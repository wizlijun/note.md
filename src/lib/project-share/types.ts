export type GitTarget = 'worktree' | 'branch' | 'patch'
export interface GitProbe { git: boolean; team: boolean; prefix: string; head?: string; branch?: string; remote?: string; reason?: string; target?: GitTarget }
export interface GitPrepared { head: string; entry: string; feedback: LocalFeedback; files: { path: string; base: string; current: string; after: string }[]; commitMessage: string; remote?: string }
export interface GitBranchResult { branch: string; commit: string; feedback: LocalFeedback; remote?: string; stateError?: string }

export interface ProjectInfo {
  gitTarget?: GitTarget
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
  modifiedAt?: number
  markdown?: string
  dataUrl?: string
}
export interface ProjectSnapshot {
  schemaVersion: 1 | 2
  project_id: string
  snapshotId: string
  entry: string
  files: ProjectFile[]
  parentSnapshotId?: string | null
  createdAt?: string | null
  git?: SnapshotGit | null
  gitError?: string | null
}
export interface PublicProjectSnapshot {
  schemaVersion: 1
  project_id: string
  snapshotId: string
  entry: string
  files: ProjectFile[]
}
export interface SnapshotGit {
  snapshotCommit: string
  headAtFreeze: string
  prefix: string
  repoRoot: string
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
  decisions: Record<string, Decision>
  review?: Record<string, ReviewDraft>
  annotation_decisions?: Record<string, 'promoted' | 'dismissed'>
  receipt?: ReceiptState | null
  git?: SubmissionGit | null
  superseded_by?: string | null
}
export interface Decision {
  status: string
  beforeHash?: string | null
  resultHash?: string | null
  hunkSummary?: HunkSummary | null
  reason?: 'superseded' | null
  gitBranch?: string | null
  gitCommit?: string | null
}
export interface HunkSummary {
  accepted: number
  total: number
}
export interface ReviewDraft {
  kernel_version: number
  ours_hash: string
  hunks: Record<string, unknown>
  target?: GitTarget | null
  updated_at: string
}
export interface ReceiptState {
  state: 'auto' | 'suppressed' | 'sent' | 'failed'
  reply?: string | null
  sent_at?: string | null
  last_error?: string | null
}
export interface SubmissionGit {
  commit?: string | null
  error?: string | null
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
