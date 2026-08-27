import { useState, useMemo, useEffect, useRef, Fragment } from "react";
import { useBehaviorTracker } from "@/hooks/useBehaviorTracker";
import {
  recordFlagExposure,
  recordDismissal,
  recordInvestigation,
  recordFieldCorrection,
  getFieldHints,
  getUserProfile,
  updateUserPreferences,
} from "@/lib/profilesApi";
import type { FieldHint } from "@/lib/profilesApi";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow as UITableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Info,
  Wand2,
  HelpCircle,
  Layers,
  Download,
  Pencil,
  Calculator,
  Sparkles,
} from "lucide-react";
import type {
  ValidatedItem,
  Discrepancy,
  DerivedField,
  ValidationResult,
  PluOption,
} from "@/lib/validateApi";

const FIELD_LABELS: Record<string, string> = {
  cost_price: "Cost Price",
  mrp: "MRP",
  // Canonical invoice-side names, as normalised by the backend. Without these
  // the table headers and discrepancy rows read "Gst Percent" / "Sku
  // Description".
  gst_percent: "Tax %",
  sku_description: "Product Name",
  // Catalog-side and pre-normalisation spellings of the same two fields.
  tax_pct: "Tax %",
  ean_code: "EAN Code",
  product_name: "Product Name",
  sku_desc: "Product Name",
  quantity: "Qty",
  plu_code: "PLU",
  invoice_price: "Invoice Price",
  taxable_value: "Taxable Value",
  sgst_amount: "SGST",
  cgst_amount: "CGST",
  igst_amount: "IGST",
  gst_amount: "GST Amount",
  uom: "UOM",
  uom_qty: "UOM Qty",
};

// The item keys a comparison field can arrive under. The backend normalises
// OCR headers, but older cached runs and the raw extraction both use variants,
// so every lookup tries them in order.
const INVOICE_KEYS: Record<string, string[]> = {
  sku_description: ["sku_description", "sku_desc", "product_name"],
  gst_percent: ["gst_percent", "tax_pct"],
  ean_code: ["ean_code", "ean"],
};

/**
 * What the invoice actually says for a comparison field.
 *
 * Discrepancies carry their own `actual`, but Gemini returns null for a field
 * it could not read and a field with no discrepancy has no row at all — in
 * both cases the item itself still holds the value, so the comparison tables
 * fall back to it rather than showing a dash.
 */
