// Pure view helpers for the Smart Lookup window (`src/SmartLookupApp.svelte`).
// Kept out of the component so the choices they encode stay unit-tested.
import type { AgentOption } from '../agent-picker/types'
import type { SearchHit } from '../search/api'
import { groupHits, type HitGroup } from '../search/grouping'
import { supportsSearchTask, VAULT_RESEARCH_TASK } from './agent'

/** The bundled agent, preferred when the app has no default agent. */
export const FALLBACK_AGENT_ID = 'notemd.claude-agent'

/** `summary.provider` values that mean "choose for me" rather than an agent id. */
export const SUMMARY_DEFAULT_CHOICES = ['auto'] as const
/** `handoff.defaultProvider` value meaning "ask every time": the user picks the agent per handoff. */
export const HANDOFF_ASK = 'ask'

/**
 * The agent that runs `task`. A reserved value (`defaultChoices`) picks the
 * app default, the bundled agent, then the first capable agent. An explicit
 * agent id is honoured or nothing is: when that agent is missing or cannot run
 * the task the result is `null`, so note excerpts never go to a provider the
 * user did not choose.
 */
export function pickTaskAgent(
  agents: AgentOption[],
  task: string,
  configured: string,
  appDefault: string,
  defaultChoices: readonly string[],
): AgentOption | null {
  const capable = agents.filter((agent) => supportsSearchTask(agent, task))
  if (!defaultChoices.includes(configured)) {
    return capable.find((agent) => agent.id === configured) ?? null
  }
  return capable.find((agent) => agent.id === appDefault)
    ?? capable.find((agent) => agent.id === FALLBACK_AGENT_ID)
    ?? capable[0]
    ?? null
}

export interface HandoffChoices {
  /** One "In-depth research" row per agent; never chosen on the user's behalf. */
  agents: AgentOption[]
  /** No agent can be offered: none is capable, or the configured one is unavailable. */
  unavailable: boolean
}

/**
 * The research agents the actions menu offers. `'ask'` offers every capable
 * agent so the user chooses each time; an explicit agent id offers that agent
 * only, and nothing when it is missing or cannot research — it is never
 * replaced by another agent.
 */
export function handoffChoices(agents: AgentOption[], configured: string): HandoffChoices {
  const capable = agents.filter((agent) => supportsSearchTask(agent, VAULT_RESEARCH_TASK))
  const offered = configured === HANDOFF_ASK
    ? capable
    : capable.filter((agent) => agent.id === configured)
  return { agents: offered, unavailable: offered.length === 0 }
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
