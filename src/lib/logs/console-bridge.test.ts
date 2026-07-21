import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

describe('installConsoleBridge', () => {
  beforeEach(() => { invokeMock.mockClear() })

  it('calls the original console and reports to the backend', async () => {
    const { installConsoleBridge } = await import('./console-bridge')
    const original = console.warn
    installConsoleBridge()
    console.warn('hello', 42)
    expect(invokeMock).toHaveBeenCalledWith('logs_append_frontend', { level: 'warn', message: 'hello 42' })
    console.warn = original
  })

  it('is idempotent — patching twice does not double-report', async () => {
    const { installConsoleBridge } = await import('./console-bridge')
    installConsoleBridge()
    installConsoleBridge()
    invokeMock.mockClear()
    console.info('x')
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('does not loop when the report itself throws', async () => {
    const { installConsoleBridge } = await import('./console-bridge')
    invokeMock.mockImplementationOnce(() => Promise.reject(new Error('boom')))
    installConsoleBridge()
    expect(() => console.error('kaboom')).not.toThrow()
  })
})
