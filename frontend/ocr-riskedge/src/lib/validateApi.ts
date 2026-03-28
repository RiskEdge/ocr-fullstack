import api from "@/lib/api";

export interface Discrepancy {
  field: string;
  expected: number | string | null;
  actual: number | string | null;
  message: string;
}

export interface ValidationResult {
  matched_plu: string | null;
  is_valid: boolean;
  match_type?: "fuzzy_name" | "no_match";
  match_note?: string;
  confidence?: "high" | "medium" | "low";
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

export async function validateItems(
  items: Record<string, unknown>[],
  token: string
): Promise<ValidatedItem[]> {
  const response = await api.post(
    "/v1/validate-data",
    { items },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data.validated_items as ValidatedItem[];
}
