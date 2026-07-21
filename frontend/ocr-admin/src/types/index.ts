export interface OcrStats {
  runs: number
  files: number
  pages: number
  credits: number
  cost_usd: number
  last_at: string | null
}

export interface ValStats {
  runs: number
  items: number
  credits: number
  gemini_calls: number
  last_at: string | null
}

export interface OverviewUserCost {
  user_id: string
  username: string
  ocr_invoices: number
  price_per_invoice: number
  total_cost: number
}

export interface OverviewData {
  company_name: string
  credits_remaining: number
  total_users: number
  total_credits_consumed: number
  total_cost_usd: number
  ocr: { all_time: OcrStats; last_30d: OcrStats }
  validation: { all_time: ValStats; last_30d: ValStats }
  by_user?: OverviewUserCost[]
  total_billing_cost?: number
}

export interface GlobalOverviewData {
  total_partners: number
  total_companies: number
  total_users: number
  total_credits_in_system: number
  ocr: { all_time: OcrStats; last_30d: OcrStats }
  validation: { all_time: ValStats; last_30d: ValStats }
}

export interface ClientSummary {
  id: string
  name: string
  credits: number
  user_count: number
  is_active: boolean
  client_code: string | null
  sync_enabled: boolean
  catalog_item_count: number
  last_synced_at: string | null
  // All-time
  ocr_runs: number
  ocr_credits: number
  val_runs: number
  val_credits: number
  // 30-day
  ocr_runs_30d: number
  ocr_credits_30d: number
  val_runs_30d: number
  val_credits_30d: number
  partner_name?: string
}

export interface Partner {
  id: string
  name: string
  contact_email: string | null
  is_active: boolean
  company_count: number
  created_at: string
}

export interface Company {
  id: string
  name: string
  credits: number
  partner_id: string | null
  partner_name: string | null
  user_count: number
  is_active: boolean
  client_code: string | null
  catalog_item_count: number
  sync_enabled: boolean
}

export interface SyncLog {
  id: string
  mode: 'upsert' | 'replace'
  records_synced: number
  records_skipped: number
  status: 'success' | 'error'
  error_message: string | null
  triggered_at: string
}

export interface SyncStatus {
  sync_enabled: boolean
  last_synced_at: string | null
  recent_syncs: SyncLog[]
}

export interface AdminUser {
  id: string
  username: string
  role: string
  company_id: string | null
  company_name: string
  is_active: boolean
}

export interface ProcessingRun {
  id: string
  username: string
  company_name: string
  total_files: number
  successful_files: number
  failed_files: number
  total_pages: number
  total_fields_extracted: number
  credits_used: number
  total_duration_ms: number
  status: string
  started_at: string
  completed_at: string | null
  environment: string
}

export interface ValidationRun {
  id: string
  username: string
  company_name: string
  source_filename: string | null
  total_items: number
  matched_exact: number
  matched_fuzzy: number
  matched_multi_plu: number
  no_match: number
  valid_items: number
  items_with_issues: number
  gemini_calls: number
  status: string
  duration_ms: number
  started_at: string
  completed_at: string | null
  environment: string
}

export interface RunFilters {
  from_date?: string
  to_date?: string
  username?: string
}

export interface LoginEvent {
  id: string
  user_id: string | null
  company_id: string | null
  username: string
  company_name: string | null
  role: string | null
  login_type: 'company' | 'global'
  success: boolean
  failure_reason: string | null
  ip_address: string | null
  user_agent: string | null
  created_at: string
}

export interface LoginEventsData {
  events: LoginEvent[]
  total: number
}

export interface LoginEventFilters {
  from_date?: string
  to_date?: string
  username?: string
  role?: string
  login_type?: 'company' | 'global'
  success?: boolean
}

export interface UserInfo {
  username: string
  role: string
  company?: string
  partner?: string
}

export interface PartnerUsage {
  partner_name: string
  company_count: number
  ocr_runs: number
  ocr_pages: number
  ocr_credits: number
  val_runs: number
  val_items: number
  val_credits: number
  total_credits: number
  total_cost: number
}

export interface CompanyUsage {
  company_id: string
  company_name: string
  partner_name: string
  ocr_runs: number
  ocr_pages: number
  ocr_credits: number
  val_runs: number
  val_items: number
  val_credits: number
  total_credits: number
  price_per_invoice: number
  total_cost: number
}

export interface UserUsage {
  user_id: string
  username: string
  company_name: string
  partner_name: string
  ocr_runs: number
  ocr_pages: number
  ocr_credits: number
  val_runs: number
  val_items: number
  val_credits: number
  total_credits: number
  price_per_invoice: number
  total_cost: number
}

export interface UsageOverviewData {
  by_company: CompanyUsage[]
  by_user: UserUsage[]
  by_partner: PartnerUsage[]
}

export interface CreditSetting {
  company_id: string
  company_name: string
  price_per_invoice: number
  has_custom: boolean
  price_updated_at: string | null
}

export interface CatalogItem {
  id: string
  sku_code: string | null
  plu_code: string
  sku_description: string | null
  ean_code: string | null
  cost_price: number | null
  mrp: number | null
  gst_percent: number | null
  priority: number | null
  status: string | null
  uom: string | null
  synced_at: string | null
}

export interface ProductCatalogData {
  items: CatalogItem[]
  total: number
}
