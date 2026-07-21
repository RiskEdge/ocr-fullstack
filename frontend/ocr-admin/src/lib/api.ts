import type {
  OverviewData, GlobalOverviewData, ClientSummary,
  Partner, Company, AdminUser,
  ProcessingRun, ValidationRun,
  RunFilters, UserInfo, UsageOverviewData,
  SyncStatus, ProductCatalogData, CreditSetting,
  LoginEventsData, LoginEventFilters,
} from '@/types'

const TOKEN_KEY = 'admin_access_token'
const USER_KEY  = 'admin_user'

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

const _cache = new Map<string, unknown>()

export function setSession(token: string, user: UserInfo): void {
  sessionStorage.setItem(TOKEN_KEY, token)
  sessionStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function clearSession(): void {
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(USER_KEY)
  _cache.clear()
}

export function clearCache(key?: string): void {
  if (key) _cache.delete(key)
  else _cache.clear()
}

export function hasToken(): boolean {
  return !!sessionStorage.getItem(TOKEN_KEY)
}

export function getUserInfo(): UserInfo | null {
  try {
    const raw = sessionStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as UserInfo) : null
  } catch {
    return null
  }
}

function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? ''
}

async function adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options?.headers ?? {}),
    },
  })
  if (res.status === 401) throw new Error('Session expired. Please sign in again.')
  if (res.status === 403) throw new Error('Access denied.')
  if (res.status === 404) throw new Error('Not found.')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail ?? `Request failed: ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

async function cachedFetch<T>(key: string, path: string): Promise<T> {
  if (_cache.has(key)) return _cache.get(key) as T
  const data = await adminFetch<T>(path)
  _cache.set(key, data)
  return data
}

export async function login(username: string, password: string, companyName?: string): Promise<string> {
  const body: Record<string, string> = { username, password }
  if (companyName) body.company_name = companyName

  const res = await fetch(`${API_BASE}/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 401) throw new Error('Invalid credentials.')
  if (res.status === 403) throw new Error('Use the correct login mode for your account type.')
  if (!res.ok) throw new Error('Login failed. Please try again.')

  const data = await res.json() as {
    access_token: string
    user: { username: string; role: string; company?: string; partner?: string }
  }
  const { role, company, partner } = data.user

  if (role === 'user') throw new Error('This account does not have admin access.')

  setSession(data.access_token, { username: data.user.username, role, company, partner })
  return role
}

