import { Store } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { homeDir } from '@tauri-apps/api/path'
import { listen } from '@tauri-apps/api/event'
import { exists, mkdir, readDir, readTextFile, writeTextFile, watchImmediate } from '@tauri-apps/plugin-fs'
import { getDeviceId } from '../settings.svelte'
import { createAnalyticsStore, type Fs } from '../insights/store.svelte'
import { abbreviateHome, normalize } from '../paths'
import { formatRecentLabel } from '../recent-merge'
import { activityFor, applyAttention, applyEdit, contentKey, contentLists, countNewDismiss, discoverContent, dismissContent, normalizeDirRule,
  emptyVaultContent, emptyHomeContent, migrateOwnerHistory, noDirRules, normalizeHomeContent, passesDirRules, READ_MS,
  type ContentCandidate, type ContentList, type HomeContentData, type HomeContentItem, type HomeDirRules, type VaultContent } from './model'
import { homeDirRulesFrom, saveHomeNewDirs, type VaultSettingsDto } from '../vault-settings.svelte'

export const homeContentStore = $state({
  newItems: [] as HomeContentItem[], continueItems: [] as HomeContentItem[],
  ready: false, busy: false, error: null as string | null, skipped: 0,
  /** A first-level directory dismissed often enough to ask about excluding it. */
  ask: null as { dir: string; count: number } | null,
})
let data: HomeContentData = emptyHomeContent()
let storage: Awaited<ReturnType<typeof Store.load>> | null = null
let hydration: Promise<void> | null = null
let writes: Promise<void> = Promise.resolve()
let root: string | null = null
let rules = { extensions: ['md'], names: [] as string[] }
let dirRules: HomeDirRules = noDirRules
/** Bumped whenever rules are set directly, so a scan that read settings
 *  before the change does not put the old rules back when it lands. */
let rulesRevision = 0
let catalog: ContentCandidate[] = []
let catalogReady = false
let unavailable = new Set<string>()
let generation = 0
let home: string | null = null
let menus: Promise<void> = Promise.resolve()
let scan: Promise<void> | null = null
interface Visit { root: string; path: string; ms: number; base: number | null; lastPublished: number; lastAttentionAt: number }
let visit: Visit | null = null
const pendingEdits = new Map<string, { path: string; target: string; at: number }>()
const editCheckpoints = new Map<string, number>()
let editTimer: ReturnType<typeof setTimeout> | undefined

function vaultFor(target: string): VaultContent {
  return data.vaults[target] ??= emptyVaultContent()
}
export function loadHomeContent(): Promise<void> {
  if (storage) return Promise.resolve()
  if (hydration) return hydration
  hydration = (async () => {
    const loaded = await Store.load('home-content.json', { autoSave: false, defaults: {} })
    data = normalizeHomeContent(await loaded.get<unknown>('data'))
    storage = loaded
  })().finally(() => { hydration = null })
  return hydration
}

function publish(): void {
  const lists = root && catalogReady ? contentLists(vaultFor(root), catalog, root, Date.now(), Infinity, unavailable, dirRules) : { newItems: [], continueItems: [] }
  const vault = root ? data.vaults[root] : undefined, asked = vault?.askDir
  homeContentStore.ask = vault && asked && passesDirRules(`${asked}/`, dirRules) ? { dir: asked, count: vault.dismissCounts[asked] ?? 0 } : null
  const display = (item: HomeContentItem) => ({ ...item, detail: abbreviateHome(item.detail, home) })
  homeContentStore.newItems = lists.newItems.map(display)
  homeContentStore.continueItems = lists.continueItems.map(display)
  // Serial publication means an in-flight old-Vault IPC cannot be the final menu.
  menus = menus.catch(() => {}).then(async () => {
    const current = root && catalogReady ? contentLists(vaultFor(root), catalog, root, Date.now(), 10, unavailable, dirRules) : { newItems: [], continueItems: [] }
    const items = (values: HomeContentItem[]) => values.map(item => ({ path: item.path, label: formatRecentLabel(item.path, home) }))
    await invoke('update_latest_menu', { items: items(current.newItems) })
    if (root) await invoke('update_recent_menu', { items: items(current.continueItems) })
  }).catch(error => { console.warn('[home-content] menu:', error) })
}

function change(target: string, update: (vault: VaultContent) => void): Promise<void> {
  const loading = loadHomeContent()
  void loading.catch(() => {})
  const operation = writes.then(async () => {
    await loading
    const previous = structuredClone(data)
    update(vaultFor(target))
    if (JSON.stringify(data) === JSON.stringify(previous)) {
      if (target === root) { homeContentStore.error = null; publish() }
      return
    }
    try {
      await storage!.set('data', data)
      await storage!.save()
    } catch (error) {
      data = previous
      throw error
    }
    if (target === root) { homeContentStore.error = null; publish() }
  }).catch(error => {
    if (target === root) homeContentStore.error = String(error)
    throw error
  })
  writes = operation.catch(() => {})
  return operation
}

