import { load as yamlLoad, dump as yamlDump } from 'js-yaml'

function looksLikeYaml(text) {
  const t = text.trim()
  return (
    t.startsWith('proxies:') ||
    t.startsWith('mixed-port:') ||
    t.startsWith('port:') ||
    t.includes('\nproxies:') ||
    t.includes('proxy-groups:')
  )
}

export function decodeSubscriptionBody(raw) {
  let text = String(raw || '').trim()
  if (!text) return ''
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (looksLikeYaml(text)) return text
  try {
    const normalized = text.replace(/\s+/g, '')
    const decoded = Buffer.from(normalized, 'base64').toString('utf8')
    if (looksLikeYaml(decoded) || decoded.includes('://') || decoded.includes('proxies')) {
      return decoded
    }
  } catch {
    // ignore
  }
  return text
}

export function parseProxyNodes(content) {
  const text = decodeSubscriptionBody(content)
  if (!text) return { nodes: [], groups: [], error: '内容为空' }

  try {
    const doc = yamlLoad(text)
    if (!doc || typeof doc !== 'object') {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (lines.some((l) => /:\/\//.test(l))) {
        const nodes = lines
          .filter((l) => /:\/\//.test(l))
          .map((l, i) => ({
            name: `节点${i + 1}`,
            type: l.split('://')[0] || 'uri',
            server: '-',
            port: '-',
          }))
        return { nodes, groups: [], error: null, format: 'uri-list' }
      }
      return { nodes: [], groups: [], error: '无法解析为 YAML' }
    }

    const proxies = Array.isArray(doc.proxies) ? doc.proxies : []
    const nodes = proxies.map((p, i) => ({
      name: p?.name || `节点${i + 1}`,
      type: p?.type || 'unknown',
      server: p?.server || '-',
      port: p?.port ?? '-',
      udp: Boolean(p?.udp),
    }))
    const groups = Array.isArray(doc['proxy-groups'])
      ? doc['proxy-groups'].map((g) => ({
          name: g?.name || '',
          type: g?.type || '',
          count: Array.isArray(g?.proxies) ? g.proxies.length : 0,
        }))
      : []
    return { nodes, groups, error: null, format: 'yaml', proxyCount: nodes.length }
  } catch (e) {
    return { nodes: [], groups: [], error: e.message || 'YAML 解析失败' }
  }
}

/**
 * Pull subscription body. Supports optional HTTP(S) proxy for CN-only links.
 * - source.fetch_proxy e.g. http://127.0.0.1:7890 or socks5://...
 * - env FORK_UPSTREAM_PROXY as global fallback
 * - source.fetch_ua custom User-Agent (some airports check UA/geo)
 */
async function fetchRemote(url, opts = {}) {
  const proxyUrl =
    String(opts.proxy || process.env.FORK_UPSTREAM_PROXY || '').trim() || null
  const ua =
    String(opts.ua || '').trim() ||
    'ClashMeta/1.18.0 Mihomo/1.18.0'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)

  try {
    let res
    if (proxyUrl) {
      // undici is built into Node 18+
      const { fetch: undiciFetch, ProxyAgent } = await import('undici')
      const dispatcher = new ProxyAgent(proxyUrl)
      res = await undiciFetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        dispatcher,
        headers: {
          'User-Agent': ua,
          Accept: '*/*',
        },
      })
    } else {
      res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': ua,
          Accept: '*/*',
        },
      })
    }

    if (!res.ok) {
      throw new Error(
        `上游订阅 HTTP ${res.status}` +
          (proxyUrl ? '（经代理）' : '') +
          '；若为国内专线，请给该源配置「拉取代理」或改用粘贴 YAML',
      )
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const text = buf.toString('utf8')
    if (!text || text.length < 8) {
      throw new Error(
        '上游返回内容过短/为空；国内专用链接从境外服务器常拉不到，请配置拉取代理',
      )
    }
    // some panels return HTML error pages
    const head = text.trim().slice(0, 200).toLowerCase()
    if (head.startsWith('<!doctype') || head.startsWith('<html')) {
      throw new Error(
        '上游返回了网页而非订阅内容（可能 IP 被墙/需登录/仅限国内）。请配置拉取代理或粘贴 YAML',
      )
    }
    return decodeSubscriptionBody(text)
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(
        '拉取上游超时；国内专线请配置 FORK_UPSTREAM_PROXY 或源级 fetch_proxy',
      )
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveSourceContent(source, username = 'user') {
  const inline = (source?.inline_yaml || '').trim()
  if (inline) {
    return {
      content: decodeSubscriptionBody(inline),
      name: source?.name || '线路',
      from: 'inline',
      tier: source?.tier || 'free',
    }
  }
  const url = (source?.url || '').trim()
  if (url) {
    const content = await fetchRemote(url, {
      proxy: source?.fetch_proxy,
      ua: source?.fetch_ua,
    })
    if (!content || content.length < 10) throw new Error('上游订阅内容为空')
    return {
      content,
      name: source?.name || '线路',
      from: source?.fetch_proxy || process.env.FORK_UPSTREAM_PROXY ? 'remote-proxy' : 'remote',
      tier: source?.tier || 'paid',
    }
  }
  throw new Error(`订阅源「${source?.name || '未命名'}」未配置 URL 或 YAML`)
}

export async function loadSubscriptionYaml({ username, source }) {
  return resolveSourceContent(source || {}, username)
}

export async function previewSource(source) {
  const resolved = await resolveSourceContent(source, 'preview')
  const parsed = parseProxyNodes(resolved.content)
  return {
    ...parsed,
    from: resolved.from,
    tier: resolved.tier,
    content_length: resolved.content.length,
    name: resolved.name,
    content_preview: resolved.content.slice(0, 500),
  }
}

/**
 * Merge multiple source YAMLs into one clash config for the client.
 */
export async function mergeSourcesForUser(sources, username) {
  const allProxies = []
  const freeNames = []
  const paidNames = []
  const usedNames = new Set()
  const parts = []

  for (const source of sources) {
    try {
      const resolved = await resolveSourceContent(source, username)
      const doc = yamlLoad(resolved.content)
      if (!doc || typeof doc !== 'object') continue
      const proxies = Array.isArray(doc.proxies) ? doc.proxies : []
      const tier = source.tier === 'paid' ? 'paid' : 'free'
      const tag = tier === 'free' ? '免费' : '付费'

      for (const p of proxies) {
        if (!p || typeof p !== 'object') continue
        let name = String(p.name || '节点')
        if (usedNames.has(name)) {
          name = `${name}-${source.name || tag}`
        }
        let finalName = name
        let n = 2
        while (usedNames.has(finalName)) {
          finalName = `${name}-${n++}`
        }
        usedNames.add(finalName)
        const item = { ...p, name: finalName }
        if (finalName !== p.name) item['fork-origin-name'] = p.name
        item['fork-tier'] = tier
        item['fork-source'] = source.name || ''
        allProxies.push(item)
        if (tier === 'free') freeNames.push(finalName)
        else paidNames.push(finalName)
      }
      parts.push({
        source_id: source.id,
        name: source.name,
        tier,
        from: resolved.from,
        count: proxies.length,
      })
    } catch (e) {
      parts.push({
        source_id: source.id,
        name: source.name,
        tier: source.tier || 'free',
        error: e.message,
        count: 0,
      })
    }
  }

  if (allProxies.length === 0) {
    const empty = {
      proxies: [],
      'proxy-groups': [
        {
          name: 'PROXY',
          type: 'select',
          proxies: ['DIRECT'],
        },
      ],
      rules: ['MATCH,DIRECT'],
    }
    return {
      content: yamlDump(empty, { lineWidth: -1, noRefs: true }),
      name: '官方线路',
      from: 'empty',
      parts,
      free_count: 0,
      paid_count: 0,
      node_count: 0,
      nodes: [],
      message: '暂无可用节点：请在管理后台为免费/付费订阅源配置真实 URL 或 YAML',
    }
  }

  const selectList = [...freeNames, ...paidNames, 'DIRECT']
  const groups = [
    {
      name: 'PROXY',
      type: 'select',
      proxies: selectList,
    },
  ]
  if (freeNames.length) {
    groups.push({
      name: '免费节点',
      type: 'select',
      proxies: [...freeNames, 'DIRECT'],
    })
  }
  if (paidNames.length) {
    groups.push({
      name: '付费节点',
      type: 'select',
      proxies: [...paidNames, 'DIRECT'],
    })
  }

  const merged = {
    proxies: allProxies,
    'proxy-groups': groups,
    rules: ['MATCH,PROXY'],
  }

  const content = yamlDump(merged, { lineWidth: -1, noRefs: true })
  const nodes = allProxies.map((p) => ({
    name: p.name,
    type: p.type || 'unknown',
    server: p.server || '-',
    port: p.port ?? '-',
    tier: p['fork-tier'] || 'free',
    source: p['fork-source'] || '',
  }))

  return {
    content,
    name: '官方线路',
    from: 'merged',
    parts,
    free_count: freeNames.length,
    paid_count: paidNames.length,
    node_count: allProxies.length,
    nodes,
  }
}
