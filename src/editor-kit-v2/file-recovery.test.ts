import { expect, it } from 'vitest'
import { acknowledgeSaved, recoveryFromSnapshot } from './file-recovery'
import { open as controller } from './file-test-utils'

it('recovery is detached and frozen, and acknowledged generations only increase', () => {
  const c = controller('A'), first = c.snapshot(), recovery = recoveryFromSnapshot(first)
  expect(recovery).toEqual({ v: 1, sourceHash: first.sourceHash, sourceRevision: first.sourceRevision, bindings: first.bindings })
  expect(recovery.bindings).not.toBe(first.bindings); expect(Object.isFrozen(recovery.bindings[0])).toBe(true)
  c.restoreContent('B'); const next = c.snapshot(), saved = acknowledgeSaved(undefined, next)
  expect(acknowledgeSaved(saved, first)).toBe(saved)
  expect(c.runHistory('undo', true)).toBe(true)
})
