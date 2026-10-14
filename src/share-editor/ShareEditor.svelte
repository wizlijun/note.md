<script lang="ts">
  import { onMount } from 'svelte'
  import type { MountedFileEditor } from '../editor-kit-v2/file-contract'
  import NoteEditPopup from '../lib/note-anno/NoteEditPopup.svelte'
  import NotePopover from '../lib/note-anno/NotePopover.svelte'
  import { noteUi } from '../lib/note-anno/note-ui.svelte'
  let { ready, notify, revert, toggleChanges }: { ready(target: HTMLElement): void; notify(text: string): void; revert(id:string):void; toggleChanges(value:boolean):void } = $props()
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
    if (await mounted?.setMode(next)) mode = next
    else notify('当前输入尚未保存，请完成输入或重试')
  }
</script>
<div class="share-editor-shell">
  <div class="share-editor-toolbar" role="toolbar" aria-label="编辑草稿">
    <span>{path}</span>
    <button type="button" aria-pressed={mode === 'rich'} onclick={() => setMode('rich')}>Rich</button>
    <button type="button" aria-pressed={mode === 'source'} onclick={() => setMode('source')}>Source</button>
    <button type="button" onclick={() => mounted?.owner.undo()}>撤销</button>
    <button type="button" onclick={() => mounted?.owner.redo()}>重做</button>
    <button type="button" disabled={mode !== 'rich'} onclick={() => mounted?.annotations.insert()}>批注</button>
    <button type="button" aria-pressed={showChanges} onclick={() => {showChanges=!showChanges;toggleChanges(showChanges)}}>我的修改</button>
    <button type="button" onclick={() => notify('无法添加图片或附件，请在批注中描述')}>图片与附件</button>
  </div>
  {#if touched}<p class="share-editor-warning">草稿中有 {touched} 条分享者批注已被改动；可修复或原样导出。</p>{/if}
  {#if showChanges}<aside aria-label="我的修改">{#each changes as change (change.id)}<p>{change.label} <button type="button" onclick={() => revert(change.id)}>撤销这处</button></p>{/each}</aside>{/if}
  <details class="share-editor-summary"><summary>提交摘要</summary>{#each summary as file (file.path)}<p>{file.path}：{file.blocks} 处修改，{file.annotations} 条批注</p>{/each}</details>
  <div class="share-editor-document" bind:this={target}></div>
  {#if noteUi.edit}<NoteEditPopup />{/if}
  <NotePopover />
</div>
