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
  cost_price: number | null;
  mrp: number | null;
  tax_pct: number | null;
  priority: number | null;
}

export interface ValidationResult {
  matched_plu: string | null;
  is_valid: boolean;
  match_type?: "fuzzy_name" | "no_match" | "multi_plu";
  match_note?: string;
  confidence?: "high" | "medium" | "low";
  plu_options?: PluOption[];
  discrepancies: Discrepancy[];
  suggested_corrections: Record<string, number | string>;
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
  credits_used: number;
  remaining_credits: number | null;
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
