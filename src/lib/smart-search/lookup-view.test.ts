import { describe, expect, it } from 'vitest'
import type { AgentHarness, AgentOption } from '../agent-picker/types'
import type { SearchHit } from '../search/api'
import { SEARCH_SUMMARY_TASK, VAULT_RESEARCH_TASK } from './agent'
import {
  dateSections,
  HANDOFF_ASK,
  handoffChoices,
  hasSummarySource,
  hitReference,
  pickTaskAgent,
  redactError,
  sourceSections,
  SUMMARY_DEFAULT_CHOICES,
} from './lookup-view'

function agent(id: string, tasks: string[]): AgentOption {
  const harness: AgentHarness = {
    harness: id, ok: true, version: null, default_model: null, hint: null, warning: null,
    capabilities: {
      tasks,
      search_plan_schemas: [],
      terminal_result: true,
      input_only_isolation: true,
      model_routing: {
        invocation_override: true,
        selectable_models: [],
        profiles: { fast: { model: 'fast', available: true }, default: { model: null, available: false } },
      },
    },
  }
  return { id, name: id, harness }
}

function hit(path: string, docDate: string | null, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    path, absPath: `/vault/${path}`, line: 3, lineEnd: 3, text: 'body', breadcrumb: '',
    level: 'line', score: 1, docDate, sourceRef: `${path}#L3`, agentBy: null,
    humanVerified: false, origin: 'human', conceptType: null, pinned: false, ...overrides,
  }
}

describe('pickTaskAgent', () => {
  const summary = agent('notemd.summary-only', [SEARCH_SUMMARY_TASK])
  const claude = agent('notemd.claude-agent', [SEARCH_SUMMARY_TASK, VAULT_RESEARCH_TASK])
  const other = agent('notemd.other', [SEARCH_SUMMARY_TASK, VAULT_RESEARCH_TASK])
  const broken: AgentOption = { ...agent('notemd.broken', [SEARCH_SUMMARY_TASK, VAULT_RESEARCH_TASK]), harness: null }
  const agents = [summary, other, claude, broken]

  it('uses an explicitly configured agent that supports the task', () => {
    expect(pickTaskAgent(agents, SEARCH_SUMMARY_TASK, 'notemd.summary-only', 'notemd.other', SUMMARY_DEFAULT_CHOICES)?.id)
      .toBe('notemd.summary-only')
  })

  it('never substitutes another agent for an explicit agent that cannot run the task', () => {
    expect(pickTaskAgent(agents, VAULT_RESEARCH_TASK, 'notemd.summary-only', 'notemd.other', SUMMARY_DEFAULT_CHOICES))
      .toBeNull()
    // A failed harness-status leaves the agent listed but incapable.
    expect(pickTaskAgent(agents, SEARCH_SUMMARY_TASK, 'notemd.broken', 'notemd.other', SUMMARY_DEFAULT_CHOICES))
      .toBeNull()
  })

  it('returns null for an explicit agent id that is not installed', () => {
    expect(pickTaskAgent(agents, SEARCH_SUMMARY_TASK, 'notemd.removed', 'notemd.other', SUMMARY_DEFAULT_CHOICES))
      .toBeNull()
  })

  it('resolves reserved values to app default, then Claude, then the first capable agent', () => {
    expect(pickTaskAgent(agents, SEARCH_SUMMARY_TASK, 'auto', 'notemd.other', SUMMARY_DEFAULT_CHOICES)?.id).toBe('notemd.other')
    expect(pickTaskAgent(agents, SEARCH_SUMMARY_TASK, 'auto', '', SUMMARY_DEFAULT_CHOICES)?.id).toBe('notemd.claude-agent')
    expect(pickTaskAgent([summary, other], SEARCH_SUMMARY_TASK, 'auto', '', SUMMARY_DEFAULT_CHOICES)?.id).toBe('notemd.summary-only')
  })
})

describe('handoffChoices', () => {
  const summary = agent('notemd.summary-only', [SEARCH_SUMMARY_TASK])
  const claude = agent('notemd.claude-agent', [SEARCH_SUMMARY_TASK, VAULT_RESEARCH_TASK])
  const other = agent('notemd.other', [SEARCH_SUMMARY_TASK, VAULT_RESEARCH_TASK])
  const broken: AgentOption = { ...agent('notemd.broken', [SEARCH_SUMMARY_TASK, VAULT_RESEARCH_TASK]), harness: null }
  const agents = [summary, other, claude, broken]

  it('"ask every time" offers every capable agent and picks none', () => {
    expect(handoffChoices(agents, HANDOFF_ASK)).toEqual({ agents: [other, claude], unavailable: false })
    expect(handoffChoices([summary, broken], HANDOFF_ASK)).toEqual({ agents: [], unavailable: true })
  })

  it('an explicit agent is the only choice', () => {
    expect(handoffChoices(agents, 'notemd.claude-agent')).toEqual({ agents: [claude], unavailable: false })
  })

  it('an explicit agent that is missing or cannot research is never replaced', () => {
    expect(handoffChoices(agents, 'notemd.removed')).toEqual({ agents: [], unavailable: true })
    expect(handoffChoices(agents, 'notemd.summary-only')).toEqual({ agents: [], unavailable: true })
    expect(handoffChoices(agents, 'notemd.broken')).toEqual({ agents: [], unavailable: true })
  })
})

describe('result sections', () => {
  it('groups by month, newest first, with undated hits last', () => {
    const sections = dateSections([
      hit('a.md', '2026-08-20'), hit('b.md', null), hit('c.md', '2026-10-01'), hit('d.md', '2026-08-02'),
    ], 'Date unknown')
    expect(sections.map((section) => [section.label, section.hits.map((h) => h.path)])).toEqual([
      ['2026-10', ['c.md']],
      ['2026-08', ['a.md', 'd.md']],
      ['Date unknown', ['b.md']],
    ])
  })

  it('keeps the shared source grouping order', () => {
    const sections = sourceSections([
      hit('raw.md', null, { origin: 'source' }), hit('mine.md', null),
    ], (group) => group.kind)
    expect(sections.map((section) => section.label)).toEqual(['human', 'source'])
    expect(sections.flatMap((section) => section.hits.map((h) => h.path))).toEqual(['mine.md', 'raw.md'])
  })
})

describe('lookup helpers', () => {
  it('needs a non-empty line hit before a summary can run', () => {
    expect(hasSummarySource([hit('a.md', null, { level: 'section' })])).toBe(false)
    expect(hasSummarySource([hit('a.md', null, { text: '  ' })])).toBe(false)
    expect(hasSummarySource([hit('a.md', null)])).toBe(true)
  })

  it('formats a path:line reference', () => {
    expect(hitReference(hit('notes/a.md', null, { line: 4, lineEnd: 9 }))).toBe('notes/a.md:4')
  })

  it('redacts local paths and secrets from errors', () => {
    const text = redactError(new Error('failed at /Users/me/Vault/.notemd/index token=abc123 sk-abcdefgh12345'))
    expect(text).not.toContain('/Users/me')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('sk-abcdefgh12345')
    expect(redactError('search index not ready')).toBe('search index not ready')
  })
})
