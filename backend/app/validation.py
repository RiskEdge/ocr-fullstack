"""
Validation logic for invoice line-item vs product_catalog table.

The public entry point is ValidationProcessor.validate_items().
"""

import asyncio
import difflib
import json
import re
from concurrent.futures import ThreadPoolExecutor
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
    # Item / PLU codes — the fallback lookup key when the EAN is missing or
    # absent from the catalog. Deliberately excludes serial-style headers
    # ("Item No", "Sr No"), which carry line numbers rather than item codes.
    "plu":                "plu_code",
    "plucode":            "plu_code",
    "pluno":              "plu_code",
    "sku":                "sku_code",
    "skucode":            "sku_code",
    "skuno":              "sku_code",
    "itemcode":           "sku_code",
    "productcode":        "sku_code",
    "articlecode":        "sku_code",
    "materialcode":       "sku_code",
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
    # Pack size — the number of individual units inside one invoiced UOM.
    # The catalog is the authority on it, but an invoice that prints its own
    # value lets a line be reconciled even when the catalog's is missing.
    "uom":                "uom",
    "unit":               "uom",
    "unitofmeasure":      "uom",
    "uomqty":             "uom_qty",
    "uomquantity":        "uom_qty",
    "packsize":           "uom_qty",
    "unitsperpack":       "uom_qty",
    "conversionfactor":   "uom_qty",
    # Invoice-side money columns used to derive a missing cost price.
    # "Rate"/"Price" on an item table is the price of one invoiced UOM, not of
    # one individual unit — see derive_cost_price().
    "invoiceprice":       "invoice_price",
    "rate":               "invoice_price",
    "brate":              "invoice_price",
    "basicrate":          "invoice_price",
    "baserate":           "invoice_price",
    "purchaserate":       "invoice_price",
    "unitprice":          "invoice_price",
    "unitrate":           "invoice_price",
    "price":              "invoice_price",
    # Line totals before tax — the fallback when no unit rate is printed.
    "taxablevalue":       "taxable_value",
    "taxableamount":      "taxable_value",
    "taxableamt":         "taxable_value",
    "assessablevalue":    "taxable_value",
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
# Rate/price columns that are somebody else's number, not the price this
# invoice charges per unit.
_NOT_INVOICE_PRICE = (
    "retail", "mrp", "sale", "sell", "discount", "margin", "exchange", "conversion",
)


# A description column names a *thing*, so it must not be a code/number column:
# "Item Code"/"HSN Description" are not product names.
_NAME_SUBJECTS = ("item", "product", "article", "goods", "material", "commodity", "brand")
_NOT_NAME      = ("code", "ean", "barcode", "hsn", "sac", "plu", "sku no", "number")


# GST is split into halves on an intra-state invoice (SGST + CGST) and levied
# whole on an inter-state one (IGST). Their *amounts* are summed to recover the
# line's tax; their *rates* are not interchangeable with the GST rate, since
# SGST 2.5% + CGST 2.5% is a 5% item.
_TAX_COMPONENTS = (
    ("sgst",  "sgst_amount",  "sgst_pct"),
    ("utgst", "sgst_amount",  "sgst_pct"),
    ("cgst",  "cgst_amount",  "cgst_pct"),
    ("igst",  "igst_amount",  "gst_percent"),
)


def _infer_tax_component(raw_key: str) -> Optional[str]:
    """
    Classify an SGST/CGST/IGST column as an amount or a rate.

    _norm_key() strips the '%' that is often the only thing telling them apart
    ('SGST' vs 'SGST %'), so this runs on the raw header ahead of the alias
    table. Only IGST's rate is the full GST rate; the state/central halves get
    their own keys and are never compared against the catalog's gst_percent.
    """
    k = raw_key.strip().lower()
    for token, amount_field, rate_field in _TAX_COMPONENTS:
        if token not in k:
            continue
        is_rate = any(t in k for t in _RATE_TOKENS)
        return rate_field if is_rate else amount_field
    return None


