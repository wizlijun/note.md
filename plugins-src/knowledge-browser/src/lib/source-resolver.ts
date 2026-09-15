export type SourceResolutionKind = 'vault' | 'web' | 'unsupported-scheme' | 'description' | 'external-path' | 'blocked'
export interface SourceResolution { kind: SourceResolutionKind; uri: string; vaultPath?: string; reason?: string }
export interface SourceLocation { kind: 'lines' | 'timecode' | 'quote' | 'unlocated'; startLine?: number; endLine?: number; startMs?: number; endMs?: number; matches?: number[]; reason?: string }

const CONTROL = new Set(['.git', '.notemd', 'node_modules', '.env', '.ssh', '.aws', '.config', 'credentials', 'secrets'])
const unsafe = (value: string) => /[\u0000-\u001f\u007f-\u009f\\]/.test(value)

function normalizeVaultPath(path: string): string | undefined {
  if (unsafe(path)) return undefined
  const result: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!result.length) return undefined; result.pop(); continue }
    if (part.startsWith('.') || CONTROL.has(part)) return undefined
    result.push(part)
  }
  return result.length ? result.join('/') : undefined
}

export function resolveSourceUri(uri: string, datasetVaultPath?: string): SourceResolution {
  const value = uri.trim(); if (!value || unsafe(value)) return { kind: 'blocked', uri, reason: 'URI 为空或包含控制字符。' }
  if (/^https?:\/\//i.test(value)) return { kind: 'web', uri }
  if (/^(?:file:\/\/|[a-zA-Z]:[\\/]|\/(?:Users|home|Volumes|private|var|etc)\/)/.test(value)) return { kind: 'external-path', uri, reason: '外部路径必须由用户通过文件选择器单独授权。' }
  if (/^[a-z][\w+.-]*:/i.test(value)) return { kind: 'unsupported-scheme', uri, reason: '该 URI scheme 不支持自动定位。' }
  if (value.startsWith('/')) {
    const vaultPath = normalizeVaultPath(value.slice(1)); return vaultPath ? { kind: 'vault', uri, vaultPath } : { kind: 'blocked', uri, reason: '来源路径越出 Vault 或进入控制目录。' }
  }
  if (/^[\w.-]+\s+/.test(value) || (!value.includes('/') && !/\.[a-z0-9]+$/i.test(value))) return { kind: 'description', uri, reason: '自然语言来源说明不解释为文件路径。' }
  const base = datasetVaultPath?.split('/').slice(0, -1).join('/') ?? ''
  const vaultPath = normalizeVaultPath(`${base}/${value}`)
  return vaultPath ? { kind: 'vault', uri, vaultPath } : { kind: 'blocked', uri, reason: '来源路径越出 Vault 或进入控制目录。' }
}

const timecode = (value: string): number | undefined => {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value.trim()); if (!match) return undefined
  const [, h, m, s, fraction = '0'] = match; if (+m > 59 || +s > 59) return undefined
  return ((+h * 60 + +m) * 60 + +s) * 1000 + +(fraction.padEnd(3, '0'))
}

export function parseSourceLocation(loc: string): SourceLocation {
  const line = /^(?:L|line-?|lines\s+)(\d+)(?:\s*(?:-|–)\s*(?:L)?(\d+))?$/i.exec(loc.trim())
  if (line) { const startLine = +line[1]; const endLine = +(line[2] ?? line[1]); return startLine > 0 && endLine >= startLine ? { kind: 'lines', startLine, endLine } : { kind: 'unlocated', reason: '行号范围无效。' } }
  const parts = loc.trim().split(/\s*(?:-->|–|-)\s*/)
  const startMs = timecode(parts[0]); const endMs = parts[1] ? timecode(parts[1]) : startMs
  if (startMs !== undefined && endMs !== undefined && endMs >= startMs) return { kind: 'timecode', startMs, endMs }
  return { kind: 'unlocated', reason: 'loc 不是当前支持的行号或时间码格式。' }
}

export function locateQuote(sourceText: string, quote: string): SourceLocation {
  const text = sourceText.replace(/\r\n?/g, '\n'); const needle = quote.replace(/\r\n?/g, '\n')
  if (!needle) return { kind: 'unlocated', reason: '没有可查找的短引文。' }
  const matches: number[] = []; let from = 0
  while (from <= text.length) { const found = text.indexOf(needle, from); if (found < 0) break; matches.push(found); from = found + Math.max(needle.length, 1) }
  return matches.length ? { kind: 'quote', matches } : { kind: 'unlocated', reason: '当前来源中未找到精确短引文。' }
}
