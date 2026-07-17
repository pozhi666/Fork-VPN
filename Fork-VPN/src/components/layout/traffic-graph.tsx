import { useTheme } from '@mui/material'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { Traffic } from 'tauri-plugin-mihomo-api'

const maxPoint = 30
const sampleIntervalMs = 1000
const frameIntervalMs = 1000 / 15
const animationDurationMs = sampleIntervalMs

const zeroTraffic: Traffic = { up: 0, down: 0, upTotal: 0, downTotal: 0 }
const createDefaultList = () =>
  Array.from({ length: maxPoint + 2 }, () => ({ ...zeroTraffic }))

const hasTraffic = (traffic?: Traffic | null) =>
  (traffic?.up ?? 0) !== 0 || (traffic?.down ?? 0) !== 0

const hasRetainedTraffic = (list: Traffic[]) => list.some(hasTraffic)

export interface TrafficRef {
  appendData: (data: Traffic) => void
  toggleStyle: () => void
}

type TrafficValueKey = 'up' | 'down'

function readCssColor(
  el: HTMLElement | null,
  name: string,
  fallback: string,
) {
  if (!el) return fallback
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * Traffic sparkline — supports default theme colors or soft sidebar palette.
 */
export function TrafficGraph({
  ref,
  variant = 'default',
}: {
  ref?: Ref<TrafficRef>
  variant?: 'default' | 'sidebar'
}) {
  const countRef = useRef(0)
  const styleRef = useRef(true)
  const listRef = useRef<Traffic[]>(createDefaultList())
  const canvasRef = useRef<HTMLCanvasElement>(null!)
  const wrapRef = useRef<HTMLDivElement>(null!)

  const cacheRef = useRef<Traffic | null>(null)
  const requestDrawRef = useRef<(animate?: boolean) => void>(() => {})

  const { palette } = useTheme()
  const isSidebar = variant === 'sidebar'

  useImperativeHandle(ref, () => ({
    appendData: (data: Traffic) => {
      cacheRef.current = data
    },
    toggleStyle: () => {
      styleRef.current = !styleRef.current
      requestDrawRef.current(false)
    },
  }))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const handleData = () => {
      const data = cacheRef.current ?? zeroTraffic
      cacheRef.current = null

      const list = listRef.current
      const shouldAppend = hasTraffic(data) || hasRetainedTraffic(list)

      if (shouldAppend) {
        if (list.length > maxPoint + 2) list.shift()
        list.push(data)
        countRef.current = 0
        requestDrawRef.current(true)
      }

      timer = setTimeout(handleData, sampleIntervalMs)
    }

    handleData()

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    let raf = 0
    let frameTimer: ReturnType<typeof setTimeout> | null = null
    let resizeObserver: ResizeObserver | null = null
    let animationStart = 0
    let lastFrameTime = 0
    const canvas = canvasRef.current!
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    const host = wrapRef.current
    const upLineColor = isSidebar
      ? readCssColor(host, '--fork-traffic-up', '#818CF8')
      : palette.secondary.main || '#818CF8'
    const downLineColor = isSidebar
      ? readCssColor(host, '--fork-traffic-down', '#2DD4BF')
      : palette.primary.main || '#0D9488'
    const refLineColor = isSidebar
      ? readCssColor(host, '--fork-traffic-ref', 'rgba(255,255,255,0.06)')
      : palette.divider || 'rgba(0,0,0,0.08)'

    const lineW = isSidebar ? 1.75 : 2.5
    const refW = 1

    const cancelPendingDraw = () => {
      if (frameTimer !== null) {
        clearTimeout(frameTimer)
        frameTimer = null
      }
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    const drawGraph = (offset = countRef.current) => {
      const list = listRef.current
      const lineStyle = styleRef.current

      // HiDPI
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cssW = canvas.clientWidth || canvas.width
      const cssH = canvas.clientHeight || canvas.height
      if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
        canvas.width = Math.floor(cssW * dpr)
        canvas.height = Math.floor(cssH * dpr)
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
      }

      const width = cssW
      const height = cssH
      const dx = width / maxPoint
      const dy = height / 7
      const l1 = dy
      const l2 = dy * 4

      const countY = (v: number) => {
        const h = height
        if (v == 0) return h - 1
        if (v <= 10) return h - (v / 10) * dy
        if (v <= 100) return h - (v / 100 + 1) * dy
        if (v <= 1024) return h - (v / 1024 + 2) * dy
        if (v <= 10240) return h - (v / 10240 + 3) * dy
        if (v <= 102400) return h - (v / 102400 + 4) * dy
        if (v <= 1048576) return h - (v / 1048576 + 5) * dy
        if (v <= 10485760) return h - (v / 10485760 + 6) * dy
        return 1
      }

      const pathSeries = (valueKey: TrafficValueKey) => {
        if (list.length === 0) return
        if (lineStyle) {
          const firstX = (dx * -1 - offset + 3) | 0
          const firstY = countY(list[0]?.[valueKey] ?? 0)
          context.moveTo(firstX, firstY)
          for (let i = 1; i < list.length; i++) {
            const p1x = (dx * (i - 1) - offset + 3) | 0
            const p1y = countY(list[i]?.[valueKey] ?? 0)
            const hasNext = i + 1 < list.length
            const p2x = hasNext ? (dx * i - offset + 3) | 0 : p1x
            const p2y = hasNext ? countY(list[i + 1]?.[valueKey] ?? 0) : p1y
            context.quadraticCurveTo(p1x, p1y, (p1x + p2x) / 2, (p1y + p2y) / 2)
          }
        } else {
          context.moveTo((dx * -1 - offset) | 0, countY(list[0]?.[valueKey] ?? 0))
          for (let i = 1; i < list.length; i++) {
            context.lineTo(
              (dx * (i - 1) - offset) | 0,
              countY(list[i]?.[valueKey] ?? 0),
            )
          }
        }
      }

      const strokeAndFill = (valueKey: TrafficValueKey, color: string) => {
        // fill under curve
        context.beginPath()
        pathSeries(valueKey)
        // close to baseline for fill
        const lastIdx = Math.max(list.length - 1, 0)
        const lastX = (dx * (lastIdx - 1) - offset + 3) | 0
        const firstX = (dx * -1 - offset + 3) | 0
        context.lineTo(lastX, height)
        context.lineTo(firstX, height)
        context.closePath()
        const grad = context.createLinearGradient(0, 0, 0, height)
        grad.addColorStop(0, color + '33')
        grad.addColorStop(1, color + '00')
        // fallback if color is rgb()
        try {
          context.fillStyle = grad
          // rebuild gradient with alpha properly for hex colors
          if (color.startsWith('#')) {
            const g2 = context.createLinearGradient(0, 0, 0, height)
            g2.addColorStop(0, hexAlpha(color, isSidebar ? 0.22 : 0.18))
            g2.addColorStop(1, hexAlpha(color, 0))
            context.fillStyle = g2
          }
          context.fill()
        } catch {
          /* ignore */
        }

        context.beginPath()
        pathSeries(valueKey)
        context.globalAlpha = 1
        context.lineWidth = lineW
        context.strokeStyle = color
        context.lineJoin = 'round'
        context.lineCap = 'round'
        context.stroke()
        context.closePath()
      }

      context.clearRect(0, 0, width, height)

      // soft ref lines
      context.beginPath()
      context.globalAlpha = 1
      context.lineWidth = refW
      context.strokeStyle = refLineColor
      context.moveTo(0, l1)
      context.lineTo(width, l1)
      context.moveTo(0, l2)
      context.lineTo(width, l2)
      context.stroke()
      context.closePath()

      // draw down first (under), then up
      strokeAndFill('down', downLineColor)
      strokeAndFill('up', upLineColor)
    }

    const drawAnimatedFrame = (timestamp: number) => {
      raf = 0
      const timeSinceLastFrame = timestamp - lastFrameTime
      if (timeSinceLastFrame < frameIntervalMs) {
        frameTimer = setTimeout(() => {
          frameTimer = null
          raf = requestAnimationFrame(drawAnimatedFrame)
        }, frameIntervalMs - timeSinceLastFrame)
        return
      }
      lastFrameTime = timestamp
      const dx = (canvas.clientWidth || canvas.width) / maxPoint
      const progress = Math.min(
        (timestamp - animationStart) / animationDurationMs,
        1,
      )
      const offset = progress * dx
      countRef.current = offset
      drawGraph(offset)
      if (progress < 1) {
        raf = requestAnimationFrame(drawAnimatedFrame)
        return
      }
      countRef.current = dx
    }

    const requestDraw = (animate = false) => {
      cancelPendingDraw()
      if (!animate) {
        raf = requestAnimationFrame(() => {
          raf = 0
          drawGraph()
        })
        return
      }
      animationStart = performance.now()
      lastFrameTime = animationStart - frameIntervalMs
      raf = requestAnimationFrame(drawAnimatedFrame)
    }

    requestDrawRef.current = requestDraw
    requestDraw(false)

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => requestDraw(false))
      resizeObserver.observe(canvas)
    }

    return () => {
      if (requestDrawRef.current === requestDraw) {
        requestDrawRef.current = () => {}
      }
      resizeObserver?.disconnect()
      cancelPendingDraw()
    }
  }, [palette, isSidebar])

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  )
}

function hexAlpha(hex: string, a: number) {
  const h = hex.replace('#', '')
  if (h.length !== 6) return hex
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}
