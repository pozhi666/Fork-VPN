import DnsRoundedIcon from '@mui/icons-material/DnsRounded'
import ForkRightRoundedIcon from '@mui/icons-material/ForkRightRounded'
import HomeRoundedIcon from '@mui/icons-material/HomeRounded'
import LanguageRoundedIcon from '@mui/icons-material/LanguageRounded'
import LockOpenRoundedIcon from '@mui/icons-material/LockOpenRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import PersonRoundedIcon from '@mui/icons-material/PersonRounded'
import ShoppingCartRoundedIcon from '@mui/icons-material/ShoppingCartRounded'
import SubjectRoundedIcon from '@mui/icons-material/SubjectRounded'
import WifiRoundedIcon from '@mui/icons-material/WifiRounded'
import { lazy, Suspense, type ComponentType } from 'react'
import { createBrowserRouter, Outlet, RouteObject } from 'react-router'

import ConnectionsSvg from '@/assets/image/itemicon/connections.svg?react'
import HomeSvg from '@/assets/image/itemicon/home.svg?react'
import LogsSvg from '@/assets/image/itemicon/logs.svg?react'
import ProfilesSvg from '@/assets/image/itemicon/profiles.svg?react'
import ProxiesSvg from '@/assets/image/itemicon/proxies.svg?react'
import RulesSvg from '@/assets/image/itemicon/rules.svg?react'
import SettingsSvg from '@/assets/image/itemicon/settings.svg?react'
import UnlockSvg from '@/assets/image/itemicon/unlock.svg?react'
import { ensureLanguageSections } from '@/services/i18n'

import { COMMERCIAL_MODE } from '@/config/commercial'
import { AuthProvider } from '@/providers/auth-provider'

import Layout from './_layout'
import HomePage from './home'

/** Ensures every route (including Layout / login) is under AuthProvider. */
function AuthRoot() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}

const waitForWarmupIdle = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    let idleId: number | undefined
    let timeoutId: number | undefined

    const cleanup = () => {
      signal.removeEventListener('abort', finish)
      if (idleId !== undefined) {
        window.cancelIdleCallback(idleId)
      }
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }

    const finish = () => {
      cleanup()
      resolve()
    }

    if (signal.aborted) {
      resolve()
      return
    }

    signal.addEventListener('abort', finish, { once: true })

    if (window.requestIdleCallback) {
      idleId = window.requestIdleCallback(finish, { timeout: 500 })
    } else {
      timeoutId = window.setTimeout(finish, 120)
    }
  })

const createRoutePreload = (
  load: () => Promise<{ default: ComponentType }>,
  sections?: string | readonly string[],
) => {
  let componentPromise: Promise<{ default: ComponentType }> | undefined

  const loadComponent = () => {
    componentPromise ??= load().catch((error) => {
      componentPromise = undefined
      throw error
    })

    return componentPromise
  }

  if (!sections) {
    return loadComponent
  }

  return async () => {
    const [component] = await Promise.all([
      loadComponent(),
      ensureLanguageSections(sections),
    ])
    return component
  }
}

const createLazyRoute = (
  load: () => Promise<{ default: ComponentType }>,
  sections?: string | readonly string[],
) => {
  const preload = createRoutePreload(load, sections)
  const Component = lazy(preload)
  const LazyRoute = () => (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  )

  return { Component: LazyRoute, preload }
}

export const preloadLogsPage = createRoutePreload(
  () => import('./logs'),
  'logs',
)

