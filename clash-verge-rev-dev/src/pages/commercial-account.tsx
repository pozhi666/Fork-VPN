import {
  AccountCircleRounded,
  CardGiftcardRounded,
  EmailRounded,
  LockResetRounded,
  LogoutRounded,
  ReceiptLongRounded,
  RefreshRounded,
  ShoppingCartCheckoutRounded,
  SyncRounded,
  WorkspacePremiumRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
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
import { PRODUCT_NAME } from '@/config/commercial'
import { useAuth } from '@/providers/auth-provider'
import {
  commercialChangeEmail,
  commercialChangePassword,
  commercialGetProfile,
  commercialListOrders,
  commercialRedeemCoupon,
  commercialWaitOrderPaid,
  type OrderListItem,
  type ProfilePurchase,
  type UserProfile,
} from '@/services/commercial'
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
  if (s === 'paid' || s === 'active') {
    return <Chip size="small" color="success" label={status} />
  }
  if (s === 'pending') {
    return <Chip size="small" color="warning" label="待支付" />
  }
  if (s === 'disabled' || s === 'failed' || s === 'cancelled') {
    return <Chip size="small" color="error" label={status} />
  }
  return <Chip size="small" variant="outlined" label={status || '—'} />
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
  const [couponCode, setCouponCode] = useState('')
  const [redeemLoading, setRedeemLoading] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [emailPw, setEmailPw] = useState('')
  const [emailLoading, setEmailLoading] = useState(false)

  // Only re-fetch when the logged-in user changes — not on every session object refresh.
  const userId = session?.user_id || ''

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    setError('')
    try {
      const [p, o] = await Promise.all([
        commercialGetProfile(),
        commercialListOrders(),
      ])
      setProfile(p)
      setOrders(o.items || [])
      setEmailInput(p.email || '')
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

  if (!enabled) {
    return <Navigate to="/" replace />
  }

  if (!ready) {
    return null
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  const purchases: ProfilePurchase[] = profile?.purchases || []
  const activeCount = purchases.filter((p) => p.active).length

  return (
    <BasePage
      title="个人中心"
      header={
        <Stack direction="row" spacing={1} alignItems="center">
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
      <Box sx={{ p: 2, maxWidth: 1100, mx: 'auto' }}>
        {error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        ) : null}

        <Grid container spacing={2}>
          {/* Account card */}
          <Grid size={{ xs: 12, md: 5 }}>
            <Card variant="outlined" sx={{ height: '100%' }}>
              <CardContent>
                <Stack direction="row" spacing={1.5} alignItems="center" mb={2}>
                  <AccountCircleRounded color="primary" sx={{ fontSize: 40 }} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="h6" noWrap fontWeight={700}>
                      {profile?.username || session.username}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {profile?.product_name || PRODUCT_NAME} · 账号
                    </Typography>
                  </Box>
                </Stack>

                <Stack spacing={1.25}>
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
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <WorkspacePremiumRounded
                          fontSize="small"
                          color="warning"
                        />
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
                            profile?.entitlement_until ||
                              profile?.expire_at ||
                              0,
                          )
                        : '无付费权益（公开线路不受此限制）'
                    }
                  />
                  <Row
                    label="注册时间"
                    value={formatTs(profile?.created_at)}
                  />
                  <Row
                    label="有效权益"
                    value={`${activeCount} 项`}
                  />
                  <Row
                    label="公共线路"
                    value={
                      (profile?.free_sources || []).join('、') || '默认公共'
                    }
                  />
                  <Row
                    label="已解锁付费源"
                    value={
                      (profile?.paid_sources || []).join('、') || '暂无'
                    }
                  />
                </Stack>

                <Divider sx={{ my: 2 }} />

                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<ShoppingCartCheckoutRounded />}
                    onClick={() => navigate('/store')}
                  >
                    去商城
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => navigate('/profile')}
                  >
                    订阅配置
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    variant="text"
                    startIcon={<LogoutRounded />}
                    onClick={() => void onLogout()}
                  >
                    退出登录
                  </Button>
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          {/* Redeem + password */}
          <Grid size={{ xs: 12, md: 7 }}>
            <Stack spacing={2}>
            <Card variant="outlined">
              <CardContent>
                <Stack direction="row" spacing={1} alignItems="center" mb={1.5}>
                  <EmailRounded color="primary" />
                  <Typography variant="h6" fontWeight={700}>
                    {profile?.email ? '更换邮箱' : '绑定邮箱'}
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary" mb={1.5}>
                  {profile?.email
                    ? '更换后请使用新邮箱作为联系邮箱；需验证当前登录密码。'
                    : '旧账号可在此补绑邮箱；需验证当前登录密码。'}
                </Typography>
                <Stack spacing={1.5} maxWidth={420}>
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
                  <Box>
                    <Button
                      variant="contained"
                      loading={emailLoading}
                      onClick={() => void onSaveEmail()}
                    >
                      {profile?.email ? '确认更换' : '确认绑定'}
                    </Button>
                  </Box>
                </Stack>
              </CardContent>
            </Card>
            <Card variant="outlined">
              <CardContent>
                <Stack direction="row" spacing={1} alignItems="center" mb={1.5}>
                  <CardGiftcardRounded color="primary" />
                  <Typography variant="h6" fontWeight={700}>
                    兑换码
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary" mb={1.5}>
                  输入运营发放的优惠券 / 兑换码，即可开通对应商品时长。
                </Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
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
                    sx={{ flexShrink: 0 }}
                  >
                    立即兑换
                  </Button>
                </Stack>
              </CardContent>
            </Card>
            <Card variant="outlined">
              <CardContent>
                <Stack direction="row" spacing={1} alignItems="center" mb={1.5}>
                  <LockResetRounded color="primary" />
                  <Typography variant="h6" fontWeight={700}>
                    修改密码
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary" mb={2}>
                  修改后本地会话仍然有效；若在其他设备登录，请使用新密码。
                </Typography>
                <Stack spacing={1.5} maxWidth={420}>
                  <TextField
                    label="原密码"
                    type="password"
                    size="small"
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                    autoComplete="current-password"
                  />
                  <TextField
                    label="新密码"
                    type="password"
                    size="small"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    autoComplete="new-password"
                    helperText="至少 6 位"
                  />
                  <TextField
                    label="确认新密码"
                    type="password"
                    size="small"
                    value={newPw2}
                    onChange={(e) => setNewPw2(e.target.value)}
                    autoComplete="new-password"
                  />
                  <Box>
                    <Button
                      variant="contained"
                      loading={pwLoading}
                      onClick={() => void onChangePassword()}
                    >
                      保存新密码
                    </Button>
                  </Box>
                </Stack>
              </CardContent>
            </Card>
            </Stack>
          </Grid>

          {/* Purchases */}
          <Grid size={{ xs: 12 }}>
            <Card variant="outlined">
              <CardContent>
                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  mb={1.5}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <WorkspacePremiumRounded color="primary" />
                    <Typography variant="h6" fontWeight={700}>
                      我的权益
                    </Typography>
                  </Stack>
                  <Chip
                    size="small"
                    label={`共 ${purchases.length} 条 · 有效 ${activeCount}`}
                  />
                </Stack>

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
                        <TableCell>剩余</TableCell>
                        <TableCell>到期时间</TableCell>
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
              </CardContent>
            </Card>
          </Grid>

          {/* Orders */}
          <Grid size={{ xs: 12 }}>
            <Card variant="outlined">
              <CardContent>
                <Stack direction="row" spacing={1} alignItems="center" mb={1.5}>
                  <ReceiptLongRounded color="primary" />
                  <Typography variant="h6" fontWeight={700}>
                    我的订单
                  </Typography>
                </Stack>

                {orders.length === 0 ? (
                  <Alert severity="info">暂无订单记录。</Alert>
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>商品</TableCell>
                        <TableCell>金额</TableCell>
                        <TableCell>状态</TableCell>
                        <TableCell>下单时间</TableCell>
                        <TableCell>支付时间</TableCell>
                        <TableCell align="right">操作</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {orders.map((o) => (
                        <TableRow key={o.order_id}>
                          <TableCell>{o.name || o.product_id || '—'}</TableCell>
                          <TableCell>
                            {o.money
                              ? `¥${o.money}`
                              : o.money_cents != null
                                ? `¥${(o.money_cents / 100).toFixed(2)}`
                                : '—'}
                          </TableCell>
                          <TableCell>{statusChip(o.status)}</TableCell>
                          <TableCell>{formatTs(o.created_at)}</TableCell>
                          <TableCell>{formatTs(o.paid_at)}</TableCell>
                          <TableCell align="right">
                            {o.status === 'pending' && o.pay_url ? (
                              <Button
                                size="small"
                                onClick={() => void onResumePay(o)}
                              >
                                继续支付
                              </Button>
                            ) : (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                {o.out_trade_no
                                  ? o.out_trade_no.slice(0, 14)
                                  : '—'}
                              </Typography>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Box>
    </BasePage>
  )
}

function Row({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="flex-start"
      spacing={2}
    >
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ flexShrink: 0, minWidth: 96 }}
      >
        {label}
      </Typography>
      <Box sx={{ textAlign: 'right', minWidth: 0 }}>
        {typeof value === 'string' || typeof value === 'number' ? (
          <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
            {value}
          </Typography>
        ) : (
          value
        )}
      </Box>
    </Stack>
  )
}
