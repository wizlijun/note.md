import { DEFAULT_RULES, normalizeRules, type ClassificationRule } from './classification'
import { parseTimeline, type TimelineDocument } from './parser'

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

export class InvalidRulesError extends Error {
  constructor() { super('分类设置格式无效。'); this.name = 'InvalidRulesError' }
}

export async function loadRules(): Promise<ClassificationRule[]> {
  const result = await host().request('host.settings.get')
  const stored = result?.settings?.classification
  if (stored === undefined) return structuredClone(DEFAULT_RULES)
  const rules = normalizeRules(stored)
  if (!rules) throw new InvalidRulesError()
  return rules
}

export async function saveRules(value: ClassificationRule[]): Promise<void> {
  const rules = normalizeRules(value)
  if (!rules) throw new Error('每条规则需要名称、关键词及有效的大类。')
  await host().request('host.settings.set', { key: 'classification', value: rules })
}

let opened: { origin: string; requestId: number; uri: string } | null = null

export function isHostOrigin(origin: string): boolean {
  return origin === 'tauri://localhost' || /^https?:\/\/tauri\.localhost$/.test(origin)
    || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
}

export function onDocument(callback: (document: TimelineDocument) => void): () => void {
  const receive = (event: MessageEvent) => {
    const data = event.data
    if (event.source !== window.parent || !isHostOrigin(event.origin) || !data || data.type !== 'custom_editor.open'
      || data.editorId !== 'timeline' || !Number.isSafeInteger(data.requestId)
      || typeof data.content !== 'string' || typeof data.uri !== 'string') return
    opened = { origin: event.origin, requestId: data.requestId, uri: data.uri }
    let ready = false
    try {
      const document = parseTimeline(data.content, data.uri)
      if (document) { callback(document); ready = true }
    } catch { /* A failed view is handled by the host's Markdown fallback. */ }
    window.parent.postMessage({ type: ready ? 'custom_editor.ready' : 'custom_editor.fallback', requestId: data.requestId }, event.origin)
  }
  window.addEventListener('message', receive)
  return () => { window.removeEventListener('message', receive); opened = null }
}

export function editMarkdown(): void {
  if (!opened) return
  window.parent.postMessage({ type: 'custom_editor.fallback', requestId: opened.requestId, reason: 'edit' }, opened.origin)
}

/** Resolve a source relative to the timeline; the host enforces the Vault fence again. */
export function sourcePath(uri: string, target: string, root: string): string {
  const path = target.split('#')[0]
  if (!path || /^[a-z][\w+.-]*:/i.test(path) || path.startsWith('//')) throw new Error('仅支持知识库内的来源文件。')
  const absolute = (value: string) => '/' + value.replace(/\\/g, '/').replace(/^\/+/, '')
  const base = new URL(`file://${absolute(uri).split('/').map(encodeURIComponent).join('/')}`)
  const resolved = decodeURIComponent(new URL(path, base).pathname)
  const prefix = absolute(root).replace(/\/+$/, '') + '/'
  if (!resolved.startsWith(prefix) || resolved.length <= prefix.length) throw new Error('来源文件不在当前知识库中。')
  const relative = resolved.slice(prefix.length)
  if (relative.split('/').some(part => part === '.' || part === '..')) throw new Error('来源路径无效。')
  return relative
}

export async function openLink(target: string): Promise<void> {
  if (!opened) return
  const uri = opened.uri
  const vault = await host().request('host.vault.info')
  if (!vault?.root) throw new Error('请先打开知识库。')
  const path = sourcePath(uri, target, vault.root)
  await host().request('host.editor.open', { path })
}
