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
  buildPayUrl,
  getEzpayConfig,
  verifyEzpayNotify,
  yuanFromCents,
} from './ezpay.js'

export const api = Router()

function ensureOrders(data) {
  if (!Array.isArray(data.orders)) data.orders = []
}

function makeOutTradeNo() {
  const tail = nanoid(10).replace(/[^a-zA-Z0-9]/g, 'x')
  return `F${Date.now()}${tail}`
}

/** Mark order paid + grant product (idempotent). */
function fulfillPaidOrder(data, order, tradeNo = '') {
  if (!order || order.status === 'paid') return order
  const user = data.users.find((u) => u.id === order.user_id)
  const product = data.plans.find((p) => p.id === order.product_id)
  if (!user) throw new Error('订单用户不存在')
  if (!product || !isSellableProduct(product)) throw new Error('订单商品无效')
  if (!product.source_id) throw new Error('商品未绑定付费订阅源')
  const { expire_at } = grantPurchase(user, product)
  order.status = 'paid'
  order.trade_no = String(tradeNo || order.trade_no || '')
  order.paid_at = nowTs()
  order.expire_at = expire_at
  order.updated_at = nowTs()
  return order
}

function getSetting(key, fallback = '') {
  const data = db.read()
  return data.settings[key] ?? fallback
}

function productDurationDays(product) {
  return Number(product?.duration_days || product?.trial_days || 30)
}

function grantPurchase(user, product, { days } = {}) {
  if (!Array.isArray(user.purchases)) user.purchases = []
  const now = nowTs()
  const d = Number(days || productDurationDays(product))
  const existing = user.purchases.find((p) => p.product_id === product.id)
  const base = existing && existing.expire_at > now ? existing.expire_at : now
  const expire_at = base + d * 86400
  if (existing) {
    existing.expire_at = expire_at
    existing.source_id = product.source_id
    existing.name = product.name
    existing.updated_at = now
  } else {
    user.purchases.push({
      product_id: product.id,
      source_id: product.source_id,
      name: product.name,
      expire_at,
      created_at: now,
      updated_at: now,
    })
  }
  // display-only: last product name for session.plan
  user.plan_id = product.id
  // keep account usable at least until entitlement ends
  if (!user.expire_at || user.expire_at < expire_at) user.expire_at = expire_at
  user.updated_at = now
  return { expire_at, days: d }
}

