<script lang="ts">
  import { feedbackAnnotations, feedbackName } from '../../lib/project-share/feedback'
  import { onDestroy, tick, untrack } from 'svelte'
  import { writeText } from '@tauri-apps/plugin-clipboard-manager'
  import { projectCommand, projectGitCommand, syncProjectReceipt, setProjectReceipt } from '../../lib/project-share/host'
  import { writeTextFile } from '@tauri-apps/plugin-fs'
  import { pickSaveFile } from '../../lib/dialogs'
  import { pushCommand, type GitConfirmation } from '../../lib/project-share/git'
  import GitTargetBar from './GitTargetBar.svelte'
  import { createMergeClient } from '../../lib/project-share/merge-client'
  import { createProjectReview, type ReviewDependencies } from '../../lib/project-share/review.svelte'
  import type { LocalFeedback } from '../../lib/project-share/types'
  import { modalFocus } from '../../lib/ui/modal-focus'
  import { visibleText } from './display'
  import ReceiptPanel from './ReceiptPanel.svelte'
  import SubmissionList from './SubmissionList.svelte'
  import HunkView from './HunkView.svelte'
  import AnnotationPanel from './AnnotationPanel.svelte'
  import SourceDiff from './SourceDiff.svelte'
  import './review.css'

  let { projectId, feedback, prepareSource, refreshSource, onUpdated }: {
    projectId: string; feedback: LocalFeedback[]; prepareSource: (path: string) => Promise<void>;
    refreshSource: (path: string) => Promise<void>; onUpdated: (feedback: LocalFeedback) => void
  } = $props()
  let items = $state.raw<LocalFeedback[]>([])
  $effect(() => { items = feedback })
  let selected = $state.raw<LocalFeedback | null>(null)
  let byFile = $state(false), rendered = $state(false), viewMenu = $state(false), navigating = $state(false)
  let localError = $state(''), copied = $state(''), focused = $state(0)
  let region: HTMLDivElement | undefined = $state()
  let viewButton: HTMLButtonElement | undefined = $state()
  let confirmation = $state.raw<(Parameters<ReviewDependencies['confirmWrite']>[0] & { resolve: (value: boolean) => void }) | null>(null)
  let gitConfirmation = $state.raw<(GitConfirmation & { resolve: (value: boolean) => void }) | null>(null)
  const client = createMergeClient()
  const session = untrack(() => createProjectReview(projectId, {
    command: projectCommand, gitCommand: projectGitCommand,
    syncReceipt: id => syncProjectReceipt(projectId, id),
    confirmGit: input => new Promise(resolve => { gitConfirmation = { ...input, resolve } }),
    pickPatch: pickSaveFile, savePatch: writeTextFile,
    prepareSource: path => prepareSource(path), refreshSource: path => refreshSource(path),
    compute: client.compute, locateAnnotations: client.locateAnnotations, cancelAnnotations: client.cancelAnnotations,
    dispose: client.destroy,
    confirmWrite: input => new Promise(resolve => { confirmation = { ...input, resolve } }),
    onUpdated: updateFeedback,
  }))
  function updateFeedback(updated: LocalFeedback) {
    items = items.map(item => item.envelope.payload.submissionId === updated.envelope.payload.submissionId ? updated : item)
    if (selected?.envelope.payload.submissionId === updated.envelope.payload.submissionId) selected = updated
    onUpdated(updated)
  }
  function predecessorHistory(item: LocalFeedback | null): LocalFeedback[] {
    const seen = new Set<string>(), history: LocalFeedback[] = []
    while (item && item.status !== 'quarantined') {
      seen.add(item.envelope.payload.submissionId)
      const previous: string | undefined = item.envelope.payload.schemaVersion === 2 ? item.envelope.payload.supersedes : undefined
      if (!previous || seen.has(previous)) break
      item = items.find(candidate => candidate.envelope.payload.submissionId === previous && candidate.status !== 'quarantined') ?? null
      if (item) history.push(item)
    }
    return history
  }
  const history = $derived(predecessorHistory(selected))
  const locked = $derived(navigating || session.phase === 'writing' || session.phase === 'loading' || session.phase === 'destroyed')
  const active = $derived(!!selected && selected.status !== 'quarantined' && session.feedback?.envelope.payload.submissionId === selected.envelope.payload.submissionId)
  const paths = (item: LocalFeedback) => [...new Set([...item.envelope.payload.edits.map(edit => edit.path), ...item.envelope.payload.annotations.map(annotation => annotation.path)])]
  const terminal = (item: LocalFeedback, path: string) => ['accepted', 'rejected', 'mirror_pending', 'branched', 'recovery_conflict'].includes(item.decisions[path]?.status ?? '')
  const pendingFiles = $derived([...new Set(items.filter(item => !['quarantined', 'resolved', 'rejected', 'accepted', 'branched'].includes(item.status)).flatMap(item => paths(item).filter(path => !terminal(item, path))))])
  const nextForPath = $derived(items.find(item => item.envelope.payload.submissionId !== selected?.envelope.payload.submissionId && !['quarantined', 'resolved', 'rejected', 'accepted', 'branched'].includes(item.status) && paths(item).includes(session.path) && !terminal(item, session.path)))

  // Reading/locating can be cancelled by the parent's normal close/project actions.
  export function isBusy() { return session.phase === 'writing' || session.phase === 'destroyed' || (navigating && session.phase !== 'loading') }
  export async function flush() { await session.flush() }
  export async function destroy() { await session.destroy() }
  onDestroy(() => { void session.destroy().catch(e => console.warn('[project-review] unawaited departure:', e)) })
  async function run(task: () => Promise<void>) {
    localError = ''; copied = ''
    try { await task() } catch (e) { localError = String(e) }
  }
  async function select(item: LocalFeedback, path = paths(item)[0]) {
    if (locked) return
    navigating = true
    try {
      await session.flush()
      item = items.find(latest => latest.envelope.payload.submissionId === item.envelope.payload.submissionId) ?? item
      selected = item; focused = 0; localError = ''; copied = ''
      if (item.status !== 'quarantined' && path) {
        await session.initializeTarget(!!item.envelope.payload.edits.length)
        await session.open(item, path)
      }
    } catch (e) { localError = String(e) } finally { navigating = false }
  }
  async function selectPath(path: string) {
    const item = items.find(item => !['quarantined', 'resolved', 'rejected', 'accepted', 'branched'].includes(item.status) && paths(item).includes(path) && !terminal(item, path))
    if (item) await select(item, path)
  }
  async function copy(text: string) { await run(async () => { await writeText(text); copied = '已复制' }) }
  function finishConfirmation(value: boolean) { const pending = confirmation; confirmation = null; pending?.resolve(value) }
  function finishGitConfirmation(value: boolean) { const pending = gitConfirmation; gitConfirmation = null; pending?.resolve(value) }
  async function copyCommitMessage() {
    const id = selected!.envelope.payload.submissionId
    const result = await projectGitCommand<{ message: string }>('commit-message', { project_id: projectId, submissionId: id })
    if (selected?.envelope.payload.submissionId === id && session.phase !== 'destroyed') await copy(result.message)
  }
  async function move(delta: number) {
    const hunks = region?.querySelectorAll<HTMLElement>('.hunk')
    if (!hunks?.length) return
    focused = Math.max(0, Math.min(hunks.length - 1, focused + delta))
    await tick(); hunks[focused].focus({ preventScroll: true }); hunks[focused].scrollIntoView?.({ block: 'nearest' })
  }
  function keyboard(event: KeyboardEvent) {
    if (viewMenu) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); viewMenu = false; viewButton?.focus(); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const choices = [...region!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        const index = choices.indexOf(document.activeElement as HTMLButtonElement)
        choices[(index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus()
        return
      }
    }
    if (event.defaultPrevented || event.isComposing || confirmation || gitConfirmation || locked || !active) return
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (session.target !== 'worktree') { if (session.canGit) void run(session.executeGit) }
      else if (session.canWrite && !session.result?.pendingConflicts.length) void run(session.writeFile)
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'j' || event.key === 'k') { event.preventDefault(); void move(event.key === 'j' ? 1 : -1); return }
    const hunk = region?.querySelectorAll<HTMLElement>('.hunk')[focused]
    if (!hunk) return
    const labels: Record<string, string> = { a: '接受', r: '拒绝', e: '编辑' }
    const button = [...hunk.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === labels[event.key])
    if (button && !button.disabled) { event.preventDefault(); button.click() }
  }
  function keyboardScope(node: HTMLElement) {
    const focus = (event: FocusEvent) => {
      const hunk = event.target instanceof Element ? event.target.closest<HTMLElement>('.hunk') : null
      const index = hunk ? [...node.querySelectorAll('.hunk')].indexOf(hunk) : -1
      if (index >= 0) focused = index
    }
    node.addEventListener('keydown', keyboard)
    node.addEventListener('focusin', focus)
    return { destroy() { node.removeEventListener('keydown', keyboard); node.removeEventListener('focusin', focus) } }
  }
