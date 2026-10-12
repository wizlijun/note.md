// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import { schema } from 'prosemirror-schema-basic'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import RichEditor from './RichEditor.svelte'
import type { Tab } from '../lib/tabs.svelte'

const h = vi.hoisted(() => ({
  view: null as EditorView | null,
  openFile: vi.fn(),
  openUrl: vi.fn(),
}))

const destinations = [
  ['§1 法条速查', '#1-先读法条速查人话版', '1. 先读:法条速查(人话版)'],
  ['§2 三条红线', '#2-三条跨角色红线', '2. 三条跨角色红线'],
  ['§7 第一周冲刺', '#7-第一周联合冲刺', '7. 第一周联合冲刺'],
  ['三类说话人', '#4-三类说话人--三条关联路径', '4. 三类说话人 × 三条关联路径'],
  ['判例对照', '#71-判例对照赢在哪输在哪', '7.1 判例对照：赢在哪、输在哪'],
] as const

vi.mock('../lib/editor-bridge', () => ({
  updateDocumentBaseDir: vi.fn(),
  mountRichEditor: vi.fn(async (host: HTMLElement, markdown: string) => {
    const links = destinations.flatMap(([label, href], index) => [
      ...(index ? [schema.text(' → ')] : []),
      schema.text(label, [schema.marks.link.create({ href })]),
    ])
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, links),
      ...destinations.map(([, , title]) => schema.nodes.heading.create({ level: 2 }, schema.text(title))),
    ])
    const view = new EditorView(host, { state: EditorState.create({ schema, doc }) })
    h.view = view
    return { view, getMarkdown: () => markdown, setContent: vi.fn(), destroy: () => view.destroy() }
  }),
}))
vi.mock('../lib/tabs.svelte', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tabs.svelte')>(),
  activeTab: () => null,
  setContent: vi.fn(),
  openFile: h.openFile,
}))
vi.mock('../lib/note-anno/answers-store.svelte', () => ({
  answersStore: { version: 0 }, loadAnswersFor: vi.fn(), answeredMap: () => new Map(),
}))
vi.mock('../lib/outline/gate.svelte', () => ({ outlineGate: { enabled: false } }))
vi.mock('../lib/mdblock-hover/hover-store.svelte', () => ({
  hoverStore: { version: 0 }, getDisplayYaml: () => null,
  loadHoverYaml: vi.fn(), recomputeLiveYaml: vi.fn(), isHoverActive: () => false,
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => vi.fn() }),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: h.openUrl, openPath: vi.fn() }))

describe('RichEditor document anchor clicks', () => {
  let component: ReturnType<typeof mount> | null = null

  afterEach(async () => {
    if (component) await unmount(component)
    component = null
    h.view = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  async function mountEditor() {
    component = mount(RichEditor, {
      target: document.body,
      props: { tab: {
        id: 'anchor-regression', filePath: '/vault/anchors.md',
        currentContent: destinations.map(([label, href]) => `[${label}](${href})`).join(' → '),
      } as Tab },
    })
    // The capture listener is installed after the editor's auxiliary plugins.
    await vi.waitFor(() => expect(h.view?.state.plugins.length).toBeGreaterThan(0))
    return Array.from(document.querySelectorAll<HTMLAnchorElement>('.ProseMirror a'))
  }

  it.each([0, 1, 2, 3, 4])('follows reported Chinese heading anchor %i on plain mousedown', async (index) => {
    const links = await mountEditor()
    const headings = Array.from(document.querySelectorAll('.ProseMirror h2'))
    const scroll = vi.spyOn(headings[index], 'scrollIntoView').mockImplementation(() => {})
    links[index].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    await vi.waitFor(() => expect(scroll).toHaveBeenCalledOnce())
    expect(h.openUrl).not.toHaveBeenCalled()
    expect(h.openFile).not.toHaveBeenCalled()
  })

  it('decodes a percent-encoded Chinese fragment before matching a heading', async () => {
    const [link] = await mountEditor()
    link.setAttribute('href', '#' + encodeURIComponent(destinations[0][1].slice(1)))
    const heading = document.querySelector('.ProseMirror h2')!
    const scroll = vi.spyOn(heading, 'scrollIntoView').mockImplementation(() => {})
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    await vi.waitFor(() => expect(scroll).toHaveBeenCalledOnce())
  })

  it.each(['metaKey', 'ctrlKey'] as const)('keeps %s + click available for editing', async (modifier) => {
    const [link] = await mountEditor()
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const caret = vi.spyOn(h.view!, 'posAtCoords').mockReturnValue({ pos: 1, inside: 0 })
    const dispatch = vi.spyOn(h.view!, 'dispatch')
    link.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, [modifier]: true,
    }))
    await vi.waitFor(() => expect(caret).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled())
    expect(scroll).not.toHaveBeenCalled()
    expect(h.openUrl).not.toHaveBeenCalled()
  })

  it('continues to open external URLs through the system browser', async () => {
    const [link] = await mountEditor()
    link.setAttribute('href', 'https://example.com/page#section')
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    await vi.waitFor(() => expect(h.openUrl).toHaveBeenCalledWith('https://example.com/page#section'))
    expect(scroll).not.toHaveBeenCalled()
    expect(h.openFile).not.toHaveBeenCalled()
  })

  it('continues to open sibling Markdown files in an editor tab', async () => {
    const [link] = await mountEditor()
    link.setAttribute('href', 'sibling.md')
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    await vi.waitFor(() => expect(h.openFile).toHaveBeenCalledWith('/vault/sibling.md'))
    expect(scroll).not.toHaveBeenCalled()
    expect(h.openUrl).not.toHaveBeenCalled()
  })
})
