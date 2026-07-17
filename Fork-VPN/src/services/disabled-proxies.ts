/**
 * 禁用代理节点列表（本地存储）。
 *
 * 设计要点：禁用状态以前用「节点名」作为主键存在 localStorage
 * (`fork-disabled-proxy-names`)，导致重名节点跨 profile / 跨组互相误伤。
 * 现在改为「稳定键」：profileUid + groupName + 标准化节点配置哈希，
 * 节点名只用于展示，不参与主键。旧数据在首次访问时做一次性迁移，
 * 迁移后仍保留对旧 key 的回读兼容（用于读取尚未迁移的旧数据）。
 *
 * 存储结构（`fork-disabled-proxy-keys`）：
 * {
 *   [profileUid]: {
 *     [groupName]: { [proxyKey: string]: true }
 *   }
 * }
 */
const KEY = 'fork-disabled-proxy-keys'
const LEGACY_KEY = 'fork-disabled-proxy-names'
const MIGRATED_FLAG = 'fork-disabled-proxy-migrated'

type Listener = () => void
const listeners = new Set<Listener>()

type GroupMap = Record<string, true> // proxyKey -> true
type ProfileMap = Record<string, GroupMap> // groupName -> GroupMap
type StorageShape = Record<string, ProfileMap> // profileUid -> ProfileMap

/**
 * 标准化节点配置字段，用于生成稳定哈希。
 *
 * 取自 mihomo 返回的节点信息里的稳定字段（type/server/port/password 等），
 * 不含 name（同名不同实例也要区分）、不含 history/延迟等易变字段。
 */
const STABLE_FIELDS: Array<keyof IProxyItem> = [
  'type',
  'udp',
  'xudp',
  'tfo',
  'mptcp',
  'smux',
]

/**
 * 从节点对象中提取稳定字段并拼成可哈希的字符串。
 * 节点对象可能携带 server/port/password 等额外字段（来自 mihomo
 * `proxies` runtime map），一并纳入以提升区分度。
 */
function buildConfigFingerprint(proxy: IProxyItem): string {
  const parts: string[] = []
  for (const f of STABLE_FIELDS) {
    const v = (proxy as any)[f]
    if (v === undefined || v === null) continue
    parts.push(`${f}=${String(v)}`)
  }
  // 额外的连接配置字段（节点来自 mihomo runtime proxies 时会有）
  const extras = ['server', 'port', 'password', 'uuid', 'sni', 'network']
  for (const f of extras) {
    const v = (proxy as any)[f]
    if (v === undefined || v === null || v === '') continue
    parts.push(`${f}=${String(v)}`)
  }
  return parts.join('|')
}

/**
 * 简单稳定哈希（djb2 变体）。无需密码学强度，只要稳定且分布均匀即可。
 * 避免引入 crypto.subtle 的异步 API，保持调用路径同步。
 */
function hashString(input: string): string {
  let h1 = 0x811c9dc5 // FNV offset basis (32-bit)
  let h2 = 0x01000193 // FNV prime
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul((h2 + c) ^ (c << 11), 0x85ebca6b) >>> 0
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)
}

/**
 * 计算节点的稳定键（不含 profileUid/groupName 前缀）。
 * 调用方负责拼上 profileUid + groupName 以保证组级 / profile 级隔离。
 */
export function proxyConfigHash(proxy: IProxyItem): string {
  return hashString(buildConfigFingerprint(proxy))
}

/**
 * 计算节点在指定 (profileUid, groupName) 下的完整稳定键。
 * 格式：`profileUid::groupName::configHash`
 * 说明：实际存储只使用 configHash 作为组内主键，profileUid/groupName
 * 通过存储结构层级天然隔离；此函数仅用于调试 / 日志场景。
 */
export function stableProxyKey(
  profileUid: string,
  groupName: string,
  proxy: IProxyItem,
): string {
  return `${profileUid}::${groupName}::${proxyConfigHash(proxy)}`
}

function readStorage(): StorageShape {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? (data as StorageShape) : {}
  } catch {
    return {}
  }
}

function writeStorage(data: StorageShape) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    /* ignore quota errors */
  }
  // 失效快照缓存，强制下次重建
  snapshotCache.clear()
  notifyListeners()
}

// ---- 快照缓存：useSyncExternalStore 需要 getSnapshot 返回稳定引用 ----
// 每次 writeStorage 会清空缓存；读路径命中缓存时返回同一 Set 引用。
const snapshotCache = new Map<string, Set<string>>()
const EMPTY_SET: Set<string> = new Set<string>()

function notifyListeners() {
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* ignore listener errors */
    }
  })
}

/**
 * 一次性迁移：把旧的按节点名存储的禁用列表转写为新结构。
 *
 * 旧数据无法还原 (profileUid, groupName, configHash)，因此迁移策略为：
 * 把每个旧名字写入「未知 profile / 未知组」桶 (`_legacy`)，并在渲染期
 * 通过 `isProxyDisabledByName` 做名称回退匹配，直到用户重新设置为止。
 * 迁移仅在 `MIGRATED_FLAG` 未置位时执行一次。
 */
