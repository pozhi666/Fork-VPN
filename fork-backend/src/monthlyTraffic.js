import { nowTs } from './db.js'
import { ensurePurchaseTraffic } from './traffic.js'

/**
 * If product.traffic_reset === 'monthly', reset used when calendar month changes.
 * Stores purchase.traffic_period = 'YYYY-MM'
 */
export function maybeResetMonthlyTraffic(user, data, now = nowTs()) {
  if (!user || !Array.isArray(user.purchases)) return
  const d = new Date(now * 1000)
  const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  for (const p of user.purchases) {
    const product = data.plans?.find((x) => x.id === p.product_id)
    if (!product) continue
    ensurePurchaseTraffic(p, product)
    const mode = product.traffic_reset || 'never'
    if (mode !== 'monthly') continue
    if (p.traffic_period === period) continue
    // new period: reset used, refresh limit from product (fixed monthly quota)
    const lim = Number(product.traffic_bytes) || 0
    if (lim > 0) p.traffic_limit_bytes = lim
    p.traffic_used_bytes = 0
    p.traffic_period = period
    p.updated_at = now
  }
}
