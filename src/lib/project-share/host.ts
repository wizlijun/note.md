import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'
import { sha256Hex } from '../hash'
import { generateSlug } from '../share/slug'
import { buildProjectBundle } from './bundle'
import { captureProjectTheme, renderProjectPresentation } from './presentation'
import { buildProjectArchive } from './archive'
import { normalizeShareTitle } from './title'
import type { FeedbackEnvelope, LocalFeedback, ProjectFile, ProjectInfo, ProjectSnapshot, ProjectSummary } from './types'

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
}
type ProjectPending = PendingBase & ({ phase?: undefined } | {
  phase: 'entry' | 'preparing' | 'full'
  publicationId: string
  previousPublicationId: string | null
  approved: { path: string; hash: string }[]
  frozenTheme: { themeId: string; compiledCss: string }
})
export interface ProjectPublishResult { info: ProjectInfo; identity: ProjectIdentity; warnings?: string[] }
export interface ProjectPublishOptions {
  useCurrentTheme?: boolean
  onEntryPublished?: (result: ProjectPublishResult) => void | Promise<void>
}
const KEY = 'projectShares'

export function projectCommand<T>(op: string, input: Record<string, unknown>): Promise<T> {
  return invoke<T>('project_share', { request: { op, ...input } })
}

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
  await store.save()
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
  if (!response.ok) throw new Error(`分享服务 HTTP ${response.status}：${(await response.text()).slice(0, 300)}`)
  if (response.status === 204) return {}
  return response.json()
}

