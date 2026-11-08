// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import SumiRecovery from './SumiRecovery.svelte'
import type { RecoveryProbe } from '../lib/sumi/recovery'
const mocks = vi.hoisted(() => ({ probe: vi.fn(), recover: vi.fn(), open: vi.fn(), invoke: vi.fn(), detach: vi.fn(), owner: vi.fn() }))
vi.mock('../lib/sumi/recovery', () => ({ probeRecovery: mocks.probe, recoverNewPage: mocks.recover }))
vi.mock('../lib/tabs.svelte', () => ({ openFile: mocks.open }))
vi.mock('../lib/sumi/session', () => ({ detachSumiSurface: mocks.detach, sumiOwner: mocks.owner }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
let component: ReturnType<typeof mount> | undefined
const props = { path: '/vault/source.writing.md', pluginId: 'notemd.sumi', tabId: 'tab', onrestored: vi.fn() }
function evidence(hash = 'a'): RecoveryProbe {
  return { evidence: { vault: '/vault', path: props.path, markdown_sha256: hash, metadata_path: '/vault/source.writing.meta.json', metadata_sha256: null }, status: 'damaged_metadata', known_page: false, preserve_line_times: false, normalize_crlf: false, warnings: ['存在多个匹配元数据候选，无法唯一配对；新纸页行时间将标为未知。'] }
}
async function settled() { await Promise.resolve(); await tick(); await Promise.resolve(); await tick() }
function button(label: string): HTMLButtonElement { const result = Array.from(document.querySelectorAll('button')).find(b => b.textContent === label); if (!result) throw new Error(`missing ${label}`); return result }
async function click(label: string) { button(label).click(); await settled() }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.probe.mockReset().mockResolvedValue(evidence())
  mocks.recover.mockReset().mockResolvedValue({ page_id: 'new', path: '/vault/new.writing.md', preserved_line_times: false })
  mocks.open.mockResolvedValue(undefined)
  mocks.invoke.mockResolvedValue(undefined)
})
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.innerHTML = '' })
describe('SumiRecovery rendered controls', () => {
  it('shows pairing warnings and retries a lost response with the same operation after re-probing identical evidence', async () => {
    component = mount(SumiRecovery, { target: document.body, props }); await settled()
    expect(document.body.textContent).toContain('存在多个匹配元数据候选')
    mocks.recover.mockRejectedValueOnce(new Error('response lost'))
    await click('恢复为新的一页')
    expect(document.body.textContent).toContain('response lost')
    const originalId = mocks.recover.mock.calls[0][1]
    await click('重新检查源文件')
    await click('恢复为新的一页')
    expect(mocks.recover.mock.calls[1][1]).toBe(originalId)
    expect(mocks.open).toHaveBeenCalledWith('/vault/new.writing.md')
    expect(mocks.probe).toHaveBeenCalledTimes(2)
  })
  it('changes operation only for new evidence and requires renewed CRLF consent', async () => {
    mocks.probe.mockResolvedValue({ ...evidence(), normalize_crlf: true })
    component = mount(SumiRecovery, { target: document.body, props }); await settled()
    expect(button('恢复为新的一页').disabled).toBe(true)
    document.querySelector<HTMLInputElement>('input')!.click(); await settled()
    await click('恢复为新的一页')
    const firstId = mocks.recover.mock.calls[0][1]
    mocks.probe.mockResolvedValue({ ...evidence('changed'), normalize_crlf: true })
    await click('重新检查源文件')
    expect(button('恢复为新的一页').disabled).toBe(true)
    document.querySelector<HTMLInputElement>('input')!.click(); await settled()
    await click('恢复为新的一页')
    expect(mocks.recover.mock.calls[1][1]).not.toBe(firstId)
    expect(mocks.recover.mock.calls[1][2]).toBe(true)
    // Returning to exactly the earlier evidence must still reuse its operation.
    mocks.probe.mockResolvedValue({ ...evidence(), normalize_crlf: true })
    await click('重新检查源文件')
    document.querySelector<HTMLInputElement>('input')!.click(); await settled()
    await click('恢复为新的一页')
    expect(mocks.recover.mock.calls[2][1]).toBe(firstId)
  })
  it('exposes initial probe failures and lets the user inspect again instead of hiding every control', async () => {
    mocks.probe.mockRejectedValueOnce(new Error('文件对发生变化'))
    component = mount(SumiRecovery, { target: document.body, props }); await settled()
    expect(document.body.textContent).toContain('文件对发生变化')
    expect(button('重新检查源文件').disabled).toBe(false)
    await click('重新检查源文件')
    expect(button('恢复为新的一页').disabled).toBe(false)
  })
  it('opens the standalone page for a durable empty recovery and ignores a response after unmount', async () => {
    mocks.recover.mockResolvedValueOnce({ page_id: 'new', path: null, preserved_line_times: false })
    component = mount(SumiRecovery, { target: document.body, props }); await settled()
    await click('恢复为新的一页')
    expect(mocks.invoke).toHaveBeenCalledWith('plugin_v2_open_window', { pluginId: 'notemd.sumi', windowId: 'main', seed: { kind: 'sumi-navigation', pageId: 'new', action: 'open_page' } })
    let finish!: (result: unknown) => void
    mocks.recover.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    button('恢复为新的一页').click(); await settled()
    await unmount(component); component = undefined
    finish({ page_id: 'new', path: '/vault/late.writing.md' }); await settled()
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
