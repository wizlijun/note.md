import { describe, expect, it } from 'vitest'
import { parseRegistry, serializeRegistry, markRunning, markFailed, clearRun, markUnread, markRead } from './registry'
const run = {
  run_id: 'r', harness: 'h', requested_at: '2026-10-27T00:00:00Z', task_path: 'inbox/tasks/a-task.md', based_on: 'sha256:x', state: 'running' as const, failure: null
}
describe('registry', () => {
  it.each([null, '{', '{}', '{"version":1,"runs":{},"unread":false}', '{"version":1,"runs":{"x":{}},"unread":[]}'])('falls back safely: %s', raw => expect(parseRegistry(raw)).toEqual({
    version: 1, runs: {}, unread: []
  }))
  it('roundtrips and never mutates inputs', () => {
    const empty = parseRegistry(null)
    const before = JSON.stringify(empty)
    const running = markRunning(empty, 't', run)
    const failed = markFailed(running, 't', {
      kind: 'error', message: 'bad', at: 'now', warning: 'warn', rawSnippet: 'raw'
    })
    expect(running.runs.t.state).toBe('running')
    expect(parseRegistry(serializeRegistry(failed))).toEqual(failed)
    expect(clearRun(failed, 't').runs).toEqual({})
    const unread = markUnread(empty, 't')
    expect(markUnread(unread, 't').unread).toEqual(['t'])
    expect(markRead(unread, 't').unread).toEqual([])
    expect(unread.unread).toEqual(['t'])
    expect(JSON.stringify(empty)).toBe(before)
  })
})

it('roundtrips a real failed start without pretending it has a host run id', () => {
  const registry = { version: 1, unread: [], runs: { task: { ...run, run_id: null, state: 'failed', failure: { kind: 'start-error', message: 'refused', at: '2026-10-27T01:00:00Z' } } } }
  expect(parseRegistry(JSON.stringify(registry))).toEqual(registry)
})

it.each([null, '', '   '])('requires a nonempty host run id for running state: %s', runId => {
  const raw = JSON.stringify({ version: 1, unread: [], runs: { task: { ...run, run_id: runId } } })
  expect(parseRegistry(raw).runs).toEqual({})
})


it('preserves frozen provenance across reload and fails closed on malformed evidence scope', () => {
  const value = { version: 1, unread: [], runs: { t: { ...run, context_paths: ['inbox/tasks/a-task.md'], task_template: 'next-task-kickoff-v2' } } }
  expect(parseRegistry(JSON.stringify(value))).toEqual(value)
  const malformed = { ...value, runs: { t: { ...value.runs.t, context_paths: 'all files', task_template: '../other' } } }
  expect(parseRegistry(JSON.stringify(malformed)).runs.t.context_paths).toEqual([])
  expect(parseRegistry(JSON.stringify(malformed)).runs.t.task_template).toBeUndefined()
})
