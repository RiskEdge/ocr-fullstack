"""Structured-output schema for document extraction.

Gemini is called with `response_schema=Document`, so the model is constrained at
decode time instead of merely being asked for a shape in the prompt. Three tiers
of field live here and every value on an invoice belongs to exactly one:

1. Canonical named fields — only for what the app computes with: catalog
   matching (the vocabulary in `validation.py`'s `_RAW_FIELD_ALIASES`) and
   grand-total reconciliation (`ValidationResults.tsx`). Naming these the same
   way the rest of the stack already names them is what makes the aliasing a
   pass-through rather than a guess.
2. Open labelled lists — for structures whose rows vary but whose shape does
   not: `InvoiceSummary.charges`, `tax_summary`.
3. `additional_fields` — the catch-all, present at every level, expressing
   "anything else printed here" as a list of key/value pairs.
   `page_to_extracted_data()` folds it back into real dict keys on the way out.

These models are *not* handed to Gemini as a `response_schema`. Constraining the
decoder with a schema this wide made it loop — see `ocr.py`'s `_JSON_SHAPE`.
`schema_outline()` renders the same field vocabulary into the prompt instead,
and `coerce_document()` + Pydantic validation put the free-form reply back on
the rails afterwards, so the models remain the single source of truth for what
a document may contain.
"""

from __future__ import annotations

import json
import re
from typing import Any, List, Optional, Union, get_args, get_origin

from pydantic import BaseModel, Field


class KeyValue(BaseModel):
    """One label/value pair the named fields do not cover."""

    key: str = Field(description="The label exactly as printed on the document")
    value: Optional[str] = None


class ChargeLine(BaseModel):
    """A labelled figure in a totals block.

    Invoices print these as free text — 'SGST', 'Round Off', 'Freight', 'TCS',
    'Adj.' — so the label is captured verbatim rather than mapped to a fixed
    key. Recognised labels are *also* mirrored into the named `InvoiceSummary`
    fields; this list is what makes an unrecognised one survive.
    """

    label: str = Field(description="The charge label exactly as printed")
    amount: Optional[float] = None
    percent: Optional[float] = None


class Party(BaseModel):
    """A named party on the invoice — supplier, buyer or consignee."""

    name: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    state: Optional[str] = None
    state_code: Optional[str] = None
    pan: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    fssai_no: Optional[str] = None
    dl_no: Optional[str] = Field(default=None, description="Drug licence number")
    additional_fields: List[KeyValue] = []


class LineItem(BaseModel):
    """One product row of the item table.

    Field names are the canonical ones `validation.py` resolves invoice headers
    to, so a row arrives already speaking the vocabulary the matcher expects.
    """

    serial_no: Optional[str] = None
    sku_description: Optional[str] = Field(
        default=None,
        description="Product name — 'Description of Goods', 'Particulars', 'Item Description'",
    )
    hsn_code: Optional[str] = None
    ean_code: Optional[str] = Field(default=None, description="EAN / barcode")
    sku_code: Optional[str] = Field(default=None, description="Item / product / article code")
    batch_no: Optional[str] = None
    expiry: Optional[str] = None

    mrp: Optional[float] = Field(default=None, description="Maximum retail price. Never the invoice rate")
    quantity: Optional[float] = Field(
        default=None,
        description="Numeric quantity only. A cell reading '6 Pcs' gives quantity 6 and uom 'Pcs'",
    )
    free_quantity: Optional[float] = Field(default=None, description="A 'Free' or 'Scheme Qty' column")
    uom: Optional[str] = Field(
        default=None,
        description="Unit — from a 'UOM', 'per' or 'Unit' column, or merged into the quantity cell",
    )
    uom_qty: Optional[float] = Field(
        default=None, description="Units inside one invoiced pack — 'Pack Size', 'Conversion Factor'"
    )

    invoice_price: Optional[float] = Field(
        default=None,
        description=(
            "Pre-tax price of one invoiced unit — 'Rate', 'Basic Rate', 'B.Rate', "
            "'PC Price', 'Rate Excl', 'Basic Cost'"
        ),
    )
    invoice_price_incl: Optional[float] = Field(
        default=None, description="Tax-inclusive unit rate — only from a 'Rate Inc' style column"
    )
    cost_price: Optional[float] = Field(
        default=None, description="Only from a column literally labelled 'Cost Price'"
    )

    gross_amount: Optional[float] = None
    discount_pct: Optional[float] = Field(default=None, description="'Disc. %', 'C.D %', 'Discount %'")
    discount_amount: Optional[float] = Field(default=None, description="'Disc Amount', in currency")
    scheme_amount: Optional[float] = Field(default=None, description="'Scheme', 'Schemes', 'Scheme Amount'")
    taxable_value: Optional[float] = Field(
        default=None, description="Pre-tax line value — 'Taxable Amount', 'Assessable Value'"
    )

    gst_percent: Optional[float] = Field(
        default=None, description="Combined GST rate — 'GST %', 'GST Rate', 'Tax %'"
    )
    cgst_percent: Optional[float] = None
    cgst_amount: Optional[float] = None
    sgst_percent: Optional[float] = None
    sgst_amount: Optional[float] = None
    igst_percent: Optional[float] = None
    igst_amount: Optional[float] = None
    cess_amount: Optional[float] = None

    net_amount: Optional[float] = Field(
        default=None, description="The line's final figure — 'Amount', 'Net Amount'"
    )

    additional_fields: List[KeyValue] = Field(
        default=[], description="Any column of this row not covered by a field above"
    )


