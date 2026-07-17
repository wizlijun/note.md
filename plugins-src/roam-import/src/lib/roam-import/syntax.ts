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

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
}
/** Roam 日记标题写法 "August 15th, 2022" → "2022-08-15";非该形式返回 null。 */
export function toIsoDate(target: string): string | null {
  const m = target.match(/^([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th), (\d{4})$/)
  if (!m) return null
  const mo = MONTHS[m[1].toLowerCase()]
  const dd = Number(m[2])
  if (!mo || dd < 1 || dd > 31) return null
  return `${m[3]}-${mo}-${String(dd).padStart(2, '0')}`
}

/** 把英文日期形式的 [[链接]] 规范成 [[yyyy-MM-dd]](note.md 只识别 ISO 日期链接,
 *  spec §6)。不依赖导出里是否存在对应日记页,故空白日期链接也能正确指向。 */
export function normalizeDateLinks(s: string): string {
  return mapNonCode(s, (seg) =>
    seg.replace(/\[\[([^\]\n]+)\]\]/g, (whole, t: string) => {
      const iso = toIsoDate(t)
      return iso != null ? `[[${iso}]]` : whole
    }),
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
