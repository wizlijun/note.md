import { activeTab } from '../tabs.svelte'
import { showError } from '../dialogs'
import { pushToast } from '../toast.svelte'
import { chunkDocument } from '../blockchunk/chunker'
import { computeFingerprint } from '../blockchunk/fingerprint'
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
  HISTORY_TEXT_KEEP_GENS,
} from '../blockio/yaml-schema'
import { readBlockYaml, writeBlockYamlAtomic } from '../blockio/yaml-rw'
import { generateBlockMd } from '../blockio/inject'

// ---- Path helpers ----

function basename(p: string): string {
  return p.replace(/^.*\//, '')
}

function yamlPathFor(mdPath: string): string {
  return mdPath.endsWith('.md')
    ? mdPath.slice(0, -3) + '.block.yaml'
    : `${mdPath}.block.yaml`
}

function blockMdPathFor(mdPath: string): string {
  return mdPath.endsWith('.md')
    ? mdPath.slice(0, -3) + '.block.md'
    : `${mdPath}.block.md`
}

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

async function computeAndBuildYaml(
  mdPath: string,
  source: string,
  prev: BlockYaml | null,
): Promise<{ yaml: BlockYaml; stats: MergeStats }> {
  const cfg = prev?.config ?? DEFAULT_CONFIG
  const newBlocks = chunkDocument(
    source,
    cfg.chunk_size_chars,
    0,
    cfg.break_window_chars,
  )

  // Fingerprints (parallel)
  const newFps = await Promise.all(newBlocks.map((b) => computeFingerprint(b.text)))
  const newEntries: NewBlockEntry[] = newBlocks.map((b, i) => ({ fp: newFps[i], text: b.text }))

  // Old entries from prev yaml
  const oldEntries: OldBlockEntry[] = []
  if (prev) {
    for (const a of prev.active) {
      const fp = await computeFingerprint(a.text)
      oldEntries.push({ id: a.id, fp, text: a.text })
    }
  }

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

  // Build active[] (sorted by src_pos via newBlocks order)
  const active: ActiveBlock[] = newBlocks.map((b, i) => ({
    id: newIds[i],
    src_line: b.src_line,
    src_pos: b.src_pos,
    fingerprint: { hash: newFps[i].hash, length: newFps[i].length },
    text: b.text,
    parents: newParents[i],
    created_gen: newCreatedGen[i],
  }))

  // Build history: carry forward + append new retirements
  const history: RetiredBlock[] = prev ? prev.history.map((h) => ({ ...h })) : []

  // 1. Pure deletions (out.retired)
  for (const r of out.retired) {
    const oldRecord = prev!.active.find((x) => x.id === r.oldId)!
    history.push({
      id: r.oldId,
      retired_gen: generation,
      replaced_by: [],
      last_fingerprint: {
        hash: oldRecord.fingerprint.hash,
        length: oldRecord.fingerprint.length,
      },
      text: oldRecord.text,
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
        last_fingerprint: {
          hash: oldRecord.fingerprint.hash,
          length: oldRecord.fingerprint.length,
        },
        text: oldRecord.text,
      })
    }
  }

  // 3. GC history.text: keep only recent or pure-deletion entries
  for (const h of history) {
    const isRecent = generation - h.retired_gen <= HISTORY_TEXT_KEEP_GENS
    const isDeletion = h.replaced_by.length === 0
    if (!isRecent && !isDeletion) delete h.text
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
  await writeBlockYamlAtomic(yamlPathFor(filePath), yaml)
  emitYamlUpdated(filePath)
  pushToast({ level: 'success', message: `Computed: ${stats.active} blocks (gen 1)` })
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
    const prev = await readBlockYaml(yamlPathFor(t.filePath))
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
        await writeBlockYamlAtomic(yamlPathFor(t.filePath), yaml)
        emitYamlUpdated(t.filePath)
      }
      pushToast({ level: 'info', message: 'No changes detected' })
      return
    }
    let { yaml, stats } = await computeAndBuildYaml(t.filePath, source, prev)
    yaml = await writeBlockMdIfNeeded(t.filePath, source, yaml)
    await writeBlockYamlAtomic(yamlPathFor(t.filePath), yaml)
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
