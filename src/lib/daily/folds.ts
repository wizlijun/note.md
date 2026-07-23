// src/lib/daily/folds.ts — lightweight per-note fold memory for the Daily Notes
// feed. Daily outlines default COLLAPSED; this records which nodes the user has
// EXPANDED, keyed by the note's vault-relative path → set of expanded node index
// paths (e.g. "0.2" = 3rd child of the 1st root). Stored in the git-synced
// `.notemd/outliner-folds.json` (NOT in the .note.md) so fold state survives, stays
// out of the portable file, and syncs across devices via the vault's git sync.
//
// Multi-device note: the whole map is rewritten on each toggle. Two devices
// editing folds concurrently can produce a git merge conflict on this one JSON;
// that is low-stakes (fold state) and resolves like any other synced file.

import { childrenOf, type OutlineTree, type OutlineNode } from '../outline/model'
import { todayStr } from '../outline/daily'
import { addDays } from './dates'

/** vaultRelPath → array of expanded index-path keys ("0.2.1"). */
type FoldMap = Record<string, string[]>

// Plain module cache (NOT $state — runes only work in .svelte/.svelte.ts; this is
// read imperatively during reload/attach, no reactivity needed).
const state: { map: FoldMap; loadedRoot: string | null } = { map: {}, loadedRoot: null }

const FILE_REL = '.notemd/outliner-folds.json'

function joinAbs(vaultRoot: string, rel: string): string {
  return vaultRoot.endsWith('/') ? vaultRoot + rel : `${vaultRoot}/${rel}`
}

/** Vault-relative key for a note (device-independent). Falls back to the raw path. */
export function noteKey(vaultRoot: string | null, notePath: string): string {
  if (vaultRoot && notePath.startsWith(vaultRoot)) {
    return notePath.slice(vaultRoot.length).replace(/^\/+/, '')
  }
  return notePath
}

/** Index-path → stable string key. */
export function pathKey(path: number[]): string {
  return path.join('.')
}

/** Index path of a node within a tree (structural position, id-independent, so it
 *  maps between a read-only parse and the editor's attached tree). */
export function pathOfNodeIn(tree: OutlineTree, id: string): number[] {
  const path: number[] = []
  let cur: OutlineNode | undefined = tree.nodes.get(id)
  while (cur) {
    const parentId: string | null = cur.parentId
    const idx = childrenOf(tree, parentId).findIndex((s) => s.id === cur!.id)
    if (idx < 0) break
    path.unshift(idx)
    cur = parentId ? tree.nodes.get(parentId) : undefined
  }
  return path
}

/** Dated daily-note keys look like `.../2026-07-23.note.md`; capture the date. */
const DATE_IN_KEY = /(\d{4}-\d{2}-\d{2})\.note\.md$/

/** Drop entries for dated notes older than `cutoffDate` (yyyy-MM-dd) to cap the
 *  single state file's size. Non-dated keys (e.g. wiki pages) are kept. Returns
 *  whether anything was removed. */
export function pruneOldFolds(cutoffDate: string): boolean {
  let changed = false
  for (const key of Object.keys(state.map)) {
    const m = key.match(DATE_IN_KEY)
    if (m && m[1] < cutoffDate) {
      delete state.map[key]
      changed = true
    }
  }
  return changed
}

/** Load the fold map from `.notemd/outliner-folds.json` into the in-memory cache,
 *  pruning dated entries older than 90 days so the file stays small. */
export async function loadDailyFolds(vaultRoot: string): Promise<void> {
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const text = await readTextFile(joinAbs(vaultRoot, FILE_REL)).catch(() => '')
    state.map = text ? (JSON.parse(text) as FoldMap) : {}
  } catch {
    state.map = {}
  }
  state.loadedRoot = vaultRoot
  if (pruneOldFolds(addDays(todayStr(), -90))) await persist(vaultRoot)
}

async function persist(vaultRoot: string): Promise<void> {
  try {
    const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs')
    await mkdir(joinAbs(vaultRoot, '.notemd'), { recursive: true }).catch(() => {})
    await writeTextFile(joinAbs(vaultRoot, FILE_REL), JSON.stringify(state.map, null, 0))
  } catch {
    /* best-effort */
  }
}

/** Record the node at `path` as EXPANDED (add its key) or collapsed (remove it),
 *  then persist. Default is: first level (path length 1) EXPANDED and never
 *  recorded; everything deeper COLLAPSED unless its key is present here. So the KV
 *  only ever stores the nodes the user manually expanded beyond the default. */
export async function setPathExpanded(
  vaultRoot: string,
  key: string,
  path: number[],
  expanded: boolean,
): Promise<void> {
  if (path.length < 2) return // first level always expanded — never recorded
  const pk = pathKey(path)
  const cur = new Set(state.map[key] ?? [])
  if (expanded) cur.add(pk)
  else cur.delete(pk)
  if (cur.size) state.map[key] = [...cur]
  else delete state.map[key]
  await persist(vaultRoot)
}

/** Apply the fold memory to a freshly-parsed tree: the FIRST level (top-level
 *  nodes, path length 1) is always EXPANDED; every deeper node is COLLAPSED by
 *  default UNLESS its index path was remembered expanded in the KV. Mutates
 *  `node.collapsed` in place. */
export function applyFolds(tree: OutlineTree, key: string): void {
  const expanded = new Set(state.map[key] ?? [])
  const walk = (parentId: string | null, path: number[]) => {
    childrenOf(tree, parentId).forEach((n: OutlineNode, i: number) => {
      const p = [...path, i]
      n.collapsed = p.length >= 2 && !expanded.has(pathKey(p))
      walk(n.id, p)
    })
  }
  walk(null, [])
}
