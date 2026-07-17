/**
 * Admin ops: orders refund, audit, backup, health, invites, devices (admin view).
 * Mounted onto the same /api/v1 router.
 */
import fs from 'fs'
import { nanoid } from 'nanoid'
import { db, nowTs } from './db.js'
import { authMiddleware } from './auth.js'
import { appendAudit, listAudit } from './audit.js'
import { createBackup, getBackupPath, listBackups, restoreBackup } from './backup.js'
import { ensureUserInviteCode, normalizeInvite } from './invites.js'
import { ensureDevices, removeDevice } from './devices.js'
import {
  clampPaidWalletIfNotEntitled,
  formatBytes,
  getUserTraffic,
  isPaidUser,
  revokeTrafficGrant,
} from './traffic.js'
import { accessFingerprint } from './access.js'
import { maybeResetMonthlyTraffic } from './monthlyTraffic.js'
import { previewSource } from './subscription.js'
import { isSellableProduct } from './access.js'
import { releaseCouponReservation } from './checkout.js'
import {
  creditOrderRefundToBalance,
  debitBalance,
  getBalanceCents,
  releaseOrderBalanceHold,
} from './balance.js'

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  return xf || req.socket?.remoteAddress || req.ip || ''
}

/**
 * Locate the per-order grant ledger entry this order produced at fulfillment.
 * grantPurchase appends a grants[] row (with order_id) onto the user's purchase
 * row for the product; we search all purchases so refunds are order-scoped even
 * when the product was renewed/merged into a single purchase row.
 */
function findOrderGrant(user, orderId) {
  const purchases = Array.isArray(user?.purchases) ? user.purchases : []
  for (const p of purchases) {
    if (Array.isArray(p.grants)) {
      const g = p.grants.find((x) => x.order_id === orderId && !x.revoked_at)
      if (g) return { purchase: p, grant: g }
    }
  }
  return null
}

/**
 * Force-revoke purchase entitlement for a product (fallback when grant ledger
 * missing / order_id not recorded). Also revokes any open grants on that row.
 */
function forceRevokeProductPurchase(user, productId, reason = '') {
  if (!user || !productId) return null
  const purchases = Array.isArray(user.purchases) ? user.purchases : []
  const p = purchases.find(
    (x) => x.product_id === productId && !x.revoked_at,
  )
  if (!p) return null
  const now = nowTs()
  p.expire_at = now
  p.revoked_at = now
  p.revoke_reason = reason || 'order refund'
  p.updated_at = now
  if (Array.isArray(p.grants)) {
    for (const g of p.grants) {
      if (g && !g.revoked_at) {
        g.revoked_at = now
        g.revoke_reason = reason || 'order refund'
      }
    }
  }
  return p
}

