import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

export async function readMd(path: string): Promise<string> {
  return readTextFile(path)
}

export async function writeMd(path: string, content: string): Promise<void> {
  return writeTextFile(path, content)
}

export function basename(path: string): string {
  const seg = path.split('/').filter(Boolean)
  return seg[seg.length - 1] ?? path
}

export type FileKind = 'markdown' | 'html' | 'code'

export interface FileClass {
  kind: FileKind
  language?: string
}

const EXT_TABLE: Record<string, FileClass> = {
  md:        { kind: 'markdown' },
  markdown:  { kind: 'markdown' },
  mdown:     { kind: 'markdown' },
  mkd:       { kind: 'markdown' },

  html:      { kind: 'html' },
  htm:       { kind: 'html' },

  txt:       { kind: 'code', language: '' },
  log:       { kind: 'code', language: '' },
  csv:       { kind: 'code', language: '' },
  tsv:       { kind: 'code', language: '' },
  env:       { kind: 'code', language: '' },

  json:      { kind: 'code', language: 'json' },
  jsonc:     { kind: 'code', language: 'json' },
  yaml:      { kind: 'code', language: 'yaml' },
  yml:       { kind: 'code', language: 'yaml' },
  toml:      { kind: 'code', language: 'ini' },     // hljs has no toml; ini is closest available
  ini:       { kind: 'code', language: 'ini' },
  conf:      { kind: 'code', language: 'ini' },
  xml:       { kind: 'code', language: 'xml' },

  sh:        { kind: 'code', language: 'bash' },
  bash:      { kind: 'code', language: 'bash' },
  zsh:       { kind: 'code', language: 'bash' },

  py:        { kind: 'code', language: 'python' },
  js:        { kind: 'code', language: 'javascript' },
  mjs:       { kind: 'code', language: 'javascript' },
  cjs:       { kind: 'code', language: 'javascript' },
  ts:        { kind: 'code', language: 'typescript' },
  tsx:       { kind: 'code', language: 'typescript' },
  jsx:       { kind: 'code', language: 'javascript' },
  rs:        { kind: 'code', language: 'rust' },
  go:        { kind: 'code', language: 'go' },
  java:      { kind: 'code', language: 'java' },
  c:         { kind: 'code', language: 'c' },
  cpp:       { kind: 'code', language: 'cpp' },
  cc:        { kind: 'code', language: 'cpp' },
  h:         { kind: 'code', language: 'c' },
  hpp:       { kind: 'code', language: 'cpp' },
  rb:        { kind: 'code', language: 'ruby' },
  swift:     { kind: 'code', language: 'swift' },
  kt:        { kind: 'code', language: 'kotlin' },
  php:       { kind: 'code', language: 'php' },
  cs:        { kind: 'code', language: 'csharp' },

  css:       { kind: 'code', language: 'css' },
  scss:      { kind: 'code', language: 'scss' },

  sql:       { kind: 'code', language: 'sql' },
}

const NAME_TABLE: Record<string, FileClass> = {
  dockerfile: { kind: 'code', language: 'dockerfile' },
  makefile:   { kind: 'code', language: 'makefile' },
  rakefile:   { kind: 'code', language: 'ruby' },
  gemfile:    { kind: 'code', language: 'ruby' },
}

export function classifyPath(path: string): FileClass | null {
  const base = basename(path).toLowerCase()
  if (NAME_TABLE[base]) return { ...NAME_TABLE[base] }
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  if (ext && EXT_TABLE[ext]) return { ...EXT_TABLE[ext] }
  return null
}

export function isSupportedPath(path: string): boolean {
  return classifyPath(path) !== null
}

/**
 * Heuristic: does the content look like a binary file?
 * Returns true if the first 8KB contains a NUL byte, or
 * more than 5% of bytes are control characters outside whitespace.
 *
 * Limitation: UTF-16 / UTF-32 with BOM will look binary because of NUL bytes.
 * Acceptable for v1.
 */
export function looksBinary(s: string): boolean {
  const sample = s.slice(0, 8192)
  if (sample.indexOf('\x00') >= 0) return true
  if (sample.length === 0) return false
  let nonText = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    // Allow TAB(9), LF(10), VT(11), FF(12), CR(13); reject other control chars
    if (c < 9 || (c > 13 && c < 32)) nonText++
  }
  return nonText / sample.length > 0.05
}