def _infer_canonical(raw_key: str) -> Optional[str]:
    """
    Map unseen header spellings to canonical fields:
      'GST Rate %', 'Tax-Rate'                  → gst_percent
      'Tax Amount', 'GST Amt'                   → gst_amount
      'Item Description', 'Name of the Article' → sku_description
    """
    k = raw_key.strip().lower()

    # 'Taxable Value' names the base the tax is charged on, not the tax — it is
    # spelled out in the alias table and must not fall into either branch below.
    if "taxable" in k or "assessable" in k:
        return None

    if any(t in k for t in _TAX_TOKENS) and any(t in k for t in _RATE_TOKENS):
        if not any(t in k for t in _AMOUNT_TOKENS):
            return "gst_percent"
        return None

    if any(t in k for t in _AMOUNT_TOKENS):
        # A combined tax-amount column ('GST Amount') stands in for SGST+CGST
        # when the invoice does not split them. Every other amount column is
        # left alone.
        if any(t in k for t in _TAX_TOKENS):
            return "gst_amount"
        return None

    # What one invoiced unit costs, under whichever of the endless spellings
    # this vendor uses: 'Net Rate', 'Basic Price', 'P.Rate', 'Rate / Unit'.
    # Line totals were excluded by the amount branch above, and the specific
    # price columns (cost / sale / MRP) are spelled out in the alias table —
    # so what is left here is the unit rate.
    if any(t in k for t in ("rate", "price")):
        if any(t in k for t in _NOT_INVOICE_PRICE):
            return None
        if "cost" in k:
            return "cost_price"
        return "invoice_price"
    if any(t in k for t in _NOT_NAME):
        return None
    if "desc" in k or "particular" in k:
        return "sku_description"
    if "name" in k and any(t in k for t in _NAME_SUBJECTS):
        return "sku_description"
    return None


# Canonical fields coerced to numbers at normalisation time, so every consumer
# (local compare, Gemini prompts, the frontend) sees 5.0 rather than "5%".
_NUMERIC_FIELDS = frozenset({
    "cost_price", "mrp", "sale_price", "gst_percent",
    # Inputs to derive_cost_price() — parsed here so the derivation works on
    # '₹1,190.40' and '5 %' exactly as it does on plain numbers.
    "invoice_price", "taxable_value", "quantity", "uom_qty",
    "sgst_amount", "cgst_amount", "igst_amount", "gst_amount",
    "sgst_pct", "cgst_pct",
})

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


# Item codes are compared as strings so leading zeros survive. Anything
# shorter than this is a line serial ("1", "23"), not a catalog code.
_MIN_CODE_LEN = 4
# sku_code / plu_code widths in product_catalog, used to restore lost zeros.
_CATALOG_CODE_WIDTHS = (6, 8)
# Item codes looked up per request — keeps the PostgREST query string bounded.
_CODE_QUERY_CHUNK = 80


def _code_str(val: object) -> Optional[str]:
    """'00565701' stays as-is; a JSON-mangled 565701.0 becomes '565701'."""
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    if re.fullmatch(r"\d+\.0+", s):
        s = s.split(".")[0]
    return s


def _code_variants(val: object) -> set[str]:
    """
    Every spelling of an invoice item code worth looking up: as printed, plus
    zero-stripped and zero-padded forms, because OCR and upstream exports
    routinely drop the leading zeros product_catalog keeps ('565701' is the
    same item as '00565701'). Empty for values too short to be a real code.
    """
    s = _code_str(val)
    if not s:
        return set()
    core = s.lstrip("0") or s
    if len(core) < _MIN_CODE_LEN:
        return set()
    if not s.isdigit():
        return {s}
    variants = {s, core}
    for width in _CATALOG_CODE_WIDTHS:
        if len(core) <= width:
            variants.add(core.zfill(width))
    return variants


def _item_code_variants(item: dict) -> list[str]:
    """Lookup keys for whichever item-code columns the invoice carried."""
    out: list[str] = []
    for field in ("plu_code", "sku_code"):
        for v in sorted(_code_variants(item.get(field))):
            if v not in out:
                out.append(v)
    return out


def normalize_item(raw: dict) -> dict:
    """
    Remap OCR field names to canonical names; unknown keys are kept as-is.
    Values of canonical numeric fields are coerced to floats, so '5%' from the
    invoice compares equal to 5.00 in the catalog instead of being skipped
    (locally) or flagged as a formatting discrepancy (by Gemini).
    """
    out: dict = {}
    for k, v in raw.items():
        canonical = (
            _infer_tax_component(k)
            or _FIELD_ALIASES.get(_norm_key(k))
            or _infer_canonical(k)
            or k
        )
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


def _name_tokens(product_name: str) -> list[str]:
    """Lower-cased word tokens of a product name, used for candidate scoring."""
    return [
        tok.lower()
        for tok in re.split(r"[^A-Za-z0-9&]+", product_name.strip())
        if tok and not _SIZE_TOKEN_RE.match(tok)
    ]


# A token this similar to a catalog word is treated as the same word misspelt.
# Calibrated on real catalog data: "tennis"/"tennies" = 0.92 and "ball"/"balls"
# = 0.89 are the same product, while "cotton"/"cricket" = 0.31 and
# "ball"/"balloons" = 0.67 are not. 0.85 sits in the empty band between them.
_FUZZY_TOKEN_THRESHOLD = 0.85
# Below this length a single edit swamps the ratio ("pen"/"pin" = 0.67), so
# short tokens must match exactly.
_FUZZY_MIN_TOKEN_LEN = 5


