import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(process.env.FORK_DATA_DIR || path.join(__dirname, '..', 'data'))
fs.mkdirSync(dataDir, { recursive: true })
const dbPath = path.join(dataDir, 'fork.json')
const snapshotDir = path.join(dataDir, 'snapshots')
const SCHEMA_VERSION = 1

// ── shared single-process state (survives module-instance splits, e.g. tests importing
// db.js with a cache-busting query string while routes.js imports the plain module) ──
const G = globalThis
const SYM_CACHE = Symbol.for('fork.db.cache')
const SYM_POOL = Symbol.for('fork.db.pgPool')
const SYM_CHAIN = Symbol.for('fork.db.writeChain')
const SYM_SYNCED = Symbol.for('fork.db.oneTimeSynced')
const SYM_VER = Symbol.for('fork.db.pgVersion')
if (!G[SYM_CHAIN]) G[SYM_CHAIN] = Promise.resolve()
const getCache = () => G[SYM_CACHE]
const setCache = (v) => { G[SYM_CACHE] = v }
const getChain = () => G[SYM_CHAIN]
const setChain = (p) => { G[SYM_CHAIN] = p }

function pgUrl() {
  return String(process.env.DATABASE_URL || process.env.FORK_DATABASE_URL || '').trim()
}
export function isPgEnabled() {
  return Boolean(pgUrl())
}
async function getPool() {
  if (G[SYM_POOL]) return G[SYM_POOL]
  const pg = await import('pg')
  const pool = new pg.default.Pool({
    connectionString: pgUrl(),
    max: Math.max(1, Number(process.env.FORK_DB_POOL_MAX || 10)),
  })
  G[SYM_POOL] = pool
  return pool
}
async function ensurePgStateTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS fork_state (
       key TEXT PRIMARY KEY,
       data JSONB NOT NULL,
       version BIGINT NOT NULL DEFAULT 0,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  )
}

export class DatabaseCorruptionError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause })
    this.name = 'DatabaseCorruptionError'
  }
}

function emptyDb() {
  return {
    schema_version: SCHEMA_VERSION,
    admins: [],
    plans: [],
    subscription_sources: [],
    users: [],
    announcements: [],
    orders: [],
    tickets: [],
    coupons: [],
    invite_codes: [],
    invite_redemptions: [],
    audit_logs: [],
    settings: {
      max_devices: 3,
      invite_reward_days: 3,
      allow_paid_unlimited_traffic: '0',
      product_name: 'Fork',
      allow_register: '1',
      support_tg: 'https://t.me/forkdl',
    },
  }
}

function validateDb(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new DatabaseCorruptionError('数据库根节点不是对象')
  }
  for (const key of [
    'admins', 'plans', 'subscription_sources', 'users', 'announcements',
    'orders', 'tickets', 'coupons', 'invite_codes', 'invite_redemptions', 'audit_logs',
  ]) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      throw new DatabaseCorruptionError(`数据库字段 ${key} 必须是数组`)
    }
  }
  if (data.settings !== undefined && (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))) {
    throw new DatabaseCorruptionError('数据库字段 settings 必须是对象')
  }
  return data
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.fsyncSync(fd)
  } catch (error) {
    if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error
  } finally {
    fs.closeSync(fd)
  }
}

