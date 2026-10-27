import { expect, it } from 'vitest'
import { kickoffEligible, kickoffButtonState, kickoffCardView } from './button-state'
import type { WorkspaceItem } from '../repository'
const item = {
  kind: 'task', path: 'inbox/tasks/a-task.md', orphan: false, state: 'capture', task: {
    id: '8afad9c5-1234-4234-8234-123456789abc'
  }
} as WorkspaceItem
it('accepts eligible task lanes', () => {
  for (const state of ['capture', 'wip', 'waiting', 'dormant'])
    expect(kickoffEligible({
      ...item, state
    } as WorkspaceItem)).toBe(true)
})
it.each([{
    kind: 'idea'
  }, {
    path: undefined
  }, {
    path: '../x.md'
  }, {
    orphan: true
  }, {
    repairReason: 'broken'
  }, {
    task: {
      id: 'bad'
    }

  }, {
    state: 'closed'
  }, {
    state: 'unsupported'
  }])('rejects invalid card %o', patch => expect(kickoffEligible({
  ...item, ...patch
} as WorkspaceItem)).toBe(false))
it('derives all seven states', () => {
  expect(kickoffButtonState({})).toBe('idle')
  expect(kickoffButtonState({
    starting: true
  })).toBe('starting')
  expect(kickoffButtonState({
    run: {
      state: 'running'
    } as never
  })).toBe('running')
  expect(kickoffButtonState({
    run: {
      state: 'failed'
    } as never
  })).toBe('failed')
  expect(kickoffButtonState({
    result: {
      based_on: 'hash'
    }, taskHash: 'hash', unread: true
  })).toBe('ready-unread')
  expect(kickoffButtonState({
    result: {
      based_on: 'hash'
    }, taskHash: 'hash'
  })).toBe('ready')
  expect(kickoffButtonState({
    result: {
      based_on: 'old'
    }, taskHash: 'new', unread: true
  })).toBe('stale')
})
it('restores elapsed time from absolute timestamps', () => {
  const run = {
    state: 'running', requested_at: '2026-10-27T00:00:00Z'
  } as never
  const now = Date.parse('2026-10-27T00:02:00Z')
  expect(kickoffCardView({
    run
  }, now).elapsedMs).toBe(120000)
  expect(kickoffCardView({
    run, status: {
      state: 'running', started_at: '2026-10-27T00:01:00Z', steps: 3, last: 'read'
    }
  }, now)).toMatchObject({
    elapsedMs: 60000, steps: 3, last: 'read'
  })
})

it.each(['', 'invalid'])('uses requested time for real host starting response started_at=%j', started_at => {
  const view = kickoffCardView({
    run: { state: 'running', requested_at: '2026-10-27T00:00:00Z' } as never,
    status: { state: 'running', started_at, steps: 0, last: 'starting' },
  }, Date.parse('2026-10-27T00:02:00Z'))
  expect(view).toMatchObject({ state: 'running', elapsedMs: 120000, steps: 0, last: 'starting' })
})
