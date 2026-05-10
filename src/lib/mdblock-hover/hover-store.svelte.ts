import type { BlockYaml } from '../blockio/yaml-schema'
import { readBlockYaml } from '../blockio/yaml-rw'
import { settings } from '../settings.svelte'
import { cachedYamlPath } from '../mdblock/path'

interface PerTabState {
  filePath: string
  yaml: BlockYaml | null
  loading: boolean
}

const tabStates = new Map<string, PerTabState>()

/**
 * Reactive version counter — bumps on every load/drop. Components depend on
 * .version to re-derive their per-tab yaml.
 */
export const hoverStore = $state<{ version: number }>({ version: 0 })

function bumpVersion() {
  hoverStore.version++
}

export function getHoverState(filePath: string): PerTabState | null {
  return tabStates.get(filePath) ?? null
}

export async function loadHoverYaml(filePath: string): Promise<void> {
  if (!filePath.endsWith('.md')) return
  const existing = tabStates.get(filePath)
  if (existing?.loading) return
  tabStates.set(filePath, { filePath, yaml: null, loading: true })
  bumpVersion()
  const yaml = await readBlockYaml(await cachedYamlPath(filePath))
  tabStates.set(filePath, { filePath, yaml, loading: false })
  bumpVersion()
}

export function dropHoverState(filePath: string): void {
  if (tabStates.delete(filePath)) bumpVersion()
}

/** Listener wiring: refresh the in-memory yaml when commands write a fresh one. */
export function installHoverInvalidator(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('mdblock:yaml-updated', (ev: Event) => {
    const detail = (ev as CustomEvent<{ filePath: string }>).detail
    if (detail?.filePath) void loadHoverYaml(detail.filePath)
  })
}

/**
 * Whether block markers should display. Tied to the master mdblock toggle —
 * once mdblock is enabled, opening any document with an existing yaml will
 * auto-load and show the markers. The legacy `hover.enabled` sub-toggle is
 * no longer consulted (see Settings UI: it is hidden / always true).
 */
export function isHoverActive(): boolean {
  return settings.mdblock.enabled
}
