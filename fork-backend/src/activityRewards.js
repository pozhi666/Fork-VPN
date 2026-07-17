/**
 * Activity rewards: days on "活动奖励" purchase + traffic into free/paid wallet.
 */
import { nowTs } from './db.js'
import { addTrafficToPool, ensureTrafficWallets, migrateToDualWallets } from './traffic.js'

export const ACTIVITY_PRODUCT_ID = '__activity_reward__'
export const ACTIVITY_PRODUCT_NAME = '活动奖励'

/**
 * @param {'free'|'paid'} trafficPool
 */
export function grantActivityReward(
  user,
  { days = 0, trafficBytes = 0, trafficPool = 'free', source = '活动' } = {},
  data = null,
) {
  if (!Array.isArray(user.purchases)) user.purchases = []
  ensureTrafficWallets(user)
  if (data) migrateToDualWallets(user, data)

  const now = nowTs()
  const d = Math.max(0, Math.floor(Number(days) || 0))
  const tb = Math.max(0, Math.floor(Number(trafficBytes) || 0))
  if (d <= 0 && tb <= 0) {
    return {
      expire_at: 0,
      traffic_added: 0,
      days_added: 0,
      traffic_pool: trafficPool,
    }
  }

  let row = user.purchases.find((p) => p.product_id === ACTIVITY_PRODUCT_ID)
  if (!row) {
    row = {
      product_id: ACTIVITY_PRODUCT_ID,
      source_id: null,
      name: ACTIVITY_PRODUCT_NAME,
      expire_at: 0,
      traffic_limit_bytes: 0,
      traffic_used_bytes: 0,
      created_at: now,
      updated_at: now,
      note: source,
    }
    user.purchases.push(row)
  }

  if (d > 0) {
    const base = row.expire_at && row.expire_at > now ? row.expire_at : now
    row.expire_at = base + d * 86400
    if (!user.expire_at || user.expire_at < row.expire_at) {
      user.expire_at = row.expire_at
    }
  } else if (tb > 0 && (!row.expire_at || row.expire_at <= now)) {
    // traffic-only: keep a display window
    row.expire_at = now + 30 * 86400
    if (!user.expire_at || user.expire_at < row.expire_at) {
      user.expire_at = row.expire_at
    }
  }

  const pool = trafficPool === 'paid' ? 'paid' : 'free'
  const traffic_added = addTrafficToPool(user, pool, tb)

  row.name = ACTIVITY_PRODUCT_NAME
  row.updated_at = now
  row.note = source
  // purchase row no longer holds wallet traffic
  row.traffic_limit_bytes = 0
  row.traffic_used_bytes = 0
  user.updated_at = now
  user.checkin_traffic_bonus = 0
  user.invite_traffic_bonus = 0

  return {
    expire_at: row.expire_at,
    traffic_added,
    days_added: d,
    traffic_pool: pool,
    purchase_id: row.product_id,
  }
}

/** @deprecated use migrateToDualWallets */
export function migrateBonusTraffic(user, data) {
  ensureTrafficWallets(user)
  migrateToDualWallets(user, data || { plans: [] })
  return null
}
