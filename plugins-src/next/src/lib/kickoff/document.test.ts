import { describe, it, expect } from 'vitest'
import { editableFrontmatter, serializeEditableFrontmatter } from '../frontmatter-document'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import payload from './__fixtures__/payload.json'
import { buildKickoffDocument, parseKickoffDocument, kickoffPathFor, renderBody, withAnswers, carryPriorAnswers } from './document'
import type { KickoffPayload } from './payload'
const p = payload as KickoffPayload
const input = { payload:p, taskTitle:'发布构建', taskPath:'inbox/tasks/demo-task.md', runId:'run-1', endedAt:'2026-10-27T13:05:00Z', durationSeconds:245, providerId:'claude-agent' }
const answer = { question_id:'q1', question:p.questions[0].text, decides:p.questions[0].decides, option_id:'a', answer:'检查配置', by:'human:owner', at:'2026-10-27T13:10:00Z' }
describe('kickoff document', () => {
  it('passes OKF lint on an isolated generated document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'next-kickoff-okf-'))
    try {
      await mkdir(join(root, 'inbox/tasks'), {recursive:true})
      await writeFile(join(root, kickoffPathFor(input.taskPath)), await buildKickoffDocument(input))
      expect(execFileSync('node', ['../../scripts/okf-lint.mjs', root], {encoding:'utf8'})).toContain('全部满足硬约束')
    } finally { await rm(root, {recursive:true, force:true}) }
  })
  it('maps only safe task paths', () => {
    expect(kickoffPathFor(input.taskPath)).toBe('inbox/tasks/demo-task.kickoff.md')
    for (const path of ['../task.md','/inbox/tasks/t.md','inbox/tasks/../t.md','inbox/tasks/a\\b.md','inbox/tasks/a.kickoff.md']) expect(() => kickoffPathFor(path)).toThrow()
  })
  it('builds complete OKF metadata with actor fallback and quoted dates', async () => {
    const text = await buildKickoffDocument(input)
    const d = parseKickoffDocument(text)!
    expect(d.metadata.type).toBe('Task Kickoff')
    expect(d.metadata.title).toBe('开个头：发布构建')
    expect(d.metadata.description).toBe(p.summary)
    expect(d.metadata.sources).toEqual([{resource:input.taskPath},...p.sources.map(s=>({resource:s.resource}))])
    expect(d.metadata.generated).toEqual({by:'process:claude-agent',at:input.endedAt})
    expect(d.kickoff).toMatchObject({version:1,schema:p.schema,task_id:p.task_id,based_on:p.based_on,harness:'claude-agent',run_id:'run-1',duration_seconds:245,repairs:[],payload:p,answers:[],prior_answers:[]})
    expect(d.kickoff.rendered).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(text).toContain('"2026-10-27T13:05:00Z"')
    expect(parseKickoffDocument(await buildKickoffDocument({...input,harness:'notemd.codex-agent'}))!.metadata.generated).toMatchObject({by:'process:codex-agent'})
  })
  it('renders stable agent content and human answers', () => {
    const before = JSON.stringify(p)
    expect(renderBody(p,[answer])).toMatchInlineSnapshot(`
      "# ✦ 开个头

      ✦ 确认发布的第一步

      ## 需要你回答

      ### ● 先检查哪一项？

      - 检查配置（建议）：配置影响发布 [s1]
      - 检查构建

      ● 检查配置

      ## ✦ 已知背景

      - 上次缺少配置 [s1]

      ## ✦ 建议

      - 承诺：提交构建
      - 下一步：打开配置文件并核对账号
      - 结束条件：构建通过

      ## ✦ 没查到的


      ## ✦ 来源

      - [s1] [发布记录](diary/release.note.md) · ## 发布
      "
    `)
    expect(JSON.stringify(p)).toBe(before)
    expect(renderBody(p,[answer])).toContain('●')
    expect(renderBody(p)).toContain('✦')
  })
  it('round trips and preserves unknown metadata when answering', async () => {
    const initial = await buildKickoffDocument(input)
    const unknown = initial.replace('---\n','---\ncustom: keep\n').replace('kickoff:\n','kickoff:\n  future: keep\n')
    const result = await withAnswers(parseKickoffDocument(unknown)!,[answer,{...answer,answer:'new'}],answer.at)
    expect(result.rerendered).toBe(true)
    const d = parseKickoffDocument(result.content)!
    expect(d.metadata.custom).toBe('keep')
    expect(d.kickoff.future).toBe('keep')
    expect(d.kickoff.answers).toEqual([{...answer,answer:'new'}])
    expect(d.kickoff.payload).toEqual(p)
    expect(d.body).toBe(renderBody(p,d.kickoff.answers).replace('# ✦ 开个头', '# ✦ 开个头：发布构建'))
    await expect(withAnswers(parseKickoffDocument(initial)!,[{...answer,by:'process:agent'}],answer.at)).rejects.toThrow()
  })
  it('protects every manually edited body byte', async () => {
    const initial = await buildKickoffDocument(input)
    const edited = initial + '\r\n人工修改\r\n'
    const result = await withAnswers(parseKickoffDocument(edited)!,[answer],answer.at)
    expect(result.rerendered).toBe(false)
    expect(parseKickoffDocument(result.content)!.body).toBe(parseKickoffDocument(edited)!.body)
  })
  it('rejects malformed documents and task identity changes', async () => {
    expect(parseKickoffDocument('no frontmatter')).toBeNull()
    expect(parseKickoffDocument('---\ntype: Note\n---\n')).toBeNull()
    const doc = parseKickoffDocument(await buildKickoffDocument(input))!
    await expect(withAnswers({...doc,kickoff:{...doc.kickoff,task_id:'other'}},[answer],answer.at)).rejects.toThrow('identity')
  })
  it('repeated saves overwrite a question and keep a valid render hash', async () => {
    const first = await withAnswers(parseKickoffDocument(await buildKickoffDocument(input))!,[answer],answer.at)
    const second = await withAnswers(parseKickoffDocument(first.content)!,[{...answer,answer:'changed'}],'2026-10-27T14:00:00Z')
    expect(second.rerendered).toBe(true)
    expect(parseKickoffDocument(second.content)!.kickoff.answers).toEqual([{...answer,answer:'changed',at:'2026-10-27T14:00:00Z'}])
  })
  it('carries old answers with their original runs', async () => {
    const previous = {...answer,run_id:'older'}
    const initial = await buildKickoffDocument({...input,priorAnswers:[previous]})
    const saved = await withAnswers(parseKickoffDocument(initial)!,[answer],answer.at)
    const old = parseKickoffDocument(saved.content)!
    const before = JSON.stringify(old)
    expect(carryPriorAnswers(old,'run-1')).toEqual([previous,{...answer,run_id:'run-1'}])
    expect(JSON.stringify(old)).toBe(before)
    expect(carryPriorAnswers(null,'run-1')).toEqual([])
  })
})

