import crypto from 'crypto'
import { sendMail } from './mail.js'
import { nowTs } from './db.js'

const TOKEN_TTL_SECONDS = 30 * 60

function randomToken() {
  return crypto.randomBytes(32).toString('hex')
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

function resetBase() {
  return String(process.env.FORK_PUBLIC_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '')
}

function findUserByEmail(data, email) {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null
  return (data.users || []).find((u) => String(u.email || '').toLowerCase() === normalized) || null
}

/**
 * Synchronously (within a db.write) issue a reset token and persist only its hash.
 * Returns the plaintext token only here so the caller can email it without storing it.
 */
export function issuePasswordReset(data, email) {
  const user = findUserByEmail(data, email)
  if (!user) return { ok: false }
  if (user.status && user.status !== 'active') return { ok: false }

  const token = randomToken()
  if (!Array.isArray(data.email_tokens)) data.email_tokens = []
  // Invalidate earlier reset tokens for this user.
  data.email_tokens = data.email_tokens.filter(
    (t) => !(t.user_id === user.id && t.purpose === 'reset_password'),
  )
  data.email_tokens.push({
    id: crypto.randomUUID(),
    user_id: user.id,
    purpose: 'reset_password',
    token_hash: tokenHash(token),
    email: user.email,
    created_at: nowTs(),
    expires_at: nowTs() + TOKEN_TTL_SECONDS,
    used_at: null,
  })
  return { ok: true, user, token }
}

export async function requestPasswordResetEmail(data, email) {
  const issued = issuePasswordReset(data, email)
  if (!issued.ok) return { ok: false, sent: false }
  const link = `${resetBase()}/reset-password?token=${encodeURIComponent(issued.token)}`
  try {
    await sendMail({
      to: issued.user.email,
      subject: 'Fork · 密码重置',
      text: `您正在重置 Fork 账号密码。请在 30 分钟内打开以下链接完成重置：\n\n${link}\n\n如非本人操作请忽略此邮件并尽快修改密码。`,
      html: `<p>您正在重置 Fork 账号密码。请在 30 分钟内点击下方链接完成重置：</p><p><a href="${link}">${link}</a></p><p>如非本人操作请忽略此邮件并尽快修改密码。</p>`,
    })
  } catch (error) {
    return { ok: true, sent: false, error: error.message || String(error) }
  }
  return { ok: true, sent: true }
}

export function consumePasswordResetToken(data, token) {
  if (!Array.isArray(data.email_tokens)) return { ok: false, error: '令牌无效' }
  const hash = tokenHash(String(token || ''))
  const record = data.email_tokens.find(
    (t) => t.token_hash === hash && t.purpose === 'reset_password' && !t.used_at,
  )
  if (!record) return { ok: false, error: '令牌无效或已使用' }
  if (Number(record.expires_at || 0) <= nowTs()) return { ok: false, error: '令牌已过期' }
  record.used_at = nowTs()
  const user = (data.users || []).find((u) => u.id === record.user_id)
  if (!user) return { ok: false, error: '账号不存在' }
  return { ok: true, user }
}
