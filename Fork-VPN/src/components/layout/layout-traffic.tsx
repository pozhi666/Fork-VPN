import {
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  MemoryRounded,
} from '@mui/icons-material'
import { Box, Typography } from '@mui/material'
import { useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { LightweightTrafficErrorBoundary } from '@/components/shared/traffic-error-boundary'
import { useMemoryData } from '@/hooks/use-memory-data'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import parseTraffic from '@/utils/parse-traffic'

import { TrafficGraph, type TrafficRef } from './traffic-graph'

/** Compact traffic block for dark sidebar rail */
export const LayoutTraffic = () => {
  const { t } = useTranslation()
  const { verge } = useVerge()

  const trafficGraph = verge?.traffic_graph ?? true
  const displayMemory = verge?.enable_memory_usage ?? true

  const trafficRef = useRef<TrafficRef>(null)
  const pageVisible = useVisibility()

  const {
    response: { data: traffic },
  } = useTrafficData({ enabled: pageVisible })
  const {
    response: { data: memory },
  } = useMemoryData({ enabled: displayMemory && pageVisible })

  useEffect(() => {
    if (trafficRef.current) {
      trafficRef.current.appendData({
        up: traffic?.up || 0,
        down: traffic?.down || 0,
        upTotal: traffic?.upTotal || 0,
        downTotal: traffic?.downTotal || 0,
      })
    }
  }, [traffic])

  const [up, upUnit] = parseTraffic(traffic?.up || 0)
  const [down, downUnit] = parseTraffic(traffic?.down || 0)
  const [inuse, inuseUnit] = parseTraffic(memory?.inuse || 0)

  const upActive = (traffic?.up || 0) > 0
  const downActive = (traffic?.down || 0) > 0

  return (
    <LightweightTrafficErrorBoundary>
      <Box sx={{ px: 0.25 }}>
        {trafficGraph && pageVisible && (
          <Box
            onClick={() => trafficRef.current?.toggleStyle()}
            title="点击切换曲线样式"
            sx={{
              width: '100%',
              height: 72,
              mb: 1,
              borderRadius: '8px',
              overflow: 'hidden',
              cursor: 'pointer',
              bgcolor: 'rgba(255,255,255,0.03)',
              // Force graph palette for dark rail
              '--fork-traffic-up': '#818CF8',
              '--fork-traffic-down': '#2DD4BF',
              '--fork-traffic-ref': 'rgba(255,255,255,0.05)',
            }}
          >
            <TrafficGraph ref={trafficRef} variant="sidebar" />
          </Box>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.85 }}>
          <StatRow
            title={t('home.components.traffic.metrics.uploadSpeed')}
            icon={
              <ArrowUpwardRounded
                sx={{ fontSize: 15, color: upActive ? '#A5B4FC' : '#4B5563' }}
              />
            }
            value={up}
            unit={`${upUnit}/s`}
            valueColor={upActive ? '#C7D2FE' : '#9CA3AF'}
          />
          <StatRow
            title={t('home.components.traffic.metrics.downloadSpeed')}
            icon={
              <ArrowDownwardRounded
                sx={{ fontSize: 15, color: downActive ? '#5EEAD4' : '#4B5563' }}
              />
            }
            value={down}
            unit={`${downUnit}/s`}
            valueColor={downActive ? '#99F6E4' : '#9CA3AF'}
          />
          {displayMemory && (
            <StatRow
              title={t('home.components.traffic.metrics.memoryUsage')}
              icon={<MemoryRounded sx={{ fontSize: 15, color: '#6B7280' }} />}
              value={inuse}
              unit={inuseUnit}
              valueColor="#D1D5DB"
            />
          )}
        </Box>
      </Box>
    </LightweightTrafficErrorBoundary>
  )
}

function StatRow({
  title,
  icon,
  value,
  unit,
  valueColor,
}: {
  title: string
  icon: ReactNode
  value: string | number
  unit: string
  valueColor: string
}) {
  return (
    <Box
      title={title}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 0.25,
        minHeight: 18,
      }}
    >
      {icon}
      <Typography
        component="span"
        sx={{
          flex: 1,
          fontSize: 12.5,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: valueColor,
          userSelect: 'none',
          letterSpacing: 0.1,
        }}
      >
        {value}
      </Typography>
      <Typography
        component="span"
        sx={{
          fontSize: 11,
          color: '#6B7280',
          userSelect: 'none',
          minWidth: 28,
          textAlign: 'right',
        }}
      >
        {unit}
      </Typography>
    </Box>
  )
}
