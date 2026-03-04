import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExtractedData, TableRow } from "./DataTable";

interface ExportButtonsProps {
  data: TableRow[];
  disabled?: boolean;
  filename?: string;
}

export const baseName = (filename?: string) => {
  if (!filename) return "extracted_data";
  const dotIndex = filename.lastIndexOf(".");
  return (dotIndex > 0 ? filename.slice(0, dotIndex) : filename) + "_extracted";
};

export const escapeXml = (str: string) =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const csvQuote = (str: string) => {
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

// ---------------------------------------------------------------------------
// CSV: flat Field/Value pairs with parent section path prefixed to the name.
// e.g. data row "Name" under section "Vendor" → "Vendor - Name"
// ---------------------------------------------------------------------------
export function flattenForCsv(rows: TableRow[]): Array<[string, string]> {
  const sectionStack: string[] = [];
  const result: Array<[string, string]> = [];

  for (const row of rows) {
    if (row.kind === "section") {
      sectionStack[row.depth] = row.label;
      sectionStack.length = row.depth + 1;
    } else {
      const parents = sectionStack.slice(0, row.depth);
      result.push([[...parents, row.field].join(" - "), row.value]);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Excel: split into multiple worksheets.
//   • "Main" sheet  — all scalar/nested-object fields as Field | Value rows
//   • One sheet per array field (e.g. "Line Items") — each array item is a
//     table row; its sub-fields become column headers.
//
// Array items are depth-0 sections whose labels end with " [N]".
// Mirrors the partitionRows logic in DataTable.tsx.
// ---------------------------------------------------------------------------
export function buildExcelSheets(
  rows: TableRow[]
): Array<{ name: string; rows: string[][] }> {
  const mainData: string[][] = [];
  const arrayData = new Map<string, Record<string, string>[]>();
  const arrayOrder: string[] = [];

  let currentArrayName: string | null = null;
  let currentItem: Record<string, string> | null = null;
  const mainSectionStack: string[] = [];

  const flushItem = () => {
    if (currentItem !== null && currentArrayName !== null) {
      arrayData.get(currentArrayName)!.push(currentItem);
      currentItem = null;
    }
  };

  for (const row of rows) {
    if (row.kind === "section") {
      if (row.depth === 0) {
        flushItem();
        const m = row.label.match(/^(.+)\s\[\d+\]$/);
        if (m) {
          currentArrayName = m[1];
          currentItem = {};
          if (!arrayData.has(currentArrayName)) {
            arrayData.set(currentArrayName, []);
            arrayOrder.push(currentArrayName);
          }
        } else {
          currentArrayName = null;
          mainSectionStack[0] = row.label;
          mainSectionStack.length = 1;
        }
      } else if (currentArrayName === null) {
        // Nested section in main context — update prefix stack
        mainSectionStack[row.depth] = row.label;
        mainSectionStack.length = row.depth + 1;
      }
      // Nested section inside an array item: skip (field names are column headers)
    } else if (currentArrayName !== null && row.depth >= 1) {
      // Data field inside an array item
      if (currentItem === null) currentItem = {};
      currentItem[row.field] = row.value;
    } else {
      // Scalar field — goes to Main sheet
      if (currentArrayName !== null) {
        flushItem();
        currentArrayName = null;
      }
      const parents = mainSectionStack.slice(0, row.depth);
      mainData.push([[...parents, row.field].join(" - "), row.value]);
    }
  }

  flushItem();

  const sheets: Array<{ name: string; rows: string[][] }> = [];

  if (mainData.length > 0) {
    sheets.push({ name: "Main", rows: [["Field", "Value"], ...mainData] });
  }

  for (const name of arrayOrder) {
    const items = arrayData.get(name)!;
    if (items.length === 0) continue;
    // Union of all column names, preserving insertion order
    const allCols = Array.from(new Set(items.flatMap((item) => Object.keys(item))));
    sheets.push({
      name,
      rows: [allCols, ...items.map((item) => allCols.map((col) => item[col] ?? ""))],
    });
  }

  return sheets;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
const ExportButtons = ({ data, disabled, filename }: ExportButtonsProps) => {
  const hasData = data.some((r): r is ExtractedData => r.kind === "data");

  const exportToCSV = () => {
    const pairs = flattenForCsv(data);
    const csvContent = [["Field", "Value"], ...pairs]
      .map((row) => row.map(csvQuote).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${baseName(filename)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const exportToExcel = () => {
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

    const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${baseName(filename)}.xls`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={disabled || !hasData} className="gap-2">
          <Download className="w-4 h-4" />
          Export Data
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={exportToCSV} className="gap-2 cursor-pointer">
          <FileText className="w-4 h-4" />
          Export as CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportToExcel} className="gap-2 cursor-pointer">
          <FileSpreadsheet className="w-4 h-4" />
          Export as Excel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ExportButtons;
