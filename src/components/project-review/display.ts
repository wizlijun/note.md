export function visibleText(text: string): string {
  return text.replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu,
    char => `⟨U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`)
}

/** Display only; neither tokens nor highlighted text are used in compose. */
export function wordDiff(before: string, after: string) {
  const split = (text: string) => Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text), part => part.segment)
  const a = split(before), b = split(after)
  let start = 0, end = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++
  const parts = (tokens: string[]) => tokens.map((text, i) => ({ text: visibleText(text), changed: i >= start && i < tokens.length - end }))
  return { before: parts(a), after: parts(b) }
}

export const flagLabels: Record<string, string> = {
  'trust-field': '信任字段', frontmatter: '文档属性', 'owner-annotation': '主人批注',
  'hidden-chars': '隐藏字符', 'eol-only': '换行差异', degraded: '整文件审阅',
}
