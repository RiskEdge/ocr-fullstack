import { useState, useEffect, useMemo } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useTheme } from '@/contexts/ThemeContext'
import type { LoginEvent, LoginEventFilters } from '@/types'
import DataTable, { type Column } from '@/components/DataTable'
import { formatDate, cn } from '@/lib/utils'

function SuccessBadge({ success }: { success: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold',
      success ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700',
    )}>
      {success ? 'Success' : 'Failed'}
    </span>
  )
}

function TypeBadge({ loginType }: { loginType: string }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold',
      loginType === 'global' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700',
    )}>
      {loginType}
    </span>
  )
}

const labelCls = 'text-xs text-gray-400 font-medium whitespace-nowrap'

export default function LoginEvents() {
  const theme = useTheme()
  const inputCls = `px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 ${theme.focusRing} focus:border-transparent transition-colors`
  const [data,          setData]          = useState<LoginEvent[]>([])
  const [serverFilters, setServerFilters] = useState<LoginEventFilters>({})
  const [userFilter,    setUserFilter]    = useState('')
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    // TODO: server-side pagination. Currently fetches the 500 most-recent events and
    // pages them client-side in DataTable. The endpoint already accepts offset/limit +
    // returns total — switch to offset-based paging if login volume exceeds 500/window.
    api.loginEvents(serverFilters)
      .then(res => setData(res.events))
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }, [serverFilters])

  const userOptions = useMemo(
    () => [...new Set(data.map(r => r.username))].sort(),
    [data],
  )

  const filteredData = useMemo(
    () => data.filter(r => !userFilter || r.username === userFilter),
    [data, userFilter],
  )

  const columns: Column<LoginEvent>[] = [
    { key: 'username', header: 'User', sortable: true },
    { key: 'company_name', header: 'Company', sortable: true, render: r => r.company_name ?? '—' },
    { key: 'role', header: 'Role', sortable: true, render: r => r.role ?? '—' },
    { key: 'login_type', header: 'Type', sortable: true, render: r => <TypeBadge loginType={r.login_type} /> },
    { key: 'success', header: 'Result', sortable: true, render: r => <SuccessBadge success={r.success} /> },
    { key: 'failure_reason', header: 'Reason', sortable: true, render: r => r.failure_reason ?? '—' },
    { key: 'ip_address', header: 'IP', sortable: true, render: r => r.ip_address ?? '—' },
    {
      key: 'user_agent',
      header: 'User Agent',
      render: r => (
        <span className="block max-w-[220px] truncate text-gray-500" title={r.user_agent ?? ''}>
          {r.user_agent ?? '—'}
        </span>
      ),
    },
    { key: 'created_at', header: 'When', sortable: true, render: r => formatDate(r.created_at) },
  ]

  const hasFilters = !!(
    serverFilters.from_date || serverFilters.to_date || serverFilters.role ||
    serverFilters.login_type || serverFilters.success !== undefined || userFilter
  )

  function clearAll() {
    setServerFilters({})
    setUserFilter('')
  }

  return (
    <div className="p-8 space-y-6 max-w-full">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Login Activity</h1>
        <p className="text-sm text-gray-400 mt-0.5">Audit log of all user &amp; admin sign-ins</p>
      </div>

      <div className="bg-white rounded-lg border border-gray-100 shadow-sm px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-gray-400 font-medium">
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </div>

          {/* Date range */}
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={serverFilters.from_date ?? ''}
              onChange={e => setServerFilters(f => ({ ...f, from_date: e.target.value || undefined }))}
              className={inputCls}
            />
            <span className="text-gray-300 text-sm">→</span>
            <input
              type="date"
              value={serverFilters.to_date ?? ''}
              onChange={e => setServerFilters(f => ({ ...f, to_date: e.target.value || undefined }))}
              className={inputCls}
            />
          </div>

          {/* Login type */}
          <div className="flex items-center gap-1.5">
            <span className={labelCls}>Type</span>
            <select
              value={serverFilters.login_type ?? ''}
              onChange={e => setServerFilters(f => ({ ...f, login_type: (e.target.value || undefined) as LoginEventFilters['login_type'] }))}
              className={inputCls}
            >
              <option value="">All</option>
              <option value="company">Company</option>
              <option value="global">Global</option>
            </select>
          </div>

          {/* Role */}
          <div className="flex items-center gap-1.5">
            <span className={labelCls}>Role</span>
            <select
              value={serverFilters.role ?? ''}
              onChange={e => setServerFilters(f => ({ ...f, role: e.target.value || undefined }))}
              className={inputCls}
            >
              <option value="">All</option>
              <option value="superadmin">Superadmin</option>
              <option value="partner_admin">Partner admin</option>
              <option value="client_admin">Client admin</option>
              <option value="user">User</option>
            </select>
          </div>

          {/* Result */}
          <div className="flex items-center gap-1.5">
            <span className={labelCls}>Result</span>
            <select
              value={serverFilters.success === undefined ? '' : String(serverFilters.success)}
              onChange={e => setServerFilters(f => ({
                ...f,
                success: e.target.value === '' ? undefined : e.target.value === 'true',
              }))}
              className={inputCls}
            >
              <option value="">All</option>
              <option value="true">Success</option>
              <option value="false">Failed</option>
            </select>
          </div>

          {/* User (client-side) */}
          <div className="flex items-center gap-1.5">
            <span className={labelCls}>User</span>
            <select
              value={userFilter}
              onChange={e => setUserFilter(e.target.value)}
              className={inputCls}
            >
              <option value="">All</option>
              {userOptions.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>

          {hasFilters && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 hover:text-red-500 hover:bg-red-50 border border-gray-200 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      <DataTable columns={columns} data={filteredData} filename="login-events" isLoading={loading} headerGradient={theme.tableHeaderGradient} />
    </div>
  )
}
