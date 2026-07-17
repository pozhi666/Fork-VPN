import { Router } from 'express'
import { nanoid } from 'nanoid'
import { db, nowTs } from './db.js'
import {
  authMiddleware,
  checkPassword,
  hashPassword,
  signAdminToken,
  signUserToken,
} from './auth.js'
import {
  loadSubscriptionYaml,
  parseProxyNodes,
  previewSource,
  mergeSourcesForUser,
} from './subscription.js'
import {
  accessFingerprint,
  getAccessibleSources,
  getCatalog,
  isSellableProduct,
  isSystemPlan,
  normalizeSourceAccess,
  summarizeUserAccess,
} from './access.js'
import {
  addTrafficToPool,
  applyTrafficDelta,
  ensurePurchaseTraffic,
  ensureTrafficWallets,
  formatBytes,
  getUserTraffic,
  isPaidUser,
  migrateToDualWallets,
  productTrafficLimitBytes,
} from './traffic.js'

import {
  buildPayUrl,
  getEzpayConfig,
  verifyEzpayNotify,
  yuanFromCents,
} from './ezpay.js'
import { appendAudit } from './audit.js'
import { clientIp, hitRateLimit } from './rateLimit.js'
import { registerDevice, ensureDevices, removeDevice, getMaxDevices } from './devices.js'
import { ensureUserInviteCode } from './invites.js'
import { applyInviteRewards, getInviteConfig } from './inviteRewards.js'
import { maybeResetMonthlyTraffic } from './monthlyTraffic.js'
import { mountOpsRoutes } from './opsRoutes.js'
import { checkinStatus, doCheckin } from './checkin.js'
import { migrateBonusTraffic } from './activityRewards.js'
import {
  consumePasswordResetToken,
  issuePasswordReset,
} from './accountRecovery.js'
import { isMailConfigured, sendMail } from './mail.js'
import {
  consumeEmailOtp,
  issueEmailOtp,
  sendOtpMail,
} from './emailOtp.js'
// isPaidProduct already from access via traffic helpers
import {
  applyCouponPricing,
  consumeCoupon,
  consumeCouponReservation,
  findValidCoupon,
  normalizeCouponCode as normCheckoutCoupon,
  releaseCouponReservation,
  reserveCoupon,
} from './checkout.js'
import {
  creditBalance,
  debitBalance,
  ensureBalance,
  formatYuan,
  getBalanceCents,
  listBalanceLedger,
  planBalanceApplication,
  releaseOrderBalanceHold,
} from './balance.js'
import {
  closeTicket,
  createTicket,
  getTicket,
  listAdminTickets,
  listUserTickets,
  publicTicket,
  replyTicket,
  TICKET_CATEGORY_LABELS,
} from './tickets.js'

export const api = Router()
mountOpsRoutes(api)

function assertPaidTrafficQuota(priceCents, trafficBytes, settings) {
  const price = Number(priceCents || 0)
  const tb = Number(trafficBytes || 0)
  const allowUnlimited = String(settings?.allow_paid_unlimited_traffic || '0') === '1'
  if (price > 0 && tb <= 0 && !allowUnlimited) {
    throw new Error('付费商品必须设置流量额度（GB > 0）。如需不限请在系统设置开启 allow_paid_unlimited_traffic')
  }
}

function ensureOrders(data) {
  if (!Array.isArray(data.orders)) data.orders = []
}

function expirePendingOrders(data, now = nowTs()) {
  ensureOrders(data)
  let expired = 0
  for (const order of data.orders) {
    if (order.status !== 'pending' && order.status !== 'pending_payment') continue
    const expiresAt = Number(order.payment_expires_at || order.coupon_reservation_expires_at || 0)
    if (!expiresAt || expiresAt > now) continue
    if (order.coupon_reservation_id) {
      const coupon = (data.coupons || []).find((c) => c.id === order.coupon_id)
      if (coupon) releaseCouponReservation(coupon, order.coupon_reservation_id, 'order_expired')
    }
    const user = data.users.find((u) => u.id === order.user_id)
    let balanceReleased = 0
    if (user) {
      balanceReleased = releaseOrderBalanceHold(user, order, 'order_expired').released
    }
    order.status = 'expired'
    order.expired_at = now
    order.updated_at = now
    appendAudit(data, {
      actor: 'system',
      actor_type: 'system',
      action: 'order.expire',
      target: order.id,
      detail: {
        out_trade_no: order.out_trade_no,
        balance_released_cents: balanceReleased,
      },
    })
    expired++
  }
  return expired
}

export function expirePendingOrdersNow() {
  return db.write((data) => expirePendingOrders(data))
}

function makeOutTradeNo() {
  const tail = nanoid(10).replace(/[^a-zA-Z0-9]/g, 'x')
  return `F${Date.now()}${tail}`
}

const BALANCE_TOPUP_PRODUCT = '__balance_topup__'
/** Suggested packs (UI). Custom amount also allowed within min/max. */
const BALANCE_TOPUP_PACKS = [
  { cents: 100, label: '¥1' },
  { cents: 500, label: '¥5' },
  { cents: 1000, label: '¥10' },
  { cents: 3000, label: '¥30' },
  { cents: 5000, label: '¥50' },
  { cents: 10000, label: '¥100' },
]
const BALANCE_TOPUP_MIN_CENTS = 100 // ¥1
const BALANCE_TOPUP_MAX_CENTS = 50000 // ¥500

function isBalanceTopupOrder(order) {
  return (
    order?.order_kind === 'balance_topup' ||
    order?.product_id === BALANCE_TOPUP_PRODUCT
  )
}

/** Mark a pending order paid + grant product / credit balance (idempotent). */
function fulfillPaidOrder(data, order, tradeNo = '') {
  if (!order) throw new Error('订单不存在')
  if (order.status === 'paid') return order
  if (order.status !== 'pending' && order.status !== 'pending_payment') {
    throw new Error(`终态订单不可履约（${order.status || 'unknown'}）`)
  }
  const user = data.users.find((u) => u.id === order.user_id)
  if (!user) throw new Error('订单用户不存在')

  // —— 余额充值：支付成功后直接入账，不走套餐履约 ——
  if (isBalanceTopupOrder(order)) {
    const credit = Math.max(
      0,
      Math.floor(Number(order.balance_credit_cents || order.money_cents) || 0),
    )
    if (credit <= 0) throw new Error('充值金额无效')
    const r = creditBalance(user, credit, {
      type: 'topup',
      reason: '余额充值',
      ref_type: 'order',
      ref_id: order.id,
      actor: 'ezpay',
    })
    order.status = 'paid'
    order.trade_no = String(tradeNo || order.trade_no || '')
    order.paid_at = nowTs()
    order.expire_at = 0
    order.balance_credited_cents = r.credited
    order.updated_at = nowTs()
    return order
  }

  const product = data.plans.find((p) => p.id === order.product_id)
  if (!product || !isSellableProduct(product)) throw new Error('订单商品无效')
  if (!product.source_id) throw new Error('商品未绑定付费订阅源')

  if (order.coupon_reservation_id) {
    const coupon = (data.coupons || []).find((c) => c.id === order.coupon_id)
    if (!coupon) throw new Error('订单优惠券不存在')
    consumeCouponReservation(coupon, order.coupon_reservation_id)
  }

  const grant = grantPurchase(user, product, { order_id: order.id })
  order.status = 'paid'
  order.trade_no = String(tradeNo || order.trade_no || '')
  order.paid_at = nowTs()
  order.expire_at = grant.expire_at
  // record per-order grant metadata so refund can reclaim this order's exact
  // allowance without depending on product lookups or purchase-merge state
  order.traffic_pool = grant.traffic_pool
  order.granted_traffic_bytes = grant.traffic_limit_bytes
  order.granted_days = grant.days
  order.updated_at = nowTs()
  return order
}

function getSetting(key, fallback = '') {
  const data = db.read()
  return data.settings[key] ?? fallback
}

export function productDurationDays(product) {
  return Number(product?.duration_days || product?.trial_days || 30)
}

export function grantPurchase(user, product, { days, traffic_bytes, order_id = '' } = {}) {
  if (!Array.isArray(user.purchases)) user.purchases = []
  ensureTrafficWallets(user)
  const now = nowTs()
  const d = Number(days || productDurationDays(product))
  const quota =
    traffic_bytes !== undefined && traffic_bytes !== null
      ? Math.max(0, Math.floor(Number(traffic_bytes) || 0))
      : productTrafficLimitBytes(product)
  // free product (price 0) → free pool; paid → paid pool
  const pool = Number(product?.price_cents || 0) > 0 ? 'paid' : 'free'
  const existing = user.purchases.find((p) => p.product_id === product.id)
  const base = existing && existing.expire_at > now ? existing.expire_at : now
  const expire_at = base + d * 86400
  // per-order grant ledger entry (enables order-scoped refunds even when the
  // same product is renewed/merged into one purchase row)
  const grantEntry = {
    order_id: order_id || '',
    granted_bytes: quota,
    granted_days: d,
    traffic_pool: pool,
    granted_at: now,
    revoked_at: 0,
    revoke_reason: '',
  }
  if (existing) {
    // Re-purchase after refund reuses the same product_id row — must clear
    // revoke flags or the user stays "free" forever (activePurchases skips revoked).
    existing.expire_at = expire_at
    existing.source_id = product.source_id
    existing.name = product.name
    existing.updated_at = now
    existing.traffic_pool = pool
    existing.revoked_at = 0
    existing.revoke_reason = ''
    // wallet is source of truth; keep purchase traffic fields at 0
    existing.traffic_limit_bytes = 0
    existing.traffic_used_bytes = 0
    if (!Array.isArray(existing.grants)) existing.grants = []
    existing.grants.push(grantEntry)
  } else {
    user.purchases.push({
      product_id: product.id,
      source_id: product.source_id,
      name: product.name,
      expire_at,
      traffic_pool: pool,
      traffic_limit_bytes: 0,
      traffic_used_bytes: 0,
      grants: [grantEntry],
      revoked_at: 0,
      revoke_reason: '',
      created_at: now,
      updated_at: now,
    })
  }
  // add product traffic into the correct account wallet
  if (quota > 0) addTrafficToPool(user, pool, quota)

  user.plan_id = product.id
  if (!user.expire_at || user.expire_at < expire_at) user.expire_at = expire_at
  user.updated_at = now
  return { expire_at, days: d, traffic_limit_bytes: quota, traffic_pool: pool, order_id }
}

function enrichUser(user, data) {
  if (!user) return null
  const access = summarizeUserAccess(data, user)
  const plan = data.plans.find((p) => p.id === user.plan_id)
  // purchase_names already prefer paid products first
  const label =
    access.purchase_names[0] ||
    (plan && Number(plan.price_cents || 0) > 0 ? plan.name : null) ||
    plan?.name ||
    (access.paid_sources.length ? 'member' : 'free')
  const paid = isPaidUser(user, data)
  return {
    ...user,
    plan_name: label,
    is_paid_user: paid,
    purchase_names: access.purchase_names,
    free_sources: access.free_sources,
    paid_sources: access.paid_sources,
    purchases: access.purchases,
  }
}

function findUser(data, usernameOrId, byId = false) {
  const user = byId
    ? data.users.find((u) => u.id === usernameOrId)
    : data.users.find((u) => u.username === usernameOrId)
  return enrichUser(user, data)
}

function userRowToSession(user, token, data) {
  const dbData = data || db.read()
  const raw = dbData.users.find((u) => u.id === user.id) || user
  return {
    token,
    user_id: user.id,
    username: user.username,
    email: raw.email || user.email || '',
    plan: user.plan_name || 'trial',
    is_paid_user: Boolean(user.is_paid_user ?? isPaidUser(raw, dbData)),
    expire_at: user.expire_at,
    status: user.status,
    product_name: getSetting('product_name', 'Fork'),
    issued_at: nowTs(),
    access_key: accessFingerprint(dbData, raw),
    purchase_names: user.purchase_names || [],
  }
}

function ensureActive(user) {
  if (!user) return '用户不存在'
  if (user.status === 'deleted') return '账号已注销'
  if (user.status !== 'active') return '账号已被禁用'
  // Do not block login on user.expire_at — that field is legacy/trial display only.
  // Paid lines are controlled by purchases[]; public sources need only an active account.
  return null
}

/** Longest active product entitlement end; 0 if none. Includes account expire_at. */
function maxPurchaseExpireAt(user, now = nowTs()) {
  const list = Array.isArray(user?.purchases) ? user.purchases : []
  let max = 0
  for (const p of list) {
    const exp = Number(p.expire_at || 0)
    if (exp > now && exp > max) max = exp
  }
  const acc = Number(user?.expire_at || 0)
  if (acc > now && acc > max) max = acc
  return max
}

api.get('/health', (_req, res) => {
  res.json({ ok: true, product: getSetting('product_name', 'Fork') })
})

/** Semver-ish compare: a < b => -1, a==b => 0, a > b => 1 */
function cmpVersion(a, b) {
  const pa = String(a || '0')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '0')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => parseInt(x, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da < db) return -1
    if (da > db) return 1
  }
  return 0
}

