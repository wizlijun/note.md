import { isMap, parseDocument } from 'yaml'

/** Only a top-level YAML boolean in the leading metadata block locks Markdown. */
export function hasReadonlyFrontmatter(content: string): boolean {
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(content)
  if (!header || header.index !== 0) return false
  try {
    const document = parseDocument(header[1])
    return document.errors.length === 0 && isMap(document.contents)
      && document.get('readonly') === true
  } catch {
    return false
  }
}

/** The accepted disk snapshot remains authoritative even if a caller edits the buffer. */
export function isReadonlyMarkdownTab(tab: { kind: string; initialContent: string }): boolean {
  return tab.kind === 'markdown' && hasReadonlyFrontmatter(tab.initialContent)
}
