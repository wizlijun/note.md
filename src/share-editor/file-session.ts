import type { Plugin } from 'prosemirror-state'
import { mountFileEditor } from '../editor-kit-v2/file-main'
import type { FileAdapters, FilePolicy, FileRender, FileSnapshot, FileRecovery, MountedFileEditor } from '../editor-kit-v2/file-contract'
import { acknowledgeSaved, recoveryFromSnapshot, type SavedFile } from '../editor-kit-v2/file-recovery'
import type { DraftV2 } from '../lib/project-share/types'
import { sha256Sync } from '../lib/share-merge/hash'

export interface ShareFileSessionOptions {
  path: string
  snapshotId: string
  raw: string
  draft: DraftV2
  policy: FilePolicy
  adapters: FileAdapters
  render?: FileRender
  mountTarget: HTMLElement
  readOnly?: boolean
  styles?: 'host'
  plugins?: Plugin[]
  /** Shared lineage FIFO: clone live + its notes at execution, await atomic, return that clone. */
  saveDraft(live: DraftV2): Promise<Readonly<DraftV2>>
}
export interface ShareFileSession {
  mounted: MountedFileEditor
  save(options?: { requireConfirmed?: boolean }): Promise<FileSnapshot>
  close(): Promise<void>
  /** Initialization only: keep captured draft even if persistence fails, then release the owner. */
  closeAfterFailedMount(): Promise<boolean>
  saved(): SavedFile | undefined
  setReadOnly(value: boolean): void
}

function sameRecovery(actual: FileRecovery | undefined, expected: FileRecovery): boolean {
  return !!actual && actual.v === expected.v && actual.sourceHash === expected.sourceHash
    && actual.sourceRevision === expected.sourceRevision && Array.isArray(actual.bindings)
    && actual.bindings.length === expected.bindings.length && actual.bindings.every((row, i) =>
      row?.rootOrdinal === expected.bindings[i].rootOrdinal && row.id === expected.bindings[i].id)
}

/** One real file owner; delivery/rebase and aggregate persistence belong to the caller. */
export async function createShareFileSession(options: ShareFileSessionOptions): Promise<ShareFileSession> {
  if (!options.policy) throw new TypeError('share file session requires an explicit policy')
  const { draft, path } = options, lineage = draft.lineageId, snapshotId = draft.snapshotId
  if (!draft.base[path]) {
    if (snapshotId !== options.snapshotId) throw new Error('old-draft-missing-base')
    draft.base[path] = { hash: sha256Sync(options.raw), markdown: options.raw }
  }
  const raw = Object.hasOwn(draft.after, path) ? draft.after[path] : draft.base[path].markdown
  let closed = false, closing: Promise<void> | undefined, readOnly = options.readOnly ?? false
  let durable: { identity: object; value: SavedFile } | undefined
  const mounted = await mountFileEditor(options.mountTarget, {
    file: { documentId: `${lineage}:${path}`, authority: `${lineage}:${snapshotId}:${path}`, raw, recovery: draft.editorFiles?.[path] },
    policy: options.policy, adapters: options.adapters, render: options.render, readOnly,
  }, { styles: options.styles, plugins: options.plugins })
  const current = () => !closed && !mounted.view.isDestroyed && draft.lineageId === lineage && draft.snapshotId === snapshotId
  function capture() {
    const identity = mounted.baselineIdentity, snapshot = mounted.owner.snapshot(), recovery = recoveryFromSnapshot(snapshot)
    draft.after[path] = snapshot.raw
    ;(draft.editorFiles ??= {})[path] = recovery
    return { identity, snapshot, recovery }
  }
  function saved() { return durable?.identity === mounted.baselineIdentity ? durable.value : undefined }
  async function persist(request: ReturnType<typeof capture>): Promise<boolean> {
    const result = await options.saveDraft(draft)
    const { identity, snapshot, recovery } = request
    if (!current() || result.lineageId !== lineage || result.snapshotId !== snapshotId
      || mounted.baselineIdentity !== identity || mounted.owner.snapshot().authority !== snapshot.authority
      || result.after[path] !== snapshot.raw || !sameRecovery(result.editorFiles?.[path], recovery)) return false
    durable = { identity, value: acknowledgeSaved(saved(), snapshot) }
    return true
  }
  // Notifications may describe an older baseline: reread the consistent current pair.
  const unsubscribe = mounted.owner.observe(() => { if (current()) capture() })
  async function save(options?: { requireConfirmed?: boolean }) {
    if (!current() || closing) throw new Error('file-session-unavailable')
    await mounted.owner.flush()
    if (!current() || closing) throw new Error('file-session-unavailable')
    const request = capture()
    const confirmed=await persist(request)
    if(options?.requireConfirmed && !confirmed) throw new Error('file-save-not-confirmed')
    return request.snapshot
  }
  function setReadOnly(value: boolean) {
    if (closing || closed) throw new Error('file-session-unavailable')
    readOnly = value; mounted.owner.setReadOnly(value)
  }
  function close(): Promise<void> {
    if (closed) return Promise.resolve()
    if (closing) return closing
    const previous = readOnly
    closing = (async () => {
      try {
        await mounted.owner.flush()
        if (!current()) throw new Error('file-session-unavailable')
        mounted.owner.setReadOnly(true)
        await mounted.owner.flush()
        if (!current()) throw new Error('file-save-not-confirmed')
        const request = capture()
        if (!await persist(request)) throw new Error('file-save-not-confirmed')
        await mounted.closeIfSaved({ identity: request.identity, raw: request.snapshot.raw })
        closed = true; unsubscribe(); mounted.destroyView()
      } catch (error) { mounted.owner.setReadOnly(previous); throw error }
      finally { closing = undefined }
    })()
    return closing
  }
  async function closeAfterFailedMount(): Promise<boolean> {
    await mounted.owner.flush()
    mounted.owner.setReadOnly(true)
    await mounted.owner.flush()
    const request = capture()
    let confirmed = false
    try { confirmed = await persist(request) } catch { /* The live raw/recovery remains available to fallback. */ }
    await mounted.owner.close()
    closed = true; unsubscribe()
    return confirmed
  }
  return { mounted, saved, save, close, closeAfterFailedMount, setReadOnly }
}
