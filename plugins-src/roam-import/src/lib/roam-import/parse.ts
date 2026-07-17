// src/lib/roam-import/parse.ts
import type { RoamBlock, RoamPage, RoamGraph } from './types'

const REF_RE = /\(\(([a-zA-Z0-9_-]{3,})\)\)/g
const DAILY_UID_RE = /^(\d{2})-(\d{2})-(\d{4})$/

/** Roam 日记页判定走 uid(MM-DD-YYYY),不解析英文标题。返回 yyyy-MM-dd 或 null。 */
export function dailyDateFromUid(uid: string | undefined): string | null {
  const m = uid?.match(DAILY_UID_RE)
  if (!m) return null
  const mm = Number(m[1]), dd = Number(m[2])
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return `${m[3]}-${m[1]}-${m[2]}`
}

function collectRefs(blocks: RoamBlock[] | undefined, acc: Set<string>): void {
  for (const b of blocks ?? []) {
    if (typeof b?.string === 'string') {
      for (const m of b.string.matchAll(REF_RE)) acc.add(m[1])
    }
    collectRefs(b?.children, acc)
  }
}

/** 解析 Roam JSON 导出全文。非数组/坏 JSON 抛错;无 title 的条目跳过。 */
export function parseRoamJson(text: string): RoamGraph {
  const data: unknown = JSON.parse(text)
  if (!Array.isArray(data)) throw new Error('Roam export must be a JSON array of pages')
  const pages: RoamPage[] = []
  const referencedUids = new Set<string>()
  for (const entry of data) {
    const p = entry as RoamPage | null
    if (p == null || typeof p.title !== 'string') continue
    pages.push(p)
    collectRefs(p.children, referencedUids)
  }
  return { pages, referencedUids }
}
