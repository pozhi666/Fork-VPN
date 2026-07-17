import { Box } from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  BaseEmpty,
  BasePage,
  BaseSearchBox,
  VirtualList,
  type VirtualListHandle,
} from '@/components/base'
import { ScrollTopButton } from '@/components/layout/scroll-top-button'
import { ProviderButton } from '@/components/rule/provider-button'
import RuleItem from '@/components/rule/rule-item'
import { useVisibility } from '@/hooks/use-visibility'
import { useAppRefreshers, useRulesData } from '@/providers/app-data-context'

const RulesPage = () => {
  const { t } = useTranslation()
  const { rules = [] } = useRulesData()
  const { refreshRules, refreshRuleProviders } = useAppRefreshers()
  const [match, setMatch] = useState(() => (_: string) => true)
  const virtuosoRef = useRef<VirtualListHandle>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const pageVisible = useVisibility()

  // 在组件挂载时和页面获得焦点时刷新规则数据
  useEffect(() => {
    refreshRules()
    refreshRuleProviders()

    if (pageVisible) {
      refreshRules()
      refreshRuleProviders()
    }
  }, [refreshRules, refreshRuleProviders, pageVisible])

  const filteredRules = useMemo(() => {
    const rulesWithLineNo = rules.map((item, index) => ({
      ...item,
      // UI-only derived data; keep app context/SWR data immutable
      lineNo: index + 1,
    }))

    return rulesWithLineNo.filter((item) => match(item.payload ?? ''))
  }, [rules, match])

  const handleScroll = useCallback((e: Event) => {
    setShowScrollTop((e.target as HTMLElement).scrollTop > 100)
  }, [])

  const scrollToTop = () => {
    virtuosoRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <BasePage
      full
      title={t('rules.page.title')}
      contentStyle={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
      }}
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ProviderButton />
        </Box>
      }
    >
      <Box
        sx={(theme) => ({
          flex: 1,
          minHeight: 0,
          mx: 1.25,
          mb: 1.25,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '12px',
          overflow: 'hidden',
          border:
            theme.palette.mode === 'dark'
              ? 'none'
              : '1px solid rgba(17,24,39,0.05)',
          bgcolor:
            theme.palette.mode === 'dark' ? '#14181f' : 'rgba(255,255,255,0.85)',
        })}
      >
        <Box
          sx={{
            pt: 1.25,
            pb: 1,
            px: 1.5,
            height: 'auto',
            minHeight: 40,
            display: 'flex',
            alignItems: 'center',
            borderBottom: (theme) =>
              theme.palette.mode === 'dark'
                ? '1px solid rgba(255,255,255,0.04)'
                : '1px solid rgba(17,24,39,0.05)',
          }}
        >
          <BaseSearchBox onSearch={(match) => setMatch(() => match)} />
        </Box>

        {filteredRules && filteredRules.length > 0 ? (
          <>
            <VirtualList
              ref={virtuosoRef}
              count={filteredRules.length}
              estimateSize={40}
              renderItem={(i) => <RuleItem value={filteredRules[i]} />}
              style={{ flex: 1 }}
              onScroll={handleScroll}
            />
            <ScrollTopButton onClick={scrollToTop} show={showScrollTop} />
          </>
        ) : (
          <BaseEmpty />
        )}
      </Box>
    </BasePage>
  )
}

export default RulesPage
