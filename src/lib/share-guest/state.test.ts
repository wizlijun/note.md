import { expect, it, vi } from 'vitest'
vi.mock('./host', () => ({guestCommand:vi.fn(),retryGuestOutbox:vi.fn(),canSubmitGuest:vi.fn()}))
import { receiveGuestUrl, finishGuestBootstrap, closeGuestLink, guestState, guestForTab } from './state.svelte'
it('queues before Vault readiness, deduplicates event/current delivery, and permits deliberate reopen after cancel', () => {
  const url='notemd://share/open?u='+encodeURIComponent('https://host/2026-10-14-test#feedback=secret')
  expect(receiveGuestUrl(url)).toBe(true); expect(receiveGuestUrl(url)).toBe(true)
  expect(guestState.ready).toBe(false);expect(guestState.links).toHaveLength(1)
  closeGuestLink();receiveGuestUrl(url);expect(guestState.links).toHaveLength(0)
  finishGuestBootstrap();receiveGuestUrl(url);expect(guestState.links).toHaveLength(1)
  closeGuestLink();receiveGuestUrl(url);expect(guestState.links).toHaveLength(1)
  closeGuestLink()
  expect(receiveGuestUrl('notemd://wrong?secret')).toBe(true)
  expect(guestState.links).toHaveLength(0)
  expect(guestState.error).not.toContain('secret')
  expect(receiveGuestUrl('file:///ordinary.md')).toBe(false)
})
it('does not infer trusted membership just from a received path', () => {
  expect(guestForTab({filePath:'/vault/received/host/pid/a.md'} as any)).toBeUndefined()
})
