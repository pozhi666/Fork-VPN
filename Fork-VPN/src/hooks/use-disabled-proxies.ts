import { useCallback, useMemo, useSyncExternalStore } from 'react'

import { useProfiles } from '@/hooks/use-profiles'
import {
  filterEnabledProxies,
  getDisabledKeysForGroup,
  isProxyDisabledFull,
  migrateLegacyDisabledNames,
  proxyConfigHash,
  setProxyDisabled,
  subscribeDisabledProxies,
  toggleProxyDisabled,
} from '@/services/disabled-proxies'

// 首次加载时执行一次性迁移
let migrationDone = false
function ensureMigration() {
  if (migrationDone) return
  migrationDone = true
  migrateLegacyDisabledNames()
}

// 稳定的空集合快照，供 useSyncExternalStore getSnapshot 返回
const EMPTY_SET: Set<string> = new Set<string>()

/**
 * 禁用代理节点 Hook（按 profileUid + groupName 隔离）。
 *
 * 内部使用 useSyncExternalStore 订阅全局禁用列表变更，
 * 并在组件首次渲染时触发旧数据迁移。
 */
export function useDisabledProxies(profileUid: string, groupName: string) {
  ensureMigration()

  // 订阅变更，任意写入都会触发 re-render
  useSyncExternalStore(
    subscribeDisabledProxies,
    () => getDisabledKeysForGroup(profileUid, groupName),
    () => EMPTY_SET,
  )

  const isDisabled = useCallback(
    (proxy: IProxyItem): boolean =>
      isProxyDisabledFull(profileUid, groupName, proxy),
    [profileUid, groupName],
  )

  const setDisabled = useCallback(
    (proxy: IProxyItem, disabled: boolean) =>
      setProxyDisabled(profileUid, groupName, proxy, disabled),
    [profileUid, groupName],
  )

  const toggle = useCallback(
    (proxy: IProxyItem): boolean =>
      toggleProxyDisabled(profileUid, groupName, proxy),
    [profileUid, groupName],
  )

  const enabledList = useCallback(
    <T extends IProxyItem>(list: T[]): T[] =>
      filterEnabledProxies(list, profileUid, groupName),
    [profileUid, groupName],
  )

  const isKeyDisabled = useCallback(
    (key: string): boolean =>
      getDisabledKeysForGroup(profileUid, groupName).has(key),
    [profileUid, groupName],
  )

  const hashOf = useCallback(
    (proxy: IProxyItem): string => proxyConfigHash(proxy),
    [],
  )

  return useMemo(
    () => ({ isDisabled, setDisabled, toggle, enabledList, isKeyDisabled, hashOf }),
    [isDisabled, setDisabled, toggle, enabledList, isKeyDisabled, hashOf],
  )
}

/**
 * 便捷封装：自动取当前 profileUid，搭配指定组名使用。
 * 当 profile 尚未加载时 profileUid 为空串，此时禁用列表恒为空。
 */
export function useDisabledProxiesCurrentProfile(groupName: string) {
  const { current } = useProfiles()
  const profileUid = current?.uid ?? ''
  return useDisabledProxies(profileUid, groupName)
}
