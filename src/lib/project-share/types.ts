export interface ProjectInfo {
  project_id: string
  sourceRoot: string
  mirrorRoot: string
  entry: string
  files: string[]
  publishedSnapshotId?: string | null
  url?: string | null
  sourceAvailable?: boolean
  deleting?: boolean
  error?: string
  orphaned?: boolean
}
export interface ProjectSummary extends ProjectInfo {}
export interface ProjectFile {
  path: string
  hash: string
  bytes: number
  markdown?: string
  dataUrl?: string
}
export interface ProjectSnapshot {
  schemaVersion: 1
  project_id: string
  snapshotId: string
  entry: string
  files: ProjectFile[]
}
export interface ProjectFeedback {
  schemaVersion: 1
  project_id: string
  snapshotId: string
  submissionId: string
  edits: { path: string; baseHash: string; afterMarkdown: string }[]
  annotations: { path: string; quote: string; comment: string; start?: number; end?: number }[]
  name?: string
}
export interface FeedbackEnvelope {
  payload: ProjectFeedback
  requestHash: string
  receivedAt: string
}
export interface LocalFeedback {
  envelope: FeedbackEnvelope
  status: string
  error?: string | null
  decisions: Record<string, { status: string; beforeHash?: string | null; resultHash?: string | null }>
}
export interface ReviewFile {
  path: string
  sourcePath: string
  base: string
  current: string
  after: string
  currentHash: string
  status: string
}
