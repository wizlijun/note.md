/**
 * Persistent shape of `<basename>.block.yaml`. This file is the source of
 * truth for block ids; generated `.block.md` is a derivative artifact.
 *
 * Schema version 1. Future migrations should bump SCHEMA_VERSION and write a
 * migration in yaml-rw.ts.
 */

export const SCHEMA_VERSION = 1

export interface BlockYamlMeta {
  source: string             // basename of the source .md, relative to yaml dir
  source_hash: string        // short SHA-256 of source content
  generation: number         // monotonic; bumped on each merge round
  updated_at: string         // ISO-8601
  schema_version: number     // SCHEMA_VERSION
  has_block_md: boolean      // whether .block.md is in sync with this yaml
}

export interface BlockYamlConfig {
  chunk_size_chars: number
  break_window_chars: number
  similarity_threshold: number
  split_coverage_threshold: number
  inject_ai_hint: boolean
}

export interface ActiveBlock {
  id: string
  src_line: number
  src_pos: number
  out_line?: number          // present only when meta.has_block_md=true
  fingerprint: { hash: string; length: number }
  text: string               // normalized text, used by next merge round
  parents: string[]          // empty for kept/edited; non-empty for splits/merges
  created_gen: number        // birth generation; never updated on inheritance
}

export interface RetiredBlock {
  id: string
  retired_gen: number
  replaced_by: string[]      // [] = pure deletion; otherwise successor ids
  last_fingerprint: { hash: string; length: number }
  text?: string              // retained for recent retirements only
}

export interface BlockYaml {
  meta: BlockYamlMeta
  config: BlockYamlConfig
  active: ActiveBlock[]
  history: RetiredBlock[]
}

export const DEFAULT_CONFIG: BlockYamlConfig = {
  chunk_size_chars: 2400,
  break_window_chars: 800,
  similarity_threshold: 0.5,
  split_coverage_threshold: 0.3,
  inject_ai_hint: true,
}

/** How many generations of history retain `.text`. Older keep only fingerprint. */
export const HISTORY_TEXT_KEEP_GENS = 5
