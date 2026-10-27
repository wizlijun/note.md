import { expect, it } from 'vitest'
import { interpretKickoffStatus, formatElapsed } from './status'
it.each([[0, '0:00'], [599000, '9:59'], [3599000, '59:59'], [3600000, '1:00:00'], [-1, '0:00']])('formats %s', (ms, s) => expect(formatElapsed(ms as number)).toBe(s))
it('interprets running absolute time', () => expect(interpretKickoffStatus({
  state: 'running', started_at: 'then', steps: 2, last: 'read'
})).toMatchObject({
  state: 'running', started_at: 'then', steps: 2, last: 'read'
}))
it('keeps successful content and timestamps', () => expect(interpretKickoffStatus({
  state: 'done', record: {
    status: 'success', started_at: 'a', ended_at: 'b'
  }, terminal_result: {
    content: '{}'
  }
})).toMatchObject({
  state: 'success', content: '{}', started_at: 'a', ended_at: 'b'
}))
it('missing result fails', () => expect(interpretKickoffStatus({
  state: 'done', record: {
    status: 'success'
  }, terminal_result: null
})).toMatchObject({
  state: 'failed', failure: {
    kind: 'missing-result'
  }
}))
it.each(['skipped', 'error', 'timeout', 'cancelled'])('preserves %s failure', kind => expect(interpretKickoffStatus({
  state: 'done', warning: 'warn', record: {
    status: kind, stderr_tail: 'bad', result: 'fallback'
  }
})).toMatchObject({
  state: 'failed', failure: {
    kind, message: 'bad', warning: 'warn'
  }
}))
it('uses result fallback', () => expect(interpretKickoffStatus({
  state: 'done', record: {
    status: 'error', result: 'fallback'
  }
})).toMatchObject({
  failure: {
    message: 'fallback'
  }
}))
it.each([null, {}, 'bad', {
    state: 'done'
  }])('unknown response is lost', raw => expect(interpretKickoffStatus(raw)).toMatchObject({
  state: 'failed', failure: {
    kind: 'lost'
  }
}))
it('preserves raw failure details', () => expect(interpretKickoffStatus({
  state: 'done', record: {
    status: 'error', warning: 'credential', rawSnippet: 'raw'
  }
})).toMatchObject({
  failure: {
    warning: 'credential', rawSnippet: 'raw'
  }
}))
it('preserves actual successful provider metadata', () => expect(interpretKickoffStatus({
  state: 'done', record: {
    status: 'success', harness: 'notemd.codex-agent', model: 'model', started_at: 'a', ended_at: 'b'
  }, terminal_result: {
    content: '{}'
  }
})).toMatchObject({
  state: 'success', harness: 'notemd.codex-agent', model: 'model', started_at: 'a', ended_at: 'b'
}))