export const api = {
  // --- shared / client-scoped overview ---
  overview: () =>
    cachedFetch<OverviewData>('overview', '/v1/admin/overview'),

  // --- superadmin global overview ---
  globalOverview: () =>
    cachedFetch<GlobalOverviewData>('global-overview', '/v1/admin/global-overview'),

  // --- partner: list of client companies ---
  myClients: () =>
    cachedFetch<ClientSummary[]>('my-clients', '/v1/admin/my-clients'),

  // --- users ---
  users: () =>
    cachedFetch<AdminUser[]>('users', '/v1/admin/users'),

  createUser: (body: { username: string; password: string; company_id?: string; role?: string }) =>
    adminFetch<AdminUser>('/v1/admin/company-users', { method: 'POST', body: JSON.stringify(body) }),

  deleteUser: (userId: string) =>
    adminFetch<void>(`/v1/admin/company-users/${userId}`, { method: 'DELETE' }),

  // --- runs ---
  processingRuns: (filters: RunFilters = {}) => {
    const p = new URLSearchParams()
    if (filters.from_date) p.set('from_date', filters.from_date)
    if (filters.to_date)   p.set('to_date', filters.to_date)
    if (filters.username)  p.set('username', filters.username)
    const key = `processing-runs:${filters.from_date ?? ''}:${filters.to_date ?? ''}:${filters.username ?? ''}`
    return cachedFetch<ProcessingRun[]>(key, `/v1/admin/processing-runs?${p}`)
  },

  validationRuns: (filters: RunFilters = {}) => {
    const p = new URLSearchParams()
    if (filters.from_date) p.set('from_date', filters.from_date)
    if (filters.to_date)   p.set('to_date', filters.to_date)
    if (filters.username)  p.set('username', filters.username)
    const key = `validation-runs:${filters.from_date ?? ''}:${filters.to_date ?? ''}:${filters.username ?? ''}`
    return cachedFetch<ValidationRun[]>(key, `/v1/admin/validation-runs?${p}`)
  },

  // --- partners (superadmin only) ---
  partners: () =>
    cachedFetch<Partner[]>('partners', '/v1/admin/partners'),

  createPartner: (body: { name: string; contact_email?: string }) =>
    adminFetch<Partner>('/v1/admin/partners', { method: 'POST', body: JSON.stringify(body) }),

  // --- companies (superadmin only) ---
  allCompanies: () =>
    cachedFetch<Company[]>('all-companies', '/v1/admin/all-companies'),

  createCompany: (body: { name: string; partner_id?: string; initial_credits?: number; client_code?: string }) =>
    adminFetch<Company>('/v1/admin/companies', { method: 'POST', body: JSON.stringify(body) }),

  updateCredits: (companyId: string, credits: number) =>
    adminFetch<{ id: string; credits: number }>(
      `/v1/admin/companies/${companyId}/credits`,
      { method: 'PATCH', body: JSON.stringify({ credits }) }
    ),

  updateClientCode: (companyId: string, clientCode: string) =>
    adminFetch<{ id: string; client_code: string }>(
      `/v1/admin/companies/${companyId}/client-code`,
      { method: 'PATCH', body: JSON.stringify({ client_code: clientCode }) }
    ),

  syncStatus: (companyId: string) =>
    adminFetch<SyncStatus>(`/v1/admin/companies/${companyId}/sync-status`),

  generateSyncKey: (companyId: string) =>
    adminFetch<{ company_id: string; sync_secret: string; note: string }>(
      `/v1/admin/companies/${companyId}/sync-key`,
      { method: 'POST' }
    ),

  revokeSyncKey: (companyId: string) =>
    adminFetch<void>(`/v1/admin/companies/${companyId}/sync-key`, { method: 'DELETE' }),

  usageOverview: (filters: Pick<RunFilters, 'from_date' | 'to_date'> = {}) => {
    const p = new URLSearchParams()
    if (filters.from_date) p.set('from_date', filters.from_date)
    if (filters.to_date)   p.set('to_date', filters.to_date)
    return adminFetch<UsageOverviewData>(`/v1/admin/usage-overview?${p}`)
  },

  creditSettings: () =>
    adminFetch<CreditSetting[]>('/v1/admin/credit-settings'),

  updatePricePerInvoice: (companyId: string, pricePerInvoice: number) =>
    adminFetch<{ company_id: string; price_per_invoice: number }>(
      `/v1/admin/companies/${companyId}/price-per-invoice`,
      { method: 'PATCH', body: JSON.stringify({ price_per_invoice: pricePerInvoice }) },
    ),

  productCatalog: (params: { search?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams()
    if (params.search)             p.set('search', params.search)
    if (params.limit !== undefined) p.set('limit',  String(params.limit))
    if (params.offset !== undefined) p.set('offset', String(params.offset))
    return adminFetch<ProductCatalogData>(`/v1/admin/product-catalog?${p}`)
  },

  loginEvents: (filters: LoginEventFilters = {}, limit = 500) => {
    const p = new URLSearchParams()
    if (filters.from_date)          p.set('from_date', filters.from_date)
    if (filters.to_date)            p.set('to_date', filters.to_date)
    if (filters.username)           p.set('username', filters.username)
    if (filters.role)               p.set('role', filters.role)
    if (filters.login_type)         p.set('login_type', filters.login_type)
    if (filters.success !== undefined) p.set('success', String(filters.success))
    p.set('limit', String(limit))
    return adminFetch<LoginEventsData>(`/v1/admin/login-events?${p}`)
  },

  changePassword: (currentPassword: string, newPassword: string) =>
    adminFetch<{ message: string }>('/v1/user/change-password', {
      method: 'PATCH',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

  toggleCompanyActive: (companyId: string, isActive: boolean) =>
    adminFetch<{ id: string; is_active: boolean }>(
      `/v1/admin/companies/${companyId}/active`,
      { method: 'PATCH', body: JSON.stringify({ is_active: isActive }) }
    ),

  toggleUserActive: (userId: string, isActive: boolean) =>
    adminFetch<{ id: string; is_active: boolean }>(
      `/v1/admin/users/${userId}/active`,
      { method: 'PATCH', body: JSON.stringify({ is_active: isActive }) }
    ),
}
