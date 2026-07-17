import {
  CampaignRounded,
  CheckCircleOutlineRounded,
  CloseRounded,
  DoneAllRounded,
  NotificationsNoneRounded,
  RefreshRounded,
} from '@mui/icons-material'
import {
  alpha,
  Badge,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { COMMERCIAL_MODE } from '@/config/commercial'
import { useAuth } from '@/providers/auth-provider'
import {
  countUnread,
  fetchAnnouncements,
  formatAnnTime,
  isUnread,
  loadReadIds,
  markAllRead,
  markRead,
  markSessionPopupDone,
  sessionPopupDone,
} from '@/services/announcement-state'
import type { AnnouncementItem } from '@/services/commercial'

interface AnnouncementContextValue {
  items: AnnouncementItem[]
  unread: number
  loading: boolean
  openCenter: () => void
  refresh: () => Promise<void>
}

const AnnouncementContext = createContext<AnnouncementContextValue | null>(null)

export function useAnnouncements() {
  const ctx = useContext(AnnouncementContext)
  if (!ctx) {
    // Safe fallback when provider not mounted (non-commercial / early boot)
    return {
      items: [] as AnnouncementItem[],
      unread: 0,
      loading: false,
      openCenter: () => {},
      refresh: async () => {},
    }
  }
  return ctx
}

export function AnnouncementProvider({ children }: { children: ReactNode }) {
  const theme = useTheme()
  const { session, enabled } = useAuth()
  const [items, setItems] = useState<AnnouncementItem[]>([])
  const [readIds, setReadIds] = useState<Set<string>>(() => loadReadIds())
  const [loading, setLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [active, setActive] = useState<AnnouncementItem | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!COMMERCIAL_MODE || !enabled || !session) {
      setItems([])
      return
    }
    setLoading(true)
    try {
      const list = await fetchAnnouncements()
      setItems(list)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [enabled, session])

  useEffect(() => {
    void refresh()
    if (!session) return
    const timer = window.setInterval(() => void refresh(), 5 * 60_000)
    return () => window.clearInterval(timer)
  }, [refresh, session])

  const unread = useMemo(() => countUnread(items, readIds), [items, readIds])

  const openCenter = useCallback(() => setDrawerOpen(true), [])

  const openDetail = useCallback((item: AnnouncementItem) => {
    setActive(item)
    setDetailOpen(true)
    setReadIds(markRead(item.id))
  }, [])

  // Auto popup newest unread once per session
  useEffect(() => {
    if (!session || !items.length || sessionPopupDone()) return
    const newest = items.find((i) => isUnread(i.id, readIds))
    if (!newest) {
      markSessionPopupDone()
      return
    }
    markSessionPopupDone()
    // slight delay so home paints first
    const t = window.setTimeout(() => openDetail(newest), 600)
    return () => window.clearTimeout(t)
  }, [session, items, readIds, openDetail])

  const value = useMemo<AnnouncementContextValue>(
    () => ({
      items,
      unread,
      loading,
      openCenter,
      refresh,
    }),
    [items, unread, loading, openCenter, refresh],
  )

  if (!COMMERCIAL_MODE) {
    return <>{children}</>
  }

  return (
    <AnnouncementContext.Provider value={value}>
      {children}

      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        slotProps={{
          paper: {
            sx: (t) => ({
              width: { xs: '100%', sm: 400 },
              bgcolor:
                t.palette.mode === 'dark' ? '#1a1f28' : t.palette.background.paper,
              backgroundImage: 'none',
              color: 'text.primary',
            }),
          },
        }}
      >
        <Box
          sx={{
            px: 2,
            py: 1.5,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <CampaignRounded color="primary" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 700 }}>公告中心</Typography>
            <Typography variant="caption" color="text.secondary">
              {unread > 0 ? `${unread} 条未读` : '全部已读'}
              {items.length ? ` · 共 ${items.length} 条` : ''}
            </Typography>
          </Box>
          <Tooltip title="刷新">
            <IconButton size="small" onClick={() => void refresh()} disabled={loading}>
              <RefreshRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="全部已读">
            <span>
              <IconButton
                size="small"
                disabled={!unread}
                onClick={() => setReadIds(markAllRead(items))}
              >
                <DoneAllRounded fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" onClick={() => setDrawerOpen(false)}>
            <CloseRounded fontSize="small" />
          </IconButton>
        </Box>

        {!items.length ? (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <CampaignRounded sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
            <Typography color="text.secondary">暂无公告</Typography>
            <Typography variant="caption" color="text.disabled">
              管理员可在后台「公告」发布
            </Typography>
          </Box>
        ) : (
          <List disablePadding sx={{ overflow: 'auto', flex: 1 }}>
            {items.map((item, idx) => {
              const unreadItem = isUnread(item.id, readIds)
              return (
                <Box key={item.id}>
                  {idx > 0 ? <Divider /> : null}
                  <ListItemButton
                    onClick={() => openDetail(item)}
                    sx={{
                      alignItems: 'flex-start',
                      py: 1.5,
                      px: 2,
                      bgcolor: unreadItem
                        ? alpha(theme.palette.primary.main, 0.06)
                        : 'transparent',
                    }}
                  >
                    <Box
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        mt: 1,
                        mr: 1.5,
                        flexShrink: 0,
                        bgcolor: unreadItem ? 'primary.main' : 'transparent',
                        border: unreadItem ? 0 : '1px solid',
                        borderColor: 'divider',
                      }}
                    />
                    <ListItemText
                      primary={
                        <Stack
                          direction="row"
                          spacing={1}
                          sx={{ display: 'flex', alignItems: 'center' }}
                        >
                          <Typography
                            sx={{ flex: 1, minWidth: 0, fontWeight: unreadItem ? 700 : 500 }}
                            noWrap
                          >
                            {item.title}
                          </Typography>
                          {unreadItem ? (
                            <Chip size="small" color="primary" label="未读" sx={{ height: 20 }} />
                          ) : (
                            <CheckCircleOutlineRounded
                              sx={{ fontSize: 16, color: 'text.disabled' }}
                            />
                          )}
                        </Stack>
                      }
                      secondary={
                        <Box sx={{ mt: 0.5 }}>
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}
                          >
                            {item.body || '（无正文）'}
                          </Typography>
                          <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
                            {formatAnnTime(item.created_at)}
                          </Typography>
                        </Box>
                      }
                      slotProps={{
                        secondary: { component: 'div' },
                      }}
                    />
                  </ListItemButton>
                </Box>
              )
            })}
          </List>
        )}
      </Drawer>

      <Dialog
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        fullWidth
        maxWidth="sm"
        slotProps={{
          paper: {
            sx: (t) => ({
              borderRadius: 2,
              bgcolor:
                t.palette.mode === 'dark' ? '#1a1f28' : t.palette.background.paper,
            }),
          },
        }}
      >
        <DialogTitle sx={{ pr: 6 }}>
          <Typography component="span" variant="h6" sx={{ fontWeight: 700 }}>
            {active?.title}
          </Typography>
          {active?.created_at ? (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              {formatAnnTime(active.created_at)} ·{' '}
              {new Date((active.created_at || 0) * 1000).toLocaleString()}
            </Typography>
          ) : null}
          <IconButton
            onClick={() => setDetailOpen(false)}
            sx={{ position: 'absolute', right: 8, top: 8 }}
            size="small"
          >
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Typography
            variant="body1"
            sx={{
              whiteSpace: 'pre-wrap',
              lineHeight: 1.75,
              color: 'text.primary',
              fontSize: 15,
            }}
          >
            {active?.body || '（无正文内容）'}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 2, py: 1.5 }}>
          <Button onClick={() => { setDetailOpen(false); setDrawerOpen(true) }}>
            查看全部
          </Button>
          <Button variant="contained" onClick={() => setDetailOpen(false)}>
            知道了
          </Button>
        </DialogActions>
      </Dialog>
    </AnnouncementContext.Provider>
  )
}

