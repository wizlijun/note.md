import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'
import { sha256Hex } from '../hash'
import { generateSlug } from '../share/slug'
import { buildProjectBundle } from './bundle'
import { captureProjectTheme, renderProjectPresentation } from './presentation'
import { buildProjectArchive } from './archive'
import { uploadProjectPart, type ProjectUploadProgress } from './upload'
import { artifactSha256, createArtifactPlan, verifyArtifactPlan, MULTIPART_BYTES, type ArtifactName, type ArtifactPlan } from './multipart'
import { normalizeShareTitle } from './title'
import type { FeedbackEnvelope, LocalFeedback, ProjectFile, ProjectInfo, ProjectSnapshot, ProjectSummary, ReviewDraft } from './types'

export interface ProjectIdentity {
  project_id: string
  sourceRoot: string
  entry: string
  baseUrl: string
  slug: string
  edit_token: string
  feedbackToken: string
  url?: string
  expiresAt?: string | null
  publishedSnapshotId?: string
  publicationId?: string
  shareTitle?: string
  useCurrentTheme?: boolean
  pending?: ProjectPending
}
interface PendingBase {
  snapshotId: string
  entry: string
  expiresInSeconds: number | null
  shareTitle?: string
  useCurrentTheme?: boolean
  warnings?: string[]
  protocol?: 2
  archiveFormat?: 'source' | 'legacy'
  entrySnapshotId?: string
  expiresAt?: string | null
  upload?: FrozenUpload
  legacy?: { migrationId: string; snapshotId: string; publicationId?: string; expires_at: string | null }
  migrationPublicationId?: string
}
type StagedPending = PendingBase & {
  phase: 'entry' | 'preparing' | 'full' | 'legacy'
  publicationId: string
  previousPublicationId: string | null
  approved: { path: string; hash: string }[]
  frozenTheme: { themeId: string; compiledCss: string }
}
type ProjectPending = (PendingBase & { phase?: undefined }) | StagedPending
interface FrozenUpload {
  sessionId: string
  phase: 'entry' | 'full' | 'legacy'
  plans: ArtifactPlan[]
  receipts: Partial<Record<ArtifactName, { number: number; etag: string }[]>>
  replaceSessionId?: string
}
interface UploadReceipt {
  publicationId: string | null
  revoked?: boolean
  entry_deadline?: string
  expires_at: string | null
  active: { publicationId: string; snapshotId: string; expires_at: string | null } | null
  upload?: { sessionId: string; phase: 'entry' | 'full' | 'legacy'; snapshotId: string; sealed: ArtifactName[] }
  pending?: { publicationId: string; entrySnapshotId: string; expires_at: string | null }
  entry?: { publicationId: string; snapshotId: string; expires_at: string | null }
  legacy?: { bytes: number; expires_at: string | null; project_id?: string }
}
export interface ProjectPublishResult { info: ProjectInfo; identity: ProjectIdentity; warnings?: string[] }
export type ProjectPublishProgress = { phase: 'preparing' } | ProjectUploadProgress
export interface ProjectPublishOptions {
  useCurrentTheme?: boolean
  onEntryPublished?: (result: ProjectPublishResult) => void | Promise<void>
  onProgress?: (progress: ProjectPublishProgress) => void
}
const KEY = 'projectShares'

export function projectCommand<T>(op: string, input: Record<string, unknown>): Promise<T> {
  return invoke<T>('project_share', { request: { op, ...input } })
}

export const saveProjectReview = (project_id: string, submissionId: string, path: string, draft: ReviewDraft) =>
  projectCommand<LocalFeedback>('review-save', { project_id, submissionId, path, draft })

export const decideProjectAnnotation = (project_id: string, submissionId: string, index: number, value: 'promoted' | 'dismissed') =>
  projectCommand<LocalFeedback>('annotation-decide', { project_id, submissionId, index, value })

export async function projectIdentities(): Promise<Record<string, ProjectIdentity>> {
  const store = await Store.load('share_db.json')
  return await store.get<Record<string, ProjectIdentity>>(KEY) ?? {}
}