export function migrateLegacyDisabledNames(): void {
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) return
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const names = JSON.parse(legacyRaw)
      if (Array.isArray(names) && names.length) {
        const data = readStorage()
        const bucket = (data['_legacy'] ??= {})
        const group = (bucket['_legacy'] ??= {})
        for (const n of names) {
          if (typeof n === 'string' && n) group[`name::${n}`] = true
        }
        writeStorage(data)
      }
    }
  } catch {
    /* ignore */
  } finally {
    try {
      localStorage.setItem(MIGRATED_FLAG, '1')
    } catch {
      /* ignore */
    }
  }
}

/** 读取 profileUid 下的全部禁用节点键。 */
export function getDisabledKeys(profileUid: string): Set<string> {
  const data = readStorage()
  const profile = data[profileUid]
  if (!profile) return new Set()
  const keys = new Set<string>()
  for (const group of Object.values(profile)) {
    for (const k of Object.keys(group)) keys.add(k)
  }
  return keys
}

/** 读取 profileUid + groupName 下的禁用节点键。带快照缓存。 */
export function getDisabledKeysForGroup(
  profileUid: string,
  groupName: string,
): Set<string> {
  if (!profileUid || !groupName) return EMPTY_SET
  const cacheKey = `${profileUid}::${groupName}`
  const cached = snapshotCache.get(cacheKey)
  if (cached) return cached
  const data = readStorage()
  const group = data[profileUid]?.[groupName]
  const result = group ? new Set(Object.keys(group)) : EMPTY_SET
  if (result === EMPTY_SET) return result
  snapshotCache.set(cacheKey, result)
  return result
}

/** 判断节点是否被禁用（按稳定键）。 */
export function isProxyDisabled(
  profileUid: string,
  groupName: string,
  proxy: IProxyItem,
): boolean {
  const key = proxyConfigHash(proxy)
  const data = readStorage()
  return Boolean(data[profileUid]?.[groupName]?.[key])
}

/**
 * 名称回退匹配（用于迁移后的旧数据）。
 * 仅当稳定键未命中时，回退到 `_legacy` 桶按名字匹配。
 */
export function isProxyDisabledByNameFallback(
  proxyName: string,
): boolean {
  const data = readStorage()
  const legacy = data['_legacy']?.['_legacy']
  if (!legacy) return false
  return Boolean(legacy[`name::${proxyName}`])
}

/**
 * 综合判定：先按稳定键命中，再回退到按名匹配（迁移兼容）。
 */
export function isProxyDisabledFull(
  profileUid: string,
  groupName: string,
  proxy: IProxyItem,
): boolean {
  if (isProxyDisabled(profileUid, groupName, proxy)) return true
  return isProxyDisabledByNameFallback(proxy.name)
}

/** 设置节点的禁用状态（按稳定键）。 */
export function setProxyDisabled(
  profileUid: string,
  groupName: string,
  proxy: IProxyItem,
  disabled: boolean,
): void {
  const key = proxyConfigHash(proxy)
  const data = readStorage()
  const profile = (data[profileUid] ??= {})
  const group = (profile[groupName] ??= {})
  if (disabled) {
    group[key] = true
  } else {
    delete group[key]
    if (Object.keys(group).length === 0) delete profile[groupName]
    if (Object.keys(profile).length === 0) delete data[profileUid]
  }
  writeStorage(data)
}

/** 切换节点禁用状态，返回新的状态。 */
export function toggleProxyDisabled(
  profileUid: string,
  groupName: string,
  proxy: IProxyItem,
): boolean {
  const next = !isProxyDisabledFull(profileUid, groupName, proxy)
  setProxyDisabled(profileUid, groupName, proxy, next)
  return next
}

/** 订阅禁用列表变更。 */
export function subscribeDisabledProxies(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * 过滤掉禁用节点（供列表渲染 / 自动选择使用）。
 * 保留迁移兼容：先按稳定键，再按名回退。
 */
export function filterEnabledProxies<T extends IProxyItem>(
  list: T[],
  profileUid: string,
  groupName: string,
): T[] {
  const keys = getDisabledKeysForGroup(profileUid, groupName)
  const hasLegacy = Boolean(readStorage()['_legacy']?.['_legacy'])
  if (!keys.size && !hasLegacy) return list
  return list.filter((p) => {
    if (keys.has(proxyConfigHash(p))) return false
    if (hasLegacy && isProxyDisabledByNameFallback(p.name)) return false
    return true
  })
}

// ---- 旧 API 兼容（仅返回空，避免外部误用；调用方应改用新 API 或 hook） ----
// 保留导出签名以维持类型兼容，但语义已迁移到稳定键模型。
/** @deprecated 使用 isProxyDisabledFull / useDisabledProxies */
export function getDisabledProxyNames(): string[] {
  return []
}
