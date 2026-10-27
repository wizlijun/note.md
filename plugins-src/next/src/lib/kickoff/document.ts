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

export function parseKickoffDocument(content: string): KickoffDoc | null {
  try {
    const { document, body } = editableFrontmatter(content, false)
    const metadata = document.toJS() as Record<string, unknown>
    const k = metadata.kickoff as KickoffData | undefined
    if (metadata.type !== CONCEPT_TYPE.taskKickoff || !k || k.version !== 1 || k.schema !== 'next-kickoff/v1' || !k.payload || k.task_id !== k.payload.task_id || !Array.isArray(k.answers) || !Array.isArray(k.prior_answers))
      return null
    return { raw: content, metadata, kickoff: k, body }
  }
  catch {
    return null
  }
}

export async function withAnswers(doc: KickoffDoc, answers: KickoffAnswer[], now: string): Promise<{
  content: string
  rerendered: boolean
}> {
  const editable = editableFrontmatter(doc.raw, false)
  const current = parseKickoffDocument(doc.raw)
  if (!current || current.kickoff.task_id !== doc.kickoff.task_id)
    throw new Error('Kickoff task identity mismatch')
  const merged = new Map(current.kickoff.answers.map(a => [a.question_id, a]))
  for (const a of answers) {
    if (!/^human:.+/.test(a.by))
      throw new Error('Answer actor must use human: prefix')
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
