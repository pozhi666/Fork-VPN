import { Box, Paper, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'

import { AuthBrandArt } from '@/components/auth/auth-brand-art'
import { FORK_BRAND } from '@/config/brand'
import { PRODUCT_NAME } from '@/config/commercial'
import { useThemeMode } from '@/services/states'

/** Split auth layout: native brand art (left) + form card (right) */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  const mode = useThemeMode()
  const isDark = mode !== 'light'
  const brand = isDark ? FORK_BRAND.dark : FORK_BRAND.light

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: 'minmax(380px, 1.05fr) 1fr' },
        bgcolor: isDark ? '#0a0c10' : '#f6f7f9',
      }}
    >
      {/* Left brand panel — code-drawn art, not a poster image */}
      <Box
        sx={{
          display: { xs: 'none', md: 'flex' },
          flexDirection: 'column',
          justifyContent: 'space-between',
          position: 'relative',
          overflow: 'hidden',
          color: '#f3f4f6',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          minHeight: '100vh',
        }}
      >
        <AuthBrandArt />

        <Stack
          spacing={2}
          sx={{
            position: 'relative',
            zIndex: 2,
            p: { md: 5, lg: 6 },
            pt: { md: 5, lg: 6 },
            maxWidth: 420,
          }}
        >
          <Box
            sx={{
              width: 42,
              height: 42,
              borderRadius: '11px',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 800,
              fontSize: 17,
              color: '#042f2e',
              background: 'linear-gradient(145deg, #2dd4bf, #0d9488)',
              boxShadow: '0 10px 28px rgba(20,184,166,0.28)',
            }}
          >
            F
          </Box>
          <Box>
            <Typography
              sx={{
                fontWeight: 750,
                fontSize: { md: 28, lg: 32 },
                letterSpacing: -0.7,
                lineHeight: 1.15,
              }}
            >
              {PRODUCT_NAME}
            </Typography>
            <Typography
              sx={{
                mt: 1.25,
                color: 'rgba(209,213,219,0.88)',
                maxWidth: 300,
                lineHeight: 1.7,
                fontSize: 14.5,
              }}
            >
              {FORK_BRAND.tagline}
              <br />
              官方线路 · 双流量池 · 干净可控
            </Typography>
          </Box>

          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', pt: 0.5 }}>
            {['低延迟', '双流量池', '一键同步'].map((label) => (
              <Box
                key={label}
                sx={{
                  px: 1.2,
                  py: 0.45,
                  borderRadius: 999,
                  fontSize: 11.5,
                  fontWeight: 650,
                  color: '#e5e7eb',
                  bgcolor: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  backdropFilter: 'blur(8px)',
                }}
              >
                {label}
              </Box>
            ))}
          </Stack>
        </Stack>

        <Typography
          variant="caption"
          sx={{
            position: 'relative',
            zIndex: 2,
            p: { md: 5, lg: 6 },
            pt: 0,
            color: 'rgba(156,163,175,0.85)',
            letterSpacing: 0.2,
          }}
        >
          © {new Date().getFullYear()} Fork · 仅供合法用途
        </Typography>
      </Box>

      {/* Right form */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: { xs: 2.5, sm: 4 },
          minHeight: { xs: '100vh', md: 'auto' },
          position: 'relative',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            background: isDark
              ? 'radial-gradient(500px 240px at 100% 0%, rgba(45,212,191,0.06), transparent 55%)'
              : 'radial-gradient(500px 240px at 100% 0%, rgba(13,148,136,0.07), transparent 55%)',
            pointerEvents: 'none',
          }}
        />
        <Paper
          elevation={0}
          sx={{
            width: '100%',
            maxWidth: 400,
            p: { xs: 3, sm: 4 },
            borderRadius: '16px',
            position: 'relative',
            zIndex: 1,
            border: isDark
              ? '1px solid rgba(255,255,255,0.08)'
              : '1px solid rgba(17,24,39,0.06)',
            bgcolor: isDark ? '#14181f' : '#fff',
            boxShadow: isDark
              ? '0 16px 40px rgba(0,0,0,0.35)'
              : '0 8px 30px rgba(17,24,39,0.06)',
          }}
        >
          <Stack spacing={0.5} sx={{ mb: 3 }}>
            <Typography
              sx={{
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: 1,
                textTransform: 'uppercase',
                color: brand.primarySoft,
                display: { xs: 'block', md: 'none' },
                mb: 0.5,
              }}
            >
              {PRODUCT_NAME}
            </Typography>
            <Typography sx={{ fontWeight: 700, fontSize: 24, letterSpacing: -0.4 }}>
              {title}
            </Typography>
            {subtitle ? (
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
                {subtitle}
              </Typography>
            ) : null}
          </Stack>
          {children}
        </Paper>
      </Box>
    </Box>
  )
}