function snapshotRetention() {
  const c = Number(process.env.FORK_DB_SNAPSHOT_KEEP || 12)
  return Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 12
}
function snapshotIntervalSeconds() {
  const c = Number(process.env.FORK_DB_SNAPSHOT_INTERVAL_SECONDS || 300)
  return Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 300
}
function trimSnapshots() {
  const keep = snapshotRetention()
  if (keep <= 0 || !fs.existsSync(snapshotDir)) return
  const snaps = fs.readdirSync(snapshotDir).filter((n) => n.endsWith('.json'))
    .map((name) => ({ name, stat: fs.statSync(path.join(snapshotDir, name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  for (const old of snaps.slice(keep)) fs.unlinkSync(path.join(snapshotDir, old.name))
}
function maybeSnapshotCurrent() {
  const keep = snapshotRetention()
  if (keep <= 0 || !fs.existsSync(dbPath)) return
  const intervalMs = snapshotIntervalSeconds() * 1000
  const latest = fs.existsSync(snapshotDir)
    ? fs.readdirSync(snapshotDir).filter((n) => n.endsWith('.json')).map((n) => fs.statSync(path.join(snapshotDir, n)).mtimeMs).sort((a, b) => b - a)[0]
    : undefined
  if (latest && intervalMs > 0 && Date.now() - latest < intervalMs) return
  fs.mkdirSync(snapshotDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const target = path.join(snapshotDir, `fork-prewrite-${stamp}.json`)
  fs.copyFileSync(dbPath, target, fs.constants.COPYFILE_EXCL)
  fsyncFile(target)
  trimSnapshots()
}

function atomicWrite(data) {
  const raw = JSON.stringify(data, null, 2)
  const tempPath = path.join(dataDir, `.fork.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(tempPath, raw, { encoding: 'utf8', mode: 0o600 })
    fsyncFile(tempPath)
    validateDb(JSON.parse(fs.readFileSync(tempPath, 'utf8')))
    fs.renameSync(tempPath, dbPath)
  } catch (error) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath) } catch {}
    throw error
  }
}

function loadFromFile() {
  if (!fs.existsSync(dbPath)) {
    const data = emptyDb()
    atomicWrite(data)
    return data
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8'))
  } catch (cause) {
    throw new DatabaseCorruptionError(
      `无法解析数据库文件 ${dbPath}；原文件已保留，拒绝自动覆盖。请从备份恢复。`,
      { cause },
    )
  }
  validateDb(parsed)
  return {
    ...emptyDb(),
    ...parsed,
    settings: { ...emptyDb().settings, ...(parsed.settings || {}) },
    schema_version: Number(parsed.schema_version || SCHEMA_VERSION),
  }
}

function save(data) {
  validateDb(data)
  data.schema_version = SCHEMA_VERSION
  maybeSnapshotCurrent()
  atomicWrite(data)
}

// ── PG read/write against the JSONB document row ─────────────────────────────
async function pgLoadLatest() {
  const pool = await getPool()
  const client = await pool.connect()
  try {
    await ensurePgStateTable(client)
    const res = await client.query("SELECT data, version FROM fork_state WHERE key='fork'")
    if (!res.rowCount) {
      const fileData = loadFromFile()
      validateDb(fileData)
      await client.query(
        "INSERT INTO fork_state (key, data, version) VALUES ('fork', $1::jsonb, 0)",
        [JSON.stringify(fileData)],
      )
      return { data: fileData, version: 0 }
    }
    return { data: res.rows[0].data, version: Number(res.rows[0].version) }
  } finally {
    client.release()
  }
}

async function pgFlushDoc(doc, expectedVersion) {
  const pool = await getPool()
  const client = await pool.connect()
  try {
    await ensurePgStateTable(client)
    await client.query('BEGIN')
    const res = await client.query("SELECT version FROM fork_state WHERE key='fork' FOR UPDATE")
    validateDb(doc)
    if (!res.rowCount) {
      await client.query(
        "INSERT INTO fork_state (key, data, version) VALUES ('fork', $1::jsonb, 1)",
        [JSON.stringify(doc)],
      )
    } else {
      await client.query(
        "UPDATE fork_state SET data = $1::jsonb, version = version + 1, updated_at = NOW() WHERE key = 'fork'",
        [JSON.stringify(doc)],
      )
    }
    await client.query('COMMIT')
    const v = await client.query("SELECT version FROM fork_state WHERE key='fork'")
    return Number(v.rows[0].version)
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

function enqueueFlush() {
  setChain(getChain().then(async () => {
    try {
      const doc = getCache()
      const newVer = await pgFlushDoc(doc, G[SYM_VER] || 0)
      G[SYM_VER] = newVer
    } catch (e) {
      console.error('[db] PG flush failed:', e.message || e)
    }
  }))
}

/** Boot: load the authoritative doc into the shared cache. */
export async function loadOnce() {
  if (getCache()) return getCache()
  if (!isPgEnabled()) {
    setCache(loadFromFile())
    return getCache()
  }
  const got = await pgLoadLatest()
  setCache({
    ...emptyDb(),
    ...got.data,
    settings: { ...emptyDb().settings, ...(got.data.settings || {}) },
    schema_version: Number(got.data.schema_version || SCHEMA_VERSION),
  })
  validateDb(getCache())
  G[SYM_VER] = got.version
  try { save(getCache()) } catch (e) { console.error('[db] initial file sync failed:', e.message) }
  return getCache()
}

/**
 * Boot seed: only push fork.json → PG when the PG row is missing.
 * NEVER overwrite an existing PG document on every restart (that wiped live
 * repairs / concurrent writes). Force with FORK_FORCE_JSON_TO_PG=1 if needed.
 */
export async function syncJsonToPgOnce() {
  if (!isPgEnabled() || G[SYM_SYNCED]) return
  G[SYM_SYNCED] = true
  const force = process.env.FORK_FORCE_JSON_TO_PG === '1'
  const pool = await getPool()
  const client = await pool.connect()
  try {
    await ensurePgStateTable(client)
    const existing = await client.query("SELECT version FROM fork_state WHERE key='fork'")
    if (existing.rowCount && !force) {
      console.log(
        `[db] PG already has fork_state (version=${existing.rows[0].version}); skip JSON→PG overwrite`,
      )
      return
    }
    const fileData = loadFromFile()
    validateDb(fileData)
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO fork_state (key, data, version) VALUES ('fork', $1::jsonb, 0)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, version = fork_state.version + 1, updated_at = NOW()`,
      [JSON.stringify(fileData)],
    )
    await client.query('COMMIT')
    console.log(
      force
        ? '[db] FORCED JSON→PG sync complete (FORK_FORCE_JSON_TO_PG=1)'
        : '[db] seeded empty PG from fork.json (PG now authoritative)',
    )
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

export async function flushNow() {
  if (!isPgEnabled() || !getCache()) return
  await getChain()
}

export const db = {
  read() {
    if (getCache()) return getCache()
    setCache(loadFromFile())
    return getCache()
  },
  write(mutator) {
    if (!getCache()) setCache(loadFromFile())
    const doc = getCache()
    const result = mutator(doc)
    validateDb(doc)
    doc.schema_version = SCHEMA_VERSION
    save(doc) // synchronous recoverable backup
    if (isPgEnabled()) enqueueFlush()
    return result
  },
  replace(data) {
    validateDb(data)
    const doc = {
      ...emptyDb(),
      ...data,
      settings: { ...emptyDb().settings, ...(data.settings || {}) },
      schema_version: SCHEMA_VERSION,
    }
    setCache(doc)
    save(doc)
    if (isPgEnabled()) enqueueFlush()
  },
  validate(data) {
    return validateDb(data)
  },
  isPgEnabled,
  snapshotDir,
  path: dbPath,
  schemaVersion: SCHEMA_VERSION,
}

export function nowTs() {
  return Math.floor(Date.now() / 1000)
}
