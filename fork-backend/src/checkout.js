/**
 * Checkout helpers: coupon preview / apply on purchase.
 */
import { nowTs } from './db.js'

export function normalizeCouponCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}

export function findValidCoupon(data, codeRaw, userId, productId) {
  const code = normalizeCouponCode(codeRaw)
  if (!code) return { ok: false, error: '请输入优惠码' }
  if (!Array.isArray(data.coupons)) return { ok: false, error: '兑换码不存在' }
  const coupon = data.coupons.find((c) => normalizeCouponCode(c.code) === code)
  if (!coupon) return { ok: false, error: '兑换码不存在' }
  if (coupon.status === 'disabled') return { ok: false, error: '兑换码已停用' }
  const now = nowTs()
  if (coupon.expire_at > 0 && coupon.expire_at < now) {
    return { ok: false, error: '兑换码已过期' }
  }
  const activeReservations = Array.isArray(coupon.reservations)
    ? coupon.reservations.filter((r) => r.status === 'reserved' && Number(r.expires_at || 0) > now)
    : []
  const maxUses = Number(coupon.max_uses || 0)
  const used = Number(coupon.used_count || 0)
  if (maxUses > 0 && used + activeReservations.length >= maxUses) {
    return { ok: false, error: '兑换码已用完' }
  }
  if (!Array.isArray(coupon.redemptions)) coupon.redemptions = []
  const perUser = Number(coupon.per_user_limit ?? 1)
  const userUsed = coupon.redemptions.filter((r) => r.user_id === userId).length
  const userReserved = activeReservations.filter((r) => r.user_id === userId).length
  if (perUser > 0 && userUsed + userReserved >= perUser) {
    return { ok: false, error: '您已使用过该兑换码' }
  }
  // product scope
  if (coupon.product_id && productId && coupon.product_id !== productId) {
    return { ok: false, error: '该优惠码不适用于此商品' }
  }
  return { ok: true, coupon }
}

/**
 * Compute final price after coupon.
 * kind: grant → free (0)
 * kind: discount → percent or cents off
 * legacy coupons without kind act as grant when product matches
 */
export function applyCouponPricing(product, coupon) {
  const base = Math.max(0, Number(product.price_cents || 0))
  const kind = coupon.kind || 'grant'
  if (kind === 'grant') {
    return {
      kind: 'grant',
      original_cents: base,
      final_cents: 0,
      discount_cents: base,
      free: true,
      label: '兑换开通（免支付）',
    }
  }
  let final = base
  const pct = Math.min(100, Math.max(0, Number(coupon.discount_percent || 0)))
  const off = Math.max(0, Math.floor(Number(coupon.discount_cents || 0)))
  if (pct > 0) final = Math.floor(base * (100 - pct) / 100)
  if (off > 0) final = Math.max(0, final - off)
  return {
    kind: 'discount',
    original_cents: base,
    final_cents: final,
    discount_cents: base - final,
    free: final <= 0,
    label:
      pct > 0
        ? `优惠 ${pct}%`
        : off > 0
          ? `立减 ¥${(off / 100).toFixed(2)}`
          : '优惠',
  }
}

export function consumeCoupon(coupon, userId, productId, { reservationId = '' } = {}) {
  const now = nowTs()
  coupon.used_count = (Number(coupon.used_count) || 0) + 1
  if (!Array.isArray(coupon.redemptions)) coupon.redemptions = []
  coupon.redemptions.push({
    user_id: userId,
    product_id: productId,
    reservation_id: reservationId || undefined,
    at: now,
  })
  coupon.updated_at = now
}

export function reserveCoupon(coupon, userId, productId, reservationId, expiresAt) {
  if (!reservationId) throw new Error('缺少优惠券预留标识')
  if (!Array.isArray(coupon.reservations)) coupon.reservations = []
  if (coupon.reservations.some((r) => r.id === reservationId)) return
  coupon.reservations.push({
    id: reservationId,
    user_id: userId,
    product_id: productId,
    status: 'reserved',
    created_at: nowTs(),
    expires_at: expiresAt,
  })
  coupon.updated_at = nowTs()
}

export function consumeCouponReservation(coupon, reservationId) {
  const reservation = Array.isArray(coupon.reservations)
    ? coupon.reservations.find((r) => r.id === reservationId)
    : null
  if (!reservation || reservation.status !== 'reserved') {
    throw new Error('优惠券预留不存在或已失效')
  }
  if (Number(reservation.expires_at || 0) <= nowTs()) {
    reservation.status = 'released'
    coupon.updated_at = nowTs()
    throw new Error('优惠券预留已过期')
  }
  reservation.status = 'consumed'
  reservation.consumed_at = nowTs()
  consumeCoupon(coupon, reservation.user_id, reservation.product_id, { reservationId })
}

export function releaseCouponReservation(coupon, reservationId, reason = 'released') {
  const reservation = Array.isArray(coupon.reservations)
    ? coupon.reservations.find((r) => r.id === reservationId)
    : null
  if (!reservation || reservation.status !== 'reserved') return false
  reservation.status = 'released'
  reservation.released_at = nowTs()
  reservation.release_reason = reason
  coupon.updated_at = nowTs()
  return true
}
