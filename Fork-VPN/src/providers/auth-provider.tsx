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
import {
  commercialEnsureAccessSynced,
  commercialGetSession,
  commercialLogin,
  commercialLogout,
  commercialRegister,
  commercialSyncSubscription,
  commercialFlushTrafficReport,
  setStoredAccessKey,
  type AuthSession,
  type SyncResult,
} from '@/services/commercial'
import { notifyEntitlementUpdated } from '@/components/home/home-profile-card'
import { showNotice } from '@/services/notice-service'
import { revalidateQueries } from '@/services/query-client'

interface AuthContextValue {
  enabled: boolean
  ready: boolean
  session: AuthSession | null
  syncing: boolean
  login: (username: string, password: string) => Promise<void>
  register: (
    username: string,
    password: string,
    email: string,
    inviteCode?: string,
    emailCode?: string,
  ) => Promise<void>
  logout: () => Promise<void>
  syncOfficial: () => Promise<SyncResult | null>
  refreshSession: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!COMMERCIAL_MODE)
  const [session, setSession] = useState<AuthSession | null>(null)
  const [syncing, setSyncing] = useState(false)

  const refreshProxyData = useCallback(async () => {
    await revalidateQueries([
      ['getProfiles'],
      ['getProxies'],
      ['getClashConfig'],
      ['getRuntimeConfig'],
    ])
  }, [])

  const refreshSession = useCallback(async () => {
    if (!COMMERCIAL_MODE) {
      setSession(null)
      setReady(true)
      return
    }
    try {
      const s = await commercialGetSession()
      setSession(s)
      // revoke / purchase change while app open → pull nodes again
      if (s?.access_key) {
        try {
          const synced = await commercialEnsureAccessSynced(s.access_key)
          if (synced) {
            await refreshProxyData()
            if (synced.message) showNotice.success(synced.message)
          }
        } catch {
          // ignore background resync errors
        }
      }
    } catch {
      setSession(null)
    } finally {
      setReady(true)
    }
  }, [refreshProxyData])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  // periodic access check (admin may revoke while client stays open)
  useEffect(() => {
    if (!COMMERCIAL_MODE || !session) return
    const tick = () => void refreshSession()
    // 20s: refund/revoke should drop paid nodes without waiting nearly a minute
    const t = window.setInterval(tick, 20_000)
    const onVis = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [session, refreshSession])

  // flush estimated traffic usage to backend
  useEffect(() => {
    if (!COMMERCIAL_MODE || !session) return
    const t = window.setInterval(() => {
      void commercialFlushTrafficReport(false)
    }, 30_000)
    return () => window.clearInterval(t)
  }, [session])

  const syncOfficial = useCallback(async () => {
    if (!COMMERCIAL_MODE) return null
    setSyncing(true)
    try {
      await commercialFlushTrafficReport(true)
      const result = await commercialSyncSubscription()
      if (result?.access_key) setStoredAccessKey(result.access_key)
      await refreshProxyData()
      notifyEntitlementUpdated()
      if (result?.message) {
        showNotice.success(result.message)
      } else {
        showNotice.success('已同步官方线路')
      }
      return result
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || String(err)
      showNotice.error(msg)
      if (
        msg.includes('登录') ||
        msg.includes('过期') ||
        msg.includes('禁用') ||
        msg.includes('流量已用尽')
      ) {
        if (msg.includes('登录') || msg.includes('过期') || msg.includes('禁用')) {
          setSession(null)
        }
      }
      throw err
    } finally {
      setSyncing(false)
    }
  }, [refreshProxyData])

  const login = useCallback(
    async (username: string, password: string) => {
      const s = await commercialLogin(username, password)
      setSession(s)
      // force full resync after login (clears stale nodes after revoke)
      setStoredAccessKey(null)
      try {
        await syncOfficial()
      } catch {
        // session kept; user can retry sync on profiles page
      }
    },
    [syncOfficial],
  )

  const register = useCallback(
    async (
      username: string,
      password: string,
      email: string,
      inviteCode?: string,
      emailCode?: string,
    ) => {
      const s = await commercialRegister(
        username,
        password,
        email,
        inviteCode,
        emailCode,
      )
      setSession(s)
      try {
        await syncOfficial()
      } catch {
        // ignore sync failure after register
      }
    },
    [syncOfficial],
  )

  const logout = useCallback(async () => {
    try {
      await commercialLogout()
    } finally {
      setSession(null)
      setStoredAccessKey(null)
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      enabled: COMMERCIAL_MODE,
      ready,
      session,
      syncing,
      login,
      register,
      logout,
      syncOfficial,
      refreshSession,
    }),
    [
      ready,
      session,
      syncing,
      login,
      register,
      logout,
      syncOfficial,
      refreshSession,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Safe fallback so a missing provider never white-screens the whole app. */
const FALLBACK_AUTH: AuthContextValue = {
  enabled: COMMERCIAL_MODE,
  ready: true,
  session: null,
  syncing: false,
  login: async () => {
    throw new Error('AuthProvider 未挂载')
  },
  register: async () => {
    throw new Error('AuthProvider 未挂载')
  },
  logout: async () => {},
  syncOfficial: async () => null,
  refreshSession: async () => {},
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    // Prefer soft fallback over "Unexpected Application Error" white screen.
    // Root cause is fixed by wrapping the router with <AuthProvider>; this is belt-and-suspenders.
    if (import.meta.env?.DEV) {
      console.error(
        '[auth] useAuth used outside AuthProvider — using fallback. Check main.tsx / router root.',
      )
    }
    return FALLBACK_AUTH
  }
  return ctx
}
