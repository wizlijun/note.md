<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onMount } from 'svelte'
  import { api } from './lib/bridge'
  import type { DatasetProposal, ReviewBatch, Snapshot } from './lib/types'

  type Tab = 'pending' | 'dictionary' | 'history' | 'settings'
  let tab: Tab = 'pending'
  let snapshot: Snapshot | null = null
  let busy = false
  let error = ''
  let notice = ''
  let datasetPath = ''
  let selectedBatchId = ''
  let selected = new Set<string>()
  let edited: Record<string, Record<string, any>> = {}
  let evidence: Record<string, Array<Record<string, any>>> = {}
  let loadingEvidence = new Set<string>()
  let migrationNames: Record<string, string> = {}
  let renamingFormalNames = false

  type MigrationEffect = {
    kind: 'update' | 'remove' | 'consolidate' | 'add_alias'
    ruleId?: string
    keptRuleId?: string
    domainId: string
    observed: string
    currentOutput?: string
    formalName: string
  }

  const t = (zh: string, en: string) => (window.notemd?.locale || '').startsWith('zh') ? zh : en
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
  const currentBatch = (): ReviewBatch | undefined => snapshot?.batches.find((batch) => batch.run_id === selectedBatchId)
  const pendingProposals = (batch: ReviewBatch) => batch.dataset.proposals.filter((proposal) => batch.proposal_states[proposal.id]?.status === 'pending')
  const proposalKey = (batch: ReviewBatch, proposalId: string) => `${batch.run_id}\u0000${proposalId}`

  async function refresh(preserveDraft = true) {
    const before = preserveDraft ? edited : {}
    snapshot = await api.bootstrap()
    edited = before
    if (snapshot.formal_name_migration.required) {
      migrationNames = Object.fromEntries(snapshot.formal_name_migration.entries.map((entry) => [
        entry.id,
        migrationNames[entry.id] ?? entry.formal_name,
      ]))
    }
    if (!selectedBatchId || !snapshot.batches.some((batch) => batch.run_id === selectedBatchId)) {
      selectedBatchId = snapshot.batches.find((batch) => pendingProposals(batch).length)?.run_id || snapshot.batches[0]?.run_id || ''
    }
  }

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return
    busy = true; error = ''; notice = ''
    try { await action(); await refresh(); notice = success; await api.toast('success', success) }
    catch (value) { error = value instanceof Error ? value.message : String(value) }
    finally { busy = false }
  }

  async function initializeAndRefresh() {
    if (busy) return
    busy = true; error = ''; notice = ''
    try {
      const result = await api.initialize()
      await refresh(false)
      if (result.dictionary_created) notice = t('沟通词典已为当前 Vault 准备好', 'Conversation Dictionary is ready for this Vault')
    } catch (value) {
      error = value instanceof Error ? value.message : String(value)
      try { await refresh(false) } catch { /* retain the initialization error */ }
    } finally {
      busy = false
    }
  }

  async function importDataset() {
    await run(() => api.importDataset(datasetPath.trim()), t('待审数据集已导入', 'Review dataset imported'))
    datasetPath = ''
  }

  function editValue(batch: ReviewBatch, proposal: DatasetProposal): Record<string, any> {
    const key = proposalKey(batch, proposal.id)
    if (!edited[key]) edited = { ...edited, [key]: clone(proposal.value) }
    return edited[key]
  }

  function setField(batch: ReviewBatch, proposal: DatasetProposal, key: string, value: unknown) {
    const cacheKey = proposalKey(batch, proposal.id)
    const next = clone(editValue(batch, proposal)); next[key] = value
    edited = { ...edited, [cacheKey]: next }
  }

  const parseLines = (value: string) => value.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)

  function setFormalName(batch: ReviewBatch, proposal: DatasetProposal, formalName: string) {
    const cacheKey = proposalKey(batch, proposal.id)
    const next = clone(editValue(batch, proposal))
    const previous = next.label || ''
    next.label = formalName
    const forms = [...(next.forms || [])]
    const previousIndex = forms.findIndex((form) => form.normalize('NFC') === previous.normalize('NFC'))
    if (previousIndex >= 0) forms[previousIndex] = formalName
    else if (formalName.trim() && !forms.some((form) => form.normalize('NFC') === formalName.normalize('NFC'))) forms.unshift(formalName)
    next.forms = forms.filter(Boolean)
    edited = { ...edited, [cacheKey]: next }
  }

  function setEntryForms(batch: ReviewBatch, proposal: DatasetProposal, input: string) {
    const value = editValue(batch, proposal)
    const forms = parseLines(input)
    const formalName = (value.label || '').trim()
    if (formalName && !forms.some((form) => form.normalize('NFC') === formalName.normalize('NFC'))) forms.unshift(formalName)
    setField(batch, proposal, 'forms', forms)
  }

  function toggle(id: string) {
    const next = new Set(selected); next.has(id) ? next.delete(id) : next.add(id); selected = next
  }

  function selectSafe(batch: ReviewBatch) {
    if (batch.dataset.conflicts.length) { selected = new Set(); return }
    selected = new Set(pendingProposals(batch).filter((proposal) => proposal.kind !== 'add_forms' || proposal.depends_on.every((id) => batch.proposal_states[id]?.status === 'accepted')).map((proposal) => proposal.id))
  }

  async function toggleEvidence(batch: ReviewBatch, proposal: DatasetProposal) {
    const key = proposalKey(batch, proposal.id)
    if (evidence[key]) {
      const next = { ...evidence }; delete next[key]; evidence = next
      return
    }
    const loading = new Set(loadingEvidence); loading.add(key); loadingEvidence = loading
    error = ''
    try {
      const result = await api.batchEvidence(batch.run_id, proposal.id)
      evidence = { ...evidence, [key]: result.evidence }
    } catch (value) {
      error = value instanceof Error ? value.message : String(value)
    } finally {
      const next = new Set(loadingEvidence); next.delete(key); loadingEvidence = next
    }
  }

  function selectedWithDependencies(batch: ReviewBatch): string[] {
    const ids = new Set(selected)
    let changed = true
    while (changed) {
      changed = false
      for (const proposal of batch.dataset.proposals) if (ids.has(proposal.id)) {
        for (const dependency of proposal.depends_on || []) {
          if (batch.proposal_states[dependency]?.status === 'pending' && !ids.has(dependency)) { ids.add(dependency); changed = true }
        }
      }
    }
    return [...ids]
  }

  async function commitSelected(batch: ReviewBatch) {
    if (batch.dataset.conflicts.length) return
    const ids = selectedWithDependencies(batch)
    if (!ids.length) return
    const proposals = new Map(batch.dataset.proposals.map((proposal) => [proposal.id, proposal]))
    await run(() => api.commitBatch({
      run_id: batch.run_id,
      dataset_sha256: batch.dataset_sha256,
      transaction_id: crypto.randomUUID(),
      expected_dictionary_revision: snapshot!.formal_name_migration.expected_revision,
      expected_dictionary_sha256: snapshot!.formal_name_migration.expected_sha256,
      selected: ids.map((id) => ({
        id,
        review_revision: batch.proposal_states[id].revision,
        ...(edited[proposalKey(batch, id)] ? { value: edited[proposalKey(batch, id)] } : {}),
      })),
    }), t(`已保存 ${ids.length} 项更改`, `Saved ${ids.length} changes`))
    for (const id of ids) { delete edited[proposalKey(batch, id)]; selected.delete(id); proposals.delete(id) }
    edited = { ...edited }; selected = new Set(selected)
  }

  function describeRef(batch: ReviewBatch, reference: Record<string, any> | undefined, kind: 'domain' | 'entry'): string {
    if (!reference) return t('未指定', 'Not specified')
    if (reference.existing_id) {
      const item = kind === 'domain'
        ? snapshot?.dictionary?.domains.find((domain) => domain.id === reference.existing_id)
        : snapshot?.dictionary?.entries.find((entry) => entry.id === reference.existing_id)
      const label = item && ('name' in item ? item.name : item.label)
      return label ? `${label} · ${reference.existing_id}` : reference.existing_id
    }
    if (reference.proposal_id) {
      const review = batch.proposal_states[reference.proposal_id]
      if (review?.status === 'accepted' && review.permanent_id) {
        const item = kind === 'domain'
          ? snapshot?.dictionary?.domains.find((domain) => domain.id === review.permanent_id)
          : snapshot?.dictionary?.entries.find((entry) => entry.id === review.permanent_id)
        const label = item && ('name' in item ? item.name : item.label)
        return label ? `${label} · ${review.permanent_id}` : review.permanent_id
      }
      const proposal = batch.dataset.proposals.find((item) => item.id === reference.proposal_id)
      const value = proposal ? (edited[proposalKey(batch, proposal.id)] || review?.edited_value || proposal.value) : undefined
      const label = kind === 'domain' ? value?.name : value?.label
      return `${label || t('待创建', 'Planned')} · ${reference.proposal_id}`
    }
    return t('无效引用', 'Invalid reference')
  }

  function formalNameForRef(batch: ReviewBatch, reference: Record<string, any> | undefined): string {
    if (reference?.existing_id) return snapshot?.dictionary?.entries.find((entry) => entry.id === reference.existing_id)?.label || t('未指定', 'Not specified')
    if (reference?.proposal_id) {
      const review = batch.proposal_states[reference.proposal_id]
      if (review?.status === 'accepted' && review.permanent_id) {
        return snapshot?.dictionary?.entries.find((entry) => entry.id === review.permanent_id)?.label || t('未指定', 'Not specified')
      }
      const proposal = batch.dataset.proposals.find((item) => item.id === reference.proposal_id)
      const value = proposal ? (edited[proposalKey(batch, proposal.id)] || review?.edited_value || proposal.value) : undefined
      return value?.label || t('未指定', 'Not specified')
    }
    return t('未指定', 'Not specified')
  }

  function aliases(entry: { label: string; forms: string[] }): string[] {
    const formal = entry.label.normalize('NFC')
    return entry.forms.filter((form) => form.normalize('NFC') !== formal)
  }

  function migrationAliases(entryId: string): string[] {
    const entry = snapshot?.dictionary?.entries.find((item) => item.id === entryId)
    if (!entry) return []
    const formal = (migrationNames[entryId] || entry.label).trim().normalize('NFC')
    const values = [...entry.forms, entry.label]
    return values.filter((value, index) => value.normalize('NFC') !== formal
      && values.findIndex((candidate) => candidate.normalize('NFC') === value.normalize('NFC')) === index)
  }

  function migrationEffects(entryId: string): MigrationEffect[] {
    const dictionary = snapshot?.dictionary
    const entry = dictionary?.entries.find((item) => item.id === entryId)
    if (!dictionary || !entry) return []
    const formalName = (migrationNames[entryId] || entry.label).trim()
    const formal = formalName.normalize('NFC')
    const rules = dictionary.rules.filter((rule) => rule.action === 'replace' && rule.target?.entry_id === entryId)
    const domains = new Set(rules.map((rule) => rule.domain_id))
    const groups = new Map<string, string>()
    const effects: MigrationEffect[] = []
    for (const rule of rules) {
      if (rule.observed.normalize('NFC') === formal) {
        effects.push({ kind: 'remove', ruleId: rule.id, domainId: rule.domain_id, observed: rule.observed, currentOutput: rule.target?.text, formalName })
        continue
      }
      const key = `${rule.domain_id}\u0000${rule.observed.normalize('NFC')}\u0000${entryId}`
      const keptRuleId = groups.get(key)
      if (keptRuleId) {
        effects.push({ kind: 'consolidate', ruleId: rule.id, keptRuleId, domainId: rule.domain_id, observed: rule.observed, currentOutput: rule.target?.text, formalName })
        continue
      }
      groups.set(key, rule.id)
      if (rule.target?.text !== formalName) effects.push({ kind: 'update', ruleId: rule.id, domainId: rule.domain_id, observed: rule.observed, currentOutput: rule.target?.text, formalName })
    }
    for (const domainId of domains) for (const alias of migrationAliases(entryId)) {
      const key = `${domainId}\u0000${alias.normalize('NFC')}\u0000${entryId}`
      if (!groups.has(key)) effects.push({ kind: 'add_alias', domainId, observed: alias, formalName })
    }
    return effects
  }

  function beginFormalNameRename() {
    if (!snapshot?.dictionary) return
    migrationNames = Object.fromEntries(snapshot.dictionary.entries.map((entry) => [entry.id, entry.label]))
    renamingFormalNames = true
  }

  async function normalizeFormalNames() {
    if (!snapshot?.dictionary || (!snapshot.formal_name_migration.required && !renamingFormalNames)) return
    await run(() => api.normalizeFormalNames({
      transaction_id: crypto.randomUUID(),
      expected_revision: snapshot!.formal_name_migration.expected_revision,
      expected_sha256: snapshot!.formal_name_migration.expected_sha256,
      formal_names: migrationNames,
    }), t('已统一为正式名', 'Formal names are now applied'))
    renamingFormalNames = false
  }

  async function openDictionary() {
    try { const { path } = await api.dictionaryPath(); await api.openInEditor(path) }
    catch (value) { error = value instanceof Error ? value.message : String(value) }
  }

  async function openSource(path: string) {
    try { await api.openInEditor(path) }
    catch (value) { error = value instanceof Error ? value.message : String(value) }
  }

  onMount(() => { initializeAndRefresh() })
