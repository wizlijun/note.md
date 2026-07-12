# Switchable Left/Right Side Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the hard-coded left (FolderView) and right (Outline/History) sidebars into a registry-driven, tabbed, switchable layout so new side views are added by registering one entry — no `App.svelte` edits.

**Architecture:** Three layers — (1) a pure model (`model.ts`) with the `SideView` type and all derivation/toggle/migration logic as pure functions; (2) a reactive registry + per-side state + persistence (`registry.svelte.ts`); (3) one generic `SidePanel.svelte` container (rendered twice: left & right) that owns width/splitter/tab-bar and mounts the active view's content component. The existing `FolderView` / `OutlinePanel` / `HistoryPanel` are demoted to content-only components (they lose their own outer shell, width, and splitter).

**Tech Stack:** Svelte 5 (runes), TypeScript, `@tauri-apps/plugin-store` (settings.json), Vitest.

**Key design decisions (from spec `docs/superpowers/specs/2026-07-12-switchable-side-panels-design.md`):**
- Panel-top tabs. Tab bar shows only when ≥2 available views on that side.
- Active view not applicable to current file → auto-fallback to another applicable view; none applicable → whole side hidden.
- Width is per-side shared (left: 160–480 default 240; right: 240–640 default 360).
- Gates (`folderView` / `outlineGate` / `historyGate`) are KEPT — they remain the source of `enabled` + view-specific config (outline shortcuts/dirs). Only `visible`/`width`/`active` move to the new per-side state. The gates' vestigial `visible`/`width` fields/setters are left in place (still hydrated) to avoid breaking `folder-view.test.ts`; they simply stop being read by the UI.

---

## File Structure

**Create:**
- `src/lib/side-panel/model.ts` — pure types + `shownViews` / `resolveActiveView` / `computeToggle` / `clampWidth` / `migrateLeft` / `migrateRight` + `SIDE_BOUNDS`.
- `src/lib/side-panel/model.test.ts` — unit tests for the pure model.
- `src/lib/side-panel/registry.svelte.ts` — reactive `sidePanels` state, `SideView` registry, selectors, persistence/migration, `toggleSideView`, `registerBuiltinSideViews`.
- `src/lib/side-panel/registry.test.ts` — persistence/migration + toggle tests (mocked store).
- `src/components/side-panel/SidePanel.svelte` — generic container (width + splitter + tab bar + active content).

**Modify:**
- `src/components/FolderView.svelte` — content-only; props `{ tab }`; drop shell/width/splitter; hide → `setSideVisible('left', false)`.
- `src/components/outline/OutlinePanel.svelte` — content-only; drop shell/width/splitter; hide → `setSideVisible('right', false)`.
- `src/components/history/HistoryPanel.svelte` — content-only; drop shell/width/splitter; hide → `setSideVisible('right', false)`.
- `src/App.svelte` — render two `<SidePanel>`; register+load side panels at startup; generic `toggle` dispatch; new `rightPanelOffset`; remove old derives/imports.
- `src/lib/i18n/en.ts` + `src/lib/i18n/zh.ts` — add `folderView.tabTitle`.

---

## Task 1: Pure model (`model.ts`) + tests

**Files:**
- Create: `src/lib/side-panel/model.ts`
- Test: `src/lib/side-panel/model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/side-panel/model.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Tab } from '../tabs.svelte'
import {
  shownViews, resolveActiveView, computeToggle, clampWidth,
  migrateLeft, migrateRight, SIDE_BOUNDS, type SideView,
} from './model'

// Minimal fake tab — only fields the appliesTo closures below read.
const tabA = { id: 'a', filePath: '/x/a.md', kind: 'markdown' } as unknown as Tab

function view(partial: Partial<SideView> & Pick<SideView, 'id' | 'side'>): SideView {
  return {
    title: () => partial.id!,
    order: 0,
    isAvailable: () => true,
    appliesTo: () => true,
    component: async () => ({ default: null as never }),
    ...partial,
  }
}

describe('shownViews', () => {
  it('filters by side, availability, applicability and sorts by order', () => {
    const views = [
      view({ id: 'b', side: 'right', order: 2 }),
      view({ id: 'a', side: 'right', order: 1 }),
      view({ id: 'left', side: 'left' }),
      view({ id: 'off', side: 'right', isAvailable: () => false }),
      view({ id: 'na', side: 'right', appliesTo: () => false }),
    ]
    expect(shownViews(views, 'right', tabA).map((v) => v.id)).toEqual(['a', 'b'])
    expect(shownViews(views, 'left', tabA).map((v) => v.id)).toEqual(['left'])
  })
})

describe('resolveActiveView', () => {
  const shown = [view({ id: 'a', side: 'right' }), view({ id: 'b', side: 'right' })]
  it('returns the matching active view', () => {
    expect(resolveActiveView(shown, 'b')?.id).toBe('b')
  })
  it('falls back to the first when active id is absent', () => {
    expect(resolveActiveView(shown, 'gone')?.id).toBe('a')
    expect(resolveActiveView(shown, null)?.id).toBe('a')
  })
  it('returns null when nothing is shown', () => {
    expect(resolveActiveView([], 'a')).toBeNull()
  })
})

describe('computeToggle', () => {
  const v = view({ id: 'a', side: 'right' })
  it('opens the hidden side onto the view', () => {
    expect(computeToggle({ visible: false, activeId: null, width: 360 }, v))
      .toEqual({ visible: true, activeId: 'a' })
  })
  it('hides the side when toggling the already-active view', () => {
    expect(computeToggle({ visible: true, activeId: 'a', width: 360 }, v))
      .toEqual({ visible: false, activeId: 'a' })
  })
  it('switches tab when a different view is active', () => {
    expect(computeToggle({ visible: true, activeId: 'b', width: 360 }, v))
      .toEqual({ visible: true, activeId: 'a' })
  })
})

describe('clampWidth', () => {
  it('clamps to per-side bounds and rounds', () => {
    expect(clampWidth('left', 10)).toBe(SIDE_BOUNDS.left.min)
    expect(clampWidth('left', 9999)).toBe(SIDE_BOUNDS.left.max)
    expect(clampWidth('right', 360.6)).toBe(361)
  })
})

describe('migration', () => {
  it('migrates left from folderView.*', () => {
    expect(migrateLeft({ visible: true, width: 300 }))
      .toEqual({ visible: true, activeId: 'folder-view', width: 300 })
    expect(migrateLeft({}))
      .toEqual({ visible: false, activeId: 'folder-view', width: SIDE_BOUNDS.left.default })
  })
  it('migrates right, preferring the active panel width', () => {
    expect(migrateRight({ outlineVisible: true, outlineWidth: 400, historyVisible: false }))
      .toEqual({ visible: true, activeId: 'outline-notes', width: 400 })
    expect(migrateRight({ historyVisible: true, historyWidth: 420 }))
      .toEqual({ visible: true, activeId: 'git-history', width: 420 })
    expect(migrateRight({}))
      .toEqual({ visible: false, activeId: null, width: SIDE_BOUNDS.right.default })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/side-panel/model.test.ts`
