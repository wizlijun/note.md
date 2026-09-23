import { invoke } from '@tauri-apps/api/core'
import { settings } from './settings.svelte'
import { loadThemes, themes } from './themes.svelte'
import { setActiveTheme } from './active-theme.svelte'
import {
  applyThemeContent, computeActiveThemeId, invalidateThemeContent, observePrefersColorScheme,
} from './theme-loader'

/** Prepare the selected theme before the first editor mounts, then follow changes. */
export async function initializeThemes(): Promise<() => void> {
  await loadThemes()
  let revision = 0
  let notified = ''
  let assignedThemes = themes.list

  async function syncSlots() {
    const currentRevision = ++revision
    const selected = { ...settings.theme }
    await Promise.all([
      applyThemeContent('light', selected.light),
      applyThemeContent('dark', selected.dark),
    ])
    if (currentRevision !== revision
      || selected.light !== settings.theme.light
      || selected.dark !== settings.theme.dark
      || selected.followSystem !== settings.theme.followSystem) return false
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    setActiveTheme(computeActiveThemeId(selected, systemDark))
    // Carry current ids to isolated plugin windows without racing settings persistence.
    const key = JSON.stringify(selected)
    if (key !== notified) {
      notified = key
      void invoke('plugin_v2_theme_changed', {
        lightId: selected.light, darkId: selected.dark, followSystem: selected.followSystem,
      }).catch(() => {})
    }
    return true
  }

  // Settings can change while the first CSS read is in flight. Only release
  // the editor once the current selection has been applied.
  while (!await syncSlots()) { /* retry the latest selection */ }
  const stopSystem = observePrefersColorScheme(() => { void syncSlots() })
  const stopWatch = $effect.root(() => {
    $effect(() => {
      void settings.theme.light
      void settings.theme.dark
      void settings.theme.followSystem
      if (assignedThemes !== themes.list) {
        assignedThemes = themes.list
        notified = ''
        invalidateThemeContent()
      }
      void syncSlots()
    })
  })
  return () => {
    revision++
    stopSystem()
    stopWatch()
  }
}
