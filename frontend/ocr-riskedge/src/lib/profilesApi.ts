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
  post("/v1/memory/investigation", {
    flag_type: flagType,
    outcome,
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
