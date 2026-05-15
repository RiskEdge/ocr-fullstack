import { type LucideIcon } from 'lucide-react'

export type CardColor = 'indigo' | 'emerald' | 'amber' | 'sky' | 'violet'

interface StatCardProps {
  label: string
  value: string | number
  icon: LucideIcon
  color: CardColor
}

const gradients: Record<CardColor, string> = {
  indigo:  'from-indigo-500 to-indigo-700',
  emerald: 'from-emerald-500 to-teal-600',
  amber:   'from-amber-400 to-orange-600',
  sky:     'from-sky-500 to-indigo-600',
  violet:  'from-violet-500 to-purple-700',
}

export default function StatCard({ label, value, icon: Icon, color }: StatCardProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden border border-gray-100">
      <div className={`bg-gradient-to-br ${gradients[color]} px-5 py-4 flex items-center justify-between`}>
        <span className="text-white/90 text-xs font-semibold uppercase tracking-wider">{label}</span>
        <div className="bg-white/20 rounded-md p-2">
          <Icon className="w-5 h-5 text-white" />
        </div>
      </div>
      <div className="px-5 py-4">
        <p className="text-3xl font-bold text-gray-900">{value}</p>
      </div>
    </div>
  )
}
