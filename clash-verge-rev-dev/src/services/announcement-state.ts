import {
  commercialGetAnnouncements,
  type AnnouncementItem,
} from '@/services/commercial'

const READ_KEY = 'fork-announcement-read-ids'
const SESSION_POPUP_KEY = 'fork-announcement-popup-done'

export function loadReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

export function saveReadIds(ids: Set<string>) {
  localStorage.setItem(READ_KEY, JSON.stringify([...ids]))
}

export function markRead(id: string) {
  const set = loadReadIds()
  set.add(id)
  saveReadIds(set)
  return set
}

export function markAllRead(items: AnnouncementItem[]) {
  const set = loadReadIds()
  for (const item of items) {
    if (item.id) set.add(item.id)
  }
  saveReadIds(set)
  return set
}

export function isUnread(id: string, read: Set<string>) {
  return Boolean(id) && !read.has(id)
}

export function countUnread(items: AnnouncementItem[], read: Set<string>) {
  return items.filter((i) => isUnread(i.id, read)).length
}

export function sessionPopupDone() {
  return sessionStorage.getItem(SESSION_POPUP_KEY) === '1'
}

export function markSessionPopupDone() {
  sessionStorage.setItem(SESSION_POPUP_KEY, '1')
}

export async function fetchAnnouncements(): Promise<AnnouncementItem[]> {
  const data = await commercialGetAnnouncements()
  return (data.items || []).filter((i) => i?.id)
}

export function formatAnnTime(ts?: number) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`
  return d.toLocaleString()
}