class TaxSummaryRow(BaseModel):
    """One row of the HSN-wise tax summary table, never a product row."""

    hsn_code: Optional[str] = None
    taxable_value: Optional[float] = None
    cgst_percent: Optional[float] = None
    cgst_amount: Optional[float] = None
    sgst_percent: Optional[float] = None
    sgst_amount: Optional[float] = None
    igst_percent: Optional[float] = None
    igst_amount: Optional[float] = None
    cess_amount: Optional[float] = None
    total_tax: Optional[float] = None


class InvoiceSummary(BaseModel):
    """The totals block. Every figure is as printed, never recomputed."""

    subtotal: Optional[float] = None
    taxable_value: Optional[float] = None
    total_tax: Optional[float] = None
    cgst_total: Optional[float] = None
    sgst_total: Optional[float] = None
    igst_total: Optional[float] = None
    cess_total: Optional[float] = None
    freight_charges: Optional[float] = None
    other_charges: Optional[float] = None
    discount: Optional[float] = None
    tcs: Optional[float] = None
    round_off: Optional[float] = Field(
        default=None, description="Signed the way it moves the total, e.g. -0.30"
    )
    grand_total: Optional[float] = Field(default=None, description="The final amount payable")
    total_quantity: Optional[float] = Field(
        default=None, description="Numeric part of a total-quantity cell such as '99 Pcs'"
    )
    total_quantity_uom: Optional[str] = None
    total_items: Optional[int] = None
    charges: List[ChargeLine] = Field(
        default=[], description="Every labelled figure in the totals block, label verbatim"
    )


class Page(BaseModel):
    """Everything printed on one physical page."""

    page_number: int
    document_type: Optional[str] = Field(default=None, description="e.g. 'Tax Invoice', 'Credit Note'")

    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = Field(default=None, description="Exactly as printed; do not reformat")
    due_date: Optional[str] = None
    po_number: Optional[str] = None
    po_date: Optional[str] = None
    eway_bill_no: Optional[str] = None
    vehicle_no: Optional[str] = None
    transporter: Optional[str] = None
    place_of_supply: Optional[str] = None
    irn: Optional[str] = None

    supplier: Optional[Party] = Field(default=None, description="Seller / vendor issuing the invoice")
    buyer: Optional[Party] = Field(default=None, description="'Buyer', 'Bill to'")
    consignee: Optional[Party] = Field(
        default=None,
        description="'Consignee', 'Ship to' — a separate block even when identical to the buyer",
    )

    line_items: List[LineItem] = []
    line_item_columns: List[str] = Field(
        default=[], description="The item table's header row, verbatim, left to right"
    )
    tax_summary: List[TaxSummaryRow] = []
    invoice_summary: Optional[InvoiceSummary] = None

    amount_in_words: Optional[str] = None
    tax_amount_in_words: Optional[str] = None
    declaration: Optional[str] = None
    authorised_signatory: Optional[str] = None
    bank_details: Optional[str] = None

    annotations: List[KeyValue] = Field(
        default=[], description="Rubber stamps, seals and handwriting. Never invoice data"
    )
    additional_fields: List[KeyValue] = Field(
        default=[], description="Anything printed on this page no field above covers"
    )
    confidence_score: float = Field(default=0.9, description="0-1 confidence in this page's extraction")


class Document(BaseModel):
    total_pages: int
    pages: List[Page]


