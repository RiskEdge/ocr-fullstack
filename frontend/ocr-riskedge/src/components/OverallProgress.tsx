import { Loader2, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface OverallProgressProps {
  completedCount: number;
  totalCount: number;
  isProcessing: boolean;
}

const OverallProgress = ({ completedCount, totalCount, isProcessing }: OverallProgressProps) => {
  const allDone = completedCount === totalCount;
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="flex items-center gap-3 w-full">
      <div className={cn("p-2 rounded-lg", allDone ? "bg-success/10" : "bg-primary/10")}>
        {allDone ? (
          <CheckCircle2 className="w-4 h-4 text-success" />
        ) : (
          <Loader2 className="w-4 h-4 text-primary animate-spin" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <p className={cn("text-sm font-medium", allDone ? "text-success" : "text-primary")}>
            {allDone
              ? `All ${totalCount} files processed`
              : `Processing ${completedCount} of ${totalCount} files...`}
          </p>
          <span className="text-xs text-muted-foreground">{percent}%</span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              allDone ? "bg-success" : "bg-primary"
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  );
};

export default OverallProgress;
