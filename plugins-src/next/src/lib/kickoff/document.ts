import { visit } from 'yaml'
import { CONCEPT_TYPE, conceptFileText } from '../../../../../src/lib/okf/concept'
import { editableFrontmatter, serializeEditableFrontmatter } from '../frontmatter-document'
import type { KickoffPayload, KickoffDecides } from './payload'
import { sha256 } from './hash'

export interface KickoffAnswer {
  question_id: string
  question: string
  decides: KickoffDecides
  option_id: string | null
  answer: string
  by: string
  at: string
}

export interface PriorAnswer extends KickoffAnswer {
  run_id: string
}

export interface KickoffData {
  version: 1
  schema: 'next-kickoff/v1'
  task_id: string
  based_on: string
  harness: string
  model?: string
  run_id: string
  duration_seconds: number
  rendered: string
  repairs: string[]
  payload: KickoffPayload
  answers: KickoffAnswer[]
  prior_answers: PriorAnswer[]
  [key: string]: unknown
}

export interface KickoffDoc {
  raw: string
  metadata: Record<string, unknown>
  kickoff: KickoffData
  body: string
}

export interface BuildKickoffInput {
  payload: KickoffPayload
  taskPath: string
  taskTitle: string
  runId: string
  endedAt: string
  durationSeconds: number
  harness?: string
  providerId: string
  model?: string
  repairs?: string[]
  priorAnswers?: PriorAnswer[]
}

export function kickoffPathFor(taskRel: string): string {
  if (!/^inbox\/tasks\/[^/]+\.md$/.test(taskRel) || /[\\\0]/.test(taskRel) || taskRel.split('/').some(p => p === '..' || p === '.') || taskRel.endsWith('.kickoff.md'))
    throw new Error('Expected safe inbox/tasks Task Markdown path')
  return taskRel.slice(0, -3) + '.kickoff.md'
}

export function renderBody(payload: KickoffPayload, answers: KickoffAnswer[] = []): string {
  const lines = ['# ✦ 开个头', '', `✦ ${payload.summary}`, '', '## 需要你回答', '']
  for (const q of payload.questions) {
    const a = answers.find(a => a.question_id === q.id)
    lines.push(`### ${a ? '●' : '✦'} ${q.text}`, '')
    for (const o of q.options)
      lines.push(`- ${o.label}${o.recommended ? '（建议）' : ''}${o.why ? `：${o.why}` : ''}${o.source_ids.length ? ` [${o.source_ids.join(', ')}]` : ''}`)
    if (a)
      lines.push('', `● ${a.answer}`)
    lines.push('')
  }
  lines.push('## ✦ 已知背景', '')
  for (const c of payload.context)
    lines.push(`- ${c.kind === 'inference' ? '推断：' : ''}${c.claim}${c.source_ids.length ? ` [${c.source_ids.join(', ')}]` : ''}`)
  const s = payload.suggestions
  lines.push('', '## ✦ 建议', '')
  if (s.commitment)
    lines.push(`- 承诺：${s.commitment}`)
  lines.push(`- 下一步：${s.next_action}`, `- 结束条件：${s.close_condition}`, ...s.blockers.map(b => `- 阻碍：${b}`), ...s.waiting_for.map(w => `- 等待：${w}`))
  lines.push('', '## ✦ 没查到的', '', ...payload.gaps.map(g => `- ${g}`), '', '## ✦ 来源', '')
  for (const s of payload.sources)
    lines.push(`- [${s.id}] [${s.title}](${s.resource})${s.locator ? ` · ${s.locator}` : ''}`)
  return lines.join('\n') + '\n'
}

function quoteDates(markdown: string): string {
  const editable = editableFrontmatter(markdown, false)
  visit(editable.document, { Scalar(_key, node) {
      if (typeof node.value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(node.value))
        node.type = 'QUOTE_DOUBLE'
    } })
  return serializeEditableFrontmatter(editable)
}

