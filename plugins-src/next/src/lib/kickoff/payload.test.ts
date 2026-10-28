import { describe, expect, it, vi } from 'vitest'
import fixture from './__fixtures__/payload.json'
import { parsePayload } from './payload'

const expected = { taskId: 'task-1', basedOn: 'sha256:abc' }
const fresh = (): any => structuredClone(fixture)
const parse = (value: unknown) => parsePayload(JSON.stringify(value), expected, async () => true)
const rejected = async (value: unknown, path: string) => {
  const result = await parse(value)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain(path)
}

describe('payload rejection rules', () => {
  const cases: [string, (p: any) => void][] = [
    ['schema', p => p.schema = 'v2'], ['task_id', p => p.task_id = 'other'], ['based_on', p => p.based_on = 'other'],
    ['summary', p => p.summary = ' '], ['summary', p => p.summary = '中'.repeat(201)],
    ['questions', p => p.questions = []], ['questions', p => p.questions = Array(4).fill(p.questions[0])],
    ['questions[1].id', p => p.questions.push(structuredClone(p.questions[0]))], ['questions[0].id', p => p.questions[0].id = 'q4'],
    ['questions[0].text', p => p.questions[0].text = ''], ['questions[0].text', p => p.questions[0].text = '😀'.repeat(201)],
    ['questions[0].decides', p => p.questions[0].decides = 'unknown'],
    ['questions[0].options', p => p.questions[0].options = []], ['questions[0].options', p => p.questions[0].options = Array(5).fill(p.questions[0].options[0])],
    ['questions[0].options[1].id', p => p.questions[0].options[1].id = 'a'], ['questions[0].options[0].id', p => p.questions[0].options[0].id = 'e'],
    ['questions[0].options[0].label', p => p.questions[0].options[0].label = ''], ['questions[0].options[0].label', p => p.questions[0].options[0].label = '中'.repeat(121)],
    ['questions[0].options[0].why', p => p.questions[0].options[0].why = '😀'.repeat(301)],
    ['questions[0].options', p => p.questions[0].options[1].recommended = true],
    ...['next_action', 'close_condition'].flatMap(key => [
      [`suggestions.${key}`, (p: any) => p.suggestions[key] = ''],
      [`suggestions.${key}`, (p: any) => p.suggestions[key] = '中'.repeat(201)],
    ] as [string, (p: any) => void][]),
    ['suggestions.commitment', p => p.suggestions.commitment = '😀'.repeat(121)],
    ['context', p => p.context = Array(9).fill(p.context[0])], ['context[0].claim', p => p.context[0].claim = ''],
    ['context[0].claim', p => p.context[0].claim = '中'.repeat(301)], ['context[0].kind', p => p.context[0].kind = 'guess'],
    ...['blockers', 'waiting_for', 'gaps'].flatMap(key => {
      const path = key === 'gaps' ? key : `suggestions.${key}`
      return [
        [path, (p: any) => (key === 'gaps' ? p : p.suggestions)[key] = Array(6).fill('x')],
        [`${path}[0]`, (p: any) => (key === 'gaps' ? p : p.suggestions)[key] = ['😀'.repeat(201)]],
      ] as [string, (p: any) => void][]
    }),
    ['sources', p => p.sources = Array(13).fill(p.sources[0])], ['sources[1].id', p => p.sources.push(structuredClone(p.sources[0]))],
    ['sources[0].id', p => p.sources[0].id = 's100'],
    ['questions[0].allow_free_text', p => p.questions[0].allow_free_text = 'yes'],
    ['questions[0].options[0].recommended', p => p.questions[0].options[0].recommended = 1],
    ['questions[0].options[0].source_ids', p => p.questions[0].options[0].source_ids = 's1'],
    ['context[0].source_ids[0]', p => p.context[0].source_ids = [null]],
  ]
  it.each(cases.map(([path, mutate], index) => ({ path, mutate, index })))('$index rejects $path', async ({path, mutate}) => {
    const p = fresh(); mutate(p); await rejected(p, path)
  })
  it.each([null, [], 1, 'text'])('rejects non object %s', async value => rejected(value, 'payload'))
  it.each(['summary', 'questions', 'context', 'suggestions', 'gaps', 'sources'])('rejects missing %s', async key => {
    const p = fresh(); delete p[key]; await rejected(p, key)
  })
  it('rejects malformed JSON and prose around JSON', async () => {
    for (const raw of ['{', `Explanation\n${JSON.stringify(fixture)}`, `${JSON.stringify(fixture)}\nDone`]) {
      expect((await parsePayload(raw, expected, async () => true)).ok).toBe(false)
    }
  })
  it('enforces raw UTF-8 64 KiB including whitespace', async () => {
    const raw = JSON.stringify(fixture)
    const bytes = new TextEncoder().encode(raw).length
    expect((await parsePayload(raw + ' '.repeat(65536 - bytes), expected, async () => true)).ok).toBe(true)
    expect((await parsePayload(raw + ' '.repeat(65537 - bytes), expected, async () => true)).ok).toBe(false)
  })
})

