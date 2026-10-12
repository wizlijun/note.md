<script lang="ts">
  import type { GitTarget } from '../../lib/project-share/types'
  let { target, git, hasEdits, disabled = false, onSelect }: {
    target: GitTarget; git: boolean; hasEdits: boolean; disabled?: boolean; onSelect: (target: GitTarget) => void
  } = $props()
</script>
<div class="review-actions" aria-label="审阅目标">
  <button aria-pressed={target === 'worktree'} {disabled} onclick={() => onSelect('worktree')}>A · 写回原件</button>
  <button aria-pressed={target === 'branch'} disabled={disabled || !git || !hasEdits} onclick={() => onSelect('branch')}>B · 创建分支</button>
  <button aria-pressed={target === 'patch'} disabled={disabled || !git || !hasEdits} onclick={() => onSelect('patch')}>C · 导出补丁</button>
</div>