export async function buildKickoffDocument(input: BuildKickoffInput): Promise<string> {
  kickoffPathFor(input.taskPath)
  const harness = input.harness || input.providerId
  const body = renderBody(input.payload).replace('# ✦ 开个头\n', `# ✦ 开个头：${input.taskTitle.replace(/[\r\n]/g, ' ')}\n`)
  const kickoff: KickoffData = {
    version: 1,
    schema: input.payload.schema,
    task_id: input.payload.task_id,
    based_on: input.payload.based_on,
    harness,
    ...(input.model === undefined ? {} : { model: input.model }),
    run_id: input.runId,
    duration_seconds: input.durationSeconds,
    rendered: await sha256(body),
    repairs: input.repairs ?? [],
    payload: input.payload,
    answers: [],
    prior_answers: input.priorAnswers ?? [],
  }
  return quoteDates(conceptFileText({
    type: CONCEPT_TYPE.taskKickoff,
    title: `开个头：${input.taskTitle}`,
    description: input.payload.summary,
    generated: { by: `process:${harness.replace(/^notemd\./, '')}`, at: input.endedAt },
    sources: [{ resource: input.taskPath }, ...input.payload.sources.map(s => ({ resource: s.resource }))],
    kickoff,
  }, body))
}

type RecordValue = Record<string, unknown>

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string'
}

function nonempty(value: unknown): value is string {
  return text(value) && value.trim().length > 0
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text)
}

const decides: readonly KickoffDecides[] = ['commitment', 'next_action', 'close_condition', 'owner', 'scope', 'other']

function decision(value: unknown): value is KickoffDecides {
  return decides.some(d => d === value)
}

