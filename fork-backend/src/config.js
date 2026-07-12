/**
 * Environment and production safety gates.
 *
 * Production normally fails closed: HTTPS public URL, loopback binding,
 * explicit HTTPS CORS origins, a strong JWT secret, and an administrator are
 * required. `FORK_TEST_INSECURE_HTTP=1` is a temporary, conspicuous escape
 * hatch for the pre-domain test deployment only.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Load sibling .env without external dotenv dependency (PM2 may not inject env_file).
;(function loadDotEnv() {
  try {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const envPath = path.join(root, '.env')
    if (!fs.existsSync(envPath)) return
    const text = fs.readFileSync(envPath, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i <= 0) continue
      const k = s.slice(0, i).trim()
      let v = s.slice(i + 1).trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1)
      }
      if (process.env[k] === undefined) process.env[k] = v
    }
  } catch {
    // Environment loading must not hide the later validation error.
  }
})()

const WEAK_JWT = new Set([
  '',
  'fork-dev-secret-change-me',
  'change-me',
  'secret',
  'jwt-secret',
  'your-secret',
])

export function isProduction() {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.FORK_ENV === 'production' ||
    process.env.FORK_PRODUCTION === '1'
  )
}

export function isInsecureTestMode() {
  return process.env.FORK_TEST_INSECURE_HTTP === '1'
}

export function getJwtSecret() {
  return String(process.env.FORK_JWT_SECRET || '').trim()
}

export function getJwtExpires() {
  return String(process.env.FORK_JWT_EXPIRES || (isProduction() ? '2h' : '7d')).trim()
}

export function assertJwtSecretSafe(secret) {
  if (!secret || WEAK_JWT.has(secret)) {
    throw new Error('JWT secret is missing or uses a known weak placeholder')
  }
  if (secret.length < 32) {
    throw new Error('FORK_JWT_SECRET must be at least 32 characters')
  }
}

/** Dev-only fallback; every production entry point validates the configured secret. */
export function resolveJwtSecret() {
  const secret = getJwtSecret()
  if (!isProduction() && !secret) return 'fork-dev-secret-change-me'
  assertJwtSecretSafe(secret)
  return secret
}

export function getListenHost() {
  const configured = String(process.env.FORK_BIND || process.env.FORK_HOST || '').trim()
  if (configured) return configured
  return isProduction() ? '127.0.0.1' : '0.0.0.0'
}

export function getListenPort() {
  return Number(process.env.FORK_PORT || 8787)
}

export function getPublicUrl() {
  return String(process.env.FORK_PUBLIC_URL || process.env.PUBLIC_URL || '').trim().replace(/\/$/, '')
}

export function getCorsOrigins() {
  return String(process.env.FORK_CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function isSecureOrigin(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value.replace(/\/$/, '')
  } catch {
    return false
  }
}

function isSecurePublicUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && url.hostname !== 'localhost'
  } catch {
    return false
  }
}

/**
 * Call once before listening. Production fails closed except for the explicit,
 * temporary HTTP testing escape hatch documented above.
 */
export function validateProductionConfig({ adminCount = 0 } = {}) {
  const errors = []
  const warnings = []

  if (!isProduction()) {
    return { ok: true, errors, warnings, production: false, insecureTestMode: false }
  }

  const insecureTestMode = isInsecureTestMode()
  try {
    assertJwtSecretSafe(getJwtSecret())
  } catch (error) {
    errors.push(error.message)
  }

  const publicUrl = getPublicUrl()
  const host = getListenHost()
  const corsOrigins = getCorsOrigins()

  if (insecureTestMode) {
    warnings.push(
      'INSECURE TEST MODE is enabled: HTTP/public binding exceptions are temporary and Phase 0 remains incomplete.',
    )
  } else {
    if (!isSecurePublicUrl(publicUrl)) {
      errors.push('FORK_PUBLIC_URL must be an HTTPS domain in production')
    }
    if (!isLoopbackHost(host)) {
      errors.push('FORK_BIND must be a loopback address in production')
    }
    if (!corsOrigins.length) {
      errors.push('FORK_CORS_ORIGINS must explicitly list HTTPS browser origins in production')
    } else if (corsOrigins.some((origin) => origin === '*' || !isSecureOrigin(origin))) {
      errors.push('FORK_CORS_ORIGINS may only contain explicit HTTPS origins')
    }
    if (adminCount === 0) {
      errors.push('No administrator exists; bootstrap one before production startup')
    }
  }

  if (insecureTestMode) {
    if (!publicUrl) warnings.push('FORK_PUBLIC_URL is empty; payment callbacks are unavailable')
    if (!corsOrigins.length) warnings.push('CORS is disabled for browser origins until FORK_CORS_ORIGINS is configured')
    if (!isLoopbackHost(host)) warnings.push(`Listening on public host ${host} during temporary HTTP testing`)
    if (adminCount === 0) warnings.push('No administrator exists — run npm run bootstrap-admin')
  }

  const ezUrl = String(process.env.EZPAY_URL || '').trim()
  const ezPid = String(process.env.EZPAY_PID || '').trim()
  const ezKey = String(process.env.EZPAY_KEY || '').trim()
  if (!ezUrl || !ezPid || !ezKey) {
    warnings.push('易支付未完整配置（EZPAY_URL/PID/KEY）— 付费商品不可用')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    production: true,
    insecureTestMode,
  }
}
