/**
 * Citation regex. Strict requirements:
 *   - pageuri may be empty or any chars except `(`, `)`, `#`
 *   - blockid is `b-` + exactly 6 lowercase hex chars
 *
 * Use with /g flag for repeated matching; the exported version has no flags
 * so callers can pick the appropriate flag set.
 */
export const CITATION_RE = /\(\(([^()#]*)#(b-[0-9a-f]{6})\)\)/

export interface ParsedCitation {
  raw: string
  pageuri: string     // may be ''
  blockid: string
  start: number       // offset in source
  end: number         // exclusive
}

export function parseCitations(text: string): ParsedCitation[] {
  const re = new RegExp(CITATION_RE.source, 'g')
  const out: ParsedCitation[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({
      raw: m[0],
      pageuri: m[1],
      blockid: m[2],
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/**
 * Find the citation that contains `cursor` (selectionStart) in `text`,
 * if any. Used by source-mode "follow citation under cursor".
 */
export function citationAtCursor(text: string, cursor: number): ParsedCitation | null {
  for (const c of parseCitations(text)) {
    if (cursor >= c.start && cursor <= c.end) return c
  }
  return null
}

import type { BlockYaml } from './yaml-schema'
import { readBlockYaml } from './yaml-rw'

export function resolvePageUri(pageuri: string, currentDocPath: string): string {
  if (pageuri === '') return currentDocPath
  // Reject `..` traversal (security: don't escape via citations)
  if (pageuri.split('/').includes('..')) {
    throw new Error(`citation: parent-dir traversal rejected (pageuri="${pageuri}")`)
  }
  if (pageuri.startsWith('/')) return pageuri
  // Posix-style relative resolve (markdown citations are posix-y on all platforms)
  const dir = currentDocPath.replace(/[^/]*$/, '') // dirname with trailing slash
  return dir + pageuri
}

export type ResolvedStatus = 'active' | 'retired' | 'deleted' | 'not_found'

export interface ResolvedCitation {
  status: ResolvedStatus
  srcLine?: number
  filePath?: string
  banner?: string
}

/**
 * Pure resolver against an in-memory yaml. Walks `replaced_by` chains for
 * retired ids until it finds an active block or hits a deletion terminus.
 */
export function resolveCitationViaYaml(
  yaml: BlockYaml,
  blockid: string,
): ResolvedCitation {
  const active = yaml.active.find((a) => a.id === blockid)
  if (active) return { status: 'active', srcLine: active.src_line }

  // Walk history chain
  const visited = new Set<string>()
  let current = blockid
  while (true) {
    if (visited.has(current)) {
      // cycle detection
      return { status: 'not_found' }
    }
    visited.add(current)
    const retired = yaml.history.find((h) => h.id === current)
    if (!retired) return { status: 'not_found' }
    if (retired.replaced_by.length === 0) {
      return {
        status: 'deleted',
        banner: `原 block 已删除（在 generation ${retired.retired_gen}）`,
      }
    }
    // Chain forward; if multiple successors, follow the first that resolves.
    let resolved: ResolvedCitation | null = null
    for (const next of retired.replaced_by) {
      const a = yaml.active.find((x) => x.id === next)
      if (a) {
        resolved = {
          status: 'retired',
          srcLine: a.src_line,
          banner: `原 block 已编辑，跳转到当前继承块 ${a.id}`,
        }
        break
      }
    }
    if (resolved) return resolved
    // None of the immediate successors are active; recurse into the first
    current = retired.replaced_by[0]
  }
}

/**
 * Full resolver: load target's yaml from disk, then resolve.
 */
export async function resolveCitation(
  pageuri: string,
  blockid: string,
  currentDocPath: string,
): Promise<ResolvedCitation & { filePath: string }> {
  const filePath = resolvePageUri(pageuri, currentDocPath)
  const { cachedYamlPath } = await import('../mdblock/path')
  const yaml = await readBlockYaml(await cachedYamlPath(filePath))
  if (!yaml) {
    return {
      status: 'not_found',
      filePath,
      banner: '目标文档未启用 block id（缓存中未找到 yaml；请先 Compute Blocks）',
    }
  }
  const r = resolveCitationViaYaml(yaml, blockid)
  return { ...r, filePath }
}
