import { tick } from 'svelte'
import { invoke } from '@tauri-apps/api/core'
import { activeTab, activate } from '../tabs.svelte'
import { sumiOwner } from './session'

/** Only a host-routed, explicit focus request reaches this handler. */
export async function focusSumiOwner(request: { page_id: string; tab_id: string }): Promise<void> {
  const owner = sumiOwner(request.tab_id)
  if (!owner || owner.pageId !== request.page_id) throw Error('已有编辑面已改变，请重新选择此页')
  await activate(request.tab_id)
  await tick()
  // activate deliberately refuses a switch during IME/unsaved handoff failure.
  if (activeTab()?.id !== request.tab_id || sumiOwner(request.tab_id) !== owner) {
    throw Error('请先完成当前输入或保存，再聚焦已有编辑面')
  }
  // The real caller window and the current page/tab owner are rechecked by Rust
  // after the asynchronous tab transition. No target window/surface is supplied.
  await invoke('sumi_focus_owner', { page_id: owner.pageId, tab_id: owner.tabId, plugin_id: owner.pluginId })
  if (activeTab()?.id !== owner.tabId || sumiOwner(owner.tabId) !== owner) return
  if (!owner.surface) window.dispatchEvent(new CustomEvent('notemd:focus-editor', {
    detail: { path: owner.path, preserveSelection: true },
  }))
}
