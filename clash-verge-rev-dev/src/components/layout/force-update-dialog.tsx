import { SystemUpdateAltRounded } from '@mui/icons-material'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material'
import { getVersion } from '@tauri-apps/api/app'
import { useCallback, useEffect, useState } from 'react'

import { COMMERCIAL_MODE, PRODUCT_NAME } from '@/config/commercial'
import { commercialCheckAppUpdate, type AppUpdateInfo } from '@/services/commercial'
import { showNotice } from '@/services/notice-service'
import { checkUpdateSafe } from '@/services/update'

const SKIP_KEY = 'fork-skip-update-version'

/**
 * Backend announces version (optional/force UI).
 * Install uses Tauri updater → /api/v1/client/updater/latest.json from admin panel.
 */
export function ForceUpdateDialog() {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [clientVer, setClientVer] = useState('')
  const [installing, setInstalling] = useState(false)

  const check = useCallback(async () => {
    if (!COMMERCIAL_MODE) return
    try {
      let ver = '0.0.0'
      try {
        ver = await getVersion()
      } catch {
        ver = '0.1.0'
      }
      setClientVer(ver)
      const data = await commercialCheckAppUpdate(ver)
      if (!data?.update) {
        setOpen(false)
        setInfo(null)
        return
      }
      if (!data.force) {
        const skipped = localStorage.getItem(SKIP_KEY)
        if (skipped && skipped === data.latest_version) {
          setOpen(false)
          setInfo(null)
          return
        }
      }
      setInfo(data)
      setOpen(true)
    } catch {
      // offline
    }
  }, [])

  useEffect(() => {
    void check()
    const t = window.setInterval(() => void check(), 10 * 60_000)
    const onVis = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [check])

  const force = Boolean(info?.force)

  const onSkip = () => {
    if (force) return
    if (info?.latest_version) {
      localStorage.setItem(SKIP_KEY, info.latest_version)
    }
    setOpen(false)
  }

  const onQuit = async () => {
    try {
      const { exit } = await import('@tauri-apps/plugin-process')
      await exit(0)
    } catch {
      window.close()
    }
  }

  /** Same as stock Clash: download + install via Tauri updater, then relaunch. */
  const onInstall = async () => {
    setInstalling(true)
    try {
      const update = await checkUpdateSafe()
      if (!update) {
        showNotice.error(
          '未获取到可安装包。请确认后台已填写版本号、安装包 URL 与 .sig 签名，且与当前客户端签名公钥匹配。',
        )
        return
      }
      showNotice.success('开始下载更新…')
      await update.downloadAndInstall()
      try {
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      } catch {
        showNotice.success('安装完成，请手动重启客户端')
      }
    } catch (err: any) {
      const msg =
        typeof err === 'string' ? err : err?.message || String(err)
      showNotice.error(`更新失败：${msg}`)
    } finally {
      setInstalling(false)
    }
  }

  if (!COMMERCIAL_MODE || !info) return null

  return (
    <Dialog
      open={open}
      onClose={(_, reason) => {
        if (force || installing) return
        if (reason === 'backdropClick' || reason === 'escapeKeyDown') onSkip()
      }}
      disableEscapeKeyDown={force || installing}
      fullWidth
      maxWidth="xs"
      PaperProps={{ sx: { borderRadius: 2 } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <SystemUpdateAltRounded color={force ? 'error' : 'primary'} />
        {info.title || '发现新版本'}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.25}>
          <Typography variant="body2" color="text.secondary">
            当前版本 <b>{clientVer || info.client_version || '—'}</b>
            {' → '}
            最新 <b>{info.latest_version}</b>
            {force ? (
              <Box component="span" sx={{ color: 'error.main', ml: 1 }}>
                · 必须更新后才能继续使用
              </Box>
            ) : (
              <Box component="span" sx={{ ml: 1 }}>
                · 可选更新
              </Box>
            )}
          </Typography>
          <Typography
            variant="body1"
            sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, minHeight: 48 }}
          >
            {info.body ||
              `请更新到最新 ${PRODUCT_NAME} 以获得更好体验。点击更新后将自动下载并安装。`}
          </Typography>
          {installing ? <LinearProgress /> : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, gap: 1 }}>
        {!force ? (
          <Button onClick={onSkip} color="inherit" disabled={installing}>
            稍后
          </Button>
        ) : (
          <Button onClick={() => void onQuit()} color="inherit" disabled={installing}>
            退出应用
          </Button>
        )}
        <Button
          variant="contained"
          color={force ? 'error' : 'primary'}
          loading={installing}
          onClick={() => void onInstall()}
        >
          {installing ? '下载安装中…' : '立即更新'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
