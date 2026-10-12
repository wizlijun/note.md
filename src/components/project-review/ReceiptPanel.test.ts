// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import ReceiptPanel from './ReceiptPanel.svelte'
import type { LocalFeedback } from '../../lib/project-share/types'
afterEach(cleanup)
const feedback: LocalFeedback = { envelope: { payload: { schemaVersion: 1, project_id: 'p', snapshotId: 's', submissionId: 'sub', edits: [], annotations: [] }, requestHash: '', receivedAt: '' }, status: 'pending', decisions: {} }
it('defaults on and saves optional reply as plain text', async () => {
  const onSave = vi.fn(async () => {}), onRetry = vi.fn(async () => {})
  const view = render(ReceiptPanel, { feedback, onSave, onRetry })
  expect((view.getByRole('checkbox', { name: '发送处理回执' }) as HTMLInputElement).checked).toBe(true)
  await fireEvent.input(view.getByRole('textbox', { name: '回复协作者' }), { target: { value: '<img onerror=x>' } })
  await fireEvent.click(view.getByRole('button', { name: '保存回执设置' }))
  expect(onSave).toHaveBeenCalledWith({ enabled: true, reply: '<img onerror=x>' })
  expect(view.container.querySelector('img')).toBeNull()
})
it('shows failed suppression and exposes DELETE retry without re-enabling', async () => {
  const onRetry = vi.fn(async () => {})
  const view = render(ReceiptPanel, { feedback: { ...feedback, receipt: { state: 'suppressed', last_error: '撤回失败，请重试', reply: '<b>原样</b>' } }, onSave: vi.fn(), onRetry })
  expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  expect(view.getByRole('alert').textContent).toContain('撤回失败')
  await fireEvent.click(view.getByRole('button', { name: '重试回执' })); expect(onRetry).toHaveBeenCalledOnce()
  expect(view.container.querySelector('b')).toBeNull()
})
