<script lang="ts">
  import { untrack } from 'svelte'
  import { CATEGORIES, normalizeRules, type ClassificationRule } from '../classification'

  let { rules, zh, onsave, oncancel }: {
    rules: ClassificationRule[]
    zh: boolean
    onsave: (rules: ClassificationRule[]) => Promise<void>
    oncancel: () => void
  } = $props()

  let draft = $state(untrack(() => rules.map((rule) => ({ ...rule, keywords: rule.keywords.join('、') }))))
  let saving = $state(false)
  let error = $state('')
  const categoryNames: Record<string, string> = { work: 'Work', interest: 'Interests', life: 'Life', leisure: 'Leisure', other: 'Other' }

  function move(index: number, direction: number) {
    if (saving || index + direction < 0 || index + direction >= draft.length) return
    const next = [...draft]
    ;[next[index], next[index + direction]] = [next[index + direction], next[index]]
    draft = next
  }

  function add() {
    if (saving) return
    draft = [...draft, { id: crypto.randomUUID(), name: '', keywords: '', category: 'other' }]
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (saving) return
    const normalized = normalizeRules(draft.map((rule) => ({
      ...rule, name: rule.name.trim(), keywords: rule.keywords.split(/[,，、;；\n]/).map((word) => word.trim()).filter(Boolean),
    })))
    if (!normalized) {
      error = zh ? '请为每条规则填写规则名称和至少一个关键词。' : 'Give each rule a name and at least one keyword.'
      return
    }
    saving = true
    error = ''
    try { await onsave(normalized) }
    catch (cause) { error = `${zh ? '保存失败，草稿已保留。' : 'Could not save. Your draft is kept.'} ${cause instanceof Error ? cause.message : String(cause)}` }
    finally { saving = false }
  }
</script>

