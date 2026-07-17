/** Client-side mirror of Rust commercial feature flag (UI only). */
export const COMMERCIAL_MODE = true

export const PRODUCT_NAME = 'Fork'

/** Public site (legal pages, landing). */
export const SITE_ORIGIN = 'https://your-domain.example'
export const TERMS_URL = `${SITE_ORIGIN}/terms.html`
export const PRIVACY_URL = `${SITE_ORIGIN}/privacy.html`
export const OPENSOURCE_URL = `${SITE_ORIGIN}/opensource.html`
export const SUPPORT_TG = 'https://t.me/forkdl'

/** Matches Rust `commercial::OFFICIAL_PROFILE_*` — server-managed, not user-import. */
export const OFFICIAL_PROFILE_MARKER = 'fork-official'
export const OFFICIAL_PROFILE_NAME = '官方线路'

export function isOfficialProfile(item?: {
  name?: string | null
  desc?: string | null
} | null) {
  if (!item) return false
  return (
    item.desc === OFFICIAL_PROFILE_MARKER || item.name === OFFICIAL_PROFILE_NAME
  )
}

/** Must match Rust `commercial::ports` (not stock Clash 789x). */
export const ISOLATED_DEFAULT_MIXED_PORT = 17897
export const ISOLATED_DEFAULT_SOCKS_PORT = 17898
export const ISOLATED_DEFAULT_HTTP_PORT = 17899
export const ISOLATED_DEFAULT_TPROXY_PORT = 17896
