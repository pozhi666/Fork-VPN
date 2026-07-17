import {
  CardGiftcardRounded,
  RefreshRounded,
  ShoppingCartCheckoutRounded,
  WorkspacePremiumRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Divider,
  Grid,
  Stack,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { AnnouncementBanner } from '@/components/home/announcement-center'
import { PRODUCT_NAME } from '@/config/commercial'
import { useAuth } from '@/providers/auth-provider'
import {
  commercialEnsureAccessSynced,
  commercialGetCatalog,
  type CatalogItem,
  type CatalogResponse,
} from '@/services/commercial'
import { showNotice } from '@/services/notice-service'
import { revalidateQueries } from '@/services/query-client'

/**
 * Commercial subscription store:
 * - Free zone: auto for all logged-in users
 * - Paid zone: 易支付浏览器收银台 → 回调开通 → 同步节点
 */
export default function CommercialStorePage() {
  const { session, syncOfficial, syncing } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastSync, setLastSync] = useState<string>('')
  const [lastCatalogAt, setLastCatalogAt] = useState('')

  const refreshProxyData = useCallback(async () => {
    await revalidateQueries([
      ['getProfiles'],
      ['getProxies'],
      ['getClashConfig'],
      ['getRuntimeConfig'],
    ])
  }, [])

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true)
      try {
        const data = await commercialGetCatalog()
        setCatalog(data)
        setLastCatalogAt(new Date().toLocaleTimeString())
        // if admin revoked products, re-pull nodes so proxy list matches
        try {
          const synced = await commercialEnsureAccessSynced(data.access_key)
          if (synced) {
            await refreshProxyData()
            if (!opts?.silent && synced.message) {
              setLastSync(synced.message)
            }
          }
        } catch {
          // ignore
        }
      } catch (err: any) {
        if (!opts?.silent) showNotice.error(err)
        setCatalog({ free: [], paid: [] })
      } finally {
        if (!opts?.silent) setLoading(false)
      }
    },
    [refreshProxyData],
  )

  useEffect(() => {
    if (location.pathname === '/store' || location.pathname === '/profile')
      void load()
  }, [load, location.pathname, location.key])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') void load({ silent: true })
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [load])

  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load({ silent: true })
    }, 30_000)
    return () => window.clearInterval(t)
  }, [load])

  const onRefreshCatalog = useLockFn(async () => {
    await load()
    showNotice.success('商品列表已刷新')
  })

  const onSync = useLockFn(async () => {
    try {
      const result = await syncOfficial()
      setLastSync(
        result
          ? `已同步 · 节点将显示在「代理」页`
          : '已同步',
      )
      await refreshProxyData()
      showNotice.success(
        result?.message || '同步成功，请到「代理」页查看节点',
      )
    } catch (err: any) {
      showNotice.error(err)
    }
  })

  const goDetail = (item: CatalogItem) => {
    navigate(`/store/${item.id}`)
  }

  return (
    <BasePage
      title="订阅商城"
      header={
        <Stack direction="row" spacing={1} sx={{ display: 'flex', alignItems: 'center' }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<RefreshRounded />}
            loading={loading}
            onClick={() => void onRefreshCatalog()}
          >
            刷新商品
          </Button>
          <Button
            size="small"
            variant="contained"
            loading={syncing}
            onClick={() => void onSync()}
          >
            同步节点
          </Button>
          <Button size="small" variant="outlined" onClick={() => navigate('/account')}>
            个人中心
          </Button>
          <Button size="small" variant="outlined" onClick={() => navigate('/proxies')}>
            去代理页
          </Button>
        </Stack>
      }
    >
      <Box sx={{ p: 2, maxWidth: 1100, mx: 'auto' }}>
        <AnnouncementBanner />
        <Alert severity="info" sx={{ mb: 2 }}>
          {PRODUCT_NAME}：商店只卖<b>商品</b>。
          <b>免费专区</b> = 价格 0 的商品；
          <b>付费商品</b> = 标价商品。
          公开线路无需购买，同步即可用。上下架后点「刷新商品」。
          {session ? ` 当前账号：${session.username}` : ''}
          {lastCatalogAt ? ` · 列表更新于 ${lastCatalogAt}` : ''}
        </Alert>

        {lastSync ? (
          <Alert severity="success" sx={{ mb: 2 }}>
            {lastSync}
          </Alert>
        ) : null}

        <Stack
          direction="row"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 1,
          }}
        >
          <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CardGiftcardRounded color="success" /> 免费专区
          </Typography>
          <Button
            size="small"
            startIcon={<RefreshRounded />}
            loading={loading}
            onClick={() => void onRefreshCatalog()}
          >
            刷新
          </Button>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          价格为 0 的上架商品。开通后解锁绑定线路，再同步到代理页
        </Typography>

        <Grid container spacing={2} sx={{ mb: 3 }}>
          {(catalog?.free || []).length === 0 && !loading ? (
            <Grid size={{ xs: 12 }}>
              <Alert severity="warning">
                暂无免费商品。请管理员：新建商品 → 价格填 0 → 绑定线路 → 上架
              </Alert>
            </Grid>
          ) : null}
          {(catalog?.free || []).map((item) => (
            <Grid key={item.id} size={{ xs: 12, sm: 6, md: 4 }}>
              <Card
                variant="outlined"
                sx={{
                  height: '100%',
                  borderColor: item.owned ? 'success.main' : 'divider',
                }}
              >
                <CardContent>
                  <Stack
                    direction="row"
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Typography sx={{ fontWeight: 700 }}>{item.name}</Typography>
                    {item.owned ? (
                      <Chip size="small" color="success" label="已开通" />
                    ) : (
                      <Chip size="small" color="success" variant="outlined" label="免费商品" />
                    )}
                  </Stack>
                  <Typography variant="h5" sx={{ mt: 1.5, fontWeight: 800 }}>
                    免费
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {item.description || `有效期 ${item.days || 30} 天`}
                    {item.source_name ? ` · 线路：${item.source_name}` : ''}
                  </Typography>
                </CardContent>
                <CardActions>
                  <Button
                    size="small"
                    variant={item.owned ? 'outlined' : 'contained'}
                    color="success"
                    startIcon={<ShoppingCartCheckoutRounded />}
                    onClick={() => goDetail(item)}
                  >
                    {item.owned ? '查看详情' : '查看并开通'}
                  </Button>
                  {item.owned ? (
                    <Button size="small" onClick={() => void onSync()} loading={syncing}>
                      同步节点
                    </Button>
                  ) : null}
                </CardActions>
              </Card>
            </Grid>
          ))}
        </Grid>

        <Divider sx={{ my: 2 }} />

        <Typography variant="h6" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          <WorkspacePremiumRounded color="warning" /> 付费商品
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          按商品价格售卖；开通后解锁所绑定的线路，再同步节点
        </Typography>

        <Grid container spacing={2}>
          {(catalog?.paid || []).length === 0 && !loading ? (
            <Grid size={{ xs: 12 }}>
              <Alert severity="warning">
                暂无在售付费商品。请管理员：新建商品 → 设价格 → 绑定「需解锁」的源 → 上架
              </Alert>
            </Grid>
          ) : null}
          {(catalog?.paid || []).map((item) => (
            <Grid key={item.id} size={{ xs: 12, sm: 6, md: 4 }}>
              <Card
                variant="outlined"
                sx={{
                  height: '100%',
                  borderColor: item.owned ? 'success.main' : 'divider',
                }}
              >
                <CardContent>
                  <Stack
                    direction="row"
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Typography sx={{ fontWeight: 700 }}>{item.name}</Typography>
                    {item.owned ? (
                      <Chip size="small" color="success" label="已开通" />
                    ) : (
                      <Chip size="small" color="warning" label="付费商品" />
                    )}
                  </Stack>
                  <Typography variant="h5" sx={{ mt: 1.5, fontWeight: 800 }}>
                    {item.price_label || '—'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {item.description || `有效期 ${item.days || 30} 天`}
                    {item.source_name ? ` · 线路：${item.source_name}` : ''}
                  </Typography>
                </CardContent>
                <CardActions>
                  <Button
                    size="small"
                    variant={item.owned ? 'outlined' : 'contained'}
                    startIcon={<ShoppingCartCheckoutRounded />}
                    onClick={() => goDetail(item)}
                  >
                    {item.owned ? '查看详情' : '查看详情 / 下单'}
                  </Button>
                  {item.owned ? (
                    <Button size="small" onClick={() => void onSync()} loading={syncing}>
                      同步节点
                    </Button>
                  ) : null}
                </CardActions>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Box>
    </BasePage>
  )
}
