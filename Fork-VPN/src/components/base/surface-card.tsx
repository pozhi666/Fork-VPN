import { Box, type SxProps, type Theme } from '@mui/material'
import type { ReactNode } from 'react'

/** Shared quiet surface — fill hierarchy, not outline chrome. */
export function SurfaceCard({
  children,
  sx,
  contentSx,
  noPadding,
}: {
  children: ReactNode
  sx?: SxProps<Theme>
  contentSx?: SxProps<Theme>
  noPadding?: boolean
}) {
  return (
    <Box
      sx={[
        (theme) => ({
          height: '100%',
          borderRadius: '12px',
          border:
            theme.palette.mode === 'dark'
              ? 'none'
              : '1px solid rgba(17,24,39,0.05)',
          bgcolor: theme.palette.mode === 'dark' ? '#14181f' : '#ffffff',
          boxShadow:
            theme.palette.mode === 'dark'
              ? 'none'
              : '0 1px 2px rgba(17,24,39,0.04)',
          overflow: 'hidden',
        }),
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <Box
        sx={[
          {
            p: noPadding ? 0 : 2.25,
            height: '100%',
            boxSizing: 'border-box',
          },
          ...(Array.isArray(contentSx)
            ? contentSx
            : contentSx
              ? [contentSx]
              : []),
        ]}
      >
        {children}
      </Box>
    </Box>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.4,
        color: 'text.secondary',
        mb: 1.25,
        mt: 0.5,
        px: 0.25,
      }}
    >
      {children}
    </Box>
  )
}
