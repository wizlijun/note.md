/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditor, createSourceSession, parseMarkdown, type MorayaEditorInstance } from '@moraya/core'
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { AllSelection, EditorState, NodeSelection, Selection, TextSelection } from 'prosemirror-state'
import { history, redo, undo, undoDepth } from 'prosemirror-history'
import { applySelectAll } from './editor-select-all'
import { hiddenFrontmatterSelectionPlugin } from './hidden-frontmatter-selection'

const metadata = '---\ntitle: t # retain\n---\n'
const editors: MorayaEditorInstance[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren() })

async function mount(raw: string, ensureBody?: (view: MorayaEditorInstance['view']) => void) {
  const container = document.createElement('div'); document.body.append(container)
  const editor = await createEditor({
    container, initialContent: raw, mediaResolver: new BrowserMediaResolver(),
    enableMath: false, enableMermaid: false, enableHistory: true,
    frontmatterViewFactory: { render(element) { element.hidden = true; return { destroy() {} } } },
    createState(schema, plugins) {
      const source = createSourceSession(raw, schema)
      if (!source.ok) throw new Error(source.reason)
      return EditorState.create({ schema, doc: source.session.doc, plugins: [...plugins, hiddenFrontmatterSelectionPlugin({ ensureBody })] })
    },
  })
  editors.push(editor)
  await Promise.resolve()
  return editor.view
}

function press(view: MorayaEditorInstance['view'], key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  view.dom.dispatchEvent(event)
  return event
}

describe('hidden metadata selection', () => {
  it('initializes at the body without changing the document or history', async () => {
    const view = await mount(metadata + '\n正文\n')
    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(view.state.doc.eq(parseMarkdown(metadata + '\n正文\n', view.state.schema))).toBe(true)
    expect(undoDepth(view.state)).toBe(0)
  })

  it.each(['正文\n', '\n', '# Heading\n', '```txt\ntext\n```\n'])('Backspace at the first body boundary preserves metadata: %j', async body => {
    const view = await mount(metadata + '\n' + body), original = view.state.doc
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.firstChild!.nodeSize + 1)))
    expect(press(view, 'Backspace').defaultPrevented).toBe(true)
    expect(press(view, 'Backspace').defaultPrevented).toBe(true)
    expect(view.state.doc.eq(original)).toBe(true)
    expect(view.state.selection.$from.parent.type.name).not.toBe('frontmatter')
  })

  it('allows first list item Backspace to lift the list without touching metadata', async () => {
    const view = await mount(metadata + '\n- Item\n'), frontmatter = view.state.doc.firstChild!
    expect(view.state.selection.$from.depth).toBeGreaterThan(1)
    press(view, 'Backspace')
    expect(view.state.doc.firstChild!.eq(frontmatter)).toBe(true)
    expect(view.state.doc.child(1).type.name).toBe('paragraph')
    expect(view.state.doc.child(1).textContent).toBe('Item')
  })

  it('clamps metadata node/text selections and preserves the selected body range direction', async () => {
    const view = await mount(metadata + '\n正文\n'), body = view.state.selection.from
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)))
    expect(view.state.selection.from).toBe(body)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    expect(view.state.selection.from).toBe(body)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, body + 2, 2)))
    expect(view.state.selection.anchor).toBe(body + 2)
    expect(view.state.selection.head).toBe(body)
    expect(view.state.selection.content().content.textBetween(0, view.state.selection.content().content.size)).toBe('正文')
  })

  it('native AllSelection deletes only the visible body and supports undo/redo', async () => {
    const view = await mount(metadata + '\n正文\n'), original = view.state.doc
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))
    expect(view.state.selection.from).toBeGreaterThanOrEqual(original.firstChild!.nodeSize)
    press(view, 'Backspace')
    expect(view.state.doc.firstChild!.eq(original.firstChild!)).toBe(true)
    expect(view.state.doc.lastChild!.textContent).toBe('')
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.eq(original)).toBe(true)
    expect(redo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.firstChild!.eq(original.firstChild!)).toBe(true)
  })

  it('metadata-only selections copy nothing and cannot delete metadata', async () => {
    const view = await mount(metadata), original = view.state.doc
    expect(view.state.selection.empty).toBe(true)
    expect(view.state.selection.from).toBe(original.content.size)
    expect(view.state.selection.visible).toBe(false)
    expect(view.state.selection.content().size).toBe(0)
    applySelectAll(view)
    press(view, 'Backspace'); press(view, 'Delete')
    view.dispatch(view.state.tr.deleteSelection())
    expect(view.state.doc.eq(original)).toBe(true)
    expect(undoDepth(view.state)).toBe(0)
    expect(Selection.fromJSON(original, view.state.selection.toJSON()).eq(view.state.selection)).toBe(true)
    expect(view.state.selection.getBookmark().resolve(original).eq(view.state.selection)).toBe(true)
  })

  it('requests a body only on editable focus, never at mount', async () => {
    const ensureBody = vi.fn(), view = await mount(metadata, ensureBody)
    expect(ensureBody).not.toHaveBeenCalled()
    view.dom.dispatchEvent(new FocusEvent('focus'))
    expect(ensureBody).toHaveBeenCalledOnce()
    view.setProps({ editable: () => false })
    view.dom.dispatchEvent(new FocusEvent('focus'))
    expect(ensureBody).toHaveBeenCalledOnce()
    expect(view.state.doc.eq(parseMarkdown(metadata, view.state.schema))).toBe(true)
  })

  it('allows source replacement and retains safe selections through history and reconfiguration', () => {
    const doc = parseMarkdown(metadata), plugins = [history(), hiddenFrontmatterSelectionPlugin()]
    let state = EditorState.create({ doc, plugins })
    state = state.applyTransaction(state.tr).state
    const original = state.doc
    const dispatch = (tr: typeof state.tr) => { state = state.applyTransaction(tr).state }
    dispatch(state.tr.insertText('new ', 1))
    expect(state.doc.firstChild!.textContent).toContain('new title:')
    expect(state.selection.from).toBe(state.doc.content.size)
    expect(undo(state, dispatch)).toBe(true)
    expect(state.doc.eq(original)).toBe(true)
    expect(state.selection.empty).toBe(true)
    expect(redo(state, dispatch)).toBe(true)
    state = state.reconfigure({ plugins: [plugins[0], hiddenFrontmatterSelectionPlugin()] })
    expect(state.selection.from).toBe(state.doc.content.size)
    dispatch(state.tr.replaceWith(0, state.doc.content.size, parseMarkdown('正文').content))
    expect(state.doc.textContent).toBe('正文')
    expect(state.selection.$from.parent.type.name).toBe('paragraph')
  })

  it('does not intercept IME Backspace', async () => {
    const view = await mount(metadata + '\n正文\n')
    const event = new KeyboardEvent('keydown', { key: 'Backspace', isComposing: true, cancelable: true })
    const plugin = view.state.plugins.find(p => p.spec.key === hiddenFrontmatterSelectionPlugin().spec.key)!
    expect(plugin.props.handleDOMEvents!.keydown!.call(plugin, view, event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })
})
