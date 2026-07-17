import {
  ComputerRounded,
  TroubleshootRounded,
  HelpOutlineRounded,
  SvgIconComponent,
} from '@mui/icons-material'
import {
  Box,
  Typography,
  Stack,
  Tooltip,
  alpha,
  useTheme,
  Fade,
} from '@mui/material'
import { useState, useMemo, memo, FC } from 'react'
import { useTranslation } from 'react-i18next'

import ProxyControlSwitches from '@/components/shared/proxy-control-switches'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'

const LOCAL_STORAGE_TAB_KEY = 'fork-proxy-active-tab'

interface TabButtonProps {
  isActive: boolean
  onClick: () => void
  icon: SvgIconComponent
  label: string
  hasIndicator?: boolean
}

// Tab组件
const TabButton: FC<TabButtonProps> = memo(
  ({ isActive, onClick, icon: Icon, label, hasIndicator = false }) => (
    <Box
      onClick={onClick}
      sx={(theme) => ({
        cursor: 'pointer',
        px: 1.5,
        py: 0.95,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.65,
        flex: 1,
        maxWidth: 160,
        position: 'relative',
        borderRadius: '8px',
        border: 'none',
        bgcolor: isActive
          ? alpha(
              theme.palette.primary.main,
              theme.palette.mode === 'dark' ? 0.16 : 0.1,
            )
          : theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.04)'
            : 'rgba(17,24,39,0.04)',
        color: isActive ? 'primary.main' : 'text.secondary',
        transition: 'background .12s ease, color .12s ease',
        '&:hover': {
          bgcolor: isActive
            ? alpha(theme.palette.primary.main, 0.2)
            : theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.06)'
              : 'rgba(17,24,39,0.06)',
          color: isActive ? 'primary.main' : 'text.primary',
        },
      })}
    >
      <Icon fontSize="small" />
      <Typography variant="body2" sx={{ fontWeight: isActive ? 700 : 500, fontSize: 13 }}>
        {label}
      </Typography>
      {hasIndicator && (
        <Box
          sx={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            bgcolor: isActive ? 'primary.main' : 'success.main',
            position: 'absolute',
            top: 8,
            right: 8,
          }}
        />
      )}
    </Box>
  ),
)

interface TabDescriptionProps {
  description: string
  tooltipTitle: string
}

// 描述文本组件 — 与模式卡片 caption 统一
const TabDescription: FC<TabDescriptionProps> = memo(
  ({ description, tooltipTitle }) => (
    <Fade in={true} timeout={200}>
      <Typography
        variant="caption"
        component="div"
        sx={(theme) => ({
          width: '100%',
          textAlign: 'center',
          color: 'text.secondary',
          px: 1.25,
          py: 0.85,
          borderRadius: '8px',
          bgcolor:
            theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.03)'
              : 'rgba(17,24,39,0.03)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.5,
          wordBreak: 'break-word',
          hyphens: 'auto',
          lineHeight: 1.5,
        })}
      >
        {description}
        <Tooltip title={tooltipTitle}>
          <HelpOutlineRounded
            sx={{ fontSize: 14, opacity: 0.7, flexShrink: 0 }}
          />
        </Tooltip>
      </Typography>
    </Fade>
  ),
)

export const ProxyTunCard: FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const [activeTab, setActiveTab] = useState<string>(
    () => localStorage.getItem(LOCAL_STORAGE_TAB_KEY) || 'system',
  )

  const { verge } = useVerge()
  const { isTunModeAvailable } = useSystemState()
  const { configState: systemProxyConfigState } = useSystemProxyState()

  const { enable_tun_mode } = verge ?? {}

  const handleError = (err: unknown) => {
    showNotice.error(err)
  }

  const handleTabChange = (tab: string) => {
    setActiveTab(tab)
    localStorage.setItem(LOCAL_STORAGE_TAB_KEY, tab)
  }

  const tabDescription = useMemo(() => {
    if (activeTab === 'system') {
      return {
        text: systemProxyConfigState
          ? t('home.components.proxyTun.status.systemProxyEnabled')
          : t('home.components.proxyTun.status.systemProxyDisabled'),
        tooltip: t('home.components.proxyTun.tooltips.systemProxy'),
      }
    } else {
      return {
        text: !isTunModeAvailable
          ? t('home.components.proxyTun.status.tunModeServiceRequired')
          : enable_tun_mode
            ? t('home.components.proxyTun.status.tunModeEnabled')
            : t('home.components.proxyTun.status.tunModeDisabled'),
        tooltip: t('home.components.proxyTun.tooltips.tunMode'),
      }
    }
  }, [
    activeTab,
    systemProxyConfigState,
    enable_tun_mode,
    isTunModeAvailable,
    t,
  ])

  return (
    <Box
      sx={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 1.25 }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          display: 'flex',
          justifyContent: 'center',
          position: 'relative',
          zIndex: 2,
        }}
      >
        <TabButton
          isActive={activeTab === 'system'}
          onClick={() => handleTabChange('system')}
          icon={ComputerRounded}
          label={t('settings.sections.system.toggles.systemProxy')}
          hasIndicator={systemProxyConfigState}
        />
        <TabButton
          isActive={activeTab === 'tun'}
          onClick={() => handleTabChange('tun')}
          icon={TroubleshootRounded}
          label={t('settings.sections.system.toggles.tunMode')}
          hasIndicator={enable_tun_mode && isTunModeAvailable}
        />
      </Stack>

      <TabDescription
        description={tabDescription.text}
        tooltipTitle={tabDescription.tooltip}
      />

      <Box
        sx={{
          p: 1.15,
          borderRadius: '8px',
          bgcolor:
            theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.03)'
              : 'rgba(17,24,39,0.03)',
        }}
      >
        <ProxyControlSwitches
          onError={handleError}
          label={
            activeTab === 'system'
              ? t('settings.sections.system.toggles.systemProxy')
              : t('settings.sections.system.toggles.tunMode')
          }
          noRightPadding={true}
        />
      </Box>
    </Box>
  )
}
