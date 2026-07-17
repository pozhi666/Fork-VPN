import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Isolated temp data dir so we never touch the real fork.json
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-backend-refund-'))
process.env.FORK_DATA_DIR = tempDir
process.env.FORK_INSECURE_TEST_MODE = '1'

const { db, nowTs } = await import(`../src/db.js?refund-test=${Date.now()}`)
const { signAdminToken } = await import(`../src/auth.js?refund-test=${Date.now()}`)
const routes = await import(`../src/routes.js?refund-test=${Date.now()}`)
const traffic = await import(`../src/traffic.js?refund-test=${Date.now()}`)

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function startApp() {
  const app = express()
  app.use(express.urlencoded({ extended: false }))
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/v1', routes.api)
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

const GB = 1024 * 1024 * 1024
const PRODUCT_TRAFFIC = 10 * GB // 10 GiB

/**
 * Seed one admin + one user + one paid product + a pending order, then fulfill
 * that order through the REAL grantPurchase path (with order_id) so the grant
 * ledger + wallet mirror production.
 */
function seedPaidOrder({ orderId = 'order-paid-1', usedBytes = 0 } = {}) {
  db.write((data) => {
    data.admins = [
      { id: 'admin-1', username: 'admin', password_hash: 'x', role: 'admin' },
    ]
    data.users = [
      {
        id: 'user-1',
        username: 'alice',
        password_hash: 'x',
        plan_id: '',
        purchases: [],
        expire_at: 0,
        traffic: {
          free: { limit_bytes: 0, used_bytes: 0 },
          paid: { limit_bytes: 0, used_bytes: 0 },
          _v2: 0,
        },
      },
    ]
    data.plans = [
      {
        id: 'plan-pro',
        name: 'Pro',
        price_cents: 1000,
        traffic_bytes: PRODUCT_TRAFFIC,
        duration_days: 30,
        trial_days: 30,
        source_id: 'src-1',
        visible: 1,
        status: 'active',
      },
    ]
    const now = nowTs()
    data.orders = [
      {
        id: orderId,
        out_trade_no: 'FTEST1',
        user_id: 'user-1',
        product_id: 'plan-pro',
        product_name: 'Pro',
        money_cents: 1000,
        money: '10.00',
        pay_type: 'alipay',
        status: 'pending',
        trade_no: '',
        pay_url: '',
        expire_at: 0,
        created_at: now,
        paid_at: 0,
        updated_at: now,
        coupon_reservation_id: '',
        coupon_reservation_expires_at: 0,
        payment_expires_at: now + 1800,
      },
    ]
  })

  // Fulfill the pending order through the real grant path, recording order_id
  // on the grant ledger (mirrors what fulfillPaidOrder now does).
  db.write((data) => {
    const order = data.orders.find((o) => o.id === orderId)
    const user = data.users.find((u) => u.id === order.user_id)
    const product = data.plans.find((p) => p.id === order.product_id)
    const grant = routes.grantPurchase(user, product, { order_id: order.id })
    order.status = 'paid'
    order.paid_at = nowTs()
    order.expire_at = grant.expire_at
    order.traffic_pool = grant.traffic_pool
    order.granted_traffic_bytes = grant.traffic_limit_bytes
    order.granted_days = grant.days
    order.updated_at = nowTs()
  })

  // simulate the client having consumed some of the paid pool
  if (usedBytes > 0) {
    db.write((data) => {
      const u = data.users.find((x) => x.id === 'user-1')
      u.traffic.paid.used_bytes = usedBytes
      u.updated_at = nowTs()
    })
  }
  return { orderId }
}

test('paid order refund reclaims unused paid-pool quota, keeps used bytes, and records the refund', async () => {
  const { orderId } = seedPaidOrder({ usedBytes: 3 * GB })

  const paidBefore = db.read().users[0].traffic.paid
  assert.equal(paidBefore.limit_bytes, PRODUCT_TRAFFIC, 'pre: paid limit = product traffic')
  assert.equal(paidBefore.used_bytes, 3 * GB, 'pre: used = 3 GiB')

  let body
  const { server, base } = await startApp()
  try {
    const token = signAdminToken({ id: 'admin-1', username: 'admin' })
    const resp = await fetch(`${base}/api/v1/admin/orders/${orderId}/refund`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'customer request' }),
    })
    const respText = await resp.text()
    assert.equal(
      resp.status,
      200,
      `refund should succeed: ${respText}`,
    )
    body = JSON.parse(respText)
    assert.equal(body.ok, true)
    assert.equal(body.status, 'refunded')
    assert.equal(body.pool, 'paid')
    assert.equal(body.granted_bytes, PRODUCT_TRAFFIC)
    // limit(10G) - used(3G) = 7G reclaimable; asked for 10G → clamped to 7G
    assert.equal(body.reclaimed_bytes, 7 * GB)
    assert.equal(body.remaining_limit_bytes, 3 * GB)
    assert.equal(body.refund_destination, 'balance')
    assert.equal(body.balance_credited_cents, 1000)
    assert.equal(body.balance_cents, 1000)
    assert.equal(body.is_paid_user, false)
  } finally {
    await new Promise((r) => server.close(r))
  }

  const after = db.read()
  const o = after.orders.find((x) => x.id === orderId)
  assert.equal(o.status, 'refunded')
  assert.ok(o.refunded_at > 0)
  assert.equal(o.refunded_by, 'admin')
  assert.equal(o.refund_reason, 'customer request')
  assert.equal(o.refund_destination, 'balance')
  assert.equal(o.balance_refund_cents, 1000)

  const paidAfter = after.users[0].traffic.paid
  // after clamp for non-paid: limit == used (3G)
  assert.equal(paidAfter.limit_bytes, 3 * GB, 'post: limit clamped to used (3G)')
  assert.equal(paidAfter.used_bytes, 3 * GB, 'post: used bytes unchanged')

  // store credit
  assert.equal(after.users[0].balance_cents, 1000)
  const balLedger = after.users[0].balance_ledger || []
  assert.ok(balLedger.some((x) => x.type === 'refund' && x.amount_cents === 1000))

  // refund recorded on the purchase row
  const purchase = after.users[0].purchases.find((p) => p.product_id === 'plan-pro')
  assert.ok(Array.isArray(purchase.refunds) && purchase.refunds.length === 1)
  assert.equal(purchase.refunds[0].order_id, orderId)
  assert.equal(purchase.refunds[0].reclaimed_bytes, 7 * GB)
  // grant ledger entry marked revoked
  const revokedGrant = purchase.grants.find((g) => g.order_id === orderId)
  assert.ok(revokedGrant && revokedGrant.revoked_at > 0)
  assert.equal(revokedGrant.revoke_reason, 'customer request')

  // traffic_refunds ledger on the user
  const refunds = after.users[0].traffic_refunds || []
  assert.ok(refunds.length >= 1)
  assert.equal(refunds[0].pool, 'paid')
  assert.equal(refunds[0].reclaimed_bytes, 7 * GB)

  // audit log entry
  const audit = after.audit_logs.find(
    (a) => a.action === 'order.refund' && a.target === orderId,
  )
  assert.ok(audit, 'order.refund audit entry should exist')
  assert.equal(audit.detail.reclaimed_bytes, 7 * GB)
  assert.equal(audit.detail.balance_credited_cents, 1000)

  // entitlement fully gone — not paid, paid pool not "unlimited"
  assert.ok(purchase.revoked_at > 0 || purchase.expire_at <= nowTs())
  assert.equal(traffic.isPaidUser(after.users[0], after), false)
  const snap = traffic.getUserTraffic(after.users[0], after)
  assert.equal(snap.is_paid_user, false)
  assert.equal(snap.paid.unlimited, false)
  assert.ok(
    snap.paid.label.includes('未开通') ||
      snap.paid.label.includes('已失效') ||
      snap.paid.empty === true,
    `paid label should not be unlimited, got: ${snap.paid.label}`,
  )
})

