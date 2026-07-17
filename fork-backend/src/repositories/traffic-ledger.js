import crypto from 'crypto'
import { withTransaction } from '../database/index.js'

const uuid = () => crypto.randomUUID()

function assertPool(pool) {
  if (pool !== 'free' && pool !== 'paid') throw new Error('流量池必须是 free 或 paid')
  return pool
}

function assertQuotaMode(mode) {
  if (!['limited', 'unlimited', 'none'].includes(mode)) {
    throw new Error('额度模式必须是 limited、unlimited 或 none')
  }
  return mode
}

function toBytes(value) {
  const bytes = Math.floor(Number(value || 0))
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('流量字节数无效')
  return bytes
}

export async function createEntitlementWithGrant({
  userId,
  originType,
  originId,
  productId = null,
  sourceId = null,
  pool,
  quotaMode = 'limited',
  grantedBytes = 0,
  startsAt = new Date(),
  expiresAt = null,
  periodKey = null,
  consumptionPriority = 100,
  productSnapshot = {},
}) {
  assertPool(pool)
  assertQuotaMode(quotaMode)
  const bytes = toBytes(grantedBytes)
  if (quotaMode === 'limited' && bytes <= 0) throw new Error('有限额度必须大于 0')
  if (quotaMode !== 'limited' && bytes !== 0) throw new Error('非有限额度不能设置字节额度')

  return withTransaction(async (client) => {
    const entitlementId = uuid()
    const grantId = uuid()
    await client.query(
      `INSERT INTO entitlements
       (id, user_id, origin_type, origin_id, product_id, source_id, pool, status, starts_at, expires_at, product_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10)`,
      [
        entitlementId,
        userId,
        originType,
        originId,
        productId,
        sourceId,
        pool,
        startsAt,
        expiresAt,
        JSON.stringify(productSnapshot),
      ],
    )
    await client.query(
      `INSERT INTO traffic_grants
       (id, entitlement_id, user_id, pool, quota_mode, granted_bytes, remaining_bytes, period_key, valid_from, expires_at, status, consumption_priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11)`,
      [
        grantId,
        entitlementId,
        userId,
        pool,
        quotaMode,
        bytes,
        quotaMode === 'limited' ? bytes : null,
        periodKey,
        startsAt,
        expiresAt,
        consumptionPriority,
      ],
    )
    await client.query(
      `INSERT INTO traffic_ledger
       (id, user_id, traffic_grant_id, entitlement_id, event_type, bytes, reference_type, reference_id, detail)
       VALUES ($1, $2, $3, $4, 'grant', $5, $6, $7, $8)`,
      [
        uuid(),
        userId,
        grantId,
        entitlementId,
        bytes,
        originType,
        originId,
        JSON.stringify({ pool, quota_mode: quotaMode, period_key: periodKey }),
      ],
    )
    return { entitlementId, grantId }
  })
}

export async function getTrafficWallets(client, userId, now = new Date()) {
  const result = await client.query(
    `SELECT
       pool,
       BOOL_OR(quota_mode = 'unlimited') AS unlimited,
       COALESCE(SUM(granted_bytes) FILTER (WHERE quota_mode = 'limited'), 0)::bigint AS limit_bytes,
       COALESCE(SUM(granted_bytes - remaining_bytes) FILTER (WHERE quota_mode = 'limited'), 0)::bigint AS used_bytes,
       COALESCE(SUM(remaining_bytes) FILTER (WHERE quota_mode = 'limited'), 0)::bigint AS remaining_bytes
     FROM traffic_grants
     WHERE user_id = $1
       AND status = 'active'
       AND valid_from <= $2
       AND (expires_at IS NULL OR expires_at > $2)
     GROUP BY pool`,
    [userId, now],
  )
  const wallets = {
    free: { unlimited: false, limit_bytes: 0, used_bytes: 0, remaining_bytes: 0, exhausted: false },
    paid: { unlimited: false, limit_bytes: 0, used_bytes: 0, remaining_bytes: 0, exhausted: false },
  }
  for (const row of result.rows) {
    const wallet = wallets[row.pool]
    wallet.unlimited = Boolean(row.unlimited)
    wallet.limit_bytes = Number(row.limit_bytes || 0)
    wallet.used_bytes = Number(row.used_bytes || 0)
    wallet.remaining_bytes = wallet.unlimited ? null : Number(row.remaining_bytes || 0)
    wallet.exhausted = !wallet.unlimited && wallet.limit_bytes > 0 && wallet.remaining_bytes <= 0
  }
  return wallets
}