<section class="settings" aria-labelledby="settings-title">
  <div class="settings-heading">
    <div>
      <h2 id="settings-title">{zh ? '分类设置' : 'Classification settings'}</h2>
      <p>{zh ? '活动类别包含任一关键词即归入对应大类；按从上到下首条匹配，未命中归为「其他」。规则名称仅用于管理。' : 'Match when the activity category contains any keyword. The first rule wins; unmatched activities use Other. Rule names are for organization only.'}</p>
    </div>
  </div>
  <form onsubmit={save}>
    <fieldset disabled={saving}>
      <div class="rule-list">
        {#each draft as rule, index (rule.id)}
          <div class="rule" data-rule-id={rule.id}>
            <span class="rule-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <label class="name-field">{zh ? '规则名称' : 'Rule name'}<input aria-label={`${zh ? '规则名称' : 'Rule name'} ${index + 1}`} bind:value={rule.name} placeholder={zh ? '如：开发' : 'e.g. Development'} required /></label>
            <label class="keyword-field">{zh ? '关键词（逗号分隔）' : 'Keywords (comma separated)'}<input aria-label={`${zh ? '关键词' : 'Keywords'} ${index + 1}`} bind:value={rule.keywords} placeholder={zh ? '开发、编码、调试' : 'develop, code, debug'} required /></label>
            <label class="category-field">{zh ? '大类' : 'Category'}<select aria-label={`${zh ? '大类' : 'Category'} ${index + 1}`} bind:value={rule.category}>{#each CATEGORIES as category}<option value={category.id}>{zh ? category.label : categoryNames[category.id]}</option>{/each}</select></label>
            <div class="rule-actions">
              <button type="button" class="icon-button" aria-label={`${zh ? '上移规则' : 'Move rule up'} ${index + 1}`} disabled={saving || index === 0} onclick={() => move(index, -1)}>↑</button>
              <button type="button" class="icon-button" aria-label={`${zh ? '下移规则' : 'Move rule down'} ${index + 1}`} disabled={saving || index === draft.length - 1} onclick={() => move(index, 1)}>↓</button>
              <button type="button" class="icon-button remove" aria-label={`${zh ? '删除规则' : 'Delete rule'} ${index + 1}`} onclick={() => { if (!saving) draft = draft.filter((entry) => entry.id !== rule.id) }}>×</button>
            </div>
          </div>
        {/each}
      </div>
      {#if !draft.length}<p class="no-rules">{zh ? '尚无规则，所有时间块将归为「其他」。' : 'No rules. All time blocks will use Other.'}</p>{/if}
      <button class="add-button" type="button" onclick={add}>+ {zh ? '添加规则' : 'Add rule'}</button>
    </fieldset>
    <div class="settings-footer">
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <p class="hint">{zh ? '保存后应用于所有时间线，不修改 Markdown 原文。' : 'Applies to all timelines after saving. Markdown stays unchanged.'}</p>
      <div class="footer-actions">
        <button type="button" disabled={saving} onclick={() => { if (!saving) oncancel() }}>{zh ? '取消' : 'Cancel'}</button>
        <button type="submit" class="primary" disabled={saving}>{saving ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存分类' : 'Save rules')}</button>
      </div>
    </div>
  </form>
</section>

<style>
  .settings { max-width: 1060px; margin: 0 auto; padding: 28px 28px 40px; }
  .settings-heading { margin-bottom: 24px; }
  h2 { font-size: 20px; letter-spacing: -.4px; margin: 0 0 8px; }
  p { margin: 0; color: var(--ui-secondary); }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  .rule-list { display: flex; flex-direction: column; gap: 10px; }
  .rule { display: grid; grid-template-columns: 24px minmax(100px, 1fr) minmax(150px, 2fr) 100px auto; gap: 12px; align-items: end; border: 1px solid var(--ui-separator); background: var(--ui-surface); border-radius: 10px; padding: 14px; }
  .rule-number { font: 11px/32px ui-monospace, monospace; color: var(--ui-tertiary); }
  label { display: flex; flex-direction: column; gap: 5px; color: var(--ui-secondary); font-size: 11px; min-width: 0; }
  input, select { width: 100%; min-width: 0; height: 32px; padding: 5px 8px; border: 1px solid var(--ui-control-border); border-radius: 6px; color: CanvasText; background: var(--ui-surface); font-size: 12px; }
  button { border: 1px solid var(--ui-control-border); border-radius: 6px; padding: 6px 12px; background: var(--ui-surface); color: CanvasText; cursor: pointer; }
  button:hover:enabled { background: var(--ui-hover); }
  button:disabled { opacity: .45; }
  .rule-actions { display: flex; gap: 3px; padding-bottom: 1px; }
  .icon-button { width: 29px; height: 30px; padding: 0; font-size: 16px; border-color: transparent; }
  .remove { color: var(--ui-danger); }
  .add-button { margin-top: 14px; color: var(--ui-accent-text); }
  .settings-footer { position: sticky; bottom: 0; margin-top: 24px; padding: 18px 0 0; background: var(--ui-bg); border-top: 1px solid var(--ui-separator); }
  .hint { font-size: 11px; }
  .footer-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 0 16px; }
  .primary { background: var(--ui-accent); border-color: var(--ui-accent); color: var(--ui-accent-foreground); }
  .primary:hover:enabled { background: color-mix(in srgb, var(--ui-accent) 90%, black); }
  .error { margin-bottom: 12px; color: var(--ui-danger); overflow-wrap: anywhere; }
  .no-rules { padding: 24px 0; }
  @media (max-width: 780px) { .rule { grid-template-columns: 22px minmax(110px, 1fr) 100px auto; } .keyword-field { grid-column: 2 / -1; grid-row: 2; } }
  @media (max-width: 480px) { .settings { padding: 20px 12px; } .rule { grid-template-columns: 20px minmax(100px, 1fr) 84px; gap: 8px; padding: 10px; } .rule-actions { grid-row: 3; grid-column: 2 / -1; justify-content: flex-end; } }
</style>
