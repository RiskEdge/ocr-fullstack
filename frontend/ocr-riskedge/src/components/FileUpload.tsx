import { useCallback, useState } from "react";
import { Upload, FileText, Image, File, X, Plus, ChevronDown, ChevronUp, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import FileProcessingStatus, { FileStatus } from "@/components/FileProcessingStatus";

const COLLAPSE_THRESHOLD = 10;

// Mirrors the `accept` attribute on the file inputs below: any image plus PDF.
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif"];

const isSupportedFile = (file: File) => {
  if (file.type) return file.type.startsWith("image/") || file.type === "application/pdf";
  // Dropped files (and folders) can arrive with an empty MIME type — fall back to the extension.
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ext === "pdf" || IMAGE_EXTENSIONS.includes(ext);
};

interface FileUploadProps {
  onFilesSelect: (files: File[]) => void;
  selectedFiles: File[];
  onClear: () => void;
  onRemoveFile: (index: number) => void;
  fileStatuses?: Record<number, FileStatus>;
  /** How many times this company has already processed each staged file. */
  duplicateCounts?: Map<File, number>;
}

const FileUpload = ({ onFilesSelect, selectedFiles, onClear, onRemoveFile, fileStatuses = {}, duplicateCounts }: FileUploadProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [rejectedFiles, setRejectedFiles] = useState<string[]>([]);

  // Keeps only images/PDFs and reports the rest in a dialog. Applies to both
  // drag-drop and the file picker (`accept` is only a hint the user can bypass).
  const selectSupportedFiles = useCallback(
    (files: File[]) => {
      const supported: File[] = [];
      const rejected: string[] = [];
      for (const file of files) {
        if (isSupportedFile(file)) supported.push(file);
        else rejected.push(file.name);
      }
      if (rejected.length > 0) setRejectedFiles(rejected);
      if (supported.length > 0) onFilesSelect(supported);
    },
    [onFilesSelect]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) selectSupportedFiles(files);
    },
    [selectSupportedFiles]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) selectSupportedFiles(files);
      e.target.value = "";
    },
    [selectSupportedFiles]
  );

  const getFileIcon = (file: File) => {
    if (file.type.startsWith("image/")) return <Image className="w-4 h-4" />;
    if (file.type === "application/pdf") return <FileText className="w-4 h-4" />;
    return <File className="w-4 h-4" />;
  };

  const getFileExtension = (fileName: string) => fileName.split('.').pop()?.toUpperCase() || '';

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  // Amber pill on files this company has processed before. Stays visible after
  // the duplicate dialog is dismissed so the warning isn't a one-shot.
  const renderDuplicateBadge = (file: File) => {
    const count = duplicateCounts?.get(file);
    if (!count) return null;
    return (
      <span
        title={`Already processed ${count} time${count !== 1 ? "s" : ""} by your company`}
        className="inline-flex items-center gap-0.5 shrink-0 text-[10px] font-medium text-warning bg-warning/10 border border-warning/30 rounded-full px-1.5 py-px"
      >
        <RefreshCw className="w-2.5 h-2.5" />
        {count}×
      </span>
    );
  };

  const renderFileCard = (file: File, index: number) => (
    <div
      key={`${file.name}-${index}`}
      className={cn(
        "relative group flex-shrink-0 bg-muted/50 rounded-lg p-3 border transition-colors",
        fileStatuses[index] === "processing"
          ? "border-primary/50 bg-primary/5"
          : fileStatuses[index] === "completed"
          ? "border-success/50 bg-success/5"
          : "border-border hover:border-primary/50"
      )}
    >
      <button
        onClick={() => onRemoveFile(index)}
        className="absolute -top-2 -right-2 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
      >
        <X className="w-3 h-3" />
      </button>
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-primary shrink-0 relative">
          {getFileIcon(file)}
          <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-primary text-primary-foreground px-1 rounded">
            {getFileExtension(file.name)}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
          <div className="flex items-center gap-1.5">
            <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
            {renderDuplicateBadge(file)}
          </div>
        </div>
        <FileProcessingStatus status={fileStatuses[index] || "idle"} />
      </div>
    </div>
  );

  const rejectedFilesDialog = rejectedFiles.length > 0 && (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setRejectedFiles([])} />
      <div className="relative z-10 w-full max-w-sm mx-4 bg-card rounded-xl border border-border shadow-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            <h2 className="text-sm font-semibold text-foreground">
              Unsupported file{rejectedFiles.length !== 1 ? "s" : ""}
            </h2>
          </div>
          <button
            onClick={() => setRejectedFiles([])}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-muted-foreground">
          {rejectedFiles.length === 1 ? "This file was" : `These ${rejectedFiles.length} files were`} skipped —
          only images and PDF files can be processed.
        </p>

        <ul className="mt-3 max-h-40 overflow-y-auto space-y-1">
          {rejectedFiles.map((name, index) => (
            <li key={`${name}-${index}`} className="text-xs text-foreground bg-muted/50 rounded px-2 py-1 truncate">
              {name}
            </li>
          ))}
        </ul>

        <Button onClick={() => setRejectedFiles([])} className="w-full mt-5 text-sm">
          Got it
        </Button>
      </div>
    </div>
  );

  const addMoreButton = (
    <label className="cursor-pointer">
      <input type="file" accept="image/*,.pdf" multiple onChange={handleFileChange} className="hidden" />
      <Button variant="outline" size="sm" className="gap-1.5" asChild>
        <span>
          <Plus className="w-3.5 h-3.5" />
          Add more
        </span>
      </Button>
    </label>
  );

  if (selectedFiles.length > 0) {
    const needsCollapse = selectedFiles.length > COLLAPSE_THRESHOLD;
    const visibleFiles = needsCollapse && !isExpanded
      ? selectedFiles.slice(0, COLLAPSE_THRESHOLD)
      : selectedFiles;
    const hiddenCount = selectedFiles.length - COLLAPSE_THRESHOLD;

    return (
      <div className="bg-card border border-border rounded-lg p-4">
        {rejectedFilesDialog}
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-foreground">
            {selectedFiles.length} file{selectedFiles.length !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            {addMoreButton}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              className="text-muted-foreground hover:text-destructive"
            >
              Clear all
            </Button>
          </div>
        </div>

        {needsCollapse ? (
          // Grid layout for >10 files
          <div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {visibleFiles.map((file, index) => (
                <div key={`${file.name}-${index}`} className={cn(
                  "relative group bg-muted/50 rounded-lg p-3 border transition-colors",
                  fileStatuses[index] === "processing"
                    ? "border-primary/50 bg-primary/5"
                    : fileStatuses[index] === "completed"
                    ? "border-success/50 bg-success/5"
                    : "border-border hover:border-primary/50"
                )}>
                  <button
                    onClick={() => onRemoveFile(index)}
                    className="absolute -top-2 -right-2 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm z-10"
                  >
                    <X className="w-3 h-3" />
                  </button>
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-primary shrink-0 relative">
                      {getFileIcon(file)}
                      <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-primary text-primary-foreground px-1 rounded">
                        {getFileExtension(file.name)}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">{file.name}</p>
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                        {renderDuplicateBadge(file)}
                      </div>
                    </div>
                    <FileProcessingStatus status={fileStatuses[index] || "idle"} />
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={() => setIsExpanded((v) => !v)}
              className="mt-2 w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted/50"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  Show {hiddenCount} more file{hiddenCount !== 1 ? "s" : ""}
                </>
              )}
            </button>
          </div>
        ) : (
          // Horizontal scroll for ≤10 files
          <ScrollArea className="w-full">
            <div className="flex gap-3 pb-2">
              {selectedFiles.map((file, index) => (
                <div key={`${file.name}-${index}`} className="w-48">
                  {renderFileCard(file, index)}
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        )}
      </div>
    );
  }

  return (
    <>
      {rejectedFilesDialog}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative border-2 border-dashed rounded-xl p-8 text-center transition-all duration-200 cursor-pointer",
          isDragging
            ? "border-primary bg-primary/5 scale-[1.02]"
            : "border-border hover:border-primary/50 hover:bg-muted/50"
        )}
      >
        <input
          type="file"
          accept="image/*,.pdf"
          multiple
          onChange={handleFileChange}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        <div className="flex flex-col items-center gap-3">
          <div
            className={cn(
              "w-14 h-14 rounded-full flex items-center justify-center transition-colors",
              isDragging ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}
          >
            <Upload className="w-6 h-6" />
          </div>
          <div>
            <p className="font-medium text-foreground">
              {isDragging ? "Drop your files here" : "Drop your files here, or browse"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Supports images (PNG, JPG, JPEG) and PDF files • Multiple files allowed
            </p>
          </div>
        </div>
      </div>
    </>
  );
};

export default FileUpload;
