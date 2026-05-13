import { Slice, Fragment } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'

/** Insert an image node at the cursor position. */
export function insertImageAtCursor(view: EditorView, src: string): void {
  const node = view.state.schema.nodes.image.create({ src, alt: '' })
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
}

/** Insert an image node at a specific ProseMirror position. */
export function insertImageAtPos(view: EditorView, src: string, pos: number): void {
  const node = view.state.schema.nodes.image.create({ src, alt: '' })
  view.dispatch(view.state.tr.insert(pos, node).scrollIntoView())
}

/**
 * Insert a markdown link [filename](href) at pos or cursor.
 * Uses the link mark from the ProseMirror schema.
 */
export function insertAttachmentLink(
  view: EditorView,
  href: string,
  pos?: number,
): void {
  const filename = href.replace(/[?#].*$/, '').replace(/^.*[/\\]/, '') || href
  const { schema } = view.state
  const linkMark = schema.marks.link.create({ href, title: null })
  const textNode = schema.text(filename, [linkMark])
  const slice = new Slice(Fragment.from(textNode), 0, 0)
  const tr = pos !== undefined
    ? view.state.tr.insert(pos, textNode)
    : view.state.tr.replaceSelection(slice)
  view.dispatch(tr.scrollIntoView())
}
