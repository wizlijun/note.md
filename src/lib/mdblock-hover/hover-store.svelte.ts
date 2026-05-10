import type { BlockYaml } from '../blockio/yaml-schema'
import { readBlockYaml } from '../blockio/yaml-rw'
import { settings } from '../settings.svelte'

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

function yamlPathFor(mdPath: string): string {
  return mdPath.endsWith('.md')
    ? mdPath.slice(0, -3) + '.block.yaml'
    : `${mdPath}.block.yaml`
}

export async function loadHoverYaml(filePath: string): Promise<void> {
  if (!filePath.endsWith('.md')) return
  const existing = tabStates.get(filePath)
  if (existing?.loading) return
  tabStates.set(filePath, { filePath, yaml: null, loading: true })
  bumpVersion()
  const yaml = await readBlockYaml(yamlPathFor(filePath))
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

export function isHoverActive(): boolean {
  return settings.mdblock.enabled && settings.mdblock.hover.enabled
}
