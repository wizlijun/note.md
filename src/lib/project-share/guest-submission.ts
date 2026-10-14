import { extractGuestAnnotations, propose } from '../share-merge'
import { sha256Sync } from '../share-merge/hash'
import type { DraftV2, ProjectFeedbackV2 } from './types'
export interface SubmissionInput {
  project_id: string; draft: DraftV2; submissionId: string
  client: { kind: 'browser' | 'notemd'; version: string }
  message?: string; name?: string; aiAssisted?: boolean
}
export interface BuiltSubmission {
  body: string; submissionId: string
  summary: { files: number; blocks: number; annotations: number }
  ownerAnnotationsTouched: readonly { path: string; raw: string[] }[]
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const pathValid = (value: string) => value.length > 0 && !/^[\/]|[\\:\0]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
function requireValid(ok: boolean, field: string): asserts ok { if (!ok) throw new Error(`Invalid submission ${field}`) }
export function buildGuestSubmission(input: SubmissionInput): BuiltSubmission {
  const { draft, project_id, submissionId, client, message, name, aiAssisted } = input
  requireValid(draft.v === 2 && id(project_id) && id(draft.snapshotId) && id(submissionId), 'identity')
  requireValid(client.kind === 'browser' || client.kind === 'notemd', 'client kind')
  requireValid(typeof client.version === 'string' && client.version.length <= 32, 'client version')
  requireValid(message === undefined || typeof message === 'string' && message.length <= 2000 && !message.includes('\0'), 'message')
  requireValid(name === undefined || typeof name === 'string' && name.length <= 80 && !/\p{Cc}/u.test(name), 'name')
  requireValid(aiAssisted === undefined || typeof aiAssisted === 'boolean', 'aiAssisted')
  requireValid(draft.lastSubmissionId === undefined || id(draft.lastSubmissionId) && draft.lastSubmissionId !== submissionId, 'supersedes')
  requireValid(draft.rebasedFrom === undefined || id(draft.rebasedFrom) && draft.rebasedFrom !== draft.snapshotId, 'rebasedFrom')
  const edits: ProjectFeedbackV2['edits'] = [], annotations: ProjectFeedbackV2['annotations'] = []
  const ownerAnnotationsTouched: { path: string; raw: string[] }[] = []
  let blocks = 0
  for (const path of Object.keys(draft.after).sort()) {
    const base = Object.hasOwn(draft.base, path) ? draft.base[path] : undefined, raw = draft.after[path]
    requireValid(pathValid(path) && !!base && typeof raw === 'string', 'file')
    requireValid(typeof base.markdown === 'string' && /^[a-f0-9]{64}$/.test(base.hash) && sha256Sync(base.markdown) === base.hash, 'base')
    const extracted = extractGuestAnnotations({ base: base.markdown, draft: raw })
    if (extracted.clean !== base.markdown) {
      edits.push({ path, baseHash: base.hash, afterMarkdown: extracted.clean })
      blocks += propose({ path, base: base.markdown, ours: base.markdown, theirs: extracted.clean }).hunks.length
    }
    for (const annotation of extracted.annotations) {
      const { selector, comment } = annotation
      const kind = draft.annotationKinds[sha256Sync(selector.exact + '\0' + comment).slice(0, 16)] ?? 'comment'
      requireValid(['comment', 'question', 'blocker'].includes(kind), 'annotation kind')
      requireValid(comment.length > 0 && comment.length <= 10000 && selector.exact.length <= 2000
        && (selector.prefix?.length ?? 0) <= 64 && (selector.suffix?.length ?? 0) <= 64
        && !!(selector.exact || selector.prefix || selector.suffix)
        && (selector.start === undefined || Number.isSafeInteger(selector.start) && selector.start >= 0)
        && (selector.end === undefined || Number.isSafeInteger(selector.end) && selector.end >= 0)
        && (selector.start === undefined || selector.end === undefined || selector.end - selector.start === selector.exact.length), 'annotation')
      annotations.push({ path, selector, comment, kind })
    }
    if (extracted.ownerAnnotationsTouched.length) ownerAnnotationsTouched.push({ path, raw: extracted.ownerAnnotationsTouched })
  }
  requireValid(edits.length <= 2000 && annotations.length <= 2000, 'item limit')
  const payload: ProjectFeedbackV2 = { schemaVersion: 2, project_id, snapshotId: draft.snapshotId, submissionId,
    edits, annotations, client: { kind: client.kind, version: client.version },
    ...(draft.lastSubmissionId === undefined ? {} : { supersedes: draft.lastSubmissionId }),
    ...(draft.rebasedFrom === undefined ? {} : { rebasedFrom: draft.rebasedFrom }),
    ...(message === undefined ? {} : { message }),
    ...(name === undefined && aiAssisted === undefined ? {} : { contributor: {
      ...(name === undefined ? {} : { name }), ...(aiAssisted === undefined ? {} : { aiAssisted }),
    } }),
  }
  const body = JSON.stringify(payload)
  requireValid(new TextEncoder().encode(body).length <= 5 * 1024 * 1024, '5 MiB limit')
  return { body, submissionId, summary: { files: edits.length, blocks, annotations: annotations.length }, ownerAnnotationsTouched }
}
