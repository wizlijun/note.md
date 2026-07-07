import { Store } from '@tauri-apps/plugin-store'
import { en, type Messages } from './en'
import { zh } from './zh'
import { ja } from './ja'

/** Every locale code the UI knows about. Extend as catalogs are added. */
export type Locale = 'en' | 'zh' | 'ja'

/** Locales offered in the Settings picker (label is each language's own name). */
export const availableLocales: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '简体中文' },
  { code: 'ja', label: '日本語' },
]

// English is the source of truth; other locales fall back to English per any
// missing key (they're kept complete, but the fallback keeps `t()` total).
const registry: Record<Locale, Partial<Record<keyof Messages, string>>> = { en, zh, ja }

/** Reactive active-locale holder; read by `t()` so switching re-renders the UI. */
export const i18n = $state<{ locale: Locale }>({ locale: 'en' })

function isLocale(v: unknown): v is Locale {
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

// ---- persistence (settings.json store; shared with settings.svelte.ts) ----

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

/** Hydrate the active locale from settings; unknown/absent → English. */
export async function loadLocale(): Promise<void> {
  const s = await getStore()
  const stored = await s.get<string>('locale')
  i18n.locale = isLocale(stored) ? stored : 'en'
}

/** Set and persist the active locale. */
export async function setLocale(code: Locale): Promise<void> {
  if (!isLocale(code)) return
  i18n.locale = code
  const s = await getStore()
  await s.set('locale', code)
  await s.save()
}
