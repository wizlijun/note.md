/** Share titles are presentation metadata; the Markdown heading stays untouched. */
export function defaultShareTitle(entry: string): string {
  const name = entry.split('/').at(-1)?.replace(/\.(?:md|markdown|mdown|mkd|mdx)$/i, '').trim()
  return name || '未命名文档'
}

export function normalizeShareTitle(title: string | undefined, entry: string): string {
  return title?.trim() || defaultShareTitle(entry)
}