Expected: FAIL — `Cannot find module './model'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/side-panel/model.ts`:

```ts
import type { Component } from 'svelte'
import type { Tab } from '../tabs.svelte'

export type Side = 'left' | 'right'

/** Props every side-view content component receives from the SidePanel container. */
export interface SideViewProps {
  tab: Tab | null
}
export type SideViewComponent = Component<SideViewProps>

/** A registerable view that lives on the left or right side of the editor. */
export interface SideView {
  id: string
  side: Side
  /** Tab label (function so i18n language switches update it). */
  title: () => string
  /** Ordering of tabs within a side (ascending). */
  order: number
  /** Whether the owning plugin is enabled (reads the gate's `enabled`). */
  isAvailable: () => boolean
  /** Whether the view is applicable to the current tab (default: always). */
  appliesTo: (tab: Tab | null) => boolean
  /** Lazy import of the content component. */
  component: () => Promise<{ default: SideViewComponent }>
}

/** Per-side UI state: whole-side visibility, active tab, shared width. */
export interface SidePanelState {
  visible: boolean
  activeId: string | null
  width: number
}

export const SIDE_BOUNDS: Record<Side, { min: number; max: number; default: number }> = {
  left: { min: 160, max: 480, default: 240 },
  right: { min: 240, max: 640, default: 360 },
}

export function clampWidth(side: Side, w: number): number {
  const b = SIDE_BOUNDS[side]
  return Math.max(b.min, Math.min(b.max, Math.round(w)))
}

/** Views on `side` that are both available (plugin on) and applicable to `tab`. */
export function shownViews(views: SideView[], side: Side, tab: Tab | null): SideView[] {
  return views
    .filter((v) => v.side === side && v.isAvailable() && v.appliesTo(tab))
    .sort((a, b) => a.order - b.order)
}

/** The active view: the one matching `activeId`, else the first shown, else null. */
export function resolveActiveView(shown: SideView[], activeId: string | null): SideView | null {
  if (shown.length === 0) return null
  return shown.find((v) => v.id === activeId) ?? shown[0]
}

/** Toggle semantics for a menu/shortcut command targeting `view`. */
export function computeToggle(
  state: SidePanelState,
  view: SideView,
): { visible: boolean; activeId: string } {
  if (!state.visible) return { visible: true, activeId: view.id }
  if (state.activeId === view.id) return { visible: false, activeId: view.id }
  return { visible: true, activeId: view.id }
}

export function migrateLeft(old: { visible?: boolean; width?: number }): SidePanelState {
  return {
    visible: old.visible ?? false,
    activeId: 'folder-view',
    width: old.width != null ? clampWidth('left', old.width) : SIDE_BOUNDS.left.default,
  }
}

export function migrateRight(old: {
  outlineVisible?: boolean
  outlineWidth?: number
  historyVisible?: boolean
  historyWidth?: number
}): SidePanelState {
  const activeId = old.outlineVisible ? 'outline-notes' : old.historyVisible ? 'git-history' : null
  const width = old.outlineVisible ? old.outlineWidth : old.historyVisible ? old.historyWidth : undefined
  return {
    visible: !!(old.outlineVisible || old.historyVisible),
    activeId,
    width: width != null ? clampWidth('right', width) : SIDE_BOUNDS.right.default,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/side-panel/model.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/side-panel/model.ts src/lib/side-panel/model.test.ts
git commit -m "feat(side-panel): pure model for switchable side views"
```

---

## Task 2: Registry + per-side state + persistence (`registry.svelte.ts`) + tests

