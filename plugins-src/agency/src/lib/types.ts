export interface Source {
  id: string
  path: string
  sha256: string
  title: string
  started: string
  ended: string
  user_turns: number
}
export interface Scan {
  date: string
  considered: number
  sources: Source[]
  excluded: { path: string; reason: string }[]
  warnings: string[]
}
export type SignalState = 'observed' | 'not_observed' | 'unknown' | 'not_applicable'
export interface Signal { state: SignalState; note: string; evidence_indices: number[] }
export interface Evidence { line: number; quote: string; kind: 'user' | 'assistant' }
export interface Finding { note: string; evidence_indices: number[] }
export interface Experiment { action: string; check: string; evidence_indices: number[] }
export interface Practical {
  progress: Finding | null
  friction: Finding | null
  expansion: Finding | null
  experiment: Experiment | null
}
export interface Episode {
  id: string
  source_id: string
  title: string
  goal_origin: 'user' | 'adopted' | 'delegated' | 'unknown'
  outcome: 'ongoing' | 'assistant_reported' | 'user_confirmed' | 'stopped' | 'unknown'
  efficacy: Signal
  optimism: Signal
  imagination: Signal
  evidence: Evidence[]
  contribution: string[]
  friction: string | null
  practical?: Practical | null
}
export interface Review { excluded: boolean; note: string }
export interface Batch {
  id: string
  date: string
  created_at: string
  provider: string
  rule_version?: number
  scan: Scan
  episodes: Episode[]
  skipped_sources: { source_id: string; reason: string }[]
  suggestion: string | null
  reviews: Record<string, Review>
}
export interface DaySummary { date: string; batch_id: string; episodes: number; observed: number; excluded: number; created_at: string }
export interface QueueItem {
  date: string
  state: 'pending' | 'running' | 'done' | 'reused' | 'skipped' | 'failed' | 'cancelled'
  message: string
  episodes?: number
  error?: string
}
export interface Job {
  id: string
  date: string
  state: 'running' | 'done' | 'partial' | 'failed' | 'cancelled'
  message: string
  run_id?: string
  error?: string
  start_date?: string
  end_date?: string
  items?: QueueItem[]
  stop_requested?: boolean
}
export interface Snapshot { batch: Batch | null; history: DaySummary[]; job: Job | null }
export interface Provider {
  id: string
  name: string
  harness?: {
    ok: boolean
    hint?: string | null
    warning?: string | null
    capabilities?: { terminal_result?: boolean; input_only_isolation?: boolean; tasks?: string[] } | null
  } | null
}
export interface Providers { providers: Provider[]; default: string }