const analyticsFs: Fs = {
  exists: p => exists(p), mkdir: async (p, o) => { await mkdir(p, o) },
  readDir: async p => (await readDir(p)).map(e => ({ name: e.name, isFile: e.isFile })),
  readTextFile: p => readTextFile(p), writeTextFile: (p, text) => writeTextFile(p, text),
}

export function refreshHomeContent(): Promise<void> {
  if (scan) return scan
  const target = root, epoch = generation, revision = rulesRevision
  if (!target) { homeContentStore.ready = true; return Promise.resolve() }
  homeContentStore.busy = true
  const current = (async () => {
    await loadHomeContent()
    const [result, history, settings] = await Promise.all([
      invoke<{ root: string; items: ContentCandidate[]; skipped: number }>('home_content_catalog', { expectedRoot: target, rules }),
      vaultFor(target).migrated ? Promise.resolve([]) : createAnalyticsStore({ fs: analyticsFs, vaultRoot: () => target,
        deviceId: getDeviceId(), deviceName: '', tzOffsetMinutes: 0 }).readAllDevices(),
      // Unreadable settings keep the rules already in force rather than unhiding everything.
      invoke<VaultSettingsDto>('notemd_vault_settings_get').catch(() => null),
    ])
    if (generation !== epoch || target !== root || normalize(result.root) !== normalize(target)) return
    const migrated = structuredClone(vaultFor(target))
    migrateOwnerHistory(migrated, history, target)
    const external = Object.values(migrated.docs).filter(d => !normalize(d.path).startsWith(normalize(target).replace(/\/$/, '') + '/'))
    const missingExternal = new Set((await Promise.all(external.map(async d => await exists(d.path).catch(() => true) ? null : d.path))).filter((p): p is string => p !== null))
    if (generation !== epoch || target !== root) return
    await change(target, vault => {
      discoverContent(vault, result.items, target, Date.now())
      migrateOwnerHistory(vault, history, target)
    })
    if (generation !== epoch || target !== root) return
    if (settings && typeof settings === 'object' && revision === rulesRevision) dirRules = homeDirRulesFrom(settings)
    catalog = result.skipped > 0 ? [...new Map([...catalog, ...result.items].map(c => [c.path, c])).values()] : result.items
    unavailable = missingExternal
    catalogReady = true
    homeContentStore.skipped = result.skipped
    homeContentStore.ready = true
    publish()
  })().catch(error => {
    if (generation === epoch) { homeContentStore.error = String(error); homeContentStore.ready = true }
    throw error
  }).finally(() => {
    if (generation === epoch) homeContentStore.busy = false
    if (scan === current) scan = null
  })
  scan = current
  return current
}

export async function dismissHomeContent(list: ContentList, path: string): Promise<void> {
  const target = root
  if (!target) return
  const now = Date.now()
  const previous = visit
  const replacement = list === 'continue' && visit?.path === path && visit.root === target
    ? { root: target, path, base: null, ms: 0, lastPublished: 0, lastAttentionAt: now } : null
  if (replacement) visit = replacement
  try {
    await change(target, vault => {
      dismissContent(activityFor(vault, path, target, now), list, now)
      if (list === 'new') countNewDismiss(vault, contentKey(path, target), dirRules)
    })
  } catch (error) {
    if (replacement && visit === replacement && previous) { previous.ms += replacement.ms; visit = previous }
    throw error
  }
}

/** Rules saved from the settings dialog; applied without waiting for a rescan. */
export function applyHomeDirRules(next: HomeDirRules): void {
  dirRules = next
  rulesRevision++
  publish()
}

/** 〔不再显示〕: append the asked directory to the vault's exclusions. On failure
 *  the prompt and the count stay, and the error is shown. */
export async function excludeAskedDir(): Promise<void> {
  const target = root, asked = homeContentStore.ask, epoch = generation
  if (!target || !asked) return
  try {
    // Re-read so a hand edit made since the last refresh is not overwritten.
    const current = homeDirRulesFrom(await invoke<VaultSettingsDto>('notemd_vault_settings_get'))
    // Save the list as the home filter reads it: a hand-written `/stat/` or
    // `./stat` would otherwise be rejected by the backend and block every answer.
    const exclude: string[] = []
    for (const dir of [...current.exclude, asked.dir].map(normalizeDirRule)) {
      if (dir && !exclude.some(kept => kept.toLowerCase() === dir.toLowerCase())) exclude.push(dir)
    }
    const next = await saveHomeNewDirs({ exclude })
    if (generation !== epoch || target !== root) return
    dirRules = next
    rulesRevision++
    await change(target, vault => {
      if (vault.askDir === asked.dir) vault.askDir = null
      delete vault.dismissCounts[asked.dir]
    })
  } catch (error) {
    if (generation === epoch) homeContentStore.error = String(error)
    throw error
  }
}

/** 〔继续显示〕: never ask about this directory again on this device. */
export function keepAskedDir(): Promise<void> {
  const target = root, asked = homeContentStore.ask
  if (!target || !asked) return Promise.resolve()
  return change(target, vault => {
    if (!vault.keepDirs.includes(asked.dir)) vault.keepDirs.push(asked.dir)
    if (vault.askDir === asked.dir) vault.askDir = null
    delete vault.dismissCounts[asked.dir]
  })
}