def _fuzzy_token_hit(tok: str, desc_words: set[str]) -> float:
    """
    Best similarity between `tok` and any word of the description, as a credit
    in [0, 1]; 0.0 when nothing clears _FUZZY_TOKEN_THRESHOLD.

    This is what lets an invoice "TENNIS BALL" find the catalog's misspelt
    "CRICKET TENNIES BALL" — a plain substring search never can.
    """
    if len(tok) < _FUZZY_MIN_TOKEN_LEN:
        return 0.0
    best = 0.0
    for word in desc_words:
        if not word or abs(len(word) - len(tok)) > 3:
            continue  # length gap that far apart is never a typo
        ratio = difflib.SequenceMatcher(None, tok, word).ratio()
        if ratio > best:
            best = ratio
    return best if best >= _FUZZY_TOKEN_THRESHOLD else 0.0


def _name_match_score(query_tokens: list[str], description: object) -> float:
    """
    How well a catalog description covers the invoice product name: 1.0 when
    every invoice word appears as a whole word in the description.

    Whole-word hits count fully; near-miss hits count almost as much, so a
    misspelt master record still outranks an unrelated one that happens to
    share a common word; substring hits count a fraction, so "SCRUBBER" never
    outranks "RUBBER BANDS" for the query word "rubber".
    """
    desc = str(description or "").lower()
    if not query_tokens or not desc:
        return 0.0
    desc_words = set(re.split(r"[^a-z0-9&]+", desc))
    score = 0.0
    for tok in query_tokens:
        if tok in desc_words:
            score += 1.0
            continue
        fuzzy = _fuzzy_token_hit(tok, desc_words)
        if fuzzy:
            # Scaled by similarity so an exact hit always beats a near one.
            score += fuzzy
        elif len(tok) >= 4 and tok in desc:
            score += 0.25
    return score / len(query_tokens)


def _best_name_score(query_tokens: list[str], row: dict) -> float:
    """
    Score a catalog row on whichever of its two description columns fits the
    invoice name better. The short description is not a truncation of the long
    one — the ERP supplies it separately, brand-stripped and abbreviated
    ("COCA COLA 2LTR" / "COKE 2L") — so an invoice name may only resemble one
    of them.
    """
    return max(
        _name_match_score(query_tokens, row.get("sku_description")),
        _name_match_score(query_tokens, row.get("sku_short_description")),
    )


def _norm_name(value: object) -> str:
    """
    Product name reduced to comparable form, so differences in case, spacing
    and punctuation ('Rubber-Ball,  Magbol') do not hide an identical product.
    """
    return " ".join(t for t in re.split(r"[^a-z0-9&]+", str(value or "").lower()) if t)


def _exact_name_rows(product_name: str, rows: list[dict]) -> list[dict]:
    """
    Rows describing exactly this product. More than one means the same product
    exists under several PLUs, which the multi-PLU flow already handles.
    """
    target = _norm_name(product_name)
    if not target:
        return []
    return [
        r for r in rows
        if target in (_norm_name(r.get("sku_description")),
                      _norm_name(r.get("sku_short_description")))
    ]


def _corroborated_rows(rows: list[dict], product_name: str) -> list[dict]:
    """
    Keep only code-matched rows whose description shares something with the
    invoice product name. An invoice item code can belong to the vendor rather
    than to this catalog, and a confident wrong match is worse than a flag.
    Rows pass unfiltered when the line has no usable product name to check.
    """
    tokens = _name_tokens(product_name)
    if not tokens:
        return rows
    # Either description may be the one that corroborates the code — the short
    # form drops the brand, so it can match an invoice name the long form misses.
    corroborated = [r for r in rows if _best_name_score(tokens, r) > 0]
    return corroborated


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
        # The ERP's brand-stripped alias, carried through so the multi-PLU
        # picker can show it: it is often the form a user recognises when the
        # long description is unfamiliar. Nothing renders it yet.
        "sku_short_desc": r.get("sku_short_description"),
        "ean_code":   r.get("ean_code"),
        "cost_price": r.get("cost_price"),
        "mrp":        r.get("mrp"),
        "tax_pct":    r.get("gst_percent"),
        "priority":   r.get("priority"),
        # Pack size — the frontend re-derives a missing cost price when the
        # user picks a PLU, and cannot do that without it.
        "uom":        r.get("uom"),
        "uom_qty":    r.get("uom_qty"),
    }


# How many candidates to surface alongside a match the user may want to override.
_MAX_OPTIONS = 5

