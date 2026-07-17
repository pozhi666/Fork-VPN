import { Link, Stack, Typography } from '@mui/material'
import { open } from '@tauri-apps/plugin-shell'

import { PRIVACY_URL, TERMS_URL } from '@/config/commercial'

async function openUrl(url: string) {
  try {
    await open(url)
  } catch {
    // web / fallback
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** Footer links under auth forms */
export function AuthLegalLinks() {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: 'block', textAlign: 'center', lineHeight: 1.7, pt: 0.5 }}
    >
      登录/使用即表示您了解并遵守{' '}
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={() => void openUrl(TERMS_URL)}
        sx={{ font: 'inherit', verticalAlign: 'baseline', cursor: 'pointer' }}
      >
        服务条款
      </Link>
      {' · '}
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={() => void openUrl(PRIVACY_URL)}
        sx={{ font: 'inherit', verticalAlign: 'baseline', cursor: 'pointer' }}
      >
        隐私政策
      </Link>
    </Typography>
  )
}

/** Inline links for agreement checkbox label */
export function LegalDocLinks() {
  return (
    <Stack component="span" direction="row" spacing={0.5} sx={{ display: 'inline' }}>
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void openUrl(TERMS_URL)
        }}
        sx={{ font: 'inherit', verticalAlign: 'baseline', cursor: 'pointer' }}
      >
        《服务条款》
      </Link>
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void openUrl(PRIVACY_URL)
        }}
        sx={{ font: 'inherit', verticalAlign: 'baseline', cursor: 'pointer' }}
      >
        《隐私政策》
      </Link>
    </Stack>
  )
}