function getClientUpdatePolicy() {
  const s = db.read().settings || {}
  const u = s.client_update || {}
  const platforms = u.platforms && typeof u.platforms === 'object' ? u.platforms : {}
  const win = platforms['windows-x86_64'] || {}
  return {
    enabled: u.enabled !== false && u.enabled !== '0',
    mode: u.mode === 'force' ? 'force' : u.mode === 'off' ? 'off' : 'optional',
    latest_version: String(u.latest_version || '').trim(),
    title: String(u.title || '发现新版本').trim() || '发现新版本',
    body: String(u.body || '').trim(),
    pub_date: String(u.pub_date || '').trim(),
    // Tauri updater platform packs (url + minisign signature from tauri build)
    platforms: {
      'windows-x86_64': {
        url: String(win.url || u.windows_url || '').trim(),
        signature: String(win.signature || u.windows_signature || '').trim(),
      },
      'darwin-x86_64': {
        url: String(platforms['darwin-x86_64']?.url || '').trim(),
        signature: String(platforms['darwin-x86_64']?.signature || '').trim(),
      },
      'darwin-aarch64': {
        url: String(platforms['darwin-aarch64']?.url || '').trim(),
        signature: String(platforms['darwin-aarch64']?.signature || '').trim(),
      },
      'linux-x86_64': {
        url: String(platforms['linux-x86_64']?.url || '').trim(),
        signature: String(platforms['linux-x86_64']?.signature || '').trim(),
      },
    },
  }
}

/** Build Tauri-compatible updater JSON (public). */
function buildTauriUpdateManifest(policy) {
  if (!policy.enabled || policy.mode === 'off' || !policy.latest_version) {
    return null
  }
  const platforms = {}
  for (const [key, p] of Object.entries(policy.platforms || {})) {
    if (p?.url && p?.signature) {
      platforms[key] = { url: p.url, signature: p.signature }
    }
  }
  if (!Object.keys(platforms).length) return null
  return {
    version: policy.latest_version.replace(/^v/i, ''),
    notes: policy.body || policy.title || '',
    pub_date: policy.pub_date || new Date().toISOString(),
    platforms,
  }
}

/**
 * Tauri plugin-updater endpoint (public, no auth).
 * Same JSON shape as GitHub update.json used by Clash Verge Rev.
 */
api.get('/client/updater/latest.json', (_req, res) => {
  const policy = getClientUpdatePolicy()
  const manifest = buildTauriUpdateManifest(policy)
  if (!manifest) {
    return res.status(204).end()
  }
  res.setHeader('Cache-Control', 'no-store')
  res.json(manifest)
})

/**
 * Public download card for landing page (no auth).
 * Returns latest Windows installer URL when configured in admin client_update.
 */
api.get('/client/download', (_req, res) => {
  const policy = getClientUpdatePolicy()
  const win = policy.platforms?.['windows-x86_64'] || {}
  const hasWin = Boolean(win.url)
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    product: getSetting('product_name', 'Fork'),
    version: policy.latest_version || null,
    enabled: policy.enabled && policy.mode !== 'off',
    title: policy.title || '下载客户端',
    notes: policy.body || '',
    windows: {
      url: hasWin ? win.url : '',
      available: hasWin,
    },
    message: hasWin
      ? '可直接下载 Windows 安装包'
      : '安装包尚未发布，请稍后再试或联系管理员',
  })
})

/**
 * Client version check (no auth — needed before/at login).
 * Query: ?version=0.1.0
 * Used for optional/force UI; actual binary install uses Tauri updater + latest.json.
 */
api.get('/client/app-update', (req, res) => {
  const clientVersion = String(req.query?.version || req.headers['x-app-version'] || '').trim()
  const policy = getClientUpdatePolicy()
  if (!policy.enabled || policy.mode === 'off' || !policy.latest_version) {
    return res.json({
      update: false,
      force: false,
      mode: 'off',
      latest_version: policy.latest_version || null,
      client_version: clientVersion || null,
    })
  }
  const need =
    !clientVersion || cmpVersion(clientVersion, policy.latest_version) < 0
  if (!need) {
    return res.json({
      update: false,
      force: false,
      mode: policy.mode,
      latest_version: policy.latest_version,
      client_version: clientVersion,
    })
  }
  const hasInstaller = Boolean(buildTauriUpdateManifest(policy))
  res.json({
    update: true,
    force: policy.mode === 'force',
    mode: policy.mode,
    latest_version: policy.latest_version,
    client_version: clientVersion || null,
    title: policy.title,
    body:
      policy.body ||
      (hasInstaller
        ? '发现新版本，点击更新将自动下载并安装。'
        : '发现新版本，但后台尚未配置安装包地址与签名，请联系管理员。'),
    has_installer: hasInstaller,
    support_hint: hasInstaller
      ? '将通过内置更新器自动下载安装'
      : '请在管理后台填写 Windows 安装包 URL 与签名',
  })
})

function isValidEmail(email) {
  if (!email || email.length > 120) return false
  // practical RFC-like check
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function ensureCoupons(data) {
  if (!Array.isArray(data.coupons)) data.coupons = []
}

function normalizeCouponCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}

/**
 * Send email OTP for register / password reset.
 * Body: { email, purpose: 'register' | 'reset_password' }
 */
api.post('/auth/email-code/send', async (req, res) => {
  const ip = clientIp(req)
  const rl = hitRateLimit(`emailotp:${ip}`, { limit: 12, windowMs: 3600_000 })
  if (!rl.ok) return res.status(429).json({ error: rl.error })

  if (!isMailConfigured()) {
    return res.status(503).json({ error: '邮件服务未配置，无法发送验证码' })
  }

  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase()
  const purpose = String(req.body?.purpose || '').trim().toLowerCase()
  if (!isValidEmail(email)) return res.status(400).json({ error: '请填写有效邮箱' })
  if (
    purpose !== 'register' &&
    purpose !== 'reset_password' &&
    purpose !== 'delete_account'
  ) {
    return res.status(400).json({ error: '验证用途无效' })
  }
  // delete_account OTP must go through authenticated endpoint (bound email only)
  if (purpose === 'delete_account') {
    return res.status(400).json({
      error: '请登录后使用账号注销验证码接口',
    })
  }

  // purpose-specific prechecks (avoid useless emails, still avoid full enumeration on reset)
  try {
    if (purpose === 'register') {
      if (getSetting('allow_register', '1') !== '1') {
        return res.status(403).json({ error: '暂未开放注册' })
      }
      const data = db.read()
      if (data.users.some((u) => String(u.email || '').toLowerCase() === email)) {
        return res.status(409).json({ error: '该邮箱已被注册' })
      }
    }

    let issued
    try {
      issued = db.write((data) => {
        if (purpose === 'reset_password') {
          const user = (data.users || []).find(
            (u) => String(u.email || '').toLowerCase() === email,
          )
          // Do not reveal existence: still create OTP only if user exists
          if (!user || (user.status && user.status !== 'active')) {
            return { ok: false, silent: true }
          }
        }
        return issueEmailOtp(data, { email, purpose })
      })
    } catch (e) {
      return res.status(400).json({ error: e.message || '无法生成验证码' })
    }

    if (issued?.silent) {
      // same response shape as success to reduce enumeration
      return res.json({
        ok: true,
        message: '若该邮箱可用，验证码已发送',
        expires_in: 600,
        cooldown: 60,
      })
    }
    if (!issued?.ok) {
      return res.status(429).json({
        error: issued?.error || '发送过于频繁',
        retry_after: issued?.retry_after,
      })
    }

    try {
      await sendOtpMail({ email: issued.email, purpose: issued.purpose, code: issued.code })
    } catch (e) {
      console.error('[otp] send failed:', e.message || e)
      return res.status(502).json({ error: '验证码邮件发送失败，请稍后重试' })
    }

    db.write((data) => {
      appendAudit(data, {
        actor: 'system',
        actor_type: 'system',
        action: 'auth.email_otp_sent',
        detail: { purpose, email, ip },
        ip,
      })
    })

    res.json({
      ok: true,
      message: purpose === 'register' ? '验证码已发送到邮箱' : '若该邮箱可用，验证码已发送',
      expires_in: issued.expires_in,
      cooldown: 60,
    })
  } catch (e) {
    res.status(400).json({ error: e.message || '发送失败' })
  }
})

api.get('/auth/email-status', (_req, res) => {
  res.json({
    ok: true,
    mail_configured: isMailConfigured(),
    register_requires_code: isMailConfigured(),
    reset_requires_code: isMailConfigured(),
  })
})

api.post('/auth/register', (req, res) => {
  if (getSetting('allow_register', '1') !== '1') {
    return res.status(403).json({ error: '暂未开放注册' })
  }
  const ip = clientIp(req)
  const rl = hitRateLimit(`reg:${ip}`, { limit: 8, windowMs: 3600_000 })
  if (!rl.ok) return res.status(429).json({ error: rl.error })

  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase()
  const invite_code = req.body?.invite_code || req.body?.invite || ''
  const email_code = String(
    req.body?.email_code || req.body?.code || req.body?.verify_code || '',
  ).trim()
  if (username.length < 3) return res.status(400).json({ error: '用户名至少 3 个字符' })
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 个字符' })
  if (!isValidEmail(email)) return res.status(400).json({ error: '请填写有效邮箱' })

  // SMTP configured → email OTP required
  if (isMailConfigured()) {
    if (!/^\d{6}$/.test(email_code)) {
      return res.status(400).json({ error: '请填写邮箱收到的 6 位验证码' })
    }
  }

  try {
    const session = db.write((data) => {
      if (data.users.some((u) => u.username === username)) {
        throw new Error('用户名已存在')
      }
      if (data.users.some((u) => String(u.email || '').toLowerCase() === email)) {
        throw new Error('该邮箱已被注册')
      }
      if (isMailConfigured()) {
        const verified = consumeEmailOtp(data, {
          email,
          purpose: 'register',
          code: email_code,
        })
        if (!verified.ok) throw new Error(verified.error || '邮箱验证失败')
      }
      // same IP many accounts in short window (soft)
      const hourAgo = nowTs() - 3600
      const sameIpRecent = data.users.filter(
        (u) => u.register_ip === ip && (u.created_at || 0) > hourAgo,
      ).length
      if (sameIpRecent >= 5) throw new Error('该网络注册过于频繁，请稍后再试')

      const now = nowTs()
      const trialDays = Math.max(0, Number(data.settings.register_trial_days ?? 0))
      const user = {
        id: nanoid(),
        username,
        email,
        email_verified_at: isMailConfigured() ? now : 0,
        password_hash: hashPassword(password),
        plan_id: null,
        purchases: [],
        devices: [],
        status: 'active',
        expire_at: trialDays > 0 ? now + trialDays * 86400 : 0,
        register_ip: ip,
        created_at: now,
        updated_at: now,
      }
      ensureUserInviteCode(user)
      if (invite_code) {
        applyInviteRewards(data, user, invite_code)
      }
      data.users.push(user)
      appendAudit(data, {
        actor: username,
        actor_type: 'user',
        action: 'auth.register',
        target: user.id,
        detail: { invite: Boolean(invite_code), email_verified: isMailConfigured() },
        ip,
      })
      const full = enrichUser(user, data)
      const token = signUserToken(full)
      const s = userRowToSession(full, token, data)
      s.invite_code = user.invite_code
      return s
    })
    res.json(session)
  } catch (e) {
    res.status(
      e.message === '用户名已存在' || e.message === '该邮箱已被注册' ? 409 : 400,
    ).json({ error: e.message })
  }
})

api.post('/auth/login', (req, res) => {
  const ip = clientIp(req)
  const rl = hitRateLimit(`login:${ip}`, { limit: 30, windowMs: 600_000 })
  if (!rl.ok) return res.status(429).json({ error: rl.error })

  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const device_id = String(req.body?.device_id || '').trim()
  const device_name = String(req.body?.device_name || '').trim()
  const platform = String(req.body?.platform || '').trim()

  let session
  try {
    session = db.write((data) => {
      const user = data.users.find((u) => u.username === username)
      if (!user || !checkPassword(password, user.password_hash)) {
        appendAudit(data, {
          actor: username || 'unknown',
          actor_type: 'user',
          action: 'auth.login_fail',
          ip,
        })
        throw new Error('用户名或密码错误')
      }
      const err = ensureActive(user)
      if (err) throw new Error(err)

      // device binding (optional if client sends device_id)
      let deviceResult = null
      if (device_id || device_name) {
        deviceResult = registerDevice(user, data.settings || {}, {
          device_id,
          name: device_name || 'Desktop',
          platform: platform || 'unknown',
        })
        if (!deviceResult.ok) throw new Error(deviceResult.error)
      }

      user.last_login_at = nowTs()
      user.last_login_ip = ip
      user.updated_at = nowTs()
      ensureUserInviteCode(user)
      maybeResetMonthlyTraffic(user, data)
      appendAudit(data, {
        actor: user.username,
        actor_type: 'user',
        action: 'auth.login',
        target: user.id,
        detail: { device_id: deviceResult?.device_id || null },
        ip,
      })
      const full = enrichUser(user, data)
      const s = userRowToSession(full, signUserToken(full), data)
      s.invite_code = user.invite_code
      s.device_id = deviceResult?.device_id || device_id || null
      s.max_devices = getMaxDevices(data.settings)
      return s
    })
  } catch (e) {
    const status = e.message === '用户名或密码错误' ? 401 : 403
    return res.status(status).json({ error: e.message })
  }
  res.json(session)
})

api.get('/auth/me', authMiddleware('user'), (req, res) => {
  const data = db.read()
  const user = findUser(data, req.auth.sub, true)
  const err = ensureActive(user)
  if (err) return res.status(403).json({ error: err })
  res.json(userRowToSession(user, req.headers.authorization.slice(7), data))
})

/**
 * Client personal center: account + active purchases + sources summary
 */