/** Header bell with unread badge (keep tiny — parent .the-logo scales bare svg to 100%) */
export function AnnouncementBellButton({ className }: { className?: string }) {
  const { session, enabled } = useAuth()
  if (!COMMERCIAL_MODE || !enabled || !session) return null

  return <AnnouncementBellInner className={className} />
}

function AnnouncementBellInner({ className }: { className?: string }) {
  const { unread, openCenter, loading } = useAnnouncements()
  return (
    <Tooltip title={unread ? `${unread} 条未读公告` : '公告中心'}>
      <span className={className}>
        <IconButton
          size="small"
          color="inherit"
          onClick={openCenter}
          disabled={loading && !unread}
          sx={{
            width: 28,
            height: 28,
            p: 0.5,
            '& svg': { width: 18, height: 18, fontSize: 18 },
          }}
        >
          <Badge
            color="error"
            badgeContent={unread > 99 ? '99+' : unread}
            invisible={unread === 0}
            overlap="circular"
            sx={{
              '& .MuiBadge-badge': {
                fontSize: 10,
                height: 16,
                minWidth: 16,
                px: 0.4,
              },
            }}
          >
            <NotificationsNoneRounded sx={{ fontSize: 18, width: 18, height: 18 }} />
          </Badge>
        </IconButton>
      </span>
    </Tooltip>
  )
}

