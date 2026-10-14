import { mount, unmount } from 'svelte'
import type { EditorView } from 'prosemirror-view'
import EditorContextMenu, { type EditorActions } from '../lib/context-menu/EditorContextMenu.svelte'
import { createRichActions, ensureSelection } from '../lib/context-menu/rich-actions'
import type { EditorCommand } from './contract'
import type { FileEditorOwner, FileSnapshot } from './file-contract'
import { noteUi } from '../lib/note-anno/note-ui.svelte'

const commands: Record<string, EditorCommand> = {
  bold: { kind: 'bold' }, italic: { kind: 'italic' }, strike: { kind: 'strikethrough' }, code: { kind: 'code' }, highlight: { kind: 'highlight' },
  h1: { kind: 'heading', level: 1 }, h2: { kind: 'heading', level: 2 }, h3: { kind: 'heading', level: 3 },
  quote: { kind: 'blockquote' }, codeblock: { kind: 'code-block' }, bullet: { kind: 'bullet-list' }, ordered: { kind: 'ordered-list' }, task: { kind: 'task-list' },
  hr: { kind: 'horizontal-rule' }, table: { kind: 'table' },
  'table-align-left': { kind: 'table.align-column', alignment: 'left' },
  'table-align-center': { kind: 'table.align-column', alignment: 'center' },
  'table-align-right': { kind: 'table.align-column', alignment: 'right' },
}

/** The shared Rich menu uses the same file owner and captures its editing target. */
export function createFileContextMenu(input: {
  view: EditorView; owner: FileEditorOwner
  available(): boolean; insertNote(seed: string): boolean; notify?(text: string): void
}) {
  const { view, owner } = input
  let popup: ReturnType<typeof mount> | undefined, target: HTMLElement | undefined, epoch = 0, destroyed = false
  type Capture = { snapshot: FileSnapshot; from: number; to: number; epoch: number }
  let active: Capture | undefined
  const capture = (): Capture => ({ snapshot: owner.snapshot(), from: view.state.selection.from, to: view.state.selection.to, epoch })
  function current(value: Capture) {
    const now = owner.snapshot()
    return !destroyed && value.epoch === epoch && input.available()
      && now.authority === value.snapshot.authority && now.sourceLineage === value.snapshot.sourceLineage && now.generation === value.snapshot.generation
      && view.state.selection.from === value.from && view.state.selection.to === value.to
  }
  function removePopup() { if (popup) { void unmount(popup); popup = undefined }; target?.remove(); target = undefined; active = undefined }
  function close() { epoch++; removePopup() }
  async function writeClipboard(value: Capture) {
    const text = view.state.doc.textBetween(value.from, value.to, '\n')
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
    else { view.focus(); if (!document.execCommand?.('copy')) throw Error('clipboard-unavailable') }
  }
  function open(event: MouseEvent) {
    if (!input.available()) return
    // The browser's image menu retains native copy/save without desktop APIs.
    if ((event.target as HTMLElement).closest('img')) return
    event.preventDefault(); close(); noteUi.hover = null
    // Restore the editor selection before the popup receives focus; native
    // right-click selection changes must not invalidate every menu action.
    view.focus()
    const captured = capture(); active = captured
    const legacy = createRichActions(view, { insertNote: seed => { if (current(captured)) input.insertNote(seed) } })
    const actions: EditorActions = {
      canRun(id) {
        if (!current(captured)) return false
        if (id === 'cut' || id === 'copy') return !view.state.selection.empty && (!!navigator.clipboard?.writeText || typeof document.execCommand === 'function')
        if (id === 'paste') return !!navigator.clipboard?.readText
        if (commands[id]) return owner.canExecute(commands[id])
        return legacy.canRun(id)
      },
      async run(id) {
        if (!current(captured)) return
        if (id === 'copy' || id === 'cut') {
          try {
            await writeClipboard(captured)
            if (id === 'cut' && current(captured)) { view.dispatch(view.state.tr.deleteSelection().scrollIntoView()); view.focus() }
          } catch { input.notify?.('剪贴板访问失败，请使用系统复制或剪切快捷键') }
          return
        }
        if (id === 'paste') {
          try {
            const text = await navigator.clipboard.readText()
            if (text && current(captured)) { view.dispatch(view.state.tr.insertText(text).scrollIntoView()); view.focus() }
          } catch { input.notify?.('无法读取剪贴板，请使用键盘粘贴（Ctrl/⌘+V）') }
          return
        }
        if (commands[id]) {
          if (['bold', 'italic', 'strike', 'code', 'highlight'].includes(id)) ensureSelection(view)
          owner.execute(commands[id]); view.focus(); return
        }
        await legacy.run(id)
      },
    }
    target = document.createElement('div'); document.body.append(target)
    popup = mount(EditorContextMenu, { target, props: { position: { x: event.clientX, y: event.clientY }, hasSelection: !view.state.selection.empty, actions, allowImageInsert: false,
      // Choosing closes the UI before executing; lifecycle close() separately invalidates pending work.
      onClose: removePopup,
    } })
  }
  const unsubscribe = owner.observe(() => { if (active && !current(active)) close() })
  view.dom.addEventListener('contextmenu', open)
  view.dom.addEventListener('compositionstart', close)
  return { close, destroy() { destroyed = true; close(); unsubscribe(); view.dom.removeEventListener('contextmenu', open); view.dom.removeEventListener('compositionstart', close) } }
}
