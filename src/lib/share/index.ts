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

const PLUGIN_NAME = 'Share'

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

function reportError(e: unknown, action: string) {
  if (e instanceof ShareError) {
    const messages: Record<string, string> = {
      not_configured: '请先在 Preferences → Share 配置 Service URL 和 API Key',
      no_path: '请先保存文件',
      empty_content: '内容为空',
      network: '网络错误，请检查网络',
      auth: 'API key 无效，请检查 Preferences',
      forbidden: '无权撤销该分享',
      too_large: '文档过大（上限 25 MB）',
      conflict: 'slug 冲突，请稍后重试',
      unsupported: '不支持的图片格式',
      server: '服务器繁忙，请稍后重试',
      http: '请求失败',
      parse: '服务器响应解析失败',
      corrupt_record: '本地分享记录损坏',
    }
    pushToast({
      level: 'error',
      message: `❌ ${PLUGIN_NAME}: ${messages[e.kind] ?? e.kind}`,
      detail: e.detail,
    })
  } else {
    pushToast({ level: 'error', message: `❌ ${PLUGIN_NAME}: ${action}失败`, detail: String(e) })
  }
}

export async function sharePublishCurrent(): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  const cfg = getShareConfig()
  if (!cfg) return reportError(new ShareError('not_configured'), '分享')
  if (!tab.filePath) return reportError(new ShareError('no_path'), '分享')

  try {
    if (tab.kind === 'image') {
      const { url, isUpdate } = await uploadImage({
        path: tab.filePath, filename: tab.title,
        baseUrl: cfg.baseUrl, defaultExpiry: cfg.defaultExpiry,
      })
      pushToast({
        level: 'success',
        message: isUpdate ? '✅ 图片已更新（已复制）' : '✅ 图片分享成功（已复制）',
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
    if (!html) return reportError(new ShareError('empty_content'), '分享')
    if (new TextEncoder().encode(html).byteLength > 25 * 1024 * 1024)
      return reportError(new ShareError('too_large'), '分享')

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
      message: isUpdate ? '✅ 内容已更新（链接已复制）' : '✅ 分享成功（已复制）',
      detail: url,
    })
    if (await isIOS()) {
      try { await invoke('present_share_sheet', { url, text: tab.title }) }
      catch { /* present_share_sheet not implemented yet — Swift bridge deferred to post-v1 */ }
    }
  } catch (e) {
    reportError(e, '分享')
  }
}

export async function shareUnpublishCurrent(): Promise<void> {
  const tab = activeTab()
  const cfg = getShareConfig()
  if (!cfg || !tab?.filePath) return
  try {
    await unpublish({ path: tab.filePath, baseUrl: cfg.baseUrl })
    pushToast({ level: 'success', message: '✅ 已撤销分享' })
  } catch (e) { reportError(e, '撤销分享') }
}

export async function shareCopyLinkCurrent(): Promise<void> {
  const tab = activeTab()
  if (!tab?.filePath) return
  try {
    const url = await copyShareLink(tab.filePath)
    pushToast({ level: 'success', message: '✅ 链接已复制', detail: url })
  } catch (e) { reportError(e, '复制链接') }
}