/** The host owns projects; publishing credentials may outlive a lost binding. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const local = await projectCommand<ProjectSummary[]>('projects', {})
  const identities = await projectIdentities()
  const known = new Set(local.map(project => project.project_id))
  return [...local, ...Object.values(identities).filter(identity => !known.has(identity.project_id)).map(identity => ({
    project_id: identity.project_id, sourceRoot: identity.sourceRoot, entry: identity.entry,
    mirrorRoot: '', files: [], url: identity.url, publishedSnapshotId: identity.publishedSnapshotId,
    sourceAvailable: false, orphaned: true, error: '仅有分享记录，本机项目绑定缺失。可停止分享或移除此记录。',
  }))]
}

export function createProject(sourceFile: string): Promise<ProjectInfo> {
  return projectCommand('create', { sourceFile })
}

async function forgetProjectIdentity(project_id: string): Promise<void> {
  const store = await Store.load('share_db.json')
  const all = await store.get<Record<string, ProjectIdentity>>(KEY) ?? {}
  delete all[project_id]
  await store.set(KEY, all)
  await store.save()
}

export function cancelProjectDeletion(project_id: string): Promise<void> {
  return projectCommand('cancel-delete', { project_id })
}

/** Reserve locally before revoking remotely; failures retain credentials for retry. */
export async function deleteProject(project_id: string, beforeDelete?: () => Promise<void>): Promise<void> {
  const local = (await projectCommand<ProjectSummary[]>('projects', {})).find(project => project.project_id === project_id)
  const identity = (await projectIdentities())[project_id]
  if (local?.url && !identity) throw new Error('缺少此项目的本机发布凭据，无法确认撤回分享。请先恢复凭据。')
  if (local) await projectCommand('begin-delete', { project_id })
  if (identity?.url || identity?.pending || local?.url) {
    await stopProjectShare(project_id)
  }
  await beforeDelete?.()
  if (local) await projectCommand('delete', { project_id })
  await forgetProjectIdentity(project_id)
  try {
    if (localStorage.getItem('projectShare.lastProjectId') === project_id) {
      localStorage.removeItem('projectShare.lastProjectId')
      localStorage.removeItem('projectShare.lastProject')
    }
  } catch { /* persisted selection is optional */ }
}

async function remember(identity: ProjectIdentity): Promise<void> {
  const store = await Store.load('share_db.json')
  const all = await store.get<Record<string, ProjectIdentity>>(KEY) ?? {}
  await store.set(KEY, { ...all, [identity.project_id]: identity })
  try { await store.save() } catch (error) {
    // A failed completion save must never make the in-memory pending disappear.
    if (all[identity.project_id]?.pending && !identity.pending) await store.set(KEY, all)
    throw error
  }
}

export async function rememberProjectLocation(info: ProjectInfo): Promise<void> {
  const identity = (await projectIdentities())[info.project_id]
  if (identity) await remember({ ...identity, sourceRoot: info.sourceRoot, entry: info.entry })
}

