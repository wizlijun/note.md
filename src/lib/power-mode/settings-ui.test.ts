/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
const mocks = vi.hoisted(() => ({ load: vi.fn(), setPowerMode: vi.fn(), destroy: vi.fn(), mount: vi.fn() }))
vi.mock('../../../plugins-src/power-mode/src/lib/bridge', () => ({
  bridge: () => ({ locale: 'zh' }), loadPowerMode: mocks.load, savePowerMode: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../../plugins-src/power-mode/src/lib/editor-kit', () => ({ loadKit: async () => mocks.mount }))
import App from '../../../plugins-src/power-mode/src/App.svelte'
let app: ReturnType<typeof mount> | undefined
let target: HTMLDivElement
// Fixtures exercise actual settings UI without a real Vault or native window.
afterEach(async () => { if (app) await unmount(app); app = undefined; target?.remove(); vi.clearAllMocks() })
it('shows missing-image fallback and keeps self-managed preview preferences when resources return', async () => {
  target = document.createElement('div'); document.body.append(target)
  mocks.load.mockResolvedValue({ config: { explosion: { presetId: 'coin' } }, surfaces: [], assets: { status: 'missing', base: null } })
  mocks.mount.mockResolvedValue({ setPowerMode: mocks.setPowerMode, destroy: mocks.destroy })
  app = mount(App, { target })
  await vi.waitFor(() => expect(target.textContent).toContain('请更新狂暴模式插件'))
  await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ powerMode: expect.objectContaining({ explosion: { enable: true, presetId: 'coin' } }) })))
  mocks.load.mockResolvedValue({ config: {}, surfaces: [], assets: { status: 'ready', base: '/__power_mode__/' } })
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(target.textContent).not.toContain('请更新狂暴模式插件'))
  expect((target.querySelector('select') as HTMLSelectElement).value).toBe('coin')
})
