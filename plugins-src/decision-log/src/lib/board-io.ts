import YAML from 'yaml'
import type { OpenDecision, ArchivedDecision } from './model'

const FM = /^---\n([\s\S]*?)\n---\n?/

function buildNote(frontmatter: object, bodyLines: string[]): string {
  const fm = YAML.stringify(frontmatter).trimEnd()
  return `---\n${fm}\n---\n\n${bodyLines.join('\n')}\n`
}
function readFrontmatter(md: string): any {
  const m = md.match(FM)
  if (!m) return null
  try { return YAML.parse(m[1]) } catch { return null }
}

export function serializeBoard(decisions: OpenDecision[]): string {
  const body = ['# 未决决策', '']
  for (const d of decisions) {
    body.push(`## ${d.title}`)
    body.push(`- 预测:${d.prediction}(信心 ${d.confidence})· 检查 ${d['check-date']}`)
    body.push('')
  }
  return buildNote({ type: 'decision-board', decisions }, body)
}
export function parseBoard(md: string): OpenDecision[] {
  const fm = readFrontmatter(md)
  return Array.isArray(fm?.decisions) ? (fm.decisions as OpenDecision[]) : []
}
export function serializeArchive(resolved: string, decisions: ArchivedDecision[]): string {
  const lines = [`# ${resolved} 裁决`, '']
  for (const d of decisions) {
    const mark = d.status === 'closed' ? (d.outcome === 'hit' ? '✅' : d.outcome === 'miss' ? '❌' : '◐') : d.status === 'dropped' ? '⊘' : '⬇'
    lines.push(`## ${d.id} — ${d.status} ${mark}`)
    lines.push(`- 预测:${d.prediction}(信心 ${d.confidence})`)
    lines.push('')
  }
  return buildNote({ type: 'decision-archive', resolved, decisions }, lines)
}
export function parseArchive(md: string): ArchivedDecision[] {
  const fm = readFrontmatter(md)
  return Array.isArray(fm?.decisions) ? (fm.decisions as ArchivedDecision[]) : []
}
