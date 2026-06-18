import { useState, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight, Users, Database, RefreshCw, PowerOff, Power } from 'lucide-react'
import { api, getUserInfo } from '@/lib/api'
import type { ClientSummary, AdminUser } from '@/types'
import { cn } from '@/lib/utils'
import { useTheme } from '@/contexts/ThemeContext'

type Period = 'all' | '30d'

function fmtDate(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function fmtTime(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  })
}

export default function PartnerOverview() {
  const theme   = useTheme()
  const role    = getUserInfo()?.role
  const showPartner = role === 'superadmin'

  const [data,     setData]     = useState<ClientSummary[]>([])
  const [users,    setUsers]    = useState<AdminUser[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [period,   setPeriod]   = useState<Period>('all')
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  function loadAll() {
    setLoading(true)
    Promise.all([api.myClients(), api.users()])
      .then(([clients, allUsers]) => { setData(clients); setUsers(allUsers) })
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }

  useEffect(loadAll, [])

  async function handleToggleCompany(company: ClientSummary) {
    const next = !company.is_active
    try {
      await api.toggleCompanyActive(company.id, next)
      setData(d => d.map(c => c.id === company.id ? { ...c, is_active: next } : c))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update company status.')
    }
  }

  const usersByCompany = useMemo(() => {
    const map = new Map<string, AdminUser[]>()
    users.forEach(u => {
      if (!u.company_id) return
      const list = map.get(u.company_id) ?? []
      list.push(u)
      map.set(u.company_id, list)
    })
    return map
  }, [users])

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function runVal(c: ClientSummary, k: 'ocr_runs' | 'ocr_credits' | 'val_runs' | 'val_credits') {
    return period === 'all' ? c[k] : c[`${k}_30d`]
  }

  // Column headers — order: identity | integration | usage
  const colHeaders = [
    ...(showPartner ? ['Partner'] : []),
    'Company',
    'Status',
    'Client Code',
    'Credits',
    'Users',
    'Catalog',
    'Sync',
    'Last Synced',
    period === 'all' ? 'OCR Runs'    : 'OCR Runs (30d)',
    period === 'all' ? 'OCR Credits' : 'OCR Credits (30d)',
    period === 'all' ? 'Val Runs'    : 'Val Runs (30d)',
    '',
  ]

  return (
    <div className="p-8 space-y-6 max-w-full">

      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {showPartner ? 'All Client Companies' : 'My Clients'}
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Company overview with integration status — click a row to expand users
          </p>
        </div>

        {/* Period toggle */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1 self-start">
          {(['all', '30d'] as Period[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
                period === p ? theme.activeTabClass : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {p === 'all' ? 'All time' : 'Last 30 days'}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="rounded-xl border border-gray-100 shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-max">
            <thead>
              <tr className={cn('bg-gradient-to-r text-white', theme.tableHeaderGradient)}>
                {/* Expand toggle column */}
                <th className="w-10 px-3 py-3" />
                {colHeaders.map(h => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={colHeaders.length + 1} className="text-center text-sm text-gray-400 py-10">
                    No clients found
                  </td>
                </tr>
              )}

              {data.map((company, i) => {
                const isOpen       = expanded.has(company.id)
                const companyUsers = usersByCompany.get(company.id) ?? []

                return (
                  <tr
                    key={company.id}
                    className={cn('border-t border-gray-100', i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40')}
                  >
                    <td colSpan={colHeaders.length + 1} className="p-0">

                      {/* ── Company summary row ──────────────────────────── */}
                      <div
                        className={cn('flex items-center cursor-pointer transition-colors', theme.rowHover)}
                        onClick={() => toggle(company.id)}
                      >
                        {/* Expand icon */}
                        <div className="w-10 flex-shrink-0 flex items-center justify-center py-3.5 text-gray-400">
                          {isOpen
                            ? <ChevronDown className={cn('h-4 w-4', theme.accentText)} />
                            : <ChevronRight className="h-4 w-4" />}
                        </div>

                        {/* Partner (superadmin only) */}
                        {showPartner && (
                          <div className="px-4 py-3.5 text-gray-500 text-sm min-w-[140px]">
                            {company.partner_name ?? '—'}
                          </div>
                        )}

                        {/* Company name */}
                        <div className="px-4 py-3.5 font-semibold text-gray-900 min-w-[160px]">
                          {company.name}
                        </div>

                        {/* Status */}
                        <div className="px-4 py-3.5 min-w-[110px]">
                          {company.is_active ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600">
                              <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                              Inactive
                            </span>
                          )}
                        </div>

                        {/* Client Code */}
                        <div className="px-4 py-3.5 min-w-[120px]">
                          {company.client_code
                            ? <code className="text-xs font-mono bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded">{company.client_code}</code>
                            : <span className="text-gray-300 text-xs">—</span>
                          }
                        </div>

                        {/* Credits */}
                        <div className="px-4 py-3.5 text-gray-700 font-medium min-w-[90px]">
                          {company.credits.toLocaleString()}
                        </div>

                        {/* Users */}
                        <div className="px-4 py-3.5 text-gray-600 min-w-[70px]">
                          {company.user_count}
                        </div>

                        {/* Catalog */}
                        <div className="px-4 py-3.5 min-w-[100px]">
                          <span className="text-gray-700">{(company.catalog_item_count ?? 0).toLocaleString()}</span>
                          <span className="text-gray-400 text-xs ml-1">items</span>
                        </div>

                        {/* Sync status */}
                        <div className="px-4 py-3.5 min-w-[90px]">
                          {company.sync_enabled ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-400">
                              <span className="h-1.5 w-1.5 rounded-full bg-gray-300" />
                              Off
                            </span>
                          )}
                        </div>

                        {/* Last synced */}
                        <div className="px-4 py-3.5 text-xs min-w-[130px]">
                          {company.last_synced_at ? (
                            <>
                              <span className="text-gray-600 block">{fmtDate(company.last_synced_at)}</span>
                              <span className="text-gray-400 block mt-0.5">{fmtTime(company.last_synced_at)}</span>
                            </>
                          ) : (
                            <span className="text-gray-300">Never</span>
                          )}
                        </div>

                        {/* OCR Runs */}
                        <div className="px-4 py-3.5 text-gray-600 min-w-[110px]">
                          {runVal(company, 'ocr_runs').toLocaleString()}
                        </div>

                        {/* OCR Credits */}
                        <div className="px-4 py-3.5 text-gray-600 min-w-[120px]">
                          {runVal(company, 'ocr_credits').toLocaleString()}
                        </div>

                        {/* Val Runs */}
                        <div className="px-4 py-3.5 text-gray-600 min-w-[110px]">
                          {runVal(company, 'val_runs').toLocaleString()}
                        </div>

                        {/* Toggle active */}
                        <div className="px-4 py-3.5">
                          <button
                            onClick={e => { e.stopPropagation(); handleToggleCompany(company) }}
                            title={company.is_active ? 'Deactivate company' : 'Activate company'}
                            className={`transition-colors ${company.is_active ? 'text-gray-300 hover:text-amber-500' : 'text-gray-300 hover:text-emerald-600'}`}
                          >
                            {company.is_active
                              ? <PowerOff className="h-4 w-4" />
                              : <Power className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>

                      {/* ── Expanded: users accordion ─────────────────────── */}
                      {isOpen && (
                        <div className={cn('border-t-2', theme.accentBorder, theme.accentBg)}>
                          <div className="pl-10 pr-6 py-4">

                            {/* Section: users */}
                            <div className="mb-3">
                              <div className="flex items-center gap-2 mb-2.5">
                                <Users className={cn('h-3.5 w-3.5 flex-shrink-0', theme.accentText)} />
                                <span className={cn('text-xs font-bold', theme.accentTextStrong)}>
                                  Users in {company.name}
                                </span>
                                <span className="text-xs text-gray-400">({companyUsers.length})</span>
                              </div>

                              {companyUsers.length === 0 ? (
                                <p className="text-xs text-gray-400 italic pl-1">No users found</p>
                              ) : (
                                <div className="flex flex-wrap gap-2">
                                  {companyUsers.map(u => (
                                    <span
                                      key={u.id}
                                      className={cn(
                                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-white border text-gray-700 shadow-sm',
                                        theme.accentBorder,
                                      )}
                                    >
                                      <span className="font-medium">{u.username}</span>
                                      <span className={cn(
                                        'font-semibold',
                                        u.role === 'client_admin' ? theme.accentText : 'text-gray-400',
                                      )}>
                                        · {u.role === 'client_admin' ? 'Admin' : 'User'}
                                      </span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Section: quick stats */}
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 pt-3 border-t border-gray-200/60">
                              <div className="bg-white/70 rounded-lg px-3 py-2.5 border border-white">
                                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Status</p>
                                {company.is_active ? (
                                  <p className="text-sm font-bold text-emerald-600">Active</p>
                                ) : (
                                  <p className="text-sm font-bold text-red-500">Inactive</p>
                                )}
                              </div>
                              <div className="bg-white/70 rounded-lg px-3 py-2.5 border border-white">
                                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Credits Left</p>
                                <p className={cn('text-sm font-bold', theme.accentTextStrong)}>
                                  {company.credits.toLocaleString()}
                                </p>
                              </div>
                              <div className="bg-white/70 rounded-lg px-3 py-2.5 border border-white">
                                <p className="flex items-center gap-1 text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">
                                  <Database className="h-3 w-3" /> Catalog
                                </p>
                                <p className={cn('text-sm font-bold', theme.accentTextStrong)}>
                                  {(company.catalog_item_count ?? 0).toLocaleString()}
                                  <span className="text-xs font-normal text-gray-400 ml-1">items</span>
                                </p>
                              </div>
                              <div className="bg-white/70 rounded-lg px-3 py-2.5 border border-white">
                                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">ERP Client Code</p>
                                <p className="text-sm font-bold text-gray-700 font-mono">
                                  {company.client_code ?? <span className="font-sans text-gray-300 font-normal text-xs">Not set</span>}
                                </p>
                              </div>
                              <div className="bg-white/70 rounded-lg px-3 py-2.5 border border-white">
                                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Last Synced</p>
                                {company.last_synced_at ? (
                                  <>
                                    <p className={cn('text-sm font-bold', theme.accentTextStrong)}>
                                      {fmtDate(company.last_synced_at)}
                                    </p>
                                    <p className="text-xs text-gray-500 mt-0.5">
                                      {fmtTime(company.last_synced_at)}
                                    </p>
                                  </>
                                ) : (
                                  <p className="text-gray-300 font-normal text-xs">Never</p>
                                )}
                              </div>
                            </div>

                          </div>
                        </div>
                      )}

                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
