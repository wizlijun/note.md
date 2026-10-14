import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'
import { parseGuestLink } from './link'

export function guestCommand<T>(op: string, input: Record<string, unknown>): Promise<T> {
  if (op === 'open' && Object.keys(input).some(key => !['origin', 'slug', 'shareUrl'].includes(key))) {
    return Promise.reject(new Error('无效的分享下载参数'))
  }
  return invoke<T>('share_guest', { request: { ...input, op } })
}
/** Credentials belong to app-data, never to the native download request or Vault. */
export async function saveGuestToken(origin: string, projectId: string, token: string): Promise<void> {
  const parsed = parseGuestLink(`${origin}/2000-01-01-guest`, import.meta.env.DEV)
  if (parsed.origin !== origin || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error('无效的分享身份')
  const store = await Store.load('share_db.json')
  await store.set(`guest:${origin}:${projectId}`, { token })
  await store.save()
}

import { buildGuestSubmission, type BuiltSubmission } from '../project-share/guest-submission'
import type { GuestInfo } from './types'
import type { DraftV2 } from '../project-share/types'
import { relative } from '../paths'
import { classifyPath } from '../fs'
import { version } from '../../../package.json'

export async function canSubmitGuest(info: GuestInfo): Promise<boolean> {
  const store = await Store.load('share_db.json')
  const value = await store.get<{ token?: unknown }>(`guest:${info.origin}:${info.project_id}`)
  return typeof value?.token === 'string' && value.token.length > 0
}
/** The shared snapshot's document extensions follow the existing file classifier. */
export function isGuestMarkdownPath(path: string): boolean {
  const kind = classifyPath(path)?.kind
  return kind === 'markdown' || kind === 'mdx'
}
export interface GuestWork {
  info: GuestInfo; base: DraftV2['base']; after: DraftV2['after']; added: string[]; missing: string[]
}
export interface GuestPreview extends BuiltSubmission { added: string[]; missing: string[]; snapshotId: string; tabPath: string }
/** Pure packaging boundary: saves mounted documents, then reads the verified disk snapshot. */
export async function buildDesktopSubmission(root: string, tabId: string, message: string, name: string): Promise<GuestPreview> {
  const { tabs, saveTab, isReadOnlyTab } = await import('../tabs.svelte')
  const info = await guestCommand<GuestInfo>('inspect', { root })
  const tab = tabs.find(item => item.id === tabId)
  if (!tab?.filePath || relative(root, tab.filePath) === null || isReadOnlyTab(tab)) throw new Error('GUEST_TAB_CHANGED')
  const originalPath = tab.filePath
  const stable = () => tabs.includes(tab) && tab.filePath === originalPath && !isReadOnlyTab(tab)
  const writableDocument = (item: typeof tab) => {
    const path = item.filePath && relative(root, item.filePath)
    return path && info.files.some(file => file.path === path) && isGuestMarkdownPath(path)
      && (item.kind === 'markdown' || item.kind === 'mdx') && !isReadOnlyTab(item)
  }
  for (const item of [...tabs].filter(writableDocument)) {
    if (!stable() || !writableDocument(item)) throw new Error('GUEST_TAB_CHANGED')
    const path = item.filePath
    await saveTab(item.id)
    if (!stable() || !tabs.includes(item) || item.filePath !== path) throw new Error('GUEST_TAB_CHANGED')
  }
  const work = await guestCommand<GuestWork>('read-work', { root })
  if (!stable() || work.info.snapshotId !== info.snapshotId || work.info.project_id !== info.project_id) throw new Error('GUEST_BASE_CHANGED')
  const built = buildGuestSubmission({ project_id: info.project_id, submissionId: crypto.randomUUID(),
    client: { kind: 'notemd', version }, message, name,
    draft: { v: 2, lineageId: crypto.randomUUID(), snapshotId: info.snapshotId, base: work.base, after: work.after,
      annotationKinds: {}, ...(info.lastSubmissionId ? { lastSubmissionId: info.lastSubmissionId } : {}) } })
  return { ...built, added: work.added, missing: work.missing, snapshotId: info.snapshotId, tabPath: originalPath }
}
const flights = new Map<string, Promise<GuestInfo>>()
function flight(root: string, run: () => Promise<GuestInfo>): Promise<GuestInfo> {
  const existing = flights.get(root)
  if (existing) return existing
  const promise = run().finally(() => { if (flights.get(root) === promise) flights.delete(root) })
  flights.set(root, promise)
  return promise
}
async function allowedInfo(root: string): Promise<GuestInfo> {
  const info = await guestCommand<GuestInfo>('inspect', { root })
  if (!await canSubmitGuest(info)) throw new Error('GUEST_READ_ONLY')
  return info
}
/** Only the explicit UI submit action creates a new durable package. */
export function submitGuest(root: string, tabId: string, message: string, name: string,
  confirm: (preview: GuestPreview) => Promise<boolean>): Promise<GuestInfo> {
  return flight(root, async () => {
    let info = await allowedInfo(root)
    let pending = info.outbox[0]
    if (!pending) {
      const preview = await buildDesktopSubmission(root, tabId, message, name)
      if ((preview.added.length || preview.missing.length || preview.ownerAnnotationsTouched.length) && !await confirm(preview)) return info
      info = await allowedInfo(root)
      const { tabs, isReadOnlyTab } = await import('../tabs.svelte')
      const tab = tabs.find(item => item.id === tabId)
      if (!tab || tab.filePath !== preview.tabPath || isReadOnlyTab(tab)) throw new Error('GUEST_TAB_CHANGED')
      if (info.snapshotId !== preview.snapshotId || info.outbox.length) throw new Error('GUEST_BASE_CHANGED')
      info = await guestCommand<GuestInfo>('queue', { root, submissionId: preview.submissionId, body: preview.body })
      pending = info.outbox[0]
      if (!pending || pending.body !== preview.body || pending.submissionId !== preview.submissionId) throw new Error('GUEST_PENDING_CONFLICT')
    }
    return guestCommand<GuestInfo>('deliver', { root, submissionId: pending.submissionId })
  })
}
/** Startup/online retry never flushes/builds/queues, even when working files changed. */
export function retryGuestOutbox(root: string): Promise<GuestInfo> {
  return flight(root, async () => {
    const info = await allowedInfo(root)
    return info.outbox[0] ? guestCommand<GuestInfo>('deliver', { root, submissionId: info.outbox[0].submissionId }) : info
  })
}
export interface GuestReceipt {
  submissionId: string; status: number
  receipt?: import('../project-share/types').ProjectReceipt
}
export async function guestReceipts(root: string, submissionIds: string[]): Promise<GuestReceipt[]> {
  await allowedInfo(root)
  return guestCommand('receipts', { root, submissionIds: submissionIds.slice(-20) })
}
