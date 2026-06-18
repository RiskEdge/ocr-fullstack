import { useState, useEffect, useMemo } from 'react'
import { Trash2, Plus, SlidersHorizontal, X, PowerOff, Power } from 'lucide-react'
import { api, getUserInfo } from '@/lib/api'
import { useTheme } from '@/contexts/ThemeContext'
import type { AdminUser, Company } from '@/types'
import DataTable, { type Column } from '@/components/DataTable'

const labelCls = 'text-xs text-gray-400 font-medium whitespace-nowrap'

const ROLE_LABELS: Record<string, string> = {
  user:          'User',
  client_admin:  'Company Admin',
  partner_admin: 'Partner Admin',
}

export default function Users() {
  const [data,          setData]          = useState<AdminUser[]>([])
  const [roleFilter,    setRoleFilter]    = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')
  const [showForm,      setShowForm]      = useState(false)
  const [uname,         setUname]         = useState('')
  const [pass,          setPass]          = useState('')
  const [role,          setRole]          = useState<'user' | 'client_admin'>('user')
  const [companyId,     setCompanyId]     = useState('')
  const [companies,     setCompanies]     = useState<Company[]>([])
  const [saving,        setSaving]        = useState(false)
  const [formErr,       setFormErr]       = useState('')

  const currentUser = getUserInfo()
  const theme = useTheme()
  const inputCls  = `w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 ${theme.focusRing} focus:border-transparent transition-colors`
  const filterCls = `px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 ${theme.focusRing} focus:border-transparent transition-colors`
  const canManage        = currentUser?.role === 'client_admin' || currentUser?.role === 'superadmin'
  const showCompany      = currentUser?.role !== 'client_admin'
  const showFilters      = showCompany
  const needsCompanyPick = currentUser?.role === 'superadmin'

  async function openForm() {
    setShowForm(f => !f)
    if (needsCompanyPick && companies.length === 0) {
      try {
        const list = await api.allCompanies()
        setCompanies(list.filter(c => c.is_active))
      } catch {
        // non-fatal — user can still see the dropdown empty
      }
    }
  }

  function loadData() {
    setLoading(true)
    api.users()
      .then(rows => setData(rows.filter(u => u.username !== currentUser?.username)))
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }

  useEffect(loadData, [])

  const roleOptions = useMemo(
    () => [...new Set(data.map(u => u.role))].sort(),
    [data],
  )

  const companyOptions = useMemo(
    () => [...new Set(data.map(u => u.company_name).filter(n => n && n !== '—'))].sort(),
    [data],
  )

  const filteredData = useMemo(
    () => data.filter(u =>
      (!roleFilter    || u.role         === roleFilter) &&
      (!companyFilter || u.company_name === companyFilter)
    ),
    [data, roleFilter, companyFilter],
  )

  const hasFilters = !!(roleFilter || companyFilter)

  async function handleDelete(userId: string) {
    if (!confirm('Delete this user?')) return
    try {
      await api.deleteUser(userId)
      setData(d => d.filter(u => u.id !== userId))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete user.')
    }
  }

  async function handleToggleActive(user: AdminUser) {
    const next = !user.is_active
    try {
      await api.toggleUserActive(user.id, next)
      setData(d => d.map(u => u.id === user.id ? { ...u, is_active: next } : u))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update user status.')
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormErr('')
    setSaving(true)
    try {
      await api.createUser({
        username: uname.trim(),
        password: pass,
        role,
        ...(needsCompanyPick && companyId ? { company_id: companyId } : {}),
      })
      setUname(''); setPass(''); setRole('user'); setCompanyId(''); setShowForm(false)
      loadData()
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : 'Failed to create user.')
    } finally {
      setSaving(false)
    }
  }

  const baseColumns: Column<AdminUser>[] = [
    { key: 'username', header: 'Username', sortable: true },
    {
      key: 'role', header: 'Role', sortable: true,
      render: row => ROLE_LABELS[row.role] ?? row.role,
    },
    ...(showCompany ? [{ key: 'company_name', header: 'Company', sortable: true } as Column<AdminUser>] : []),
    {
      key: 'is_active', header: 'Status', sortable: true,
      render: row => row.is_active
        ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600">
            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
            Inactive
          </span>
        ),
    },
    { key: 'id', header: 'User ID', sortable: false },
  ]

  const columns: Column<AdminUser>[] = canManage
    ? [
        ...baseColumns,
        {
          key: '_actions' as keyof AdminUser,
          header: '',
          sortable: false,
          render: row => (
            <div className="flex items-center gap-4">
              <button
                onClick={() => handleToggleActive(row)}
                title={row.is_active ? 'Deactivate user' : 'Activate user'}
                className={`transition-colors ${row.is_active ? 'text-gray-300 hover:text-amber-500' : 'text-gray-300 hover:text-emerald-600'}`}
              >
                {row.is_active
                  ? <PowerOff className="h-4 w-4" />
                  : <Power className="h-4 w-4" />}
              </button>
              <button
                onClick={() => handleDelete(row.id)}
                className="text-gray-300 hover:text-red-500 transition-colors"
                title="Delete user"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ),
        },
      ]
    : baseColumns

  return (
    <div className="p-8 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Users</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {currentUser?.role === 'client_admin' ? 'Users in your company' : 'All users'}
          </p>
        </div>
        {canManage && (
          <button
            onClick={openForm}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${theme.primaryBtn}`}
          >
            <Plus className="h-4 w-4" />
            New User
          </button>
        )}
      </div>

      {/* Filters — shown for superadmin / partner_admin */}
      {showFilters && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-gray-400 font-medium">
              <SlidersHorizontal className="h-4 w-4" />
              Filters
            </div>

            <div className="flex items-center gap-1.5">
              <span className={labelCls}>Role</span>
              <select
                value={roleFilter}
                onChange={e => setRoleFilter(e.target.value)}
                className={filterCls}
              >
                <option value="">All</option>
                {roleOptions.map(r => (
                  <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className={labelCls}>Company</span>
              <select
                value={companyFilter}
                onChange={e => setCompanyFilter(e.target.value)}
                className={filterCls}
              >
                <option value="">All</option>
                {companyOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {hasFilters && (
              <button
                onClick={() => { setRoleFilter(''); setCompanyFilter('') }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 hover:text-red-500 hover:bg-red-50 border border-gray-200 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {showForm && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Create User</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Username *</label>
                <input value={uname} onChange={e => setUname(e.target.value)} required placeholder="username" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Password *</label>
                <input type="password" value={pass} onChange={e => setPass(e.target.value)} required placeholder="••••••••" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Role</label>
                <select value={role} onChange={e => setRole(e.target.value as 'user' | 'client_admin')} className={inputCls}>
                  <option value="user">User</option>
                  <option value="client_admin">Company Admin</option>
                </select>
              </div>
              {needsCompanyPick && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Company *</label>
                  <select
                    value={companyId}
                    onChange={e => setCompanyId(e.target.value)}
                    required
                    className={inputCls}
                  >
                    <option value="">Select company…</option>
                    {companies.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {formErr && <p className="text-xs text-red-500">{formErr}</p>}
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={saving || !uname.trim() || !pass || (needsCompanyPick && !companyId)}
                className={`px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors ${theme.primaryBtn}`}>
                {saving ? 'Saving…' : 'Create'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setCompanyId('') }}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
      <DataTable columns={columns} data={filteredData} filename="users" isLoading={loading} headerGradient={theme.tableHeaderGradient} />
    </div>
  )
}
