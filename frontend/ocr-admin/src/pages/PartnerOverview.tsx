import { useState, useEffect } from 'react'
import { api, getUserInfo } from '@/lib/api'
import type { ClientSummary } from '@/types'
import DataTable, { type Column } from '@/components/DataTable'

const baseColumns: Column<ClientSummary>[] = [
  { key: 'name',            header: 'Company',         sortable: true },
  { key: 'credits',         header: 'Credits',         sortable: true },
  { key: 'user_count',      header: 'Users',           sortable: true },
  { key: 'ocr_runs_30d',    header: 'OCR Runs (30d)',  sortable: true },
  { key: 'ocr_credits_30d', header: 'OCR Credits (30d)', sortable: true },
  { key: 'val_runs_30d',    header: 'Val Runs (30d)',  sortable: true },
  { key: 'val_credits_30d', header: 'Val Credits (30d)', sortable: true },
]

const partnerCol: Column<ClientSummary> = {
  key: 'partner_name', header: 'Partner', sortable: true,
  render: row => row.partner_name ?? '—',
}

export default function PartnerOverview() {
  const [data,    setData]    = useState<ClientSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const role = getUserInfo()?.role

  useEffect(() => {
    api.myClients()
      .then(setData)
      .catch(e => setError(String(e.message)))
      .finally(() => setLoading(false))
  }, [])

  const columns = role === 'superadmin' ? [partnerCol, ...baseColumns] : baseColumns

  return (
    <div className="p-8 space-y-6 max-w-full">
      <div>
        <h1 className="text-xl font-bold text-gray-900">
          {role === 'superadmin' ? 'All Client Companies' : 'My Clients'}
        </h1>
        <p className="text-sm text-gray-400 mt-0.5">30-day usage summary per company</p>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <DataTable
        columns={columns}
        data={data}
        filename="clients"
        isLoading={loading}
        headerGradient="from-violet-500 to-indigo-600"
      />
    </div>
  )
}