/** Home / store compact teaser card */
export function AnnouncementBanner() {
  const { session, enabled } = useAuth()
  if (!COMMERCIAL_MODE || !enabled || !session) return null
  return <AnnouncementBannerInner />
}

function AnnouncementBannerInner() {
  const theme = useTheme()
  const { items, unread, openCenter } = useAnnouncements()
  const readIds = loadReadIds()
  const top = items.find((i) => isUnread(i.id, readIds)) || items[0]

  if (!items.length) return null

  const isDark = theme.palette.mode === 'dark'

  return (
    <Box
      onClick={openCenter}
      sx={{
        mb: 2,
        p: 1.75,
        borderRadius: '12px',
        cursor: 'pointer',
        border: '1px solid',
        borderColor: unread
          ? alpha(theme.palette.primary.main, isDark ? 0.45 : 0.35)
          : isDark
            ? 'rgba(255,255,255,0.1)'
            : 'rgba(17,24,39,0.08)',
        // Brighter surface so announcements don't disappear into dark UI
        bgcolor: isDark
          ? unread
            ? alpha(theme.palette.primary.main, 0.18)
            : 'rgba(255,255,255,0.08)'
          : unread
            ? alpha(theme.palette.primary.main, 0.1)
            : '#FFFFFF',
        boxShadow: isDark
          ? 'none'
          : '0 1px 3px rgba(17,24,39,0.06)',
        transition: 'background .12s ease, border-color .12s ease',
        '&:hover': {
          borderColor: alpha(theme.palette.primary.main, 0.55),
          bgcolor: isDark
            ? alpha(theme.palette.primary.main, 0.22)
            : alpha(theme.palette.primary.main, 0.08),
        },
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ display: 'flex', alignItems: 'flex-start' }}
      >
        <Box
          sx={{
            width: 34,
            height: 34,
            borderRadius: '10px',
            display: 'grid',
            placeItems: 'center',
            bgcolor: alpha(theme.palette.primary.main, isDark ? 0.28 : 0.14),
            color: isDark ? '#5EEAD4' : 'primary.main',
            flexShrink: 0,
            '& svg': { fontSize: 18, width: 18, height: 18 },
          }}
        >
          <NotificationsNoneRounded />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack
            direction="row"
            spacing={1}
            sx={{ display: 'flex', alignItems: 'center', mb: 0.25 }}
          >
            <Typography
              variant="subtitle2"
              noWrap
              sx={{
                flex: 1,
                fontWeight: 700,
                color: 'text.primary',
              }}
            >
              {top?.title || '公告'}
            </Typography>
            {unread > 0 ? (
              <Chip size="small" color="primary" label={`${unread} 未读`} sx={{ height: 22 }} />
            ) : (
              <Chip size="small" variant="outlined" label="已读" sx={{ height: 22 }} />
            )}
          </Stack>
          <Typography
            variant="body2"
            noWrap
            sx={{
              mb: 0.5,
              color: isDark ? 'rgba(243,244,246,0.78)' : 'text.secondary',
            }}
          >
            {top?.body || '点击查看公告中心'}
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: isDark ? 'rgba(156,163,175,0.95)' : 'text.disabled' }}
          >
            {formatAnnTime(top?.created_at)} · 点击打开公告中心
          </Typography>
        </Box>
      </Stack>
    </Box>
  )
}
