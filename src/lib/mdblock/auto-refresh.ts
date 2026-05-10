import { settings } from '../settings.svelte'
import { readBlockYaml } from '../blockio/yaml-rw'
import { cmdMdblockRefresh } from './commands'
import { cachedYamlPath } from './path'

/**
 * Called from the tab save flow after a successful write. No-op unless:
 *   - mdblock is enabled
 *   - autoRefreshOnSave is on
 *   - the document already has a yaml in the cache (opt-in via Compute Blocks)
 */
export async function maybeAutoRefresh(mdPath: string): Promise<void> {
  if (!mdPath.endsWith('.md')) return
  if (!settings.mdblock?.enabled) return
  if (!settings.mdblock?.autoRefreshOnSave) return
  const existing = await readBlockYaml(await cachedYamlPath(mdPath))
  if (!existing) return
  await cmdMdblockRefresh()
}
