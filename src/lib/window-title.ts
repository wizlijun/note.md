import { basename, dirname } from './paths'
import { frontmatterValues } from './plugins/file-views'

/** The marker shown on a document that lives OUTSIDE the vault but has a vault
 *  mirror. Opening the mirror redirects to the source (`tabs.svelte.ts`), so the
 *  file under the cursor is always the source — this says so. */
export const SYNC_MARK = '↔'

interface DisplayTitleDocument {
  filePath: string
  title: string
  currentContent: string
}

/** Display-only title for a document. `tab.title` remains the real filename. */
export function displayTitleForDocument(document: DisplayTitleDocument): string {
  const filename = basename(document.filePath).toLowerCase()
  if (!filename.endsWith('.typeset.md')) return document.title
  const metadataTitle = frontmatterValues(document.currentContent)?.get('title')
  if (typeof metadataTitle === 'string') {
    const title = metadataTitle.trim()
    if (title && [...title].length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(title)) return title
  }
  if (filename === 'book.typeset.md') {
    const directory = basename(dirname(document.filePath)).trim()
    if (directory) return directory
  }
  return document.title
}

/** Window title: the document name when a single tab is open, plain otherwise.
 *  A mirrored source carries the marker so it's visible even with no tab bar. */
export function windowTitleFor(docTitle: string | null, mirroredSource: boolean): string {
  if (!docTitle) return 'note.md'
  return `${mirroredSource ? `${SYNC_MARK} ` : ''}${docTitle} — note.md`
}
