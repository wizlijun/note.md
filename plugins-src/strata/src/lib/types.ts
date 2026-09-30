import type { MeetingNodeMetadata, MeetingSnapshotMetadata } from './meetings'
import type { Atlas, TerrainInputNode, SourceSupport } from './types-terrain'
export type { Atlas }
export type Dataset = 'vault_index' | 'meetings_knowledge'
export type Confidentiality = 'confidential' | 'explicitly_public' | 'unknown'
export type OwnerSpecificity = 'owner_specific' | 'general' | 'unknown'
export interface DateRange { from: string; to: string }
export interface Evidence { id: string; sourceId: string; path: string; contentHash: string; blockKey: string; lineStart: number; lineEnd: number; quote: string }
export interface KnowledgeNode extends TerrainInputNode {
  kind: string
  state: 'candidate' | 'verified' | 'imported'
  importance?: 0 | 1
  meeting?: MeetingNodeMetadata
  features: string[]
  links: string[]
  ownerSpecificity: OwnerSpecificity
  confidentiality: Confidentiality
  classificationReason: string
  speaker: string | null
  conditions: string[]
  limits: string[]
  epistemic: string
  sourceGroups: SourceSupport[]
  evidence: Evidence[]
}
export interface SourceFile {
  fileKey: string; path: string; contentHash: string; title?: string | null; conceptType?: string | null
  tags: string[]; docDate: string | null; dateInferred: boolean; indexOrigin: string; humanVerified: boolean
  attentionMinutes: number; filePriority: number; priorityBasis?: unknown; confidentiality: Confidentiality
  links: { kind: string; target: string; line: number }[]
}
export interface Relation { id: string; source: string; target: string; type: string; title: string; evidence: Evidence[]; participants?: { nodeId: string; role: string }[]; meeting?: MeetingNodeMetadata }
export interface Coverage {
  indexed: number; selected: number; processed: number; candidate: number; excluded: number; stale: number
  proofDeferred: number
  dateInferred: number; confidential: number; unknownConfidentiality: number
}
export interface Budget { maxFiles: number; maxBytes: number; maxSeconds: number }
export interface Job {
  id: string; state: string; range: DateRange; harness: string; model: string | null; budget: Budget
  includeConfidential: boolean; selected: number; processed: number; reused: number; skipped: number; failed: number
  inputBytes: number; nodes: number; stopRequested: boolean; runId: string | null; invocationId: string | null
  canDismissRecovery: boolean
  message: string; error: string | null; startedAt: string; updatedAt: string
}
export interface Snapshot {
  schema: 'notemd.strata/snapshot/v1'; vaultKey: string; snapshotId: string; configHash: string; asOf: string
  meetings?: MeetingSnapshotMetadata
  range: DateRange; files: SourceFile[]; nodes: KnowledgeNode[]; relations: Relation[]; coverage: Coverage; job: Job | null
}
export interface Provider {
  id: string; name: string
  harness?: { ok: boolean; default_model?: string | null; hint?: string | null; capabilities?: { tasks: string[]; terminal_result: boolean; input_only_isolation: boolean } } | null
}
export interface Providers { providers: Provider[]; default: string }
export interface Preferences {
  from: string; to: string; view: '2d' | '3d'; personal: boolean; relations: boolean; includePublic: boolean
  level: 'auto' | 'domain' | 'topic' | 'knowledge'; verticalScale: number; harness: string
}

export interface BrowserSettings { browser?: Partial<Preferences>; datasets?: { active?: Dataset; preferences?: Partial<Record<Dataset, Partial<Preferences>>> } }
