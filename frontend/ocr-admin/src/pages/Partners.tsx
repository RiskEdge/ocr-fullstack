import { useState, useEffect } from 'react'
import { Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { useTheme } from '@/contexts/ThemeContext'
import type { Partner } from '@/types'
import DataTable, { type Column } from '@/components/DataTable'

const columns: Column<Partner>[] = [
  { key: 'name',          header: 'Partner Name',   sortable: true },
  { key: 'contact_email', header: 'Email',          sortable: true, render: r => r.contact_email ?? '—' },
  { key: 'company_count', header: 'Companies',      sortable: true },
  {
    key: 'is_active', header: 'Status', sortable: true,
    render: r => (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
        r.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
      }`}>
        {r.is_active ? 'Active' : 'Inactive'}
      </span>
    ),
  },
  {
    key: 'created_at', header: 'Created', sortable: true,
    render: r => new Date(r.created_at).toLocaleDateString(),
  },
]

export default function Partners() {
  const theme = useTheme()
  const inputCls = `w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 ${theme.focusRing} focus:border-transparent transition-colors`
  const [data,    setData]    = useState<Partner[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [showForm, setShowForm] = useState(false)
  const [name,    setName]    = useState('')
  const [email,   setEmail]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [formErr, setFormErr] = useState('')

  function loadData() {
    setLoading(true)
    api.partners()
      .then(setData)
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }

  useEffect(loadData, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormErr('')
    setSaving(true)
    try {
      await api.createPartner({ name: name.trim(), contact_email: email.trim() || undefined })
      setName(''); setEmail(''); setShowForm(false)
      loadData()
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : 'Failed to create partner.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-8 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Partners</h1>
          <p className="text-sm text-gray-400 mt-0.5">Manage partner organisations</p>
        </div>
        <button
          onClick={() => setShowForm(f => !f)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${theme.primaryBtn}`}
        >
          <Plus className="h-4 w-4" />
          New Partner
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Create Partner</h2>
          <form onSubmit={handleCreate} className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-44">
              <label className="block text-xs text-gray-500 mb-1">Partner Name *</label>
              <input value={name} onChange={e => setName(e.target.value)} required placeholder="Acme Partners" className={inputCls} />
            </div>
            <div className="flex-1 min-w-44">
              <label className="block text-xs text-gray-500 mb-1">Contact Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="contact@acme.com" className={inputCls} />
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={saving || !name.trim()}
                className={`px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors ${theme.primaryBtn}`}>
                {saving ? 'Saving…' : 'Create'}
              </button>
              <button type="button" onClick={() => setShowForm(false)}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                Cancel
              </button>
            </div>
            {formErr && <p className="w-full text-xs text-red-500">{formErr}</p>}
          </form>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
      <DataTable columns={columns} data={data} filename="partners" isLoading={loading} headerGradient={theme.tableHeaderGradient} />
    </div>
  )
}
