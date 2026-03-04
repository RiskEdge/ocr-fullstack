import { Loader2, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export type ProcessingState = "idle" | "uploading" | "processing" | "completed" | "error";

interface ProcessingStatusProps {
  state: ProcessingState;
  progress?: number;
}

const ProcessingStatus = ({ state, progress = 0 }: ProcessingStatusProps) => {
  const states = {
    idle: {
      icon: Clock,
      label: "Ready to process",
      color: "text-muted-foreground",
      bgColor: "bg-muted",
    },
    uploading: {
      icon: Loader2,
      label: "Uploading document...",
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    processing: {
      icon: Loader2,
      label: "Extracting text...",
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    completed: {
      icon: CheckCircle2,
      label: "Extraction complete",
      color: "text-success",
      bgColor: "bg-success/10",
    },
    error: {
      icon: AlertCircle,
      label: "Processing failed",
      color: "text-destructive",
      bgColor: "bg-destructive/10",
    },
  };

  const currentState = states[state];
  const Icon = currentState.icon;
  const isAnimating = state === "uploading" || state === "processing";

  return (
    <div className="flex items-center gap-3">
      <div className={cn("p-2 rounded-lg", currentState.bgColor)}>
        <Icon className={cn("w-4 h-4", currentState.color, isAnimating && "animate-spin")} />
      </div>
      <div className="flex-1">
        <p className={cn("text-sm font-medium", currentState.color)}>{currentState.label}</p>
        {isAnimating && (
          <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default ProcessingStatus;
