import { useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { searchCatalog, type PluOption } from "@/lib/validateApi";

// Keystrokes closer together than this share one request — the user is still
// typing, and a request per character is a request the next one cancels.
const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

function fmt(val: unknown): string {
  if (val === null || val === undefined || val === "") return "—";
  return String(val);
}

/**
 * Catalog typeahead for a line the validation left unmatched — or matched to
 * the wrong record. Suggestions appear as the user types; picking one hands
 * the catalog row back as a PluOption, the same shape the multi-PLU picker
 * feeds selectPlu(), so everything downstream (local compare, derived cost,
 * summary counts, CSV) treats it as any other pick.
 */
export default function CatalogSearch({
  onSelect,
  placeholder = "Search the catalogue by name, PLU or EAN…",
  autoFocus = false,
}: {
  onSelect: (opt: PluOption) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PluOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      abortRef.current?.abort();
      setResults([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      searchCatalog(q, controller.signal)
        .then((opts) => {
          if (controller.signal.aborted) return;
          setResults(opts);
          setActive(0);
          setOpen(true);
          setLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setResults([]);
          setFailed(true);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Close on an outside click, the way a native dropdown does.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (opt: PluOption) => {
    abortRef.current?.abort();
    setOpen(false);
    setQuery("");
    setResults([]);
    onSelect(opt);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) {
      if (e.key === "Escape") setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showList = open && query.trim().length >= MIN_CHARS;

  return (
    <div
      ref={rootRef}
      className="relative"
      // The row behind this toggles its expansion on click.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label="Search the catalogue"
          aria-autocomplete="list"
          aria-expanded={showList}
          className="h-8 pl-8 pr-8 text-sm"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      {showList && (
        <div
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-md border border-border bg-popover shadow-md"
        >
          {failed ? (
            <p className="px-3 py-2 text-xs text-destructive">
              Catalogue search failed. Try again.
            </p>
          ) : results.length === 0 && !loading ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No catalogue products match “{query.trim()}”.
            </p>
          ) : (
            results.map((opt, i) => (
              <div
                key={`${opt.plu_code}-${i}`}
                role="option"
                aria-selected={i === active}
                data-testid="catalog-result"
                className={`flex items-center gap-3 px-3 py-1.5 text-xs cursor-pointer border-b border-border last:border-b-0 ${
                  i === active ? "bg-accent" : "hover:bg-muted/50"
                }`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  // Before the input's blur, so the list is still mounted.
                  e.preventDefault();
                  pick(opt);
                }}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground truncate">
                    {fmt(opt.sku_desc)}
                  </p>
                  <p className="text-muted-foreground font-mono truncate">
                    PLU {fmt(opt.plu_code)}
                    {opt.ean_code ? ` · EAN ${opt.ean_code}` : ""}
                    {opt.uom ? ` · ${opt.uom}` : ""}
                    {opt.uom_qty ? ` × ${opt.uom_qty}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right text-muted-foreground whitespace-nowrap">
                  <p>MRP {fmt(opt.mrp)}</p>
                  <p>Cost {fmt(opt.cost_price)}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs shrink-0"
                  tabIndex={-1}
                >
                  Select
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