# Name-search tunables: how many words of the product name are searched, how
# many rows each word may contribute, and how many survive ranking.
#
# The fetch limit is per probe and exists only to bound a pathological query,
# not to rank — ranking happens in Python over the pooled rows. It was 25,
# which on a 20k-row catalog silently dropped correct matches: a common word
# like "BALL" matches 59 rows of which 51 share priority=1, so
# `ORDER BY priority LIMIT 25` returned an arbitrary 25 of the 51 and the right
# row was discarded before it could ever be scored.
# One shared pool for every probe fan-out, rather than a pool per call.
# get_supabase() hands out one client per thread, so fresh threads would mean a
# fresh client and TLS handshake on every line item. Sized to cover a whole
# fan-out at once (the full name plus _MAX_SEARCH_KEYWORDS words) with room for
# a second request running alongside; beyond that, probes queue rather than
# opening more connections to the database.
_PROBE_POOL = ThreadPoolExecutor(max_workers=10, thread_name_prefix="catalog-probe")

_MAX_SEARCH_KEYWORDS = 4
_KEYWORD_FETCH_LIMIT = 400
_MAX_CANDIDATES = 20

# Words are also probed by prefix, so a description that misspells the tail of
# a word ("TENNIS" vs "TENNIES") is still retrieved. Short enough to survive a
# typo, long enough not to drag in unrelated rows.
_PREFIX_PROBE_LEN = 5


def _ilike_pattern(text: str) -> str:
    """
    Wrap a search term for ILIKE. Characters PostgREST reads as wildcards are
    replaced by a wildcard rather than escaped: in an OCR'd name they are noise
    ("5% PACK" vs "5 PACK"), so matching anything there is the wanted result.
    """
    return "%{}%".format(re.sub(r"[%_*]+", "%", text.strip()))


def _or_ilike_filter(pattern: str) -> str:
    """
    An `or=` filter matching `pattern` against either description column.

    PostgREST parses `or=(...)` on commas and parentheses, so a product name
    containing them ("PACK (2), 500G") would otherwise split the filter into
    nonsense and error the query. They are replaced by a wildcard for the same
    reason _ilike_pattern replaces the wildcard characters: in an OCR'd name
    they are noise, and matching anything in their place is what we want.
    """
    safe = re.sub(r'[(),."]+', "%", pattern)
    return f"sku_description.ilike.{safe},sku_short_description.ilike.{safe}"


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
# Derived cost price
# ---------------------------------------------------------------------------

# Money is compared to the paisa, so the derived figure is published at the same
# precision. Only the final value is rounded — rounding the base cost first
# turns 12.4992 into 12.4952, which then reads as a discrepancy against a
# catalog cost of 12.50.
_COST_PRECISION = 2

# Below this the derivation is dividing by noise (a zero rate, a blank qty) and
# would publish a confidently wrong cost.
_MIN_DERIVE_INPUT = 0.0001


def _norm_uom(val: object) -> str:
    """'BOX', 'Box.', 'boxes' → 'BOX'. Empty when the value carries no letters."""
    letters = re.sub(r"[^A-Za-z]", "", str(val or "")).upper()
    return letters[:-2] if letters.endswith("ES") else letters.rstrip("S")


def _uom_compatible(item: dict, master: dict) -> bool:
    """
    Whether the invoice quantity counts the same thing the catalog's uom_qty
    unpacks. When the invoice prints 'PCS' against a catalog 'BOX' its quantity
    is already in individual units, so applying uom_qty would count the pack
    twice — better to leave the cost blank than to state a wrong one. A line
    that prints no UOM at all is taken at the catalog's word.
    """
    inv_uom    = _norm_uom(item.get("uom"))
    master_uom = _norm_uom(master.get("uom"))
    if not inv_uom or not master_uom:
        return True
    return inv_uom == master_uom


def _tax_total(item: dict) -> Optional[float]:
    """
    The line's total tax: SGST + CGST + IGST as printed, or a combined GST
    amount column when the invoice does not split them. None when the invoice
    shows no tax amount at all — 0.0 is a real (exempt) answer and is kept.
    """
    parts = [
        _to_float(item.get(f))
        for f in ("sgst_amount", "cgst_amount", "igst_amount")
    ]
    present = [p for p in parts if p is not None]
    if present:
        return sum(present)
    return _to_float(item.get("gst_amount"))


def _gst_rate(item: dict) -> Optional[float]:
    """The line's full GST rate, reassembled from the halves if that is all
    the invoice printed."""
    rate = _to_float(item.get("gst_percent"))
    if rate is not None:
        return rate
    halves = [_to_float(item.get("sgst_pct")), _to_float(item.get("cgst_pct"))]
    present = [h for h in halves if h is not None]
    return sum(present) if present else None


def _fmt_num(val: float) -> str:
    """Trim a computed float for display: 11.904 stays, 10.0 becomes 10."""
    return f"{val:.4f}".rstrip("0").rstrip(".") or "0"


