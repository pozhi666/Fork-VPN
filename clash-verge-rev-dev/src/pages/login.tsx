import {
  Alert,
  Box,
  Button,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useState } from 'react'
import { Link as RouterLink, Navigate, useNavigate } from 'react-router'

import { PRODUCT_NAME } from '@/config/commercial'
import { useAuth } from '@/providers/auth-provider'
import { useThemeMode } from '@/services/states'

export default function LoginPage() {
  const { session, ready, login, enabled } = useAuth()
  const navigate = useNavigate()
  const mode = useThemeMode()
  const isDark = mode !== 'light'

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = useLockFn(async () => {
    setError('')
    setLoading(true)
    try {
      await login(username.trim(), password)
      navigate('/', { replace: true })
    } catch (err: any) {
      setError(typeof err === 'string' ? err : err?.message || '登录失败')
    } finally {
      setLoading(false)
    }
  })

  if (!enabled) {
    return <Navigate to="/" replace />
  }

  if (!ready) {
    return null
  }

  if (session) {
    return <Navigate to="/" replace />
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: isDark ? '#0f1115' : '#f4f6fb',
        p: 2,
      }}
    >
      <Paper
        elevation={isDark ? 0 : 3}
        sx={{
          width: '100%',
          maxWidth: 420,
          p: 4,
          borderRadius: 3,
          border: isDark ? '1px solid rgba(255,255,255,0.08)' : 'none',
          bgcolor: isDark ? '#181b21' : '#fff',
        }}
      >
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              {PRODUCT_NAME}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Fork · 登录后可同步官方线路，也可自行导入订阅
            </Typography>
          </Box>

          {error ? (
            <Alert severity="error" sx={{ py: 0.5 }}>
              {error}
            </Alert>
          ) : null}

          <TextField
            label="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            fullWidth
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSubmit()
            }}
          />
          <TextField
            label="密码"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSubmit()
            }}
          />

          <Button
            variant="contained"
            size="large"
            loading={loading}
            disabled={!username || !password}
            onClick={() => void onSubmit()}
          >
            登录
          </Button>

          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center' }}
          >
            还没有账号？{' '}
            <Link component={RouterLink} to="/register" underline="hover">
              立即注册
            </Link>
          </Typography>
        </Stack>
      </Paper>
    </Box>
  )
}
