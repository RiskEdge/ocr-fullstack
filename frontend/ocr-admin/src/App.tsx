import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { hasToken, getUserInfo } from '@/lib/api'
import { ThemeProvider } from '@/contexts/ThemeContext'
import Sidebar from '@/components/Sidebar'
import Login from '@/pages/Login'
import Overview from '@/pages/Overview'
import SuperAdminOverview from '@/pages/SuperAdminOverview'
import PartnerOverview from '@/pages/PartnerOverview'
import Users from '@/pages/Users'
import ProcessingRuns from '@/pages/ProcessingRuns'
import ValidationRuns from '@/pages/ValidationRuns'
import Partners from '@/pages/Partners'
import AllCompanies from '@/pages/AllCompanies'
import UsageOverview from '@/pages/UsageOverview'
import ProductCatalog from '@/pages/ProductCatalog'
import CreditSettings from '@/pages/CreditSettings'
import LoginEvents from '@/pages/LoginEvents'

function defaultRoute(role?: string): string {
  if (role === 'superadmin')    return '/superadmin/overview'
  if (role === 'partner_admin') return '/partner/overview'
  return '/client/overview'
}

function ProtectedLayout() {
  if (!hasToken()) return <Navigate to="/login" replace />
  const user = getUserInfo()

  return (
    <ThemeProvider>
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Navigate to={defaultRoute(user?.role)} replace />} />

          {/* Superadmin */}
          <Route path="/superadmin/overview"         element={<SuperAdminOverview />} />
          <Route path="/superadmin/partners"         element={<Partners />} />
          <Route path="/superadmin/companies"        element={<AllCompanies />} />
          <Route path="/superadmin/users"            element={<Users />} />
          <Route path="/superadmin/usage-overview"   element={<UsageOverview />} />
          <Route path="/superadmin/processing-runs"  element={<ProcessingRuns />} />
          <Route path="/superadmin/validation-runs"  element={<ValidationRuns />} />
          <Route path="/superadmin/login-events"     element={<LoginEvents />} />
          <Route path="/superadmin/credit-settings"  element={<CreditSettings />} />

          {/* Partner admin */}
          <Route path="/partner/overview"            element={<PartnerOverview />} />
          <Route path="/partner/credit-settings"     element={<CreditSettings />} />
          <Route path="/partner/usage-overview"      element={<UsageOverview />} />
          <Route path="/partner/processing-runs"     element={<ProcessingRuns />} />
          <Route path="/partner/validation-runs"     element={<ValidationRuns />} />

          {/* Client admin */}
          <Route path="/client/overview"             element={<Overview />} />
          <Route path="/client/users"                element={<Users />} />
          <Route path="/client/credit-settings"      element={<CreditSettings />} />
          <Route path="/client/catalog"              element={<ProductCatalog />} />
          <Route path="/client/processing-runs"      element={<ProcessingRuns />} />
          <Route path="/client/validation-runs"      element={<ValidationRuns />} />

          {/* Legacy redirects */}
          <Route path="/overview"        element={<Navigate to={defaultRoute(user?.role)} replace />} />
          <Route path="/users"           element={<Navigate to="/client/users" replace />} />
          <Route path="/processing-runs" element={<Navigate to="/client/processing-runs" replace />} />
          <Route path="/validation-runs" element={<Navigate to="/client/validation-runs" replace />} />
        </Routes>
      </main>
    </div>
    </ThemeProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*"     element={<ProtectedLayout />} />
      </Routes>
    </BrowserRouter>
  )
}
