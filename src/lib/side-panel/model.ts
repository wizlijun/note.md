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
  // Always returns a non-null activeId: toggling a specific view always names it.
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
  // outline takes priority if both legacy flags are somehow set
  const activeId = old.outlineVisible ? 'outline-notes' : old.historyVisible ? 'git-history' : null
  const width = old.outlineVisible ? old.outlineWidth : old.historyVisible ? old.historyWidth : undefined
  return {
    visible: !!(old.outlineVisible || old.historyVisible),
    activeId,
    width: width != null ? clampWidth('right', width) : SIDE_BOUNDS.right.default,
  }
}
