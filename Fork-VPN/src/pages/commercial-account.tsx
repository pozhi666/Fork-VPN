import {
  AccountCircleRounded,
  CardGiftcardRounded,
  DevicesRounded,
  EmailRounded,
  EventAvailableRounded,
  GroupAddRounded,
  DeleteForeverRounded,
  LockResetRounded,
  LogoutRounded,
  ReceiptLongRounded,
  RefreshRounded,
  ShoppingCartCheckoutRounded,
  SpeedRounded,
  SupportAgentRounded,
  SyncRounded,
  WorkspacePremiumRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Grid,
  LinearProgress,
  Link,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { open } from '@tauri-apps/plugin-shell'
import { useLockFn } from 'ahooks'
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { Navigate, useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { SectionLabel, SurfaceCard } from '@/components/base/surface-card'
import { PRODUCT_NAME } from '@/config/commercial'
import { useAuth } from '@/providers/auth-provider'
import {
  commercialBalancePacks,
  commercialBalanceTopup,
  commercialChangeEmail,
  commercialChangePassword,
  commercialCheckinStatus,
  commercialCloseTicket,
  commercialCreateTicket,
  commercialDeleteAccount,
  commercialDeleteAccountSendCode,
  commercialDoCheckin,
  commercialGetProfile,
  commercialGetTicket,
  commercialInviteInfo,
  commercialListOrders,
  commercialListTickets,
  commercialRedeemCoupon,
  commercialRemoveDevice,
  commercialReplyTicket,
  commercialWaitOrderPaid,
  getOrCreateDeviceId,
  setTrafficPoolHint,
  type BalancePack,
  type CheckinStatus,
  type DeviceInfo,
  type InviteInfo,
  type OrderListItem,
  type ProfilePurchase,
  type TicketItem,
  type UserProfile,
} from '@/services/commercial'
import { notifyEntitlementUpdated } from '@/components/home/home-profile-card'
import { showNotice } from '@/services/notice-service'

function formatTs(ts?: number) {
  if (!ts) return '—'
  try {
    return new Date(ts * 1000).toLocaleString()
  } catch {
    return String(ts)
  }
}

function statusChip(status: string) {
  const s = (status || '').toLowerCase()
  if (s === 'paid' || s === 'active' || s === 'replied') {
    return (
      <Chip
        size="small"
        color="success"
        label={
          s === 'active' ? '正常' : s === 'paid' ? '已支付' : s === 'replied' ? '已回复' : status
        }
      />
    )
  }
  if (s === 'pending' || s === 'pending_payment' || s === 'open') {
    return (
      <Chip
        size="small"
        color="warning"
        label={s === 'open' ? '待处理' : '待支付'}
      />
    )
  }
  if (s === 'disabled' || s === 'failed' || s === 'cancelled' || s === 'refunded' || s === 'closed') {
    const label =
      s === 'refunded'
        ? '已退款'
        : s === 'cancelled'
          ? '已取消'
          : s === 'closed'
            ? '已关闭'
            : status
    return <Chip size="small" color="default" label={label} />
  }
  if (s === 'expired') {
    return <Chip size="small" variant="outlined" label="已过期" />
  }
  return <Chip size="small" variant="outlined" label={status || '—'} />
}

function orderKindLabel(kind?: string) {
  return kind === 'balance_topup' ? '余额充值' : '套餐'
}

function payTypeLabel(t?: string) {
  if (!t) return '—'
  if (t === 'balance') return '余额'
  if (t === 'alipay') return '支付宝'
  if (t === 'wxpay') return '微信'
  if (t === 'qqpay') return 'QQ'
  return t
}

function SectionTitle({
  icon,
  title,
  extra,
}: {
  icon: ReactNode
  title: string
  extra?: ReactNode
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        mb: 1.75,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}
      >
        <Box
          sx={(t) => ({
            width: 32,
            height: 32,
            borderRadius: '9px',
            display: 'grid',
            placeItems: 'center',
            bgcolor:
              t.palette.mode === 'dark'
                ? 'rgba(45,212,191,0.12)'
                : 'rgba(13,148,136,0.1)',
            color: 'primary.main',
            flexShrink: 0,
            '& .MuiSvgIcon-root': { fontSize: 18 },
          })}
        >
          {icon}
        </Box>
        <Typography sx={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2 }}>
          {title}
        </Typography>
      </Stack>
      {extra}
    </Stack>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        py: 0.85,
        borderBottom: (t) =>
          `1px solid ${
            t.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.05)'
              : 'rgba(17,24,39,0.05)'
          }`,
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ flexShrink: 0, minWidth: 72, fontSize: 13 }}
      >
        {label}
      </Typography>
      <Box sx={{ textAlign: 'right', minWidth: 0 }}>
        {typeof value === 'string' || typeof value === 'number' ? (
          <Typography variant="body2" sx={{ wordBreak: 'break-all', fontWeight: 500 }}>
            {value}
          </Typography>
        ) : (
          value
        )}
      </Box>
    </Stack>
  )
}

