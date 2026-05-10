import type { BlockYaml } from '../blockio/yaml-schema'
import { readBlockYaml } from '../blockio/yaml-rw'
import { settings } from '../settings.svelte'
import { cachedYamlPath } from '../mdblock/path'

interface PerTabState {
  filePath: string
  /** The persisted yaml from the cache. Source of truth across sessions. */
  yaml: BlockYaml | null
  /**
   * In-memory live yaml computed from the editor's current source. Reflects
   * the chunker / merge result for the unsaved content. When non-null,
   * components prefer it over `yaml` for marker display so structure
   * (new blocks, removed blocks, shifted positions) tracks edits in
   * near-real time without disk writes.
   */
  liveYaml: BlockYaml | null
  loading: boolean
  /** Whether a live recompute is currently running (prevents reentry). */
  recomputing: boolean
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

/** Display yaml: prefer the live preview, fall back to the persisted file. */
export function getDisplayYaml(filePath: string): BlockYaml | null {
  const s = tabStates.get(filePath)
  return s?.liveYaml ?? s?.yaml ?? null
}

export async function loadHoverYaml(filePath: string): Promise<void> {
  if (!filePath.endsWith('.md')) return
  const existing = tabStates.get(filePath)
  if (existing?.loading) return
  tabStates.set(filePath, {
    filePath,
    yaml: existing?.yaml ?? null,
    liveYaml: existing?.liveYaml ?? null,
    loading: true,
    recomputing: existing?.recomputing ?? false,
  })
  bumpVersion()
  const yaml = await readBlockYaml(await cachedYamlPath(filePath))
  tabStates.set(filePath, {
    filePath,
    yaml,
    liveYaml: null,   // persisted yaml is fresh; clear stale live preview
    loading: false,
    recomputing: false,
  })
  bumpVersion()
}

/**
 * Recompute the live preview yaml from the editor's current source. Runs
 * the chunker + merge (against the persisted yaml as the merge base),
 * stores the result as liveYaml for display. Does NOT write to disk —
 * persistence stays explicit (user runs Cmd+Shift+B).
 *
 * Reentrant calls are debounced by a `recomputing` flag; subsequent
 * triggers while one is in flight are dropped. The caller (typically a
 * setTimeout in the editor view) is expected to debounce its own input.
 */
export async function recomputeLiveYaml(filePath: string, source: string): Promise<void> {
  const state = tabStates.get(filePath)
  if (!state) return  // nothing loaded yet
  if (state.recomputing) return
  // Mark recomputing without bumping version (avoids unnecessary re-renders)
  tabStates.set(filePath, { ...state, recomputing: true })
  try {
    const { computeAndBuildYaml } = await import('../mdblock/commands')
    const { yaml } = await computeAndBuildYaml(filePath, source, state.yaml)
    const after = tabStates.get(filePath)
    if (!after) return  // tab closed during recompute
    tabStates.set(filePath, { ...after, liveYaml: yaml, recomputing: false })
    bumpVersion()
  } catch (e) {
    // Live preview is best-effort; never throw to UI.
    // eslint-disable-next-line no-console
    console.warn('[mdblock-hover] live recompute failed:', e)
    const after = tabStates.get(filePath)
    if (after) tabStates.set(filePath, { ...after, recomputing: false })
  }
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
 * auto-load and show the markers.
 */
export function isHoverActive(): boolean {
  return settings.mdblock.enabled
}
