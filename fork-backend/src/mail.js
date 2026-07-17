import nodemailer from 'nodemailer'

let cachedTransport = null

export function getMailConfig() {
  return {
    host: String(process.env.SMTP_HOST || '').trim(),
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() !== 'false',
    user: String(process.env.SMTP_USER || '').trim(),
    pass: String(process.env.SMTP_PASS || '').trim(),
    from: String(process.env.FORK_MAIL_FROM || '').trim(),
  }
}

export function isMailConfigured() {
  const cfg = getMailConfig()
  return Boolean(cfg.host && (cfg.user || cfg.pass) && cfg.from)
}

function getTransport() {
  if (cachedTransport) return cachedTransport
  const cfg = getMailConfig()
  if (!isMailConfigured()) throw new Error('SMTP 未配置')
  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  })
  return cachedTransport
}

export function resetMailTransport() {
  if (cachedTransport) {
    cachedTransport.close?.()
    cachedTransport = null
  }
}

export async function sendMail({ to, subject, text, html }) {
  if (!isMailConfigured()) throw new Error('SMTP 未配置')
  const cfg = getMailConfig()
  const transport = getTransport()
  return transport.sendMail({ from: cfg.from, to, subject, text, html })
}