async function configuration() {
  const { getPluginScopedKey } = await import('../settings.svelte')
  const baseUrl = String(getPluginScopedKey('share.baseUrl') ?? '').replace(/\/+$/, '')
  const apiKey = String(getPluginScopedKey('share.apiKey') ?? '')
  if (!baseUrl || !apiKey) throw new Error('请先在设置中配置分享服务地址和 API Key')
  const url = new URL(baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('分享服务地址无效')
  const expiry = String(getPluginScopedKey('share.defaultExpiry') ?? '7d')
  const expiresInSeconds = expiry === 'never' ? null : ({ '7d': 7, '30d': 30, '90d': 90 }[expiry] ?? 7) * 86400
  return { baseUrl, apiKey, expiresInSeconds }
}

function checkService(identity: ProjectIdentity | undefined, baseUrl: string): void {
  if (identity && identity.baseUrl !== baseUrl) throw new Error('该项目绑定了另一个分享服务。请恢复原服务设置后维护此分享')
}

async function ownerRequest(baseUrl: string, apiKey: string, path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(baseUrl + path, {
    method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status === 404 && method === 'DELETE') return {}
  if (!response.ok) throw new ProjectServiceError(response.status, (await response.text()).slice(0, 300))
  if (response.status === 204) return {}
  return response.json()
}

class ProjectServiceError extends Error {
  constructor(readonly status: number, readonly detail: string) { super(`分享服务 HTTP ${status}：${detail}`) }
}

function validPartReceipt(receipt: { number: number; etag: string }, part: { number: number; md5: string }): boolean {
  return receipt.number === part.number && typeof receipt.etag === 'string' && receipt.etag.length > 0 && receipt.etag.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(receipt.etag)
    && (!/^[a-f0-9]{32}$/i.test(receipt.etag) || receipt.etag.toLowerCase() === part.md5)
}

/** Freeze every artifact and receipt locally; only exact active identities finish a publication. */
export async function publishProject(info: ProjectInfo, files: ProjectFile[], title?: string, options: ProjectPublishOptions = {}): Promise<ProjectPublishResult> {
  let published = await projectCommand<ProjectInfo>('get', { project_id: info.project_id })
  if (info.deleting || published.deleting) throw new Error('项目正在删除，请完成或取消删除后再发布。')
  const cfg = await configuration()
  let identity = (await projectIdentities())[info.project_id]
  checkService(identity, cfg.baseUrl)
  if (!identity) identity = {
    project_id: info.project_id, sourceRoot: info.sourceRoot, entry: info.entry, baseUrl: cfg.baseUrl,
    slug: generateSlug('project-' + crypto.randomUUID(), info.project_id, false), edit_token: crypto.randomUUID().replace(/-/g, ''),
    feedbackToken: crypto.randomUUID() + crypto.randomUUID(),
  }
  const path = `/project/${identity.slug}/upload/`
  const request = (op: string, body: unknown) => ownerRequest(identity.baseUrl, cfg.apiKey, path + op, 'POST', body) as Promise<UploadReceipt>
  const status = async (): Promise<UploadReceipt | null> => {
    try { return await request('status', { edit_token: identity.edit_token }) } catch (error) {
      if (error instanceof ProjectServiceError && error.status === 404) return null
      throw error
    }
  }
  if (!identity.pending) {
    options.onProgress?.({ phase: 'preparing' })
    const entry = files.find(file => file.path === info.entry)
    if (!entry) throw new Error('必须包含入口文档')
    const useCurrentTheme = options.useCurrentTheme ?? identity.useCurrentTheme ?? true
    const frozenTheme = await captureProjectTheme(useCurrentTheme)
    const snapshot = await projectCommand<ProjectSnapshot>('snapshot', {
      project_id: info.project_id, paths: [entry.path], hashes: { [entry.path]: entry.hash },
    })
    const shareTitle = normalizeShareTitle(title ?? identity.shareTitle, snapshot.entry)
    const presentation = await renderProjectPresentation(snapshot, { useCurrentTheme, frozenTheme })
    const html = buildProjectBundle(snapshot, `${identity.baseUrl}/feedback/${identity.slug}`, {
      title: shareTitle, presentation, publicationPending: true, archiveUrl: `${identity.baseUrl}/project/${identity.slug}/download`,
    })
    await projectCommand('bundle', { project_id: info.project_id, snapshotId: snapshot.snapshotId, html })
    const plan = await createArtifactPlan('entry', new TextEncoder().encode(html))
    identity = { ...identity, sourceRoot: info.sourceRoot, entry: info.entry, pending: {
      snapshotId: snapshot.snapshotId, entrySnapshotId: snapshot.snapshotId, entry: snapshot.entry, expiresInSeconds: cfg.expiresInSeconds,
      shareTitle, useCurrentTheme, warnings: presentation.warnings, frozenTheme,
      phase: 'entry', publicationId: crypto.randomUUID(), previousPublicationId: identity.publicationId ?? null,
      approved: files.map(({ path, hash }) => ({ path, hash })), protocol: 2, archiveFormat: 'source',
      upload: { sessionId: crypto.randomUUID(), phase: 'entry', plans: [plan], receipts: {} },
    } }
  }
  // Always retry the durable save before the first request, including in-memory Store retries.
  await remember(identity)
  const url = `${identity.baseUrl}/${identity.slug}`
  const finish = async (pending: ProjectPending, expiresAt: string | null, publicationId?: string): Promise<ProjectPublishResult> => {
    published = await projectCommand<ProjectInfo>('published', { project_id: info.project_id, snapshotId: pending.snapshotId, url })
    const complete: ProjectIdentity = { ...identity, url, publishedSnapshotId: pending.snapshotId, expiresAt,
      useCurrentTheme: pending.useCurrentTheme ?? true,
      ...(publicationId ? { publicationId } : {}), ...(pending.shareTitle === undefined ? {} : { shareTitle: pending.shareTitle }) }
    delete complete.pending
    await remember(complete)
    identity = complete
    return { info: published, identity, warnings: pending.warnings ?? [] }
  }
  if (!identity.pending!.phase) {
    let legacy = identity.pending!
    // Persist one migration generation even if the metadata request has an unknown result.
    if (!legacy.migrationPublicationId) {
      legacy = { ...legacy, migrationPublicationId: crypto.randomUUID(), legacy: {
        migrationId: crypto.randomUUID(), snapshotId: identity.publishedSnapshotId ?? legacy.snapshotId, expires_at: identity.expiresAt ?? null,
      } }
      identity = { ...identity, pending: legacy }; await remember(identity)
    }
    const remote = await status()
    if (!remote?.legacy) throw new Error('原发布状态无法确认，本轮不续期。请保留冻结输入，主动发起新一轮分享。')
    if (remote.legacy.project_id && remote.legacy.project_id !== info.project_id) throw new Error('旧分享项目身份不匹配')
    if (remote.legacy.expires_at && Date.parse(remote.legacy.expires_at) <= Date.now()) throw new Error('原分享已到期，本轮不续期。请保留冻结输入，主动发起新一轮分享。')
    const response = await fetch(identity.baseUrl + path + 'legacy', {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ edit_token: identity.edit_token }),
    })
    if (!response.ok) throw new ProjectServiceError(response.status, (await response.text()).slice(0, 300))
    const html = await projectCommand<string>('bundle-get', { project_id: info.project_id, snapshotId: legacy.snapshotId })
    const bytes = new TextEncoder().encode(html)
    const remoteBytes = new Uint8Array(await response.arrayBuffer())
    if (remoteBytes.byteLength !== remote.legacy.bytes) throw new Error('旧分享正文长度与远端元数据不一致')
    if (await artifactSha256(remoteBytes) === await artifactSha256(bytes)) return finish(legacy, remote.legacy.expires_at)
    legacy = { ...legacy, expiresAt: remote.legacy.expires_at, legacy: { ...legacy.legacy!, expires_at: remote.legacy.expires_at } }
    identity = { ...identity, pending: {
      ...legacy, phase: 'legacy', protocol: 2, publicationId: legacy.migrationPublicationId!, previousPublicationId: null,
      approved: [], frozenTheme: { themeId: '', compiledCss: '' },
      upload: { sessionId: crypto.randomUUID(), phase: 'legacy', plans: [await createArtifactPlan('entry', bytes)], receipts: {} },
    } }
    await remember(identity)
  }
  let pending = identity.pending as StagedPending
  const persist = async (next: StagedPending) => { pending = next; identity = { ...identity, pending }; await remember(identity) }
  const assertUsable = (receipt: UploadReceipt | null) => {
    if (!receipt) return
    if (receipt.publicationId === pending.publicationId && receipt.revoked) throw new Error('本轮分享已撤回，请保留冻结输入并主动发起新一轮分享。')
    const targetExpiries = [
      receipt.publicationId === pending.publicationId ? receipt.expires_at : undefined,
      receipt.pending?.publicationId === pending.publicationId ? receipt.pending.expires_at : undefined,
      receipt.entry?.publicationId === pending.publicationId ? receipt.entry.expires_at : undefined,
      receipt.active?.publicationId === pending.publicationId ? receipt.active.expires_at : undefined,
    ]
    if (targetExpiries.some(expiry => expiry && Date.parse(expiry) <= Date.now())) throw new Error('本轮分享已到期，请保留冻结输入并主动发起新一轮分享。')
    if (receipt.publicationId === pending.publicationId && receipt.entry?.publicationId !== pending.publicationId && receipt.active?.publicationId !== pending.publicationId
      && receipt.entry_deadline && Date.parse(receipt.entry_deadline) <= Date.now()) throw new Error('本轮入口上传已到期，请保留冻结输入并主动发起新一轮分享。')
  }
  let remote = await status()
  assertUsable(remote)
  const exactActive = (receipt: UploadReceipt | null) => receipt?.active?.publicationId === pending.publicationId && receipt.active.snapshotId === pending.snapshotId
  if ((pending.phase === 'full' || pending.phase === 'legacy') && exactActive(remote)) return finish(pending, remote!.active!.expires_at, pending.publicationId)
  if (remote?.publicationId && remote.publicationId !== pending.publicationId && remote.publicationId !== pending.previousPublicationId) throw new Error('远端发布代际身份已变化，请保留本轮冻结输入。')
  const confirmedEntry = exactActive(remote) || remote?.entry?.publicationId === pending.publicationId && remote.entry.snapshotId === pending.snapshotId
  if (pending.phase === 'entry' && confirmedEntry) {
    const expiresAt = remote!.entry?.expires_at ?? remote!.pending?.expires_at ?? remote!.expires_at
    if (exactActive(remote)) {
      published = await projectCommand<ProjectInfo>('published', { project_id: info.project_id, snapshotId: pending.snapshotId, url })
      identity = { ...identity, url, publishedSnapshotId: pending.snapshotId, expiresAt, shareTitle: pending.shareTitle, useCurrentTheme: pending.useCurrentTheme ?? true }
    }
    identity = { ...identity, publicationId: pending.publicationId }
    await persist({ ...pending, phase: 'preparing', expiresAt, entrySnapshotId: pending.snapshotId, upload: undefined, protocol: 2, archiveFormat: 'source' })
  }
  async function transfer(artifacts: { name: ArtifactName; bytes: Uint8Array }[]): Promise<UploadReceipt> {
    if (!pending.upload) await persist({ ...pending, protocol: 2, upload: {
      sessionId: crypto.randomUUID(), phase: pending.phase === 'entry' ? 'entry' : pending.phase === 'legacy' ? 'legacy' : 'full',
      plans: await Promise.all(artifacts.map(artifact => createArtifactPlan(artifact.name, artifact.bytes))), receipts: {},
    } })
    let upload = pending.upload!
    if (upload.plans.length !== artifacts.length) throw new Error('冻结产物数量不一致')
    for (const artifact of artifacts) {
      const plan = upload.plans.find(plan => plan.name === artifact.name)
      if (!plan) throw new Error('冻结产物身份不一致')
      await verifyArtifactPlan(plan, artifact.bytes)
    }
    const send = async (): Promise<UploadReceipt> => {
      const operation = () => ({ edit_token: identity.edit_token, publicationId: pending.publicationId, sessionId: upload.sessionId })
      let receipt = await request('begin', { ...operation(), project_id: info.project_id, feedback_token_hash: await sha256Hex(identity.feedbackToken),
        previousPublicationId: pending.previousPublicationId, phase: upload.phase, snapshotId: pending.snapshotId,
        entry: pending.entry, title: pending.shareTitle ?? normalizeShareTitle(undefined, pending.entry), expires_in_seconds: pending.expiresInSeconds,
        artifacts: upload.plans, ...(upload.replaceSessionId ? { replaceSessionId: upload.replaceSessionId } : {}), ...(pending.legacy ? { legacy: pending.legacy } : {}),
      })
      assertUsable(receipt)
      if (exactActive(receipt) && upload.phase !== 'entry') return receipt
      if (receipt.upload?.sessionId !== upload.sessionId || receipt.upload.snapshotId !== pending.snapshotId || receipt.upload.phase !== upload.phase) throw new Error('分享服务上传会话身份不匹配')
      for (const artifact of artifacts) {
        const plan = upload.plans.find(plan => plan.name === artifact.name)!
        if (receipt.upload?.sealed.includes(artifact.name)) continue
        for (const part of plan.parts) {
          const confirmed = upload.receipts[artifact.name] ?? []
          const known = confirmed.find(item => item.number === part.number)
          if (known) { if (!validPartReceipt(known, part)) throw new Error('本机分片回执与冻结计划不一致'); continue }
          const bytes = artifact.bytes.subarray((part.number - 1) * MULTIPART_BYTES, (part.number - 1) * MULTIPART_BYTES + part.bytes)
          const response = await uploadProjectPart(identity.baseUrl + path + 'part', {
            Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/octet-stream', 'X-Edit-Token': identity.edit_token,
            'X-Publication-Id': pending.publicationId, 'X-Upload-Session': upload.sessionId, 'X-Artifact': artifact.name, 'X-Part-Number': String(part.number),
          }, bytes, { artifact: artifact.name, partNumber: part.number, partCount: plan.parts.length,
            confirmedBytes: confirmed.reduce((total, item) => total + plan.parts.find(part => part.number === item.number)!.bytes, 0), total: plan.bytes }, options.onProgress)
          if (!response.ok) throw new ProjectServiceError(response.status, (await response.text()).slice(0, 300))
          const received = await response.json() as { number: number; etag: string }
          if (!validPartReceipt(received, part)) throw new Error('分享服务分片校验回执不匹配')
          upload = { ...upload, receipts: { ...upload.receipts, [artifact.name]: [...confirmed, received] } }
          await persist({ ...pending, upload })
        }
        options.onProgress?.({ phase: 'processing' })
        receipt = await request('seal', { ...operation(), artifact: artifact.name, parts: upload.receipts[artifact.name] ?? [] })
        assertUsable(receipt)
      }
      options.onProgress?.({ phase: 'processing' })
      const committed = await request('commit', operation())
      assertUsable(committed)
      return committed
    }
    try { return await send() } catch (error) {
      if (!(error instanceof ProjectServiceError) || error.status !== 410 || !error.detail.includes('upload_expired')) throw error
      // The server verifies the original absolute business deadline before rotating transport.
      upload = { ...upload, sessionId: crypto.randomUUID(), replaceSessionId: upload.sessionId, receipts: {} }
      await persist({ ...pending, upload })
      return send()
    }
  }
  if (pending.phase === 'entry') {
    const html = await projectCommand<string>('bundle-get', { project_id: info.project_id, snapshotId: pending.snapshotId })
    remote = await transfer([{ name: 'entry', bytes: new TextEncoder().encode(html) }])
    const entryConfirmed = exactActive(remote) || remote.entry?.publicationId === pending.publicationId && remote.entry.snapshotId === pending.snapshotId
    if (!entryConfirmed) throw new Error('分享服务未确认入口发布身份')
    const expiresAt = remote.entry?.expires_at ?? remote.pending?.expires_at ?? remote.expires_at
    if (exactActive(remote)) {
      published = await projectCommand<ProjectInfo>('published', { project_id: info.project_id, snapshotId: pending.snapshotId, url })
      identity = { ...identity, url, publishedSnapshotId: pending.snapshotId, expiresAt, shareTitle: pending.shareTitle, useCurrentTheme: pending.useCurrentTheme ?? true }
    }
    identity = { ...identity, publicationId: pending.publicationId }
    await persist({ ...pending, phase: 'preparing', expiresAt, entrySnapshotId: pending.snapshotId, upload: undefined, protocol: 2, archiveFormat: 'source' })
  }
  if (pending.phase !== 'legacy') {
    await options.onEntryPublished?.({ info: published, identity, warnings: pending.warnings ?? [] })
    options.onProgress?.({ phase: 'preparing' })
  }
  if (pending.phase === 'preparing') {
    const snapshot = await projectCommand<ProjectSnapshot>('snapshot', {
      project_id: info.project_id, paths: pending.approved.map(file => file.path), hashes: Object.fromEntries(pending.approved.map(file => [file.path, file.hash])),
    })
    const presentation = await renderProjectPresentation(snapshot, { useCurrentTheme: pending.useCurrentTheme, frozenTheme: pending.frozenTheme })
    const html = buildProjectBundle(snapshot, `${identity.baseUrl}/feedback/${identity.slug}`, {
      title: pending.shareTitle, presentation, archiveUrl: `${identity.baseUrl}/project/${identity.slug}/download`,
    })
    await projectCommand('bundle', { project_id: info.project_id, snapshotId: snapshot.snapshotId, html })
    await persist({ ...pending, phase: 'full', protocol: 2, archiveFormat: 'source', snapshotId: snapshot.snapshotId, warnings: presentation.warnings, upload: undefined })
  }
  const html = await projectCommand<string>('bundle-get', { project_id: info.project_id, snapshotId: pending.snapshotId })
  if (pending.phase === 'legacy') remote = await transfer([{ name: 'entry', bytes: new TextEncoder().encode(html) }])
  else {
    const snapshot = await projectCommand<ProjectSnapshot>('snapshot-get', { project_id: info.project_id, snapshotId: pending.snapshotId })
    const format = pending.archiveFormat ?? 'legacy'
    const archive = await buildProjectArchive(snapshot, html, format)
    await persist({ ...pending, archiveFormat: format })
    remote = await transfer([{ name: 'archive', bytes: archive }, { name: 'reader', bytes: new TextEncoder().encode(html) }])
  }
  if (!exactActive(remote)) throw new Error('分享服务未确认完整发布身份，请保留本轮待传记录后重试。')
  return finish(pending, remote!.active!.expires_at, pending.publicationId)
}

