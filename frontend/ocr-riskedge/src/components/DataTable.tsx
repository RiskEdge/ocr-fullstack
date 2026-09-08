import { useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow as UITableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";

export interface ExtractedData {
  kind: "data";
  id: number;
  field: string;
  value: string;
  confidence: number;
  type: "text" | "number" | "date" | "currency";
  depth: number;
}

export interface SectionRow {
  kind: "section";
  label: string;
  depth: number;
}

export type TableRow = ExtractedData | SectionRow;

// ---------------------------------------------------------------------------
// Partition: split flat TableRow[] into a main table + one table per array.
//
// Array items are depth-0 sections whose labels end with " [N]".
// Everything else (scalar fields + nested-object sections) stays in the
// main table, preserving grouping dividers and indentation.
// ---------------------------------------------------------------------------

type MainPart  = { kind: "main";  rows: TableRow[] };
type ArrayPart = { kind: "array"; name: string; columns: string[]; items: Record<string, string>[] };
type RenderPart = MainPart | ArrayPart;

function partitionRows(rows: TableRow[]): RenderPart[] {
  const mainRows: TableRow[] = [];
  const arrays   = new Map<string, { columns: Set<string>; items: Record<string, string>[] }>();
  const arrayOrder: string[] = [];

  let currentArrayName: string | null = null;
  let currentItem: Record<string, string> | null = null;

  const flushItem = () => {
    if (currentItem !== null && currentArrayName !== null) {
      const arr = arrays.get(currentArrayName)!;
      Object.keys(currentItem).forEach((k) => arr.columns.add(k));
      arr.items.push(currentItem);
      currentItem = null;
    }
  };

  for (const row of rows) {
    if (row.kind === "section") {
      if (row.depth === 0) {
        // Top-level section: decide array vs main
        flushItem();
        const m = row.label.match(/^(.+)\s\[\d+\]$/);
        if (m) {
          currentArrayName = m[1];
          currentItem = {};
          if (!arrays.has(currentArrayName)) {
            arrays.set(currentArrayName, { columns: new Set(), items: [] });
            arrayOrder.push(currentArrayName);
          }
        } else {
          currentArrayName = null;
          mainRows.push(row);
        }
      } else if (currentArrayName === null) {
        // Nested section in main context
        mainRows.push(row);
      }
      // Nested section inside an array item: skip (field names act as column headers)
    } else if (currentArrayName !== null && row.depth >= 1) {
      // Data field inside an array item
      if (currentItem === null) currentItem = {};
      currentItem[row.field] = row.value;
    } else {
      // Depth-0 data field, or a field outside array context
      if (currentArrayName !== null) {
        // Leaving array context (e.g. a top-level field after the array)
        flushItem();
        currentArrayName = null;
      }
      mainRows.push(row);
    }
  }

  flushItem();

  const parts: RenderPart[] = [];
  if (mainRows.length > 0) parts.push({ kind: "main", rows: mainRows });
  for (const name of arrayOrder) {
    const { columns, items } = arrays.get(name)!;
    if (items.length > 0) {
      parts.push({ kind: "array", name, columns: Array.from(columns), items });
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Section collapse: a flattened, depth-tagged row list is a tree in
// disguise — collapsing a section hides every row nested under it (deeper
// depth) until a row at its own depth or shallower closes the range. One
// pass with a single "currently hiding below this depth" marker is enough:
// hidden ranges from a flat depth-first walk never overlap, they only nest.
// ---------------------------------------------------------------------------

function sectionVisibility(rows: TableRow[], collapsed: Set<number>): boolean[] {
  let hideBelowDepth: number | null = null;
  return rows.map((row, i) => {
    if (hideBelowDepth !== null && row.depth <= hideBelowDepth) {
      hideBelowDepth = null;
    }
    const visible = hideBelowDepth === null;
    if (visible && row.kind === "section" && collapsed.has(i)) {
      hideBelowDepth = row.depth;
    }
    return visible;
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DataTableProps {
  data: TableRow[];
}

const DataTable = ({ data }: DataTableProps) => {
  // Keyed by each section row's index within the main part, and by array
  // field name — both stable for a given extraction, reset when a different
  // document's data replaces it.
  const [collapsedSections, setCollapsedSections] = useState<Set<number>>(new Set());
  const [collapsedArrays, setCollapsedArrays] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCollapsedSections(new Set());
    setCollapsedArrays(new Set());
  }, [data]);

  const toggleSection = (index: number) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleArray = (name: string) => {
    setCollapsedArrays((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (data.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
        <p className="font-medium">No data extracted yet</p>
        <p className="text-sm mt-1">Upload a document to extract data</p>
      </div>
    );
  }

  const dataRows = data.filter((r): r is ExtractedData => r.kind === "data");
  const overallConfidence =
    dataRows.length > 0
      ? Math.round(dataRows.reduce((sum, d) => sum + d.confidence, 0) / dataRows.length)
      : 0;

  const getConfidenceBadge = (confidence: number) => {
    if (confidence >= 90)
      return (
        <Badge variant="default" className="bg-success/10 text-success border-success/20 gap-1">
          <CheckCircle2 className="w-3 h-3" />
          {confidence}% overall confidence
        </Badge>
      );
    if (confidence >= 70)
      return (
        <Badge variant="default" className="bg-warning/10 text-warning border-warning/20 gap-1">
          <AlertCircle className="w-3 h-3" />
          {confidence}% overall confidence
        </Badge>
      );
    return (
      <Badge variant="default" className="bg-destructive/10 text-destructive border-destructive/20 gap-1">
        <AlertCircle className="w-3 h-3" />
        {confidence}% overall confidence
      </Badge>
    );
  };

  const parts = partitionRows(data);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        {getConfidenceBadge(overallConfidence)}
      </div>

      {parts.map((part, partIdx) => {
        // ── Main table (scalar + nested-object fields) ─────────────────────
        if (part.kind === "main") {
          const visible = sectionVisibility(part.rows, collapsedSections);
          let rowNum = 0;
          return (
            <div key={`main-${partIdx}`} className="border border-border rounded-lg">
              <Table wrapperClassName="overflow-visible">
                <TableHeader sticky>
                  <UITableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead className="font-semibold text-foreground w-12">#</TableHead>
                    <TableHead className="font-semibold text-foreground">Field</TableHead>
                    <TableHead className="font-semibold text-foreground">Value</TableHead>
                  </UITableRow>
                </TableHeader>
                <TableBody>
                  {part.rows.map((row, index) => {
                    if (!visible[index]) return null;

                    if (row.kind === "section") {
                      const isCollapsed = collapsedSections.has(index);
                      return (
                        <tr
                          key={`section-${index}`}
                          className="border-b border-border bg-muted/20 cursor-pointer hover:bg-muted/40"
                          onClick={() => toggleSection(index)}
                        >
                          <td colSpan={3} className="px-4 py-1.5">
                            <div
                              className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
                              style={{ paddingLeft: row.depth * 12 }}
                            >
                              {isCollapsed ? (
                                <ChevronRight className="w-3 h-3 shrink-0" />
                              ) : (
                                <ChevronDown className="w-3 h-3 shrink-0" />
                              )}
                              <span>{row.label}</span>
                              <div className="flex-1 h-px bg-border" />
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    rowNum++;
                    return (
                      <UITableRow key={row.id} className="hover:bg-muted/30">
                        <TableCell className="text-muted-foreground font-mono text-sm">{rowNum}</TableCell>
                        <TableCell className="font-medium text-foreground">
                          <span style={{ paddingLeft: row.depth * 16 }}>{row.field}</span>
                        </TableCell>
                        <TableCell className="text-foreground">{row.value}</TableCell>
                      </UITableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          );
        }

        // ── Array table (one per array field, e.g. Line Items) ─────────────
        const isCollapsed = collapsedArrays.has(part.name);
        return (
          <div key={`array-${part.name}-${partIdx}`} className="space-y-1.5">
            <button
              type="button"
              onClick={() => toggleArray(part.name)}
              className="flex items-center gap-1.5 text-sm font-semibold text-foreground px-0.5 w-full text-left"
            >
              {isCollapsed ? (
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              )}
              {part.name}
              <span className="text-xs font-normal text-muted-foreground">
                ({part.items.length})
              </span>
            </button>
            {!isCollapsed && (
              <div className="border border-border rounded-lg">
                <Table wrapperClassName="overflow-visible">
                  <TableHeader sticky>
                    <UITableRow className="bg-muted/50 hover:bg-muted/50">
                      {part.columns.map((col) => (
                        <TableHead key={col} className="font-semibold text-foreground">{col}</TableHead>
                      ))}
                    </UITableRow>
                  </TableHeader>
                  <TableBody>
                    {part.items.map((item, rowIdx) => (
                      <UITableRow key={rowIdx} className="hover:bg-muted/30">
                        {part.columns.map((col) => (
                          <TableCell key={col} className="text-foreground">{item[col] ?? ""}</TableCell>
                        ))}
                      </UITableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default DataTable;
