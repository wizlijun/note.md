import { en, type Messages } from './en'
import { zh } from './zh'
import { ja } from './ja'
import { de } from './de'

/** Every locale code the UI knows about. Extend as catalogs are added. */
export type Locale = 'en' | 'zh' | 'ja' | 'de'

/** Locales offered in the Settings picker (label is each language's own name). */
export const availableLocales: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '简体中文' },
]

// English is the source of truth; other locales fall back to English per any
// missing key (they're kept complete, but the fallback keeps `t()` total).
const registry: Record<Locale, Partial<Record<keyof Messages, string>>> = { en, zh, ja, de }

/** Reactive active-locale holder; read by `t()` so switching re-renders the UI. */
export const i18n = $state<{ locale: Locale }>({ locale: 'en' })

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && availableLocales.some((l) => l.code === v)
}

/**
 * Translate a message key for the active locale. Falls back to the English
 * catalog, then to the raw key. `{name}` placeholders are filled from `params`;
 * a placeholder with no matching param is left untouched.
 */
export function t(key: keyof Messages, params?: Record<string, string | number>): string {
  const catalog = registry[i18n.locale] ?? en
  let s: string = catalog[key] ?? en[key] ?? (key as string)
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
  }
  return s
}
