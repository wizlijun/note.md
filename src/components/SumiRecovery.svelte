<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { openFile } from '../lib/tabs.svelte'
  import { detachSumiSurface, sumiOwner } from '../lib/sumi/session'
  import { probeRecovery, recoverNewPage, type RecoveryProbe } from '../lib/sumi/recovery'
  let { path, pluginId, tabId, pageId, onrestored }: {
    path: string; pluginId: string; tabId: string; pageId?: string; onrestored: () => Promise<void>
  } = $props()
  let probe = $state<RecoveryProbe>()
  let busy = $state(false)
  let message = $state('')
  let normalize = $state(false)
  const requestIds = new Map<string, string>()
  let evidenceKey = ''
  let requestId = ''
  let generation = 0
  let alive = true
  onMount(() => () => { alive = false; generation++ })
  $effect(() => {
    void checkSource(path, pluginId)
  })
  async function checkSource(sourcePath: string, sourcePlugin: string) {
    const current = ++generation
    busy = true; message = ''; probe = undefined
    try {
      const value = await probeRecovery(sourcePath, sourcePlugin)
      if (!alive || current !== generation) return
      const e = value.evidence
      const key = JSON.stringify([e.vault, e.path, e.markdown_sha256, e.metadata_path, e.metadata_sha256])
      if (key !== evidenceKey) normalize = false
      evidenceKey = key
      // A lost response may already have created the new page. Rechecking the
      // same bytes must retry the same durable operation, not create a duplicate.
      requestId = requestIds.get(key) ?? crypto.randomUUID()
      requestIds.set(key, requestId)
      probe = value
    } catch (error) { if (alive && current === generation) message = String(error) }
    finally { if (alive && current === generation) busy = false }
  }
  async function restore(asNew: boolean) {
    if (busy) return
    const current = generation
    const repairPage = pageId ?? probe?.source_page_id
    const repairTab = tabId
    busy = true; message = ''
    try {
      if (asNew && probe) {
        const recovered = await recoverNewPage(probe, requestId, normalize, pluginId)
        if (!alive || current !== generation) return
        if (recovered.path) await openFile(recovered.path)
        else await invoke('plugin_v2_open_window', { pluginId, windowId: 'main' })
        message = '已恢复为新的一页，原文件保持不变。'
      } else {
        const owner = sumiOwner(repairTab)
        if (owner) await detachSumiSurface(owner)
        if (!alive || current !== generation) return
        const result = await invoke<{ recovery_path: string }>('sumi_restore_projection', {
          plugin_id: pluginId, page_id: repairPage, tab_id: repairTab,
        })
        if (!alive || current !== generation) return
        message = `已重新保存此页；原文件保留在 ${result.recovery_path}`
        await onrestored()
      }
    } catch (error) { if (alive && current === generation) message = String(error) }
    finally { if (alive && current === generation) busy = false }
  }
</script>

  <div class="sumi-recovery">
    <button disabled={busy} onclick={() => checkSource(path, pluginId)}>重新检查源文件</button>
    {#if probe}
      <p>{probe.preserve_line_times ? '可将正文和已验证的逐行时间恢复为新的一页，原文件保持不变。' : '可将正文恢复为新的一页，原文件保持不变；无法验证的历史时间将标为未知。'}</p>
      {#each probe.warnings as warning}<p>{warning}</p>{/each}
      {#if probe.normalize_crlf}<label><input type="checkbox" bind:checked={normalize} />统一换行符后恢复，原文件保持不变</label>{/if}
      <button disabled={busy || probe.normalize_crlf && !normalize} onclick={() => restore(true)}>恢复为新的一页</button>
    {/if}
    {#if pageId || probe?.known_page}
      <p>也可保留磁盘上的原文件，再用本机已保存的正文和逐行时间重新写出此页。</p>
      <button disabled={busy} onclick={() => restore(false)}>保留原文件并重新写出此页</button>
    {/if}
    {#if message}<p role="status">{message}</p>{/if}
  </div>

<style>
  .sumi-recovery { max-width: 36rem; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; font-size: 13px; }
  p { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
  button { color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 5px; padding: 6px 10px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  label { display: flex; align-items: center; gap: 6px; }
</style>
