import { activeTab } from '../tabs.svelte'
import { showError } from '../dialogs'
import { pushToast } from '../toast.svelte'
import { t as tr } from '../i18n/store.svelte'
import { chunkDocument } from '../blockchunk/chunker'
import { chunkDocumentSemantic } from '../blockchunk/semantic-chunker'
import {
  computeFingerprint,
  serializeMinHash,
  parseMinHash,
} from '../blockchunk/fingerprint'
import { newBlockId } from '../blockchunk/id'
import {
  mergeBlocks,
  type OldBlockEntry,
  type NewBlockEntry,
} from '../blockchunk/merge'
import {
  type BlockYaml,
  type ActiveBlock,
  type RetiredBlock,
  SCHEMA_VERSION,
  DEFAULT_CONFIG,
} from '../blockio/yaml-schema'
import { readBlockYaml, writeBlockYamlAtomic } from '../blockio/yaml-rw'
import { generateBlockMd, splitFrontmatter } from '../blockio/inject'
import type { BlockYamlConfig } from '../blockio/yaml-schema'
import { settings } from '../settings.svelte'
import { citationAtCursor, resolveCitation } from '../blockio/citation'

// ---- Path helpers ----

function basename(p: string): string {
  return p.replace(/^.*\//, '')
}

import { cachedYamlPath, blockMdPathFor } from './path'

const yamlPathFor = (mdPath: string): Promise<string> => cachedYamlPath(mdPath)

// ---- Hash + IO helpers ----

async function sourceHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('').slice(0, 16)
}

async function readSource(mdPath: string): Promise<string> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  return await readTextFile(mdPath)
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

function reservedIdsFromYaml(y: BlockYaml | null): Set<string> {
  if (!y) return new Set()
  const s = new Set<string>()
  for (const a of y.active) s.add(a.id)
  for (const h of y.history) s.add(h.id)
  return s
}

// ---- Stats ----

interface MergeStats {
  active: number
  kept: number
  edited: number
  splits: number
  merges: number
  fresh: number
  retired: number
}

// ---- Core: chunk + merge + build new yaml ----