# ---------------------------------------------------------------------------
# Prompt side — the same field vocabulary, rendered for Gemini
# ---------------------------------------------------------------------------

_TYPE_NAMES = {str: "string", float: "number", int: "integer", bool: "boolean"}


def _unwrap_optional(annotation):
    """`Optional[float]` -> `float`. Anything else is returned unchanged."""
    if get_origin(annotation) is Union:
        args = [arg for arg in get_args(annotation) if arg is not type(None)]
        if len(args) == 1:
            return args[0]
    return annotation


def _render_type(annotation, depth: int, seen: dict, label: str) -> str:
    inner = _unwrap_optional(annotation)
    if get_origin(inner) is list:
        args = get_args(inner)
        element = _unwrap_optional(args[0]) if args else str
        return "[" + _render_type(element, depth, seen, label) + ", ...]"
    if isinstance(inner, type) and issubclass(inner, BaseModel):
        return _render_model(inner, depth, seen, label)
    return _TYPE_NAMES.get(inner, "string")


def _render_model(model, depth: int, seen: dict, label: str) -> str:
    # Party is printed three times over; naming the repeat instead of expanding
    # it keeps the outline short enough to sit in every prompt. Two- and
    # three-field helpers are cheaper inline than as a back-reference.
    reusable = len(model.model_fields) > 6
    if reusable and model in seen:
        return '{ ...same keys as "%s"... }' % seen[model]
    if reusable:
        seen[model] = label
    pad = "  " * (depth + 1)
    lines = [
        '%s"%s": %s' % (pad, name, _render_type(field.annotation, depth + 1, seen, name))
        for name, field in model.model_fields.items()
    ]
    return "{\n" + ",\n".join(lines) + "\n" + "  " * depth + "}"


def schema_outline() -> str:
    """The `Document` shape as a JSON skeleton for the extraction prompt.

    Gemini is no longer given these models as a `response_schema` — a schema
    this wide sent the constrained decoder into a repetition loop on dense
    invoices — so the field names have to reach it through the prompt instead.
    Generating the outline from the models rather than hand-writing it is what
    stops the prompt and `coerce_document()` drifting apart as fields are added.
    """
    return _render_model(Document, 0, {}, "document")


# ---------------------------------------------------------------------------
# Repair — free-form Gemini JSON back onto the models
# ---------------------------------------------------------------------------


def _numeric_fields(model) -> set:
    return {
        name
        for name, field in model.model_fields.items()
        if _unwrap_optional(field.annotation) in (float, int)
    }


_PAGE_FIELDS = set(Page.model_fields)
_PARTY_FIELDS = set(Party.model_fields)
_LINE_ITEM_FIELDS = set(LineItem.model_fields)
_TAX_ROW_FIELDS = set(TaxSummaryRow.model_fields)
_SUMMARY_FIELDS = set(InvoiceSummary.model_fields)

_PAGE_NUMERIC = _numeric_fields(Page)
_PARTY_NUMERIC = _numeric_fields(Party)
_LINE_ITEM_NUMERIC = _numeric_fields(LineItem)
_TAX_ROW_NUMERIC = _numeric_fields(TaxSummaryRow)
_SUMMARY_NUMERIC = _numeric_fields(InvoiceSummary)

_NUMBER_NOISE_RE = re.compile(r"[^0-9.\-]")


def _as_number(value):
    """'1,262.42', '18 %' or '16,753.00/-' -> a float, or None.

    The prompt asks for plain numbers, but nothing enforces it now that the
    decoder is unconstrained, and Pydantic rejects '1,262.42' outright — which
    would fail a whole document over one stray separator.
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    cleaned = _NUMBER_NOISE_RE.sub("", value.replace(",", "")).rstrip(".")
    if cleaned in ("", "-", "."):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _scalar_text(value):
    """A value destined for a `KeyValue.value`, which only holds strings."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _as_list(value) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return [value]
    return []


