import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core'
import {
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from '@mui/material'
import type { CSSProperties, PointerEvent, ReactNode } from 'react'
import { useCallback } from 'react'
import { useMatch, useNavigate, useResolvedPath } from 'react-router'

import { useVerge } from '@/hooks/use-verge'

interface SortableProps {
  setNodeRef?: (element: HTMLElement | null) => void
  attributes?: DraggableAttributes
  listeners?: DraggableSyntheticListeners
  style?: CSSProperties
  isDragging?: boolean
  disabled?: boolean
}

interface Props {
  to: string
  children: string
  icon: ReactNode[]
  sortable?: SortableProps
  onPreload?: () => Promise<unknown>
}

export const LayoutItem = (props: Props) => {
  const { to, children, icon, sortable, onPreload } = props
  const { verge } = useVerge()
  const { menu_icon } = verge ?? {}
  const navCollapsed = verge?.collapse_navbar ?? false
  const resolved = useResolvedPath(to)
  const match = useMatch({ path: resolved.pathname, end: true })
  const navigate = useNavigate()

  const effectiveMenuIcon =
    navCollapsed && menu_icon === 'disable' ? 'monochrome' : menu_icon
  const showIcon =
    effectiveMenuIcon === 'monochrome' ||
    !effectiveMenuIcon ||
    effectiveMenuIcon === 'colorful'
  const showText = !navCollapsed
  const iconOnly = navCollapsed

  const { setNodeRef, attributes, listeners, style, isDragging, disabled } =
    sortable ?? {}

  const draggable = Boolean(sortable) && !disabled
  const { onPointerDown, ...otherListeners } = draggable
    ? (listeners ?? {})
    : {}

  const handlePreload = useCallback(() => {
    void onPreload?.().catch(() => {})
  }, [onPreload])

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      handlePreload()
      onPointerDown?.(event)
    },
    [handlePreload, onPointerDown],
  )

  return (
    <ListItem
      ref={setNodeRef}
      style={style}
      disablePadding
      sx={[
        { width: '100%', px: 1, py: 0.25 },
        isDragging ? { opacity: 0.75 } : {},
      ]}
    >
      <ListItemButton
        selected={!!match}
        {...(draggable ? (attributes ?? {}) : {})}
        {...(draggable ? otherListeners : {})}
        sx={[
          {
            borderRadius: '8px',
            minHeight: 38,
            px: iconOnly ? 1 : 1.15,
            py: 0.65,
            gap: 1.1,
            justifyContent: iconOnly ? 'center' : 'flex-start',
            cursor: draggable ? 'grab' : 'pointer',
            color: 'rgba(229, 231, 235, 0.58)',
            transition: 'background .12s ease, color .12s ease',
            '&:hover': {
              bgcolor: 'rgba(255, 255, 255, 0.045)',
              color: 'rgba(249, 250, 251, 0.92)',
            },
            '&:active': draggable ? { cursor: 'grabbing' } : {},
            '& .MuiListItemIcon-root': {
              minWidth: 20,
              width: 20,
              height: 20,
              margin: 0,
              color: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              '& svg': { fontSize: 18, width: 18, height: 18 },
            },
            '& .MuiListItemText-root': {
              m: 0,
              minWidth: 0,
            },
            '& .MuiListItemText-primary': {
              color: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: 0,
              lineHeight: 1.3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          () => ({
            '&.Mui-selected': {
              color: '#F9FAFB',
              bgcolor: 'rgba(255, 255, 255, 0.08)',
              '&:hover': {
                bgcolor: 'rgba(255, 255, 255, 0.1)',
              },
              '& .MuiListItemText-primary': {
                fontWeight: 600,
                color: '#F9FAFB',
              },
              '& .MuiListItemIcon-root': {
                color: '#2DD4BF',
              },
            },
          }),
        ]}
        title={children}
        aria-label={children}
        onFocus={handlePreload}
        onMouseEnter={handlePreload}
        onPointerDown={handlePointerDown}
        onClick={() => navigate(to)}
      >
        {showIcon && (
          <ListItemIcon>
            {effectiveMenuIcon === 'colorful' ? icon[1] : icon[0]}
          </ListItemIcon>
        )}
        {showText && effectiveMenuIcon !== 'disable' && (
          <ListItemText primary={children} />
        )}
        {showText && effectiveMenuIcon === 'disable' && (
          <ListItemText
            primary={children}
            sx={{ textAlign: 'center', width: '100%' }}
          />
        )}
      </ListItemButton>
    </ListItem>
  )
}
