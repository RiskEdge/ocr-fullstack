import { type LucideIcon } from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'

interface StatCardProps {
  label: string
  value: string | number
  icon: LucideIcon
  variant?: 1 | 2 | 3 | 4
}

export default function StatCard({ label, value, icon: Icon, variant = 1 }: StatCardProps) {
  const theme = useTheme()
  const gradient = theme.statCards[variant - 1]

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-5 flex items-center gap-4">
      <div className={`bg-gradient-to-br ${gradient} rounded-xl p-3 flex-shrink-0 shadow-sm`}>
        <Icon className="w-5 h-5 text-white" />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        <p className="text-xs text-gray-500 mt-0.5 truncate">{label}</p>
      </div>
    </div>
  )
}
