/**
 * In-app balance (store credit) — not a payment-gateway wallet.
 *
 * Units: integer cents (¥1.00 = 100).
 * Credits: admin refunds, admin adjust, order cancel/expire release.
 * Debits: purchase balance pay / partial pay hold.
 */
import { nowTs } from './db.js'

const MAX_LEDGER = 500

export function ensureBalance(user) {
  if (!user || typeof user !== 'object') return user
  const n = Math.floor(Number(user.balance_cents))
  user.balance_cents = Number.isFinite(n) && n > 0 ? n : 0
  if (!Array.isArray(user.balance_ledger)) user.balance_ledger = []
  return user
}

export function getBalanceCents(user) {
  ensureBalance(user)
  return user.balance_cents
}

function pushLedger(user, entry) {
  ensureBalance(user)
  user.balance_ledger.unshift(entry)
  if (user.balance_ledger.length > MAX_LEDGER) {
    user.balance_ledger.length = MAX_LEDGER
  }
}

/**
 * Credit balance. Returns { credited, balance_cents }.
 */
export function creditBalance(
  user,
  cents,
  { type = 'credit', reason = '', ref_type = '', ref_id = '', actor = '' } = {},
) {
  ensureBalance(user)
  const amount = Math.max(0, Math.floor(Number(cents) || 0))
  if (amount <= 0) {
    return { credited: 0, balance_cents: user.balance_cents }
  }
  user.balance_cents += amount
  user.updated_at = nowTs()
  pushLedger(user, {
    id: `bl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: nowTs(),
    direction: 'credit',
    type: String(type || 'credit').slice(0, 40),
    amount_cents: amount,
    balance_after: user.balance_cents,
    reason: String(reason || '').slice(0, 200),
    ref_type: String(ref_type || '').slice(0, 40),
    ref_id: String(ref_id || '').slice(0, 80),
    actor: String(actor || '').slice(0, 80),
  })
  return { credited: amount, balance_cents: user.balance_cents }
}

/**
 * Debit balance. Throws if insufficient unless allowPartial.
 * Returns { debited, balance_cents }.
 */
export function debitBalance(
  user,
  cents,
  {
    type = 'debit',
    reason = '',
    ref_type = '',
    ref_id = '',
    actor = '',
    allowPartial = false,
  } = {},
) {
  ensureBalance(user)
  const want = Math.max(0, Math.floor(Number(cents) || 0))
  if (want <= 0) {
    return { debited: 0, balance_cents: user.balance_cents }
  }
  let amount = want
  if (user.balance_cents < want) {
    if (!allowPartial) throw new Error('余额不足')
    amount = user.balance_cents
  }
  if (amount <= 0) {
    return { debited: 0, balance_cents: user.balance_cents }
  }
  user.balance_cents -= amount
  user.updated_at = nowTs()
  pushLedger(user, {
    id: `bl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: nowTs(),
    direction: 'debit',
    type: String(type || 'debit').slice(0, 40),
    amount_cents: amount,
    balance_after: user.balance_cents,
    reason: String(reason || '').slice(0, 200),
    ref_type: String(ref_type || '').slice(0, 40),
    ref_id: String(ref_id || '').slice(0, 80),
    actor: String(actor || '').slice(0, 80),
  })
  return { debited: amount, balance_cents: user.balance_cents }
}

/**
 * How much balance can cover of a final price.
 * useBalance: false → apply 0; true/undefined → apply min(balance, price).
 */
export function planBalanceApplication(user, priceCents, useBalance = true) {
  ensureBalance(user)
  const price = Math.max(0, Math.floor(Number(priceCents) || 0))
  if (!useBalance || price <= 0) {
    return {
      balance_cents: user.balance_cents,
      balance_applied_cents: 0,
      gateway_cents: price,
      fully_covered: price <= 0,
    }
  }
  const applied = Math.min(user.balance_cents, price)
  const gateway = price - applied
  return {
    balance_cents: user.balance_cents,
    balance_applied_cents: applied,
    gateway_cents: gateway,
    fully_covered: gateway <= 0,
  }
}

/**
 * Release balance held on a pending order (cancel / expire).
 * Idempotent via order.balance_released.
 */
export function releaseOrderBalanceHold(user, order, reason = 'order_cancelled') {
  if (!order || !user) return { released: 0 }
  if (order.balance_released) return { released: 0 }
  const held = Math.max(0, Math.floor(Number(order.balance_applied_cents) || 0))
  // Only release if order never completed (pending/expired/cancelled)
  // Paid refunds use full money_cents credit instead.
  if (held <= 0) {
    order.balance_released = true
    return { released: 0 }
  }
  const r = creditBalance(user, held, {
    type: 'order_release',
    reason,
    ref_type: 'order',
    ref_id: order.id,
    actor: 'system',
  })
  order.balance_released = true
  order.balance_released_at = nowTs()
  return { released: r.credited }
}

/**
 * Credit full order value to balance on business refund (destination = balance).
 * Idempotent via order.balance_refund_cents.
 */
export function creditOrderRefundToBalance(user, order, { reason = '', actor = '' } = {}) {
  if (!order || !user) return { credited: 0, balance_cents: getBalanceCents(user) }
  if (Number(order.balance_refund_cents) > 0) {
    return {
      credited: 0,
      balance_cents: getBalanceCents(user),
      already: true,
    }
  }
  const amount = Math.max(0, Math.floor(Number(order.money_cents) || 0))
  if (amount <= 0) {
    order.balance_refund_cents = 0
    order.refund_destination = 'balance'
    return { credited: 0, balance_cents: getBalanceCents(user) }
  }
  // Mark hold released so cancel path won't double-credit the hold portion
  order.balance_released = true
  const r = creditBalance(user, amount, {
    type: 'refund',
    reason: reason || 'order refund to balance',
    ref_type: 'order',
    ref_id: order.id,
    actor: actor || 'admin',
  })
  order.balance_refund_cents = r.credited
  order.refund_destination = 'balance'
  return { credited: r.credited, balance_cents: r.balance_cents }
}

export function listBalanceLedger(user, limit = 50) {
  ensureBalance(user)
  const n = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)))
  return (user.balance_ledger || []).slice(0, n)
}

export function formatYuan(cents) {
  const n = Math.floor(Number(cents) || 0)
  return (n / 100).toFixed(2)
}
