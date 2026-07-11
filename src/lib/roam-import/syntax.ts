// src/lib/roam-import/syntax.ts
/** 代码段(``` fence 或 `inline`)切分:偶数下标是普通文本,奇数是代码,转换只作用于普通段 */
const CODE_SPLIT_RE = /(```[\s\S]*?```|`[^`\n]*`)/

function mapNonCode(s: string, fn: (seg: string) => string): string {
  return s.split(CODE_SPLIT_RE).map((seg, i) => (i % 2 === 0 ? fn(seg) : seg)).join('')
}

/** Roam 行内语法 → 本地 markdown(spec 语法映射表) */
export function convertInline(s: string): string {
  return mapNonCode(s, (seg) =>
    seg
      .replace(/\{\{\[\[embed\]\]:\s*\(\(([a-zA-Z0-9_-]+)\)\)\s*\}\}/g, '(($1))')
      .replace(/\{\{embed:\s*\(\(([a-zA-Z0-9_-]+)\)\)\s*\}\}/g, '(($1))')
      .replace(/\{\{\[\[TODO\]\]\}\}/g, '[ ]')
      .replace(/\{\{\[\[DONE\]\]\}\}/g, '[x]')
      .replace(/\{\{TODO\}\}/g, '[ ]')
      .replace(/\{\{DONE\}\}/g, '[x]')
      .replace(/__([^_\n](?:[^\n]*?[^_\n])?)__/g, '*$1*')
      .replace(/#\[\[([^\]\n]+)\]\]/g, '[[$1]]'),
  )
}

/** 按改名映射改写 [[链接]](wikilink 只按文件名解析,改名必须全图重链) */
export function rewriteLinks(s: string, renames: Map<string, string>): string {
  if (renames.size === 0) return s
  return mapNonCode(s, (seg) =>
    seg.replace(/\[\[([^\]\n]+)\]\]/g, (whole, t: string) => {
      const to = renames.get(t)
      return to != null ? `[[${to}]]` : whole
    }),
  )
}

/** 多行 block 里形如保留属性(parseOutline 的 PROP_RE)的续行会被当属性吃掉,
 *  前置一个空格转义(渲染等价)。首行在 `- ` 之后,天然安全。 */
const RESERVED_PROP_RE = /^(type|line|id|collapsed|created|updated):: /
export function escapeReservedProps(s: string): string {
  const lines = s.split('\n')
  return lines
    .map((ln, i) => (i > 0 && RESERVED_PROP_RE.test(ln) ? ` ${ln}` : ln))
    .join('\n')
}