export function collaborationLink(identity: ProjectIdentity): string | undefined {
  return identity.url ? identity.url + '#feedback=' + encodeURIComponent(identity.feedbackToken) : undefined
}

/** Restart pagination each time; local IDs, not a long-lived cursor, deduplicate. */
export async function pullProjectFeedback(project_id: string): Promise<LocalFeedback[]> {
  const cfg = await configuration()
  const identity = (await projectIdentities())[project_id]
  checkService(identity, cfg.baseUrl)
  const baseUrl = identity?.baseUrl ?? cfg.baseUrl
  const known = await projectCommand<LocalFeedback[]>('inbox', { project_id })
  const seen = new Set(known.map(item => item.envelope.payload.submissionId))
  let cursor: string | undefined
  do {
    const page: { items: { submissionId: string }[]; cursor?: string } = await ownerRequest(baseUrl, cfg.apiKey,
      `/feedback?project_id=${encodeURIComponent(project_id)}` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    for (const item of page.items) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.submissionId)) throw new Error('分享服务返回了无效反馈 ID')
      if (seen.has(item.submissionId)) continue
      const envelope: FeedbackEnvelope = await ownerRequest(baseUrl, cfg.apiKey,
        `/feedback/${encodeURIComponent(project_id)}/${encodeURIComponent(item.submissionId)}`)
      if (envelope.payload.project_id !== project_id || envelope.payload.submissionId !== item.submissionId) throw new Error('反馈身份与请求不一致')
      await projectCommand('feedback', { project_id, envelope })
      seen.add(item.submissionId)
    }
    cursor = page.cursor
  } while (cursor)
  return projectCommand('inbox', { project_id })
}

