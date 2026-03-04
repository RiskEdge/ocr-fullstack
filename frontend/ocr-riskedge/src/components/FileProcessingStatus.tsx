import { Loader2, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type FileStatus = "idle" | "processing" | "completed" | "error";

interface FileProcessingStatusProps {
  status: FileStatus;
  className?: string;
}

const FileProcessingStatus = ({ status, className }: FileProcessingStatusProps) => {
  if (status === "idle") return null;

  const config = {
    processing: {
      icon: Loader2,
      color: "text-primary",
      bg: "bg-primary/10",
      animate: true,
    },
    completed: {
      icon: CheckCircle2,
      color: "text-success",
      bg: "bg-success/10",
      animate: false,
    },
    error: {
      icon: AlertCircle,
      color: "text-destructive",
      bg: "bg-destructive/10",
      animate: false,
    },
  };

  const c = config[status];
  const Icon = c.icon;

  return (
    <div className={cn("flex items-center justify-center", className)}>
      <div className={cn("p-1 rounded-full", c.bg)}>
        <Icon className={cn("w-3.5 h-3.5", c.color, c.animate && "animate-spin")} />
      </div>
    </div>
  );
};

export default FileProcessingStatus;
