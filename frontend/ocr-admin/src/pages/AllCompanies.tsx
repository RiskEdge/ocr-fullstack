import { useState, useEffect, useMemo } from 'react'
import { Plus, Pencil, Check, X, SlidersHorizontal, Settings, PowerOff, Power } from 'lucide-react'
import { api, clearCache } from '@/lib/api'
import { useTheme } from '@/contexts/ThemeContext'
import type { Company, Partner } from '@/types'
import DataTable, { type Column } from '@/components/DataTable'
import CompanySyncPanel from '@/components/CompanySyncPanel'

const labelCls = 'text-xs text-gray-400 font-medium whitespace-nowrap'

// ---------------------------------------------------------------------------
// Inline credits editor cell
// ---------------------------------------------------------------------------
function CreditsCell({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const theme = useTheme()
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
        className={`w-20 px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 ${theme.focusRing}`}
      />
      <button onClick={save} disabled={saving} className="text-emerald-600 hover:text-emerald-700">
        <Check className="h-4 w-4" />
      </button>
      <button
        onClick={() => { setEditing(false); setVal(String(company.credits)) }}
        className="text-gray-400 hover:text-gray-600"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )

  return (
    <div className="flex items-center gap-2">
      <span>{company.credits.toLocaleString()}</span>
      <button
        onClick={() => setEditing(true)}
        className={`text-gray-300 transition-colors ${theme.hoverAccentText}`}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function AllCompanies() {
  const theme = useTheme()
  const inputCls = `px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 ${theme.focusRing} focus:border-transparent transition-colors`

  const [data,          setData]          = useState<Company[]>([])
  const [partners,      setPartners]      = useState<Partner[]>([])
  const [partnerFilter, setPartnerFilter] = useState('')
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')

  // Create company form
  const [showForm,    setShowForm]    = useState(false)
  const [name,        setName]        = useState('')
  const [partnerId,   setPartnerId]   = useState('')
  const [initCredits, setInitCredits] = useState('100')
  const [clientCode,  setClientCode]  = useState('')
  const [saving,      setSaving]      = useState(false)
  const [formErr,     setFormErr]     = useState('')

  // Sync panel
  const [managingCompany, setManagingCompany] = useState<Company | null>(null)

  function loadData() {
    clearCache('all-companies')
    setLoading(true)
    Promise.all([api.allCompanies(), api.partners()])
      .then(([c, p]) => { setData(c); setPartners(p) })
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }

  useEffect(loadData, [])

  const partnerOptions = useMemo(
    () => [...new Set(data.map(c => c.partner_name).filter((p): p is string => !!p))].sort(),
    [data],
  )

  const filteredData = useMemo(
    () => partnerFilter ? data.filter(c => c.partner_name === partnerFilter) : data,
    [data, partnerFilter],
  )

  async function handleToggleCompany(company: Company) {
    const next = !company.is_active
    try {
      await api.toggleCompanyActive(company.id, next)
      setData(d => d.map(c => c.id === company.id ? { ...c, is_active: next } : c))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update company status.')
    }
  }

  const columns: Column<Company>[] = [
    { key: 'name', header: 'Company', sortable: true },
    {
      key: 'partner_name', header: 'Partner', sortable: true,
      render: r => r.partner_name ?? '—',
    },
    {
      key: 'is_active', header: 'Status', sortable: true,
      render: r => r.is_active
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
    {
      key: 'client_code', header: 'Client Code',
      render: r => r.client_code
        ? <code className="text-xs font-mono bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded">{r.client_code}</code>
        : <span className="text-gray-300 text-xs">—</span>,
    },
    { key: 'user_count', header: 'Users', sortable: true },
    {
      key: 'credits', header: 'Credits', sortable: true,
      render: row => <CreditsCell company={row} onSaved={loadData} />,
    },
    {
      key: 'catalog_item_count', header: 'Catalog', sortable: true,
      render: r => (
        <span className="text-gray-700">
          {(r.catalog_item_count ?? 0).toLocaleString()}
          <span className="text-gray-400 text-xs ml-1">items</span>
        </span>
      ),
    },
    {
      key: 'sync_enabled', header: 'Sync',
      render: r => r.sync_enabled
        ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Active
          </span>
        ) : (
          <span className="text-xs text-gray-300">Not set</span>
        ),
    },
    {
      key: 'id', header: '',
      render: row => (
        <div className="flex items-center gap-4">
          <button
            onClick={() => handleToggleCompany(row)}
            title={row.is_active ? 'Deactivate company' : 'Activate company'}
            className={`transition-colors ${row.is_active ? 'text-gray-300 hover:text-amber-500' : 'text-gray-300 hover:text-emerald-600'}`}
          >
            {row.is_active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
          </button>
          <button
            onClick={() => setManagingCompany(row)}
            className={`text-gray-300 hover:text-gray-600 transition-colors ${theme.hoverAccentText}`}
            title="Manage sync settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ]

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormErr('')
    setSaving(true)
    try {
      await api.createCompany({
        name:            name.trim(),
        partner_id:      partnerId || undefined,
        initial_credits: parseInt(initCredits, 10) || 100,
        client_code:     clientCode.trim() || undefined,
      })
      setName(''); setPartnerId(''); setInitCredits('100'); setClientCode('')
      setShowForm(false)
      loadData()
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : 'Failed to create company.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-8 space-y-6 max-w-6xl">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Companies</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Manage client companies, credits, and ERP sync settings
          </p>
        </div>
        <button
          onClick={() => setShowForm(f => !f)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${theme.primaryBtn}`}
        >
          <Plus className="h-4 w-4" />
          New Company
        </button>
      </div>

      {/* Filter bar */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-gray-400 font-medium">
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </div>
          <div className="flex items-center gap-1.5">
            <span className={labelCls}>Partner</span>
            <select
              value={partnerFilter}
              onChange={e => setPartnerFilter(e.target.value)}
              className={inputCls}
            >
              <option value="">All partners</option>
              {partnerOptions.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {partnerFilter && (
            <button
              onClick={() => setPartnerFilter('')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 hover:text-red-500 hover:bg-red-50 border border-gray-200 transition-colors"
            >
              <X className="h-3.5 w-3.5" /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Create company form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          {/* Form header */}
          <div className={`px-6 py-3.5 bg-gradient-to-r ${theme.tableHeaderGradient} flex items-center justify-between`}>
            <h2 className="text-sm font-semibold text-white">New Company</h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-white/60 hover:text-white transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleCreate} className="p-6 space-y-4">
            {/* Row 1: Company Name + Partner */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  Company Name <span className="text-red-400">*</span>
                </label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  placeholder="Acme Retail Ltd."
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Partner</label>
                <select
                  value={partnerId}
                  onChange={e => setPartnerId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">No partner</option>
                  {partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>

            {/* Row 2: Initial Credits + Client Code */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Initial Credits</label>
                <input
                  type="number"
                  min={0}
                  value={initCredits}
                  onChange={e => setInitCredits(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  ERP Client Code
                  <span className="ml-1.5 text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  value={clientCode}
                  onChange={e => setClientCode(e.target.value.toUpperCase())}
                  placeholder="e.g. STR001"
                  maxLength={50}
                  className={`${inputCls} font-mono tracking-wide`}
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={saving || !name.trim()}
                className={`px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors ${theme.primaryBtn}`}
              >
                {saving ? 'Creating…' : 'Create Company'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-5 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              {formErr && (
                <p className="text-xs text-red-500 ml-1">{formErr}</p>
              )}
            </div>
          </form>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}

      <DataTable
        columns={columns}
        data={filteredData}
        filename="companies"
        isLoading={loading}
        headerGradient={theme.tableHeaderGradient}
      />

      {/* Sync management panel — shown when a company row's gear icon is clicked */}
      {managingCompany && (
        <CompanySyncPanel
          company={managingCompany}
          onClose={() => setManagingCompany(null)}
          onRefresh={() => {
            loadData()
            // Refresh the managing company object after the list reloads
            // (state update happens via loadData → setData → re-render)
          }}
        />
      )}
    </div>
  )
}