export const navItems = [
  {
    label: 'layout.components.navigation.tabs.home',
    path: '/',
    icon: [<HomeRoundedIcon key="mui" />, <HomeSvg key="svg" />],
    Component: HomePage,
  },
  {
    label: 'layout.components.navigation.tabs.proxies',
    path: '/proxies',
    icon: [<WifiRoundedIcon key="mui" />, <ProxiesSvg key="svg" />],
    ...createLazyRoute(() => import('./proxies')),
  },
  {
    label: 'layout.components.navigation.tabs.profiles',
    path: '/profile',
    icon: [<DnsRoundedIcon key="mui" />, <ProfilesSvg key="svg" />],
    ...createLazyRoute(() => import('./profiles'), 'rules'),
  },
  ...(COMMERCIAL_MODE
    ? [
        {
          label: '订阅商城',
          path: '/store',
          icon: [
            <ShoppingCartRoundedIcon key="mui" />,
            <ProfilesSvg key="svg" />,
          ],
          ...createLazyRoute(() => import('./commercial-store')),
        },
        {
          label: '个人中心',
          path: '/account',
          icon: [
            <PersonRoundedIcon key="mui" />,
            <ProfilesSvg key="svg" />,
          ],
          ...createLazyRoute(() => import('./commercial-account')),
        },
      ]
    : []),
  {
    label: 'layout.components.navigation.tabs.connections',
    path: '/connections',
    icon: [<LanguageRoundedIcon key="mui" />, <ConnectionsSvg key="svg" />],
    ...createLazyRoute(() => import('./connections'), 'connections'),
  },
  {
    label: 'layout.components.navigation.tabs.rules',
    path: '/rules',
    icon: [<ForkRightRoundedIcon key="mui" />, <RulesSvg key="svg" />],
    ...createLazyRoute(() => import('./rules'), 'rules'),
  },
  {
    label: 'layout.components.navigation.tabs.logs',
    path: '/logs',
    icon: [<SubjectRoundedIcon key="mui" />, <LogsSvg key="svg" />],
    Component: () => null /* LogsPage rendered in Layout only on /logs route */,
    preload: preloadLogsPage,
  },
  {
    label: 'layout.components.navigation.tabs.unlock',
    path: '/unlock',
    icon: [<LockOpenRoundedIcon key="mui" />, <UnlockSvg key="svg" />],
    ...createLazyRoute(() => import('./unlock')),
  },
  {
    label: 'layout.components.navigation.tabs.settings',
    path: '/settings',
    icon: [<SettingsRoundedIcon key="mui" />, <SettingsSvg key="svg" />],
    ...createLazyRoute(() => import('./settings')),
  },
]

const navigationWarmupPriority = ['/connections', '/logs', '/rules']

const navigationWarmupItems = [...navItems].sort((left, right) => {
  const leftIndex = navigationWarmupPriority.indexOf(left.path)
  const rightIndex = navigationWarmupPriority.indexOf(right.path)
  const leftRank =
    leftIndex === -1 ? navigationWarmupPriority.length : leftIndex
  const rightRank =
    rightIndex === -1 ? navigationWarmupPriority.length : rightIndex

  return leftRank - rightRank
})

export const preloadNavigationRoutes = async (signal: AbortSignal) => {
  for (const item of navigationWarmupItems) {
    if (signal.aborted) {
      return
    }
    const preload = 'preload' in item ? item.preload : undefined
    if (!preload) {
      continue
    }

    await waitForWarmupIdle(signal)
    if (signal.aborted) {
      return
    }

    await preload().catch(() => {})
  }
}

const LoginPage = lazy(() => import('./login'))
const RegisterPage = lazy(() => import('./register'))
const ForgotPasswordPage = lazy(() => import('./forgot-password'))

const ProductPage = lazy(() => import('./commercial-product'))

export const router = createBrowserRouter([
  {
    Component: AuthRoot,
    children: [
  {
    path: '/login',
    Component: () => (
      <Suspense fallback={null}>
        <LoginPage />
      </Suspense>
    ),
  },
  {
    path: '/register',
    Component: () => (
      <Suspense fallback={null}>
        <RegisterPage />
      </Suspense>
    ),
  },
  {
    path: '/forgot-password',
    Component: () => (
      <Suspense fallback={null}>
        <ForgotPasswordPage />
      </Suspense>
    ),
  },
  {
    path: '/',
    Component: Layout,
    children: [
      ...navItems.map(
        (item) =>
          ({
            path: item.path,
            Component: item.Component,
          }) as RouteObject,
      ),
      ...(COMMERCIAL_MODE
        ? [
            {
              path: '/store/:productId',
              Component: () => (
                <Suspense fallback={null}>
                  <ProductPage />
                </Suspense>
              ),
            } as RouteObject,
          ]
        : []),
    ],
  },
    ],
  },
])
