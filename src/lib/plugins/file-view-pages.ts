import { ensureIndex, openPageOrCreate } from '../outline/backlinks-io.svelte'
import { outline } from '../outline/store.svelte'
import { sotvaultStore } from '../sotvault.svelte'
import { isUnder } from '../recent-merge'
import { isBlockedWikilink } from '../wikilink/blocklist'
import { whenWikilinkBlocklistReady } from '../wikilink/blocklist-io.svelte'
import { validPageTarget } from './v2/file-view-msg'

/** User-initiated page navigation shares the editor's wiki/date/create rules. */
export async function openFileViewPage(sourcePath: string, target: string, isCurrent: () => boolean): Promise<void> {
  if (!validPageTarget(target)) throw new Error('Invalid page name')
  const vault = sotvaultStore.vaultRoot
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('File view changed')
    if (!vault || sotvaultStore.vaultRoot !== vault || !isUnder(sourcePath, vault)) {
      throw new Error('Open this file inside the current Vault to navigate pages')
    }
  }
  assertCurrent()
  await whenWikilinkBlocklistReady()
  assertCurrent()
  if (isBlockedWikilink(target)) throw new Error('This page is excluded by the wikilink blocklist')
  await ensureIndex(sourcePath)
  assertCurrent()
  if (outline.backlinkIndex?.scope?.root !== vault) throw new Error('The current Vault page index changed')
  await openPageOrCreate(target.trim(), { throwErrors: true })
}
