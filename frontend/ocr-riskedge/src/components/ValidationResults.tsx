import { useState, useMemo, Fragment } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow as UITableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Info,
  Wand2,
  HelpCircle,
} from "lucide-react";
import type { ValidatedItem, Discrepancy, ValidationResult } from "@/lib/validateApi";

const FIELD_LABELS: Record<string, string> = {
  cost_price: "Cost Price",
  mrp: "MRP",
  tax_pct: "Tax %",
  ean_code: "EAN Code",
  product_name: "Product Name",
  sku_desc: "Product Name",
  quantity: "Qty",
  plu_code: "PLU",
};

function fieldLabel(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (Array.isArray(val)) return val.map((v) => String(v ?? "")).join(", ");
  if (typeof val === "object") return "—";
  return String(val);
}

// A discrepancy is resolved when the user has edited the field to match the master value.
function isResolved(
  d: Discrepancy,
  corrections: ValidationResult["suggested_corrections"],
  itemEdits: Record<string, string> | undefined
): boolean {
  const suggested = corrections[d.field];
  if (suggested === undefined) return false;
  return itemEdits?.[d.field] === String(suggested);
}

interface Props {
  items: ValidatedItem[];
}

const ValidationResults = ({ items }: Props) => {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Record<number, Record<string, string>>>({});

  // Collect all unique field keys across all items (preserve insertion order, skip 'validation')
  const fieldKeys = useMemo(() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      for (const key of Object.keys(item)) {
        if (key !== "validation" && !seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
    return keys;
  }, [items]);

  // chevron + # + fieldKeys + PLU + Match + Status
  const totalCols = fieldKeys.length + 5;

  // Summary stats derived from edits (reactive)
  const stats = useMemo(() => {
    let effectiveValid = 0;
    let effectiveIssues = 0;
    let noMatch = 0;
    let totalAccepted = 0;
    let rowsWithAccepted = 0;

    for (let idx = 0; idx < items.length; idx++) {
      const v = items[idx].validation;
      const itemEdits = edits[idx];

      if (v.match_type === "no_match") {
        noMatch++;
        continue;
      }

      let acceptedInRow = 0;
      let remaining = 0;
      for (const d of v.discrepancies) {
        if (isResolved(d, v.suggested_corrections, itemEdits)) {
          totalAccepted++;
          acceptedInRow++;
        } else {
          remaining++;
        }
      }
      if (acceptedInRow > 0) rowsWithAccepted++;

      const effectivelyValid = v.is_valid || remaining === 0;
      if (effectivelyValid) effectiveValid++;
      else effectiveIssues++;
    }

    return { effectiveValid, effectiveIssues, noMatch, totalAccepted, rowsWithAccepted };
  }, [items, edits]);

  function toggleExpand(idx: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function setFieldEdit(itemIdx: number, field: string, value: string) {
    setEdits((prev) => ({
      ...prev,
      [itemIdx]: { ...(prev[itemIdx] ?? {}), [field]: value },
    }));
  }

  function applyAllSuggestions(
    itemIdx: number,
    corrections: ValidationResult["suggested_corrections"]
  ) {
    const updates: Record<string, string> = {};
    for (const [field, val] of Object.entries(corrections)) {
      updates[field] = String(val);
    }
    setEdits((prev) => ({
      ...prev,
      [itemIdx]: { ...(prev[itemIdx] ?? {}), ...updates },
    }));
  }

  function getEditValue(itemIdx: number, field: string, actual: unknown): string {
    return edits[itemIdx]?.[field] ?? String(actual ?? "");
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <p className="font-medium">No line items to validate</p>
        <p className="text-sm mt-1">
          The document has no item arrays to validate against master data.
        </p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-3">
        {/* Summary bar */}
        <div className="p-3 bg-muted/40 rounded-lg space-y-1.5">
          <div className="flex items-center gap-3 text-sm flex-wrap">
            <span className="font-medium text-foreground">
              {items.length} item{items.length !== 1 ? "s" : ""}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {stats.effectiveValid} valid
            </span>
            {stats.effectiveIssues > 0 && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="flex items-center gap-1 text-destructive">
                  <XCircle className="w-3.5 h-3.5" />
                  {stats.effectiveIssues} with issues
                </span>
              </>
            )}
            {stats.noMatch > 0 && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <HelpCircle className="w-3.5 h-3.5" />
                  {stats.noMatch} unmatched
                </span>
              </>
            )}
          </div>

          {/* Accepted suggestions metadata — only shown once at least one is accepted */}
          {stats.totalAccepted > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
              <Wand2 className="w-3 h-3" />
              <span>
                <span className="font-semibold">{stats.totalAccepted}</span>{" "}
                suggestion{stats.totalAccepted !== 1 ? "s" : ""} accepted across{" "}
                <span className="font-semibold">{stats.rowsWithAccepted}</span>{" "}
                row{stats.rowsWithAccepted !== 1 ? "s" : ""}
              </span>
            </div>
          )}
        </div>

        {/* Main table */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <UITableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-8 px-2" />
                  <TableHead className="w-8 text-xs font-semibold text-foreground">#</TableHead>
                  {fieldKeys.map((key) => (
                    <TableHead
                      key={key}
                      className="text-xs font-semibold text-foreground whitespace-nowrap"
                    >
                      {fieldLabel(key)}
                    </TableHead>
                  ))}
                  <TableHead className="text-xs font-semibold text-foreground whitespace-nowrap">
                    Matched PLU
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-foreground whitespace-nowrap">
                    Match
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-foreground whitespace-nowrap">
                    Status
                  </TableHead>
                </UITableRow>
              </TableHeader>

              <TableBody>
                {items.map((item, idx) => {
                  const v = item.validation;
                  const itemEdits = edits[idx];
                  const isExpanded = expanded.has(idx);
                  const isFuzzy = v.match_type === "fuzzy_name";
                  const isNoMatch = v.match_type === "no_match";

                  // Remaining unresolved discrepancies
                  const effectiveDiscrepancies = v.discrepancies.filter(
                    (d) => !isResolved(d, v.suggested_corrections, itemEdits)
                  );
                  const isEffectivelyValid =
                    v.is_valid || (!isNoMatch && effectiveDiscrepancies.length === 0);

                  // Cells that still have active discrepancies
                  const discrepantFields = new Set(effectiveDiscrepancies.map((d) => d.field));

                  const isExpandable =
                    v.discrepancies.length > 0 || isFuzzy || isNoMatch;

                  return (
                    <Fragment key={idx}>
                      {/* Data row */}
                      <UITableRow
                        className={`${isExpandable ? "cursor-pointer" : ""} hover:bg-muted/30 ${
                          isExpanded ? "bg-muted/20" : ""
                        }`}
                        onClick={() => isExpandable && toggleExpand(idx)}
                      >
                        {/* Expand chevron */}
                        <TableCell className="px-2 py-2 w-8">
                          {isExpandable &&
                            (isExpanded ? (
                              <ChevronDown className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-muted-foreground" />
                            ))}
                        </TableCell>

                        {/* Row number */}
                        <TableCell className="text-xs text-muted-foreground font-mono py-2">
                          {idx + 1}
                        </TableCell>

                        {/* Dynamic OCR field cells */}
                        {fieldKeys.map((key) => (
                          <TableCell
                            key={key}
                            className={`text-sm py-2 whitespace-nowrap ${
                              discrepantFields.has(key)
                                ? "text-destructive font-semibold"
                                : "text-foreground"
                            }`}
                          >
                            {formatCellValue(item[key])}
                          </TableCell>
                        ))}

                        {/* Matched PLU */}
                        <TableCell className="text-sm py-2 font-mono text-foreground whitespace-nowrap">
                          {v.matched_plu ?? "—"}
                        </TableCell>

                        {/* Match type badge */}
                        <TableCell className="py-2">
                          {isFuzzy ? (
                            <Badge
                              variant="outline"
                              className="text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-xs whitespace-nowrap"
                            >
                              Fuzzy
                              {v.confidence && (
                                <span className="ml-1 opacity-70">· {v.confidence}</span>
                              )}
                            </Badge>
                          ) : isNoMatch ? (
                            <Badge
                              variant="outline"
                              className="text-muted-foreground text-xs whitespace-nowrap"
                            >
                              No Match
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-950/20 text-xs"
                            >
                              Exact
                            </Badge>
                          )}
                        </TableCell>

                        {/* Status badge — reflects accepted edits */}
                        <TableCell className="py-2">
                          {isEffectivelyValid ? (
                            <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20 gap-1 text-xs whitespace-nowrap">
                              <CheckCircle2 className="w-3 h-3" />
                              Valid
                            </Badge>
                          ) : isNoMatch ? (
                            <Badge
                              variant="outline"
                              className="text-muted-foreground text-xs gap-1 whitespace-nowrap"
                            >
                              <HelpCircle className="w-3 h-3" />
                              Unmatched
                            </Badge>
                          ) : (
                            <Badge className="bg-destructive/10 text-destructive border-destructive/20 gap-1 text-xs whitespace-nowrap">
                              <XCircle className="w-3 h-3" />
                              {effectiveDiscrepancies.length} issue
                              {effectiveDiscrepancies.length !== 1 ? "s" : ""}
                            </Badge>
                          )}
                        </TableCell>
                      </UITableRow>

                      {/* Inline expanded detail row */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={totalCols} className="p-0">
                            <div className="bg-muted/10 border-t border-border px-4 py-3 space-y-3">
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                Item {idx + 1} — {String(item.product_name ?? "details")}
                              </p>

                              {/* Fuzzy match note */}
                              {isFuzzy && v.match_note && (
                                <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded-md px-3 py-2">
                                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                                  <span>{v.match_note}</span>
                                </div>
                              )}

                              {/* No-match message */}
                              {isNoMatch && v.discrepancies[0]?.message && (
                                <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
                                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                  <span>{v.discrepancies[0].message}</span>
                                </div>
                              )}

                              {/* Discrepancies table (all original, resolved ones dimmed) */}
                              {!isNoMatch && v.discrepancies.length > 0 && (
                                <>
                                  <div className="border border-border rounded-lg overflow-hidden">
                                    <Table>
                                      <TableHeader>
                                        <UITableRow className="bg-muted/50 hover:bg-muted/50">
                                          <TableHead className="text-xs font-semibold text-foreground">Field</TableHead>
                                          <TableHead className="text-xs font-semibold text-foreground">Master (Expected)</TableHead>
                                          <TableHead className="text-xs font-semibold text-foreground">Invoice Value</TableHead>
                                          <TableHead className="text-xs font-semibold text-foreground hidden md:table-cell">Note</TableHead>
                                          <TableHead className="w-32" />
                                        </UITableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {v.discrepancies.map((d: Discrepancy, di: number) => {
                                          const resolved = isResolved(
                                            d,
                                            v.suggested_corrections,
                                            itemEdits
                                          );
                                          return (
                                            <UITableRow
                                              key={di}
                                              className={`hover:bg-muted/30 transition-opacity ${
                                                resolved ? "opacity-50" : ""
                                              }`}
                                            >
                                              <TableCell className="text-sm font-medium py-2">
                                                <span className="flex items-center gap-1.5">
                                                  {resolved && (
                                                    <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                                                  )}
                                                  {fieldLabel(d.field)}
                                                </span>
                                              </TableCell>
                                              <TableCell className="text-sm text-muted-foreground py-2 font-mono">
                                                {d.expected !== null ? String(d.expected) : "—"}
                                              </TableCell>
                                              <TableCell
                                                className="py-2"
                                                onClick={(e) => e.stopPropagation()}
                                              >
                                                <Input
                                                  className={`h-7 text-sm font-mono w-28 ${
                                                    resolved
                                                      ? "border-green-500/50 bg-green-500/5"
                                                      : ""
                                                  }`}
                                                  value={getEditValue(idx, d.field, d.actual)}
                                                  onChange={(e) =>
                                                    setFieldEdit(idx, d.field, e.target.value)
                                                  }
                                                />
                                              </TableCell>
                                              <TableCell className="text-xs text-muted-foreground py-2 max-w-xs hidden md:table-cell">
                                                {d.message}
                                              </TableCell>
                                              <TableCell
                                                className="py-2"
                                                onClick={(e) => e.stopPropagation()}
                                              >
                                                {!resolved &&
                                                  v.suggested_corrections[d.field] !== undefined && (
                                                    <Tooltip>
                                                      <TooltipTrigger asChild>
                                                        <Button
                                                          variant="outline"
                                                          size="sm"
                                                          className="h-7 text-xs gap-1"
                                                          onClick={() =>
                                                            setFieldEdit(
                                                              idx,
                                                              d.field,
                                                              String(v.suggested_corrections[d.field])
                                                            )
                                                          }
                                                        >
                                                          <Wand2 className="w-3 h-3" />
                                                          Use master
                                                        </Button>
                                                      </TooltipTrigger>
                                                      <TooltipContent>
                                                        Apply master value:{" "}
                                                        {String(v.suggested_corrections[d.field])}
                                                      </TooltipContent>
                                                    </Tooltip>
                                                  )}
                                              </TableCell>
                                            </UITableRow>
                                          );
                                        })}
                                      </TableBody>
                                    </Table>
                                  </div>

                                  {/* Apply all — only shown while unresolved corrections remain */}
                                  {effectiveDiscrepancies.length > 0 &&
                                    Object.keys(v.suggested_corrections).length > 0 && (
                                      <div className="flex justify-end">
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="text-xs gap-1"
                                          onClick={() =>
                                            applyAllSuggestions(idx, v.suggested_corrections)
                                          }
                                        >
                                          <Wand2 className="w-3 h-3" />
                                          Apply all suggestions
                                        </Button>
                                      </div>
                                    )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};

export default ValidationResults;
