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
  setStoredAccessKey,
  type AuthSession,
  type SyncResult,
} from '@/services/commercial'
import { showNotice } from '@/services/notice-service'
import { revalidateQueries } from '@/services/query-client'

interface AuthContextValue {
  enabled: boolean
  ready: boolean
  session: AuthSession | null
  syncing: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, email: string) => Promise<void>
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
    const t = window.setInterval(tick, 45_000)
    const onVis = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [session, refreshSession])

  const syncOfficial = useCallback(async () => {
    if (!COMMERCIAL_MODE) return null
    setSyncing(true)
    try {
      const result = await commercialSyncSubscription()
      if (result?.access_key) setStoredAccessKey(result.access_key)
      await refreshProxyData()
      if (result?.message) {
        showNotice.success(result.message)
      } else {
        showNotice.success('已同步官方线路')
      }
      return result
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || String(err)
      showNotice.error(msg)
      if (msg.includes('登录') || msg.includes('过期') || msg.includes('禁用')) {
        setSession(null)
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
    async (username: string, password: string, email: string) => {
      const s = await commercialRegister(username, password, email)
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

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}
