import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), load: vi.fn(), set: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: mocks.load } }))
import { guestCommand, saveGuestToken } from './host'
import { parseGuestLink } from './link'
beforeEach(() => { vi.clearAllMocks(); mocks.load.mockResolvedValue({ set: mocks.set, save: mocks.save }) })
it('parsing the confirmation link never invokes or loads credentials', () => {
  parseGuestLink('https://host/2026-10-14-test#feedback=FIXTURE_TOKEN', false)
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled()
})
it('downloads with only the token-free identity, credentials stay in app-data Store', async () => {
  const { token, ...link } = parseGuestLink('https://host/2026-10-14-test#feedback=FIXTURE_TOKEN', false)
  await guestCommand('open', link)
  expect(mocks.invoke).toHaveBeenCalledWith('share_guest', { request: { op: 'open', ...link } })
  expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('FIXTURE_TOKEN')
  await saveGuestToken(link.origin, 'pid', token!)
  expect(mocks.load).toHaveBeenCalledWith('share_db.json')
  expect(mocks.set).toHaveBeenCalledWith('guest:https://host:pid', { token: 'FIXTURE_TOKEN' })
  expect(mocks.save).toHaveBeenCalledOnce()
})
it('rejects secret-bearing origin before opening the Store', async () => {
  await expect(saveGuestToken('https://user:FIXTURE_TOKEN@host', 'pid', 'FIXTURE_TOKEN')).rejects.toThrow('无效')
  expect(mocks.load).not.toHaveBeenCalled()
})

it('rejects an accidental full credential-bearing link before invoke', async () => {
  const link = parseGuestLink('https://host/2026-10-14-test#feedback=FIXTURE_TOKEN', false)
  await expect(guestCommand('open', { ...link })).rejects.toThrow('无效')
  expect(mocks.invoke).not.toHaveBeenCalled()
})
