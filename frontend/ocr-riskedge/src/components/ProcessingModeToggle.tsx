import { Layers, FileImage } from "lucide-react";
import { cn } from "@/lib/utils";

export type ProcessingMode = "single" | "batch";

interface ProcessingModeToggleProps {
  mode: ProcessingMode;
  onModeChange: (mode: ProcessingMode) => void;
  fileCount: number;
}

const ProcessingModeToggle = ({ mode, onModeChange, fileCount }: ProcessingModeToggleProps) => {
  return (
    <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
      <button
        onClick={() => onModeChange("single")}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
          mode === "single"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <FileImage className="w-4 h-4" />
        Single
      </button>
      <button
        onClick={() => onModeChange("batch")}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
          mode === "batch"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Layers className="w-4 h-4" />
        Batch
        {fileCount > 1 && (
          <span className="ml-1 px-1.5 py-0.5 bg-primary text-primary-foreground text-xs rounded-full">
            {fileCount}
          </span>
        )}
      </button>
    </div>
  );
};

export default ProcessingModeToggle;
