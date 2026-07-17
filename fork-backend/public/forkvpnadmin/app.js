const API = '/api/v1'
const state = {
  token: localStorage.getItem('fork_admin_token') || '',
  username: localStorage.getItem('fork_admin_user') || '',
  plans: [],
  sources: [],
  tab: 'overview',
  confirmResolver: null,
  userMode: 'create',
  planMode: 'create',
}

const PAGE_META = {
  overview: { title: '概览', desc: '运营数据与快捷入口' },
  users: { title: '用户', desc: '账号、权益、改密、代开、删除' },
  orders: { title: '订单', desc: '支付订单 · 充值 · 取消 / 退款' },
  tickets: { title: '工单', desc: '用户反馈 · 回复 · 关闭' },
  sources: { title: '订阅源', desc: '线路池：公开 / 需商品解锁' },
  plans: { title: '商品套餐', desc: '价格决定免费/付费 · 绑定线路' },
  coupons: { title: '兑换码', desc: '优惠券生成与管理' },
  invites: { title: '邀请码', desc: '运营通用邀请码' },
  announcements: { title: '公告', desc: '客户端运营通知' },
  settings: { title: '运营配置', desc: '注册 · 邀请返利 · 签到' },
  update: { title: '客户端更新', desc: '版本号与安装包清单' },
  ops: { title: '运维', desc: '健康检查 · 备份 · 审计日志' },
  account: { title: '管理员', desc: '修改控制台登录密码' },
}

const ALL_TABS = Object.keys(PAGE_META)

let usersCache = []

const $ = (id) => document.getElementById(id)

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  }
  if (state.token) headers.Authorization = `Bearer ${state.token}`
  const res = await fetch(API + path, { ...options, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText || '请求失败')
  return data
}

function toast(message, type = 'info') {
  const root = $('toast-root')
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = message
  root.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity .2s'
    setTimeout(() => el.remove(), 200)
  }, 2600)
}

function setError(id, msg, ok = false) {
  const el = $(id)
  if (!el) return
  if (!msg) {
    el.hidden = true
    el.textContent = ''
    el.classList.remove('ok')
    return
  }
  el.hidden = false
  el.textContent = msg
  el.classList.toggle('ok', ok)
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function fmtTime(ts) {
  if (!ts) return '永不过期'
  return new Date(ts * 1000).toLocaleString()
}

function openModal(id) {
  $(id).classList.remove('hidden')
}

function closeModal(id) {
  $(id).classList.add('hidden')
  if (id === 'modal-confirm' && state.confirmResolver) {
    state.confirmResolver(false)
    state.confirmResolver = null
  }
}

function confirmDialog(title, message) {
  $('confirm-title').textContent = title
  $('confirm-msg').textContent = message
  openModal('modal-confirm')
  return new Promise((resolve) => {
    state.confirmResolver = resolve
  })
}

function showLogin() {
  $('login-view').classList.remove('hidden')
  $('main-view').classList.add('hidden')
}

function showMain() {
  $('login-view').classList.add('hidden')
  $('main-view').classList.remove('hidden')
  $('admin-name').textContent = state.username || 'admin'
  $('admin-avatar').textContent = (state.username || 'A').slice(0, 1).toUpperCase()
}

function switchTab(name) {
  state.tab = name
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name)
  })
  ALL_TABS.forEach((t) => {
    const el = $(`tab-${t}`)
    if (el) el.classList.toggle('hidden', t !== name)
  })
  if (name === 'coupons') {
    void loadCoupons()
    fillCouponProductSelect()
  }
  if (name === 'orders') {
    void loadOrdersAdmin()
  }
  if (name === 'invites') {
    void loadInvitesAdmin()
  }
  if (name === 'ops') {
    void loadOps()
  }
  if (name === 'settings' || name === 'update') {
    void loadSettings()
  }
  const meta = PAGE_META[name] || PAGE_META.overview
  $('page-title').textContent = meta.title
  $('page-desc').textContent = meta.desc
}

