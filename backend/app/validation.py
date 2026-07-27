"""
Validation logic for invoice line-item vs product_catalog table.

The public entry point is ValidationProcessor.validate_items().
"""

import asyncio
import json
import re
from typing import Optional

from google import genai

from app.db import get_supabase
from app.context_builder import build_context_block, get_user_preferences


# ---------------------------------------------------------------------------
# Field-name normalisation
# ---------------------------------------------------------------------------

# Maps OCR header → canonical field name used internally.
# Canonical names match product_catalog column names exactly.
# Keys are run through _norm_key() below, so spacing/punctuation here is
# irrelevant ("Tax %", "tax_pct" and "TAX%" all collapse to the same entry).
_RAW_FIELD_ALIASES: dict[str, str] = {
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
    "gstrate":            "gst_percent",
    "gst":                "gst_percent",
    "gstpercentage":      "gst_percent",
    "gstpct":             "gst_percent",
    # Product description — invoices label this column many different ways;
    # if none of these match, _infer_canonical() and _best_effort_name() below
    # act as further safety nets. An unresolved name means no fuzzy search.
    "product":            "sku_description",
    "productname":        "sku_description",
    "description":        "sku_description",
    "skudesc":            "sku_description",
    "skudescription":     "sku_description",
    "skudescri":          "sku_description",
    "itemname":           "sku_description",
    "itemdescription":    "sku_description",
    "itemdesc":           "sku_description",
    "item":               "sku_description",
    "items":              "sku_description",
    "particulars":        "sku_description",
    "particular":         "sku_description",
    "productdescription": "sku_description",
    "proddesc":           "sku_description",
    "productdesc":        "sku_description",
    "materialdescription": "sku_description",
    "descriptionofgoods": "sku_description",
    "goodsdescription":   "sku_description",
    "commodity":          "sku_description",
    "articlename":        "sku_description",
    "article":            "sku_description",
    "nameofproduct":      "sku_description",
    "productname/description": "sku_description",
    # Quantity (not validated, just passed through)
    "qty":                "quantity",
    "quantity":           "quantity",
}


def _norm_key(k: str) -> str:
    """
    Strip everything that is not a letter or digit so header spelling variants
    collapse together: 'B.RATE' → 'brate', 'Tax %' → 'tax', 'GST (%)' → 'gst',
    'Cost-Price' → 'costprice'.
    """
    return re.sub(r"[^a-z0-9]", "", k.strip().lower())


_FIELD_ALIASES: dict[str, str] = {
    _norm_key(k): v for k, v in _RAW_FIELD_ALIASES.items()
}

# Fallback heuristic for headers not in the alias table. A column is a GST rate
# only if it names a tax AND a rate — "GST Amount"/"Taxable Value" are money
# columns and must never be treated as a percentage.
_TAX_TOKENS     = ("gst", "tax", "vat")
_RATE_TOKENS    = ("percent", "percentage", "pct", "rate", "%")
_AMOUNT_TOKENS  = ("amount", "amt", "value", "total", "sum")


# A description column names a *thing*, so it must not be a code/number column:
# "Item Code"/"HSN Description" are not product names.
_NAME_SUBJECTS = ("item", "product", "article", "goods", "material", "commodity", "brand")
_NOT_NAME      = ("code", "ean", "barcode", "hsn", "sac", "plu", "sku no", "number")


def _infer_canonical(raw_key: str) -> Optional[str]:
    """
    Map unseen header spellings to canonical fields:
      'GST Rate %', 'Tax-Rate'                  → gst_percent
      'Item Description', 'Name of the Article' → sku_description
    """
    k = raw_key.strip().lower()

    if any(t in k for t in _TAX_TOKENS) and any(t in k for t in _RATE_TOKENS):
        if not any(t in k for t in _AMOUNT_TOKENS):
            return "gst_percent"
        return None

    if any(t in k for t in _AMOUNT_TOKENS):
        return None
    if any(t in k for t in _NOT_NAME):
        return None
    if "desc" in k or "particular" in k:
        return "sku_description"
    if "name" in k and any(t in k for t in _NAME_SUBJECTS):
        return "sku_description"
    return None


