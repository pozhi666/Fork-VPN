import { Alert, Button, Link, Stack, TextField, Typography } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useState } from 'react'
import { Link as RouterLink, Navigate, useNavigate } from 'react-router'

import { AuthLegalLinks } from '@/components/auth/auth-legal-links'
import { AuthShell } from '@/components/auth/auth-shell'
import { useAuth } from '@/providers/auth-provider'

export default function LoginPage() {
  const { session, ready, login, enabled } = useAuth()
  const navigate = useNavigate()

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

  if (!enabled) return <Navigate to="/" replace />
  if (!ready) return null
  if (session) return <Navigate to="/" replace />

  return (
    <AuthShell title="欢迎回来" subtitle="登录后同步官方线路，也可自行导入订阅">
      <Stack spacing={2.25}>
        {error ? (
          <Alert severity="error" sx={{ py: 0.5, borderRadius: 2 }}>
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
          sx={{
            py: 1.2,
            borderRadius: 2.5,
            fontWeight: 700,
            textTransform: 'none',
            boxShadow: '0 10px 24px rgba(15, 118, 110, 0.28)',
          }}
        >
          登录
        </Button>

        <Stack
          direction="row"
          sx={{ width: '100%', justifyContent: 'space-between' }}
        >
          <Typography variant="body2" color="text.secondary">
            还没有账号？{' '}
            <Link
              component={RouterLink}
              to="/register"
              underline="hover"
              sx={{ fontWeight: 600 }}
            >
              立即注册
            </Link>
          </Typography>
          <Typography variant="body2">
            <Link
              component={RouterLink}
              to="/forgot-password"
              underline="hover"
              sx={{ fontWeight: 600 }}
            >
              忘记密码
            </Link>
          </Typography>
        </Stack>

        <AuthLegalLinks />
      </Stack>
    </AuthShell>
  )
}