test('re-grant after refund clears revoked_at so user becomes paid again', async () => {
  const { orderId } = seedPaidOrder({ orderId: 'order-regrant-1', usedBytes: 0 })
  // refund
  {
    const { server, base } = await startApp()
    try {
      const token = signAdminToken({ id: 'admin-1', username: 'admin' })
      const resp = await fetch(`${base}/api/v1/admin/orders/${orderId}/refund`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'then rebuy' }),
      })
      assert.equal(resp.status, 200, await resp.text())
    } finally {
      await new Promise((r) => server.close(r))
    }
  }
  assert.equal(traffic.isPaidUser(db.read().users[0], db.read()), false)

  // simulate balance re-purchase via grantPurchase
  db.write((data) => {
    const user = data.users.find((u) => u.id === 'user-1')
    const product = data.plans.find((p) => p.id === 'plan-pro')
    routes.grantPurchase(user, product, { order_id: 'order-regrant-2' })
  })

  const after = db.read()
  const p = after.users[0].purchases.find((x) => x.product_id === 'plan-pro')
  assert.equal(Number(p.revoked_at || 0), 0, 'revoked_at must be cleared on re-grant')
  assert.ok(p.grants.some((g) => g.order_id === 'order-regrant-2' && !g.revoked_at))
  assert.equal(traffic.isPaidUser(after.users[0], after), true)
  const snap = traffic.getUserTraffic(after.users[0], after)
  assert.equal(snap.is_paid_user, true)
  assert.ok(!String(snap.paid.label).includes('未开通'))
})