function invoiceValueFor(item: ValidatedItem, field: string): unknown {
  for (const key of INVOICE_KEYS[field] ?? [field]) {
    const val = item[key];
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return undefined;
}

function fieldLabel(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (Array.isArray(val)) return val.map((v) => String(v ?? "")).join(", ");
  if (typeof val === "object") return "—";
  return String(val);
}

// A discrepancy is resolved when the user has explicitly accepted a value for the field.
function isResolved(
  d: Discrepancy,
  accepted: Set<string> | undefined,
): boolean {
  return accepted?.has(d.field) ?? false;
}

function num(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = parseFloat(String(val).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? null : n;
}

function normUom(val: unknown): string {
  const letters = String(val ?? "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
  return letters.endsWith("ES") ? letters.slice(0, -2) : letters.replace(/S$/, "");
}

/**
 * Client-side mirror of the backend's derive_cost_price().
 *
 * Needed because picking a PLU in the multi-PLU table re-runs the comparison
 * locally against a different catalog row — and uom_qty belongs to the row, so
 * the cost the invoice implies changes with the pick.
 *
 *   base cost per unit = invoice price / uom_qty
 *   tax per unit       = line tax / (qty * uom_qty)   (or base * gst%)
 */
function deriveCostPrice(
  item: ValidatedItem,
  master: PluOption,
): DerivedField | null {
  // A cost_price the backend derived belongs to the PLU *it* matched, so it
  // must not block re-derivation against the row the user picked instead —
  // only a figure the invoice actually printed does.
  const wasDerived = !!item.validation?.derived_fields?.cost_price;
  if (!wasDerived && num(item["cost_price"]) !== null) return null;

  const invUom = normUom(item["uom"]);
  const masterUom = normUom(master.uom);
  // Quantities counted in different units cannot be reconciled — an invoice in
  // PCS against a catalog BOX would apply the pack size twice.
  if (invUom && masterUom && invUom !== masterUom) return null;

  const uomQty = num(master.uom_qty) ?? num(item["uom_qty"]) ?? 1;
  if (uomQty <= 0) return null;

  const quantity = num(item["quantity"]);

  let unitPrice = num(item["invoice_price"]);
  if (unitPrice === null) {
    const taxable = num(item["taxable_value"]);
    if (taxable === null || quantity === null || quantity <= 0) return null;
    unitPrice = taxable / quantity;
  }
  if (unitPrice <= 0) return null;

  const baseUnitCost = unitPrice / uomQty;

  const taxParts = ["sgst_amount", "cgst_amount", "igst_amount"]
    .map((k) => num(item[k]))
    .filter((n): n is number => n !== null);
  const taxTotal = taxParts.length
    ? taxParts.reduce((a, b) => a + b, 0)
    : num(item["gst_amount"]);
  const totalUnits = quantity !== null ? quantity * uomQty : null;

  let taxPerUnit: number;
  let source: DerivedField["source"];
  let taxFormula: string;
  if (taxTotal !== null && totalUnits !== null && totalUnits > 0) {
    taxPerUnit = taxTotal / totalUnits;
    source = "tax_amounts";
    taxFormula = `${trimNum(taxTotal)} / ${trimNum(totalUnits)}`;
  } else {
    const rate =
      num(item["gst_percent"]) ??
      num(item["tax_pct"]) ??
      (() => {
        const halves = ["sgst_pct", "cgst_pct"]
          .map((k) => num(item[k]))
          .filter((n): n is number => n !== null);
        return halves.length ? halves.reduce((a, b) => a + b, 0) : null;
      })();
    if (rate === null) return null;
    taxPerUnit = (baseUnitCost * rate) / 100;
    source = "gst_rate";
    taxFormula = `${trimNum(baseUnitCost)} x ${trimNum(rate)}%`;
  }

  // Only the final value is rounded — rounding the base cost first turns
  // 12.4992 into 12.4952, which then reads as a discrepancy.
  const value = Math.round((baseUnitCost + taxPerUnit) * 100) / 100;
  if (value <= 0) return null;

  return {
    value,
    source,
    unit_price: unitPrice,
    uom: master.uom ?? (item["uom"] as string | null),
    uom_qty: uomQty,
    base_unit_cost: baseUnitCost,
    total_units: totalUnits,
    tax_per_unit: taxPerUnit,
    formula: `${trimNum(unitPrice)} / ${trimNum(uomQty)} + ${taxFormula} = ${value.toFixed(2)}`,
  };
}

function trimNum(val: number): string {
  return String(parseFloat(val.toFixed(4)));
}

/**
 * Marks a value that was computed rather than read off the invoice, and shows
 * the arithmetic behind it. Without this a derived cost price is
 * indistinguishable from one the vendor actually printed.
 */
function DerivedBadge({ derived }: { derived: DerivedField }) {
  const unitLabel = derived.uom ? ` per ${derived.uom}` : "";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-0.5 rounded bg-blue-500/10 px-1 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400 cursor-help align-middle">
          <Calculator className="w-2.5 h-2.5" />
          derived
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="font-medium">Not printed on the invoice</p>
        <p className="font-mono text-xs mt-1">{derived.formula}</p>
        <p className="text-xs mt-1 opacity-80">
          {`${trimNum(derived.unit_price ?? 0)}${unitLabel}`}
          {derived.uom_qty ? ` ÷ ${trimNum(derived.uom_qty)} units` : ""}
          {derived.source === "tax_amounts"
            ? ", plus the line's GST spread over every unit."
            : ", plus GST at the line's rate."}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The three numeric fields a catalog row is compared on.
 *
 * The invoice side and the catalog side spell two of them differently: the
 * backend normalises every OCR header onto `gst_percent`, while `master_items`
 * calls the same number `tax_pct`. Everything keyed off a *discrepancy* — the
 * edits map, accepted-field highlighting, the CSV export, correction hints —
 * uses the invoice-side name, so that is what `field` carries. Mixing the two
 * is what previously made an accepted tax correction vanish from the table.
 */
const COMPARE_FIELDS: Array<{
  field: string;
  masterKey: "cost_price" | "mrp" | "tax_pct";
}> = [
  { field: "cost_price", masterKey: "cost_price" },
  { field: "mrp", masterKey: "mrp" },
  { field: "gst_percent", masterKey: "tax_pct" },
];

// Client-side comparison mirroring backend local_compare logic.
function computeLocalValidation(
  item: ValidatedItem,
  master: PluOption,
): {
  discrepancies: Discrepancy[];
  corrections: Record<string, number | string>;
  derived: DerivedField | null;
} {
  const discrepancies: Discrepancy[] = [];
  const corrections: Record<string, number | string> = {};

  // A cost price the invoice never printed but the pack size implies — so
  // picking a PLU compares against the cost that PLU actually works out to
  // instead of skipping the field.
  const derived = deriveCostPrice(item, master);

  const invoiceField = (field: string): unknown =>
    field === "gst_percent"
      ? (item["gst_percent"] ?? item.tax_pct)
      : field === "cost_price"
        ? // The freshly derived value wins: any cost_price already on the item
          // was derived against a different PLU's pack size.
          (derived?.value ?? item.cost_price)
        : item[field];

  for (const { field, masterKey } of COMPARE_FIELDS) {
    const invVal = parseFloat(String(invoiceField(field) ?? ""));
    const masterVal = parseFloat(String(master[masterKey] ?? ""));
    if (isNaN(invVal) || isNaN(masterVal)) continue;
    if (Math.abs(invVal - masterVal) > 0.01) {
      discrepancies.push({
        field,
        expected: masterVal,
        actual: invVal,
        message: `${fieldLabel(field)} mismatch: invoice has ${invVal}, master has ${masterVal}.`,
      });
      corrections[field] = masterVal;
    }
  }

  const invDescRaw = String(
    item["sku_description"] ?? item.sku_desc ?? item.product_name ?? "",
  );
  const invDesc = invDescRaw.trim().toUpperCase();
  const masterDesc = String(master.sku_desc ?? "")
    .trim()
    .toUpperCase();
  if (invDesc && masterDesc && invDesc !== masterDesc) {
    discrepancies.push({
      field: "sku_description",
      expected: master.sku_desc,
      actual: invDescRaw,
      message: `Product description mismatch: invoice has '${invDescRaw}', master has '${master.sku_desc}'.`,
    });
    corrections["sku_description"] = master.sku_desc ?? "";
  }

  return { discrepancies, corrections, derived };
}

interface PluSelection {
  plu_code: string;
  discrepancies: Discrepancy[];
  corrections: Record<string, number | string>;
  /** Cost price this PLU's pack size implies, when the invoice printed none. */
  derived: DerivedField | null;
}

/** Middle columns a candidate table can carry, between PLU/name and the
 *  differences summary. */
type OptionColumn = "ean" | "cost_price" | "mrp" | "tax_pct" | "priority";

const OPTION_COLUMNS: Record<
  OptionColumn,
  {
    header: string;
    value: (opt: PluOption) => string | number | null | undefined;
    /** Discrepancy field this column tracks, when a mismatch should colour it. */
    compare?: string;
    /** Value for the invoice reference row; a column without one sits empty. */
    invoice?: (item: ValidatedItem) => string;
    mono?: boolean;
  }
> = {
  ean: {
    header: "EAN",
    value: (opt) => opt.ean_code,
    invoice: (item) => String(item.ean_code ?? "—"),
    mono: true,
  },
  cost_price: {
    header: "Cost Price",
    value: (opt) => opt.cost_price,
    compare: "cost_price",
    invoice: (item) => String(item.cost_price ?? "—"),
    mono: true,
  },
  mrp: {
    header: "MRP",
    value: (opt) => opt.mrp,
    compare: "mrp",
    invoice: (item) => String(item.mrp ?? "—"),
    mono: true,
  },
  tax_pct: {
    header: "Tax %",
    value: (opt) => opt.tax_pct,
    compare: "gst_percent",
    invoice: (item) => String(item["gst_percent"] ?? item.tax_pct ?? "—"),
    mono: true,
  },
  priority: {
    header: "Priority",
    value: (opt) => opt.priority,
  },
};

const DEFAULT_OPTION_COLUMNS: OptionColumn[] = [
  "ean",
  "cost_price",
  "mrp",
  "tax_pct",
];

// The one candidate table behind every place a catalog record gets picked: the
// multi-PLU chooser, the runners-up behind a fuzzy or auto-selected match, and
// the records considered for an item that matched nothing. They differ only in
// which middle columns they carry and whether the invoice values head the
// table, so those are props rather than three copies of the markup.
function MatchOptionsTable({
  item,
  options,
  columns = DEFAULT_OPTION_COLUMNS,
  showInvoiceRow = true,
  recommendedPlu,
  activePlu,
  onSelect,
}: {
  item: ValidatedItem;
  options: PluOption[];
  columns?: OptionColumn[];
  showInvoiceRow?: boolean;
  recommendedPlu?: string | null;
  activePlu?: string | null;
  onSelect: (opt: PluOption) => void;
}) {
  const cols = columns.map((key) => ({ key, ...OPTION_COLUMNS[key] }));
  return (
    <Table>
      <TableHeader>
        <UITableRow className="bg-muted/50 hover:bg-muted/50">
          <TableHead className="text-xs font-semibold text-foreground">
            PLU Code
          </TableHead>
          <TableHead className="text-xs font-semibold text-foreground">
            Product Name
          </TableHead>
          {cols.map((col) => (
            <TableHead
              key={col.key}
              className="text-xs font-semibold text-foreground"
            >
              {col.header}
            </TableHead>
          ))}
          <TableHead className="text-xs font-semibold text-foreground">
            Differences
          </TableHead>
          <TableHead className="w-24" />
        </UITableRow>
        {/* Invoice reference row */}
        {showInvoiceRow && (
          <UITableRow className="bg-blue-50/60 dark:bg-blue-950/20 hover:bg-blue-50/60">
            <TableCell className="text-xs text-blue-600 dark:text-blue-400 font-semibold py-1.5 italic">
              Invoice
            </TableCell>
            <TableCell className="text-xs font-mono py-1.5 text-blue-700 dark:text-blue-300">
              {String(
                item["sku_description"] ??
                  item.sku_desc ??
                  item.product_name ??
                  "—",
              )}
            </TableCell>
            {cols.map((col) => (
              <TableCell
                key={col.key}
                className="text-xs font-mono py-1.5 text-blue-700 dark:text-blue-300"
              >
                {col.invoice?.(item)}
              </TableCell>
            ))}
            <TableCell className="py-1.5" />
            <TableCell className="py-1.5" />
          </UITableRow>
        )}
      </TableHeader>
      <TableBody>
        {options.map((opt) => {
          const { discrepancies: optDiffs } = computeLocalValidation(item, opt);
          const diffFields = new Set(optDiffs.map((d) => d.field));
          // A column with nothing to compare against stays neutral — only the
          // fields a discrepancy can name are coloured.
          const cellCls = (field?: string) =>
            !field
              ? ""
              : diffFields.has(field)
                ? "text-destructive font-semibold"
                : "text-green-700 dark:text-green-400";
          const isRecommended = opt.plu_code === recommendedPlu;
          const isActive = opt.plu_code === activePlu;
          return (
            <UITableRow
              key={opt.plu_code}
              className={
                isActive
                  ? "bg-violet-50 dark:bg-violet-950/30 hover:bg-violet-50"
                  : isRecommended
                    ? "bg-amber-50/70 dark:bg-amber-950/20 hover:bg-amber-50/70"
                    : "hover:bg-muted/30"
              }
            >
              <TableCell className="text-sm font-mono py-2 whitespace-nowrap">
                <span className="flex items-center gap-1.5">
                  {opt.plu_code}
                  {isRecommended && (
                    <Badge
                      variant="outline"
                      className="text-amber-700 dark:text-amber-400 border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-[10px] px-1.5 py-0 gap-0.5"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      Recommended
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell className={`text-sm py-2 ${cellCls("sku_description")}`}>
                {opt.sku_desc ?? "—"}
              </TableCell>
              {cols.map((col) => (
                <TableCell
                  key={col.key}
                  className={`text-sm py-2 ${col.mono ? "font-mono " : ""}${cellCls(col.compare)}`}
                >
                  {col.value(opt) ?? "—"}
                </TableCell>
              ))}
              <TableCell className="py-2">
                {optDiffs.length === 0 ? (
                  <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    No issues
                  </span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {optDiffs.map((d) => (
                      <Badge
                        key={d.field}
                        variant="outline"
                        className="text-destructive border-destructive/30 bg-destructive/5 text-xs px-1.5 py-0"
                      >
                        {fieldLabel(d.field)}
                      </Badge>
                    ))}
                  </span>
                )}
              </TableCell>
              <TableCell className="py-2" onClick={(e) => e.stopPropagation()}>
                {isActive ? (
                  <span className="flex items-center gap-1 text-xs font-medium text-violet-700 dark:text-violet-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Selected
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => onSelect(opt)}
                  >
                    Select
                  </Button>
                )}
              </TableCell>
            </UITableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Calculation validation — field-name candidates. Every consumer matches
// through normKey(), which lowercases and strips non-alphanumerics, so each
// entry is stored in that form already: adding a "base_rate" beside "baserate"
// buys nothing, both collapse to the same key.
// ---------------------------------------------------------------------------

const TAX_AMOUNT_CANDIDATES = ["taxamount", "taxamt", "gstamount", "vatamount"];
const LINE_AMOUNT_CANDIDATES = [
  "amount",
  "netamount",
  "linetotal",
  "totalamount",
  "value",
  "netvalue",
  "lineamount",
];
// Ordered most-specific first — findGrandTotal walks this list in order and
// takes the first candidate present, so an unambiguous "grand_total" always
// beats a generic "total" that may well be a page subtotal.
const GRAND_TOTAL_CANDIDATES = [
  "grandtotal",
  "grandtotalamount",
  "invoicetotal",
  "totalinvoicevalue",
  "totalinvoiceamount",
  "invoicevalue",
  "invoiceamount",
  "amountpayable",
  "netpayable",
  "payableamount",
  "billamount",
  "nettotal",
  "grosstotal",
  "finalamount",
  "totalamount",
  "nettaxableamount",
  "total",
];

// Per-unit price as printed on the line. This is per invoice UOM — per pack —
// not per catalog unit, which is why it can never be compared against a cost
// price without applying the pack size first.
const UNIT_PRICE_CANDIDATES = [
  "invoiceprice",
  "rate",
  "unitprice",
  "baserate",
  "brate",
  "basicrate",
];
// Pre-tax line value. Only unambiguous names live here; a bare "total" is
// admitted separately and only when the line's structure proves it is pre-tax.
const TAXABLE_VALUE_CANDIDATES = [
  "taxablevalue",
  "taxableamount",
  "assessablevalue",
];
const AMBIGUOUS_TAXABLE_CANDIDATES = ["total", "subtotal", "grossamount"];
// GST components are whole-line figures by invoice convention, never per unit.
// Amount-suffixed names are tried first so a bare "cgst" holding a percentage
// is never summed alongside a real "cgst_amount".
const GST_SPLIT_AMOUNT_CANDIDATES = [
  "cgstamount",
  "cgstamt",
  "sgstamount",
  "sgstamt",
  "igstamount",
  "igstamt",
  "utgstamount",
  "cessamount",
];
const GST_SPLIT_BARE_CANDIDATES = ["cgst", "sgst", "igst", "utgst", "cess"];
const TAX_PCT_CANDIDATES = [
  "taxpct",
  "taxpercent",
  "gstpercent",
  "gstpct",
  "gstrate",
  "taxrate",
];

// Strips every non-alphanumeric character, so "Grand Total (INR)",
// "grand-total" and "grand_total" all collapse to the same key. Kept in sync
// with the normKey used for line-item table detection in Index.tsx.
function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Drops a trailing currency/unit token from an already-normalised key, so
// "totalamountinr" can still match the "totalamount" candidate. Applied only
// when matching grand totals, and only as a fallback.
const CURRENCY_SUFFIX_RE = /(inr|inrs|rs|rupees|usd|eur|gbp)$/;

function stripCurrencySuffix(norm: string): string {
  const stripped = norm.replace(CURRENCY_SUFFIX_RE, "");
  // Guard against eating a whole short key (e.g. "rs" on its own).
  return stripped.length >= 4 ? stripped : norm;
}

// Find a field in an item by any of the candidate keys; returns [key, numericValue].
function findFieldValue(
  item: Record<string, unknown>,
  candidates: string[],
): { key: string; value: number } | null {
  const normCandidates = new Set(candidates.map(normKey));
  for (const [k, v] of Object.entries(item)) {
    if (k === "validation") continue;
    if (normCandidates.has(normKey(k))) {
      // Thousands separators are common in OCR output — parseFloat would
      // silently truncate "1,234.56" to 1 and wreck the line-amount sum.
      const n = parseFloat(String(v ?? "").replace(/[,\s]/g, ""));
      if (!isNaN(n)) return { key: k, value: n };
    }
  }
  return null;
}

// Find a grand-total field in the document-level scalar map. Candidates are
// tried in priority order rather than taking whichever key the document
// happens to list first, so the most specific name present always wins.
function findGrandTotal(
  scalars: Record<string, unknown>,
): { key: string; value: number } | null {
  // Normalised key → original key + parsed value, for every numeric scalar.
  const byNorm = new Map<string, { key: string; value: number }>();
  const numeric: Array<{ key: string; norm: string; value: number }> = [];
  for (const [k, v] of Object.entries(scalars)) {
    const n = parseFloat(String(v ?? "").replace(/[,\s]/g, ""));
    if (isNaN(n)) continue;
    const norm = normKey(k);
    numeric.push({ key: k, norm, value: n });
    // first occurrence of a name wins
    if (!byNorm.has(norm)) byNorm.set(norm, { key: k, value: n });
  }
  // Second pass: currency/unit suffixes ride along on plenty of OCR'd headers
  // — "Total Amount (INR)", "grand_total_rs". Register the stripped form as an
  // alias, but only after every exact name is in, so a key that matches on its
  // own is never displaced by another key's alias.
  for (const { key, norm, value } of numeric) {
    const denoised = stripCurrencySuffix(norm);
    if (denoised !== norm && !byNorm.has(denoised)) {
      byNorm.set(denoised, { key, value });
    }
  }
  for (const candidate of GRAND_TOTAL_CANDIDATES) {
    const hit = byNorm.get(normKey(candidate));
    if (hit) return hit;
  }
  return null;
}

// findFieldValue returns whichever key the item happens to list first. Where
// several candidates could match one slot, priority has to come from the
// candidate list instead, so an explicit "taxable_value" always beats a
// generic "total".
function findFieldOrdered(
  item: Record<string, unknown>,
  candidates: string[],
): { key: string; value: number } | null {
  const byNorm = new Map<string, { key: string; value: number }>();
  for (const [k, v] of Object.entries(item)) {
    if (k === "validation") continue;
    const n = parseFloat(String(v ?? "").replace(/[,\s]/g, ""));
    if (isNaN(n)) continue;
    const nk = normKey(k);
    if (!byNorm.has(nk)) byNorm.set(nk, { key: k, value: n });
  }
  for (const c of candidates) {
    const hit = byNorm.get(normKey(c));
    if (hit) return hit;
  }
  return null;
}

// Adds up every matching column — a GST total is split across CGST and SGST,
// so no single field holds it.
function sumFields(
  item: Record<string, unknown>,
  candidates: string[],
): { keys: string[]; value: number } | null {
  const norm = new Set(candidates.map(normKey));
  const keys: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(item)) {
    if (k === "validation") continue;
    if (!norm.has(normKey(k))) continue;
    const n = parseFloat(String(v ?? "").replace(/[,\s]/g, ""));
    if (isNaN(n)) continue;
    keys.push(k);
    total += n;
  }
  return keys.length ? { keys, value: parseFloat(total.toFixed(4)) } : null;
}

interface CalcCheck {
  label: string;
  field: string;
  formula: string;
  calculated: number;
  actual: number;
  ok: boolean;
  /** False when the correct value cannot be written back to one column — a GST
   *  total split across CGST/SGST has no single field to accept it into. */
  acceptable?: boolean;
}

interface LineCalcResult {
  idx: number;
  checks: CalcCheck[];
}

interface CalcValidationResult {
  lineResults: LineCalcResult[];
  lineAmountSum: number;
  grandTotalCheck: {
    field: string;
    documentTotal: number;
    ok: boolean;
    /** Lines that contributed an amount to lineAmountSum. */
    linesCounted: number;
    /** Total lines on the invoice. */
    linesTotal: number;
    /** True when some line had no recognisable amount column, so the sum is
     *  known to be short and a mismatch is not necessarily a real discrepancy. */
    partial: boolean;
  } | null;
}

// ---------------------------------------------------------------------------

// Maps a discrepancy field to a stable flag_type string for the profiles API.
function getDiscrepancyFlagType(field: string): string {
  return `${field}_discrepancy`;
}

// Returns an item-level flag_type for investigation records.
function getItemFlagType(matchType?: string): string {
  if (matchType === "no_match") return "no_match";
  if (matchType === "fuzzy_name") return "fuzzy_match";
  if (matchType === "multi_plu") return "multi_plu";
  return "field_discrepancy";
}

interface Props {
  items: ValidatedItem[];
  documentScalars?: Record<string, unknown>;
  sourceFilename?: string;
}

const ValidationResults = ({
  items,
  documentScalars,
  sourceFilename,
}: Props) => {
  const track = useBehaviorTracker({ sourceFilename });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Record<number, Record<string, string>>>(
    {},
  );
  const [pluSelections, setPluSelections] = useState<
    Record<number, PluSelection>
  >({});
  const [acceptedFields, setAcceptedFields] = useState<
    Record<number, Set<string>>
  >({});
  const [editingDiscrepancy, setEditingDiscrepancy] = useState<
    Record<number, Set<string>>
  >({});
  // Rows whose full-field editor is open. Every row can be edited, not just
  // unmatched ones — a clean match can still carry a mis-read value.
  const [editingRow, setEditingRow] = useState<Set<number>>(new Set());
  // Phase 2: dismissals and investigation outcomes
  const [dismissedFields, setDismissedFields] = useState<
    Record<number, Set<string>>
  >({});
  const [itemOutcomes, setItemOutcomes] = useState<Record<number, string>>({});
  // Phase 2: flags suppressed by the backend (low_signal_flags from user_profiles)
  const [suppressedFlags, setSuppressedFlags] = useState<Set<string>>(
    new Set(),
  );
  // PLU auto-select preference
  const [autoSelectPlu, setAutoSelectPlu] = useState(false);
  // Feedback flash: itemIdx → last clicked feedback type, auto-clears after 1.5s
  const [feedbackFlash, setFeedbackFlash] = useState<Record<number, string>>({});
  // Tracks which (itemIdx:flagType) combos have had flag-exposure fired this session.
  const exposedRef = useRef<Set<string>>(new Set());
  // hint map: key is `${plu_code}:${field}` or `${ean_code}:${field}`
  const [hintMap, setHintMap] = useState<Map<string, FieldHint>>(new Map());
  // Ref for the copy event listener (copied_summary signal)
  const containerRef = useRef<HTMLDivElement>(null);

  // Fire flag-exposure for discrepancies/match-types as rows are expanded.
  useEffect(() => {
    for (const idx of expanded) {
      const v = items[idx]?.validation;
      if (!v) continue;
      // Field-level discrepancies
      for (const d of v.discrepancies) {
        const key = `${idx}:${getDiscrepancyFlagType(d.field)}`;
        if (!exposedRef.current.has(key)) {
          exposedRef.current.add(key);
          recordFlagExposure(getDiscrepancyFlagType(d.field));
        }
      }
      // Match-type flags
      if (
        v.match_type === "no_match" ||
        v.match_type === "fuzzy_name" ||
        v.match_type === "multi_plu"
      ) {
        const flagType = getItemFlagType(v.match_type);
        const key = `${idx}:${flagType}`;
        if (!exposedRef.current.has(key)) {
          exposedRef.current.add(key);
          recordFlagExposure(flagType);
        }
      }
    }
  }, [expanded, items]);

  // Fetch user profile on mount → populate suppressedFlags + autoSelectPlu.
  useEffect(() => {
    getUserProfile().then((profile) => {
      if (profile?.low_signal_flags?.length) {
        setSuppressedFlags(new Set(profile.low_signal_flags));
      }
      if (profile?.auto_select_plu) {
        setAutoSelectPlu(true);
      }
    });
  }, []);

  // copied_summary — fires whenever the user copies text from within the validation UI.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = () => track("copied_summary");
    el.addEventListener("copy", handler);
    return () => el.removeEventListener("copy", handler);
  }, [track]);

  // Fetch field correction hints for all matched PLUs/EANs once items arrive.
  useEffect(() => {
    const pluCodes = items
      .map((item) => item.validation?.matched_plu)
      .filter((p): p is string => Boolean(p));
    const eanCodes = items
      .map((item) => item.ean_code)
      .filter((e): e is string => Boolean(e));
    if (!pluCodes.length && !eanCodes.length) return;
    getFieldHints(pluCodes, eanCodes).then((hints) => {
      const map = new Map<string, FieldHint>();
      for (const h of hints) {
        const key = h.plu_code
          ? `${h.plu_code}:${h.field}`
          : `${h.ean_code}:${h.field}`;
        map.set(key, h);
      }
      setHintMap(map);
    });
  }, [items]);

  // Collect all unique field keys across all items (preserve insertion order, skip 'validation')
  const fieldKeys = useMemo(() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      for (const key of Object.keys(item)) {
        if (key !== "validation" && !seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
    return keys;
  }, [items]);

  // chevron + # + fieldKeys + PLU + Match + Status
  const totalCols = fieldKeys.length + 5;

  // Summary stats derived from edits and PLU selections (reactive)
  const stats = useMemo(() => {
    let effectiveValid = 0;
    let effectiveIssues = 0;
    let noMatch = 0;
    let pending = 0;
    let totalAccepted = 0;
    let rowsWithAccepted = 0;

    for (let idx = 0; idx < items.length; idx++) {
      const v = items[idx].validation;
      const pluSel = pluSelections[idx];
      const hasSel = !!pluSel;

      // A no-match item the user hasn't resolved via a suggestion is unmatched;
      // once a candidate is selected it behaves like a resolved match.
      if (v.match_type === "no_match" && !hasSel) {
        noMatch++;
        continue;
      }
      if (v.match_type === "multi_plu" && !hasSel) {
        pending++;
        continue;
      }

      const effectiveDiscrepanciesRaw = hasSel
        ? pluSel.discrepancies
        : v.discrepancies;

      let acceptedInRow = 0;
      let remaining = 0;
      for (const d of effectiveDiscrepanciesRaw) {
        if (isResolved(d, acceptedFields[idx])) {
          totalAccepted++;
          acceptedInRow++;
        } else {
          remaining++;
        }
      }
      if (acceptedInRow > 0) rowsWithAccepted++;

      // A selection replaces the backend's verdict entirely: its discrepancies
      // are the whole story, so `remaining === 0` already covers it.
      const effectivelyValid = (!hasSel && v.is_valid) || remaining === 0;
      if (effectivelyValid) effectiveValid++;
      else effectiveIssues++;
    }

    return {
      effectiveValid,
      effectiveIssues,
      noMatch,
      pending,
      totalAccepted,
      rowsWithAccepted,
    };
  }, [items, pluSelections, acceptedFields]);

  // ---------------------------------------------------------------------------
  // Calculation validation — runs for every item, reactive to edits.
  // ---------------------------------------------------------------------------
  const calcResults = useMemo((): CalcValidationResult | null => {
    const lineResults: LineCalcResult[] = [];
    let lineAmountSum = 0;
    let allLinesHaveAmount = true;
    let linesWithAmount = 0;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx] as Record<string, unknown>;

      // Build effectiveItem — overlay every accepted edit so all calc fields re-run correctly.
      const effectiveItem: Record<string, unknown> = { ...item };
      const itemEdits = edits[idx];
      const itemAccepted = acceptedFields[idx];
      if (itemEdits && itemAccepted) {
        for (const [field, val] of Object.entries(itemEdits)) {
          if (itemAccepted.has(field)) effectiveItem[field] = val;
        }
      }

      // A PLU the user picked re-derives the cost against its own pack size,
      // so it outranks whatever the backend matched. An accepted edit still
      // outranks both — a value the user typed is the last word.
      const pluSel = pluSelections[idx];
      const derivedCost =
        (pluSel
          ? pluSel.derived
          : items[idx].validation?.derived_fields?.cost_price) ?? null;
      const costEdited = itemAccepted?.has("cost_price") ?? false;

      const effectiveCostPrice = parseFloat(
        String(
          costEdited
            ? effectiveItem["cost_price"]
            : (derivedCost?.value ?? effectiveItem["cost_price"] ?? ""),
        ),
      );
      const taxAmountField = findFieldValue(
        effectiveItem,
        TAX_AMOUNT_CANDIDATES,
      );
      const lineAmtField = findFieldValue(
        effectiveItem,
        LINE_AMOUNT_CANDIDATES,
      );
      const quantity = parseFloat(String(effectiveItem["quantity"] ?? ""));

      // A cost price is per individual unit, while an invoice quantity counts
      // packs — 5 Pkts of 10 is 50 units. Without the pack size the line total
      // comes out short by exactly that factor.
      const uomQtyRaw = derivedCost?.uom_qty ?? num(effectiveItem["uom_qty"]);
      const packSize =
        uomQtyRaw !== null && uomQtyRaw !== undefined && uomQtyRaw > 0
          ? uomQtyRaw
          : 1;
      const totalUnits =
        derivedCost?.total_units != null && derivedCost.total_units > 0
          ? derivedCost.total_units
          : quantity * packSize;

      // The cost price on screen is rounded to the paisa. Scaling that rounded
      // figure by 50 units magnifies the error past any sane tolerance, so the
      // check multiplies the exact derivation when one is available.
      const exactCostPrice =
        !costEdited &&
        derivedCost?.base_unit_cost !== undefined &&
        derivedCost?.tax_per_unit !== undefined
          ? derivedCost.base_unit_cost + derivedCost.tax_per_unit
          : effectiveCostPrice;

      const checks: CalcCheck[] = [];

      // —— Resolve each printed figure on a basis we can name ————————
      // GST components and taxable/amount columns are whole-line figures by
      // invoice convention; a unit price is per invoice UOM; a cost price is
      // per catalog unit. Comparing across bases is what made the old checks
      // wrong, so every check below works in one stated basis and skips
      // outright when it cannot establish one. A skipped check is honest; a
      // false "Calc error" is not.
      const unitPriceField = findFieldOrdered(
        effectiveItem,
        UNIT_PRICE_CANDIDATES,
      );
      const gstSplit =
        sumFields(effectiveItem, GST_SPLIT_AMOUNT_CANDIDATES) ??
        sumFields(effectiveItem, GST_SPLIT_BARE_CANDIDATES);

      let taxableField = findFieldOrdered(
        effectiveItem,
        TAXABLE_VALUE_CANDIDATES,
      );
      if (!taxableField) {
        // A bare "total" is the pre-tax base only when a larger tax-inclusive
        // amount sits beside it. Equal values mean a nil-rated line or a
        // tax-inclusive total — neither is safe to treat as taxable.
        const loose = findFieldOrdered(
          effectiveItem,
          AMBIGUOUS_TAXABLE_CANDIDATES,
        );
        if (
          loose &&
          lineAmtField &&
          loose.key !== lineAmtField.key &&
          lineAmtField.value > loose.value
        ) {
          taxableField = loose;
        }
      }

      // Line-level mode: the invoice splits its GST out or names a taxable
      // value, so the whole-line basis is established rather than guessed.
      const lineLevel = !!gstSplit || !!taxableField;
      const lineTax = gstSplit
        ? { value: gstSplit.value, field: null as string | null }
        : taxAmountField
          ? { value: taxAmountField.value, field: taxAmountField.key }
          : null;

      // An invoice names the tax rate all sorts of ways, so this searches the
      // candidate spellings rather than reading one key. `effectiveItem`
      // already carries any accepted edit, so a corrected rate is picked up
      // here too.
      const taxPctField = findFieldOrdered(effectiveItem, TAX_PCT_CANDIDATES);
      const linePct = taxPctField?.value ?? NaN;

      const computedTaxable =
        unitPriceField && !isNaN(quantity)
          ? unitPriceField.value * quantity
          : null;
      const lineTaxable = taxableField?.value ?? computedTaxable;

      if (lineLevel) {
        // Check 1 — Taxable Value = Unit Price x Qty   (line basis)
        // Only worth running against a printed column; against our own
        // computed base it would merely restate itself.
        if (taxableField && computedTaxable !== null) {
          const calculated = parseFloat(computedTaxable.toFixed(2));
          checks.push({
            label: "Taxable Value",
            field: taxableField.key,
            formula: `${trimNum(unitPriceField!.value)} × ${trimNum(quantity)}`,
            calculated,
            actual: taxableField.value,
            ok: Math.abs(calculated - taxableField.value) <= 0.05,
          });
        }

        // Check 2 — Tax Amount = Taxable x Tax% / 100   (line basis)
        if (lineTaxable !== null && !isNaN(linePct) && lineTax) {
          const calculated = parseFloat(
            ((lineTaxable * linePct) / 100).toFixed(2),
          );
          checks.push({
            label: "Tax Amount",
            field: lineTax.field ?? "",
            formula: `${trimNum(lineTaxable)} × ${trimNum(linePct)}% ÷ 100`,
            calculated,
            actual: lineTax.value,
            ok: Math.abs(calculated - lineTax.value) <= 0.05,
            acceptable: lineTax.field !== null,
          });
        }

        // Check 3 — Line Amount = Taxable + Tax   (line basis)
        // Stronger than scaling a cost price back up, and free of the rounding
        // amplification that comes with multiplying a per-unit figure.
        if (lineTaxable !== null && lineTax && lineAmtField) {
          const calculated = parseFloat(
            (lineTaxable + lineTax.value).toFixed(2),
          );
          checks.push({
            label: "Line Amount",
            field: lineAmtField.key,
            formula: `${trimNum(lineTaxable)} + ${trimNum(lineTax.value)}`,
            calculated,
            actual: lineAmtField.value,
            ok: Math.abs(calculated - lineAmtField.value) <= 0.05,
          });
        }

        // Check 4 — Cost Price = Line Amount / total units   (unit basis)
        // Skipped when the cost was derived from these very figures, where it
        // could only ever restate them or report its own rounding.
        if (
          !derivedCost &&
          !isNaN(effectiveCostPrice) &&
          totalUnits > 0 &&
          lineAmtField
        ) {
          const calculated = parseFloat(
            (lineAmtField.value / totalUnits).toFixed(2),
          );
          checks.push({
            label: "Cost Price",
            field: "cost_price",
            formula:
              packSize > 1
                ? `${trimNum(lineAmtField.value)} ÷ (${trimNum(quantity)} × ${trimNum(packSize)})`
                : `${trimNum(lineAmtField.value)} ÷ ${trimNum(quantity)}`,
            calculated,
            actual: effectiveCostPrice,
            ok: Math.abs(calculated - effectiveCostPrice) <= 0.02,
          });
        }
      } else {
        // —— Per-unit mode ————————————————
        // No GST split and no taxable column: the invoice prints rate, tax and
        // cost side by side, all per unit.
        //
        // The tax and cost checks that used to live here compared against a
        // "base rate" column, but the backend normalises every spelling of it
        // (rate / b.rate / basic rate / unit price) onto invoice_price before
        // the item reaches us, so they could never fire.

        // Line Amount = Cost Price x Qty x pack size
        // With packSize 1 this is the plain cost x qty it has always been.
        if (
          !isNaN(effectiveCostPrice) &&
          !isNaN(quantity) &&
          totalUnits > 0 &&
          lineAmtField
        ) {
          const calculated = parseFloat(
            (exactCostPrice * totalUnits).toFixed(2),
          );
          // Every unit carries up to half a paisa of rounding, so a flat 0.02
          // reads a 50-unit line as broken when it is merely rounded.
          const tolerance = Math.max(0.02, 0.005 * totalUnits);
          checks.push({
            label: "Line Amount",
            field: lineAmtField.key,
            formula:
              packSize > 1
                ? `${trimNum(effectiveCostPrice)} × ${trimNum(quantity)} × ${trimNum(packSize)}`
                : `${trimNum(effectiveCostPrice)} × ${trimNum(quantity)}`,
            calculated,
            actual: lineAmtField.value,
            ok: Math.abs(calculated - lineAmtField.value) <= tolerance,
          });
        }
      }

      if (lineAmtField) {
        lineAmountSum += lineAmtField.value;
        linesWithAmount += 1;
      } else {
        allLinesHaveAmount = false;
      }

      lineResults.push({ idx, checks });
    }

    // Grand total check. Lines without a recognisable amount column no longer
    // suppress the whole check — a single scheme/free row used to hide it for
    // the entire invoice. The sum covers whatever lines did carry an amount and
    // is reported as partial so a shortfall isn't read as a real discrepancy.
    let grandTotalCheck: CalcValidationResult["grandTotalCheck"] = null;
    if (documentScalars && linesWithAmount > 0) {
      const gtField = findGrandTotal(documentScalars);
      if (gtField) {
        const sumRounded = parseFloat(lineAmountSum.toFixed(2));
        const partial = !allLinesHaveAmount;
        grandTotalCheck = {
          field: gtField.key,
          documentTotal: gtField.value,
          ok: Math.abs(sumRounded - gtField.value) <= 0.05,
          linesCounted: linesWithAmount,
          linesTotal: lineResults.length,
          partial,
        };
      }
    }

    return {
      lineResults,
      lineAmountSum: parseFloat(lineAmountSum.toFixed(2)),
      grandTotalCheck,
    };
  }, [items, edits, acceptedFields, documentScalars, pluSelections]);

  function toggleExpand(idx: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        // Collapsing — fire skipped_reasoning if the user opened it but never interacted.
        const hadInteraction =
          (acceptedFields[idx]?.size ?? 0) > 0 ||
          (dismissedFields[idx]?.size ?? 0) > 0 ||
          (editingDiscrepancy[idx]?.size ?? 0) > 0 ||
          editingRow.has(idx) ||
          !!pluSelections[idx] ||
          !!itemOutcomes[idx];
        // Only a row that actually raised something counts as reasoning the
        // user skipped — clean rows open onto their editor, and reading one
        // is not a signal that explanations are too long.
        const v = items[idx]?.validation;
        const hadReasoning =
          (v?.discrepancies?.length ?? 0) > 0 ||
          v?.match_type !== undefined ||
          (calcResults?.lineResults
            .find((r) => r.idx === idx)
            ?.checks.some((c) => !c.ok) ??
            false);
        if (!hadInteraction && hadReasoning) {
          track("skipped_reasoning", {
            item_index: idx,
            match_type: items[idx]?.validation?.match_type,
          });
        }
        next.delete(idx);
      } else {
        // Expanding — fire expanded_breakdown.
        track("expanded_breakdown", {
          item_index: idx,
          match_type: items[idx]?.validation?.match_type,
        });
        next.add(idx);
      }
      return next;
    });
  }

  function setFieldEdit(itemIdx: number, field: string, value: string) {
    setEdits((prev) => ({
      ...prev,
      [itemIdx]: { ...(prev[itemIdx] ?? {}), [field]: value },
    }));
  }

  function applyAllSuggestions(
    itemIdx: number,
    corrections: ValidationResult["suggested_corrections"],
  ) {
    const updates: Record<string, string> = {};
    const fields = new Set<string>();
    for (const [field, val] of Object.entries(corrections)) {
      updates[field] = String(val);
      fields.add(field);
    }
    setEdits((prev) => ({
      ...prev,
      [itemIdx]: { ...(prev[itemIdx] ?? {}), ...updates },
    }));
    setAcceptedFields((prev) => ({
      ...prev,
      [itemIdx]: new Set([...(prev[itemIdx] ?? []), ...fields]),
    }));

    track("suggestion_accepted", {
      fields: [...fields],
      item_index: itemIdx,
      match_type: items[itemIdx]?.validation?.match_type ?? "exact",
      bulk: true,
    });

    for (const [field, val] of Object.entries(corrections)) {
      recordFieldCorrection(
        items[itemIdx]?.validation?.matched_plu ?? null,
        items[itemIdx]?.ean_code ?? null,
        field,
        String(val),
        sourceFilename,
      );
    }
  }

  function acceptField(itemIdx: number, field: string, value: string) {
    setEdits((prev) => ({
      ...prev,
      [itemIdx]: { ...(prev[itemIdx] ?? {}), [field]: value },
    }));
    setAcceptedFields((prev) => ({
      ...prev,
      [itemIdx]: new Set([...(prev[itemIdx] ?? []), field]),
    }));
    setEditingDiscrepancy((prev) => {
      const set = new Set(prev[itemIdx] ?? []);
      set.delete(field);
      return { ...prev, [itemIdx]: set };
    });

    // Determine if user accepted the master suggestion unchanged, or typed their own value.
    const suggestedValue = String(
      items[itemIdx]?.validation?.suggested_corrections?.[field] ?? "",
    );
    const isSuggestion = value === suggestedValue && suggestedValue !== "";
    const existingHint = getHint(items[itemIdx], field);
    const isOverride = Boolean(existingHint) && existingHint!.corrected_value !== value;
    const trackEvent = isOverride
      ? "field_correction_overridden"
      : isSuggestion
        ? "suggestion_accepted"
        : "field_edit";
    track(trackEvent, {
      field_id: field,
      item_index: itemIdx,
      match_type: items[itemIdx]?.validation?.match_type ?? "exact",
      had_hint: Boolean(existingHint),
    });

    recordFieldCorrection(
      items[itemIdx]?.validation?.matched_plu ?? null,
      items[itemIdx]?.ean_code ?? null,
      field,
      value,
      sourceFilename,
    );
  }

  function openFieldEdit(itemIdx: number, field: string) {
    setEditingDiscrepancy((prev) => ({
      ...prev,
      [itemIdx]: new Set([...(prev[itemIdx] ?? []), field]),
    }));

    track("flag_acknowledged", {
      field_id: field,
      item_index: itemIdx,
      match_type: items[itemIdx]?.validation?.match_type ?? "exact",
    });
  }

  function cancelFieldEdit(itemIdx: number, field: string) {
    setEditingDiscrepancy((prev) => {
      const set = new Set(prev[itemIdx] ?? []);
      set.delete(field);
      return { ...prev, [itemIdx]: set };
    });
  }

  function getEditValue(
    itemIdx: number,
    field: string,
    actual: unknown,
  ): string {
    return edits[itemIdx]?.[field] ?? String(actual ?? "");
  }

  function cancelRowEdit(itemIdx: number) {
    setEditingRow((prev) => {
      const next = new Set(prev);
      next.delete(itemIdx);
      return next;
    });
  }

  // Commits the row editor. `markAll` preserves the unmatched-row behaviour of
  // stamping every field as accepted; a matched row only marks what the user
  // actually changed, so a clean match is not repainted green throughout.
  function saveRowEdits(itemIdx: number, markAll: boolean) {
    const item = items[itemIdx];
    const itemEdits = edits[itemIdx] ?? {};
    const changed = new Set<string>();
    const accepted = new Set<string>();

    for (const key of fieldKeys) {
      if (markAll) accepted.add(key);
      const edited = itemEdits[key];
      if (edited !== undefined && edited !== String(item[key] ?? "")) {
        changed.add(key);
        accepted.add(key);
      }
    }

    setAcceptedFields((prev) => ({
      ...prev,
      [itemIdx]: new Set([...(prev[itemIdx] ?? []), ...accepted]),
    }));
    cancelRowEdit(itemIdx);

    if (changed.size === 0) return;
    track("field_edit", {
      fields: [...changed],
      item_index: itemIdx,
      match_type: item.validation?.match_type ?? "exact",
      bulk: true,
    });
    for (const field of changed) {
      recordFieldCorrection(
        item.validation?.matched_plu ?? null,
        item.ean_code ?? null,
        field,
        itemEdits[field],
        sourceFilename,
      );
    }
  }

  function selectPlu(itemIdx: number, opt: PluOption) {
    const { discrepancies, corrections, derived } = computeLocalValidation(
      items[itemIdx],
      opt,
    );
    setPluSelections((prev) => ({
      ...prev,
      [itemIdx]: { plu_code: opt.plu_code, discrepancies, corrections, derived },
    }));

    track("plu_selected", {
      plu_code: opt.plu_code,
      item_index: itemIdx,
      options_count: items[itemIdx]?.validation?.plu_options?.length ?? 0,
    });
    setEdits((prev) => {
      const next = { ...prev };
      delete next[itemIdx];
      return next;
    });
    setAcceptedFields((prev) => {
      const next = { ...prev };
      delete next[itemIdx];
      return next;
    });
    setEditingDiscrepancy((prev) => {
      const next = { ...prev };
      delete next[itemIdx];
      return next;
    });
  }

  function clearPluSelection(itemIdx: number) {
    setPluSelections((prev) => {
      const next = { ...prev };
      delete next[itemIdx];
      return next;
    });
    setEdits((prev) => {
      const next = { ...prev };
      delete next[itemIdx];
      return next;
    });
    setAcceptedFields((prev) => {
      const next = { ...prev };
      delete next[itemIdx];
      return next;
    });
    setEditingDiscrepancy((prev) => {
      const next = { ...prev };
      delete next[itemIdx];
      return next;
    });
  }

  function fireFeedback(idx: number, eventType: string) {
    track(eventType);
    setFeedbackFlash((prev) => ({ ...prev, [idx]: eventType }));
    setTimeout(() => {
      setFeedbackFlash((prev) => {
        const next = { ...prev };
        delete next[idx];
        return next;
      });
    }, 1500);
  }

  function getHint(item: ValidatedItem, field: string): FieldHint | undefined {
    const plu = item.validation?.matched_plu;
    if (plu) return hintMap.get(`${plu}:${field}`);
    const ean = item.ean_code;
    if (ean) return hintMap.get(`${ean}:${field}`);
    return undefined;
  }

  function applyHint(itemIdx: number, field: string, hintValue: string) {
    setEdits((prev) => ({
      ...prev,
      [itemIdx]: { ...(prev[itemIdx] ?? {}), [field]: hintValue },
    }));
    setAcceptedFields((prev) => ({
      ...prev,
      [itemIdx]: new Set([...(prev[itemIdx] ?? []), field]),
    }));
    setEditingDiscrepancy((prev) => {
      const set = new Set(prev[itemIdx] ?? []);
      set.delete(field);
      return { ...prev, [itemIdx]: set };
    });
    track("field_correction_accepted", {
      field,
      plu_code: items[itemIdx]?.validation?.matched_plu,
      hint_count: getHint(items[itemIdx], field)?.count,
    });
    recordFieldCorrection(
      items[itemIdx]?.validation?.matched_plu ?? null,
      items[itemIdx]?.ean_code ?? null,
      field,
      hintValue,
      sourceFilename,
    );
  }

  function toggleAutoSelectPlu() {
    const next = !autoSelectPlu;
    setAutoSelectPlu(next);
    updateUserPreferences({ auto_select_plu: next });
    track("plu_auto_select_toggled", { enabled: next });

    if (next) {
      // Immediately auto-select best available PLU for every pending multi_plu item.
      // "Best" = fewest discrepancies; ties broken by array order (backend priority).
      items.forEach((item, idx) => {
        if (item.validation.match_type !== "multi_plu") return;
        if (pluSelections[idx]) return; // already resolved
        const opts = item.validation.plu_options;
        if (!opts?.length) return;
        const best = opts.reduce((a, b) => {
          const da = computeLocalValidation(item, a).discrepancies.length;
          const db = computeLocalValidation(item, b).discrepancies.length;
          return db < da ? b : a;
        });
        selectPlu(idx, best);
      });
    }
  }

  function dismissField(itemIdx: number, field: string) {
    setDismissedFields((prev) => ({
      ...prev,
      [itemIdx]: new Set([...(prev[itemIdx] ?? []), field]),
    }));
    recordDismissal(getDiscrepancyFlagType(field));
  }

  function recordItemOutcome(itemIdx: number, outcome: string) {
    setItemOutcomes((prev) => ({ ...prev, [itemIdx]: outcome }));
    const flagType = getItemFlagType(items[itemIdx]?.validation?.match_type);
    recordInvestigation(flagType, outcome, sourceFilename);
  }

  function downloadValidationCsv() {
    const headers = [
      ...fieldKeys.map(fieldLabel),
      "Matched PLU",
      "Match Type",
      "Status",
      "Remaining Issues",
    ];

    const rows = items.map((item, idx) => {
      const v = item.validation;
      const pluSel = pluSelections[idx];
      const itemEdits = edits[idx];

      // Field values — use accepted edit when available
      const fieldVals = fieldKeys.map((key) => {
        const accepted = itemEdits?.[key];
        return accepted !== undefined ? accepted : String(item[key] ?? "");
      });

      // Matched PLU
      const matchedPlu =
        v.match_type === "multi_plu"
          ? (pluSel?.plu_code ?? "")
          : (v.matched_plu ?? "");

      // Match type label
      const matchTypeLabel =
        v.match_type === "multi_plu"
          ? pluSel
            ? "Multi PLU"
            : "Multi PLU (pending)"
          : v.match_type === "fuzzy_name"
            ? "Fuzzy"
            : v.match_type === "no_match"
              ? "No Match"
              : "Exact";

      // Remaining unresolved discrepancies
      const effectiveDiscrepanciesRaw =
        v.match_type === "multi_plu" && pluSel
          ? pluSel.discrepancies
          : v.discrepancies;
      const remaining = effectiveDiscrepanciesRaw.filter(
        (d) => !isResolved(d, acceptedFields[idx]),
      );

      // Status label
      let status: string;
      if (v.match_type === "no_match") status = "Unmatched";
      else if (v.match_type === "multi_plu" && !pluSel)
        status = "Pending Selection";
      else if (remaining.length === 0) status = "Valid";
      else
        status = `${remaining.length} issue${remaining.length !== 1 ? "s" : ""}`;

      const remainingIssues = remaining
        .map((d) => fieldLabel(d.field))
        .join("; ");

      return [
        ...fieldVals,
        matchedPlu,
        matchTypeLabel,
        status,
        remainingIssues,
      ];
    });

    const escape = (s: string) =>
      s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => escape(String(cell ?? ""))).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "validation_results.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <p className="font-medium">No line items to validate</p>
        <p className="text-sm mt-1">
          The document has no item arrays to validate against master data.
        </p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div ref={containerRef} className="space-y-3">
        {/* Summary bar */}
        <div className="p-3 bg-muted/40 rounded-lg space-y-1.5">
          <div className="flex items-center gap-3 text-sm flex-wrap">
            <span className="font-medium text-foreground">
              {items.length} item{items.length !== 1 ? "s" : ""}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={autoSelectPlu ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs gap-1.5 shrink-0"
                  onClick={toggleAutoSelectPlu}
                >
                  Auto-select PLU: {autoSelectPlu ? "ON" : "OFF"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {autoSelectPlu
                  ? "Gemini picks the best PLU automatically (1 credit per ambiguous item). Toggle off to select manually."
                  : "Toggle on to let Gemini auto-select the best PLU when multiple matches exist (1 credit per item)."}
              </TooltipContent>
            </Tooltip>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 text-xs gap-1.5 shrink-0"
              onClick={downloadValidationCsv}
            >
              <Download className="w-3.5 h-3.5" />
              Download CSV
            </Button>
            <span className="text-muted-foreground">·</span>
            <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {stats.effectiveValid} valid
            </span>
            {stats.effectiveIssues > 0 && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="flex items-center gap-1 text-destructive">
                  <XCircle className="w-3.5 h-3.5" />
                  {stats.effectiveIssues} with issues
                </span>
              </>
            )}
            {stats.pending > 0 && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="flex items-center gap-1 text-violet-600 dark:text-violet-400">
                  <Layers className="w-3.5 h-3.5" />
                  {stats.pending} pending selection
                </span>
              </>
            )}
            {stats.noMatch > 0 && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <HelpCircle className="w-3.5 h-3.5" />
                  {stats.noMatch} unmatched
                </span>
              </>
            )}
          </div>

          {/* Accepted suggestions metadata — only shown once at least one is accepted */}
          {stats.totalAccepted > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
              <Wand2 className="w-3 h-3" />
              <span>
                <span className="font-semibold">{stats.totalAccepted}</span>{" "}
                suggestion{stats.totalAccepted !== 1 ? "s" : ""} accepted across{" "}
                <span className="font-semibold">{stats.rowsWithAccepted}</span>{" "}
                row
                {stats.rowsWithAccepted !== 1 ? "s" : ""}
              </span>
            </div>
          )}
        </div>

        {/* Main table */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <UITableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-8 px-2" />
                  <TableHead className="w-8 text-xs font-semibold text-foreground">
                    #
                  </TableHead>
                  {fieldKeys.map((key) => (
                    <TableHead
                      key={key}
                      className="text-xs font-semibold text-foreground whitespace-nowrap"
                    >
                      {fieldLabel(key)}
                    </TableHead>
                  ))}
                  <TableHead className="text-xs font-semibold text-foreground whitespace-nowrap">
                    Matched PLU
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-foreground whitespace-nowrap">
                    Match
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-foreground whitespace-nowrap">
                    Status
                  </TableHead>
                </UITableRow>
              </TableHeader>

              <TableBody>
                {items.map((item, idx) => {
                  const v = item.validation;
                  const isExpanded = expanded.has(idx);
                  const isFuzzy = v.match_type === "fuzzy_name";
                  const isNoMatch = v.match_type === "no_match";
                  const isMultiPlu = v.match_type === "multi_plu";
                  const isAutoSelected = v.match_type === "auto_selected";
                  const pluSel = pluSelections[idx];
                  const hasSelection = !!pluSel;
                  // no_match items may carry "considered" candidates to pick from
                  const noMatchOptions = isNoMatch ? (v.plu_options ?? []) : [];
                  const hasSuggestions = noMatchOptions.length > 0;
                  // A no_match item stays unmatched until the user picks a suggestion.
                  const stillUnmatched = isNoMatch && !hasSelection;
                  // Gemini matched one record but others were plausible — offer the
                  // runners-up with its pick highlighted rather than a silent guess.
                  const altOptions =
                    isFuzzy || isAutoSelected ? (v.plu_options ?? []) : [];
                  const hasAlternatives = altOptions.length > 1;
                  // Rows that support candidate selection (multi-PLU, no_match with
                  // suggestions, or an overridable match) share the picker +
                  // comparison UI.
                  const canSelect =
                    isMultiPlu || hasSuggestions || hasAlternatives;

                  // Build effective validation values (override after a selection)
                  const effectiveMatchedPlu = hasSelection
                    ? pluSel.plu_code
                    : isMultiPlu
                      ? null
                      : v.matched_plu;
                  const effectiveDiscrepanciesRaw = hasSelection
                    ? pluSel.discrepancies
                    : v.discrepancies;
                  const effectiveCorrections = hasSelection
                    ? pluSel.corrections
                    : v.suggested_corrections;
                  // Values worked out rather than read off the invoice. A
                  // selection re-derives locally, since the pack size that
                  // produces the cost belongs to the chosen PLU.
                  const derivedFields: Record<string, DerivedField> =
                    hasSelection
                      ? pluSel.derived
                        ? { cost_price: pluSel.derived }
                        : {}
                      : (v.derived_fields ?? {});

                  // Remaining unresolved discrepancies
                  const effectiveDiscrepancies =
                    effectiveDiscrepanciesRaw.filter(
                      (d) => !isResolved(d, acceptedFields[idx]),
                    );

                  const isPending = isMultiPlu && !pluSel;

                  const isEffectivelyValid =
                    !isPending &&
                    !stillUnmatched &&
                    ((!hasSelection && v.is_valid) ||
                      effectiveDiscrepancies.length === 0);

                  // Cells that still have active discrepancies. Discrepancy
                  // fields and item keys share one spelling, so this is a
                  // straight lookup.
                  const discrepantFields = new Set(
                    effectiveDiscrepancies.map((d) => d.field),
                  );

                  const itemCalcResult = calcResults?.lineResults.find(
                    (r) => r.idx === idx,
                  );
                  const hasCalcErrors =
                    itemCalcResult?.checks.some((c) => !c.ok) ?? false;

                  // Something the validator wants reviewed. Every row expands
                  // regardless — a clean match still opens onto its editor —
                  // but only these carry a finding worth an outcome.
                  const hasFindings =
                    v.discrepancies.length > 0 ||
                    isFuzzy ||
                    isNoMatch ||
                    isMultiPlu ||
                    hasAlternatives ||
                    hasCalcErrors;

                  return (
                    <Fragment key={idx}>
                      {/* Data row */}
                      <UITableRow
                        className={`cursor-pointer hover:bg-muted/30 ${
                          isExpanded ? "bg-muted/20" : ""
                        }`}
                        onClick={() => toggleExpand(idx)}
                      >
                        {/* Expand chevron */}
                        <TableCell className="px-2 py-2 w-8">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          )}
                        </TableCell>

                        {/* Row number */}
                        <TableCell className="text-xs text-muted-foreground font-mono py-2">
                          {idx + 1}
                        </TableCell>

                        {/* Dynamic OCR field cells */}
                        {fieldKeys.map((key) => {
                          const editedVal = edits[idx]?.[key];
                          const displayVal =
                            editedVal !== undefined ? editedVal : item[key];
                          const isAccepted =
                            acceptedFields[idx]?.has(key) ?? false;
                          // A value we worked out from the invoice's other
                          // columns is labelled here too, not only inside the
                          // expanded comparison — this row is what most users
                          // read.
                          const cellDerived =
                            editedVal === undefined && !isAccepted
                              ? (derivedFields[key] ?? null)
                              : null;
                          return (
                            <TableCell
                              key={key}
                              className={`text-sm py-2 whitespace-nowrap ${
                                discrepantFields.has(key)
                                  ? "text-destructive font-semibold"
                                  : isAccepted
                                    ? "text-green-700 dark:text-green-400 font-medium"
                                    : "text-foreground"
                              }`}
                            >
                              <span className="inline-flex items-center gap-1.5">
                                {formatCellValue(
                                  cellDerived ? cellDerived.value : displayVal,
                                )}
                                {cellDerived && (
                                  <DerivedBadge derived={cellDerived} />
                                )}
                              </span>
                            </TableCell>
                          );
                        })}

                        {/* Matched PLU */}
                        <TableCell className="text-sm py-2 font-mono text-foreground whitespace-nowrap">
                          {effectiveMatchedPlu ?? "—"}
                        </TableCell>

                        {/* Match type badge */}
                        <TableCell className="py-2">
                          {isMultiPlu ? (
                            <Badge
                              variant="outline"
                              className="text-violet-600 border-violet-300 bg-violet-50 dark:bg-violet-950/20 text-xs whitespace-nowrap gap-1"
                            >
                              <Layers className="w-3 h-3" />
                              Multi PLU
                            </Badge>
                          ) : isFuzzy ? (
                            <Badge
                              variant="outline"
                              className="text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-xs whitespace-nowrap"
                            >
                              Fuzzy
                              {v.confidence && (
                                <span className="ml-1 opacity-70">
                                  · {v.confidence}
                                </span>
                              )}
                            </Badge>
                          ) : isNoMatch ? (
                            <Badge
                              variant="outline"
                              className="text-muted-foreground text-xs whitespace-nowrap"
                            >
                              No Match
                            </Badge>
                          ) : isAutoSelected ? (
                            <Badge
                              variant="outline"
                              className="text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-xs whitespace-nowrap gap-1"
                            >
                              <Sparkles className="w-3 h-3" />
                              Auto
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-950/20 text-xs"
                            >
                              Exact
                            </Badge>
                          )}
                        </TableCell>

                        {/* Status badge — reflects accepted edits and PLU selection */}
                        <TableCell className="py-2">
                          <div className="flex flex-col gap-1">
                            {isPending ? (
                              <Badge
                                variant="outline"
                                className="text-violet-600 border-violet-300 bg-violet-50 dark:bg-violet-950/20 text-xs gap-1 whitespace-nowrap"
                              >
                                <Layers className="w-3 h-3" />
                                Select PLU
                              </Badge>
                            ) : isEffectivelyValid ? (
                              <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 gap-1 text-xs whitespace-nowrap">
                                <CheckCircle2 className="w-3 h-3" />
                                Valid
                              </Badge>
                            ) : stillUnmatched ? (
                              (acceptedFields[idx]?.size ?? 0) > 0 ? (
                                <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 gap-1 text-xs whitespace-nowrap">
                                  <CheckCircle2 className="w-3 h-3" />
                                  Accepted
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="text-muted-foreground text-xs gap-1 whitespace-nowrap"
                                >
                                  <HelpCircle className="w-3 h-3" />
                                  Unmatched
                                </Badge>
                              )
                            ) : (
                              <Badge className="bg-destructive/10 text-destructive border-destructive/20 gap-1 text-xs whitespace-nowrap">
                                <XCircle className="w-3 h-3" />
                                {effectiveDiscrepancies.length} issue
                                {effectiveDiscrepancies.length !== 1 ? "s" : ""}
                              </Badge>
                            )}
                            {hasCalcErrors && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge
                                    variant="outline"
                                    className="text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-xs gap-1 whitespace-nowrap cursor-default"
                                  >
                                    <Calculator className="w-3 h-3" />
                                    Calc error
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Calculation mismatch — expand row to review
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </TableCell>
                      </UITableRow>

                      {/* Inline expanded detail row */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={totalCols} className="p-0">
                            <div className="bg-muted/10 border-t border-border px-4 py-3 space-y-3">
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                Item {idx + 1} —{" "}
                                {String(
                                  item["sku_description"] ??
                                    item.product_name ??
                                    item.sku_desc ??
                                    "details",
                                )}
                              </p>

                              {/* Multi-PLU: PLU selection table */}
                              {isMultiPlu && !pluSel && v.plu_options && (
                                <div className="border border-violet-200 dark:border-violet-800 rounded-lg overflow-hidden">
                                  <div className="px-3 py-2 bg-violet-50 dark:bg-violet-950/20 border-b border-violet-200 dark:border-violet-800 flex items-center gap-2">
                                    <Layers className="w-3.5 h-3.5 text-violet-600 shrink-0" />
                                    <p className="text-xs font-semibold text-violet-700 dark:text-violet-400">
                                      Multiple PLUs found for this EAN — select
                                      the correct one
                                    </p>
                                  </div>
                                  <MatchOptionsTable
                                    item={item}
                                    options={v.plu_options}
                                    columns={[
                                      "cost_price",
                                      "mrp",
                                      "tax_pct",
                                      "priority",
                                    ]}
                                    onSelect={(opt) => selectPlu(idx, opt)}
                                  />
                                </div>
                              )}

                              {/* Selected PLU indicator with Change + Accept All options */}
                              {canSelect && pluSel && (
                                <div className="flex items-center gap-2 text-sm text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 rounded-md px-3 py-2">
                                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                                  <span>
                                    Selected PLU:{" "}
                                    <strong className="font-mono">
                                      {pluSel.plu_code}
                                    </strong>
                                  </span>
                                  {/* "Accept all" lives under the discrepancy
                                      table below, which now covers a selection
                                      too — a second copy here acted on the same
                                      corrections. */}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto h-6 text-xs text-violet-600 hover:text-violet-700"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearPluSelection(idx);
                                    }}
                                  >
                                    Change
                                  </Button>
                                </div>
                              )}

                              {/* Fuzzy match note */}
                              {isFuzzy && v.match_note && (
                                <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded-md px-3 py-2">
                                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                                  <span>{v.match_note}</span>
                                </div>
                              )}

                              {/* Matched, but other records were plausible —
                                  show them with the recommendation highlighted */}
                              {hasAlternatives && (
                                <div
                                  className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800 flex items-center gap-2">
                                    <Layers className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                                      {altOptions.length} similar products found —
                                      the recommended match is highlighted; select
                                      another if it fits better
                                    </p>
                                  </div>
                                  <MatchOptionsTable
                                    item={item}
                                    options={altOptions}
                                    recommendedPlu={
                                      v.recommended_plu ?? v.matched_plu
                                    }
                                    activePlu={
                                      pluSel?.plu_code ?? v.matched_plu
                                    }
                                    onSelect={(opt) => selectPlu(idx, opt)}
                                  />
                                </div>
                              )}

                              {/* No-match message + edit row */}
                              {isNoMatch && (
                                <>
                                  {(v.discrepancies[0]?.message ??
                                    v.match_note) && (
                                    <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
                                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                      <span>
                                        {v.discrepancies[0]?.message ??
                                          v.match_note}
                                      </span>
                                    </div>
                                  )}

                                  {/* Considered similar products — pickable when the
                                      EAN was not found but name-similar records exist */}
                                  {hasSuggestions && !pluSel && (
                                    <div
                                      className="border border-border rounded-lg overflow-hidden"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-2">
                                        <Layers className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                        <p className="text-xs font-semibold text-foreground">
                                          Considered {noMatchOptions.length} similar
                                          product
                                          {noMatchOptions.length !== 1 ? "s" : ""} —
                                          select the correct match, or leave unmatched
                                        </p>
                                      </div>
                                      <MatchOptionsTable
                                        item={item}
                                        options={noMatchOptions}
                                        columns={["ean", "mrp", "tax_pct"]}
                                        showInvoiceRow={false}
                                        onSelect={(opt) => selectPlu(idx, opt)}
                                      />
                                    </div>
                                  )}
                                </>
                              )}

                              {/* A value worked out from the invoice's other
                                  columns that has nowhere else to appear: the
                                  invoice printed no such column, so the main
                                  table has no cell for it, and it agrees with
                                  the catalog, so no discrepancy row carries it
                                  either. Deriving a cost price and then not
                                  showing it is the one thing worse than not
                                  deriving it. */}
                              {(() => {
                                const unshown = Object.entries(
                                  derivedFields,
                                ).filter(
                                  ([field]) =>
                                    !fieldKeys.includes(field) &&
                                    !effectiveDiscrepanciesRaw.some(
                                      (d) => d.field === field,
                                    ),
                                );
                                if (!unshown.length) return null;
                                return (
                                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
                                    {unshown.map(([field, derived]) => (
                                      <span
                                        key={field}
                                        className="inline-flex items-center gap-1.5"
                                      >
                                        <span className="text-xs text-muted-foreground">
                                          {fieldLabel(field)}
                                        </span>
                                        <span className="text-sm font-mono font-medium text-foreground">
                                          {derived.value}
                                        </span>
                                        <DerivedBadge derived={derived} />
                                      </span>
                                    ))}
                                  </div>
                                );
                              })()}

                              {/* The one discrepancy table, whatever raised the
                                  finding: the backend's own comparison, or the
                                  local re-comparison against a PLU the user
                                  picked. Resolved rows are dimmed rather than
                                  removed.

                                  A multi-PLU row waiting on a choice has
                                  nothing to compare against yet, and an
                                  unmatched row states its case in the no-match
                                  notice above instead. */}
                              {!isPending &&
                                (!isNoMatch || hasSelection) &&
                                effectiveDiscrepanciesRaw.length > 0 && (
                                  <>
                                    <div className="border border-border rounded-lg overflow-hidden">
                                      <Table>
                                        <TableHeader>
                                          <UITableRow className="bg-muted/50 hover:bg-muted/50">
                                            <TableHead className="text-xs font-semibold text-foreground">
                                              Field
                                            </TableHead>
                                            <TableHead className="text-xs font-semibold text-foreground">
                                              Master (Expected)
                                            </TableHead>
                                            <TableHead className="text-xs font-semibold text-foreground">
                                              Invoice Value
                                            </TableHead>
                                            <TableHead className="text-xs font-semibold text-foreground hidden md:table-cell">
                                              Note
                                            </TableHead>
                                            <TableHead className="w-32" />
                                          </UITableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {effectiveDiscrepanciesRaw.map(
                                            (d: Discrepancy, di: number) => {
                                              const resolved = isResolved(
                                                d,
                                                acceptedFields[idx],
                                              );
                                              const isDismissed =
                                                dismissedFields[idx]?.has(
                                                  d.field,
                                                ) ?? false;
                                              const isSuppressed =
                                                suppressedFlags.has(
                                                  getDiscrepancyFlagType(
                                                    d.field,
                                                  ),
                                                );
                                              const isFieldEditing =
                                                editingDiscrepancy[idx]?.has(
                                                  d.field,
                                                ) ?? false;
                                              // Gemini returns actual: null for
                                              // a field it could not read, and
                                              // a derived cost never reaches
                                              // the discrepancy at all — fall
                                              // back to the item so the column
                                              // always shows Master vs Invoice.
                                              const invoiceFallback =
                                                derivedFields[d.field]?.value ??
                                                d.actual ??
                                                invoiceValueFor(item, d.field);
                                              const currentVal = getEditValue(
                                                idx,
                                                d.field,
                                                invoiceFallback,
                                              );
                                              const derivedHere =
                                                derivedFields[d.field] ?? null;
                                              const masterStr =
                                                effectiveCorrections[
                                                  d.field
                                                ] !== undefined
                                                  ? String(
                                                      effectiveCorrections[
                                                        d.field
                                                      ],
                                                    )
                                                  : null;
                                              return (
                                                <Fragment key={di}>
                                                <UITableRow
                                                  className={`hover:bg-muted/30 transition-opacity ${
                                                    resolved ||
                                                    isDismissed ||
                                                    isSuppressed
                                                      ? "opacity-50"
                                                      : ""
                                                  }`}
                                                >
                                                  <TableCell className="text-sm font-medium py-2">
                                                    <span className="flex items-center gap-1.5">
                                                      {resolved && (
                                                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                                                      )}
                                                      {isDismissed &&
                                                        !resolved && (
                                                          <XCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                                        )}
                                                      {fieldLabel(d.field)}
                                                    </span>
                                                  </TableCell>
                                                  <TableCell className="text-sm text-muted-foreground py-2 font-mono">
                                                    {d.expected !== null
                                                      ? String(d.expected)
                                                      : "—"}
                                                  </TableCell>
                                                  <TableCell
                                                    className="py-2"
                                                    onClick={(e) =>
                                                      e.stopPropagation()
                                                    }
                                                  >
                                                    {isFieldEditing ? (
                                                      <Input
                                                        className="h-7 text-sm font-mono w-28"
                                                        value={currentVal}
                                                        autoFocus
                                                        onChange={(e) =>
                                                          setFieldEdit(
                                                            idx,
                                                            d.field,
                                                            e.target.value,
                                                          )
                                                        }
                                                      />
                                                    ) : (
                                                      <span className="inline-flex items-center gap-1.5">
                                                        <span
                                                          className={`text-sm font-mono ${resolved ? "text-green-700 dark:text-green-400 font-medium" : ""}`}
                                                        >
                                                          {currentVal || "—"}
                                                        </span>
                                                        {derivedHere &&
                                                          !resolved && (
                                                            <DerivedBadge
                                                              derived={
                                                                derivedHere
                                                              }
                                                            />
                                                          )}
                                                      </span>
                                                    )}
                                                  </TableCell>
                                                  <TableCell className="text-xs text-muted-foreground py-2 max-w-xs hidden md:table-cell">
                                                    {d.message}
                                                  </TableCell>
                                                  <TableCell
                                                    className="py-2"
                                                    onClick={(e) =>
                                                      e.stopPropagation()
                                                    }
                                                  >
                                                    {isSuppressed &&
                                                    !resolved ? (
                                                      <Badge
                                                        variant="outline"
                                                        className="text-xs text-muted-foreground"
                                                      >
                                                        Auto-suppressed
                                                      </Badge>
                                                    ) : (
                                                      !resolved &&
                                                      (isFieldEditing ? (
                                                        <div className="flex gap-1">
                                                          <Button
                                                            variant="default"
                                                            size="sm"
                                                            className="h-7 text-xs gap-1"
                                                            onClick={() =>
                                                              acceptField(
                                                                idx,
                                                                d.field,
                                                                currentVal,
                                                              )
                                                            }
                                                          >
                                                            <CheckCircle2 className="w-3 h-3" />
                                                            Accept
                                                          </Button>
                                                          <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-7 text-xs"
                                                            onClick={() =>
                                                              cancelFieldEdit(
                                                                idx,
                                                                d.field,
                                                              )
                                                            }
                                                          >
                                                            Cancel
                                                          </Button>
                                                        </div>
                                                      ) : isDismissed ? (
                                                        <span className="text-xs text-muted-foreground italic">
                                                          Dismissed
                                                        </span>
                                                      ) : (
                                                        <div className="flex gap-1">
                                                          {masterStr !==
                                                            null && (
                                                            <Tooltip>
                                                              <TooltipTrigger
                                                                asChild
                                                              >
                                                                <Button
                                                                  variant="outline"
                                                                  size="sm"
                                                                  className="h-7 text-xs gap-1"
                                                                  onClick={() =>
                                                                    acceptField(
                                                                      idx,
                                                                      d.field,
                                                                      masterStr,
                                                                    )
                                                                  }
                                                                >
                                                                  <Wand2 className="w-3 h-3" />
                                                                  Accept
                                                                </Button>
                                                              </TooltipTrigger>
                                                              <TooltipContent>
                                                                Accept master
                                                                value:{" "}
                                                                {masterStr}
                                                              </TooltipContent>
                                                            </Tooltip>
                                                          )}
                                                          <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-7 text-xs gap-1"
                                                            onClick={() =>
                                                              openFieldEdit(
                                                                idx,
                                                                d.field,
                                                              )
                                                            }
                                                          >
                                                            <Pencil className="w-3 h-3" />
                                                            Edit
                                                          </Button>
                                                          <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-7 text-xs gap-1 text-muted-foreground"
                                                            onClick={() =>
                                                              dismissField(
                                                                idx,
                                                                d.field,
                                                              )
                                                            }
                                                          >
                                                            Dismiss
                                                          </Button>
                                                        </div>
                                                      ))
                                                    )}
                                                  </TableCell>
                                                </UITableRow>
                                                {!resolved && !isDismissed && !isSuppressed && (() => {
                                                  const hint = getHint(item, d.field);
                                                  if (!hint) return null;
                                                  const displayValue = isNaN(Number(hint.corrected_value))
                                                    ? hint.corrected_value
                                                    : Number(hint.corrected_value);
                                                  return (
                                                    <tr>
                                                      <td colSpan={5} className="px-0 pb-2 pt-0 border-0">
                                                        <div className="mx-4 flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-1.5 text-sm dark:bg-amber-950/20 dark:border-amber-800">
                                                          <span className="text-amber-700 dark:text-amber-400">
                                                            You've corrected this {hint.count} time{hint.count > 1 ? "s" : ""} before
                                                            {" → "}<strong>{String(displayValue)}</strong>
                                                          </span>
                                                          <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="ml-auto h-6 border-amber-400 text-amber-800 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-900/30"
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              applyHint(idx, d.field, hint.corrected_value);
                                                            }}
                                                          >
                                                            Apply
                                                          </Button>
                                                        </div>
                                                      </td>
                                                    </tr>
                                                  );
                                                })()}
                                                </Fragment>
                                              );
                                            },
                                          )}
                                        </TableBody>
                                      </Table>
                                    </div>

                                    {/* Apply all — only shown while unresolved corrections remain */}
                                    {effectiveDiscrepancies.length > 0 &&
                                      Object.keys(effectiveCorrections).length >
                                        0 && (
                                        <div className="flex justify-end">
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="text-xs gap-1"
                                            onClick={() =>
                                              applyAllSuggestions(
                                                idx,
                                                effectiveCorrections,
                                              )
                                            }
                                          >
                                            <Wand2 className="w-3 h-3" />
                                            Accept all
                                          </Button>
                                        </div>
                                      )}
                                  </>
                                )}

                              {/* Inline calculation checks */}
                              {(() => {
                                if (
                                  !itemCalcResult ||
                                  itemCalcResult.checks.length === 0
                                ) {
                                  return null;
                                }

                                const failingChecks =
                                  itemCalcResult.checks.filter((c) => !c.ok);
                                const allOk = failingChecks.length === 0;

                                return (
                                  <div className="border border-border rounded-lg overflow-hidden">
                                    <div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-2">
                                      <Calculator className="w-3.5 h-3.5 text-foreground" />
                                      <p className="text-xs font-semibold text-foreground">
                                        Calculation Checks
                                      </p>
                                      {allOk ? (
                                        <Badge className="ml-auto bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 gap-1 text-xs">
                                          <CheckCircle2 className="w-3 h-3" />
                                          All correct
                                        </Badge>
                                      ) : (
                                        <Badge className="ml-auto bg-destructive/10 text-destructive border-destructive/20 gap-1 text-xs">
                                          <XCircle className="w-3 h-3" />
                                          {failingChecks.length} issue
                                          {failingChecks.length !== 1
                                            ? "s"
                                            : ""}
                                        </Badge>
                                      )}
                                    </div>

                                    {allOk ? (
                                      <div className="px-3 py-2 flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
                                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                        Tax amount, cost price and line amount
                                        all check out.
                                      </div>
                                    ) : (
                                      <Table>
                                        <TableHeader>
                                          <UITableRow className="bg-muted/50 hover:bg-muted/50">
                                            <TableHead className="text-xs font-semibold text-foreground">
                                              Check
                                            </TableHead>
                                            <TableHead className="text-xs font-semibold text-foreground">
                                              Formula
                                            </TableHead>
                                            <TableHead className="text-xs font-semibold text-foreground whitespace-nowrap">
                                              Correct Value
                                            </TableHead>
                                            <TableHead className="text-xs font-semibold text-foreground whitespace-nowrap">
                                              Invoice Value
                                            </TableHead>
                                            <TableHead className="w-36" />
                                          </UITableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {failingChecks.map((check) => (
                                            <UITableRow
                                              key={check.field}
                                              className="bg-destructive/5 hover:bg-destructive/10"
                                              onClick={(e) =>
                                                e.stopPropagation()
                                              }
                                            >
                                              <TableCell className="text-sm py-2 font-medium">
                                                {check.label}
                                              </TableCell>
                                              <TableCell className="text-xs text-muted-foreground py-2 font-mono whitespace-nowrap">
                                                {check.formula}
                                              </TableCell>
                                              <TableCell className="text-sm font-mono py-2 text-green-700 dark:text-green-400 font-semibold">
                                                {check.calculated}
                                              </TableCell>
                                              <TableCell className="text-sm font-mono py-2 text-destructive font-semibold">
                                                {check.actual}
                                              </TableCell>
                                              <TableCell className="py-2">
                                                {check.acceptable === false ? (
                                                  <span className="text-xs text-muted-foreground">
                                                    Split across columns
                                                  </span>
                                                ) : (
                                                <Tooltip>
                                                  <TooltipTrigger asChild>
                                                    <Button
                                                      variant="outline"
                                                      size="sm"
                                                      className="h-7 text-xs gap-1"
                                                      onClick={() => {
                                                        setFieldEdit(
                                                          idx,
                                                          check.field,
                                                          String(
                                                            check.calculated,
                                                          ),
                                                        );
                                                        setAcceptedFields(
                                                          (prev) => ({
                                                            ...prev,
                                                            [idx]: new Set([
                                                              ...(prev[idx] ??
                                                                []),
                                                              check.field,
                                                            ]),
                                                          }),
                                                        );
                                                      }}
                                                    >
                                                      <Wand2 className="w-3 h-3" />
                                                      Accept {check.calculated}
                                                    </Button>
                                                  </TooltipTrigger>
                                                  <TooltipContent>
                                                    Replace {check.actual} with{" "}
                                                    {check.calculated}
                                                  </TooltipContent>
                                                </Tooltip>
                                                )}
                                              </TableCell>
                                            </UITableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    )}
                                  </div>
                                );
                              })()}

{/* Row editor — open on every row, matched or not. A clean
                                  match can still hold a mis-read value, so the
                                  fields stay editable either way. */}
                              {(() => {
                                // Nothing else to show in the panel means the
                                // editor is the point of opening it — skip the
                                // extra click and render it open.
                                const editorOpen =
                                  editingRow.has(idx) || !hasFindings;

                                if (!editorOpen) {
                                  return (
                                    <div
                                      className="flex justify-end"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 text-xs gap-1"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setEditingRow(
                                            (prev) => new Set([...prev, idx]),
                                          );
                                        }}
                                      >
                                        <Pencil className="w-3 h-3" />
                                        Edit Row
                                      </Button>
                                    </div>
                                  );
                                }

                                return (
                                  <div
                                    className="border border-border rounded-lg overflow-hidden"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <div className="px-3 py-2 bg-muted/50 border-b border-border">
                                      <p className="text-xs font-semibold text-foreground">
                                        Edit Row Values
                                      </p>
                                    </div>
                                    <div className="p-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                                      {fieldKeys.map((key) => {
                                        const currentVal =
                                          edits[idx]?.[key] ??
                                          String(item[key] ?? "");
                                        return (
                                          <div key={key} className="space-y-1">
                                            <label className="text-xs font-medium text-muted-foreground">
                                              {fieldLabel(key)}
                                            </label>
                                            <Input
                                              className="h-7 text-sm"
                                              value={currentVal}
                                              onChange={(e) =>
                                                setFieldEdit(
                                                  idx,
                                                  key,
                                                  e.target.value,
                                                )
                                              }
                                            />
                                          </div>
                                        );
                                      })}
                                    </div>
                                    <div className="px-3 py-2 border-t border-border flex gap-2 justify-end">
                                      {editingRow.has(idx) && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-7 text-xs"
                                          onClick={() => cancelRowEdit(idx)}
                                        >
                                          Cancel
                                        </Button>
                                      )}
                                      <Button
                                        variant="default"
                                        size="sm"
                                        className="h-7 text-xs gap-1"
                                        onClick={() =>
                                          saveRowEdits(idx, stillUnmatched)
                                        }
                                      >
                                        <CheckCircle2 className="w-3 h-3" />
                                        {stillUnmatched
                                          ? "Accept Row"
                                          : "Save Changes"}
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })()}

                                                            {/* Feedback widget — explicit preference signals */}
                              <div
                                className="flex items-center gap-2 pt-2 border-t border-border"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span className="text-xs text-muted-foreground shrink-0">
                                  Feedback:
                                </span>
                                <div className="flex gap-1">
                                  {(
                                    [
                                      ["feedback_too_long", "Too long"],
                                      ["feedback_too_short", "Too short"],
                                      ["feedback_too_technical", "Too technical"],
                                      ["feedback_incorrect", "Incorrect"],
                                    ] as const
                                  ).map(([type, label]) => {
                                    const flashed = feedbackFlash[idx] === type;
                                    return (
                                      <Button
                                        key={type}
                                        variant="ghost"
                                        size="sm"
                                        className={`h-6 text-xs transition-colors ${
                                          flashed
                                            ? "text-green-600 dark:text-green-400"
                                            : "text-muted-foreground"
                                        }`}
                                        onClick={() => fireFeedback(idx, type)}
                                      >
                                        {flashed ? "✓ " : ""}{label}
                                      </Button>
                                    );
                                  })}
                                </div>
                              </div>

                              {/* Investigation outcome */}
                              {hasFindings && (
                                <div
                                  className="flex items-center gap-2 pt-2 border-t border-border"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <span className="text-xs text-muted-foreground shrink-0">
                                    Outcome:
                                  </span>
                                  {itemOutcomes[idx] ? (
                                    <Badge
                                      variant="outline"
                                      className="text-xs"
                                    >
                                      {itemOutcomes[idx]}
                                    </Badge>
                                  ) : (
                                    <div className="flex gap-1">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-6 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                                        onClick={() =>
                                          recordItemOutcome(idx, "Fraud")
                                        }
                                      >
                                        Fraud
                                      </Button>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-6 text-xs text-amber-600 border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/20"
                                        onClick={() =>
                                          recordItemOutcome(idx, "VendorError")
                                        }
                                      >
                                        Vendor Error
                                      </Button>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-6 text-xs"
                                        onClick={() =>
                                          recordItemOutcome(
                                            idx,
                                            "FalsePositive",
                                          )
                                        }
                                      >
                                        False Positive
                                      </Button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {/* Grand Total — always shown when a grand total field is detected */}
      {calcResults?.grandTotalCheck && (
        <div className="border border-border rounded-lg overflow-hidden my-4">
          <div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-3">
            <Calculator className="w-4 h-4 text-foreground" />
            <p className="text-xs font-semibold text-foreground">Grand Total</p>
            <span className="text-xs text-muted-foreground font-mono">
              {calcResults.grandTotalCheck.field}
            </span>
            {calcResults.grandTotalCheck.ok ? (
              <Badge className="ml-auto bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 gap-1 text-xs">
                <CheckCircle2 className="w-3 h-3" />
                Matches line sum
              </Badge>
            ) : calcResults.grandTotalCheck.partial ? (
              // Some lines had no amount column, so the sum is short by
              // construction — flag it as incomplete, not as a discrepancy.
              <Badge className="ml-auto bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20 gap-1 text-xs">
                <AlertCircle className="w-3 h-3" />
                Partial — {calcResults.grandTotalCheck.linesCounted} of{" "}
                {calcResults.grandTotalCheck.linesTotal} lines
              </Badge>
            ) : (
              <Badge className="ml-auto bg-destructive/10 text-destructive border-destructive/20 gap-1 text-xs">
                <XCircle className="w-3 h-3" />
                Mismatch
              </Badge>
            )}
          </div>
          <div className="px-4 py-3 flex items-center gap-6 text-sm">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                Sum of line amounts
              </span>
              <span className="font-mono font-semibold text-green-700 dark:text-green-400">
                {calcResults.lineAmountSum}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                Invoice grand total
              </span>
              <span
                className={`font-mono font-semibold ${calcResults.grandTotalCheck.ok ? "" : "text-destructive"}`}
              >
                {calcResults.grandTotalCheck.documentTotal}
              </span>
            </div>
            {!calcResults.grandTotalCheck.ok && (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  Difference
                </span>
                <span
                  className={`font-mono font-semibold ${calcResults.grandTotalCheck.partial ? "text-yellow-700 dark:text-yellow-400" : "text-destructive"}`}
                >
                  {Math.abs(
                    calcResults.lineAmountSum -
                      calcResults.grandTotalCheck.documentTotal,
                  ).toFixed(2)}
                </span>
              </div>
            )}
          </div>
          {calcResults.grandTotalCheck.partial && (
            <p className="px-4 pb-3 text-xs text-muted-foreground">
              {calcResults.grandTotalCheck.linesTotal -
                calcResults.grandTotalCheck.linesCounted}{" "}
              line item(s) had no recognisable amount column and are not
              included in the sum, so a difference here may not be a real
              discrepancy.
            </p>
          )}
        </div>
      )}
    </TooltipProvider>
  );
};

export default ValidationResults;
