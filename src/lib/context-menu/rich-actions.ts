import type { EditorView } from 'prosemirror-view'
import { toggleMark } from 'prosemirror-commands'
import { TextSelection } from 'prosemirror-state'
import type { EditorActions } from './EditorContextMenu.svelte'
import {
  setBlock, wrapBlock, wrapList, insertAtom, insertTable, insertTaskList,
} from './block-helpers'

const MARK_BY_ID: Record<string, string> = {
  bold: 'strong', italic: 'em', highlight: 'highlight', strike: 'strike_through', code: 'code',
}

/** Select the word under the cursor if the selection is empty, so mark toggles have a target. */
function ensureSelection(view: EditorView) {
  const { selection, doc } = view.state
  if (!selection.empty) return
  const $pos = selection.$from
  const text = $pos.parent.textContent
  const offset = $pos.parentOffset
  const isWord = (c: string) => /[\w一-龥]/.test(c)
  let s = offset, e = offset
  while (s > 0 && isWord(text[s - 1])) s--
  while (e < text.length && isWord(text[e])) e++
  if (e === s) return
  const base = $pos.pos - offset
  view.dispatch(view.state.tr.setSelection(
    TextSelection.create(doc, base + s, base + e)))
}

function toggle(view: EditorView, markName: string) {
  const mark = view.state.schema.marks[markName]
  if (!mark) return
  ensureSelection(view)
  toggleMark(mark)(view.state, view.dispatch)
  view.focus()
}

/** Wrap the selected text (or current word) in [[ ]] as literal text. */
function wrapWikilink(view: EditorView) {
  ensureSelection(view)
  const { from, to } = view.state.selection
  const text = view.state.doc.textBetween(from, to) || ''
  const tr = view.state.tr.insertText(`[[${text}]]`, from, to)
  const caret = text ? from + text.length + 4 : from + 2
  tr.setSelection(TextSelection.create(tr.doc, caret))
  view.dispatch(tr)
  view.focus()
}

function toggleLink(view: EditorView) {
  const linkMark = view.state.schema.marks.link
  if (!linkMark) return
  const { from, to } = view.state.selection
  if (from === to) return
  toggleMark(linkMark, { href: '' })(view.state, view.dispatch)
  view.focus()
}

function insertDate(view: EditorView) {
  const d = new Date().toISOString().slice(0, 10)
  view.dispatch(view.state.tr.insertText(d).scrollIntoView())
  view.focus()
}

export function createRichActions(view: EditorView): EditorActions {
  return {
    canRun(id) {
      if (id === 'link') return !view.state.selection.empty
      return true
    },
    async run(id) {
      if (id in MARK_BY_ID) return toggle(view, MARK_BY_ID[id])
      switch (id) {
        case 'cut':       document.execCommand('cut'); return
        case 'copy':      document.execCommand('copy'); return
        case 'paste':     document.execCommand('paste'); return
        case 'selectAll': {
          const { doc } = view.state
          view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 0, doc.content.size)))
          view.focus(); return
        }
        case 'wikilink':  return wrapWikilink(view)
        case 'link':      return toggleLink(view)
        case 'h1':        return setBlock(view, 'heading', { level: 1 })
        case 'h2':        return setBlock(view, 'heading', { level: 2 })
        case 'h3':        return setBlock(view, 'heading', { level: 3 })
        case 'quote':     return wrapBlock(view, 'blockquote')
        case 'codeblock': return setBlock(view, 'code_block', { language: '' })
        case 'bullet':    return wrapList(view, 'bullet_list')
        case 'ordered':   return wrapList(view, 'ordered_list')
        case 'task':      return insertTaskList(view)
        case 'hr':        return insertAtom(view, 'horizontal_rule')
        case 'table':     return insertTable(view)
        case 'math':      return insertAtom(view, 'math_block', { value: '' })
        case 'mermaid':   return setBlock(view, 'code_block', { language: 'mermaid' })
        case 'date':      return insertDate(view)
        case 'image': {
          const { open } = await import('@tauri-apps/plugin-dialog')
          const result = await open({ multiple: false,
            filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','svg','webp','bmp','avif'] }] })
          if (typeof result !== 'string') return
          const { insertImageAtCursor } = await import('../attachment-insert')
          insertImageAtCursor(view, result)
          return
        }
      }
    },
  }
}
