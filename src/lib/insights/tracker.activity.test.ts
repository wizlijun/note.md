// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ focus: null as null | ((event: { payload: boolean }) => void),
  focused: true, tab: null as null | { filePath: string; kind: string; mode: string },
  begin: vi.fn(), attention: vi.fn(), flush: vi.fn(async () => {}), accrue: vi.fn() }))
vi.mock('../tabs.svelte', () => ({ activeTab: () => mocks.tab }))
vi.mock('../sotvault.svelte', () => ({ sotvaultStore: { vaultRoot: '/vault' } }))
vi.mock('../settings.svelte', () => ({ getDeviceId: () => 'test-device' }))
vi.mock('@tauri-apps/plugin-os', () => ({ hostname: async () => 'test' }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  isFocused: async () => mocks.focused,
  onFocusChanged: async (handler: typeof mocks.focus) => { mocks.focus = handler; return () => {} },
}) }))
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: vi.fn(), mkdir: vi.fn(), readDir: vi.fn(), readTextFile: vi.fn(), writeTextFile: vi.fn() }))
vi.mock('./store.svelte', () => ({ createAnalyticsStore: () => ({
  preloadToday: async () => {}, accrue: mocks.accrue, sessionStart() {}, sessionExtend() {}, sessionClose() {}, flush: async () => {},
}) }))
vi.mock('../home-content/store.svelte', () => ({ beginHomeVisit: mocks.begin, recordHomeAttention: mocks.attention, flushHomeContent: mocks.flush }))

import { installTracker, onActiveDocChanged, onNativeUserEdit, recordEditorDelta } from './tracker.svelte'
let dispose: (() => void | Promise<void>) | undefined
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.clearAllMocks()
  mocks.tab = { filePath: '/vault/book.md', kind: 'markdown', mode: 'rich' }; mocks.focused = true
})
afterEach(async () => { await dispose?.(); dispose = undefined; vi.useRealTimers() })

describe('home attention uses the real tracker lifecycle', () => {
  it('credits only the foreground document, then binds a replacement after closing', async () => {
    dispose = await installTracker()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.attention.mock.calls.reduce((n, [, ms]) => n + ms, 0)).toBe(30_000)
    mocks.focus?.({ payload: false })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.attention.mock.calls.reduce((n, [, ms]) => n + ms, 0)).toBe(30_000)
    mocks.tab = { filePath: '/vault/next.pdf', kind: 'custom', mode: 'rich' }
    onActiveDocChanged()
    mocks.attention.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.attention).not.toHaveBeenCalled()
    mocks.focus?.({ payload: true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.attention).toHaveBeenLastCalledWith('/vault/next.pdf', 5_000, expect.any(Number))
    mocks.tab = null; onActiveDocChanged()
    expect(mocks.begin).toHaveBeenLastCalledWith(null, '/vault')
  })

  it('does not count restored background windows or repeat activation as new visits', async () => {
    mocks.focused = false
    dispose = await installTracker()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.attention).not.toHaveBeenCalled()
    const calls = mocks.begin.mock.calls.length
    onActiveDocChanged()
    expect(mocks.begin).toHaveBeenCalledTimes(calls)
  })

  it('counts source-mode attention without claiming an edit and resumes native input after idle', async () => {
    mocks.tab!.mode = 'source'
    dispose = await installTracker()
    await vi.advanceTimersByTimeAsync(65_000)
    expect(mocks.accrue.mock.calls.some(([, patch]) => patch.edit_sessions)).toBe(false)
    mocks.attention.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.attention).not.toHaveBeenCalled()
    onNativeUserEdit('/vault/other.md')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.attention).not.toHaveBeenCalled()
    onNativeUserEdit('/vault/book.md')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.attention).toHaveBeenLastCalledWith('/vault/book.md', 5_000, expect.any(Number))
    recordEditorDelta({ markOps: 0, sizeDelta: -1 })
    expect(mocks.accrue).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ edit_sessions: 1 }), expect.any(Number))
  })
})