api.get('/client/profile', authMiddleware('user'), (req, res) => {
  const data = db.read()
  ensureOrders(data)
  const raw = data.users.find((u) => u.id === req.auth.sub)
  if (!raw) return res.status(401).json({ error: '请先登录' })
  const user = enrichUser(raw, data)
  const err = ensureActive(user)
  if (err) return res.status(403).json({ error: err })

  const now = nowTs()
  db.write((d) => {
    const u = d.users.find((x) => x.id === raw.id)
    if (!u) return
    maybeResetMonthlyTraffic(u, d, now)
    migrateToDualWallets(u, d)
    migrateBonusTraffic(u, d)
    raw.purchases = u.purchases
    raw.expire_at = u.expire_at
    raw.traffic = u.traffic
  })
  const traffic = getUserTraffic(raw, data, now)
  ensureUserInviteCode(raw)
  const purchases = (Array.isArray(raw.purchases) ? raw.purchases : []).map((p) => {
    const exp = Number(p.expire_at || 0)
    const active = !exp || exp === 0 || exp > now
    const product = data.plans.find((x) => x.id === p.product_id)
    const pool =
      p.traffic_pool ||
      (p.product_id === '__activity_reward__'
        ? 'activity'
        : product && Number(product.price_cents || 0) > 0
          ? 'paid'
          : 'free')
    return {
      product_id: p.product_id,
      name: p.name || '',
      source_id: p.source_id || null,
      expire_at: exp,
      created_at: p.created_at || 0,
      updated_at: p.updated_at || 0,
      active,
      days_left: active && exp > 0 ? Math.max(0, Math.ceil((exp - now) / 86400)) : null,
      traffic_pool: pool,
      // per-purchase traffic moved to account wallets
      traffic_limit_bytes: 0,
      traffic_used_bytes: 0,
      traffic_unlimited: false,
      traffic_label: pool === 'paid' ? '计入付费流量池' : pool === 'free' ? '计入免费流量池' : '活动',
    }
  })
  // active first, then by expire
  purchases.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return (b.expire_at || 0) - (a.expire_at || 0)
  })

  const entitlementUntil = maxPurchaseExpireAt(raw, now)
  res.json({
    user_id: raw.id,
    username: raw.username,
    email: raw.email || '',
    status: raw.status,
    plan: user.plan_name || 'trial',
    // Prefer real entitlement end; 0 = no paid entitlement (public-only is fine)
    expire_at: entitlementUntil,
    account_expire_at: raw.expire_at || 0,
    entitlement_until: entitlementUntil,
    created_at: raw.created_at || 0,
    updated_at: raw.updated_at || 0,
    product_name: getSetting('product_name', 'Fork'),
    access_key: accessFingerprint(data, raw),
    purchase_names: user.purchase_names || [],
    purchases,
    free_sources: user.free_sources || [],
    paid_sources: user.paid_sources || [],
    invite_code: raw.invite_code || '',
    invited_by: raw.invited_by || null,
    devices: ensureDevices(raw).map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      last_seen_at: d.last_seen_at,
      created_at: d.created_at,
    })),
    max_devices: getMaxDevices(db.read().settings),
    support_tg: getSetting('support_tg', 'https://t.me/forkdl'),
    is_paid_user: traffic.is_paid_user,
    balance_cents: getBalanceCents(raw),
    balance_yuan: formatYuan(getBalanceCents(raw)),
    traffic: {
      // dual wallets
      free: traffic.free,
      paid: traffic.paid,
      is_paid_user: traffic.is_paid_user,
      // legacy single (dashboard fallback)
      unlimited: traffic.unlimited,
      limit_bytes: traffic.limit_bytes,
      used_bytes: traffic.used_bytes,
      remaining_bytes: traffic.remaining_bytes,
      exhausted: traffic.exhausted,
      label: traffic.label,
    },
  })
})

/** Client balance ledger (store credit history) */
api.get('/client/balance/ledger', authMiddleware('user'), (req, res) => {
  const data = db.read()
  const user = data.users.find((u) => u.id === req.auth.sub)
  if (!user) return res.status(401).json({ error: '请先登录' })
  const limit = Number(req.query?.limit || 50)
  res.json({
    balance_cents: getBalanceCents(user),
    balance_yuan: formatYuan(getBalanceCents(user)),
    items: listBalanceLedger(user, limit),
  })
})

/** Fixed top-up packs (cents) */
api.get('/client/balance/packs', authMiddleware('user'), (req, res) => {
  const data = db.read()
  const user = data.users.find((u) => u.id === req.auth.sub)
  if (!user) return res.status(401).json({ error: '请先登录' })
  res.json({
    balance_cents: getBalanceCents(user),
    balance_yuan: formatYuan(getBalanceCents(user)),
    packs: BALANCE_TOPUP_PACKS.map((p) => ({
      amount_cents: p.cents,
      label: p.label,
      yuan: formatYuan(p.cents),
    })),
    min_cents: BALANCE_TOPUP_MIN_CENTS,
    max_cents: BALANCE_TOPUP_MAX_CENTS,
    allow_custom: true,
    ezpay_enabled: getEzpayConfig().enabled,
  })
})

/**
 * Create a balance top-up payment order.
 * Body: { amount_cents, pay_type? }
 * amount_cents: any integer in [min_cents, max_cents] (custom allowed)
 * On 易支付 notify → credit balance (not product grant).
 */
