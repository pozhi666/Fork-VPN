/**
 * Lightweight support tickets (no third-party helpdesk).
 */
import { nanoid } from 'nanoid'
import { nowTs } from './db.js'

export function ensureTickets(data) {
  if (!Array.isArray(data.tickets)) data.tickets = []
  return data.tickets
}

const CATEGORIES = new Set([
  'payment',
  'traffic',
  'account',
  'connection',
  'other',
])

export function normalizeCategory(c) {
  const v = String(c || 'other').toLowerCase().trim()
  return CATEGORIES.has(v) ? v : 'other'
}

export function createTicket(data, user, { subject, body, category } = {}) {
  ensureTickets(data)
  const title = String(subject || '').trim().slice(0, 80)
  const content = String(body || '').trim().slice(0, 2000)
  if (!title) throw new Error('请填写工单标题')
  if (content.length < 4) throw new Error('请填写问题描述（至少 4 字）')
  const openCount = data.tickets.filter(
    (t) => t.user_id === user.id && (t.status === 'open' || t.status === 'replied'),
  ).length
  if (openCount >= 5) throw new Error('进行中的工单过多（最多 5 个），请等待处理或关闭旧单')

  const now = nowTs()
  const id = nanoid(14)
  const ticket = {
    id,
    user_id: user.id,
    username: user.username,
    subject: title,
    category: normalizeCategory(category),
    status: 'open', // open | replied | closed
    messages: [
      {
        id: nanoid(10),
        role: 'user',
        author: user.username,
        body: content,
        at: now,
      },
    ],
    created_at: now,
    updated_at: now,
    closed_at: 0,
  }
  data.tickets.unshift(ticket)
  if (data.tickets.length > 5000) data.tickets.length = 5000
  return ticket
}

export function listUserTickets(data, userId, limit = 50) {
  ensureTickets(data)
  return data.tickets
    .filter((t) => t.user_id === userId)
    .slice(0, Math.min(100, Math.max(1, limit)))
    .map(publicTicket)
}

export function listAdminTickets(data, { status = '', limit = 100 } = {}) {
  ensureTickets(data)
  let list = [...data.tickets]
  if (status) list = list.filter((t) => t.status === status)
  return list
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, Math.min(300, Math.max(1, limit)))
    .map((t) => ({
      ...publicTicket(t),
      user_id: t.user_id,
      username: t.username,
    }))
}

export function getTicket(data, id) {
  ensureTickets(data)
  return data.tickets.find((t) => t.id === id) || null
}

export function replyTicket(data, ticket, { role, author, body }) {
  if (!ticket) throw new Error('工单不存在')
  if (ticket.status === 'closed') throw new Error('工单已关闭')
  const content = String(body || '').trim().slice(0, 2000)
  if (content.length < 1) throw new Error('回复不能为空')
  const now = nowTs()
  if (!Array.isArray(ticket.messages)) ticket.messages = []
  ticket.messages.push({
    id: nanoid(10),
    role: role === 'admin' ? 'admin' : 'user',
    author: String(author || '').slice(0, 80),
    body: content,
    at: now,
  })
  if (ticket.messages.length > 200) {
    ticket.messages = ticket.messages.slice(-200)
  }
  ticket.updated_at = now
  if (role === 'admin') ticket.status = 'replied'
  else if (ticket.status === 'replied') ticket.status = 'open'
  return ticket
}

export function closeTicket(data, ticket, actor = '') {
  if (!ticket) throw new Error('工单不存在')
  if (ticket.status === 'closed') return ticket
  ticket.status = 'closed'
  ticket.closed_at = nowTs()
  ticket.updated_at = ticket.closed_at
  ticket.closed_by = String(actor || '').slice(0, 80)
  return ticket
}

export function publicTicket(t) {
  return {
    id: t.id,
    subject: t.subject,
    category: t.category || 'other',
    status: t.status,
    created_at: t.created_at || 0,
    updated_at: t.updated_at || 0,
    closed_at: t.closed_at || 0,
    message_count: Array.isArray(t.messages) ? t.messages.length : 0,
    last_message: Array.isArray(t.messages) && t.messages.length
      ? {
          role: t.messages[t.messages.length - 1].role,
          body: String(t.messages[t.messages.length - 1].body || '').slice(0, 120),
          at: t.messages[t.messages.length - 1].at,
        }
      : null,
    messages: (t.messages || []).map((m) => ({
      id: m.id,
      role: m.role,
      author: m.author,
      body: m.body,
      at: m.at,
    })),
  }
}

export const TICKET_CATEGORY_LABELS = {
  payment: '支付/订单',
  traffic: '流量/套餐',
  account: '账号',
  connection: '连接/节点',
  other: '其他',
}
