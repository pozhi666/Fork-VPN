/**
 * Pack a desensitized source release of Fork (client + backend).
 * Does NOT mutate the live working tree — copies to a staging dir, redacts, zips.
 *
 * Live client dir: Fork-VPN  →  public pack dir: Fork-VPN
 *
 * Usage: node scripts/pack-source-release.mjs
 * Optional: node scripts/pack-source-release.mjs --stage-only  (no zip)
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
const PUBLIC_TREE = path.join(OUT_DIR, 'Fork-VPN-public') // clean tree for git push
const ZIP_NAME = `fork-source-desensitized-${STAMP}.zip`
const ZIP_PATH = path.join(OUT_DIR, ZIP_NAME)
const STAGE_ONLY = process.argv.includes('--stage-only')

/** Live workspace name → public pack name */
const CLIENT_LIVE = 'Fork-VPN'
const CLIENT_PUBLIC = 'Fork-VPN'

// ---------- exclude rules (path segments relative to ROOT, after remapping) ----------
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  'target',
  'dist',
  '.git',
  '.pnpm-store',
  '__pycache__',
  '.turbo',
  'releases',
  '_deploy_b64',
  '_stage-fork-source',
])

const EXCLUDE_PATH_PREFIXES = [
  'fork-backend/data',
  `${CLIENT_PUBLIC}/src-tauri/sidecar`,
  `${CLIENT_PUBLIC}/src-tauri/target`,
  `${CLIENT_PUBLIC}/src-tauri/gen`,
]

const EXCLUDE_FILE_NAMES = new Set([
  '.env',
  '.DS_Store',
  'Thumbs.db',
  'fork-vite.log',
  'fork-backend-deploy.tgz',
  'fork-backend-fix.tgz',
  'PHASE0_PROGRESS.md',
  'HANDOFF.md', // local ops handoff — not for public
  'start-fork.ps1',
  'start-fork.bat',
  'pnpm-lock.yaml', // re-generated on install; optional: we KEEP lock for reproducibility — actually keep lock
])
// Keep pnpm-lock — remove from exclude set above comment is fine, we don't exclude it

const EXCLUDE_FILE_GLOBS = [
  /^fork-backend\/scripts\/_/,
  /^fork-backend\/scripts\/deploy-/,
  /^fork-backend\/scripts\/ops-/,
  /^fork-backend\/scripts\/ensure-jwt/,
  /^fork-backend\/scripts\/fix-user-purchases/,
  /^fork-backend\/scripts\/run-fix-purchases/,
  /^fork-backend\/scripts\/repair-/,
  /^fork-backend\/scripts\/inventory-/,
  /^fork-backend\/scripts\/migrate-json/, // optional migration helpers can stay? keep migrate-postgres
  new RegExp(`^${CLIENT_PUBLIC}/src-tauri/resources/.*\\.(exe|dat|mmdb)$`, 'i'),
  new RegExp(`^${CLIENT_PUBLIC}/src-tauri/sidecar/`),
  /\.log$/i,
  /\.tgz$/i,
  /\.zip$/i,
  new RegExp(`^${CLIENT_PUBLIC}/\\.cargo/`),
  // local-only noise
  /^_scp_test/,
]

const OPS_DOC_PATHS = new Set(['docs/OPS_DONE.md'])

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.rs', '.json', '.md', '.txt',
  '.html', '.css', '.scss', '.yml', '.yaml', '.toml', '.ps1', '.bat',
  '.cmd', '.sh', '.env', '.example', '.svg', '.nsi', '.plist', '.desktop',
  '.mts', '.cts',
])

