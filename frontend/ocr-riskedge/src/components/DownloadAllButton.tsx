import JSZip from "jszip";
import { Download, FileText, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableRow } from "./DataTable";
import {
  baseName,
  csvQuote,
  escapeXml,
  flattenForCsv,
  buildExcelSheets,
} from "./ExportButtons";

interface DownloadAllButtonProps {
  dataByFile: Record<number, TableRow[]>;
  files: File[];
  disabled?: boolean;
}

const DownloadAllButton = ({ dataByFile, files, disabled }: DownloadAllButtonProps) => {
  const entries = Object.entries(dataByFile)
    .map(([idx, data]) => ({ idx: Number(idx), data, file: files[Number(idx)] }))
    .filter(({ data, file }) => file && data.some((r) => r.kind === "data"));

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadAllCsv = async () => {
    const zip = new JSZip();
    for (const { data, file } of entries) {
      const pairs = flattenForCsv(data);
      const content = [["Field", "Value"], ...pairs]
        .map((row) => row.map(csvQuote).join(","))
        .join("\n");
      zip.file(`${baseName(file.name)}.csv`, content);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, "extracted_data_all.zip");
  };

  const downloadAllExcel = async () => {
    const zip = new JSZip();
    for (const { data, file } of entries) {
      const sheets = buildExcelSheets(data);
      const worksheetsXml = sheets
        .map(({ name, rows }) => {
          const xmlRows = rows
            .map(
              (row) =>
                `<Row>${row
                  .map(
                    (cell) =>
                      `<Cell><Data ss:Type="String">${escapeXml(String(cell))}</Data></Cell>`
                  )
                  .join("")}</Row>`
            )
            .join("");
          return `<Worksheet ss:Name="${escapeXml(name)}"><Table>${xmlRows}</Table></Worksheet>`;
        })
        .join("\n");
      const xml = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"`,
        `          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">`,
        worksheetsXml,
        `</Workbook>`,
      ].join("\n");
      zip.file(`${baseName(file.name)}.xls`, xml);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, "extracted_data_all.zip");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled || entries.length < 2}
          className="gap-2"
        >
          <Download className="w-4 h-4" />
          Download All ({entries.length})
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={downloadAllCsv} className="gap-2 cursor-pointer">
          <FileText className="w-4 h-4" />
          Download All as CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={downloadAllExcel} className="gap-2 cursor-pointer">
          <FileSpreadsheet className="w-4 h-4" />
          Download All as Excel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default DownloadAllButton;
