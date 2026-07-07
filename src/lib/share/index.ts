import { invoke } from '@tauri-apps/api/core'
import { activeTab } from '../tabs.svelte'
import { getPluginScopedKey } from '../settings.svelte'
import { pushToast } from '../toast.svelte'
import { isIOS } from '../platform.svelte'
import { bakeShareHtml } from '../plugins/share-baker'
import { publishHtml } from './publish'
import { unpublish } from './unpublish'
import { copyShareLink } from './copy-link'
import { uploadImage } from './upload-image'
import { ShareError } from './types'
import { t } from '../i18n/store.svelte'
import type { Messages } from '../i18n/en'

function getShareConfig(): { baseUrl: string; defaultExpiry: 'never'|'7d'|'30d'|'90d'; slugRandomSuffix: boolean } | null {
  const baseUrl = getPluginScopedKey('share.baseUrl') as string | undefined
  const apiKey = getPluginScopedKey('share.apiKey') as string | undefined
  if (!baseUrl || !apiKey) return null
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    defaultExpiry: (getPluginScopedKey('share.defaultExpiry') as any) ?? 'never',
    slugRandomSuffix: (getPluginScopedKey('share.slugRandomSuffix') as boolean | undefined) ?? true,
  }
}

const SHARE_ERROR_KEYS: Record<string, keyof Messages> = {
  not_configured: 'share.err.not_configured',
  no_path: 'share.err.no_path',
  empty_content: 'share.err.empty_content',
  network: 'share.err.network',
  auth: 'share.err.auth',
  forbidden: 'share.err.forbidden',
  too_large: 'share.err.too_large',
  conflict: 'share.err.conflict',
  unsupported: 'share.err.unsupported',
  server: 'share.err.server',
  http: 'share.err.http',
  parse: 'share.err.parse',
  corrupt_record: 'share.err.corrupt_record',
}

function reportError(e: unknown, action: string) {
  if (e instanceof ShareError) {
    const key = SHARE_ERROR_KEYS[e.kind]
    pushToast({
      level: 'error',
      message: t('share.errPrefix', { msg: key ? t(key) : e.kind }),
      detail: e.detail,
    })
  } else {
    pushToast({ level: 'error', message: t('share.actionFailed', { action }), detail: String(e) })
  }
}

export async function sharePublishCurrent(): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  const cfg = getShareConfig()
  if (!cfg) return reportError(new ShareError('not_configured'), t('share.action.share'))
  if (!tab.filePath) return reportError(new ShareError('no_path'), t('share.action.share'))

  try {
    if (tab.kind === 'image') {
      const { url, isUpdate } = await uploadImage({
        path: tab.filePath, filename: tab.title,
        baseUrl: cfg.baseUrl, defaultExpiry: cfg.defaultExpiry,
      })
      pushToast({
        level: 'success',
        message: isUpdate ? t('share.imageUpdated') : t('share.imageShared'),
        detail: url,
      })
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
      await writeText(url)
      if (await isIOS()) {
        try { await invoke('present_share_sheet', { url, text: tab.title }) }
        catch { /* present_share_sheet not implemented yet — Swift bridge deferred to post-v1 */ }
      }
      return
    }

    const html = await bakeShareHtml(tab)
    if (!html) return reportError(new ShareError('empty_content'), t('share.action.share'))
    if (new TextEncoder().encode(html).byteLength > 25 * 1024 * 1024)
      return reportError(new ShareError('too_large'), t('share.action.share'))

    const { url, isUpdate } = await publishHtml({
      path: tab.filePath, filename: tab.title, html,
      baseUrl: cfg.baseUrl,
      defaultExpiry: cfg.defaultExpiry,
      slugRandomSuffix: cfg.slugRandomSuffix,
    })
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(url)
    pushToast({
      level: 'success',
      message: isUpdate ? t('share.contentUpdated') : t('share.shared'),
      detail: url,
    })
    if (await isIOS()) {
      try { await invoke('present_share_sheet', { url, text: tab.title }) }
      catch { /* present_share_sheet not implemented yet — Swift bridge deferred to post-v1 */ }
    }
  } catch (e) {
    reportError(e, t('share.action.share'))
  }
}

export async function shareUnpublishCurrent(): Promise<void> {
  const tab = activeTab()
  const cfg = getShareConfig()
  if (!cfg || !tab?.filePath) return
  try {
    await unpublish({ path: tab.filePath, baseUrl: cfg.baseUrl })
    pushToast({ level: 'success', message: t('share.unpublished') })
  } catch (e) { reportError(e, t('share.action.unpublish')) }
}

export async function shareCopyLinkCurrent(): Promise<void> {
  const tab = activeTab()
  if (!tab?.filePath) return
  try {
    const url = await copyShareLink(tab.filePath)
    pushToast({ level: 'success', message: t('share.linkCopied'), detail: url })
  } catch (e) { reportError(e, t('share.action.copyLink')) }
}
