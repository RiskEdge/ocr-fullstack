"""
Validation logic for invoice line-item vs product_catalog table.

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

# Maps normalised OCR header → canonical field name used internally.
# Canonical names match product_catalog column names exactly.
_FIELD_ALIASES: dict[str, str] = {
    # EAN / barcode
    "eancode":            "ean_code",
    "ean":                "ean_code",
    "barcode":            "ean_code",
    # Prices
    "costprice":          "cost_price",
    "mrp":                "mrp",
    "maximumretailprice": "mrp",
    "saleprice":          "sale_price",
    # GST / Tax — all common invoice labels map to gst_percent
    "tax%":               "gst_percent",
    "taxpct":             "gst_percent",
    "tax":                "gst_percent",
    "taxrate":            "gst_percent",
    "taxpercentage":      "gst_percent",
    "taxpercent":         "gst_percent",
    "gstpercent":         "gst_percent",
    "gst%":               "gst_percent",
    "gstpercer":          "gst_percent",
    # Product description
    "product":            "sku_description",
    "productname":        "sku_description",
    "description":        "sku_description",
    "skudesc":            "sku_description",
    "skudescription":     "sku_description",
    "skudescri":          "sku_description",
    # Quantity (not validated, just passed through)
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
    """8901234567890.0 → '8901234567890'."""
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

    for field in ("cost_price", "mrp", "gst_percent"):
        inv_val = _to_float(item.get(field))
        master_val = _to_float(master.get(field))
        if inv_val is None or master_val is None:
            continue
        if abs(inv_val - master_val) > 0.01:
            label = {"cost_price": "Cost Price", "mrp": "MRP", "gst_percent": "GST%"}[field]
            discrepancies.append({
                "field":    field,
                "expected": master_val,
                "actual":   inv_val,
                "message":  f"{label} mismatch: invoice has {inv_val}, master has {master_val}.",
            })
            corrections[field] = master_val

    inv_desc = str(item.get("sku_description") or "").strip().upper()
    master_desc = str(master.get("sku_description") or "").strip().upper()
    if inv_desc and master_desc and inv_desc != master_desc:
        discrepancies.append({
            "field":    "sku_description",
            "expected": master.get("sku_description"),
            "actual":   item.get("sku_description"),
            "message":  f"Description mismatch: invoice has '{item.get('sku_description')}', master has '{master.get('sku_description')}'.",
        })
        corrections["sku_description"] = master.get("sku_description")

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

        Called when multiple PLUs exist for the EAN and all have mismatches
        (auto_select_plu mode).
        """
        ean     = item.get("ean_code", "unknown")
        product = item.get("sku_description", "unknown")

        master_lines = [
            f"  PLU {r['plu_code']} (priority {r.get('priority', '?')}): "
            f"'{r.get('sku_description') or '—'}', "
            f"Cost={r.get('cost_price')}, MRP={r.get('mrp')}, GST%={r.get('gst_percent')}"
            for r in master_rows
        ]
        master_json = json.dumps([
            {k: r.get(k) for k in ("plu_code", "sku_description", "cost_price", "mrp", "gst_percent", "priority")}
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
  GST%: {_fmt(item.get("gst_percent"))}

Master data records for EAN {ean}:
{chr(10).join(master_lines)}

Task:
1. Select the master record whose values are closest to the invoice
   (prioritise MRP match, then GST%, then Cost Price).
2. Compare cost_price, mrp, gst_percent, AND sku_description between the invoice and the chosen record.
   IMPORTANT: If an invoice field says "not provided in invoice", that data was absent
   from the document. Do NOT flag it as a discrepancy — skip it entirely.
3. For numeric fields (cost_price, mrp, gst_percent): identify any value differences.
   For sku_description: identify any mismatch between invoice and master description (case-insensitive).
4. Assign a risk_score (0.0–1.0) to each discrepancy: 1.0 = clear pricing or identity error,
   0.1 = trivial formatting difference. Only include discrepancies with risk_score >= {threshold:.2f}.
5. Suggest corrections using the master record values.

Return ONLY the following JSON — no markdown, no extra text:
{{
  "matched_plu": "<plu_code of chosen master record>",
  "is_valid": <true if zero discrepancies survive the threshold, else false>,
  "discrepancies": [
    {{
      "field":      "<cost_price | mrp | gst_percent | sku_description>",
      "expected":   <master value — number for numeric fields, string for sku_description>,
      "actual":     <invoice value — number for numeric fields, string for sku_description>,
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
        Called when the invoice EAN is not in product_catalog but a product-name
        keyword search returned candidate records.

        Gemini selects the closest candidate and returns the same validation
        shape as _gemini_analyze, plus:
          "match_type":  "fuzzy_name"
          "match_note":  "<why Gemini chose this record>"
        """
        ean     = item.get("ean_code", "unknown")
        product = item.get("sku_description") or item.get("product_name") or "unknown"

        candidates_lines = [
            f"  PLU {r['plu_code']} | EAN {r.get('ean_code')} | "
            f"'{r.get('sku_description') or '—'}' | "
            f"Cost={r.get('cost_price')}, MRP={r.get('mrp')}, GST%={r.get('gst_percent')}"
            for r in candidates
        ]
        candidates_json = json.dumps([
            {k: r.get(k) for k in ("plu_code", "ean_code", "sku_description", "cost_price", "mrp", "gst_percent", "priority")}
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
  GST%: {item.get("gst_percent")}

Possible master records (matched by product name keyword):
{chr(10).join(candidates_lines)}

Task:
1. Choose the master record that most likely represents the same product
   (use product name similarity, then MRP, then GST% as tiebreakers).
2. If no record is a reasonable match, set "matched_plu" to null.
3. Compare cost_price, mrp, gst_percent, AND sku_description between the invoice and the chosen record.
   For sku_description: identify any mismatch between invoice and master description (case-insensitive).
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
      "field":      "<ean_code | cost_price | mrp | gst_percent | sku_description>",
      "expected":   <master value or null — number for numeric fields, string for sku_description>,
      "actual":     <invoice value — number for numeric fields, string for sku_description>,
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

    def _fetch_master_lookup(self, ean_codes: list[str], company_id: str = "") -> dict[str, list[dict]]:
        """Batch fetch product_catalog rows for given EANs, scoped to company."""
        if not ean_codes:
            return {}
        q = (
            get_supabase()
            .table("product_catalog")
            .select("*")
            .in_("ean_code", ean_codes)
            .order("priority")
        )
        if company_id:
            q = q.eq("company_id", company_id)
        lookup: dict[str, list[dict]] = {}
        for row in q.execute().data:
            lookup.setdefault(row["ean_code"], []).append(row)
        return lookup

    def _fetch_candidates_by_name(self, product_name: str, company_id: str = "") -> list[dict]:
        """
        ILIKE search on sku_description using the first meaningful word from the
        invoice product name (usually the brand).  Returns up to 20 rows.
        """
        words = [w for w in product_name.strip().split() if len(w) >= 3]
        if not words:
            return []
        keyword = words[0]   # e.g. "SANTOOR" from "SANTOOR SOAP 100G MRP38"
        q = (
            get_supabase()
            .table("product_catalog")
            .select("*")
            .ilike("sku_description", f"%{keyword}%")
            .order("priority")
            .limit(20)
        )
        if company_id:
            q = q.eq("company_id", company_id)
        return q.execute().data

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
        Validate a list of raw OCR line items against product_catalog.

        Each returned dict is the original item enriched with a `validation` key:
          {
            "matched_plu":           str | None,
            "is_valid":              bool,
            "discrepancies":         [{"field", "expected", "actual", "message"}, ...],
            "suggested_corrections": {"field": corrected_value, ...}
          }

        Decision tree per item
        ──────────────────────
        EAN not in catalog, product name yields candidates  →  Gemini fuzzy match  (1 credit)
        EAN not in catalog, no name candidates              →  flag immediately, no Gemini
        Single PLU                                         →  local compare, no Gemini
        Multiple PLUs, clean match found locally           →  auto-select, no Gemini
        Multiple PLUs, all mismatched, auto_select_plu ON  →  Gemini analyzes     (1 credit)
        Multiple PLUs, all mismatched, auto_select_plu OFF →  return options for user selection

        Returns (validated_items, stats).
        """
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
        gemini_calls   = 0
        matched_exact  = 0
        matched_fuzzy  = 0
        matched_auto   = 0
        matched_multi  = 0
        no_match_count = 0

        ean_codes = list({
            _ean_str(item.get("ean_code"))
            for item in items
            if item.get("ean_code")
        } - {None})

        master_lookup = await asyncio.to_thread(self._fetch_master_lookup, ean_codes, company_id)

        results: list[dict | None] = []
        gemini_queue: list[tuple[int, object, str | None]] = []

        for item in items:
            ean = _ean_str(item.get("ean_code"))
            master_rows = master_lookup.get(ean or "", []) if ean else []

            # ── EAN not found ────────────────────────────────────────────
            if not master_rows:
                product_name = str(item.get("sku_description") or item.get("product_name") or "")
                candidates = await asyncio.to_thread(
                    self._fetch_candidates_by_name, product_name, company_id
                )

                placeholder_idx = len(results)
                results.append(None)

                if candidates:
                    gemini_calls += 1
                    gemini_queue.append((
                        placeholder_idx,
                        self._gemini_fuzzy_match(item, candidates, context_block, threshold),
                        None,
                    ))
                else:
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
                                "message":  "EAN code not found in master catalog and no similar product name could be matched.",
                            }],
                            "suggested_corrections": {},
                        },
                    }
                continue

            # ── Single PLU fast path ─────────────────────────────────────
            if len(master_rows) == 1:
                matched_exact += 1
                results.append({**item, "validation": local_compare(item, master_rows[0])})
                continue

            # ── Multiple PLUs ────────────────────────────────────────────
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
                gemini_calls += 1
                placeholder_idx = len(results)
                results.append(None)
                gemini_queue.append((
                    placeholder_idx,
                    self._gemini_analyze(item, master_rows, context_block, threshold),
                    "auto_selected",
                ))
            else:
                matched_multi += 1
                plu_options = [
                    {k: r.get(k) for k in ("plu_code", "sku_description", "cost_price", "mrp", "gst_percent", "priority")}
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
                        results[result_idx] = {
                            **item,
                            "validation": {
                                **local_compare(item, master_rows_fb[0]),
                                "match_type": "auto_selected",
                            },
                        }
                    else:
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
                                    "message":  "EAN code not found in master catalog.",
                                }],
                                "suggested_corrections": {},
                            },
                        }
                else:
                    validation = dict(output)
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

        _unresolved = {"no_match", "multi_plu"}
        valid_items       = sum(1 for r in results if r and r.get("validation", {}).get("is_valid"))
        items_with_issues = sum(
            1 for r in results
            if r
            and not r["validation"].get("is_valid")
            and r["validation"].get("match_type") not in _unresolved
        )

        stats = {
            "gemini_calls":          gemini_calls,
            "matched_exact":         matched_exact,
            "matched_fuzzy":         matched_fuzzy,
            "matched_auto_selected": matched_auto,
            "matched_multi_plu":     matched_multi,
            "no_match":              no_match_count,
            "valid_items":           valid_items,
            "items_with_issues":     items_with_issues,
        }
        return results, stats  # type: ignore[return-value]
