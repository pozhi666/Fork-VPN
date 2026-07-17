import { Box, Typography, useTheme } from '@mui/material'
import React, { forwardRef, ReactNode } from 'react'

interface EnhancedCardProps {
  title: ReactNode
  icon: ReactNode
  action?: ReactNode
  children: ReactNode
  iconColor?: 'primary' | 'secondary' | 'error' | 'warning' | 'info' | 'success'
  minHeight?: number | string
  noContentPadding?: boolean
}

export const EnhancedCard = forwardRef<HTMLElement, EnhancedCardProps>(
  (
    {
      title,
      icon,
      action,
      children,
      iconColor = 'primary',
      minHeight,
      noContentPadding = false,
    },
    ref,
  ) => {
    const theme = useTheme()
    const isDark = theme.palette.mode === 'dark'
    const accent = theme.palette[iconColor].main

    return (
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '12px',
          bgcolor: isDark ? '#14181f' : '#ffffff',
          // Quiet surfaces: light gets soft shadow, dark relies on fill vs page bg
          border: isDark ? 'none' : '1px solid rgba(17,24,39,0.05)',
          boxShadow: isDark ? 'none' : '0 1px 2px rgba(17,24,39,0.04)',
          overflow: 'hidden',
        }}
        ref={ref}
      >
        <Box
          sx={{
            px: 2,
            pt: 1.5,
            pb: 0.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              flex: 1,
              gap: 1,
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                color: accent,
                opacity: 0.9,
                lineHeight: 0,
                '& svg': { fontSize: 18 },
              }}
            >
              {icon}
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              {typeof title === 'string' ? (
                <Typography
                  sx={{
                    fontWeight: 600,
                    fontSize: 14,
                    letterSpacing: -0.1,
                    color: 'text.primary',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={title}
                >
                  {title}
                </Typography>
              ) : (
                title
              )}
            </Box>
          </Box>
          {action && <Box sx={{ ml: 1, flexShrink: 0 }}>{action}</Box>}
        </Box>
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            p: noContentPadding ? 0 : 2,
            pt: noContentPadding ? 0 : 1.5,
            ...(minHeight && { minHeight }),
          }}
        >
          {children}
        </Box>
      </Box>
    )
  },
)

EnhancedCard.displayName = 'EnhancedCard'
