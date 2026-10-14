import { Store } from '@tauri-apps/plugin-store'
import { i18n, isLocale, type Locale } from './runtime.svelte'
export { i18n, availableLocales, t, type Locale } from './runtime.svelte'

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

/** Set and persist the active locale. Also broadcasts `settings://changed` so
 *  separate webview windows (Daily Notes, Insights, Logs, Plugin Market, Preview)
 *  can re-read the locale and re-render live — they each own an isolated i18n
 *  store, so without this signal a language switch in the main window would not
 *  reach them until they reopened. */
export async function setLocale(code: Locale): Promise<void> {
  if (!isLocale(code)) return
  i18n.locale = code
  const s = await getStore()
  await s.set('locale', code)
  await s.save()
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit('settings://changed')
  } catch { /* non-Tauri/dev: no cross-window broadcast */ }
}

/** Wire a standalone window to follow live language switches: on every
 *  `settings://changed` broadcast, re-hydrate the active locale from disk (which
 *  updates the reactive `i18n.locale`, re-running every `t()` in the view).
 *  Returns an unlisten function; call it in the component's onDestroy. */
export async function watchLocaleChanges(): Promise<() => void> {
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen('settings://changed', () => { void loadLocale() })
  } catch {
    return () => {}
  }
}
