import { nanoid } from 'nanoid'
import { db, nowTs } from './db.js'

const now = nowTs()

db.write((data) => {
  // --- admin: NEVER auto-create default password (Phase 0 security) ---
  // Use: node scripts/bootstrap-admin.mjs
  if (!Array.isArray(data.admins)) data.admins = []
  if (data.admins.length === 0) {
    console.warn(
      '[seed] no admin users — run: node scripts/bootstrap-admin.mjs (BOOTSTRAP_TOKEN required in production)',
    )
  }

  // --- sources: pure node pools; access = public|locked (not free/paid pricing) ---
  for (const s of data.subscription_sources) {
    if (s.name && s.name.includes('演示')) {
      s.name = '公共线路'
      if (!s.notes || s.notes.includes('演示') || s.notes.includes('内置')) {
        s.notes = '公开线路，登录用户同步即可用'
      }
    }
    // migrate tier → access once
    if (!s.access) {
      s.access = s.tier === 'paid' ? 'locked' : 'public'
    }
    // keep tier in sync for compatibility
    s.tier = s.access === 'locked' ? 'paid' : 'free'
  }

  let publicSource = data.subscription_sources.find((s) => s.access === 'public' || s.tier === 'free')
  if (!publicSource) {
    publicSource = {
      id: nanoid(),
      name: '公共线路',
      url: '',
      inline_yaml: '',
      notes: '公开线路，登录用户同步即可用',
      access: 'public',
      tier: 'free',
      created_at: now,
    }
    data.subscription_sources.push(publicSource)
    console.log('created public source scaffold')
  }

  let lockedSource =
    data.subscription_sources.find((s) => s.access === 'locked' || s.tier === 'paid') ||
    data.subscription_sources.find((s) => s.name === '美国')
  if (!lockedSource) {
    lockedSource = {
      id: nanoid(),
      name: '精品线路',
      url: '',
      inline_yaml: '',
      notes: '需通过商品开通后解锁',
      access: 'locked',
      tier: 'paid',
      created_at: now,
    }
    data.subscription_sources.push(lockedSource)
    console.log('created locked source scaffold')
  }
  // for product default bind
  const paidSource = lockedSource

  // --- trial system plan (always system, never for_sale) ---
  let trial = data.plans.find((p) => p.name === 'trial')
  if (!trial) {
    trial = {
      id: nanoid(),
      name: 'trial',
      kind: 'system',
      source_id: null,
      trial_days: 30,
      duration_days: 30,
      traffic_bytes: 0,
      description: '系统账号有效期默认值（不售卖、不解锁节点）',
      price_cents: 0,
      for_sale: false,
      created_at: now,
    }
    data.plans.push(trial)
  } else {
    trial.kind = 'system'
    trial.for_sale = false
    trial.source_id = null
    if (trial.price_cents === undefined) trial.price_cents = 0
  }

  // --- ensure one paid product exists (only when missing) ---
  let monthly = data.plans.find((p) => p.name === '月度会员')
  if (!monthly) {
    monthly = {
      id: nanoid(),
      name: '月度会员',
      kind: 'product',
      source_id: paidSource.id,
      trial_days: 30,
      duration_days: 30,
      traffic_bytes: 0,
      description: '解锁精品线路 30 天',
      price_cents: 1500,
      for_sale: true,
      created_at: now,
    }
    data.plans.push(monthly)
    console.log('created product 月度会员 ¥15')
  }

  // ensure one free-zone product (price 0) when missing
  let freeProd = data.plans.find(
    (p) => p.kind !== 'system' && p.name !== 'trial' && Number(p.price_cents || 0) <= 0 && p.for_sale !== false,
  )
  if (!freeProd) {
    freeProd = {
      id: nanoid(),
      name: '免费体验',
      kind: 'product',
      source_id: publicSource.id,
      trial_days: 7,
      duration_days: 7,
      traffic_bytes: 0,
      description: '免费专区商品 · 绑定公共线路',
      price_cents: 0,
      for_sale: true,
      created_at: now,
    }
    data.plans.push(freeProd)
    console.log('created free-zone product 免费体验')
  }

  // normalize plans WITHOUT flipping for_sale
  for (const p of data.plans) {
    if (p.name === 'trial') {
      p.kind = 'system'
      p.for_sale = false
      p.source_id = null
      continue
    }
    if (!p.kind) p.kind = 'product'
    if (p.duration_days === undefined) {
      p.duration_days = p.trial_days || 30
    }
    // only set default when field truly missing
    if (p.for_sale === undefined || p.for_sale === null) {
      p.for_sale = true
    }
    // do not force for_sale true/false if admin already set it
    if (p.kind === 'product' && !p.source_id) {
      p.source_id = paidSource.id
    }
  }

  // --- remove demo user if any ---
  const demoIdx = data.users.findIndex((u) => u.username === 'demo')
  if (demoIdx >= 0) {
    data.users.splice(demoIdx, 1)
    console.log('removed demo user')
  }

  // --- users: structure only ---
  for (const u of data.users) {
    if (!Array.isArray(u.purchases)) u.purchases = []

    u.purchases = u.purchases.filter((p) => {
      const plan = data.plans.find((x) => x.id === p.product_id)
      if (!plan) return Boolean(p.source_id)
      if (plan.kind === 'system' || plan.name === 'trial') return false
      return true
    })

    for (const p of u.purchases) {
      const plan = data.plans.find((x) => x.id === p.product_id)
      if (plan?.source_id) p.source_id = plan.source_id
      if (plan?.name) p.name = plan.name
    }

    if (u.purchases.length) {
      const last = u.purchases[u.purchases.length - 1]
      u.plan_id = last.product_id || u.plan_id
    } else if (!u.plan_id) {
      u.plan_id = trial.id
    } else {
      // Do NOT auto-grant purchases from plan_id (caused ghost entitlements like "basic").
      // plan_id is display-only; real access only via purchases[] / paid orders.
      const plan = data.plans.find((x) => x.id === u.plan_id)
      if (!plan || plan.kind === 'system') {
        u.plan_id = trial.id
      }
    }
  }

  data.settings.product_name ??= 'Fork'
  data.settings.allow_register ??= '1'
  data.settings.default_plan ??= 'trial'
})

console.log('seed done ->', db.path)
