import { FileText, Image, ZoomIn, ZoomOut, RotateCw, ChevronLeft, ChevronRight } from "lucide-react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DocumentPreviewProps {
  file: File | null;
  previewUrl: string | null;
  totalPages?: number;
}

const DocumentPreview = ({ file, previewUrl, totalPages: totalPagesProp }: DocumentPreviewProps) => {
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [pageInputValue, setPageInputValue] = useState("1");

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 25, 200));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 25, 50));
  const handleRotate = () => setRotation((prev) => (prev + 90) % 360);

  const handlePrevPage = () => {
    if (currentPage > 1) {
      const newPage = currentPage - 1;
      setCurrentPage(newPage);
      setPageInputValue(String(newPage));
    }
  };

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      const newPage = currentPage + 1;
      setCurrentPage(newPage);
      setPageInputValue(String(newPage));
    }
  };

  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPageInputValue(e.target.value);
  };

  const handlePageInputBlur = () => {
    const pageNum = parseInt(pageInputValue, 10);
    if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
      setCurrentPage(pageNum);
    } else {
      setPageInputValue(String(currentPage));
    }
  };

  const handlePageInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handlePageInputBlur();
    }
  };

  // Reset state when file or page count changes
  useEffect(() => {
    setCurrentPage(1);
    setPageInputValue("1");
    setZoom(100);
    setRotation(0);
    setTotalPages(file?.type === "application/pdf" ? (totalPagesProp ?? 1) : 1);
  }, [file, totalPagesProp]);

  if (!file || !previewUrl) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-muted-foreground bg-muted/30 rounded-xl">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <FileText className="w-8 h-8" />
        </div>
        <p className="font-medium">No document uploaded</p>
        <p className="text-sm mt-1">Upload a file to preview it here</p>
      </div>
    );
  }

  const isImage = file.type.startsWith("image/");
  const isPdf = file.type === "application/pdf";

  // Generate PDF URL with page fragment
  const getPdfUrl = () => {
    if (!previewUrl) return "";
    return `${previewUrl}#page=${currentPage}`;
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between pb-3 border-b border-border mb-3">
        <div className="flex items-center gap-2">
          {isImage ? (
            <Image className="w-4 h-4 text-primary" />
          ) : (
            <FileText className="w-4 h-4 text-primary" />
          )}
          <span className="text-sm font-medium text-foreground truncate max-w-[180px]">
            {file.name}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleZoomOut}
            disabled={zoom <= 50}
          >
            <ZoomOut className="w-4 h-4" />
          </Button>
          <span className="text-xs text-muted-foreground w-12 text-center">{zoom}%</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleZoomIn}
            disabled={zoom >= 200}
          >
            <ZoomIn className="w-4 h-4" />
          </Button>
          {isImage && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleRotate}>
              <RotateCw className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {/* PDF Page Navigation */}
      {isPdf && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pb-3 mb-3 border-b border-border">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={handlePrevPage}
            disabled={currentPage <= 1}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={pageInputValue}
              onChange={handlePageInputChange}
              onBlur={handlePageInputBlur}
              onKeyDown={handlePageInputKeyDown}
              className="w-12 h-8 text-center text-sm"
            />
            <span className="text-sm text-muted-foreground">of {totalPages}</span>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={handleNextPage}
            disabled={currentPage >= totalPages}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}

      {/* Preview Area */}
      <div className="flex-1 min-h-0 overflow-hidden bg-muted/30 rounded-lg">
        {isImage ? (
          <div className="w-full h-full overflow-auto flex items-center justify-center p-4">
            <img
              src={previewUrl}
              alt="Document preview"
              className="max-w-full max-h-full object-contain transition-transform duration-200 shadow-lg rounded"
              style={{
                transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
              }}
            />
          </div>
        ) : isPdf ? (
          <iframe
            src={getPdfUrl()}
            className="w-full h-full rounded border-0 block"
            title="PDF Preview"
            key={`${previewUrl}-${currentPage}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <FileText className="w-12 h-12 mx-auto mb-2" />
              <p>Preview not available for this file type</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DocumentPreview;
