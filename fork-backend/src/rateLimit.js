/**
 * Simple in-memory sliding-window rate limiter (per process).
 * key → timestamps[]
 */
const buckets = new Map()

function prune(arr, windowMs, now) {
  const min = now - windowMs
  let i = 0
  while (i < arr.length && arr[i] < min) i++
  if (i > 0) arr.splice(0, i)
}

/**
 * @returns {{ ok: true } | { ok: false, retry_after_sec: number, error: string }}
 */
export function hitRateLimit(key, { limit = 20, windowMs = 60_000 } = {}) {
  const now = Date.now()
  let arr = buckets.get(key)
  if (!arr) {
    arr = []
    buckets.set(key, arr)
  }
  prune(arr, windowMs, now)
  if (arr.length >= limit) {
    const retryMs = Math.max(0, windowMs - (now - arr[0]))
    return {
      ok: false,
      retry_after_sec: Math.ceil(retryMs / 1000),
      error: `请求过于频繁，请 ${Math.ceil(retryMs / 1000)} 秒后再试`,
    }
  }
  arr.push(now)
  return { ok: true }
}

export function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  return xf || req.socket?.remoteAddress || req.ip || ''
}
