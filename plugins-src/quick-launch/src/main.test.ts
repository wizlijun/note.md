// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
const initial = () => ({ entries: [
  { id: 'cmd1', name: '屏幕重连', kind: 'cli', target: 'uc reconnect', enabled: true },
  { id: 'cmd2', name: '', kind: 'app', target: '', enabled: false },
] })
const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!
const field = (id: string, name: string) => document.querySelector<HTMLInputElement>(`[data-entry="${id}"] [data-field="${name}"]`)!
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
async function load() { await import('./main'); await flush() }
function input(id: string, name: string, value: string) {
  const control = field(id, name)
  control.value = value
  control.dispatchEvent(new Event('input'))
}
beforeEach(() => {
  vi.resetModules()
  request.mockReset()
  request.mockImplementation(async (method: string, params?: unknown) => {
    // The injected bridge serializes omitted params as null. Quick Launch's
    // production host boundary requires an object, including for get.
    const wireParams = JSON.parse(JSON.stringify(params === undefined ? null : params))
    if (method.startsWith('host.quickLaunch.') && (!wireParams || Array.isArray(wireParams) || typeof wireParams !== 'object')) {
      throw new Error('Quick Launch params must be an object')
    }
    if (method === 'host.quickLaunch.get') return initial()
    if (method === 'host.quickLaunch.save') return structuredClone(params)
    if (method === 'host.quickLaunch.run') return { ok: true, exitCode: 0, stdout: 'done', stderr: '' }
    throw new Error(`Unexpected method ${method}`)
  })
  document.body.innerHTML = '<main id="app" class="ui-surface"></main>'
  window.notemd = { locale: 'zh-CN', request }
})

describe('Quick Launch configuration', () => {
  it('loads host defaults without executing and disables empty entries', async () => {
    await load()
    expect(field('cmd1', 'name').value).toBe('屏幕重连')
    expect(field('cmd1', 'target').value).toBe('uc reconnect')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('host.quickLaunch.get', {})
    expect(button('[data-entry="cmd1"] [data-action="run"]').disabled).toBe(false)
    expect(button('[data-entry="cmd2"] [data-action="run"]').disabled).toBe(true)
    expect(button('#save').disabled).toBe(true)
  })

  it('blocks launch until edited data has been explicitly saved', async () => {
    await load()
    input('cmd1', 'name', '重连显示器')
    expect(button('[data-entry="cmd1"] [data-action="run"]').disabled).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    button('#save').click()
    await flush()
    expect(request).toHaveBeenCalledWith('host.quickLaunch.save', { entries: [
      { ...initial().entries[0], name: '重连显示器' }, initial().entries[1],
    ] })
    expect(button('[data-entry="cmd1"] [data-action="run"]').disabled).toBe(false)
    expect(button('#save').disabled).toBe(true)
  })

  it('retains edits after a failed save and lets the user retry', async () => {
    await load()
    input('cmd1', 'target', 'printf hello')
    request.mockRejectedValueOnce(new Error('disk full'))
    button('#save').click()
    await flush()
    expect(field('cmd1', 'target').value).toBe('printf hello')
    expect(document.querySelector('#error')!.textContent).toBe('disk full')
    expect(button('#save').disabled).toBe(false)
    expect(button('[data-entry="cmd1"] [data-action="run"]').disabled).toBe(true)
    button('#save').click()
    await flush()
    expect(button('#save').disabled).toBe(true)
  })

  it('supports reorder, add, enable and delete without changing entry identity', async () => {
    await load()
    button('[data-entry="cmd2"] [data-action="up"]').click()
    expect(document.querySelector('.entry')!.getAttribute('data-entry')).toBe('cmd2')
    button('#add').click()
    expect(document.querySelectorAll('.entry')).toHaveLength(3)
    expect(document.activeElement?.getAttribute('data-field')).toBe('name')
    const enabled = field('cmd2', 'enabled')
    enabled.checked = true
    enabled.dispatchEvent(new Event('change'))
    button('[data-entry="cmd1"] [data-action="remove"]').click()
    button('#save').click()
    await flush()
    const payload = request.mock.calls.find(([method]) => method === 'host.quickLaunch.save')![1]
    expect(payload.entries).toHaveLength(2)
    expect(payload.entries[0].id).toBe('cmd2')
    expect(payload.entries[0].enabled).toBe(true)
  })

  it('chooses an app through the host dialog and preserves target on cancel', async () => {
    await load()
    request.mockResolvedValueOnce({ paths: ['/Applications/Safari.app'] })
    button('[data-entry="cmd2"] [data-action="browse"]').click()
    await flush()
    expect(request).toHaveBeenLastCalledWith('host.dialog.open', {
      title: '选择应用', multiple: false, filters: [{ name: '应用', extensions: ['app'] }],
    })
    expect(field('cmd2', 'target').value).toBe('/Applications/Safari.app')
    request.mockResolvedValueOnce({ paths: null })
    button('[data-entry="cmd2"] [data-action="browse"]').click()
    await flush()
    expect(field('cmd2', 'target').value).toBe('/Applications/Safari.app')
  })

  it('shows real in-flight progress, prevents duplicate execution and renders output as text', async () => {
    await load()
    let resolve!: (value: unknown) => void
    request.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    button('[data-entry="cmd1"] [data-action="run"]').click()
    expect(document.querySelector('#run-state')!.textContent).toContain('正在运行')
    expect(button('[data-entry="cmd1"] [data-action="run"]').disabled).toBe(true)
    expect(button('#add').disabled).toBe(true)
    resolve({ ok: true, exitCode: 0, stdout: '<img src=x onerror=alert(1)>', stderr: '' })
    await flush()
    expect(request).toHaveBeenLastCalledWith('host.quickLaunch.run', { id: 'cmd1' })
    expect(document.querySelector('#run-state')!.textContent).toContain('命令已完成')
    expect(document.querySelector('#output')!.textContent).toContain('<img')
    expect(document.querySelector('#output img')).toBeNull()
    expect(button('[data-entry="cmd1"] [data-action="run"]').disabled).toBe(false)
  })

  it('reports a failed command and restores controls', async () => {
    await load()
    request.mockRejectedValueOnce(new Error('exit 127: uc: command not found'))
    button('[data-entry="cmd1"] [data-action="run"]').click()
    await flush()
    expect(document.querySelector('#run-state')!.textContent).toContain('执行失败')
    expect(document.querySelector('#error')!.textContent).toContain('command not found')
    expect(button('[data-entry="cmd1"] [data-action="run"]').disabled).toBe(false)
  })

  it('never substitutes defaults after a read error and supports retry', async () => {
    request.mockRejectedValueOnce(new Error('invalid config'))
    await load()
    expect(document.querySelectorAll('.entry')).toHaveLength(0)
    expect(button('#add').disabled).toBe(true)
    expect(button('#save').disabled).toBe(true)
    expect(document.querySelector('#error')!.textContent).toBe('invalid config')
    button('#retry').click()
    await flush()
    expect(document.querySelectorAll('.entry')).toHaveLength(2)
  })

  it('limits configuration to 20 entries and supports English', async () => {
    window.notemd!.locale = 'en'
    await load()
    for (let i = 0; i < 18; i++) button('#add').click()
    expect(document.querySelectorAll('.entry')).toHaveLength(20)
    expect(button('#add').disabled).toBe(true)
    expect(document.querySelector('h1')!.textContent).toBe('Quick Launch')
  })
})