# Canonical fields coerced to numbers at normalisation time, so every consumer
# (local compare, Gemini prompts, the frontend) sees 5.0 rather than "5%".
_NUMERIC_FIELDS = frozenset({"cost_price", "mrp", "sale_price", "gst_percent"})

_CURRENCY_RE = re.compile(r"^(?:rs\.?|inr|usd|₹|\$)\s*", re.IGNORECASE)
_NUMERIC_RE  = re.compile(r"^[-+]?\d[\d,]*(?:\.\d*)?$")


def _to_float(val: object) -> Optional[float]:
    """
    Tolerant numeric parse. Accepts the formatting invoices actually use —
    '5%', '5 %', '₹1,234.50', 'Rs. 38' — and returns None for genuinely
    non-numeric values ('2 PCS') so they stay uncompared rather than wrong.
    """
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)

    s = _CURRENCY_RE.sub("", str(val).strip()).strip()
    if s.endswith("%"):
        s = s[:-1].strip()
    if not _NUMERIC_RE.match(s):
        return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
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
    """
    Remap OCR field names to canonical names; unknown keys are kept as-is.
    Values of canonical numeric fields are coerced to floats, so '5%' from the
    invoice compares equal to 5.00 in the catalog instead of being skipped
    (locally) or flagged as a formatting discrepancy (by Gemini).
    """
    out: dict = {}
    for k, v in raw.items():
        canonical = _FIELD_ALIASES.get(_norm_key(k)) or _infer_canonical(k) or k
        if canonical in _NUMERIC_FIELDS:
            num = _to_float(v)
            if num is not None:
                v = num
        # Two headers can land on sku_description (e.g. a serial "Item" column
        # alongside a real "Product Name"). Keep the more name-like value so a
        # working description is never clobbered by a row number.
        if canonical == "sku_description" and canonical in out:
            if _letter_count(v) <= _letter_count(out[canonical]):
                continue
        out[canonical] = v
    return out


def _letter_count(val: object) -> int:
    return sum(c.isalpha() for c in str(val or ""))


# Column names that never hold a product name — used by _best_effort_name.
_NON_NAME_SUBSTRINGS = (
    "code", "ean", "barcode", "hsn", "sac", "plu", "qty", "quantity", "rate",
    "price", "mrp", "amount", "tax", "gst", "discount", "batch", "expiry",
    "serial", "uom", "cess", "total", "value", "date",
)
_NON_NAME_EXACT = {"no", "srno", "slno", "sr", "sl", "s", "unit", "pack", "free", "mfg", "exp"}


# "1KG", "50GM", "12X75" carry no brand signal — a keyword search on them
# matches noise, so they are skipped when picking the search keyword.
_SIZE_TOKEN_RE = re.compile(
    r"^\d+(?:\.\d+)?(?:g|gm|gms|kg|ml|l|lt|ltr|pc|pcs|pkt|pack|n|x|mg|cm|mm|inch|in|nos?)?$",
    re.IGNORECASE,
)


def _name_keywords(product_name: str) -> list[str]:
    """
    Search keywords from a product name, best first: the leading word (usually
    the brand), then the remaining words longest-first as fallbacks.
    """
    words = []
    for tok in re.split(r"[^A-Za-z0-9&]+", product_name.strip()):
        if len(tok) < 3 or _SIZE_TOKEN_RE.match(tok) or _letter_count(tok) < 3:
            continue
        words.append(tok)
    return words[:1] + sorted(words[1:], key=len, reverse=True)


def _best_effort_name(item: dict) -> str:
    """
    Last-resort product name for the fuzzy search: the most name-like string
    value in the item when no header mapped to sku_description. Without this a
    single unrecognised column header silently makes every line unmatchable.
    """
    best, best_score = "", 0
    for k, v in item.items():
        if k in ("sku_description", "product_name") or not isinstance(v, str):
            continue
        kn = _norm_key(k)
        if kn in _NON_NAME_EXACT or any(h in kn for h in _NON_NAME_SUBSTRINGS):
            continue
        score = _letter_count(v)
        if score >= 4 and score > best_score:
            best, best_score = v, score
    return best


