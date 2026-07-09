// src/lib/outline/shortcuts.ts
export type OutlineCommandId =
  | 'outline.indent' | 'outline.outdent' | 'outline.toggleCollapse'
  | 'outline.moveUp' | 'outline.moveDown' | 'outline.bold' | 'outline.italic'

export const DEFAULT_SHORTCUTS: Record<OutlineCommandId, string> = {
  'outline.indent': 'Tab',
  'outline.outdent': 'Shift+Tab',
  'outline.toggleCollapse': 'Mod+ArrowUp',
  'outline.moveUp': 'Alt+ArrowUp',
  'outline.moveDown': 'Alt+ArrowDown',
  'outline.bold': 'Mod+B',
  'outline.italic': 'Mod+I',
}

const MODIFIER_ORDER = ['Mod', 'Alt', 'Shift']

/** shortcuts.cljs:27 normalize-key */
function normalizeKey(key: string): string | null {
  if (!key) return null
  const map: Record<string, string> = { Esc: 'Escape', Spacebar: 'Space', ' ': 'Space' }
  const k = map[key] ?? key
  return k.length === 1 ? k.toUpperCase() : k
}

/** shortcuts.cljs:51 normalize-shortcut */
export function normalizeShortcut(shortcut: string): string | null {
  if (!shortcut) return null
  const parts = shortcut.split('+').map(p => p.trim()).filter(Boolean)
  const normalized = parts.map(p => {
    const lower = p.toLowerCase()
    if (['cmd', 'command', 'meta', 'ctrl', 'control', 'mod'].includes(lower)) return 'Mod'
    if (['alt', 'option'].includes(lower)) return 'Alt'
    if (lower === 'shift') return 'Shift'
    return normalizeKey(p)
  })
  const mods = [...new Set(normalized.filter(p => MODIFIER_ORDER.includes(p!)))] as string[]
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  const main = normalized.find(p => p && !MODIFIER_ORDER.includes(p))
  if (!main) return null
  return [...mods, main].join('+')
}

/** shortcuts.cljs:76 display-shortcut */
export function displayShortcut(shortcut: string, isMac: boolean): string {
  const normalized = normalizeShortcut(shortcut)
  if (!normalized) return ''
  const sym: Record<string, [string, string]> = {
    Mod: ['⌘', 'Ctrl'], Alt: ['⌥', 'Alt'], Shift: ['⇧', 'Shift'],
    ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'], ArrowLeft: ['←', '←'], ArrowRight: ['→', '→'],
    Escape: ['Esc', 'Esc'], Backspace: ['⌫', '⌫'], Delete: ['Del', 'Del'],
  }
  const parts = normalized.split('+').map(p => (sym[p] ? sym[p][isMac ? 0 : 1] : p))
  return parts.join(isMac ? '' : ' + ')
}

/** shortcuts.cljs:99 event->shortcut */
export function eventToShortcut(e: KeyboardEvent): string | null {
  const key = normalizeKey(e.key)
  if (!key || ['Meta', 'Control', 'Shift', 'Alt'].includes(key)) return null
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return normalizeShortcut(parts.join('+'))
}

export function resolveShortcuts(overrides: Partial<Record<OutlineCommandId, string>>): Record<OutlineCommandId, string> {
  const out = { ...DEFAULT_SHORTCUTS }
  for (const [id, sc] of Object.entries(overrides)) {
    const n = sc ? normalizeShortcut(sc) : null
    if (n && id in out) out[id as OutlineCommandId] = n
  }
  return out
}

/** 同表内冲突检测（shortcuts.cljs:133 conflicting-command 语义） */
export function findConflict(resolved: Record<OutlineCommandId, string>, id: OutlineCommandId): OutlineCommandId | null {
  const target = normalizeShortcut(resolved[id])
  for (const [other, sc] of Object.entries(resolved)) {
    if (other !== id && normalizeShortcut(sc) === target) return other as OutlineCommandId
  }
  return null
}

/** 事件 → 命令 id（编辑器 keydown 用） */
export function matchCommand(e: KeyboardEvent, resolved: Record<OutlineCommandId, string>): OutlineCommandId | null {
  const sc = eventToShortcut(e)
  if (!sc) return null
  for (const [id, bound] of Object.entries(resolved)) {
    if (bound === sc) return id as OutlineCommandId
  }
  return null
}
