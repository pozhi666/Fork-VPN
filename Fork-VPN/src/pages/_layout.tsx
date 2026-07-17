import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { LogoutRounded } from '@mui/icons-material'
import {
  Box,
  IconButton,
  List,
  Menu,
  MenuItem,
  Paper,
  ThemeProvider,
  Tooltip,
  Typography,
} from '@mui/material'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import type { CSSProperties } from 'react'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router'

import { PRODUCT_NAME } from '@/config/commercial'
import { BaseErrorBoundary } from '@/components/base'
import { LayoutItem } from '@/components/layout/layout-item'
import { LayoutTraffic } from '@/components/layout/layout-traffic'
import { AnnouncementBellButton } from '@/components/home/announcement-center'
import { NoticeManager } from '@/components/layout/notice-manager'
import { UpdateButton } from '@/components/layout/update-button'
import {
  WindowControls,
  WindowResizeHandles,
} from '@/components/layout/window-controller'
import { useI18n } from '@/hooks/use-i18n'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import { useWindowDecorations } from '@/hooks/use-window'
import { useAuth } from '@/providers/auth-provider'
import { useThemeMode } from '@/services/states'
import getSystem from '@/utils/get-system'

import {
  useCustomTheme,
  useLayoutEvents,
  useLoadingOverlay,
  useNavMenuOrder,
} from './_layout/hooks'
import { handleNoticeMessage } from './_layout/utils'
import { navItems, preloadLogsPage, preloadNavigationRoutes } from './_routers'

import 'dayjs/locale/ru'
import 'dayjs/locale/zh-cn'

export const portableFlag = false

const LogsPage = lazy(() => preloadLogsPage())

type NavItem = (typeof navItems)[number]

type MenuContextPosition = { top: number; left: number }

interface SortableNavMenuItemProps {
  item: NavItem
  label: string
}

const SortableNavMenuItem = ({ item, label }: SortableNavMenuItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.path,
  })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  if (isDragging) {
    style.zIndex = 100
  }

  return (
    <LayoutItem
      to={item.path}
      icon={item.icon}
      onPreload={item.preload}
      sortable={{
        setNodeRef,
        attributes,
        listeners,
        style,
        isDragging,
      }}
    >
      {label}
    </LayoutItem>
  )
}

dayjs.extend(relativeTime)

const OS = getSystem()

