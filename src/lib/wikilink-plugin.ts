import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { toggleMark } from 'prosemirror-commands'

const wikilinkKey = new PluginKey<DecorationSet>('wikilink')

/**
 * Doubled markdown emphasis markers → the schema mark they toggle when the user
 * types the *second* marker char. In rich (WYSIWYG) mode we can't insert a
 * literal `**` — moraya's serializer escapes it to `\*\*` and it never formats —
 * so instead we toggle the formatting mark and leave the caret "inside" it
 * (empty selection → stored mark), which is the intent of "auto-complete + caret
 * in the middle".
 */
const EMPHASIS_MARK: Record<string, { name: string; attrs?: Record<string, unknown> }> = {
  '*': { name: 'strong' },
  '_': { name: 'strong' },
  '~': { name: 'strike_through' },
  '^': { name: 'highlight', attrs: { delimiter: 'caret' } },
  '=': { name: 'highlight', attrs: { delimiter: 'equals' } },
}

/**
 * Matches an Obsidian-style wikilink `[[target]]` (optionally `[[target|alias]]`).
 * The brackets are intentionally part of the match: we decorate the whole
 * `[[…]]` span so the symbols stay visible but read as a link.
 */
export const WIKILINK_RE = /\[\[([^[\]\n]+?)\]\]/g

/**
 * Matches a bare `http(s)://…` URL in plain text. The character class stops at
 * whitespace and the bracket/quote/paren pairs that commonly surround a URL,
 * so an inline `(https://x.com)` doesn't swallow the closing `)`. Trailing
 * sentence punctuation is trimmed separately by {@link matchUrl}.
 */
export const URL_RE = /https?:\/\/[^\s<>()[\]{}"']+/g
const TRAILING_PUNCT_RE = /[.,;:!?]+$/

/** Normalise a raw URL match by dropping trailing sentence punctuation. */
export function matchUrl(raw: string): string {
  return raw.replace(TRAILING_PUNCT_RE, '')
}

/**
 * Build the inline decorations for every `[[wikilink]]` and every bare
 * `http(s)://` URL in the document. URLs inside inline code, code blocks, or an
 * existing link mark are skipped (those are either literal or already anchors).
 */
function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return
    const text = node.text

    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(text)) !== null) {
      const from = pos + m.index
      const to = from + m[0].length
      const target = m[1].split('|')[0].trim()
      if (!target) continue
      decos.push(
        Decoration.inline(from, to, {
          nodeName: 'span',
          class: 'wikilink',
          'data-wikilink': target,
        }),
      )
    }

    const inCode =
      parent?.type.name === 'code_block' ||
      node.marks.some((mk) => mk.type.name === 'code' || mk.type.name === 'link')
    if (inCode) return

    URL_RE.lastIndex = 0
    while ((m = URL_RE.exec(text)) !== null) {
      const url = matchUrl(m[0])
      if (!url) continue
      const from = pos + m.index
      const to = from + url.length
      decos.push(
        Decoration.inline(from, to, {
          nodeName: 'span',
          class: 'url-autolink',
          'data-url': url,
        }),
      )
    }
  })
  return DecorationSet.create(doc, decos)
}

/**
 * ProseMirror plugin that renders `[[wikilinks]]` and bare `http(s)://` URLs
 * with link styling while leaving the document text untouched. The decorations
 * expose `data-wikilink` / `data-url` so the click handler in RichEditor can
 * resolve and open the target. Recomputes only when the doc changes.
 */
export function wikilinkPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: wikilinkKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc),
      apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
    },
    props: {
      decorations(state): DecorationSet | undefined {
        return wikilinkKey.getState(state)
      },
      handleTextInput(view: EditorView, from: number, to: number, text: string): boolean {
        // `[[` → `[[]]`, caret between the brackets (literal wikilink).
        if (text === '[') {
          const before = view.state.doc.textBetween(Math.max(0, from - 2), from)
          if (!before.endsWith('[') || before.endsWith('[[')) return false
          const tr = view.state.tr.insertText('[]]', from, to)
          tr.setSelection(TextSelection.create(tr.doc, from + 1))
          view.dispatch(tr)
          return true
        }

        // Single backtick → toggle inline code (empty selection → stored mark).
        if (text === '`') {
          const prev = view.state.doc.textBetween(Math.max(0, from - 1), from)
          const codeType = view.state.schema.marks.code
          if (prev !== '`' && codeType && toggleMark(codeType)(view.state)) {
            toggleMark(codeType)(view.state, view.dispatch)
            return true
          }
          return false
        }

        // Doubled emphasis markers (** __ ^^ ~~ ==) → toggle the mark on the
        // second marker char. Remove the first (already-typed) marker char and
        // don't insert the second, so no literal `*` is left behind.
        const em = EMPHASIS_MARK[text]
        if (em) {
          const before = view.state.doc.textBetween(Math.max(0, from - 2), from)
          if (!before.endsWith(text) || before.endsWith(text + text)) return false
          const markType = view.state.schema.marks[em.name]
          const attrs = em.attrs ?? null
          if (markType && toggleMark(markType, attrs)(view.state)) {
            view.dispatch(view.state.tr.delete(from - 1, from))
            toggleMark(markType, attrs)(view.state, view.dispatch)
            return true
          }
        }
        return false
      },
    },
  })
}
