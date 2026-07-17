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
  traffic_label?: string
  traffic_gb?: number
  traffic_bytes?: number
}

export interface CheckoutPreview {
  ok?: boolean
  original_cents: number
  final_cents: number
  discount_cents?: number
  free?: boolean
  label?: string
  coupon_code?: string
  balance_cents?: number
  balance_yuan?: string
  balance_applied_cents?: number
  gateway_cents?: number
  fully_covered_by_balance?: boolean
  use_balance?: boolean
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

const DEVICE_ID_KEY = 'fork-device-id'

export function getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id =
      (globalThis.crypto?.randomUUID?.() as string | undefined) ||
      `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

/** Dual-pool pending usage (bytes). `auto` is resolved server-side if pool hint unset. */
let trafficPendingFree = 0
let trafficPendingPaid = 0
let trafficPendingAuto = 0
let lastFlushAt = 0
/** Client-side hint from profile: paid user with paid quota → 'paid', else 'free'. */
let trafficPoolHint: 'free' | 'paid' | 'auto' = 'auto'

export function setTrafficPoolHint(pool: 'free' | 'paid' | 'auto') {
  trafficPoolHint = pool === 'paid' || pool === 'free' ? pool : 'auto'
}

export function accumulateTrafficBytes(upBps: number, downBps: number, dtSec: number) {
  const d = Math.max(0, upBps) + Math.max(0, downBps)
  if (!Number.isFinite(d) || !Number.isFinite(dtSec) || dtSec <= 0) return
  const bytes = d * dtSec
  if (trafficPoolHint === 'paid') trafficPendingPaid += bytes
  else if (trafficPoolHint === 'free') trafficPendingFree += bytes
  else trafficPendingAuto += bytes
}

async function flushOnePool(
  pool: 'free' | 'paid' | 'auto',
  delta: number,
): Promise<{ ok?: boolean; traffic?: TrafficInfo } | null> {
  if (delta <= 0) return null
  try {
    return await invoke<{ ok?: boolean; traffic?: TrafficInfo }>(
      'commercial_report_traffic',
      { deltaBytes: delta, pool },
    )
  } catch {
    if (pool === 'paid') trafficPendingPaid += delta
    else if (pool === 'free') trafficPendingFree += delta
    else trafficPendingAuto += delta
    return null
  }
}

export async function commercialFlushTrafficReport(force = false) {
  const now = Date.now()
  if (!force && now - lastFlushAt < 20_000) return null
  const free = Math.floor(trafficPendingFree)
  const paid = Math.floor(trafficPendingPaid)
  const auto = Math.floor(trafficPendingAuto)
  const total = free + paid + auto
  if (total < 50 * 1024 && !force) return null // min 50KB
  trafficPendingFree = Math.max(0, trafficPendingFree - free)
  trafficPendingPaid = Math.max(0, trafficPendingPaid - paid)
  trafficPendingAuto = Math.max(0, trafficPendingAuto - auto)
  lastFlushAt = now
  let last: { ok?: boolean; traffic?: TrafficInfo } | null = null
  if (free > 0) last = (await flushOnePool('free', free)) || last
  if (paid > 0) last = (await flushOnePool('paid', paid)) || last
  if (auto > 0) last = (await flushOnePool('auto', auto)) || last
  return last
}

export async function commercialRegister(
  username: string,
  password: string,
  email: string,
  inviteCode?: string,
  emailCode?: string,
) {
  return invoke<AuthSession>('commercial_register', {
    username,
    password,
    email,
    inviteCode: inviteCode || null,
    emailCode: emailCode || null,
  })
}

export async function commercialSendEmailCode(
  email: string,
  purpose: 'register' | 'reset_password',
) {
  return invoke<{
    ok?: boolean
    message?: string
    expires_in?: number
    cooldown?: number
  }>('commercial_send_email_code', { email, purpose })
}

export async function commercialEmailStatus() {
  return invoke<{
    ok?: boolean
    mail_configured?: boolean
    register_requires_code?: boolean
    reset_requires_code?: boolean
  }>('commercial_email_status')
}

export async function commercialPasswordResetRequest(email: string) {
  return invoke<{ ok?: boolean; message?: string; cooldown?: number }>(
    'commercial_password_reset_request',
    { email },
  )
}

export async function commercialPasswordResetComplete(
  email: string,
  emailCode: string,
  newPassword: string,
) {
  return invoke<{ ok?: boolean; message?: string }>(
    'commercial_password_reset_complete',
    { email, emailCode, newPassword },
  )
}

/** 向已绑定邮箱发送注销验证码 */
export async function commercialDeleteAccountSendCode() {
  return invoke<{
    ok?: boolean
    message?: string
    email_masked?: string
    cooldown?: number
  }>('commercial_delete_account_send_code')
}

/** 注销账号（不可恢复）：密码 + 邮箱验证码 */
export async function commercialDeleteAccount(
  password: string,
  emailCode: string,
) {
  return invoke<{ ok?: boolean; message?: string }>(
    'commercial_delete_account',
    { password, emailCode },
  )
}

export async function commercialLogin(username: string, password: string) {
  return invoke<AuthSession>('commercial_login', {
    username,
    password,
    deviceId: getOrCreateDeviceId(),
    deviceName: 'Fork Desktop',
    platform: navigator.platform || 'windows',
  })
}

export async function commercialLogout() {
  return invoke<void>('commercial_logout')
}

export async function commercialRemoveDevice(deviceId: string) {
  return invoke<{ ok?: boolean }>('commercial_remove_device', { deviceId })
}

export async function commercialGetSession() {
  return invoke<AuthSession | null>('commercial_get_session')
}

export async function commercialSyncSubscription() {
  const result = await invoke<SyncResult>('commercial_sync_subscription')
  if (result?.access_key) setStoredAccessKey(result.access_key)
  // Belt-and-suspenders: frontend also closes connections after entitlement sync
  // (Rust path already closes; this covers partial failures / older builds).
  try {
    const { closeAllConnections } = await import('tauri-plugin-mihomo-api')
    await closeAllConnections()
  } catch {
    /* core may be down */
  }
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
  balance_applied_cents?: number
  gateway_cents?: number
  balance_cents?: number
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
  opts?: { force?: boolean },
): Promise<SyncResult | null> {
  if (!accessKey) return null
  if (!opts?.force && accessKey === getStoredAccessKey()) return null
  return commercialSyncSubscription()
}

const RECONCILE_MIN_GAP_MS = 8_000
let lastReconcileAt = 0

/**
 * Call when entering Proxies (or other node UI):
 * 1) pull latest session (access_key = entitlement fingerprint)
 * 2) if fingerprint changed vs last successful sync → re-pull subscription
 *    so paid nodes drop without opening shop
 * force=true: ignore short throttle (used on first enter)
 */
export async function commercialReconcileAccess(opts?: {
  force?: boolean
}): Promise<SyncResult | null> {
  const now = Date.now()
  if (!opts?.force && now - lastReconcileAt < RECONCILE_MIN_GAP_MS) {
    return null
  }

  const session = await commercialGetSession()
  if (!session?.access_key) return null

  lastReconcileAt = now
  const stored = getStoredAccessKey()
  // force enter still only re-syncs when entitlements actually changed
  // (avoids pulling full YAML every click); fingerprint miss = must sync
  if (session.access_key === stored) {
    return null
  }

  const result = await commercialSyncSubscription()
  if (result?.access_key) setStoredAccessKey(result.access_key)
  else setStoredAccessKey(session.access_key)
  return result
}

export async function commercialPurchase(
  productId: string,
  opts?: { payType?: string; couponCode?: string; useBalance?: boolean },
) {
  return invoke<PurchaseResult>('commercial_purchase', {
    productId,
    payType: opts?.payType || null,
    couponCode: opts?.couponCode || null,
    useBalance: opts?.useBalance ?? true,
  })
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
  traffic_limit_bytes?: number
  traffic_used_bytes?: number
  traffic_unlimited?: boolean
  traffic_label?: string
}

export interface TrafficPoolInfo {
  unlimited?: boolean
  limit_bytes?: number
  used_bytes?: number
  remaining_bytes?: number | null
  exhausted?: boolean
  label?: string
}

export interface TrafficInfo {
  /** dual wallets */
  free?: TrafficPoolInfo
  paid?: TrafficPoolInfo
  is_paid_user?: boolean
  /** legacy single bar */
  unlimited?: boolean
  limit_bytes?: number
  used_bytes?: number
  remaining_bytes?: number | null
  exhausted?: boolean
  label?: string
}

export interface DeviceInfo {
  id: string
  name?: string
  platform?: string
  last_seen_at?: number
  created_at?: number
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
  traffic?: TrafficInfo
  is_paid_user?: boolean
  invite_code?: string
  devices?: DeviceInfo[]
  max_devices?: number
  support_tg?: string
  /** Store credit (cents). Refunds credit here; can pay for products. */
  balance_cents?: number
  balance_yuan?: string
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
  order_kind?: string
  money?: string
  money_cents?: number
  balance_applied_cents?: number
  gateway_cents?: number
  balance_refund_cents?: number
  refund_destination?: string
  pay_type?: string
  trade_no?: string
  expire_at?: number
  created_at?: number
  paid_at?: number
  refunded_at?: number
  pay_url?: string
}

export interface OrderList {
  items: OrderListItem[]
}

export interface ChangePasswordResult {
  ok?: boolean
  message?: string
}

export async function commercialGetCatalogItem(productId: string) {
  return invoke<{ item: CatalogItem }>('commercial_get_catalog_item', {
    productId,
  })
}

export async function commercialPreviewCheckout(
  productId: string,
  couponCode?: string,
  useBalance = true,
) {
  return invoke<CheckoutPreview>('commercial_preview_checkout', {
    productId,
    couponCode: couponCode || null,
    useBalance,
  })
}

export interface BalancePack {
  amount_cents: number
  label: string
  yuan: string
}

export interface BalancePacksResponse {
  balance_cents: number
  balance_yuan: string
  packs: BalancePack[]
  min_cents?: number
  max_cents?: number
  allow_custom?: boolean
  ezpay_enabled?: boolean
}

export async function commercialBalancePacks() {
  return invoke<BalancePacksResponse>('commercial_balance_packs')
}

export async function commercialBalanceTopup(
  amountCents: number,
  payType?: string,
) {
  return invoke<PurchaseResult>('commercial_balance_topup', {
    amountCents,
    payType: payType || 'alipay',
  })
}

export interface TicketMessage {
  id?: string
  role: 'user' | 'admin' | string
  author?: string
  body: string
  at: number
}

export interface TicketItem {
  id: string
  subject: string
  category: string
  status: string
  created_at: number
  updated_at: number
  closed_at?: number
  message_count?: number
  last_message?: { role?: string; body?: string; at?: number } | null
  messages?: TicketMessage[]
}

export async function commercialListTickets() {
  return invoke<{ items: TicketItem[]; categories?: Record<string, string> }>(
    'commercial_list_tickets',
  )
}

export async function commercialCreateTicket(payload: {
  subject: string
  body: string
  category?: string
}) {
  return invoke<{ ok?: boolean; ticket: TicketItem }>(
    'commercial_create_ticket',
    {
      subject: payload.subject,
      body: payload.body,
      category: payload.category || 'other',
    },
  )
}

export async function commercialGetTicket(ticketId: string) {
  return invoke<{ ticket: TicketItem }>('commercial_get_ticket', { ticketId })
}

export async function commercialReplyTicket(ticketId: string, body: string) {
  return invoke<{ ok?: boolean; ticket: TicketItem }>(
    'commercial_reply_ticket',
    { ticketId, body },
  )
}

export async function commercialCloseTicket(ticketId: string) {
  return invoke<{ ok?: boolean; ticket: TicketItem }>(
    'commercial_close_ticket',
    { ticketId },
  )
}

export async function commercialCheckinStatus() {
  return invoke<CheckinStatus>('commercial_checkin_status')
}

export async function commercialDoCheckin() {
  return invoke<CheckinResult>('commercial_do_checkin')
}

export async function commercialInviteInfo() {
  return invoke<InviteInfo>('commercial_invite_info')
}

export interface CheckinStatus {
  enabled: boolean
  can_checkin: boolean
  done_today: boolean
  streak: number
  next_streak?: number
  is_paid_user?: boolean
  reward_days: number
  reward_traffic_gb: number
  last_checkin_day?: string | null
  daily?: {
    tier?: string
    reward_days?: number
    free_traffic_gb?: number
    paid_traffic_gb?: number
  }
  upcoming_streak?: {
    days: number
    free_traffic_gb?: number
    paid_traffic_gb?: number
    reward_days?: number
  } | null
}

export interface CheckinResult {
  ok?: boolean
  message?: string
  streak?: number
  reward_days?: number
  reward_traffic_bytes?: number
}

export interface InviteInfo {
  enabled: boolean
  invite_code: string
  reward_days: number
  reward_traffic_gb: number
  invitee_days: number
  invitee_traffic_gb: number
  invited_count: number
  reward_count: number
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
