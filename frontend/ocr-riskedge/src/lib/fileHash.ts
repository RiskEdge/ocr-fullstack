/**
 * fileHash.ts — SHA-256 fingerprints for staged uploads.
 *
 * Used by the duplicate check so the browser can ask "has this company already
 * processed these bytes?" without re-uploading the files. The digest is
 * one-way: it identifies a file without revealing anything about its contents.
 *
 * crypto.subtle is only available in a secure context (HTTPS or localhost).
 * Where it isn't, hashing is skipped and duplicate detection quietly turns off
 * rather than blocking the upload.
 */

/** Files hashed at once. Keeps large batches from monopolising the main thread. */
const HASH_CONCURRENCY = 4;

export function isHashingSupported(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256File(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Hash a batch of files with bounded concurrency.
 *
 * Files that fail to hash (unreadable, or no secure context) are simply absent
 * from the returned map — callers treat a missing hash as "not checkable".
 */
export async function hashFiles(files: File[]): Promise<Map<File, string>> {
  const hashes = new Map<File, string>();
  if (!isHashingSupported() || files.length === 0) return hashes;

  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      try {
        hashes.set(file, await sha256File(file));
      } catch {
        // Unreadable file — skip it rather than failing the whole batch.
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(HASH_CONCURRENCY, files.length) },
    worker,
  );
  await Promise.all(workers);
  return hashes;
}
