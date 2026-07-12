import { invoke } from '@tauri-apps/api/core'

export interface CommercialStatus {
  enabled: boolean
  product_name: string
  mock_backend: boolean
  api_base?: string
  demo_hint: string
}

export interface AuthSession {
  token: string
  user_id: string
  username: string
  plan: string
  expire_at: number
  status: string
  product_name: string
  issued_at: number
  access_key?: string
  purchase_names?: string[]
}

export interface SyncResult {
  profile_uid: string
  name: string
  updated: number
  expire_at: number
  plan: string
  message: string
  access_key?: string
}

export interface CatalogItem {
  id: string
  name: string
  notes?: string
  description?: string
  tier?: string
  type?: string
  price_cents?: number
  price_label?: string
  days?: number
  owned?: boolean
  source_name?: string
  configured?: boolean
}

export interface CatalogResponse {
  free: CatalogItem[]
  paid: CatalogItem[]
  access_key?: string
  purchases?: unknown[]
}

const ACCESS_KEY_STORAGE = 'fork-access-key'

export function getStoredAccessKey() {
  return localStorage.getItem(ACCESS_KEY_STORAGE) || ''
}

export function setStoredAccessKey(key?: string | null) {
  if (key) localStorage.setItem(ACCESS_KEY_STORAGE, key)
  else localStorage.removeItem(ACCESS_KEY_STORAGE)
}

export async function getCommercialStatus() {
  return invoke<CommercialStatus>('get_commercial_status')
}

export async function commercialRegister(
  username: string,
  password: string,
  email: string,
) {
  return invoke<AuthSession>('commercial_register', {
    username,
    password,
    email,
  })
}

export async function commercialLogin(username: string, password: string) {
  return invoke<AuthSession>('commercial_login', { username, password })
}

export async function commercialLogout() {
  return invoke<void>('commercial_logout')
}

export async function commercialGetSession() {
  return invoke<AuthSession | null>('commercial_get_session')
}

export async function commercialSyncSubscription() {
  const result = await invoke<SyncResult>('commercial_sync_subscription')
  if (result?.access_key) setStoredAccessKey(result.access_key)
  return result
}

export interface PurchaseResult {
  product_id: string
  name: string
  expire_at: number
  price_cents: number
  message: string
  need_pay?: boolean
  pay_url?: string | null
  order_id?: string | null
  out_trade_no?: string | null
  status?: string | null
  access_key?: string | null
}

export interface OrderStatus {
  order_id: string
  out_trade_no?: string
  status: string
  product_id?: string
  name?: string
  expire_at?: number
  price_cents?: number
  paid_at?: number
  pay_url?: string
  message?: string
  access_key?: string
}

export async function commercialGetCatalog() {
  return invoke<CatalogResponse>('commercial_get_catalog')
}

/**
 * If backend access_key differs from last successful sync, re-pull nodes
 * (covers admin revoke / expire without user manually clicking sync).
 */
export async function commercialEnsureAccessSynced(
  accessKey?: string | null,
): Promise<SyncResult | null> {
  if (!accessKey) return null
  if (accessKey === getStoredAccessKey()) return null
  return commercialSyncSubscription()
}

export async function commercialPurchase(productId: string) {
  return invoke<PurchaseResult>('commercial_purchase', { productId })
}

export async function commercialGetOrder(orderId: string) {
  return invoke<OrderStatus>('commercial_get_order', { orderId })
}

/** Poll until paid / timeout (ms). */
export async function commercialWaitOrderPaid(
  orderId: string,
  {
    intervalMs = 2500,
    timeoutMs = 5 * 60 * 1000,
  }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<OrderStatus> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const st = await commercialGetOrder(orderId)
    if (st.status === 'paid') {
      if (st.access_key) setStoredAccessKey(st.access_key)
      return st
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('等待支付超时，若已付款请点「刷新商品」后再同步节点')
}

export interface AnnouncementItem {
  id: string
  title: string
  body?: string
  created_at?: number
}

export interface AnnouncementList {
  items: AnnouncementItem[]
}

export async function commercialGetAnnouncements() {
  return invoke<AnnouncementList>('commercial_get_announcements')
}

export interface AppUpdateInfo {
  update: boolean
  force: boolean
  mode?: string
  latest_version?: string
  client_version?: string | null
  title?: string
  body?: string
}

/** Public endpoint — works before login through the Rust-owned API client. */
export async function commercialCheckAppUpdate(version: string) {
  return invoke<AppUpdateInfo>('commercial_check_app_update', { version })
}

export interface ProfilePurchase {
  product_id: string
  name: string
  source_id?: string | null
  expire_at: number
  created_at?: number
  updated_at?: number
  active?: boolean
  days_left?: number | null
}

export interface UserProfile {
  user_id: string
  username: string
  email?: string
  status: string
  plan: string
  /** Longest active product entitlement end; 0 if none */
  expire_at: number
  entitlement_until?: number
  account_expire_at?: number
  created_at?: number
  updated_at?: number
  product_name?: string
  access_key?: string
  purchase_names?: string[]
  purchases?: ProfilePurchase[]
  free_sources?: string[]
  paid_sources?: string[]
}

export interface RedeemResult {
  ok?: boolean
  code?: string
  product_id?: string
  name?: string
  days?: number
  expire_at?: number
  message?: string
  access_key?: string
}

export interface OrderListItem {
  order_id: string
  out_trade_no?: string
  status: string
  product_id?: string
  name?: string
  money?: string
  money_cents?: number
  pay_type?: string
  trade_no?: string
  expire_at?: number
  created_at?: number
  paid_at?: number
  pay_url?: string
}

export interface OrderList {
  items: OrderListItem[]
}

export interface ChangePasswordResult {
  ok?: boolean
  message?: string
}

export async function commercialGetProfile() {
  return invoke<UserProfile>('commercial_get_profile')
}

export async function commercialListOrders() {
  return invoke<OrderList>('commercial_list_orders')
}

export async function commercialChangePassword(
  oldPassword: string,
  newPassword: string,
) {
  return invoke<ChangePasswordResult>('commercial_change_password', {
    oldPassword,
    newPassword,
  })
}

export async function commercialRedeemCoupon(code: string) {
  const r = await invoke<RedeemResult>('commercial_redeem_coupon', { code })
  if (r.access_key) setStoredAccessKey(r.access_key)
  return r
}

export interface ChangeEmailResult {
  ok?: boolean
  email?: string
  message?: string
}

export async function commercialChangeEmail(email: string, password: string) {
  return invoke<ChangeEmailResult>('commercial_change_email', {
    email,
    password,
  })
}