/** Persist each immutable stage before its first request; old pending packages keep their protocol. */
export async function publishProject(info: ProjectInfo, files: ProjectFile[], title?: string, options: ProjectPublishOptions = {}): Promise<ProjectPublishResult> {
  let published = await projectCommand<ProjectInfo>('get', { project_id: info.project_id })
  if (info.deleting || published.deleting) throw new Error('项目正在删除，请完成或取消删除后再发布。')
  const cfg = await configuration()
  let identity = (await projectIdentities())[info.project_id]
  checkService(identity, cfg.baseUrl)
  if (!identity) {
    identity = {
      project_id: info.project_id, sourceRoot: info.sourceRoot, entry: info.entry, baseUrl: cfg.baseUrl,
      slug: generateSlug('project-' + crypto.randomUUID(), info.project_id, false), edit_token: crypto.randomUUID().replace(/-/g, ''),
      feedbackToken: crypto.randomUUID() + crypto.randomUUID(),
    }
  }
  if (!identity.pending) {
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
    identity = { ...identity, sourceRoot: info.sourceRoot, entry: info.entry, pending: {
      snapshotId: snapshot.snapshotId, entry: snapshot.entry, expiresInSeconds: cfg.expiresInSeconds,
      shareTitle, useCurrentTheme, warnings: presentation.warnings, frozenTheme,
      phase: 'entry', publicationId: crypto.randomUUID(), previousPublicationId: identity.publicationId ?? null, approved: files.map(({ path, hash }) => ({ path, hash })),
    } }
  }
  // Store can retain in-memory changes after a failed save, so save on every attempt.
  await remember(identity)
  let pending = identity.pending!
  const url = `${identity.baseUrl}/${identity.slug}`
  if (!pending.phase) {
    const html = await projectCommand<string>('bundle-get', { project_id: info.project_id, snapshotId: pending.snapshotId })
    const receipt = await ownerRequest(identity.baseUrl, cfg.apiKey, '/publish', 'POST', {
      slug: identity.slug, edit_token: identity.edit_token, html, expires_in_seconds: pending.expiresInSeconds,
      metadata: { original_filename: pending.entry, source_ext: 'md', project_id: info.project_id,
        feedback_token_hash: await sha256Hex(identity.feedbackToken) },
    })
    published = await projectCommand<ProjectInfo>('published', { project_id: info.project_id, snapshotId: pending.snapshotId, url })
    identity = { ...identity, url, publishedSnapshotId: pending.snapshotId, expiresAt: receipt.expires_at,
      useCurrentTheme: pending.useCurrentTheme ?? true,
      ...(pending.shareTitle === undefined ? {} : { shareTitle: pending.shareTitle }) }
    delete identity.pending
    await remember(identity)
    return { info: published, identity, warnings: pending.warnings ?? [] }
  }
  if (pending.phase === 'entry') {
    const html = await projectCommand<string>('bundle-get', { project_id: info.project_id, snapshotId: pending.snapshotId })
    const receipt = await ownerRequest(identity.baseUrl, cfg.apiKey, `/project/${identity.slug}/entry`, 'POST', {
      publicationId: pending.publicationId, previousPublicationId: pending.previousPublicationId, snapshotId: pending.snapshotId, project_id: info.project_id,
      edit_token: identity.edit_token, feedback_token_hash: await sha256Hex(identity.feedbackToken),
      html, entry: pending.entry, title: pending.shareTitle, expires_in_seconds: pending.expiresInSeconds,
    })
    // Existing complete publications stay active until their new archive is ready.
    if (receipt.stage === 'entry') {
      published = await projectCommand<ProjectInfo>('published', { project_id: info.project_id, snapshotId: pending.snapshotId, url })
      identity = { ...identity, url, publishedSnapshotId: pending.snapshotId, expiresAt: receipt.expires_at,
        shareTitle: pending.shareTitle, useCurrentTheme: pending.useCurrentTheme ?? true }
    } else if (receipt.stage !== 'ready') throw new Error('分享服务未确认入口发布阶段')
    pending = { ...pending, phase: 'preparing' }
    identity = { ...identity, pending, publicationId: pending.publicationId }
    await remember(identity)
  }
  await options.onEntryPublished?.({ info: published, identity, warnings: pending.warnings ?? [] })
  if (pending.phase === 'preparing') {
    // Recheck precisely the approved scope; never silently add or take changed files.
    const snapshot = await projectCommand<ProjectSnapshot>('snapshot', {
      project_id: info.project_id, paths: pending.approved.map(file => file.path),
      hashes: Object.fromEntries(pending.approved.map(file => [file.path, file.hash])),
    })
    const presentation = await renderProjectPresentation(snapshot, { useCurrentTheme: pending.useCurrentTheme, frozenTheme: pending.frozenTheme })
    const html = buildProjectBundle(snapshot, `${identity.baseUrl}/feedback/${identity.slug}`, {
      title: pending.shareTitle, presentation, archiveUrl: `${identity.baseUrl}/project/${identity.slug}/download`,
    })
    await projectCommand('bundle', { project_id: info.project_id, snapshotId: snapshot.snapshotId, html })
    pending = { ...pending, phase: 'full', snapshotId: snapshot.snapshotId, warnings: presentation.warnings }
    identity = { ...identity, pending }
    await remember(identity)
  }
  const snapshot = await projectCommand<ProjectSnapshot>('snapshot-get', { project_id: info.project_id, snapshotId: pending.snapshotId })
  const html = await projectCommand<string>('bundle-get', { project_id: info.project_id, snapshotId: pending.snapshotId })
  // Archive builder fixes timestamps, order and compression: cached inputs reproduce exact bytes.
  const archive = await buildProjectArchive(snapshot, html)
  const response = await fetch(`${identity.baseUrl}/project/${identity.slug}/archive`, {
    method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/zip',
      'X-Edit-Token': identity.edit_token, 'X-Publication-Id': pending.publicationId, 'X-Snapshot-Id': pending.snapshotId },
    body: archive as BodyInit,
  })
  if (!response.ok) throw new Error(`分享服务 HTTP ${response.status}：${(await response.text()).slice(0, 300)}`)
  const receipt = await response.json()
  if (receipt.stage !== 'ready') throw new Error('分享服务未确认完整项目发布阶段')
  published = await projectCommand<ProjectInfo>('published', { project_id: info.project_id, snapshotId: pending.snapshotId, url })
  identity = { ...identity, url, publishedSnapshotId: pending.snapshotId, expiresAt: receipt.expires_at,
    shareTitle: pending.shareTitle, useCurrentTheme: pending.useCurrentTheme ?? true }
  delete identity.pending
  await remember(identity)
  return { info: published, identity, warnings: pending.warnings ?? [] }
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
