import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consumeCouponReservation,
  findValidCoupon,
  releaseCouponReservation,
  reserveCoupon,
} from '../src/checkout.js'

function coupon() {
  return {
    id: 'coupon-1',
    code: 'SAVE10',
    status: 'active',
    max_uses: 1,
    per_user_limit: 1,
    used_count: 0,
    redemptions: [],
  }
}

test('a pending order reserves a coupon without consuming it', () => {
  const item = coupon()
  const expiresAt = Math.floor(Date.now() / 1000) + 60
  reserveCoupon(item, 'user-1', 'product-1', 'reservation-1', expiresAt)

  assert.equal(item.used_count, 0)
  assert.equal(findValidCoupon({ coupons: [item] }, 'SAVE10', 'user-2', 'product-1').ok, false)
  assert.equal(findValidCoupon({ coupons: [item] }, 'SAVE10', 'user-1', 'product-1').ok, false)
})

test('releasing an expired or cancelled order reservation makes the coupon available again', () => {
  const item = coupon()
  reserveCoupon(item, 'user-1', 'product-1', 'reservation-1', Math.floor(Date.now() / 1000) + 60)
  assert.equal(releaseCouponReservation(item, 'reservation-1', 'order_cancelled'), true)
  assert.equal(findValidCoupon({ coupons: [item] }, 'SAVE10', 'user-2', 'product-1').ok, true)
})

test('payment fulfillment consumes an existing coupon reservation exactly once', () => {
  const item = coupon()
  reserveCoupon(item, 'user-1', 'product-1', 'reservation-1', Math.floor(Date.now() / 1000) + 60)
  consumeCouponReservation(item, 'reservation-1')

  assert.equal(item.used_count, 1)
  assert.equal(item.redemptions.length, 1)
  assert.equal(item.reservations[0].status, 'consumed')
  assert.throws(() => consumeCouponReservation(item, 'reservation-1'), /不存在或已失效/)
})