function saveVisit(current: Visit, now: number): Promise<void> {
  const ms = current.ms
  const activeAt = current.lastAttentionAt
  return change(current.root, vault => {
    const doc = activityFor(vault, current.path, current.root, now)
    current.base ??= doc.readMs
    applyAttention(doc, current.base + ms, ms, activeAt)
  })
}
export function beginHomeVisit(path: string | null, target: string | null, now = Date.now()): void {
  if (visit?.path === path && visit.root === target) return
  void flushEdits().catch(() => {})
  if (visit && visit.ms > 0) void saveVisit(visit, now).catch(() => {})
  visit = path && target ? { root: target, path, ms: 0, base: null, lastPublished: 0, lastAttentionAt: now } : null
}
export function recordHomeAttention(path: string, ms: number, now = Date.now()): void {
  if (!visit || visit.path !== path || !Number.isFinite(ms) || ms <= 0) return
  const current = visit
  current.ms += ms
  current.lastAttentionAt = now
  // Checkpoints at the read threshold and every 30s thereafter, not every tick.
  if (current.ms >= READ_MS && (current.lastPublished === 0 || current.ms - current.lastPublished >= READ_MS)) {
    current.lastPublished = current.ms
    void saveVisit(current, now).catch(() => { current.lastPublished = 0 })
  }
}
export function recordHomeEdit(path: string, target: string | null, now = Date.now()): void {
  if (!target || !path) return
  const key = JSON.stringify([target, path])
  pendingEdits.set(key, { path, target, at: now })
  if (!editCheckpoints.has(key) || now - editCheckpoints.get(key)! >= READ_MS) {
    editCheckpoints.set(key, now)
    void flushEdits().catch(() => {})
  } else if (editTimer === undefined) {
    editTimer = setTimeout(() => { editTimer = undefined; void flushEdits().catch(() => {}) }, READ_MS)
  }
}

async function flushEdits(): Promise<void> {
  if (editTimer !== undefined) { clearTimeout(editTimer); editTimer = undefined }
  const entries = [...pendingEdits.entries()]
  for (const target of new Set(entries.map(([, edit]) => edit.target))) {
    const edits = entries.filter(([, edit]) => edit.target === target)
    await change(target, vault => {
      for (const [, edit] of edits) applyEdit(activityFor(vault, edit.path, target, edit.at), edit.at)
    })
    for (const [key, edit] of edits) if (pendingEdits.get(key) === edit) pendingEdits.delete(key)
  }
}

export async function flushHomeContent(): Promise<void> {
  await flushEdits()
  if (visit && visit.ms > 0) await saveVisit(visit, Date.now())
  await writes
}

/** Rename preserves reading and dismiss state; Save As remains a new document. */
export async function renameHomeContent(oldPath: string, newPath: string, target: string | null): Promise<void> {
  if (!target || oldPath === newPath) return
  await change(target, vault => {
    const previous = Object.entries(vault.docs).find(([, doc]) => doc.path === normalize(oldPath))
    if (!previous) return
    const next = activityFor(vault, newPath, target, previous[1].discoveredAt)
    Object.assign(next, previous[1], { path: normalize(newPath) })
    delete vault.docs[previous[0]]
  })
}

export function installHomeContent(target: string | null, documentRules = rules): () => void {
  const epoch = ++generation
  root = target; rules = documentRules; dirRules = noDirRules; catalog = []; catalogReady = false; scan = null; unavailable = new Set()
  homeContentStore.newItems = []; homeContentStore.continueItems = []
  homeContentStore.ready = !target; homeContentStore.busy = false; homeContentStore.error = null; homeContentStore.skipped = 0
  homeContentStore.ask = null
  publish()
  let disposed = false, dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanups: Array<() => void> = []
  const keep = (dispose: () => void) => { if (disposed) dispose(); else cleanups.push(dispose) }
  const refresh = async () => {
    if (disposed) return
    if (scan) { dirty = true; return }
    try { await refreshHomeContent() } catch { /* error is rendered on home */ }
    if (dirty && !disposed) { dirty = false; schedule() }
  }
  const schedule = () => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; void refresh() }, 1000)
  }
  void homeDir().then(value => { if (!disposed) { home = value; publish() } }).catch(() => {})
  void listen('menu-rebuilt', () => { if (!disposed) publish() }).then(keep).catch(() => {})
  if (target) {
    void watchImmediate(target, event => {
      if (typeof event.type === 'object' && 'access' in event.type) return
      if (!event.paths.length || event.paths.some(p => !normalize(p).split('/').some(part => ['.notemd', '.git', '.trash'].includes(part)))) schedule()
    }, { recursive: true }).then(keep).catch(() => {})
    window.addEventListener('focus', schedule)
    cleanups.push(() => window.removeEventListener('focus', schedule))
    void refresh()
  }
  return () => {
    disposed = true
    if (generation === epoch) { ++generation; root = null; scan = null }
    if (timer !== undefined) clearTimeout(timer)
    cleanups.forEach(dispose => dispose())
  }
}
