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

const ALLOWED = new Set(['md', 'markdown', 'mdown', 'mkd'])

export function isMarkdownPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return ALLOWED.has(ext)
}
