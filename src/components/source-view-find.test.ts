/**
 * @vitest-environment happy-dom
 */
// Mount-time find behaviour: switching rich/source (or tabs) mounts a new
// editor while the find bar keeps its query, and the bar only dispatches when
// the query changes — so the editor has to pull the current state on mount.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FileSourceOptions } from '../editor-kit-v2/file-source-input'

it('file replace-all preserves disjoint mixed EOL and paints rejected draft matches', async () => {
  const { mount, unmount, tick } = await import('svelte')
  const { default: SourceView } = await import('./SourceView.svelte')
  const { open } = await import('../editor-kit-v2/file-test-utils')
  const { attachFileSourceInput } = await import('../editor-kit-v2/file-source-input')
  const { tabs, activeId } = await import('../lib/tabs.svelte')
  const { findState } = await import('../lib/find-replace.svelte')
  let allow = true
  const raw = 'A\r\nkeep\nA\rTail', controller = open(raw, [], undefined, { acceptRawChange: () => allow })
  const owner = { snapshot: controller.snapshot, replaceSource: controller.replaceSource, observe: controller.observe,
    undo: () => controller.runHistory('undo', true), redo: () => controller.runHistory('redo', true) }
  tabs.push({ id: 'find-file', title: 'file', filePath: '', kind: 'markdown', mode: 'source', currentContent: raw, initialContent: raw,
    externalState: 'fresh', externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' }); activeId.value = 'find-file'
  const target = document.createElement('div'); document.body.append(target)
  const component = mount(SourceView, { target, props: { value: raw, tabId: 'find-file', oninput() { throw new Error('adapter bypass') },
    attachFileSource: (el: HTMLTextAreaElement, options?: FileSourceOptions) => attachFileSourceInput(el, owner, options) } })
  try {
    await tick()
    window.dispatchEvent(new CustomEvent('notemd:find-search', { detail: { query: 'A', caseSensitive: true, wholeWord: false, useRegex: false } })); await tick()
    window.dispatchEvent(new CustomEvent('notemd:find-replace-all', { detail: { replacement: 'Z' } })); await tick()
    expect(controller.snapshot().raw).toBe('Z\r\nkeep\nZ\rTail')
    allow = false
    window.dispatchEvent(new CustomEvent('notemd:find-search', { detail: { query: 'Z', caseSensitive: true, wholeWord: false, useRegex: false } })); await tick()
    window.dispatchEvent(new CustomEvent('notemd:find-replace-all', { detail: { replacement: 'Draft' } })); await tick()
    expect(controller.snapshot().raw).toBe('Z\r\nkeep\nZ\rTail')
    expect(target.querySelector('textarea')!.value).toBe('Draft\nkeep\nDraft\nTail')
    window.dispatchEvent(new CustomEvent('notemd:find-search', { detail: { query: 'Draft', caseSensitive: true, wholeWord: false, useRegex: false } })); await tick()
    expect(findState.matchCount).toBe(2)
    expect(target.querySelectorAll('.search-hit,.search-hit-current')).toHaveLength(2)
  } finally { await unmount(component); target.remove(); tabs.splice(0); activeId.value = null }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => false, readTextFile: async () => '', writeTextFile: async () => {} }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: async () => null, save: async () => null }))

const CONTENT = Array.from({ length: 40 }, (_, i) => `line ${i} alpha beta`).join('\n')

async function mountSourceView() {
  const { mount } = await import('svelte')
  const SourceView = (await import('./SourceView.svelte')).default
  const target = document.createElement('div')
  document.body.appendChild(target)
  mount(SourceView, { target, props: { value: CONTENT, oninput: () => {}, tabId: 'tab-1' } })
  await new Promise((r) => setTimeout(r, 20))
  return target
}

describe('SourceView find integration', () => {
  beforeEach(async () => {
    const { findState } = await import('../lib/find-replace.svelte')
    findState.open = false
    findState.query = ''
    findState.caseSensitive = false
    findState.wholeWord = false
    findState.useRegex = false
    findState.matchCount = 0
    findState.currentMatch = 0
  })

  it('picks up a query that was already in the find bar when it mounts', async () => {
    const { findState, openFind } = await import('../lib/find-replace.svelte')
    openFind()
    findState.query = 'alpha'

    await mountSourceView()

    expect(findState.matchCount).toBe(40)
    expect(findState.currentMatch).toBe(1)
  })

  it('stays quiet when the find bar is closed', async () => {
    const { findState } = await import('../lib/find-replace.svelte')
    findState.query = 'alpha'   // stale query, bar not open
    await mountSourceView()
    expect(findState.matchCount).toBe(0)
  })

  it('paints hits into the overlay, and next moves the current hit', async () => {
    const { findState, openFind } = await import('../lib/find-replace.svelte')
    openFind()
    findState.query = 'alpha'
    const target = await mountSourceView()

    const pre = target.querySelector('pre.hl') as HTMLElement
    // Which hit (in document order) currently carries the "current" class?
    const currentPos = () => {
      const all = [...pre.querySelectorAll('.search-hit, .search-hit-current')]
      return all.findIndex((el) => el.classList.contains('search-hit-current'))
    }
    expect(pre.querySelectorAll('.search-hit-current').length).toBe(1)
    expect(pre.querySelectorAll('.search-hit').length).toBe(39)
    expect(currentPos()).toBe(0)

    window.dispatchEvent(new CustomEvent('notemd:find-next'))
    await new Promise((r) => setTimeout(r, 10))

    expect(findState.currentMatch).toBe(2)
    expect(currentPos()).toBe(1)
  })

  it('does not loop: one search dispatch produces one search', async () => {
    const { findState, openFind } = await import('../lib/find-replace.svelte')
    openFind()
    await mountSourceView()

    let dispatched = 0
    const count = () => { dispatched++ }
    window.addEventListener('notemd:find-search', count)
    window.dispatchEvent(new CustomEvent('notemd:find-search', {
      detail: { query: 'alpha', caseSensitive: false, wholeWord: false, useRegex: false },
    }))
    await new Promise((r) => setTimeout(r, 20))
    window.removeEventListener('notemd:find-search', count)

    expect(dispatched).toBe(1)
    expect(findState.matchCount).toBe(40)
  })
})