</script>

<div class="project-review" role="region" aria-label="逐处审阅" tabindex="-1" bind:this={region} use:keyboardScope>
  <div class="review-actions"><button aria-pressed={!byFile} disabled={locked} onclick={() => byFile = false}>按提交</button><button aria-pressed={byFile} disabled={locked} onclick={() => byFile = true}>按文件</button><span class="review-secondary">{session.saving ? '正在保存…' : session.dirty ? '待保存' : '审阅进度已保存'}</span></div>
  {#if byFile}<div class="review-actions" aria-label="待审文件">{#each pendingFiles as path}<button disabled={locked} onclick={() => { void selectPath(path) }}>{path}</button>{/each}{#if !pendingFiles.length}<p>没有待审文件。</p>{/if}</div>{:else}<SubmissionList feedback={items} selectedId={selected?.envelope.payload.submissionId} hunkCount={active ? session.proposal?.hunks.length : undefined} disabled={locked} onSelect={item => { void select(item) }} />{/if}
  {#if localError}<p class="review-error" role="alert">{localError}</p>{/if}
  {#if copied}<p role="status">{copied}</p>{/if}
  {#if selected}
    <h4>{feedbackName(selected.envelope.payload) || '访客'} <span class="review-badge">自报</span>{#if selected.envelope.payload.schemaVersion === 2 && selected.envelope.payload.contributor?.aiAssisted}<span class="review-badge">AI 辅助</span>{/if}</h4>
    {#if selected.envelope.payload.schemaVersion === 2 && selected.envelope.payload.message}<p>{selected.envelope.payload.message}</p>{/if}
    {#if selected.status === 'quarantined'}<p class="review-error">这份反馈已隔离，快照或基线不可信，不能写回原件。</p><p>{selected.error}</p><button onclick={() => { void copy(JSON.stringify(selected!.envelope.payload)) }}>复制反馈</button>
    {:else}
      {#key selected.envelope.payload.submissionId}<ReceiptPanel feedback={selected} disabled={locked} onSave={async input => { updateFeedback(await setProjectReceipt(projectId, selected!.envelope.payload.submissionId, input)) }} onRetry={async () => { updateFeedback(await syncProjectReceipt(projectId, selected!.envelope.payload.submissionId)) }} />{/key}
      {#if history.length}<section aria-label="此前提交"><h4>此前提交</h4>{#each history as previous}<button disabled={locked} onclick={() => { void select(previous) }}>{feedbackName(previous.envelope.payload) || '访客'} · {previous.envelope.payload.submissionId}</button>{/each}<button disabled={locked} onclick={() => { void run(() => session.rejectSuperseded(history)) }}>全部标为已取代</button></section>{/if}
      <GitTargetBar target={session.target} git={!!session.probe?.git} hasEdits={!!selected.envelope.payload.edits.length} disabled={locked} onSelect={target => { void run(() => session.setTarget(target)) }} />
      {#if session.gitError}<p class="review-error">Git 暂不可用：{session.gitError}</p>{/if}
      {#if session.target !== 'worktree'}
        <p class="review-secondary">按磁盘内容审阅；整份投稿将相对当前 HEAD 重新计算。未保存的编辑器内容不参与，批注不写入分支或补丁。</p>
        <button class="primary" disabled={locked || !session.canGit} onclick={() => { void run(session.executeGit) }}>{session.target === 'branch' ? '创建整份投稿分支' : '导出整份投稿补丁'}</button>
      {:else}<button disabled={locked} onclick={() => { void run(copyCommitMessage) }}>复制提交信息</button>{/if}
      {#if session.branchResult}
        <p class="review-secondary" role="status">分支：{session.branchResult.branch}</p>
        {#if session.probe?.remote}<button onclick={() => { void copy(pushCommand(session.probe!.remote!, session.branchResult!.branch)) }}>复制 push 命令</button>{/if}
        {#if session.branchResult.stateError}<p class="review-error">分支已创建，但状态未完整记录：{session.branchResult.stateError}</p><button disabled={locked} onclick={() => { void run(session.retryBranchState) }}>重试记录状态</button>{/if}
      {/if}
      {#if selected.status === 'branched'}<p role="status">这份投稿已处理，可重复导出补丁。</p>{/if}
      <div class="review-actions" aria-label="提交文件">{#each paths(selected) as path}<button aria-pressed={session.path === path} disabled={locked} onclick={() => { void select(selected!, path) }}>审阅文件：{path}</button>{/each}</div>
      {#if active}
        <h4>文件审阅：{session.path}</h4>
        {#if session.phase === 'loading'}<p role="status">正在读取原件并定位批注…</p>{/if}
        {#if session.error}<p class="review-error" role="alert">{session.file ? session.error : `目标不在分享范围或原件不可用；只能复制或拒绝。${session.error}`}</p>{/if}
        {#if session.notice}<p role="status">{session.notice}</p>{/if}
        <div class="review-actions">
          <button disabled={!session.canDecide || locked} onclick={() => session.acceptAll()}>接受全部无冲突改动</button>
          {#if session.target === 'worktree'}<button class="primary" disabled={!session.canWrite || !!session.result?.pendingConflicts.length || locked} onclick={() => { void run(session.writeFile) }}>写回本文件</button>{/if}
          <button disabled={!session.canReject || locked} onclick={() => { void run(session.rejectFile) }}>拒绝此文件</button>
          <button onclick={() => { void copy(selected!.envelope.payload.edits.find(edit => edit.path === session.path)?.afterMarkdown ?? feedbackAnnotations(selected!.envelope.payload).filter(a => a.path === session.path).map(a => `${a.selector.exact}\n${a.comment}`).join('\n\n')) }}>复制建议</button>
          <div class="view-menu"><button bind:this={viewButton} aria-haspopup="menu" aria-expanded={viewMenu} onclick={() => viewMenu = !viewMenu}>{rendered ? '渲染 diff' : '源码 diff'} ▾</button>{#if viewMenu}<div class="menu-panel" role="menu" aria-label="差异视图"><button class="menu-row" role="menuitem" onclick={() => { rendered = false; viewMenu = false; viewButton?.focus() }}>源码 diff</button><button class="menu-row" role="menuitem" onclick={() => { rendered = true; viewMenu = false; viewButton?.focus() }}>渲染 diff</button></div>{/if}</div>
        </div>
        {#if session.result?.pendingConflicts.length}<p class="review-error">{session.result.pendingConflicts.length} 处未决冲突，确认后才能写回。</p>{/if}
        {#if session.proposal}{#each session.proposal.segments as segment}
          {#if segment.type === 'stable'}{#if segment.text}<pre class="stable-context">{visibleText(segment.text)}</pre>{/if}
          {:else}{@const hunk = session.proposal.hunks.find(hunk => hunk.id === segment.id)!}{#key hunk.id}<HunkView {hunk} decision={session.decisions[hunk.id]} disabled={!session.canDecide || locked} {rendered} onDecide={session.decide} />{/key}{/if}
        {/each}{/if}
        <AnnotationPanel gitTarget={session.target !== 'worktree'} rows={session.annotations} disabled={locked} onStage={session.stageAnnotation} onDismiss={index => { void run(() => session.dismissAnnotation(index)) }} onCopy={text => { void copy(text) }} />
        <div class="review-actions">{#if !selected.envelope.payload.edits.length}<button disabled={locked} onclick={() => { void run(session.resolve) }}>标注已阅</button>{/if}{#if nextForPath}<button disabled={locked} onclick={() => { void select(nextForPath!, session.path) }}>审阅下一份</button>{/if}{#if session.error && session.dirty}<button disabled={locked} onclick={() => { void run(session.flush) }}>重试保存进度</button>{/if}</div>
      {/if}
    {/if}
  {/if}
  {#if gitConfirmation}<div class="confirm-overlay"><div class="confirm-dialog ui-surface" role="dialog" aria-modal="true" aria-labelledby="git-review-confirm-title" tabindex="-1" use:modalFocus={{ onClose: () => finishGitConfirmation(false) }}>
    <h4 id="git-review-confirm-title">确认整份投稿</h4><p>{gitConfirmation.target === 'branch' ? '创建分支' : '导出补丁'} · {gitConfirmation.files.length} 个文件 · {gitConfirmation.pendingAnnotations} 条批注尚未处理</p>
    <div class="confirm-diff">{#each gitConfirmation.files as file}<section aria-label={`确认文件：${file.path}`}><h5>{file.path} · {file.pendingTheirs} 处未决将视为不采纳</h5><SourceDiff current={file.current} result={file.result} /></section>{/each}</div>
    <div class="review-actions"><button data-initial-focus onclick={() => finishGitConfirmation(false)}>取消</button><button class="primary" onclick={() => finishGitConfirmation(true)}>{gitConfirmation.target === 'branch' ? '确认创建分支' : '确认导出补丁'}</button></div>
  </div></div>{/if}
  {#if confirmation}<div class="confirm-overlay"><div class="confirm-dialog ui-surface" role="dialog" aria-modal="true" aria-labelledby="review-confirm-title" tabindex="-1" use:modalFocus={{ onClose: () => finishConfirmation(false) }}>
    <h4 id="review-confirm-title">确认写回</h4><p>{confirmation.path} · {confirmation.pendingTheirs} 处未决将视为不采纳 · {confirmation.pendingAnnotations} 条批注尚未处理</p>
    <div class="confirm-diff"><SourceDiff current={confirmation.current} result={confirmation.result} /></div><div class="review-actions"><button data-initial-focus onclick={() => finishConfirmation(false)}>取消</button><button class="primary" onclick={() => finishConfirmation(true)}>确认写回</button></div>
  </div></div>{/if}
</div>
