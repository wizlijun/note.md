export const CURRENT_DATASET_SCHEMA = 'knowledge-representation-dataset/3.1.0' as const
export const LEGACY_DATASET_SCHEMA = 'knowledge-representation-dataset/3.0.0' as const
export const CURRENT_EXTRACTOR_RULE = 'relation-schema-extractor/3.1.0' as const
export const LEGACY_EXTRACTOR_RULE = 'relation-schema-extractor/3.0.0' as const
export const RELATION_TYPES_VERSION = '1.0.0' as const

export type DatasetSchema = typeof CURRENT_DATASET_SCHEMA | typeof LEGACY_DATASET_SCHEMA
export type ExtractorRule = typeof CURRENT_EXTRACTOR_RULE | typeof LEGACY_EXTRACTOR_RULE

export type LocalId = `e${number}` | `c${number}` | `q${number}` | `v${number}` | `n${number}` | `r${number}`
export type SourceId = `s${number}`
export type EvidenceId = `x${number}`
export type NodeRef = SourceId | LocalId
export type TimeValue = string | [string | null, string | null] | null
export type KnowledgeKind = 'entities' | 'concepts' | 'claims' | 'events' | 'narratives' | 'relations'

export interface GeneratedInfo { by: string; at: string; rule: ExtractorRule; types: typeof RELATION_TYPES_VERSION }
export interface Selection { profile: 'strong_only' | 'exploratory'; policy: 'epistemic-strength/1.0.0'; minimum_strength: 'strong' | 'medium' | 'weak' }
export interface EpistemicAssessment {
  strength: 'strong' | 'medium' | 'weak'
  basis: Array<'explicit_statement' | 'explicit_speech_act' | 'direct_observation' | 'source_defined' | 'independent_corroboration' | 'self_report' | 'agent_inference' | 'ambiguous'>
  reason?: string
}
export interface DatasetScope { purpose: string; questions: string[] }
export interface Source { id: SourceId; uri: string; v: string | null; title?: string; origin?: 'derived' | 'unknown'; group?: string; retrieved?: string }
export interface Evidence { id: EvidenceId; s: SourceId; loc: string; quote?: string; at?: Exclude<TimeValue, null>; speaker?: `e${number}`; role?: 'mentions' | 'defines' | 'reports' | 'supports' | 'contradicts' | 'describes' | 'sequences' | 'context' | 'identity' }
export interface Authority { reviewed_by: string[]; basis: string; uses?: string[] }
export interface CommonRecord {
  id: LocalId; i: 0 | 1; why: string; ev: EvidenceId[]; scope?: string | Record<string, string | number | boolean | null>
  epistemic?: EpistemicAssessment
  event?: TimeValue; valid?: TimeValue; status?: 'contested' | 'supported' | 'confirmed' | 'superseded' | 'retracted'
  score?: number; score_type?: string; rev?: number; op?: 'update' | 'supersede' | 'correct' | 'retract'; parents?: string[]
  authority?: Authority; limits?: string[]
}
export interface Entity extends CommonRecord { id: `e${number}`; type: 'person' | 'organization' | 'team' | 'project' | 'document' | 'place' | 'system' | 'artifact' | 'other'; name: string; aliases?: string[]; desc?: string; identity?: 'resolved' | 'ambiguous' }
export interface Concept extends CommonRecord { id: `c${number}`; term: string; aliases?: string[]; definition: string; criteria?: string[]; excludes?: string[] }
export interface Claim extends CommonRecord { id: `q${number}`; text: string; kind: 'fact' | 'definition' | 'decision' | 'commitment' | 'rule' | 'evaluation' | 'prediction' | 'hypothesis' | 'question' | 'other'; about: NodeRef[]; by: string[]; if?: string[]; unless?: string[]; reason?: string }
export type RoleMap = Record<string, NodeRef | NodeRef[]>
export interface KnowledgeEvent extends CommonRecord { id: `v${number}`; type: string; title: string; desc?: string; state: 'planned' | 'ongoing' | 'completed' | 'cancelled' | 'unknown'; args: RoleMap; event: TimeValue; place?: `e${number}`[] }
export interface Narrative extends CommonRecord { id: `n${number}`; type: 'chronology' | 'causal' | 'explanatory' | 'argumentative' | 'decision_rationale' | 'other'; title: string; thesis: string; mode: 'source' | 'agent' | 'mixed'; members: Array<{ ref: LocalId; role: string }>; reason?: string; alternatives?: string[] }
export interface RelationTypeDefinition { id: string; p: 0 | 1 | 2 | 3; v: string; roles: string[]; definition: string; not: string }
export interface Relation extends CommonRecord { id: `r${number}`; p: 0 | 1 | 2 | 3; type: string; text?: string; args: RoleMap; claim?: `q${number}`[]; if?: string[]; unless?: string[]; reason?: string; single_source_reason?: string }
export interface Coverage { unprocessed?: Array<{ uri: string; why: string }>; limits?: string[] }

export interface KnowledgeDataset {
  schema: DatasetSchema; id: `ks_${string}`; generated: GeneratedInfo; selection?: Selection; scope: DatasetScope
  sources: Source[]; evidence: Evidence[]; entities: Entity[]; concepts: Concept[]; claims: Claim[]
  events: KnowledgeEvent[]; narratives: Narrative[]; relations: Relation[]; type_defs?: RelationTypeDefinition[]; coverage?: Coverage
}
export type KnowledgeRecord = Entity | Concept | Claim | KnowledgeEvent | Narrative | Relation
export interface ViewRecord {
  id: string; kind: KnowledgeKind; label: string; pointer: string; raw: KnowledgeRecord
  effectiveStatus: 'candidate' | NonNullable<CommonRecord['status']>; originalOrder: number
}

export type DiagnosticSeverity = 'error' | 'warning'
export interface Diagnostic { code: string; severity: DiagnosticSeverity; pointer: string; objectId?: string; message: string; suggestion: string }
export interface ValidationResult { valid: boolean; fatal: boolean; diagnostics: Diagnostic[]; isolatedIds: Set<string> }
export interface ParsedDataset { dataset?: KnowledgeDataset; raw?: unknown; diagnostics: Diagnostic[]; fatal: boolean; unsupported: boolean }
export interface ParseResult extends ParsedDataset {
  status: 'ready' | 'partial' | 'invalid' | 'unsupported'; uri: string; sourceText: string; snapshotHash: string
  records: ViewRecord[]; indexes?: DatasetIndexes
}

export interface DatasetIndexes {
  nodesById: Map<string, KnowledgeRecord>; sourcesById: Map<string, Source>; evidenceById: Map<string, Evidence>
  relationsByParticipant: Map<string, Relation[]>; recordsByEvidence: Map<string, KnowledgeRecord[]>; incomingReferences: Map<string, Array<{ from: string; field: string }>>
  kindById: Map<string, KnowledgeKind>; originalOrder: Map<string, number>
  isolatedIds?: Set<string>
}

export function isKnowledgeRecord(value: unknown): value is KnowledgeRecord {
  return !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' && /^[ecqvnr][1-9]\d*$/.test((value as { id: string }).id)
}

export function recordLabel(record: KnowledgeRecord): string {
  if ('name' in record) return record.name
  if ('term' in record) return record.term
  if ('text' in record && !('p' in record)) return record.text
  if ('title' in record) return record.title
  if ('text' in record && record.text) return record.text
  return record.id
}

export function effectiveStatus(record: KnowledgeRecord): 'candidate' | NonNullable<CommonRecord['status']> {
  return record.status ?? 'candidate'
}
