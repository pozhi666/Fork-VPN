import { nowTs } from './db.js'
import { grantActivityReward } from './activityRewards.js'
import { isPaidUser, repairRefundedEntitlements } from './traffic.js'

function utcDayKey(ts = nowTs()) {
  const d = new Date(ts * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * Parse streak rewards from settings.
 * checkin_streaks: JSON array or array
 * [{ days: 7, free_traffic_gb: 1, paid_traffic_gb: 5, reward_days: 1, for: 'all'|'free'|'paid' }]
 */
export function parseStreakRewards(settings = {}) {
  let raw = settings.checkin_streaks
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = []
    }
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map((r) => ({
      days: Math.max(1, Math.floor(Number(r.days) || 0)),
      free_traffic_gb: Math.max(0, Number(r.free_traffic_gb || 0)),
      paid_traffic_gb: Math.max(0, Number(r.paid_traffic_gb || 0)),
      reward_days: Math.max(0, Math.floor(Number(r.reward_days) || 0)),
      for: r.for === 'paid' || r.for === 'free' ? r.for : 'all',
    }))
    .filter((r) => r.days > 0)
    .sort((a, b) => a.days - b.days)
}

export function getCheckinConfig(settings = {}) {
  const enabled = String(settings.checkin_enabled ?? '1') === '1'
  // free user daily
  const free_days = Math.max(0, Math.floor(Number(settings.checkin_free_days ?? settings.checkin_reward_days ?? 0)))
  const free_traffic_gb = Math.max(
    0,
    Number(settings.checkin_free_traffic_gb ?? settings.checkin_reward_traffic_gb ?? 1),
  )
  // paid user daily
  const paid_days = Math.max(
    0,
    Math.floor(Number(settings.checkin_paid_days ?? settings.checkin_reward_days ?? 0)),
  )
  const paid_traffic_gb = Math.max(
    0,
    Number(settings.checkin_paid_traffic_gb ?? settings.checkin_reward_traffic_gb ?? 2),
  )
  // optional: paid user also gets free traffic
  const paid_extra_free_gb = Math.max(0, Number(settings.checkin_paid_extra_free_gb ?? 0))

  return {
    enabled,
    free_days,
    free_traffic_gb,
    free_traffic_bytes: Math.floor(free_traffic_gb * 1024 ** 3),
    paid_days,
    paid_traffic_gb,
    paid_traffic_bytes: Math.floor(paid_traffic_gb * 1024 ** 3),
    paid_extra_free_gb,
    paid_extra_free_bytes: Math.floor(paid_extra_free_gb * 1024 ** 3),
    // legacy aliases for old UI
    reward_days: free_days,
    reward_traffic_gb: free_traffic_gb,
    reward_traffic_bytes: Math.floor(free_traffic_gb * 1024 ** 3),
    streaks: parseStreakRewards(settings),
  }
}

function resolveCheckinData(dataOrSettings) {
  // Full db snapshot has users[]; settings-only objects must not fake empty plans
  // as "full data" (empty array is truthy and broke isPaidUser lookups before).
  if (dataOrSettings && Array.isArray(dataOrSettings.users)) {
    return {
      settings: dataOrSettings.settings || {},
      data: dataOrSettings,
    }
  }
  if (dataOrSettings && Array.isArray(dataOrSettings.plans) && dataOrSettings.plans.length) {
    return {
      settings: dataOrSettings.settings || {},
      data: dataOrSettings,
    }
  }
  const settings = dataOrSettings?.settings
    ? dataOrSettings.settings
    : dataOrSettings || {}
  return {
    settings,
    data: {
      plans: [],
      subscription_sources: [],
      orders: [],
      settings,
    },
  }
}

export function checkinStatus(user, dataOrSettings) {
  const { settings, data } = resolveCheckinData(dataOrSettings)
  // Heal stale paid entitlement before tier decision (refund residual rows)
  if (Array.isArray(data.orders) && data.orders.length) {
    repairRefundedEntitlements(user, data)
  }
  const cfg = getCheckinConfig(settings)
  const today = utcDayKey()
  const last = user.last_checkin_day || ''
  const done_today = last === today
  const paidUser = isPaidUser(user, data)
  const streak = Number(user.checkin_streak || 0)
  const nextStreak = done_today ? streak : last === utcDayKey(nowTs() - 86400) ? streak + 1 : 1

  const daily = paidUser
    ? {
        tier: 'paid',
        reward_days: cfg.paid_days,
        free_traffic_gb: cfg.paid_extra_free_gb,
        paid_traffic_gb: cfg.paid_traffic_gb,
      }
    : {
        tier: 'free',
        reward_days: cfg.free_days,
        free_traffic_gb: cfg.free_traffic_gb,
        paid_traffic_gb: 0,
      }

  // upcoming streak rewards
  const upcoming = cfg.streaks.filter((s) => {
    if (s.for === 'paid' && !paidUser) return false
    if (s.for === 'free' && paidUser) return false
    return s.days > streak
  })

  return {
    enabled: cfg.enabled,
    done_today,
    last_checkin_day: last || null,
    streak,
    next_streak: nextStreak,
    can_checkin: cfg.enabled && !done_today,
    is_paid_user: paidUser,
    daily,
    // legacy fields for old client
    reward_days: daily.reward_days,
    reward_traffic_gb: paidUser ? daily.paid_traffic_gb : daily.free_traffic_gb,
    streaks: cfg.streaks,
    upcoming_streak: upcoming[0] || null,
  }
}

export function doCheckin(user, data) {
  const cfg = getCheckinConfig(data.settings || {})
  if (!cfg.enabled) throw new Error('签到活动未开启')
  const today = utcDayKey()
  if (user.last_checkin_day === today) throw new Error('今日已签到')

  // Same heal as status — never grant paid-tier checkin after refund
  repairRefundedEntitlements(user, data)

  const now = nowTs()
  const yesterday = utcDayKey(now - 86400)
  const streak =
    user.last_checkin_day === yesterday ? Number(user.checkin_streak || 0) + 1 : 1

  user.last_checkin_day = today
  user.checkin_streak = streak
  user.updated_at = now

  const paidUser = isPaidUser(user, data)
  let days = 0
  let freeTb = 0
  let paidTb = 0

  if (paidUser) {
    days = cfg.paid_days
    paidTb = cfg.paid_traffic_bytes
    freeTb = cfg.paid_extra_free_bytes
  } else {
    days = cfg.free_days
    freeTb = cfg.free_traffic_bytes
  }

  // streak milestones hit today
  const streakHits = cfg.streaks.filter((s) => {
    if (s.days !== streak) return false
    if (s.for === 'paid' && !paidUser) return false
    if (s.for === 'free' && paidUser) return false
    return true
  })
  for (const s of streakHits) {
    days += s.reward_days
    freeTb += Math.floor(s.free_traffic_gb * 1024 ** 3)
    paidTb += Math.floor(s.paid_traffic_gb * 1024 ** 3)
  }

  if (days <= 0 && freeTb <= 0 && paidTb <= 0) {
    throw new Error('签到未配置奖励（请在后台分别为普通/付费用户设置）')
  }

  let grantedDays = 0
  let freeAdded = 0
  let paidAdded = 0

  if (days > 0 || freeTb > 0) {
    const g = grantActivityReward(
      user,
      {
        days,
        trafficBytes: freeTb,
        trafficPool: 'free',
        source: paidUser ? '付费用户签到' : '普通用户签到',
      },
      data,
    )
    grantedDays += g.days_added
    freeAdded += g.traffic_added
  }
  if (paidTb > 0) {
    const g = grantActivityReward(
      user,
      {
        days: 0,
        trafficBytes: paidTb,
        trafficPool: 'paid',
        source: paidUser ? '付费用户签到' : '签到-付费流量',
      },
      data,
    )
    paidAdded += g.traffic_added
    if (!grantedDays && g.days_added) grantedDays += g.days_added
  }

  if (!Array.isArray(user.checkin_logs)) user.checkin_logs = []
  user.checkin_logs.unshift({
    day: today,
    streak,
    reward_days: grantedDays,
    free_traffic_bytes: freeAdded,
    paid_traffic_bytes: paidAdded,
    tier: paidUser ? 'paid' : 'free',
    streak_hits: streakHits.map((s) => s.days),
    at: now,
  })
  if (user.checkin_logs.length > 60) user.checkin_logs.length = 60

  return {
    day: today,
    streak,
    reward_days: grantedDays,
    free_traffic_bytes: freeAdded,
    paid_traffic_bytes: paidAdded,
    reward_traffic_bytes: freeAdded + paidAdded,
    tier: paidUser ? 'paid' : 'free',
    message: buildMsg(grantedDays, freeAdded, paidAdded, streak, streakHits),
  }
}

function buildMsg(days, freeTb, paidTb, streak, hits) {
  const parts = [`签到成功 · 连续 ${streak} 天`]
  if (days > 0) parts.push(`+${days} 天`)
  if (freeTb > 0) parts.push(`+免费 ${(freeTb / 1024 ** 3).toFixed(2).replace(/\.?0+$/, '')} GB`)
  if (paidTb > 0) parts.push(`+付费 ${(paidTb / 1024 ** 3).toFixed(2).replace(/\.?0+$/, '')} GB`)
  if (hits?.length) parts.push(`连签奖励×${hits.length}`)
  return parts.join(' · ')
}
