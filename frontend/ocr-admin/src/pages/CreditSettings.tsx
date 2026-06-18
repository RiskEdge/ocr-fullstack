import { useState, useEffect } from 'react'
import { IndianRupee, Check, X, Pencil, RotateCcw, Info } from 'lucide-react'
import { api, getUserInfo } from '@/lib/api'
import { useTheme } from '@/contexts/ThemeContext'
import type { CreditSetting } from '@/types'
import DataTable, { type Column } from '@/components/DataTable'
import { cn } from '@/lib/utils'

const DEFAULT_PRICE = 20.00

// ---------------------------------------------------------------------------
// Inline price editor — partner_admin only
// ---------------------------------------------------------------------------
function PriceCell({
  row,
  onUpdate,
}: {
  row: CreditSetting
  onUpdate: (price: number) => Promise<void>
}) {
  const theme = useTheme()
  const [editing, setEditing] = useState(false)
  const [val,     setVal]     = useState(row.price_per_invoice.toFixed(2))
  const [busy,    setBusy]    = useState(false)

  async function save() {
    const n = parseFloat(val)
    if (isNaN(n) || n <= 0) return
    setBusy(true)
    try {
      await onUpdate(n)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    if (!confirm(`Reset ${row.company_name} to the default price of ₹${DEFAULT_PRICE.toFixed(2)}/invoice?`)) return
    setBusy(true)
    try {
      await onUpdate(DEFAULT_PRICE)
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-gray-500 text-sm">₹</span>
        <input
          type="number"
          min={0.01}
          step={0.01}
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          autoFocus
          className={cn(
            'w-24 px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1',
            theme.focusRing,
          )}
        />
        <button
          onClick={save}
          disabled={busy}
          className="text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={() => { setEditing(false); setVal(row.price_per_invoice.toFixed(2)) }}
          className="text-gray-400 hover:text-gray-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-medium text-gray-800">₹{Number(row.price_per_invoice).toFixed(2)}</span>
      <button
        onClick={() => setEditing(true)}
        className={cn('text-gray-300 transition-colors', theme.hoverAccentText)}
        title="Edit price"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      {row.has_custom && (
        <button
          onClick={reset}
          disabled={busy}
          title={`Reset to default (₹${DEFAULT_PRICE.toFixed(2)}/invoice)`}
          className="text-gray-300 hover:text-amber-500 transition-colors disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function CreditSettings() {
  const theme   = useTheme()
  const role    = getUserInfo()?.role
  const canEdit = role === 'partner_admin'

  const [data,    setData]    = useState<CreditSetting[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  function loadData() {
    setLoading(true)
    setError('')
    api.creditSettings()
      .then(setData)
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }

  useEffect(loadData, [])

  async function handleUpdate(companyId: string, price: number) {
    await api.updatePricePerInvoice(companyId, price)
    setData(d => d.map(r =>
      r.company_id === companyId
        ? { ...r, price_per_invoice: price, has_custom: price !== DEFAULT_PRICE, price_updated_at: new Date().toISOString() }
        : r,
    ))
  }

  function fmtDate(iso: string | null) {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  const columns: Column<CreditSetting>[] = [
    { key: 'company_name', header: 'Company', sortable: true },
    {
      key: 'price_per_invoice',
      header: 'Price / Invoice',
      sortable: true,
      render: row =>
        canEdit ? (
          <PriceCell row={row} onUpdate={price => handleUpdate(row.company_id, price)} />
        ) : (
          <span className="font-medium text-gray-800">₹{Number(row.price_per_invoice).toFixed(2)}</span>
        ),
    },
    {
      key: 'has_custom',
      header: 'Type',
      sortable: true,
      render: row =>
        row.has_custom ? (
          <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', theme.badge)}>
            Custom
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
            Default
          </span>
        ),
    },
    {
      key: 'price_updated_at',
      header: 'Last Updated',
      sortable: true,
      render: row => <span className="text-gray-500 text-sm">{fmtDate(row.price_updated_at)}</span>,
    },
  ]

  const customCount  = data.filter(r => r.has_custom).length
  const defaultCount = data.length - customCount

  return (
    <div className="p-8 space-y-6 max-w-4xl">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <IndianRupee className={cn('h-5 w-5', theme.accentText)} />
            <h1 className="text-xl font-bold text-gray-900">Credit Settings</h1>
          </div>
          <p className="text-sm text-gray-400 mt-0.5 pl-7">
            {canEdit
              ? 'Set a custom price per invoice for each client company'
              : 'Price per invoice charged for OCR processing'}
          </p>
        </div>

        {/* Stats chips */}
        {!loading && data.length > 0 && (
          <div className="flex gap-2 self-start flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 text-xs font-medium text-gray-600">
              {data.length} {data.length === 1 ? 'company' : 'companies'}
            </span>
            {customCount > 0 && (
              <span className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium', theme.badge)}>
                {customCount} custom
              </span>
            )}
            {defaultCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 text-xs font-medium text-gray-500">
                {defaultCount} default
              </span>
            )}
          </div>
        )}
      </div>

      {/* Info banner */}
      <div className={cn('flex items-start gap-3 px-4 py-3 rounded-lg border', theme.accentBg, theme.accentBorder)}>
        <Info className={cn('h-4 w-4 mt-0.5 flex-shrink-0', theme.accentText)} />
        <p className={cn('text-sm', theme.accentTextStrong)}>
          Platform default is <strong>₹{DEFAULT_PRICE.toFixed(2)} per invoice</strong>.
          {canEdit
            ? ' Click the pencil to set a custom rate, or the reset icon to revert to default.'
            : ' Contact your partner admin to update pricing.'}
        </p>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <DataTable
        columns={columns}
        data={data}
        filename="credit-settings"
        isLoading={loading}
        headerGradient={theme.tableHeaderGradient}
      />
    </div>
  )
}
