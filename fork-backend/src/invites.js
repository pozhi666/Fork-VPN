import { nanoid } from 'nanoid'
import { nowTs } from './db.js'

export function ensureInvites(data) {
  if (!Array.isArray(data.invite_codes)) data.invite_codes = []
  if (!Array.isArray(data.invite_redemptions)) data.invite_redemptions = []
}

export function normalizeInvite(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}

/** Ensure user has a personal invite code */
export function ensureUserInviteCode(user) {
  if (user.invite_code) return user.invite_code
  user.invite_code = nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
  return user.invite_code
}

export function getInviteRewardDays(settings) {
  const n = Number(settings?.invite_reward_days)
  if (!Number.isFinite(n) || n < 0) return 3
  return Math.min(365, Math.floor(n))
}

/**
 * Apply invite on register: bind invited_by, reward inviter account expire extension.
 * Note: reward is trial-style days on inviter.expire_at (display) + optional free product later.
 */
export function applyInviteOnRegister(data, newUser, inviteCodeRaw) {
  ensureInvites(data)
  const code = normalizeInvite(inviteCodeRaw)
  if (!code) return null

  // personal codes on users
  const inviter = data.users.find(
    (u) => String(u.invite_code || '').toUpperCase() === code && u.id !== newUser.id,
  )
  if (!inviter) {
    // also allow admin-created codes
    const row = data.invite_codes.find(
      (c) => c.code === code && c.status !== 'disabled',
    )
    if (!row) throw new Error('邀请码无效')
    if (row.max_uses > 0 && (row.used_count || 0) >= row.max_uses) {
      throw new Error('邀请码已达使用上限')
    }
    row.used_count = (row.used_count || 0) + 1
    row.updated_at = nowTs()
    newUser.invited_by = row.owner_user_id || 'code:' + row.code
    data.invite_redemptions.push({
      id: nanoid(),
      code,
      invitee_id: newUser.id,
      inviter_id: row.owner_user_id || null,
      created_at: nowTs(),
    })
    return { type: 'admin_code', code }
  }

  ensureUserInviteCode(inviter)
  newUser.invited_by = inviter.id
  const days = getInviteRewardDays(data.settings)
  const now = nowTs()
  if (days > 0) {
    const base = inviter.expire_at && inviter.expire_at > now ? inviter.expire_at : now
    inviter.expire_at = base + days * 86400
    inviter.invite_reward_count = (inviter.invite_reward_count || 0) + 1
    inviter.updated_at = now
  }
  data.invite_redemptions.push({
    id: nanoid(),
    code: inviter.invite_code,
    invitee_id: newUser.id,
    inviter_id: inviter.id,
    reward_days: days,
    created_at: now,
  })
  return { type: 'user', code: inviter.invite_code, inviter_id: inviter.id, reward_days: days }
}
