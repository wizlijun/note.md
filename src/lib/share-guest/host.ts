import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'
import { parseGuestLink } from './link'

export function guestCommand<T>(op: string, input: Record<string, unknown>): Promise<T> {
  if (op === 'open' && Object.keys(input).some(key => !['origin', 'slug', 'shareUrl'].includes(key))) {
    return Promise.reject(new Error('无效的分享下载参数'))
  }
  return invoke<T>('share_guest', { request: { ...input, op } })
}
/** Credentials belong to app-data, never to the native download request or Vault. */
export async function saveGuestToken(origin: string, projectId: string, token: string): Promise<void> {
  const parsed = parseGuestLink(`${origin}/2000-01-01-guest`, import.meta.env.DEV)
  if (parsed.origin !== origin || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error('无效的分享身份')
  const store = await Store.load('share_db.json')
  await store.set(`guest:${origin}:${projectId}`, { token })
  await store.save()
}