describe('payload normalization', () => {
  it('accepts fixture and strips only a single whole json fence', async () => {
    expect(await parse(fixture)).toEqual({ok:true, payload:fixture, repairs:[]})
    expect((await parsePayload(` \n\x60\x60\x60json\n${JSON.stringify(fixture)}\n\x60\x60\x60 \n`, expected, async () => true)).ok).toBe(true)
    for (const raw of [`\x60\x60\x60json\n${JSON.stringify(fixture)}\n\x60\x60\x60\n\x60\x60\x60json\n{}\n\x60\x60\x60`, `prefix\n\x60\x60\x60json\n${JSON.stringify(fixture)}\n\x60\x60\x60`]) {
      expect((await parsePayload(raw, expected, async () => true)).ok).toBe(false)
    }
  })
  it('accepts literal triple backticks inside JSON strings within a whole fence', async () => {
    const p = fresh(); p.summary = '检查 ``` 标记'
    const result = await parsePayload('```json\n' + JSON.stringify(p) + '\n```', expected, async () => true)
    expect(result).toEqual({ok:true, payload:p, repairs:[]})
  })
  it('counts emoji and Chinese by code point at all limits', async () => {
    const p = fresh(); p.summary = '😀中'.repeat(100); p.questions[0].text = '😀'.repeat(200)
    p.questions[0].options[0].label = '😀'.repeat(120); p.questions[0].options[0].why = '😀'.repeat(300)
    p.context[0].claim = '😀'.repeat(300); p.suggestions.commitment = '😀'.repeat(120)
    p.suggestions.next_action = '😀'.repeat(200); p.suggestions.close_condition = '中'.repeat(200)
    p.suggestions.blockers = ['😀'.repeat(200)]; p.suggestions.waiting_for = ['中'.repeat(200)]; p.gaps = ['😀'.repeat(200)]
    expect((await parse(p)).ok).toBe(true)
  })
  it.each(['/etc/passwd', '../secret', 'dir/../secret', 'dir\0secret', 'missing.md'])('deletes invalid source %s and dangling references', async resource => {
    const p = fresh(); p.sources[0].resource = resource
    const exists = vi.fn(async () => resource !== 'missing.md')
    const result = await parsePayload(JSON.stringify(p), expected, exists)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.sources).toEqual([])
    expect(result.payload.questions[0].options[0].source_ids).toEqual([])
    expect(result.payload.context[0]).toEqual({claim:p.context[0].claim, kind:'inference', source_ids:[], unverified:true})
    expect(result.repairs.length).toBeGreaterThan(0)
    if (resource !== 'missing.md') expect(exists).not.toHaveBeenCalled()
  })
  it('drops unknown source ids, retaining valid fact evidence', async () => {
    const p = fresh(); p.context[0].source_ids.push('s99'); p.questions[0].options[0].source_ids.push('s99')
    const result = await parse(p); expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.context[0].kind).toBe('fact'); expect(result.payload.context[0].source_ids).toEqual(['s1'])
    expect(result.payload.questions[0].options[0].source_ids).toEqual(['s1']); expect(result.repairs.length).toBeGreaterThan(0)
  })
  it('downgrades facts without any sources', async () => {
    const p = fresh(); p.context[0].source_ids = []
    const result = await parse(p)
    expect(result.ok && result.payload.context[0].unverified).toBe(true)
  })
  it('removes unknown keys at every object and marks each repair', async () => {
    const p = fresh()
    for (const object of [p, p.questions[0], p.questions[0].options[0], p.context[0], p.suggestions, p.sources[0]]) object.extra = 'discard'
    const result = await parse(p); expect(result.ok).toBe(true)
    if (result.ok) { expect(result.payload).toEqual(fixture); expect(result.repairs).toHaveLength(6) }
  })
  it('retains an inference without evidence and accepts dot-dot inside a path segment', async () => {
    const p = fresh(); p.context[0].kind = 'inference'; p.context[0].source_ids = []
    p.sources[0].resource = 'diary/name..part.md'
    const result = await parse(p)
    expect(result.ok && result.payload).toEqual(p)
    expect(result.ok && result.repairs).toEqual([])
  })
  it('defaults omitted why, recommended, and allow_free_text', async () => {
    const p = fresh(); delete p.questions[0].allow_free_text; delete p.questions[0].options[0].why; delete p.questions[0].options[0].recommended
    const result = await parse(p); expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.questions[0].allow_free_text).toBe(true)
      expect(result.payload.questions[0].options[0]).toMatchObject({why:'', recommended:false})
      expect(result.repairs).toHaveLength(3)
    }
  })
})

it.each(['https://example.org/article', 'http://example.org/article?q=hello'])('preserves a permitted web citation %s', async resource => {
  const p = fresh(); p.sources[0].resource = resource
  const result = await parse(p)
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.payload.sources[0].resource).toBe(resource)
})

it.each(['javascript:alert(1)', 'file:///secret', '//example.org/page', 'https://user:secret@example.org', 'https://example.org/\\evil', 'https://example.org/\nspoof', '.notemd/config.json', 'diary/../secret.md', 'C:\\secret.md', '/vault/note.md'])('removes unsafe research source %s before IO', async resource => {
  const p = fresh(); p.sources[0].resource = resource
  const exists = vi.fn(async () => true)
  const result = await parsePayload(JSON.stringify(p), expected, exists)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.payload.sources).toEqual([])
    expect(result.payload.context[0].kind).toBe('inference')
  }
  expect(exists).not.toHaveBeenCalled()
})
