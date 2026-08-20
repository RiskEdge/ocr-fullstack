import { useEffect, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, X, Zap, FileText, Image as ImageIcon, File as FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { DuplicateEntry } from "@/lib/duplicateApi";

export interface DuplicateFile {
  file: File;
  info: DuplicateEntry;
}

/**
 * "select" — raised when files are staged: the user prunes the selection.
 * "extract" — raised when Extract would re-run a file already extracted in
 * this session: confirming starts the run, dismissing abandons it.
 */
export type DuplicateDialogMode = "select" | "extract";

interface Props {
  open: boolean;
  mode?: DuplicateDialogMode;
  /** Staged files this company has already processed. */
  duplicates: DuplicateFile[];
  /** Staged files this dialog isn't asking about — carried through untouched. */
  otherFileCount: number;
  lookbackDays: number;
  /** Called with the files the user chose to drop from the selection. */
  onResolve: (filesToRemove: File[]) => void;
  /** Dismissed without deciding — nothing is removed. */
  onDismiss: () => void;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown" : format(date, "d MMM yyyy, h:mm a");
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown" : format(date, "d MMM");
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(file: File) {
  if (file.type.startsWith("image/")) return <ImageIcon className="w-4 h-4" />;
  if (file.type === "application/pdf") return <FileText className="w-4 h-4" />;
  return <FileIcon className="w-4 h-4" />;
}

/** "3 times" / "once" — reads better than a bare number in the summary line. */
function timesLabel(count: number): string {
  if (count === 1) return "once";
  if (count === 2) return "twice";
  return `${count} times`;
}

const DuplicateWarningDialog = ({
  open,
  mode = "select",
  duplicates,
  otherFileCount,
  lookbackDays,
  onResolve,
  onDismiss,
}: Props) => {
  // Duplicates start unticked — skipping is the safe default, since the whole
  // point of the warning is to avoid spending credits twice on the same file.
  const [keptFiles, setKeptFiles] = useState<Set<File>>(new Set());

  useEffect(() => {
    setKeptFiles(new Set());
  }, [duplicates]);

  if (!open || duplicates.length === 0) return null;

  const toggle = (file: File) => {
    setKeptFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  const removeAllOf = (files: DuplicateFile[]) =>
    onResolve(files.map((d) => d.file));

  const lookbackLabel = `in the last ${Math.round(lookbackDays / 30)} months`;

  // ── Single duplicate ──────────────────────────────────────────────────────
  if (duplicates.length === 1) {
    const { file, info } = duplicates[0];
    const pages = info.page_count ?? 1;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onDismiss} />
        <div className="relative z-10 w-full max-w-md mx-4 bg-card rounded-xl border border-border shadow-xl p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-warning" />
              <h2 className="text-sm font-semibold text-foreground">
                {mode === "extract"
                  ? "You have already extracted this file"
                  : "This file has been processed before"}
              </h2>
            </div>
            <button
              onClick={onDismiss}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg border border-border">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-primary shrink-0">
              {fileIcon(file)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
              <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
            </div>
          </div>

          <p className="mt-4 text-sm text-foreground">
            {mode === "extract" ? (
              <>
                Extracting this again will not produce new data — it has already been
                processed <span className="font-medium">{timesLabel(info.count)}</span>{" "}
                {lookbackLabel}.
              </>
            ) : (
              <>
                Processed <span className="font-medium">{timesLabel(info.count)}</span> by
                your company {lookbackLabel}.
              </>
            )}
          </p>

          <dl className="mt-3 space-y-1.5 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Most recent</dt>
              <dd className="text-foreground text-right">
                {formatDateTime(info.last_seen_at)}
                {info.last_user && (
                  <span className="text-muted-foreground"> · {info.last_user}</span>
                )}
              </dd>
            </div>
            {info.count > 1 && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">First seen</dt>
                <dd className="text-foreground text-right">
                  {formatDateTime(info.first_seen_at)}
                  {info.first_user && (
                    <span className="text-muted-foreground"> · {info.first_user}</span>
                  )}
                </dd>
              </div>
            )}
            {info.last_filename !== file.name && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Uploaded then as</dt>
                <dd className="text-foreground text-right truncate max-w-[60%]">
                  {info.last_filename}
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Pages</dt>
              <dd className="text-foreground">{pages}</dd>
            </div>
          </dl>

          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground border-t border-border pt-3">
            <Zap className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
            <span>
              Extracting again will use{" "}
              <span className="font-medium text-foreground">1</span> more credit.
            </span>
          </div>

          <div className="mt-5 flex gap-2">
            <Button variant="outline" className="flex-1 text-sm" onClick={() => onResolve([file])}>
              Remove file
            </Button>
            <Button className="flex-1 text-sm" onClick={() => onResolve([])}>
              {mode === "extract" ? "Extract again" : "Extract anyway"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Batch ─────────────────────────────────────────────────────────────────
  const totalToProcess = otherFileCount + keptFiles.size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onDismiss} />
      <div className="relative z-10 w-full max-w-lg mx-4 bg-card rounded-xl border border-border shadow-xl p-6">
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <h2 className="text-sm font-semibold text-foreground">
              {duplicates.length} of {duplicates.length + otherFileCount} files have already
              been {mode === "extract" ? "extracted" : "processed"}
            </h2>
          </div>
          <button
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-2"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 mt-3 mb-2">
          <p className="text-xs text-muted-foreground">
            Tick a file to extract it again. Unticked files are removed{
              mode === "extract" ? " from this run" : ""}.
          </p>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setKeptFiles(new Set())}
            >
              Skip all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setKeptFiles(new Set(duplicates.map((d) => d.file)))}
            >
              Keep all
            </Button>
          </div>
        </div>

        <ScrollArea className="max-h-64 border-y border-border">
          <ul className="divide-y divide-border">
            {duplicates.map(({ file, info }, index) => {
              const kept = keptFiles.has(file);
              return (
                <li key={`${file.name}-${index}`}>
                  <label
                    className={cn(
                      "flex items-center gap-3 px-1 py-2.5 cursor-pointer transition-colors",
                      kept ? "bg-primary/5" : "hover:bg-muted/50",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={kept}
                      onChange={() => toggle(file)}
                      className="w-4 h-4 shrink-0 accent-primary cursor-pointer"
                    />
                    <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center text-primary shrink-0">
                      {fileIcon(file)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {info.count}× · last {formatDate(info.last_seen_at)}
                        {info.last_user ? ` · ${info.last_user}` : ""}
                        {info.page_count ? ` · ${info.page_count} page${info.page_count !== 1 ? "s" : ""}` : ""}
                      </p>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        </ScrollArea>

        <div className="mt-3 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">{otherFileCount}</span> other file
            {otherFileCount !== 1 ? "s" : ""}
            {keptFiles.size > 0 && (
              <>
                {" + "}
                <span className="font-medium text-foreground">{keptFiles.size}</span> duplicate
                {keptFiles.size !== 1 ? "s" : ""} kept
              </>
            )}
          </p>
          {keptFiles.size > 0 && (
            <p className="mt-1 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
              <span>
                The kept duplicate{keptFiles.size !== 1 ? "s" : ""} will cost{" "}
                <span className="font-medium text-foreground">{keptFiles.size}</span> more credit
                {keptFiles.size !== 1 ? "s" : ""} — 1 per document, whatever its page count.
              </span>
            </p>
          )}
        </div>

        <div className="mt-5 flex gap-2">
          <Button variant="outline" className="flex-1 text-sm" onClick={onDismiss}>
            Cancel
          </Button>
          <Button
            className="flex-1 text-sm"
            onClick={() => removeAllOf(duplicates.filter((d) => !keptFiles.has(d.file)))}
          >
            {totalToProcess === 0
              ? "Remove all files"
              : mode === "extract"
              ? `Extract ${totalToProcess} file${totalToProcess !== 1 ? "s" : ""}`
              : `Continue with ${totalToProcess} file${totalToProcess !== 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default DuplicateWarningDialog;
