import { nowTs } from './db.js'
import { ensureUserInviteCode, normalizeInvite } from './invites.js'
import { grantActivityReward } from './activityRewards.js'
import { isPaidUser } from './traffic.js'

export function getInviteConfig(settings = {}) {
  const enabled = String(settings.invite_enabled ?? '1') === '1'
  const reward_days = Math.max(0, Math.floor(Number(settings.invite_reward_days ?? 3)))
  // inviter: free + paid traffic
  const reward_free_traffic_gb = Math.max(
    0,
    Number(settings.invite_reward_free_traffic_gb ?? settings.invite_reward_traffic_gb ?? 0),
  )
  const reward_paid_traffic_gb = Math.max(
    0,
    Number(settings.invite_reward_paid_traffic_gb ?? 5),
  )
  const invitee_days = Math.max(0, Math.floor(Number(settings.invitee_reward_days ?? 1)))
  const invitee_free_traffic_gb = Math.max(
    0,
    Number(settings.invitee_reward_free_traffic_gb ?? settings.invitee_reward_traffic_gb ?? 1),
  )
  const invitee_paid_traffic_gb = Math.max(0, Number(settings.invitee_reward_paid_traffic_gb ?? 0))

  return {
    enabled,
    reward_days,
    reward_free_traffic_gb,
    reward_paid_traffic_gb,
    reward_traffic_gb: reward_paid_traffic_gb || reward_free_traffic_gb,
    invitee_days,
    invitee_free_traffic_gb,
    invitee_paid_traffic_gb,
    invitee_traffic_gb: invitee_free_traffic_gb || invitee_paid_traffic_gb,
  }
}

export function applyInviteRewards(data, newUser, inviteCodeRaw) {
  const cfg = getInviteConfig(data.settings || {})
  if (!cfg.enabled) {
    if (inviteCodeRaw) throw new Error('邀请活动未开启')
    return null
  }
  const code = normalizeInvite(inviteCodeRaw)
  if (!code) return null

  if (!Array.isArray(data.invite_redemptions)) data.invite_redemptions = []
  if (!Array.isArray(data.invite_codes)) data.invite_codes = []

  let inviter = data.users.find(
    (u) => String(u.invite_code || '').toUpperCase() === code && u.id !== newUser.id,
  )
  let via = 'user'

  if (!inviter) {
    const row = data.invite_codes.find((c) => c.code === code && c.status !== 'disabled')
    if (!row) throw new Error('邀请码无效')
    if (row.max_uses > 0 && (row.used_count || 0) >= row.max_uses) {
      throw new Error('邀请码已达使用上限')
    }
    row.used_count = (row.used_count || 0) + 1
    row.updated_at = nowTs()
    via = 'admin_code'
    if (row.owner_user_id) {
      inviter = data.users.find((u) => u.id === row.owner_user_id)
    }
    newUser.invited_by = row.owner_user_id || 'code:' + row.code
  } else {
    ensureUserInviteCode(inviter)
    newUser.invited_by = inviter.id
  }

  // invitee (new user → free pool mainly)
  grantActivityReward(
    newUser,
    {
      days: cfg.invitee_days,
      trafficBytes: Math.floor(cfg.invitee_free_traffic_gb * 1024 ** 3),
      trafficPool: 'free',
      source: '邀请注册-免费流量',
    },
    data,
  )
  if (cfg.invitee_paid_traffic_gb > 0) {
    grantActivityReward(
      newUser,
      {
        days: 0,
        trafficBytes: Math.floor(cfg.invitee_paid_traffic_gb * 1024 ** 3),
        trafficPool: 'paid',
        source: '邀请注册-付费流量',
      },
      data,
    )
  }

  if (inviter) {
    grantActivityReward(
      inviter,
      {
        days: cfg.reward_days,
        trafficBytes: Math.floor(cfg.reward_free_traffic_gb * 1024 ** 3),
        trafficPool: 'free',
        source: '邀请好友-免费流量',
      },
      data,
    )
    // paid traffic for inviter if they are paid user OR always add to paid pool as stock
    const inviterPaid = isPaidUser(inviter, data)
    if (cfg.reward_paid_traffic_gb > 0) {
      grantActivityReward(
        inviter,
        {
          days: 0,
          trafficBytes: Math.floor(cfg.reward_paid_traffic_gb * 1024 ** 3),
          trafficPool: inviterPaid ? 'paid' : 'paid', // stock paid traffic for when they subscribe
          source: '邀请好友-付费流量',
        },
        data,
      )
    }
    inviter.invite_reward_count = (inviter.invite_reward_count || 0) + 1
    inviter.updated_at = nowTs()
  }

  data.invite_redemptions.push({
    id: `${nowTs()}-${Math.random().toString(36).slice(2, 8)}`,
    code,
    invitee_id: newUser.id,
    inviter_id: inviter?.id || null,
    via,
    created_at: nowTs(),
  })

  return {
    type: via,
    code,
    inviter_id: inviter?.id || null,
    reward_days: cfg.reward_days,
    invitee_days: cfg.invitee_days,
  }
}
