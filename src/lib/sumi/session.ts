import { invoke } from '@tauri-apps/api/core'
import { writable } from 'svelte/store'
export const sumiSurfaceVersion = writable(0)
function changed() { sumiSurfaceVersion.update(value => value + 1) }

export const SUMI_PLUGIN_ID = 'notemd.sumi'
export interface NativeBounds { x: number; y: number; width: number; height: number }
export interface ProjectionIdentity { path: string; sha256: string }
export interface SumiSnapshot { raw: string; revision: number; projected?: boolean; projection_identity?: ProjectionIdentity | null }
export interface SumiOpen extends SumiSnapshot { page_id: string }
export interface ExistingOwner { kind: 'existing_owner'; page_id: string }
export class SumiExistingOwnerError extends Error {
  constructor(readonly pageId: string) { super('此页已在另一个编辑面中打开') }
}
function opened<T>(value: T | ExistingOwner): T {
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'existing_owner') throw new SumiExistingOwnerError((value as ExistingOwner).page_id)
  return value as T
}
export async function focusExistingSumiPage(pageId: string, pluginId = SUMI_PLUGIN_ID): Promise<void> {
  await invoke('sumi_focus_existing', { page_id: pageId, plugin_id: pluginId })
}
export interface NativeBinding { surface_id: string; generation: number }
export interface SumiOwner extends SumiSnapshot {
  readonly tabId: string
  path: string
  readonly pluginId: string
  readonly pageId: string
  editor: 'native' | 'web'
  /** A newer web draft may still descend from the pre-merge source baseline. */
  projectionRevision?: number
  sourceBaseRevision?: number
  sourceConflict?: { submitted: string; accepted: string; draft: string }
  surface?: NativeBinding
  tail: Promise<unknown>
}
const owners = new Map<string, SumiOwner>()
const opening = new Map<string, Promise<SumiOwner>>()
export function sumiOwner(tabId: string): SumiOwner | undefined { return owners.get(tabId) }
export async function settleSumiOwner(tabId: string): Promise<void> {
  await opening.get(tabId)
  await owners.get(tabId)?.tail
}
function identity(owner: SumiOwner) {
  return { page_id: owner.pageId, plugin_id: owner.pluginId, tab_id: owner.tabId }
}
function current(owner: SumiOwner) {
  if (owners.get(owner.tabId) !== owner) throw new Error('Sumi document session changed')
}
function serial<T>(owner: SumiOwner, operation: () => Promise<T>): Promise<T> {
  const result = owner.tail.catch(() => {}).then(() => { current(owner); return operation() })
  owner.tail = result.catch(() => {})
  return result
}
function accept(owner: SumiOwner, snapshot: SumiSnapshot): SumiSnapshot {
  current(owner)
  owner.raw = snapshot.raw
  owner.revision = snapshot.revision
  owner.projected = snapshot.projected
  owner.projection_identity = snapshot.projection_identity
  return snapshot
}
export async function openSumiOwner(tabId: string, path: string, pluginId = SUMI_PLUGIN_ID, expectedPageId?: string): Promise<SumiOwner> {
  const existing = owners.get(tabId)
  if (existing) {
    if (existing.path !== path || existing.pluginId !== pluginId || expectedPageId && existing.pageId !== expectedPageId) throw new Error('Sumi page path changed; reopen the page')
    return existing
  }
  const pending = opening.get(tabId)
  if (pending) {
    const owner = await pending
    if (owner.path !== path || owner.pluginId !== pluginId || expectedPageId && owner.pageId !== expectedPageId) throw new Error('Sumi document changed while opening')
    return owner
  }
  const operation = invoke<SumiOpen | ExistingOwner>('sumi_open_path', { path, plugin_id: pluginId, tab_id: tabId, ...(expectedPageId ? { expected_page_id: expectedPageId } : {}) }).then(result => {
    const value = opened(result)
    if (expectedPageId && value.page_id !== expectedPageId) throw new Error('Sumi page identity changed on disk')
    const owner: SumiOwner = { ...value, pageId: value.page_id, tabId, path, pluginId, editor: 'web', tail: Promise.resolve() }
    owners.set(tabId, owner)
    return owner
  })
  opening.set(tabId, operation)
  try { return await operation } finally { if (opening.get(tabId) === operation) opening.delete(tabId) }
}
export async function mountSumiOwner(owner: SumiOwner, bounds: NativeBounds, available: () => boolean): Promise<NativeBinding | undefined> {
  return serial(owner, async () => {
    if (!available()) return
    if (owner.surface) throw new Error('Sumi page already has an active surface')
    const binding = opened(await invoke<NativeBinding | ExistingOwner>('sumi_mount', { ...identity(owner), bounds }))
    current(owner)
    owner.surface = binding
    owner.editor = 'native'
    changed()
    if (!available()) {
      accept(owner, await invoke<SumiSnapshot>('sumi_detach', { ...identity(owner), ...binding }))
      owner.surface = undefined
      changed()
      return
    }
    return binding
  })
}
export async function flushSumiNative(owner: SumiOwner, detach = false): Promise<SumiSnapshot | undefined> {
  return serial(owner, async () => {
    if (!owner.surface) return owner.editor === 'native' ? { raw: owner.raw, revision: owner.revision, projected: owner.projected, projection_identity: owner.projection_identity } : undefined
    const binding = owner.surface
    const snapshot = await invoke<SumiSnapshot>(detach ? 'sumi_detach' : 'sumi_flush', { ...identity(owner), ...binding })
    accept(owner, snapshot)
    if (detach) {
      if (owner.surface === binding) { owner.surface = undefined; changed() }
    }
    return snapshot
  })
}
export async function saveSumiSource(owner: SumiOwner, raw: string): Promise<SumiSnapshot> {
  return serial(owner, async () => {
    if (owner.surface || owner.editor === 'native') throw new Error('Native Sumi editor still owns this page')
    return accept(owner, await invoke<SumiSnapshot>('sumi_source_save', {
      ...identity(owner), base_revision: owner.sourceBaseRevision ?? owner.revision, raw,
    }))
  })
}
export async function rebaseSumiDraft(owner: SumiOwner, submitted: string, accepted: string, draft: string): Promise<string> {
  return serial(owner, async () => {
    const result = await invoke<{ kind: 'merged'; text: string } | { kind: 'conflict'; submitted: string; accepted: string; draft: string }>('sumi_rebase_draft', {
      ...identity(owner), submitted, accepted, draft,
    })
    if (result.kind === 'conflict') {
      owner.sourceConflict = { submitted: result.submitted, accepted: result.accepted, draft: result.draft }
      throw Error('保存期间的新输入与远端修改重叠，原稿、合并结果和当前草稿均已保留。')
    }
    owner.sourceConflict = undefined
    return result.text
  })
}
export async function refreshSumiOwner(owner: SumiOwner): Promise<SumiSnapshot> {
  return serial(owner, async () => {
    if (owner.surface || owner.editor === 'native') throw new Error('Detach the native Sumi editor before importing disk changes')
    const snapshot = opened(await invoke<SumiOpen | ExistingOwner>('sumi_open_path', { path: owner.path, plugin_id: owner.pluginId, tab_id: owner.tabId, expected_page_id: owner.pageId }))
    if (snapshot.page_id !== owner.pageId) throw new Error('Sumi page identity changed on disk')
    return accept(owner, snapshot)
  })
}
export async function updateSumiSurface(owner: SumiOwner, binding: NativeBinding, command: 'sumi_bounds' | 'sumi_visible' | 'sumi_focus', fields: Record<string, unknown> = {}): Promise<void> {
  return serial(owner, async () => {
    if (owner.surface !== binding) return
    await invoke(command, { ...identity(owner), ...binding, ...fields })
  })
}
export async function detachSumiSurface(owner: SumiOwner, binding?: NativeBinding): Promise<void> {
  return serial(owner, async () => {
    const active = owner.surface
    if (!active || binding && binding !== active) return
    const snapshot = await invoke<SumiSnapshot>('sumi_detach', { ...identity(owner), ...active })
    accept(owner, snapshot)
    if (owner.surface === active) { owner.surface = undefined; changed() }
  })
}
export async function closeSumiOwner(tabId: string): Promise<void> {
  const pending = opening.get(tabId)
  if (pending) await pending
  const owner = owners.get(tabId)
  if (!owner) return
  await detachSumiSurface(owner)
  await invoke('sumi_close', identity(owner))
  if (owners.get(tabId) === owner) { owners.delete(tabId); changed() }
}

/** Called only after the tab mirror has accepted the final native snapshot. */
export function finishSumiHandoff(owner: SumiOwner): void {
  current(owner)
  if (owner.surface) throw new Error('Sumi surface must detach before releasing its writer')
  owner.editor = 'web'
  changed()
}
