import { guestCommand, retryGuestOutbox, canSubmitGuest } from './host'
import { parseGuestLink } from './link'
import type { GuestInfo, GuestLink } from './types'
import type { Tab } from '../tabs.svelte'
import { relative } from '../paths'

export const guestState = $state({ projects: [] as GuestInfo[], links: [] as GuestLink[], ready: false,
  menuOpen: false, error: '', statuses: {} as Record<string, string> })
const pendingKeys = new Set<string>()
const initialKeys = new Set<string>()
let bootstrapping = true
let epoch = 0
const key = (link: GuestLink) => link.shareUrl + '#' + (link.token ?? '')
export function receiveGuestUrl(url: string): boolean {
  if (!/^notemd:/i.test(url)) return false
  try {
    const link = parseGuestLink(url, import.meta.env.DEV), identity = key(link)
    if (pendingKeys.has(identity) || bootstrapping && initialKeys.has(identity)) return true
    pendingKeys.add(identity)
    if (bootstrapping) initialKeys.add(identity)
    guestState.links.push(link)
  } catch { guestState.error = 'GUEST_INVALID_LINK' }
  return true
}
export function finishGuestBootstrap(): void { bootstrapping = false; initialKeys.clear() }
export function closeGuestLink(): void {
  const link = guestState.links.shift()
  if (link) pendingKeys.delete(key(link))
  guestState.menuOpen = false
}
export function guestForTab(tab: Tab | null): GuestInfo | undefined {
  return tab?.filePath ? guestState.projects.find(info => relative(info.root, tab.filePath!) !== null) : undefined
}
export function rememberGuest(info: GuestInfo): void {
  guestState.projects = [...guestState.projects.filter(p => p.root !== info.root), info]
}
export async function refreshGuests(vault: string | null): Promise<void> {
  const current = ++epoch
  guestState.ready = false; guestState.projects = []; guestState.statuses = {}
  if (!vault) return
  try {
    const projects = await guestCommand<GuestInfo[]>('list', {})
    if (epoch !== current) return
    guestState.projects = projects; guestState.ready = true
    await retryGuests()
  } catch { if (epoch === current) guestState.error = 'GUEST_LOAD_FAILED' }
}
export async function retryGuests(): Promise<void> {
  const current = epoch
  for (const info of guestState.projects) {
    if (!info.outbox.length) continue
    try {
      if (!await canSubmitGuest(info)) continue
      const next = await retryGuestOutbox(info.root)
      if (epoch === current) { rememberGuest(next); guestState.statuses[info.root] = '' }
    } catch (error) {
      if (epoch === current) guestState.statuses[info.root] = guestErrorCode(error)
    }
  }
}
export function guestErrorCode(error: unknown): string {
  if (/composing|annotation-pending|file-input-pending/.test(String(error))) return 'GUEST_INPUT_PENDING'
  const code = String(error).match(/GUEST_(?:HTTP_\d{3}|READ_ONLY|PENDING_CONFLICT|NETWORK|BASE_CHANGED|TAB_CHANGED|INPUT_CHANGED|INPUT_PENDING|WORK_CHANGED|UNRESOLVED|UPDATE_BUSY|UPDATE_PENDING|EDITOR_NOT_READY)/)?.[0]
  return code ?? 'GUEST_FAILED'
}
