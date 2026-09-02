import api from "@/lib/api";

export interface Discrepancy {
  field: string;
  expected: number | string | null;
  actual: number | string | null;
  message: string;
}

export interface PluOption {
  plu_code: string;
  sku_desc: string | null;
  ean_code?: string | null;
  cost_price: number | null;
  mrp: number | null;
  tax_pct: number | null;
  priority: number | null;
  /** Unit of measure the catalog costs this item in, e.g. "BOX". */
  uom?: string | null;
  /** Individual units inside one UOM — the divisor that turns an invoice's
   *  pack price into a per-unit cost. */
  uom_qty?: number | null;
}

/** How a value the invoice never printed was worked out. */
export interface DerivedField {
  value: number;
  source: "tax_amounts" | "gst_rate";
  formula: string;
  unit_price?: number;
  price_source?: string;
  uom?: string | null;
  uom_qty?: number | null;
  quantity?: number | null;
  base_unit_cost?: number;
  tax_total?: number | null;
  total_units?: number | null;
  tax_per_unit?: number;
}

export interface ValidationResult {
  matched_plu: string | null;
  is_valid: boolean;
  match_type?: "fuzzy_name" | "no_match" | "multi_plu" | "auto_selected";
  /** Which identifier resolved the match. Absent on Gemini-decided matches. */
  match_source?: "ean" | "item_code" | "name_exact";
  match_note?: string;
  confidence?: "high" | "medium" | "low";
  plu_options?: PluOption[];
  /** Candidates ranked below plu_options that were still considered for this
   *  line. Already fetched and scored server-side, so the "show all
   *  considered" toggle reveals them without another request. */
  additional_plu_options?: PluOption[];
  /** Gemini's pick among plu_options — highlighted as recommended in the UI. */
  recommended_plu?: string | null;
  discrepancies: Discrepancy[];
  suggested_corrections: Record<string, number | string>;
  /** Fields computed from other invoice columns rather than read off the
   *  document — currently only cost_price. Rendered with a "derived" badge so
   *  a computed figure is never mistaken for a printed one. */
  derived_fields?: Record<string, DerivedField>;
}

export type ValidatedItem = {
  product_name?: string;
  ean_code?: string;
  cost_price?: number | string;
  mrp?: number | string;
  tax_pct?: number | string;
  validation: ValidationResult;
} & Record<string, unknown>;

export interface ValidationRunResult {
  validated_items: ValidatedItem[];
}

export async function validateItems(
  items: Record<string, unknown>[],
  token: string,
  sourceFilename?: string,
): Promise<ValidationRunResult> {
  const response = await api.post(
    "/v1/validate-data",
    { items, source_filename: sourceFilename ?? null },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data as ValidationRunResult;
}