test('refund without grant ledger still revokes purchase and paid access', async () => {
  const { orderId } = seedPaidOrder({ orderId: 'order-noleger-1', usedBytes: 0 })
  // strip grant ledger (legacy shape)
  db.write((data) => {
    const u = data.users.find((x) => x.id === 'user-1')
    const p = u.purchases.find((x) => x.product_id === 'plan-pro')
    delete p.grants
    p.expire_at = nowTs() + 86400 * 30
    p.revoked_at = 0
  })

  let body
  const { server, base } = await startApp()
  try {
    const token = signAdminToken({ id: 'admin-1', username: 'admin' })
    const resp = await fetch(`${base}/api/v1/admin/orders/${orderId}/refund`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'no ledger' }),
    })
    const text = await resp.text()
    assert.equal(resp.status, 200, text)
    body = JSON.parse(text)
    assert.equal(body.is_paid_user, false)
  } finally {
    await new Promise((r) => server.close(r))
  }

  const after = db.read()
  const p = after.users[0].purchases.find((x) => x.product_id === 'plan-pro')
  assert.ok(p.revoked_at > 0, 'purchase must be revoked')
  assert.equal(traffic.isPaidUser(after.users[0], after), false)
  const snap = traffic.getUserTraffic(after.users[0], after)
  assert.equal(snap.paid.unlimited, false)
  assert.ok(!String(snap.paid.label).includes('不限'))
})

test('refunding an already-refunded order is rejected (duplicate refund blocked)', async () => {
  const { orderId } = seedPaidOrder({ orderId: 'order-dup-1', usedBytes: 0 })
  // mark it already refunded
  db.write((data) => {
    const o = data.orders.find((x) => x.id === orderId)
    o.status = 'refunded'
    o.refunded_at = nowTs()
  })

  const { server, base } = await startApp()
  try {
    const token = signAdminToken({ id: 'admin-1', username: 'admin' })
    const resp = await fetch(`${base}/api/v1/admin/orders/${orderId}/refund`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'dup' }),
    })
    assert.equal(resp.status, 400)
    const body = await resp.json()
    assert.match(body.error, /不可退款|已关闭|状态/)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('revokeTrafficGrant only reclaims the unused portion and never drops limit below used', () => {
  const user = {
    traffic: {
      free: { limit_bytes: 0, used_bytes: 0 },
      paid: { limit_bytes: 0, used_bytes: 0 },
      _v2: 0,
    },
  }
  traffic.ensureTrafficWallets(user)
  traffic.addTrafficToPool(user, 'paid', 10 * GB)
  user.traffic.paid.used_bytes = 6 * GB

  // ask to reclaim 8 GiB → only 4 GiB reclaimable (10-6)
  const r = traffic.revokeTrafficGrant(user, 'paid', 8 * GB, 'partial')
  assert.equal(r.reclaimed, 4 * GB)
  assert.equal(r.remaining_limit, 6 * GB)
  assert.equal(user.traffic.paid.limit_bytes, 6 * GB)
  assert.equal(user.traffic.paid.used_bytes, 6 * GB)

  // second reclaim of the full pool now reclaims 0 (limit == used)
  const r2 = traffic.revokeTrafficGrant(user, 'paid', 5 * GB, 'none left')
  assert.equal(r2.reclaimed, 0)
  assert.equal(user.traffic.paid.limit_bytes, 6 * GB)

  // ledger recorded both attempts
  assert.ok(user.traffic_refunds.length === 2)
})
