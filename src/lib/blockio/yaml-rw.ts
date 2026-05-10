import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { BlockYaml } from './yaml-schema'
import { SCHEMA_VERSION } from './yaml-schema'

/**
 * Serialize a BlockYaml to a string. We force `text` fields to use block
 * scalar form (literal `|`) so multi-line content stays human-readable.
 */
export function serializeBlockYaml(y: BlockYaml): string {
  return stringifyYaml(y, {
    lineWidth: 0,           // never fold long lines
    blockQuote: 'literal',  // prefer | for multi-line strings
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
  })
}

/**
 * Parse a yaml string into BlockYaml. Throws on malformed yaml or
 * incompatible schema_version.
 */
export function parseBlockYaml(text: string): BlockYaml {
  const obj = parseYaml(text)
  if (!obj || typeof obj !== 'object') throw new Error('blockyaml: not an object')
  const meta = (obj as { meta?: { schema_version?: unknown } }).meta
  if (!meta || meta.schema_version !== SCHEMA_VERSION) {
    throw new Error(`blockyaml: schema_version mismatch (expected ${SCHEMA_VERSION})`)
  }
  return obj as BlockYaml
}

/**
 * Atomic write to disk via Tauri fs: write `path.tmp`, then rename. The
 * existing target is removed first so rename succeeds on Windows.
 */
export async function writeBlockYamlAtomic(path: string, y: BlockYaml): Promise<void> {
  const { writeTextFile, rename, remove, exists } = await import('@tauri-apps/plugin-fs')
  const tmp = `${path}.tmp`
  const content = serializeBlockYaml(y)
  await writeTextFile(tmp, content)
  if (await exists(path)) await remove(path)
  await rename(tmp, path)
}

/**
 * Read a block.yaml. On parse error, rename to `<path>.broken-<ts>` and
 * return null so the caller can rebuild fresh.
 */
export async function readBlockYaml(path: string): Promise<BlockYaml | null> {
  const { readTextFile, rename, exists } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path))) return null
  const text = await readTextFile(path)
  try {
    return parseBlockYaml(text)
  } catch (err) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${path}.broken-${ts}`
    try { await rename(path, backup) } catch { /* best effort */ }
    console.warn(`[mdblock] yaml parse failed, backed up to ${backup}: ${err}`)
    return null
  }
}
