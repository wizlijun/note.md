import { invoke } from '@tauri-apps/api/core'

export interface ThemeMeta {
  id: string
  name: string
  appearance: 'light' | 'dark'
  author?: string
  version?: string
  description?: string
  source: string
  compiled: string
  built_in: boolean
}

export const themes = $state<{ list: ThemeMeta[]; error: string | null }>({
  list: [],
  error: null,
})

export async function loadThemes(): Promise<void> {
  try {
    const list = await invoke<ThemeMeta[]>('theme_list')
    themes.list = list
    themes.error = null
  } catch (e) {
    themes.list = []
    themes.error = typeof e === 'string' ? e : String(e)
  }
}

export function findThemeById(id: string): ThemeMeta | undefined {
  return themes.list.find((t) => t.id === id)
}

export async function reloadThemes(): Promise<void> {
  await loadThemes()
}