function timestamp(value: unknown): value is string {
  return nonempty(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
}

// Persisted documents must be validated without the async input parser's repairs:
// source disappearance must never remove an old source or a person's answers.
function storedPayload(value: unknown): value is KickoffPayload {
  if (!record(value)
    || value.schema !== 'next-kickoff/v1'
    || !nonempty(value.task_id)
    || !nonempty(value.based_on)
    || !nonempty(value.summary)) return false
  if (!Array.isArray(value.sources)
    || !Array.isArray(value.questions)
    || value.questions.length < 1
    || value.questions.length > 3
    || !Array.isArray(value.context)
    || !strings(value.gaps)) return false
  const sourceIds = new Set<string>()
  for (const source of value.sources) {
    if (!record(source)
      || !text(source.id)
      || !/^s\d{1,2}$/.test(source.id)
      || sourceIds.has(source.id)
      || !text(source.resource)
      || !text(source.title)
      || !text(source.locator)) return false
    sourceIds.add(source.id)
  }
  const references = (ids: unknown): boolean => strings(ids) && ids.every(id => sourceIds.has(id))
  const questionIds = new Set<string>()
  for (const q of value.questions) {
    if (!record(q)
      || !text(q.id)
      || !/^q[1-3]$/.test(q.id)
      || questionIds.has(q.id)
      || !nonempty(q.text)
      || !decision(q.decides)
      || typeof q.allow_free_text !== 'boolean'
      || !Array.isArray(q.options)
      || q.options.length < 2
      || q.options.length > 4) return false
    questionIds.add(q.id)
    const optionIds = new Set<string>()
    let recommended = 0
    for (const o of q.options) {
      if (!record(o)
        || !text(o.id)
        || !/^[a-d]$/.test(o.id)
        || optionIds.has(o.id)
        || !nonempty(o.label)
        || typeof o.recommended !== 'boolean'
        || !text(o.why)
        || !references(o.source_ids)) return false
      optionIds.add(o.id)
      if (o.recommended) recommended++
    }
    if (recommended > 1) return false
  }
  for (const c of value.context) {
    if (!record(c)
      || !nonempty(c.claim)
      || !['fact', 'inference'].includes(String(c.kind))
      || !references(c.source_ids)
      || (c.unverified !== undefined && c.unverified !== true)) return false
  }
  const s = value.suggestions
  return record(s) && (s.commitment === undefined || text(s.commitment)) && nonempty(s.next_action) && nonempty(s.close_condition) && strings(s.blockers) && strings(s.waiting_for)
}

function storedAnswer(value: unknown): value is KickoffAnswer {
  return record(value) && text(value.question_id) && /^q[1-3]$/.test(value.question_id) && nonempty(value.question) && decision(value.decides)
    && (value.option_id === null || (text(value.option_id) && /^[a-d]$/.test(value.option_id)))
    && text(value.answer) && text(value.by) && /^human:\S+$/.test(value.by) && timestamp(value.at)
}

function storedKickoff(value: unknown): value is KickoffData {
  if (!record(value)
    || value.version !== 1
    || value.schema !== 'next-kickoff/v1'
    || !nonempty(value.task_id)
    || !nonempty(value.based_on)
    || !nonempty(value.harness)
    || !nonempty(value.run_id)

    || (value.model !== undefined && !text(value.model))
    || typeof value.duration_seconds !== 'number'
    || !Number.isFinite(value.duration_seconds)
    || value.duration_seconds < 0

    || !text(value.rendered)
    || !/^sha256:[a-f0-9]{64}$/.test(value.rendered)
    || !strings(value.repairs)
    || !storedPayload(value.payload)

    || value.task_id !== value.payload.task_id
    || value.based_on !== value.payload.based_on
    || !Array.isArray(value.answers)
    || !Array.isArray(value.prior_answers)) return false
  const answered = new Set<string>()
  for (const a of value.answers) {
    if (!storedAnswer(a) || answered.has(a.question_id)) return false
    const q = value.payload.questions.find(q => q.id === a.question_id)
    if (!q || a.decides !== q.decides || (a.option_id === null ? !q.allow_free_text : !q.options.some(o => o.id === a.option_id))) return false
    answered.add(a.question_id)
  }
  // Historical questions/options belong to their original run, not this payload.
  return value.prior_answers.every(a => storedAnswer(a) && record(a) && nonempty(a.run_id))
}

export function parseKickoffDocument(content: string): KickoffDoc | null {
  try {
    const { document, body } = editableFrontmatter(content, false)
    const metadata: unknown = document.toJS()
    if (!record(metadata) || metadata.type !== CONCEPT_TYPE.taskKickoff || !storedKickoff(metadata.kickoff)) return null
    return { raw: content, metadata, kickoff: metadata.kickoff, body }
  } catch {
    return null
  }
}

export async function withAnswers(doc: KickoffDoc, answers: KickoffAnswer[], now: string): Promise<{
  content: string
  rerendered: boolean
}> {
  if (!timestamp(now)) throw new Error('Invalid answer timestamp')
  const editable = editableFrontmatter(doc.raw, false)
  const current = parseKickoffDocument(doc.raw)
  if (!current || current.kickoff.task_id !== doc.kickoff.task_id)
    throw new Error('Kickoff task identity mismatch')
  const merged = new Map(current.kickoff.answers.map(a => [a.question_id, a]))
  for (const a of answers) {
    if (!storedAnswer({ ...a, at: now }))
      throw new Error('Invalid answer: requires human: actor and valid answer fields')
    const q = current.kickoff.payload.questions.find(q => q.id === a.question_id)
    if (!q)
      throw new Error('Unknown kickoff question')
    if (a.option_id !== null && !q.options.some(o => o.id === a.option_id))
      throw new Error('Unknown kickoff option')
    if (a.option_id === null && !q.allow_free_text)
      throw new Error('Free text not allowed')
    merged.set(a.question_id, { ...a, question: q.text, decides: q.decides, at: now })
  }
  const next = [...merged.values()]
  editable.document.setIn(['kickoff', 'answers'], editable.document.createNode(next))
  const rerendered = await sha256(editable.body) === current.kickoff.rendered
  if (rerendered) {
    const heading = current.body.split('\n')[0]
    editable.body = renderBody(current.kickoff.payload, next).replace('# ✦ 开个头', heading)
    editable.document.setIn(['kickoff', 'rendered'], await sha256(editable.body))
  }
  return { content: quoteDates(serializeEditableFrontmatter(editable)), rerendered }
}

export function carryPriorAnswers(oldDoc: KickoffDoc | null, runId: string): PriorAnswer[] {
  return oldDoc ? [...oldDoc.kickoff.prior_answers, ...oldDoc.kickoff.answers.map(a => ({ ...a, run_id: runId }))] : []
}