export async function acceptUsageReport({
  userId,
  deviceId,
  clientReportId,
  sequenceNo,
  deltaBytes,
  reportedPool,
  subscriptionRevision = null,
  reportedSourceId = null,
  occurredAt = null,
}) {
  if (!deviceId) throw new Error('流量上报必须包含已注册设备')
  const pool = assertPool(reportedPool)
  const bytes = toBytes(deltaBytes)
  if (!clientReportId || !/^[0-9a-f-]{36}$/i.test(clientReportId)) {
    throw new Error('client_report_id 必须是 UUID')
  }
  const sequence = Number(sequenceNo)
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('sequence_no 无效')

  return withTransaction(async (client) => {
    const device = await client.query(
      `SELECT id FROM app_devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE`,
      [deviceId, userId],
    )
    if (!device.rowCount) throw new Error('设备不存在或已撤销')

    const existing = await client.query(
      `SELECT id, accepted_bytes, status FROM usage_reports
       WHERE user_id = $1 AND device_id = $2 AND client_report_id = $3`,
      [userId, deviceId, clientReportId],
    )
    if (existing.rowCount) {
      return {
        duplicate: true,
        reportId: existing.rows[0].id,
        acceptedBytes: Number(existing.rows[0].accepted_bytes || 0),
        status: existing.rows[0].status,
      }
    }

    const reportId = uuid()
    await client.query(
      `INSERT INTO usage_reports
       (id, user_id, device_id, client_report_id, sequence_no, subscription_revision, reported_pool, reported_source_id, delta_bytes, accepted_bytes, status, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'review', $10)`,
      [reportId, userId, deviceId, clientReportId, sequence, subscriptionRevision, pool, reportedSourceId, bytes, occurredAt],
    )

    const grants = await client.query(
      `SELECT id, entitlement_id, remaining_bytes
       FROM traffic_grants
       WHERE user_id = $1 AND pool = $2 AND quota_mode = 'limited' AND status = 'active'
         AND valid_from <= NOW() AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY expires_at NULLS LAST, consumption_priority ASC, created_at ASC
       FOR UPDATE`,
      [userId, pool],
    )
    const hasUnlimited = await client.query(
      `SELECT 1 FROM traffic_grants
       WHERE user_id = $1 AND pool = $2 AND quota_mode = 'unlimited' AND status = 'active'
         AND valid_from <= NOW() AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [userId, pool],
    )

    let remaining = bytes
    if (hasUnlimited.rowCount) {
      remaining = 0
      await client.query(
        `INSERT INTO traffic_ledger
         (id, user_id, event_type, bytes, reference_type, reference_id, detail)
         VALUES ($1, $2, 'consume', $3, 'usage_report', $4, $5)`,
        [uuid(), userId, -bytes, reportId, JSON.stringify({ pool, unlimited: true })],
      )
    } else {
      for (const grant of grants.rows) {
        if (!remaining) break
        const available = Math.max(0, Number(grant.remaining_bytes || 0))
        const consumed = Math.min(available, remaining)
        if (!consumed) continue
        await client.query(
          `UPDATE traffic_grants
           SET remaining_bytes = remaining_bytes - $1,
               status = CASE WHEN remaining_bytes - $1 <= 0 THEN 'exhausted' ELSE 'active' END
           WHERE id = $2`,
          [consumed, grant.id],
        )
        await client.query(
          `INSERT INTO traffic_consumptions (id, usage_report_id, traffic_grant_id, bytes)
           VALUES ($1, $2, $3, $4)`,
          [uuid(), reportId, grant.id, consumed],
        )
        await client.query(
          `INSERT INTO traffic_ledger
           (id, user_id, traffic_grant_id, entitlement_id, event_type, bytes, reference_type, reference_id, detail)
           VALUES ($1, $2, $3, $4, 'consume', $5, 'usage_report', $6, $7)`,
          [uuid(), userId, grant.id, grant.entitlement_id, -consumed, reportId, JSON.stringify({ pool })],
        )
        remaining -= consumed
      }
    }

    const acceptedBytes = bytes - remaining
    const status = remaining === 0 ? 'accepted' : acceptedBytes > 0 ? 'review' : 'rejected'
    await client.query(
      `UPDATE usage_reports SET accepted_bytes = $1, status = $2 WHERE id = $3`,
      [acceptedBytes, status, reportId],
    )
    return { duplicate: false, reportId, acceptedBytes, status, unacceptedBytes: remaining }
  })
}

export async function expireTrafficGrants(now = new Date()) {
  return withTransaction(async (client) => {
    const expired = await client.query(
      `UPDATE traffic_grants
       SET status = 'expired'
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1
       RETURNING id, entitlement_id, user_id, remaining_bytes`,
      [now],
    )
    for (const grant of expired.rows) {
      const remaining = Math.max(0, Number(grant.remaining_bytes || 0))
      await client.query(
        `INSERT INTO traffic_ledger
         (id, user_id, traffic_grant_id, entitlement_id, event_type, bytes, reference_type, reference_id, detail)
         VALUES ($1, $2, $3, $4, 'expire', $5, 'job', 'grant-expiry', '{}')`,
        [uuid(), grant.user_id, grant.id, grant.entitlement_id, -remaining],
      )
    }
    return expired.rowCount
  })
}
