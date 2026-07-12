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

export default function RegisterPage() {
  const { session, ready, register, enabled } = useAuth()
  const navigate = useNavigate()
  const mode = useThemeMode()
  const isDark = mode !== 'light'

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = useLockFn(async () => {
    setError('')
    const em = email.trim()
    if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      setError('请填写有效邮箱')
      return
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setLoading(true)
    try {
      await register(username.trim(), password, em)
      navigate('/', { replace: true })
    } catch (err: any) {
      setError(typeof err === 'string' ? err : err?.message || '注册失败')
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
              注册 Fork
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              请填写邮箱完成注册，用于账号找回与运营联系
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
            helperText="至少 3 个字符"
            autoFocus
          />
          <TextField
            label="邮箱"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            fullWidth
            required
            helperText="必填，不可与已有账号重复"
          />
          <TextField
            label="密码"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth
            helperText="至少 6 个字符"
          />
          <TextField
            label="确认密码"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            fullWidth
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSubmit()
            }}
          />

          <Button
            variant="contained"
            size="large"
            loading={loading}
            disabled={!username || !email || !password || !confirm}
            onClick={() => void onSubmit()}
          >
            注册并登录
          </Button>

          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center' }}
          >
            已有账号？{' '}
            <Link component={RouterLink} to="/login" underline="hover">
              返回登录
            </Link>
          </Typography>
        </Stack>
      </Paper>
    </Box>
  )
}
