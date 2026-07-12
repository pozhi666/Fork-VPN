import { nowTs } from './db.js'

/**
 * Source is a pure node pool. Access control is NOT "free/paid pricing":
 * - public: every logged-in user
 * - locked: only via product purchase / admin grant
 *
 * Legacy field `tier: free|paid` maps to public|locked.
 */
export function sourceAccess(source) {
  if (source?.access === 'locked' || source?.access === 'public') return source.access
  return source?.tier === 'paid' ? 'locked' : 'public'
}

export function isPublicSource(source) {
  return sourceAccess(source) === 'public'
}

export function isLockedSource(source) {
  return sourceAccess(source) === 'locked'
}

/** System plans (trial etc.) are never sold. */
export function isSystemPlan(plan) {
  if (!plan) return false
  if (plan.kind === 'system') return true
  if (plan.kind === 'product') return false
  return plan.name === 'trial'
}

/** Listed in client shop */
export function isSellableProduct(plan) {
  if (!plan) return false
  if (isSystemPlan(plan)) return false
  if (plan.for_sale === false) return false
  return true
}

export function isFreeProduct(plan) {
  return isSellableProduct(plan) && Number(plan.price_cents || 0) <= 0
}

export function isPaidProduct(plan) {
  return isSellableProduct(plan) && Number(plan.price_cents || 0) > 0
}

function activePurchases(user, now = nowTs()) {
  const list = Array.isArray(user?.purchases) ? user.purchases : []
  return list.filter((p) => !p.expire_at || p.expire_at === 0 || p.expire_at > now)
}

/**
 * Accessible sources for a user:
 * - all public sources
 * - locked sources unlocked by active product purchases
 */
export function getAccessibleSources(data, user) {
  const publicSources = data.subscription_sources.filter((s) => isPublicSource(s))

  const unlockedSourceIds = new Set()
  for (const p of activePurchases(user)) {
    if (p.source_id) unlockedSourceIds.add(p.source_id)
    if (!p.source_id && p.product_id) {
      const plan = data.plans.find((x) => x.id === p.product_id)
      if (plan?.source_id) unlockedSourceIds.add(plan.source_id)
    }
  }

  const lockedUnlocked = data.subscription_sources.filter(
    (s) => isLockedSource(s) && unlockedSourceIds.has(s.id),
  )

  const map = new Map()
  for (const s of [...publicSources, ...lockedUnlocked]) map.set(s.id, s)
  return [...map.values()]
}

/**
 * Shop catalog is split by PRODUCT price only:
 * - free: sellable products with price_cents <= 0  (免费专区商品)
 * - paid: sellable products with price_cents > 0
 *
 * Public sources are NOT shop items — they auto-merge on sync without "buying".
 */
export function getCatalog(data, user) {
  const now = nowTs()
  const ownedIds = new Set(
    activePurchases(user, now)
      .map((p) => p.product_id)
      .filter(Boolean),
  )

  function mapProduct(p, tier) {
    const source = data.subscription_sources.find((s) => s.id === p.source_id)
    const price = Number(p.price_cents || 0)
    const configured = Boolean(
      source && ((source.url || '').trim() || (source.inline_yaml || '').trim()),
    )
    return {
      id: p.id,
      name: p.name,
      description: p.description || '',
      price_cents: price,
      price_label: price <= 0 ? '免费' : `¥${(price / 100).toFixed(2)}`,
      days: Number(p.duration_days || p.trial_days || 30),
      source_id: p.source_id,
      source_name: source?.name || null,
      source_access: source ? sourceAccess(source) : null,
      tier,
      type: 'product',
      owned: ownedIds.has(p.id),
      configured,
    }
  }

  const free = data.plans.filter(isFreeProduct).map((p) => mapProduct(p, 'free'))
  const paid = data.plans.filter(isPaidProduct).map((p) => mapProduct(p, 'paid'))

  return { free, paid }
}

export function summarizeUserAccess(data, user) {
  const now = nowTs()
  const purchases = activePurchases(user, now)
  const sources = getAccessibleSources(data, user)
  return {
    purchases: purchases.map((p) => ({
      product_id: p.product_id,
      name: p.name,
      source_id: p.source_id,
      expire_at: p.expire_at,
    })),
    purchase_names: purchases.map((p) => p.name).filter(Boolean),
    public_sources: sources.filter(isPublicSource).map((s) => s.name),
    unlocked_sources: sources.filter(isLockedSource).map((s) => s.name),
    // legacy keys for older admin UI
    free_sources: sources.filter(isPublicSource).map((s) => s.name),
    paid_sources: sources.filter(isLockedSource).map((s) => s.name),
  }
}

/**
 * Fingerprint of what nodes a user is allowed to have.
 * Client compares this with last sync; if different → re-sync (e.g. after revoke).
 */
export function accessFingerprint(data, user) {
  const now = nowTs()
  const sources = getAccessibleSources(data, user)
    .map((s) => s.id)
    .sort()
    .join(',')
  const pur = activePurchases(user, now)
    .map((p) => `${p.product_id}:${p.expire_at || 0}:${p.source_id || ''}`)
    .sort()
    .join('|')
  return `${sources}#${pur}`
}

/** Normalize source fields when saving */
export function normalizeSourceAccess(body = {}, existing = {}) {
  let access = body.access
  if (access !== 'public' && access !== 'locked') {
    // accept legacy tier
    if (body.tier === 'paid' || body.tier === 'locked') access = 'locked'
    else if (body.tier === 'free' || body.tier === 'public') access = 'public'
    else access = existing.access || (existing.tier === 'paid' ? 'locked' : 'public')
  }
  return {
    access,
    // keep tier in sync for old rows / old clients
    tier: access === 'locked' ? 'paid' : 'free',
  }
}
