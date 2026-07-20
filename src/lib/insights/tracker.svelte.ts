import { getCurrentWindow } from '@tauri-apps/api/window'
import { exists, mkdir, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { hostname } from '@tauri-apps/plugin-os'
import type { MorayaEditorInstance } from '@moraya/core'
import { activeTab } from '../tabs.svelte'
import { sotvaultStore } from '../sotvault.svelte'
import { getDeviceId } from '../settings.svelte'
import { createAnalyticsStore, type AnalyticsStore, type Fs } from './store.svelte'
import { initTiming, applyEvent, activeNow, sessionActionFor, type TimingState, type TimingEvent, type TimingMode } from './timing'
import { docKeyFor, localTzOffsetMinutes } from './model'
import { analyticsObserverPlugin } from './observer'

const TICK_MS = 5_000
const FLUSH_EVERY_TICKS = 6 // ~30s

const fs: Fs = {
  exists: (p) => exists(p),
  mkdir: (p, o) => mkdir(p, o).then(() => {}),
  readDir: async (p) => (await readDir(p)).map((e) => ({ name: e.name, isFile: e.isFile })),
  readTextFile: (p) => readTextFile(p),
  writeTextFile: (p, c) => writeTextFile(p, c),
}

interface TrackerState {
  store: AnalyticsStore
  timing: TimingState
  currentDocKey: string | null
  timer: ReturnType<typeof setInterval> | null
  tickCount: number
  disposers: Array<() => void>
}

let tracker: TrackerState | null = null

/** Which vault the tracker is currently installed for, plus its disposer. */
let installed: { root: string; dispose: () => void | Promise<void> } | null = null

function currentDocKey(): string | null {
  const t = activeTab()
  if (!t || !t.filePath || t.kind !== 'markdown') return null
  return docKeyFor(t.filePath, sotvaultStore.vaultRoot)
}

function currentMode(): TimingMode {
  return activeTab()?.mode === 'source' ? 'edit' : 'read'
  // NOTE: 'rich' + no typing is still "read"; edit_ms is credited whenever the
  // observer reports doc changes (below) — see analyticsPluginForEditor().
}

function dispatch(ev: TimingEvent): void {
  if (!tracker) return
  const now = Date.now()
  const wasActive = activeNow(tracker.timing.presence)
  const { state, accrued } = applyEvent(tracker.timing, ev, now)
  tracker.timing = state
  const docKey = tracker.currentDocKey
  if (!docKey) return
  const act = sessionActionFor(wasActive, activeNow(state.presence), accrued)
  if (act.start) tracker.store.sessionStart(docKey, now)
  if (act.extend) {
    tracker.store.accrue(
      docKey,
      act.extend.mode === 'read' ? { read_ms: act.extend.ms } : { edit_ms: act.extend.ms },
      now,
    )
    tracker.store.sessionExtend(docKey, act.extend.mode, act.extend.ms, now)
  }
  if (act.close) tracker.store.sessionClose(docKey)
}

/** Switch the tracked document: credit + close the old doc's interval, reset
 *  timing for the new, and open its interval (we're switching in the foreground). */
export function onActiveDocChanged(): void {
  if (!tracker) return
  dispatch({ type: 'tabInactive' }) // credit remaining time + close old doc's session
  tracker.currentDocKey = currentDocKey()
  tracker.timing = initTiming(Date.now(), currentMode())
  if (tracker.currentDocKey) {
    tracker.store.accrue(tracker.currentDocKey, { open_count: 1 }, Date.now())
    // Assume focused + active tab (a doc switch happens in the foreground), so the
    // new doc's interval opens immediately — mirrors the install path below.
    dispatch({ type: 'focus' })
    dispatch({ type: 'tabActive' })
  }
}

/** Attach the analytics observer to a freshly mounted editor. Returns a plugin
 *  to be merged into the editor's state (see editor-bridge wiring). */
export function analyticsPluginForEditor() {
  return analyticsObserverPlugin(({ markOps, sizeDelta }) => {
    if (!tracker || !tracker.currentDocKey) return
    const now = Date.now()
    // A doc change counts as user activity (resumes from idle) and an edit.
    dispatch({ type: 'activity' })
    tracker.store.accrue(
      tracker.currentDocKey,
      { mark_ops: markOps, net_chars: Math.max(0, sizeDelta), edit_sessions: 1 },
      now,
    )
  })
}

export async function installTracker(): Promise<() => void> {
  // Core-ized: vault gate remains; plugin gate removed.
  if (sotvaultStore.vaultRoot === null) {
    return () => {}
  }
  const deviceId = getDeviceId()
  const deviceName = (await hostname().catch(() => null)) ?? `Device-${deviceId.slice(0, 8)}`
  const store = createAnalyticsStore({
    fs,
    vaultRoot: () => sotvaultStore.vaultRoot,
    deviceId,
    deviceName,
    tzOffsetMinutes: localTzOffsetMinutes(),
  })
  // Seed today's buckets from any file an earlier session wrote, so this session's
  // flush merges with it instead of overwriting (no restart data loss).
  await store.preloadToday()
  tracker = {
    store,
    timing: initTiming(Date.now(), currentMode()),
    currentDocKey: currentDocKey(),
    timer: null,
    tickCount: 0,
    disposers: [],
  }
  const self = tracker

  // Window focus/blur.
  const unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    dispatch({ type: focused ? 'focus' : 'blur' })
  })
  tracker.disposers.push(unlistenFocus)

  // User activity (idle reset).
  const activity = () => dispatch({ type: 'activity' })
  for (const evt of ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(evt, activity, { passive: true })
    tracker.disposers.push(() => window.removeEventListener(evt, activity))
  }

  // Periodic tick: idle detection + checkpoint + flush.
  tracker.timer = setInterval(() => {
    dispatch({ type: 'tick' })
    if (tracker && ++tracker.tickCount % FLUSH_EVERY_TICKS === 0) void store.flush()
  }, TICK_MS)

  // Assume focused + active tab at install (app is in the foreground on mount).
  dispatch({ type: 'focus' })
  dispatch({ type: 'tabActive' })
  if (tracker.currentDocKey) store.accrue(tracker.currentDocKey, { open_count: 1 }, Date.now())

  // Flush on page hide (app quit / backgrounding).
  const onHide = () => { void store.flush() }
  window.addEventListener('pagehide', onHide)
  tracker.disposers.push(() => window.removeEventListener('pagehide', onHide))

  return async () => {
    dispatch({ type: 'blur' })
    if (self.timer) clearInterval(self.timer)
    self.disposers.forEach((d) => d())
    await self.store.flush()
    // Only clear the module slot if a newer install hasn't replaced us (guards
    // the rare vault-change reinstall from nulling the fresh tracker mid-flush).
    if (tracker === self) tracker = null
  }
}

