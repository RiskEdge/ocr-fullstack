import { useState, useMemo } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, Download, FileSpreadsheet } from 'lucide-react'
import { cn } from '@/lib/utils'
import { exportToCsv, exportToExcel, type ExportColumn } from '@/lib/export'
import { useTheme } from '@/contexts/ThemeContext'

export interface Column<T> {
  key: string
  header: string
  render?: (row: T) => React.ReactNode
  sortable?: boolean
  className?: string
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  filename?: string
  isLoading?: boolean
  pageSize?: number
  headerGradient?: string
  showTotals?: boolean
}

const DEFAULT_PAGE_SIZE = 25

export default function DataTable<T>({
  columns,
  data,
  filename = 'export',
  isLoading = false,
  pageSize = DEFAULT_PAGE_SIZE,
  headerGradient = 'from-gray-700 to-gray-900',
  showTotals = false,
}: DataTableProps<T>) {
  const theme = useTheme()
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage]       = useState(0)

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
    setPage(0)
  }

  const sorted = useMemo(() => {
    if (!sortKey) return data
    return [...data].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey] ?? ''
      const bv = (b as Record<string, unknown>)[sortKey] ?? ''
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data, sortKey, sortDir])

  const totalPages = Math.ceil(sorted.length / pageSize)
  const paginated  = sorted.slice(page * pageSize, (page + 1) * pageSize)

  const totalsRow = useMemo(() => {
    if (!showTotals || data.length === 0) return null
    const result: Record<string, unknown> = {}
    let firstLabelDone = false
    for (const col of columns) {
      const vals = data.map((row) => (row as Record<string, unknown>)[col.key])
      const allNumeric = vals.every((v) => v == null || typeof v === 'number')
      if (allNumeric) {
        result[col.key] = vals.reduce((sum, v) => (sum as number) + (Number(v) || 0), 0)
      } else if (!firstLabelDone) {
        result[col.key] = 'Total'
        firstLabelDone = true
      } else {
        result[col.key] = ''
      }
    }
    return result
  }, [showTotals, data, columns])

  const exportCols: ExportColumn[] = columns.map(c => ({ key: c.key, header: c.header }))
  const exportData = data as unknown as Record<string, unknown>[]

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm flex items-center justify-center h-48">
        <div className="flex flex-col items-center gap-3">
          <div className={cn('w-8 h-8 border-2 border-t-transparent rounded-full animate-spin', theme.spinner)} />
          <p className="text-sm text-gray-400">Loading…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          <span className="font-semibold text-gray-700">{data.length.toLocaleString()}</span> rows
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => exportToCsv(filename, exportCols, exportData)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-white border border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50 transition-colors shadow-sm"
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </button>
          <button
            onClick={() => { void exportToExcel(filename, exportCols, exportData) }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors shadow-sm"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Excel
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-100 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className={`bg-gradient-to-r ${headerGradient}`}>
              {columns.map(col => (
                <th
                  key={col.key}
                  onClick={() => col.sortable && handleSort(col.key)}
                  className={cn(
                    'px-4 py-3.5 text-left text-xs font-semibold text-white/90 uppercase tracking-wider whitespace-nowrap',
                    col.sortable && 'cursor-pointer select-none hover:text-white',
                    col.className,
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {col.header}
                    {col.sortable && (
                      sortKey === col.key ? (
                        sortDir === 'asc'
                          ? <ChevronUp className="h-3.5 w-3.5 text-white" />
                          : <ChevronDown className="h-3.5 w-3.5 text-white" />
                      ) : (
                        <ChevronsUpDown className="h-3.5 w-3.5 text-white/40" />
                      )
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-50">
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-16 text-center text-sm text-gray-400">
                  No data found
                </td>
              </tr>
            ) : (
              paginated.map((row, i) => (
                <tr
                  key={i}
                  className={cn(
                    'transition-colors', theme.rowHover,
                    i % 2 !== 0 && 'bg-gray-50/50',
                  )}
                >
                  {columns.map(col => (
                    <td
                      key={col.key}
                      className={cn('px-4 py-3 text-gray-700 whitespace-nowrap', col.className)}
                    >
                      {col.render
                        ? col.render(row)
                        : String((row as Record<string, unknown>)[col.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))
            )}
            {totalsRow && (
              <tr className="bg-gray-100 border-t-2 border-gray-300">
                {columns.map((col) => {
                  const val = totalsRow[col.key]
                  const isLabel = val === 'Total'
                  return (
                    <td
                      key={col.key}
                      className={cn(
                        'px-4 py-3 whitespace-nowrap font-bold',
                        isLabel ? 'text-gray-500 uppercase tracking-wide text-xs' : 'text-gray-900',
                        col.className,
                      )}
                    >
                      {typeof val === 'number'
                        ? val.toLocaleString()
                        : String(val ?? '')}
                    </td>
                  )
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500 px-1">
          <span>
            {(page * pageSize + 1).toLocaleString()}–
            {Math.min((page + 1) * pageSize, sorted.length).toLocaleString()} of{' '}
            {sorted.length.toLocaleString()}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              disabled={page === 0}
              onClick={() => setPage(p => p - 1)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 bg-white disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              ← Prev
            </button>
            <span className={cn('px-3 py-1.5 text-xs font-semibold bg-gradient-to-r text-white rounded-lg', theme.paginationGradient)}>
              {page + 1} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 bg-white disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
