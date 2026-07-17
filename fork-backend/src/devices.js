import { nanoid } from 'nanoid'
import { nowTs } from './db.js'

export function ensureDevices(user) {
  if (!Array.isArray(user.devices)) user.devices = []
  return user.devices
}

export function getMaxDevices(settings) {
  const n = Number(settings?.max_devices)
  if (!Number.isFinite(n) || n <= 0) return 3
  return Math.min(20, Math.floor(n))
}

/**
 * Register or touch a device. Enforces max concurrent devices.
 * @returns {{ ok: true, devices } | { ok: false, error }}
 */
export function registerDevice(user, settings, { device_id, name, platform } = {}) {
  const devices = ensureDevices(user)
  const max = getMaxDevices(settings)
  const now = nowTs()
  let id = String(device_id || '').trim().slice(0, 80)
  if (!id) id = nanoid(16)

  const existing = devices.find((d) => d.id === id)
  if (existing) {
    existing.last_seen_at = now
    if (name) existing.name = String(name).slice(0, 80)
    if (platform) existing.platform = String(platform).slice(0, 40)
    user.updated_at = now
    return { ok: true, device_id: id, devices, max }
  }

  if (devices.length >= max) {
    // drop oldest last_seen
    devices.sort((a, b) => (a.last_seen_at || 0) - (b.last_seen_at || 0))
    // if still over after, reject unless replace_oldest
    return {
      ok: false,
      error: `设备数已达上限（${max}）。请在个人中心移除旧设备后再登录。`,
      max,
      devices,
    }
  }

  devices.push({
    id,
    name: String(name || '未知设备').slice(0, 80),
    platform: String(platform || '').slice(0, 40),
    created_at: now,
    last_seen_at: now,
  })
  user.updated_at = now
  return { ok: true, device_id: id, devices, max }
}

export function removeDevice(user, deviceId) {
  ensureDevices(user)
  const before = user.devices.length
  user.devices = user.devices.filter((d) => d.id !== deviceId)
  user.updated_at = nowTs()
  return before !== user.devices.length
}