export async function computeAndBuildYaml(
  mdPath: string,
  source: string,
  prev: BlockYaml | null,
): Promise<{ yaml: BlockYaml; stats: MergeStats }> {
  // For first-time compute, seed config from user settings (so the Settings
  // UI defaults take effect). For refresh, prev.config wins so per-document
  // overrides survive global setting changes.
  const seedCfg: BlockYamlConfig = prev
    ? prev.config
    : {
        ...DEFAULT_CONFIG,
        chunk_strategy: settings.mdblock.chunkStrategy,
        chunk_size_chars: settings.mdblock.chunkSizeChars,
        section_cut_level: settings.mdblock.sectionCutLevel,
        section_min_chars: settings.mdblock.sectionMinChars,
        similarity_threshold: settings.mdblock.similarityThreshold,
        split_coverage_threshold: settings.mdblock.splitCoverageThreshold,
        inject_ai_hint: settings.mdblock.injectAiHint,
      }
  // Defensive clamp: protect chunker from out-of-range config values that
  // could slip in via Settings UI paste / hand-edit of yaml.
  const rawCfg = seedCfg
  const cfg: typeof rawCfg = {
    ...rawCfg,
    chunk_strategy: rawCfg.chunk_strategy ?? 'section',
    chunk_size_chars: clamp(rawCfg.chunk_size_chars, 200, 20000),
    break_window_chars: clamp(rawCfg.break_window_chars, 50, 5000),
    section_cut_level: clamp(rawCfg.section_cut_level ?? 2, 1, 6),
    section_min_chars: clamp(rawCfg.section_min_chars ?? 400, 0, 5000),
    similarity_threshold: clamp(rawCfg.similarity_threshold, 0, 1),
    split_coverage_threshold: clamp(rawCfg.split_coverage_threshold, 0, 1),
  }
  // Frontmatter is preserved verbatim and never chunked. Run chunker on the
  // body alone, then offset src_pos/src_line back to full-source coordinates
  // so callers and citations land in the right place.
  const fm = splitFrontmatter(source)
  const bodyBlocks =
    cfg.chunk_strategy === 'size'
      ? chunkDocument(fm.body, cfg.chunk_size_chars, 0, cfg.break_window_chars)
      : chunkDocumentSemantic(fm.body, {
          cutLevel: cfg.section_cut_level,
          maxChars: cfg.chunk_size_chars,
          minChars: cfg.section_min_chars,
          windowChars: cfg.break_window_chars,
        })
  const newBlocks = bodyBlocks.map((b) => ({
    text: b.text,
    src_pos: b.src_pos + fm.fm.length,
    src_line: b.src_line + fm.fmLines,
  }))

  // Fingerprints (parallel)
  const newFps = await Promise.all(newBlocks.map((b) => computeFingerprint(b.text)))
  const newEntries: NewBlockEntry[] = newFps.map((fp) => ({ fp }))

  // Old entries: rebuild fingerprints from the persisted MinHash signature.
  // No re-tokenization needed because v2 schema stores the signature directly.
  const oldEntries: OldBlockEntry[] = prev
    ? prev.active.map((a) => ({
        id: a.id,
        fp: {
          hash: a.fingerprint.hash,
          length: a.fingerprint.length,
          minhash: parseMinHash(a.fingerprint.minhash),
        },
      }))
    : []

  const generation = (prev?.meta.generation ?? 0) + 1
  const out = mergeBlocks(
    oldEntries,
    newEntries,
    cfg.similarity_threshold,
    cfg.split_coverage_threshold,
  )

  // Allocate ids and lineage per merge contract
  const reserved = reservedIdsFromYaml(prev)
  const newIds: string[] = new Array(newBlocks.length).fill('')
  const newParents: string[][] = new Array(newBlocks.length).fill(null).map(() => [])
  const newCreatedGen: number[] = new Array(newBlocks.length).fill(generation)

  // kept: inherit oldId; preserve old created_gen; parents=[]
  for (const k of out.kept) {
    newIds[k.newIdx] = k.oldId
    const old = prev!.active.find((x) => x.id === k.oldId)!
    newCreatedGen[k.newIdx] = old.created_gen
  }
  // edited: inherit oldId; preserve old created_gen; parents=[]
  for (const e of out.edited) {
    newIds[e.newIdx] = e.oldId
    const old = prev!.active.find((x) => x.id === e.oldId)!
    newCreatedGen[e.newIdx] = old.created_gen
  }
  // splits.newIdx: inherit oldId; preserve old created_gen; parents=[]
  // splits.siblings: fresh id; parents=[oldId]; new created_gen
  for (const sp of out.splits) {
    newIds[sp.newIdx] = sp.oldId
    const old = prev!.active.find((x) => x.id === sp.oldId)!
    newCreatedGen[sp.newIdx] = old.created_gen
    for (const sib of sp.siblings) {
      const id = newBlockId(reserved); reserved.add(id)
      newIds[sib] = id
      newParents[sib] = [sp.oldId]
      newCreatedGen[sib] = generation
    }
  }
  // merges: fresh id; parents=oldIds; new created_gen
  for (const m of out.merges) {
    const id = newBlockId(reserved); reserved.add(id)
    newIds[m.newIdx] = id
    newParents[m.newIdx] = [...m.oldIds]
    newCreatedGen[m.newIdx] = generation
  }
  // fresh: fresh id; parents=[]; new created_gen
  for (const f of out.fresh) {
    const id = newBlockId(reserved); reserved.add(id)
    newIds[f.newIdx] = id
    newCreatedGen[f.newIdx] = generation
  }

  // Build active[] (sorted by src_pos via newBlocks order). Compute end
  // extents (1-based src_end_line, exclusive src_end_pos) so the yaml is
  // self-describing for line-range consumers.
  const active: ActiveBlock[] = newBlocks.map((b, i) => {
    const newlines = (b.text.match(/\n/g) ?? []).length
    return {
      id: newIds[i],
      src_line: b.src_line,
      src_pos: b.src_pos,
      src_end_line: b.src_line + newlines,
      src_end_pos: b.src_pos + b.text.length,
      fingerprint: {
        hash: newFps[i].hash,
        length: newFps[i].length,
        minhash: serializeMinHash(newFps[i].minhash),
      },
      parents: newParents[i],
      created_gen: newCreatedGen[i],
    }
  })

  // Build history: carry forward + append new retirements. Schema v2 retires
  // store only the persisted fingerprint (no inline text); a retired block's
  // identity for citation-chain resolution is its id, not its content.
  const history: RetiredBlock[] = prev ? prev.history.map((h) => ({ ...h })) : []

  // 1. Pure deletions (out.retired)
  for (const r of out.retired) {
    const oldRecord = prev!.active.find((x) => x.id === r.oldId)!
    history.push({
      id: r.oldId,
      retired_gen: generation,
      replaced_by: [],
      last_fingerprint: { ...oldRecord.fingerprint },
    })
  }
  // 2. Merge-derived retirements (from out.merges)
  for (const m of out.merges) {
    const successorId = newIds[m.newIdx]
    for (const oldId of m.oldIds) {
      const oldRecord = prev!.active.find((x) => x.id === oldId)!
      history.push({
        id: oldId,
        retired_gen: generation,
        replaced_by: [successorId],
        last_fingerprint: { ...oldRecord.fingerprint },
      })
    }
  }

  const yaml: BlockYaml = {
    meta: {
      source: basename(mdPath),
      source_hash: await sourceHash(source),
      generation,
      updated_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
      has_block_md: prev?.meta.has_block_md ?? false,
    },
    config: cfg,
    active,
    history,
  }

  const stats: MergeStats = {
    active: active.length,
    kept: out.kept.length,
    edited: out.edited.length,
    splits: out.splits.length,
    merges: out.merges.length,
    fresh: out.fresh.length,
    retired: out.retired.length + out.merges.reduce((n, m) => n + m.oldIds.length, 0),
  }

  return { yaml, stats }
}

