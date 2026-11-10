// Pure view helpers for the Smart Lookup window (`src/SmartLookupApp.svelte`).
// Kept out of the component so the choices they encode stay unit-tested.
import type { AgentOption } from '../agent-picker/types'
import type { SearchHit } from '../search/api'
import { groupHits, type HitGroup } from '../search/grouping'
import { supportsSearchTask } from './agent'

/** The bundled agent, preferred when the app has no default agent. */
export const FALLBACK_AGENT_ID = 'notemd.claude-agent'

/**
 * The agent that runs `task`: the configured id when that agent can run the
 * task; otherwise the app default, the bundled agent, then the first capable
 * agent. Reserved settings values (`auto`, `same_as_planner`, `ask`) never
 * name an agent, so they fall through to the default order.
 */
export function pickTaskAgent(
  agents: AgentOption[],
  task: string,
  configured: string,
  appDefault: string,
): AgentOption | null {
  const capable = agents.filter((agent) => supportsSearchTask(agent, task))
  return capable.find((agent) => agent.id === configured)
    ?? capable.find((agent) => agent.id === appDefault)
    ?? capable.find((agent) => agent.id === FALLBACK_AGENT_ID)
    ?? capable[0]
    ?? null
}

export interface ResultSection<T extends SearchHit = SearchHit> {
  key: string
  label: string
  hits: T[]
}

/** Month sections (`YYYY-MM`), newest first; hits without a date come last. */
export function dateSections<T extends SearchHit>(hits: T[], unknownLabel: string): ResultSection<T>[] {
  const months = new Map<string, T[]>()
  const undated: T[] = []
  for (const hit of hits) {
    const month = /^\d{4}-\d{2}/.exec(hit.docDate ?? '')?.[0]
    if (!month) { undated.push(hit); continue }
    const bucket = months.get(month)
    if (bucket) bucket.push(hit)
    else months.set(month, [hit])
  }
  const sections: ResultSection<T>[] = [...months.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([month, members]) => ({ key: `date:${month}`, label: month, hits: members }))
  if (undated.length) sections.push({ key: 'date:unknown', label: unknownLabel, hits: undated })
  return sections
}

/** The shared origin grouping (`groupHits`), flattened to one list per group. */
export function sourceSections(
  hits: SearchHit[],
  label: (group: HitGroup) => string,
): ResultSection[] {
  return groupHits(hits).map((group) => ({
    key: group.kind === 'derivedType' ? `derived:${group.conceptType}` : group.kind,
    label: label(group),
    hits: group.files.flatMap((file) => file.hits),
  }))
}

/** A summary needs at least one line-level hit that carries text. */
export function hasSummarySource(hits: SearchHit[]): boolean {
  return hits.some((hit) => hit.level === 'line' && hit.text.trim().length > 0)
}

export function hitReference(hit: Pick<SearchHit, 'path' | 'line'>): string {
  return `${hit.path}:${hit.line}`
}

/** A short, display-safe error: no local paths, tokens or keys. */
export function redactError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(^|[\s("'`])\/(?:[^/\s"'`]+\/)+[^/\s"'`,;:)]+/g, '$1[local path]')
    .replace(/\b[A-Za-z]:\\[^\s"'`,;]+/g, '[local path]')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(message).slice(0, 180).join('')
}
