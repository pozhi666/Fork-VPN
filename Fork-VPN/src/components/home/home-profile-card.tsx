import {
  CloudUploadOutlined,
  DnsOutlined,
  EventOutlined,
  LaunchOutlined,
  SpeedOutlined,
  StorageOutlined,
  UpdateOutlined,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  LinearProgress,
  Link,
  Stack,
  Typography,
  alpha,
  keyframes,
  useTheme,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

import { COMMERCIAL_MODE, isOfficialProfile } from '@/config/commercial'
import { useAppRefreshers } from '@/providers/app-data-context'
import { useAuth } from '@/providers/auth-provider'
import { openWebUrl, updateProfile } from '@/services/cmds'
import {
  commercialGetProfile,
  setTrafficPoolHint,
  type TrafficInfo,
} from '@/services/commercial'
import { showNotice } from '@/services/notice-service'
import parseTraffic from '@/utils/parse-traffic'

import { EnhancedCard } from './enhanced-card'

/** Fired after check-in / purchase so home traffic refreshes without full sync */
export const FORK_ENTITLEMENT_EVENT = 'fork-entitlement-updated'

export function notifyEntitlementUpdated() {
  try {
    window.dispatchEvent(new Event(FORK_ENTITLEMENT_EVENT))
  } catch {
    /* ignore */
  }
}

// 定义旋转动画
const round = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`

// 辅助函数解析URL和过期时间
const parseUrl = (url?: string) => {
  if (!url) return '-'
  if (url.startsWith('http')) return new URL(url).host
  return 'local'
}

const parseExpire = (expire?: number) => {
  if (!expire) return '-'
  return dayjs(expire * 1000).format('YYYY-MM-DD')
}

// 使用类型定义，而不是导入
interface ProfileExtra {
  upload: number
  download: number
  total: number
  expire: number
}

interface ProfileItem {
  uid: string
  type?: 'local' | 'remote' | 'merge' | 'script'
  name?: string
  desc?: string
  file?: string
  url?: string
  updated?: number
  extra?: ProfileExtra
  home?: string
  option?: any
}

interface HomeProfileCardProps {
  current: ProfileItem | null | undefined
  onProfileUpdated?: () => void
}

// 提取独立组件减少主组件复杂度
const ProfileDetails = ({
  current,
  onUpdateProfile,
  updating,
  commercialTraffic,
  commercialExpire,
  commercialBalanceYuan,
}: {
  current: ProfileItem
  onUpdateProfile: () => void
  updating: boolean
  /** Backend account quota (check-in / purchases) — preferred over profile.extra for official */
  commercialTraffic?: TrafficInfo | null
  commercialExpire?: number | null
  commercialBalanceYuan?: string | null
}) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const navigate = useNavigate()
  const { session } = useAuth()

  // Prefer live backend traffic for commercial official profile (survives check-in without re-sync)
  const usedTraffic = useMemo(() => {
    if (commercialTraffic && !commercialTraffic.unlimited) {
      return Number(commercialTraffic.used_bytes || 0)
    }
    if (commercialTraffic?.unlimited) {
      return Number(commercialTraffic.used_bytes || 0)
    }
    if (!current.extra) return 0
    return current.extra.upload + current.extra.download
  }, [current.extra, commercialTraffic])

  const totalTraffic = useMemo(() => {
    if (commercialTraffic) {
      if (commercialTraffic.unlimited) return 0 // show as unlimited
      return Number(commercialTraffic.limit_bytes || 0)
    }
    return current.extra?.total || 0
  }, [current.extra, commercialTraffic])

  const trafficLabel = commercialTraffic?.label

  const trafficPercentage = useMemo(() => {
    if (commercialTraffic?.unlimited) return 0
    if (!totalTraffic || totalTraffic <= 0) return 0
    return Math.min(Math.round((usedTraffic / totalTraffic) * 100), 100)
  }, [usedTraffic, totalTraffic, commercialTraffic])

  const expireAt =
    commercialExpire && commercialExpire > 0
      ? commercialExpire
      : current.extra?.expire || 0

  return (
    <Box>
      <Stack spacing={2}>
        {current.url && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <DnsOutlined fontSize="small" color="action" />
            <Typography
              variant="body2"
              color="text.secondary"
              noWrap
              sx={{ display: 'flex', alignItems: 'center' }}
            >
              <span style={{ flexShrink: 0 }}>{t('shared.labels.from')}: </span>
              {current.home ? (
                <Link
                  component="button"
                  onClick={() => current.home && openWebUrl(current.home)}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    minWidth: 0,
                    maxWidth: 'calc(100% - 40px)',
                    ml: 0.5,
                    fontWeight: 'medium',
                  }}
                  title={parseUrl(current.url)}
                >
                  <Typography
                    component="span"
                    sx={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    {parseUrl(current.url)}
                  </Typography>
                  <LaunchOutlined
                    fontSize="inherit"
                    sx={{
                      ml: 0.5,
                      fontSize: '0.8rem',
                      opacity: 0.7,
                      flexShrink: 0,
                    }}
                  />
                </Link>
              ) : (
                <Typography
                  component="span"
                  sx={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    flex: 1,
                    ml: 0.5,
                    fontWeight: 'medium',
                  }}
                  title={parseUrl(current.url)}
                >
                  {parseUrl(current.url)}
                </Typography>
              )}
            </Typography>
          </Stack>
        )}

        {current.updated && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <UpdateOutlined
              fontSize="small"
              color="action"
              sx={{
                cursor: 'pointer',
                animation: updating ? `${round} 1.5s linear infinite` : 'none',
              }}
              onClick={onUpdateProfile}
            />
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ cursor: 'pointer' }}
              onClick={onUpdateProfile}
            >
              {t('shared.labels.updateTime')}:{' '}
              <Box component="span" sx={{ fontWeight: 'medium' }}>
                {dayjs(current.updated * 1000).format('YYYY-MM-DD HH:mm')}
              </Box>
            </Typography>
          </Stack>
        )}

        {COMMERCIAL_MODE && session ? (
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Typography variant="body2" color="text.secondary">
              账户余额：{' '}
              <Box
                component="span"
                sx={{ fontWeight: 700, color: 'primary.main', fontSize: 15 }}
              >
                ¥{commercialBalanceYuan ?? '0.00'}
              </Box>
            </Typography>
            <Button
              size="small"
              variant="outlined"
              onClick={() => navigate('/account#balance')}
              sx={{ borderRadius: 1.5, minWidth: 0, px: 1.25 }}
            >
              充值
            </Button>
          </Stack>
        ) : null}

        {(commercialTraffic || current.extra) && (
          <>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <SpeedOutlined fontSize="small" color="action" />
              <Typography variant="body2" color="text.secondary">
                流量额度：{' '}
                <Box component="span" sx={{ fontWeight: 'medium' }}>
                  {trafficLabel
                    ? trafficLabel
                    : commercialTraffic?.unlimited
                      ? `${parseTraffic(usedTraffic)} / 不限`
                      : `${parseTraffic(usedTraffic)} / ${parseTraffic(totalTraffic)}`}
                </Box>
              </Typography>
            </Stack>

            {commercialTraffic?.is_paid_user ? (
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label="付费"
                sx={{ alignSelf: 'flex-start', height: 22, fontWeight: 600 }}
              />
            ) : commercialTraffic ? (
              <Chip
                size="small"
                color="primary"
                variant="outlined"
                label="免费"
                sx={{ alignSelf: 'flex-start', height: 22, fontWeight: 600 }}
              />
            ) : null}

            {expireAt > 0 && (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <EventOutlined fontSize="small" color="action" />
                <Typography variant="body2" color="text.secondary">
                  {t('shared.labels.expireTime')}:{' '}
                  <Box component="span" sx={{ fontWeight: 'medium' }}>
                    {parseExpire(expireAt)}
                  </Box>
                </Typography>
              </Stack>
            )}

            {/* Dual traffic pools: free + paid bars */}
            {commercialTraffic?.free || commercialTraffic?.paid ? (
              <Stack spacing={1.25} sx={{ mt: 0.5 }}>
                <Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mb: 0.5, display: 'block' }}
                  >
                    免费流量{' '}
                    {commercialTraffic.free?.label ||
                      (commercialTraffic.free?.unlimited
                        ? '不限'
                        : `${parseTraffic(commercialTraffic.free?.used_bytes || 0)} / ${parseTraffic(commercialTraffic.free?.limit_bytes || 0)}`)}
                  </Typography>
                  {(commercialTraffic.free?.limit_bytes || 0) > 0 ? (
                    <LinearProgress
                      variant="determinate"
                      color="success"
                      value={Math.min(
                        100,
                        Math.round(
                          ((commercialTraffic.free?.used_bytes || 0) /
                            Math.max(1, commercialTraffic.free?.limit_bytes || 1)) *
                            100,
                        ),
                      )}
                      sx={{
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: alpha(theme.palette.success.main, 0.12),
                      }}
                    />
                  ) : (
                    <LinearProgress
                      variant="determinate"
                      color="success"
                      value={0}
                      sx={{
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: alpha(theme.palette.success.main, 0.12),
                      }}
                    />
                  )}
                </Box>
                <Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mb: 0.5, display: 'block' }}
                  >
                    付费流量{' '}
                    {commercialTraffic.paid?.label ||
                      ((commercialTraffic.paid?.limit_bytes || 0) > 0
                        ? `${parseTraffic(commercialTraffic.paid?.used_bytes || 0)} / ${parseTraffic(commercialTraffic.paid?.limit_bytes || 0)}`
                        : commercialTraffic.is_paid_user
                          ? commercialTraffic.paid?.unlimited
                            ? '不限'
                            : '未配置额度'
                          : '未开通')}
                  </Typography>
                  {(commercialTraffic.paid?.limit_bytes || 0) > 0 ? (
                    <LinearProgress
                      variant="determinate"
                      color="warning"
                      value={Math.min(
                        100,
                        Math.round(
                          ((commercialTraffic.paid?.used_bytes || 0) /
                            Math.max(1, commercialTraffic.paid?.limit_bytes || 1)) *
                            100,
                        ),
                      )}
                      sx={{
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: alpha(theme.palette.warning.main, 0.12),
                      }}
                    />
                  ) : (
                    <LinearProgress
                      variant="determinate"
                      color="warning"
                      value={0}
                      sx={{
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: alpha(theme.palette.warning.main, 0.12),
                        opacity: commercialTraffic.is_paid_user ? 1 : 0.45,
                      }}
                    />
                  )}
                </Box>
              </Stack>
            ) : (
              !commercialTraffic?.unlimited &&
              totalTraffic > 0 && (
                <Box sx={{ mt: 1 }}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mb: 0.5, display: 'block' }}
                  >
                    {trafficPercentage}%
                  </Typography>
                  <LinearProgress
                    variant="determinate"
                    value={trafficPercentage}
                    sx={{
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: alpha(theme.palette.primary.main, 0.12),
                    }}
                  />
                </Box>
              )
            )}
          </>
        )}
      </Stack>
    </Box>
  )
}

// 提取空配置组件
const EmptyProfile = ({ onClick }: { onClick: () => void }) => {
  const { t } = useTranslation()

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        py: 2.4,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'action.hover' },
        borderRadius: 2,
      }}
      onClick={onClick}
    >
      <CloudUploadOutlined
        sx={{ fontSize: 60, color: 'primary.main', mb: 2 }}
      />
      <Typography variant="h6" gutterBottom>
        {t('profiles.page.actions.import')} {t('profiles.page.title')}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t('profiles.components.card.labels.clickToImport')}
      </Typography>
    </Box>
  )
}

export const HomeProfileCard = ({
  current,
  onProfileUpdated,
}: HomeProfileCardProps) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { refreshAll } = useAppRefreshers()
  const { syncOfficial, session } = useAuth()

  // 更新当前订阅
  const [updating, setUpdating] = useState(false)
  const [commercialTraffic, setCommercialTraffic] =
    useState<TrafficInfo | null>(null)
  const [commercialExpire, setCommercialExpire] = useState<number | null>(null)
  const [commercialBalanceYuan, setCommercialBalanceYuan] = useState<
    string | null
  >(null)

  // Live backend quota for official profile (check-in / purchases)
  const loadCommercialQuota = useCallback(async () => {
    if (!COMMERCIAL_MODE || !session || !current || !isOfficialProfile(current)) {
      setCommercialTraffic(null)
      setCommercialExpire(null)
      setCommercialBalanceYuan(null)
      return
    }
    try {
      const p = await commercialGetProfile()
      setCommercialBalanceYuan(
        p.balance_yuan ||
          ((Number(p.balance_cents) || 0) / 100).toFixed(2),
      )
      const t = p.traffic
      if (t) {
        const fmtPool = (pool?: {
          label?: string
          unlimited?: boolean
          used_bytes?: number
          limit_bytes?: number
        }) => {
          if (!pool) return null
          if (pool.label) return pool.label
          if (pool.unlimited) return `${parseTraffic(pool.used_bytes || 0)} / 不限`
          if ((pool.limit_bytes || 0) > 0) {
            return `${parseTraffic(pool.used_bytes || 0)} / ${parseTraffic(pool.limit_bytes || 0)}`
          }
          return '0 / 0'
        }
        const freeLabel = fmtPool(t.free)
        const paidLabel = fmtPool(t.paid)
        const dualLabel =
          freeLabel || paidLabel
            ? `免费 ${freeLabel || '—'} · 付费 ${paidLabel || '未开通'}`
            : t.label || null
        // progress: free pool for free users, paid pool for paid users
        const usePaid =
          t.is_paid_user || p.is_paid_user || (t.paid?.limit_bytes || 0) > 0
        const primary = usePaid && (t.paid?.limit_bytes || 0) > 0 ? t.paid : t.free
        // Hint for dual-pool traffic reporting
        setTrafficPoolHint(
          usePaid && (t.paid?.limit_bytes || 0) > 0 ? 'paid' : 'free',
        )
        setCommercialTraffic({
          ...t,
          free: t.free,
          paid: t.paid,
          is_paid_user: t.is_paid_user ?? p.is_paid_user,
          unlimited: primary ? !!primary.unlimited && !(primary.limit_bytes || 0) : !!t.unlimited,
          used_bytes: primary?.used_bytes ?? t.used_bytes ?? 0,
          limit_bytes: primary?.limit_bytes ?? t.limit_bytes ?? 0,
          exhausted: primary?.exhausted ?? t.exhausted,
          label: dualLabel || t.label || undefined,
        })
      } else {
        setCommercialTraffic(null)
      }
      setCommercialExpire(
        Number(p.entitlement_until || p.expire_at || 0) || null,
      )
    } catch {
      // keep last known / fall back to profile.extra
    }
  }, [session, current])

  useEffect(() => {
    void loadCommercialQuota()
  }, [loadCommercialQuota])

  useEffect(() => {
    const onEnt = () => void loadCommercialQuota()
    window.addEventListener(FORK_ENTITLEMENT_EVENT, onEnt)
    const onVis = () => {
      if (document.visibilityState === 'visible') void loadCommercialQuota()
    }
    document.addEventListener('visibilitychange', onVis)
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadCommercialQuota()
    }, 45_000)
    return () => {
      window.removeEventListener(FORK_ENTITLEMENT_EVENT, onEnt)
      document.removeEventListener('visibilitychange', onVis)
      window.clearInterval(t)
    }
  }, [loadCommercialQuota])

  const onUpdateProfile = useLockFn(async () => {
    if (!current?.uid) return

    setUpdating(true)
    try {
      if (COMMERCIAL_MODE && isOfficialProfile(current)) {
        await syncOfficial()
        await loadCommercialQuota()
      } else {
        await updateProfile(current.uid, current.option)
      }
      onProfileUpdated?.()

      // 刷新首页数据
      refreshAll()
    } catch (err) {
      showNotice.error(err, 3000)
    } finally {
      setUpdating(false)
    }
  })

  // 导航到订阅页面
  const goToProfiles = useCallback(() => {
    navigate('/profile')
  }, [navigate])

  // 卡片标题
  const cardTitle = useMemo(() => {
    if (!current) return t('profiles.page.title')

    if (!current.home) return current.name

    return (
      <Link
        component="button"
        variant="h6"
        onClick={() => current.home && openWebUrl(current.home)}
        sx={{
          color: 'inherit',
          textDecoration: 'none',
          display: 'flex',
          alignItems: 'center',
          minWidth: 0,
          maxWidth: '100%',
          fontWeight: 'medium',
          fontSize: 18,
          '& > span': {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          },
        }}
        title={current.name}
      >
        <span>{current.name}</span>
        <LaunchOutlined
          fontSize="inherit"
          sx={{
            ml: 0.5,
            fontSize: '0.8rem',
            opacity: 0.7,
            flexShrink: 0,
          }}
        />
      </Link>
    )
  }, [current, t])

  // 卡片操作按钮
  const cardAction = useMemo(() => {
    if (!current) return null

    return (
      <Button
        variant="outlined"
        size="small"
        onClick={goToProfiles}
        endIcon={<StorageOutlined fontSize="small" />}
        sx={{ borderRadius: 1.5 }}
      >
        {t('layout.components.navigation.tabs.profiles')}
      </Button>
    )
  }, [current, goToProfiles, t])

  return (
    <EnhancedCard
      title={cardTitle}
      icon={<CloudUploadOutlined />}
      iconColor="info"
      action={cardAction}
    >
      {current ? (
        <ProfileDetails
          current={current}
          onUpdateProfile={onUpdateProfile}
          updating={updating}
          commercialTraffic={
            COMMERCIAL_MODE && isOfficialProfile(current)
              ? commercialTraffic
              : null
          }
          commercialExpire={
            COMMERCIAL_MODE && isOfficialProfile(current)
              ? commercialExpire
              : null
          }
          commercialBalanceYuan={
            COMMERCIAL_MODE && isOfficialProfile(current)
              ? commercialBalanceYuan
              : null
          }
        />
      ) : (
        <EmptyProfile onClick={goToProfiles} />
      )}
    </EnhancedCard>
  )
}