const REDACTIONS = [
  [/forkvpn\.i58\.xyz/gi, 'your-domain.example'],
  [/64\.90\.19\.128/g, 'YOUR_SERVER_IP'],
  // live workspace folder name → public name in docs/paths
  [/Fork-VPN/g, CLIENT_PUBLIC],
  [/fork_vpn/g, 'fork_vpn'],
  // accidental secrets
  [/(FORK_JWT_SECRET\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2CHANGE_ME_JWT_SECRET_AT_LEAST_32_CHARS'],
  [/(EZPAY_KEY\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2CHANGE_ME'],
  [/(EZPAY_PID\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2CHANGE_ME'],
  [/(SSH_PASS\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2'],
  [/(SSH_MCP_PASSWORD\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2'],
  [/(DATABASE_URL\s*[=:]\s*)(["']?)[^\s"'\\]+/gi, '$1$2'],
  [/https?:\/\/103\.14\.76\.98\/[^\s"'<>]+/gi, ''],
]

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/** Map live relative path → public relative path */
function toPublicRel(liveRelPosix) {
  if (liveRelPosix === CLIENT_LIVE || liveRelPosix.startsWith(CLIENT_LIVE + '/')) {
    return CLIENT_PUBLIC + liveRelPosix.slice(CLIENT_LIVE.length)
  }
  return liveRelPosix
}

function shouldExcludePublic(publicRel) {
  const base = path.posix.basename(publicRel)
  if (EXCLUDE_FILE_NAMES.has(base)) return true
  if (base === '.env' || (base.startsWith('.env.') && !base.endsWith('.example'))) return true
  const parts = publicRel.split('/')
  for (const part of parts) {
    if (EXCLUDE_DIR_NAMES.has(part)) return true
  }
  for (const pref of EXCLUDE_PATH_PREFIXES) {
    if (publicRel === pref || publicRel.startsWith(pref + '/')) return true
  }
  for (const re of EXCLUDE_FILE_GLOBS) {
    if (re.test(publicRel)) return true
  }
  return false
}

function walkLive(dir, baseRelLive, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const liveRel = baseRelLive ? `${baseRelLive}/${ent.name}` : ent.name
    const livePosix = toPosix(liveRel)
    const publicRel = toPublicRel(livePosix)
    if (shouldExcludePublic(publicRel)) continue
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      walkLive(abs, livePosix, out)
    } else if (ent.isFile()) {
      out.push({ abs, publicRel })
    }
  }
}

function redactText(text, publicRel) {
  let out = text
  for (const [re, rep] of REDACTIONS) {
    out = out.replace(re, rep)
  }
  if (OPS_DOC_PATHS.has(publicRel) || publicRel.endsWith('/OPS_DONE.md')) {
    out = `# Ops notes (redacted)

This file was removed from the public source pack.

Production deploy: set env vars, reverse-proxy TLS to \`127.0.0.1:8787\`,
bootstrap an admin, never commit \`.env\` or \`data/\`.

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
  return base === 'dockerfile' || base === 'makefile' || base === 'license' || base === 'cargo.lock'
}

// ---------- main ----------
console.log('ROOT', ROOT)
console.log(`Client: ${CLIENT_LIVE}  →  public: ${CLIENT_PUBLIC}`)

if (!fs.existsSync(path.join(ROOT, CLIENT_LIVE))) {
  console.error(`Missing live client dir: ${CLIENT_LIVE}`)
  process.exit(1)
}
if (!fs.existsSync(path.join(ROOT, 'fork-backend'))) {
  console.error('Missing fork-backend')
  process.exit(1)
}

if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true })
ensureDir(STAGE)
ensureDir(OUT_DIR)

const includeLiveRoots = [
  CLIENT_LIVE,
  'fork-backend',
  'README.md',
  'CLASH_REFACTOR_PLAN.md',
  'docs',
  'scripts/pack-source-release.mjs',
]

const files = []
for (const item of includeLiveRoots) {
  const abs = path.join(ROOT, item)
  if (!fs.existsSync(abs)) {
    console.warn('skip missing', item)
    continue
  }
  const st = fs.statSync(abs)
  if (st.isDirectory()) {
    walkLive(abs, item, files)
  } else if (st.isFile()) {
    const publicRel = toPublicRel(toPosix(item))
    if (!shouldExcludePublic(publicRel)) files.push({ abs, publicRel })
  }
}

let copied = 0
let redacted = 0
const manifest = []

for (const { abs, publicRel } of files) {
  const dest = path.join(STAGE, publicRel)
  if (isTextFile(publicRel)) {
    let text = fs.readFileSync(abs, 'utf8')
    const before = text
    text = redactText(text, publicRel)
    if (text !== before) redacted++
    writeText(dest, text)
  } else {
    copyFile(abs, dest)
  }
  const st = fs.statSync(dest)
  const hash = createHash('sha256').update(fs.readFileSync(dest)).digest('hex').slice(0, 16)
  manifest.push({ path: publicRel, bytes: st.size, sha256_16: hash })
  copied++
}

// ---------- public README (always rewrite for consistent branding) ----------
const publicReadme = `# Fork VPN

> 基于 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) 的商业化桌面客户端 · 可选自建后端  
> 当前版本：**0.2.0**

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](./Fork-VPN/LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-orange.svg)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)

Fork 在保留 Clash Meta / Mihomo 能力的同时，增加 **账号体系、订阅商城、官方线路下发、个人中心、余额与工单** 等，并与原版 Clash Verge **数据目录与端口隔离**，可同时运行。

> **合规说明**：客户端基于 GPL-3.0 上游二次开发。分发二进制时须提供对应源码并保留许可证。  
> **请勿提交** 生产密钥、用户数据与服务器凭据。本仓库为**脱敏**源码。

---

## 目录结构

\`\`\`text
.
├── Fork-VPN/        # 桌面客户端（Tauri 2 + React + Rust）
├── fork-backend/    # 商业 API 与管理后台
├── DESENSITIZE.md   # 脱敏说明
└── README.md
\`\`\`

---

## 功能概览

### 客户端（\`Fork-VPN/\`）

- 注册 / 登录、会话校验、找回密码（邮箱 OTP）
- 官方线路同步（客户端不暴露源站 URL）
- 订阅商城、易支付、站内余额
- 个人中心：权益、订单、工单、改密
- 签到与双流量钱包（免费 / 付费）
- 与原版 Clash Verge 端口 / AppId / 数据目录隔离

### 后端（\`fork-backend/\`）

- JWT 用户体系与管理员
- 商品 / 订阅源 / 权益 / 退款撤权
- 易支付下单与回调
- 管理后台静态面板（\`/forkvpnadmin/\`）

---

## 快速开始

### 环境

- Node.js 20+、[pnpm](https://pnpm.io/)
- Rust（stable）+ [Tauri 依赖](https://v2.tauri.app/start/prerequisites/)

### 1. 后端

\`\`\`bash
cd fork-backend
cp .env.example .env
npm install
npm run bootstrap-admin -- -u admin -p 'YourStrongPass1'
npm run dev
\`\`\`

- API：\`http://127.0.0.1:8787/api/v1\`
- 管理后台：\`http://127.0.0.1:8787/forkvpnadmin/\`

### 2. 客户端

\`\`\`bash
cd Fork-VPN
corepack enable
pnpm install
pnpm run prebuild
# 本地后端（PowerShell）:
# $env:FORK_API_BASE="http://127.0.0.1:8787/api/v1"
pnpm dev
\`\`\`

默认 API 占位为 \`https://your-domain.example/api/v1\`，本地务必用环境变量覆盖。

---

## 社区

| | |
|--|--|
| Telegram | [t.me/forkdl](https://t.me/forkdl) |
| 源码 | 本仓库 |

---

## 许可证

客户端见 \`Fork-VPN/LICENSE\`（GPL-3.0）。后端与文档以仓库内说明为准。
`
writeText(path.join(STAGE, 'README.md'), publicReadme)

// .env.example
const envExample = `# Copy to .env and fill in. NEVER commit real values.
NODE_ENV=development
FORK_BIND=127.0.0.1
FORK_PORT=8787
FORK_PUBLIC_URL=http://127.0.0.1:8787
FORK_CORS_ORIGINS=http://127.0.0.1:8787,http://localhost:1420,http://localhost:3000
FORK_JWT_SECRET=CHANGE_ME_JWT_SECRET_AT_LEAST_32_CHARS
FORK_JWT_EXPIRES=7d
# Production: omit FORK_TEST_INSECURE_HTTP; use HTTPS public URL

# Optional: 易支付
# EZPAY_URL=https://pay.example.com
# EZPAY_PID=
CHANGE_ME EZPAY_KEY=

CHANGE_ME Optional: Postgres
# DATABASE_URL=

# 生产首次建管理员时使用，成功后删除
# FORK_BOOTSTRAP_TOKEN=
`
writeText(path.join(STAGE, 'fork-backend/.env.example'), envExample)

writeText(
  path.join(STAGE, 'fork-backend/data/.gitkeep'),
  '# Runtime DB lives here. Not shipped with source.\n',
)

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

# OS / IDE
.DS_Store
Thumbs.db
.idea/
.vscode/
`
writeText(path.join(STAGE, '.gitignore'), gitignore)

const note = `# 脱敏源码包说明

打包日期：${STAMP}  
内容：客户端 **\`Fork-VPN/\`**（由本机开发目录同步并改名）+ **\`fork-backend/\`**

## 已排除

- \`node_modules/\`、Rust \`target/\`、前端 \`dist/\`
- \`fork-backend/data/\`（用户、订单、管理员哈希、真实订阅）
- \`.env\` 与生产密钥
- 预编译 sidecar / geo / service 二进制（需 \`pnpm run prebuild\`）
- 内部运维脚本（\`deploy-*\`、\`_*\`、repair 等）与本地交接文档

## 已替换

- 生产域名 → \`your-domain.example\`
- 生产 IP → \`YOUR_SERVER_IP\`
- 本机开发目录名 → 公开名 **\`Fork-VPN\`**

## 合规

基于 Clash Verge Rev，见 \`Fork-VPN/LICENSE\`（GPL-3.0）。
`
writeText(path.join(STAGE, 'DESENSITIZE.md'), note)

// manifest
const sorted = manifest.sort((a, b) => a.path.localeCompare(b.path))
writeText(
  path.join(STAGE, 'FILELIST.json'),
  JSON.stringify({ generated_at: new Date().toISOString(), file_count: sorted.length, files: sorted }, null, 2),
)

// residual scan
const residualPatterns = [
  /forkvpn\.i58\.xyz/i,
  /64\.90\.19\.128/,
  /103\.14\.76\.98/,
  /Fork-VPN/,
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/,
  /EZPAY_KEY\s*[=:]\s*['"]?[a-zA-Z0-9]{16,}/i,
]
const residualHits = []
function scanDir(dir, baseRel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = baseRel ? `${baseRel}/${ent.name}` : ent.name
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) scanDir(abs, rel)
    else if (ent.isFile() && isTextFile(rel)) {
      // FILELIST may mention nothing sensitive; still scan
      if (rel === 'FILELIST.json') continue
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
  for (const h of residualHits.slice(0, 40)) console.error(' ', h.path, h.pattern)
  process.exit(1)
}
console.log('secret scan: clean')

// mirror stage → public tree for git (stable folder name)
if (fs.existsSync(PUBLIC_TREE)) fs.rmSync(PUBLIC_TREE, { recursive: true, force: true })
fs.cpSync(STAGE, PUBLIC_TREE, { recursive: true })
console.log('public tree:', PUBLIC_TREE)

if (!STAGE_ONLY) {
  if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH)
  const ps = `
$ErrorActionPreference = 'Stop'
$src = '${STAGE.replace(/'/g, "''")}'
$dst = '${ZIP_PATH.replace(/'/g, "''")}'
if (Test-Path $dst) { Remove-Item $dst -Force }
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dst -CompressionLevel Optimal
Get-Item $dst | Select-Object FullName, Length
`
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    stdio: 'inherit',
    windowsHide: true,
  })
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
    public_tree: PUBLIC_TREE,
    client_public_name: CLIENT_PUBLIC,
  }
  writeText(path.join(OUT_DIR, `${ZIP_NAME}.sha256.txt`), `${zipHash}  ${ZIP_NAME}\n`)
  writeText(path.join(OUT_DIR, `${ZIP_NAME}.meta.json`), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(JSON.stringify({ files: copied, redacted_files: redacted, stage: STAGE, public_tree: PUBLIC_TREE }, null, 2))
}
console.log('DONE')
