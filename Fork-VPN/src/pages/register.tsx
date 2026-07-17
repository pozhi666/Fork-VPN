import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useEffect, useState } from 'react'
import { Link as RouterLink, Navigate, useNavigate } from 'react-router'

import { AuthLegalLinks, LegalDocLinks } from '@/components/auth/auth-legal-links'
import { AuthShell } from '@/components/auth/auth-shell'
import { useAuth } from '@/providers/auth-provider'
import {
  commercialEmailStatus,
  commercialSendEmailCode,
} from '@/services/commercial'

export default function RegisterPage() {
  const { session, ready, register, enabled } = useAuth()
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [invite, setInvite] = useState('')
  const [agreeLegal, setAgreeLegal] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [requireCode, setRequireCode] = useState(true)

  useEffect(() => {
    void commercialEmailStatus()
      .then((s) => {
        setRequireCode(Boolean(s?.mail_configured ?? s?.register_requires_code ?? true))
      })
      .catch(() => setRequireCode(true))
  }, [])

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
      setError('请先填写有效邮箱')
      return
    }
    setSendingCode(true)
    try {
      const r = await commercialSendEmailCode(em, 'register')
      setInfo(r?.message || '验证码已发送，请查收邮件')
      setCooldown(Number(r?.cooldown || 60))
    } catch (err: any) {
      setError(typeof err === 'string' ? err : err?.message || '发送验证码失败')
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
    if (requireCode && !/^\d{6}$/.test(emailCode.trim())) {
      setError('请填写邮箱收到的 6 位验证码')
      return
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    if (!agreeLegal) {
      setError('请先阅读并同意服务条款与隐私政策')
      return
    }
    setLoading(true)
    try {
      await register(
        username.trim(),
        password,
        em,
        invite.trim() || undefined,
        requireCode ? emailCode.trim() : undefined,
      )
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
    <AuthShell title="创建账号" subtitle="邮箱验证后完成注册，用于账号找回与运营联系">
      <Stack spacing={2}>
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
          helperText="必填，用于接收验证码与找回密码"
        />
        {requireCode ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            <TextField
              label="邮箱验证码"
              value={emailCode}
              onChange={(e) =>
                setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))
              }
              fullWidth
              required
              slotProps={{
                htmlInput: { inputMode: 'numeric', maxLength: 6 },
              }}
              helperText="6 位数字，10 分钟内有效"
            />
            <Button
              variant="outlined"
              sx={{ minWidth: 112, height: 56, flexShrink: 0, borderRadius: 2 }}
              disabled={sendingCode || cooldown > 0 || !email.trim()}
              loading={sendingCode}
              onClick={() => void onSendCode()}
            >
              {cooldown > 0 ? `${cooldown}s` : '获取验证码'}
            </Button>
          </Stack>
        ) : null}
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
        <TextField
          label="邀请码（可选）"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
          fullWidth
          helperText="有邀请码可填写，邀请人将获得额外天数奖励"
        />

        <FormControlLabel
          sx={{ alignItems: 'flex-start', m: 0, gap: 0.5 }}
          control={
            <Checkbox
              size="small"
              checked={agreeLegal}
              onChange={(e) => setAgreeLegal(e.target.checked)}
              sx={{ pt: 0.25 }}
            />
          }
          label={
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>
              我已阅读并同意 <LegalDocLinks />
            </Typography>
          }
        />

        <Button
          variant="contained"
          size="large"
          loading={loading}
          disabled={
            !username ||
            !email ||
            !password ||
            !confirm ||
            !agreeLegal ||
            (requireCode && emailCode.length !== 6)
          }
          onClick={() => void onSubmit()}
          sx={{
            py: 1.2,
            borderRadius: 2.5,
            fontWeight: 700,
            textTransform: 'none',
          }}
        >
          注册并登录
        </Button>

        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
          已有账号？{' '}
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
