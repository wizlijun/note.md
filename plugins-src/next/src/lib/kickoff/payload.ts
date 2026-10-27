export type KickoffDecides = 'commitment' | 'next_action' | 'close_condition' | 'owner' | 'scope' | 'other'
export interface KickoffOption { id: string; label: string; recommended: boolean; why: string; source_ids: string[] }
export interface KickoffQuestion { id: string; text: string; decides: KickoffDecides; options: KickoffOption[]; allow_free_text: boolean }
export interface KickoffContext { claim: string; kind: 'fact' | 'inference'; source_ids: string[]; unverified?: true }
export interface KickoffSuggestions { commitment?: string; next_action: string; close_condition: string; blockers: string[]; waiting_for: string[] }
export interface KickoffSource { id: string; resource: string; title: string; locator: string }
export interface KickoffPayload {
  schema: 'next-kickoff/v1'; task_id: string; based_on: string; summary: string
  questions: KickoffQuestion[]; context: KickoffContext[]; suggestions: KickoffSuggestions; gaps: string[]; sources: KickoffSource[]
}
export type PayloadResult = { ok: true; payload: KickoffPayload; repairs: string[] } | { ok: false; error: string }

export async function parsePayload(
  raw: string,
  expect: { taskId: string; basedOn: string },
  exists: (rel: string) => Promise<boolean>,
): Promise<PayloadResult> {
  const repairs: string[] = []
  const fail = (path: string, message: string): never => { throw new Error(`${path}: ${message}`) }
  const object = (value: unknown, path: string, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object')
    const result = value as Record<string, unknown>
    for (const key of Object.keys(result)) if (!keys.includes(key)) repairs.push(`${path}.${key}: removed unknown key`)
    return result
  }
  const string = (value: unknown, path: string, max?: number, nonempty = false): string => {
    if (typeof value !== 'string') fail(path, 'expected string')
    const result = value as string
    if (nonempty && !result.trim()) fail(path, 'expected non-empty string')
    if (max !== undefined && Array.from(result).length > max) fail(path, `expected at most ${max} code points`)
    return result
  }
  const list = (value: unknown, path: string, min: number, max: number): unknown[] => {
    if (!Array.isArray(value)) fail(path, 'expected array')
    const result = value as unknown[]
    if (result.length < min || result.length > max) fail(path, `expected ${min}-${max}, got ${result.length}`)
    return result
  }
  const strings = (value: unknown, path: string, max: number, limit?: number) =>
    list(value, path, 0, max).map((v, i) => string(v, `${path}[${i}]`, limit))
  const boolean = (value: unknown, path: string, fallback: boolean): boolean => {
    if (value === undefined) { repairs.push(`${path}: defaulted to ${fallback}`); return fallback }
    if (typeof value !== 'boolean') fail(path, 'expected boolean')
    return value as boolean
  }
  const uniqueId = (value: unknown, path: string, pattern: RegExp, seen: Set<string>) => {
    const id = string(value, path)
    if (!pattern.test(id)) fail(path, 'invalid id')
    if (seen.has(id)) fail(path, 'duplicate id')
    seen.add(id); return id
  }
  try {
    if (new TextEncoder().encode(raw).length > 65536) fail('payload', 'exceeds 64 KiB')
    let text = raw.trim()
    const fence = /^```json\s*\n([\s\S]*?)\n```$/.exec(text)
    if (fence) text = fence[1]
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { fail('payload', 'invalid JSON') }
    const p = object(parsed, 'payload', ['schema', 'task_id', 'based_on', 'summary', 'questions', 'context', 'suggestions', 'gaps', 'sources'])
    if (p.schema !== 'next-kickoff/v1') fail('schema', 'expected next-kickoff/v1')
    if (p.task_id !== expect.taskId) fail('task_id', 'mismatch')
    if (p.based_on !== expect.basedOn) fail('based_on', 'mismatch')
    const summary = string(p.summary, 'summary', 200, true)
    const questionIds = new Set<string>()
    const questions: KickoffQuestion[] = list(p.questions, 'questions', 1, 3).map((value, i) => {
      const path = `questions[${i}]`
      const q = object(value, path, ['id', 'text', 'decides', 'options', 'allow_free_text'])
      const id = uniqueId(q.id, `${path}.id`, /^q[1-3]$/, questionIds)
      const text = string(q.text, `${path}.text`, 200, true)
      if (!['commitment', 'next_action', 'close_condition', 'owner', 'scope', 'other'].includes(q.decides as string)) fail(`${path}.decides`, 'invalid enum')
      const optionIds = new Set<string>()
      const options = list(q.options, `${path}.options`, 2, 4).map((value, j): KickoffOption => {
        const op = `${path}.options[${j}]`
        const o = object(value, op, ['id', 'label', 'recommended', 'why', 'source_ids'])
        let why = ''
        if (o.why === undefined) repairs.push(`${op}.why: defaulted to empty string`)
        else why = string(o.why, `${op}.why`, 300)
        return { id: uniqueId(o.id, `${op}.id`, /^[a-d]$/, optionIds), label: string(o.label, `${op}.label`, 120, true),
          recommended: boolean(o.recommended, `${op}.recommended`, false), why,
          source_ids: strings(o.source_ids, `${op}.source_ids`, Infinity) }
      })
      if (options.filter(o => o.recommended).length > 1) fail(`${path}.options`, 'expected at most one recommended option')
      return { id, text, decides: q.decides as KickoffDecides, options, allow_free_text: boolean(q.allow_free_text, `${path}.allow_free_text`, true) }
    })
    const context: KickoffContext[] = list(p.context, 'context', 0, 8).map((value, i) => {
      const path = `context[${i}]`
      const c = object(value, path, ['claim', 'kind', 'source_ids'])
      if (c.kind !== 'fact' && c.kind !== 'inference') fail(`${path}.kind`, 'invalid enum')
      return { claim: string(c.claim, `${path}.claim`, 300, true), kind: c.kind as KickoffContext['kind'], source_ids: strings(c.source_ids, `${path}.source_ids`, Infinity) }
    })
    const s = object(p.suggestions, 'suggestions', ['commitment', 'next_action', 'close_condition', 'blockers', 'waiting_for'])
    const suggestions: KickoffSuggestions = {
      ...(s.commitment === undefined ? {} : {commitment: string(s.commitment, 'suggestions.commitment', 120)}),
      next_action: string(s.next_action, 'suggestions.next_action', 200, true), close_condition: string(s.close_condition, 'suggestions.close_condition', 200, true),
      blockers: strings(s.blockers, 'suggestions.blockers', 5, 200), waiting_for: strings(s.waiting_for, 'suggestions.waiting_for', 5, 200),
    }
    const gaps = strings(p.gaps, 'gaps', 5, 200)
    const sourceIds = new Set<string>()
    const candidates = list(p.sources, 'sources', 0, 12).map((value, i): KickoffSource => {
      const path = `sources[${i}]`
      const s = object(value, path, ['id', 'resource', 'title', 'locator'])
      return {id: uniqueId(s.id, `${path}.id`, /^s\d{1,2}$/, sourceIds), resource: string(s.resource, `${path}.resource`), title: string(s.title, `${path}.title`), locator: string(s.locator, `${path}.locator`)}
    })
    const sources: KickoffSource[] = []
    for (const [i, source] of candidates.entries()) {
      const rel = source.resource
      if (rel.startsWith('/') || rel.split('/').includes('..') || rel.includes('\0') || !await exists(rel)) repairs.push(`sources[${i}]: removed invalid resource`)
      else sources.push(source)
    }
    const validIds = new Set(sources.map(s => s.id))
    const filterIds = (ids: string[], path: string) => ids.filter((id, i) => {
      if (validIds.has(id)) return true
      repairs.push(`${path}[${i}]: removed unknown source ${id}`); return false
    })
    questions.forEach((q, i) => q.options.forEach((o, j) => { o.source_ids = filterIds(o.source_ids, `questions[${i}].options[${j}].source_ids`) }))
    context.forEach((c, i) => {
      c.source_ids = filterIds(c.source_ids, `context[${i}].source_ids`)
      if (c.kind === 'fact' && !c.source_ids.length) {
        c.kind = 'inference'; c.unverified = true; repairs.push(`context[${i}]: downgraded to unverified inference`)
      }
    })
    return {ok:true, payload:{schema:'next-kickoff/v1', task_id:expect.taskId, based_on:expect.basedOn, summary, questions, context, suggestions, gaps, sources}, repairs}
  } catch (error) {
    return {ok:false, error:error instanceof Error ? error.message : 'payload: validation failed'}
  }
}
