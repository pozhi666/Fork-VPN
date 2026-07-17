import { LanOutlined, LanRounded, WarningRounded } from '@mui/icons-material'
import { Box, Button, ButtonGroup } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { closeAllConnections } from 'tauri-plugin-mihomo-api'

import { BasePage, TooltipIcon } from '@/components/base'
import { notifyEntitlementUpdated } from '@/components/home/home-profile-card'
import { ProviderButton } from '@/components/proxy/provider-button'
import { ProxyGroups } from '@/components/proxy/proxy-groups'
import { COMMERCIAL_MODE } from '@/config/commercial'
import { useVerge } from '@/hooks/use-verge'
import {
  useAppRefreshers,
  useClashConfigData,
} from '@/providers/app-data-context'
import { useAuth } from '@/providers/auth-provider'
import {
  getRuntimeProxyChainConfig,
  patchClashMode,
  updateProxyChainConfigInRuntime,
} from '@/services/cmds'
import { commercialReconcileAccess } from '@/services/commercial'
import { showNotice } from '@/services/notice-service'
import { revalidateQueries } from '@/services/query-client'
import { debugLog } from '@/utils/debug'

const MODES = ['rule', 'global', 'direct'] as const
type Mode = (typeof MODES)[number]
const MODE_SET = new Set<string>(MODES)
const isMode = (value: unknown): value is Mode =>
  typeof value === 'string' && MODE_SET.has(value)

const ProxyPage = () => {
  const { t } = useTranslation()
  const { session, ready, refreshSession } = useAuth()
  const { clashConfig } = useClashConfigData()
  const { refreshClashConfig, refreshProxy } = useAppRefreshers()

  // 从 localStorage 恢复链式代理按钮状态
  const [isChainMode, setIsChainMode] = useState(() => {
    try {
      const saved = localStorage.getItem('proxy-chain-mode-enabled')
      return saved === 'true'
    } catch {
      return false
    }
  })

  const [chainConfigData, dispatchChainConfigData] = useReducer(
    (_: string | null, action: string | null) => action,
    null as string | null,
  )

  // Enter Proxies → 先验权指纹，权益变了就重拉订阅（退款后不必再去商城同步）
  useEffect(() => {
    if (!COMMERCIAL_MODE || !ready || !session) return
    let cancelled = false

    const reconcile = async (force = false) => {
      try {
        await refreshSession()
        if (cancelled) return
        const synced = await commercialReconcileAccess({ force })
        if (cancelled || !synced) return
        notifyEntitlementUpdated()
        await revalidateQueries([
          ['getProfiles'],
          ['getProxies'],
          ['getClashConfig'],
        ])
        await refreshProxy()
        await refreshClashConfig()
        if (synced.message) {
          debugLog('[proxies] access reconciled:', synced.message)
        }
      } catch (e) {
        debugLog('[proxies] access reconcile failed', e)
      }
    }

    void reconcile(true)

    const onVis = () => {
      if (document.visibilityState === 'visible') void reconcile(false)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [ready, session?.user_id, refreshSession, refreshProxy, refreshClashConfig])

  const updateChainConfigData = useCallback((value: string | null) => {
    dispatchChainConfigData(value)
  }, [])
  const { verge } = useVerge()

  const normalizedMode = clashConfig?.mode?.toLowerCase()
  const curMode = isMode(normalizedMode) ? normalizedMode : undefined
  const chainWarning = t('proxies.page.chain.warning')

  const onChangeMode = useLockFn(async (mode: Mode) => {
    // 断开连接
    if (mode !== curMode && verge?.auto_close_connection) {
      closeAllConnections()
    }
    try {
      // patchClashMode 在后端 PATCH 失败时会 reject，需提示用户而非静默失败
      await patchClashMode(mode)
      refreshClashConfig()
    } catch (error) {
      showNotice.error(error)
    }
  })

  const onToggleChainMode = useLockFn(async () => {
    const newChainMode = !isChainMode

    setIsChainMode(newChainMode)
    // 保存链式代理按钮状态到 localStorage
    localStorage.setItem('proxy-chain-mode-enabled', newChainMode.toString())

    if (!newChainMode) {
      // 退出链式代理模式时，清除链式代理配置
      try {
        debugLog('Exiting chain mode, clearing chain configuration')
        await updateProxyChainConfigInRuntime(null)
        debugLog('Chain configuration cleared successfully')
      } catch (error) {
        console.error('Failed to clear chain configuration:', error)
      }
    }
  })

  // 当开启链式代理模式时，获取配置数据
  useEffect(() => {
    if (!isChainMode) {
      updateChainConfigData(null)
      return
    }

    let cancelled = false

    const fetchChainConfig = async () => {
      try {
        const exitNode = localStorage.getItem('proxy-chain-exit-node')

        if (!exitNode) {
          console.error('No proxy chain exit node found in localStorage')
          if (!cancelled) {
            updateChainConfigData('')
          }
          return
        }

        const configData = await getRuntimeProxyChainConfig(exitNode)
        if (!cancelled) {
          updateChainConfigData(configData || '')
        }
      } catch (error) {
        console.error('Failed to get runtime proxy chain config:', error)
        if (!cancelled) {
          updateChainConfigData('')
        }
      }
    }

    fetchChainConfig()

    return () => {
      cancelled = true
    }
  }, [isChainMode, updateChainConfigData])

  useEffect(() => {
    if (normalizedMode && !isMode(normalizedMode)) {
      onChangeMode('rule')
    }
  }, [normalizedMode, onChangeMode])

  return (
    <BasePage
      full
      contentStyle={{ height: '100%' }}
      title={
        isChainMode ? (
          <Box
            component="span"
            data-tauri-drag-region="true"
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
          >
            {t('proxies.page.title.chainMode')}
            <TooltipIcon
              title={chainWarning}
              icon={WarningRounded}
              color="warning"
              sx={{ p: 0.25 }}
            />
          </Box>
        ) : (
          t('proxies.page.title.default')
        )
      }
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <ProviderButton />

          <ButtonGroup
            size="small"
            sx={{
              borderRadius: '10px',
              overflow: 'hidden',
              '& .MuiButton-root': {
                textTransform: 'capitalize',
                fontWeight: 600,
                px: 1.5,
                borderRadius: 0,
              },
            }}
          >
            {MODES.map((mode) => (
              <Button
                key={mode}
                variant={mode === curMode ? 'contained' : 'outlined'}
                onClick={() => onChangeMode(mode)}
              >
                {t(`proxies.page.modes.${mode}`)}
              </Button>
            ))}
          </ButtonGroup>

          <Button
            size="small"
            variant={isChainMode ? 'contained' : 'outlined'}
            onClick={onToggleChainMode}
            startIcon={
              isChainMode ? (
                <LanRounded fontSize="small" />
              ) : (
                <LanOutlined fontSize="small" />
              )
            }
            sx={{ fontWeight: 600 }}
          >
            {t('proxies.page.actions.toggleChain')}
          </Button>
        </Box>
      }
    >
      <Box
        sx={(theme) => ({
          height: '100%',
          mx: 1.25,
          mb: 1.25,
          borderRadius: '12px',
          overflow: 'hidden',
          bgcolor:
            theme.palette.mode === 'dark' ? '#14181f' : 'rgba(255,255,255,0.85)',
          border:
            theme.palette.mode === 'dark'
              ? 'none'
              : '1px solid rgba(17,24,39,0.05)',
        })}
      >
        <ProxyGroups
          mode={curMode ?? 'rule'}
          isChainMode={isChainMode}
          chainConfigData={chainConfigData}
        />
      </Box>
    </BasePage>
  )
}

export default ProxyPage
