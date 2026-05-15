import { useState, useEffect } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { api, getUserInfo } from '@/lib/api'
import type { ProcessingRun, AdminUser, RunFilters } from '@/types'
import DataTable, { type Column } from '@/components/DataTable'
import { formatDate, formatDuration, cn } from '@/lib/utils'

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold',
      status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
      status === 'failed'    ? 'bg-red-100 text-red-700' :
                               'bg-amber-100 text-amber-700',
    )}>
      {status}
    </span>
  )
}

const inputCls = 'px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sky-400 focus:border-transparent transition-colors'

export default function ProcessingRuns() {
  const [data,    setData]    = useState<ProcessingRun[]>([])
  const [users,   setUsers]   = useState<AdminUser[]>([])
  const [filters, setFilters] = useState<RunFilters>({})
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const role = getUserInfo()?.role
  const showCompany = role === 'superadmin' || role === 'partner_admin'

  useEffect(() => { api.users().then(setUsers).catch(() => {}) }, [])

  useEffect(() => {
    setLoading(true)
    setError('')
    api.processingRuns(filters)
      .then(setData)
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }, [filters])

  const columns: Column<ProcessingRun>[] = [
    { key: 'username', header: 'User', sortable: true },
    ...(showCompany ? [{ key: 'company_name' as const, header: 'Company', sortable: true }] : []),
    { key: 'total_files',            header: 'Files',    sortable: true },
    { key: 'successful_files',       header: 'Success',  sortable: true },
    { key: 'failed_files',           header: 'Failed',   sortable: true },
    { key: 'total_pages',            header: 'Pages',    sortable: true },
    { key: 'total_fields_extracted', header: 'Fields',   sortable: true },
    { key: 'credits_used',           header: 'Credits',  sortable: true },
    {
      key: 'total_duration_ms',
      header: 'Duration',
      sortable: true,
      render: row => formatDuration(row.total_duration_ms),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: row => <StatusBadge status={row.status} />,
    },
    {
      key: 'started_at',
      header: 'Started',
      sortable: true,
      render: row => formatDate(row.started_at),
    },
    { key: 'environment', header: 'Env', sortable: true },
  ]

  const hasFilters = !!(filters.from_date || filters.to_date || filters.username)

  return (
    <div className="p-8 space-y-6 max-w-full">
      <div>
        <h1 className="text-xl font-bold text-gray-900">OCR Runs</h1>
        <p className="text-sm text-gray-400 mt-0.5">Document processing activity</p>
      </div>

      <div className="bg-white rounded-lg border border-gray-100 shadow-sm px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-gray-400 font-medium">
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={filters.from_date ?? ''}
              onChange={e => setFilters(f => ({ ...f, from_date: e.target.value || undefined }))}
              className={inputCls}
            />
            <span className="text-gray-300 text-sm">→</span>
            <input
              type="date"
              value={filters.to_date ?? ''}
              onChange={e => setFilters(f => ({ ...f, to_date: e.target.value || undefined }))}
              className={inputCls}
            />
          </div>
          <select
            value={filters.username ?? ''}
            onChange={e => setFilters(f => ({ ...f, username: e.target.value || undefined }))}
            className={inputCls}
          >
            <option value="">All users</option>
            {users.map(u => <option key={u.id} value={u.username}>{u.username}</option>)}
          </select>
          {hasFilters && (
            <button
              onClick={() => setFilters({})}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 hover:text-red-500 hover:bg-red-50 border border-gray-200 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      <DataTable columns={columns} data={data} filename="ocr-runs" isLoading={loading} headerGradient="from-sky-500 to-indigo-600" />
    </div>
  )
}
