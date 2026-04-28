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
} from "lucide-react";
import type {
  ValidatedItem,
  Discrepancy,
  ValidationResult,
  PluOption,
} from "@/lib/validateApi";

const FIELD_LABELS: Record<string, string> = {
  cost_price: "Cost Price",
  mrp: "MRP",
  tax_pct: "Tax %",
  ean_code: "EAN Code",
  product_name: "Product Name",
  sku_desc: "Product Name",
  quantity: "Qty",
  plu_code: "PLU",
};

function fieldLabel(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Maps item key names to the canonical edit key used in the edits state
const ITEM_KEY_TO_EDIT_KEY: Record<string, string> = {
  product_name: "sku_desc",
  sku_desc: "sku_desc",
  cost_price: "cost_price",
  mrp: "mrp",
  tax_pct: "tax_pct",
};

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

// Client-side comparison mirroring backend local_compare logic.
function computeLocalValidation(
  item: ValidatedItem,
  master: PluOption,
): {
  discrepancies: Discrepancy[];
  corrections: Record<string, number | string>;
} {
  const discrepancies: Discrepancy[] = [];
  const corrections: Record<string, number | string> = {};

  for (const field of ["cost_price", "mrp", "tax_pct"] as const) {
    const invVal = parseFloat(String(item[field] ?? ""));
    const masterVal = parseFloat(String(master[field] ?? ""));
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

  const invDesc = String(item.sku_desc ?? item.product_name ?? "")
    .trim()
    .toUpperCase();
  const masterDesc = String(master.sku_desc ?? "")
    .trim()
    .toUpperCase();
  if (invDesc && masterDesc && invDesc !== masterDesc) {
    discrepancies.push({
      field: "sku_desc",
      expected: master.sku_desc,
      actual: String(item.sku_desc ?? item.product_name ?? ""),
      message: `Product description mismatch: invoice has '${item.sku_desc ?? item.product_name}', master has '${master.sku_desc}'.`,
    });
    corrections["sku_desc"] = master.sku_desc ?? "";
  }

  return { discrepancies, corrections };
}

interface PluSelection {
  plu_code: string;
  discrepancies: Discrepancy[];
  corrections: Record<string, number | string>;
}

// ---------------------------------------------------------------------------
// Calculation validation — field-name candidates (normalised to lowercase,
// no spaces/underscores/dots for matching)
// ---------------------------------------------------------------------------

const BASE_RATE_CANDIDATES = [
  "baserate",
  "baseRate",
  "base_rate",
  "brate",
  "b_rate",
  "basicrate",
  "basic_rate",
  "rate",
  "unitprice",
  "unit_price",
];
const TAX_AMOUNT_CANDIDATES = [
  "taxamount",
  "tax_amount",
  "taxamt",
  "tax_amt",
  "gstamount",
  "gst_amount",
  "vatamount",
  "vat_amount",
];
const LINE_AMOUNT_CANDIDATES = [
  "amount",
  "netamount",
  "net_amount",
  "linetotal",
  "line_total",
  "totalamount",
  "total_amount",
  "value",
  "netvalue",
  "net_value",
  "lineamount",
  "line_amount",
];
const GRAND_TOTAL_CANDIDATES = [
  "grandtotal",
  "grand_total",
  "invoicetotal",
  "invoice_total",
  "nettotal",
  "net_total",
  "billamount",
  "bill_amount",
  "totalamount",
  "total_amount",
  "invoiceamount",
  "invoice_amount",
  "total",
  "nettaxableamount",
  "net_taxable_amount",
];

function normKey(k: string): string {
  return k.toLowerCase().replace(/[\s_.]/g, "");
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
      const n = parseFloat(String(v ?? ""));
      if (!isNaN(n)) return { key: k, value: n };
    }
  }
  return null;
}

// Find a grand-total field in the document-level scalar map.
function findGrandTotal(
  scalars: Record<string, unknown>,
): { key: string; value: number } | null {
  const normCandidates = new Set(GRAND_TOTAL_CANDIDATES.map(normKey));
  for (const [k, v] of Object.entries(scalars)) {
    if (normCandidates.has(normKey(k))) {
      const n = parseFloat(String(v ?? ""));
      if (!isNaN(n)) return { key: k, value: n };
    }
  }
  return null;
}