async function writeBlockMdIfNeeded(
  mdPath: string,
  source: string,
  yaml: BlockYaml,
): Promise<BlockYaml> {
  if (!yaml.meta.has_block_md) return yaml
  const { writeTextFile, rename, exists, remove } = await import('@tauri-apps/plugin-fs')
  const out = generateBlockMd(source, yaml.active, yaml.config.inject_ai_hint, yaml.meta.source)
  for (const a of yaml.active) {
    a.out_line = out.outLines.get(a.id)
  }
  const p = blockMdPathFor(mdPath)
  const tmp = `${p}.tmp`
  await writeTextFile(tmp, out.output)
  if (await exists(p)) await remove(p)
  await rename(tmp, p)
  return yaml
}

function emitYamlUpdated(filePath: string): void {
  // Browser env only — guard for test runs that may import this file.
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('mdblock:yaml-updated', { detail: { filePath } }))
  }
}

// ---- Public commands ----

async function doFirstTimeCompute(filePath: string, source: string): Promise<void> {
  const { yaml, stats } = await computeAndBuildYaml(filePath, source, null)
  await writeBlockYamlAtomic(await yamlPathFor(filePath), yaml)
  emitYamlUpdated(filePath)
  pushToast({ level: 'success', message: `Computed: ${stats.active} blocks (gen 1)` })
}

/**
 * Persist the in-memory liveYaml (computed by recomputeLiveYaml) to disk.
 * Called by the tab save flow so saving the .md also commits the matching
 * block.yaml in one shot — avoids the separate Cmd+Shift+B step. If no
 * liveYaml exists yet, falls through to a fresh compute against the saved
 * source.
 */
export async function persistLiveYamlOrCompute(filePath: string, source: string): Promise<void> {
  const { getHoverState } = await import('../mdblock-hover/hover-store.svelte')
  const state = getHoverState(filePath)
  let yaml = state?.liveYaml ?? null
  if (!yaml) {
    // No live preview yet; either no yaml at all (first time) or the user
    // didn't trigger a recompute. Run the full pipeline against the saved
    // source.
    const prev = await readBlockYaml(await yamlPathFor(filePath))
    const built = await computeAndBuildYaml(filePath, source, prev)
    yaml = built.yaml
  }
  yaml = await writeBlockMdIfNeeded(filePath, source, yaml)
  await writeBlockYamlAtomic(await yamlPathFor(filePath), yaml)
  emitYamlUpdated(filePath)
}

export async function cmdMdblockCompute(): Promise<void> {
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return
  try {
    const source = await readSource(t.filePath)
    await doFirstTimeCompute(t.filePath, source)
  } catch (e) {
    await showError(`mdblock.compute failed: ${e}`)
  }
}

