import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import api from "@/lib/api";
import Header from "@/components/Header";
import FileUpload from "@/components/FileUpload";
import DocumentPreview from "@/components/DocumentPreview";
import DataTable, { ExtractedData, TableRow } from "@/components/DataTable";
import ExportButtons from "@/components/ExportButtons";
import DownloadAllButton from "@/components/DownloadAllButton";
import ProcessingHistory, { HistoryItem, RawContent } from "@/components/ProcessingHistory";
import ProcessingModeToggle, { ProcessingMode } from "@/components/ProcessingModeToggle";
import OverallProgress from "@/components/OverallProgress";
import { FileStatus } from "@/components/FileProcessingStatus";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Sparkles, RefreshCw, Table2, Eye, History, PanelLeftClose, PanelLeft, ChevronLeft, ChevronRight, LayoutGrid, FileText as FileTextIcon, Zap, ShieldCheck, Maximize2, Minimize2 } from "lucide-react";
import DocumentGridView from "@/components/DocumentGridView";
import ValidationResults from "@/components/ValidationResults";
import { validateItems } from "@/lib/validateApi";
import type { ValidatedItem } from "@/lib/validateApi";
import DuplicateWarningDialog, { DuplicateFile, DuplicateDialogMode } from "@/components/DuplicateWarningDialog";
import { checkDuplicates, DuplicateEntry } from "@/lib/duplicateApi";
import { hashFiles, isHashingSupported } from "@/lib/fileHash";
import { track } from "@/lib/behaviorTracker";

// ---------------------------------------------------------------------------
// Session-storage persistence for processing history
// ---------------------------------------------------------------------------

const HISTORY_STORAGE_KEY = 'ocr_history';

