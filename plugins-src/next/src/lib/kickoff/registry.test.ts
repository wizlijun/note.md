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
