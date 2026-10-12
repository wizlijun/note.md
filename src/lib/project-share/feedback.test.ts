import { expect, it } from 'vitest'
import { feedbackAnnotations, feedbackName } from './feedback'
import type { ProjectFeedbackV1, ProjectFeedbackV2 } from './types'

const v1: ProjectFeedbackV1 = { schemaVersion: 1, project_id: 'p', snapshotId: 'S1', submissionId: 'v1', edits: [], name: 'Legacy',
  annotations: [{ path: 'README.md', quote: 'Before', comment: 'Comment', start: 0, end: 6 }] }
const v2: ProjectFeedbackV2 = { schemaVersion: 2, project_id: 'p', snapshotId: 'S1', submissionId: 'v2', edits: [], contributor: { name: 'Alice' },
  annotations: [{ path: 'README.md', selector: { exact: 'Before', prefix: 'Context', suffix: 'After', start: 0, end: 6 }, comment: 'Comment', kind: 'question' }] }
it('reads both author formats and defaults absent names', () => {
  expect(feedbackName(v1)).toBe('Legacy'); expect(feedbackName(v2)).toBe('Alice')
  expect(feedbackName({ ...v1, name: undefined })).toBe('')
  expect(feedbackName({ ...v2, contributor: undefined })).toBe('')
})
it('normalizes legacy annotations only at the read boundary and preserves v2 selector context', () => {
  const original = JSON.stringify([v1, v2])
  expect(feedbackAnnotations(v1)[0]).toEqual({ path: 'README.md', selector: { exact: 'Before', start: 0, end: 6 }, comment: 'Comment', kind: 'comment' })
  expect(feedbackAnnotations(v2)[0].selector).toEqual(v2.annotations[0].selector)
  expect(feedbackAnnotations({ ...v2, annotations: [{ ...v2.annotations[0], kind: undefined }] })[0].kind).toBe('comment')
  expect(JSON.stringify([v1, v2])).toBe(original)
})
