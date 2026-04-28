/**
 * profilesApi.ts — Phase 2: fire-and-forget wrappers for profile endpoints.
 *
 * Reads the JWT from localStorage (same pattern as behaviorTracker.ts).
 * All fire-and-forget functions return void and swallow errors — profile
 * calls must never block or break the UI.
 */

const TOKEN_KEY = "ocr_access_token";

function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function post(path: string, body: Record<string, unknown>): void {
  const token = getToken();
  if (!token) return;
  fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Record that this user has seen a validation flag.
 * Called automatically when a discrepancy row is first rendered.
 */
export function recordFlagExposure(flagType: string): void {
  post("/v1/memory/flag-exposure", { flag_type: flagType });
}

/**
 * Record a flag dismissal. When the user has dismissed the same flag 3 times
 * the backend will auto-suppress it in future prompts.
 */
export function recordDismissal(flagType: string, riskScore?: number): void {
  post("/v1/memory/dismiss", {
    flag_type: flagType,
    ...(riskScore !== undefined ? { risk_score: riskScore } : {}),
  });
}

const OUTCOME_RISK_SCORES: Record<string, number> = {
  Fraud: 0.9,
  VendorError: 0.5,
  FalsePositive: 0.1,
};

/**
 * Record the outcome of a flag investigation.
 * outcome must be one of: 'Fraud' | 'VendorError' | 'FalsePositive'
 */
export function recordInvestigation(
  flagType: string,
  outcome: string,
  sourceFilename?: string,
  vendorId?: string,
): void {
  const riskScore = OUTCOME_RISK_SCORES[outcome];
  post("/v1/memory/investigation", {
    flag_type: flagType,
    outcome,
    ...(riskScore !== undefined ? { risk_score: riskScore } : {}),
    ...(sourceFilename ? { source_filename: sourceFilename } : {}),
    ...(vendorId ? { vendor_id: vendorId } : {}),
  });
}

export interface UserProfile {
  user_id: string;
  company_id: string;
  role: string | null;
  explanation_depth: number;
  technical_level: number;
  effective_risk_threshold: number;
  low_signal_flags: string[];
  auto_select_plu: boolean;
  last_aggregated_at: string | null;
}

export type UserProfilePatch = Partial<Pick<UserProfile, "auto_select_plu">>;

/**
 * Partially update user preference fields.
 * Fire-and-forget — errors are swallowed.
 */
export function updateUserPreferences(patch: UserProfilePatch): void {
  const token = getToken();
  if (!token) return;
  fetch("/v1/user-profile", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(patch),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Record a field correction so the system can learn repeated patterns.
 * Fire-and-forget — errors are swallowed.
 */
export function recordFieldCorrection(
  pluCode: string | null,
  eanCode: string | null,
  field: string,
  correctedValue: string,
  sourceFilename?: string,
): void {
  if (!pluCode && !eanCode) return;
  post("/v1/memory/field-correction", {
    plu_code: pluCode,
    ean_code: eanCode,
    field,
    corrected_value: correctedValue,
    ...(sourceFilename ? { source_filename: sourceFilename } : {}),
  });
}

export interface FieldHint {
  plu_code: string | null;
  ean_code: string | null;
  field: string;
  corrected_value: string;
  count: number;
  last_corrected_at: string;
}

export async function getFieldHints(
  pluCodes: string[],
  eanCodes: string[] = [],
): Promise<FieldHint[]> {
  const token = getToken();
  if (!token) return [];
  const params = new URLSearchParams();
  if (pluCodes.length) params.set("plu_codes", pluCodes.join(","));
  if (eanCodes.length) params.set("ean_codes", eanCodes.join(","));
  try {
    const res = await fetch(`/v1/memory/field-hints?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    return (await res.json()) as FieldHint[];
  } catch {
    return [];
  }
}

/**
 * Fetch the current user's preference profile.
 * Returns null on any error so callers can fall back to defaults silently.
 */
export async function getUserProfile(): Promise<UserProfile | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch("/v1/user-profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as UserProfile;
  } catch {
    return null;
  }
}