def _as_pairs(value) -> list:
    """Whatever came back for a key/value list -> `[{key, value}]`.

    Unconstrained, the model spells this list several different ways across
    runs: `{"key","value"}`, `{"label","amount"}`, `{"text": "..."}`, or a bare
    string. Each still carries a label and a figure, so each is accepted rather
    than dropped on the floor.
    """
    if value is None:
        return []
    if isinstance(value, dict):
        value = [{"key": key, "value": val} for key, val in value.items()]
    elif not isinstance(value, list):
        value = [value]

    pairs = []
    for entry in value:
        if entry is None:
            continue
        if not isinstance(entry, dict):
            pairs.append({"key": "note", "value": _scalar_text(entry)})
            continue
        label = entry.get("key") or entry.get("label") or entry.get("name") or entry.get("field")
        if label is None:
            free_text = entry.get("text") or entry.get("note") or entry.get("description")
            if free_text is not None:
                pairs.append({"key": "note", "value": _scalar_text(free_text)})
            else:
                pairs.extend(
                    {"key": str(key), "value": _scalar_text(val)} for key, val in entry.items()
                )
            continue
        for value_key in ("value", "text", "amount", "val"):
            if value_key in entry:
                pairs.append({"key": str(label), "value": _scalar_text(entry[value_key])})
                break
        else:
            pairs.append({"key": str(label), "value": None})
    return pairs


def _as_charges(value) -> list:
    if isinstance(value, dict):
        value = [{"label": key, "amount": val} for key, val in value.items()]
    out = []
    for entry in _as_list(value):
        if not isinstance(entry, dict):
            continue
        label = entry.get("label") or entry.get("key") or entry.get("name")
        if not label:
            continue
        out.append(
            {
                "label": str(label),
                "amount": _as_number(entry.get("amount", entry.get("value"))),
                "percent": _as_number(entry.get("percent")),
            }
        )
    return out


def _split_known(raw: dict, known: set, numeric: set):
    """Split a dict into the model's own fields and everything else.

    Numeric fields are coerced here rather than left to Pydantic, so a rate that
    came back as '87.01 Pcs' becomes 87.01 instead of failing the document.
    """
    kept, extras = {}, []
    for key, value in raw.items():
        if key in known:
            kept[key] = _as_number(value) if key in numeric and isinstance(value, str) else value
        else:
            extras.append({"key": str(key), "value": _scalar_text(value)})
    return kept, extras


def _coerce_party(raw):
    if not isinstance(raw, dict):
        return None
    kept, extras = _split_known(raw, _PARTY_FIELDS, _PARTY_NUMERIC)
    kept["additional_fields"] = _as_pairs(kept.get("additional_fields")) + extras
    return kept


def _coerce_line_item(raw):
    if not isinstance(raw, dict):
        return None
    kept, extras = _split_known(raw, _LINE_ITEM_FIELDS, _LINE_ITEM_NUMERIC)
    kept["additional_fields"] = _as_pairs(kept.get("additional_fields")) + extras
    return kept


def _coerce_tax_row(raw):
    if not isinstance(raw, dict):
        return None
    # No `additional_fields` on a tax row: an unmapped column here is a rate or
    # an amount the summary already carries, not a figure needing a new key.
    kept, _ = _split_known(raw, _TAX_ROW_FIELDS, _TAX_ROW_NUMERIC)
    return kept


def _coerce_summary(raw: dict) -> dict:
    kept, extras = _split_known(raw, _SUMMARY_FIELDS, _SUMMARY_NUMERIC)
    # An unrecognised totals key is a labelled figure by another name, and
    # `charges` is exactly where labelled figures live.
    stray = [{"label": pair["key"], "amount": pair["value"]} for pair in extras]
    kept["charges"] = _as_charges(kept.get("charges")) + _as_charges(stray)
    return kept


def _coerce_page(raw, index: int):
    if not isinstance(raw, dict):
        return None
    # The old wire format, in case the model echoes the envelope back at us.
    nested = raw.get("extracted_data")
    if isinstance(nested, dict):
        raw = {**{k: v for k, v in raw.items() if k != "extracted_data"}, **nested}
    raw = dict(raw)

    # Totals hung off the page instead of off the totals block. Nothing forces
    # the nesting any more, and a page-level `grand_total` is still the grand
    # total — the reconciliation downstream only ever reads `invoice_summary`.
    summary = raw.pop("invoice_summary", None)
    summary = dict(summary) if isinstance(summary, dict) else {}
    for key in list(raw):
        if key not in _PAGE_FIELDS and key in _SUMMARY_FIELDS:
            summary.setdefault(key, raw.pop(key))

    raw["invoice_summary"] = _coerce_summary(summary) if summary else None
    raw["line_items"] = [
        item for item in (_coerce_line_item(x) for x in _as_list(raw.get("line_items"))) if item
    ]
    raw["tax_summary"] = [
        row for row in (_coerce_tax_row(x) for x in _as_list(raw.get("tax_summary"))) if row
    ]
    for party_key in ("supplier", "buyer", "consignee"):
        if party_key in raw:
            raw[party_key] = _coerce_party(raw[party_key])
    raw["annotations"] = _as_pairs(raw.get("annotations"))

    kept, extras = _split_known(raw, _PAGE_FIELDS, _PAGE_NUMERIC)
    kept["additional_fields"] = _as_pairs(kept.get("additional_fields")) + extras
    kept["page_number"] = _as_number(kept.get("page_number")) or index
    return kept


