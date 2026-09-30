// Wire contract mirrors habitat-core/src/model.rs (serde camelCase).
export interface Algorithm { version: string; parserVersion: string; tokenizerVersion: string; effectiveParams: Record<string, unknown> }
export interface Diagnostic { code: string; path: string; message: string }
export interface Coverage { indexed: number; parsed: number; unavailable: number; excluded: number; knowledgeDatasets: number; knowledgeRecords: number; importedRecords: number; isolatedRecords: number; unprojectedRecords: number; diagnosticCount: number; unassignedSources: number; unresolvedLinks: number; diagnostics: Diagnostic[] }
export interface Meta { schema: string; snapshotId: string; stateHash: string; parents: string[]; generatedAt: string; vaultId: string; algorithm: Algorithm; scopeHash: string; manifestHash: string; structureHash: string; evidenceHash: string; layoutHash: string; coverage: Coverage; changeCause: string }
export interface Source { id: string; path: string; hash: string; role: string; status: string; family: string; familyStatus: string }
export interface Node { id: string; key: string; nodeType: string; label: string; status: string; aliases?: string[]; evidence?: string[]; intentStatus?: string }
export interface Locator { start: number; end: number; outlineId?: string; jsonPointer?: string }
export interface Evidence { id: string; source: string; locator: Locator; role: string; authorship: string; granularity: string; verification: string }
export interface Participant { node: string; role: string }
export interface Edge { id: string; edgeType: string; status: string; participants: Participant[]; evidence: string[]; verifiedFamilies: number; provisionalFamilies: number; unresolvedLineage: number }
export interface Membership { id: string; node: string; topic: string; role: string; score: number }
export interface Lineage { id: string; change: string; from: string[]; to: string[]; status: string }
export interface Layout { id: string; x: number; y: number; zone: string; pinned: boolean }
export interface Snapshot { meta: Meta; sources: Source[]; nodes: Node[]; evidence: Evidence[]; edges: Edge[]; memberships: Membership[]; lineage: Lineage[]; layout: Layout[] }
export interface Job { id: string; state: 'running' | 'complete' | 'cancelled' | 'failed'; phase: string; message: string; processed: number; total: number; error?: string; snapshotId?: string; saveStatus?: string }
export interface State { vaultKey: string; snapshot: Snapshot | null; preview?: Snapshot | null; job: Job | null; pending: boolean; historyAvailable: boolean; historyError?: string | null; externalChange?: boolean; readOnlyPreview?: boolean }
export interface Version { commit: string; snapshotId: string; parents: string[]; generatedAt: string; changeCause: string; nodes: number; edges: number }
export interface History { versions: Version[]; truncated: boolean }
export interface Diff { from: string; to: string; causes: string[]; comparable: boolean; warnings: string[]; added: Node[]; removed: Node[]; renamed: { id: string; before: string; after: string }[]; changed: Node[]; edgesAdded: Edge[]; edgesRemoved: Edge[]; edgesChanged: Edge[]; membershipChanges: number; layoutChanges: number }