def derive_cost_price(item: dict, master: dict) -> tuple[Optional[float], Optional[dict]]:
    """
    Reconstruct the per-unit cost price of a line the invoice never printed one
    for, from the money it did print plus the catalog's pack size.

    An invoice prices a pack ("119.04 per BOX") while the catalog costs an
    individual unit, so the two only meet once uom_qty is applied:

        base cost per unit = invoice price / uom_qty        119.04 / 10 = 11.904
        tax per unit       = line tax / (qty * uom_qty)     29.76 / 50  = 0.5952
        cost price         = base + tax                                 = 12.50

    The tax leg falls back to the GST rate when the invoice prints no tax
    amounts; the two routes are algebraically the same, since the printed
    SGST + CGST is itself qty * price * rate.

    Returns (value, breakdown) — (None, None) whenever an input is missing,
    non-positive, or the units do not line up. A cost price the invoice *did*
    print is never overwritten.
    """
    if _to_float(item.get("cost_price")) is not None:
        return None, None
    if not _uom_compatible(item, master):
        return None, None

    uom_qty = _to_float(master.get("uom_qty"))
    if uom_qty is None:
        uom_qty = _to_float(item.get("uom_qty"))
    # A catalog that does not unpack the UOM sells the invoiced unit itself.
    if uom_qty is None:
        uom_qty = 1.0
    if uom_qty < _MIN_DERIVE_INPUT:
        return None, None

    quantity = _to_float(item.get("quantity"))

    # Unit price as printed, else recovered from the line total before tax.
    unit_price = _to_float(item.get("invoice_price"))
    price_note = "invoice price"
    if unit_price is None:
        taxable = _to_float(item.get("taxable_value"))
        if taxable is None or quantity is None or quantity < _MIN_DERIVE_INPUT:
            return None, None
        unit_price = taxable / quantity
        price_note = "taxable value / qty"
    if unit_price < _MIN_DERIVE_INPUT:
        return None, None

    base_unit_cost = unit_price / uom_qty

    tax_total   = _tax_total(item)
    total_units = quantity * uom_qty if quantity is not None else None
    if tax_total is not None and total_units is not None and total_units >= _MIN_DERIVE_INPUT:
        tax_per_unit = tax_total / total_units
        source       = "tax_amounts"
        tax_formula  = f"{_fmt_num(tax_total)} / {_fmt_num(total_units)}"
    else:
        rate = _gst_rate(item)
        if rate is None:
            return None, None
        tax_per_unit = base_unit_cost * rate / 100.0
        source       = "gst_rate"
        tax_formula  = f"{_fmt_num(base_unit_cost)} x {_fmt_num(rate)}%"

    cost_price = round(base_unit_cost + tax_per_unit, _COST_PRECISION)
    if cost_price <= 0:
        return None, None

    breakdown = {
        "value":          cost_price,
        "source":         source,
        "unit_price":     round(unit_price, 4),
        "price_source":   price_note,
        "uom_qty":        uom_qty,
        "uom":            master.get("uom") or item.get("uom"),
        "quantity":       quantity,
        "base_unit_cost": round(base_unit_cost, 4),
        "tax_total":      tax_total,
        "total_units":    total_units,
        "tax_per_unit":   round(tax_per_unit, 4),
        "formula": (
            f"{_fmt_num(unit_price)} / {_fmt_num(uom_qty)} + {tax_formula} "
            f"= {cost_price:.2f}"
        ),
    }
    return cost_price, breakdown


def with_derived_cost(
    item: dict, master: dict, log: bool = True
) -> tuple[dict, Optional[dict]]:
    """
    `item` with a derived cost_price filled in where the invoice left one out,
    plus the breakdown that produced it (None when nothing was derived).

    Applied per candidate row rather than once per line, because uom_qty is a
    property of the PLU: two candidates can imply two different unit costs.
    """
    value, breakdown = derive_cost_price(item, master)
    if value is None:
        # Only interesting when a cost price was actually wanted: a line that
        # printed one is supposed to skip this path silently. Named inputs make
        # an unrecognised column header a one-line diagnosis instead of a
        # guessing game about why a line came back blank.
        if log and _to_float(item.get("cost_price")) is None:
            print(
                f"[validate-data] cost price not derived — plu={master.get('plu_code')} "
                f"reason={_derive_blocker(item, master)} keys={sorted(item.keys())}"
            )
        return item, None
    return {**item, "cost_price": value}, breakdown


def _derive_blocker(item: dict, master: dict) -> str:
    """Which input stopped derive_cost_price() — for the log line above."""
    if not _uom_compatible(item, master):
        return (
            f"uom mismatch (invoice {item.get('uom')!r} vs catalog {master.get('uom')!r})"
        )
    uom_qty = _to_float(master.get("uom_qty"))
    if uom_qty is None:
        uom_qty = _to_float(item.get("uom_qty"))
    if uom_qty is not None and uom_qty < _MIN_DERIVE_INPUT:
        return f"uom_qty is {uom_qty}"

    quantity = _to_float(item.get("quantity"))
    if _to_float(item.get("invoice_price")) is None:
        if _to_float(item.get("taxable_value")) is None:
            return "no unit price and no taxable value on the line"
        if quantity is None or quantity < _MIN_DERIVE_INPUT:
            return "taxable value present but quantity missing"
    if _tax_total(item) is None and _gst_rate(item) is None:
        return "no tax amount and no gst rate on the line"
    return "inputs present but non-positive"


