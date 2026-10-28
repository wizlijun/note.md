// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { linkOpen } from './bridge'

const url = 'https://research.example/recent?topic=next'
function bridge() {
  const request = vi.fn().mockResolvedValue({ ok: true })
  window.notemd = { pluginId: 'notemd.next', locale: 'en', theme: 'light', request, onMessage: vi.fn() }
  return request
}
afterEach(() => { vi.restoreAllMocks() })

describe('web source compatibility', () => {
  it('uses the link method when supported', async () => {
    const request = bridge()
    await expect(linkOpen(url)).resolves.toBe('opened')
    expect(request.mock.calls).toEqual([['host.link.open', { url }]])
  })
  it('copies the URL only when an older host rejects the unknown method', async () => {
    const request = bridge().mockRejectedValueOnce(new Error('-32601: unknown method host.link.open'))
    await expect(linkOpen(url)).resolves.toBe('copied')
    expect(request.mock.calls).toEqual([['host.link.open', { url }], ['host.clipboard.write', { text: url }]])
  })
  it.each(['-32001: method host.link.open requires capability link.open', '-32000: io: browser unavailable', 'Network request failed'])('surfaces other failures without overwriting the clipboard: %s', async (message) => {
    const request = bridge().mockRejectedValueOnce(new Error(message))
    await expect(linkOpen(url)).rejects.toThrow(message)
    expect(request).toHaveBeenCalledOnce()
  })
  it('surfaces clipboard failure instead of claiming the link was copied', async () => {
    const request = bridge().mockRejectedValueOnce(new Error('-32601: unknown method host.link.open'))
      .mockRejectedValueOnce(new Error('-32000: io: clipboard unavailable'))
    await expect(linkOpen(url)).rejects.toThrow('clipboard unavailable')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.org/', '//example.org/a'])('rejects unsafe sources before either operation: %s', async (source) => {
    const request = bridge()
    await expect(linkOpen(source)).rejects.toThrow('Invalid source link')
    expect(request).not.toHaveBeenCalled()
  })
})