interface CalcCheck {
  label: string;
  field: string;
  formula: string;
  calculated: number;
  actual: number;
  ok: boolean;
}

interface LineCalcResult {
  idx: number;
  productName: string;
  checks: CalcCheck[];
  ok: boolean;
}

interface CalcValidationResult {
  lineResults: LineCalcResult[];
  lineAmountSum: number;
  grandTotalCheck: {
    field: string;
    documentTotal: number;
    ok: boolean;
  } | null;
  allLinesHaveAmount: boolean;
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
  const [editingNoMatch, setEditingNoMatch] = useState<Set<number>>(new Set());
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
      const itemEdits = edits[idx];
      const pluSel = pluSelections[idx];

      if (v.match_type === "no_match") {
        noMatch++;
        continue;
      }
      if (v.match_type === "multi_plu" && !pluSel) {
        pending++;
        continue;
      }

      const effectiveDiscrepanciesRaw =
        v.match_type === "multi_plu" && pluSel
          ? pluSel.discrepancies
          : v.discrepancies;
      const effectiveCorrections =
        v.match_type === "multi_plu" && pluSel
          ? pluSel.corrections
          : v.suggested_corrections;

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

      const effectivelyValid =
        (v.match_type === "multi_plu"
          ? pluSel!.discrepancies.length === 0
          : v.is_valid) || remaining === 0;
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
  }, [items, edits, pluSelections, acceptedFields]);

  // ---------------------------------------------------------------------------
  // Calculation validation — runs for every item, reactive to edits.
  // ---------------------------------------------------------------------------
  const calcResults = useMemo((): CalcValidationResult | null => {
    const lineResults: LineCalcResult[] = [];
    let lineAmountSum = 0;
    let allLinesHaveAmount = true;

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

      const effectiveCostPrice = parseFloat(
        String(effectiveItem["cost_price"] ?? ""),
      );
      const effectiveTaxPct = parseFloat(
        String(effectiveItem["tax_pct"] ?? ""),
      );

      const baseRateField = findFieldValue(effectiveItem, BASE_RATE_CANDIDATES);
      const taxAmountField = findFieldValue(
        effectiveItem,
        TAX_AMOUNT_CANDIDATES,
      );
      const lineAmtField = findFieldValue(
        effectiveItem,
        LINE_AMOUNT_CANDIDATES,
      );
      const quantity = parseFloat(String(effectiveItem["quantity"] ?? ""));

      const checks: CalcCheck[] = [];

      // Check 1 — Tax Amount = Base Rate × Tax% / 100
      if (baseRateField && !isNaN(effectiveTaxPct) && taxAmountField) {
        const calculated = parseFloat(
          ((baseRateField.value * effectiveTaxPct) / 100).toFixed(4),
        );
        checks.push({
          label: "Tax Amount",
          field: taxAmountField.key,
          formula: `${baseRateField.value} × ${effectiveTaxPct}% ÷ 100`,
          calculated,
          actual: taxAmountField.value,
          ok: Math.abs(calculated - taxAmountField.value) <= 0.02,
        });
      }

      // Check 2 — Cost Price = Base Rate + Tax Amount
      if (baseRateField && taxAmountField && !isNaN(effectiveCostPrice)) {
        const calculated = parseFloat(
          (baseRateField.value + taxAmountField.value).toFixed(4),
        );
        checks.push({
          label: "Cost Price",
          field: "cost_price",
          formula: `${baseRateField.value} + ${taxAmountField.value}`,
          calculated,
          actual: effectiveCostPrice,
          ok: Math.abs(calculated - effectiveCostPrice) <= 0.02,
        });
      }

      // Check 3 — Line Amount = Cost Price × Qty
      if (!isNaN(effectiveCostPrice) && !isNaN(quantity) && lineAmtField) {
        const calculated = parseFloat(
          (effectiveCostPrice * quantity).toFixed(2),
        );
        checks.push({
          label: "Line Amount",
          field: lineAmtField.key,
          formula: `${effectiveCostPrice} × ${quantity}`,
          calculated,
          actual: lineAmtField.value,
          ok: Math.abs(calculated - lineAmtField.value) <= 0.02,
        });
      }

      if (lineAmtField) {
        lineAmountSum += lineAmtField.value;
      } else {
        allLinesHaveAmount = false;
      }

      const productName = String(
        item["product_name"] ?? item["sku_desc"] ?? `Item ${idx + 1}`,
      );

      lineResults.push({
        idx,
        productName,
        checks,
        ok: checks.length === 0 || checks.every((c) => c.ok),
      });
    }

    // Grand total check
    let grandTotalCheck: CalcValidationResult["grandTotalCheck"] = null;
    if (documentScalars && allLinesHaveAmount && lineResults.length > 0) {
      const gtField = findGrandTotal(documentScalars);
      if (gtField) {
        const sumRounded = parseFloat(lineAmountSum.toFixed(2));
        grandTotalCheck = {
          field: gtField.key,
          documentTotal: gtField.value,
          ok: Math.abs(sumRounded - gtField.value) <= 0.05,
        };
      }
    }

    return {
      lineResults,
      lineAmountSum: parseFloat(lineAmountSum.toFixed(2)),
      grandTotalCheck,
      allLinesHaveAmount,
    };
  }, [items, edits, acceptedFields, documentScalars]);

  function toggleExpand(idx: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        // Collapsing — fire skipped_reasoning if the user opened it but never interacted.
        const hadInteraction =
          (acceptedFields[idx]?.size ?? 0) > 0 ||
          (dismissedFields[idx]?.size ?? 0) > 0 ||
          (editingDiscrepancy[idx]?.size ?? 0) > 0 ||
          !!pluSelections[idx] ||
          !!itemOutcomes[idx];
        if (!hadInteraction) {
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

  function selectPlu(itemIdx: number, opt: PluOption) {
    const { discrepancies, corrections } = computeLocalValidation(
      items[itemIdx],
      opt,
    );
    setPluSelections((prev) => ({
      ...prev,
      [itemIdx]: { plu_code: opt.plu_code, discrepancies, corrections },
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
        const editKey = ITEM_KEY_TO_EDIT_KEY[key] ?? key;
        const accepted = itemEdits?.[editKey];
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
      const effectiveCorrections =
        v.match_type === "multi_plu" && pluSel
          ? pluSel.corrections
          : v.suggested_corrections;
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
                  const itemEdits = edits[idx];
                  const isExpanded = expanded.has(idx);
                  const isFuzzy = v.match_type === "fuzzy_name";
                  const isNoMatch = v.match_type === "no_match";
                  const isMultiPlu = v.match_type === "multi_plu";
                  const pluSel = pluSelections[idx];

                  // Build effective validation values (override for multi-PLU after selection)
                  const effectiveMatchedPlu = isMultiPlu
                    ? (pluSel?.plu_code ?? null)
                    : v.matched_plu;
                  const effectiveDiscrepanciesRaw =
                    isMultiPlu && pluSel
                      ? pluSel.discrepancies
                      : v.discrepancies;
                  const effectiveCorrections =
                    isMultiPlu && pluSel
                      ? pluSel.corrections
                      : v.suggested_corrections;

                  // Remaining unresolved discrepancies
                  const effectiveDiscrepancies =
                    effectiveDiscrepanciesRaw.filter(
                      (d) => !isResolved(d, acceptedFields[idx]),
                    );

                  const isPending = isMultiPlu && !pluSel;

                  const isEffectivelyValid =
                    !isPending &&
                    !isNoMatch &&
                    (isMultiPlu
                      ? pluSel!.discrepancies.length === 0 ||
                        effectiveDiscrepancies.length === 0
                      : v.is_valid || effectiveDiscrepancies.length === 0);

                  // Cells that still have active discrepancies
                  // sku_desc and product_name are aliases — highlight both
                  const discrepantFields = new Set(
                    effectiveDiscrepancies.flatMap((d) =>
                      d.field === "sku_desc"
                        ? ["sku_desc", "product_name"]
                        : [d.field],
                    ),
                  );

                  const itemCalcResult = calcResults?.lineResults.find(
                    (r) => r.idx === idx,
                  );
                  const hasCalcErrors =
                    itemCalcResult?.checks.some((c) => !c.ok) ?? false;

                  const isExpandable =
                    v.discrepancies.length > 0 ||
                    isFuzzy ||
                    isNoMatch ||
                    isMultiPlu ||
                    hasCalcErrors;

                  return (
                    <Fragment key={idx}>
                      {/* Data row */}
                      <UITableRow
                        className={`${isExpandable ? "cursor-pointer" : ""} hover:bg-muted/30 ${
                          isExpanded ? "bg-muted/20" : ""
                        }`}
                        onClick={() => isExpandable && toggleExpand(idx)}
                      >
                        {/* Expand chevron */}
                        <TableCell className="px-2 py-2 w-8">
                          {isExpandable &&
                            (isExpanded ? (
                              <ChevronDown className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-muted-foreground" />
                            ))}
                        </TableCell>

                        {/* Row number */}
                        <TableCell className="text-xs text-muted-foreground font-mono py-2">
                          {idx + 1}
                        </TableCell>

                        {/* Dynamic OCR field cells */}
                        {fieldKeys.map((key) => {
                          const editKey = ITEM_KEY_TO_EDIT_KEY[key] ?? key;
                          const editedVal = edits[idx]?.[editKey];
                          const displayVal =
                            editedVal !== undefined ? editedVal : item[key];
                          const isAccepted =
                            acceptedFields[idx]?.has(editKey) ?? false;
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
                              {formatCellValue(displayVal)}
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
                            ) : isNoMatch ? (
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
                                  <Table>
                                    <TableHeader>
                                      <UITableRow className="bg-muted/50 hover:bg-muted/50">
                                        <TableHead className="text-xs font-semibold text-foreground">
                                          PLU Code
                                        </TableHead>
                                        <TableHead className="text-xs font-semibold text-foreground">
                                          Product Name
                                        </TableHead>
                                        <TableHead className="text-xs font-semibold text-foreground">
                                          Cost Price
                                        </TableHead>
                                        <TableHead className="text-xs font-semibold text-foreground">
                                          MRP
                                        </TableHead>
                                        <TableHead className="text-xs font-semibold text-foreground">
                                          Tax %
                                        </TableHead>
                                        <TableHead className="text-xs font-semibold text-foreground">
                                          Priority
                                        </TableHead>
                                        <TableHead className="text-xs font-semibold text-foreground">
                                          Differences
                                        </TableHead>
                                        <TableHead className="w-20" />
                                      </UITableRow>
                                      {/* Invoice reference row */}
                                      <UITableRow className="bg-blue-50/60 dark:bg-blue-950/20 hover:bg-blue-50/60">
                                        <TableCell className="text-xs text-blue-600 dark:text-blue-400 font-semibold py-1.5 italic">
                                          Invoice
                                        </TableCell>
                                        <TableCell className="text-xs font-mono py-1.5 text-blue-700 dark:text-blue-300">
                                          {String(
                                            item.sku_desc ??
                                              item.product_name ??
                                              "—",
                                          )}
                                        </TableCell>
                                        <TableCell className="text-xs font-mono py-1.5 text-blue-700 dark:text-blue-300">
                                          {String(item.cost_price ?? "—")}
                                        </TableCell>
                                        <TableCell className="text-xs font-mono py-1.5 text-blue-700 dark:text-blue-300">
                                          {String(item.mrp ?? "—")}
                                        </TableCell>
                                        <TableCell className="text-xs font-mono py-1.5 text-blue-700 dark:text-blue-300">
                                          {String(item.tax_pct ?? "—")}
                                        </TableCell>
                                        <TableCell className="py-1.5" />
                                        <TableCell className="py-1.5" />
                                        <TableCell className="py-1.5" />
                                      </UITableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {v.plu_options.map((opt) => {
                                        const { discrepancies: optDiffs } =
                                          computeLocalValidation(item, opt);
                                        const diffFields = new Set(
                                          optDiffs.map((d) => d.field),
                                        );
                                        const cellCls = (field: string) =>
                                          diffFields.has(field)
                                            ? "text-destructive font-semibold"
                                            : "text-green-700 dark:text-green-400";
                                        return (
                                          <UITableRow
                                            key={opt.plu_code}
                                            className="hover:bg-muted/30"
                                          >
                                            <TableCell className="text-sm font-mono py-2">
                                              {opt.plu_code}
                                            </TableCell>
                                            <TableCell
                                              className={`text-sm py-2 ${cellCls("sku_desc")}`}
                                            >
                                              {opt.sku_desc ?? "—"}
                                            </TableCell>
                                            <TableCell
                                              className={`text-sm font-mono py-2 ${cellCls("cost_price")}`}
                                            >
                                              {opt.cost_price ?? "—"}
                                            </TableCell>
                                            <TableCell
                                              className={`text-sm font-mono py-2 ${cellCls("mrp")}`}
                                            >
                                              {opt.mrp ?? "—"}
                                            </TableCell>
                                            <TableCell
                                              className={`text-sm font-mono py-2 ${cellCls("tax_pct")}`}
                                            >
                                              {opt.tax_pct ?? "—"}
                                            </TableCell>
                                            <TableCell className="text-sm py-2">
                                              {opt.priority ?? "—"}
                                            </TableCell>
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
                                            <TableCell
                                              className="py-2"
                                              onClick={(e) =>
                                                e.stopPropagation()
                                              }
                                            >
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-7 text-xs"
                                                onClick={() =>
                                                  selectPlu(idx, opt)
                                                }
                                              >
                                                Select
                                              </Button>
                                            </TableCell>
                                          </UITableRow>
                                        );
                                      })}
                                    </TableBody>
                                  </Table>
                                </div>
                              )}

                              {/* Multi-PLU: selected PLU indicator with Change + Accept All options */}
                              {isMultiPlu && pluSel && (
                                <div className="flex items-center gap-2 text-sm text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 rounded-md px-3 py-2">
                                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                                  <span>
                                    Selected PLU:{" "}
                                    <strong className="font-mono">
                                      {pluSel.plu_code}
                                    </strong>
                                  </span>
                                  <div className="ml-auto flex items-center gap-1">
                                    {effectiveDiscrepancies.length > 0 &&
                                      Object.keys(pluSel.corrections).length >
                                        0 && (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="h-6 text-xs gap-1 text-violet-700 border-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/30"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            applyAllSuggestions(
                                              idx,
                                              pluSel.corrections,
                                            );
                                          }}
                                        >
                                          <Wand2 className="w-3 h-3" />
                                          Accept all
                                        </Button>
                                      )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 text-xs text-violet-600 hover:text-violet-700"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        clearPluSelection(idx);
                                      }}
                                    >
                                      Change
                                    </Button>
                                  </div>
                                </div>
                              )}

                              {/* Fuzzy match note */}
                              {isFuzzy && v.match_note && (
                                <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded-md px-3 py-2">
                                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                                  <span>{v.match_note}</span>
                                </div>
                              )}

                              {/* No-match message + edit row */}
                              {isNoMatch && (
                                <>
                                  {v.discrepancies[0]?.message && (
                                    <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
                                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                      <span>{v.discrepancies[0].message}</span>
                                    </div>
                                  )}
                                  {editingNoMatch.has(idx) ? (
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
                                          const editKey =
                                            ITEM_KEY_TO_EDIT_KEY[key] ?? key;
                                          const currentVal =
                                            edits[idx]?.[editKey] ??
                                            String(item[key] ?? "");
                                          return (
                                            <div
                                              key={key}
                                              className="space-y-1"
                                            >
                                              <label className="text-xs font-medium text-muted-foreground">
                                                {fieldLabel(key)}
                                              </label>
                                              <Input
                                                className="h-7 text-sm"
                                                value={currentVal}
                                                onChange={(e) =>
                                                  setFieldEdit(
                                                    idx,
                                                    editKey,
                                                    e.target.value,
                                                  )
                                                }
                                              />
                                            </div>
                                          );
                                        })}
                                      </div>
                                      <div className="px-3 py-2 border-t border-border flex gap-2 justify-end">
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-7 text-xs"
                                          onClick={() =>
                                            setEditingNoMatch((prev) => {
                                              const next = new Set(prev);
                                              next.delete(idx);
                                              return next;
                                            })
                                          }
                                        >
                                          Cancel
                                        </Button>
                                        <Button
                                          variant="default"
                                          size="sm"
                                          className="h-7 text-xs gap-1"
                                          onClick={() => {
                                            const fields = new Set<string>(
                                              fieldKeys.map(
                                                (k) =>
                                                  ITEM_KEY_TO_EDIT_KEY[k] ?? k,
                                              ),
                                            );
                                            setAcceptedFields((prev) => ({
                                              ...prev,
                                              [idx]: new Set([
                                                ...(prev[idx] ?? []),
                                                ...fields,
                                              ]),
                                            }));
                                            setEditingNoMatch((prev) => {
                                              const next = new Set(prev);
                                              next.delete(idx);
                                              return next;
                                            });
                                          }}
                                        >
                                          <CheckCircle2 className="w-3 h-3" />
                                          Accept Row
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
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
                                          setEditingNoMatch(
                                            (prev) => new Set([...prev, idx]),
                                          );
                                        }}
                                      >
                                        <Pencil className="w-3 h-3" />
                                        Edit Row
                                      </Button>
                                    </div>
                                  )}
                                </>
                              )}

                              {/* Multi-PLU selected: full editable comparison for ALL fields */}
                              {isMultiPlu &&
                                pluSel &&
                                (() => {
                                  const selectedOpt = v.plu_options?.find(
                                    (o) => o.plu_code === pluSel.plu_code,
                                  );
                                  if (!selectedOpt) return null;

                                  const comparableFields: Array<{
                                    field: string;
                                    label: string;
                                    invoiceKeys: string[];
                                    masterVal: string | number | null;
                                    isNumeric: boolean;
                                  }> = [
                                    {
                                      field: "sku_desc",
                                      label: "Product Name",
                                      invoiceKeys: ["sku_desc", "product_name"],
                                      masterVal: selectedOpt.sku_desc,
                                      isNumeric: false,
                                    },
                                    {
                                      field: "cost_price",
                                      label: "Cost Price",
                                      invoiceKeys: ["cost_price"],
                                      masterVal: selectedOpt.cost_price,
                                      isNumeric: true,
                                    },
                                    {
                                      field: "mrp",
                                      label: "MRP",
                                      invoiceKeys: ["mrp"],
                                      masterVal: selectedOpt.mrp,
                                      isNumeric: true,
                                    },
                                    {
                                      field: "tax_pct",
                                      label: "Tax %",
                                      invoiceKeys: ["tax_pct"],
                                      masterVal: selectedOpt.tax_pct,
                                      isNumeric: true,
                                    },
                                  ];

                                  return (
                                    <div className="border border-border rounded-lg overflow-hidden">
                                      <Table>
                                        <TableHeader>
                                          <UITableRow className="bg-muted/50 hover:bg-muted/50">
                                            <TableHead className="text-xs font-semibold text-foreground">
                                              Field
                                            </TableHead>
                                            <TableHead className="text-xs font-semibold text-foreground">
                                              Master Value
                                            </TableHead>
                                            <TableHead className="text-xs font-semibold text-foreground">
                                              Your Value
                                            </TableHead>
                                            <TableHead className="w-32" />
                                          </UITableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {comparableFields.map(
                                            ({
                                              field,
                                              label,
                                              invoiceKeys,
                                              masterVal,
                                              isNumeric,
                                            }) => {
                                              const invoiceRaw =
                                                invoiceKeys.reduce<unknown>(
                                                  (acc, k) =>
                                                    acc !== undefined &&
                                                    acc !== null
                                                      ? acc
                                                      : item[k],
                                                  undefined,
                                                );
                                              const masterStr =
                                                masterVal !== null &&
                                                masterVal !== undefined
                                                  ? String(masterVal)
                                                  : null;
                                              const currentVal =
                                                edits[idx]?.[field] ??
                                                String(invoiceRaw ?? "");
                                              const isFieldAccepted =
                                                acceptedFields[idx]?.has(
                                                  field,
                                                ) ?? false;
                                              const isFieldEditing =
                                                editingDiscrepancy[idx]?.has(
                                                  field,
                                                ) ?? false;

                                              const matches =
                                                masterStr !== null &&
                                                (() => {
                                                  if (isNumeric) {
                                                    const a =
                                                      parseFloat(currentVal);
                                                    const b =
                                                      parseFloat(masterStr);
                                                    return (
                                                      !isNaN(a) &&
                                                      !isNaN(b) &&
                                                      Math.abs(a - b) <= 0.01
                                                    );
                                                  }
                                                  return (
                                                    currentVal
                                                      .trim()
                                                      .toUpperCase() ===
                                                    masterStr
                                                      .trim()
                                                      .toUpperCase()
                                                  );
                                                })();

                                              const isResolved2 =
                                                isFieldAccepted || matches;

                                              return (
                                                <UITableRow
                                                  key={field}
                                                  className={`hover:bg-muted/30 ${!isResolved2 && masterStr !== null ? "bg-destructive/5" : ""}`}
                                                >
                                                  <TableCell className="text-sm font-medium py-2">
                                                    <span className="flex items-center gap-1.5">
                                                      {isResolved2 ? (
                                                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                                                      ) : masterStr !== null ? (
                                                        <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                                                      ) : null}
                                                      {label}
                                                    </span>
                                                  </TableCell>
                                                  <TableCell className="text-sm text-muted-foreground py-2 font-mono">
                                                    {masterStr ?? "—"}
                                                  </TableCell>
                                                  <TableCell
                                                    className="py-2"
                                                    onClick={(e) =>
                                                      e.stopPropagation()
                                                    }
                                                  >
                                                    {isFieldEditing ? (
                                                      <Input
                                                        className="h-7 text-sm font-mono w-36"
                                                        value={currentVal}
                                                        autoFocus
                                                        onChange={(e) =>
                                                          setFieldEdit(
                                                            idx,
                                                            field,
                                                            e.target.value,
                                                          )
                                                        }
                                                      />
                                                    ) : (
                                                      <span
                                                        className={`text-sm font-mono ${isResolved2 ? "text-green-700 dark:text-green-400 font-medium" : ""}`}
                                                      >
                                                        {currentVal || "—"}
                                                      </span>
                                                    )}
                                                  </TableCell>
                                                  <TableCell
                                                    className="py-2"
                                                    onClick={(e) =>
                                                      e.stopPropagation()
                                                    }
                                                  >
                                                    {isFieldEditing ? (
                                                      <div className="flex gap-1">
                                                        <Button
                                                          variant="default"
                                                          size="sm"
                                                          className="h-7 text-xs gap-1"
                                                          onClick={() =>
                                                            acceptField(
                                                              idx,
                                                              field,
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
                                                              field,
                                                            )
                                                          }
                                                        >
                                                          Cancel
                                                        </Button>
                                                      </div>
                                                    ) : !isResolved2 ? (
                                                      <div className="flex gap-1">
                                                        {masterStr !== null && (
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
                                                                    field,
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
                                                              value: {masterStr}
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
                                                              field,
                                                            )
                                                          }
                                                        >
                                                          <Pencil className="w-3 h-3" />
                                                          Edit
                                                        </Button>
                                                      </div>
                                                    ) : null}
                                                  </TableCell>
                                                </UITableRow>
                                              );
                                            },
                                          )}
                                        </TableBody>
                                      </Table>
                                    </div>
                                  );
                                })()}

                              {/* Discrepancies table for non-multi-PLU items (resolved ones dimmed) */}
                              {!isNoMatch &&
                                !isPending &&
                                !isMultiPlu &&
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
                                              const currentVal = getEditValue(
                                                idx,
                                                d.field,
                                                d.actual,
                                              );
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
                                                      <span
                                                        className={`text-sm font-mono ${resolved ? "text-green-700 dark:text-green-400 font-medium" : ""}`}
                                                      >
                                                        {currentVal || "—"}
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
                                const lr = calcResults?.lineResults.find(
                                  (r) => r.idx === idx,
                                );
                                if (!lr || lr.checks.length === 0) return null;

                                const failingChecks = lr.checks.filter(
                                  (c) => !c.ok,
                                );
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
                                              </TableCell>
                                            </UITableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    )}
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
                              {isExpandable && (
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
                <span className="font-mono font-semibold text-destructive">
                  {Math.abs(
                    calcResults.lineAmountSum -
                      calcResults.grandTotalCheck.documentTotal,
                  ).toFixed(2)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </TooltipProvider>
  );
};

export default ValidationResults;
