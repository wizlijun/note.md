// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const status = () => ({ auto_sync: false, running: false, last_finished: null, report: null, error: null, vault: null })
const request = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  request.mockReset()
  document.body.innerHTML = '<main id="app"></main>'
  window.notemd = { locale: 'zh-CN', request }
})
afterEach(() => {
  window.dispatchEvent(new Event('beforeunload'))
  vi.clearAllTimers()
  vi.useRealTimers()
  delete window.notemd
})
async function load() {
  await import('./main')
  await vi.advanceTimersByTimeAsync(0)
}

describe('Apple Notes window bridge', () => {
  it('reads backend status and requests background sync without blocking the UI', async () => {
    request.mockResolvedValueOnce(status()).mockResolvedValueOnce({ ...status(), running: true })
    await load()
    expect(request).toHaveBeenCalledWith('plugin.status', undefined)
    const button = document.querySelector<HTMLButtonElement>('#sync')!
    expect(button.disabled).toBe(false)
    button.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledWith('plugin.sync', undefined)
    expect(button.disabled).toBe(true)
    expect(document.querySelector('#status')?.textContent).toBe('正在读取 Apple Notes…')
  })

  it('persists user opt-in through settings and rolls the checkbox back on failure', async () => {
    request.mockResolvedValueOnce(status()).mockResolvedValueOnce({ ...status(), auto_sync: true, running: true })
      .mockRejectedValueOnce(new Error('Cannot save settings'))
    await load()
    const toggle = document.querySelector<HTMLInputElement>('#auto')!
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledWith('plugin.settings', { auto_sync: true })
    expect(toggle.checked).toBe(true)
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(0)
    expect(toggle.checked).toBe(true)
    expect(document.querySelector('#error')?.textContent).toBe('Cannot save settings')
  })

  it('renders incomplete counts and source warnings as text', async () => {
    request.mockResolvedValue({ ...status(), vault: '/tmp/<vault>', last_finished: 1,
      report: { created: 8, updated: 2, moved: 1, deleted: 0, unchanged: 40, locked: 1,
        complete: false, warnings: ['<img src=x onerror=alert(1)> locked note'] } })
    await load()
    expect(document.querySelector('#status')?.textContent).toBe('同步未完整完成')
    expect([...document.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['8', '2', '1', '0', '40', '1'])
    expect(document.querySelector('#warnings')?.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelector('#warnings img')).toBeNull()
    expect(document.querySelector('#destination')?.textContent).toBe('/tmp/<vault>/applenotes/')
  })

  it('reports a missing host bridge', async () => {
    delete window.notemd
    await load()
    expect(document.querySelector('#error')?.textContent).toBe('Open this plugin inside note.md.')
    expect(document.querySelector('#status')?.textContent).toBe('Unable to load sync status')
    expect(document.querySelector<HTMLButtonElement>('#sync')?.disabled).toBe(true)
  })
})
