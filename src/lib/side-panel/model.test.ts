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
