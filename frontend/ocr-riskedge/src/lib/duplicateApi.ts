import api from "@/lib/api";

/** One previously-processed file, grouped by content hash. */
export interface DuplicateEntry {
  file_hash: string;
  /** How many times this company has processed these exact bytes. */
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  /** Filename used on the most recent run — may differ from the current one. */
  last_filename: string;
  last_user: string | null;
  first_user: string | null;
  /** Pages Gemini reported last run. Informational — billing is 1 credit
   *  per document regardless of page count. */
  page_count: number | null;
}

export interface DuplicateCheckResponse {
  duplicates: DuplicateEntry[];
  lookback_days: number;
}

export interface DuplicateCheckFile {
  filename: string;
  sha256: string;
  size: number;
}

/**
 * Ask the backend which of these files the company has already processed.
 *
 * Advisory only — the caller shows a warning, the server never blocks the
 * upload. Errors are the caller's to swallow; a failed check must not stop
 * someone from extracting.
 */
export async function checkDuplicates(
  files: DuplicateCheckFile[],
  token: string,
): Promise<DuplicateCheckResponse> {
  const response = await api.post(
    "/v1/duplicate-check",
    { files },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.data as DuplicateCheckResponse;
}