def _to_plu_option(r: dict) -> dict:
    """
    Map a product_catalog row to the PluOption shape the frontend expects
    (sku_desc / tax_pct rather than the DB's sku_description / gst_percent).
    Used for both the multi-PLU picker and the no-match suggestion list.
    """
    return {
        "plu_code":   r.get("plu_code"),
        "sku_desc":   r.get("sku_description"),
        "ean_code":   r.get("ean_code"),
        "cost_price": r.get("cost_price"),
        "mrp":        r.get("mrp"),
        "tax_pct":    r.get("gst_percent"),
        "priority":   r.get("priority"),
    }


# How many candidates to surface alongside a match the user may want to override.
_MAX_OPTIONS = 5


def _rank_options(
    candidates: list[dict],
    matched_plu: object,
    alternates: object = None,
    limit: int = _MAX_OPTIONS,
) -> list[dict]:
    """
    Order candidate rows for display: the chosen PLU first, then Gemini's ranked
    alternates, then any remaining candidates in catalog priority order.
    Returns at most `limit` PluOption dicts.
    """
    by_plu = {str(r.get("plu_code")): r for r in candidates if r.get("plu_code") is not None}

    preferred: list[str] = []
    if matched_plu is not None:
        preferred.append(str(matched_plu))
    if isinstance(alternates, list):
        preferred += [str(a) for a in alternates if a is not None]

    ordered: list[dict] = []
    seen: set[str] = set()
    for plu in preferred:
        row = by_plu.get(plu)
        if row is not None and plu not in seen:
            ordered.append(row)
            seen.add(plu)
    for row in candidates:
        if len(ordered) >= limit:
            break
        plu = str(row.get("plu_code"))
        if plu not in seen:
            ordered.append(row)
            seen.add(plu)

    return [_to_plu_option(r) for r in ordered[:limit]]


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
   Compare them NUMERICALLY — values that differ only in formatting are EQUAL and must
   never be reported (e.g. "5%" = 5.00 = 5, "1,234.50" = 1234.5, "Rs. 38" = 38.00).
   For sku_description: identify any mismatch between invoice and master description (case-insensitive).
4. Assign a risk_score (0.0–1.0) to each discrepancy: 1.0 = clear pricing or identity error,
   0.1 = trivial formatting difference. Only include discrepancies with risk_score >= {threshold:.2f}.
5. Suggest corrections using the master record values.
6. List up to {_MAX_OPTIONS - 1} OTHER plausible records in "alternate_plus", best first, so the
   user can override your choice. Include only genuinely plausible records — omit
   the field entirely if the chosen record is the only sensible one.