**Files:**
- Create: `src/lib/side-panel/registry.svelte.ts`
- Test: `src/lib/side-panel/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/side-panel/registry.test.ts` (mirrors the Store-mock style of `src/lib/folder-view.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const storeGet = vi.fn()
const storeSet = vi.fn()
const storeSave = vi.fn()
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: vi.fn(async () => ({ get: storeGet, set: storeSet, save: storeSave })) },
}))
// The gate/store modules pulled in by registerBuiltinSideViews are not exercised
// here; stub them so importing the registry stays side-effect free.
vi.mock('../folder-view.svelte', () => ({ folderView: { enabled: true } }))
vi.mock('../outline/gate.svelte', () => ({ outlineGate: { enabled: true }, isOutlineNoteTab: () => false }))
vi.mock('../git-history/gate.svelte', () => ({ historyGate: { enabled: true }, historyAppliesTo: () => true }))
vi.mock('../sotvault.svelte', () => ({ sotvaultStore: { vaultRoot: '/vault' } }))
vi.mock('../i18n/store.svelte', () => ({ t: (k: string) => k }))

import {
  sidePanels, registerSideView, getSideView, loadSidePanels, toggleSideView,
} from './registry.svelte'
import type { SideView } from './model'

function stub(id: string, side: 'left' | 'right'): SideView {
  return {
    id, side, order: 0, title: () => id,
    isAvailable: () => true, appliesTo: () => true,
    component: async () => ({ default: null as never }),
  }
}

beforeEach(() => {
  storeGet.mockReset(); storeSet.mockReset(); storeSave.mockReset()
  sidePanels.left = { visible: false, activeId: null, width: 240 }
  sidePanels.right = { visible: false, activeId: null, width: 360 }
})

describe('loadSidePanels migration', () => {
  it('derives new sidebar.* state from legacy keys when absent', async () => {
    storeGet.mockImplementation(async (k: string) => ({
      'folderView.visible': true, 'folderView.width': 300,
      'outline.visible': true, 'outline.width': 400,
    } as Record<string, unknown>)[k])
    await loadSidePanels()
    expect(sidePanels.left).toEqual({ visible: true, activeId: 'folder-view', width: 300 })
    expect(sidePanels.right).toEqual({ visible: true, activeId: 'outline-notes', width: 400 })
    expect(storeSet).toHaveBeenCalledWith('sidebar.left.activeId', 'folder-view')
    expect(storeSet).toHaveBeenCalledWith('sidebar.right.activeId', 'outline-notes')
  })

  it('reads new keys directly when present', async () => {
    storeGet.mockImplementation(async (k: string) => ({
      'sidebar.left.visible': false, 'sidebar.left.activeId': 'folder-view', 'sidebar.left.width': 260,
      'sidebar.right.visible': true, 'sidebar.right.activeId': 'git-history', 'sidebar.right.width': 500,
    } as Record<string, unknown>)[k])
    await loadSidePanels()
    expect(sidePanels.left.width).toBe(260)
    expect(sidePanels.right).toEqual({ visible: true, activeId: 'git-history', width: 500 })
  })
})

describe('toggleSideView', () => {
  beforeEach(() => {
    // registry is module-global; ensure our stubs exist (idempotent).
    registerSideView(stub('outline-notes', 'right'))
    registerSideView(stub('git-history', 'right'))
    storeGet.mockResolvedValue(undefined)
  })
  it('opens the side onto the toggled view', async () => {
    expect(getSideView('outline-notes')).toBeDefined()
    await toggleSideView('outline-notes')
    expect(sidePanels.right.visible).toBe(true)
    expect(sidePanels.right.activeId).toBe('outline-notes')
  })
  it('switches tab, then hides on repeat toggle of the active view', async () => {
    await toggleSideView('outline-notes')
    await toggleSideView('git-history')
    expect(sidePanels.right).toMatchObject({ visible: true, activeId: 'git-history' })
    await toggleSideView('git-history')
    expect(sidePanels.right.visible).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/side-panel/registry.test.ts`
Expected: FAIL — `Cannot find module './registry.svelte'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/side-panel/registry.svelte.ts`:

```ts
import { Store } from '@tauri-apps/plugin-store'
import { t } from '../i18n/store.svelte'
import type { Tab } from '../tabs.svelte'
import {
  type Side, type SideView, type SidePanelState,
  SIDE_BOUNDS, clampWidth, shownViews, resolveActiveView, computeToggle,
  migrateLeft, migrateRight,
} from './model'
import { folderView } from '../folder-view.svelte'
import { outlineGate, isOutlineNoteTab } from '../outline/gate.svelte'
import { historyGate, historyAppliesTo } from '../git-history/gate.svelte'
import { sotvaultStore } from '../sotvault.svelte'

// ---- registry (plain module array; identity is stable across the app) --------
const registered: SideView[] = []

export function registerSideView(v: SideView): void {
  if (registered.some((x) => x.id === v.id)) return
  registered.push(v)
}
export function getSideView(id: string): SideView | undefined {
  return registered.find((v) => v.id === id)
}
export function registeredSideViews(): SideView[] {
  return registered
}

// ---- per-side reactive state -------------------------------------------------
export const sidePanels = $state<{ left: SidePanelState; right: SidePanelState }>({
  left: { visible: false, activeId: null, width: SIDE_BOUNDS.left.default },
  right: { visible: false, activeId: null, width: SIDE_BOUNDS.right.default },
})

// ---- reactive selectors (call the pure model with live registry + state) -----
export function sideShownViews(side: Side, tab: Tab | null): SideView[] {
  return shownViews(registered, side, tab)
}
export function sideActiveView(side: Side, tab: Tab | null): SideView | null {
  return resolveActiveView(sideShownViews(side, tab), sidePanels[side].activeId)
}
export function isSideVisible(side: Side, tab: Tab | null): boolean {
  return sidePanels[side].visible && sideShownViews(side, tab).length > 0
}
export function sideShowTabBar(side: Side, tab: Tab | null): boolean {
  return isSideVisible(side, tab) && sideShownViews(side, tab).length >= 2
}

// ---- persistence -------------------------------------------------------------
let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

export async function setSideVisible(side: Side, v: boolean): Promise<void> {
  sidePanels[side].visible = v
  const s = await getStore()
  await s.set(`sidebar.${side}.visible`, v)
  await s.save()
}
export async function setActiveView(side: Side, id: string): Promise<void> {
  sidePanels[side].activeId = id
  const s = await getStore()
  await s.set(`sidebar.${side}.activeId`, id)
  await s.save()
}
/** Update width in state only (clamped, no persist). Call during drag. */
export function setSideWidthLive(side: Side, w: number): void {
  sidePanels[side].width = clampWidth(side, w)
}
export async function setSideWidth(side: Side, w: number): Promise<void> {
  const c = clampWidth(side, w)
  sidePanels[side].width = c
  const s = await getStore()
  await s.set(`sidebar.${side}.width`, c)
  await s.save()
}

/** Menu/shortcut toggle: open onto / switch to / hide the given view. */
export async function toggleSideView(id: string): Promise<void> {
  const view = getSideView(id)
  if (!view) return
  const r = computeToggle(sidePanels[view.side], view)
  await setActiveView(view.side, r.activeId)
  await setSideVisible(view.side, r.visible)
}

/** Hydrate per-side state; migrate from legacy keys on first run. */
export async function loadSidePanels(): Promise<void> {
  const s = await getStore()

  const leftVisible = await s.get<boolean>('sidebar.left.visible')
  if (leftVisible === undefined) {
    const m = migrateLeft({
      visible: await s.get<boolean>('folderView.visible'),
      width: await s.get<number>('folderView.width'),
    })
    sidePanels.left = m
    await s.set('sidebar.left.visible', m.visible)
    await s.set('sidebar.left.activeId', m.activeId)
    await s.set('sidebar.left.width', m.width)
  } else {
    sidePanels.left = {
      visible: leftVisible,
      activeId: (await s.get<string>('sidebar.left.activeId')) ?? 'folder-view',
      width: clampWidth('left', (await s.get<number>('sidebar.left.width')) ?? SIDE_BOUNDS.left.default),
    }
  }

  const rightVisible = await s.get<boolean>('sidebar.right.visible')
  if (rightVisible === undefined) {
    const m = migrateRight({
      outlineVisible: await s.get<boolean>('outline.visible'),
      outlineWidth: await s.get<number>('outline.width'),
      historyVisible: await s.get<boolean>('history.visible'),
      historyWidth: await s.get<number>('history.width'),
    })
    sidePanels.right = m
    await s.set('sidebar.right.visible', m.visible)
    await s.set('sidebar.right.activeId', m.activeId)
    await s.set('sidebar.right.width', m.width)
  } else {
    sidePanels.right = {
      visible: rightVisible,
      activeId: (await s.get<string>('sidebar.right.activeId')) ?? null,
      width: clampWidth('right', (await s.get<number>('sidebar.right.width')) ?? SIDE_BOUNDS.right.default),
    }
  }

  await s.save()
}

/** Register the three built-in views. Idempotent; call once at startup. */
export function registerBuiltinSideViews(): void {
  registerSideView({
    id: 'folder-view', side: 'left', order: 0,
    title: () => t('folderView.tabTitle'),
    isAvailable: () => folderView.enabled,
    appliesTo: () => true,
    component: () => import('../../components/FolderView.svelte'),
  })
  registerSideView({
    id: 'outline-notes', side: 'right', order: 0,
    title: () => t('outline.title'),
    isAvailable: () => outlineGate.enabled,
    appliesTo: (tab) => !(tab != null && isOutlineNoteTab(tab)),
    component: () => import('../../components/outline/OutlinePanel.svelte'),
  })
  registerSideView({
    id: 'git-history', side: 'right', order: 1,
    title: () => t('history.title'),
    isAvailable: () => historyGate.enabled,
    appliesTo: (tab) => tab != null && historyAppliesTo(tab, sotvaultStore.vaultRoot),
    component: () => import('../../components/history/HistoryPanel.svelte'),
  })
}
```

> Note: `component:` returns `import('...FolderView.svelte')`. The `Component<SideViewProps>` typing requires those components to accept `{ tab }` — done in Tasks 4–6. Until then `pnpm check` may report a props mismatch on these lines; that clears once the components are refactored. Tests in this task don't touch the real components (they're mocked), so they pass now.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/side-panel/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/side-panel/registry.svelte.ts src/lib/side-panel/registry.test.ts
git commit -m "feat(side-panel): reactive registry, per-side state, persistence + migration"
```

---

## Task 3: `SidePanel.svelte` container

**Files:**
- Create: `src/components/side-panel/SidePanel.svelte`

- [ ] **Step 1: Create the container component**

Create `src/components/side-panel/SidePanel.svelte`:

```svelte
<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import type { Side } from '../../lib/side-panel/model'
  import {
    sidePanels, sideActiveView, sideShownViews, isSideVisible, sideShowTabBar,
    setActiveView, setSideWidth, setSideWidthLive,
  } from '../../lib/side-panel/registry.svelte'

  let { side, tab }: { side: Side; tab: Tab | null } = $props()

  let visible = $derived(isSideVisible(side, tab))
  let shown = $derived(sideShownViews(side, tab))
  let active = $derived(sideActiveView(side, tab))
  let showTabs = $derived(sideShowTabBar(side, tab))

  let startX = 0
  let startW = 0
  function onSplitterDown(e: PointerEvent) {
    startX = e.clientX
    startW = sidePanels[side].width
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onSplitterMove(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    if (!el.hasPointerCapture(e.pointerId)) return
    const delta = side === 'left' ? e.clientX - startX : startX - e.clientX
    setSideWidthLive(side, startW + delta)
  }
  function onSplitterUp(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    if (!el.hasPointerCapture(e.pointerId)) return
    el.releasePointerCapture(e.pointerId)
    void setSideWidth(side, sidePanels[side].width)
  }
</script>

{#if visible && active}
  <aside class="side-panel {side}" style="width: {sidePanels[side].width}px">
    {#if side === 'right'}
      <div class="splitter" onpointerdown={onSplitterDown} onpointermove={onSplitterMove} onpointerup={onSplitterUp}></div>
    {/if}

    {#if showTabs}
      <div class="tab-bar" role="tablist">
        {#each shown as v (v.id)}
          <button
            class="tab"
            class:active={v.id === active.id}
            role="tab"
            aria-selected={v.id === active.id}
            onclick={() => void setActiveView(side, v.id)}
          >{v.title()}</button>
        {/each}
      </div>
    {/if}

    <div class="content">
      {#key active.id}
        {#await active.component() then Mod}
          <Mod.default {tab} />
        {/await}
      {/key}
    </div>

    {#if side === 'left'}
      <div class="splitter" onpointerdown={onSplitterDown} onpointermove={onSplitterMove} onpointerup={onSplitterUp}></div>
    {/if}
  </aside>
{/if}

<style>
  .side-panel {
    position: relative;
    flex: 0 0 auto;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .side-panel.left { border-right: 1px solid var(--border-color, rgba(0, 0, 0, 0.08)); }
  .side-panel.right { border-left: 1px solid var(--border-color, #3333); }
  .splitter {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 5px;
    cursor: col-resize;
    z-index: 5;
    touch-action: none;
  }
  .side-panel.left .splitter { right: 0; }
  .side-panel.right .splitter { left: 0; }
  .splitter:hover { background: rgba(0, 0, 0, 0.08); }
  .tab-bar {
    display: flex;
    gap: 2px;
    padding: 4px 6px 0;
    border-bottom: 1px solid var(--border-color, #3333);
  }
  .tab {
    border: 0;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px 6px 0 0;
    opacity: 0.6;
  }
  .tab:hover { background: rgba(0, 0, 0, 0.06); opacity: 0.9; }
  .tab.active { opacity: 1; font-weight: 600; background: rgba(0, 0, 0, 0.08); }
  .content { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  /* Content components fill the container. */
  .content :global(> *) { flex: 1; min-height: 0; }
  @media (prefers-color-scheme: dark) {
    .splitter:hover { background: rgba(255, 255, 255, 0.1); }
    .tab:hover { background: rgba(255, 255, 255, 0.08); }
    .tab.active { background: rgba(255, 255, 255, 0.12); }
  }
</style>
```

- [ ] **Step 2: Typecheck the new component**

Run: `pnpm check 2>&1 | grep -A3 'SidePanel.svelte' || echo "no SidePanel errors"`
Expected: No errors originating in `SidePanel.svelte` itself. (Errors about `FolderView`/`OutlinePanel`/`HistoryPanel` props are expected until Tasks 4–6; they surface at the `component:` lines in `registry.svelte.ts`, not here.)

- [ ] **Step 3: Commit**

```bash
git add src/components/side-panel/SidePanel.svelte
git commit -m "feat(side-panel): generic SidePanel container (tabs + resize + lazy content)"
```

---

## Task 4: Demote `FolderView` to content component

**Files:**
- Modify: `src/components/FolderView.svelte`

Goal: props become `{ tab }`; remove the outer `<aside>` width wrapper, the `.splitter`, and all drag/width code; hide button hides the whole left side.

- [ ] **Step 1: Update the script — props, imports, remove drag code**

In `src/components/FolderView.svelte`, replace the import of `setWidth`/`setVisible` usage and props. Change the import block:

```svelte
  import {
    folderView, setRootDir, refreshAll, syncToActiveFile,
    parentDir, watchRoot, setFilter, clearFilter, revealInFinder,
    type FolderEntry,
  } from '../lib/folder-view.svelte'
  import { setSideVisible } from '../lib/side-panel/registry.svelte'
  import type { Tab } from '../lib/tabs.svelte'
```

(Removed `setWidth` and `setVisible` from the folder-view import; added `setSideVisible` and `Tab`.)

Change the props + derive `activePath`:

```svelte
  let { tab }: { tab: Tab | null } = $props()
  let activePath = $derived(tab?.filePath ?? null)
```

Remove the drag-to-resize block entirely (the `let asideEl`, `let dragging`, `startDrag`, `onDrag`, `endDrag` functions):

```svelte
  // Drag-to-resize the sidebar width.  ← DELETE this whole block:
  // let asideEl ... startDrag ... onDrag ... endDrag
```

- [ ] **Step 2: Update the markup — drop the aside shell and splitter**

Replace the opening `<aside ...>` line:

```svelte
<aside bind:this={asideEl} class="folder-view" style="width: {folderView.width}px">
```

with:

```svelte
<div class="folder-view-content">
```

Change the hide button's handler from `onclick={() => setVisible(false)}` to:

```svelte
    <button class="hbtn" onclick={() => void setSideVisible('left', false)} title={t('folderView.hide')} aria-label={t('folderView.hide')}>
```

Delete the splitter element near the end of the markup:

```svelte
  <div
    class="splitter"
    role="separator"
    aria-orientation="vertical"
    onpointerdown={startDrag}
    onpointermove={onDrag}
    onpointerup={endDrag}
  ></div>
```

Change the closing `</aside>` (the one that closes the folder root, immediately before the `{#if ctx.open}` block) to `</div>`.

- [ ] **Step 3: Update styles — fill the container instead of sizing itself**

Replace the `.folder-view` style rule:

```css
  .folder-view {
    position: relative;
    flex: 0 0 auto;
    height: 100%;
    display: flex; flex-direction: column;
    background: var(--drawer-bg, #f6f6f6);
    border-right: 1px solid rgba(0,0,0,0.08);
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }
```

with (rename to `.folder-view-content`, drop width/border/absolute concerns — the container owns those):

```css
  .folder-view-content {
    height: 100%;
    display: flex; flex-direction: column;
    background: var(--drawer-bg, #f6f6f6);
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }
```

Delete the `.splitter` and `.splitter:hover` rules (now owned by `SidePanel`). In the dark-mode block, change `.folder-view { background: ...; border-right-color: ... }` to `.folder-view-content { background: var(--drawer-bg, #1c1c1e); }` and delete the `.splitter:hover` dark rule.

- [ ] **Step 4: Typecheck**

Run: `pnpm check 2>&1 | grep -A3 'FolderView.svelte' || echo "no FolderView errors"`
Expected: no errors in `FolderView.svelte`.

- [ ] **Step 5: Commit**

```bash
git add src/components/FolderView.svelte
git commit -m "refactor(folder-view): content-only component for SidePanel"
```

---

## Task 5: Demote `OutlinePanel` to content component

**Files:**
- Modify: `src/components/outline/OutlinePanel.svelte`

- [ ] **Step 1: Update the script — imports + remove splitter/width code**

Change the gate import to drop width/visible setters and add the side setter:

```svelte
  import { outlineAppliesTo } from '../../lib/outline/gate.svelte'
  import { setSideVisible } from '../../lib/side-panel/registry.svelte'
```

(Removed `outlineGate, setOutlineWidth, setOutlineWidthLive, setOutlineVisible` from the outline gate import; kept `outlineAppliesTo`.)

Delete the splitter drag block:

```svelte
  let startX = 0
  let startW = 0
  function onSplitterDown(e: PointerEvent) { ... }
  function onSplitterMove(e: PointerEvent) { ... }
  function onSplitterUp(e: PointerEvent) { ... }
```

- [ ] **Step 2: Update the markup**

Replace the opening aside + splitter:

```svelte
<aside class="outline-panel" style="width: {outlineGate.width}px">
  <div
    class="splitter"
    onpointerdown={onSplitterDown}
    onpointermove={onSplitterMove}
    onpointerup={onSplitterUp}
  ></div>
  <header>
```

with:

```svelte
<div class="outline-content">
  <header>
```

Change the hide button handler:

```svelte
    <button class="hbtn" title={t('outline.hide')} aria-label={t('outline.hide')} onclick={() => void setSideVisible('right', false)}>
```

Change the closing `</aside>` to `</div>`.

- [ ] **Step 3: Update styles**

Replace `.outline-panel` rule:

```css
  .outline-panel {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color, #3333);
    overflow: hidden;
  }
```

with:

```css
  .outline-content {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
```

Delete the `.splitter` rule. Change the `.outline-panel :global(.outline-editor .body)` selector to `.outline-content :global(.outline-editor .body)`.

- [ ] **Step 4: Typecheck**

Run: `pnpm check 2>&1 | grep -A3 'OutlinePanel.svelte' || echo "no OutlinePanel errors"`
Expected: no errors in `OutlinePanel.svelte`.

- [ ] **Step 5: Commit**

```bash
git add src/components/outline/OutlinePanel.svelte
git commit -m "refactor(outline): content-only panel for SidePanel"
```

---

## Task 6: Demote `HistoryPanel` to content component

**Files:**
- Modify: `src/components/history/HistoryPanel.svelte`

- [ ] **Step 1: Update the script — imports + remove splitter/width code**

Change the git-history gate import to drop width/visible setters and add the side setter:

```svelte
  import { historyAppliesTo, relTime } from '../../lib/git-history/gate.svelte'
  import { setSideVisible } from '../../lib/side-panel/registry.svelte'
```

(Removed `historyGate, setHistoryWidth, setHistoryWidthLive, setHistoryVisible` from the import; kept `historyAppliesTo, relTime`.)

Delete the splitter drag block:

```svelte
  let startX = 0
  let startW = 0
  function onSplitterDown(e: PointerEvent) { ... }
  function onSplitterMove(e: PointerEvent) { ... }
  function onSplitterUp(e: PointerEvent) { ... }
```

- [ ] **Step 2: Update the markup**

Replace the opening aside + splitter:

```svelte
<aside class="history-panel" style="width: {historyGate.width}px">
  <div class="splitter" onpointerdown={onSplitterDown} onpointermove={onSplitterMove} onpointerup={onSplitterUp}></div>
  <header>
```

with:

```svelte
<div class="history-content">
  <header>
```

Change the hide button handler:

```svelte
    <button class="hbtn" title={t('history.hide')} aria-label={t('history.hide')} onclick={() => void setSideVisible('right', false)}>
```

Change the closing `</aside>` to `</div>`.

- [ ] **Step 3: Update styles**

Replace `.history-panel` rule:

```css
  .history-panel {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color, #3333);
    overflow: hidden;
  }
```

with:

```css
  .history-content {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
```

Delete the `.splitter` rule.

- [ ] **Step 4: Typecheck**

Run: `pnpm check 2>&1 | grep -A3 'HistoryPanel.svelte' || echo "no HistoryPanel errors"`
Expected: no errors in `HistoryPanel.svelte`.

- [ ] **Step 5: Commit**

```bash
git add src/components/history/HistoryPanel.svelte
git commit -m "refactor(history): content-only panel for SidePanel"
```

---

## Task 7: Wire into `App.svelte` + i18n key

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/zh.ts`
- Modify: `src/App.svelte`

- [ ] **Step 1: Add the folder tab-title i18n key**

In `src/lib/i18n/en.ts`, next to the existing `folderView.*` keys (near line 383), add:

```ts
  'folderView.tabTitle': 'Files',
```

In `src/lib/i18n/zh.ts`, add the matching entry alongside the other `folderView.*` keys:

```ts
  'folderView.tabTitle': '文件',
```

- [ ] **Step 2: Update `App.svelte` imports**

Add the SidePanel + registry imports near the other component imports:

```svelte
  import SidePanel from './components/side-panel/SidePanel.svelte'
  import {
    sidePanels, isSideVisible, loadSidePanels, registerBuiltinSideViews, toggleSideView, getSideView,
  } from './lib/side-panel/registry.svelte'
```

Remove the now-unused `FolderView` import and trim the gate imports to only what App still uses. Change these three lines:

```svelte
  import FolderView from './components/FolderView.svelte'
  import { folderView, loadFolderViewState, setVisible } from './lib/folder-view.svelte'
  import { outlineGate, loadOutlineGate, setOutlineVisible, isOutlineNoteTab } from './lib/outline/gate.svelte'
  import { historyGate, loadHistoryGate, setHistoryVisible, historyAppliesTo } from './lib/git-history/gate.svelte'
```

to:

```svelte
  import { loadFolderViewState } from './lib/folder-view.svelte'
  import { loadOutlineGate } from './lib/outline/gate.svelte'
  import { loadHistoryGate } from './lib/git-history/gate.svelte'
```

> The `loadOutlineGate`/`loadHistoryGate`/`loadFolderViewState` calls stay — they still hydrate each gate's `enabled` (and outline shortcuts). `setVisible`, `setOutlineVisible`, `setHistoryVisible`, `isOutlineNoteTab`, `historyAppliesTo`, `outlineGate`, `historyGate`, `folderView` are no longer referenced in `App.svelte` after the edits below. If `pnpm check` reports any as still-used, keep only those it flags.

- [ ] **Step 3: Replace the panel derives**

Delete the `showOutlinePanel` and `showHistoryPanel` derives (the two `$derived(...)` blocks around lines 635–645) and replace the `rightPanelOffset` derive:

```svelte
  let rightPanelOffset = $derived(
    showHistoryPanel ? historyGate.width : showOutlinePanel ? outlineGate.width : 0
  )
```

with:

```svelte
  // Right-edge inset for the floating mode toggle: push it left by the right
  // panel width whenever that side is showing, so it stays over the editor.
  let rightPanelOffset = $derived(isSideVisible('right', current) ? sidePanels.right.width : 0)
```

- [ ] **Step 4: Replace the `.pane` sidebar markup**

Replace the folder/outline/history blocks inside `<section class="pane">`:

```svelte
    {#if platformName !== 'ios' && folderView.enabled && folderView.visible}
      <FolderView activePath={current?.filePath ?? null} />
    {/if}
```

with:

```svelte
    {#if platformName !== 'ios'}
      <SidePanel side="left" tab={current ?? null} />
    {/if}
```

and replace:

```svelte
    {#if showOutlinePanel}
      {#await import('./components/outline/OutlinePanel.svelte') then Panel}
        <Panel.default tab={current ?? null} />
      {/await}
    {/if}
    {#if showHistoryPanel}
      {#await import('./components/history/HistoryPanel.svelte') then Panel}
        <Panel.default tab={current ?? null} />
      {/await}
    {/if}
```

with:

```svelte
    {#if platformName !== 'ios'}
      <SidePanel side="right" tab={current ?? null} />
    {/if}
```

- [ ] **Step 5: Register + load side panels at startup**

In the load sequence (after `await loadHistoryGate()`, around line 199), add:

```svelte
      await loadFolderViewState()
      await loadOutlineGate()
      await loadHistoryGate()
      registerBuiltinSideViews()
      await loadSidePanels()
```

- [ ] **Step 6: Generic toggle dispatch**

In `dispatchPlugin` (starts ~line 331), add a generic branch at the very top of the function body and delete the three hard-coded branches. Replace:

```ts
      dispatchPlugin = async (pluginId: string, command: string) => {
        if (pluginId === 'sotvault') {
          if (command === 'sync-to-vault') await syncCurrentToVault()
          return
        }
        if (pluginId === 'folder-view') {
          if (command === 'toggle') await setVisible(!folderView.visible)
          return
        }
        if (pluginId === 'outline-notes') {
          if (command === 'toggle') {
            const next = !outlineGate.visible
            await setOutlineVisible(next)
            if (next) await setHistoryVisible(false)
          }
          return
        }
        if (pluginId === 'git-history') {
          if (command === 'toggle') {
            const next = !historyGate.visible
            await setHistoryVisible(next)
            if (next) await setOutlineVisible(false)
          }
          return
        }
        if (pluginId === 'roam-import') {
```

with:

```ts
      dispatchPlugin = async (pluginId: string, command: string) => {
        // Side-view toggles: folder-view / outline-notes / git-history and any
        // future registered side view all route through the registry. The
        // per-side "one active tab" model replaces the old outline↔history
        // mutual-exclusion special-casing.
        if (command === 'toggle' && getSideView(pluginId)) {
          await toggleSideView(pluginId)
          return
        }
        if (pluginId === 'sotvault') {
          if (command === 'sync-to-vault') await syncCurrentToVault()
          return
        }
        if (pluginId === 'roam-import') {
```

- [ ] **Step 7: Typecheck the whole app**

Run: `pnpm check`
Expected: PASS (0 errors). If any removed import is still referenced, restore just that symbol.

- [ ] **Step 8: Run the full test suite**

Run: `pnpm test`
Expected: PASS (existing suite green + the new `model.test.ts` / `registry.test.ts`).

- [ ] **Step 9: Commit**

```bash
git add src/App.svelte src/lib/i18n/en.ts src/lib/i18n/zh.ts
git commit -m "feat(side-panel): render SidePanels + registry-driven toggle in App"
```

---

## Task 8: Build + manual GUI verification

**Files:** none (verification only)

- [ ] **Step 1: Production build sanity**

Run: `pnpm build`
Expected: Vite build succeeds with no errors.

- [ ] **Step 2: Manual GUI verification (dev build)**

Follow the project's established GUI-verification flow (dev build + osascript-driven window + `/tmp/mdeditor.log` + `screencapture`; ensure the desktop is free of other concurrent sessions first). Verify:

- [ ] Left side: folder view shows/hides via its menu/shortcut toggle; no tab bar (single view); drag the right edge to resize; width persists across restart.
- [ ] Right side with both plugins enabled: a tab bar with **Outline** and **History**; clicking a tab switches content without collapsing; drag the left edge to resize; shared width persists.
- [ ] Toggle semantics: with the right side hidden, the Outline shortcut opens it on Outline; the History shortcut then switches to History (side stays open); pressing the History shortcut again hides the side.
- [ ] Auto-fallback: with History active, open a file **outside** the vault → right side falls back to Outline (or hides if Outline also inapplicable); open a `.note.md` full-screen outline tab → Outline drops out and it falls back to History or hides.
- [ ] Migration: on the first launch after this change, prior `outline.visible` / `history.visible` / `folderView.visible` states are reflected in the new layout.

- [ ] **Step 3: Final full check**

Run: `pnpm check && pnpm test`
Expected: both PASS.

- [ ] **Step 4: Commit any verification fixups**

```bash
git add -A
git commit -m "fix(side-panel): GUI verification fixups"
```

(Skip if nothing changed.)

---

## Self-Review Notes (author checklist — verified)

- **Spec coverage:** SideView registry (Task 1–2) ✓; per-side state + persistence + migration (Task 2) ✓; SidePanel container with tab bar hidden when ≤1 view (Task 3) ✓; auto-fallback + display rules as pure derivation (Task 1, used in Task 2/3) ✓; toggle semantics (Task 1 `computeToggle`, Task 2 `toggleSideView`, wired Task 7) ✓; content-component demotion of all three views (Tasks 4–6) ✓; generic `dispatchPlugin` (Task 7) ✓; shared per-side width (Task 1 `SIDE_BOUNDS`/`clampWidth`) ✓; gates retained for `enabled`/config (stated, Tasks 4–7) ✓; i18n tab title (Task 7) ✓; future-extension rule (register one entry, no App edits — enabled by Task 2/7 generic dispatch) ✓.
- **Placeholder scan:** none.
- **Type consistency:** `SideView`, `SidePanelState`, `Side`, `SideViewProps`/`SideViewComponent` defined in Task 1 and used verbatim in Tasks 2–3; selector names (`sideShownViews`/`sideActiveView`/`isSideVisible`/`sideShowTabBar`) and setters (`setSideVisible`/`setActiveView`/`setSideWidth`/`setSideWidthLive`/`toggleSideView`) consistent across Tasks 2, 3, 4, 5, 6, 7.
```
