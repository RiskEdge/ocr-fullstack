import { useState, useEffect } from 'react'
import { Plus, Pencil, Check, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { Company, Partner } from '@/types'
import DataTable, { type Column } from '@/components/DataTable'

const inputCls = 'px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition-colors'

function CreditsCell({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [val,     setVal]     = useState(String(company.credits))
  const [saving,  setSaving]  = useState(false)

  async function save() {
    const n = parseInt(val, 10)
    if (isNaN(n) || n < 0) return
    setSaving(true)
    try {
      await api.updateCredits(company.id, n)
      setEditing(false)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  if (editing) return (
    <div className="flex items-center gap-1">
      <input
        type="number" min={0} value={val}
        onChange={e => setVal(e.target.value)}
        className="w-20 px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
      />
      <button onClick={save} disabled={saving} className="text-emerald-600 hover:text-emerald-700"><Check className="h-4 w-4" /></button>
      <button onClick={() => { setEditing(false); setVal(String(company.credits)) }} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
    </div>
  )

  return (
    <div className="flex items-center gap-2">
      <span>{company.credits.toLocaleString()}</span>
      <button onClick={() => setEditing(true)} className="text-gray-300 hover:text-indigo-500 transition-colors"><Pencil className="h-3.5 w-3.5" /></button>
    </div>
  )
}

export default function AllCompanies() {
  const [data,     setData]     = useState<Company[]>([])
  const [partners, setPartners] = useState<Partner[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [showForm, setShowForm] = useState(false)
  const [name,     setName]     = useState('')
  const [partnerId, setPartnerId] = useState('')
  const [initCredits, setInitCredits] = useState('100')
  const [saving,   setSaving]   = useState(false)
  const [formErr,  setFormErr]  = useState('')

  function loadData() {
    setLoading(true)
    Promise.all([api.allCompanies(), api.partners()])
      .then(([c, p]) => { setData(c); setPartners(p) })
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }

  useEffect(loadData, [])

  const columns: Column<Company>[] = [
    { key: 'name',        header: 'Company',    sortable: true },
    { key: 'partner_name', header: 'Partner',   sortable: true, render: r => r.partner_name ?? '—' },
    { key: 'user_count',  header: 'Users',      sortable: true },
    {
      key: 'credits', header: 'Credits', sortable: true,
      render: row => <CreditsCell company={row} onSaved={loadData} />,
    },
  ]

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormErr('')
    setSaving(true)
    try {
      await api.createCompany({
        name: name.trim(),
        partner_id: partnerId || undefined,
        initial_credits: parseInt(initCredits, 10) || 100,
      })
      setName(''); setPartnerId(''); setInitCredits('100'); setShowForm(false)
      loadData()
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : 'Failed to create company.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-8 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Companies</h1>
          <p className="text-sm text-gray-400 mt-0.5">Manage all client companies and their credits</p>
        </div>
        <button
          onClick={() => setShowForm(f => !f)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Company
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Create Company</h2>
          <form onSubmit={handleCreate} className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-40">
              <label className="block text-xs text-gray-500 mb-1">Company Name *</label>
              <input value={name} onChange={e => setName(e.target.value)} required placeholder="Acme Corp" className={inputCls} />
            </div>
            <div className="flex-1 min-w-40">
              <label className="block text-xs text-gray-500 mb-1">Partner</label>
              <select value={partnerId} onChange={e => setPartnerId(e.target.value)} className={inputCls}>
                <option value="">No partner</option>
                {partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="w-32">
              <label className="block text-xs text-gray-500 mb-1">Initial Credits</label>
              <input type="number" min={0} value={initCredits} onChange={e => setInitCredits(e.target.value)} className={inputCls} />
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={saving || !name.trim()}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors">
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
      <DataTable columns={columns} data={data} filename="companies" isLoading={loading} headerGradient="from-sky-500 to-indigo-600" />
    </div>
  )
}
