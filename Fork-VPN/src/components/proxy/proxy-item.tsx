import { CheckCircleOutlineRounded } from '@mui/icons-material'
import {
  alpha,
  Box,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  styled,
  SxProps,
  Theme,
} from '@mui/material'
import { useState, type MouseEvent } from 'react'

import { BaseLoading } from '@/components/base'
import { useDisabledProxiesCurrentProfile } from '@/hooks/use-disabled-proxies'
import { useProxyDelayState } from '@/hooks/use-proxy-delay-state'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'

interface Props {
  group: IProxyGroupItem
  proxy: IProxyItem
  selected: boolean
  showType?: boolean
  sx?: SxProps<Theme>
  onClick?: (name: string) => void
}

const Widget = styled(Box)(() => ({
  padding: '2px 8px',
  fontSize: 12,
  fontWeight: 600,
  borderRadius: '8px',
  fontVariantNumeric: 'tabular-nums',
}))

const TypeBox = styled('span')(({ theme }) => ({
  display: 'inline-block',
  border: `1px solid ${alpha(theme.palette.text.secondary, 0.18)}`,
  borderColor: alpha(theme.palette.text.secondary, 0.18),
  color: alpha(theme.palette.text.secondary, 0.72),
  borderRadius: 6,
  fontSize: 10,
  fontWeight: 600,
  marginRight: '4px',
  padding: '1px 5px',
  lineHeight: 1.35,
  letterSpacing: 0.2,
}))

export const ProxyItem = (props: Props) => {
  const { group, proxy, selected, showType = true, sx, onClick } = props
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const { isDisabled, toggle } = useDisabledProxiesCurrentProfile(group.name)
  const disabled = isDisabled(proxy)

  // -1/<=0 为不显示，-2 为 loading
  const { delayValue, isPreset, timeout, onDelay } = useProxyDelayState(
    proxy,
    group.name,
  )

  const onContext = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (isPreset) return
    setMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <ListItem sx={sx}>
      <ListItemButton
        dense
        selected={selected && !disabled}
        onContextMenu={onContext}
        onClick={() => {
          if (disabled) {
            showNotice.info('节点已禁用，右键可重新启用')
            return
          }
          onClick?.(proxy.name)
        }}
        sx={[
          {
            borderRadius: '8px',
            opacity: disabled ? 0.45 : 1,
            cursor: disabled ? 'not-allowed' : 'pointer',
            border: 'none',
            transition: 'background .12s ease',
          },
          ({ palette: { mode, primary } }) => {
            const bgcolor =
              mode === 'light' ? 'rgba(255,255,255,0.9)' : 'rgba(20,24,31,0.9)'
            const showDelay = delayValue > 0

            return {
              '&:hover': {
                bgcolor:
                  mode === 'light'
                    ? alpha(primary.main, 0.06)
                    : 'rgba(255,255,255,0.06)',
              },
              '&:hover .the-check': { display: !showDelay ? 'block' : 'none' },
              '&:hover .the-delay': { display: showDelay ? 'block' : 'none' },
              '&:hover .the-icon': { display: 'none' },
              '&.Mui-selected': {
                borderColor: 'transparent',
                bgcolor:
                  mode === 'light'
                    ? alpha(primary.main, 0.1)
                    : alpha(primary.main, 0.14),
              },
              backgroundColor: bgcolor,
              marginBottom: '4px',
              minHeight: 40,
            }
          },
        ]}
      >
        <ListItemText
          title={proxy.name}
          secondary={
            <>
              <Box
                sx={{
                  display: 'inline-block',
                  marginRight: '8px',
                  fontSize: '14px',
                  color: 'text.primary',
                }}
              >
                {proxy.name}
                {showType && proxy.now && ` - ${proxy.now}`}
              </Box>
              {disabled && <TypeBox>已禁用</TypeBox>}
              {showType && !!proxy.provider && (
                <TypeBox>{proxy.provider}</TypeBox>
              )}
              {showType && <TypeBox>{proxy.type}</TypeBox>}
              {showType && proxy.udp && <TypeBox>UDP</TypeBox>}
              {showType && proxy.xudp && <TypeBox>XUDP</TypeBox>}
              {showType && proxy.tfo && <TypeBox>TFO</TypeBox>}
              {showType && proxy.mptcp && <TypeBox>MPTCP</TypeBox>}
              {showType && proxy.smux && <TypeBox>SMUX</TypeBox>}
            </>
          }
        />

        <ListItemIcon
          sx={{
            justifyContent: 'flex-end',
            color: 'primary.main',
            display: isPreset ? 'none' : '',
          }}
        >
          {delayValue === -2 && (
            <Widget>
              <BaseLoading />
            </Widget>
          )}

          {!proxy.provider && delayValue !== -2 && (
            // provider 的节点不支持检测
            <Widget
              className="the-check"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onDelay()
              }}
              sx={({ palette }) => ({
                display: 'none', // hover 时显示
                ':hover': { bgcolor: alpha(palette.primary.main, 0.15) },
              })}
            >
              Check
            </Widget>
          )}

          {delayValue > 0 && (
            // 显示延迟
            <Widget
              className="the-delay"
              onClick={(e) => {
                if (proxy.provider) return
                e.preventDefault()
                e.stopPropagation()
                onDelay()
              }}
              sx={({ palette }) => ({
                color: delayManager.formatDelayColor(delayValue, timeout),
                ...(!proxy.provider
                  ? { ':hover': { bgcolor: alpha(palette.primary.main, 0.15) } }
                  : {}),
              })}
            >
              {delayManager.formatDelay(delayValue, timeout)}
            </Widget>
          )}

          {delayValue !== -2 && delayValue <= 0 && selected && (
            // 展示已选择的 icon
            <CheckCircleOutlineRounded
              className="the-icon"
              sx={{ fontSize: 16 }}
            />
          )}
        </ListItemIcon>
      </ListItemButton>
      <Menu
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
      >
        <MenuItem
          onClick={() => {
            const next = toggle(proxy)
            setMenu(null)
            showNotice.success(next ? `已禁用 ${proxy.name}` : `已启用 ${proxy.name}`)
          }}
        >
          {disabled ? '启用此节点' : '禁用此节点'}
        </MenuItem>
      </Menu>
    </ListItem>
  )
}