def coerce_document(raw) -> Document:
    """Free-form Gemini JSON -> a validated `Document`.

    Every repair above exists because the reply is no longer schema-constrained:
    this is the layer that makes an unconstrained answer as safe to hand
    downstream as a constrained one was, without the decoder loop.
    """
    if isinstance(raw, list):
        raw = {"pages": raw}
    if not isinstance(raw, dict):
        raise ValueError("Gemini returned JSON that is not an object")

    pages_raw = raw.get("pages")
    if not isinstance(pages_raw, list):
        # A single page emitted without the envelope around it.
        pages_raw = [raw] if _PAGE_FIELDS & set(raw) else []

    pages = [page for page in (_coerce_page(p, i) for i, p in enumerate(pages_raw, start=1)) if page]
    if not pages:
        raise ValueError("Gemini returned no pages")
    return Document.model_validate({"total_pages": len(pages), "pages": pages})


# ---------------------------------------------------------------------------
# Flattening — model back to the wire format the frontend already parses
# ---------------------------------------------------------------------------

_SLUG_RE = re.compile(r"[^a-z0-9]+")

# Charge labels, as invoices print them, mapped to the summary field that holds
# the same figure. Used by `_fold_charges` to repair a totals block the model
# recorded only as labelled lines.
_CHARGE_LABEL_TO_FIELD: dict[str, str] = {
    "total": "grand_total",
    "grand_total": "grand_total",
    "invoice_total": "grand_total",
    "bill_total": "grand_total",
    "net_total": "grand_total",
    "total_payable": "grand_total",
    "amount_payable": "grand_total",
    "net_payable": "grand_total",
    "total_amount_payable": "grand_total",
    "net_amount_payable": "grand_total",
    "total_invoice_value": "grand_total",
    "cgst": "cgst_total",
    "cgst_total": "cgst_total",
    "total_cgst": "cgst_total",
    "cgst_amount": "cgst_total",
    "sgst": "sgst_total",
    "sgst_utgst": "sgst_total",
    "utgst": "sgst_total",
    "sgst_total": "sgst_total",
    "total_sgst": "sgst_total",
    "sgst_amount": "sgst_total",
    "igst": "igst_total",
    "igst_total": "igst_total",
    "total_igst": "igst_total",
    "igst_amount": "igst_total",
    "cess": "cess_total",
    "cess_amount": "cess_total",
    "tax": "total_tax",
    "total_tax": "total_tax",
    "total_tax_amount": "total_tax",
    "gst": "total_tax",
    "total_gst": "total_tax",
    "round_off": "round_off",
    "rounded_off": "round_off",
    "rounding": "round_off",
    "rounding_off": "round_off",
    "round_off_amount": "round_off",
    "rounding_adjustment": "round_off",
    "freight": "freight_charges",
    "freight_charges": "freight_charges",
    "discount": "discount",
    "less_discount": "discount",
    "total_discount": "discount",
    "discount_amount": "discount",
    "tcs": "tcs",
    "tcs_amount": "tcs",
    "sub_total": "subtotal",
    "subtotal": "subtotal",
    "taxable_value": "taxable_value",
    "taxable_amount": "taxable_value",
    "total_taxable_value": "taxable_value",
    "other_charges": "other_charges",
    "misc_charges": "other_charges",
    "miscellaneous_charges": "other_charges",
}


def _slugify(label: str) -> str:
    """'Vessel/Flight No.' -> 'vessel_flight_no'."""
    return _SLUG_RE.sub("_", label.strip().lower()).strip("_")


def _is_empty(value) -> bool:
    """Empty means absent. 0 and False are values and are kept."""
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, dict)):
        return len(value) == 0
    return False


def _prune(value):
    """Drop absent leaves recursively, so a field only appears when printed.

    Without this every document would carry the full field list padded with
    nulls: unreadable in the table, noisy in the CSV/Excel export, and it would
    flatten `total_fields_extracted` (counted in `stream_documents` as the
    number of top-level keys) into a constant.
    """
    if isinstance(value, dict):
        out: dict = {}
        for key, val in value.items():
            cleaned = _prune(val)
            if not _is_empty(cleaned):
                out[key] = cleaned
        return out
    if isinstance(value, list):
        out_list: list = []
        for item in value:
            cleaned = _prune(item)
            if not _is_empty(cleaned):
                out_list.append(cleaned)
        return out_list
    return value


