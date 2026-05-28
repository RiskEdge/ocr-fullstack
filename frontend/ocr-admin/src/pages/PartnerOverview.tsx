import { useState, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight, Users } from 'lucide-react'
import { api, getUserInfo } from '@/lib/api'
import type { ClientSummary, AdminUser } from '@/types'
import { cn } from '@/lib/utils'
import { useTheme } from '@/contexts/ThemeContext'

type Period = 'all' | '30d'

export default function PartnerOverview() {
  const [data,     setData]     = useState<ClientSummary[]>([])
  const [users,    setUsers]    = useState<AdminUser[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [period,   setPeriod]   = useState<Period>('all')
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const theme = useTheme()
  const role = getUserInfo()?.role

  useEffect(() => {
    Promise.all([api.myClients(), api.users()])
      .then(([clients, allUsers]) => {
        setData(clients)
        setUsers(allUsers)
      })
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }, [])

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

  const showPartner = role === 'superadmin'

  const colHeaders = [
    ...(showPartner ? ['Partner'] : []),
    'Company', 'Credits', 'Users',
    period === 'all' ? 'OCR Runs' : 'OCR Runs (30d)',
    period === 'all' ? 'OCR Credits' : 'OCR Credits (30d)',
    period === 'all' ? 'Val Runs' : 'Val Runs (30d)',
    period === 'all' ? 'Val Credits' : 'Val Credits (30d)',
  ]

  function runVal(company: ClientSummary, key: 'ocr_runs' | 'ocr_credits' | 'val_runs' | 'val_credits') {
    return period === 'all' ? company[key] : company[`${key}_30d`]
  }

  return (
    <div className="p-8 space-y-6 max-w-full">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {role === 'superadmin' ? 'All Client Companies' : 'My Clients'}
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Usage summary per company — click a row to expand users
          </p>
        </div>

        {/* Period toggle */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setPeriod('all')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
              period === 'all' ? theme.activeTabClass : 'text-gray-500 hover:text-gray-700',
            )}
          >
            All time
          </button>
          <button
            onClick={() => setPeriod('30d')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
              period === '30d' ? theme.activeTabClass : 'text-gray-500 hover:text-gray-700',
            )}
          >
            Last 30 days
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {loading ? (
        <div className="text-sm text-gray-400 py-6">Loading…</div>
      ) : (
        <div className="rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className={cn('bg-gradient-to-r text-white', theme.tableHeaderGradient)}>
                <th className="w-10 px-3 py-3" />
                {colHeaders.map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap">
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
                const isOpen = expanded.has(company.id)
                const companyUsers = usersByCompany.get(company.id) ?? []
                return (
                  <tr
                    key={company.id}
                    className={cn(
                      'border-t border-gray-100',
                      i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40',
                    )}
                  >
                    <td colSpan={colHeaders.length + 1} className="p-0">
                      {/* Company summary row */}
                      <div
                        className={cn('flex items-center cursor-pointer transition-colors', theme.rowHover)}
                        onClick={() => toggle(company.id)}
                      >
                        <div className="w-10 flex-shrink-0 flex items-center justify-center py-3 text-gray-400">
                          {isOpen
                            ? <ChevronDown className={cn('h-4 w-4', theme.accentText)} />
                            : <ChevronRight className="h-4 w-4" />}
                        </div>
                        {showPartner && (
                          <div className="px-4 py-3 text-gray-500 text-sm min-w-[140px]">
                            {company.partner_name ?? '—'}
                          </div>
                        )}
                        <div className="px-4 py-3 font-semibold text-gray-900 min-w-[160px]">{company.name}</div>
                        <div className="px-4 py-3 text-gray-600 min-w-[90px]">{company.credits}</div>
                        <div className="px-4 py-3 text-gray-600 min-w-[70px]">{company.user_count}</div>
                        <div className="px-4 py-3 text-gray-600 min-w-[120px]">{runVal(company, 'ocr_runs')}</div>
                        <div className="px-4 py-3 text-gray-600 min-w-[140px]">{runVal(company, 'ocr_credits')}</div>
                        <div className="px-4 py-3 text-gray-600 min-w-[120px]">{runVal(company, 'val_runs')}</div>
                        <div className="px-4 py-3 text-gray-600">{runVal(company, 'val_credits')}</div>
                      </div>

                      {/* Accordion — users */}
                      {isOpen && (
                        <div className={cn('border-t-2', theme.accentBorder, theme.accentBg)}>
                          <div className="pl-10 pr-6 py-3">
                            <div className="flex items-center gap-2 mb-2.5">
                              <Users className={cn('h-3.5 w-3.5 flex-shrink-0', theme.accentText)} />
                              <span className={cn('text-xs font-bold', theme.accentTextStrong)}>
                                Users in {company.name}
                              </span>
                              <span className="text-xs text-gray-400">
                                ({companyUsers.length})
                              </span>
                            </div>
                            {companyUsers.length === 0 ? (
                              <p className="text-xs text-gray-400 italic pl-1">No users found</p>
                            ) : (
                              <div className="flex flex-wrap gap-2">
                                {companyUsers.map(u => (
                                  <span
                                    key={u.id}
                                    className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-white border text-gray-700 shadow-sm', theme.accentBorder)}
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