export function mountOpsRoutes(api) {
  /** Orders export CSV */
  api.get('/admin/orders/export', authMiddleware('admin'), (_req, res) => {
    const data = db.read()
    if (!Array.isArray(data.orders)) data.orders = []
    const lines = [
      'id,out_trade_no,username,product_name,money_cents,status,pay_type,trade_no,created_at,paid_at',
    ]
    for (const o of data.orders) {
      const u = data.users.find((x) => x.id === o.user_id)
      lines.push(
        [
          o.id,
          o.out_trade_no || '',
          u?.username || o.user_id,
          JSON.stringify(o.product_name || ''),
          o.money_cents || 0,
          o.status || '',
          o.pay_type || '',
          o.trade_no || '',
          o.created_at || 0,
          o.paid_at || 0,
        ].join(','),
      )
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"')
    res.send('\uFEFF' + lines.join('\n'))
  })

  /**
   * Refund (paid order) or cancel (pending order).
   *
   * Paid order refund is a BUSINESS refund:
   * 1) reclaim unused traffic for this order's grant
   * 2) credit order.money_cents to the user's in-app balance (store credit)
   * No payment-gateway (原路) refund — avoids channel risk / chargebacks.
   *
   * Pending order cancel frees coupon reservation + releases any balance hold.
   *
   * body: { reason }  (admin-supplied refund reason)
   */
  api.post('/admin/orders/:id/refund', authMiddleware('admin'), (req, res) => {
    try {
      const actor = req.auth?.username || req.auth?.sub || 'admin'
      const reason = String(req.body?.reason ?? req.body?.note ?? '').slice(0, 200)
      const result = db.write((data) => {
        if (!Array.isArray(data.orders)) data.orders = []
        const order = data.orders.find((o) => o.id === req.params.id)
        if (!order) throw new Error('订单不存在')

        const wasPaid = order.status === 'paid' || order.status === 'fulfilled'
        if (!wasPaid && order.status !== 'pending' && order.status !== 'pending_payment') {
          throw new Error(`订单当前状态不可退款（${order.status || 'unknown'}）`)
        }
        const user = data.users.find((u) => u.id === order.user_id)

        // --- pending order: cancel + free coupon + release balance hold ---
        if (!wasPaid) {
          if (order.coupon_reservation_id) {
            const coupon = (data.coupons || []).find((c) => c.id === order.coupon_id)
            if (coupon) {
              releaseCouponReservation(coupon, order.coupon_reservation_id, 'order_cancelled')
            }
          }
          let balanceReleased = 0
          if (user) {
            balanceReleased = releaseOrderBalanceHold(
              user,
              order,
              reason || 'order_cancelled',
            ).released
          }
          order.status = 'cancelled'
          order.cancelled_at = nowTs()
          order.refund_reason = reason
          order.updated_at = nowTs()
          appendAudit(data, {
            actor,
            actor_type: 'admin',
            action: 'order.cancel',
            target: order.id,
            detail: {
              out_trade_no: order.out_trade_no,
              user_id: order.user_id,
              product_id: order.product_id,
              balance_released_cents: balanceReleased,
              reason,
            },
            ip: clientIp(req),
          })
          return {
            id: order.id,
            status: order.status,
            balance_released_cents: balanceReleased,
          }
        }

        // --- paid order ---
        if (!user) throw new Error('订单用户不存在')

        // 余额充值单：扣回已入账余额（非渠道原路退），不涉及流量
        const isTopup =
          order.order_kind === 'balance_topup' ||
          order.product_id === '__balance_topup__'
        if (isTopup) {
          const claw = Math.max(
            0,
            Math.floor(
              Number(order.balance_credited_cents || order.money_cents) || 0,
            ),
          )
          let debited = 0
          if (claw > 0) {
            const r = debitBalance(user, claw, {
              type: 'topup_refund',
              reason: reason || '充值订单退款扣回',
              ref_type: 'order',
              ref_id: order.id,
              actor,
              allowPartial: true,
            })
            debited = r.debited
          }
          order.status = 'refunded'
          order.refunded_at = nowTs()
          order.refunded_by = actor
          order.refund_reason = reason
          order.refund_destination = 'clawback_balance'
          order.balance_clawback_cents = debited
          order.updated_at = nowTs()
          user.updated_at = nowTs()
          appendAudit(data, {
            actor,
            actor_type: 'admin',
            action: 'order.refund',
            target: order.id,
            detail: {
              out_trade_no: order.out_trade_no,
              user_id: order.user_id,
              order_kind: 'balance_topup',
              balance_clawback_cents: debited,
              balance_cents: getBalanceCents(user),
              reason,
            },
            ip: clientIp(req),
          })
          return {
            id: order.id,
            status: order.status,
            order_kind: 'balance_topup',
            balance_clawback_cents: debited,
            balance_cents: getBalanceCents(user),
            balance_credited_cents: 0,
          }
        }

        const product = order.product_id
          ? data.plans.find((p) => p.id === order.product_id)
          : null
        let pool = order.traffic_pool || (Number(product?.price_cents || 0) > 0 ? 'paid' : 'free')
        let grantBytes = Math.max(0, Math.floor(Number(order.granted_traffic_bytes) || 0))
        if (grantBytes <= 0 && product) {
          grantBytes = Math.max(0, Math.floor(Number(product.traffic_bytes) || 0))
        }

        const reclaim = grantBytes > 0
          ? revokeTrafficGrant(user, pool, grantBytes, `order refund ${order.id}: ${reason || 'refund'}`)
          : { reclaimed: 0, remaining_limit: Number(user.traffic?.[pool]?.limit_bytes) || 0 }

        const found = findOrderGrant(user, order.id)
        if (found) {
          found.grant.revoked_at = nowTs()
          found.grant.revoke_reason = reason
          found.purchase.updated_at = nowTs()
          if (!Array.isArray(found.purchase.refunds)) found.purchase.refunds = []
          found.purchase.refunds.push({
            order_id: order.id,
            pool,
            bytes: grantBytes,
            reclaimed_bytes: reclaim.reclaimed,
            reason,
            at: nowTs(),
          })
          const allRevoked = found.purchase.grants.every((g) => g.revoked_at)
          if (allRevoked) {
            found.purchase.expire_at = nowTs()
            found.purchase.revoked_at = nowTs()
            found.purchase.revoke_reason = reason
          }
        } else if (order.product_id) {
          // Fallback: no grant ledger (legacy orders / missing order_id) →
          // still kill the product entitlement so nodes/access drop immediately.
          forceRevokeProductPurchase(
            user,
            order.product_id,
            reason || `order refund ${order.id}`,
          )
        }

        // Unlimited products grant 0 bytes: still reclaim any leftover paid
        // remaining once entitlement is gone.
        clampPaidWalletIfNotEntitled(user, data)

        // Clear plan_id if it pointed at a revoked product and no paid left
        if (
          user.plan_id &&
          order.product_id &&
          user.plan_id === order.product_id &&
          !isPaidUser(user, data)
        ) {
          user.plan_id = null
        }

        const bal = creditOrderRefundToBalance(user, order, { reason, actor })

        order.status = 'refunded'
        order.refunded_at = nowTs()
        order.refunded_by = actor
        order.refund_reason = reason
        order.updated_at = nowTs()
        user.updated_at = nowTs()

        // access_key changes when purchases/sources change — client should re-sync
        const newAccessKey = accessFingerprint(data, user)

        appendAudit(data, {
          actor,
          actor_type: 'admin',
          action: 'order.refund',
          target: order.id,
          detail: {
            out_trade_no: order.out_trade_no,
            user_id: order.user_id,
            product_id: order.product_id,
            pool,
            granted_bytes: grantBytes,
            reclaimed_bytes: reclaim.reclaimed,
            remaining_limit_bytes: reclaim.remaining_limit,
            refund_destination: 'balance',
            balance_credited_cents: bal.credited,
            balance_cents: bal.balance_cents,
            is_paid_user: isPaidUser(user, data),
            access_key: newAccessKey,
            reason,
          },
          ip: clientIp(req),
        })
        return {
          id: order.id,
          status: order.status,
          pool,
          granted_bytes: grantBytes,
          reclaimed_bytes: reclaim.reclaimed,
          remaining_limit_bytes: reclaim.remaining_limit,
          refund_destination: 'balance',
          balance_credited_cents: bal.credited,
          balance_cents: bal.balance_cents ?? getBalanceCents(user),
          is_paid_user: isPaidUser(user, data),
          access_key: newAccessKey,
        }
      })
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  api.get('/admin/audit', authMiddleware('admin'), (req, res) => {
    const data = db.read()
    const limit = Number(req.query?.limit || 100)
    const action = req.query?.action ? String(req.query.action) : ''
    res.json({ items: listAudit(data, { limit, action }) })
  })

  api.get('/admin/backups', authMiddleware('admin'), (_req, res) => {
    res.json({ items: listBackups() })
  })

  api.get('/admin/backups/:name/download', authMiddleware('admin'), (req, res) => {
    try {
      const name = String(req.params.name || '')
      const filePath = getBackupPath(name)
      res.download(filePath, name)
    } catch (e) {
      res.status(404).json({ error: e.message })
    }
  })

  api.post('/admin/backups', authMiddleware('admin'), (req, res) => {
    try {
      const r = createBackup(db.path, String(req.body?.note || '').slice(0, 30))
      db.write((data) => {
        appendAudit(data, {
          actor: req.auth?.username || 'admin',
          actor_type: 'admin',
          action: 'backup.create',
          target: r.name,
          ip: clientIp(req),
        })
      })
      res.json({ ok: true, ...r })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  api.post('/admin/backups/restore', authMiddleware('admin'), (req, res) => {
    try {
      const name = String(req.body?.name || '')
      restoreBackup(db.path, name)
      db.write((data) => {
        appendAudit(data, {
          actor: req.auth?.username || 'admin',
          actor_type: 'admin',
          action: 'backup.restore',
          target: name,
          ip: clientIp(req),
        })
      })
      res.json({ ok: true, message: '已恢复，请确认服务正常' })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  api.get('/admin/health', authMiddleware('admin'), async (_req, res) => {
    const data = db.read()
    const checks = []
    // db size
    let dbBytes = 0
    try {
      dbBytes = fs.statSync(db.path).size
      checks.push({ name: 'database', ok: true, detail: `${dbBytes} bytes` })
    } catch (e) {
      checks.push({ name: 'database', ok: false, detail: e.message })
    }
    checks.push({
      name: 'users',
      ok: true,
      detail: String((data.users || []).length),
    })
    checks.push({
      name: 'orders_pending',
      ok: true,
      detail: String((data.orders || []).filter((o) => o.status === 'pending').length),
    })
    // sample source pull (first configured)
    const src = (data.subscription_sources || []).find(
      (s) => (s.url || '').trim() || (s.inline_yaml || '').trim(),
    )
    if (src) {
      try {
        const prev = await previewSource(src)
        const n = prev?.nodes?.length ?? prev?.node_count ?? 0
        checks.push({
          name: 'source_preview',
          ok: n > 0,
          detail: `${src.name}: ${n} nodes`,
        })
      } catch (e) {
        checks.push({
          name: 'source_preview',
          ok: false,
          detail: `${src.name}: ${e.message}`,
        })
      }
    } else {
      checks.push({ name: 'source_preview', ok: false, detail: '无可用订阅源' })
    }
    const ok = checks.every((c) => c.ok)
    res.json({ ok, checks, at: nowTs() })
  })

  /** Admin create global invite code */
  api.post('/admin/invites', authMiddleware('admin'), (req, res) => {
    try {
      const code = normalizeInvite(req.body?.code) || nanoid(8).toUpperCase()
      const max_uses = Math.max(0, Number(req.body?.max_uses || 0))
      db.write((data) => {
        if (!Array.isArray(data.invite_codes)) data.invite_codes = []
        if (data.invite_codes.some((c) => c.code === code)) throw new Error('邀请码已存在')
        if (data.users.some((u) => String(u.invite_code || '').toUpperCase() === code)) {
          throw new Error('与用户邀请码冲突')
        }
        data.invite_codes.push({
          id: nanoid(),
          code,
          max_uses,
          used_count: 0,
          status: 'active',
          note: String(req.body?.note || '').slice(0, 100),
          created_at: nowTs(),
          updated_at: nowTs(),
        })
        appendAudit(data, {
          actor: req.auth?.username || 'admin',
          actor_type: 'admin',
          action: 'invite.create',
          target: code,
          ip: clientIp(req),
        })
      })
      res.json({ ok: true, code })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  api.get('/admin/invites', authMiddleware('admin'), (_req, res) => {
    const data = db.read()
    res.json({
      items: data.invite_codes || [],
      redemptions: (data.invite_redemptions || []).slice(0, 100),
      reward_days: Number(data.settings?.invite_reward_days ?? 3),
    })
  })

  api.get('/admin/users/:id/devices', authMiddleware('admin'), (req, res) => {
    const data = db.read()
    const user = data.users.find((u) => u.id === req.params.id)
    if (!user) return res.status(404).json({ error: '用户不存在' })
    res.json({ items: ensureDevices(user), max: Number(data.settings?.max_devices || 3) })
  })

  api.delete('/admin/users/:id/devices/:deviceId', authMiddleware('admin'), (req, res) => {
    try {
      db.write((data) => {
        const user = data.users.find((u) => u.id === req.params.id)
        if (!user) throw new Error('用户不存在')
        removeDevice(user, req.params.deviceId)
        appendAudit(data, {
          actor: req.auth?.username || 'admin',
          actor_type: 'admin',
          action: 'device.remove',
          target: req.params.id,
          detail: { device_id: req.params.deviceId },
          ip: clientIp(req),
        })
      })
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })
}