/** Notify the tracker that the editor mode toggled (rich ↔ source). */
export function onModeChanged(): void {
  dispatch({ type: 'mode', mode: currentMode() })
}

/** Flush in-memory analytics to disk immediately (e.g. before reading all devices). */
export async function flushNow(): Promise<void> {
  if (tracker) await tracker.store.flush()
}

/**
 * Idempotently (re)install the tracker for the currently-configured vault.
 *
 * Called at boot (via App.svelte onMount) and on vault-root changes (via
 * `setVaultRootChangedHandler` → `refreshSotvault`). Unlike a one-shot
 * `onMount` install, this is STATE-driven so it works correctly both when
 * a vault is already configured at launch and when the user configures one
 * mid-session. No-ops when no vault is set or when the tracker is already
 * installed for that same vault root.
 */
export async function maybeInstallTracker(
  install: () => Promise<() => void | Promise<void>> = installTracker,
): Promise<void> {
  const root = sotvaultStore.vaultRoot
  // Core-ized: vault gate remains; plugin gate removed.
  if (root === null) return
  if (installed && installed.root === root) return
  if (installed) {
    const prev = installed
    installed = null
    await prev.dispose()
  }
  const dispose = await install()
  installed = { root, dispose }
}

/** Tear down the tracker (app teardown). */
export async function shutdownTracker(): Promise<void> {
  if (!installed) return
  const prev = installed
  installed = null
  await prev.dispose()
}