export async function stopProjectShare(project_id: string): Promise<void> {
  const cfg = await configuration()
  const identity = (await projectIdentities())[project_id]
  if (!identity) throw new Error('该项目没有本机发布记录')
  checkService(identity, cfg.baseUrl)
  const pending = identity.pending
  const staged = pending?.phase ? pending : undefined
  const receipt = await ownerRequest(identity.baseUrl, cfg.apiKey, '/' + identity.slug, 'DELETE', {
    edit_token: identity.edit_token, project_id,
    ...(pending?.legacy ? { legacyMigrationId: pending.legacy.migrationId } : {}),
    publicationId: staged?.publicationId ?? identity.publicationId,
    previousPublicationId: staged ? staged.previousPublicationId : identity.publicationId ?? null,
    ...(staged?.phase === 'entry' ? { entrySnapshotId: staged.snapshotId, legacySnapshotId: identity.publishedSnapshotId } : {}),
  })
  // Orphaned owner credentials still allow revocation without inventing a binding.
  const local = await projectCommand<ProjectSummary[]>('projects', {})
  if (local.some(project => project.project_id === project_id)) await projectCommand('stopped', { project_id })
  const stopped = { ...identity }
  if (typeof receipt.publicationId === 'string') stopped.publicationId = receipt.publicationId
  delete stopped.url
  delete stopped.pending
  delete stopped.expiresAt
  await remember(stopped)
}
