<script lang="ts">
  import { onMount } from 'svelte'
  import type { MountedFileEditor } from '../editor-kit-v2/file-contract'
  import NoteEditPopup from '../lib/note-anno/NoteEditPopup.svelte'
  import NotePopover from '../lib/note-anno/NotePopover.svelte'
  import { noteUi } from '../lib/note-anno/note-ui.svelte'
  let { ready, notify, revert, toggleChanges, undoRebase, recoverRebase, discardRecovery }: { ready(target: HTMLElement): void; notify(text: string): void; revert(id:string):void; toggleChanges(value:boolean):void; undoRebase():void; recoverRebase():void; discardRecovery():void } = $props()
  let canUndoRebase = $state(false), canRecoverRebase = $state(false)
  export function rebaseState(undo: boolean, recover: boolean) { canUndoRebase = undo; canRecoverRebase = recover }
  let showChanges=$state(false)
  let changes=$state<{id:string;label:string}[]>([])
  let summary=$state<{path:string;blocks:number;annotations:number}[]>([])
  export function updateChanges(rows:typeof changes, files:typeof summary) {changes=rows;summary=files}
  let target: HTMLDivElement
  let mounted = $state<MountedFileEditor | undefined>()
  let mode = $state<'rich' | 'source'>('rich')
  let path = $state(''), touched = $state(0)
  onMount(() => ready(target))
  export function install(editor: MountedFileEditor, nextPath: string, count: number) { mounted = editor; mode = 'rich'; path = nextPath; touched = count }
  export function warning(count: number) { touched = count }
  async function setMode(next: 'rich' | 'source') {
    if (next === mode) return
    if (await mounted?.setMode(next)) mode = next
    else notify('当前输入尚未保存，请完成输入或重试')
  }
  function moveTab(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (current < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1)!
      : buttons[(current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]
    next.click(); next.focus()
  }
</script>
{#snippet icon(kind: 'undo' | 'redo' | 'note' | 'changes')}
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if kind === 'undo'}<path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12" />
    {:else if kind === 'redo'}<path d="m15 5 5 5-5 5M20 10H10a6 6 0 0 0 0 12" />
    {:else if kind === 'note'}<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 2V11.5a8.5 8.5 0 0 1 17 0ZM8 10h8M8 14h5" />
    {:else}<path d="M8 4h12v16H8M4 8h8M4 12h6M4 16h8" />{/if}
  </svg>
{/snippet}
<div class="share-editor-shell">
  <div class="share-editor-toolbar" role="toolbar" aria-label="编辑草稿">
    <span class="share-editor-path" title={path}>{path}</span>
    <div class="share-editor-modes" role="tablist" aria-label="编辑模式" tabindex="-1" onkeydown={moveTab}>
      <button type="button" role="tab" aria-selected={mode === 'rich'} aria-label="富文本" title="富文本（Rich）" tabindex={mode === 'rich' ? 0 : -1} class:active={mode === 'rich'} onclick={() => setMode('rich')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
      <button type="button" role="tab" aria-selected={mode === 'source'} aria-label="源码" title="源码（Source）" tabindex={mode === 'source' ? 0 : -1} class:active={mode === 'source'} onclick={() => setMode('source')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      </button>
    </div>
    <div class="share-editor-actions">
      <button type="button" aria-label="撤销" title="撤销" onclick={() => mounted?.owner.undo()}>{@render icon('undo')}</button>
      <button type="button" aria-label="重做" title="重做" onclick={() => mounted?.owner.redo()}>{@render icon('redo')}</button>
      <button type="button" aria-label="批注" title="添加批注" disabled={mode !== 'rich'} onclick={() => mounted?.annotations.insert()}>{@render icon('note')}</button>
      <button type="button" aria-label="我的修改" title="我的修改" aria-pressed={showChanges} onclick={() => {showChanges=!showChanges;toggleChanges(showChanges)}}>{@render icon('changes')}</button>
    </div>
    {#if canUndoRebase}<button type="button" onclick={undoRebase}>撤销 rebase</button>{/if}
    {#if canRecoverRebase}<button type="button" onclick={recoverRebase}>恢复上次迁移</button>{/if}
    {#if canRecoverRebase}<button type="button" onclick={discardRecovery}>取消上次迁移</button>{/if}
  </div>
  {#if touched}<p class="share-editor-warning">草稿中有 {touched} 条分享者批注已被改动；可修复或原样导出。</p>{/if}
  {#if showChanges}<aside class="share-editor-changes" aria-label="我的修改">
    {#each changes as change (change.id)}<p>{change.label} <button type="button" onclick={() => revert(change.id)}>撤销这处</button></p>{/each}
    <details class="share-editor-summary"><summary>提交摘要</summary>{#each summary as file (file.path)}<p>{file.path}：{file.blocks} 处修改，{file.annotations} 条批注</p>{/each}</details>
  </aside>{/if}
  <div class="share-editor-document" bind:this={target}></div>
  {#if noteUi.edit}<NoteEditPopup />{/if}
  <NotePopover />
</div>
