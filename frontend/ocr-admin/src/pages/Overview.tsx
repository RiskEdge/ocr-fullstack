import { useState, useEffect } from 'react'
import { CreditCard, Users, Zap } from 'lucide-react'
import { api, getUserInfo } from '@/lib/api'
import type { OverviewData } from '@/types'
import StatCard from '@/components/StatCard'

interface StatDef { key: string; label: string }

function ComparisonCard({
  title,
  gradient,
  allTime,
  last30d,
  statDefs,
}: {
  title: string
  gradient: string
  allTime: Record<string, number>
  last30d: Record<string, number>
  statDefs: Array<{ key: string; label: string }>
}) {
  const sections = [
    { period: 'All Time',     values: allTime },
    { period: 'Last 30 Days', values: last30d },
  ]
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
      <div className={`bg-gradient-to-r ${gradient} px-6 py-3.5`}>
        <h3 className="text-white font-semibold text-sm tracking-wide">{title}</h3>
      </div>
      {sections.map((s, i) => (
        <div key={s.period} className={i > 0 ? 'border-t border-gray-100' : ''}>
          <p className="px-6 pt-4 pb-2 text-xs font-bold text-gray-400 uppercase tracking-widest">
            {s.period}
          </p>
          <div className="px-6 pb-5 grid grid-cols-4 gap-4">
            {statDefs.map(({ key, label }) => (
              <div key={key}>
                <p className="text-2xl font-bold text-gray-900">
                  {(s.values[key] ?? 0).toLocaleString()}
                </p>
                <p className="text-xs text-gray-400 mt-1">{label}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const ocrStats:  StatDef[] = [
  { key: 'runs',    label: 'Runs'    },
  { key: 'files',   label: 'Files'   },
  { key: 'pages',   label: 'Pages'   },
  { key: 'credits', label: 'Credits' },
]

const valStats: StatDef[] = [
  { key: 'runs',         label: 'Runs'         },
  { key: 'items',        label: 'Items'        },
  { key: 'credits',      label: 'Credits'      },
  { key: 'gemini_calls', label: 'Gemini Calls' },
]

export default function Overview() {
  const [data,  setData]  = useState<OverviewData | null>(null)
  const [error, setError] = useState('')
  const role = getUserInfo()?.role

  useEffect(() => {
    api.overview().then(setData).catch(e => setError(String(e.message)))
  }, [])

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-red-500">{error}</div>
    )
  }
  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Loading…</p>
        </div>
      </div>
    )
  }

  const { ocr, validation } = data

  return (
    <div className="p-8 space-y-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{data.company_name}</h1>
          <p className="text-sm text-gray-400 mt-0.5">Company overview</p>
        </div>
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-gradient-to-r from-violet-100 to-indigo-100 text-indigo-700 border border-indigo-200">
          {role === 'superadmin' ? 'Super Admin' : 'Company Admin'}
        </span>
      </div>

      {/* Headline metrics */}
      <section>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">At a Glance</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            color="indigo"
            icon={CreditCard}
            label="Credits Remaining"
            value={data.credits_remaining.toLocaleString()}
          />
          <StatCard
            color="emerald"
            icon={Users}
            label="Total Users"
            value={data.total_users}
          />
          <StatCard
            color="amber"
            icon={Zap}
            label="Credits Consumed"
            value={data.total_credits_consumed.toLocaleString()}
          />
        </div>
      </section>

      {/* OCR */}
      <section>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">OCR Processing</p>
        <ComparisonCard
          title="OCR Processing"
          gradient="from-sky-500 to-indigo-600"
          allTime={ocr.all_time as unknown as Record<string, number>}
          last30d={ocr.last_30d as unknown as Record<string, number>}
          statDefs={ocrStats}
        />
      </section>

      {/* Validation */}
      <section>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">Validation</p>
        <ComparisonCard
          title="Validation"
          gradient="from-violet-500 to-purple-700"
          allTime={validation.all_time as unknown as Record<string, number>}
          last30d={validation.last_30d as unknown as Record<string, number>}
          statDefs={valStats}
        />
      </section>
    </div>
  )
}
