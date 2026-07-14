// src/lib/wikilink/blocklist.ts
// 无效 wikilink 黑名单：纯逻辑，模块级 Set（默认空 → 未加载/测试时不拦截）。
// vault 加载器（blocklist-io）解析清单后调 setBlockedWikilinks 灌入。

/** 随版本发布的默认清单，也是首次播种 vault/wikilink/blocklist.md 的内容源。 */
export const DEFAULT_BLOCKED_WIKILINKS = ['wikilink', '链接', '双链']

/** 剥 |别名 与 #标题（取页名），trim，toLowerCase。 */
export function normalizeWikilinkTarget(raw: string): string {
  return raw.split('|')[0].split('#')[0].trim().toLowerCase()
}

/**
 * markdown 列表文本 → 条目数组：跳过 --- front-matter 块、空行、# 标题；
 * 剥行首 - / * / + 列表符号；trim；非空即一条（原样，不 normalize —— 由
 * setBlockedWikilinks 统一 normalize）。
 */
export function parseBlocklistFile(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/)
  const out: string[] = []
  let inFrontmatter = false
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    if (idx === 0 && line.trim() === '---') { inFrontmatter = true; continue }
    if (inFrontmatter) { if (line.trim() === '---') inFrontmatter = false; continue }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const item = trimmed.replace(/^[-*+]\s+/, '').trim()
    if (item) out.push(item)
  }
  return out
}

let blocked = new Set<string>()

/** 用给定清单重建模块级 Set（每项 normalize，丢弃空串）。 */
export function setBlockedWikilinks(list: string[]): void {
  blocked = new Set(list.map(normalizeWikilinkTarget).filter(Boolean))
}

/** normalize(target) 是否在当前黑名单里。 */
export function isBlockedWikilink(target: string): boolean {
  const key = normalizeWikilinkTarget(target)
  return key !== '' && blocked.has(key)
}
