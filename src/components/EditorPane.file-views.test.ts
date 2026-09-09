// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { fromStore, writable } from 'svelte/store'
import EditorPane from './EditorPane.svelte'
import { pluginRuntime } from '../lib/plugins/runtime.svelte'
import type { Tab } from '../lib/tabs.svelte'
import { setContent } from '../lib/tabs.svelte'
import type { PluginManifest } from '../lib/plugins/types'

vi.mock('../lib/tabs.svelte', () => ({
  isManagedMemoryTab: (tab: { filePath: string }) => tab.filePath === '/vault/MEMORY.md',
  setContent: vi.fn(),
}))
vi.mock('../lib/outline/gate.svelte', () => ({ isOutlineNoteTab: (tab: Tab) => tab.filePath.endsWith('.note.md') }))
vi.mock('../lib/i18n/store.svelte', () => ({ t: (key: string) => key }))
vi.mock('./ExternalChangeBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./SyncOriginBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./MirrorSiblingsBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./SyncToVaultBanner.svelte', () => ({ default: () => ({}) }))
async function editorProbe(className: string) {
  const { onDestroy } = await import('svelte')
  return { default: (anchor: Comment, props: { tab?: Tab; html?: string }) => {
    const node = document.createElement('div')
    node.className = className
    node.textContent = props.tab?.currentContent ?? props.html ?? ''
    anchor.before(node)
    onDestroy(() => node.remove())
    return {}
  } }
}
vi.mock('./CsvEditor.svelte', () => editorProbe('csv-editor-probe'))
vi.mock('./BaseView.svelte', () => editorProbe('base-editor-probe'))
vi.mock('./HtmlPreview.svelte', () => editorProbe('html-preview-probe'))
vi.mock('./outline/OutlineEditor.svelte', () => editorProbe('outline-editor-probe'))
vi.mock('./CustomEditorIframe.svelte', () => editorProbe('custom-editor-probe'))
vi.mock('./RichEditor.svelte', async () => {
  const { onDestroy } = await import('svelte')
  return { default: (anchor: Comment, props: { tab: Tab; readOnly?: boolean; wrapAsCodeBlock?: string; onFlush?: (content: string) => void }) => {
    const node = document.createElement('div')
    node.className = 'rich-editor-probe'
    node.textContent = props.tab.currentContent
    node.dataset.readOnly = String(!!props.readOnly)
    node.dataset.language = props.wrapAsCodeBlock
    node.contentEditable = String(!props.readOnly)
    node.tabIndex = 0
    node.oninput = () => props.onFlush?.(node.textContent ?? '')
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

describe('EditorPane file view routing', () => {
  let component: ReturnType<typeof mount> | undefined
  const content = '---\ntype: Timeline\n---\n## 09:00–10:00 开发'

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    pluginRuntime.manifests = []
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.mocked(setContent).mockReset()
  })

  async function setup(overrides: Partial<Tab> = {}, views?: PluginManifest['file_views'], pluginId = 'notemd.timeline') {
    pluginRuntime.manifests = [{
      id: pluginId, name: 'File preview', version: '1.0.0', binary: '', host_capabilities: [],
      file_views: views ?? [{ id: 'timeline', selectors: [{ file_extensions: ['md'], frontmatter: { type: ['timeline'] } }], entry: 'index.html' }],
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
      data: { type: 'file_view.fallback', requestId: 1 },
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

  it('keeps editing after metadata stops matching, changes rules, and matches again until an explicit retry', async () => {
    const store = await setup({}, [
      { id: 'timeline', selectors: [{ file_extensions: ['md'], frontmatter: { type: ['timeline'] } }], entry: 'index.html' },
      { id: 'alternate', selectors: [{ file_extensions: ['md'], frontmatter: { type: ['other'] } }], entry: 'other.html' },
    ])
    vi.mocked(setContent).mockImplementation((id, value) => store.update((tab) => ({ ...tab, currentContent: value })))
    const frame = document.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', { origin: 'plugin://notemd.timeline', source: frame.contentWindow, data: { type: 'file_view.fallback', requestId: 1, reason: 'edit' } }))
    await tick()
    const editor = document.querySelector<HTMLElement>('.rich-editor-probe')!
    editor.focus()
    for (const value of ['---\ntype:\n---\nEditing', '---\ntype: other\n---\nAnother rule', content]) {
      editor.textContent = value
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
      expect(document.querySelector('iframe')).toBeNull()
      expect(document.querySelector('.rich-editor-probe')).toBe(editor)
      expect(document.activeElement).toBe(editor)
      expect(vi.mocked(setContent)).toHaveBeenLastCalledWith('timeline-tab', value)
    }
    document.querySelector<HTMLButtonElement>('.file-plugin-fallback button')!.click()
    await tick()
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('plugin://notemd.timeline/index.html')
  })

  it('retains the default editor across plugin removal and retries matching after external reload', async () => {
    await setup()
    const manifests = pluginRuntime.manifests
    const frame = document.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', { origin: 'plugin://notemd.timeline', source: frame.contentWindow, data: { type: 'file_view.fallback', requestId: 1 } }))
    await tick()
    pluginRuntime.manifests = []; await tick()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('.rich-editor-probe')).toBeTruthy()
    pluginRuntime.manifests = manifests; await tick()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('.rich-editor-probe')).toBeTruthy()
    window.dispatchEvent(new CustomEvent('notemd:auto-reloaded', { detail: { tabId: 'timeline-tab', oldContent: content, newContent: content } }))
    await tick()
    expect(document.querySelector('iframe')).toBeTruthy()
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

  it.each([
    { kind: 'spreadsheet', extension: 'csv', currentContent: 'name,value\nalpha,1', probe: '.csv-editor-probe' },
    { kind: 'html', extension: 'html', currentContent: '<h1>Report</h1>', probe: '.html-preview-probe' },
    { kind: 'mdx', extension: 'mdx', currentContent: 'import Chart from "./Chart"\n\n<Chart />', probe: '.rich-editor-probe', readOnly: 'true' },
    { kind: 'code', extension: 'json', currentContent: '{"name":"sample"}', probe: '.rich-editor-probe', language: 'json' },
    { kind: 'base', extension: 'base', currentContent: 'views: []', probe: '.base-editor-probe' },
  ] as const)('routes $extension through a generic view and restores its original built-in editor after fallback', async (sample) => {
    const store = await setup({ kind: sample.kind, language: 'json', filePath: `/vault/sample.${sample.extension}`, currentContent: sample.currentContent }, [
      { id: 'generic-preview', entry: 'generic.html', selectors: [{ file_extensions: [sample.extension] }] },
    ], 'example.file-preview')
    const frame = document.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('plugin://example.file-preview/generic.html')
    const sent = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    frame.dispatchEvent(new Event('load'))
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'file_view.open', viewId: 'generic-preview', content: sample.currentContent }), 'plugin://example.file-preview')
    window.dispatchEvent(new MessageEvent('message', { origin: 'plugin://example.file-preview', source: frame.contentWindow, data: { type: 'file_view.fallback', requestId: 1 } }))
    await tick()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector(sample.probe)?.textContent).toBe(sample.currentContent)
    if ('readOnly' in sample) expect(document.querySelector<HTMLElement>(sample.probe)?.dataset.readOnly).toBe(sample.readOnly)
    if ('language' in sample) expect(document.querySelector<HTMLElement>(sample.probe)?.dataset.language).toBe(sample.language)
    store.update((tab) => ({ ...tab, mode: 'source' })); await tick()
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('.source-editor-probe')?.value).toBe(sample.currentContent)
    store.update((tab) => ({ ...tab, mode: 'rich' })); await tick()
    expect(document.querySelector('iframe')).toBeTruthy()
  })

  it('preserves Outline fallback and never replaces extension-owned custom editors', async () => {
    await setup({ filePath: '/vault/day.note.md' })
    const frame = document.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', { origin: 'plugin://notemd.timeline', source: frame.contentWindow, data: { type: 'file_view.fallback', requestId: 1 } }))
    await tick()
    expect(document.querySelector('.outline-editor-probe')).toBeTruthy()
    await unmount(component!); component = undefined
    await setup({ kind: 'custom', filePath: '/vault/day.widget' }, [{ id: 'generic', entry: 'index.html', selectors: [{ file_extensions: ['widget'] }] }])
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('.custom-editor-probe')).toBeTruthy()
  })
})