function toDatetimeLocal(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromDatetimeLocal(v) {
  if (!v) return 0
  return Math.floor(new Date(v).getTime() / 1000)
}

function sourceKind(s) {
  if ((s.inline_yaml || '').trim() || s.has_inline) return { key: 'yaml', label: '粘贴 YAML' }
  if ((s.url || '').trim()) return { key: 'url', label: '远程 URL' }
  return { key: 'empty', label: '未配置' }
}

function sourceDetail(s) {
  const kind = sourceKind(s)
  if (kind.key === 'url') return s.url || ''
  if (kind.key === 'yaml') {
    const n = s.inline_len || (s.inline_yaml || '').length
    return `YAML · ${n} 字符`
  }
  return '请填写订阅 URL 或粘贴 YAML'
}

function productPlans() {
  return state.plans.filter((p) => p.kind !== 'system' && p.name !== 'trial')
}

function fillProductSelect(selectEl, preferredId) {
  const list = productPlans()
  selectEl.innerHTML =
    `<option value="">（不代开商品，仅公共线路）</option>` +
    list
      .map((p) => {
        const price =
          Number(p.price_cents || 0) <= 0
            ? '免费商品'
            : `¥${(Number(p.price_cents) / 100).toFixed(2)}`
        const sale = p.for_sale === false ? '下架' : '在售'
        return `<option value="${escapeHtml(p.id)}" ${
          p.id === preferredId ? 'selected' : ''
        }>${escapeHtml(p.name)} · ${price} · ${sale}</option>`
      })
      .join('')
}

function sourceAccessOf(s) {
  if (s.access === 'locked' || s.access === 'public') return s.access
  return s.tier === 'paid' ? 'locked' : 'public'
}

function fillSourceSelect(selectEl, preferred, lockedOnly = false) {
  let list = state.sources
  if (lockedOnly) list = list.filter((s) => sourceAccessOf(s) === 'locked')
  if (!list.length) list = state.sources
  selectEl.innerHTML =
    `<option value="">（未绑定）</option>` +
    list
      .map((s) => {
        const acc = sourceAccessOf(s) === 'locked' ? '需解锁' : '公开'
        return `<option value="${escapeHtml(s.id)}" ${
          s.id === preferred ? 'selected' : ''
        }>${escapeHtml(s.name)} · ${acc}</option>`
      })
      .join('')
}

async function loadStats() {
  const s = await api('/admin/stats')
  $('stats').innerHTML = `
    <div class="stat">
      <span class="label">用户总数</span>
      <span class="value">${s.users}</span>
      <span class="hint">有效 ${s.active} · 付费 ${s.paid_users ?? 0}</span>
    </div>
    <div class="stat">
      <span class="label">有效权益</span>
      <span class="value">${s.active_purchases ?? 0}</span>
      <span class="hint">未过期的商品开通</span>
    </div>
    <div class="stat">
      <span class="label">订阅源</span>
      <span class="value">${s.sources}</span>
      <span class="hint">公开 ${s.public_sources ?? s.free_sources ?? 0} · 需解锁 ${s.locked_sources ?? s.paid_sources ?? 0}</span>
    </div>
    <div class="stat">
      <span class="label">在售商品</span>
      <span class="value">${s.products_on_sale ?? 0}</span>
      <span class="hint">公告 ${s.announcements ?? 0} 条</span>
    </div>
  `
}

function renderUsersTable(items) {
  const body = $('users-body')
  if (!items.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">无匹配用户</td></tr>`
    return
  }
  body.innerHTML = items
    .map((u) => {
      const now = Date.now() / 1000
      const ent = Number(u.entitlement_until || 0)
      const hasEnt = ent > now || (u.active_purchases || 0) > 0
      const entExpired = ent > 0 && ent < now
      const statusClass =
        u.status !== 'active' ? 'off' : u.traffic_exhausted ? 'warn' : entExpired ? 'warn' : 'ok'
      const statusText =
        u.status !== 'active'
          ? '已禁用'
          : u.traffic_exhausted
            ? '流量用尽'
            : !hasEnt && !ent
              ? '正常·无权益'
              : entExpired
                ? '权益已过期'
                : '正常'
      const bought = (u.purchase_names || []).join('、') || '无商品权益'
      const unlocked = (u.unlocked_sources || u.paid_sources || []).join('、') || '—'
      const pub = (u.public_sources || u.free_sources || []).join('、') || '—'
      const entLabel = ent > 0 ? fmtTime(ent) : '—'
      const trafficLabel = escapeHtml(u.traffic_label || '—')
      const balYuan = escapeHtml(u.balance_yuan || ((Number(u.balance_cents) || 0) / 100).toFixed(2))
      return `<tr>
        <td>
          <span class="cell-title">${escapeHtml(u.username)}</span>
          <span class="cell-sub">${escapeHtml(u.email || '无邮箱')} · 余额 ¥${balYuan} · 注册 ${fmtTime(u.created_at)}</span>
        </td>
        <td>
          <span class="cell-title">${escapeHtml(bought)}</span>
          <span class="cell-sub">公开：${escapeHtml(pub)} · 解锁：${escapeHtml(unlocked)}</span>
        </td>
        <td><span class="badge ${statusClass}">${statusText}</span></td>
        <td class="mono"><span class="cell-sub" style="margin:0">${trafficLabel}</span></td>
        <td class="mono">${entLabel}</td>
        <td class="col-actions">
          <div class="actions">
            <button type="button" class="btn btn-sm btn-secondary" data-act="detail" data-id="${u.id}">详情</button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="grant" data-id="${u.id}">代开</button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="balance" data-id="${u.id}">余额</button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="reset-traffic" data-id="${u.id}">清零流量</button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="toggle" data-id="${u.id}" data-status="${u.status}">
              ${u.status === 'active' ? '禁用' : '启用'}
            </button>
          </div>
        </td>
      </tr>`
    })
    .join('')

  body.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id
      const u = usersCache.find((x) => x.id === id)
      try {
        if (btn.dataset.act === 'detail') {
          openUserDetail(u)
          return
        }
        if (btn.dataset.act === 'balance') {
          const cur = u.balance_yuan || ((Number(u.balance_cents) || 0) / 100).toFixed(2)
          const raw = prompt(
            `调整余额（元）· 当前 ¥${cur}\n正数增加、负数扣减，例如 10 或 -5`,
            '10',
          )
          if (raw == null || String(raw).trim() === '') return
          const yuan = Number(String(raw).trim())
          if (!Number.isFinite(yuan) || yuan === 0) {
            toast('请输入非零数字', 'error')
            return
          }
          const reason = prompt('备注（可选）', 'admin') || 'admin'
          const delta_cents = Math.round(yuan * 100)
          await api(`/admin/users/${id}/balance`, {
            method: 'POST',
            body: JSON.stringify({ delta_cents, reason }),
          })
          toast(`余额已调整 ${yuan > 0 ? '+' : ''}¥${yuan.toFixed(2)}`, 'success')
          await loadUsers()
          return
        }
        if (btn.dataset.act === 'toggle') {
          const next = btn.dataset.status === 'active' ? 'disabled' : 'active'
          const ok = await confirmDialog(
            next === 'disabled' ? '禁用用户' : '启用用户',
            next === 'disabled' ? '禁用后该用户将无法登录与同步。' : '确认重新启用此用户？',
          )
          if (!ok) return
          await api(`/admin/users/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: next }),
          })
          toast(next === 'disabled' ? '已禁用' : '已启用', 'success')
        } else if (btn.dataset.act === 'grant') {
          openGrantModal(u)
          return
        } else if (btn.dataset.act === 'reset-traffic') {
          const ok = await confirmDialog(
            '清零流量',
            `将「${u.username}」所有权益的已用流量清零，确认？`,
          )
          if (!ok) return
          await api(`/admin/users/${id}/traffic`, {
            method: 'POST',
            body: JSON.stringify({ reset: true }),
          })
          toast('流量已清零', 'success')
        }
        await refreshAll()
      } catch (e) {
        toast(e.message, 'error')
      }
    }
  })
}

async function loadUsers() {
  const { items } = await api('/admin/users')
  usersCache = items
  const q = ($('user-search')?.value || '').trim().toLowerCase()
  const filtered = q
    ? items.filter((u) => (u.username || '').toLowerCase().includes(q))
    : items
  renderUsersTable(filtered)
}

function openUserDetail(user) {
  if (!user) return
  $('ud-id').value = user.id
  $('ud-title').textContent = `用户 · ${user.username}`
  $('ud-name').value = user.username
  $('ud-status').value = user.status === 'disabled' ? 'disabled' : 'active'
  const ent = Number(user.entitlement_until || 0)
  $('ud-expire').value = ent > 0 ? fmtTime(ent) : '无付费权益'
  $('ud-pass').value = ''
  setError('ud-error', '')
  const balEl = $('ud-balance')
  if (balEl) {
    const y = user.balance_yuan || ((Number(user.balance_cents) || 0) / 100).toFixed(2)
    balEl.textContent = `¥${y}`
  }
  const box = $('ud-purchases')
  const list = user.purchases || []
  if (!list.length) {
    box.innerHTML = `<div class="purchase-empty">暂无商品权益（仅公共线路）</div>`
  } else {
    box.innerHTML = list
      .map(
        (p) => `<div class="purchase-item">
        <div>
          <div class="cell-title">${escapeHtml(p.name || p.product_id)}</div>
          <div class="cell-sub">到期 ${fmtTime(p.expire_at)}</div>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" data-revoke="${escapeHtml(p.product_id)}">撤销</button>
      </div>`,
      )
      .join('')
    box.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.onclick = async () => {
        const ok = await confirmDialog(
          '撤销权益',
          `确认撤销「${user.username}」的该商品权益？`,
        )
        if (!ok) return
        try {
          await api(`/admin/users/${user.id}/purchases/${btn.dataset.revoke}`, {
            method: 'DELETE',
          })
          toast('已撤销', 'success')
          await refreshAll()
          const next = usersCache.find((x) => x.id === user.id)
          openUserDetail(next)
        } catch (e) {
          toast(e.message, 'error')
        }
      }
    })
  }
  openModal('modal-user-detail')
}

function openCreateUserModal() {
  state.userMode = 'create'
  $('modal-user-title').textContent = '新建用户'
  $('user-edit-id').value = ''
  $('user-name').value = ''
  $('user-name').disabled = false
  $('user-pass').value = ''
  $('user-pass-field').classList.remove('hidden')
  $('user-days-field').classList.remove('hidden')
  $('user-days').value = '30'
  fillProductSelect($('user-plan'), '')
  // label context
  const lab = document.querySelector('label[for="user-plan"]')
  if (lab) lab.textContent = '代开商品（可选）'
  setError('modal-user-error', '')
  openModal('modal-user')
}

function openGrantModal(user) {
  state.userMode = 'grant'
  $('modal-user-title').textContent = `代开商品 · ${user.username}`
  $('user-edit-id').value = user.id
  $('user-name').value = user.username
  $('user-name').disabled = true
  $('user-pass-field').classList.add('hidden')
  $('user-days-field').classList.remove('hidden')
  $('user-days').value = '30'
  fillProductSelect($('user-plan'), '')
  const lab = document.querySelector('label[for="user-plan"]')
  if (lab) lab.textContent = '商品'
  setError('modal-user-error', '')
  openModal('modal-user')
}

async function saveUserModal() {
  setError('modal-user-error', '')
  try {
    if (state.userMode === 'create') {
      const username = $('user-name').value.trim()
      const password = $('user-pass').value
      if (!username || !password) throw new Error('请填写用户名和密码')
      const product_id = $('user-plan').value || undefined
      await api('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          days: Number($('user-days').value || 30),
          product_id,
        }),
      })
      toast('用户已创建', 'success')
    } else if (state.userMode === 'grant') {
      const product_id = $('user-plan').value
      if (!product_id) throw new Error('请选择商品')
      await api(`/admin/users/${$('user-edit-id').value}/grant`, {
        method: 'POST',
        body: JSON.stringify({
          product_id,
          days: Number($('user-days').value || 30),
        }),
      })
      toast('已代开商品', 'success')
    }
    closeModal('modal-user')
    await refreshAll()
  } catch (e) {
    setError('modal-user-error', e.message)
  }
}

function renderNodesTable(tbodyId, nodes, cols = 5) {
  const body = $(tbodyId)
  if (!nodes?.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="${cols}">未解析到节点</td></tr>`
    return
  }
  body.innerHTML = nodes
    .map(
      (n, i) => `<tr>
      <td class="mono">${i + 1}</td>
      <td>${escapeHtml(n.name)}</td>
      <td><span class="badge neutral">${escapeHtml(n.type)}</span></td>
      <td class="mono">${escapeHtml(n.server)}</td>
      <td class="mono">${escapeHtml(n.port)}</td>
    </tr>`,
    )
    .join('')
}

async function showSourceNodes(sourceId, sourceName) {
  $('nodes-panel').classList.remove('hidden')
  $('nodes-title').textContent = `节点预览 · ${sourceName}`
  $('nodes-meta').textContent = '解析中…'
  setError('nodes-error', '')
  $('nodes-body').innerHTML = ''
  try {
    const data = await api(`/admin/sources/${sourceId}/nodes`)
    if (data.error) setError('nodes-error', data.error)
    $('nodes-meta').textContent = `${data.nodes?.length || 0} 个节点 · 来源 ${data.from || '—'}`
    renderNodesTable('nodes-body', data.nodes || [])
  } catch (e) {
    setError('nodes-error', e.message)
    $('nodes-meta').textContent = '解析失败'
  }
}

async function loadSources() {
  const { items } = await api('/admin/sources')
  state.sources = items
  const body = $('sources-body')
  if (!items.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">暂无订阅源</td></tr>`
    return
  }
  body.innerHTML = items
    .map((s) => {
      const kind = sourceKind(s)
      const acc = sourceAccessOf(s)
      const tierBadge =
        acc === 'locked'
          ? '<span class="badge paid">需解锁</span>'
          : '<span class="badge free">公开</span>'
      const kindBadge =
        kind.key === 'empty'
          ? '<span class="badge warn">未配置</span>'
          : `<span class="badge neutral">${kind.label}</span>`
      return `<tr>
      <td>
        <span class="cell-title">${escapeHtml(s.name)}</span>
      </td>
      <td>${tierBadge}</td>
      <td>
        ${kindBadge}
        <span class="cell-sub mono">${escapeHtml(sourceDetail(s))}</span>
      </td>
      <td>${escapeHtml(s.notes || '—')}</td>
      <td class="col-actions">
        <div class="actions">
          <button type="button" class="btn btn-sm btn-secondary" data-act="nodes" data-id="${s.id}">解析</button>
          <button type="button" class="btn btn-sm btn-ghost" data-act="edit" data-id="${s.id}">编辑</button>
          <button type="button" class="btn btn-sm btn-ghost" data-act="del" data-id="${s.id}">删除</button>
        </div>
      </td>
    </tr>`
    })
    .join('')

  body.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async () => {
      const row = items.find((x) => x.id === btn.dataset.id)
      try {
        if (btn.dataset.act === 'del') {
          const ok = await confirmDialog('删除订阅源', `确认删除「${row.name}」？此操作不可恢复。`)
          if (!ok) return
          await api(`/admin/sources/${row.id}`, { method: 'DELETE' })
          toast('已删除', 'success')
          await refreshAll()
        } else if (btn.dataset.act === 'nodes') {
          await showSourceNodes(row.id, row.name)
        } else if (btn.dataset.act === 'edit') {
          openSourceModal(row)
        }
      } catch (e) {
        toast(e.message, 'error')
      }
    }
  })
}

function openSourceModal(row) {
  $('modal-source-title').textContent = row ? '编辑订阅源' : '添加订阅源'
  $('src-id').value = row?.id || ''
  $('src-name').value = row?.name || ''
  const acc =
    row?.access === 'locked' || row?.tier === 'paid' ? 'locked' : 'public'
  $('src-tier').value = acc
  $('src-url').value = row?.url || ''
  if ($('src-proxy')) $('src-proxy').value = row?.fetch_proxy || ''
  if ($('src-ua')) $('src-ua').value = row?.fetch_ua || ''
  $('src-yaml').value = row?.inline_yaml || ''
  $('src-notes').value = row?.notes || ''
  setError('modal-source-error', '')
  $('modal-nodes').classList.add('hidden')
  $('modal-nodes-body').innerHTML = ''
  openModal('modal-source')
}

async function loadCoupons() {
  if (!$('coupons-body')) return
  const { items } = await api('/admin/coupons')
  const body = $('coupons-body')
  if (!items.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">暂无兑换码</td></tr>`
    return
  }
  body.innerHTML = items
    .map((c) => {
      const st =
        c.status === 'disabled'
          ? '<span class="badge off">停用</span>'
          : '<span class="badge ok">有效</span>'
      const usage =
        c.max_uses > 0
          ? `${c.used_count}/${c.max_uses}`
          : `${c.used_count}/∞`
      return `<tr>
        <td class="mono"><strong>${escapeHtml(c.code)}</strong>
          <span class="cell-sub">${escapeHtml(c.note || '')}</span></td>
        <td>${escapeHtml(c.product_name)} · ${c.days || '—'} 天</td>
        <td class="mono">${usage}</td>
        <td>${st}</td>
        <td class="mono">${c.expire_at ? fmtTime(c.expire_at) : '不过期'}</td>
        <td class="col-actions">
          <div class="actions">
            <button type="button" class="btn btn-sm btn-ghost" data-act="toggle" data-id="${c.id}" data-status="${c.status}">
              ${c.status === 'active' ? '停用' : '启用'}
            </button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="del" data-id="${c.id}">删除</button>
          </div>
        </td>
      </tr>`
    })
    .join('')

  body.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async () => {
      try {
        if (btn.dataset.act === 'del') {
          const ok = await confirmDialog('删除兑换码', '确定删除该兑换码？')
          if (!ok) return
          await api(`/admin/coupons/${btn.dataset.id}`, { method: 'DELETE' })
          toast('已删除', 'success')
        } else if (btn.dataset.act === 'toggle') {
          const next = btn.dataset.status === 'active' ? 'disabled' : 'active'
          await api(`/admin/coupons/${btn.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: next }),
          })
          toast(next === 'active' ? '已启用' : '已停用', 'success')
        }
        await loadCoupons()
      } catch (e) {
        toast(e.message, 'error')
      }
    }
  })
}

function fillCouponProductSelect() {
  const sel = $('cp-product')
  if (!sel) return
  const sellable = (state.plans || []).filter(
    (p) => p.kind !== 'system' && p.name !== 'trial' && p.for_sale !== false,
  )
  sel.innerHTML = sellable
    .map(
      (p) =>
        `<option value="${p.id}">${escapeHtml(p.name)} · ¥${((p.price_cents || 0) / 100).toFixed(2)}</option>`,
    )
    .join('')
}

async function loadPlans() {
  const { items } = await api('/admin/plans')
  state.plans = items
  const body = $('plans-body')
  if (!items.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">暂无商品</td></tr>`
    return
  }
  body.innerHTML = items
    .map((p) => {
      const isSys = p.kind === 'system' || p.name === 'trial'
      const price =
        Number(p.price_cents || 0) <= 0
          ? '免费'
          : `¥${(Number(p.price_cents) / 100).toFixed(2)}`
      const saleBadge = isSys
        ? '<span class="badge neutral">系统</span>'
        : p.for_sale === false
          ? '<span class="badge off">下架</span>'
          : '<span class="badge ok">在售</span>'
      const srcDetail = isSys
        ? '不绑定源（不解锁节点）'
        : p.source_name
          ? `${p.source_name}${
              p.source_access === 'locked' || p.source_tier === 'paid'
                ? ' · 需解锁'
                : ' · 公开'
            }${p.source_has_inline ? ' · YAML' : p.source_url ? '' : ' · 未配置'}`
          : '未绑定'
      return `<tr>
      <td>
        <span class="cell-title">${escapeHtml(p.name)}</span>
        <span class="cell-sub">${
          isSys
            ? '账号有效期模板'
            : Number(p.price_cents || 0) <= 0
              ? '客户端 · 免费专区商品'
              : '客户端 · 付费商品'
        }</span>
      </td>
      <td>
        <span class="cell-title">${isSys ? '—' : price}</span>
        <div style="margin-top:6px">${saleBadge}</div>
      </td>
      <td>
        <span class="cell-title">${escapeHtml(srcDetail)}</span>
        <span class="cell-sub mono">${escapeHtml(isSys ? '' : p.source_url || '')}</span>
      </td>
      <td>${p.duration_days || p.trial_days || 30} 天</td>
      <td>${
        isSys
          ? '—'
          : Number(p.traffic_bytes || 0) > 0
            ? `${Math.round((Number(p.traffic_bytes) / (1024 * 1024 * 1024)) * 10) / 10} GB`
            : '<span class="badge warn">不限流量</span>'
      }</td>
      <td>${escapeHtml(p.description || '—')}</td>
      <td class="col-actions">
        <div class="actions">
          ${
            isSys
              ? `<button type="button" class="btn btn-sm btn-secondary" data-act="edit" data-id="${p.id}">查看</button>`
              : `<button type="button" class="btn btn-sm btn-ghost" data-act="sale" data-id="${p.id}" data-sale="${
                  p.for_sale === false ? '0' : '1'
                }">${p.for_sale === false ? '上架' : '下架'}</button>
                 <button type="button" class="btn btn-sm btn-secondary" data-act="edit" data-id="${p.id}">编辑</button>
                 <button type="button" class="btn btn-sm btn-ghost" data-act="del" data-id="${p.id}">删除</button>`
          }
        </div>
      </td>
    </tr>`
    })
    .join('')

  body.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async () => {
      const p = items.find((x) => x.id === btn.dataset.id)
      try {
        if (btn.dataset.act === 'edit') {
          openPlanModal(p)
        } else if (btn.dataset.act === 'sale') {
          const next = btn.dataset.sale === '1' ? false : true
          await api(`/admin/plans/${p.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ for_sale: next }),
          })
          toast(next ? '已上架' : '已下架', 'success')
          await refreshAll()
        } else if (btn.dataset.act === 'del') {
          const ok = await confirmDialog('删除商品', `确认删除「${p.name}」？已购用户历史记录仍保留。`)
          if (!ok) return
          await api(`/admin/plans/${p.id}`, { method: 'DELETE' })
          toast('已删除', 'success')
          await refreshAll()
        }
      } catch (e) {
        toast(e.message, 'error')
      }
    }
  })
}

async function loadAnnouncements() {
  const { items } = await api('/admin/announcements')
  const body = $('ann-body')
  if (!items.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">暂无公告</td></tr>`
    return
  }
  body.innerHTML = items
    .map((a) => {
      const active = a.active !== false
      return `<tr>
        <td><span class="cell-title">${escapeHtml(a.title)}</span></td>
        <td><span class="cell-sub" style="margin:0;max-width:360px;display:block;white-space:pre-wrap">${escapeHtml(
          a.body || '',
        )}</span></td>
        <td>${
          active
            ? '<span class="badge ok">发布中</span>'
            : '<span class="badge off">已下架</span>'
        }</td>
        <td class="mono">${fmtTime(a.created_at)}</td>
        <td class="col-actions">
          <div class="actions">
            <button type="button" class="btn btn-sm btn-ghost" data-act="toggle" data-id="${a.id}" data-active="${
              active ? '1' : '0'
            }">${active ? '下架' : '发布'}</button>
            <button type="button" class="btn btn-sm btn-secondary" data-act="edit" data-id="${a.id}">编辑</button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="del" data-id="${a.id}">删除</button>
          </div>
        </td>
      </tr>`
    })
    .join('')

  body.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async () => {
      const row = items.find((x) => x.id === btn.dataset.id)
      try {
        if (btn.dataset.act === 'edit') {
          openAnnModal(row)
        } else if (btn.dataset.act === 'toggle') {
          await api(`/admin/announcements/${row.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ active: btn.dataset.active !== '1' }),
          })
          toast('已更新', 'success')
          await loadAnnouncements()
          await loadStats()
        } else if (btn.dataset.act === 'del') {
          const ok = await confirmDialog('删除公告', `确认删除「${row.title}」？`)
          if (!ok) return
          await api(`/admin/announcements/${row.id}`, { method: 'DELETE' })
          toast('已删除', 'success')
          await loadAnnouncements()
          await loadStats()
        }
      } catch (e) {
        toast(e.message, 'error')
      }
    }
  })
}

function openAnnModal(row) {
  $('ann-modal-title').textContent = row ? '编辑公告' : '发布公告'
  $('ann-id').value = row?.id || ''
  $('ann-title').value = row?.title || ''
  $('ann-body').value = row?.body || ''
  $('ann-active').value = row && row.active === false ? '0' : '1'
  setError('ann-error', '')
  openModal('modal-ann')
}

function openPlanModal(row) {
  state.planMode = row ? 'edit' : 'create'
  const isSys = row && (row.kind === 'system' || row.name === 'trial')
  $('modal-plan-title').textContent = row
    ? isSys
      ? `系统项 · ${row.name}`
      : `编辑商品 · ${row.name}`
    : '新建商品（价格 0 = 免费专区）'
  $('plan-id').value = row?.id || ''
  $('plan-name').value = row?.name || ''
  $('plan-name').disabled = Boolean(isSys)
  // default 0 so new free products land in 免费专区; edit keeps existing
  $('plan-price').value = row ? ((row.price_cents || 0) / 100).toFixed(2) : '0'
  $('plan-price').disabled = Boolean(isSys)
  $('plan-days').value = row?.duration_days || row?.trial_days || 30
  // traffic: bytes → GB for form (0 = unlimited). New product default 100 GB.
  const tb = Number(row?.traffic_bytes || 0)
  $('plan-traffic-gb').value = row
    ? tb > 0
      ? Math.round((tb / (1024 * 1024 * 1024)) * 1000) / 1000
      : 0
    : 100
  $('plan-traffic-gb').disabled = Boolean(isSys)
  if ($('plan-traffic-reset')) {
    $('plan-traffic-reset').value = row?.traffic_reset === 'monthly' ? 'monthly' : 'never'
    $('plan-traffic-reset').disabled = Boolean(isSys)
  }
  $('plan-desc').value = row?.description || ''
  $('plan-sale').value = row && row.for_sale === false ? '0' : '1'
  $('plan-sale').disabled = Boolean(isSys)
  // all sources: free product can bind locked line (free unlock) or public line
  fillSourceSelect($('plan-source'), row?.source_id || '', false)
  $('plan-source').disabled = Boolean(isSys)
  setError('modal-plan-error', '')
  openModal('modal-plan')
}

async function savePlanModal() {
  setError('modal-plan-error', '')
  try {
    const gb = Number($('plan-traffic-gb')?.value || 0)
    const traffic_bytes =
      !Number.isFinite(gb) || gb <= 0 ? 0 : Math.floor(gb * 1024 * 1024 * 1024)
    const payload = {
      name: $('plan-name').value.trim(),
      source_id: $('plan-source').value || null,
      trial_days: Number($('plan-days').value || 30),
      price_cents: Math.round(Number($('plan-price').value || 0) * 100),
      for_sale: $('plan-sale').value === '1',
      description: $('plan-desc').value.trim(),
      traffic_bytes,
      traffic_reset: $('plan-traffic-reset')?.value || 'never',
    }
    if (!payload.name) throw new Error('请填写商品名')
    const id = $('plan-id').value
    if (id) {
      await api(`/admin/plans/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      toast('商品已更新', 'success')
    } else {
      if (!payload.source_id) throw new Error('请绑定订阅源')
      await api('/admin/plans', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      toast('商品已创建', 'success')
    }
    closeModal('modal-plan')
    await refreshAll()
  } catch (e) {
    setError('modal-plan-error', e.message)
  }
}

async function loadSettings() {
  const s = await api('/admin/settings')
  $('set-product').value = s.product_name || 'Fork'
  $('set-register').value = s.allow_register || '1'
  $('set-default-plan').value = s.default_plan || 'trial'
  if ($('set-max-devices')) $('set-max-devices').value = s.max_devices ?? 3
  if ($('set-invite-on')) $('set-invite-on').value = s.invite_enabled === '0' ? '0' : '1'
  if ($('set-invite-days')) $('set-invite-days').value = s.invite_reward_days ?? 3
  if ($('set-invite-traffic')) $('set-invite-traffic').value = s.invite_reward_traffic_gb ?? 5
  if ($('set-invitee-days')) $('set-invitee-days').value = s.invitee_reward_days ?? 1
  if ($('set-invitee-traffic')) $('set-invitee-traffic').value = s.invitee_reward_traffic_gb ?? 1
  if ($('set-checkin-on')) $('set-checkin-on').value = s.checkin_enabled === '0' ? '0' : '1'
  if ($('set-checkin-free-days'))
    $('set-checkin-free-days').value = s.checkin_free_days ?? s.checkin_reward_days ?? 0
  if ($('set-checkin-free-gb'))
    $('set-checkin-free-gb').value = s.checkin_free_traffic_gb ?? s.checkin_reward_traffic_gb ?? 1
  if ($('set-checkin-paid-days'))
    $('set-checkin-paid-days').value = s.checkin_paid_days ?? s.checkin_reward_days ?? 1
  if ($('set-checkin-paid-gb'))
    $('set-checkin-paid-gb').value = s.checkin_paid_traffic_gb ?? 2
  if ($('set-checkin-paid-free-gb'))
    $('set-checkin-paid-free-gb').value = s.checkin_paid_extra_free_gb ?? 0
  if ($('set-checkin-streaks')) {
    const st = s.checkin_streaks
    $('set-checkin-streaks').value =
      typeof st === 'string' ? st : st ? JSON.stringify(st) : '[]'
  }
  if ($('set-support-tg')) $('set-support-tg').value = s.support_tg || 'https://t.me/forkdl'
  if ($('set-paid-unlim'))
    $('set-paid-unlim').value = s.allow_paid_unlimited_traffic === '1' ? '1' : '0'
  const u = s.client_update || {}
  if ($('upd-enabled')) {
    $('upd-enabled').value = u.enabled === false ? '0' : '1'
    $('upd-mode').value = u.mode === 'force' ? 'force' : u.mode === 'off' ? 'off' : 'optional'
    $('upd-ver').value = u.latest_version || ''
    $('upd-title').value = u.title || '发现新版本'
    $('upd-body').value = u.body || ''
    const win = (u.platforms && u.platforms['windows-x86_64']) || {}
    if ($('upd-win-url')) $('upd-win-url').value = win.url || u.windows_url || ''
    if ($('upd-win-sig')) $('upd-win-sig').value = win.signature || u.windows_signature || ''
  }
}

async function loadOps() {
  await Promise.all([loadBackups(), loadAudit()])
  // health is on-demand via button
}

function orderStatusBadge(status) {
  const map = {
    paid: ['ok', '已支付'],
    pending: ['warn', '待支付'],
    pending_payment: ['warn', '待支付'],
    refunded: ['off', '已退款'],
    cancelled: ['neutral', '已取消'],
    expired: ['neutral', '已过期'],
  }
  const [cls, label] = map[status] || ['neutral', status || '—']
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`
}

function orderKindLabel(kind) {
  return kind === 'balance_topup' ? '余额充值' : '套餐'
}

async function loadOrdersAdmin() {
  if (!$('orders-body')) return
  const { items } = await api('/admin/orders')
  const body = $('orders-body')
  if (!items?.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">暂无订单</td></tr>`
    return
  }
  body.innerHTML = items
    .map((o) => {
      const yuan = ((o.money_cents || 0) / 100).toFixed(2)
      const bal =
        o.balance_applied_cents > 0
          ? `余额抵 ¥${((o.balance_applied_cents || 0) / 100).toFixed(2)}`
          : ''
      const pay = o.pay_type ? `支付 ${o.pay_type}` : ''
      return `<tr>
        <td><span class="cell-title">${escapeHtml(o.username || '')}</span>
          <span class="cell-sub mono">${escapeHtml(o.out_trade_no || o.id)}</span></td>
        <td><span class="cell-title">${escapeHtml(orderKindLabel(o.order_kind))} · ${escapeHtml(o.product_name || '')}</span>
          <span class="cell-sub">${escapeHtml([bal, pay].filter(Boolean).join(' · ') || '—')}</span></td>
        <td class="mono">¥${yuan}</td>
        <td>${orderStatusBadge(o.status)}
          <span class="cell-sub">${o.trade_no ? '渠道 ' + escapeHtml(o.trade_no) : ''}</span></td>
        <td class="mono"><span class="cell-title" style="font-size:12px">下单 ${fmtTime(o.created_at)}</span>
          <span class="cell-sub">${o.paid_at ? '支付 ' + fmtTime(o.paid_at) : o.refunded_at ? '退款 ' + fmtTime(o.refunded_at) : ''}</span></td>
        <td class="col-actions"><div class="actions">
          ${
            o.status === 'pending' || o.status === 'pending_payment' || o.status === 'paid'
              ? `<button type="button" class="btn btn-sm btn-ghost" data-act="refund" data-id="${o.id}" data-status="${o.status}" data-kind="${o.order_kind || ''}">${
                  o.status === 'paid' ? '退款' : '取消'
                }</button>`
              : '—'
          }
        </div></td>
      </tr>`
    })
    .join('')
  body.querySelectorAll('button[data-act="refund"]').forEach((btn) => {
    btn.onclick = async () => {
      const paid = btn.dataset.status === 'paid'
      const topup = btn.dataset.kind === 'balance_topup'
      const ok = await confirmDialog(
        paid ? (topup ? '撤销充值' : '退款到余额') : '取消订单',
        paid
          ? topup
            ? '将扣回用户已到账余额（不做渠道原路退款）。'
            : '将撤销该订单权益，并把订单金额退回用户站内余额（不做支付渠道原路退款）。'
          : '确认取消未支付订单？预扣余额会退回。',
      )
      if (!ok) return
      try {
        const r = await api(`/admin/orders/${btn.dataset.id}/refund`, {
          method: 'POST',
          body: JSON.stringify({ note: 'admin' }),
        })
        if (paid) {
          if (topup) {
            toast(`已扣回余额 ¥${((Number(r.balance_clawback_cents) || 0) / 100).toFixed(2)}`, 'success')
          } else {
            const yuan = ((Number(r.balance_credited_cents) || 0) / 100).toFixed(2)
            toast(`已退款到余额 ¥${yuan}，权益已撤销`, 'success')
          }
        } else {
          toast('已取消', 'success')
        }
        await loadOrdersAdmin()
      } catch (e) {
        toast(e.message, 'error')
      }
    }
  })
}

async function loadTicketsAdmin() {
  if (!$('tickets-body')) return
  const st = $('ticket-filter-status')?.value || ''
  const q = st ? `?status=${encodeURIComponent(st)}` : ''
  const { items } = await api('/admin/tickets' + q)
  const body = $('tickets-body')
  if (!items?.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">暂无工单</td></tr>`
    return
  }
  const cat = { payment: '支付', traffic: '流量', account: '账号', connection: '连接', other: '其他' }
  const stMap = {
    open: ['warn', '待处理'],
    replied: ['ok', '已回复'],
    closed: ['neutral', '已关闭'],
  }
  body.innerHTML = items
    .map((t) => {
      const [cls, label] = stMap[t.status] || ['neutral', t.status]
      const last = t.last_message?.body || ''
      return `<tr>
        <td><span class="cell-title">${escapeHtml(t.username || '')}</span>
          <span class="cell-sub mono">${escapeHtml(t.id)}</span></td>
        <td><span class="cell-title">${escapeHtml(t.subject || '')}</span>
          <span class="cell-sub">${escapeHtml(cat[t.category] || t.category || '')} · ${escapeHtml(last)}</span></td>
        <td><span class="badge ${cls}">${escapeHtml(label)}</span></td>
        <td class="mono">${fmtTime(t.updated_at || t.created_at)}</td>
        <td class="col-actions"><div class="actions">
          <button type="button" class="btn btn-sm btn-secondary" data-act="view" data-id="${t.id}">处理</button>
        </div></td>
      </tr>`
    })
    .join('')
  body.querySelectorAll('button[data-act="view"]').forEach((btn) => {
    btn.onclick = () => void openTicketAdmin(btn.dataset.id)
  })
}

async function openTicketAdmin(id) {
  try {
    const { ticket } = await api(`/admin/tickets/${id}`)
    const msgs = (ticket.messages || [])
      .map(
        (m) =>
          `[${m.role === 'admin' ? '客服' : '用户'} ${fmtTime(m.at)}] ${m.author || ''}\n${m.body}`,
      )
      .join('\n\n')
    const reply = prompt(
      `工单：${ticket.subject}\n用户：${ticket.username}\n状态：${ticket.status}\n\n--- 对话 ---\n${msgs}\n\n输入回复（取消=不回复；输入 close 关闭工单）：`,
      '',
    )
    if (reply == null) return
    if (String(reply).trim().toLowerCase() === 'close') {
      await api(`/admin/tickets/${id}/close`, { method: 'POST', body: '{}' })
      toast('工单已关闭', 'success')
    } else if (String(reply).trim()) {
      await api(`/admin/tickets/${id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body: reply.trim() }),
      })
      toast('已回复', 'success')
    }
    await loadTicketsAdmin()
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function loadBackups() {
  if (!$('backup-body')) return
  const { items } = await api('/admin/backups')
  const body = $('backup-body')
  if (!items?.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="4">暂无备份</td></tr>`
    return
  }
  body.innerHTML = items
    .slice(0, 20)
    .map(
      (b) => `<tr>
      <td class="mono">${escapeHtml(b.name)}</td>
      <td>${Math.round((b.bytes || 0) / 1024)} KB</td>
      <td class="mono">${fmtTime(b.mtime)}</td>
      <td class="col-actions"><button type="button" class="btn btn-sm btn-ghost" data-name="${escapeHtml(
        b.name,
      )}">恢复</button></td>
    </tr>`,
    )
    .join('')
  body.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async () => {
      const ok = await confirmDialog('恢复备份', `将用 ${btn.dataset.name} 覆盖当前数据，先自动再备份一份。`)
      if (!ok) return
      try {
        await api('/admin/backups/restore', {
          method: 'POST',
          body: JSON.stringify({ name: btn.dataset.name }),
        })
        toast('已恢复', 'success')
        await refreshAll()
      } catch (e) {
        toast(e.message, 'error')
      }
    }
  })
}

async function loadAudit() {
  if (!$('audit-body')) return
  const { items } = await api('/admin/audit?limit=80')
  const body = $('audit-body')
  if (!items?.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="4">暂无日志</td></tr>`
    return
  }
  body.innerHTML = items
    .map(
      (a) => `<tr>
      <td class="mono">${fmtTime(a.at)}</td>
      <td>${escapeHtml(a.actor || '')}<span class="cell-sub">${escapeHtml(a.actor_type || '')}</span></td>
      <td class="mono">${escapeHtml(a.action || '')}</td>
      <td class="mono">${escapeHtml(String(a.target || '').slice(0, 40))}</td>
    </tr>`,
    )
    .join('')
}

async function loadInvitesAdmin() {
  if (!$('invites-body')) return
  const { items } = await api('/admin/invites')
  const body = $('invites-body')
  if (!items?.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="3">暂无运营邀请码</td></tr>`
    return
  }
  body.innerHTML = items
    .map(
      (c) => `<tr>
      <td class="mono">${escapeHtml(c.code)}</td>
      <td>${c.used_count || 0}${c.max_uses ? ' / ' + c.max_uses : ' / ∞'}</td>
      <td>${escapeHtml(c.note || '—')}</td>
    </tr>`,
    )
    .join('')
}

async function refreshAll() {
  await loadStats()
  await loadSources()
  await loadPlans()
  await loadUsers()
  await loadAnnouncements()
  await loadSettings()
  if (state.tab === 'coupons') await loadCoupons()
  if (state.tab === 'orders') await loadOrdersAdmin()
  if (state.tab === 'tickets') await loadTicketsAdmin()
  if (state.tab === 'invites') await loadInvitesAdmin()
  if (state.tab === 'ops') await loadOps()
}

if ($('btn-create-coupon')) {
  $('btn-create-coupon').onclick = async () => {
    try {
      fillCouponProductSelect()
      const product_id = $('cp-product').value
      if (!product_id) throw new Error('请先创建可售商品')
      const days = Number($('cp-days').value || 0)
      const body = {
        product_id,
        days: days > 0 ? days : undefined,
        max_uses: Number($('cp-max').value || 1),
        count: Number($('cp-count').value || 1),
        code: $('cp-code').value.trim() || undefined,
        expire_days: Number($('cp-expire-days').value || 0) || undefined,
        note: $('cp-note').value.trim(),
      }
      const r = await api('/admin/coupons', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const codes = (r.items || []).map((x) => x.code).join(', ')
      $('cp-result').textContent = `已生成 ${r.items?.length || 0} 个：${codes}`
      toast('兑换码已生成', 'success')
      await loadCoupons()
    } catch (e) {
      toast(e.message, 'error')
    }
  }
}
if ($('btn-refresh-coupons')) {
  $('btn-refresh-coupons').onclick = () => void loadCoupons()
}

// ---------- Events ----------
$('login-form').onsubmit = async (e) => {
  e.preventDefault()
  setError('login-error', '')
  try {
    const data = await api('/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('admin-user').value.trim(),
        password: $('admin-pass').value,
      }),
    })
    state.token = data.token
    state.username = data.username
    localStorage.setItem('fork_admin_token', state.token)
    localStorage.setItem('fork_admin_user', state.username)
    showMain()
    switchTab('overview')
    await refreshAll()
    toast('登录成功', 'success')
  } catch (err) {
    setError('login-error', err.message)
  }
}

$('btn-logout').onclick = () => {
  state.token = ''
  localStorage.removeItem('fork_admin_token')
  localStorage.removeItem('fork_admin_user')
  showLogin()
}

$('btn-refresh').onclick = async () => {
  try {
    await refreshAll()
    toast('已刷新', 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

document.querySelectorAll('.nav-item').forEach((b) => {
  b.onclick = () => switchTab(b.dataset.tab)
})

document.querySelectorAll('[data-goto]').forEach((b) => {
  b.onclick = () => switchTab(b.dataset.goto)
})

document.querySelectorAll('[data-close]').forEach((b) => {
  b.onclick = () => closeModal(b.dataset.close)
})

document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m) closeModal(m.id)
  })
})

$('btn-confirm-ok').onclick = () => {
  if (state.confirmResolver) {
    state.confirmResolver(true)
    state.confirmResolver = null
  }
  closeModal('modal-confirm')
}

$('btn-create-user').onclick = openCreateUserModal
$('btn-save-user').onclick = saveUserModal
$('btn-create-source').onclick = () => openSourceModal(null)
$('btn-create-plan').onclick = () => openPlanModal(null)
$('btn-save-plan').onclick = savePlanModal
$('btn-close-nodes').onclick = () => $('nodes-panel').classList.add('hidden')
$('btn-create-ann').onclick = () => openAnnModal(null)

if ($('user-search')) {
  $('user-search').oninput = () => {
    const q = ($('user-search').value || '').trim().toLowerCase()
    const filtered = q
      ? usersCache.filter((u) => (u.username || '').toLowerCase().includes(q))
      : usersCache
    renderUsersTable(filtered)
  }
}

$('btn-ud-save').onclick = async () => {
  setError('ud-error', '')
  try {
    const id = $('ud-id').value
    const payload = {
      status: $('ud-status').value,
    }
    const pw = $('ud-pass').value.trim()
    if (pw) payload.password = pw
    await api(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    toast('用户已保存', 'success')
    closeModal('modal-user-detail')
    await refreshAll()
  } catch (e) {
    setError('ud-error', e.message)
  }
}

$('btn-ud-delete').onclick = async () => {
  const id = $('ud-id').value
  const name = $('ud-name').value
  const ok = await confirmDialog('删除用户', `确认删除用户「${name}」？不可恢复。`)
  if (!ok) return
  try {
    await api(`/admin/users/${id}`, { method: 'DELETE' })
    toast('已删除用户', 'success')
    closeModal('modal-user-detail')
    await refreshAll()
  } catch (e) {
    toast(e.message, 'error')
  }
}

$('btn-ud-grant').onclick = () => {
  const id = $('ud-id').value
  const u = usersCache.find((x) => x.id === id)
  closeModal('modal-user-detail')
  openGrantModal(u)
}

$('btn-save-ann').onclick = async () => {
  setError('ann-error', '')
  try {
    const payload = {
      title: $('ann-title').value.trim(),
      body: $('ann-body').value,
      active: $('ann-active').value === '1',
    }
    if (!payload.title) throw new Error('请填写标题')
    const id = $('ann-id').value
    if (id) {
      await api(`/admin/announcements/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    } else {
      await api('/admin/announcements', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    }
    closeModal('modal-ann')
    toast('公告已保存', 'success')
    await loadAnnouncements()
    await loadStats()
  } catch (e) {
    setError('ann-error', e.message)
  }
}

$('btn-change-admin-pw').onclick = async () => {
  try {
    const old_password = $('adm-old').value
    const new_password = $('adm-new').value
    const n2 = $('adm-new2').value
    if (new_password !== n2) throw new Error('两次新密码不一致')
    await api('/admin/change-password', {
      method: 'POST',
      body: JSON.stringify({ old_password, new_password }),
    })
    $('adm-old').value = ''
    $('adm-new').value = ''
    $('adm-new2').value = ''
    toast('管理员密码已修改', 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

$('btn-preview').onclick = async () => {
  setError('modal-source-error', '')
  try {
    const data = await api('/admin/sources/preview', {
      method: 'POST',
      body: JSON.stringify({
        id: $('src-id').value || undefined,
        name: $('src-name').value,
        url: $('src-url').value,
        inline_yaml: $('src-yaml').value,
        fetch_proxy: $('src-proxy')?.value || '',
        fetch_ua: $('src-ua')?.value || '',
      }),
    })
    $('modal-nodes').classList.remove('hidden')
    const body = $('modal-nodes-body')
    const nodes = data.nodes || []
    body.innerHTML = nodes.length
      ? nodes
          .slice(0, 100)
          .map(
            (n) => `<tr>
          <td>${escapeHtml(n.name)}</td>
          <td>${escapeHtml(n.type)}</td>
          <td class="mono">${escapeHtml(n.server)}</td>
          <td class="mono">${escapeHtml(n.port)}</td>
        </tr>`,
          )
          .join('')
      : `<tr class="empty-row"><td colspan="4">无节点</td></tr>`
    if (data.error) setError('modal-source-error', data.error)
    else setError('modal-source-error', `解析成功：${nodes.length} 个节点（${data.from}）`, true)
  } catch (e) {
    setError('modal-source-error', e.message)
  }
}

$('btn-save-source').onclick = async () => {
  setError('modal-source-error', '')
  const access = $('src-tier').value === 'locked' || $('src-tier').value === 'paid' ? 'locked' : 'public'
  const payload = {
    name: $('src-name').value.trim() || '未命名',
    access,
    tier: access === 'locked' ? 'paid' : 'free',
    url: $('src-url').value.trim(),
    inline_yaml: $('src-yaml').value,
    notes: $('src-notes').value,
    fetch_proxy: ($('src-proxy')?.value || '').trim(),
    fetch_ua: ($('src-ua')?.value || '').trim(),
  }
  try {
    const id = $('src-id').value
    if (id) {
      await api(`/admin/sources/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    } else {
      await api('/admin/sources', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    }
    closeModal('modal-source')
    toast('订阅源已保存', 'success')
    await refreshAll()
  } catch (e) {
    setError('modal-source-error', e.message)
  }
}

$('btn-save-settings').onclick = async () => {
  try {
    await api('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        product_name: $('set-product').value.trim() || 'Fork',
        allow_register: $('set-register').value,
        default_plan: $('set-default-plan').value.trim() || 'trial',
        max_devices: Number($('set-max-devices')?.value || 3),
        invite_enabled: $('set-invite-on')?.value || '1',
        invite_reward_days: Number($('set-invite-days')?.value || 3),
        invite_reward_traffic_gb: Number($('set-invite-traffic')?.value || 5),
        invitee_reward_days: Number($('set-invitee-days')?.value || 1),
        invitee_reward_traffic_gb: Number($('set-invitee-traffic')?.value || 1),
        checkin_enabled: $('set-checkin-on')?.value || '1',
        checkin_free_days: Number($('set-checkin-free-days')?.value || 0),
        checkin_free_traffic_gb: Number($('set-checkin-free-gb')?.value || 1),
        checkin_paid_days: Number($('set-checkin-paid-days')?.value || 1),
        checkin_paid_traffic_gb: Number($('set-checkin-paid-gb')?.value || 2),
        checkin_paid_extra_free_gb: Number($('set-checkin-paid-free-gb')?.value || 0),
        checkin_streaks: (() => {
          const raw = $('set-checkin-streaks')?.value?.trim() || '[]'
          try {
            JSON.parse(raw)
            return raw
          } catch {
            throw new Error('连签奖励 JSON 格式错误')
          }
        })(),
        // legacy aliases
        checkin_reward_days: Number($('set-checkin-free-days')?.value || 0),
        checkin_reward_traffic_gb: Number($('set-checkin-free-gb')?.value || 1),
        support_tg: $('set-support-tg')?.value.trim() || 'https://t.me/forkdl',
        allow_paid_unlimited_traffic: $('set-paid-unlim')?.value || '0',
      }),
    })
    toast('设置已保存', 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

if ($('btn-health')) {
  $('btn-health').onclick = async () => {
    try {
      const h = await api('/admin/health')
      $('health-out').textContent = (h.checks || [])
        .map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
        .join('\n')
      toast(h.ok ? '健康检查通过' : '存在异常项', h.ok ? 'success' : 'error')
    } catch (e) {
      toast(e.message, 'error')
    }
  }
}
if ($('btn-backup')) {
  $('btn-backup').onclick = async () => {
    try {
      const r = await api('/admin/backups', { method: 'POST', body: '{}' })
      toast('备份完成 ' + (r.name || ''), 'success')
      await loadBackups()
    } catch (e) {
      toast(e.message, 'error')
    }
  }
}
if ($('btn-refresh-orders')) $('btn-refresh-orders').onclick = () => void loadOrdersAdmin()
if ($('btn-refresh-tickets')) $('btn-refresh-tickets').onclick = () => void loadTicketsAdmin()
if ($('ticket-filter-status')) {
  $('ticket-filter-status').onchange = () => void loadTicketsAdmin()
}
if ($('btn-refresh-audit')) $('btn-refresh-audit').onclick = () => void loadAudit()
if ($('btn-create-invite')) {
  $('btn-create-invite').onclick = async () => {
    try {
      const r = await api('/admin/invites', {
        method: 'POST',
        body: JSON.stringify({
          code: $('inv-code')?.value.trim() || undefined,
          max_uses: Number($('inv-max')?.value || 0),
        }),
      })
      toast('邀请码 ' + r.code, 'success')
      if ($('inv-code')) $('inv-code').value = ''
      await loadInvitesAdmin()
    } catch (e) {
      toast(e.message, 'error')
    }
  }
}
if ($('btn-export-orders')) {
  $('btn-export-orders').onclick = async (e) => {
    e.preventDefault()
    try {
      const res = await fetch(API + '/admin/orders/export', {
        headers: { Authorization: 'Bearer ' + state.token },
      })
      if (!res.ok) throw new Error('导出失败')
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'orders.csv'
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (err) {
      toast(err.message, 'error')
    }
  }
}

if ($('btn-save-update')) {
  $('btn-save-update').onclick = async () => {
    try {
      await api('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          client_update: {
            enabled: $('upd-enabled').value === '1',
            mode: $('upd-mode').value,
            latest_version: $('upd-ver').value.trim(),
            title: $('upd-title').value.trim() || '发现新版本',
            body: $('upd-body').value,
            pub_date: new Date().toISOString(),
            platforms: {
              'windows-x86_64': {
                url: ($('upd-win-url') && $('upd-win-url').value.trim()) || '',
                signature: ($('upd-win-sig') && $('upd-win-sig').value.trim()) || '',
              },
            },
          },
        }),
      })
      toast('更新策略已保存（客户端将自动下载安装）', 'success')
      await loadSettings()
    } catch (e) {
      toast(e.message, 'error')
    }
  }
}

// Check if plan PATCH supports full payload - need to verify routes
;(async () => {
  if (!state.token) {
    showLogin()
    return
  }
  try {
    showMain()
    switchTab('overview')
    await refreshAll()
  } catch {
    showLogin()
  }
})()
