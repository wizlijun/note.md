import { settings } from '../settings.svelte'
import { readBlockYaml } from '../blockio/yaml-rw'
import { persistLiveYamlOrCompute } from './commands'
import { cachedYamlPath } from './path'

/**
 * Called from the tab save flow after a successful md write. When mdblock
 * is enabled AND the document already has a yaml in the cache, persist the
 * current in-memory liveYaml (or recompute on the fly) to disk in a single
 * step — saving the md auto-saves its block.yaml too.
 *
 * Skips if:
 *   - mdblock disabled
 *   - file is not a .md
 *   - no yaml exists yet for this doc (user hasn't opted in via
 *     Compute Blocks). This protects users who don't want a yaml created
 *     for every transient document they save.
 */
export async function maybeAutoRefresh(mdPath: string): Promise<void> {
  if (!mdPath.endsWith('.md')) return
  if (!settings.mdblock?.enabled) return
  const existing = await readBlockYaml(await cachedYamlPath(mdPath))
  if (!existing) return
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  try {
    const source = await readTextFile(mdPath)
    await persistLiveYamlOrCompute(mdPath, source)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[mdblock] save-time persist failed:', e)
  }
}
