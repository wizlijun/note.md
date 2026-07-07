import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'

const wikilinkKey = new PluginKey<DecorationSet>('wikilink')

/**
 * Matches an Obsidian-style wikilink `[[target]]` (optionally `[[target|alias]]`).
 * The brackets are intentionally part of the match: we decorate the whole
 * `[[…]]` span so the symbols stay visible but read as a link.
 */
export const WIKILINK_RE = /\[\[([^[\]\n]+?)\]\]/g

/** Build the inline decorations for every `[[wikilink]]` in the document. */
function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
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
  })
  return DecorationSet.create(doc, decos)
}

/**
 * ProseMirror plugin that renders `[[wikilinks]]` with link styling while
 * leaving the document text (including the `[[ ]]` brackets) untouched. The
 * decoration exposes `data-wikilink` so the click handler in RichEditor can
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
    },
  })
}
