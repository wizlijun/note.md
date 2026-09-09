import { DEFAULT_RULES, normalizeRules, type ClassificationRule } from './classification'
import { parseTimeline, type TimelineDocument } from './parser'
import { timelineDateTarget } from './date-navigation'

export const DEFAULT_START_TIME = '09:00'

export interface TimelineSettings {
  classification: ClassificationRule[]
  startTime: string
}

interface HostBridge {
  locale: string
  theme: string
  request(method: string, params?: unknown): Promise<any>
}

function host(): HostBridge {
  const value = (window as Window & { notemd?: HostBridge }).notemd
  if (!value) throw new Error('Timeline host bridge is unavailable')
  return value
}

export function locale(): string { return host().locale }

export class InvalidSettingsError extends Error {
  constructor() { super('时间线设置格式无效。'); this.name = 'InvalidSettingsError' }
}

export function normalizeStartTime(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null
}

export function startTimeMinute(value: string): number {
  const normalized = normalizeStartTime(value)
  if (!normalized) throw new Error('打开时定位时间必须使用 HH:mm 格式。')
  const [hour, minute] = normalized.split(':').map(Number)
  return hour * 60 + minute
}

export async function loadSettings(): Promise<TimelineSettings> {
  const result = await host().request('host.settings.get')
  const root = result?.settings
  const stored = root?.timeline
  if (stored !== undefined && (!stored || typeof stored !== 'object' || Array.isArray(stored))) throw new InvalidSettingsError()
  const rulesValue = stored?.classification ?? root?.classification
  const rules = rulesValue === undefined ? structuredClone(DEFAULT_RULES) : normalizeRules(rulesValue)
  const timeValue = stored?.startTime
  const startTime = timeValue === undefined ? DEFAULT_START_TIME : normalizeStartTime(timeValue)
  if (!rules || !startTime) throw new InvalidSettingsError()
  return { classification: rules, startTime }
}

export async function saveSettings(value: TimelineSettings): Promise<void> {
  const rules = normalizeRules(value.classification)
  const startTime = normalizeStartTime(value.startTime)
  if (!rules) throw new Error('每条规则需要名称、关键词及有效的大类。')
  if (!startTime) throw new Error('打开时定位时间必须使用 HH:mm 格式。')
  await host().request('host.settings.set', { key: 'timeline', value: { classification: rules, startTime } })
}

let opened: { uri: string } | null = null

function absolutePath(value: string): string {
  return '/' + value.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function vaultRelativePath(uri: string, root: string): string {
  const absolute = absolutePath(uri)
  const prefix = absolutePath(root).replace(/\/+$/, '') + '/'
  if (!absolute.startsWith(prefix) || absolute.length <= prefix.length) throw new Error('文件不在当前知识库中。')
  const relative = absolute.slice(prefix.length)
  if (relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('文件路径无效。')
  return relative
}

export function isHostOrigin(origin: string): boolean {
  return origin === 'tauri://localhost' || /^https?:\/\/tauri\.localhost$/.test(origin)
    || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
}

export function onDocument(callback: (document: TimelineDocument) => void): () => void {
  const receive = (event: MessageEvent) => {
    const data = event.data
    if (event.source !== window.parent || !isHostOrigin(event.origin) || !data || data.type !== 'file_view.open'
      || data.viewId !== 'timeline' || !Number.isSafeInteger(data.requestId)
      || typeof data.content !== 'string' || typeof data.uri !== 'string') return
    opened = { uri: data.uri }
    let ready = false
    try {
      const document = parseTimeline(data.content, data.uri)
      if (document) { callback(document); ready = true }
    } catch { /* A failed view is handled by the host's Markdown fallback. */ }
    window.parent.postMessage({ type: ready ? 'file_view.ready' : 'file_view.fallback', requestId: data.requestId }, event.origin)
  }
  window.addEventListener('message', receive)
  return () => { window.removeEventListener('message', receive); opened = null }
}

/** Resolve a source relative to the timeline; the host enforces the Vault fence again. */
export function sourcePath(uri: string, target: string, root: string): string {
  const path = target.split('#')[0]
  if (!path || /^[a-z][\w+.-]*:/i.test(path) || path.startsWith('//')) throw new Error('仅支持知识库内的来源文件。')
  const base = new URL(`file://${absolutePath(uri).split('/').map(encodeURIComponent).join('/')}`)
  const resolved = decodeURIComponent(new URL(path, base).pathname)
  return vaultRelativePath(resolved, root)
}

export async function openLink(target: string): Promise<void> {
  if (!opened) return
  const uri = opened.uri
  const vault = await host().request('host.vault.info')
  if (!vault?.root) throw new Error('请先打开知识库。')
  const path = sourcePath(uri, target, vault.root)
  await host().request('host.editor.open', { path })
}

export async function openTimelineDate(date: string): Promise<void> {
  if (!opened) return
  const uri = opened.uri
  const target = timelineDateTarget(uri, date)
  const zh = locale().startsWith('zh')
  if (!target) throw new Error(zh ? '请使用 YYYY-MM-DD.timeline.md 格式的时间线文件和有效日期。' : 'Use a valid date and a YYYY-MM-DD.timeline.md file.')
  const vault = await host().request('host.vault.info')
  if (!vault?.root) throw new Error(zh ? '请先打开知识库。' : 'Open a Vault first.')
  const currentPath = vaultRelativePath(uri, vault.root)
  const path = sourcePath(uri, target, vault.root)
  const result = await host().request('host.vault.exists', { path })
  if (result?.exists !== true) throw new Error(zh ? `${date} 暂无时间线。` : `No timeline for ${date}.`)
  await host().request('host.editor.open', { path, fileView: 'timeline', replaceCurrent: true, currentPath })
}