function enrichUser(user, data) {
  if (!user) return null
  const access = summarizeUserAccess(data, user)
  const plan = data.plans.find((p) => p.id === user.plan_id)
  const label =
    access.purchase_names[0] ||
    plan?.name ||
    (access.paid_sources.length ? 'member' : 'free')
  return {
    ...user,
    plan_name: label,
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
  if (user.status !== 'active') return '账号已被禁用'
  // Do not block login on user.expire_at — that field is legacy/trial display only.
  // Paid lines are controlled by purchases[]; public sources need only an active account.
  return null
}

/** Longest active product entitlement end; 0 if none. */
function maxPurchaseExpireAt(user, now = nowTs()) {
  const list = Array.isArray(user?.purchases) ? user.purchases : []
  let max = 0
  for (const p of list) {
    const exp = Number(p.expire_at || 0)
    if (exp > now && exp > max) max = exp
  }
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

api.post('/auth/register', (req, res) => {
  if (getSetting('allow_register', '1') !== '1') {
    return res.status(403).json({ error: '暂未开放注册' })
  }
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase()
  if (username.length < 3) return res.status(400).json({ error: '用户名至少 3 个字符' })
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 个字符' })
  if (!isValidEmail(email)) return res.status(400).json({ error: '请填写有效邮箱' })

  try {
    const session = db.write((data) => {
      if (data.users.some((u) => u.username === username)) {
        throw new Error('用户名已存在')
      }
      if (data.users.some((u) => String(u.email || '').toLowerCase() === email)) {
        throw new Error('该邮箱已被注册')
      }
      // Registration does NOT auto-grant product entitlements (purchases stays empty).
      // Optional settings.register_trial_days / default_plan only for legacy display fields.
      // Paid lines require purchase / coupon / admin grant; public sources need active status only.
      const now = nowTs()
      const trialDays = Math.max(0, Number(data.settings.register_trial_days ?? 0))
      const user = {
        id: nanoid(),
        username,
        email,
        password_hash: hashPassword(password),
        plan_id: null,
        purchases: [],
        status: 'active',
        expire_at: trialDays > 0 ? now + trialDays * 86400 : 0,
        created_at: now,
        updated_at: now,
      }
      data.users.push(user)
      const full = enrichUser(user, data)
      const token = signUserToken(full)
      return userRowToSession(full, token, data)
    })
    res.json(session)
  } catch (e) {
    res.status(
      e.message === '用户名已存在' || e.message === '该邮箱已被注册' ? 409 : 400,
    ).json({ error: e.message })
  }
})

api.post('/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const data = db.read()
  const user = findUser(data, username, false)
  if (!user || !checkPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }
  const err = ensureActive(user)
  if (err) return res.status(403).json({ error: err })
  res.json(userRowToSession(user, signUserToken(user), data))
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
  const purchases = (Array.isArray(raw.purchases) ? raw.purchases : []).map((p) => {
    const exp = Number(p.expire_at || 0)
    const active = !exp || exp === 0 || exp > now
    return {
      product_id: p.product_id,
      name: p.name || '',
      source_id: p.source_id || null,
      expire_at: exp,
      created_at: p.created_at || 0,
      updated_at: p.updated_at || 0,
      active,
      days_left: active && exp > 0 ? Math.max(0, Math.ceil((exp - now) / 86400)) : null,
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
  })
})

/**
 * Redeem coupon / gift code → grant product entitlement
 * Body: { code }
 */
api.post('/client/redeem', authMiddleware('user'), (req, res) => {
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
    .map((o) => ({
      order_id: o.id,
      out_trade_no: o.out_trade_no,
      status: o.status,
      product_id: o.product_id,
      name: o.product_name,
      money: o.money,
      money_cents: o.money_cents,
      pay_type: o.pay_type || '',
      trade_no: o.trade_no || '',
      expire_at: o.expire_at || 0,
      created_at: o.created_at || 0,
      paid_at: o.paid_at || 0,
      pay_url: o.status === 'pending' ? o.pay_url || '' : '',
    }))
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

/**
 * Self-serve purchase:
 * - price_cents <= 0 → instant grant
 * - paid → create 易支付 order, return pay_url (grant on async notify)
 */
api.post('/client/purchase', authMiddleware('user'), (req, res) => {
  const productId = String(req.body?.product_id || '')
  if (!productId) return res.status(400).json({ error: '缺少 product_id' })

  const payTypeRaw = String(req.body?.pay_type || 'alipay').toLowerCase()
  const payType = ['alipay', 'wxpay', 'qqpay'].includes(payTypeRaw)
    ? payTypeRaw
    : 'alipay'

  try {
    const result = db.write((data) => {
      ensureOrders(data)
      const user = data.users.find((u) => u.id === req.auth.sub)
      if (!user) throw new Error('用户不存在')
      if (user.status !== 'active') throw new Error('账号已被禁用')

      const product = data.plans.find((p) => p.id === productId)
      if (!isSellableProduct(product)) throw new Error('商品不存在或已下架')
      if (!product.source_id) throw new Error('商品未绑定付费订阅源')

      const priceCents = Math.max(0, Number(product.price_cents || 0))

      // Free products: open immediately
      if (priceCents <= 0) {
        const { expire_at } = grantPurchase(user, product)
        return {
          need_pay: false,
          status: 'paid',
          product_id: productId,
          name: product.name,
          expire_at,
          price_cents: 0,
          message: `已开通 ${product.name}`,
          access_key: accessFingerprint(data, user),
        }
      }

      const cfg = getEzpayConfig()
      if (!cfg.enabled) {
        throw new Error('在线支付未配置，请联系管理员')
      }

      const now = nowTs()
      const outTradeNo = makeOutTradeNo()
      const money = yuanFromCents(priceCents)
      const order = {
        id: nanoid(),
        out_trade_no: outTradeNo,
        user_id: user.id,
        product_id: product.id,
        product_name: product.name,
        money_cents: priceCents,
        money,
        pay_type: payType,
        status: 'pending',
        trade_no: '',
        pay_url: '',
        expire_at: 0,
        created_at: now,
        paid_at: 0,
        updated_at: now,
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
        message: '请在打开的页面完成支付',
      }
    })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
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
  res.json({
    order_id: order.id,
    out_trade_no: order.out_trade_no,
    status: order.status,
    product_id: order.product_id,
    name: order.product_name,
    expire_at: order.expire_at || 0,
    price_cents: order.money_cents || 0,
    paid_at: order.paid_at || 0,
    pay_url: order.status === 'pending' ? order.pay_url || '' : '',
    message:
      order.status === 'paid'
        ? `已开通 ${order.product_name}`
        : order.status === 'pending'
          ? '等待支付'
          : order.status,
    access_key:
      order.status === 'paid' && user
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
    .slice(0, 200)
    .map((o) => {
      const user = data.users.find((u) => u.id === o.user_id)
      return {
        id: o.id,
        out_trade_no: o.out_trade_no,
        username: user?.username || o.user_id,
        product_name: o.product_name,
        money: o.money,
        money_cents: o.money_cents,
        status: o.status,
        pay_type: o.pay_type,
        trade_no: o.trade_no || '',
        created_at: o.created_at,
        paid_at: o.paid_at || 0,
      }
    })
  res.json({ items, ezpay_enabled: getEzpayConfig().enabled })
})

/** Merge free + purchased paid sources for the client proxy list */
api.get('/client/subscription', authMiddleware('user'), async (req, res) => {
  try {
    const data = db.read()
    const rawUser = data.users.find((u) => u.id === req.auth.sub)
    if (!rawUser) return res.status(401).json({ error: '请先登录' })
    const err = ensureActive(rawUser)
    if (err) return res.status(403).json({ error: err })

    const sources = getAccessibleSources(data, rawUser)
    const merged = await mergeSourcesForUser(sources, rawUser.username)

    res.json({
      name: merged.name,
      updated_at: nowTs(),
      expire_at: rawUser.expire_at,
      plan: enrichUser(rawUser, data)?.plan_name || 'free',
      content: merged.content,
      source: merged.from,
      traffic_total: 100 * 1024 * 1024 * 1024,
      node_count: merged.node_count,
      free_count: merged.free_count,
      paid_count: merged.paid_count,
      nodes: (merged.nodes || []).slice(0, 300),
      parts: merged.parts,
      access_key: accessFingerprint(data, rawUser),
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
      }
    })
    .sort((a, b) => b.created_at - a.created_at)
  res.json({ items })
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
  const password = String(req.body?.password || '123456')
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' })
  try {
    db.write((data) => {
      const user = data.users.find((u) => u.id === req.params.id)
      if (!user) throw new Error('用户不存在')
      user.password_hash = hashPassword(password)
      user.updated_at = nowTs()
    })
    res.json({ ok: true, password })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

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
    db.write((data) => {
      if (data.plans.some((p) => p.name === name)) throw new Error('商品名已存在')
      data.plans.push({
        id,
        name,
        kind: 'product',
        source_id: req.body?.source_id || null,
        trial_days: days,
        duration_days: days,
        traffic_bytes: Number(req.body?.traffic_bytes || 0),
        description: String(req.body?.description || ''),
        price_cents: Number(req.body?.price_cents || 0),
        for_sale: req.body?.for_sale !== false,
        created_at: nowTs(),
      })
    })
    res.json({ id })
  } catch (e) {
    res.status(409).json({ error: e.message })
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
      if (req.body?.description !== undefined) row.description = req.body.description
      if (req.body?.price_cents !== undefined) row.price_cents = Number(req.body.price_cents)
      if (req.body?.for_sale !== undefined) row.for_sale = Boolean(req.body.for_sale)
      row.kind = 'product'
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(404).json({ error: e.message })
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
