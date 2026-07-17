import getSystem from '@/utils/get-system'
import { FORK_BRAND } from '@/config/brand'

const OS = getSystem()

const font = `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif${
  OS === 'windows' ? ', twemoji mozilla' : ''
}`

/** Fork light — slate + teal (not Clash blue/purple) */
export const defaultTheme = {
  primary_color: FORK_BRAND.light.primary,
  secondary_color: FORK_BRAND.light.secondary,
  primary_text: FORK_BRAND.light.text,
  secondary_text: FORK_BRAND.light.textMuted,
  info_color: '#0EA5E9',
  error_color: '#EF4444',
  warning_color: '#F59E0B',
  success_color: '#10B981',
  background_color: FORK_BRAND.light.bg,
  font_family: font,
}

/** Fork dark — ink navy + teal glow */
export const defaultDarkTheme = {
  ...defaultTheme,
  primary_color: FORK_BRAND.dark.primary,
  secondary_color: FORK_BRAND.dark.secondary,
  primary_text: FORK_BRAND.dark.text,
  secondary_text: FORK_BRAND.dark.textMuted,
  background_color: FORK_BRAND.dark.paper,
  info_color: '#38BDF8',
  error_color: '#F87171',
  warning_color: '#FBBF24',
  success_color: '#34D399',
}
