"""
Validation logic for invoice line-item vs master_items table.

The public entry point is ValidationProcessor.validate_items().
"""

import asyncio
import json
from typing import Optional

from google import genai

from app.db import get_supabase
from app.context_builder import build_context_block, get_user_preferences


# ---------------------------------------------------------------------------
# Field-name normalisation
# ---------------------------------------------------------------------------

# Maps normalised OCR header → canonical field name used internally
_FIELD_ALIASES: dict[str, str] = {
    "eancode":            "ean_code",
    "ean":                "ean_code",
    "barcode":            "ean_code",
    # "brate":              "cost_price",   # B.RATE column on purchase invoices
    # "baserate":           "cost_price",
    "costprice":          "cost_price",
    "mrp":                "mrp",
    "maximumretailprice": "mrp",
    "tax%":               "tax_pct",
    "taxpct":             "tax_pct",
    "tax":                "tax_pct",
    "taxrate":            "tax_pct",
    "taxpercentage":      "tax_pct",
    "taxpercent":         "tax_pct",
    # "gst%":               "tax_pct",
    # "gstrate":            "tax_pct",
    # "gstpercent":         "tax_pct",
    # "igst%":              "tax_pct",
    # "igstrate":           "tax_pct",
    # "igstpct":            "tax_pct",
    "product":            "sku_desc",
    "productname":        "sku_desc",
    "description":        "sku_desc",
    "skudesc":            "sku_desc",
    "qty":                "quantity",
    "quantity":           "quantity",
}


def _norm_key(k: str) -> str:
    """'B.RATE' → 'brate', 'Tax%' → 'tax%', 'Cost Price' → 'costprice'."""
    return k.strip().lower().replace(" ", "").replace(".", "").replace("_", "")


