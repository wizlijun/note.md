import type { ProjectAnnotationV2, ProjectFeedback } from './types'

export function feedbackName(payload: ProjectFeedback): string {
  return (payload.schemaVersion === 2 ? payload.contributor?.name : payload.name) ?? ''
}

// Keep the persisted wire payload intact; only review/display use this projection.
export function feedbackAnnotations(payload: ProjectFeedback): ProjectAnnotationV2[] {
  if (payload.schemaVersion === 2) return payload.annotations.map(note => ({ ...note, selector: { ...note.selector }, kind: note.kind ?? 'comment' }))
  return payload.annotations.map(note => ({
    path: note.path, comment: note.comment, kind: 'comment',
    selector: { exact: note.quote, ...(note.start == null ? {} : { start: note.start }), ...(note.end == null ? {} : { end: note.end }) },
  }))
}
