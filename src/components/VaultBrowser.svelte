<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { vaultStore, syncNow } from '../lib/vault.svelte'
  import { fileIcon, type VaultListEntry } from '../lib/vault-list'
  import { openFile } from '../lib/tabs.svelte'

  let { onCloseDrawer = () => {} }: { onCloseDrawer?: () => void } = $props()

  let breadcrumb = $state<string[]>([])
  let entries = $state<VaultListEntry[]>([])
  let loadError = $state<string | null>(null)

  $effect(() => {
    if (vaultStore.configured) {
      void refresh()
    } else {
      entries = []
    }
  })

  $effect(() => {
    // Refresh when sync completes or breadcrumb changes
    void vaultStore.lastSync
    void breadcrumb
    if (vaultStore.configured) void refresh()
  })

  async function refresh() {
    try {
      const relPath = breadcrumb.join('/')
      entries = await invoke<VaultListEntry[]>('vault_list_dir', { relPath })
      loadError = null
    } catch (e) {
      loadError = String(e)
    }
  }

  function joinRel(name: string): string {
    return [...breadcrumb, name].join('/')
  }

  async function onClickEntry(e: VaultListEntry) {
    if (e.kind === 'dir') {
      breadcrumb = [...breadcrumb, e.name]
    } else {
      const { documentDir } = await import('@tauri-apps/api/path')
      const docs = await documentDir()
      const abs = `${docs.replace(/\/$/, '')}/Vault/${joinRel(e.name)}`
      onCloseDrawer()
      try { await openFile(abs) } catch {}
    }
  }

  function up() {
    if (breadcrumb.length > 0) breadcrumb = breadcrumb.slice(0, -1)
  }
</script>

<div class="vault-browser">
  <div class="header">
    <span class="section-label">Vault</span>
    <button class="sync-btn" onclick={() => syncNow()} aria-label="Sync now"
      class:spinning={vaultStore.state === 'syncing' || vaultStore.state === 'cloning'}>
      ↻
    </button>
  </div>

  {#if !vaultStore.configured}
    <p class="empty">未配置 Vault。<br />请去 Settings → Vault 配置仓库。</p>
  {:else}
    {#if breadcrumb.length > 0}
      <div class="breadcrumb">
        <button class="up" onclick={up}>‹ 上级</button>
        <span class="path">Vault › {breadcrumb.join(' › ')}</span>
      </div>
    {/if}

    {#if loadError}
      <p class="error">❌ {loadError}</p>
    {:else if entries.length === 0}
      <p class="empty">Vault 为空</p>
    {:else}
      <ul>
        {#each entries as e (e.name)}
          <li>
            <button class="entry" onclick={() => onClickEntry(e)}>
              <span class="icon">{e.kind === 'dir' ? '📁' : fileIcon(e.ext ?? '')}</span>
              <span class="name">{e.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .vault-browser { display: flex; flex-direction: column; }
  .header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 4px; }
  .section-label { font-size: 12px; opacity: 0.5; text-transform: uppercase; }
  .sync-btn {
    background: transparent; border: 0; padding: 4px 8px; cursor: pointer;
    font-size: 16px; opacity: 0.7;
  }
  .sync-btn:hover { opacity: 1; }
  .sync-btn.spinning { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .breadcrumb { display: flex; align-items: center; gap: 6px; padding: 4px 16px; font-size: 12px; }
  .up { background: transparent; border: 0; padding: 2px 6px; cursor: pointer; color: var(--accent, #3584e4); }
  .path { opacity: 0.6; overflow: hidden; text-overflow: ellipsis; }
  ul { list-style: none; padding: 0; margin: 0; }
  .entry {
    display: flex; align-items: center; gap: 8px; width: 100%;
    text-align: left; padding: 8px 16px; background: transparent;
    border: 0; cursor: pointer; font: inherit;
    border-top: 1px solid rgba(0,0,0,0.04);
  }
  .entry:hover { background: rgba(0,0,0,0.04); }
  .icon { width: 22px; text-align: center; }
  .empty { padding: 12px 16px; opacity: 0.5; font-size: 13px; }
  .error { padding: 8px 16px; color: var(--danger, #e01b24); font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    .entry:hover { background: rgba(255,255,255,0.05); }
    .entry { border-top-color: rgba(255,255,255,0.06); }
  }
</style>
