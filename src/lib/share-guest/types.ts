export interface GuestLink { origin: string; slug: string; shareUrl: string; token?: string }
export interface GuestInfo {
  schemaVersion: 1
  root: string
  entry: string
  origin: string
  slug: string
  shareUrl: string
  project_id: string
  snapshotId: string
  workPaths?: Record<string, string>
  contributorName?: string
  lastSubmissionId?: string
  files: readonly { path: string; hash: string }[]
  submitted: readonly string[]
  outbox: readonly { submissionId: string; body: string; queuedAt: string }[]
  pendingUpdate: null | { snapshotId: string; unresolved: string[]; paths?: string[] }
}
