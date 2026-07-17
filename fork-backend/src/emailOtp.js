/**
 * Email OTP (6-digit) for register / password-reset / delete-account.
 * Codes are stored hashed; plaintext only lives in the outbound email.
 */
import crypto from 'crypto'
import { sendMail, isMailConfigured } from './mail.js'
import { nowTs } from './db.js'

export const OTP_TTL_SECONDS = 10 * 60
export const OTP_RESEND_COOLDOWN = 60
export const OTP_MAX_ATTEMPTS = 5
const PURPOSES = new Set(['register', 'reset_password', 'delete_account'])

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function normalizePurpose(purpose) {
  const p = String(purpose || '').trim().toLowerCase()
  return PURPOSES.has(p) ? p : null
}

function hashCode(email, purpose, code) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeEmail(email)}|${purpose}|${String(code).trim()}`, 'utf8')
    .digest('hex')
}

function genCode() {
  // 6-digit, never leading-zero ambiguity in UI (allow 000000–999999)
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

function ensureList(data) {
  if (!Array.isArray(data.email_otps)) data.email_otps = []
}

/**
 * Issue a fresh OTP. Returns plaintext code for mailing (not persisted).
 * Rate: one active code per email+purpose; resend blocked within cooldown.
 */
export function issueEmailOtp(data, { email, purpose }) {
  const em = normalizeEmail(email)
  const pur = normalizePurpose(purpose)
  if (!em) return { ok: false, error: '请填写邮箱' }
  if (!pur) return { ok: false, error: '验证用途无效' }

  ensureList(data)
  const now = nowTs()
  // prune expired
  data.email_otps = data.email_otps.filter(
    (t) => Number(t.expires_at || 0) > now - 3600,
  )

  const existing = data.email_otps.find(
    (t) =>
      t.email === em &&
      t.purpose === pur &&
      !t.used_at &&
      Number(t.expires_at || 0) > now,
  )
  if (existing && Number(existing.created_at || 0) > now - OTP_RESEND_COOLDOWN) {
    const wait = OTP_RESEND_COOLDOWN - (now - Number(existing.created_at || 0))
    return { ok: false, error: `请 ${wait} 秒后再重新获取验证码`, retry_after: wait }
  }

  // invalidate previous for same email+purpose
  data.email_otps = data.email_otps.filter(
    (t) => !(t.email === em && t.purpose === pur && !t.used_at),
  )

  const code = genCode()
  data.email_otps.push({
    id: crypto.randomUUID(),
    email: em,
    purpose: pur,
    code_hash: hashCode(em, pur, code),
    created_at: now,
    expires_at: now + OTP_TTL_SECONDS,
    attempts: 0,
    used_at: null,
  })
  return { ok: true, code, email: em, purpose: pur, expires_in: OTP_TTL_SECONDS }
}

/**
 * Verify and consume OTP. On failure increments attempts.
 */
export function consumeEmailOtp(data, { email, purpose, code }) {
  const em = normalizeEmail(email)
  const pur = normalizePurpose(purpose)
  const raw = String(code || '').trim()
  if (!em || !pur) return { ok: false, error: '验证参数无效' }
  if (!/^\d{6}$/.test(raw)) return { ok: false, error: '请输入 6 位验证码' }

  ensureList(data)
  const now = nowTs()
  const rec = data.email_otps.find(
    (t) => t.email === em && t.purpose === pur && !t.used_at,
  )
  if (!rec) return { ok: false, error: '请先获取验证码' }
  if (Number(rec.expires_at || 0) <= now) {
    rec.used_at = now
    return { ok: false, error: '验证码已过期，请重新获取' }
  }
  if (Number(rec.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    rec.used_at = now
    return { ok: false, error: '验证码错误次数过多，请重新获取' }
  }

  const expect = hashCode(em, pur, raw)
  if (rec.code_hash !== expect) {
    rec.attempts = Number(rec.attempts || 0) + 1
    const left = OTP_MAX_ATTEMPTS - rec.attempts
    return {
      ok: false,
      error: left > 0 ? `验证码错误，还可尝试 ${left} 次` : '验证码错误次数过多，请重新获取',
    }
  }
  rec.used_at = now
  return { ok: true, email: em, purpose: pur }
}

export async function sendOtpMail({ email, purpose, code }) {
  if (!isMailConfigured()) throw new Error('SMTP 未配置，无法发送验证码')
  const title =
    purpose === 'register'
      ? 'Fork · 注册验证码'
      : purpose === 'delete_account'
        ? 'Fork · 注销账号验证码'
        : 'Fork · 找回密码验证码'
  const action =
    purpose === 'register'
      ? '完成注册'
      : purpose === 'delete_account'
        ? '注销账号'
        : '重置密码'
  const text = `您的验证码是：${code}\n\n用于${action}，${Math.floor(OTP_TTL_SECONDS / 60)} 分钟内有效。请勿泄露给他人。\n如非本人操作请忽略本邮件。`
  const html = `<p>您的验证码是：</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p><p>用于${action}，${Math.floor(OTP_TTL_SECONDS / 60)} 分钟内有效。请勿泄露给他人。</p><p style="color:#888">如非本人操作请忽略本邮件。</p>`
  await sendMail({ to: email, subject: title, text, html })
}
