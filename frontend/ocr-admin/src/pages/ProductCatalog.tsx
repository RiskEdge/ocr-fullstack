import { useState, useEffect, useRef } from 'react'
import { Search, Package, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import type { CatalogItem } from '@/types'
import { cn } from '@/lib/utils'
import { useTheme } from '@/contexts/ThemeContext'

const PAGE_SIZE = 50

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—'
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

const COLUMNS: { key: keyof CatalogItem | '_row'; label: string }[] = [
  { key: 'plu_code',        label: 'PLU Code'    },
  { key: 'sku_code',        label: 'SKU Code'    },
  { key: 'ean_code',        label: 'EAN'         },
  { key: 'sku_description', label: 'Description' },
  { key: 'mrp',             label: 'MRP'         },
  { key: 'cost_price',      label: 'Cost Price'  },
  { key: 'gst_percent',     label: 'GST %'       },
  { key: 'uom',             label: 'UoM'         },
  { key: 'uom_qty',         label: 'UoM Qty'     },
  { key: 'status',          label: 'Status'      },
  { key: 'synced_at',       label: 'Synced'      },
]

function Cell({ item, colKey }: { item: CatalogItem; colKey: keyof CatalogItem | '_row' }) {
  switch (colKey) {
    case 'mrp':
      return item.mrp != null
        ? <span className="font-medium text-gray-800">₹{fmt(item.mrp)}</span>
        : <span className="text-gray-300">—</span>

    case 'cost_price':
      return item.cost_price != null
        ? <span className="text-gray-600">₹{fmt(item.cost_price)}</span>
        : <span className="text-gray-300">—</span>

    case 'gst_percent':
      return item.gst_percent != null
        ? <span className="text-gray-600">{fmt(item.gst_percent, 1)}%</span>
        : <span className="text-gray-300">—</span>

    case 'status': {
      const active = item.status == null || item.status === '0'
      return (
        <span className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
          active ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-400',
        )}>
          <span className={cn('h-1.5 w-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-gray-300')} />
          {active ? 'Active' : 'Inactive'}
        </span>
      )
    }

    case 'synced_at':
      return <span className="text-xs text-gray-400">{fmtDate(item.synced_at)}</span>

    case 'sku_description':
      return item.sku_description
        ? (
          <span className="block max-w-[260px] truncate text-gray-700" title={item.sku_description}>
            {item.sku_description}
          </span>
        )
        : <span className="text-gray-300">—</span>

    case 'plu_code':
      return <code className="text-xs font-mono text-gray-800 bg-gray-100 px-1.5 py-0.5 rounded">{item.plu_code}</code>

    default: {
      const val = item[colKey as keyof CatalogItem]
      return val != null
        ? <code className="text-xs font-mono text-gray-700">{String(val)}</code>
        : <span className="text-gray-300">—</span>
    }
  }
}

export default function ProductCatalog() {
  const theme = useTheme()
  const [items,   setItems]   = useState<CatalogItem[]>([])
  const [total,   setTotal]   = useState(0)
  const [search,  setSearch]  = useState('')
  const [page,    setPage]    = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function load(q: string, p: number) {
    setLoading(true)
    setError('')
    api.productCatalog({ search: q.trim() || undefined, limit: PAGE_SIZE, offset: p * PAGE_SIZE })
      .then(data => { setItems(data.items); setTotal(data.total) })
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load('', 0) }, [])

  function handleSearch(val: string) {
    setSearch(val)
    setPage(0)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load(val, 0), 300)
  }

  function goTo(p: number) {
    setPage(p)
    load(search, p)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const fromItem   = total === 0 ? 0 : page * PAGE_SIZE + 1
  const toItem     = Math.min((page + 1) * PAGE_SIZE, total)

  return (
    <div className="p-8 space-y-6 max-w-full">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <Package className={cn('h-5 w-5', theme.accentText)} />
            <h1 className="text-xl font-bold text-gray-900">Product Catalog</h1>
            {!loading && (
              <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold', theme.badge)}>
                {total.toLocaleString()} items
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-0.5 pl-7">
            Master product data synced from your ERP system
          </p>
        </div>

        {/* Search */}
        <div className="relative self-start">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search PLU, SKU, EAN or description…"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            className={cn(
              'pl-9 pr-4 py-2 w-72 rounded-lg border border-gray-200 text-sm bg-white',
              'focus:outline-none focus:ring-2', theme.focusRing,
              'placeholder:text-gray-400',
            )}
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* Table */}
      <div className="rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-max">
          <thead>
            <tr className={cn('bg-gradient-to-r text-white', theme.tableHeaderGradient)}>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide w-12">#</th>
              {COLUMNS.map(c => (
                <th key={c.key} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="py-16 text-center">
                  <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Loading catalog…
                  </div>
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="py-16 text-center">
                  <Package className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-400">
                    {search.trim()
                      ? 'No items match your search.'
                      : 'No catalog items found. Sync your ERP data to get started.'}
                  </p>
                </td>
              </tr>
            ) : (
              items.map((item, i) => (
                <tr
                  key={item.id}
                  className={cn(
                    'border-t border-gray-100 transition-colors',
                    theme.rowHover,
                    i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40',
                  )}
                >
                  <td className="px-4 py-3 text-gray-400 text-xs tabular-nums">
                    {page * PAGE_SIZE + i + 1}
                  </td>
                  {COLUMNS.map(c => (
                    <td key={c.key} className="px-4 py-3 whitespace-nowrap">
                      <Cell item={item} colKey={c.key} />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {!loading && total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Showing{' '}
            <span className="font-medium">{fromItem.toLocaleString()}</span>–<span className="font-medium">{toItem.toLocaleString()}</span>
            {' '}of{' '}
            <span className="font-medium">{total.toLocaleString()}</span> items
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => goTo(page - 1)}
              disabled={page === 0}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border',
                page === 0
                  ? 'border-gray-100 text-gray-300 cursor-not-allowed'
                  : cn('border-gray-200 text-gray-600 hover:bg-gray-50', theme.hoverAccentText),
              )}
            >
              <ChevronLeft className="h-4 w-4" />
              Prev
            </button>
            <span className="text-sm text-gray-500 px-2">
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => goTo(page + 1)}
              disabled={page >= totalPages - 1}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border',
                page >= totalPages - 1
                  ? 'border-gray-100 text-gray-300 cursor-not-allowed'
                  : cn('border-gray-200 text-gray-600 hover:bg-gray-50', theme.hoverAccentText),
              )}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
