import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'

const noteBadgeKey = new PluginKey<DecorationSet>('note-badges')

/**
 * Append a badge widget after each contiguous annotation-mark range.
 * note_anchor nodes render their own badge via toDOM, so they're skipped.
 */
function buildBadges(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'annotation')
    if (!mark) return
    const end = pos + node.nodeSize
    // Badge only the last node of the run: skip if the next inline node
    // continues the same annotation.
    const $end = doc.resolve(end)
    const after = $end.nodeAfter
    if (after && mark.isInSet(after.marks)) return
    const note = mark.attrs.note as string
    decos.push(
      Decoration.widget(end, () => {
        const el = document.createElement('span')
        el.className = 'note-badge'
        el.dataset.note = note
        el.contentEditable = 'false'
        return el
      }, { side: 1, key: `note-badge-${end}-${note}` }),
    )
  })
  return DecorationSet.create(doc, decos)
}

export function noteBadgePlugin(): Plugin<DecorationSet> {
  return new Plugin({
    key: noteBadgeKey,
    state: {
      init: (_config, { doc }) => buildBadges(doc),
      apply: (tr, old) => (tr.docChanged ? buildBadges(tr.doc) : old),
    },
    props: {
      decorations(state) { return noteBadgeKey.getState(state) },
    },
  })
}