const Layout = () => {
  const mode = useThemeMode()
  const isDark = mode !== 'light'
  const { t } = useTranslation()
  const { theme } = useCustomTheme()
  const { verge, mutateVerge, patchVerge } = useVerge()
  const { language } = verge ?? {}
  const navCollapsed = verge?.collapse_navbar ?? false
  const { switchLanguage } = useI18n()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const isLogsPage = pathname === '/logs'
  const pageVisible = useVisibility()
  const themeReady = useMemo(() => Boolean(theme), [theme])
  const {
    enabled: commercialEnabled,
    ready: authReady,
    session,
    logout,
  } = useAuth()

  const [menuUnlocked, setMenuUnlocked] = useState(false)
  const [menuContextPosition, setMenuContextPosition] =
    useState<MenuContextPosition | null>(null)

  const windowControlsRef = useRef<any>(null)
  const { decorated } = useWindowDecorations()

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleMenuOrderOptimisticUpdate = useCallback(
    (order: string[]) => {
      mutateVerge(
        (prev) => (prev ? { ...prev, menu_order: order } : prev),
        false,
      )
    },
    [mutateVerge],
  )

  const handleMenuOrderPersist = useCallback(
    (order: string[]) => patchVerge({ menu_order: order }),
    [patchVerge],
  )

  const {
    menuOrder,
    navItemMap,
    handleMenuDragEnd,
    isDefaultOrder,
    resetMenuOrder,
  } = useNavMenuOrder({
    enabled: menuUnlocked,
    items: navItems,
    storedOrder: verge?.menu_order,
    onOptimisticUpdate: handleMenuOrderOptimisticUpdate,
    onPersist: handleMenuOrderPersist,
  })

  const handleMenuContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setMenuContextPosition({ top: event.clientY, left: event.clientX })
    },
    [],
  )

  const handleMenuContextClose = useCallback(() => {
    setMenuContextPosition(null)
  }, [])

  const handleResetMenuOrder = useCallback(() => {
    setMenuContextPosition(null)
    void resetMenuOrder()
  }, [resetMenuOrder])

  const handleUnlockMenu = useCallback(() => {
    setMenuUnlocked(true)
    setMenuContextPosition(null)
  }, [])

  const handleLockMenu = useCallback(() => {
    setMenuUnlocked(false)
    setMenuContextPosition(null)
  }, [])

  const handleToggleNavCollapsed = useCallback(() => {
    setMenuContextPosition(null)
    void patchVerge({ collapse_navbar: !navCollapsed })
  }, [navCollapsed, patchVerge])

  const customTitlebar = useMemo(
    () =>
      decorated === false ? (
        <div className="the_titlebar">
          <div
            className="the_titlebar-drag-region"
            data-tauri-drag-region="true"
          />
          <WindowControls ref={windowControlsRef} />
        </div>
      ) : null,
    [decorated],
  )

  useLoadingOverlay(themeReady)

  useEffect(() => {
    if (!themeReady || !pageVisible) {
      return
    }

    const controller = new AbortController()
    const timerId = window.setTimeout(() => {
      void preloadNavigationRoutes(controller.signal)
    }, 2000)

    return () => {
      controller.abort()
      window.clearTimeout(timerId)
    }
  }, [themeReady, pageVisible])

  const handleNotice = useCallback(
    (payload: [string, string]) => {
      const [status, msg] = payload
      try {
        handleNoticeMessage(status, msg, t, navigate)
      } catch (error) {
        console.error('[通知处理] 失败:', error)
      }
    },
    [t, navigate],
  )

  useLayoutEvents(handleNotice)

  useEffect(() => {
    if (language) {
      dayjs.locale(language === 'zh' ? 'zh-cn' : language)
      switchLanguage(language)
    }
  }, [language, switchLanguage])

  useEffect(() => {
    if (!commercialEnabled || !authReady) return
    if (!session) {
      navigate('/login', { replace: true })
    }
  }, [commercialEnabled, authReady, session, navigate])

  if (!themeReady || (commercialEnabled && !authReady)) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          background: mode === 'light' ? '#f1f5f9' : '#070b14',
          transition: 'background 0.2s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: mode === 'light' ? '#0f172a' : '#f8fafc',
        }}
      ></div>
    )
  }

  if (commercialEnabled && !session) {
    return null
  }

  return (
    <ThemeProvider theme={theme}>
      <NoticeManager position={verge?.notice_position} />
      <div
        style={{
          animation: 'fadeIn 0.5s',
          WebkitAnimation: 'fadeIn 0.5s',
        }}
      />
      <style>
        {`
            @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          `}
      </style>
      <Paper
        square
        elevation={0}
        className={`${OS} layout${navCollapsed ? ' layout--nav-collapsed' : ''}`}
        style={{
          borderTopLeftRadius: '0px',
          borderTopRightRadius: '0px',
        }}
        onContextMenu={(e) => {
          if (
            OS === 'windows' &&
            !['input', 'textarea'].includes(
              e.currentTarget.tagName.toLowerCase(),
            ) &&
            !e.currentTarget.isContentEditable
          ) {
            e.preventDefault()
          }
        }}
        sx={[
          ({ palette }) => ({ bgcolor: palette.background.paper }),
          OS === 'linux'
            ? {
                borderRadius: '8px',
                width: '100vw',
                height: '100vh',
              }
            : {},
        ]}
      >
        {decorated === false && <WindowResizeHandles />}

        {/* Custom titlebar - rendered only when decorated is false, memoized for performance */}
        {customTitlebar}

        <div className="layout-content">
          <div className="layout-content__left">
            <div className="the-logo" data-tauri-drag-region="false">
              <Box
                data-tauri-drag-region="true"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  minWidth: 0,
                  pr: 5,
                }}
              >
                <Box
                  sx={{
                    height: 28,
                    width: 28,
                    borderRadius: '8px',
                    display: 'grid',
                    placeItems: 'center',
                    fontWeight: 700,
                    fontSize: 13,
                    color: '#042f2e',
                    background: '#2DD4BF',
                    flexShrink: 0,
                  }}
                >
                  F
                </Box>
                {!navCollapsed && (
                  <Box sx={{ minWidth: 0 }}>
                    <Box
                      component="span"
                      sx={{
                        display: 'block',
                        fontWeight: 600,
                        fontSize: 14,
                        letterSpacing: -0.1,
                        lineHeight: 1.25,
                        color: '#F3F4F6',
                      }}
                    >
                      {PRODUCT_NAME}
                    </Box>
                  </Box>
                )}
              </Box>
              <AnnouncementBellButton className="the-ann-btn" />
              <UpdateButton className="the-newbtn" />
            </div>

            {menuUnlocked && (
              <Box
                sx={(theme) => ({
                  px: 1.5,
                  py: 0.75,
                  mx: 'auto',
                  mb: 1,
                  maxWidth: 250,
                  borderRadius: 1.5,
                  fontSize: 12,
                  fontWeight: 600,
                  textAlign: 'center',
                  color: theme.palette.warning.contrastText,
                  bgcolor:
                    theme.palette.mode === 'light'
                      ? theme.palette.warning.main
                      : theme.palette.warning.dark,
                })}
              >
                {t('layout.components.navigation.menu.reorderMode')}
              </Box>
            )}

            {menuUnlocked ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleMenuDragEnd}
              >
                <SortableContext items={menuOrder}>
                  <List
                    className="the-menu"
                    onContextMenu={handleMenuContextMenu}
                  >
                    {menuOrder.map((path) => {
                      const item = navItemMap.get(path)
                      if (!item) {
                        return null
                      }
                      return (
                        <SortableNavMenuItem
                          key={item.path}
                          item={item}
                          label={t(item.label)}
                        />
                      )
                    })}
                  </List>
                </SortableContext>
              </DndContext>
            ) : (
              <List className="the-menu" onContextMenu={handleMenuContextMenu}>
                {menuOrder.map((path) => {
                  const item = navItemMap.get(path)
                  if (!item) {
                    return null
                  }
                  return (
                    <LayoutItem
                      key={item.path}
                      to={item.path}
                      icon={item.icon}
                      onPreload={item.preload}
                    >
                      {t(item.label)}
                    </LayoutItem>
                  )
                })}
              </List>
            )}

            <Menu
              open={Boolean(menuContextPosition)}
              onClose={handleMenuContextClose}
              anchorReference="anchorPosition"
              anchorPosition={
                menuContextPosition
                  ? {
                      top: menuContextPosition.top,
                      left: menuContextPosition.left,
                    }
                  : undefined
              }
              transitionDuration={200}
              slotProps={{
                list: {
                  sx: { py: 0.5 },
                },
              }}
            >
              <MenuItem onClick={handleToggleNavCollapsed} dense>
                {navCollapsed
                  ? t('layout.components.navigation.menu.expandNavBar')
                  : t('layout.components.navigation.menu.collapseNavBar')}
              </MenuItem>
              <MenuItem
                onClick={menuUnlocked ? handleLockMenu : handleUnlockMenu}
                dense
              >
                {menuUnlocked
                  ? t('layout.components.navigation.menu.lock')
                  : t('layout.components.navigation.menu.unlock')}
              </MenuItem>
              <MenuItem
                onClick={handleResetMenuOrder}
                dense
                disabled={isDefaultOrder}
              >
                {t('layout.components.navigation.menu.restoreDefaultOrder')}
              </MenuItem>
            </Menu>

            {commercialEnabled && session ? (
              <div className="the-account">
                <Box
                  onClick={() => navigate('/account')}
                  title={
                    navCollapsed
                      ? `${session.username} · ${session.plan || '账户'}`
                      : '打开个人中心'
                  }
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    mx: navCollapsed ? 0.5 : 1,
                    mb: 0.25,
                    px: navCollapsed ? 0.75 : 1,
                    py: 0.75,
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'background .12s ease',
                    justifyContent: navCollapsed ? 'center' : 'flex-start',
                    '&:hover': {
                      bgcolor: 'rgba(255,255,255,0.04)',
                    },
                  }}
                >
                  <Box
                    sx={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      flexShrink: 0,
                      display: 'grid',
                      placeItems: 'center',
                      fontWeight: 600,
                      fontSize: 12,
                      color: '#9CA3AF',
                      background: 'rgba(255,255,255,0.08)',
                    }}
                  >
                    {(session.username || '?').trim().charAt(0).toUpperCase() ||
                      '?'}
                  </Box>

                  {!navCollapsed && (
                    <>
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography
                          noWrap
                          sx={{
                            fontSize: 12.5,
                            fontWeight: 500,
                            lineHeight: 1.25,
                            color: 'rgba(243,244,246,0.92)',
                          }}
                        >
                          {session.username}
                        </Typography>
                        <Typography
                          noWrap
                          sx={{
                            mt: 0.15,
                            fontSize: 11,
                            fontWeight: 500,
                            lineHeight: 1.2,
                            color: 'rgba(156,163,175,0.9)',
                          }}
                        >
                          {session.plan || '免费套餐'}
                        </Typography>
                      </Box>
                      <Tooltip title="退出登录" placement="top">
                        <IconButton
                          size="small"
                          aria-label="退出登录"
                          onClick={(e) => {
                            e.stopPropagation()
                            void logout().then(() =>
                              navigate('/login', { replace: true }),
                            )
                          }}
                          sx={{
                            width: 26,
                            height: 26,
                            flexShrink: 0,
                            color: 'rgba(156,163,175,0.75)',
                            borderRadius: '6px',
                            '&:hover': {
                              color: '#FCA5A5',
                              bgcolor: 'rgba(248,113,113,0.1)',
                            },
                          }}
                        >
                          <LogoutRounded sx={{ fontSize: 15 }} />
                        </IconButton>
                      </Tooltip>
                    </>
                  )}
                </Box>
              </div>
            ) : null}

            <div className="the-traffic">
              <LayoutTraffic />
            </div>
          </div>

          <div className="layout-content__right">
            <div className="the-bar"></div>
            <div className="the-content">
              <BaseErrorBoundary>
                <Outlet />
              </BaseErrorBoundary>
              {isLogsPage && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                  }}
                >
                  <Suspense fallback={null}>
                    <LogsPage />
                  </Suspense>
                </div>
              )}
            </div>
          </div>
        </div>
      </Paper>
    </ThemeProvider>
  )
}

export default Layout
