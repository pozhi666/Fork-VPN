import crypto from 'crypto'
import { getPublicUrl } from './config.js'

/**
 * 彩虹易支付 / 兼容易支付 MD5 签名
 * 文档常见字段：pid, type, out_trade_no, notify_url, return_url, name, money, sitename?
 */
export function getEzpayConfig() {
  const base = String(process.env.EZPAY_URL || process.env.FORK_EZPAY_URL || '')
    .trim()
    .replace(/\/$/, '')
  const pid = String(process.env.EZPAY_PID || process.env.FORK_EZPAY_PID || '').trim()
  const key = String(process.env.EZPAY_KEY || process.env.FORK_EZPAY_KEY || '').trim()
  const publicUrl = getPublicUrl()
  return {
    base,
    pid,
    key,
    publicUrl,
    enabled: Boolean(base && pid && key),
    submitPath: '/submit.php',
  }
}

export function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex')
}

/** 签名：参数按 key ASCII 排序，空值不参与，末尾拼接 KEY */
export function ezpaySign(params, key) {
  const keys = Object.keys(params)
    .filter((k) => {
      if (k === 'sign' || k === 'sign_type') return false
      const v = params[k]
      return v !== undefined && v !== null && String(v) !== ''
    })
    .sort()
  const str = keys.map((k) => `${k}=${params[k]}`).join('&') + key
  return md5(str)
}

export function verifyEzpayNotify(query, key) {
  if (!key) return false
  const sign = String(query.sign || '').toLowerCase()
  if (!sign) return false
  const calc = ezpaySign(query, key).toLowerCase()
  return calc === sign
}

/**
 * 组装跳转收银台 URL（浏览器打开即可支付）
 * type: alipay | wxpay | qqpay
 */
export function buildPayUrl({
  outTradeNo,
  name,
  moneyYuan,
  type = 'alipay',
  returnPath = '/pay/return.html',
}) {
  const cfg = getEzpayConfig()
  if (!cfg.enabled) throw new Error('易支付未配置（EZPAY_URL / PID / KEY）')
  if (!cfg.publicUrl) throw new Error('FORK_PUBLIC_URL is required to create payment callbacks')

  const params = {
    pid: cfg.pid,
    type: type || 'alipay',
    out_trade_no: outTradeNo,
    notify_url: `${cfg.publicUrl}/api/v1/pay/ezpay/notify`,
    return_url: `${cfg.publicUrl}${returnPath}`,
    name: String(name || 'Fork会员').slice(0, 127),
    money: Number(moneyYuan).toFixed(2),
  }
  params.sign = ezpaySign(params, cfg.key)
  params.sign_type = 'MD5'

  const qs = Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')
  return `${cfg.base}${cfg.submitPath}?${qs}`
}

export function yuanFromCents(cents) {
  return (Number(cents || 0) / 100).toFixed(2)
}