export default function CommercialAccountPage() {
  const { session, ready, enabled, logout, syncOfficial, syncing } = useAuth()
  const navigate = useNavigate()

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [orders, setOrders] = useState<OrderListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [deletePw, setDeletePw] = useState('')
  const [deleteCode, setDeleteCode] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteSending, setDeleteSending] = useState(false)
  const [deleteCooldown, setDeleteCooldown] = useState(0)
  const [deleteHint, setDeleteHint] = useState('')
  const [couponCode, setCouponCode] = useState('')
  const [redeemLoading, setRedeemLoading] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [emailPw, setEmailPw] = useState('')
  const [emailLoading, setEmailLoading] = useState(false)
  const [checkin, setCheckin] = useState<CheckinStatus | null>(null)
  const [invite, setInvite] = useState<InviteInfo | null>(null)
  const [checkinLoading, setCheckinLoading] = useState(false)
  const DEFAULT_BALANCE_PACKS: BalancePack[] = [
    { amount_cents: 100, label: '¥1', yuan: '1.00' },
    { amount_cents: 500, label: '¥5', yuan: '5.00' },
    { amount_cents: 1000, label: '¥10', yuan: '10.00' },
    { amount_cents: 3000, label: '¥30', yuan: '30.00' },
    { amount_cents: 5000, label: '¥50', yuan: '50.00' },
    { amount_cents: 10000, label: '¥100', yuan: '100.00' },
  ]
  const [balancePacks, setBalancePacks] =
    useState<BalancePack[]>(DEFAULT_BALANCE_PACKS)
  const [topupLoading, setTopupLoading] = useState(false)
  const [balanceHint, setBalanceHint] = useState('')
  const [customYuan, setCustomYuan] = useState('5')
  const [topupMinCents, setTopupMinCents] = useState(100)
  const [topupMaxCents, setTopupMaxCents] = useState(50000)
  const [tickets, setTickets] = useState<TicketItem[]>([])
  const [ticketSubject, setTicketSubject] = useState('')
  const [ticketBody, setTicketBody] = useState('')
  const [ticketCategory, setTicketCategory] = useState('other')
  const [ticketLoading, setTicketLoading] = useState(false)
  const [activeTicket, setActiveTicket] = useState<TicketItem | null>(null)
  const [ticketReply, setTicketReply] = useState('')

  const userId = session?.user_id || ''

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    setError('')
    try {
      // Profile/orders first — balance packs must not block the whole page
      const [p, o, c, inv, tix] = await Promise.all([
        commercialGetProfile(),
        commercialListOrders(),
        commercialCheckinStatus().catch(() => null),
        commercialInviteInfo().catch(() => null),
        commercialListTickets().catch(() => null),
      ])
      setProfile(p)
      setOrders(o.items || [])
      setEmailInput(p.email || '')
      setCheckin(c)
      setInvite(inv)
      if (tix?.items) setTickets(tix.items)
      // dual-pool report hint from profile
      const paidLim = p.traffic?.paid?.limit_bytes || 0
      const isPaid = Boolean(p.is_paid_user || p.traffic?.is_paid_user)
      setTrafficPoolHint(isPaid && paidLim > 0 ? 'paid' : 'free')

      try {
        const packs = await commercialBalancePacks()
        if (packs?.packs?.length) setBalancePacks(packs.packs)
        else setBalancePacks(DEFAULT_BALANCE_PACKS)
        if (packs?.min_cents) setTopupMinCents(packs.min_cents)
        if (packs?.max_cents) setTopupMaxCents(packs.max_cents)
        setBalanceHint('')
        // Prefer live packs response for balance if profile omitted fields
        if (packs?.balance_yuan != null || packs?.balance_cents != null) {
          setProfile((prev) =>
            prev
              ? {
                  ...prev,
                  balance_cents:
                    packs.balance_cents ?? prev.balance_cents ?? 0,
                  balance_yuan:
                    packs.balance_yuan ||
                    prev.balance_yuan ||
                    ((packs.balance_cents || 0) / 100).toFixed(2),
                }
              : prev,
          )
        }
      } catch (e: any) {
        setBalancePacks(DEFAULT_BALANCE_PACKS)
        setBalanceHint(
          typeof e === 'string'
            ? e
            : e?.message || '充值接口暂不可用，若支付失败请稍后再试或联系管理员',
        )
      }
    } catch (err: any) {
      const msg =
        typeof err === 'string' ? err : err?.message || '加载个人中心失败'
      setError(msg)
      if (String(msg).includes('登录') || String(msg).includes('过期')) {
        showNotice.error(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    if (userId) void load()
  }, [userId, load])

  // Home "充值" → /account#balance ：滚到余额区并高亮
  useEffect(() => {
    if (loading) return
    const hash = window.location.hash.replace('#', '')
    if (hash !== 'balance') return
    const t = window.setTimeout(() => {
      document.getElementById('account-balance')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    }, 80)
    return () => window.clearTimeout(t)
  }, [loading, profile])

  const onSync = useLockFn(async () => {
    try {
      await syncOfficial()
      await load()
    } catch {
      // notice already shown
    }
  })

  const onLogout = useLockFn(async () => {
    await logout()
    navigate('/login', { replace: true })
  })

  const onRemoveDevice = useLockFn(async (device: DeviceInfo) => {
    const currentDeviceId = getOrCreateDeviceId()
    const isCurrentDevice = device.id === currentDeviceId
    const confirmed = window.confirm(
      isCurrentDevice
        ? '移除当前设备会立即退出登录，是否继续？'
        : `确定移除设备「${device.name || device.id}」吗？`,
    )
    if (!confirmed) return
    try {
      await commercialRemoveDevice(device.id)
      showNotice.success(isCurrentDevice ? '当前设备已移除，正在退出登录' : '设备已移除')
      if (isCurrentDevice) {
        await logout()
        navigate('/login', { replace: true })
      } else {
        await load()
      }
    } catch (err: any) {
      showNotice.error(typeof err === 'string' ? err : err?.message || '移除设备失败')
    }
  })

  const onSaveEmail = useLockFn(async () => {
    const em = emailInput.trim()
    if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      showNotice.error('请填写有效邮箱')
      return
    }
    if (!emailPw) {
      showNotice.error('请输入当前登录密码以确认')
      return
    }
    setEmailLoading(true)
    try {
      const r = await commercialChangeEmail(em, emailPw)
      showNotice.success(r.message || '邮箱已更新')
      setEmailPw('')
      await load()
    } catch (err: any) {
      showNotice.error(
        typeof err === 'string' ? err : err?.message || '更新失败',
      )
    } finally {
      setEmailLoading(false)
    }
  })

  const onTopup = useLockFn(async (amountCents: number) => {
    const cents = Math.round(Number(amountCents) || 0)
    if (cents < topupMinCents || cents > topupMaxCents) {
      showNotice.error(
        `充值金额需在 ¥${(topupMinCents / 100).toFixed(2)} ~ ¥${(topupMaxCents / 100).toFixed(2)}`,
      )
      return
    }
    setTopupLoading(true)
    try {
      const result = await commercialBalanceTopup(cents, 'alipay')
      if (result.need_pay && result.pay_url && result.order_id) {
        try {
          await open(result.pay_url)
        } catch {
          showNotice.error('无法打开浏览器，请手动打开支付链接')
        }
        showNotice.success('已打开支付页，请完成充值…')
        await commercialWaitOrderPaid(result.order_id)
        showNotice.success('充值成功')
        notifyEntitlementUpdated()
        await load()
        return
      }
      showNotice.success(result.message || '充值成功')
      await load()
    } catch (err: any) {
      showNotice.error(
        typeof err === 'string' ? err : err?.message || '充值失败',
      )
    } finally {
      setTopupLoading(false)
    }
  })

  const onCustomTopup = useLockFn(async () => {
    const yuan = Number(String(customYuan).trim())
    if (!Number.isFinite(yuan)) {
      showNotice.error('请输入有效金额')
      return
    }
    await onTopup(Math.round(yuan * 100))
  })

  const onCreateTicket = useLockFn(async () => {
    if (!ticketSubject.trim() || ticketBody.trim().length < 4) {
      showNotice.error('请填写标题和描述（至少 4 字）')
      return
    }
    setTicketLoading(true)
    try {
      await commercialCreateTicket({
        subject: ticketSubject.trim(),
        body: ticketBody.trim(),
        category: ticketCategory,
      })
      showNotice.success('工单已提交')
      setTicketSubject('')
      setTicketBody('')
      await load()
    } catch (err: any) {
      showNotice.error(typeof err === 'string' ? err : err?.message || '提交失败')
    } finally {
      setTicketLoading(false)
    }
  })

  const onOpenTicket = useLockFn(async (id: string) => {
    try {
      const r = await commercialGetTicket(id)
      setActiveTicket(r.ticket)
      setTicketReply('')
    } catch (err: any) {
      showNotice.error(typeof err === 'string' ? err : err?.message || '加载失败')
    }
  })

  const onReplyTicket = useLockFn(async () => {
    if (!activeTicket || !ticketReply.trim()) return
    try {
      const r = await commercialReplyTicket(activeTicket.id, ticketReply.trim())
      setActiveTicket(r.ticket)
      setTicketReply('')
      await load()
      showNotice.success('已发送')
    } catch (err: any) {
      showNotice.error(typeof err === 'string' ? err : err?.message || '发送失败')
    }
  })

  const onCloseTicket = useLockFn(async () => {
    if (!activeTicket) return
    try {
      await commercialCloseTicket(activeTicket.id)
      setActiveTicket(null)
      await load()
      showNotice.success('工单已关闭')
    } catch (err: any) {
      showNotice.error(typeof err === 'string' ? err : err?.message || '关闭失败')
    }
  })

  const onRedeem = useLockFn(async () => {
    const code = couponCode.trim()
    if (!code) {
      showNotice.error('请输入兑换码')
      return
    }
    setRedeemLoading(true)
    try {
      const r = await commercialRedeemCoupon(code)
      showNotice.success(r.message || '兑换成功')
      setCouponCode('')
      await load()
      notifyEntitlementUpdated()
    } catch (err: any) {
      showNotice.error(
        typeof err === 'string' ? err : err?.message || '兑换失败',
      )
    } finally {
      setRedeemLoading(false)
    }
  })

  const onChangePassword = useLockFn(async () => {
    if (!oldPw || !newPw) {
      showNotice.error('请填写原密码与新密码')
      return
    }
    if (newPw.length < 6) {
      showNotice.error('新密码至少 6 位')
      return
    }
    if (oldPw === newPw) {
      showNotice.error('新密码不能与原密码相同')
      return
    }
    if (newPw !== newPw2) {
      showNotice.error('两次输入的新密码不一致')
      return
    }
    setPwLoading(true)
    try {
      const r = await commercialChangePassword(oldPw, newPw)
      showNotice.success(r.message || '密码已修改')
      setOldPw('')
      setNewPw('')
      setNewPw2('')
    } catch (err: any) {
      showNotice.error(
        typeof err === 'string' ? err : err?.message || '修改失败',
      )
    } finally {
      setPwLoading(false)
    }
  })

  useEffect(() => {
    if (deleteCooldown <= 0) return
    const t = window.setTimeout(() => setDeleteCooldown((c) => c - 1), 1000)
    return () => window.clearTimeout(t)
  }, [deleteCooldown])

  const onSendDeleteCode = useLockFn(async () => {
    if (!profile?.email) {
      showNotice.error('请先绑定邮箱后再注销')
      return
    }
    setDeleteSending(true)
    try {
      const r = await commercialDeleteAccountSendCode()
      setDeleteHint(r.message || '验证码已发送到绑定邮箱')
      setDeleteCooldown(Number(r.cooldown || 60))
      showNotice.success(r.message || '验证码已发送')
    } catch (err: any) {
      showNotice.error(
        typeof err === 'string' ? err : err?.message || '发送验证码失败',
      )
    } finally {
      setDeleteSending(false)
    }
  })

  const onDeleteAccount = useLockFn(async () => {
    if (!profile?.email) {
      showNotice.error('请先绑定邮箱后再注销')
      return
    }
    if (!deletePw) {
      showNotice.error('请输入登录密码')
      return
    }
    if (!/^\d{6}$/.test(deleteCode.trim())) {
      showNotice.error('请填写邮箱收到的 6 位验证码')
      return
    }
    const ok = window.confirm(
      '注销后账号不可恢复，权益与设备绑定将清除，用户名与邮箱可被重新注册。确定继续？',
    )
    if (!ok) return
    setDeleteLoading(true)
    try {
      const r = await commercialDeleteAccount(deletePw, deleteCode.trim())
      showNotice.success(r.message || '账号已注销')
      await logout()
      navigate('/login', { replace: true })
    } catch (err: any) {
      showNotice.error(
        typeof err === 'string' ? err : err?.message || '注销失败',
      )
    } finally {
      setDeleteLoading(false)
    }
  })

  const onResumePay = useLockFn(async (order: OrderListItem) => {
    if (!order.pay_url || !order.order_id) {
      showNotice.error('该订单无可打开的支付链接')
      return
    }
    try {
      await open(order.pay_url)
    } catch {
      showNotice.error('无法打开浏览器，请稍后重试')
      return
    }
    showNotice.success('已打开支付页，等待确认…')
    try {
      await commercialWaitOrderPaid(order.order_id)
      showNotice.success('支付成功')
      await syncOfficial()
      await load()
    } catch (err: any) {
      showNotice.error(
        typeof err === 'string' ? err : err?.message || '等待支付超时',
      )
      await load()
    }
  })

  const onCheckin = useLockFn(async () => {
    setCheckinLoading(true)
    try {
      const r = await commercialDoCheckin()
      showNotice.success(r.message || '签到成功')
      await load()
      // home dashboard reads live backend quota — notify it to refresh
      notifyEntitlementUpdated()
    } catch (err: any) {
      showNotice.error(
        typeof err === 'string' ? err : err?.message || '签到失败',
      )
    } finally {
      setCheckinLoading(false)
    }
  })

  if (!enabled) return <Navigate to="/" replace />
  if (!ready) return null
  if (!session) return <Navigate to="/login" replace />

  const purchases: ProfilePurchase[] = profile?.purchases || []
  const activeCount = purchases.filter((p) => p.active).length
  const traffic = profile?.traffic
  // Prefer dual wallets; fall back to legacy single pool as free
  const freePool =
    traffic?.free ||
    (traffic && !traffic.free
      ? {
          unlimited: traffic.unlimited,
          limit_bytes: traffic.limit_bytes,
          used_bytes: traffic.used_bytes,
          remaining_bytes: traffic.remaining_bytes,
          exhausted: traffic.exhausted,
          label: traffic.label,
        }
      : undefined)
  const paidPool = traffic?.paid
  const freePct =
    freePool && !freePool.unlimited && (freePool.limit_bytes || 0) > 0
      ? Math.min(
          100,
          Math.round(
            ((freePool.used_bytes || 0) /
              Math.max(1, freePool.limit_bytes || 1)) *
              100,
          ),
        )
      : 0
  const paidPct =
    paidPool && !paidPool.unlimited && (paidPool.limit_bytes || 0) > 0
      ? Math.min(
          100,
          Math.round(
            ((paidPool.used_bytes || 0) /
              Math.max(1, paidPool.limit_bytes || 1)) *
              100,
          ),
        )
      : 0
  const devices = profile?.devices || []
  const currentDeviceId = getOrCreateDeviceId()

  return (
    <BasePage
      title="个人中心"
      header={
        <Stack direction="row" spacing={1} sx={{ display: 'flex', alignItems: 'center' }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<RefreshRounded />}
            loading={loading}
            onClick={() => void load()}
          >
            刷新
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<SyncRounded />}
            loading={syncing}
            onClick={() => void onSync()}
          >
            同步官方线路
          </Button>
        </Stack>
      }
    >
      <Box sx={{ p: { xs: 1.5, sm: 2 }, maxWidth: 1080, mx: 'auto' }}>
        {error ? (
          <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
            {error}
          </Alert>
        ) : null}

        <SectionLabel>概览</SectionLabel>
        <Grid container spacing={2} sx={{ mb: 2.5 }}>
          {/* —— 账号概览 —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard>
                <Stack
                  direction="row"
                  spacing={1.5}
                  sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}
                >
                  <Box
                    sx={(t) => ({
                      width: 48,
                      height: 48,
                      borderRadius: '14px',
                      display: 'grid',
                      placeItems: 'center',
                      bgcolor:
                        t.palette.mode === 'dark'
                          ? 'rgba(45,212,191,0.12)'
                          : 'rgba(13,148,136,0.1)',
                      color: 'primary.main',
                    })}
                  >
                    <AccountCircleRounded sx={{ fontSize: 30 }} />
                  </Box>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography noWrap sx={{ fontWeight: 750, fontSize: 17, letterSpacing: -0.2 }}>
                      {profile?.username || session.username}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12.5 }}>
                      {profile?.product_name || PRODUCT_NAME}
                    </Typography>
                  </Box>
                </Stack>
                <Stack spacing={0.5}>
                  <Row
                    label="状态"
                    value={statusChip(profile?.status || session.status)}
                  />
                  <Row
                    label="邮箱"
                    value={
                      profile?.email ? (
                        <Typography variant="body2">{profile.email}</Typography>
                      ) : (
                        <Chip size="small" color="warning" label="未绑定" />
                      )
                    }
                  />
                  <Row
                    label="当前套餐"
                    value={
                      <Stack direction="row" spacing={0.5} sx={{ display: 'flex', alignItems: 'center' }}>
                        <WorkspacePremiumRounded fontSize="small" color="warning" />
                        <Typography variant="body2">
                          {profile?.plan || session.plan || '—'}
                        </Typography>
                      </Stack>
                    }
                  />
                  <Row
                    label="权益到期"
                    value={
                      activeCount > 0
                        ? formatTs(
                            profile?.entitlement_until || profile?.expire_at || 0,
                          )
                        : '无付费权益'
                    }
                  />
                  <Row label="注册时间" value={formatTs(profile?.created_at)} />
                  {profile?.support_tg ? (
                    <Row
                      label="客服"
                      value={
                        <Link
                          href={profile.support_tg}
                          target="_blank"
                          rel="noreferrer"
                          underline="hover"
                        >
                          Telegram
                        </Link>
                      }
                    />
                  ) : null}
                </Stack>
                <Divider sx={{ my: 1.75 }} />
                <Stack
                  direction="row"
                  spacing={1}
                  useFlexGap
                  sx={{ display: 'flex', flexWrap: 'wrap' }}
                >
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<ShoppingCartCheckoutRounded />}
                    onClick={() => navigate('/store')}
                  >
                    商城
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => navigate('/proxies')}
                  >
                    代理
                  </Button>
                  <Button
                    size="small"
                    color="inherit"
                    startIcon={<LogoutRounded />}
                    onClick={() => void onLogout()}
                    sx={{ ml: 'auto' }}
                  >
                    退出
                  </Button>
                </Stack>
            </SurfaceCard>
          </Grid>

          {/* —— 账户余额 / 充值（始终显示） —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard
              sx={{
                outline: (t) =>
                  typeof window !== 'undefined' &&
                  window.location.hash === '#balance'
                    ? `2px solid ${t.palette.primary.main}`
                    : 'none',
              }}
            >
              <Box id="account-balance">
                <SectionTitle icon={<CardGiftcardRounded />} title="账户余额" />
                <Typography
                  sx={{
                    fontWeight: 800,
                    fontSize: 28,
                    letterSpacing: -0.5,
                    color: 'primary.main',
                    lineHeight: 1.2,
                    mb: 0.5,
                  }}
                >
                  ¥
                  {profile?.balance_yuan ??
                    ((Number(profile?.balance_cents) || 0) / 100).toFixed(2)}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 1.5 }}
                >
                  可用于购买套餐抵扣；后台退款也会退到此余额（非原路退回支付渠道）
                </Typography>
                {balanceHint ? (
                  <Alert severity="warning" sx={{ mb: 1.25, py: 0 }}>
                    {balanceHint}
                  </Alert>
                ) : null}
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.75 }}
                >
                  快捷金额（最低 ¥{(topupMinCents / 100).toFixed(0)}）
                </Typography>
                <Stack
                  direction="row"
                  spacing={0.75}
                  useFlexGap
                  sx={{ display: 'flex', flexWrap: 'wrap', mb: 1.25 }}
                >
                  {(balancePacks.length
                    ? balancePacks
                    : DEFAULT_BALANCE_PACKS
                  ).map((pack) => (
                    <Button
                      key={pack.amount_cents}
                      size="small"
                      variant="contained"
                      color="primary"
                      disabled={topupLoading || loading}
                      onClick={() => void onTopup(pack.amount_cents)}
                      sx={{ borderRadius: 1.5, minWidth: 56, fontWeight: 700 }}
                    >
                      {pack.label}
                    </Button>
                  ))}
                </Stack>
                <Stack direction="row" spacing={1} sx={{ display: 'flex', alignItems: 'center' }}>
                  <TextField
                    size="small"
                    label="自定义金额(元)"
                    value={customYuan}
                    onChange={(e) => setCustomYuan(e.target.value)}
                    type="number"
                    slotProps={{
                      htmlInput: {
                        min: topupMinCents / 100,
                        max: topupMaxCents / 100,
                        step: 0.01,
                      },
                    }}
                    sx={{ flex: 1 }}
                  />
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={topupLoading || loading}
                    onClick={() => void onCustomTopup()}
                    sx={{ borderRadius: 1.5, fontWeight: 700, whiteSpace: 'nowrap' }}
                  >
                    充值
                  </Button>
                </Stack>
              </Box>
            </SurfaceCard>
          </Grid>

          {/* —— 流量（免费 / 付费独立） —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard>
                <SectionTitle
                  icon={<SpeedRounded />}
                  title="流量额度"
                  extra={
                    profile?.is_paid_user || traffic?.is_paid_user ? (
                      <Chip size="small" color="warning" label="付费用户" />
                    ) : (
                      <Chip size="small" label="普通用户" />
                    )
                  }
                />
                <Typography variant="caption" color="text.secondary">
                  免费流量（公开/免费线）
                </Typography>
                <Typography variant="body1" sx={{ mb: 0.5, fontWeight: 700 }}>
                  {freePool?.unlimited
                    ? freePool?.label || '不限流量'
                    : (freePool?.limit_bytes || 0) > 0
                      ? freePool?.label ||
                        `${freePool?.used_bytes || 0} / ${freePool?.limit_bytes}`
                      : freePool?.label || '0（暂无额度）'}
                </Typography>
                {(freePool?.limit_bytes || 0) > 0 ? (
                  <LinearProgress
                    variant="determinate"
                    value={freePct}
                    color={freePool?.exhausted ? 'error' : 'success'}
                    sx={{ height: 8, borderRadius: 1, mb: 1.5 }}
                  />
                ) : (
                  <Box sx={{ mb: 1.5 }} />
                )}

                <Typography variant="caption" color="text.secondary">
                  付费流量（锁定/精品线）
                </Typography>
                <Typography variant="body1" sx={{ mb: 0.5, fontWeight: 700 }}>
                  {paidPool?.unlimited
                    ? paidPool?.label || '不限流量'
                    : (paidPool?.limit_bytes || 0) > 0
                      ? paidPool?.label ||
                        `${paidPool?.used_bytes || 0} / ${paidPool?.limit_bytes}`
                      : profile?.is_paid_user || traffic?.is_paid_user
                        ? paidPool?.label || '0（暂无付费额度）'
                        : '未开通付费（购套餐后计入此池）'}
                </Typography>
                {(paidPool?.limit_bytes || 0) > 0 ? (
                  <LinearProgress
                    variant="determinate"
                    value={paidPct}
                    color={paidPool?.exhausted ? 'error' : 'warning'}
                    sx={{ height: 8, borderRadius: 1, mb: 1.5 }}
                  />
                ) : (
                  <Box sx={{ mb: 1.5 }} />
                )}

                {paidPool?.exhausted ? (
                  <Alert severity="warning" sx={{ mb: 1, py: 0 }}>
                    付费流量用尽：精品线将无法同步，免费线仍可用。
                  </Alert>
                ) : null}
                {freePool?.exhausted ? (
                  <Alert severity="info" sx={{ mb: 1, py: 0 }}>
                    免费流量用尽：请签到或开通套餐补充。
                  </Alert>
                ) : null}
                <Typography variant="body2" color="text.secondary">
                  公共线路：
                  {(profile?.free_sources || []).join('、') || '默认公共'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  已解锁：
                  {(profile?.paid_sources || []).join('、') || '暂无'}
                </Typography>
            </SurfaceCard>
          </Grid>
        </Grid>

        <SectionLabel>活动</SectionLabel>
        <Grid container spacing={2} sx={{ mb: 2.5 }}>
          {/* —— 签到 —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard>
                <SectionTitle
                  icon={<EventAvailableRounded />}
                  title="每日签到"
                />
                {!checkin?.enabled ? (
                  <Typography variant="body2" color="text.secondary">
                    签到活动未开启
                  </Typography>
                ) : (
                  <Stack spacing={1.5}>
                    <Typography variant="body2" color="text.secondary">
                      连续签到{' '}
                      <Box component="span" sx={{ fontWeight: 700, color: 'text.primary' }}>
                        {checkin.streak || 0}
                      </Box>{' '}
                      天
                    </Typography>
                    <Typography variant="body2">
                      身份：
                      {checkin.is_paid_user || checkin.daily?.tier === 'paid'
                        ? '付费用户'
                        : '普通用户'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      每日：
                      {checkin.daily
                        ? [
                            checkin.daily.reward_days
                              ? `+${checkin.daily.reward_days}天`
                              : '',
                            checkin.daily.free_traffic_gb
                              ? `免费+${checkin.daily.free_traffic_gb}GB`
                              : '',
                            checkin.daily.paid_traffic_gb
                              ? `付费+${checkin.daily.paid_traffic_gb}GB`
                              : '',
                          ]
                            .filter(Boolean)
                            .join(' · ') || '见后台'
                        : '见后台'}
                    </Typography>
                    {checkin.upcoming_streak ? (
                      <Typography variant="caption" color="text.secondary">
                        连签满 {checkin.upcoming_streak.days} 天有额外奖励（当前{' '}
                        {checkin.streak || 0} 天）
                      </Typography>
                    ) : null}
                    <Button
                      variant="contained"
                      fullWidth
                      disabled={!checkin.can_checkin}
                      loading={checkinLoading}
                      onClick={() => void onCheckin()}
                    >
                      {checkin.done_today ? '今日已签到' : '立即签到'}
                    </Button>
                  </Stack>
                )}
            </SurfaceCard>
          </Grid>

          {/* —— 邀请 —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard>
                <SectionTitle
                  icon={<GroupAddRounded />}
                  title="拉新返利"
                />
                {!invite?.enabled ? (
                  <Typography variant="body2" color="text.secondary">
                    邀请活动未开启
                    {profile?.invite_code
                      ? ` · 你的码：${profile.invite_code}`
                      : ''}
                  </Typography>
                ) : (
                  <Stack spacing={1}>
                    <Alert severity="info" sx={{ py: 0.5 }}>
                      把邀请码发给好友，注册成功后双方都有奖励。
                    </Alert>
                    <Row
                      label="我的邀请码"
                      value={
                        <Typography
                          variant="body1"
                          sx={{ fontFamily: 'monospace', fontWeight: 700 }}
                        >
                          {invite.invite_code || profile?.invite_code || '—'}
                        </Typography>
                      }
                    />
                    <Typography variant="body2" color="text.secondary">
                      你得：{invite.reward_days} 天
                      {invite.reward_traffic_gb
                        ? ` + ${invite.reward_traffic_gb} GB`
                        : ''}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      好友得：{invite.invitee_days} 天
                      {invite.invitee_traffic_gb
                        ? ` + ${invite.invitee_traffic_gb} GB`
                        : ''}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      已邀请 {invite.invited_count} 人 · 奖励次数 {invite.reward_count}
                    </Typography>
                  </Stack>
                )}
            </SurfaceCard>
          </Grid>

          {/* —— 设备 —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard>
                <SectionTitle
                  icon={<DevicesRounded />}
                  title="登录设备"
                  extra={
                    <Chip
                      size="small"
                      label={`${devices.length}/${profile?.max_devices || 3}`}
                    />
                  }
                />
                {devices.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    暂无设备记录。下次登录客户端会自动绑定。
                  </Typography>
                ) : (
                  <Stack spacing={1} divider={<Divider flexItem />}>
                    {devices.map((d) => {
                      const isCurrentDevice = d.id === currentDeviceId
                      return (
                        <Stack
                          key={d.id}
                          direction="row"
                          spacing={1}
                          sx={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <Box>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {d.name || d.id}
                              {isCurrentDevice ? (
                                <Chip size="small" color="primary" label="本机" sx={{ ml: 1 }} />
                              ) : null}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {d.platform || '—'}
                            </Typography>
                          </Box>
                          <Stack direction="row" spacing={1} sx={{ display: 'flex', alignItems: 'center' }}>
                            <Typography variant="caption" color="text.secondary">
                              {formatTs(d.last_seen_at)}
                            </Typography>
                            <Button
                              size="small"
                              color="error"
                              variant="text"
                              onClick={() => void onRemoveDevice(d)}
                            >
                              移除
                            </Button>
                          </Stack>
                        </Stack>
                      )
                    })}
                  </Stack>
                )}
            </SurfaceCard>
          </Grid>
        </Grid>

        <SectionLabel>权益与订单</SectionLabel>
        <Grid container spacing={2} sx={{ mb: 2.5 }}>
          {/* —— 权益 —— */}
          <Grid size={{ xs: 12, md: 6 }}>
            <SurfaceCard>
                <SectionTitle
                  icon={<WorkspacePremiumRounded />}
                  title="我的权益"
                  extra={
                    <Chip
                      size="small"
                      label={`共 ${purchases.length} · 有效 ${activeCount}`}
                    />
                  }
                />
                {purchases.length === 0 ? (
                  <Alert severity="info">
                    暂无商品权益。可到「订阅商城」开通，或仅使用公共线路。
                  </Alert>
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>商品</TableCell>
                        <TableCell>状态</TableCell>
                        <TableCell>流量</TableCell>
                        <TableCell>剩余</TableCell>
                        <TableCell>到期</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {purchases.map((p) => (
                        <TableRow key={`${p.product_id}-${p.expire_at}`}>
                          <TableCell>{p.name || p.product_id}</TableCell>
                          <TableCell>
                            {p.active ? (
                              <Chip size="small" color="success" label="有效" />
                            ) : (
                              <Chip size="small" label="已过期" />
                            )}
                          </TableCell>
                          <TableCell>
                            {p.traffic_label ||
                              (p.traffic_unlimited ? '不限' : '—')}
                          </TableCell>
                          <TableCell>
                            {p.active
                              ? p.days_left != null
                                ? `${p.days_left} 天`
                                : '长期'
                              : '—'}
                          </TableCell>
                          <TableCell>{formatTs(p.expire_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
            </SurfaceCard>
          </Grid>

          {/* —— 订单（全宽完整信息） —— */}
          <Grid size={{ xs: 12 }}>
            <SurfaceCard>
                <SectionTitle
                  icon={<ReceiptLongRounded />}
                  title="我的订单"
                  extra={
                    <Typography variant="caption" color="text.secondary">
                      共 {orders.length} 条
                    </Typography>
                  }
                />
                {orders.length === 0 ? (
                  <Alert severity="info">暂无订单记录。</Alert>
                ) : (
                  <Box sx={{ overflowX: 'auto' }}>
                    <Table size="small" sx={{ minWidth: 720 }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>类型</TableCell>
                          <TableCell>商品 / 说明</TableCell>
                          <TableCell>金额</TableCell>
                          <TableCell>支付方式</TableCell>
                          <TableCell>状态</TableCell>
                          <TableCell>下单时间</TableCell>
                          <TableCell>完成时间</TableCell>
                          <TableCell>单号</TableCell>
                          <TableCell align="right">操作</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {orders.map((o) => {
                          const yuan =
                            o.money != null && o.money !== ''
                              ? `¥${o.money}`
                              : o.money_cents != null
                                ? `¥${(Number(o.money_cents) / 100).toFixed(2)}`
                                : '—'
                          const bal =
                            (o.balance_applied_cents || 0) > 0
                              ? `含余额抵 ¥${((o.balance_applied_cents || 0) / 100).toFixed(2)}`
                              : ''
                          const doneAt =
                            o.status === 'refunded'
                              ? o.refunded_at
                              : o.paid_at
                          return (
                            <TableRow key={o.order_id}>
                              <TableCell>
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  label={orderKindLabel(o.order_kind)}
                                />
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                  {o.name || o.product_id || '—'}
                                </Typography>
                                {bal ? (
                                  <Typography variant="caption" color="text.secondary">
                                    {bal}
                                  </Typography>
                                ) : null}
                              </TableCell>
                              <TableCell sx={{ fontWeight: 600 }}>{yuan}</TableCell>
                              <TableCell>{payTypeLabel(o.pay_type)}</TableCell>
                              <TableCell>{statusChip(o.status)}</TableCell>
                              <TableCell>
                                <Typography variant="caption">
                                  {formatTs(o.created_at)}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="caption">
                                  {doneAt ? formatTs(doneAt) : '—'}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography
                                  variant="caption"
                                  sx={{ fontFamily: 'monospace' }}
                                >
                                  {o.out_trade_no || o.order_id.slice(0, 12)}
                                </Typography>
                              </TableCell>
                              <TableCell align="right">
                                {(o.status === 'pending' ||
                                  o.status === 'pending_payment') &&
                                o.pay_url ? (
                                  <Button
                                    size="small"
                                    onClick={() => void onResumePay(o)}
                                  >
                                    继续支付
                                  </Button>
                                ) : o.refund_destination === 'balance' ? (
                                  <Typography variant="caption" color="text.secondary">
                                    已退余额
                                  </Typography>
                                ) : (
                                  <Typography variant="caption" color="text.secondary">
                                    —
                                  </Typography>
                                )}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </Box>
                )}
            </SurfaceCard>
          </Grid>

          {/* —— 工单 —— */}
          <Grid size={{ xs: 12 }}>
            <SurfaceCard>
              <SectionTitle icon={<SupportAgentRounded />} title="工单 / 客服" />
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, md: 5 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    支付、流量、连接等问题可提交工单，客服会在后台回复。
                  </Typography>
                  <Stack spacing={1.25}>
                    <TextField
                      size="small"
                      select
                      label="分类"
                      value={ticketCategory}
                      onChange={(e) => setTicketCategory(e.target.value)}
                      fullWidth
                    >
                      <MenuItem value="payment">支付/订单</MenuItem>
                      <MenuItem value="traffic">流量/套餐</MenuItem>
                      <MenuItem value="account">账号</MenuItem>
                      <MenuItem value="connection">连接/节点</MenuItem>
                      <MenuItem value="other">其他</MenuItem>
                    </TextField>
                    <TextField
                      size="small"
                      label="标题"
                      value={ticketSubject}
                      onChange={(e) => setTicketSubject(e.target.value)}
                      fullWidth
                      slotProps={{ htmlInput: { maxLength: 80 } }}
                    />
                    <TextField
                      size="small"
                      label="问题描述"
                      value={ticketBody}
                      onChange={(e) => setTicketBody(e.target.value)}
                      fullWidth
                      multiline
                      minRows={3}
                      slotProps={{ htmlInput: { maxLength: 2000 } }}
                    />
                    <Button
                      variant="contained"
                      loading={ticketLoading}
                      onClick={() => void onCreateTicket()}
                    >
                      提交工单
                    </Button>
                  </Stack>
                </Grid>
                <Grid size={{ xs: 12, md: 7 }}>
                  {tickets.length === 0 ? (
                    <Alert severity="info">暂无工单。</Alert>
                  ) : (
                    <Stack spacing={1}>
                      {tickets.map((t) => (
                        <Box
                          key={t.id}
                          onClick={() => void onOpenTicket(t.id)}
                          sx={(theme) => ({
                            p: 1.25,
                            borderRadius: 2,
                            cursor: 'pointer',
                            bgcolor:
                              theme.palette.mode === 'dark'
                                ? 'rgba(255,255,255,0.04)'
                                : 'rgba(17,24,39,0.03)',
                            '&:hover': {
                              bgcolor:
                                theme.palette.mode === 'dark'
                                  ? 'rgba(255,255,255,0.07)'
                                  : 'rgba(17,24,39,0.06)',
                            },
                          })}
                        >
                          <Stack
                            direction="row"
                            spacing={1}
                            sx={{ display: 'flex', alignItems: 'center' }}
                          >
                            <Typography
                              sx={{ flex: 1, fontWeight: 600, fontSize: 14 }}
                              noWrap
                            >
                              {t.subject}
                            </Typography>
                            {statusChip(t.status)}
                          </Stack>
                          <Typography variant="caption" color="text.secondary">
                            {formatTs(t.updated_at || t.created_at)}
                            {t.last_message?.body
                              ? ` · ${t.last_message.body}`
                              : ''}
                          </Typography>
                        </Box>
                      ))}
                    </Stack>
                  )}
                  {activeTicket ? (
                    <Box
                      sx={{
                        mt: 2,
                        p: 1.5,
                        borderRadius: 2,
                        border: '1px solid',
                        borderColor: 'divider',
                      }}
                    >
                      <Stack
                        direction="row"
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          mb: 1,
                          gap: 1,
                        }}
                      >
                        <Typography sx={{ flex: 1, fontWeight: 700 }}>
                          {activeTicket.subject}
                        </Typography>
                        {statusChip(activeTicket.status)}
                        {activeTicket.status !== 'closed' ? (
                          <Button size="small" onClick={() => void onCloseTicket()}>
                            关闭
                          </Button>
                        ) : null}
                      </Stack>
                      <Stack spacing={1} sx={{ maxHeight: 220, overflow: 'auto', mb: 1.5 }}>
                        {(activeTicket.messages || []).map((m, i) => (
                          <Box key={m.id || i}>
                            <Typography variant="caption" color="text.secondary">
                              {m.role === 'admin' ? '客服' : '我'} · {formatTs(m.at)}
                            </Typography>
                            <Typography
                              variant="body2"
                              sx={{ whiteSpace: 'pre-wrap' }}
                            >
                              {m.body}
                            </Typography>
                          </Box>
                        ))}
                      </Stack>
                      {activeTicket.status !== 'closed' ? (
                        <Stack direction="row" spacing={1}>
                          <TextField
                            size="small"
                            fullWidth
                            placeholder="继续补充…"
                            value={ticketReply}
                            onChange={(e) => setTicketReply(e.target.value)}
                          />
                          <Button
                            variant="contained"
                            onClick={() => void onReplyTicket()}
                            disabled={!ticketReply.trim()}
                          >
                            发送
                          </Button>
                        </Stack>
                      ) : null}
                    </Box>
                  ) : null}
                </Grid>
              </Grid>
            </SurfaceCard>
          </Grid>
        </Grid>

        <SectionLabel>账号与安全</SectionLabel>
        <Grid container spacing={2}>
          {/* —— 兑换码 —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard>
                <SectionTitle
                  icon={<CardGiftcardRounded />}
                  title="兑换码"
                />
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mb: 1.5 }}
                >
                  输入运营发放的兑换码开通商品（商品详情下单也可填优惠券）。
                </Typography>
                <Stack spacing={1}>
                  <TextField
                    size="small"
                    fullWidth
                    label="兑换码"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                    placeholder="例如 ABCD1234"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void onRedeem()
                    }}
                  />
                  <Button
                    variant="contained"
                    loading={redeemLoading}
                    onClick={() => void onRedeem()}
                  >
                    立即兑换
                  </Button>
                </Stack>
            </SurfaceCard>
          </Grid>

          {/* —— 邮箱 —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard>
                <SectionTitle
                  icon={<EmailRounded />}
                  title={profile?.email ? '更换邮箱' : '绑定邮箱'}
                />
                <Stack spacing={1.25}>
                  <TextField
                    size="small"
                    type="email"
                    label="邮箱"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    fullWidth
                  />
                  <TextField
                    size="small"
                    type="password"
                    label="当前密码"
                    value={emailPw}
                    onChange={(e) => setEmailPw(e.target.value)}
                    fullWidth
                    autoComplete="current-password"
                  />
                  <Button
                    variant="contained"
                    loading={emailLoading}
                    onClick={() => void onSaveEmail()}
                  >
                    {profile?.email ? '确认更换' : '确认绑定'}
                  </Button>
                </Stack>
            </SurfaceCard>
          </Grid>

          {/* —— 密码 —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard>
                <SectionTitle
                  icon={<LockResetRounded />}
                  title="修改密码"
                />
                <Stack spacing={1.25}>
                  <TextField
                    label="原密码"
                    type="password"
                    size="small"
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                    autoComplete="current-password"
                    fullWidth
                  />
                  <TextField
                    label="新密码"
                    type="password"
                    size="small"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    autoComplete="new-password"
                    helperText="至少 6 位"
                    fullWidth
                  />
                  <TextField
                    label="确认新密码"
                    type="password"
                    size="small"
                    value={newPw2}
                    onChange={(e) => setNewPw2(e.target.value)}
                    autoComplete="new-password"
                    fullWidth
                  />
                  <Button
                    variant="contained"
                    loading={pwLoading}
                    onClick={() => void onChangePassword()}
                  >
                    保存新密码
                  </Button>
                </Stack>
            </SurfaceCard>
          </Grid>

          {/* —— 注销账号 —— */}
          <Grid size={{ xs: 12, md: 4 }}>
            <SurfaceCard
              sx={{
                borderColor: (t) =>
                  t.palette.mode === 'dark'
                    ? 'rgba(248,113,113,0.35)'
                    : 'rgba(239,68,68,0.28)',
              }}
            >
                <SectionTitle
                  icon={<DeleteForeverRounded color="error" />}
                  title="注销账号"
                />
                <Alert severity="warning" sx={{ mb: 1.5, py: 0.5, borderRadius: 2 }}>
                  注销需验证绑定邮箱与登录密码。权益与设备将清除且不可恢复。
                </Alert>
                {!profile?.email ? (
                  <Alert severity="info" sx={{ py: 0.5, borderRadius: 2 }}>
                    请先在上方绑定邮箱，再进行注销。
                  </Alert>
                ) : (
                  <Stack spacing={1.25}>
                    <Typography variant="body2" color="text.secondary">
                      验证码将发送至：{profile.email}
                      {deleteHint ? ` · ${deleteHint}` : ''}
                    </Typography>
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{ alignItems: 'flex-start' }}
                    >
                      <TextField
                        label="邮箱验证码"
                        size="small"
                        value={deleteCode}
                        onChange={(e) =>
                          setDeleteCode(
                            e.target.value.replace(/\D/g, '').slice(0, 6),
                          )
                        }
                        slotProps={{
                          htmlInput: { inputMode: 'numeric', maxLength: 6 },
                        }}
                        helperText="6 位数字，10 分钟内有效"
                        fullWidth
                      />
                      <Button
                        variant="outlined"
                        sx={{ minWidth: 112, height: 40, flexShrink: 0 }}
                        disabled={
                          deleteSending || deleteCooldown > 0 || !profile?.email
                        }
                        loading={deleteSending}
                        onClick={() => void onSendDeleteCode()}
                      >
                        {deleteCooldown > 0 ? `${deleteCooldown}s` : '获取验证码'}
                      </Button>
                    </Stack>
                    <TextField
                      label="登录密码"
                      type="password"
                      size="small"
                      value={deletePw}
                      onChange={(e) => setDeletePw(e.target.value)}
                      autoComplete="current-password"
                      fullWidth
                    />
                    <Button
                      variant="outlined"
                      color="error"
                      loading={deleteLoading}
                      disabled={
                        !deletePw || deleteCode.length !== 6 || !profile?.email
                      }
                      onClick={() => void onDeleteAccount()}
                    >
                      确认注销账号
                    </Button>
                  </Stack>
                )}
            </SurfaceCard>
          </Grid>
        </Grid>
      </Box>
    </BasePage>
  )
}
