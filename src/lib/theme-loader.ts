import { invoke } from '@tauri-apps/api/core'

export type ThemeSlot = 'light' | 'dark'

export interface ThemeSettingsLike {
  light: string
  dark: string
  followSystem: boolean
}

export function ensureThemeSlots(): void {
  for (const slot of ['light', 'dark'] as ThemeSlot[]) {
    if (!document.querySelector(`style[data-theme-slot="${slot}"]`)) {
      const el = document.createElement('style')
      el.setAttribute('data-theme-slot', slot)
      document.head.appendChild(el)
    }
  }
}

/**
 * Load the compiled CSS for theme `themeId` and place it in the named slot.
 * Uses the `theme_load_compiled` Tauri command rather than `readTextFile` so
 * we don't have to grant the frontend fs:scope access to the app data dir
 * (Tauri 2's plugin-fs scope syntax for $APPDATA paths is fiddly; routing
 * the read through Rust is cleaner and equally fast).
 */
export async function applyThemeContent(slot: ThemeSlot, themeId: string): Promise<void> {
  ensureThemeSlots()
  const el = document.querySelector(`style[data-theme-slot="${slot}"]`)
  if (!el) return
  try {
    const css = await invoke<string>('theme_load_compiled', { id: themeId })
    el.textContent = css
  } catch (e) {
    console.warn('[theme-loader] applyThemeContent failed', slot, themeId, e)
    el.textContent = ''
  }
}

/**
 * Resolve the theme id whose CSS should currently match via `data-theme`.
 */
export function computeActiveThemeId(t: ThemeSettingsLike, systemDark: boolean): string {
  if (!t.followSystem) return t.light
  return systemDark ? t.dark : t.light
}

/**
 * Listen to `prefers-color-scheme: dark`. Calls back immediately with the
 * current value, then on every change. Returns a stop function.
 */
export function observePrefersColorScheme(cb: (dark: boolean) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  cb(mq.matches)
  const handler = (e: MediaQueryListEvent) => cb(e.matches)
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
