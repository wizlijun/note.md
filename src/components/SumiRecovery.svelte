<script lang="ts">
  import { i18n } from '../lib/i18n/runtime.svelte'
  import { createI18n } from '../lib/sumi/i18n'
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { openFile } from '../lib/tabs.svelte'
  import { detachSumiSurface, sumiOwner } from '../lib/sumi/session'
  import { probeRecovery, recoverNewPage, type RecoveryProbe } from '../lib/sumi/recovery'
  let text = $derived(createI18n(i18n.locale))
  let { path, pluginId, tabId, pageId, onrestored }: {
    path: string; pluginId: string; tabId: string; pageId?: string; onrestored: () => Promise<void>
  } = $props()
  let probe = $state<RecoveryProbe>()
  let busy = $state(false)
  type Message = { kind: 'error'; detail: string } | { kind: 'new' } | { kind: 'rewritten'; path: string }
  let message = $state<Message>()
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
    busy = true; message = undefined; probe = undefined
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
    } catch (error) { if (alive && current === generation) message = { kind: 'error', detail: String(error) } }
    finally { if (alive && current === generation) busy = false }
  }
  async function restore(asNew: boolean) {
    if (busy) return
    const current = generation
    const repairPage = pageId ?? probe?.source_page_id
    const repairTab = tabId
    busy = true; message = undefined
    try {
      if (asNew && probe) {
        const recovered = await recoverNewPage(probe, requestId, normalize, pluginId)
        if (!alive || current !== generation) return
        if (recovered.path) await openFile(recovered.path)
        else await invoke('plugin_v2_open_window', { pluginId, windowId: 'main', seed: { kind: 'sumi-navigation', pageId: recovered.page_id, action: 'open_page' } })
        message = { kind: 'new' }
      } else {
        const owner = sumiOwner(repairTab)
        if (owner) await detachSumiSurface(owner)
        if (!alive || current !== generation) return
        const result = await invoke<{ recovery_path: string }>('sumi_restore_projection', {
          plugin_id: pluginId, page_id: repairPage, tab_id: repairTab,
        })
        if (!alive || current !== generation) return
        message = { kind: 'rewritten', path: result.recovery_path }
        await onrestored()
      }
    } catch (error) { if (alive && current === generation) message = { kind: 'error', detail: String(error) } }
    finally { if (alive && current === generation) busy = false }
  }
</script>

  <div class="sumi-recovery">
    <button disabled={busy} onclick={() => checkSource(path, pluginId)}>{text.t("重新检查源文件", "Recheck source files", "元のファイルを再確認")}</button>
    {#if probe}
      <p>{probe.preserve_line_times ? text.t("可将正文和已验证的逐行时间恢复为新的一页，原文件保持不变。", "Restore the text and verified line timestamps as a new page. The original files remain unchanged.", "本文と検証済みの行ごとの時刻を新しいページに復元できます。元のファイルは変更されません。") : text.t("可将正文恢复为新的一页，原文件保持不变；无法验证的历史时间将标为未知。", "Restore the text as a new page without changing the original files. Unverifiable historical timestamps will be marked unknown.", "元のファイルを変更せずに、本文を新しいページに復元できます。検証できない過去の時刻は不明として扱います。")}</p>
      {#each probe.warnings as warning}<p>{text.hostMessage(warning, 'status')}</p>{/each}
      {#if probe.normalize_crlf}<label><input type="checkbox" bind:checked={normalize} />{text.t("统一换行符后恢复，原文件保持不变", "Normalize line endings when restoring; keep the original files unchanged", "改行を統一して復元する（元のファイルは変更しない）")}</label>{/if}
      <button disabled={busy || probe.normalize_crlf && !normalize} onclick={() => restore(true)}>{text.t("恢复为新的一页", "Restore as a new page", "新しいページとして復元")}</button>
    {/if}
    {#if pageId || probe?.known_page}
      <p>{text.t("也可保留磁盘上的原文件，再用本机已保存的正文和逐行时间重新写出此页。", "Alternatively, preserve the original files on disk and rewrite this page using the text and line timestamps saved on this device.", "ディスク上の元のファイルを残したまま、この端末に保存済みの本文と行ごとの時刻からこのページを書き直すこともできます。")}</p>
      <button disabled={busy} onclick={() => restore(false)}>{text.t("保留原文件并重新写出此页", "Preserve originals and rewrite this page", "元のファイルを残してこのページを書き直す")}</button>
    {/if}
    {#if message}<p role="status">
      {#if message.kind === 'error'}{text.hostMessage(message.detail)}
      {:else if message.kind === 'new'}{text.t('已恢复为新的一页，原文件保持不变。', 'Restored as a new page. The original files remain unchanged.', '新しいページとして復元しました。元のファイルは変更されていません。')}
      {:else}{text.t('已重新保存此页；原文件保留在 ', 'This page has been saved again; the original files are preserved at ', 'このページを保存し直しました。元のファイルの保存先：')}{message.path}{/if}
    </p>{/if}
  </div>

<style>
  .sumi-recovery { max-width: 36rem; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; font-size: 13px; }
  p { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
  button { color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 5px; padding: 6px 10px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  label { display: flex; align-items: center; gap: 6px; }
</style>
