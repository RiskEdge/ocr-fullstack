import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  Globe, Building2, Briefcase, Users, FileText, ShieldCheck,
  LayoutDashboard, LogOut, KeyRound, BarChart3,
} from 'lucide-react'
import { clearSession, getUserInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import ChangePasswordDialog from '@/components/ChangePasswordDialog'

interface NavItem { to: string; label: string; Icon: React.ElementType }

const SUPERADMIN_NAV: NavItem[] = [
  { to: '/superadmin/overview',        label: 'Global Overview',   Icon: Globe },
  { to: '/superadmin/partners',        label: 'Partners',          Icon: Building2 },
  { to: '/superadmin/companies',       label: 'Companies',         Icon: Briefcase },
  { to: '/superadmin/users',           label: 'All Users',         Icon: Users },
  { to: '/superadmin/usage-overview',  label: 'Usage Overview',    Icon: BarChart3 },
  { to: '/superadmin/processing-runs', label: 'OCR Runs',          Icon: FileText },
  { to: '/superadmin/validation-runs', label: 'Validation Runs',   Icon: ShieldCheck },
]

const PARTNER_NAV: NavItem[] = [
  { to: '/partner/overview',           label: 'My Clients',        Icon: Building2 },
  { to: '/partner/usage-overview',     label: 'Usage Overview',    Icon: BarChart3 },
  { to: '/partner/processing-runs',    label: 'OCR Runs',          Icon: FileText },
  { to: '/partner/validation-runs',    label: 'Validation Runs',   Icon: ShieldCheck },
]

const CLIENT_NAV: NavItem[] = [
  { to: '/client/overview',            label: 'Overview',          Icon: LayoutDashboard },
  { to: '/client/users',               label: 'Users',             Icon: Users },
  { to: '/client/processing-runs',     label: 'OCR Runs',          Icon: FileText },
  { to: '/client/validation-runs',     label: 'Validation Runs',   Icon: ShieldCheck },
]

function navForRole(role?: string): NavItem[] {
  if (role === 'superadmin')    return SUPERADMIN_NAV
  if (role === 'partner_admin') return PARTNER_NAV
  return CLIENT_NAV
}

function roleBadge(role?: string): string {
  if (role === 'superadmin')    return 'Super Admin'
  if (role === 'partner_admin') return 'Partner'
  if (role === 'client_admin')  return 'Company Admin'
  return role ?? ''
}

export default function Sidebar() {
  const navigate  = useNavigate()
  const userInfo  = getUserInfo()
  const initials  = (userInfo?.username ?? '??').slice(0, 2).toUpperCase()
  const nav       = navForRole(userInfo?.role)
  const subtitle  = userInfo?.partner ?? userInfo?.company ?? roleBadge(userInfo?.role)
  const [showChangePw, setShowChangePw] = useState(false)

  function logout() {
    clearSession()
    navigate('/login')
  }

  return (
    <>
      <aside className="w-60 flex-shrink-0 flex flex-col bg-gradient-to-b from-violet-700 via-indigo-800 to-indigo-950">
        {/* Brand */}
        <div className="px-5 pt-6 pb-5 border-b border-white/10">
          <img src="/riskedge.png" alt="Risk Edge" className="h-7 w-auto brightness-0 invert mb-1" />
          <p className="text-xs text-indigo-300 font-medium tracking-wide">Admin Portal</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {nav.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all',
                  isActive
                    ? 'bg-white text-indigo-700 shadow-sm'
                    : 'text-indigo-200 hover:bg-white/10 hover:text-white',
                )
              }
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User + actions */}
        <div className="px-3 pb-4 border-t border-white/10 pt-3 space-y-1">
          {userInfo && (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-md">
              <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center text-xs font-bold text-indigo-700 flex-shrink-0 shadow-sm">
                {initials}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white truncate">{userInfo.username}</p>
                <p className="text-xs text-indigo-300 truncate">{subtitle}</p>
              </div>
            </div>
          )}
          <button
            onClick={() => setShowChangePw(true)}
            className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-indigo-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <KeyRound className="h-4 w-4" />
            Change password
          </button>
          <button
            onClick={logout}
            className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-indigo-300 hover:bg-white/10 hover:text-red-300 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

      <ChangePasswordDialog open={showChangePw} onClose={() => setShowChangePw(false)} />
    </>
  )
}