api.post('/client/balance/topup', authMiddleware('user'), (req, res) => {
  // accept yuan (amount) or cents (amount_cents)
  let amountCents = Math.floor(Number(req.body?.amount_cents) || 0)
  if (!amountCents && req.body?.amount != null) {
    amountCents = Math.round(Number(req.body.amount) * 100)
  }
  if (
    !Number.isFinite(amountCents) ||
    amountCents < BALANCE_TOPUP_MIN_CENTS ||
    amountCents > BALANCE_TOPUP_MAX_CENTS
  ) {
    return res.status(400).json({
      error: `充值金额需在 ¥${formatYuan(BALANCE_TOPUP_MIN_CENTS)} ~ ¥${formatYuan(BALANCE_TOPUP_MAX_CENTS)} 之间`,
    })
  }
  const payTypeRaw = String(req.body?.pay_type || 'alipay').toLowerCase()
  const payType = ['alipay', 'wxpay', 'qqpay'].includes(payTypeRaw)
    ? payTypeRaw
    : 'alipay'
  try {
    const result = db.write((data) => {
      ensureOrders(data)
      expirePendingOrders(data)
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      if (user.status !== 'active') throw new Error('账号已被禁用')
      const cfg = getEzpayConfig()
      if (!cfg.enabled) throw new Error('在线支付未配置，请联系管理员')

      const now = nowTs()
      const orderId = nanoid()
      const outTradeNo = makeOutTradeNo()
      const money = yuanFromCents(amountCents)
      const pendingExpiresAt = now + 30 * 60
      let payUrl
      try {
        payUrl = buildPayUrl({
          outTradeNo,
          name: `余额充值 ¥${formatYuan(amountCents)}`,
          moneyYuan: money,
          type: payType,
          returnPath: '/pay-return.html',
        })
      } catch (e) {
        throw new Error(e.message || '生成支付链接失败')
      }
      const order = {
        id: orderId,
        out_trade_no: outTradeNo,
        user_id: user.id,
        product_id: BALANCE_TOPUP_PRODUCT,
        product_name: `余额充值 ¥${formatYuan(amountCents)}`,
        order_kind: 'balance_topup',
        money_cents: amountCents,
        balance_credit_cents: amountCents,
        gateway_cents: amountCents,
        balance_applied_cents: 0,
        original_cents: amountCents,
        discount_cents: 0,
        money,
        pay_type: payType,
        status: 'pending',
        payment_expires_at: pendingExpiresAt,
        trade_no: '',
        pay_url: payUrl,
        expire_at: 0,
        created_at: now,
        paid_at: 0,
        updated_at: now,
        balance_released: true,
      }
      data.orders.push(order)
      appendAudit(data, {
        actor: user.username,
        actor_type: 'user',
        action: 'balance.topup_create',
        target: orderId,
        detail: { amount_cents: amountCents, pay_type: payType },
        ip: clientIp(req),
      })
      return {
        need_pay: true,
        status: 'pending',
        order_id: orderId,
        out_trade_no: outTradeNo,
        pay_url: payUrl,
        product_id: BALANCE_TOPUP_PRODUCT,
        name: `余额充值 ¥${formatYuan(amountCents)}`,
        amount_cents: amountCents,
        price_cents: amountCents,
        expire_at: 0,
        message: `请支付 ¥${formatYuan(amountCents)} 完成充值`,
      }
    })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/** Client: list / remove own devices */
api.get('/client/devices', authMiddleware('user'), (req, res) => {
  const data = db.read()
  const user = data.users.find((u) => u.id === req.auth.sub)
  if (!user) return res.status(401).json({ error: '请先登录' })
  res.json({
    items: ensureDevices(user),
    max: getMaxDevices(data.settings),
  })
})

api.delete('/client/devices/:deviceId', authMiddleware('user'), (req, res) => {
  try {
    db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      removeDevice(user, req.params.deviceId)
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

api.post('/client/devices/register', authMiddleware('user'), (req, res) => {
  try {
    let out
    db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      out = registerDevice(user, data.settings || {}, {
        device_id: req.body?.device_id,
        name: req.body?.name || req.body?.device_name,
        platform: req.body?.platform,
      })
      if (!out.ok) throw new Error(out.error)
    })
    res.json(out)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/**
 * Redeem coupon / gift code → grant product entitlement
 * Body: { code }
 */
api.post('/client/redeem', authMiddleware('user'), (req, res) => {
  const ip = clientIp(req)
  const rl = hitRateLimit(`redeem:${ip}:${req.auth.sub}`, { limit: 15, windowMs: 600_000 })
  if (!rl.ok) return res.status(429).json({ error: rl.error })
  const code = normalizeCouponCode(req.body?.code)
  if (!code || code.length < 4) {
    return res.status(400).json({ error: '请输入有效兑换码' })
  }
  try {
    const result = db.write((data) => {
      ensureCoupons(data)
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      if (user.status !== 'active') throw new Error('账号已被禁用')

      const coupon = data.coupons.find((c) => normalizeCouponCode(c.code) === code)
      if (!coupon) throw new Error('兑换码不存在')
      if (coupon.status === 'disabled') throw new Error('兑换码已停用')
      const now = nowTs()
      if (coupon.expire_at > 0 && coupon.expire_at < now) {
        throw new Error('兑换码已过期')
      }
      const maxUses = Number(coupon.max_uses || 0)
      const used = Number(coupon.used_count || 0)
      if (maxUses > 0 && used >= maxUses) throw new Error('兑换码已达使用上限')

      if (!Array.isArray(coupon.redemptions)) coupon.redemptions = []
      const perUser = Number(coupon.per_user_limit ?? 1)
      const userUsed = coupon.redemptions.filter((r) => r.user_id === user.id).length
      if (perUser > 0 && userUsed >= perUser) {
        throw new Error('您已使用过该兑换码')
      }

      const product = data.plans.find((p) => p.id === coupon.product_id)
      if (!product || isSystemPlan(product)) throw new Error('兑换码绑定的商品无效')
      if (!product.source_id) throw new Error('商品未绑定订阅源')

      const days = Number(coupon.days || productDurationDays(product))
      const { expire_at } = grantPurchase(user, product, { days })
      coupon.used_count = used + 1
      coupon.redemptions.push({
        user_id: user.id,
        username: user.username,
        at: now,
      })
      coupon.updated_at = now

      return {
        ok: true,
        code: coupon.code,
        product_id: product.id,
        name: product.name,
        days,
        expire_at,
        message: `已兑换 ${product.name}（${days} 天）`,
        access_key: accessFingerprint(data, user),
      }
    })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/** User order history (own orders only) */
api.get('/client/orders', authMiddleware('user'), (req, res) => {
  const data = db.read()
  ensureOrders(data)
  const items = data.orders
    .filter((o) => o.user_id === req.auth.sub)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, 100)
    .map((o) => {
      const isTopup =
        o.order_kind === 'balance_topup' || o.product_id === BALANCE_TOPUP_PRODUCT
      return {
        order_id: o.id,
        out_trade_no: o.out_trade_no,
        status: o.status,
        product_id: o.product_id,
        name: o.product_name,
        order_kind: o.order_kind || (isTopup ? 'balance_topup' : 'product'),
        money: o.money || formatYuan(o.money_cents || 0),
        money_cents: o.money_cents,
        balance_applied_cents: o.balance_applied_cents || 0,
        gateway_cents: o.gateway_cents != null ? o.gateway_cents : o.money_cents,
        balance_refund_cents: o.balance_refund_cents || 0,
        refund_destination: o.refund_destination || '',
        pay_type: o.pay_type || '',
        trade_no: o.trade_no || '',
        expire_at: o.expire_at || 0,
        created_at: o.created_at || 0,
        paid_at: o.paid_at || 0,
        refunded_at: o.refunded_at || 0,
        pay_url: o.status === 'pending' ? o.pay_url || '' : '',
      }
    })
  res.json({ items })
})

/** User change password */
api.post('/client/change-password', authMiddleware('user'), (req, res) => {
  const oldPassword = String(req.body?.old_password || '')
  const newPassword = String(req.body?.new_password || '')
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' })
  }
  if (oldPassword === newPassword) {
    return res.status(400).json({ error: '新密码不能与原密码相同' })
  }
  try {
    db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      if (!checkPassword(oldPassword, user.password_hash)) {
        throw new Error('原密码错误')
      }
      user.password_hash = hashPassword(newPassword)
      user.updated_at = nowTs()
    })
    res.json({ ok: true, message: '密码已修改，请牢记新密码' })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/**
 * Bind or rebind email (password required when account already has email)
 * Body: { email, password }
 */
api.post('/client/change-email', authMiddleware('user'), (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase()
  const password = String(req.body?.password || '')
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: '请填写有效邮箱' })
  }
  try {
    const result = db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      const current = String(user.email || '')
        .trim()
        .toLowerCase()
      // rebind or first bind: verify password if already has email or always for safety
      if (!checkPassword(password, user.password_hash)) {
        throw new Error('密码错误')
      }
      if (current === email) {
        throw new Error('新邮箱与当前邮箱相同')
      }
      if (
        data.users.some(
          (u) =>
            u.id !== user.id &&
            String(u.email || '')
              .trim()
              .toLowerCase() === email,
        )
      ) {
        throw new Error('该邮箱已被其他账号使用')
      }
      const wasEmpty = !current
      user.email = email
      user.updated_at = nowTs()
      return {
        ok: true,
        email,
        message: wasEmpty ? '邮箱绑定成功' : '邮箱已更换',
      }
    })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/** Shop catalog: free zone + paid products */
api.get('/client/catalog', authMiddleware('user'), (req, res) => {
  const data = db.read()
  const user = data.users.find((u) => u.id === req.auth.sub)
  if (!user) return res.status(401).json({ error: '请先登录' })
  const catalog = getCatalog(data, user)
  res.json({
    free: catalog.free,
    paid: catalog.paid,
    purchases: user.purchases || [],
    access_key: accessFingerprint(data, user),
  })
})

/** Product detail for checkout page */
api.get('/client/catalog/:id', authMiddleware('user'), (req, res) => {
  const data = db.read()
  const user = data.users.find((u) => u.id === req.auth.sub)
  if (!user) return res.status(401).json({ error: '请先登录' })
  const catalog = getCatalog(data, user)
  const all = [...catalog.free, ...catalog.paid]
  const item = all.find((p) => p.id === req.params.id)
  if (!item) return res.status(404).json({ error: '商品不存在或已下架' })
  res.json({ item, access_key: accessFingerprint(data, user) })
})

/** Preview coupon + optional balance application on a product (no consume) */
api.post('/client/checkout/preview', authMiddleware('user'), (req, res) => {
  const productId = String(req.body?.product_id || '')
  const code = req.body?.coupon_code || req.body?.code || ''
  const useBalance = req.body?.use_balance !== false && req.body?.use_balance !== 0
  try {
    const data = db.read()
    const user = data.users.find((u) => u.id === req.auth.sub)
    if (!user) throw new Error('用户不存在')
    ensureBalance(user)
    const product = data.plans.find((p) => p.id === productId)
    if (!isSellableProduct(product)) throw new Error('商品不存在或已下架')
    const base = Math.max(0, Number(product.price_cents || 0))
    let pricing = {
      original_cents: base,
      final_cents: base,
      discount_cents: 0,
      free: base <= 0,
      label: base <= 0 ? '免费' : '原价',
    }
    if (code) {
      const found = findValidCoupon(data, code, user.id, productId)
      if (!found.ok) return res.status(400).json({ error: found.error })
      pricing = applyCouponPricing(product, found.coupon)
    }
    const bal = planBalanceApplication(user, pricing.final_cents, useBalance)
    res.json({
      ok: true,
      ...pricing,
      coupon_code: code ? normCheckoutCoupon(code) : undefined,
      balance_cents: bal.balance_cents,
      balance_yuan: formatYuan(bal.balance_cents),
      balance_applied_cents: bal.balance_applied_cents,
      gateway_cents: bal.gateway_cents,
      fully_covered_by_balance: bal.fully_covered && pricing.final_cents > 0,
      use_balance: useBalance,
    })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/**
 * Self-serve purchase (from product detail):
 * Body: { product_id, pay_type?, coupon_code?, use_balance? }
 * - free / coupon grant / discounted-to-0 → instant grant
 * - balance fully covers → debit balance + instant grant
 * - partial balance → hold balance + 易支付 remainder
 * - no balance → 易支付 full final price
 */
api.post('/client/purchase', authMiddleware('user'), (req, res) => {
  const productId = String(req.body?.product_id || '')
  if (!productId) return res.status(400).json({ error: '缺少 product_id' })

  const payTypeRaw = String(req.body?.pay_type || 'alipay').toLowerCase()
  const payType = ['alipay', 'wxpay', 'qqpay'].includes(payTypeRaw)
    ? payTypeRaw
    : 'alipay'
  const couponCode = req.body?.coupon_code || req.body?.code || ''
  const useBalance = req.body?.use_balance !== false && req.body?.use_balance !== 0

  try {
    const result = db.write((data) => {
      ensureOrders(data)
      expirePendingOrders(data)
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      if (user.status !== 'active') throw new Error('账号已被禁用')
      ensureBalance(user)

      const product = data.plans.find((p) => p.id === productId)
      if (!isSellableProduct(product)) throw new Error('商品不存在或已下架')
      if (!product.source_id) throw new Error('商品未绑定付费订阅源')

      let priceCents = Math.max(0, Number(product.price_cents || 0))
      let pricing = {
        original_cents: priceCents,
        final_cents: priceCents,
        discount_cents: 0,
        free: priceCents <= 0,
        label: priceCents <= 0 ? '免费' : '原价',
      }
      let coupon = null
      if (couponCode) {
        const found = findValidCoupon(data, couponCode, user.id, productId)
        if (!found.ok) throw new Error(found.error)
        coupon = found.coupon
        pricing = applyCouponPricing(product, coupon)
        priceCents = pricing.final_cents
      }

      // Free / fully discounted / grant coupon
      if (priceCents <= 0 || pricing.free) {
        if (coupon) consumeCoupon(coupon, user.id, productId)
        const { expire_at } = grantPurchase(user, product)
        return {
          need_pay: false,
          status: 'paid',
          product_id: productId,
          name: product.name,
          expire_at,
          price_cents: 0,
          original_cents: pricing.original_cents,
          discount_cents: pricing.discount_cents,
          balance_applied_cents: 0,
          gateway_cents: 0,
          balance_cents: getBalanceCents(user),
          coupon_applied: Boolean(coupon),
          message: coupon
            ? `已使用优惠开通 ${product.name}`
            : `已开通 ${product.name}`,
          access_key: accessFingerprint(data, user),
        }
      }

      const balPlan = planBalanceApplication(user, priceCents, useBalance)
      const balanceApplied = balPlan.balance_applied_cents
      const gatewayCents = balPlan.gateway_cents

      // Fully covered by store balance
      if (gatewayCents <= 0 && balanceApplied > 0) {
        if (coupon) consumeCoupon(coupon, user.id, productId)
        const now = nowTs()
        const orderId = nanoid()
        const outTradeNo = makeOutTradeNo()
        debitBalance(user, balanceApplied, {
          type: 'purchase',
          reason: `购买 ${product.name}`,
          ref_type: 'order',
          ref_id: orderId,
          actor: user.username,
        })
        const grant = grantPurchase(user, product, { order_id: orderId })
        data.orders.push({
          id: orderId,
          out_trade_no: outTradeNo,
          user_id: user.id,
          product_id: product.id,
          product_name: product.name,
          money_cents: priceCents,
          original_cents: pricing.original_cents,
          discount_cents: pricing.discount_cents,
          balance_applied_cents: balanceApplied,
          gateway_cents: 0,
          coupon_code: coupon ? normCheckoutCoupon(couponCode) : '',
          coupon_id: coupon?.id || '',
          money: yuanFromCents(priceCents),
          pay_type: 'balance',
          status: 'paid',
          trade_no: '',
          pay_url: '',
          expire_at: grant.expire_at,
          traffic_pool: grant.traffic_pool,
          granted_traffic_bytes: grant.traffic_limit_bytes,
          granted_days: grant.days,
          created_at: now,
          paid_at: now,
          updated_at: now,
          balance_released: true,
        })

        return {
          need_pay: false,
          status: 'paid',
          order_id: orderId,
          out_trade_no: outTradeNo,
          product_id: productId,
          name: product.name,
          expire_at: grant.expire_at,
          price_cents: priceCents,
          original_cents: pricing.original_cents,
          discount_cents: pricing.discount_cents,
          balance_applied_cents: balanceApplied,
          gateway_cents: 0,
          balance_cents: getBalanceCents(user),
          coupon_applied: Boolean(coupon),
          message: `已使用余额 ¥${formatYuan(balanceApplied)} 开通 ${product.name}`,
          access_key: accessFingerprint(data, user),
        }
      }

      const cfg = getEzpayConfig()
      if (!cfg.enabled) {
        throw new Error('在线支付未配置，请联系管理员')
      }
      if (gatewayCents <= 0) {
        throw new Error('应付金额异常')
      }

      const now = nowTs()
      const outTradeNo = makeOutTradeNo()
      const money = yuanFromCents(gatewayCents)
      const orderId = nanoid()
      const couponReservationId = coupon ? nanoid(18) : ''
      const pendingExpiresAt = now + 30 * 60
      if (coupon) {
        reserveCoupon(coupon, user.id, productId, couponReservationId, pendingExpiresAt)
      }

      // Hold balance immediately; released on cancel/expire, or kept on paid
      // (refund credits full money_cents including this hold).
      if (balanceApplied > 0) {
        debitBalance(user, balanceApplied, {
          type: 'purchase_hold',
          reason: `下单预扣 ${product.name}`,
          ref_type: 'order',
          ref_id: orderId,
          actor: user.username,
        })
      }

      const order = {
        id: orderId,
        out_trade_no: outTradeNo,
        user_id: user.id,
        product_id: product.id,
        product_name: product.name,
        money_cents: priceCents,
        original_cents: pricing.original_cents,
        discount_cents: pricing.discount_cents,
        balance_applied_cents: balanceApplied,
        gateway_cents: gatewayCents,
        coupon_code: coupon ? normCheckoutCoupon(couponCode) : '',
        coupon_id: coupon?.id || '',
        coupon_reservation_id: couponReservationId,
        coupon_reservation_expires_at: coupon ? pendingExpiresAt : 0,
        money,
        pay_type: payType,
        status: 'pending',
        payment_expires_at: pendingExpiresAt,
        trade_no: '',
        pay_url: '',
        expire_at: 0,
        created_at: now,
        paid_at: 0,
        updated_at: now,
        balance_released: false,
      }

      let payUrl
      try {
        payUrl = buildPayUrl({
          outTradeNo,
          name: product.name,
          moneyYuan: money,
          type: payType,
          returnPath: '/pay-return.html',
        })
      } catch (e) {
        // roll back balance hold if pay URL fails
        if (balanceApplied > 0) {
          creditBalance(user, balanceApplied, {
            type: 'order_release',
            reason: 'pay_url_failed',
            ref_type: 'order',
            ref_id: orderId,
            actor: 'system',
          })
        }
        throw new Error(e.message || '生成支付链接失败')
      }
      order.pay_url = payUrl
      data.orders.push(order)

      return {
        need_pay: true,
        status: 'pending',
        order_id: order.id,
        out_trade_no: outTradeNo,
        pay_url: payUrl,
        product_id: productId,
        name: product.name,
        expire_at: 0,
        price_cents: priceCents,
        original_cents: pricing.original_cents,
        discount_cents: pricing.discount_cents,
        balance_applied_cents: balanceApplied,
        gateway_cents: gatewayCents,
        balance_cents: getBalanceCents(user),
        coupon_applied: Boolean(coupon),
        message:
          balanceApplied > 0
            ? `已预扣余额 ¥${formatYuan(balanceApplied)}，请再支付 ¥${formatYuan(gatewayCents)}`
            : '请在打开的页面完成支付',
      }
    })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/** Daily check-in */
api.get('/client/checkin', authMiddleware('user'), (req, res) => {
  try {
    // Persist entitlement heal so is_paid_user matches refund state
    const status = db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('请先登录')
      return checkinStatus(user, data)
    })
    res.json(status)
  } catch (e) {
    res.status(e.message === '请先登录' ? 401 : 400).json({ error: e.message })
  }
})

api.post('/client/checkin', authMiddleware('user'), (req, res) => {
  try {
    const result = db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      if (user.status !== 'active') throw new Error('账号已被禁用')
      const r = doCheckin(user, data)
      appendAudit(data, {
        actor: user.username,
        actor_type: 'user',
        action: 'checkin',
        target: user.id,
        detail: r,
        ip: clientIp(req),
      })
      return r
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/** Invite activity public info for client */
api.get('/client/invite/info', authMiddleware('user'), (req, res) => {
  const data = db.read()
  const user = data.users.find((u) => u.id === req.auth.sub)
  if (!user) return res.status(401).json({ error: '请先登录' })
  ensureUserInviteCode(user)
  // persist code if newly generated
  db.write((d) => {
    const u = d.users.find((x) => x.id === user.id)
    if (u) ensureUserInviteCode(u)
  })
  const cfg = getInviteConfig(data.settings || {})
  const invited = (data.invite_redemptions || []).filter((r) => r.inviter_id === user.id)
  res.json({
    enabled: cfg.enabled,
    invite_code: user.invite_code,
    reward_days: cfg.reward_days,
    reward_traffic_gb: cfg.reward_traffic_gb,
    invitee_days: cfg.invitee_days,
    invitee_traffic_gb: cfg.invitee_traffic_gb,
    invited_count: invited.length,
    reward_count: user.invite_reward_count || 0,
  })
})

/** Client polls order after browser payment */
api.get('/client/orders/:id', authMiddleware('user'), (req, res) => {
  const data = db.read()
  ensureOrders(data)
  const id = String(req.params.id || '')
  const order = data.orders.find(
    (o) =>
      o.user_id === req.auth.sub && (o.id === id || o.out_trade_no === id),
  )
  if (!order) return res.status(404).json({ error: '订单不存在' })

  const user = data.users.find((u) => u.id === order.user_id)
  const isTopup = isBalanceTopupOrder(order)
  res.json({
    order_id: order.id,
    out_trade_no: order.out_trade_no,
    status: order.status,
    product_id: order.product_id,
    name: order.product_name,
    order_kind: order.order_kind || (isTopup ? 'balance_topup' : 'product'),
    expire_at: order.expire_at || 0,
    price_cents: order.money_cents || 0,
    paid_at: order.paid_at || 0,
    pay_url: order.status === 'pending' ? order.pay_url || '' : '',
    balance_cents: user ? getBalanceCents(user) : undefined,
    message:
      order.status === 'paid'
        ? isTopup
          ? `充值成功，余额 ¥${formatYuan(getBalanceCents(user))}`
          : `已开通 ${order.product_name}`
        : order.status === 'pending'
          ? '等待支付'
          : order.status,
    access_key:
      order.status === 'paid' && user && !isTopup
        ? accessFingerprint(data, user)
        : undefined,
  })
})

/**
 * 易支付异步通知 — must respond plain text "success"
 * GET/POST both supported (query + body merged)
 */
function handleEzpayNotify(req, res) {
  const cfg = getEzpayConfig()
  if (!cfg.enabled) {
    console.error('[ezpay] notify while not configured')
    return res.status(400).type('text/plain').send('fail')
  }

  const q = { ...(req.query || {}), ...(req.body || {}) }
  if (!verifyEzpayNotify(q, cfg.key)) {
    console.error('[ezpay] bad sign', q.out_trade_no)
    return res.status(400).type('text/plain').send('fail')
  }

  if (String(q.pid || '') !== cfg.pid) {
    console.error('[ezpay] pid mismatch')
    return res.status(400).type('text/plain').send('fail')
  }

  const tradeStatus = String(q.trade_status || '')
  // non-success: still ack so gateway stops retrying weird states carefully
  if (tradeStatus && tradeStatus !== 'TRADE_SUCCESS') {
    return res.type('text/plain').send('success')
  }

  const outTradeNo = String(q.out_trade_no || '')
  if (!outTradeNo) {
    return res.status(400).type('text/plain').send('fail')
  }

  try {
    db.write((data) => {
      ensureOrders(data)
      const order = data.orders.find((o) => o.out_trade_no === outTradeNo)
      if (!order) throw new Error(`order not found: ${outTradeNo}`)
      if (order.status === 'paid') return
      if (order.status !== 'pending' && order.status !== 'pending_payment') {
        appendAudit(data, {
          actor: 'ezpay',
          actor_type: 'system',
          action: 'payment.notify_ignored',
          target: order.id,
          detail: { order_status: order.status, out_trade_no: outTradeNo },
          ip: clientIp(req),
        })
        return
      }

      const expected = Number(order.money).toFixed(2)
      const got = Number(q.money).toFixed(2)
      if (expected !== got) {
        throw new Error(`money mismatch expected=${expected} got=${got}`)
      }

      fulfillPaidOrder(data, order, String(q.trade_no || ''))
      console.log(
        `[ezpay] paid ${outTradeNo} user=${order.user_id} product=${order.product_name}`,
      )
    })
    res.type('text/plain').send('success')
  } catch (e) {
    console.error('[ezpay] notify error', e.message || e)
    res.status(400).type('text/plain').send('fail')
  }
}

api.get('/pay/ezpay/notify', handleEzpayNotify)
api.post('/pay/ezpay/notify', handleEzpayNotify)

/** Admin: recent orders */
api.get('/admin/orders', authMiddleware('admin'), (_req, res) => {
  const data = db.read()
  ensureOrders(data)
  const items = [...data.orders]
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, 300)
    .map((o) => {
      const user = data.users.find((u) => u.id === o.user_id)
      const isTopup =
        o.order_kind === 'balance_topup' || o.product_id === BALANCE_TOPUP_PRODUCT
      return {
        id: o.id,
        out_trade_no: o.out_trade_no,
        username: user?.username || o.user_id,
        product_name: o.product_name,
        order_kind: o.order_kind || (isTopup ? 'balance_topup' : 'product'),
        money: o.money || formatYuan(o.money_cents || 0),
        money_cents: o.money_cents,
        balance_applied_cents: o.balance_applied_cents || 0,
        gateway_cents: o.gateway_cents,
        status: o.status,
        pay_type: o.pay_type,
        trade_no: o.trade_no || '',
        created_at: o.created_at,
        paid_at: o.paid_at || 0,
        refunded_at: o.refunded_at || 0,
        refund_destination: o.refund_destination || '',
      }
    })
  res.json({ items, ezpay_enabled: getEzpayConfig().enabled })
})

// ---------- support tickets ----------
api.get('/client/tickets', authMiddleware('user'), (req, res) => {
  const data = db.read()
  res.json({
    items: listUserTickets(data, req.auth.sub, 50),
    categories: TICKET_CATEGORY_LABELS,
  })
})

api.post('/client/tickets', authMiddleware('user'), (req, res) => {
  try {
    const result = db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      if (user.status !== 'active') throw new Error('账号已被禁用')
      const ticket = createTicket(data, user, {
        subject: req.body?.subject,
        body: req.body?.body || req.body?.content,
        category: req.body?.category,
      })
      appendAudit(data, {
        actor: user.username,
        actor_type: 'user',
        action: 'ticket.create',
        target: ticket.id,
        detail: { subject: ticket.subject, category: ticket.category },
        ip: clientIp(req),
      })
      return publicTicket(ticket)
    })
    res.json({ ok: true, ticket: result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

api.get('/client/tickets/:id', authMiddleware('user'), (req, res) => {
  const data = db.read()
  const t = getTicket(data, req.params.id)
  if (!t || t.user_id !== req.auth.sub) {
    return res.status(404).json({ error: '工单不存在' })
  }
  res.json({ ticket: publicTicket(t) })
})

api.post('/client/tickets/:id/reply', authMiddleware('user'), (req, res) => {
  try {
    const result = db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      const t = getTicket(data, req.params.id)
      if (!t || t.user_id !== user.id) throw new Error('工单不存在')
      replyTicket(data, t, {
        role: 'user',
        author: user.username,
        body: req.body?.body || req.body?.content,
      })
      return publicTicket(t)
    })
    res.json({ ok: true, ticket: result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

api.post('/client/tickets/:id/close', authMiddleware('user'), (req, res) => {
  try {
    const result = db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      const t = getTicket(data, req.params.id)
      if (!t || t.user_id !== user.id) throw new Error('工单不存在')
      closeTicket(data, t, user.username)
      return publicTicket(t)
    })
    res.json({ ok: true, ticket: result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

api.get('/admin/tickets', authMiddleware('admin'), (req, res) => {
  const data = db.read()
  const status = String(req.query?.status || '')
  res.json({
    items: listAdminTickets(data, { status, limit: Number(req.query?.limit || 100) }),
    categories: TICKET_CATEGORY_LABELS,
  })
})

api.get('/admin/tickets/:id', authMiddleware('admin'), (req, res) => {
  const data = db.read()
  const t = getTicket(data, req.params.id)
  if (!t) return res.status(404).json({ error: '工单不存在' })
  res.json({
    ticket: {
      ...publicTicket(t),
      user_id: t.user_id,
      username: t.username,
    },
  })
})

api.post('/admin/tickets/:id/reply', authMiddleware('admin'), (req, res) => {
  try {
    const actor = req.auth?.username || req.auth?.sub || 'admin'
    const result = db.write((data) => {
      const t = getTicket(data, req.params.id)
      if (!t) throw new Error('工单不存在')
      replyTicket(data, t, {
        role: 'admin',
        author: actor,
        body: req.body?.body || req.body?.content,
      })
      appendAudit(data, {
        actor,
        actor_type: 'admin',
        action: 'ticket.reply',
        target: t.id,
        detail: {},
        ip: clientIp(req),
      })
      return {
        ...publicTicket(t),
        user_id: t.user_id,
        username: t.username,
      }
    })
    res.json({ ok: true, ticket: result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

api.post('/admin/tickets/:id/close', authMiddleware('admin'), (req, res) => {
  try {
    const actor = req.auth?.username || req.auth?.sub || 'admin'
    const result = db.write((data) => {
      const t = getTicket(data, req.params.id)
      if (!t) throw new Error('工单不存在')
      closeTicket(data, t, actor)
      appendAudit(data, {
        actor,
        actor_type: 'admin',
        action: 'ticket.close',
        target: t.id,
        detail: {},
        ip: clientIp(req),
      })
      return {
        ...publicTicket(t),
        user_id: t.user_id,
        username: t.username,
      }
    })
    res.json({ ok: true, ticket: result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/**
 * Client reports traffic usage (bytes since last report or absolute totals).
 * Body: { delta_bytes, pool? } or { upload, download, pool? }
 * pool: 'free' | 'paid' | 'auto' (default auto)
 * Enforcement is soft without a middle proxy; over-quota blocks /client/subscription.
 */
api.post('/client/traffic/report', authMiddleware('user'), (req, res) => {
  try {
    let delta = Number(req.body?.delta_bytes)
    if (!Number.isFinite(delta) || delta < 0) {
      const up = Math.max(0, Math.floor(Number(req.body?.upload) || 0))
      const down = Math.max(0, Math.floor(Number(req.body?.download) || 0))
      delta = up + down
    }
    delta = Math.floor(delta)
    if (delta > 50 * 1024 * 1024 * 1024) {
      return res.status(400).json({ error: '单次上报流量过大' })
    }
    const rawPool = String(req.body?.pool || 'auto').toLowerCase()
    const pool =
      rawPool === 'paid' || rawPool === 'free' || rawPool === 'auto' ? rawPool : 'auto'

    let traffic
    let appliedPool = pool === 'auto' ? 'free' : pool
    db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      migrateToDualWallets(user, data)
      if (delta > 0) {
        const result = applyTrafficDelta(user, data, delta, pool)
        appliedPool = result?.pool || appliedPool
      }
      traffic = getUserTraffic(user, data)
    })

    res.json({
      ok: true,
      applied: delta,
      pool: appliedPool,
      traffic: {
        free: traffic.free,
        paid: traffic.paid,
        is_paid_user: traffic.is_paid_user,
        unlimited: traffic.unlimited,
        limit_bytes: traffic.limit_bytes,
        used_bytes: traffic.used_bytes,
        remaining_bytes: traffic.remaining_bytes,
        exhausted: traffic.exhausted,
        label: traffic.label,
      },
    })
  } catch (e) {
    res.status(e.message === '用户不存在' ? 404 : 400).json({ error: e.message })
  }
})

/** Merge free + purchased paid sources for the client proxy list */
api.get('/client/subscription', authMiddleware('user'), async (req, res) => {
  try {
    const ip = clientIp(req)
    const rl = hitRateLimit(`sub:${req.auth.sub}`, { limit: 60, windowMs: 600_000 })
    if (!rl.ok) return res.status(429).json({ error: rl.error })

    const data = db.read()
    const rawUser = data.users.find((u) => u.id === req.auth.sub)
    if (!rawUser) return res.status(401).json({ error: '请先登录' })
    const err = ensureActive(rawUser)
    if (err) return res.status(403).json({ error: err })

    db.write((d) => {
      const u = d.users.find((x) => x.id === rawUser.id)
      if (!u) return
      maybeResetMonthlyTraffic(u, d)
      migrateToDualWallets(u, d)
      rawUser.traffic = u.traffic
      rawUser.purchases = u.purchases
    })

    const traffic = getUserTraffic(rawUser, data)
    let sources = getAccessibleSources(data, rawUser)

    // dual-pool gate: drop locked sources if paid pool exhausted
    if (traffic.paid?.exhausted) {
      sources = sources.filter((s) => {
        const access = s.access === 'locked' || s.tier === 'paid' ? 'locked' : 'public'
        return access === 'public'
      })
    }
    // free pool exhausted (limited): still keep locked if paid ok; drop nothing for public
    // if paid exhausted and free also exhausted with only public left → allow public if free unlimited
    if (traffic.free?.exhausted && traffic.paid?.exhausted) {
      return res.status(403).json({
        error: '免费与付费流量均已用尽，请续费或签到领取',
        traffic: {
          free: traffic.free,
          paid: traffic.paid,
          exhausted: true,
          label: traffic.label,
        },
      })
    }
    if (traffic.paid?.exhausted && sources.length === 0) {
      return res.status(403).json({
        error: '付费流量已用尽，且无可同步的公开线路',
        traffic: { free: traffic.free, paid: traffic.paid, exhausted: true },
      })
    }

    const merged = await mergeSourcesForUser(sources, rawUser.username)
    const entitlementUntil = maxPurchaseExpireAt(rawUser, nowTs())

    // Dashboard: show paid pool if paid user, else free (plus dual in new fields)
    const show = traffic.is_paid_user && !traffic.paid.unlimited ? traffic.paid : traffic.free
    const trafficTotal = show.unlimited
      ? Math.max(show.used_bytes + 1024 ** 4, 1024 ** 4)
      : show.limit_bytes
    const trafficUsed = show.used_bytes

    res.json({
      name: merged.name,
      updated_at: nowTs(),
      expire_at: entitlementUntil || rawUser.expire_at || 0,
      plan: enrichUser(rawUser, data)?.plan_name || 'free',
      content: merged.content,
      source: merged.from,
      traffic_upload: 0,
      traffic_download: trafficUsed,
      traffic_total: trafficTotal,
      traffic_unlimited: show.unlimited,
      traffic_remaining: show.remaining_bytes,
      traffic_exhausted: show.exhausted,
      traffic_label: `免费 ${traffic.free.label} · 付费 ${traffic.paid.label}`,
      traffic_free: traffic.free,
      traffic_paid: traffic.paid,
      is_paid_user: traffic.is_paid_user,
      node_count: merged.node_count,
      free_count: merged.free_count,
      paid_count: merged.paid_count,
      nodes: (merged.nodes || []).slice(0, 300),
      parts: merged.parts,
      access_key: accessFingerprint(data, rawUser),
      paid_sources_filtered: traffic.paid?.exhausted || false,
    })
  } catch (e) {
    res.status(502).json({ error: e.message || '拉取订阅失败' })
  }
})

api.get('/client/announcement', authMiddleware('user'), (_req, res) => {
  const items = db
    .read()
    .announcements.filter((a) => a.active)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 10)
    .map(({ id, title, body, created_at }) => ({ id, title, body, created_at }))
  res.json({ items })
})

api.post('/admin/login', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const admin = db.read().admins.find((a) => a.username === username)
  if (!admin || !checkPassword(password, admin.password_hash)) {
    return res.status(401).json({ error: '管理员账号或密码错误' })
  }
  res.json({ token: signAdminToken(admin), username: admin.username })
})

api.get('/admin/stats', authMiddleware('admin'), (_req, res) => {
  const data = db.read()
  const now = nowTs()
  const active = data.users.filter(
    (u) => u.status === 'active' && (u.expire_at === 0 || u.expire_at > now),
  )
  let paidUsers = 0
  let activePurchases = 0
  for (const u of data.users) {
    const ps = Array.isArray(u.purchases) ? u.purchases : []
    const live = ps.filter((p) => !p.expire_at || p.expire_at === 0 || p.expire_at > now)
    if (live.length) paidUsers += 1
    activePurchases += live.length
  }
  const products = data.plans.filter((p) => !isSystemPlan(p))
  res.json({
    users: data.users.length,
    active: active.length,
    paid_users: paidUsers,
    active_purchases: activePurchases,
    sources: data.subscription_sources.length,
    public_sources: data.subscription_sources.filter(
      (s) => s.access === 'public' || (s.access !== 'locked' && s.tier !== 'paid'),
    ).length,
    locked_sources: data.subscription_sources.filter(
      (s) => s.access === 'locked' || s.tier === 'paid',
    ).length,
    free_sources: data.subscription_sources.filter(
      (s) => s.access === 'public' || (s.access !== 'locked' && s.tier !== 'paid'),
    ).length,
    paid_sources: data.subscription_sources.filter(
      (s) => s.access === 'locked' || s.tier === 'paid',
    ).length,
    plans: data.plans.length,
    products_on_sale: products.filter((p) => p.for_sale !== false).length,
    announcements: (data.announcements || []).length,
  })
})

api.get('/admin/users', authMiddleware('admin'), (_req, res) => {
  const data = db.read()
  const now = nowTs()
  const items = data.users
    .map((u) => {
      const full = enrichUser(u, data)
      const entitlementUntil = maxPurchaseExpireAt(u, now)
      const activePurchases = (full.purchases || []).length
      const traffic = getUserTraffic(u, data, now)
      return {
        id: u.id,
        username: u.username,
        email: u.email || '',
        status: u.status,
        // legacy field kept for admin optional edit
        expire_at: u.expire_at || 0,
        entitlement_until: entitlementUntil,
        active_purchases: activePurchases,
        created_at: u.created_at,
        updated_at: u.updated_at,
        plan_name: full.plan_name,
        purchase_names: full.purchase_names,
        free_sources: full.free_sources,
        paid_sources: full.paid_sources,
        purchases: full.purchases,
        traffic_unlimited: traffic.unlimited,
        traffic_limit_bytes: traffic.limit_bytes,
        traffic_used_bytes: traffic.used_bytes,
        traffic_remaining_bytes: traffic.remaining_bytes,
        traffic_exhausted: traffic.exhausted,
        traffic_free: traffic.free,
        traffic_paid: traffic.paid,
        is_paid_user: traffic.is_paid_user,
        traffic_label: `免费 ${traffic.free?.label || '—'} · 付费 ${traffic.paid?.label || '—'}`,
        balance_cents: getBalanceCents(u),
        balance_yuan: formatYuan(getBalanceCents(u)),
      }
    })
    .sort((a, b) => b.created_at - a.created_at)
  res.json({ items })
})

/**
 * Admin adjust user store balance.
 * Body: { delta_cents }  positive=credit, negative=debit
 *    or { amount_cents, direction: 'credit'|'debit' }
 *    + reason
 */
api.post('/admin/users/:id/balance', authMiddleware('admin'), (req, res) => {
  try {
    const actor = req.auth?.username || req.auth?.sub || 'admin'
    const reason = String(req.body?.reason || req.body?.note || 'admin adjust').slice(0, 200)
    const result = db.write((data) => {
      const user = data.users.find((u) => u.id === req.params.id)
      if (!user) throw new Error('用户不存在')
      ensureBalance(user)
      let delta = Math.floor(Number(req.body?.delta_cents))
      if (!Number.isFinite(delta)) {
        const amount = Math.max(0, Math.floor(Number(req.body?.amount_cents) || 0))
        const dir = String(req.body?.direction || 'credit').toLowerCase()
        delta = dir === 'debit' ? -amount : amount
      }
      if (!delta) throw new Error('调整金额不能为 0')
      let r
      if (delta > 0) {
        r = creditBalance(user, delta, {
          type: 'admin_adjust',
          reason,
          ref_type: 'admin',
          ref_id: actor,
          actor,
        })
      } else {
        r = debitBalance(user, Math.abs(delta), {
          type: 'admin_adjust',
          reason,
          ref_type: 'admin',
          ref_id: actor,
          actor,
        })
      }
      appendAudit(data, {
        actor,
        actor_type: 'admin',
        action: 'user.balance_adjust',
        target: user.id,
        detail: {
          delta_cents: delta,
          balance_cents: r.balance_cents,
          reason,
        },
        ip: clientIp(req),
      })
      return {
        user_id: user.id,
        username: user.username,
        balance_cents: r.balance_cents,
        balance_yuan: formatYuan(r.balance_cents),
        delta_cents: delta,
      }
    })
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

api.get('/admin/users/:id/balance/ledger', authMiddleware('admin'), (req, res) => {
  const data = db.read()
  const user = data.users.find((u) => u.id === req.params.id)
  if (!user) return res.status(404).json({ error: '用户不存在' })
  res.json({
    user_id: user.id,
    username: user.username,
    balance_cents: getBalanceCents(user),
    balance_yuan: formatYuan(getBalanceCents(user)),
    items: listBalanceLedger(user, Number(req.query?.limit || 100)),
  })
})

/** Admin: list coupons */
api.get('/admin/coupons', authMiddleware('admin'), (_req, res) => {
  const data = db.read()
  ensureCoupons(data)
  const items = [...data.coupons]
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .map((c) => {
      const product = data.plans.find((p) => p.id === c.product_id)
      return {
        id: c.id,
        code: c.code,
        product_id: c.product_id,
        product_name: product?.name || c.product_id,
        days: c.days || 0,
        max_uses: c.max_uses ?? 0,
        used_count: c.used_count || 0,
        per_user_limit: c.per_user_limit ?? 1,
        status: c.status || 'active',
        expire_at: c.expire_at || 0,
        note: c.note || '',
        created_at: c.created_at || 0,
        redemptions: (c.redemptions || []).slice(-20),
      }
    })
  res.json({ items })
})

/**
 * Create one or batch coupons
 * Body: { code?, product_id, days?, max_uses?, per_user_limit?, expire_at?, note?, count? }
 */
api.post('/admin/coupons', authMiddleware('admin'), (req, res) => {
  try {
    const result = db.write((data) => {
      ensureCoupons(data)
      const productId = String(req.body?.product_id || '')
      const product = data.plans.find((p) => p.id === productId)
      if (!product || isSystemPlan(product)) throw new Error('请选择有效商品')
      if (!product.source_id) throw new Error('商品未绑定订阅源')

      const count = Math.min(100, Math.max(1, Number(req.body?.count || 1)))
      const days = Number(req.body?.days || productDurationDays(product))
      const maxUses = Math.max(0, Number(req.body?.max_uses ?? 1))
      const perUser = Math.max(0, Number(req.body?.per_user_limit ?? 1))
      let expireAt = Number(req.body?.expire_at || 0)
      if (req.body?.expire_days) {
        expireAt = nowTs() + Number(req.body.expire_days) * 86400
      }
      const note = String(req.body?.note || '').slice(0, 200)
      const now = nowTs()
      const created = []

      for (let i = 0; i < count; i++) {
        let code = normalizeCouponCode(req.body?.code)
        if (!code || count > 1) {
          code = nanoid(10).replace(/[^a-zA-Z0-9]/g, 'X').toUpperCase()
        }
        if (data.coupons.some((c) => normalizeCouponCode(c.code) === code)) {
          if (count === 1 && req.body?.code) throw new Error('兑换码已存在')
          code = nanoid(12).replace(/[^a-zA-Z0-9]/g, 'X').toUpperCase()
        }
        const row = {
          id: nanoid(),
          code,
          product_id: productId,
          days,
          max_uses: maxUses,
          used_count: 0,
          per_user_limit: perUser,
          status: 'active',
          expire_at: expireAt,
          note,
          redemptions: [],
          created_at: now,
          updated_at: now,
        }
        data.coupons.push(row)
        created.push({ id: row.id, code: row.code })
      }
      return { items: created, product_name: product.name, days }
    })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

api.patch('/admin/coupons/:id', authMiddleware('admin'), (req, res) => {
  try {
    db.write((data) => {
      ensureCoupons(data)
      const row = data.coupons.find((c) => c.id === req.params.id)
      if (!row) throw new Error('兑换码不存在')
      if (req.body?.status === 'active' || req.body?.status === 'disabled') {
        row.status = req.body.status
      }
      if (req.body?.note !== undefined) row.note = String(req.body.note).slice(0, 200)
      if (req.body?.max_uses !== undefined) row.max_uses = Math.max(0, Number(req.body.max_uses))
      if (req.body?.expire_at !== undefined) row.expire_at = Number(req.body.expire_at) || 0
      row.updated_at = nowTs()
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

api.delete('/admin/coupons/:id', authMiddleware('admin'), (req, res) => {
  db.write((data) => {
    ensureCoupons(data)
    data.coupons = data.coupons.filter((c) => c.id !== req.params.id)
  })
  res.json({ ok: true })
})

api.patch('/admin/users/:id', authMiddleware('admin'), (req, res) => {
  try {
    db.write((data) => {
      const user = data.users.find((u) => u.id === req.params.id)
      if (!user) throw new Error('用户不存在')
      if (req.body?.status !== undefined) user.status = req.body.status
      if (req.body?.expire_at !== undefined) user.expire_at = Number(req.body.expire_at)
      if (req.body?.password) {
        const pw = String(req.body.password)
        if (pw.length < 6) throw new Error('密码至少 6 位')
        user.password_hash = hashPassword(pw)
      }
      user.updated_at = nowTs()
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(e.message === '用户不存在' ? 404 : 400).json({ error: e.message })
  }
})

api.delete('/admin/users/:id', authMiddleware('admin'), (req, res) => {
  try {
    db.write((data) => {
      const before = data.users.length
      data.users = data.users.filter((u) => u.id !== req.params.id)
      if (data.users.length === before) throw new Error('用户不存在')
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

api.post('/admin/users/:id/reset-password', authMiddleware('admin'), (req, res) => {
  const password = String(req.body?.password || '')
  if (password.length < 6) {
    return res.status(400).json({ error: '请提供至少 6 位的新密码' })
  }
  try {
    db.write((data) => {
      const user = data.users.find((u) => u.id === req.params.id)
      if (!user) throw new Error('用户不存在')
      user.password_hash = hashPassword(password)
      user.updated_at = nowTs()
      appendAudit(data, {
        actor: req.auth?.username || 'admin',
        actor_type: 'admin',
        action: 'user.reset_password',
        target: user.id,
        ip: clientIp(req),
      })
    })
    // Never echo the cleartext password back to the caller.
    res.json({ ok: true, message: '密码已重置，请以新密码登录' })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

/**
 * Public account recovery: request a password reset email OTP (rate limited).
 * Preferred flow for the desktop client: 6-digit code.
 * Body: { email }
 * Also accepts legacy link mode via { email, mode: 'link' }.
 */
api.post('/auth/password-reset/request', async (req, res) => {
  const ip = clientIp(req)
  const rl = hitRateLimit(`pwreset:${ip}`, { limit: 8, windowMs: 3600_000 })
  if (!rl.ok) return res.status(429).json({ error: rl.error })
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!isValidEmail(email)) return res.status(400).json({ error: '请填写有效邮箱' })
  if (!isMailConfigured()) {
    return res.status(503).json({ error: '邮件服务未配置，无法找回密码' })
  }

  const mode = String(req.body?.mode || 'code').toLowerCase()
  if (mode === 'link') {
    // legacy link email — always 200 to avoid enumeration
    void notifyPasswordResetAsync(email, ip)
    return res.json({ ok: true, message: '若该邮箱已注册，重置链接已发送' })
  }

  // default: OTP code (reuse /auth/email-code/send logic inline for same shape)
  try {
    const issued = db.write((data) => {
      const user = (data.users || []).find(
        (u) => String(u.email || '').toLowerCase() === email,
      )
      if (!user || (user.status && user.status !== 'active')) {
        return { ok: false, silent: true }
      }
      return issueEmailOtp(data, { email, purpose: 'reset_password' })
    })
    if (issued?.silent) {
      return res.json({
        ok: true,
        message: '若该邮箱已注册，验证码已发送',
        expires_in: 600,
        cooldown: 60,
      })
    }
    if (!issued?.ok) {
      return res.status(429).json({
        error: issued?.error || '发送过于频繁',
        retry_after: issued?.retry_after,
      })
    }
    try {
      await sendOtpMail({
        email: issued.email,
        purpose: 'reset_password',
        code: issued.code,
      })
    } catch (e) {
      console.error('[recovery] otp send failed:', e.message || e)
      return res.status(502).json({ error: '验证码邮件发送失败，请稍后重试' })
    }
    db.write((data) => {
      appendAudit(data, {
        actor: 'system',
        actor_type: 'system',
        action: 'auth.password_reset_otp',
        detail: { email, ip },
        ip,
      })
    })
    res.json({
      ok: true,
      message: '若该邮箱已注册，验证码已发送',
      expires_in: issued.expires_in,
      cooldown: 60,
    })
  } catch (e) {
    res.status(400).json({ error: e.message || '请求失败' })
  }
})

/**
 * Complete password reset.
 * Preferred: { email, email_code|code, new_password }
 * Legacy:    { token, new_password }
 */
api.post('/auth/password-reset/complete', (req, res) => {
  const token = String(req.body?.token || '')
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase()
  const email_code = String(
    req.body?.email_code || req.body?.code || req.body?.verify_code || '',
  ).trim()
  const newPassword = String(req.body?.new_password || req.body?.password || '')
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' })
  }
  try {
    db.write((data) => {
      let user = null
      if (email && email_code) {
        const verified = consumeEmailOtp(data, {
          email,
          purpose: 'reset_password',
          code: email_code,
        })
        if (!verified.ok) throw new Error(verified.error || '验证码无效')
        user = (data.users || []).find(
          (u) => String(u.email || '').toLowerCase() === email,
        )
        if (!user) throw new Error('账号不存在')
      } else if (token) {
        const consumed = consumePasswordResetToken(data, token)
        if (!consumed.ok) throw new Error(consumed.error)
        user = consumed.user
      } else {
        throw new Error('请提供邮箱验证码或重置令牌')
      }
      if (user.status && user.status !== 'active') throw new Error('账号不可用')
      if (checkPassword(newPassword, user.password_hash)) {
        throw new Error('新密码不能与旧密码相同')
      }
      user.password_hash = hashPassword(newPassword)
      user.updated_at = nowTs()
      appendAudit(data, {
        actor: user.username,
        actor_type: 'user',
        action: 'auth.password_reset',
        target: user.id,
        ip: clientIp(req),
      })
    })
    res.json({ ok: true, message: '密码已重置，请使用新密码登录' })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

/**
 * Send delete-account OTP to the logged-in user's bound email.
 */
api.post('/client/delete-account/send-code', authMiddleware('user'), async (req, res) => {
  const ip = clientIp(req)
  const rl = hitRateLimit(`delotp:${req.auth.sub}`, { limit: 6, windowMs: 3600_000 })
  if (!rl.ok) return res.status(429).json({ error: rl.error })
  if (!isMailConfigured()) {
    return res.status(503).json({ error: '邮件服务未配置，无法发送注销验证码' })
  }

  const data = db.read()
  const user = data.users.find((u) => u.id === req.auth.sub)
  if (!user) return res.status(401).json({ error: '请先登录' })
  const err = ensureActive(user)
  if (err) return res.status(403).json({ error: err })
  const email = String(user.email || '')
    .trim()
    .toLowerCase()
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: '请先绑定有效邮箱后再注销账号' })
  }

  try {
    const issued = db.write((d) => issueEmailOtp(d, { email, purpose: 'delete_account' }))
    if (!issued?.ok) {
      return res.status(429).json({
        error: issued?.error || '发送过于频繁',
        retry_after: issued?.retry_after,
      })
    }
    try {
      await sendOtpMail({
        email: issued.email,
        purpose: 'delete_account',
        code: issued.code,
      })
    } catch (e) {
      console.error('[delete] otp send failed:', e.message || e)
      return res.status(502).json({ error: '验证码邮件发送失败，请稍后重试' })
    }
    db.write((d) => {
      appendAudit(d, {
        actor: user.username,
        actor_type: 'user',
        action: 'auth.delete_account_otp',
        target: user.id,
        ip,
      })
    })
    // mask email for UI: a***@b.com
    const [local, domain] = email.split('@')
    const masked =
      local.length <= 2
        ? `*@${domain}`
        : `${local[0]}***${local[local.length - 1]}@${domain}`
    res.json({
      ok: true,
      message: `验证码已发送至 ${masked}`,
      email_masked: masked,
      expires_in: issued.expires_in,
      cooldown: 60,
    })
  } catch (e) {
    res.status(400).json({ error: e.message || '发送失败' })
  }
})

/**
 * User self-service account deletion (注销).
 * Body: { password, email_code }
 * Requires: bound email + OTP mailed to that address + login password.
 * Soft-delete: free username/email for re-registration, strip credentials & devices.
 */
api.post('/client/delete-account', authMiddleware('user'), (req, res) => {
  const password = String(req.body?.password || '')
  const email_code = String(
    req.body?.email_code || req.body?.code || req.body?.verify_code || '',
  ).trim()
  if (!password) return res.status(400).json({ error: '请输入登录密码以确认注销' })
  if (!/^\d{6}$/.test(email_code)) {
    return res.status(400).json({ error: '请填写邮箱收到的 6 位验证码' })
  }
  if (!isMailConfigured()) {
    return res.status(503).json({ error: '邮件服务未配置，无法完成注销' })
  }
  try {
    db.write((data) => {
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      if (user.status === 'deleted') throw new Error('账号已注销')
      const email = String(user.email || '')
        .trim()
        .toLowerCase()
      if (!isValidEmail(email)) throw new Error('请先绑定有效邮箱后再注销账号')
      if (!checkPassword(password, user.password_hash)) {
        throw new Error('密码错误')
      }
      const verified = consumeEmailOtp(data, {
        email,
        purpose: 'delete_account',
        code: email_code,
      })
      if (!verified.ok) throw new Error(verified.error || '邮箱验证码无效')

      const now = nowTs()
      const oldUsername = user.username
      const oldEmail = email
      // free credentials for future registration
      user.status = 'deleted'
      user.deleted_at = now
      user.username = `__deleted__${user.id}`
      user.email = ''
      user.email_verified_at = 0
      user.password_hash = hashPassword(
        `deleted:${user.id}:${now}:${Math.random().toString(36).slice(2)}`,
      )
      user.purchases = []
      user.devices = []
      user.plan_id = null
      user.expire_at = 0
      user.invite_code = user.invite_code || ''
      user.traffic = {
        free: { limit_bytes: 0, used_bytes: 0 },
        paid: { limit_bytes: 0, used_bytes: 0 },
        _v2: 2,
      }
      user.updated_at = now
      if (Array.isArray(data.email_otps) && oldEmail) {
        data.email_otps = data.email_otps.filter(
          (t) => String(t.email || '').toLowerCase() !== oldEmail,
        )
      }
      if (Array.isArray(data.email_tokens)) {
        data.email_tokens = data.email_tokens.filter((t) => t.user_id !== user.id)
      }
      appendAudit(data, {
        actor: oldUsername,
        actor_type: 'user',
        action: 'auth.delete_account',
        target: user.id,
        detail: { email: '[redacted]', via: 'email_otp+password' },
        ip: clientIp(req),
      })
    })
    res.json({ ok: true, message: '账号已注销，相关数据已清除' })
  } catch (e) {
    res.status(e.message === '用户不存在' ? 404 : 400).json({ error: e.message })
  }
})

async function notifyPasswordResetAsync(email, ip) {
  try {
    const issued = db.write((data) => issuePasswordReset(data, email))
    if (!issued.ok) return
    await sendMail({
      to: email,
      subject: 'Fork · 密码重置',
      text: `您正在重置 Fork 账号密码，请在 30 分钟内使用此链接完成重置：\n\n${resetLink(issued.token)}\n\n如非本人操作请忽略此邮件并尽快修改密码。`,
      html: `<p>您正在重置 Fork 账号密码，请在 30 分钟内点击下方链接完成重置：</p><p><a href="${resetLink(issued.token)}">${resetLink(issued.token)}</a></p><p>如非本人操作请忽略此邮件并尽快修改密码。</p>`,
    })
    db.write((data) => {
      appendAudit(data, {
        actor: 'system',
        actor_type: 'system',
        action: 'auth.password_reset_request',
        detail: { email, ip },
        ip,
      })
    })
  } catch (e) {
    console.error('[recovery] password reset email failed:', e.message || e)
  }
}

function resetLink(token) {
  const base = String(
    process.env.FORK_PUBLIC_URL || process.env.PUBLIC_URL || '',
  ).replace(/\/$/, '')
  return `${base}/reset-password?token=${encodeURIComponent(token)}`
}

/** Revoke one product entitlement from user */
api.delete('/admin/users/:id/purchases/:productId', authMiddleware('admin'), (req, res) => {
  try {
    const result = db.write((data) => {
      const user = data.users.find((u) => u.id === req.params.id)
      if (!user) throw new Error('用户不存在')
      if (!Array.isArray(user.purchases)) user.purchases = []
      const before = user.purchases.length
      const productId = req.params.productId
      user.purchases = user.purchases.filter((p) => p.product_id !== productId)
      if (user.purchases.length === before) throw new Error('该用户无此商品权益')
      // drop display plan_id if it pointed at revoked product
      if (user.plan_id === productId) {
        const last = user.purchases[user.purchases.length - 1]
        const trial = data.plans.find((p) => p.name === 'trial')
        user.plan_id = last?.product_id || trial?.id || null
      }
      user.updated_at = nowTs()
      return {
        ok: true,
        access_key: accessFingerprint(data, user),
        remaining_purchases: user.purchases.length,
      }
    })
    res.json(result)
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

/**
 * Admin: reset or set traffic usage for a user.
 * Body: { reset: true } | { traffic_used_bytes: number } | { product_id, traffic_used_bytes }
 */
api.post('/admin/users/:id/traffic', authMiddleware('admin'), (req, res) => {
  try {
    let traffic
    db.write((data) => {
      const user = data.users.find((u) => u.id === req.params.id)
      if (!user) throw new Error('用户不存在')
      if (!Array.isArray(user.purchases)) user.purchases = []
      const productId = req.body?.product_id ? String(req.body.product_id) : ''
      const reset = req.body?.reset === true || req.body?.reset === 1 || req.body?.reset === '1'
      ensureTrafficWallets(user)
      migrateToDualWallets(user, data)
      if (reset) {
        // clear both account wallets' used counters
        user.traffic.free.used_bytes = 0
        user.traffic.paid.used_bytes = 0
        for (const p of user.purchases || []) {
          p.traffic_used_bytes = 0
        }
      }
      if (req.body?.free_limit_bytes !== undefined) {
        user.traffic.free.limit_bytes = Math.max(0, Math.floor(Number(req.body.free_limit_bytes) || 0))
      }
      if (req.body?.paid_limit_bytes !== undefined) {
        user.traffic.paid.limit_bytes = Math.max(0, Math.floor(Number(req.body.paid_limit_bytes) || 0))
      }
      if (req.body?.free_used_bytes !== undefined) {
        user.traffic.free.used_bytes = Math.max(0, Math.floor(Number(req.body.free_used_bytes) || 0))
      }
      if (req.body?.paid_used_bytes !== undefined) {
        user.traffic.paid.used_bytes = Math.max(0, Math.floor(Number(req.body.paid_used_bytes) || 0))
      }
      if (productId) {
        const p = user.purchases.find((x) => x.product_id === productId)
        if (!p) throw new Error('该用户无此商品权益')
        p.updated_at = nowTs()
      }
      user.updated_at = nowTs()
      traffic = getUserTraffic(user, data)
      appendAudit(data, {
        actor: req.auth?.username || 'admin',
        actor_type: 'admin',
        action: 'user.traffic',
        target: user.id,
        detail: { reset: req.body?.reset === true, product_id: req.body?.product_id || null },
        ip: clientIp(req),
      })
    })
    res.json({
      ok: true,
      traffic: {
        unlimited: traffic.unlimited,
        limit_bytes: traffic.limit_bytes,
        used_bytes: traffic.used_bytes,
        remaining_bytes: traffic.remaining_bytes,
        exhausted: traffic.exhausted,
        label: traffic.unlimited
          ? `已用 ${formatBytes(traffic.used_bytes)} / 不限流量`
          : `${formatBytes(traffic.used_bytes)} / ${formatBytes(traffic.limit_bytes)}`,
      },
    })
  } catch (e) {
    res.status(e.message === '用户不存在' || e.message.includes('无此') ? 404 : 400).json({
      error: e.message,
    })
  }
})

/** Admin grants a product entitlement (same effect as client purchase). */
api.post('/admin/users/:id/grant', authMiddleware('admin'), (req, res) => {
  try {
    const result = db.write((data) => {
      const user = data.users.find((u) => u.id === req.params.id)
      if (!user) throw new Error('用户不存在')
      const productId = req.body?.product_id
      const productName = req.body?.product_name
      const product = productId
        ? data.plans.find((p) => p.id === productId)
        : data.plans.find((p) => p.name === productName)
      if (!product || isSystemPlan(product)) throw new Error('请选择有效商品')
      if (!product.source_id) throw new Error('商品未绑定付费订阅源')
      const { expire_at, days } = grantPurchase(user, product, {
        days: req.body?.days,
      })
      return {
        username: user.username,
        product_id: product.id,
        name: product.name,
        expire_at,
        days,
        message: `已为 ${user.username} 开通 ${product.name}`,
      }
    })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

api.post('/admin/users', authMiddleware('admin'), (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '123456')
  if (username.length < 3) return res.status(400).json({ error: '用户名至少 3 个字符' })
  try {
    const created = db.write((data) => {
      if (data.users.some((u) => u.username === username)) throw new Error('用户名已存在')
      const trial = data.plans.find((p) => p.name === 'trial')
      const days = Number(req.body?.days || 30)
      const now = nowTs()
      const user = {
        id: nanoid(),
        username,
        password_hash: hashPassword(password),
        plan_id: trial?.id || null,
        purchases: [],
        status: 'active',
        expire_at: now + days * 86400,
        created_at: now,
        updated_at: now,
      }
      // optional: grant product on create
      if (req.body?.product_id || req.body?.product_name) {
        const product = req.body.product_id
          ? data.plans.find((p) => p.id === req.body.product_id)
          : data.plans.find((p) => p.name === req.body.product_name)
        if (product && !isSystemPlan(product) && product.source_id) {
          grantPurchase(user, product, { days: req.body?.days })
        }
      }
      data.users.push(user)
      return { id: user.id, username }
    })
    res.json(created)
  } catch (e) {
    res.status(e.message === '用户名已存在' ? 409 : 400).json({ error: e.message })
  }
})

api.get('/admin/sources', authMiddleware('admin'), (_req, res) => {
  const items = [...db.read().subscription_sources]
    .sort((a, b) => b.created_at - a.created_at)
    .map((s) => {
      const access =
        s.access === 'locked' || s.tier === 'paid' ? 'locked' : 'public'
      return {
        ...s,
        access,
        // legacy field for older admin UI scripts
        tier: access === 'locked' ? 'paid' : 'free',
        has_inline: Boolean((s.inline_yaml || '').trim()),
        inline_len: (s.inline_yaml || '').length,
      }
    })
  res.json({ items })
})

/** Preview / parse nodes for a source (live fetch URL or inline yaml). */
api.post('/admin/sources/preview', authMiddleware('admin'), async (req, res) => {
  try {
    const source = {
      name: req.body?.name || 'preview',
      url: req.body?.url || '',
      inline_yaml: req.body?.inline_yaml || '',
      fetch_proxy: req.body?.fetch_proxy || '',
      fetch_ua: req.body?.fetch_ua || '',
    }
    if (req.body?.id) {
      const saved = db.read().subscription_sources.find((s) => s.id === req.body.id)
      if (saved) {
        source.url = req.body.url !== undefined ? req.body.url : saved.url
        source.inline_yaml =
          req.body.inline_yaml !== undefined ? req.body.inline_yaml : saved.inline_yaml
        source.fetch_proxy =
          req.body.fetch_proxy !== undefined ? req.body.fetch_proxy : saved.fetch_proxy
        source.fetch_ua =
          req.body.fetch_ua !== undefined ? req.body.fetch_ua : saved.fetch_ua
        source.name = saved.name
      }
    }
    const preview = await previewSource(source)
    res.json(preview)
  } catch (e) {
    res.status(502).json({ error: e.message || '预览失败', nodes: [], groups: [] })
  }
})

api.get('/admin/sources/:id/nodes', authMiddleware('admin'), async (req, res) => {
  try {
    const source = db.read().subscription_sources.find((s) => s.id === req.params.id)
    if (!source) return res.status(404).json({ error: '订阅源不存在' })
    const preview = await previewSource(source)
    res.json(preview)
  } catch (e) {
    res.status(502).json({ error: e.message || '解析失败', nodes: [], groups: [] })
  }
})

api.post('/admin/sources', authMiddleware('admin'), (req, res) => {
  const id = nanoid()
  const { access, tier } = normalizeSourceAccess(req.body || {})
  db.write((data) => {
    data.subscription_sources.push({
      id,
      name: String(req.body?.name || '').trim() || '未命名订阅源',
      url: String(req.body?.url || '').trim(),
      inline_yaml: String(req.body?.inline_yaml || ''),
      notes: String(req.body?.notes || ''),
      fetch_proxy: String(req.body?.fetch_proxy || '').trim(),
      fetch_ua: String(req.body?.fetch_ua || '').trim(),
      access,
      tier,
      created_at: nowTs(),
      updated_at: nowTs(),
    })
  })
  res.json({ id })
})

api.patch('/admin/sources/:id', authMiddleware('admin'), (req, res) => {
  try {
    db.write((data) => {
      const row = data.subscription_sources.find((s) => s.id === req.params.id)
      if (!row) throw new Error('不存在')
      if (req.body?.name !== undefined) row.name = req.body.name
      if (req.body?.url !== undefined) row.url = req.body.url
      if (req.body?.inline_yaml !== undefined) row.inline_yaml = req.body.inline_yaml
      if (req.body?.notes !== undefined) row.notes = req.body.notes
      if (req.body?.fetch_proxy !== undefined) {
        row.fetch_proxy = String(req.body.fetch_proxy || '').trim()
      }
      if (req.body?.fetch_ua !== undefined) {
        row.fetch_ua = String(req.body.fetch_ua || '').trim()
      }
      if (req.body?.access !== undefined || req.body?.tier !== undefined) {
        const norm = normalizeSourceAccess(req.body, row)
        row.access = norm.access
        row.tier = norm.tier
      }
      row.updated_at = nowTs()
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

api.delete('/admin/sources/:id', authMiddleware('admin'), (req, res) => {
  db.write((data) => {
    data.subscription_sources = data.subscription_sources.filter((s) => s.id !== req.params.id)
  })
  res.json({ ok: true })
})

api.get('/admin/plans', authMiddleware('admin'), (_req, res) => {
  const data = db.read()
  const items = data.plans
    .map((p) => {
      const s = data.subscription_sources.find((x) => x.id === p.source_id)
      const kind = isSystemPlan(p) ? 'system' : 'product'
      return {
        ...p,
        kind,
        for_sale: kind === 'system' ? false : p.for_sale !== false,
        duration_days: Number(p.duration_days || p.trial_days || 30),
        source_name: s?.name || null,
        source_url: s?.url || '',
        source_has_inline: Boolean((s?.inline_yaml || '').trim()),
        source_access: s
          ? s.access === 'locked' || s.tier === 'paid'
            ? 'locked'
            : 'public'
          : null,
        source_tier: s
          ? s.access === 'locked' || s.tier === 'paid'
            ? 'paid'
            : 'free'
          : null,
      }
    })
    .sort((a, b) => b.created_at - a.created_at)
  res.json({ items })
})

api.post('/admin/plans', authMiddleware('admin'), (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: '商品名必填' })
  if (name === 'trial') return res.status(400).json({ error: 'trial 为系统保留名' })
  try {
    const id = nanoid()
    const days = Number(req.body?.trial_days || req.body?.duration_days || 30)
    const price_cents = Number(req.body?.price_cents || 0)
    const traffic_bytes = Number(req.body?.traffic_bytes || 0)
    const traffic_reset =
      req.body?.traffic_reset === 'monthly' ? 'monthly' : 'never'
    db.write((data) => {
      assertPaidTrafficQuota(price_cents, traffic_bytes, data.settings)
      if (data.plans.some((p) => p.name === name)) throw new Error('商品名已存在')
      data.plans.push({
        id,
        name,
        kind: 'product',
        source_id: req.body?.source_id || null,
        trial_days: days,
        duration_days: days,
        traffic_bytes,
        traffic_reset,
        description: String(req.body?.description || ''),
        price_cents,
        for_sale: req.body?.for_sale !== false,
        created_at: nowTs(),
      })
      appendAudit(data, {
        actor: req.auth?.username || 'admin',
        actor_type: 'admin',
        action: 'plan.create',
        target: id,
        detail: { name, price_cents, traffic_bytes, traffic_reset },
        ip: clientIp(req),
      })
    })
    res.json({ id })
  } catch (e) {
    res.status(e.message.includes('流量') ? 400 : 409).json({ error: e.message })
  }
})

api.patch('/admin/plans/:id', authMiddleware('admin'), (req, res) => {
  try {
    db.write((data) => {
      const row = data.plans.find((p) => p.id === req.params.id)
      if (!row) throw new Error('不存在')
      if (isSystemPlan(row)) {
        // system plan: only description / duration for account defaults
        if (req.body?.description !== undefined) row.description = req.body.description
        if (req.body?.trial_days !== undefined) {
          row.trial_days = Number(req.body.trial_days)
          row.duration_days = Number(req.body.trial_days)
        }
        row.kind = 'system'
        row.for_sale = false
        row.source_id = null
        return
      }
      if (req.body?.name !== undefined) row.name = req.body.name
      if (req.body?.source_id !== undefined) row.source_id = req.body.source_id
      if (req.body?.trial_days !== undefined) {
        row.trial_days = Number(req.body.trial_days)
        row.duration_days = Number(req.body.trial_days)
      }
      if (req.body?.duration_days !== undefined) {
        row.duration_days = Number(req.body.duration_days)
        row.trial_days = Number(req.body.duration_days)
      }
      if (req.body?.traffic_bytes !== undefined) {
        row.traffic_bytes = Number(req.body.traffic_bytes)
      }
      if (req.body?.traffic_reset !== undefined) {
        row.traffic_reset = req.body.traffic_reset === 'monthly' ? 'monthly' : 'never'
      }
      if (req.body?.description !== undefined) row.description = req.body.description
      if (req.body?.price_cents !== undefined) row.price_cents = Number(req.body.price_cents)
      if (req.body?.for_sale !== undefined) row.for_sale = Boolean(req.body.for_sale)
      assertPaidTrafficQuota(row.price_cents, row.traffic_bytes, data.settings)
      row.kind = 'product'
      appendAudit(data, {
        actor: req.auth?.username || 'admin',
        actor_type: 'admin',
        action: 'plan.patch',
        target: row.id,
        ip: clientIp(req),
      })
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(e.message.includes('流量') ? 400 : 404).json({ error: e.message })
  }
})

api.delete('/admin/plans/:id', authMiddleware('admin'), (req, res) => {
  try {
    db.write((data) => {
      const row = data.plans.find((p) => p.id === req.params.id)
      if (!row) throw new Error('不存在')
      if (isSystemPlan(row)) throw new Error('系统项不可删除')
      data.plans = data.plans.filter((p) => p.id !== req.params.id)
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ---------- announcements ----------
api.get('/admin/announcements', authMiddleware('admin'), (_req, res) => {
  const items = [...(db.read().announcements || [])].sort(
    (a, b) => (b.created_at || 0) - (a.created_at || 0),
  )
  res.json({ items })
})

api.post('/admin/announcements', authMiddleware('admin'), (req, res) => {
  const title = String(req.body?.title || '').trim()
  const body = String(req.body?.body || '').trim()
  if (!title) return res.status(400).json({ error: '标题必填' })
  const id = nanoid()
  const now = nowTs()
  db.write((data) => {
    if (!Array.isArray(data.announcements)) data.announcements = []
    data.announcements.push({
      id,
      title,
      body,
      active: req.body?.active !== false,
      created_at: now,
      updated_at: now,
    })
  })
  res.json({ id })
})

api.patch('/admin/announcements/:id', authMiddleware('admin'), (req, res) => {
  try {
    db.write((data) => {
      if (!Array.isArray(data.announcements)) data.announcements = []
      const row = data.announcements.find((a) => a.id === req.params.id)
      if (!row) throw new Error('公告不存在')
      if (req.body?.title !== undefined) row.title = String(req.body.title)
      if (req.body?.body !== undefined) row.body = String(req.body.body)
      if (req.body?.active !== undefined) row.active = Boolean(req.body.active)
      row.updated_at = nowTs()
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

api.delete('/admin/announcements/:id', authMiddleware('admin'), (req, res) => {
  db.write((data) => {
    data.announcements = (data.announcements || []).filter((a) => a.id !== req.params.id)
  })
  res.json({ ok: true })
})

api.get('/admin/settings', authMiddleware('admin'), (_req, res) => {
  const settings = db.read().settings || {}
  res.json({
    ...settings,
    client_update: getClientUpdatePolicy(),
  })
})

api.put('/admin/settings', authMiddleware('admin'), (req, res) => {
  db.write((data) => {
    const body = { ...(req.body || {}) }
    if (body.client_update && typeof body.client_update === 'object') {
      const cur = data.settings.client_update || {}
      const next = body.client_update
      const curPl = cur.platforms || {}
      const nextPl = next.platforms && typeof next.platforms === 'object' ? next.platforms : {}
      const mergePlat = (key, urlField, sigField) => {
        const n = nextPl[key] || {}
        const c = curPl[key] || {}
        return {
          url: String(
            n.url ?? next[urlField] ?? c.url ?? cur[urlField] ?? '',
          ).trim(),
          signature: String(
            n.signature ?? next[sigField] ?? c.signature ?? cur[sigField] ?? '',
          ).trim(),
        }
      }
      data.settings.client_update = {
        enabled: next.enabled !== false && next.enabled !== '0' && next.enabled !== 0,
        mode:
          next.mode === 'force' ? 'force' : next.mode === 'off' ? 'off' : 'optional',
        latest_version: String(next.latest_version ?? cur.latest_version ?? '').trim(),
        title: String(next.title ?? cur.title ?? '发现新版本').trim(),
        body: String(next.body ?? cur.body ?? '').trim(),
        pub_date: String(next.pub_date ?? cur.pub_date ?? new Date().toISOString()).trim(),
        platforms: {
          'windows-x86_64': mergePlat(
            'windows-x86_64',
            'windows_url',
            'windows_signature',
          ),
          'darwin-x86_64': mergePlat('darwin-x86_64', 'darwin_x64_url', 'darwin_x64_signature'),
          'darwin-aarch64': mergePlat(
            'darwin-aarch64',
            'darwin_arm_url',
            'darwin_arm_signature',
          ),
          'linux-x86_64': mergePlat('linux-x86_64', 'linux_url', 'linux_signature'),
        },
      }
      delete body.client_update
    }
    data.settings = { ...data.settings, ...body }
  })
  res.json({ ok: true, client_update: getClientUpdatePolicy() })
})

/** Change current admin password */
api.post('/admin/change-password', authMiddleware('admin'), (req, res) => {
  const oldPassword = String(req.body?.old_password || '')
  const newPassword = String(req.body?.new_password || '')
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' })
  try {
    db.write((data) => {
      const row =
        data.admins.find((a) => a.id === req.auth.sub) ||
        data.admins.find((a) => a.username === req.auth.username) ||
        data.admins[0]
      if (!row) throw new Error('管理员不存在')
      if (!checkPassword(oldPassword, row.password_hash)) throw new Error('原密码错误')
      row.password_hash = hashPassword(newPassword)
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})