export async function cmdMdblockRefresh(): Promise<void> {
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return
  try {
    const source = await readSource(t.filePath)
    const prev = await readBlockYaml(await yamlPathFor(t.filePath))
    if (!prev) {
      // First-time → reuse the source we already read
      await doFirstTimeCompute(t.filePath, source)
      return
    }
    const newHash = await sourceHash(source)
    if (newHash === prev.meta.source_hash) {
      // Source unchanged; regenerate .block.md if it's expected to be in sync
      let yaml = prev
      if (yaml.meta.has_block_md) {
        yaml = await writeBlockMdIfNeeded(t.filePath, source, yaml)
        await writeBlockYamlAtomic(await yamlPathFor(t.filePath), yaml)
        emitYamlUpdated(t.filePath)
      }
      pushToast({ level: 'info', message: 'No changes detected' })
      return
    }
    let { yaml, stats } = await computeAndBuildYaml(t.filePath, source, prev)
    yaml = await writeBlockMdIfNeeded(t.filePath, source, yaml)
    await writeBlockYamlAtomic(await yamlPathFor(t.filePath), yaml)
    emitYamlUpdated(t.filePath)
    pushToast({
      level: 'success',
      message:
        `Refreshed: ${stats.active} active, ` +
        `${stats.kept} kept, ${stats.edited} edited, ` +
        `${stats.splits} split, ${stats.merges} merged, ` +
        `${stats.fresh} fresh, ${stats.retired} retired`,
    })
  } catch (e) {
    await showError(`mdblock.refresh failed: ${e}`)
  }
}

export async function cmdMdblockGenerateBlockMd(): Promise<void> {
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return
  try {
    const source = await readSource(t.filePath)
    let prev = await readBlockYaml(await yamlPathFor(t.filePath))
    if (!prev) {
      // No yaml yet — compute first
      const built = await computeAndBuildYaml(t.filePath, source, null)
      prev = built.yaml
    }
    prev.meta.has_block_md = true
    prev = await writeBlockMdIfNeeded(t.filePath, source, prev)
    await writeBlockYamlAtomic(await yamlPathFor(t.filePath), prev)
    emitYamlUpdated(t.filePath)
    pushToast({ level: 'success', message: `Wrote ${blockMdPathFor(t.filePath)}` })
  } catch (e) {
    await showError(`mdblock.generateBlockMd failed: ${e}`)
  }
}

export async function cmdMdblockReset(): Promise<void> {
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return
  const { confirm } = await import('@tauri-apps/plugin-dialog')
  const ok = await confirm(
    'This will discard all block-id lineage and reassign fresh ids to every block. ' +
    'External references to old ids will resolve to "deleted". Continue?',
    { title: 'Reset block ids', kind: 'warning' },
  )
  if (!ok) return
  try {
    const source = await readSource(t.filePath)
    // Preserve the user's "I want a .block.md generated" preference across
    // the reset so they aren't left with a stale .block.md whose anchors
    // point at retired ids the new yaml never heard of.
    const prev = await readBlockYaml(await yamlPathFor(t.filePath))
    const wantsBlockMd = prev?.meta.has_block_md ?? false
    let { yaml, stats } = await computeAndBuildYaml(t.filePath, source, null)
    if (wantsBlockMd) {
      yaml.meta.has_block_md = true
      yaml = await writeBlockMdIfNeeded(t.filePath, source, yaml)
    }
    await writeBlockYamlAtomic(await yamlPathFor(t.filePath), yaml)
    emitYamlUpdated(t.filePath)
    pushToast({ level: 'success', message: `Reset: ${stats.active} fresh blocks (gen 1)` })
  } catch (e) {
    await showError(`mdblock.reset failed: ${e}`)
  }
}

export async function cmdMdblockFollowCitationAtCursor(): Promise<boolean> {
  // Returns true if a citation was followed (or the citation was found but
  // unresolvable — e.g., target deleted), false to let the caller fall back
  // to default keystroke handling (e.g., insert newline).
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return false

  // Source mode renders an active textarea with the .src-textarea class.
  // If we're in rich mode (no such textarea is mounted), silently skip.
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea.src-textarea')
  if (!textarea) return false
  const cursor = textarea.selectionStart
  const text = textarea.value
  const cite = citationAtCursor(text, cursor)
  if (!cite) return false

  try {
    const r = await resolveCitation(cite.pageuri, cite.blockid, t.filePath)
    if (r.status === 'not_found') {
      pushToast({ level: 'warn', message: r.banner ?? tr('citation.notFound') })
      return true
    }
    if (r.status === 'deleted') {
      pushToast({ level: 'warn', message: r.banner! })
      return true
    }
    // Open the target file (if different) and jump to the line.
    const { openFile } = await import('../tabs.svelte')
    if (r.filePath !== t.filePath) {
      await openFile(r.filePath)
    }
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('mdblock:jump', {
        detail: { filePath: r.filePath, srcLine: r.srcLine, blockid: cite.blockid },
      }))
    })
    if (r.banner) pushToast({ level: 'info', message: r.banner })
    return true
  } catch (e) {
    await showError(`mdblock.followCitation failed: ${e}`)
    return true
  }
}
