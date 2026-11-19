// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { FileInputBlockedError, type FileInputBlockedReason } from '../editor-kit-v2/file-input-error'
import { reportFileInputBlocked } from './file-input-feedback'
import { clearToasts, toasts } from './toast.svelte'
import { settings } from './settings.svelte'
import { i18n } from './i18n/runtime.svelte'

afterEach(() => { clearToasts(); vi.restoreAllMocks(); vi.useRealTimers(); settings.toastAutoClose = false; i18n.locale = 'en' })
it.each([
  ['rich-composing', '输入法尚未结束'],
  ['source-composing', '源码中的输入法尚未结束'],
  ['source-pending', '源码修改尚未应用'],
  ['annotation-pending', '批注修改尚未应用'],
] as [FileInputBlockedReason, string][])('reports %s without document contents or paths', (reason, message) => {
  i18n.locale = 'zh'
  settings.toastAutoClose = true
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(reportFileInputBlocked(new FileInputBlockedError(reason, '/private/vault/secret draft'))).toBe(true)
  expect(toasts.list).toHaveLength(1)
  expect(toasts.list[0]).toMatchObject({ message: expect.stringContaining(message), level: 'warn' })
  vi.advanceTimersByTime(10_000)
  expect(toasts.list).toHaveLength(1)
  expect(log.mock.calls).toEqual([['[file-input] operation blocked:', reason]])
})
it('deduplicates owner and UI reporting and permits a retry after dismissal', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = new FileInputBlockedError('source-pending')
  reportFileInputBlocked(error); reportFileInputBlocked(error)
  reportFileInputBlocked(new FileInputBlockedError('source-pending'))
  expect(toasts.list).toHaveLength(1)
  clearToasts()
  reportFileInputBlocked(new FileInputBlockedError('source-pending'))
  expect(toasts.list).toHaveLength(1)
  expect(reportFileInputBlocked(new Error('unrelated'))).toBe(false)
})