def _to_float(val: object) -> Optional[float]:
    try:
        return float(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _ean_str(val: object) -> Optional[str]:
    """8901399000591.0 → '8901399000591'."""
    if val is None:
        return None
    try:
        return str(int(float(str(val))))
    except (ValueError, TypeError):
        s = str(val).strip()
        return s or None


def normalize_item(raw: dict) -> dict:
    """Remap OCR field names to canonical names; unknown keys are kept as-is."""
    out: dict = {}
    for k, v in raw.items():
        canonical = _FIELD_ALIASES.get(_norm_key(k), k)
        out[canonical] = v
    # print(out)
    return out


# ---------------------------------------------------------------------------
# Local (no-Gemini) comparison
# ---------------------------------------------------------------------------

def local_compare(item: dict, master: dict) -> dict:
    """
    Fast comparison for the single-PLU, no-discrepancy fast path.
    Returns a validation dict compatible with the Gemini output shape.
    """
    discrepancies = []
    corrections: dict = {}

    # Numeric field comparison
    for field in ("cost_price", "mrp", "tax_pct"):
        inv_val = _to_float(item.get(field))
        master_val = _to_float(master.get(field))
        if inv_val is None or master_val is None:
            continue
        if abs(inv_val - master_val) > 0.01:
            label = field.replace("_", " ").title()
            discrepancies.append({
                "field":    field,
                "expected": master_val,
                "actual":   inv_val,
                "message":  f"{label} mismatch: invoice has {inv_val}, master has {master_val}.",
            })
            corrections[field] = master_val

    # Product description comparison
    inv_desc = str(item.get("sku_desc") or "").strip().upper()
    master_desc = str(master.get("sku_desc") or "").strip().upper()
    if inv_desc and master_desc and inv_desc != master_desc:
        discrepancies.append({
            "field":    "sku_desc",
            "expected": master.get("sku_desc"),
            "actual":   item.get("sku_desc"),
            "message":  f"Product description mismatch: invoice has '{item.get('sku_desc')}', master has '{master.get('sku_desc')}'.",
        })
        corrections["sku_desc"] = master.get("sku_desc")

    return {
        "matched_plu":           master.get("plu_code"),
        "is_valid":              len(discrepancies) == 0,
        "discrepancies":         discrepancies,
        "suggested_corrections": corrections,
    }


# ---------------------------------------------------------------------------
# ValidationProcessor
# ---------------------------------------------------------------------------

class ValidationProcessor:
    def __init__(self, client: genai.Client):
        self.client = client

    # ------------------------------------------------------------------
    # Gemini analysis
    # ------------------------------------------------------------------

    async def _gemini_analyze(
        self, item: dict, master_rows: list[dict], context_block: str = "", threshold: float = 0.5
    ) -> dict:
        """
        Ask Gemini to select the best-matching PLU and identify discrepancies.

        Called when:
          - Multiple PLUs exist for the EAN (need to pick best match), or
          - A single-PLU local check already found at least one discrepancy.
        """
        ean     = item.get("ean_code", "unknown")
        product = item.get("sku_desc", "unknown")

        # Human-readable summary for the narrative part of the prompt
        master_lines = [
            f"  PLU {r['plu_code']} (priority {r.get('priority', '?')}): "
            f"'{r.get('sku_desc') or '—'}', "
            f"Cost Price={r.get('cost_price')}, MRP={r.get('mrp')}, Tax%={r.get('tax_pct')}"
            for r in master_rows
        ]

        # Compact JSON for the structured reference block
        master_json = json.dumps([
            {k: r.get(k) for k in ("plu_code", "sku_desc", "cost_price", "mrp", "tax_pct", "priority")}
            for r in master_rows
        ])

        def _fmt(v: object) -> str:
            return str(v) if v is not None else "not provided in invoice"

        context_prefix = f"{context_block}\n\n" if context_block else ""
        prompt = f"""{context_prefix}You are a procurement data validator.

Invoice line item:
  EAN: {ean}
  Product: {product}
  Cost Price: {_fmt(item.get("cost_price"))}
  MRP: {_fmt(item.get("mrp"))}
  Tax%: {_fmt(item.get("tax_pct"))}

Master data records for EAN {ean}:
{chr(10).join(master_lines)}

Task:
1. Select the master record whose values are closest to the invoice
   (prioritise MRP match, then Tax%, then Cost Price).
2. Compare cost_price, mrp, tax_pct, AND sku_desc between the invoice and the chosen record.
   IMPORTANT: If an invoice field says "not provided in invoice", that data was absent
   from the document. Do NOT flag it as a discrepancy — skip it entirely.
3. For numeric fields (cost_price, mrp, tax_pct): identify any value differences.
   For sku_desc: identify any mismatch between invoice and master description (case-insensitive).
4. Assign a risk_score (0.0–1.0) to each discrepancy: 1.0 = clear pricing or identity error,
   0.1 = trivial formatting difference. Only include discrepancies with risk_score >= {threshold:.2f}.
5. Suggest corrections using the master record values.

Return ONLY the following JSON — no markdown, no extra text:
{{
  "matched_plu": "<plu_code of chosen master record>",
  "is_valid": <true if zero discrepancies survive the threshold, else false>,
  "discrepancies": [
    {{
      "field":      "<cost_price | mrp | tax_pct | sku_desc>",
      "expected":   <master value — number for numeric fields, string for sku_desc>,
      "actual":     <invoice value — number for numeric fields, string for sku_desc>,
      "message":    "<one-sentence explanation>",
      "risk_score": <0.0–1.0>
    }}
  ],
  "suggested_corrections": {{ "<field>": <corrected value> }}
}}

Master records (JSON):
{master_json}"""

        response = await self.client.aio.models.generate_content(
            model="gemini-3-flash-preview",
            contents=[prompt],
        )
        raw = response.text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(raw)

    # ------------------------------------------------------------------
    # Gemini fuzzy match (EAN not found — try by product name)
    # ------------------------------------------------------------------

    async def _gemini_fuzzy_match(
        self, item: dict, candidates: list[dict], context_block: str = "", threshold: float = 0.5
    ) -> dict:
        """
        Called when the invoice EAN is not in master_items but a product-name
        keyword search returned candidate records.

        Gemini selects the closest candidate and returns the same validation
        shape as _gemini_analyze, plus two extra fields:
          "match_type":  "fuzzy_name"   (so the frontend can style it differently)
          "match_note":  "<why Gemini chose this record>"
        """
        ean     = item.get("ean_code", "unknown")
        product = item.get("sku_desc") or item.get("product_name") or "unknown"

        candidates_lines = [
            f"  PLU {r['plu_code']} | EAN {r.get('ean_code')} | "
            f"'{r.get('sku_desc') or '—'}' | "
            f"Cost={r.get('cost_price')}, MRP={r.get('mrp')}, Tax%={r.get('tax_pct')}"
            for r in candidates
        ]
        candidates_json = json.dumps([
            {k: r.get(k) for k in ("plu_code", "ean_code", "sku_desc", "cost_price", "mrp", "tax_pct", "priority")}
            for r in candidates
        ])

        context_prefix = f"{context_block}\n\n" if context_block else ""
        prompt = f"""{context_prefix}You are a procurement data validator.

The invoice contains a line item whose EAN code ({ean}) was NOT found in master data.
However, a keyword search on the product name returned possible matches below.

Invoice line item:
  EAN: {ean}  ← not in master
  Product: {product}
  Cost Price: {item.get("cost_price")}
  MRP: {item.get("mrp")}
  Tax%: {item.get("tax_pct")}

Possible master records (matched by product name keyword):
{chr(10).join(candidates_lines)}

Task:
1. Choose the master record that most likely represents the same product
   (use product name similarity, then MRP, then Tax% as tiebreakers).
2. If no record is a reasonable match, set "matched_plu" to null.
3. Compare cost_price, mrp, tax_pct, AND sku_desc between the invoice and the chosen record.
   For sku_desc: identify any mismatch between invoice and master description (case-insensitive).
4. Assign a risk_score (0.0–1.0) to each discrepancy: 1.0 = clear pricing or identity error,
   0.1 = trivial formatting difference. Only include discrepancies with risk_score >= {threshold:.2f}.
5. Suggest corrections using the master record values.
6. Write a short note explaining why you chose (or could not choose) a match.

Return ONLY the following JSON — no markdown, no extra text:
{{
  "matched_plu": "<plu_code of best match, or null>",
  "match_type":  "fuzzy_name",
  "match_note":  "<one-sentence explanation of match choice>",
  "confidence":  "<high | medium | low>",
  "is_valid":    false,
  "discrepancies": [
    {{
      "field":      "<ean_code | cost_price | mrp | tax_pct | sku_desc>",
      "expected":   <master value or null — number for numeric fields, string for sku_desc>,
      "actual":     <invoice value — number for numeric fields, string for sku_desc>,
      "message":    "<one-sentence explanation>",
      "risk_score": <0.0–1.0>
    }}
  ],
  "suggested_corrections": {{ "<field>": <corrected value> }}
}}

Master records (JSON):
{candidates_json}"""

        response = await self.client.aio.models.generate_content(
            model="gemini-3-flash-preview",
            contents=[prompt],
        )
        raw = response.text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(raw)

    # ------------------------------------------------------------------
    # DB helpers
    # ------------------------------------------------------------------

    def _fetch_master_lookup(self, ean_codes: list[str]) -> dict[str, list[dict]]:
        """Batch fetch master rows for given EANs; returns {ean_code: [rows]}."""
        if not ean_codes:
            return {}
        result = (
            get_supabase()
            .table("master_items")
            .select("*")
            .in_("ean_code", ean_codes)
            .order("priority")
            .execute()
        )
        lookup: dict[str, list[dict]] = {}
        for row in result.data:
            lookup.setdefault(row["ean_code"], []).append(row)
        return lookup

    def _fetch_candidates_by_name(self, product_name: str) -> list[dict]:
        """
        ILIKE search on sku_desc using the first meaningful word from the
        invoice product name (usually the brand).  Returns up to 20 rows.
        """
        words = [w for w in product_name.strip().split() if len(w) >= 3]
        if not words:
            return []
        keyword = words[0]          # e.g. "SANTOOR" from "SANTOOR SOAP 100G MRP38"
        result = (
            get_supabase()
            .table("master_items")
            .select("*")
            .ilike("sku_desc", f"%{keyword}%")
            .order("priority")
            .limit(20)
            .execute()
        )
        return result.data

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    async def validate_items(
        self,
        raw_items: list[dict],
        user_id: str = "",
        company_id: str = "",
    ) -> tuple[list[dict], int]:
        """
        Validate a list of raw OCR line items against master_items.

        Each returned dict is the original item enriched with a `validation` key:
          {
            "matched_plu":           str | None,
            "is_valid":              bool,
            "discrepancies":         [{"field", "expected", "actual", "message"}, ...],
            "suggested_corrections": {"field": corrected_value, ...}
          }

        Decision tree per item
        ──────────────────────
        EAN not in master, product name yields candidates  →  Gemini fuzzy match      (1 credit)
        EAN not in master, no name candidates              →  flag immediately, no Gemini
        Single PLU                                         →  local compare, no Gemini
        Multiple PLUs, clean match found locally           →  auto-select, no Gemini
        Multiple PLUs, all mismatched, auto_select_plu ON  →  Gemini analyzes         (1 credit)
        Multiple PLUs, all mismatched, auto_select_plu OFF →  return options for user selection

        Returns (validated_items, stats) where stats is a dict with match/outcome
        breakdowns and gemini_calls count (each Gemini call costs 1 credit).
        """
        # Build context block and fetch preference flags concurrently.
        context_block   = ""
        auto_select_plu = False
        threshold       = 0.5
        if user_id:
            context_block, prefs = await asyncio.gather(
                build_context_block(user_id, company_id),
                get_user_preferences(user_id),
            )
            auto_select_plu = prefs.get("auto_select_plu", False)
            threshold       = float(prefs.get("effective_risk_threshold", 0.5))

        items = [normalize_item(raw) for raw in raw_items]
        gemini_calls        = 0
        matched_exact       = 0
        matched_fuzzy       = 0   # incremented after Gemini resolves (not on exception)
        matched_auto        = 0   # multi-PLU items resolved via _gemini_analyze
        matched_multi       = 0   # multi-PLU items left for manual user selection
        no_match_count      = 0

        # Collect unique EAN codes → single batch DB query
        ean_codes = list({
            _ean_str(item.get("ean_code"))
            for item in items
            if item.get("ean_code")
        } - {None})

        master_lookup = await asyncio.to_thread(self._fetch_master_lookup, ean_codes)

        results: list[dict | None] = []
        # Queue entries: (result_index, coroutine, match_type_override | None)
        # match_type_override is set for auto-selected items so the result handler
        # can stamp the correct match_type onto the validation dict.
        gemini_queue: list[tuple[int, object, str | None]] = []

        for item in items:
            ean = _ean_str(item.get("ean_code"))
            master_rows = master_lookup.get(ean or "", []) if ean else []

            # ── EAN not found ────────────────────────────────────────────
            if not master_rows:
                product_name = str(item.get("sku_desc") or item.get("product_name") or "")
                candidates = await asyncio.to_thread(
                    self._fetch_candidates_by_name, product_name
                )

                placeholder_idx = len(results)
                results.append(None)

                if candidates:
                    # Fuzzy match via Gemini — counts as 1 credit
                    gemini_calls += 1
                    gemini_queue.append((
                        placeholder_idx,
                        self._gemini_fuzzy_match(item, candidates, context_block, threshold),
                        None,   # match_type comes from Gemini response ("fuzzy_name")
                    ))
                else:
                    # No name candidates either — flag immediately
                    no_match_count += 1
                    results[placeholder_idx] = {
                        **item,
                        "validation": {
                            "matched_plu":           None,
                            "match_type":            "no_match",
                            "is_valid":              False,
                            "discrepancies": [{
                                "field":    "ean_code",
                                "expected": None,
                                "actual":   ean,
                                "message":  "EAN code not found in master data and no similar product name could be matched.",
                            }],
                            "suggested_corrections": {},
                        },
                    }
                continue

            # ── Single PLU fast path ─────────────────────────────────────
            if len(master_rows) == 1:
                local = local_compare(item, master_rows[0])
                matched_exact += 1
                results.append({**item, "validation": local})
                continue

            # ── Multiple PLUs ────────────────────────────────────────────
            # Run local_compare against every PLU (rows already ordered by priority).
            # If any PLU is a clean match (zero discrepancies) auto-select it —
            # no need to bother the user. Only surface the selection UI when every
            # PLU has at least one mismatch.
            comparisons = [(r, local_compare(item, r)) for r in master_rows]
            clean = next(
                ((r, cmp) for r, cmp in comparisons if not cmp["discrepancies"]),
                None,
            )

            if clean:
                _, cmp = clean
                matched_exact += 1
                results.append({**item, "validation": cmp})
            elif auto_select_plu:
                # User prefers Gemini to pick — queue _gemini_analyze (1 credit).
                gemini_calls += 1
                placeholder_idx = len(results)
                results.append(None)
                gemini_queue.append((
                    placeholder_idx,
                    self._gemini_analyze(item, master_rows, context_block, threshold),
                    "auto_selected",   # stamp this onto the result
                ))
            else:
                matched_multi += 1
                plu_options = [
                    {k: r.get(k) for k in ("plu_code", "sku_desc", "cost_price", "mrp", "tax_pct", "priority")}
                    for r in master_rows
                ]
                results.append({
                    **item,
                    "validation": {
                        "matched_plu":           None,
                        "match_type":            "multi_plu",
                        "is_valid":              False,
                        "plu_options":           plu_options,
                        "discrepancies":         [],
                        "suggested_corrections": {},
                    },
                })

        # ── Run all Gemini calls concurrently ────────────────────────────
        if gemini_queue:
            indices, coros, overrides = zip(*gemini_queue)
            outputs = await asyncio.gather(*coros, return_exceptions=True)

            for result_idx, output, match_type_override in zip(indices, outputs, overrides):
                item = items[result_idx]
                if isinstance(output, Exception):
                    print(f"[validate-data] Gemini failed for index {result_idx}: {output}")
                    ean = _ean_str(item.get("ean_code"))
                    master_rows_fb = master_lookup.get(ean or "", [])
                    if master_rows_fb:
                        # Known EAN (auto-select path) — fall back to highest-priority PLU
                        results[result_idx] = {
                            **item,
                            "validation": {
                                **local_compare(item, master_rows_fb[0]),
                                "match_type": "auto_selected",
                            },
                        }
                    else:
                        # Fuzzy path failed — fall back to no_match flag
                        results[result_idx] = {
                            **item,
                            "validation": {
                                "matched_plu":           None,
                                "match_type":            "no_match",
                                "is_valid":              False,
                                "discrepancies": [{
                                    "field":    "ean_code",
                                    "expected": None,
                                    "actual":   ean,
                                    "message":  "EAN code not found in master data.",
                                }],
                                "suggested_corrections": {},
                            },
                        }
                else:
                    validation = dict(output)
                    # Filter out any discrepancies below the user's risk threshold.
                    # Gemini should already respect it, but this enforces it in code.
                    validation["discrepancies"] = [
                        d for d in validation.get("discrepancies", [])
                        if float(d.get("risk_score", 1.0)) >= threshold
                    ]
                    validation["is_valid"] = len(validation["discrepancies"]) == 0
                    if match_type_override:
                        validation["match_type"] = match_type_override
                        matched_auto += 1
                    else:
                        matched_fuzzy += 1
                    results[result_idx] = {**item, "validation": validation}

        # Outcome breakdown (multi_plu and no_match excluded — outcome unknown at run time)
        _unresolved = {"no_match", "multi_plu"}
        valid_items       = sum(1 for r in results if r and r.get("validation", {}).get("is_valid"))
        items_with_issues = sum(
            1 for r in results
            if r
            and not r["validation"].get("is_valid")
            and r["validation"].get("match_type") not in _unresolved
        )

        stats = {
            "gemini_calls":         gemini_calls,
            "matched_exact":        matched_exact,
            "matched_fuzzy":        matched_fuzzy,
            "matched_auto_selected": matched_auto,
            "matched_multi_plu":    matched_multi,
            "no_match":             no_match_count,
            "valid_items":          valid_items,
            "items_with_issues":    items_with_issues,
        }
        return results, stats  # type: ignore[return-value]
