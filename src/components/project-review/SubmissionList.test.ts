// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import SubmissionList from './SubmissionList.svelte'
import type { LocalFeedback } from '../../lib/project-share/types'
afterEach(cleanup)
it('collapses superseded submissions without automatically deciding them and keeps them selectable', async () => {
  const old: LocalFeedback = { envelope: { payload: { schemaVersion: 1, project_id: 'p', snapshotId: 's', submissionId: 'old', edits: [], annotations: [], name: '旧提交' }, requestHash: '', receivedAt: '' }, status: 'pending', decisions: {}, superseded_by: 'new' }
  const onSelect = vi.fn(), view = render(SubmissionList, { feedback: [old], onSelect })
  const details = view.container.querySelector('details')!
  expect(details).toBeTruthy(); expect(details.open).toBe(false)
  expect(details.textContent).toContain('已取代')
  await fireEvent.click(view.getByText('已取代（1）')); details.open = true
  await fireEvent.click(view.getByRole('button', { name: /旧提交/ }))
  expect(onSelect).toHaveBeenCalledWith(old); expect(old.decisions).toEqual({})
})
