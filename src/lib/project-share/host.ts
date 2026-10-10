import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'
import { sha256Hex } from '../hash'
import { generateSlug } from '../share/slug'
import { buildProjectBundle } from './bundle'
import type { FeedbackEnvelope, LocalFeedback, ProjectFile, ProjectInfo, ProjectSnapshot } from './types'

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
  pending?: { snapshotId: string; entry: string; expiresInSeconds: number | null }
}
const KEY = 'projectShares'

export function projectCommand<T>(op: string, input: Record<string, unknown>): Promise<T> {
  return invoke<T>('project_share', { request: { op, ...input } })
}

export async function projectIdentities(): Promise<Record<string, ProjectIdentity>> {
  const store = await Store.load('share_db.json')
  return await store.get<Record<string, ProjectIdentity>>(KEY) ?? {}
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

/** Persist everything needed to retry before sending the first request. */
export async function publishProject(info: ProjectInfo, files: ProjectFile[]): Promise<{ info: ProjectInfo; identity: ProjectIdentity }> {
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
  let html: string
  if (identity.pending) {
    html = await projectCommand<string>('bundle-get', { project_id: info.project_id, snapshotId: identity.pending.snapshotId })
  } else {
    if (!files.some(file => file.path === info.entry)) throw new Error('必须包含入口文档')
    const snapshot = await projectCommand<ProjectSnapshot>('snapshot', {
      project_id: info.project_id, paths: files.map(file => file.path), hashes: Object.fromEntries(files.map(file => [file.path, file.hash])),
    })
    html = buildProjectBundle(snapshot, `${identity.baseUrl}/feedback/${identity.slug}`)
    await projectCommand('bundle', { project_id: info.project_id, snapshotId: snapshot.snapshotId, html })
    identity = { ...identity, sourceRoot: info.sourceRoot, entry: info.entry,
      pending: { snapshotId: snapshot.snapshotId, entry: snapshot.entry, expiresInSeconds: cfg.expiresInSeconds } }
    await remember(identity)
  }
  const pending = identity.pending!
  const receipt = await ownerRequest(identity.baseUrl, cfg.apiKey, '/publish', 'POST', {
    slug: identity.slug, edit_token: identity.edit_token, html, expires_in_seconds: pending.expiresInSeconds,
    metadata: { original_filename: pending.entry, source_ext: 'md', project_id: info.project_id,
      feedback_token_hash: await sha256Hex(identity.feedbackToken) },
  })
  const url = `${identity.baseUrl}/${identity.slug}`
  const published = await projectCommand<ProjectInfo>('published', { project_id: info.project_id, snapshotId: pending.snapshotId, url })
  identity = { ...identity, url, publishedSnapshotId: pending.snapshotId, expiresAt: receipt.expires_at }
  delete identity.pending
  await remember(identity)
  return { info: published, identity }
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
  await ownerRequest(identity.baseUrl, cfg.apiKey, '/' + identity.slug, 'DELETE', { edit_token: identity.edit_token })
  const stopped = { ...identity }
  delete stopped.url
  delete stopped.pending
  delete stopped.expiresAt
  await remember(stopped)
}