it.each([
  ['payload.questions', null], ['payload.questions.0.options', null],
  ['payload.questions.0.options.0.source_ids', [null]], ['payload.questions.0.options.0.recommended', 'yes'],
  ['payload.context', [null]], ['payload.context.0.claim', null],
  ['payload.suggestions', null], ['payload.suggestions.blockers', [null]],
  ['payload.sources', [null]], ['payload.sources.0.resource', null], ['payload.gaps', [null]],
  ['task_id', null], ['based_on', 'different'], ['payload.task_id', null],
  ['answers', [null]], ['prior_answers', [null]], ['run_id', ''], ['rendered', null],
])('rejects damaged persisted %s without modifying original bytes', async (path, value) => {
  const text = await buildKickoffDocument(input)
  const editable = editableFrontmatter(text, false)
  editable.document.setIn(['kickoff', ...path.split('.').map(p => /^\d+$/.test(p) ? Number(p) : p)], value)
  const damaged = serializeEditableFrontmatter(editable)
  expect(parseKickoffDocument(damaged)).toBeNull()
  await expect(withAnswers({ ...parseKickoffDocument(text)!, raw: damaged }, [answer], answer.at)).rejects.toThrow()
  expect(serializeEditableFrontmatter(editable)).toBe(damaged)
})

it.each([
  { by: 'process:agent' }, { at: 'invalid' }, { question_id: 'q9' },
  { option_id: 'z' }, { decides: 'wrong' }, { answer: null }, { question: null },
])('rejects damaged current answer %o', async patch => {
  const editable = editableFrontmatter(await buildKickoffDocument(input), false)
  editable.document.setIn(['kickoff', 'answers'], [{ ...answer, ...patch }])
  expect(parseKickoffDocument(serializeEditableFrontmatter(editable))).toBeNull()
})

it('preserves historical answers from different questions and valid unverified context', async () => {
  const old = { ...answer, question_id: 'q3', option_id: 'd', question: '旧问题', run_id: 'old-run' }
  const text = await buildKickoffDocument({ ...input, model: 'test-model', priorAnswers: [old] })
  const editable = editableFrontmatter(text, false)
  editable.document.setIn(['kickoff', 'payload', 'context', 0, 'unverified'], true)
  const doc = parseKickoffDocument(serializeEditableFrontmatter(editable))!
  expect(doc.kickoff.model).toBe('test-model')
  expect(doc.kickoff.prior_answers).toEqual([old])
  expect(doc.kickoff.payload.context[0].unverified).toBe(true)
  expect(carryPriorAnswers(doc, 'run-1')).toEqual([old])
  editable.document.setIn(['kickoff', 'prior_answers', 0, 'run_id'], '')
  expect(parseKickoffDocument(serializeEditableFrontmatter(editable))).toBeNull()
})

it.each([
  { by: 'process:agent' }, { at: 'invalid' }, { run_id: null }, { option_id: 2 }, { question_id: null },
])('rejects damaged prior answer %o without silently discarding it', async patch => {
  const editable = editableFrontmatter(await buildKickoffDocument(input), false)
  editable.document.setIn(['kickoff', 'prior_answers'], [{ ...answer, run_id: 'old', ...patch }])
  expect(parseKickoffDocument(serializeEditableFrontmatter(editable))).toBeNull()
})

it('rejects duplicate current answer IDs', async () => {
  const editable = editableFrontmatter(await buildKickoffDocument(input), false)
  editable.document.setIn(['kickoff', 'answers'], [answer, answer])
  expect(parseKickoffDocument(serializeEditableFrontmatter(editable))).toBeNull()
})

it('keeps historical citations readable without discarding saved human answers', async () => {
  const raw = await buildKickoffDocument(input)
  const editable = editableFrontmatter(raw, false)
  editable.document.setIn(['kickoff', 'payload', 'sources', 0, 'resource'], 'diary/meeting:notes.md')
  editable.document.setIn(['kickoff', 'answers'], [answer])
  const historic = parseKickoffDocument(serializeEditableFrontmatter(editable))
  expect(historic?.kickoff.payload.sources[0].resource).toBe('diary/meeting:notes.md')
  expect(historic?.kickoff.answers).toEqual([answer])
})
