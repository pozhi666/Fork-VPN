/**
 * Create or reset an admin account (no default password in seed).
 *
 * Usage:
 *   # development
 *   node scripts/bootstrap-admin.mjs --username admin --password 'YourStrongPass!'
 *
 *   # production (required)
 *   BOOTSTRAP_TOKEN=... node scripts/bootstrap-admin.mjs --username admin --password '...' --token $BOOTSTRAP_TOKEN
 *
 * Env:
 *   BOOTSTRAP_TOKEN — must match FORK_BOOTSTRAP_TOKEN when NODE_ENV=production
 */
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { randomBytes } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

// Node ESM needs file: URLs for absolute Windows paths such as D:\\clash\\... .
const projectModule = (relativePath) => pathToFileURL(path.join(root, relativePath)).href
const { db, nowTs } = await import(projectModule('src/db.js'))
const { hashPassword } = await import(projectModule('src/auth.js'))
const { isProduction } = await import(projectModule('src/config.js'))
const { nanoid } = await import('nanoid')

function parseArgs(argv) {
  const out = { username: 'admin', password: '', token: '' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--username' || a === '-u') out.username = argv[++i] || ''
    else if (a === '--password' || a === '-p') out.password = argv[++i] || ''
    else if (a === '--token' || a === '-t') out.token = argv[++i] || ''
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function passwordStrong(pw) {
  if (pw.length < 10) return 'password must be at least 10 characters'
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return 'password must include letters and numbers'
  }
  const weak = ['admin123', 'password', '12345678', 'qwerty123']
  if (weak.includes(pw.toLowerCase())) return 'password is too common'
  return null
}

const args = parseArgs(process.argv)
if (args.help) {
  console.log(`Usage: node scripts/bootstrap-admin.mjs -u admin -p 'StrongPass1!' [-t TOKEN]`)
  process.exit(0)
}

if (!args.password) {
  console.error('Missing --password')
  process.exit(1)
}
const weak = passwordStrong(args.password)
if (weak) {
  console.error(weak)
  process.exit(1)
}

if (isProduction()) {
  const expected = String(process.env.FORK_BOOTSTRAP_TOKEN || '').trim()
  const provided = String(args.token || process.env.BOOTSTRAP_TOKEN || '').trim()
  if (!expected) {
    console.error(
      'Production requires FORK_BOOTSTRAP_TOKEN in env. Generate one, set it, then pass --token.',
    )
    console.error('Example token:', randomBytes(24).toString('hex'))
    process.exit(1)
  }
  if (!provided || provided !== expected) {
    console.error('Invalid or missing bootstrap token')
    process.exit(1)
  }
}

const username = String(args.username || 'admin').trim()
if (username.length < 3) {
  console.error('username too short')
  process.exit(1)
}

const result = db.write((data) => {
  if (!Array.isArray(data.admins)) data.admins = []
  const existing = data.admins.find((a) => a.username === username)
  const hash = hashPassword(args.password)
  const now = nowTs()
  if (existing) {
    existing.password_hash = hash
    existing.updated_at = now
    return { action: 'updated', id: existing.id, username }
  }
  const row = {
    id: nanoid(),
    username,
    password_hash: hash,
    created_at: now,
    updated_at: now,
  }
  data.admins.push(row)
  return { action: 'created', id: row.id, username }
})

console.log(`admin ${result.action}: ${result.username} (id=${result.id})`)
console.log('Password was not printed. Store it securely.')
if (isProduction()) {
  console.log(
    'Tip: remove or rotate FORK_BOOTSTRAP_TOKEN after use so this script cannot be re-run easily.',
  )
}