Return ONLY the following JSON — no markdown, no extra text:
{{
  "matched_plu": "<plu_code of chosen master record>",
  "alternate_plus": ["<plu_code>", "..."],
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
   Compare numeric fields NUMERICALLY — values that differ only in formatting are EQUAL and must
   never be reported (e.g. "5%" = 5.00 = 5, "1,234.50" = 1234.5, "Rs. 38" = 38.00).
   For sku_description: identify any mismatch between invoice and master description (case-insensitive).
4. Assign a risk_score (0.0–1.0) to each discrepancy: 1.0 = clear pricing or identity error,
   0.1 = trivial formatting difference. Only include discrepancies with risk_score >= {threshold:.2f}.
5. Suggest corrections using the master record values.
6. Write a short note explaining why you chose (or could not choose) a match.
7. List up to {_MAX_OPTIONS - 1} OTHER plausible records in "alternate_plus", best first, so the
   user can override your choice. Include only genuinely plausible records — omit
   the field entirely if the chosen record is the only sensible one.

Return ONLY the following JSON — no markdown, no extra text:
{{
  "matched_plu": "<plu_code of best match, or null>",
  "alternate_plus": ["<plu_code>", "..."],
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
        ILIKE search on sku_description, keyed on the first meaningful word of
        the invoice product name (usually the brand). Falls back to the next
        keywords if the first yields nothing. Returns up to 20 rows.
        """
        for keyword in _name_keywords(product_name)[:3]:
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
            rows = q.execute().data
            if rows:
                return rows
        return []

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
        # placeholder_idx → the candidate rows Gemini chose from, so its pick can
        # be shown alongside the runners-up (and so a null-match result can still
        # surface "considered" products to pick from).
        queued_candidates: dict[int, list[dict]] = {}

        for item in items:
            ean = _ean_str(item.get("ean_code"))
            master_rows = master_lookup.get(ean or "", []) if ean else []

            # ── EAN not found ────────────────────────────────────────────
            if not master_rows:
                product_name = str(item.get("sku_description") or item.get("product_name") or "")
                # Fall back whenever the mapped name is unusable for search —
                # missing, or a value like "1" from a mislabelled column.
                if not _name_keywords(product_name):
                    product_name = _best_effort_name(item) or product_name
                candidates = await asyncio.to_thread(
                    self._fetch_candidates_by_name, product_name, company_id
                )
                if not candidates:
                    print(
                        f"[validate-data] no name candidates — ean={ean!r} "
                        f"name={product_name!r} keys={list(item.keys())}"
                    )

                placeholder_idx = len(results)
                results.append(None)

                if candidates:
                    gemini_calls += 1
                    queued_candidates[placeholder_idx] = candidates
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
                queued_candidates[placeholder_idx] = master_rows
                gemini_queue.append((
                    placeholder_idx,
                    self._gemini_analyze(item, master_rows, context_block, threshold),
                    "auto_selected",
                ))
            else:
                matched_multi += 1
                plu_options = [_to_plu_option(r) for r in master_rows]
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
                    # An item is only valid if a real master record was matched
                    # AND no discrepancies survive the risk threshold. When
                    # matched_plu is null (Gemini found no genuine match) there
                    # are trivially no discrepancies, so guard against a false
                    # "valid" verdict here.
                    has_match = validation.get("matched_plu") is not None
                    validation["is_valid"] = has_match and len(validation["discrepancies"]) == 0

                    # Gemini picked one record out of several plausible ones — show
                    # the runners-up too, with its pick flagged as recommended, so
                    # the user can override instead of accepting a guess blindly.
                    if has_match:
                        options = _rank_options(
                            queued_candidates.get(result_idx, []),
                            validation.get("matched_plu"),
                            validation.get("alternate_plus"),
                        )
                        if len(options) > 1:
                            validation["plu_options"]    = options
                            validation["recommended_plu"] = validation.get("matched_plu")
                    validation.pop("alternate_plus", None)

                    if match_type_override:
                        validation["match_type"] = match_type_override
                        matched_auto += 1
                    elif not has_match:
                        # Fuzzy path returned no genuine match — treat as no_match
                        # so it renders as unmatched and is counted correctly.
                        validation["match_type"] = "no_match"
                        no_match_count += 1
                        # Surface the candidates Gemini considered so the user can
                        # still pick one manually ("considered similar products").
                        cands = queued_candidates.get(result_idx, [])
                        if cands:
                            validation["plu_options"] = [_to_plu_option(c) for c in cands[:8]]
                        # The frontend shows the unmatched explanation from
                        # discrepancies[0].message (match_note is only rendered
                        # for fuzzy_name). Ensure a message survives: carry over
                        # Gemini's match_note, else a sensible default.
                        if not validation["discrepancies"]:
                            note = (
                                validation.get("match_note")
                                or "EAN code not found in master catalog and no matching product could be identified."
                            )
                            validation["discrepancies"] = [{
                                "field":    "ean_code",
                                "expected": None,
                                "actual":   _ean_str(item.get("ean_code")),
                                "message":  note,
                            }]
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
