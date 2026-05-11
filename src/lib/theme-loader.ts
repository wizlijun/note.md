import { readTextFile } from '@tauri-apps/plugin-fs'

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
 * Read the compiled CSS at `compiledPath` and place it in the named slot.
 * Use after the active theme id for a slot has changed.
 */
export async function applyThemeContent(slot: ThemeSlot, compiledPath: string): Promise<void> {
  ensureThemeSlots()
  const el = document.querySelector(`style[data-theme-slot="${slot}"]`)
  if (!el) return
  try {
    const css = await readTextFile(compiledPath)
    el.textContent = css
  } catch (e) {
    console.warn('[theme-loader] applyThemeContent', slot, compiledPath, e)
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