def _inflate(target: dict, pairs: list) -> None:
    """Fold a KeyValue list into `target` as real keys.

    A named field always wins a collision — the extras are the fallback, not an
    override — so a clashing pair is parked under a numbered suffix instead of
    overwriting. Insertion order puts the schema's fields ahead of the extras,
    which is the order the table and the exports render in.
    """
    for pair in pairs or []:
        if not isinstance(pair, dict):
            continue
        label = (pair.get("key") or "").strip()
        value = pair.get("value")
        if not label or _is_empty(value):
            continue
        slug = _slugify(label) or "field"
        if slug in target:
            if str(target[slug]) == str(value):
                continue
            suffix = 2
            while f"{slug}_{suffix}" in target:
                suffix += 1
            slug = f"{slug}_{suffix}"
        target[slug] = value


def _fold_charges(summary: dict) -> None:
    """Mirror each printed charge line into a scalar key on the summary.

    The frontend's reconciliation reads scalar fields and skips arrays outright,
    so a figure that lands only in `charges` is invisible to it: the grand total
    reads as "not detected" and the ladder loses its rungs. Rather than trust
    the model to fill both places, recognised labels fill their canonical field
    here whenever it was left empty, and unrecognised ones are kept under their
    own slugified label so nothing printed is dropped.

    A label that maps to a canonical field never also gets a slug key — two
    spellings of one figure invite it being counted twice. `charges` itself
    stays as the verbatim record of how the block was printed.
    """
    for charge in summary.get("charges") or []:
        if not isinstance(charge, dict):
            continue
        label = (charge.get("label") or "").strip()
        amount = charge.get("amount")
        # A bare percentage is not a rung on the ladder; only money is folded.
        if not label or amount is None:
            continue
        slug = _slugify(label)
        if not slug:
            continue
        field = _CHARGE_LABEL_TO_FIELD.get(slug)
        if field:
            if _is_empty(summary.get(field)):
                summary[field] = amount
            continue
        if _is_empty(summary.get(slug)):
            summary[slug] = amount


def page_to_extracted_data(page: dict) -> dict:
    """One `Page` dump -> the flat `extracted_data` dict the frontend reads.

    `page_number` is lifted out by the caller; everything else keeps the key
    names the schema uses, with the key/value escape hatches folded back into
    ordinary keys so nothing downstream has to know they existed.
    """
    data = dict(page)
    data.pop("page_number", None)

    for item in data.get("line_items") or []:
        if isinstance(item, dict):
            _inflate(item, item.pop("additional_fields", []))

    for party_key in ("supplier", "buyer", "consignee"):
        party = data.get(party_key)
        if isinstance(party, dict):
            _inflate(party, party.pop("additional_fields", []))

    summary = data.get("invoice_summary")
    if isinstance(summary, dict):
        _fold_charges(summary)

    # Stamps and handwriting stay in their own nested object: visible in the
    # table, but never sitting beside the invoice's own fields, where a stamped
    # date could be read as the invoice date.
    annotations: dict = {}
    _inflate(annotations, data.pop("annotations", []))
    if annotations:
        data["annotations"] = annotations

    _inflate(data, data.pop("additional_fields", []))

    confidence = data.pop("confidence_score", 0.9)
    data = _prune(data)
    data["confidence_score"] = confidence
    return data


def document_to_content(document: Document) -> dict:
    """`Document` -> the `{total_pages, pages[]}` envelope the stream emits.

    A page number is only allowed to appear once. A model that emits the same
    page twice is making an error, not describing a document with two identical
    pages, and the frontend pools line items across pages and flattens them —
    so a repeat would render, export and validate every row of that page twice.
    """
    dumped = document.model_dump()
    pages = []
    seen: set[int] = set()
    for index, page in enumerate(dumped.get("pages") or [], start=1):
        number = page.get("page_number") or index
        if number in seen:
            continue
        seen.add(number)
        pages.append(
            {
                "page_number": number,
                "extracted_data": page_to_extracted_data(page),
            }
        )
    return {
        # Counted after de-duplication, so the page count and the pages agree.
        "total_pages": len(pages) or dumped.get("total_pages") or 1,
        "pages": pages,
    }
