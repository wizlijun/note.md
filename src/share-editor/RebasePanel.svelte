<script lang="ts">
  import { completeGuestRebase, refreshGuestRebase, type RebaseCandidate } from './rebase'
  import type { DraftV2 } from '../lib/project-share/types'
  let { candidate, done, cancel, changed }: { candidate: RebaseCandidate; done(next: DraftV2): Promise<void>; cancel(): Promise<void>; changed(): void } = $props()
  let revision = $state(0), error = $state(''), busy = $state(false)
  function update() { refreshGuestRebase(candidate); candidate = { ...candidate }; revision++; changed() }
  function exportItem(id: string, raw: string, name: string) {
    const url = URL.createObjectURL(new Blob([raw], { type: 'text/plain;charset=utf-8' })), link = document.createElement('a')
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    candidate.exported.add(id); candidate = { ...candidate }; revision++
  }
  async function finish() {
    try { busy = true; error = ''; await done(completeGuestRebase(candidate)) }
    catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
  async function cancelSafely() {
    try { busy = true; error = ''; await cancel() }
    catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
</script>
<section class="rebase-panel" aria-label="在新版本上继续" data-revision={revision}>
  <h3>在新版本上继续</h3>
  <p>逐一处理冲突。取消将保留原版本的完整草稿。</p>
  {#each candidate.files as file (file.path)}
    {#each file.proposal.hunks.filter(h => h.kind === 'conflict') as hunk (hunk.id)}
      <fieldset disabled={busy}><legend>{file.path} · 冲突</legend>
        <p>分享者版本</p><pre>{hunk.ours}</pre><p>我的版本</p><pre>{hunk.theirs}</pre>
        <button type="button" aria-pressed={file.decisions[hunk.id]?.choice === 'ours'} onclick={() => { file.decisions[hunk.id] = { kind: 'conflict', choice: 'ours' }; update() }}>分享者版本</button>
        <button type="button" aria-pressed={file.decisions[hunk.id]?.choice === 'theirs'} onclick={() => { file.decisions[hunk.id] = { kind: 'conflict', choice: 'theirs' }; update() }}>我的版本</button>
        <label>手改<textarea aria-label="手改冲突" oninput={(e) => { file.decisions[hunk.id] = { kind: 'conflict', choice: 'edited', text: e.currentTarget.value }; update() }}></textarea></label>
      </fieldset>
    {/each}
  {/each}
  {#each candidate.removed as path}
    <p>{path} 已移出分享。<button type="button" onclick={() => exportItem('file:' + path, candidate.old.after[path] ?? candidate.old.base[path].markdown, path.split('/').pop()!)}>导出完整原稿</button>
      {#if candidate.exported.has('file:' + path)}已导出，完成迁移时从新范围移除{/if}</p>
  {/each}
  {#each candidate.orphans as row}
    <p>{row.path} · 无法自动放置批注：{row.annotation.selector.exact} — {row.annotation.comment}
      <button type="button" onclick={() => exportItem(row.id, JSON.stringify(row.annotation, null, 2), 'annotation.json')}>导出批注并稍后手动处理</button>
      {#if candidate.exported.has(row.id)}已导出，稍后手动处理{/if}
    </p>
  {/each}
  {#if error}<p role="alert">{error}</p>{/if}
  <button type="button" disabled={busy} onclick={finish}>完成迁移</button>
  <button type="button" disabled={busy} onclick={cancelSafely}>取消</button>
</section>
<style>
  .rebase-panel { padding: 16px; border: 1px solid var(--border-color, #ccc); background: var(--bg-secondary, #f5f5f5); }
  pre { white-space: pre-wrap; } textarea { display: block; width: 100%; min-height: 4em; }
</style>
