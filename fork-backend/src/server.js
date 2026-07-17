import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { api, expirePendingOrdersNow } from './routes.js'
import { getEzpayConfig } from './ezpay.js'
import {
  getCorsOrigins,
  getListenHost,
  getListenPort,
  isProduction,
  validateProductionConfig,
} from './config.js'
import { db, loadOnce, syncJsonToPgOnce, flushNow, isPgEnabled } from './db.js'
import { startBackupScheduler } from './backup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, '..', 'public')
const adminDir = path.join(publicDir, 'forkvpnadmin')
const PORT = getListenPort()
const HOST = getListenHost()

// Auto seed on boot; it never creates a default administrator password.
await import('./seed.js')

// Switch the data layer to PostgreSQL: first cutover the live JSON into PG so no writes are
// lost, then load the in-process cache from PG. After this, db.read()/db.write() serve from
// the PG-backed cache while keeping fork.json as a synchronous recoverable backup.
if (isPgEnabled()) {
  await syncJsonToPgOnce()
  await loadOnce()
  console.log('[boot] PostgreSQL is authoritative (JSON kept as sync backup)')
} else {
  await loadOnce()
}

// Flush queued PG writes on graceful shutdown so no committed cache write is lost.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await flushNow() } catch {}
    process.exit(0)
  })
}

const adminCount = (db.read().admins || []).length
const check = validateProductionConfig({ adminCount })
for (const warning of check.warnings) {
  console.warn(`[config] WARN: ${warning}`)
}
if (!check.ok) {
  console.error('[config] FATAL production config errors:')
  for (const error of check.errors) console.error(' -', error)
  process.exit(1)
}

const app = express()
if (isProduction()) app.set('trust proxy', 1)
app.disable('x-powered-by')

const corsOrigins = getCorsOrigins()
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true)
      if (corsOrigins.includes(origin)) return callback(null, true)
      return callback(null, false)
    },
  }),
)

app.use(express.urlencoded({ extended: false }))
app.use(express.json({ limit: '2mb' }))

app.use((req, res, next) => {
  req.request_id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  res.setHeader('X-Request-Id', req.request_id)
  next()
})

app.use('/api/v1', api)

// Admin console (moved off site root)
app.use(
  '/forkvpnadmin',
  express.static(adminDir, { index: 'index.html', fallthrough: true }),
)
app.get(['/forkvpnadmin', '/forkvpnadmin/'], (_req, res) => {
  res.sendFile(path.join(adminDir, 'index.html'))
})

// Pay return + other root static assets (not the old admin index)
app.get('/pay-return.html', (_req, res) => {
  res.sendFile(path.join(publicDir, 'pay-return.html'))
})

// Marketing landing site at /
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'))
})
app.use(express.static(publicDir, { index: false }))

const backupScheduler = startBackupScheduler()
const orderExpiryScheduler = setInterval(() => {
  try {
    const expired = expirePendingOrdersNow()
    if (expired) console.log(`[orders] expired ${expired} pending order(s)`)
  } catch (error) {
    console.error('[orders] pending-order expiry failed:', error.message || error)
  }
}, 60_000)
orderExpiryScheduler.unref?.()

app.listen(PORT, HOST, () => {
  const scheme = check.insecureTestMode ? 'http' : 'https (via reverse proxy)'
  console.log(`Fork backend listening on ${HOST}:${PORT} (${scheme})`)
  console.log(`Landing: /   Admin: /forkvpnadmin/   API: /api/v1`)
  console.log(`Mode: ${isProduction() ? 'production' : 'development'}`)
  console.log(`Automatic backups: ${backupScheduler ? 'enabled' : 'disabled'}`)
  const ez = getEzpayConfig()
  console.log(
    `易支付: ${ez.enabled ? `已启用 ${ez.base} pid=${ez.pid}` : '未配置（设 EZPAY_URL/PID/KEY）'}`,
  )
  if (adminCount === 0) {
    console.warn(
      '[boot] No admin — run: npm run bootstrap-admin -- -u admin -p <strong-password>',
    )
  }
})
