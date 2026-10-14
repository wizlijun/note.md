import { gfmTableCommand } from '@moraya/core/commands'
import type { EditorView } from 'prosemirror-view'
import { toggleMark } from 'prosemirror-commands'
import { TextSelection } from 'prosemirror-state'
import type { EditorActions } from './EditorContextMenu.svelte'
import { applySelectAll } from '../editor-select-all'
import {
  setBlock, wrapBlock, wrapList, insertAtom, insertTable, insertTaskList,
} from './block-helpers'

const MARK_BY_ID: Record<string, string> = {
  bold: 'strong', italic: 'em', highlight: 'highlight', strike: 'strike_through', code: 'code',
}

/** Select the word under the cursor if the selection is empty, so mark toggles have a target. */
export function ensureSelection(view: EditorView) {
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

/**
 * Paste clipboard text at the current selection. `execCommand('paste')` is
 * blocked in Tauri's WKWebView, so read the clipboard directly and insert.
 * (Only text — native Cmd+V still routes through the rich paste handler for
 * images/URLs.)
 */
async function pasteText(view: EditorView) {
  try {
    const text = await navigator.clipboard.readText()
    if (!text) return
    view.dispatch(view.state.tr.insertText(text).scrollIntoView())
    view.focus()
  } catch { /* clipboard permission denied */ }
}

export function createRichActions(
  view: EditorView,
  opts: {
    imageEl?: HTMLImageElement
    copyImage?(image: HTMLImageElement): Promise<void>
    insertImage?(): Promise<void>
    trace?(text: string): Promise<void>
    insertNote?(seed: string): void
  } = {},
): EditorActions {
  return {
    canRun(id) {
      switch (id) {
        case 'table-align-left': return gfmTableCommand({ kind: 'align-column', alignment: 'left' })(view.state)
        case 'table-align-center': return gfmTableCommand({ kind: 'align-column', alignment: 'center' })(view.state)
        case 'table-align-right': return gfmTableCommand({ kind: 'align-column', alignment: 'right' })(view.state)
      }
      if (id === 'link') return !view.state.selection.empty
      if (id === 'copyImage') return !!opts.imageEl && !!opts.copyImage
      if (id === 'image') return !!opts.insertImage
      if (id === 'trace') return !!opts.trace
      return true
    },
    async run(id): Promise<void> {
      if (id in MARK_BY_ID) return toggle(view, MARK_BY_ID[id])
      switch (id) {
        case 'table-align-left': gfmTableCommand({ kind: 'align-column', alignment: 'left' })(view.state, view.dispatch); view.focus(); return
        case 'table-align-center': gfmTableCommand({ kind: 'align-column', alignment: 'center' })(view.state, view.dispatch); view.focus(); return
        case 'table-align-right': gfmTableCommand({ kind: 'align-column', alignment: 'right' })(view.state, view.dispatch); view.focus(); return
        case 'cut':       view.focus(); document.execCommand('cut'); return
        case 'copy':      view.focus(); document.execCommand('copy'); return
        case 'paste':     return pasteText(view)
        case 'copyImage': {
          if (!opts.imageEl) return
          try { await opts.copyImage?.(opts.imageEl) }
          catch (e) { console.error('copy image failed', e) }
          return
        }
        case 'selectAll': applySelectAll(view); return
        case 'wikilink':  return wrapWikilink(view)
        case 'note': {
          if (opts.insertNote) { opts.insertNote(''); return }
          const { insertNoteRich } = await import('../note-anno/note-commands')
          insertNoteRich(view); return
        }
        case 'question': {
          if (opts.insertNote) { opts.insertNote('?'); return }
          // Same annotation, seeded with `?` — that's what makes it a question
          // to the agent (isQuestionText); the popup caret lands before it.
          const { insertNoteRich } = await import('../note-anno/note-commands')
          insertNoteRich(view, '?'); return
        }
        case 'trace': {
          const { from, to } = view.state.selection
          const text = view.state.doc.textBetween(from, to, '\n')
          if (!text.trim()) return
          return opts.trace?.(text)
        }
        case 'link':      return toggleLink(view)
        case 'h1':        setBlock(view, 'heading', { level: 1 }); return
        case 'h2':        setBlock(view, 'heading', { level: 2 }); return
        case 'h3':        setBlock(view, 'heading', { level: 3 }); return
        case 'quote':     wrapBlock(view, 'blockquote'); return
        case 'codeblock': setBlock(view, 'code_block', { language: '' }); return
        case 'bullet':    wrapList(view, 'bullet_list'); return
        case 'ordered':   wrapList(view, 'ordered_list'); return
        case 'task':      insertTaskList(view); return
        case 'hr':        insertAtom(view, 'horizontal_rule'); return
        case 'table':     insertTable(view); return
        case 'math':      insertAtom(view, 'math_block', { value: '' }); return
        case 'mermaid':   setBlock(view, 'code_block', { language: 'mermaid' }); return
        case 'date':      return insertDate(view)
        case 'image': {
          return opts.insertImage?.()
        }
      }
    },
  }
}
