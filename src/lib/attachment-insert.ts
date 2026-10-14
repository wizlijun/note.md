import { Slice, Fragment } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'

/** Native filesystem paths are encoded once before creating the image node.
 * Unicode and Windows separators follow the core parser's source attrs; URL
 * inputs from HTML/Markdown paste already have their own parser path. */
export function imageSourceForNativePath(path: string): string {
  const drive = /^[A-Za-z]:[\\/]/.test(path)
  return path.replace(/[\u0000-\u007f]/g, (char, index: number) =>
    char === '/' || char === '\\' || drive && index === 1 ? char : encodeURIComponent(char))
}

/** Insert an image from a native filesystem path at the cursor position. */
export function insertImageAtCursor(view: EditorView, path: string): void {
  const node = view.state.schema.nodes.image.create({ src: imageSourceForNativePath(path), alt: '' })
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
}

/** Insert an image from a native filesystem path at a specific position. */
export function insertImageAtPos(view: EditorView, path: string, pos: number): void {
  const node = view.state.schema.nodes.image.create({ src: imageSourceForNativePath(path), alt: '' })
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
