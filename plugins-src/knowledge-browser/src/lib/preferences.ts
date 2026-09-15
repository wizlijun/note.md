import { settingsGet, settingsSet } from './bridge'

export const PREFERENCES_SCHEMA_VERSION = 1
export const MAX_RECENT_DATASETS = 50

export type BrowserView = 'reading' | 'relations' | 'timeline'
export type ResultSort = 'core' | 'relevance' | 'original' | 'time-asc' | 'time-desc'

export interface DatasetPreference {
  key: string
  path: string
  datasetId?: string
  view: BrowserView
  ref?: string
  touchedAt: number
}

export interface VaultPreference {
  directory: string
  recursive: boolean
  listWidth: number
  sort: ResultSort
  recent: DatasetPreference[]
}

export interface KnowledgeBrowserPreferences {
  schemaVersion: typeof PREFERENCES_SCHEMA_VERSION
  vaults: Record<string, VaultPreference>
}

const VIEWS = new Set<BrowserView>(['reading', 'relations', 'timeline'])
const SORTS = new Set<ResultSort>(['core', 'relevance', 'original', 'time-asc', 'time-desc'])
const CONTROL_DIRECTORIES = new Set(['.git', '.notemd', 'node_modules', 'vendor', 'target', 'dist', 'dist-plugins'])

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function defaultVaultPreference(): VaultPreference {
  return { directory: 'research', recursive: false, listWidth: 360, sort: 'core', recent: [] }
}

export function defaultPreferences(): KnowledgeBrowserPreferences {
  return { schemaVersion: PREFERENCES_SCHEMA_VERSION, vaults: Object.create(null) }
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384
    && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.replace(/\\/g, '/').split('/').some(part => !part || part === '.' || part === '..' || CONTROL_DIRECTORIES.has(part))
}

function normalizeDatasetPreference(value: unknown): DatasetPreference | null {
  if (!object(value) || typeof value.key !== 'string' || !safeRelativePath(value.path)
    || !VIEWS.has(value.view as BrowserView) || !Number.isFinite(value.touchedAt)) return null
  return {
    key: value.key.slice(0, 512),
    path: value.path.replace(/\\/g, '/'),
    datasetId: typeof value.datasetId === 'string' ? value.datasetId.slice(0, 128) : undefined,
    view: value.view as BrowserView,
    ref: typeof value.ref === 'string' ? value.ref.slice(0, 128) : undefined,
    touchedAt: value.touchedAt as number,
  }
}

export function normalizePreferences(value: unknown): KnowledgeBrowserPreferences {
  if (!object(value) || value.schemaVersion !== PREFERENCES_SCHEMA_VERSION || !object(value.vaults)) return defaultPreferences()
  const vaults: Record<string, VaultPreference> = Object.create(null)
  for (const [key, raw] of Object.entries(value.vaults).slice(0, 64)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(raw)) continue
    const defaults = defaultVaultPreference()
    const recent = Array.isArray(raw.recent)
      ? raw.recent.map(normalizeDatasetPreference).filter((item): item is DatasetPreference => !!item)
        .sort((a, b) => b.touchedAt - a.touchedAt).slice(0, MAX_RECENT_DATASETS)
      : []
    vaults[key] = {
      directory: safeRelativePath(raw.directory) ? raw.directory.replace(/\\/g, '/') : defaults.directory,
      recursive: typeof raw.recursive === 'boolean' ? raw.recursive : defaults.recursive,
      listWidth: typeof raw.listWidth === 'number' && Number.isFinite(raw.listWidth)
        ? Math.min(480, Math.max(280, Math.round(raw.listWidth))) : defaults.listWidth,
      sort: SORTS.has(raw.sort as ResultSort) ? raw.sort as ResultSort : defaults.sort,
      recent,
    }
  }
  return { schemaVersion: PREFERENCES_SCHEMA_VERSION, vaults }
}

export async function vaultPreferenceKey(vaultRoot: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(vaultRoot))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function loadPreferences(): Promise<KnowledgeBrowserPreferences> {
  const settings = await settingsGet()
  return normalizePreferences(settings.preferences)
}

export async function savePreferences(value: KnowledgeBrowserPreferences): Promise<void> {
  await settingsSet('preferences', normalizePreferences(value))
}

export function preferenceForVault(value: KnowledgeBrowserPreferences, key: string): VaultPreference {
  return value.vaults[key] ?? defaultVaultPreference()
}

export function setVaultPreference(
  value: KnowledgeBrowserPreferences,
  key: string,
  preference: VaultPreference,
): KnowledgeBrowserPreferences {
  return normalizePreferences({ ...value, vaults: { ...value.vaults, [key]: preference } })
}

export function touchDatasetPreference(
  preference: VaultPreference,
  update: Omit<DatasetPreference, 'key' | 'touchedAt'> & { touchedAt?: number },
): VaultPreference {
  const key = `${update.datasetId ?? ''}\0${update.path}`
  const current: DatasetPreference = { ...update, key, touchedAt: update.touchedAt ?? Date.now() }
  return {
    ...preference,
    recent: [current, ...preference.recent.filter(item => item.key !== key)]
      .sort((a, b) => b.touchedAt - a.touchedAt).slice(0, MAX_RECENT_DATASETS),
  }
}

/** A small best-effort writer: failures are reported but never stop reading. */
export function createPreferenceSaver(
  write: (value: KnowledgeBrowserPreferences) => Promise<void> = savePreferences,
  delayMs = 250,
  onError: (error: unknown) => void = () => {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: KnowledgeBrowserPreferences | undefined
  let chain = Promise.resolve()
  const commit = async () => {
    clearTimeout(timer)
    timer = undefined
    const value = pending
    pending = undefined
    if (!value) return
    chain = chain.then(() => write(value)).catch(onError)
    await chain
  }
  return {
    schedule(value: KnowledgeBrowserPreferences) {
      pending = value
      clearTimeout(timer)
      timer = setTimeout(() => { void commit() }, delayMs)
    },
    flush: commit,
    cancel() { clearTimeout(timer); timer = undefined; pending = undefined },
  }
}