def _derived_fields(breakdown: Optional[dict]) -> dict:
    """
    The `derived_fields` key for a validation result, or nothing at all.

    A derived cost price is filled into the item so every existing consumer
    (comparison table, export) shows it, which would otherwise make it
    indistinguishable from a figure the vendor printed. This is what lets the
    UI label it as computed and show the arithmetic behind it.
    """
    if not breakdown:
        return {}
    return {"derived_fields": {"cost_price": breakdown}}


def _row_by_plu(rows: list[dict], plu: object) -> Optional[dict]:
    """The row Gemini named, matched on PLU as a string so 02176501 and
    2176501 do not miss each other."""
    if plu is None:
        return None

    def key(val: object) -> str:
        code = _code_str(val) or ""
        # A PLU that survived a JSON round-trip as a number has lost its
        # leading zeros; the catalog's has not.
        return code.lstrip("0") or code

    target = key(plu)
    for r in rows:
        if key(r.get("plu_code")) == target:
            return r
    return None


def _reconcile_cost_price(validation: dict, item: dict, master: dict) -> None:
    """
    Re-decide the cost_price verdict in place, now that the line has a derived
    cost to compare. Gemini saw no cost price at all, so whatever it said about
    the field was said blind: any existing cost_price discrepancy is replaced,
    never stacked on top of.
    """
    inv_val    = _to_float(item.get("cost_price"))
    master_val = _to_float(master.get("cost_price"))

    validation["discrepancies"] = [
        d for d in validation.get("discrepancies", []) if d.get("field") != "cost_price"
    ]
    corrections = dict(validation.get("suggested_corrections") or {})
    corrections.pop("cost_price", None)

    if inv_val is not None and master_val is not None and abs(inv_val - master_val) > 0.01:
        validation["discrepancies"].append({
            "field":    "cost_price",
            "expected": master_val,
            "actual":   inv_val,
            "message": (
                f"Cost Price mismatch: invoice works out to {inv_val}, "
                f"master has {master_val}."
            ),
        })
        corrections["cost_price"] = master_val

    validation["suggested_corrections"] = corrections


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

    # Compared on normalised form: case, spacing and punctuation differences
    # are OCR noise, not a data discrepancy worth showing the user.
    inv_desc = _norm_name(item.get("sku_description"))
    master_desc = _norm_name(master.get("sku_description"))
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

        # Both descriptions are shown: the short form is the ERP's own
        # brand-stripped alias ("COKE 2L" for "COCA COLA 2LTR"), so it often
        # resembles the invoice wording more closely than the long one, and it
        # also reveals a misspelling present in only one of the two.
        candidates_lines = [
            f"  PLU {r['plu_code']} | EAN {r.get('ean_code')} | "
            f"'{r.get('sku_description') or '—'}' | "
            f"short: '{r.get('sku_short_description') or '—'}' | "
            f"Cost={r.get('cost_price')}, MRP={r.get('mrp')}, GST%={r.get('gst_percent')}"
            for r in candidates
        ]
        candidates_json = json.dumps([
            {k: r.get(k) for k in ("plu_code", "ean_code", "sku_description", "sku_short_description", "cost_price", "mrp", "gst_percent", "priority")}
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
   Master descriptions are ERP-entered and may be MISSPELT or abbreviated
   ("TENNIES" for "TENNIS"), and the short description drops the brand
   ("COKE 2L" for "COCA COLA 2LTR"). Judge the product identity, not the
   spelling: a misspelt record naming the same product beats a correctly
   spelt record naming a different one.
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

    def _fetch_master_by_codes(self, codes: list[str], company_id: str = "") -> dict[str, list[dict]]:
        """
        Batch fetch product_catalog rows whose plu_code OR sku_code matches any
        of the invoice item codes. Keyed by both columns, so a line can be
        looked up by whichever code it happened to print.
        """
        lookup: dict[str, list[dict]] = {}
        # Chunked: every code goes into the URL twice (once per column), so a
        # 100-line invoice would otherwise build a query string long enough to
        # be rejected before it reaches PostgREST.
        for start in range(0, len(codes), _CODE_QUERY_CHUNK):
            chunk = codes[start:start + _CODE_QUERY_CHUNK]
            quoted = ",".join('"{}"'.format(c.replace('"', "")) for c in chunk)
            q = (
                get_supabase()
                .table("product_catalog")
                .select("*")
                .or_(f"plu_code.in.({quoted}),sku_code.in.({quoted})")
                .order("priority")
            )
            if company_id:
                q = q.eq("company_id", company_id)
            for row in q.execute().data:
                for col in ("plu_code", "sku_code"):
                    key = _code_str(row.get(col))
                    if key and row not in lookup.setdefault(key, []):
                        lookup[key].append(row)
        return lookup

    def _fetch_candidates_by_name(self, product_name: str, company_id: str = "") -> list[dict]:
        """
        ILIKE search on sku_description for EVERY meaningful word of the invoice
        product name — not just the first one that returns rows. A common word
        ("RUBBER" also matches "SCRUBBER") floods the result set and would bury
        the real record, so the rarer words are always searched too and the
        pooled rows are re-ranked by how much of the invoice name they cover.

        Both description columns are searched. sku_short_description is not a
        truncation of sku_description — the ERP supplies it separately, with
        the brand stripped and words abbreviated ("COCA COLA 2LTR" is stored
        alongside "COKE 2L") — so an invoice name frequently matches only one
        of the two.

        Returns at most _MAX_CANDIDATES rows, best match first.
        """
        keywords = _name_keywords(product_name)[:_MAX_SEARCH_KEYWORDS]
        if not keywords:
            return []

        def probe(pattern: str) -> list[dict]:
            q = (
                get_supabase()
                .table("product_catalog")
                .select("*")
                # Either description column may carry the recognisable name.
                .or_(_or_ilike_filter(pattern))
                # plu_code breaks priority ties deterministically. Without it a
                # truncated result set is an arbitrary sample of the tied rows,
                # so the same query can return different rows run to run.
                .order("priority")
                .order("plu_code")
                .limit(_KEYWORD_FETCH_LIMIT)
            )
            if company_id:
                q = q.eq("company_id", company_id)
            return q.execute().data

        def run(patterns: list[str]) -> list[list[dict]]:
            """
            Probes are independent queries, so they go out together rather than
            one round-trip after another — this function is already called once
            per line item, and the round-trips dominate its cost. Results are
            returned in `patterns` order, so pooling stays deterministic.
            """
            if len(patterns) == 1:
                return [probe(patterns[0])]
            return list(_PROBE_POOL.map(probe, patterns))

        # The whole description first. A row containing the entire invoice name
        # is the answer, and a per-word search can bury it behind rows that
        # merely share one common word.
        wave1 = [_ilike_pattern(product_name)] + [_ilike_pattern(k) for k in keywords]
        results = run(wave1)

        pooled: dict[str, dict] = {}

        def absorb(rows: list[dict]) -> None:
            for row in rows:
                pooled.setdefault(str(row.get("plu_code") or row.get("id")), row)

        for rows in results:
            absorb(rows)

        # Prefix probes retrieve rows whose spelling diverges after the first
        # few characters, which an exact substring search misses entirely. Only
        # worth a round-trip for a word that found nothing — that is exactly the
        # misspelt case ("TENNIS" finds no row because the catalog says
        # "TENNIES"). When the word did match, the prefix returns a superset we
        # do not need and every lookup would pay for it.
        prefixes: list[str] = []
        for keyword, rows in zip(keywords, results[1:]):
            if rows or len(keyword) <= _PREFIX_PROBE_LEN:
                continue
            prefix = _ilike_pattern(keyword[:_PREFIX_PROBE_LEN])
            if prefix not in prefixes:
                prefixes.append(prefix)
        if prefixes:
            for rows in run(prefixes):
                absorb(rows)

        tokens = _name_tokens(product_name)
        target = _norm_name(product_name)

        def sort_key(r: dict) -> tuple:
            score = _best_name_score(tokens, r)
            names = (_norm_name(r.get("sku_description")),
                     _norm_name(r.get("sku_short_description")))
            # A description identical to the invoice name is the answer and must
            # never be cut by the _MAX_CANDIDATES trim. Without this an invoice
            # name that reduces to one common token ("MAGGI 560GM" -> "maggi")
            # leaves every MAGGI row tied on score, and the exact row can lose
            # its place to an arbitrary sibling.
            exact = 0 if target and target in names else 1
            # Among equal scores prefer the tighter description: every query
            # word is present in both, so the one carrying fewer unrelated
            # extra words is the closer product ("TATA SALT 1KG" over
            # "TATA SALT PLUS IRON+IODINE 1KG"). Only ever a tiebreaker.
            extra = min(
                (len([w for w in re.split(r"[^a-z0-9&]+", n) if w and w not in tokens])
                 for n in names if n),
                default=10**6,
            )
            return (
                exact,
                -score,
                extra,
                r.get("priority") if r.get("priority") is not None else 10**9,
                str(r.get("plu_code") or ""),
            )

        ranked = sorted(pooled.values(), key=sort_key)
        return ranked[:_MAX_CANDIDATES]

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

        # Item codes printed on the invoice — the fallback lookup key for lines
        # whose EAN is missing or absent from the catalog.
        item_codes = sorted({v for item in items for v in _item_code_variants(item)})

        master_lookup, code_lookup = await asyncio.gather(
            asyncio.to_thread(self._fetch_master_lookup, ean_codes, company_id),
            asyncio.to_thread(self._fetch_master_by_codes, item_codes, company_id),
        )

        results: list[dict | None] = []
        gemini_queue: list[tuple[int, object, str | None]] = []
        # placeholder_idx → the candidate rows Gemini chose from, so its pick can
        # be shown alongside the runners-up (and so a null-match result can still
        # surface "considered" products to pick from).
        queued_candidates: dict[int, list[dict]] = {}

        for item in items:
            ean = _ean_str(item.get("ean_code"))
            # Identification cascade — each step runs only when the previous
            # one found nothing, and every step but the last is exact, so a
            # line is never sent to Gemini while a definite match exists:
            #   1. EAN   2. invoice item code   3. identical name   4. fuzzy
            master_rows  = master_lookup.get(ean or "", []) if ean else []
            match_source = "ean" if master_rows else None
            candidates: list[dict] = []

            product_name = str(item.get("sku_description") or item.get("product_name") or "")
            # Fall back whenever the mapped name is unusable for search —
            # missing, or a value like "1" from a mislabelled column.
            if not _name_keywords(product_name):
                product_name = _best_effort_name(item) or product_name

            # ── 2. No EAN match: try the item code the invoice printed ───
            if not master_rows:
                code_rows: list[dict] = []
                for variant in _item_code_variants(item):
                    for row in code_lookup.get(variant, []):
                        if row not in code_rows:
                            code_rows.append(row)
                code_rows = _corroborated_rows(code_rows, product_name)
                if code_rows:
                    master_rows  = code_rows
                    match_source = "item_code"

            # ── 3. Still nothing: an identical product name is a match ───
            if not master_rows:
                candidates = await asyncio.to_thread(
                    self._fetch_candidates_by_name, product_name, company_id
                )
                exact_rows = _exact_name_rows(product_name, candidates)
                if exact_rows:
                    master_rows  = exact_rows
                    match_source = "name_exact"

            # ── 4. Nothing exact: let Gemini judge the near misses ───────
            if not master_rows:
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
                                "message":  (
                                    "EAN code not found in master catalog and no similar "
                                    "product name could be matched."
                                    if ean else
                                    "No EAN code on this line, and neither its item code nor "
                                    "its product name matched a master record."
                                ),
                            }],
                            "suggested_corrections": {},
                        },
                    }
                continue

            # ── Single PLU fast path ─────────────────────────────────────
            if len(master_rows) == 1:
                matched_exact += 1
                priced, derived = with_derived_cost(item, master_rows[0])
                results.append({
                    **priced,
                    "validation": {
                        **local_compare(priced, master_rows[0]),
                        "match_source": match_source,
                        **_derived_fields(derived),
                    },
                })
                continue

            # ── Multiple PLUs ────────────────────────────────────────────
            # Derivation is per row: uom_qty belongs to the PLU, so each
            # candidate implies its own unit cost and must be compared against
            # the one it implies.
            # Every candidate is tried, but only the first reports a failure:
            # the blocker is a property of the invoice line, so N candidates
            # would otherwise print N copies of the same diagnosis.
            priced_rows  = [
                with_derived_cost(item, r, log=(i == 0))
                for i, r in enumerate(master_rows)
            ]
            comparisons  = [
                (r, priced, derived, local_compare(priced, r))
                for r, (priced, derived) in zip(master_rows, priced_rows)
            ]
            clean = next(
                ((r, priced, derived, cmp) for r, priced, derived, cmp in comparisons
                 if not cmp["discrepancies"]),
                None,
            )

            if clean:
                _, priced, derived, cmp = clean
                matched_exact += 1
                results.append({
                    **priced,
                    "validation": {
                        **cmp,
                        "match_source": match_source,
                        **_derived_fields(derived),
                    },
                })
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
                        priced, derived = with_derived_cost(item, master_rows_fb[0])
                        results[result_idx] = {
                            **priced,
                            "validation": {
                                **local_compare(priced, master_rows_fb[0]),
                                "match_type": "auto_selected",
                                **_derived_fields(derived),
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

                    # Gemini is told to skip fields the invoice left blank, so a
                    # cost price that only exists once the pack size is applied
                    # is invisible to it. Derive it here — against the record it
                    # actually chose, since uom_qty is per-PLU — and reconcile
                    # the cost_price verdict with the value that produces.
                    matched_row = _row_by_plu(
                        queued_candidates.get(result_idx, []),
                        validation.get("matched_plu"),
                    )
                    if matched_row is not None:
                        item, derived = with_derived_cost(item, matched_row)
                        if derived:
                            validation.update(_derived_fields(derived))
                            _reconcile_cost_price(validation, item, matched_row)

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
