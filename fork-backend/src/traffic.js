/**
 * Dual traffic wallets (independent):
 * - free: public / free-tier lines
 * - paid: locked / paid-tier lines
 *
 * Product purchases unlock sources + add days; traffic_bytes of product
 * goes into the matching wallet (price>0 → paid, else free).
 * Check-in / invite write into free or paid per admin rules.
 */
import { nowTs } from './db.js'
import { activePurchases as accessActivePurchases, isPaidProduct } from './access.js'

/** Product traffic quota in bytes. 0 / missing = no traffic grant (not "unlimited product"). */
export function productTrafficLimitBytes(product) {
  const n = Number(product?.traffic_bytes)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/** Re-export access-layer entitlement filter (single source of truth). */
export function activePurchases(user, now = nowTs()) {
  return accessActivePurchases(user, now)
}

/**
 * True only if user has a live **paid** product (price_cents > 0).
 *
 * Free products that unlock a "locked" source (e.g. 免费体验 → 免费线路) must NOT
 * count as paid — that wrongly gave check-in/paid-tier rewards after refunds.
 * traffic_pool==='paid' alone is also insufficient (stale after revoke).
 */
export function isPaidUser(user, data, now = nowTs()) {
  const list = activePurchases(user, now)
  for (const p of list) {
    if (!p || p.product_id === '__activity_reward__') continue
    const plan = data?.plans?.find((x) => x.id === p.product_id)
    if (plan && Number(plan.price_cents || 0) > 0) return true
    // plan row missing: fall back to a still-paid order for this product
    if (!plan && Array.isArray(data?.orders) && user?.id) {
      const livePaid = data.orders.some(
        (o) =>
          o &&
          o.user_id === user.id &&
          o.product_id === p.product_id &&
          o.status === 'paid' &&
          Number(o.money_cents || 0) > 0,
      )
      if (livePaid) return true
    }
  }
  return false
}

/**
 * After refund/revoke: if user no longer has paid entitlement, leave paid pool
 * with zero remaining (limit clamped to used). Never leave limit=0 meaning
 * "unlimited" for a non-paid user.
 */
export function clampPaidWalletIfNotEntitled(user, data, now = nowTs()) {
  ensureTrafficWallets(user)
  if (isPaidUser(user, data, now)) return false
  let changed = false
  const used = Math.max(0, Math.floor(Number(user.traffic.paid.used_bytes) || 0))
  const lim = Math.max(0, Math.floor(Number(user.traffic.paid.limit_bytes) || 0))
  // remaining = 0; keep used for audit; empty pool shows as 未开通
  if (lim !== used) {
    user.traffic.paid.limit_bytes = used
    changed = true
  }
  // clear stale plan_id pointing at a non-active / free-only identity
  if (user.plan_id) {
    const plan = data?.plans?.find((x) => x.id === user.plan_id)
    const stillHolds = activePurchases(user, now).some(
      (p) => p.product_id === user.plan_id,
    )
    if (!stillHolds || (plan && Number(plan.price_cents || 0) > 0 && !stillHolds)) {
      // if plan was paid product and not in active list, clear
      if (!stillHolds) {
        user.plan_id = null
        changed = true
      }
    }
  }
  if (changed) user.updated_at = nowTs()
  return changed
}

function emptyPool() {
  return { limit_bytes: 0, used_bytes: 0 }
}

export function ensureTrafficWallets(user) {
  if (!user.traffic || typeof user.traffic !== 'object') {
    user.traffic = { free: emptyPool(), paid: emptyPool(), _v2: 0 }
  }
  if (!user.traffic.free) user.traffic.free = emptyPool()
  if (!user.traffic.paid) user.traffic.paid = emptyPool()
  user.traffic.free.limit_bytes = Math.max(0, Math.floor(Number(user.traffic.free.limit_bytes) || 0))
  user.traffic.free.used_bytes = Math.max(0, Math.floor(Number(user.traffic.free.used_bytes) || 0))
  user.traffic.paid.limit_bytes = Math.max(0, Math.floor(Number(user.traffic.paid.limit_bytes) || 0))
  user.traffic.paid.used_bytes = Math.max(0, Math.floor(Number(user.traffic.paid.used_bytes) || 0))
  return user.traffic
}

/**
 * One-time migrate: fold old purchase-level traffic + bonus fields into dual wallets.
 */
export function migrateToDualWallets(user, data) {
  ensureTrafficWallets(user)
  if (user.traffic._v2 === 2) return false

  const now = nowTs()
  let freeLim = user.traffic.free.limit_bytes
  let freeUsed = user.traffic.free.used_bytes
  let paidLim = user.traffic.paid.limit_bytes
  let paidUsed = user.traffic.paid.used_bytes

  // orphan bonuses → free
  freeLim += Math.max(0, Math.floor(Number(user.checkin_traffic_bonus) || 0))
  freeLim += Math.max(0, Math.floor(Number(user.invite_traffic_bonus) || 0))
  user.checkin_traffic_bonus = 0
  user.invite_traffic_bonus = 0

  for (const p of user.purchases || []) {
    const lim = Math.max(0, Math.floor(Number(p.traffic_limit_bytes) || 0))
    const used = Math.max(0, Math.floor(Number(p.traffic_used_bytes) || 0))
    if (lim <= 0 && used <= 0) continue
    const plan = data?.plans?.find((x) => x.id === p.product_id)
    const isActivity = p.product_id === '__activity_reward__'
    const toPaid =
      p.traffic_pool === 'paid' ||
      (!isActivity && plan && Number(plan.price_cents || 0) > 0)
    if (toPaid) {
      paidLim += lim
      paidUsed += used
    } else {
      freeLim += lim
      freeUsed += used
    }
    // clear per-purchase counters (wallet is source of truth)
    p.traffic_limit_bytes = 0
    p.traffic_used_bytes = 0
    p.traffic_pool = toPaid ? 'paid' : 'free'
  }

  user.traffic.free.limit_bytes = freeLim
  user.traffic.free.used_bytes = freeUsed
  user.traffic.paid.limit_bytes = paidLim
  user.traffic.paid.used_bytes = paidUsed
  user.traffic._v2 = 2
  user.updated_at = now
  return true
}

/** Add traffic to a pool (free | paid). limit 0 means no grant. */
export function addTrafficToPool(user, pool, bytes) {
  const n = Math.max(0, Math.floor(Number(bytes) || 0))
  if (n <= 0) return 0
  ensureTrafficWallets(user)
  const key = pool === 'paid' ? 'paid' : 'free'
  user.traffic[key].limit_bytes += n
  user.updated_at = nowTs()
  return n
}

/**
 * Revoke a previously granted traffic allowance on a pool.
 *
 * Business refund / quota recovery (NOT a payment-gateway refund). Subtracts
 * `bytes` from the pool's limit_bytes without lowering it below used_bytes:
 * only the UNUSED portion of the grant is recovered — already-consumed traffic
 * is never reclaimed. used_bytes is left untouched.
 *
 * If bytes > (limit - used), only the reclaimable remainder (limit - used) is
 * recovered, and the function returns the actually-reclaimed amount.
 *
 * Records the reclaim into user.traffic_refunds[] for auditability.
 *
 * Returns { reclaimed, remaining_limit } where reclaimed is the bytes actually
 * subtracted (0 if nothing was reclaimable) and remaining_limit is the pool's
 * post-reclaim limit_bytes.
 */
export function revokeTrafficGrant(user, pool, bytes, reason = '') {
  const want = Math.max(0, Math.floor(Number(bytes) || 0))
  ensureTrafficWallets(user)
  const key = pool === 'paid' ? 'paid' : 'free'
  const p = user.traffic[key]
  const limit = Math.floor(Number(p.limit_bytes) || 0)
  const used = Math.floor(Number(p.used_bytes) || 0)
  // only the unused remainder (limit - used) can be reclaimed
  const reclaimable = Math.max(0, limit - used)
  const reclaimed = Math.min(want, reclaimable)
  if (reclaimed > 0) {
    p.limit_bytes = Math.max(used, limit - reclaimed)
    user.updated_at = nowTs()
  }
  if (!Array.isArray(user.traffic_refunds)) user.traffic_refunds = []
  user.traffic_refunds.unshift({
    id: `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: nowTs(),
    pool: key,
    asked_bytes: want,
    reclaimed_bytes: reclaimed,
    remaining_limit_bytes: Math.floor(Number(p.limit_bytes) || 0),
    used_bytes: used,
    reason: String(reason || '').slice(0, 200),
  })
  if (user.traffic_refunds.length > 500) user.traffic_refunds.length = 500
  return { reclaimed, remaining_limit: Math.floor(Number(p.limit_bytes) || 0) }
}

/**
 * Describe a traffic pool.
 * limit_bytes <= 0 means NO quota (not unlimited). Only explicit high limits show GB.
 * role: 'free' | 'paid' — affects empty labels.
 * entitled: for paid pool, false → always "未开通" even if residual used bytes remain.
 */
function describePool(pool, { role = 'free', entitled = true } = {}) {
  const lim = Math.max(0, Math.floor(Number(pool.limit_bytes) || 0))
  const used = Math.max(0, Math.floor(Number(pool.used_bytes) || 0))

  if (!entitled && role === 'paid') {
    return {
      limit_bytes: lim,
      used_bytes: used,
      remaining_bytes: 0,
      unlimited: false,
      exhausted: true,
      empty: true,
      label: used > 0 ? `已用 ${formatBytes(used)} · 已失效` : '未开通',
    }
  }

  // No configured quota
  if (lim <= 0) {
    return {
      limit_bytes: 0,
      used_bytes: used,
      remaining_bytes: 0,
      unlimited: false,
      exhausted: true,
      empty: true,
      label:
        used > 0
          ? `已用 ${formatBytes(used)} / 无额度`
          : role === 'paid'
            ? '未开通'
            : '无免费额度',
    }
  }

  const remaining = Math.max(0, lim - used)
  const exhausted = used >= lim
  return {
    limit_bytes: lim,
    used_bytes: used,
    remaining_bytes: remaining,
    unlimited: false,
    exhausted,
    empty: false,
    label: `${formatBytes(used)} / ${formatBytes(lim)}`,
  }
}

/**
 * Self-heal: if an order is already refunded but its grant/purchase was not
 * revoked (legacy bug), close the entitlement so nodes + paid flag drop.
 */
export function repairRefundedEntitlements(user, data) {
  if (!user || !Array.isArray(data?.orders)) return false
  let changed = false
  const now = nowTs()
  const refunded = data.orders.filter(
    (o) =>
      o &&
      o.user_id === user.id &&
      o.status === 'refunded' &&
      o.product_id &&
      o.product_id !== '__balance_topup__',
  )
  if (!refunded.length) return false

  for (const o of refunded) {
    const purchases = Array.isArray(user.purchases) ? user.purchases : []
    for (const p of purchases) {
      if (!p || p.product_id !== o.product_id) continue
      if (Array.isArray(p.grants)) {
        for (const g of p.grants) {
          if (g && g.order_id === o.id && !g.revoked_at) {
            g.revoked_at = o.refunded_at || now
            g.revoke_reason = o.refund_reason || 'repair: order already refunded'
            changed = true
          }
        }
        if (
          p.grants.length > 0 &&
          p.grants.every((g) => g && g.revoked_at) &&
          !p.revoked_at
        ) {
          p.revoked_at = o.refunded_at || now
          p.expire_at = p.revoked_at
          p.revoke_reason = o.refund_reason || 'repair: order already refunded'
          p.updated_at = now
          changed = true
        }
      } else if (!p.revoked_at) {
        // No grants ledger: only revoke if there is no later paid order AND
        // purchase expire is not after the refund (re-buy after refund keeps expire in future).
        const laterPaid = data.orders.some(
          (x) =>
            x.user_id === user.id &&
            x.product_id === o.product_id &&
            x.status === 'paid' &&
            Number(x.paid_at || x.created_at || 0) >
              Number(o.refunded_at || o.created_at || 0),
        )
        const regranted =
          Number(p.expire_at || 0) > now &&
          Number(p.updated_at || 0) > Number(o.refunded_at || 0)
        if (!laterPaid && !regranted) {
          p.revoked_at = o.refunded_at || now
          p.expire_at = p.revoked_at
          p.revoke_reason = o.refund_reason || 'repair: order already refunded'
          p.updated_at = now
          changed = true
        }
      }
    }
  }

  if (changed) {
    clampPaidWalletIfNotEntitled(user, data, now)
    user.updated_at = now
  }
  return changed
}

/**
 * Dual traffic snapshot for API / UI.
 */
export function getUserTraffic(user, data, now = nowTs()) {
  ensureTrafficWallets(user)
  migrateToDualWallets(user, data)
  repairRefundedEntitlements(user, data)

  const paidUser = isPaidUser(user, data, now)
  // Safety: non-paid users must not keep residual paid "unlimited" appearance
  if (!paidUser) clampPaidWalletIfNotEntitled(user, data, now)

  const free = describePool(user.traffic.free, { role: 'free', entitled: true })
  const paid = describePool(user.traffic.paid, {
    role: 'paid',
    entitled: paidUser,
  })

  // legacy single field: prefer paid if paid user with paid quota, else free
  let legacy
  if (paidUser && paid.limit_bytes > 0) {
    legacy = {
      unlimited: false,
      limit_bytes: paid.limit_bytes,
      used_bytes: paid.used_bytes,
      remaining_bytes: paid.remaining_bytes,
      exhausted: paid.exhausted,
      label: `付费 ${paid.label}`,
    }
  } else if (free.limit_bytes > 0) {
    legacy = {
      unlimited: false,
      limit_bytes: free.limit_bytes,
      used_bytes: free.used_bytes,
      remaining_bytes: free.remaining_bytes,
      exhausted: free.exhausted,
      label: `免费 ${free.label}`,
    }
  } else {
    legacy = {
      unlimited: false,
      limit_bytes: 0,
      used_bytes: free.used_bytes + paid.used_bytes,
      remaining_bytes: 0,
      exhausted: true,
      label: paidUser ? '付费未配置额度' : '无流量额度',
    }
  }

  return {
    free,
    paid,
    is_paid_user: paidUser,
    // legacy combined (old clients / dashboard single bar)
    unlimited: false,
    limit_bytes: legacy.limit_bytes,
    used_bytes: legacy.used_bytes,
    remaining_bytes: legacy.remaining_bytes,
    exhausted: legacy.exhausted,
    label: legacy.label,
    purchases: [],
  }
}

/**
 * Report usage. pool: 'free' | 'paid' | 'auto'
 * auto: paid user with paid limit → paid, else free
 */
/**
 * Apply usage to a wallet.
 * Returns { applied, pool } where pool is the resolved wallet key ('free'|'paid').
 * (Numeric return kept as applied for older callers that treat result as number.)
 */
export function applyTrafficDelta(user, data, deltaBytes, pool = 'auto', now = nowTs()) {
  const delta = Math.max(0, Math.floor(Number(deltaBytes) || 0))
  if (!delta) {
    const result = { applied: 0, pool: pool === 'paid' ? 'paid' : 'free' }
    result.valueOf = () => 0
    return result
  }
  ensureTrafficWallets(user)
  migrateToDualWallets(user, data)

  let key = pool
  if (pool === 'auto') {
    const paidUser = isPaidUser(user, data, now)
    const paidLim = user.traffic.paid.limit_bytes
    // Prefer paid wallet when user is paid and paid quota exists; otherwise free.
    // If paid user but paid unlimited (limit 0), still charge free for public use when free is limited.
    if (paidUser && paidLim > 0) key = 'paid'
    else if (paidUser && paidLim <= 0 && (user.traffic.free.limit_bytes || 0) > 0) key = 'free'
    else if (paidUser) key = 'paid'
    else key = 'free'
  } else {
    key = pool === 'paid' ? 'paid' : 'free'
  }

  user.traffic[key].used_bytes += delta
  user.updated_at = now
  const result = { applied: delta, pool: key }
  // backward compat: Number(result) / result + 0 style
  result.valueOf = () => delta
  result[Symbol.toPrimitive] = () => delta
  return result
}

/** Normalize purchase traffic fields (legacy, kept for admin display) */
export function ensurePurchaseTraffic(purchase, product) {
  if (!purchase) return purchase
  if (purchase.traffic_limit_bytes === undefined || purchase.traffic_limit_bytes === null) {
    purchase.traffic_limit_bytes = product ? productTrafficLimitBytes(product) : 0
  } else {
    purchase.traffic_limit_bytes = Math.max(0, Math.floor(Number(purchase.traffic_limit_bytes) || 0))
  }
  if (purchase.traffic_used_bytes === undefined || purchase.traffic_used_bytes === null) {
    purchase.traffic_used_bytes = 0
  } else {
    purchase.traffic_used_bytes = Math.max(0, Math.floor(Number(purchase.traffic_used_bytes) || 0))
  }
  return purchase
}

export function formatBytes(n) {
  const v = Number(n) || 0
  if (v <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let x = v
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${x.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

export function gbToBytes(gb) {
  const n = Number(gb)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n * 1024 * 1024 * 1024)
}

export function bytesToGb(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return 0
  return Math.round((n / (1024 * 1024 * 1024)) * 1000) / 1000
}

