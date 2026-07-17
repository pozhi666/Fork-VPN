import { nanoid } from 'nanoid'
import { nowTs } from './db.js'

export function ensureAudit(data) {
  if (!Array.isArray(data.audit_logs)) data.audit_logs = []
}

/** Keep last N audit rows */
export function appendAudit(data, entry) {
  ensureAudit(data)
  data.audit_logs.unshift({
    id: nanoid(12),
    at: nowTs(),
    actor: entry.actor || 'system',
    actor_type: entry.actor_type || 'system', // admin|user|system
    action: entry.action || 'unknown',
    target: entry.target || '',
    detail: entry.detail || {},
    ip: entry.ip || '',
  })
  if (data.audit_logs.length > 2000) data.audit_logs.length = 2000
}

export function listAudit(data, { limit = 100, action } = {}) {
  ensureAudit(data)
  let rows = data.audit_logs
  if (action) rows = rows.filter((r) => r.action === action)
  return rows.slice(0, Math.min(500, Math.max(1, limit)))
}
