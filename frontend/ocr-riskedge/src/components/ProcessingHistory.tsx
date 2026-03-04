import { History, FileText, Image, Trash2, Clock, CheckCircle, Files, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { TableRow } from "@/components/DataTable";

export interface HistoryItem {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  processedAt: Date;
  fieldsExtracted: number;
  previewUrl: string;
  file: File;
  extractedData: TableRow[];
  totalPages: number;
  processingDuration: number; // ms, shared across all files in the same batch
}

interface ProcessingHistoryProps {
  history: HistoryItem[];
  selectedId: string | null;
  onSelect: (item: HistoryItem) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
};

const formatRelativeTime = (date: Date) => {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
};

const getFileIcon = (fileType: string) => {
  if (fileType.startsWith("image/")) return <Image className="w-4 h-4" />;
  return <FileText className="w-4 h-4" />;
};

// ─── Stats card ─────────────────────────────────────────────────────────────

interface StatPillProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}

const StatPill = ({ icon, label, value }: StatPillProps) => (
  <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/60 rounded-lg">
    <span className="text-muted-foreground">{icon}</span>
    <span className="text-xs font-semibold text-foreground tabular-nums">{value}</span>
    <span className="text-xs text-muted-foreground">{label}</span>
  </div>
);

interface SessionStatsProps {
  history: HistoryItem[];
}

const SessionStats = ({ history }: SessionStatsProps) => {
  const totalDocs = history.length;
  const totalPDFs = history.filter((h) => h.fileType === "application/pdf").length;
  const totalImages = history.filter((h) => h.fileType.startsWith("image/")).length;
  // Most recent batch duration (history is newest-first)
  const lastDuration = history[0]?.processingDuration ?? 0;

  return (
    <div className="mb-3 p-2.5 rounded-lg border border-border bg-card/50">
      <p className="text-xs font-medium text-muted-foreground mb-2">Session summary</p>
      <div className="grid grid-cols-2 gap-1.5">
        <StatPill icon={<Files className="w-3.5 h-3.5" />} value={totalDocs} label="total" />
        <StatPill icon={<Timer className="w-3.5 h-3.5" />} value={formatDuration(lastDuration)} label="last batch" />
        <StatPill icon={<FileText className="w-3.5 h-3.5" />} value={totalPDFs} label="PDFs" />
        <StatPill icon={<Image className="w-3.5 h-3.5" />} value={totalImages} label="images" />
      </div>
    </div>
  );
};

// ─── Main component ──────────────────────────────────────────────────────────

const ProcessingHistory = ({
  history,
  selectedId,
  onSelect,
  onDelete,
  onClear,
}: ProcessingHistoryProps) => {
  if (history.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between pb-3 border-b border-border mb-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-foreground">History</span>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
          <Clock className="w-10 h-10 mb-3 opacity-50" />
          <p className="text-sm font-medium">No documents processed</p>
          <p className="text-xs mt-1">Processed documents will appear here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between pb-3 border-b border-border mb-3">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium text-foreground">
            History
            <span className="ml-2 px-1.5 py-0.5 bg-primary/10 text-primary text-xs rounded-full">
              {history.length}
            </span>
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="h-7 text-xs text-muted-foreground hover:text-destructive"
        >
          Clear all
        </Button>
      </div>

      <SessionStats history={history} />

      <ScrollArea className="flex-1 -mx-1 px-1">
        <div className="space-y-2">
          {history.map((item) => (
            <div
              key={item.id}
              onClick={() => onSelect(item)}
              className={cn(
                "group relative p-3 rounded-lg border cursor-pointer transition-all",
                selectedId === item.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-muted/50"
              )}
            >
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    "w-8 h-8 rounded-md flex items-center justify-center shrink-0",
                    selectedId === item.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {getFileIcon(item.fileType)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate pr-6">
                    {item.fileName}
                  </p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                    <span>{formatFileSize(item.fileSize)}</span>
                    <span>•</span>
                    <span>{formatRelativeTime(item.processedAt)}</span>
                  </div>
                  <div className="flex items-center gap-1 mt-1.5">
                    <CheckCircle className="w-3 h-3 text-success" />
                    <span className="text-xs text-success">
                      {item.fieldsExtracted} fields extracted
                    </span>
                  </div>
                </div>
              </div>

              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(item.id);
                }}
                className="absolute top-2 right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

export default ProcessingHistory;
