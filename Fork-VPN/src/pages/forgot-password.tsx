import { Alert, Button, Link, Stack, TextField, Typography } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useEffect, useState } from 'react'
import { Link as RouterLink, Navigate, useNavigate } from 'react-router'

import { AuthLegalLinks } from '@/components/auth/auth-legal-links'
import { AuthShell } from '@/components/auth/auth-shell'
import { useAuth } from '@/providers/auth-provider'
import {
  commercialPasswordResetComplete,
  commercialPasswordResetRequest,
} from '@/services/commercial'

export default function ForgotPasswordPage() {
  const { session, ready, enabled } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => window.clearTimeout(t)
  }, [cooldown])

  const onSendCode = useLockFn(async () => {
    setError('')
    setInfo('')
    const em = email.trim()
    if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      setError('请填写有效邮箱')
      return
    }
    setSendingCode(true)
    try {
      const r = await commercialPasswordResetRequest(em)
      setInfo(r?.message || '若该邮箱已注册，验证码已发送')
      setCooldown(Number(r?.cooldown || 60))
    } catch (err: any) {
      setError(typeof err === 'string' ? err : err?.message || '发送失败')
    } finally {
      setSendingCode(false)
    }
  })

  const onSubmit = useLockFn(async () => {
    setError('')
    setInfo('')
    const em = email.trim()
    if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      setError('请填写有效邮箱')
      return
    }
    if (!/^\d{6}$/.test(emailCode.trim())) {
      setError('请填写 6 位验证码')
      return
    }
    if (password.length < 6) {
      setError('新密码至少 6 位')
      return
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    // 新旧是否相同只能由服务端用哈希校验；此处仅拦截明显空/过短
    setLoading(true)
    try {
      const r = await commercialPasswordResetComplete(
        em,
        emailCode.trim(),
        password,
      )
      setDone(true)
      setInfo(r?.message || '密码已重置，请使用新密码登录')
      window.setTimeout(() => navigate('/login', { replace: true }), 1500)
    } catch (err: any) {
      setError(typeof err === 'string' ? err : err?.message || '重置失败')
    } finally {
      setLoading(false)
    }
  })

  if (!enabled) {
    return <Navigate to="/" replace />
  }
  if (!ready) return null
  if (session) return <Navigate to="/" replace />

  return (
    <AuthShell title="找回密码" subtitle="通过注册邮箱验证码重置密码">
      <Stack spacing={2.25}>
        {error ? (
          <Alert severity="error" sx={{ py: 0.5, borderRadius: 2 }}>
            {error}
          </Alert>
        ) : null}
        {info ? (
          <Alert severity="success" sx={{ py: 0.5, borderRadius: 2 }}>
            {info}
          </Alert>
        ) : null}

        <TextField
          label="注册邮箱"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          fullWidth
          autoFocus
          disabled={done}
        />
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
          <TextField
            label="邮箱验证码"
            value={emailCode}
            onChange={(e) =>
              setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))
            }
            fullWidth
            disabled={done}
            slotProps={{
              htmlInput: { inputMode: 'numeric', maxLength: 6 },
            }}
            helperText="6 位数字，10 分钟内有效"
          />
          <Button
            variant="outlined"
            sx={{ minWidth: 112, height: 56, flexShrink: 0, borderRadius: 2 }}
            disabled={done || sendingCode || cooldown > 0 || !email.trim()}
            loading={sendingCode}
            onClick={() => void onSendCode()}
          >
            {cooldown > 0 ? `${cooldown}s` : '获取验证码'}
          </Button>
        </Stack>
        <TextField
          label="新密码"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          fullWidth
          disabled={done}
          helperText="至少 6 个字符"
        />
        <TextField
          label="确认新密码"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          fullWidth
          disabled={done}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSubmit()
          }}
        />

        <Button
          variant="contained"
          size="large"
          loading={loading}
          disabled={done || !email || emailCode.length !== 6 || !password || !confirm}
          onClick={() => void onSubmit()}
          sx={{
            py: 1.2,
            borderRadius: 2.5,
            fontWeight: 700,
            textTransform: 'none',
          }}
        >
          重置密码
        </Button>

        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
          <Link
            component={RouterLink}
            to="/login"
            underline="hover"
            sx={{ fontWeight: 600 }}
          >
            返回登录
          </Link>
        </Typography>

        <AuthLegalLinks />
      </Stack>
    </AuthShell>
  )
}
