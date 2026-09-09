// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { fromStore, writable } from 'svelte/store'
import EditorPane from './EditorPane.svelte'
import { pluginRuntime } from '../lib/plugins/runtime.svelte'
import type { Tab } from '../lib/tabs.svelte'

vi.mock('../lib/tabs.svelte', () => ({
  isManagedMemoryTab: (tab: { filePath: string }) => tab.filePath === '/vault/MEMORY.md',
  setContent: vi.fn(),
}))
vi.mock('../lib/outline/gate.svelte', () => ({ isOutlineNoteTab: () => false }))
vi.mock('../lib/i18n/store.svelte', () => ({ t: (key: string) => key }))
vi.mock('./ExternalChangeBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./SyncOriginBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./MirrorSiblingsBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./SyncToVaultBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./CsvEditor.svelte', () => ({ default: () => ({}) }))
vi.mock('./BaseView.svelte', () => ({ default: () => ({}) }))
vi.mock('./HtmlPreview.svelte', () => ({ default: () => ({}) }))
vi.mock('./outline/OutlineEditor.svelte', () => ({ default: () => ({}) }))
vi.mock('./RichEditor.svelte', async () => {
  const { onDestroy } = await import('svelte')
  return { default: (anchor: Comment, props: { tab: Tab; readOnly?: boolean }) => {
    const node = document.createElement('div')
    node.className = 'rich-editor-probe'
    node.textContent = props.tab.currentContent
    node.dataset.readOnly = String(!!props.readOnly)
    anchor.before(node)
    onDestroy(() => node.remove())
    return {}
  } }
})
vi.mock('./SourceView.svelte', async () => {
  const { onDestroy } = await import('svelte')
  return { default: (anchor: Comment, props: { value: string }) => {
    const node = document.createElement('textarea')
    node.className = 'source-editor-probe'
    node.value = props.value
    anchor.before(node)
    onDestroy(() => node.remove())
    return {}
  } }
})

describe('EditorPane Timeline display routing', () => {
  let component: ReturnType<typeof mount> | undefined
  const content = '---\ntype: Timeline\n---\n## 09:00–10:00 开发'

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    pluginRuntime.manifests = []
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function setup(overrides: Partial<Tab> = {}) {
    pluginRuntime.manifests = [{
      id: 'notemd.timeline', name: 'Timeline', version: '1.0.0', binary: '', host_capabilities: [],
      custom_editors: [{ id: 'timeline', markdown_types: ['Timeline'], entry: 'index.html' }],
    }]
    const store = writable({
      id: 'timeline-tab', filePath: '/vault/diary/day.timeline.md', title: 'day.timeline.md',
      currentContent: content, initialContent: content, kind: 'markdown', mode: 'rich',
      ...overrides,
    } as Tab)
    const tab = fromStore(store)
    component = mount(EditorPane, { target: document.body, props: { get tab() { return tab.current } } })
    await tick()
    return store
  }

  it('keeps Timeline a Markdown document and lets source mode take priority', async () => {
    const store = await setup()
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('plugin://notemd.timeline/index.html')
    store.update((tab) => {
      expect(tab.kind).toBe('markdown')
      expect(tab.currentContent).toBe(content)
      return { ...tab, mode: 'source' }
    })
    await tick()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('.source-editor-probe')?.value).toBe(content)
    store.update((tab) => ({ ...tab, mode: 'rich' }))
    await tick()
    expect(document.querySelector('iframe')).toBeTruthy()
  })

  it('falls back to the actual Markdown branch when the plugin rejects parsing', async () => {
    const store = await setup()
    const frame = document.querySelector('iframe')!
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    frame.dispatchEvent(new Event('load'))
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'plugin://notemd.timeline', source: frame.contentWindow,
      data: { type: 'custom_editor.fallback', requestId: 1 },
    }))
    await tick()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('.rich-editor-probe')?.textContent).toBe(content)
    store.update((tab) => ({ ...tab, mode: 'source' }))
    await tick()
    store.update((tab) => ({ ...tab, mode: 'rich' }))
    await tick()
    expect(document.querySelector('iframe')).toBeTruthy()
  })

  it('uses Markdown when the plugin becomes unavailable', async () => {
    await setup()
    pluginRuntime.manifests = []
    await tick()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('.rich-editor-probe')?.textContent).toBe(content)
  })

  it.each(['# ordinary Markdown', '---\ntype: [Timeline]\n---', '---\ntype: Timeline\ntype: Other\n---'])('leaves unmatched or invalid metadata in Markdown', async (currentContent) => {
    await setup({ currentContent })
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('.rich-editor-probe')?.textContent).toBe(currentContent)
  })

  it('retains managed-memory read-only protections even if its type is Timeline', async () => {
    await setup({ filePath: '/vault/MEMORY.md' })
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector<HTMLElement>('.rich-editor-probe')?.dataset.readOnly).toBe('true')
  })
})
