/** Declarative, read-only plugin views. The host keeps the underlying document. */
import { isMap, isScalar, parseDocument } from 'yaml'
import { basename, isAbsolute, normalize } from '../paths'
import type { FileViewContribution, FileViewScalar, FileViewSelector, PluginManifest } from './types'

export interface FileViewRef {
  pluginId: string
  viewId: string
  entry: string
}

interface ViewDocument {
  path: string
  kind: string
  content: string
}

const TEXT_KINDS = new Set(['markdown', 'mdx', 'html', 'code', 'spreadsheet', 'base'])
const MAX_ITEMS = 32
const MAX_PATH = 16_384
const MAX_FRONTMATTER = 128 * 1024
const VIEW_KEYS = new Set(['id', 'entry', 'priority', 'selectors'])
const SELECTOR_KEYS = new Set(['file_extensions', 'file_name_patterns', 'path_patterns', 'frontmatter'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Rust str::trim uses Unicode White_Space (unlike JavaScript's BOM-aware trim). */
function trim(value: string): string {
  const whitespace = /\p{White_Space}/u
  let start = 0
  let end = value.length
  while (start < end && whitespace.test(value[start])) start++
  while (end > start && whitespace.test(value[end - 1])) end--
  return value.slice(start, end)
}

function boundedString(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length <= max * 2 && [...value].length <= max && !value.includes('\0') && trim(value).length > 0
}

function list(value: unknown, valid: (item: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_ITEMS && value.every(valid)
}

function extension(value: string): string {
  return trim(value).replace(/^\.+/, '').toLowerCase()
}

function validScalar(value: unknown): value is FileViewScalar {
  return boundedString(value) || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

function validSelector(value: unknown): value is FileViewSelector {
  if (!record(value)) return false
  const keys = Object.keys(value)
  if (!keys.length || keys.some((key) => !SELECTOR_KEYS.has(key))) return false
  for (const key of keys) {
    const condition = value[key]
    if (key === 'frontmatter') {
      if (!record(condition)) return false
      const entries = Object.entries(condition)
      if (!entries.length || entries.length > MAX_ITEMS || entries.some(([name, values]) => !boundedString(name, 128) || !list(values, validScalar))) return false
    } else if (!list(condition, (item) => {
      if (!boundedString(item)) return false
      if (key === 'file_extensions') return /^[a-z0-9][a-z0-9_-]*$/i.test(extension(item))
      return !item.includes('\\') && (key !== 'file_name_patterns' || !item.includes('/'))
    })) return false
  }
  return true
}

/** Mirrors manifest validation in plugin-protocol; malformed views never claim files. */
export function isValidFileView(value: unknown): value is FileViewContribution {
  if (!record(value) || Object.keys(value).some((key) => !VIEW_KEYS.has(key))) return false
  if (!boundedString(value.id, 128) || !/^[a-z0-9-]+$/.test(value.id)) return false
  if (!boundedString(value.entry) || !value.entry.endsWith('.html') || /[\\%:?#]/.test(value.entry)) return false
  if (value.entry.split('/').some((part) => !part || part === '.' || part === '..')) return false
  if ('priority' in value && (typeof value.priority !== 'number' || !Number.isInteger(value.priority) || value.priority < -1000 || value.priority > 1000)) return false
  return list(value.selectors, validSelector)
}

type GlobToken = { kind: 'literal'; value: string } | { kind: 'one' | 'star' | 'globstar' | 'directory' }

/** Only *, ? and ** are special. All other characters are literal. */
function globTokens(pattern: string): GlobToken[] {
  const chars = [...trim(pattern)]
  const tokens: GlobToken[] = []
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    if (char === '?') tokens.push({ kind: 'one' })
    else if (char !== '*') tokens.push({ kind: 'literal', value: char })
    else if (chars[i + 1] !== '*') tokens.push({ kind: 'star' })
    else {
      const start = i
      while (chars[i + 1] === '*') i++
      // A complete **/ path segment also matches zero directories.
      if (chars[i + 1] === '/' && (start === 0 || chars[start - 1] === '/')) {
        tokens.push({ kind: 'directory' })
        i++
      } else tokens.push({ kind: 'globstar' })
    }
  }
  return tokens
}

/** Dynamic programming bounds work to O(pattern × path), with no regex backtracking. */
function globMatches(pattern: string, text: string): boolean {
  const tokens = globTokens(pattern)
  let previous = new Uint8Array(tokens.length + 1)
  let current = new Uint8Array(tokens.length + 1)
  const directories = new Uint8Array(tokens.length + 1)
  previous[0] = 1
  for (let j = 1; j <= tokens.length; j++) {
    if (['star', 'globstar', 'directory'].includes(tokens[j - 1].kind)) previous[j] = previous[j - 1]
  }
  for (const char of text) {
    current.fill(0)
    for (let j = 1; j <= tokens.length; j++) {
      const token = tokens[j - 1]
      if (token.kind === 'literal') current[j] = Number(previous[j - 1] === 1 && token.value === char)
      else if (token.kind === 'one') current[j] = Number(previous[j - 1] === 1 && char !== '/')
      else if (token.kind === 'directory') {
        directories[j] ||= previous[j - 1]
        current[j] = Number(current[j - 1] === 1 || (char === '/' && directories[j] === 1))
      } else current[j] = Number(current[j - 1] === 1 || (previous[j] === 1 && (token.kind === 'globstar' || char !== '/')))
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[tokens.length] === 1
}

function frontmatterValues(content: string): Map<string, FileViewScalar> | null {
  // Bound metadata parsing independently of the document body size.
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(content.slice(0, MAX_FRONTMATTER))
  if (!header || header.index !== 0) return null
  // Slicing in the middle of a longer closing line must not fabricate a fence.
  const afterFence = content[header[0].length]
  if (afterFence !== undefined && afterFence !== '\n' && afterFence !== '\r') return null
  try {
    const document = parseDocument(header[1])
    if (document.errors.length || !isMap(document.contents)) return null
    const values = new Map<string, FileViewScalar>()
    for (const pair of document.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isScalar(pair.value)) continue
      const value = pair.value.value
      if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) values.set(pair.key.value, value)
    }
    return values
  } catch {
    return null
  }
}

function sameScalar(actual: FileViewScalar | undefined, expected: FileViewScalar): boolean {
  return typeof actual === 'string' && typeof expected === 'string'
    ? trim(actual).toLowerCase() === trim(expected).toLowerCase()
    : actual === expected
}

/** OR across selectors and condition values; AND across fields and metadata keys. */
export function fileViewFor(document: ViewDocument, manifests: PluginManifest[]): FileViewRef | null {
  if (!TEXT_KINDS.has(document.kind) || document.path.length > MAX_PATH * 2 || [...document.path].length > MAX_PATH) return null
  const path = normalize(document.path)
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  let metadata: Map<string, FileViewScalar> | null | undefined
  const candidates = manifests.flatMap((manifest) => {
    const views = manifest.file_views
    if (!Array.isArray(views) || views.length > MAX_ITEMS) return []
    const ids = new Set<string>()
    for (const view of views) {
      if (!record(view) || typeof view.id !== 'string') continue
      if (ids.has(view.id)) return []
      ids.add(view.id)
    }
    return views.filter(isValidFileView).map((view) => ({ manifest, view }))
  }).sort((a, b) => {
    const priority = (b.view.priority ?? 0) - (a.view.priority ?? 0)
    if (priority) return priority
    const first = `${a.manifest.id}\0${a.view.id}`
    const second = `${b.manifest.id}\0${b.view.id}`
    return first < second ? -1 : first > second ? 1 : 0
  })
  for (const { manifest, view } of candidates) {
    const matches = view.selectors.some((selector) => {
      if (selector.file_extensions && !selector.file_extensions.some((candidate) => extension(candidate) === ext)) return false
      if (selector.file_name_patterns && !selector.file_name_patterns.some((pattern) => globMatches(pattern, name))) return false
      if (selector.path_patterns && (!isAbsolute(path) || !selector.path_patterns.some((pattern) => globMatches(pattern, path)))) return false
      if (selector.frontmatter) {
        if (metadata === undefined) metadata = frontmatterValues(document.content)
        if (!metadata || !Object.entries(selector.frontmatter).every(([key, values]) => values.some((value) => sameScalar(metadata!.get(key), value)))) return false
      }
      return true
    })
    if (matches) return { pluginId: manifest.id, viewId: view.id, entry: view.entry }
  }
  return null
}
