/**
 * Persistent shape of `<basename>.block.yaml`. This file is the source of
 * truth for block ids; generated `.block.md` is a derivative artifact.
 *
 * v2 schema: dropped `text` from active and retired blocks. Block content
 * is no longer duplicated in yaml; instead, every block stores a MinHash
 * signature (256 hex chars) inside `fingerprint.minhash`, which the merge
 * algorithm uses to estimate Jaccard similarity at next refresh. Source
 * extents are described by `src_line/src_pos` (start) and the block's
 * length (`fingerprint.length` is the *normalized* char count; the unmodified
 * source byte length is recoverable as `next_block.src_pos - this.src_pos`).
 *
 * Migration: v1 yaml is rejected by the parser; the caller renames it to
 * `*.broken-<ts>` and the user re-runs Compute Blocks to produce v2.
 */

export const SCHEMA_VERSION = 2

export interface BlockYamlMeta {
  source: string             // basename of the source .md, relative to yaml dir
  source_hash: string        // short SHA-256 of source content
  generation: number         // monotonic; bumped on each merge round
  updated_at: string         // ISO-8601
  schema_version: number     // SCHEMA_VERSION
  has_block_md: boolean      // whether .block.md is in sync with this yaml
}

export interface BlockYamlConfig {
  chunk_strategy?: 'size' | 'section'  // default 'section'
  chunk_size_chars: number              // size mode: target; section mode: max per block
  break_window_chars: number            // size mode only
  section_cut_level?: number            // section mode: heading depth (1..6); default 2
  section_min_chars?: number            // section mode: merge threshold; default 400
  similarity_threshold: number
  split_coverage_threshold: number
  inject_ai_hint: boolean
}

export interface PersistedFingerprint {
  hash: string               // 12 hex
  length: number             // normalized char count
  minhash: string            // hex-encoded MinHash signature (k=32, 256 chars)
}

export interface ActiveBlock {
  id: string
  src_line: number           // 1-based line of the block's first character
  src_pos: number            // char offset in source
  src_end_line?: number      // 1-based line of the block's last character
  src_end_pos?: number       // char offset just past the block's last character
  out_line?: number          // present only when meta.has_block_md=true
  fingerprint: PersistedFingerprint
  parents: string[]          // empty for kept/edited; non-empty for splits/merges
  created_gen: number        // birth generation; never updated on inheritance
}

export interface RetiredBlock {
  id: string
  retired_gen: number
  replaced_by: string[]      // [] = pure deletion; otherwise successor ids
  last_fingerprint: PersistedFingerprint
}

export interface BlockYaml {
  meta: BlockYamlMeta
  config: BlockYamlConfig
  active: ActiveBlock[]
  history: RetiredBlock[]
}

export const DEFAULT_CONFIG: BlockYamlConfig = {
  chunk_strategy: 'section',
  chunk_size_chars: 2400,
  break_window_chars: 800,
  section_cut_level: 2,
  section_min_chars: 400,
  similarity_threshold: 0.5,
  split_coverage_threshold: 0.3,
  inject_ai_hint: true,
}