</script>

<svelte:head><title>{t('沟通词典', 'Conversation Dictionary')}</title></svelte:head>

<main>
  <header class="app-header">
    <div>
      <h1>{t('沟通词典', 'Conversation Dictionary')}</h1>
      <p>{t('整理你参与的沟通转写，经确认后按场景复用人名与术语。', 'Review transcription terms from conversations you participate in, then reuse them by context.')}</p>
    </div>
    {#if snapshot?.dictionary}<button class="secondary" onclick={openDictionary}>{t('打开词典', 'Open dictionary')}</button>{/if}
  </header>

  <nav class="tabs" aria-label={t('沟通词典页面', 'Dictionary sections')}>
    {#each [['pending', t('待确认', 'Review')], ['dictionary', t('词典', 'Dictionary')], ['history', t('历史', 'History')], ['settings', t('设置', 'Settings')]] as item}
      <button class:active={tab === item[0]} aria-current={tab === item[0] ? 'page' : undefined} onclick={() => tab = item[0] as Tab}>{item[1]}</button>
    {/each}
  </nav>

  {#if error}<div class="banner error" role="alert">{error}</div>{/if}
  {#if notice}<div class="banner success" role="status">{notice}</div>{/if}

  {#if snapshot?.dictionary && (snapshot.formal_name_migration.required || renamingFormalNames)}
    <section class="migration-panel" aria-labelledby="formal-name-migration-title">
      <h2 id="formal-name-migration-title">{snapshot.formal_name_migration.required ? t('确认正式名', 'Confirm formal names') : t('修改正式名', 'Edit formal names')}</h2>
      <p>{t('每个词条只有一个正式名。保存前请检查下面的完整影响：规则输出会更新；变成无操作的规则会移除；重复规则会保守合并；已有别称会在该词条现有场景中新增“只建议”归一规则。', 'Each entry has one formal name. Review the full impact below: outputs are updated, no-op rules are removed, duplicates are conservatively consolidated, and existing aliases gain suggest-only normalization rules in the entry’s current contexts.')}</p>
      <div class="migration-list">
        {#each snapshot.formal_name_migration.entries as entry}
          <article>
            <label><span>{t('正式名', 'Formal name')}</span><input value={migrationNames[entry.id] || ''} oninput={(event) => migrationNames = { ...migrationNames, [entry.id]: event.currentTarget.value }} /></label>
            <small>{entry.kind} · {entry.id}</small>
            <p><strong>{t('保存后的别称', 'Aliases after saving')}:</strong> {migrationAliases(entry.id).length ? migrationAliases(entry.id).join(' · ') : t('无', 'None')}</p>
            {#if migrationEffects(entry.id).length}
              <details open><summary>{t(`${migrationEffects(entry.id).length} 项规则变更`, `${migrationEffects(entry.id).length} rule changes`)}</summary>
                <ul>{#each migrationEffects(entry.id) as effect}<li>
                  {#if effect.kind === 'remove'}{t('移除无操作规则', 'Remove no-op rule')} <code>{effect.ruleId}</code>: <code>{effect.observed}</code>
                  {:else if effect.kind === 'consolidate'}{t('合并重复规则', 'Consolidate duplicate')} <code>{effect.ruleId}</code> → <code>{effect.keptRuleId}</code> ({t('只建议优先，任一停用则保持停用', 'suggest wins; any disabled stays disabled')})
                  {:else if effect.kind === 'add_alias'}{t('新增别称归一（只建议）', 'Add alias normalization (suggest)')} <code>{effect.observed}</code> → <code>{effect.formalName}</code> · <code>{effect.domainId}</code>
                  {:else}<code>{effect.ruleId}</code>: <code>{effect.currentOutput}</code> → <code>{effect.formalName}</code>{/if}
                </li>{/each}</ul>
              </details>
            {:else}<p class="muted">{t('没有规则需要改变', 'No rules need changes')}</p>
            {/if}
          </article>
        {/each}
      </div>
      <button class="primary" onclick={normalizeFormalNames} disabled={busy || Object.values(migrationNames).some((name) => !name.trim())}>{t('保存并统一为正式名', 'Save and apply formal names')}</button>
      {#if !snapshot.formal_name_migration.required}<button onclick={() => renamingFormalNames = false} disabled={busy}>{t('取消', 'Cancel')}</button>{/if}
    </section>
  {/if}

  {#if !snapshot}
    <div class="loading">{t('正在准备沟通词典…', 'Preparing Conversation Dictionary…')}</div>
  {:else if !snapshot.dictionary}
    {#if snapshot.status.status === 'not_created'}
      <section class="empty-state">
        <h2>{t('初始化尚未完成', 'Initialization is incomplete')}</h2>
        <p>{t('请检查当前 Vault 与作者身份，然后重试。词典不会使用手工填写的身份。', 'Check the current Vault and its author identity, then retry. The dictionary never uses a manually entered identity.')}</p>
        <button class="primary" onclick={initializeAndRefresh} disabled={busy}>{t('重试初始化', 'Retry initialization')}</button>
      </section>
    {:else}
      <section class="empty-state">
        <h2>{t('词典需要检查', 'Dictionary needs review')}</h2>
        <p>{snapshot.status.error || t('词典未通过可信基线检查。', 'The dictionary did not pass its reviewed baseline check.')}</p>
        <button onclick={openDictionary}>{t('打开词典检查', 'Open dictionary')}</button>
      </section>
    {/if}
  {:else if tab === 'pending'}
    <section class="import-bar">
      <div><h2>{t('历史整理', 'Historical review')}</h2><p>{t('导入生成 Skill 输出的 Vault 相对路径。正式词典在你确认前不会改变。', 'Import a Vault-relative dataset created by the generation skill. Nothing changes until you approve it.')}</p></div>
      <div class="import-controls"><input bind:value={datasetPath} placeholder="ssot/meetings/conversation-dictionary-drafts/…/dataset.yml" disabled={busy} /><button onclick={importDataset} disabled={busy || !datasetPath.trim()}>{t('导入', 'Import')}</button></div>
    </section>
    {#if snapshot.batches.length === 0}
      <section class="empty-state compact">
        <h3>{t('暂无历史整理批次', 'No review datasets')}</h3>
        <p>{t('运行 build-conversation-dictionary Skill 后，把生成的数据集导入这里。下方样例只用于说明，不会参与转写。', 'Run the build-conversation-dictionary skill, then import its dataset here. The example below is instructional and never affects transcription.')}</p>
        {#if snapshot.dictionary.domains.length === 0 && snapshot.dictionary.entries.length === 0 && snapshot.dictionary.rules.length === 0}
          <article class="teaching-example" aria-label={t('未启用的教学样例', 'Inactive teaching example')}>
            <div class="example-heading"><strong>{t('样例 · 未启用', 'Example · inactive')}</strong><span>{snapshot.example.domain.name}</span></div>
            <p><code>{snapshot.example.rule.observed}</code> → <code>{snapshot.example.rule.target?.text}</code></p>
            <small>{t('正式名', 'Formal name')}: {snapshot.example.entry.label} · {t('别称', 'Aliases')}: {aliases(snapshot.example.entry).join(' · ')} · {t('后续使用', 'Future use')}: {t('只建议', 'Suggest')}</small>
          </article>
        {/if}
      </section>
    {:else}
      <div class="review-layout">
        <aside class="batch-list">
          {#each snapshot.batches as batch}
            <button class:selected={selectedBatchId === batch.run_id} onclick={() => { selectedBatchId = batch.run_id; selected = new Set() }}>
              <strong>{batch.run_id.slice(0, 8)}</strong><span>{pendingProposals(batch).length} {t('项待确认', 'pending')}</span>
              <small>{batch.dataset.coverage.processed}/{batch.dataset.coverage.discovered} {t('份来源已处理', 'sources processed')}</small>
            </button>
          {/each}
        </aside>
        {#if currentBatch()}
          {@const batch = currentBatch()!}
          <section class="proposal-pane">
            <div class="batch-summary">
              <div><h2>{t('待审数据集', 'Review dataset')}</h2><p>{batch.dataset.state} · {batch.dataset.coverage.chunks_processed}/{batch.dataset.coverage.chunks_planned} chunks · {batch.dataset.conflicts.length} {t('个冲突', 'conflicts')}</p></div>
              <button onclick={() => selectSafe(batch)}>{t('选择可处理项', 'Select reviewable')}</button>
            </div>
            {#if batch.dataset.conflicts.length || batch.dataset.unresolved.length}
              <div class="unresolved-banner">
                <strong>{t('仍有需要单独处理的项目', 'Some items still need separate review')}</strong>
                <span>{t('它们不会随选中提案写入词典；请修订数据集后重新导入。', 'They are not written with selected proposals. Revise the dataset and import a new run.')}</span>
                <details><summary>{t('查看详情', 'View details')}</summary><pre>{JSON.stringify([...batch.dataset.conflicts, ...batch.dataset.unresolved], null, 2)}</pre></details>
              </div>
            {/if}
            <div class="proposal-list">
              {#each pendingProposals(batch) as proposal}
                {@const value = editValue(batch, proposal)}
                {@const cacheKey = proposalKey(batch, proposal.id)}
                <article class:selected={selected.has(proposal.id)}>
                  <label class="select-row"><input type="checkbox" checked={selected.has(proposal.id)} onchange={() => toggle(proposal.id)} /><strong>{proposal.kind.replaceAll('_', ' ')}</strong><span>{proposal.evidence_ids.length} {t('处证据', 'evidence')}</span></label>
                  {#if proposal.reason}<p class="reason">{proposal.reason}</p>{/if}
                  {#if proposal.evidence_ids.length}
                    <button class="evidence-toggle" onclick={() => toggleEvidence(batch, proposal)} disabled={loadingEvidence.has(cacheKey)}>
                      {loadingEvidence.has(cacheKey) ? t('载入中…', 'Loading…') : evidence[cacheKey] ? t('收起证据', 'Hide evidence') : t('查看证据', 'View evidence')}
                    </button>
                    {#if evidence[cacheKey]}
                      <div class="evidence-list">
                        {#each evidence[cacheKey] as item}
                          <blockquote>
                            <p>{item.excerpt || item.observed}</p>
                            <footer>
                              <span>{item.locator || item.source_id}</span>
                              {#if item.resource}<button onclick={() => openSource(item.resource)}>{t('打开原文', 'Open source')}</button>{/if}
                            </footer>
                            {#if item.communication?.basis?.detail}<small>{item.communication.basis.detail}</small>{/if}
                          </blockquote>
                        {/each}
                      </div>
                    {/if}
                  {/if}
                  {#if proposal.kind === 'create_domain'}
                    <label><span>{t('场景名称', 'Context name')}</span><input value={value.name || ''} oninput={(event) => setField(batch, proposal, 'name', event.currentTarget.value)} /></label>
                    <label><span>{t('说明', 'Description')}</span><input value={value.description || ''} oninput={(event) => setField(batch, proposal, 'description', event.currentTarget.value)} /></label>
                  {:else if proposal.kind === 'create_entry'}
                    <label><span>{t('正式名', 'Formal name')}</span><input value={value.label || ''} oninput={(event) => setFormalName(batch, proposal, event.currentTarget.value)} /></label>
                    <label><span>{t('正式名与别称（每行一个）', 'Formal name and aliases (one per line)')}</span><textarea rows="3" value={(value.forms || []).join('\n')} oninput={(event) => setEntryForms(batch, proposal, event.currentTarget.value)}></textarea></label>
                  {:else if proposal.kind === 'add_forms'}
                    <label><span>{t('新增别称（每行一个）', 'New aliases (one per line)')}</span><textarea rows="3" value={(value.forms || []).join('\n')} oninput={(event) => setField(batch, proposal, 'forms', parseLines(event.currentTarget.value))}></textarea></label>
                  {:else if proposal.kind === 'create_rule'}
                    <div class="reference-summary"><span>{t('生效场景', 'Context')}</span><strong>{describeRef(batch, value.domain_ref, 'domain')}</strong></div>
                    <label><span>{t('常见误识别', 'Observed transcription')}</span><input value={value.observed || ''} oninput={(event) => setField(batch, proposal, 'observed', event.currentTarget.value)} /></label>
                    {#if value.action === 'replace'}
                      <div class="reference-summary"><span>{t('目标词条', 'Target entry')}</span><strong>{describeRef(batch, value.target?.entry_ref, 'entry')}</strong></div>
                      <div class="reference-summary"><span>{t('统一输出正式名', 'Formal output')}</span><strong>{formalNameForRef(batch, value.target?.entry_ref)}</strong></div>
                      <label><span>{t('后续使用', 'Future use')}</span><select value={value.application || 'suggest'} onchange={(event) => setField(batch, proposal, 'application', event.currentTarget.value)}><option value="suggest">{t('只建议', 'Suggest')}</option><option value="automatic">{t('可自动应用', 'Automatic')}</option></select></label>
                    {:else}<p class="preserve">{t('在此场景始终保留这个写法', 'Always preserve this form in the selected context')}</p>{/if}
                  {/if}
                  {#if proposal.depends_on.length}<small>{t('依赖', 'Depends on')}: {proposal.depends_on.join(', ')}</small>{/if}
                </article>
              {/each}
            </div>
            <footer class="commit-bar"><span>{selectedWithDependencies(batch).length} {t('项更改（含依赖）', 'changes including dependencies')}</span><button class="primary" onclick={() => commitSelected(batch)} disabled={busy || selected.size === 0 || batch.dataset.conflicts.length > 0 || snapshot.formal_name_migration.required}>{t('保存选中的更改', 'Save selected changes')}</button></footer>
          </section>
        {/if}
      </div>
    {/if}
  {:else if tab === 'dictionary'}
    <section><div class="section-heading"><h2>{t('场景', 'Contexts')}</h2><button onclick={beginFormalNameRename} disabled={busy || snapshot.dictionary.entries.length === 0}>{t('修改正式名', 'Edit formal names')}</button></div><div class="cards">{#each snapshot.dictionary.domains as domain}<article><h3>{domain.name}</h3><p>{domain.description}</p><small>{domain.id}</small></article>{/each}</div></section>
    <section><h2>{t('词条与规则', 'Entries and rules')}</h2>{#each snapshot.dictionary.entries as entry}<article class="entry"><div><h3>{entry.label}</h3><p><strong>{t('别称', 'Aliases')}:</strong> {aliases(entry).length ? aliases(entry).join(' · ') : t('无', 'None')}</p><small>{entry.kind} · {entry.id}</small></div><ul>{#each snapshot.dictionary.rules.filter((rule) => rule.target?.entry_id === entry.id) as rule}<li><span class="rule-kind">{aliases(entry).some((alias) => alias.normalize('NFC') === rule.observed.normalize('NFC')) ? t('别称归一', 'Alias') : t('ASR 纠错', 'ASR correction')}</span> <code>{rule.observed}</code> → <code>{entry.label}</code> · {rule.application} · {snapshot.dictionary.domains.find((domain) => domain.id === rule.domain_id)?.name}</li>{/each}</ul></article>{/each}</section>
  {:else if tab === 'history'}
    <section><h2>{t('提交历史', 'Review history')}</h2><p>{t('当前版本', 'Current revision')}: {snapshot.dictionary.revision} · {snapshot.dictionary.updated_at}</p>{#each snapshot.batches as batch}<article class="history-row"><strong>{batch.run_id}</strong><span>{Object.values(batch.proposal_states).filter((state) => state.status === 'accepted').length} {t('项已接受', 'accepted')}</span><small>{batch.imported_at}</small></article>{/each}</section>
  {:else}
    <section><h2>{t('设置', 'Settings')}</h2><label><span>{t('词典路径', 'Dictionary path')}</span><input value={snapshot.settings.dictionary_path} readonly /></label><p class="muted">{t(`生成 Skill 已安装到 Vault 的 ${snapshot.agent_integration.skill_path}。`, `The generation skill is installed at ${snapshot.agent_integration.skill_path} in this Vault.`)}</p><p class="muted">{t(`调用说明由 ${snapshot.agent_integration.agents_path} 中的受管理区块提供。`, `Usage instructions are provided by the managed block in ${snapshot.agent_integration.agents_path}.`)}</p><button onclick={openDictionary}>{t('在编辑器中打开', 'Open in editor')}</button></section>
  {/if}
</main>

<style>
  :global(*){box-sizing:border-box} :global(body){margin:0;background:var(--ui-background,#f5f5f7);color:var(--ui-text,#1d1d1f);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif} button,input,select,textarea{font:inherit} button{border:1px solid var(--ui-border,#d0d0d5);border-radius:8px;background:var(--ui-control,#fff);color:inherit;padding:7px 12px;cursor:pointer} button:disabled{opacity:.5;cursor:default} button.primary{background:var(--ui-accent,#0a84ff);border-color:var(--ui-accent,#0a84ff);color:white} button.secondary{white-space:nowrap} main{min-height:100vh;padding:22px 26px}.app-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.app-header h1{font-size:25px;margin:0 0 4px}.app-header p{margin:0;color:var(--ui-text-secondary,#666);max-width:720px}.tabs{display:flex;gap:4px;border-bottom:1px solid var(--ui-border,#ddd);margin:20px 0}.tabs button{border:0;background:none;border-radius:6px 6px 0 0;padding:9px 14px;color:var(--ui-text-secondary,#666)}.tabs button.active{color:var(--ui-accent,#0a84ff);box-shadow:inset 0 -2px var(--ui-accent,#0a84ff)}.banner{padding:10px 12px;border-radius:8px;margin-bottom:12px}.banner.error{background:#ff3b3018;color:#c3271f}.banner.success{background:#34c75918;color:#217a37}section{background:var(--ui-surface,#fff);border:1px solid var(--ui-border,#ddd);border-radius:12px;padding:18px;margin-bottom:16px}section h2{margin:0 0 10px;font-size:18px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.section-heading h2{margin:0}label{display:grid;gap:5px;margin:10px 0}label span{font-size:12px;color:var(--ui-text-secondary,#666)}input,select,textarea{width:100%;border:1px solid var(--ui-border,#ccc);border-radius:7px;background:var(--ui-input,#fff);color:inherit;padding:8px 9px}textarea{resize:vertical}.empty-state{max-width:640px;margin:50px auto;text-align:left}.empty-state.compact{margin:20px auto}.teaching-example{margin-top:14px;border:1px dashed var(--ui-border,#ccc);border-radius:10px;padding:13px;background:var(--ui-selection,#0a84ff0a)}.teaching-example p{margin:10px 0}.example-heading{display:flex;justify-content:space-between;gap:12px}.example-heading span,.teaching-example small{color:var(--ui-text-secondary,#666)}.migration-panel{border-color:#ff9f0a;background:#ff9f0a0d}.migration-panel>p{color:var(--ui-text-secondary,#666)}.migration-panel>button+button{margin-left:8px}.migration-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;margin:14px 0}.migration-list article{border:1px solid var(--ui-border,#ddd);border-radius:9px;padding:10px;background:var(--ui-surface,#fff)}.migration-list p{font-size:13px}.migration-list ul{margin:7px 0;padding-left:18px}.rule-kind{display:inline-block;font-size:11px;color:var(--ui-text-secondary,#666);margin-right:4px}.import-bar{display:flex;align-items:flex-end;justify-content:space-between;gap:22px}.import-bar p,.batch-summary p{margin:4px 0;color:var(--ui-text-secondary,#666)}.import-controls{display:flex;gap:8px;min-width:min(480px,50%)}.review-layout{display:grid;grid-template-columns:230px 1fr;gap:14px}.batch-list{display:flex;flex-direction:column;gap:7px}.batch-list button{text-align:left;display:grid;gap:3px;background:transparent}.batch-list button.selected{background:var(--ui-selection,#0a84ff18);border-color:var(--ui-accent,#0a84ff)}.batch-list span,.batch-list small{color:var(--ui-text-secondary,#666)}.proposal-pane{padding:0;overflow:hidden}.batch-summary,.commit-bar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 18px}.unresolved-banner{margin:0 18px 12px;padding:10px 12px;border-radius:8px;background:#ff9f0a18;color:#7a4c00;display:grid;gap:3px;font-size:13px}.unresolved-banner details{margin-top:4px}.unresolved-banner pre{max-height:180px;overflow:auto;white-space:pre-wrap;color:inherit}.proposal-list{border-top:1px solid var(--ui-border,#ddd);border-bottom:1px solid var(--ui-border,#ddd);max-height:510px;overflow:auto;padding:10px}.proposal-list article{border:1px solid var(--ui-border,#ddd);border-radius:10px;padding:12px;margin-bottom:9px}.proposal-list article.selected{border-color:var(--ui-accent,#0a84ff);background:var(--ui-selection,#0a84ff0f)}.select-row{display:flex;align-items:center;gap:9px;margin:0}.select-row input{width:auto}.select-row span{margin-left:auto}.reason{font-size:13px;color:var(--ui-text-secondary,#666)}.reference-summary{display:grid;gap:3px;margin:10px 0;padding:8px 9px;border-radius:7px;background:var(--ui-selection,#0a84ff0a)}.reference-summary span{font-size:12px;color:var(--ui-text-secondary,#666)}.reference-summary strong{font-size:13px}.evidence-toggle{margin:0 0 6px;padding:4px 8px;font-size:12px}.evidence-list{display:grid;gap:7px;margin:4px 0 10px}.evidence-list blockquote{margin:0;padding:9px 10px;border-left:3px solid var(--ui-accent,#0a84ff);background:var(--ui-selection,#0a84ff0a);border-radius:0 7px 7px 0}.evidence-list p{margin:0 0 6px;white-space:pre-wrap}.evidence-list footer{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--ui-text-secondary,#666);font-size:12px}.evidence-list footer button{padding:3px 7px}.evidence-list small{display:block;margin-top:5px;color:var(--ui-text-secondary,#666)}.preserve{font-size:13px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}.cards article,.entry,.history-row{border:1px solid var(--ui-border,#ddd);border-radius:9px;padding:12px}.cards h3,.entry h3{margin:0 0 5px}.cards p,.entry p{margin:0 0 5px}.entry{display:grid;grid-template-columns:minmax(180px,1fr) 2fr;gap:16px;margin-bottom:9px}.entry ul{margin:0;padding-left:20px}.history-row{display:grid;grid-template-columns:1fr auto auto;gap:14px;margin-bottom:8px}.muted{color:var(--ui-text-secondary,#666)}.loading{padding:60px;text-align:center}
  @media(max-width:760px){main{padding:16px}.app-header{display:block}.app-header button{margin-top:12px}.import-bar{display:block}.import-controls{min-width:0;width:100%}.review-layout{grid-template-columns:1fr}.batch-list{flex-direction:row;overflow:auto}.batch-list button{min-width:190px}.entry{grid-template-columns:1fr}.history-row{grid-template-columns:1fr}.commit-bar{position:sticky;bottom:0;background:var(--ui-surface,#fff)}}
</style>
