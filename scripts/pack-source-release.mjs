/**
 * Pack a desensitized source release of Fork (client + backend).
 * Does NOT mutate the live working tree — copies to a staging dir, redacts, zips.
 *
 * Usage: node scripts/pack-source-release.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const OUT_DIR = path.join(ROOT, 'releases')
const STAGE = path.join(OUT_DIR, `_stage-fork-source-${STAMP}`)
const ZIP_NAME = `fork-source-desensitized-${STAMP}.zip`
const ZIP_PATH = path.join(OUT_DIR, ZIP_NAME)

// ---------- exclude rules (path segments relative to ROOT, posix-ish) ----------
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  'target',
  'dist',
  '.git',
  '.pnpm-store',
  '__pycache__',
  '.turbo',
  'releases', // avoid nesting previous packs
])

const EXCLUDE_PATH_PREFIXES = [
  'fork-backend/data',
  'Fork-VPN/src-tauri/sidecar',
  'Fork-VPN/src-tauri/target',
  'Fork-VPN/src-tauri/gen',
]

const EXCLUDE_FILE_NAMES = new Set([
  '.env',
  '.DS_Store',
  'Thumbs.db',
  'fork-vite.log',
  'fork-backend-deploy.tgz',
  'PHASE0_PROGRESS.md', // ops notes with production hostnames / recovery steps
  'start-fork.ps1', // local convenience only
  'start-fork.bat',
])

const EXCLUDE_FILE_GLOBS = [
  // one-off ops / deploy scripts (may embed host IPs)
  /^fork-backend\/scripts\/_/,
  /^fork-backend\/scripts\/deploy-/,
  /^fork-backend\/scripts\/ops-/,
  /^fork-backend\/scripts\/ensure-jwt/,
  /^fork-backend\/scripts\/fix-user-purchases/,
  /^fork-backend\/scripts\/run-fix-purchases/,
  // large / redistributable binaries (prebuild fetches)
  /^Fork-VPN\/src-tauri\/resources\/.*\.(exe|dat|mmdb)$/i,
  /^Fork-VPN\/src-tauri\/sidecar\//,
  // logs / archives
  /\.log$/i,
  /\.tgz$/i,
  /\.zip$/i,
  // local cargo/node caches that may appear
  /^Fork-VPN\/\.cargo\//,
]

// Paths to keep docs but scrub
const OPS_DOC_PATHS = new Set(['docs/OPS_DONE.md'])

// Text files eligible for redaction
const TEXT_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.rs',
  '.json',
  '.md',
  '.txt',
  '.html',
  '.css',
  '.scss',
  '.yml',
  '.yaml',
  '.toml',
  '.ps1',
  '.bat',
  '.cmd',
  '.sh',
  '.env',
  '.example',
  '.svg',
  '.nsi',
  '.plist',
  '.desktop',
])

const REDACTIONS = [
  // production domain → placeholder
  [/forkvpn\.i58\.xyz/gi, 'your-domain.example'],
  [/https:\/\/your-domain\.example/g, 'https://your-domain.example'],
  // production server IP / SSH helpers
  [/64\.90\.19\.128/g, 'YOUR_SERVER_IP'],
  // common accidental secret env dumps (defensive)
  [/(FORK_JWT_SECRET\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2CHANGE_ME_JWT_SECRET_AT_LEAST_32_CHARS'],
  [/(EZPAY_KEY\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2CHANGE_ME'],
  [/(EZPAY_PID\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2CHANGE_ME'],
  [/(SSH_PASS\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2'],
  [/(SSH_MCP_PASSWORD\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2'],
  // real-looking sub provider host from local data (if any leaked into docs)
  [/https?:\/\/103\.14\.76\.98\/[^\s"'<>]+/gi, ''],
]

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function shouldExclude(relPosix) {
  const base = path.posix.basename(relPosix)
  if (EXCLUDE_FILE_NAMES.has(base)) return true
  if (base === '.env' || base.startsWith('.env.')) {
    if (base.endsWith('.example')) return false
    return true
  }
  const parts = relPosix.split('/')
  for (const part of parts) {
    if (EXCLUDE_DIR_NAMES.has(part)) return true
  }
  for (const pref of EXCLUDE_PATH_PREFIXES) {
    if (relPosix === pref || relPosix.startsWith(pref + '/')) return true
  }
  for (const re of EXCLUDE_FILE_GLOBS) {
    if (re.test(relPosix)) return true
  }
  return false
}

function walk(dir, baseRel, files) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const rel = baseRel ? `${baseRel}/${ent.name}` : ent.name
    const relPosix = toPosix(rel)
    if (shouldExclude(relPosix)) continue
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      walk(abs, relPosix, files)
    } else if (ent.isFile()) {
      files.push({ abs, rel: relPosix })
    }
  }
}

function redactText(text, rel) {
  let out = text
  for (const [re, rep] of REDACTIONS) {
    out = out.replace(re, rep)
  }
  // OPS_DONE: replace with short public placeholder rather than production runbook
  if (OPS_DOC_PATHS.has(rel)) {
    out = `# Ops notes (redacted)

This file was removed from the public source pack.

Production deploy steps: set env vars on the server, reverse-proxy TLS to
\`127.0.0.1:8787\`, bootstrap an admin, never commit \`.env\` or \`data/\`.

See \`fork-backend/README.md\` and root \`README.md\`.
`
  }
  return out
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest))
  fs.copyFileSync(src, dest)
}

function writeText(dest, text) {
  ensureDir(path.dirname(dest))
  fs.writeFileSync(dest, text, 'utf8')
}

function isTextFile(rel) {
  const ext = path.extname(rel).toLowerCase()
  if (TEXT_EXT.has(ext)) return true
  const base = path.basename(rel).toLowerCase()
  if (base === 'dockerfile' || base === 'makefile' || base === 'license') return true
  return false
}

// ---------- main ----------
console.log('ROOT', ROOT)
if (fs.existsSync(STAGE)) {
  fs.rmSync(STAGE, { recursive: true, force: true })
}
ensureDir(STAGE)
ensureDir(OUT_DIR)

const includeRoots = [
  'Fork-VPN',
  'fork-backend',
  'README.md',
  // 不打包本机启动脚本（start-fork.ps1 / .bat）——仅本地运维，非发布源码
  'CLASH_REFACTOR_PLAN.md',
  'docs',
  'scripts/pack-source-release.mjs',
]

const files = []
for (const item of includeRoots) {
  const abs = path.join(ROOT, item)
  if (!fs.existsSync(abs)) {
    console.warn('skip missing', item)
    continue
  }
  const st = fs.statSync(abs)
  if (st.isDirectory()) {
    walk(abs, item, files)
  } else if (st.isFile() && !shouldExclude(toPosix(item))) {
    files.push({ abs, rel: toPosix(item) })
  }
}

let copied = 0
let redacted = 0
const manifest = []

for (const { abs, rel } of files) {
  const dest = path.join(STAGE, rel)
  if (isTextFile(rel)) {
    let text = fs.readFileSync(abs, 'utf8')
    const before = text
    text = redactText(text, rel)
    if (text !== before) redacted++
    writeText(dest, text)
  } else {
    copyFile(abs, dest)
  }
  const st = fs.statSync(dest)
  const hash = createHash('sha256').update(fs.readFileSync(dest)).digest('hex').slice(0, 16)
  manifest.push({ path: rel, bytes: st.size, sha256_16: hash })
  copied++
}

// .env.example for backend
const envExample = `# Copy to .env and fill in. NEVER commit real values.
NODE_ENV=development
FORK_BIND=127.0.0.1
FORK_PORT=8787
FORK_PUBLIC_URL=http://127.0.0.1:8787
FORK_CORS_ORIGINS=http://127.0.0.1:8787,http://localhost:1420
FORK_JWT_SECRET=dev-only-change-me-to-32chars-min!!
FORK_JWT_EXPIRES=7d
# Production: omit FORK_TEST_INSECURE_HTTP; use HTTPS public URL
# FORK_TEST_INSECURE_HTTP=1

# 易支付（付费商品可选）
# EZPAY_URL=https://pay.example.com
# EZPAY_PID=
# EZPAY_KEY=

# 生产首次建管理员时使用，成功后立即删除
# FORK_BOOTSTRAP_TOKEN=
`
writeText(path.join(STAGE, 'fork-backend/.env.example'), envExample)

// empty data placeholder
writeText(
  path.join(STAGE, 'fork-backend/data/.gitkeep'),
  '# Runtime DB lives here (fork.json). Not shipped with source.\n',
)

// root .gitignore for the pack
const gitignore = `# Dependencies / build
node_modules/
target/
dist/
.pnpm-store/

# Secrets & runtime data
.env
.env.*
!.env.example
fork-backend/data/*
!fork-backend/data/.gitkeep

# Packs / logs
*.tgz
*.zip
*.log
releases/

# OS
.DS_Store
Thumbs.db
`
writeText(path.join(STAGE, '.gitignore'), gitignore)

// DESENSITIZE note
const note = `# 脱敏源码包说明

打包日期：${STAMP}
内容：客户端 \`Fork-VPN\` + 后端 \`fork-backend\` 源码（已脱敏）

## 已排除

- \`node_modules/\`、Rust \`target/\`、前端 \`dist/\`
- \`fork-backend/data/\`（用户、订单、管理员哈希、真实订阅 URL）
- \`.env\` 与一切生产密钥
- 预编译 sidecar / 资源二进制（exe、geoip 等；客户端需 \`pnpm run prebuild\` 重新拉取）
- 内部运维脚本（\`deploy-*\`、\`_*\` 临时脚本）与生产运维备忘

## 已替换 / 脱敏

- 生产域名 → \`your-domain.example\`
- 生产服务器 IP → \`YOUR_SERVER_IP\`
- 文档中的运维细节已裁剪

## 本地启动（摘要）

### 后端

\`\`\`bash
cd fork-backend
cp .env.example .env
npm install
npm run bootstrap-admin -- -u admin -p 'YourStrongPass1'
npm run dev
\`\`\`

管理后台：\`http://127.0.0.1:8787/forkvpnadmin/\`

### 客户端

\`\`\`bash
cd Fork-VPN
corepack enable && pnpm install
pnpm run prebuild
# Windows:
# $env:FORK_API_BASE="http://127.0.0.1:8787/api/v1"
pnpm dev
\`\`\`

默认 API 占位为 \`https://your-domain.example/api/v1\`，务必用环境变量覆盖。

## 合规

基于 Clash Verge Rev，许可证见 \`Fork-VPN/LICENSE\`（GPL-3.0）。
分发二进制时请同时提供对应源码获取方式。
`
writeText(path.join(STAGE, 'DESENSITIZE.md'), note)

// update README admin path hint if still says root
const readmePath = path.join(STAGE, 'README.md')
if (fs.existsSync(readmePath)) {
  let r = fs.readFileSync(readmePath, 'utf8')
  r = r.replace(
    '默认：`http://127.0.0.1:8787/`（管理面板）',
    '默认：`http://127.0.0.1:8787/forkvpnadmin/`（管理面板）· 落地页 `/`',
  )
  r = r.replace(
    '| 管理后台 | 浏览器访问后端根路径 |',
    '| 管理后台 | 浏览器访问 `/forkvpnadmin/` |',
  )
  fs.writeFileSync(readmePath, r, 'utf8')
}

// manifest
const sorted = manifest.sort((a, b) => a.path.localeCompare(b.path))
writeText(
  path.join(STAGE, 'FILELIST.json'),
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      file_count: sorted.length,
      files: sorted,
    },
    null,
    2,
  ),
)

// scan staged tree for residual secrets
const residualPatterns = [
  /forkvpn\.i58\.xyz/i,
  /64\.90\.19\.128/,
  /103\.14\.76\.98/,
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/, // bcrypt hashes
  /EZPAY_KEY\s*[=:]\s*['\"]?[a-zA-Z0-9]{16,}/i,
]
const residualHits = []
function scanDir(dir, baseRel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = baseRel ? `${baseRel}/${ent.name}` : ent.name
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) scanDir(abs, rel)
    else if (ent.isFile() && isTextFile(rel)) {
      const t = fs.readFileSync(abs, 'utf8')
      for (const re of residualPatterns) {
        if (re.test(t)) residualHits.push({ path: rel, pattern: String(re) })
      }
    }
  }
}
scanDir(STAGE, '')

if (residualHits.length) {
  console.error('RESIDUAL SECRET SCAN FAILED:')
  for (const h of residualHits.slice(0, 30)) console.error(' ', h.path, h.pattern)
  process.exit(1)
}
console.log('secret scan: clean')

// zip via PowerShell Compress-Archive (Windows)
if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH)
const ps = `
$ErrorActionPreference = 'Stop'
$src = '${STAGE.replace(/'/g, "''")}'
$dst = '${ZIP_PATH.replace(/'/g, "''")}'
if (Test-Path $dst) { Remove-Item $dst -Force }
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dst -CompressionLevel Optimal
Get-Item $dst | Select-Object FullName, Length
`
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', ps],
  { stdio: 'inherit', windowsHide: true },
)

const zipStat = fs.statSync(ZIP_PATH)
const zipHash = createHash('sha256').update(fs.readFileSync(ZIP_PATH)).digest('hex')
const summary = {
  zip: ZIP_PATH,
  bytes: zipStat.size,
  mb: Math.round((zipStat.size / 1024 / 1024) * 100) / 100,
  sha256: zipHash,
  files: copied,
  redacted_files: redacted,
  stage: STAGE,
}
writeText(path.join(OUT_DIR, `${ZIP_NAME}.sha256.txt`), `${zipHash}  ${ZIP_NAME}\n`)
writeText(path.join(OUT_DIR, `${ZIP_NAME}.meta.json`), JSON.stringify(summary, null, 2))

console.log(JSON.stringify(summary, null, 2))
console.log('DONE')
