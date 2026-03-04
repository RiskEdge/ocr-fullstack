import { FileText, Image, File } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface DocumentGridViewProps {
  files: File[];
  previewUrls: string[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

const DocumentGridView = ({ files, previewUrls, activeIndex, onSelect }: DocumentGridViewProps) => {
  const getFileExtension = (fileName: string) =>
    fileName.split(".").pop()?.toUpperCase() || "";

  const isImage = (file: File) => file.type.startsWith("image/");

  return (
    <ScrollArea className="h-[440px]">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-1">
        {files.map((file, index) => (
          <button
            key={`${file.name}-${index}`}
            onClick={() => onSelect(index)}
            className={cn(
              "group relative flex flex-col items-center rounded-lg border-2 p-3 transition-all duration-150 text-left",
              activeIndex === index
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border bg-muted/30 hover:border-primary/40 hover:bg-muted/60"
            )}
          >
            {/* Thumbnail */}
            <div className="w-full aspect-[4/3] rounded-md overflow-hidden bg-muted flex items-center justify-center mb-2">
              {isImage(file) && previewUrls[index] ? (
                <img
                  src={previewUrls[index]}
                  alt={file.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="flex flex-col items-center gap-1 text-muted-foreground">
                  {file.type === "application/pdf" ? (
                    <FileText className="w-8 h-8" />
                  ) : (
                    <File className="w-8 h-8" />
                  )}
                  <span className="text-[10px] font-bold bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    {getFileExtension(file.name)}
                  </span>
                </div>
              )}
            </div>

            {/* File info */}
            <p className="text-xs font-medium text-foreground truncate w-full text-center">
              {file.name}
            </p>

            {/* Active indicator */}
            {activeIndex === index && (
              <div className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-primary" />
            )}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
};

export default DocumentGridView;
