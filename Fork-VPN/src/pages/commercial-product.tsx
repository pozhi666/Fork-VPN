import {
  ArrowBackRounded,
  LocalOfferRounded,
  ShoppingCartCheckoutRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { open } from '@tauri-apps/plugin-shell'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'

import { BasePage } from '@/components/base'
import { PRODUCT_NAME } from '@/config/commercial'
import { useAuth } from '@/providers/auth-provider'
import {
  commercialGetCatalogItem,
  commercialPreviewCheckout,
  commercialPurchase,
  commercialWaitOrderPaid,
  type CatalogItem,
  type CheckoutPreview,
} from '@/services/commercial'
import { notifyEntitlementUpdated } from '@/components/home/home-profile-card'
import { showNotice } from '@/services/notice-service'
import { revalidateQueries } from '@/services/query-client'

export default function CommercialProductPage() {
  const { productId = '' } = useParams()
  const { session, ready, enabled, syncOfficial, syncing, refreshSession } =
    useAuth()
  const navigate = useNavigate()

  const [item, setItem] = useState<CatalogItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [coupon, setCoupon] = useState('')
  const [preview, setPreview] = useState<CheckoutPreview | null>(null)
  const [payType, setPayType] = useState('alipay')
  const [useBalance, setUseBalance] = useState(true)
  const [buying, setBuying] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!productId) return
    setLoading(true)
    setError('')
    try {
      const r = await commercialGetCatalogItem(productId)
      setItem(r.item)
      const p = await commercialPreviewCheckout(productId, '', true)
      setPreview(p)
    } catch (err: any) {
      setError(typeof err === 'string' ? err : err?.message || '加载失败')
      setItem(null)
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    if (session) void load()
  }, [session, load])

  const refreshPreview = useLockFn(async (code?: string, bal = useBalance) => {
    if (!productId) return
    const p = await commercialPreviewCheckout(
      productId,
      (code ?? coupon).trim(),
      bal,
    )
    setPreview(p)
    return p
  })

  const onApplyCoupon = useLockFn(async () => {
    if (!productId) return
    try {
      const p = await refreshPreview(coupon.trim(), useBalance)
      showNotice.success(p?.label || '优惠已应用')
    } catch (err: any) {
      showNotice.error(typeof err === 'string' ? err : err?.message || '优惠码无效')
    }
  })

  const onBuy = useLockFn(async () => {
    if (!item) return
    setBuying(true)
    try {
      const result = await commercialPurchase(item.id, {
        payType,
        couponCode: coupon.trim() || undefined,
        useBalance,
      })

      if (result.need_pay && result.pay_url && result.order_id) {
        try {
          await open(result.pay_url)
        } catch {
          showNotice.error('无法打开浏览器，请手动打开支付链接')
        }
        showNotice.success('已打开支付页，请完成付款…')
        await commercialWaitOrderPaid(result.order_id)
        showNotice.success(`已开通 ${item.name}`)
        await syncOfficial()
        // refresh plan / is_paid on session (balance pay returns immediately)
        await refreshSession()
        notifyEntitlementUpdated()
        await revalidateQueries([
          ['getProfiles'],
          ['getProxies'],
          ['getClashConfig'],
        ])
        navigate('/account')
        return
      }

      showNotice.success(result.message || '开通成功')
      await syncOfficial()
      await refreshSession()
      notifyEntitlementUpdated()
      await revalidateQueries([['getProfiles'], ['getProxies']])
      navigate('/account')
    } catch (err: any) {
      showNotice.error(typeof err === 'string' ? err : err?.message || '下单失败')
    } finally {
      setBuying(false)
    }
  })

  if (!enabled) return <Navigate to="/" replace />
  if (!ready) return null
  if (!session) return <Navigate to="/login" replace />

  const finalCents = preview?.final_cents ?? item?.price_cents ?? 0
  const originalCents = preview?.original_cents ?? item?.price_cents ?? 0
  const free = finalCents <= 0
  const balanceCents = preview?.balance_cents ?? 0
  const balanceApplied = preview?.balance_applied_cents ?? 0
  const gatewayCents = preview?.gateway_cents ?? finalCents
  const fullyByBalance = Boolean(preview?.fully_covered_by_balance)

  return (
    <BasePage
      title="商品详情"
      header={
        <Button
          size="small"
          startIcon={<ArrowBackRounded />}
          onClick={() => navigate('/store')}
        >
          返回商城
        </Button>
      }
    >
      <Box sx={{ p: 2, maxWidth: 640, mx: 'auto' }}>
        {error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        ) : null}

        {loading || !item ? (
          <Typography color="text.secondary">加载中…</Typography>
        ) : (
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Stack
                  direction="row"
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Typography variant="h5" sx={{ fontWeight: 800 }}>
                    {item.name}
                  </Typography>
                  {item.owned ? (
                    <Chip color="success" label="已开通" />
                  ) : free ? (
                    <Chip color="success" variant="outlined" label="免费/免单" />
                  ) : (
                    <Chip color="warning" label="付费" />
                  )}
                </Stack>

                <Typography color="text.secondary">
                  {item.description || `${PRODUCT_NAME} 商品`}
                </Typography>

                <Stack
                  direction="row"
                  spacing={2}
                  sx={{ display: 'flex', flexWrap: 'wrap' }}
                >
                  <Typography variant="body2">
                    有效期：{item.days || 30} 天
                  </Typography>
                  {item.traffic_label ? (
                    <Typography variant="body2">流量：{item.traffic_label}</Typography>
                  ) : null}
                  {item.source_name ? (
                    <Typography variant="body2">线路：{item.source_name}</Typography>
                  ) : null}
                </Stack>

                <Divider />

                <Box>
                  <Typography variant="caption" color="text.secondary">
                    价格
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ display: 'flex', alignItems: 'baseline' }}
                  >
                    <Typography variant="h4" sx={{ fontWeight: 800 }}>
                      {free
                        ? '¥0'
                        : `¥${(finalCents / 100).toFixed(2)}`}
                    </Typography>
                    {originalCents > finalCents ? (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ textDecoration: 'line-through' }}
                      >
                        ¥{(originalCents / 100).toFixed(2)}
                      </Typography>
                    ) : null}
                    {preview?.label ? (
                      <Chip size="small" color="primary" label={preview.label} />
                    ) : null}
                  </Stack>
                  {!free && balanceCents > 0 ? (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mt: 0.75 }}
                    >
                      账户余额 ¥{(balanceCents / 100).toFixed(2)}
                      {useBalance && balanceApplied > 0
                        ? fullyByBalance
                          ? ` · 将全额使用余额`
                          : ` · 抵扣 ¥${(balanceApplied / 100).toFixed(2)}，还需支付 ¥${(gatewayCents / 100).toFixed(2)}`
                        : null}
                    </Typography>
                  ) : null}
                </Box>

                {!item.owned ? (
                  <>
                    <TextField
                      label="优惠券 / 兑换码"
                      value={coupon}
                      onChange={(e) => setCoupon(e.target.value)}
                      fullWidth
                      placeholder="有码可填，先点应用再下单"
                      slotProps={{
                        input: {
                          endAdornment: (
                            <Button
                              size="small"
                              startIcon={<LocalOfferRounded />}
                              onClick={() => void onApplyCoupon()}
                              disabled={!coupon.trim()}
                            >
                              应用
                            </Button>
                          ),
                        },
                      }}
                    />

                    {!free && balanceCents > 0 ? (
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={useBalance}
                            onChange={(_, v) => {
                              setUseBalance(v)
                              void refreshPreview(coupon, v).catch(() => {})
                            }}
                          />
                        }
                        label="使用账户余额抵扣"
                      />
                    ) : null}

                    {!free && !fullyByBalance ? (
                      <TextField
                        select
                        label="支付方式"
                        value={payType}
                        onChange={(e) => setPayType(e.target.value)}
                        fullWidth
                      >
                        <MenuItem value="alipay">支付宝</MenuItem>
                        <MenuItem value="wxpay">微信</MenuItem>
                        <MenuItem value="qqpay">QQ 钱包</MenuItem>
                      </TextField>
                    ) : null}

                    <Button
                      variant="contained"
                      size="large"
                      startIcon={<ShoppingCartCheckoutRounded />}
                      loading={buying || syncing}
                      onClick={() => void onBuy()}
                      fullWidth
                    >
                      {free
                        ? '确认开通'
                        : fullyByBalance
                          ? '余额支付并开通'
                          : gatewayCents < finalCents
                            ? `支付 ¥${(gatewayCents / 100).toFixed(2)} 并开通`
                            : '确认支付并开通'}
                    </Button>
                  </>
                ) : (
                  <Alert severity="success">您已拥有此商品，可在个人中心查看权益。</Alert>
                )}
              </Stack>
            </CardContent>
          </Card>
        )}
      </Box>
    </BasePage>
  )
}
