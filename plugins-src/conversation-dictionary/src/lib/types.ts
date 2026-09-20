export type Domain = { id: string; name: string; description: string }
export type Entry = { id: string; kind: string; label: string; forms: string[]; description: string }
export type Rule = {
  id: string
  domain_id: string
  observed: string
  action: 'replace' | 'preserve'
  target?: { entry_id: string; text: string }
  application?: 'suggest' | 'automatic'
  enabled: boolean
  confirmed_by: string
  confirmed_at: string
}
export type Dictionary = {
  schema: string
  dictionary_id: string
  revision: number
  updated_at: string
  subject_id: string
  scope: string
  domains: Domain[]
  entries: Entry[]
  rules: Rule[]
}
export type DatasetProposal = {
  id: string
  kind: 'create_domain' | 'create_entry' | 'add_forms' | 'create_rule'
  depends_on: string[]
  value: Record<string, any>
  evidence_ids: string[]
  reason: string
}
export type ProposalReview = {
  revision: number
  status: 'pending' | 'accepted' | 'dismissed'
  permanent_id?: string
  edited_value?: Record<string, any>
}
export type ReviewBatch = {
  run_id: string
  dataset_sha256: string
  imported_at: string
  dataset: {
    state: 'completed' | 'partial'
    coverage: {
      discovered: number
      processed: number
      excluded: number
      unknown_scope: number
      failed: number
      pending: number
      chunks_planned: number
      chunks_processed: number
    }
    proposals: DatasetProposal[]
    conflicts: unknown[]
    unresolved: unknown[]
  }
  proposal_states: Record<string, ProposalReview>
}
export type Candidate = {
  id: string
  status: string
  received_at: string
  observed: string
  domain_id: string
  candidates: Array<{ output: string; confidence: number; reason: string }>
}
export type DictionaryExample = {
  schema: string
  example_only: true
  description: string
  domain: { id: string; name: string }
  entry: { id: string; kind: string; label: string; forms: string[] }
  rule: {
    domain_id: string
    observed: string
    action: 'replace' | 'preserve'
    target?: { entry_id: string; text: string }
    application?: 'suggest' | 'automatic'
    enabled: false
  }
}
export type AgentIntegration = {
  status: 'ready' | 'needs_initialization'
  agents_path: string
  agents_ready: boolean
  skill_path: string
  skill_ready: boolean
}
export type Snapshot = {
  settings: { schema: string; dictionary_path: string }
  status: Record<string, any>
  dictionary: Dictionary | null
  candidates: Candidate[]
  batches: ReviewBatch[]
  agent_integration: AgentIntegration
  example: DictionaryExample
}
export type InitializationResult = {
  status: 'created' | 'existing'
  dictionary_created: boolean
}
