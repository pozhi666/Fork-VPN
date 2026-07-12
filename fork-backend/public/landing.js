;(async function () {
  const yearEl = document.getElementById('year')
  if (yearEl) yearEl.textContent = String(new Date().getFullYear())

  const dlBtn = document.getElementById('btn-dl')
  const heroBtn = document.getElementById('btn-dl-hero')
  const verMeta = document.getElementById('ver-meta')
  const dlVer = document.getElementById('dl-ver')
  const dlStatus = document.getElementById('dl-status')
  const dlNotes = document.getElementById('dl-notes')
  const dlHint = document.getElementById('dl-hint')
  const copyBtn = document.getElementById('btn-copy-link')

  let downloadUrl = ''

  function setDisabled(disabled) {
    for (const el of [dlBtn, heroBtn]) {
      if (!el) continue
      if (disabled) {
        el.setAttribute('aria-disabled', 'true')
        el.removeAttribute('href')
        el.href = '#download'
      } else {
        el.removeAttribute('aria-disabled')
        el.href = downloadUrl
      }
    }
  }

  try {
    const res = await fetch('/api/v1/client/download', { cache: 'no-store' })
    const data = await res.json()
    const ver = data.version || '—'
    const win = data.windows || {}
    downloadUrl = win.url || ''

    if (dlVer) dlVer.textContent = ver
    if (data.notes && dlNotes) dlNotes.textContent = data.notes
    if (data.product && document.title.indexOf(data.product) < 0) {
      document.title = `${data.product} — 安全稳定的代理客户端`
    }

    if (win.available && downloadUrl) {
      setDisabled(false)
      if (dlStatus) dlStatus.textContent = '可下载'
      if (verMeta) verMeta.textContent = `最新版本 v${ver} · Windows x64`
      if (dlHint) dlHint.textContent = '下载后安装即可使用，建议关闭杀软误报后安装。'
    } else {
      setDisabled(true)
      if (dlStatus) dlStatus.textContent = '暂未发布安装包'
      if (verMeta) verMeta.textContent = '安装包尚未发布，请稍后再来'
      if (dlHint) dlHint.textContent = data.message || '管理员可在后台「客户端版本更新」填写下载地址'
    }
  } catch {
    setDisabled(true)
    if (dlStatus) dlStatus.textContent = '无法获取下载信息'
    if (verMeta) verMeta.textContent = '网络异常，请稍后刷新'
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!downloadUrl) {
        alert('当前没有可复制的下载链接')
        return
      }
      try {
        await navigator.clipboard.writeText(downloadUrl)
        copyBtn.textContent = '已复制'
        setTimeout(() => {
          copyBtn.textContent = '复制下载链接'
        }, 1600)
      } catch {
        prompt('复制以下链接', downloadUrl)
      }
    })
  }
})()
