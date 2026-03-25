import { useState, useEffect, useCallback, useRef } from "react";
import api from "@/lib/api";
import Header from "@/components/Header";
import FileUpload from "@/components/FileUpload";
import DocumentPreview from "@/components/DocumentPreview";
import DataTable, { ExtractedData, TableRow } from "@/components/DataTable";
import ExportButtons from "@/components/ExportButtons";
import DownloadAllButton from "@/components/DownloadAllButton";
import ProcessingHistory, { HistoryItem } from "@/components/ProcessingHistory";
import ProcessingModeToggle, { ProcessingMode } from "@/components/ProcessingModeToggle";
import OverallProgress from "@/components/OverallProgress";
import { FileStatus } from "@/components/FileProcessingStatus";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Sparkles, RefreshCw, Table2, Eye, History, PanelLeftClose, PanelLeft, ChevronLeft, ChevronRight, LayoutGrid, FileText as FileTextIcon, Zap } from "lucide-react";
import DocumentGridView from "@/components/DocumentGridView";

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
// Component
// ---------------------------------------------------------------------------

const Index = () => {
  const { token, credits, setCredits, refreshCredits } = useAuth();

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
          };
        })
      );
      setHistory(items);
    };
    restore();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const currentFile = selectedFiles[activeFileIndex] || null;
  const currentPreviewUrl = previewUrls[activeFileIndex] || null;

  const handleFilesSelect = (files: File[]) => {
    const newUrls = files.map((file) => URL.createObjectURL(file));
    setSelectedFiles((prev) => [...prev, ...files]);
    setPreviewUrls((prev) => [...prev, ...newUrls]);
    setProcessingState("idle");
    setExtractedData([]);
    setFileStatuses({});
    setCompletedCount(0);
    setSelectedHistoryId(null);
  };

  const handleRemoveFile = (index: number) => {
    URL.revokeObjectURL(previewUrls[index]);
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviewUrls((prev) => prev.filter((_, i) => i !== index));
    if (activeFileIndex >= index && activeFileIndex > 0) {
      setActiveFileIndex(activeFileIndex - 1);
    }
  };

  const handleClearFiles = () => {
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    setSelectedFiles([]);
    setPreviewUrls([]);
    setActiveFileIndex(0);
    setProcessingState("idle");
    setExtractedData([]);
    setFileStatuses({});
    setCompletedCount(0);
    setTotalToProcess(0);
    setExtractedDataByFile({});
    setPageCountByFile({});
    setSelectedHistoryId(null);
  };

  const handleHistorySelect = (item: HistoryItem) => {
    setSelectedFiles([item.file]);
    setPreviewUrls([item.previewUrl]);
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
      URL.revokeObjectURL(item.previewUrl);
    });
    setHistory([]);
    storedItemsRef.current = [];
    saveHistoryToStorage([]);
    if (selectedHistoryId) {
      handleClearFiles();
    }
  };

  const handleExtract = useCallback(async () => {
    if (selectedFiles.length === 0 || !token) return;

    const filesToProcess = processingMode === "single" ? 1 : selectedFiles.length;
    const startIndex = processingMode === "single" ? activeFileIndex : 0;
    const filesToSend = selectedFiles.slice(startIndex, startIndex + filesToProcess);

    // Block if company has zero credits (exact page cost is unknown upfront)
    if (credits !== null && credits < 1) {
      alert("No credits remaining. Please contact support to top up your balance.");
      return;
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
            dataByFile[absoluteIndex] = data;
            pagesByFile[absoluteIndex] = totalPages;
            setFileStatuses((prev) => ({ ...prev, [absoluteIndex]: "completed" }));
            setExtractedDataByFile((prev) => ({ ...prev, [absoluteIndex]: data }));
            setPageCountByFile((prev) => ({ ...prev, [absoluteIndex]: totalPages }));
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
        lines.forEach((line) => processLine(line.trim()));
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
  }, [selectedFiles, previewUrls, token, credits, setCredits, refreshCredits, processingMode, activeFileIndex, selectedHistoryId]);

  // Update extracted data when switching files
  useEffect(() => {
    if (processingState === "completed" && extractedDataByFile[activeFileIndex]) {
      setExtractedData(extractedDataByFile[activeFileIndex]);
    }
  }, [activeFileIndex, processingState, extractedDataByFile]);

  // Cleanup preview URLs on unmount — use refs so the closure always sees
  // the latest values and doesn't fire on every state change.
  const previewUrlsRef = useRef(previewUrls);
  previewUrlsRef.current = previewUrls;
  const selectedHistoryIdRef = useRef(selectedHistoryId);
  selectedHistoryIdRef.current = selectedHistoryId;

  useEffect(() => {
    return () => {
      if (!selectedHistoryIdRef.current) {
        previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasFiles = selectedFiles.length > 0;

  return (
    <div className="min-h-screen bg-background">
      <Header />

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
                      {credits !== null && (
                        <span className="ml-2 text-muted-foreground">· {credits} remaining</span>
                      )}
                    </span>
                  </div>
                )}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    {processingState === "idle" && (
                      <p className="text-sm text-muted-foreground">Ready to process</p>
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
                        }}
                        className="gap-2 flex-1 sm:flex-none"
                      >
                        <RefreshCw className="w-4 h-4" />
                        Re-process
                      </Button>
                    )}
                    <Button
                      onClick={handleExtract}
                      disabled={processingState === "processing" || (credits !== null && credits < 1)}
                      title={credits !== null && credits < 1 ? "No credits remaining" : undefined}
                      className="gap-2 flex-1 sm:flex-none"
                    >
                      <Sparkles className="w-4 h-4" />
                      {processingMode === "single" ? "Extract Current" : `Extract All (${selectedFiles.length})`}
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

                {/* Extracted Data Panel */}
                <div
                  className={`bg-card rounded-xl border border-border p-4 min-h-[500px] ${
                    activeTab !== "data" ? "hidden lg:block" : ""
                  }`}
                >
                  <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                    <Table2 className="w-5 h-5 text-primary" />
                    Extracted Data
                    {extractedData.some(r => r.kind === "data") && (
                      <span className="ml-2 px-2 py-0.5 bg-primary/10 text-primary text-sm rounded-full">
                        {extractedData.filter(r => r.kind === "data").length} fields
                      </span>
                    )}
                  </h2>
                  <div className="overflow-auto max-h-[450px]">
                    <DataTable data={extractedData} />
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
