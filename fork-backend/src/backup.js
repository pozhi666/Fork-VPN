import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { db, nowTs } from './db.js'

const dataDir = path.dirname(db.path)
const backupDir = path.join(dataDir, 'backups')
const BACKUP_SCHEMA_VERSION = 1

export function ensureBackupDir() {
  fs.mkdirSync(backupDir, { recursive: true })
  return backupDir
}

function backupPath(name) {
  const safe = path.basename(String(name || ''))
  if (!safe.endsWith('.json') || safe !== name) throw new Error('非法备份名')
  return path.join(backupDir, safe)
}

function metadataPath(name) {
  return `${backupPath(name)}.meta.json`
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let bytesRead = 0
    let position = 0
    do {
      bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position)
      if (bytesRead) hash.update(chunk.subarray(0, bytesRead))
      position += bytesRead
    } while (bytesRead)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function readMetadata(name) {
  const metaPath = metadataPath(name)
  if (!fs.existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    return meta && typeof meta === 'object' ? meta : null
  } catch {
    throw new Error('备份元数据损坏')
  }
}

function validateBackup(name) {
  const source = backupPath(name)
  if (!fs.existsSync(source)) throw new Error('备份不存在')
  const raw = fs.readFileSync(source, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('备份不是有效 JSON')
  }
  db.validate(parsed)

  const metadata = readMetadata(name)
  if (metadata?.sha256 && metadata.sha256 !== sha256File(source)) {
    throw new Error('备份校验和不匹配')
  }
  return { source, parsed, metadata }
}

export function listBackups() {
  ensureBackupDir()
  return fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))
    .map((name) => {
      const p = backupPath(name)
      const st = fs.statSync(p)
      const metadata = readMetadata(name)
      return {
        name,
        bytes: st.size,
        mtime: Math.floor(st.mtimeMs / 1000),
        verified: Boolean(metadata?.sha256),
        sha256: metadata?.sha256 || null,
        schema_version: metadata?.schema_version || null,
        source: metadata?.source || 'legacy',
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

function trimBackups() {
  const all = listBackups()
  for (const old of all.slice(30)) {
    try {
      fs.unlinkSync(backupPath(old.name))
      const meta = metadataPath(old.name)
      if (fs.existsSync(meta)) fs.unlinkSync(meta)
    } catch {
      // A retention failure must not invalidate the newly-created backup.
    }
  }
}

export function createBackup(dbPath = db.path, note = '') {
  ensureBackupDir()
  if (!fs.existsSync(dbPath)) throw new Error('数据库文件不存在')

  const raw = fs.readFileSync(dbPath, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('拒绝备份损坏的数据库文件')
  }
  db.validate(parsed)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safeNote = String(note || '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30)
  const name = `fork-${stamp}${safeNote ? `-${safeNote}` : ''}.json`
  const dest = backupPath(name)
  fs.copyFileSync(dbPath, dest, fs.constants.COPYFILE_EXCL)
  const metadata = {
    backup_schema_version: BACKUP_SCHEMA_VERSION,
    schema_version: Number(parsed.schema_version || db.schemaVersion),
    source: path.resolve(dbPath) === path.resolve(db.path) ? 'fork-json' : 'external',
    bytes: fs.statSync(dest).size,
    sha256: sha256File(dest),
    created_at: nowTs(),
  }
  fs.writeFileSync(metadataPath(name), JSON.stringify(metadata, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
  trimBackups()
  return { name, path: dest, at: metadata.created_at, ...metadata }
}

export function getBackupPath(name) {
  const { source } = validateBackup(name)
  return source
}

export function restoreBackup(_dbPath = db.path, name) {
  const { parsed } = validateBackup(name)
  // db.replace performs a pre-write snapshot and an atomic validated write.
  db.replace(parsed)
  return { ok: true, restored: name }
}

export function startBackupScheduler({ intervalHours = Number(process.env.FORK_BACKUP_INTERVAL_HOURS || 24) } = {}) {
  const hours = Number(intervalHours)
  if (!Number.isFinite(hours) || hours <= 0) return null
  const intervalMs = Math.max(1, hours) * 60 * 60 * 1000
  return setInterval(() => {
    try {
      createBackup(db.path, 'scheduled')
    } catch (error) {
      console.error('[backup] scheduled backup failed:', error.message || error)
    }
  }, intervalMs)
}
