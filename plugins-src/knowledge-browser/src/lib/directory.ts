import { DATASET_SCHEMA, type KnowledgeKind } from './types'

export const DEFAULT_DATASET_DIRECTORY = 'research'
export const MAX_DATASET_FILES = 500
export const MAX_DIRECTORY_DEPTH = 10
export const DIRECTORY_READ_CONCURRENCY = 2

const CONTROL_DIRECTORIES = new Set([
  '.git', '.notemd', 'node_modules', 'vendor', 'target', 'dist', 'dist-plugins',
])
const KNOWLEDGE_KINDS: KnowledgeKind[] = ['entities', 'concepts', 'claims', 'events', 'narratives', 'relations']

export interface DirectoryIo {
  list(path: string): Promise<Array<{ name: string; is_dir: boolean }>>
  read(path: string): Promise<string>
}

export type DatasetDirectoryStatus = 'available' | 'unsupported' | 'invalid' | 'read-error'

export interface DatasetDirectoryItem {
  path: string
  name: string
  title: string
  status: DatasetDirectoryStatus
  schema?: string
  datasetId?: string
  purpose?: string
  generatedAt?: string
  counts?: Record<KnowledgeKind, number>
  snapshotHash?: string
  error?: string
  copyState?: 'unique' | 'same-copy' | 'different-snapshot'
}

export interface DatasetScanResult {
  items: DatasetDirectoryItem[]
  truncated: boolean
  cancelled: boolean
  errors: Array<{ path: string; message: string }>
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function matchesDatasetName(name: string): boolean {
  return /(?:-knowledge-[^/]*)\.json$/.test(name) || /\.knowledge\.json$/.test(name)
}

/** Normalize a user preference before it reaches host.vault.list. */
export function normalizeDatasetDirectory(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
    || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || CONTROL_DIRECTORIES.has(part))) return null
  return parts.join('/')
}

function joinPath(parent: string, name: string): string { return parent ? `${parent}/${name}` : name }

async function sha256Text(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function summarizeDataset(path: string, content: string): Promise<DatasetDirectoryItem> {
  const name = path.split('/').at(-1) ?? path
  const base: DatasetDirectoryItem = {
    path, name, title: name.replace(/\.knowledge\.json$/, '').replace(/-knowledge-[^.]*\.json$/, ''), status: 'invalid',
  }
  let value: unknown
  try { value = JSON.parse(content) }
  catch (error) { return { ...base, error: error instanceof Error ? error.message : String(error) } }
  if (!object(value) || typeof value.schema !== 'string') return { ...base, error: 'Missing dataset schema' }
  const common = {
    ...base,
    schema: value.schema,
    datasetId: typeof value.id === 'string' ? value.id : undefined,
    purpose: object(value.scope) && typeof value.scope.purpose === 'string' ? value.scope.purpose : undefined,
    generatedAt: object(value.generated) && typeof value.generated.at === 'string' ? value.generated.at : undefined,
    snapshotHash: await sha256Text(content),
  }
  if (value.schema !== DATASET_SCHEMA) return { ...common, status: 'unsupported' }
  if (typeof value.id !== 'string') return { ...common, status: 'invalid', error: 'Missing dataset id' }
  return {
    ...common,
    status: 'available',
    counts: Object.fromEntries(KNOWLEDGE_KINDS.map(kind => [kind, Array.isArray(value[kind]) ? value[kind].length : 0])) as Record<KnowledgeKind, number>,
  }
}

export function markDatasetCopies(items: DatasetDirectoryItem[]): DatasetDirectoryItem[] {
  const byId = new Map<string, DatasetDirectoryItem[]>()
  for (const item of items) {
    if (!item.datasetId) continue
    const group = byId.get(item.datasetId) ?? []
    group.push(item)
    byId.set(item.datasetId, group)
  }
  return items.map(item => {
    if (!item.datasetId) return item
    const group = byId.get(item.datasetId) ?? []
    if (group.length < 2) return { ...item, copyState: 'unique' }
    const hashes = new Set(group.map(entry => entry.snapshotHash))
    return { ...item, copyState: hashes.size === 1 ? 'same-copy' : 'different-snapshot' }
  })
}

/**
 * Discover only matching files, then read summaries through a fixed two-worker
 * queue. Cancellation stops scheduling new work and preserves completed rows.
 */
export async function scanDatasetDirectory(
  io: DirectoryIo,
  options: { path?: string; recursive?: boolean; signal?: AbortSignal } = {},
): Promise<DatasetScanResult> {
  const root = normalizeDatasetDirectory(options.path ?? DEFAULT_DATASET_DIRECTORY)
  if (!root) throw new Error('Invalid dataset directory')
  const signal = options.signal
  const paths: string[] = []
  const errors: Array<{ path: string; message: string }> = []
  let truncated = false

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (signal?.aborted || paths.length >= MAX_DATASET_FILES) return
    let entries: Array<{ name: string; is_dir: boolean }>
    try { entries = await io.list(directory) }
    catch (error) {
      errors.push({ path: directory, message: error instanceof Error ? error.message : String(error) })
      return
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (signal?.aborted) return
      if (!entry.name || entry.name.includes('/') || entry.name.includes('\\')) continue
      const path = joinPath(directory, entry.name)
      if (entry.is_dir) {
        if (options.recursive && !CONTROL_DIRECTORIES.has(entry.name)) {
          if (depth < MAX_DIRECTORY_DEPTH) await walk(path, depth + 1)
          else truncated = true
        }
      } else if (matchesDatasetName(entry.name)) {
        if (paths.length >= MAX_DATASET_FILES) { truncated = true; return }
        paths.push(path)
      }
    }
  }
  await walk(root, 0)

  const items: DatasetDirectoryItem[] = []
  let cursor = 0
  const worker = async () => {
    while (!signal?.aborted) {
      const index = cursor++
      if (index >= paths.length) return
      const path = paths[index]
      try { items.push(await summarizeDataset(path, await io.read(path))) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const name = path.split('/').at(-1) ?? path
        items.push({ path, name, title: name, status: 'read-error', error: message })
        errors.push({ path, message })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DIRECTORY_READ_CONCURRENCY, paths.length) }, worker))
  items.sort((a, b) => a.path.localeCompare(b.path))
  return { items: markDatasetCopies(items), truncated, cancelled: signal?.aborted === true, errors }
}
