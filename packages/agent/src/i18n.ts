/**
 * Minimal i18n for the agent. Locale is a short BCP-47 tag normalized to
 * lowercase (e.g. "zh", "en", "ja", "zh-hans"). Language selection follows
 * session → config → env → default "en". Region fallback: a request for
 * "zh-hans" falls back to "zh" when the exact key is absent.
 */

export type Locale = string

/** Normalize an arbitrary locale string to a stable lowercase tag. */
export function normalizeLocale(locale: string | undefined | null): string {
  const l = (locale ?? '').trim().toLowerCase()
  if (l === '') return 'en'
  // Accept underscores/upper as aliases: zh_CN / zh-CN / ZH -> zh-cn.
  return l.replace('_', '-')
}

/** Strip the region for a primary-language fallback. */
function primaryOf(tag: string): string {
  const i = tag.indexOf('-')
  return i === -1 ? tag : tag.slice(0, i)
}

/**
 * Resolve a localized string from a `Record<locale, value>` map.
 * Exact match → region fallback → null (so callers fall back to default).
 */
export function pickLocalized(
  map: Record<string, string> | undefined | null,
  locale: string,
): string | null {
  if (map == null) return null
  const l = normalizeLocale(locale)
  if (map[l] !== undefined) return map[l]
  const p = primaryOf(l)
  if (p !== l && map[p] !== undefined) return map[p]
  return null
}

/**
 * Resolve a tool/variable description: `descriptions[locale]` →
 * `descriptions[primary]` → `description` (the default/English fallback).
 */
export function pickDescription(
  description: string,
  descriptions: Record<string, string> | undefined | null,
  locale: string,
): string {
  return pickLocalized(descriptions, locale) ?? description
}

/** Resolve a locale from the effective preference chain. */
export function resolveLocale(
  sessionLocale: string | undefined | null,
  configLocale: string | undefined | null,
  envDefault: string,
): string {
  for (const v of [sessionLocale, configLocale]) {
    const n = normalizeLocale(v)
    if (n !== 'en' && n !== '') return n
    if (n === '' && v == null) continue
  }
  return normalizeLocale(envDefault)
}
