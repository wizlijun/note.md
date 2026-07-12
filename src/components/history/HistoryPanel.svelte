<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import type { Tab } from '../../lib/tabs.svelte'
  import { openTextTab, setContent } from '../../lib/tabs.svelte'
  import { basename } from '../../lib/fs'
  import { t } from '../../lib/i18n/store.svelte'
  import { pushToast } from '../../lib/toast.svelte'
  import { sotvaultStore } from '../../lib/sotvault.svelte'
  import {
    historyGate, setHistoryWidth, setHistoryWidthLive, setHistoryVisible, historyAppliesTo, relTime,
  } from '../../lib/git-history/gate.svelte'
  import type { GitCommit } from '../../lib/git-history/types'

  let { tab }: { tab: Tab | null } = $props()

  let commits = $state<GitCommit[]>([])
  let selected = $state<string | null>(null)
  type LoadState = 'loading' | 'ready' | 'not-applicable' | 'git-unavailable' | 'error'
  let loadState = $state<LoadState>('loading')

  let vaultRoot = $derived(sotvaultStore.vaultRoot)
  let applicable = $derived(historyAppliesTo(tab, vaultRoot))

  let loadSeq = 0
  async function load() {
    const seq = ++loadSeq
    selected = null
    if (!tab || !applicable || !vaultRoot) {
      commits = []
      loadState = 'not-applicable'
      return
    }
    loadState = 'loading'
    try {
      const result = await invoke<GitCommit[]>('git_file_log', { repo: vaultRoot, absPath: tab.filePath })
      if (seq !== loadSeq) return // superseded by a newer load
      commits = result
      loadState = 'ready'
    } catch (e) {
      if (seq !== loadSeq) return // superseded by a newer load
      commits = []
      loadState = String(e).includes('git-unavailable') ? 'git-unavailable' : 'error'
      if (loadState === 'error') console.warn('[git-history] log:', e)
    }
  }

  // Reload whenever the active file changes (or applicability flips).
  $effect(() => {
    void tab?.id; void tab?.filePath; void applicable
    void load()
  })

  async function onDiff(c: GitCommit) {
    if (!tab || !vaultRoot) return
    try {
      const diff = await invoke<string>('git_file_show', { repo: vaultRoot, rev: c.hash, absPath: tab.filePath })
      const title = t('history.diffTitle', { short: c.short, name: basename(tab.filePath) })
      openTextTab({ title, content: diff, kind: 'code', language: 'diff' })
    } catch (e) {
      pushToast({ level: 'error', message: t('history.loadFailed'), detail: String(e) })
    }
  }

  async function onCompareCurrent(c: GitCommit) {
    if (!tab || !vaultRoot) return
    try {
      const diff = await invoke<string>('git_diff_current', {
        repo: vaultRoot, rev: c.hash, absPath: tab.filePath, current: tab.currentContent,
      })
      if (!diff.trim()) {
        pushToast({ level: 'info', message: t('history.noDiff') })
        return
      }
      const title = t('history.diffCurrentTitle', { short: c.short, name: basename(tab.filePath) })
      openTextTab({ title, content: diff, kind: 'code', language: 'diff' })
    } catch (e) {
      pushToast({ level: 'error', message: t('history.loadFailed'), detail: String(e) })
    }
  }

  async function onRestore(c: GitCommit) {
    if (!tab || !vaultRoot) return
    try {
      const content = await invoke<string>('git_file_at', { repo: vaultRoot, rev: c.hash, absPath: tab.filePath })
      setContent(tab.id, content)
      pushToast({ level: 'success', message: t('history.restored') })
    } catch (e) {
      pushToast({ level: 'error', message: t('history.loadFailed'), detail: String(e) })
    }
  }

  let startX = 0
  let startW = 0
  function onSplitterDown(e: PointerEvent) {
    startX = e.clientX; startW = historyGate.width
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onSplitterMove(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    setHistoryWidthLive(startW + (startX - e.clientX))
  }
  function onSplitterUp(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    void setHistoryWidth(historyGate.width)
  }
</script>

<aside class="history-panel" style="width: {historyGate.width}px">
  <div class="splitter" onpointerdown={onSplitterDown} onpointermove={onSplitterMove} onpointerup={onSplitterUp}></div>
  <header>
    <button class="hbtn" title={t('history.hide')} aria-label={t('history.hide')} onclick={() => void setHistoryVisible(false)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="15" y1="3" x2="15" y2="21" />
        <polyline points="8 9 11 12 8 15" />
      </svg>
    </button>
    <span class="title">{t('history.title')}</span>
    <button class="hbtn" title={t('history.refresh')} aria-label={t('history.refresh')} onclick={() => void load()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    </button>
  </header>

  {#if loadState === 'not-applicable'}
    <div class="body"><p class="empty">{tab == null ? t('history.noDocument') : t('history.notInVault')}</p></div>
  {:else if loadState === 'git-unavailable'}
    <div class="body"><p class="empty">{t('history.gitUnavailable')}</p></div>
  {:else if loadState === 'error'}
    <div class="body"><p class="empty">{t('history.loadFailed')}</p></div>
  {:else if loadState === 'ready' && commits.length === 0}
    <div class="body"><p class="empty">{t('history.empty')}</p></div>
  {:else if loadState === 'loading'}
    <div class="body"><p class="empty">…</p></div>
  {:else}
    <div class="body">
      <ul class="commits">
        {#each commits as c (c.hash)}
          <li class="commit" class:selected={selected === c.hash}>
            <button class="row" onclick={() => (selected = selected === c.hash ? null : c.hash)}>
              <span class="subject">{c.subject}</span>
              <span class="meta">{c.short} · {relTime(c.timestamp)} · {c.author}</span>
            </button>
            {#if selected === c.hash}
              <div class="actions">
                <button class="abtn" onclick={() => void onDiff(c)}>{t('history.diff')}</button>
                <button class="abtn" onclick={() => void onCompareCurrent(c)}>{t('history.compareCurrent')}</button>
                <button class="abtn" onclick={() => void onRestore(c)}>{t('history.restore')}</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</aside>

<style>
  .history-panel {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color, #3333);
    overflow: hidden;
  }
  .splitter {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 4px;
    cursor: col-resize;
    z-index: 5;
    touch-action: none;
  }
  header {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    border-bottom: 1px solid var(--border-color, #3333);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .title { flex: 1; }
  .hbtn {
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; background: transparent; cursor: pointer;
    padding: 3px; border-radius: 4px; opacity: 0.7;
  }
  .hbtn svg { display: block; }
  .hbtn:hover:not(:disabled) { background: rgba(0,0,0,0.08); opacity: 1; }
  .body { flex: 1; overflow-y: auto; padding: 8px; }
  .empty { opacity: 0.5; font-size: 12px; }
  .commits { list-style: none; margin: 0; padding: 0; }
  .commit { border-radius: 6px; }
  .commit.selected { background: rgba(0,0,0,0.06); }
  .row {
    display: flex; flex-direction: column; gap: 2px;
    width: 100%; text-align: left;
    border: 0; background: transparent; cursor: pointer;
    padding: 6px 8px; border-radius: 6px;
  }
  .row:hover { background: rgba(0,0,0,0.05); }
  .subject { font-size: 13px; }
  .meta { font-size: 11px; opacity: 0.6; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 8px 8px; }
  .abtn {
    font-size: 12px; padding: 3px 8px; border-radius: 4px;
    border: 1px solid var(--border-color, #3335); background: transparent; cursor: pointer;
  }
  .abtn:hover { background: rgba(0,0,0,0.06); }
  @media (prefers-color-scheme: dark) {
    .hbtn:hover:not(:disabled), .row:hover, .abtn:hover { background: rgba(255,255,255,0.1); }
    .commit.selected { background: rgba(255,255,255,0.08); }
  }
</style>