interface StoredHistoryItem {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  processedAt: string; // ISO string
  fieldsExtracted: number;
  fileBase64: string;  // data URL — doubles as previewUrl on restore
  extractedData: TableRow[];
  totalPages: number;
  processingDuration: number;
  /** Optional — entries written before this field existed won't carry it. */
  rawContent?: RawContent;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function saveHistoryToStorage(items: StoredHistoryItem[]): void {
  try {
    sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage quota exceeded — skip silently
  }
}

function loadHistoryFromStorage(): StoredHistoryItem[] {
  try {
    const raw = sessionStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredHistoryItem[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferType(key: string, val: unknown): ExtractedData["type"] {
  const k = key.toLowerCase();
  if (k.includes("date") || k.includes("dob")) return "date";
  if (
    k.includes("amount") || k.includes("total") || k.includes("price") ||
    k.includes("cost") || k.includes("fee") || k.includes("balance") ||
    k.includes("subtotal") || k.includes("tax")
  ) return "currency";
  if (typeof val === "number") return "number";
  return "text";
}

function titleCase(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Recursively build table rows, emitting section headers for objects/arrays
// and indented data rows for their leaf values.
function buildTableRows(
  obj: Record<string, unknown>,
  confidence: number,
  counter: { id: number },
  depth = 0
): TableRow[] {
  const rows: TableRow[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const label = titleCase(key);
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      if (val.every((item) => typeof item !== "object" || item === null)) {
        // Array of primitives → single joined cell
        rows.push({ kind: "data", id: counter.id++, field: label, value: (val as unknown[]).map(String).join(", "), confidence, type: inferType(key, val[0]), depth });
      } else {
        // Array of objects → one section header per item
        (val as unknown[]).forEach((item, idx) => {
          rows.push({ kind: "section", label: `${label} [${idx + 1}]`, depth });
          if (typeof item === "object" && item !== null) {
            rows.push(...buildTableRows(item as Record<string, unknown>, confidence, counter, depth + 1));
          } else {
            rows.push({ kind: "data", id: counter.id++, field: `${label} ${idx + 1}`, value: String(item ?? ""), confidence, type: "text", depth: depth + 1 });
          }
        });
      }
    } else if (typeof val === "object" && val !== null) {
      rows.push({ kind: "section", label, depth });
      rows.push(...buildTableRows(val as Record<string, unknown>, confidence, counter, depth + 1));
    } else {
      rows.push({ kind: "data", id: counter.id++, field: label, value: String(val ?? ""), confidence, type: inferType(key, val), depth });
    }
  }
  return rows;
}

function transformOCRResult(content: {
  total_pages: number;
  pages: Array<{ extracted_data: Record<string, unknown> }>;
}): { data: TableRow[]; totalPages: number } {
  const counter = { id: 1 };
  const data = content.pages.flatMap((page) => {
    const { confidence_score, ...fields } = page.extracted_data;
    const confidence = Math.round(((confidence_score as number) ?? 0.9) * 100);
    return buildTableRows(fields, confidence, counter);
  });
  return { data, totalPages: content.total_pages };
}

// ---------------------------------------------------------------------------
// Raw OCR content types + line item extractor for validation
// ---------------------------------------------------------------------------

// RawContent is defined alongside HistoryItem — history persists it so a
// restored document can still be validated.

// Column signatures used to tell a line-item table apart from a tax /
// GST-summary table. Only arrays that look like product line items should be
// sent for validation — tax tables (which have no EAN) must be ignored.
const PRODUCT_KEY_HINTS = [
  "ean", "barcode", "product", "description", "desc",
  "sku", "plu", "itemname", "item", "particulars",
  // line-item-only columns tax/GST-summary tables don't carry — extra signals
  // so a product table is still recognised even if its name column is unusual
  "mrp", "qty", "quantity", "uom", "unitprice", "packsize", "batch",
];
const TAX_KEY_HINTS = [
  "taxrate", "taxpercent", "taxpct", "taxablevalue", "taxableamount",
  "taxamount", "cgst", "sgst", "igst", "utgst", "cess", "gstrate", "gstamount",
];
const TAX_FIELD_NAME_RE = /(^|[_\s])(tax|gst|hsn[_\s]?summary|tax[_\s]?summary|tax[_\s]?detail|taxes)/i;

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

// Union of (normalised) column names across all rows in an array.
function rowKeySet(rows: Record<string, unknown>[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === "object") {
      for (const k of Object.keys(row)) keys.add(normKey(k));
    }
  }
  return keys;
}

const hasProductSignal = (keys: Set<string>) =>
  [...keys].some((k) => PRODUCT_KEY_HINTS.some((p) => k.includes(p)));

const looksLikeTax = (fieldKey: string, keys: Set<string>) => {
  const taxHits = [...keys].filter((k) => TAX_KEY_HINTS.some((t) => k.includes(t))).length;
  return !hasProductSignal(keys) && (TAX_FIELD_NAME_RE.test(fieldKey) || taxHits >= 2);
};

function extractLineItems(content: RawContent): Record<string, unknown>[] {
  // Collect every array-of-objects field, classified by its column signature.
  const productArrays: Record<string, unknown>[][] = [];
  const otherArrays: Record<string, unknown>[][] = []; // non-product, non-tax fallback

  for (const page of content.pages) {
    for (const [key, val] of Object.entries(page.extracted_data)) {
      if (key === "confidence_score") continue;
      if (
        Array.isArray(val) &&
        val.length > 0 &&
        typeof val[0] === "object" &&
        val[0] !== null
      ) {
        const rows = val as Record<string, unknown>[];
        const keys = rowKeySet(rows);
        if (looksLikeTax(key, keys)) continue; // drop tax / GST-summary tables
        if (hasProductSignal(keys)) productArrays.push(rows);
        else otherArrays.push(rows);
      }
    }
  }

  // Prefer arrays that clearly look like line items; only fall back to
  // ambiguous (but non-tax) arrays if no product table was identified.
  const chosen = productArrays.length > 0 ? productArrays : otherArrays;
  return chosen.flat();
}

// Extract scalar fields (strings/numbers) from the OCR output — used to find
// the invoice grand total for calculation validation.
//
// Gemini names every key itself, so totals land at the top level on some
// documents and nested under a "totals" / "invoice_summary" object on others.
// The walk is breadth-first with first-writer-wins, so a shallower field always
// takes precedence over a deeper one sharing its name. Arrays are skipped —
// those are line-item tables, handled by extractLineItems.
// Across pages the *last* page wins, since on a multi-page invoice the closing
// page carries the real grand total while earlier pages carry carry-forward
// subtotals under the same key names.
const MAX_SCALAR_DEPTH = 4;

function scalarsForPage(root: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Each level's objects are drained before descending into the next.
  let level: Record<string, unknown>[] = [root];

  for (let depth = 0; depth < MAX_SCALAR_DEPTH && level.length > 0; depth++) {
    const next: Record<string, unknown>[] = [];
    for (const obj of level) {
      for (const [key, val] of Object.entries(obj)) {
        if (key === "confidence_score") continue;
        if (Array.isArray(val)) continue;
        if (typeof val === "number" || typeof val === "string") {
          if (!(key in out)) out[key] = val; // shallower wins
        } else if (typeof val === "object" && val !== null) {
          next.push(val as Record<string, unknown>);
        }
      }
    }
    level = next;
  }
  return out;
}

function extractDocumentScalars(content: RawContent): Record<string, unknown> {
  const scalars: Record<string, unknown> = {};
  for (const page of content.pages) {
    Object.assign(scalars, scalarsForPage(page.extracted_data));
  }
  return scalars;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const Index = () => {
  const { user, token, credits, setCredits, refreshCredits } = useAuth();

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [processingState, setProcessingState] = useState<"idle" | "processing" | "completed">("idle");
  const [extractedData, setExtractedData] = useState<TableRow[]>([]);
  const [extractedDataByFile, setExtractedDataByFile] = useState<Record<number, TableRow[]>>({});
  const [pageCountByFile, setPageCountByFile] = useState<Record<number, number>>({});
  const [fileStatuses, setFileStatuses] = useState<Record<number, FileStatus>>({});
  const [completedCount, setCompletedCount] = useState(0);
  const [totalToProcess, setTotalToProcess] = useState(0);
  const [activeTab, setActiveTab] = useState<"preview" | "data">("preview");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("batch");
  const [showHistory, setShowHistory] = useState(true);
  const [previewMode, setPreviewMode] = useState<"single" | "grid">("single");
  const [lastRunCreditsUsed, setLastRunCreditsUsed] = useState<number | null>(null);
  const [rawContentByFile, setRawContentByFile] = useState<Record<number, RawContent>>({});
  const [dataTab, setDataTab] = useState<"extracted" | "validation">("extracted");
  const [validationState, setValidationState] = useState<"idle" | "validating" | "done">("idle");
  const [validationByFile, setValidationByFile] = useState<Record<number, ValidatedItem[]>>({});
  const [dataPanelFullscreen, setDataPanelFullscreen] = useState(false);
  // Duplicate detection — populated on file select, before Extract is usable
  const [duplicateInfo, setDuplicateInfo] = useState<Map<File, DuplicateEntry>>(new Map());
  const [pendingDuplicates, setPendingDuplicates] = useState<DuplicateFile[]>([]);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [duplicateCheckState, setDuplicateCheckState] = useState<"idle" | "checking">("idle");
  const [duplicateLookbackDays, setDuplicateLookbackDays] = useState(120);
  const [duplicateDialogMode, setDuplicateDialogMode] = useState<DuplicateDialogMode>("select");
  /** Files in the dialog's scope that aren't duplicates — shown as context. */
  const [duplicateOtherCount, setDuplicateOtherCount] = useState(0);
  /** Set once the user confirms a re-extract, so the run starts after the
   *  removals have been committed to state. */
  const [pendingExtract, setPendingExtract] = useState(false);
  /** SHA-256 per staged file — not rendered, so a ref rather than state. */
  const fileHashesRef = useRef<Map<File, string>>(new Map());
  /** Live mirror of selectedFiles, readable from async callbacks. */
  const selectionRef = useRef<File[]>([]);
  /** Preview URL per file, so previewUrls can be rebuilt from the selection. */
  const fileUrlsRef = useRef<Map<File, string>>(new Map());
  /** Mirror of history, read when deciding whether a URL is safe to revoke. */
  const historyRef = useRef<HistoryItem[]>([]);
  /**
   * Files already extracted in this session. The server row only lands after a
   * run finishes, so a second Extract on the same staged file (via Re-process,
   * or just clicking Extract twice) would otherwise spend credits unwarned.
   */
  const sessionProcessedRef = useRef<Map<File, { at: Date; pages: number }>>(new Map());

  // Ref that mirrors history in sessionStorage (serialisable format)
  const storedItemsRef = useRef<StoredHistoryItem[]>(loadHistoryFromStorage());

  // Restore history from sessionStorage on mount
  useEffect(() => {
    const stored = storedItemsRef.current;
    if (stored.length === 0) return;
    const restore = async () => {
      const items: HistoryItem[] = await Promise.all(
        stored.map(async (s) => {
          const res = await fetch(s.fileBase64);
          const blob = await res.blob();
          const file = new File([blob], s.fileName, { type: s.fileType });
          return {
            id: s.id,
            fileName: s.fileName,
            fileType: s.fileType,
            fileSize: s.fileSize,
            processedAt: new Date(s.processedAt),
            fieldsExtracted: s.fieldsExtracted,
            previewUrl: s.fileBase64,
            file,
            extractedData: s.extractedData,
            totalPages: s.totalPages,
            processingDuration: s.processingDuration,
            rawContent: s.rawContent,
          };
        })
      );
      setHistory(items);
    };
    restore();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const currentFile = selectedFiles[activeFileIndex] || null;
  const currentPreviewUrl = previewUrls[activeFileIndex] || null;

  /**
   * The selection is mirrored in refs so async callbacks (the duplicate check
   * resolves well after the files were staged) can mutate it without reading a
   * stale render closure. previewUrls is always derived from selectedFiles, so
   * the two arrays can never drift out of alignment.
   */
  /**
   * Object URL for a staged file, created on first use and cached. Creating on
   * demand means a file whose URL was released earlier still renders when it
   * comes back into the selection, instead of falling back to an empty src.
   */
  const getPreviewUrl = useCallback((file: File): string => {
    let url = fileUrlsRef.current.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      fileUrlsRef.current.set(file, url);
    }
    return url;
  }, []);

  /**
   * Drop a file's object URL — unless a history entry still points at that
   * File. Revoking one of those leaves the history item with a dead URL and a
   * blank preview when it's reopened.
   */
  const releasePreviewUrl = useCallback((file: File) => {
    const url = fileUrlsRef.current.get(file);
    fileUrlsRef.current.delete(file);
    if (!url || !url.startsWith("blob:")) return;
    if (historyRef.current.some((item) => item.file === file)) return;
    URL.revokeObjectURL(url);
  }, []);

  const applySelection = useCallback((files: File[]) => {
    selectionRef.current = files;
    setSelectedFiles(files);
    setPreviewUrls(files.map((file) => getPreviewUrl(file)));
  }, [getPreviewUrl]);

  /** Drop a set of files from the selection, keeping the active preview put. */
  const removeFiles = useCallback((toRemove: File[]) => {
    if (toRemove.length === 0) return;
    const removeSet = new Set(toRemove);
    const previous = selectionRef.current;
    const kept = previous.filter((file) => !removeSet.has(file));
    if (kept.length === previous.length) return;

    removeSet.forEach((file) => {
      releasePreviewUrl(file);
      fileHashesRef.current.delete(file);
      sessionProcessedRef.current.delete(file);
    });

    setActiveFileIndex((prev) => {
      const removedBefore = previous.slice(0, prev).filter((f) => removeSet.has(f)).length;
      return Math.max(0, Math.min(prev - removedBefore, kept.length - 1));
    });
    setDuplicateInfo((prev) => {
      const next = new Map(prev);
      removeSet.forEach((file) => next.delete(file));
      return next;
    });
    applySelection(kept);
  }, [applySelection, releasePreviewUrl]);

  /**
   * Fingerprint newly staged files and ask the backend whether this company has
   * processed them before. Runs on select — never on Extract — so the user has
   * already decided about every duplicate by the time they can start a run.
   */
  const runDuplicateCheck = useCallback(async (files: File[]) => {
    if (!token || files.length === 0 || !isHashingSupported()) return;

    setDuplicateCheckState("checking");
    try {
      const hashes = await hashFiles(files);

      // The same bytes staged twice in one selection — drop the extra copies
      // locally rather than warning about a file the user can already see.
      const staged = new Set(fileHashesRef.current.values());
      const inSelectionRepeats: File[] = [];
      const fresh: File[] = [];
      for (const file of files) {
        const hash = hashes.get(file);
        if (!hash) continue;  // unreadable — leave it alone, it just isn't checked
        if (staged.has(hash)) {
          inSelectionRepeats.push(file);
          continue;
        }
        staged.add(hash);
        fileHashesRef.current.set(file, hash);
        fresh.push(file);
      }

      if (inSelectionRepeats.length > 0) {
        removeFiles(inSelectionRepeats);
        toast.info(
          inSelectionRepeats.length === 1
            ? "That file is already selected — the extra copy was dropped, the original is untouched."
            : `${inSelectionRepeats.length} files were already selected — the extra copies were dropped, the originals are untouched.`
        );
      }

      if (fresh.length === 0) return;

      const response = await checkDuplicates(
        fresh.map((file) => ({
          filename: file.name,
          sha256: fileHashesRef.current.get(file) as string,
          size: file.size,
        })),
        token,
      );
      setDuplicateLookbackDays(response.lookback_days);

      const byHash = new Map(response.duplicates.map((entry) => [entry.file_hash, entry]));
      const found: DuplicateFile[] = [];
      for (const file of fresh) {
        const entry = byHash.get(fileHashesRef.current.get(file) as string);
        if (entry) found.push({ file, info: entry });
      }
      if (found.length === 0) return;

      setDuplicateInfo((prev) => {
        const next = new Map(prev);
        found.forEach(({ file, info }) => next.set(file, info));
        return next;
      });
      setPendingDuplicates(found);
      setDuplicateOtherCount(Math.max(0, selectionRef.current.length - found.length));
      setDuplicateDialogMode("select");
      setDuplicateDialogOpen(true);
      track("duplicate_prompt_shown", {
        duplicate_count: found.length,
        batch_size: fresh.length,
        trigger: "select",
      });
    } catch (error) {
      // A failed check must never block extraction, but it shouldn't vanish
      // without trace either — a 404 here means the backend predates the
      // /v1/duplicate-check route and needs a restart.
      console.warn("[duplicate-check] skipped:", error);
    } finally {
      setDuplicateCheckState("idle");
    }
  }, [token, removeFiles]);

  const handleFilesSelect = useCallback((files: File[]) => {
    applySelection([...selectionRef.current, ...files]);
    // Files are appended, so existing indices are untouched — keep the results
    // and status badges of anything already extracted rather than making it
    // look unprocessed (and inviting a second paid run).
    setProcessingState("idle");
    setCompletedCount(0);
    setSelectedHistoryId(null);
    void runDuplicateCheck(files);
  }, [applySelection, runDuplicateCheck]);

  const handleRemoveFile = useCallback((index: number) => {
    const file = selectionRef.current[index];
    if (file) removeFiles([file]);
  }, [removeFiles]);

  /** Apply the user's choices from the duplicate dialog. */
  const handleDuplicateResolve = useCallback((filesToRemove: File[]) => {
    const keptCount = pendingDuplicates.length - filesToRemove.length;
    const remaining = selectionRef.current.length - filesToRemove.length;
    if (filesToRemove.length > 0) {
      removeFiles(filesToRemove);
      track("duplicate_skipped", { count: filesToRemove.length, mode: duplicateDialogMode });
    }
    if (keptCount > 0) {
      track("duplicate_proceeded", { count: keptCount, mode: duplicateDialogMode });
    }
    setDuplicateDialogOpen(false);
    setPendingDuplicates([]);
    // Confirming an extract-time warning starts the run. It's deferred to an
    // effect so the removals above are committed before handleExtract reads
    // the selection.
    if (duplicateDialogMode === "extract" && remaining > 0) {
      setPendingExtract(true);
    }
  }, [pendingDuplicates, removeFiles, duplicateDialogMode]);

  /** Backed out of the dialog — nothing removed, and no run started. */
  const handleDuplicateDismiss = useCallback(() => {
    track("duplicate_proceeded", {
      count: pendingDuplicates.length,
      dismissed: true,
      mode: duplicateDialogMode,
    });
    setDuplicateDialogOpen(false);
    setPendingDuplicates([]);
  }, [pendingDuplicates, duplicateDialogMode]);

  const handleClearFiles = () => {
    selectionRef.current.forEach(releasePreviewUrl);
    fileUrlsRef.current.clear();
    fileHashesRef.current.clear();
    sessionProcessedRef.current.clear();
    setDuplicateInfo(new Map());
    setPendingDuplicates([]);
    setDuplicateDialogOpen(false);
    applySelection([]);
    setActiveFileIndex(0);
    setProcessingState("idle");
    setExtractedData([]);
    setFileStatuses({});
    setCompletedCount(0);
    setTotalToProcess(0);
    setExtractedDataByFile({});
    setPageCountByFile({});
    setSelectedHistoryId(null);
    setRawContentByFile({});
    setValidationByFile({});
    setValidationState("idle");

    setDataTab("extracted");
  };

  const handleHistorySelect = (item: HistoryItem) => {
    // Restored history replaces the selection outright — reset the duplicate
    // state with it, since those warnings belong to the files being dropped.
    fileHashesRef.current.clear();
    sessionProcessedRef.current.clear();
    setDuplicateInfo(new Map());
    setPendingDuplicates([]);
    setDuplicateDialogOpen(false);
    // item.previewUrl is the blob URL from when the file was first staged, and
    // it may since have been revoked. Drop the mapping so applySelection mints
    // a fresh one from the File — restoring history must always show the doc.
    fileUrlsRef.current.delete(item.file);
    applySelection([item.file]);
    setActiveFileIndex(0);
    setProcessingState("completed");
    setCompletedCount(1);
    setTotalToProcess(1);
    setFileStatuses({ 0: "completed" });
    setExtractedData(item.extractedData);
    setExtractedDataByFile({ 0: item.extractedData });
    setPageCountByFile({ 0: item.totalPages });
    setSelectedHistoryId(item.id);
    setActiveTab("data");
    // Restoring the raw payload is what keeps Validate (and with it the grand
    // total check) available on a document reopened from history.
    setRawContentByFile(item.rawContent ? { 0: item.rawContent } : {});
    setValidationByFile({});
    setValidationState("idle");

    setDataTab("extracted");
  };

  const handleHistoryDelete = (id: string) => {
    setHistory((prev) => prev.filter((item) => item.id !== id));
    storedItemsRef.current = storedItemsRef.current.filter((s) => s.id !== id);
    saveHistoryToStorage(storedItemsRef.current);
    if (selectedHistoryId === id) {
      handleClearFiles();
    }
  };

  const handleHistoryClear = () => {
    history.forEach((item) => {
      // Skip files still staged — their preview is on screen right now.
      if (selectionRef.current.includes(item.file)) return;
      if (item.previewUrl.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
      fileUrlsRef.current.delete(item.file);
    });
    setHistory([]);
    storedItemsRef.current = [];
    saveHistoryToStorage([]);
    if (selectedHistoryId) {
      handleClearFiles();
    }
  };

  /**
   * Describe a file already extracted in this session as a duplicate entry, so
   * the same dialog can present it. Merges in the server-side history when the
   * file was also processed on an earlier day.
   */
  const buildSessionEntry = useCallback((file: File): DuplicateEntry => {
    const server = duplicateInfo.get(file);
    const session = sessionProcessedRef.current.get(file);
    const at = (session?.at ?? new Date()).toISOString();
    return {
      file_hash: fileHashesRef.current.get(file) ?? "",
      count: (server?.count ?? 0) + 1,
      first_seen_at: server?.first_seen_at ?? at,
      last_seen_at: at,
      last_filename: file.name,
      last_user: user?.username ?? null,
      first_user: server?.first_user ?? user?.username ?? null,
      page_count: session?.pages ?? server?.page_count ?? null,
    };
  }, [duplicateInfo, user]);

  const handleExtract = useCallback(async (options?: { skipDuplicateGuard?: boolean }) => {
    if (selectionRef.current.length === 0 || !token) return;

    const selection = selectionRef.current;
    const filesToProcess = processingMode === "single" ? 1 : selection.length;
    const startIndex = processingMode === "single" ? activeFileIndex : 0;
    const filesToSend = selection.slice(startIndex, startIndex + filesToProcess);

    // Block if company has zero credits (1 credit per document is charged
    // after the run, once we know which files succeeded)
    if (credits !== null && credits < 1) {
      alert("No credits remaining. Please contact support to top up your balance.");
      return;
    }

    // Re-extracting a file already processed in this session costs another
    // credit and yields the same data — confirm before spending it. The server
    // row for this run doesn't exist yet, so this check has to be local.
    if (!options?.skipDuplicateGuard) {
      const repeats = filesToSend.filter((file) => sessionProcessedRef.current.has(file));
      if (repeats.length > 0) {
        setPendingDuplicates(repeats.map((file) => ({ file, info: buildSessionEntry(file) })));
        setDuplicateOtherCount(Math.max(0, filesToSend.length - repeats.length));
        setDuplicateDialogMode("extract");
        setDuplicateDialogOpen(true);
        track("duplicate_prompt_shown", {
          duplicate_count: repeats.length,
          batch_size: filesToSend.length,
          trigger: "extract",
        });
        return;
      }
    }

    // Build FormData
    const formData = new FormData();
    filesToSend.forEach((file) => formData.append("files", file));

    // Mark all as processing
    const initialStatuses: Record<number, FileStatus> = {};
    for (let i = 0; i < filesToProcess; i++) {
      initialStatuses[startIndex + i] = "processing";
    }
    setFileStatuses(initialStatuses);
    setProcessingState("processing");
    setCompletedCount(0);
    setTotalToProcess(filesToProcess);
    setExtractedDataByFile({});
    setExtractedData([]);
    setLastRunCreditsUsed(null);
    setActiveTab("data");

    const batchStart = Date.now();

    try {
      const dataByFile: Record<number, TableRow[]> = {};
      const pagesByFile: Record<number, number> = {};
      const rawByFile: Record<number, RawContent> = {};
      let doneCount = 0;
      let buffer = "";

      const processLine = (trimmed: string) => {
        if (!trimmed) return;
        try {
          const result = JSON.parse(trimmed);

          // Skip ping; handle run_summary for credit updates
          if (result.type === "ping") return;
          if (result.type === "run_summary") {
            if (typeof result.credits_used === "number") {
              setLastRunCreditsUsed(result.credits_used);
            }
            if (typeof result.remaining_credits === "number") {
              setCredits(result.remaining_credits);
            } else {
              // fallback: fetch from API if backend didn't include it
              refreshCredits();
            }
            return;
          }

          const fileIndex = filesToSend.findIndex((f) => f.name === result.filename);
          const absoluteIndex = fileIndex === -1 ? startIndex + doneCount : startIndex + fileIndex;

          if (result.status === "success") {
            const { data, totalPages } = transformOCRResult(result.content);
            const succeeded = fileIndex === -1 ? filesToSend[doneCount] : filesToSend[fileIndex];
            if (succeeded) {
              sessionProcessedRef.current.set(succeeded, { at: new Date(), pages: totalPages });
            }
            dataByFile[absoluteIndex] = data;
            pagesByFile[absoluteIndex] = totalPages;
            rawByFile[absoluteIndex] = result.content as RawContent;
            setFileStatuses((prev) => ({ ...prev, [absoluteIndex]: "completed" }));
            setExtractedDataByFile((prev) => ({ ...prev, [absoluteIndex]: data }));
            setPageCountByFile((prev) => ({ ...prev, [absoluteIndex]: totalPages }));
            setRawContentByFile((prev) => ({ ...prev, [absoluteIndex]: result.content as RawContent }));
            if (absoluteIndex === activeFileIndex) {
              setExtractedData(data);
            }
          } else {
            dataByFile[absoluteIndex] = [];
            setFileStatuses((prev) => ({ ...prev, [absoluteIndex]: "error" }));
          }

          doneCount += 1;
          setCompletedCount(doneCount);
        } catch {
          // malformed line — skip
        }
      };

      const res = await fetch(`${api.defaults.baseURL}/v1/process-invoice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok || !res.body) {
        const errorStatuses: Record<number, FileStatus> = {};
        for (let i = 0; i < filesToProcess; i++) errorStatuses[startIndex + i] = "error";
        setFileStatuses(errorStatuses);
        setProcessingState("completed");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            processLine(trimmed);
            await new Promise(r => requestAnimationFrame(r));
          }
        }
      }

      // Flush any remaining buffered line
      processLine(buffer.trim());

      setProcessingState("completed");

      if (!selectedHistoryId) {
        const batchDuration = Date.now() - batchStart;
        const newHistoryItems: HistoryItem[] = filesToSend.map((file, idx) => {
          const absIdx = startIndex + idx;
          const data = dataByFile[absIdx] ?? [];
          return {
            id: crypto.randomUUID(),
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            processedAt: new Date(),
            fieldsExtracted: data.filter(r => r.kind === "data").length,
            previewUrl: previewUrls[absIdx],
            file,
            extractedData: data,
            totalPages: pagesByFile[absIdx] ?? 1,
            processingDuration: batchDuration,
            rawContent: rawByFile[absIdx],
          };
        });
        setHistory((prev) => [...newHistoryItems, ...prev]);
        if (newHistoryItems.length > 0) {
          setSelectedHistoryId(newHistoryItems[0].id);
        }

        // Persist to sessionStorage (async file → base64 conversion)
        const newStoredItems = await Promise.all(
          newHistoryItems.map(async (item) => {
            const fileBase64 = await fileToBase64(item.file);
            return {
              id: item.id,
              fileName: item.fileName,
              fileType: item.fileType,
              fileSize: item.fileSize,
              processedAt: item.processedAt.toISOString(),
              fieldsExtracted: item.fieldsExtracted,
              fileBase64,
              extractedData: item.extractedData,
              totalPages: item.totalPages,
              processingDuration: item.processingDuration,
              rawContent: item.rawContent,
            } satisfies StoredHistoryItem;
          })
        );
        storedItemsRef.current = [...newStoredItems, ...storedItemsRef.current];
        saveHistoryToStorage(storedItemsRef.current);
      }
    } catch {
      const errorStatuses: Record<number, FileStatus> = {};
      for (let i = 0; i < filesToProcess; i++) errorStatuses[startIndex + i] = "error";
      setFileStatuses(errorStatuses);
      setProcessingState("completed");
    }
  }, [previewUrls, token, credits, setCredits, refreshCredits, processingMode, activeFileIndex, selectedHistoryId, buildSessionEntry]);

  const handleValidate = useCallback(async () => {
    if (!token) return;
    const content = rawContentByFile[activeFileIndex];
    if (!content) return;
    const items = extractLineItems(content);
    if (items.length === 0) return;

    setValidationState("validating");
    setDataTab("validation");
    try {
      const { validated_items } = await validateItems(items, token, currentFile?.name);
      setValidationByFile((prev) => ({ ...prev, [activeFileIndex]: validated_items }));
      setValidationState("done");
    } catch {
      setValidationState("idle");
      setDataTab("extracted");
    }
  }, [token, rawContentByFile, activeFileIndex, currentFile]);

  // Update extracted data when switching files
  useEffect(() => {
    if (extractedDataByFile[activeFileIndex]) {
      setExtractedData(extractedDataByFile[activeFileIndex]);
    } else {
      setExtractedData([]);
    }
  }, [activeFileIndex, extractedDataByFile]);

  // Auto-switch away from validation tab if the new file has no results
  useEffect(() => {
    if (dataTab === "validation" && !validationByFile[activeFileIndex]) {
      setDataTab("extracted");
    }
  }, [activeFileIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close fullscreen data panel on Escape
  useEffect(() => {
    if (!dataPanelFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDataPanelFullscreen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [dataPanelFullscreen]);

  // Cleanup preview URLs on unmount — use refs so the closure always sees
  // the latest values and doesn't fire on every state change.
  const previewUrlsRef = useRef(previewUrls);
  previewUrlsRef.current = previewUrls;
  historyRef.current = history;
  const selectedHistoryIdRef = useRef(selectedHistoryId);
  selectedHistoryIdRef.current = selectedHistoryId;

  useEffect(() => {
    return () => {
      if (!selectedHistoryIdRef.current) {
        previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Runs the extraction the user confirmed in an extract-mode dialog, after
  // the render that applied their removals.
  useEffect(() => {
    if (!pendingExtract) return;
    setPendingExtract(false);
    void handleExtract({ skipDuplicateGuard: true });
  }, [pendingExtract, handleExtract]);

  const hasFiles = selectedFiles.length > 0;
  const duplicateCounts = useMemo(() => {
    const counts = new Map<File, number>();
    duplicateInfo.forEach((info, file) => counts.set(file, info.count));
    return counts;
  }, [duplicateInfo]);

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <DuplicateWarningDialog
        open={duplicateDialogOpen}
        mode={duplicateDialogMode}
        duplicates={pendingDuplicates}
        otherFileCount={duplicateOtherCount}
        lookbackDays={duplicateLookbackDays}
        onResolve={handleDuplicateResolve}
        onDismiss={handleDuplicateDismiss}
      />

      <main className="container mx-auto px-4 py-6">
        <div className="flex gap-6">
          {/* History Sidebar */}
          <div
            className={`hidden lg:block transition-all duration-300 ${
              showHistory ? "w-72 shrink-0" : "w-0"
            }`}
          >
            {showHistory && (
              <div className="bg-card rounded-xl border border-border p-4 h-[calc(100vh-180px)] sticky top-6">
                <ProcessingHistory
                  history={history}
                  selectedId={selectedHistoryId}
                  onSelect={handleHistorySelect}
                  onDelete={handleHistoryDelete}
                  onClear={handleHistoryClear}
                />
              </div>
            )}
          </div>

          {/* Main Content */}
          <div className="flex-1 min-w-0">
            {/* History Toggle (Desktop) */}
            <div className="hidden lg:flex items-center gap-2 mb-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowHistory(!showHistory)}
                className="gap-2"
              >
                {showHistory ? (
                  <>
                    <PanelLeftClose className="w-4 h-4" />
                    Hide History
                  </>
                ) : (
                  <>
                    <PanelLeft className="w-4 h-4" />
                    Show History
                  </>
                )}
              </Button>
              {!showHistory && history.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  {history.length} document{history.length !== 1 ? "s" : ""} processed
                </span>
              )}
            </div>

            {/* Upload Section */}
            <div className="mb-6">
              <FileUpload
                onFilesSelect={handleFilesSelect}
                selectedFiles={selectedFiles}
                onClear={handleClearFiles}
                onRemoveFile={handleRemoveFile}
                fileStatuses={fileStatuses}
                duplicateCounts={duplicateCounts}
              />
            </div>

            {/* Mobile History Button */}
            {history.length > 0 && (
              <div className="lg:hidden mb-4">
                <Button variant="outline" className="w-full gap-2">
                  <History className="w-4 h-4" />
                  View History ({history.length})
                </Button>
              </div>
            )}

            {/* Action Bar */}
            {hasFiles && (
              <div className="mb-6 flex flex-col gap-4 p-4 bg-card rounded-xl border border-border">
                {/* Overall Progress */}
                {processingState !== "idle" && totalToProcess > 0 && (
                  <OverallProgress
                    completedCount={completedCount}
                    totalCount={totalToProcess}
                    isProcessing={processingState === "processing"}
                  />
                )}
                {/* Credits used summary */}
                {processingState === "completed" && lastRunCreditsUsed !== null && lastRunCreditsUsed > 0 && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground border-t border-border pt-3">
                    <Zap className="w-3.5 h-3.5 text-yellow-500" />
                    <span>
                      <span className="font-medium text-foreground">{lastRunCreditsUsed}</span> credit{lastRunCreditsUsed !== 1 ? "s" : ""} used this run
                      <span className="ml-1 text-muted-foreground/70">(1 credit / invoice)</span>
                      {credits !== null && (
                        <span className="ml-2 text-muted-foreground">· {credits} remaining</span>
                      )}
                    </span>
                  </div>
                )}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    {processingState === "idle" && (
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-muted-foreground">Ready to process</p>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/70 px-2 py-0.5 bg-muted rounded-full">
                          <Zap className="w-3 h-3" />
                          1 credit / invoice
                        </span>
                      </div>
                    )}
                    {selectedFiles.length > 1 && processingState === "idle" && (
                      <ProcessingModeToggle
                        mode={processingMode}
                        onModeChange={setProcessingMode}
                        fileCount={selectedFiles.length}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    {processingState === "completed" && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setProcessingState("idle");
                          setExtractedData([]);
                          setExtractedDataByFile({});
                          setFileStatuses({});
                          setCompletedCount(0);
                          setTotalToProcess(0);
                          setRawContentByFile({});
                          setValidationByFile({});
                          setValidationState("idle");
                          setDataTab("extracted");
                        }}
                        className="gap-2 flex-1 sm:flex-none"
                      >
                        <RefreshCw className="w-4 h-4" />
                        Re-process
                      </Button>
                    )}
                    {processingState === "completed" && rawContentByFile[activeFileIndex] && (
                      <Button
                        variant="outline"
                        onClick={handleValidate}
                        disabled={validationState === "validating"}
                        className="gap-2 flex-1 sm:flex-none"
                      >
                        <ShieldCheck className="w-4 h-4" />
                        {validationState === "validating" ? "Validating..." : "Validate"}
                      </Button>
                    )}
                    <Button
                      onClick={() => handleExtract()}
                      disabled={
                        processingState === "processing" ||
                        duplicateCheckState === "checking" ||
                        (credits !== null && credits < 1)
                      }
                      title={
                        credits !== null && credits < 1
                          ? "No credits remaining"
                          : duplicateCheckState === "checking"
                          ? "Checking for files already processed"
                          : undefined
                      }
                      className="gap-2 flex-1 sm:flex-none"
                    >
                      <Sparkles className="w-4 h-4" />
                      {duplicateCheckState === "checking"
                        ? "Checking files..."
                        : processingMode === "single"
                        ? "Extract Current"
                        : `Extract All (${selectedFiles.length})`}
                    </Button>
                    <ExportButtons data={extractedData} disabled={!extractedData.some(r => r.kind === "data")} filename={currentFile?.name} />
                    <DownloadAllButton dataByFile={extractedDataByFile} files={selectedFiles} />
                  </div>
                </div>
              </div>
            )}

            {/* Split View */}
            {hasFiles && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:items-start">
                {/* Mobile Tab Switcher */}
                <div className="lg:hidden flex items-center gap-2 p-1 bg-muted rounded-lg">
                  <button
                    onClick={() => setActiveTab("preview")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                      activeTab === "preview"
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Eye className="w-4 h-4" />
                    Preview
                  </button>
                  <button
                    onClick={() => setActiveTab("data")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                      activeTab === "data"
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Table2 className="w-4 h-4" />
                    Data
                    {extractedData.some(r => r.kind === "data") && (
                      <span className="ml-1 px-1.5 py-0.5 bg-primary text-primary-foreground text-xs rounded-full">
                        {extractedData.filter(r => r.kind === "data").length}
                      </span>
                    )}
                  </button>
                </div>

                {/* Document Preview Panel */}
                <div
                  className={`bg-card rounded-xl border border-border p-4 h-[78vh] min-h-[560px] flex flex-col ${
                    activeTab !== "preview" ? "hidden lg:flex" : ""
                  }`}
                >
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Eye className="w-5 h-5 text-primary" />
                      Document Preview
                    </h2>
                    <div className="flex items-center gap-2">
                      {/* Grid/Single Toggle */}
                      {selectedFiles.length > 1 && (
                        <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
                          <button
                            onClick={() => setPreviewMode("single")}
                            className={`p-1.5 rounded-md transition-colors ${
                              previewMode === "single"
                                ? "bg-card text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                            title="Single view"
                          >
                            <FileTextIcon className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setPreviewMode("grid")}
                            className={`p-1.5 rounded-md transition-colors ${
                              previewMode === "grid"
                                ? "bg-card text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                            title="Grid view"
                          >
                            <LayoutGrid className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                      {/* File Navigation (single mode only) */}
                      {selectedFiles.length > 1 && previewMode === "single" && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setActiveFileIndex((prev) => Math.max(0, prev - 1))}
                            disabled={activeFileIndex === 0}
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </Button>
                          <span className="text-sm text-muted-foreground">
                            {activeFileIndex + 1} / {selectedFiles.length}
                          </span>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() =>
                              setActiveFileIndex((prev) =>
                                Math.min(selectedFiles.length - 1, prev + 1)
                              )
                            }
                            disabled={activeFileIndex === selectedFiles.length - 1}
                          >
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 flex flex-col">
                    {previewMode === "grid" && selectedFiles.length > 1 ? (
                      <DocumentGridView
                        files={selectedFiles}
                        previewUrls={previewUrls}
                        activeIndex={activeFileIndex}
                        onSelect={(index) => {
                          setActiveFileIndex(index);
                          setPreviewMode("single");
                        }}
                      />
                    ) : (
                      <DocumentPreview file={currentFile} previewUrl={currentPreviewUrl} totalPages={pageCountByFile[activeFileIndex] ?? 1} />
                    )}
                  </div>
                </div>

                {/* Data Panel (Extracted + Validation tabs) */}
                <div
                  className={
                    dataPanelFullscreen
                      ? "fixed inset-0 z-50 bg-card flex flex-col p-6 overflow-hidden"
                      : `bg-card rounded-xl border border-border p-4 min-h-[500px] ${
                          activeTab !== "data" ? "hidden lg:flex lg:flex-col" : "flex flex-col"
                        }`
                  }
                >
                  {/* Header: tab switcher + fullscreen toggle */}
                  <div className="flex items-center justify-between mb-4 shrink-0">
                    <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
                      <button
                        onClick={() => setDataTab("extracted")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          dataTab === "extracted"
                            ? "bg-card text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <Table2 className="w-4 h-4" />
                        Extracted Data
                        {extractedData.some((r) => r.kind === "data") && (
                          <span className="ml-1 px-1.5 py-0.5 bg-primary/10 text-primary text-xs rounded-full">
                            {extractedData.filter((r) => r.kind === "data").length}
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => setDataTab("validation")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          dataTab === "validation"
                            ? "bg-card text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <ShieldCheck className="w-4 h-4" />
                        Validation
                        {(validationByFile[activeFileIndex]?.length ?? 0) > 0 && (
                          <span className="ml-1 px-1.5 py-0.5 bg-primary/10 text-primary text-xs rounded-full">
                            {validationByFile[activeFileIndex].length}
                          </span>
                        )}
                      </button>
                    </div>

                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setDataPanelFullscreen((f) => !f)}
                      title={dataPanelFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
                    >
                      {dataPanelFullscreen ? (
                        <Minimize2 className="w-4 h-4" />
                      ) : (
                        <Maximize2 className="w-4 h-4" />
                      )}
                    </Button>
                  </div>

                  {/* Tab content — both views stay mounted to preserve ValidationResults state */}
                  <div className={`overflow-auto ${dataPanelFullscreen ? "flex-1 min-h-0" : "max-h-[450px]"}`}>
                    {/* Extracted view */}
                    <div className={dataTab === "extracted" ? "" : "hidden"}>
                      {fileStatuses[activeFileIndex] === "processing" && !extractedDataByFile[activeFileIndex] ? (
                        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
                          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                          Extracting data...
                        </div>
                      ) : (
                        <DataTable data={extractedData} />
                      )}
                    </div>

                    {/* Validation view */}
                    <div className={dataTab === "validation" ? "" : "hidden"}>
                      {validationState === "validating" ? (
                        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
                          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                          Validating items against master data...
                        </div>
                      ) : validationByFile[activeFileIndex] ? (
                        <>
                          <ValidationResults
                            items={validationByFile[activeFileIndex]}
                            documentScalars={rawContentByFile[activeFileIndex] ? extractDocumentScalars(rawContentByFile[activeFileIndex]) : undefined}
                            sourceFilename={selectedFiles[activeFileIndex]?.name}
                          />
                        </>
                      ) : (
                        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                          <ShieldCheck className="w-10 h-10 mb-3 opacity-30" />
                          <p className="font-medium">Not validated yet</p>
                          <p className="text-sm mt-1">
                            Click "Validate" to check line items against master data.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Empty State */}
            {!hasFiles && (
              <div className="mt-12 text-center">
                <div className="max-w-md mx-auto">
                  <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
                    <Sparkles className="w-10 h-10 text-primary" />
                  </div>
                  <h2 className="text-2xl font-bold text-foreground mb-3">
                    Extract Text from Documents
                  </h2>
                  <p className="text-muted-foreground mb-6">
                    Upload images, scanned documents, or PDF files and our OCR engine will extract
                    all text into a structured, downloadable format.
                  </p>
                  <div className="flex flex-wrap justify-center gap-3">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-full text-sm text-muted-foreground">
                      <span className="w-2 h-2 bg-success rounded-full"></span>
                      High Accuracy
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-full text-sm text-muted-foreground">
                      <span className="w-2 h-2 bg-primary rounded-full"></span>
                      Multiple Files
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-full text-sm text-muted-foreground">
                      <span className="w-2 h-2 bg-accent rounded-full"></span>
                      Export Ready
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
