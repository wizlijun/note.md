export type Theme = 'ink' | 'dim' | 'paper' | 'sepia' | 'crt' | 'crt-blue'
export interface Preferences {
  theme: Theme
  fontFamily: string
  caretMotion: 'breathing' | 'steady'
  focusTyping: boolean
  fontSize: number
  lineHeight: number
  maxColumns: number
  bottomInset: number
}
export interface Page { id: string; excerpt: string; deleted: boolean }
export interface SumiState {
  available: boolean
  reason?: string
  pages: Page[]
  activePageId: string | null
  navigationVersion?: number
  preferences: Preferences
  sync: { connected: boolean; pending: number; message?: string }
  saveState: 'saved' | 'saving' | 'projection-pending' | 'error'
}
export interface SurfaceHandle { id: string; generation: number }
export interface Bounds { x: number; y: number; width: number; height: number }
export interface FontStatus {
  family: string
  status: 'not_downloaded' | 'downloading' | 'ready' | 'error'
  downloadedBytes: number
  totalBytes: number
  error?: string | null
}
export interface FontState { fonts: FontStatus[]; selectedFont: string; pendingFont: string | null }
export interface SoundState {
  enabled: boolean
  preset: 'typewriter' | 'thock'
  permission: 'granted' | 'required' | 'unsupported'
  status: 'off' | 'ready' | 'permission_required' | 'unavailable'
  error?: string
}
export const fontPresets = [
  ['Sumi Plex', 'IBM Plex Mono Light + IBM Plex Sans SC Light'],
  ['Sumi WenKai', 'LXGW WenKai Mono Lite'],
  ['Sumi Zhaohua', '朝华打字机'],
  ['Sumi Youcha', '油茶馓子体'],
  ['Sumi Fangsong', 'Zhuque Fangsong · 朱雀仿宋'],
  ['Sumi CRT', '复古绿磷 CRT · GNU Unifont'],
] as const
export const defaultPreferences: Preferences = {
  theme: 'dim', fontFamily: 'Sumi Plex', caretMotion: 'breathing', focusTyping: true, fontSize: 22,
  lineHeight: 1.6, maxColumns: 80, bottomInset: 0,
}
export function pageLabel(page: Page, fallback: string): string {
  return page.excerpt.trim().slice(0, 80) || fallback
}
export function preferencesFromForm(form: HTMLFormElement, currentFont?: string): Preferences {
  const data = new FormData(form)
  const number = (key: string, min: number, max: number) => {
    const value = Number(data.get(key))
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`)
    return value
  }
  const theme = data.get('theme')
  if (theme !== 'ink' && theme !== 'dim' && theme !== 'paper' && theme !== 'sepia' && theme !== 'crt' && theme !== 'crt-blue') throw new Error('Invalid theme')
  const fontFamily = String(currentFont ?? data.get('fontFamily') ?? '').trim()
  if (!fontPresets.some(([value]) => value === fontFamily)) throw new Error('Invalid font')
  const caretMotion = data.get('caretMotion')
  if (caretMotion !== 'breathing' && caretMotion !== 'steady') throw new Error('Invalid caret motion')
  return { theme, fontFamily, caretMotion, focusTyping: data.has('focusTyping'), fontSize: number('fontSize', 8, 96), lineHeight: number('lineHeight', 1, 3), maxColumns: number('maxColumns', 20, 200), bottomInset: number('bottomInset', 0, 2000) }
}
