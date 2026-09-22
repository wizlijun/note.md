<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onMount } from 'svelte'
  import { api } from './lib/bridge'
  import type { DatasetProposal, Entry, ReviewBatch, Snapshot } from './lib/types'

  type Tab = 'pending' | 'dictionary' | 'history' | 'settings'
  let tab: Tab = 'dictionary'
  let snapshot: Snapshot | null = null
  let busy = false
  let initializationError = ''
  let error = ''
  let notice = ''
  let disposed = false
  let datasetPath = ''
  let selectedBatchId = ''
  let selected = new Set<string>()
  let edited: Record<string, Record<string, any>> = {}
  let evidence: Record<string, Array<Record<string, any>>> = {}
  let loadingEvidence = new Set<string>()
  let migrationNames: Record<string, string> = {}
  let renamingFormalNames = false
  let batchMenu: { runId: string; x: number; y: number } | null = null
  let selectedDomainId = ''
  let selectedEntryId = ''
  let addingDomain = false
  let addingSharedEntry = false
  let newDomainName = ''
  let correctionDraft = { kind: 'other', formalName: '', aliases: '', mistakenForms: '' }

  let savedDraft = JSON.stringify(correctionDraft)
  let draggingEntry: { entryId: string; sourceDomainId: string } | null = null
  let dropDomainId = ''
  let dragPress: { entryId: string; sourceDomainId: string; pointerId: number; x: number; y: number; element: HTMLElement } | null = null
  let dragX = 0
  let dragY = 0
  let suppressDragClick = false
  let moveTargetId = ''
  let needsReload = false
  let pendingSelection: { domainId?: string; entryId: string } | null = null
  let merging = false
  let mergeSearch = ''
  let mergeTargetId = ''

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
  const hasAcceptedProposals = (batch: ReviewBatch) => Object.values(batch.proposal_states).some((state) => state.status === 'accepted')
  const proposalKey = (batch: ReviewBatch, proposalId: string) => `${batch.run_id}\u0000${proposalId}`

  function dictionaryDomains() {
    const domains = snapshot?.dictionary?.domains || []
    return [{ id: 'public', name: t('public（公共）', 'public (Shared)'), description: '' }, ...domains.filter((domain) => domain.id !== 'public')]
  }

  function entriesForDomain(domainId: string): Entry[] {
    return snapshot?.dictionary?.entries.filter((entry) => contextIdsForEntry(entry.id).includes(domainId)) || []
  }

  function contextIdsForEntry(entryId: string): string[] {
    if (!snapshot?.dictionary) return []
    const ids = new Set([
      ...(snapshot.dictionary.entry_domains?.[entryId] || []),
      ...snapshot.dictionary.rules
        .filter((rule) => rule.action === 'replace' && rule.target?.entry_id === entryId)
        .map((rule) => rule.domain_id),
    ])
    return ids.size ? [...ids] : ['public']
  }

  function mergeTargets() {
    const query = mergeSearch.trim().toLocaleLowerCase()
    return snapshot?.dictionary?.entries.filter((entry) => entry.id !== selectedEntryId &&
      (!query || [entry.label, ...entry.forms].some((name) => name.toLocaleLowerCase().includes(query)))) || []
  }

  function canDiscardDraft() {
    return (JSON.stringify(correctionDraft) === savedDraft && !(addingDomain && newDomainName.trim())) || window.confirm(t('当前词条有未保存的修改。放弃修改并继续？', 'Discard unsaved changes to this entry and continue?'))
  }

  function resetEntryActions() {
    merging = false; mergeSearch = ''; mergeTargetId = ''; moveTargetId = ''
  }

  function unattachedEntries(domainId: string): Entry[] {
    const attached = new Set(entriesForDomain(domainId).map((entry) => entry.id))
    return snapshot?.dictionary?.entries.filter((entry) => !attached.has(entry.id)) || []
  }

  function preserveRules(domainId: string) {
    return snapshot?.dictionary?.rules.filter((rule) => rule.domain_id === domainId && rule.action === 'preserve') || []
  }

  function parseDelimited(value: string): string[] {
    const seen = new Set<string>()
    return value.split(/[,，;；\r\n]+/).map((part) => part.trim()).filter((part) => {
      const key = part.normalize('NFC')
      if (!part || seen.has(key)) return false
      seen.add(key); return true
    })
  }

  function loadCorrectionDraft(entryId: string) {
    resetEntryActions()
    const dictionary = snapshot?.dictionary
    const entry = dictionary?.entries.find((item) => item.id === entryId)
    if (!dictionary || !entry) {
      correctionDraft = { kind: 'other', formalName: '', aliases: '', mistakenForms: '' }
      savedDraft = JSON.stringify(correctionDraft)
      return
    }
    const entryAliases = aliases(entry)
    const aliasKeys = new Set(entryAliases.map((value) => value.normalize('NFC')))
    const mistaken = dictionary.rules
      .filter((rule) => rule.domain_id === selectedDomainId && rule.action === 'replace' && rule.target?.entry_id === entryId)
      .map((rule) => rule.observed)
      .filter((value) => !aliasKeys.has(value.normalize('NFC')))
    correctionDraft = {
      kind: entry.kind,
      formalName: entry.label,
      aliases: entryAliases.join('，'),
      mistakenForms: mistaken.join('，'),
    }
    savedDraft = JSON.stringify(correctionDraft)
  }

  function selectDomain(domainId: string) {
    if (busy || !canDiscardDraft()) return
    selectedDomainId = domainId
    addingDomain = false
    addingSharedEntry = false
    newDomainName = ''
    selectedEntryId = entriesForDomain(domainId)[0]?.id || ''
    loadCorrectionDraft(selectedEntryId)
  }

  function selectEntry(entryId: string) {
    if (busy || !canDiscardDraft()) return
    addingSharedEntry = false
    selectedEntryId = entryId
    loadCorrectionDraft(entryId)
  }

  function beginNewDomain() {
    if (busy || !canDiscardDraft()) return
    resetEntryActions()
    addingDomain = true
    addingSharedEntry = false
    selectedDomainId = ''
    selectedEntryId = ''
    newDomainName = ''
    correctionDraft = { kind: 'other', formalName: '', aliases: '', mistakenForms: '' }
    savedDraft = JSON.stringify(correctionDraft)
  }

  function beginNewEntry() {
    if (busy || !canDiscardDraft()) return
    resetEntryActions()
    addingDomain = false
    addingSharedEntry = false
    selectedEntryId = ''
    correctionDraft = { kind: 'other', formalName: '', aliases: '', mistakenForms: '' }
    savedDraft = JSON.stringify(correctionDraft)
  }

  function beginAddSharedEntry() {
    if (busy || !canDiscardDraft()) return
    resetEntryActions()
    addingDomain = false
    addingSharedEntry = true
    selectedEntryId = ''
    correctionDraft = { kind: 'other', formalName: '', aliases: '', mistakenForms: '' }
    savedDraft = JSON.stringify(correctionDraft)
  }

  function selectSharedEntry(entryId: string) {
    if (busy || !canDiscardDraft()) return
    selectedEntryId = entryId
    loadCorrectionDraft(entryId)
  }

  function ensureDictionarySelection() {
    if (!snapshot?.dictionary || addingDomain) return
    if (!selectedDomainId || !dictionaryDomains().some((domain) => domain.id === selectedDomainId)) {
      selectedDomainId = 'public'
    }
    const entries = entriesForDomain(selectedDomainId)
    if (selectedEntryId && entries.some((entry) => entry.id === selectedEntryId)) loadCorrectionDraft(selectedEntryId)
    else if (entries.length) { selectedEntryId = entries[0].id; loadCorrectionDraft(selectedEntryId) }
    else { selectedEntryId = ''; loadCorrectionDraft('') }
  }

  async function refresh(preserveDraft = true) {
    const before = preserveDraft ? edited : {}
    snapshot = await api.bootstrap()
    if (pendingSelection) {
      selectedDomainId = pendingSelection.domainId || selectedDomainId
      selectedEntryId = pendingSelection.entryId
      addingDomain = false; addingSharedEntry = false; newDomainName = ''
      pendingSelection = null
    }
    needsReload = false
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
    ensureDictionarySelection()
  }

  async function refreshCommitted(selection: { domainId?: string; entryId: string }) {
    pendingSelection = selection
    try { await refresh(false) }
    catch { needsReload = true; throw new Error(t('更改已保存，但重新加载失败。请点击“重新加载”后继续。', 'Changes were saved, but reloading failed. Reload before continuing.')) }
  }

  async function reloadDictionary() {
    if (busy) return
    busy = true; error = ''
    try { await refresh(false) }
    catch (value) { error = value instanceof Error ? value.message : String(value) }
    finally { busy = false }
  }

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return
    busy = true; error = ''; notice = ''
    try { await action(); await refresh(); notice = success; await api.toast('success', success) }
    catch (value) { error = value instanceof Error ? value.message : String(value) }
    finally { busy = false }
  }

  async function initializeWhenIdentityIsReady() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (disposed) return null
      const result = await api.initialize()
      if (disposed) return null
      if (result.status !== 'pending') return result
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(t('Host 身份服务未在预期时间内就绪', 'The Host identity service did not become ready in time'))
  }

  async function initializeAndRefresh() {
    if (busy) return
    busy = true; error = ''; notice = ''
    try {
      const result = await initializeWhenIdentityIsReady()
      if (!result || disposed) return
      await refresh(false)
      initializationError = ''
      if (result.dictionary_created) notice = t('沟通转写勘误已为当前 Vault 准备好', 'Conversation Transcript Corrections is ready for this Vault')
    } catch (value) {
      if (disposed) return
      initializationError = value instanceof Error ? value.message : String(value)
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

  function selectAll(batch: ReviewBatch) {
    selected = new Set(pendingProposals(batch).map((proposal) => proposal.id))
  }

  function invertSelection(batch: ReviewBatch) {
    selected = new Set(pendingProposals(batch).map((proposal) => proposal.id).filter((id) => !selected.has(id)))
  }

  function conflictProposalIds(conflict: Record<string, any>): string[] {
    return [...(conflict.proposal_ids || []), ...(conflict.rule_or_proposal_ids || [])]
  }

  function selectedConflictCount(batch: ReviewBatch): number {
    const ids = new Set(selectedWithDependencies(batch))
    return batch.dataset.conflicts.filter((conflict) => conflictProposalIds(conflict as Record<string, any>).some((id) => ids.has(id))).length
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
    const ids = selectedWithDependencies(batch)
    if (!ids.length || selectedConflictCount(batch)) return
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
    }), t(`已审批通过 ${ids.length} 项并加入勘误表`, `Approved ${ids.length} items and added them to Corrections`))
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

  async function saveCorrectionEntry() {
    if (!snapshot?.dictionary || snapshot.formal_name_migration.required || busy) return
    busy = true; error = ''; notice = ''
    try {
      const result = await api.saveCorrectionEntry({
        transaction_id: crypto.randomUUID(),
        expected_revision: snapshot.formal_name_migration.expected_revision,
        expected_sha256: snapshot.formal_name_migration.expected_sha256,
        domain_id: addingDomain ? null : selectedDomainId,
        domain_name: addingDomain ? newDomainName.trim() : (dictionaryDomains().find((domain) => domain.id === selectedDomainId)?.name || ''),
        entry_id: selectedEntryId || null,
        kind: correctionDraft.kind,
        formal_name: correctionDraft.formalName.trim(),
        aliases: parseDelimited(correctionDraft.aliases),
        mistaken_forms: parseDelimited(correctionDraft.mistakenForms),
      })
      await refreshCommitted({ domainId: result.domain_id, entryId: result.entry_id })
      notice = t('词条已保存', 'Entry saved')
      await api.toast('success', notice)
    } catch (value) { error = value instanceof Error ? value.message : String(value) }
    finally { busy = false }
  }

  // Tauri intercepts HTML5 drag/drop in plugin windows. Use pointer events for internal moves.
  function beginEntryDrag(event: PointerEvent, entryId: string) {
    if (event.button !== 0 || event.isPrimary === false || busy || needsReload || snapshot?.formal_name_migration.required) return
    cancelEntryDrag()
    suppressDragClick = false
    dragPress = { entryId, sourceDomainId: selectedDomainId, pointerId: event.pointerId, x: event.clientX, y: event.clientY, element: event.currentTarget as HTMLElement }
  }

  function domainAtPoint(x: number, y: number): string {
    const button = document.elementFromPoint(x, y)?.closest<HTMLButtonElement>('[data-drop-domain]')
    return button && !button.disabled ? button.dataset.dropDomain || '' : ''
  }

  function moveEntryPointer(event: PointerEvent) {
    if (!dragPress || event.pointerId !== dragPress.pointerId) return
    if (!draggingEntry) {
      if (Math.hypot(event.clientX - dragPress.x, event.clientY - dragPress.y) < 6) return
      draggingEntry = { entryId: dragPress.entryId, sourceDomainId: dragPress.sourceDomainId }
      suppressDragClick = true
      dragPress.element.setPointerCapture(event.pointerId)
    }
    event.preventDefault()
    dragX = Math.min(event.clientX + 12, window.innerWidth - 180)
    dragY = event.clientY + 12
    const domainId = domainAtPoint(event.clientX, event.clientY)
    dropDomainId = domainId !== draggingEntry.sourceDomainId ? domainId : ''
  }

  async function finishEntryDrag(event: PointerEvent) {
    if (!dragPress || event.pointerId !== dragPress.pointerId) return
    const dragged = draggingEntry
    // Re-check the release point; the pointer may have left the last highlighted target.
    const targetDomainId = dragged ? domainAtPoint(event.clientX, event.clientY) : ''
    cancelEntryDrag()
    if (dragged && targetDomainId && targetDomainId !== dragged.sourceDomainId) {
      await moveEntry(dragged.entryId, dragged.sourceDomainId, targetDomainId, true)
    }
  }

  function cancelEntryDrag() {
    const press = dragPress
    dragPress = null; draggingEntry = null; dropDomainId = ''
    if (press?.element.hasPointerCapture(press.pointerId)) press.element.releasePointerCapture(press.pointerId)
  }

  function cancelEntryPointer(event: PointerEvent) {
    if (event.pointerId === dragPress?.pointerId) cancelEntryDrag()
  }

  function resetDragClick(event: PointerEvent) {
    if (event.isPrimary !== false) suppressDragClick = false
  }

  function suppressClickAfterDrag(event: MouseEvent) {
    if (!suppressDragClick || event.detail === 0) return
    suppressDragClick = false
    event.preventDefault(); event.stopImmediatePropagation()
  }

  async function moveEntry(entryId: string, sourceDomainId: string, targetDomainId: string, stayInSource = false) {
    if (!snapshot?.dictionary || busy || snapshot.formal_name_migration.required || !targetDomainId || sourceDomainId === targetDomainId) return
    if (!canDiscardDraft()) return
    const entries = entriesForDomain(sourceDomainId)
    const remaining = entries.filter((entry) => entry.id !== entryId)
    const nextEntryId = selectedEntryId !== entryId ? selectedEntryId
      : remaining[Math.min(entries.findIndex((entry) => entry.id === entryId), remaining.length - 1)]?.id || ''
    busy = true; error = ''; notice = ''
    try {
      await api.moveCorrectionEntry({
        transaction_id: crypto.randomUUID(),
        expected_revision: snapshot.formal_name_migration.expected_revision,
        expected_sha256: snapshot.formal_name_migration.expected_sha256,
        entry_id: entryId, source_domain_id: sourceDomainId, target_domain_id: targetDomainId,
      })
      await refreshCommitted(stayInSource
        ? { domainId: sourceDomainId, entryId: nextEntryId }
        : { domainId: targetDomainId, entryId })
      notice = t('词条已移入目标场景', 'Entry moved to the selected context')
    } catch (value) { error = value instanceof Error ? value.message : String(value) }
    finally { busy = false }
  }

  function beginMerge() {
    if (busy || !selectedEntryId) return
    merging = true; mergeSearch = ''; mergeTargetId = ''
  }

  async function mergeEntries() {
    const dictionary = snapshot?.dictionary
    const source = dictionary?.entries.find((entry) => entry.id === selectedEntryId)
    const target = dictionary?.entries.find((entry) => entry.id === mergeTargetId)
    if (!snapshot || !source || !target || busy || snapshot.formal_name_migration.required) return
    if (!canDiscardDraft()) return
    const count = new Set([...contextIdsForEntry(source.id), ...contextIdsForEntry(target.id)]).size
    if (!window.confirm(t(`将“${source.label}”合并到“${target.label}”？涉及 ${count} 个场景。保留目标词条，原正式名成为别名，相关规则统一输出“${target.label}”。`, `Merge “${source.label}” into “${target.label}” across ${count} contexts? Keep the target entry, retain the old formal name as an alias, and output “${target.label}” in related rules.`))) return
    busy = true; error = ''; notice = ''
    try {
      await api.mergeCorrectionEntries({
        transaction_id: crypto.randomUUID(),
        expected_revision: snapshot.formal_name_migration.expected_revision,
        expected_sha256: snapshot.formal_name_migration.expected_sha256,
        source_entry_id: source.id, target_entry_id: target.id,
      })
      await refreshCommitted({ entryId: target.id })
      notice = t(`已合并到“${target.label}”`, `Merged into “${target.label}”`)
    } catch (value) { error = value instanceof Error ? value.message : String(value) }
    finally { busy = false }
  }

  async function deleteCorrectionEntry(deleteGlobally: boolean) {
    const currentSnapshot = snapshot
    const dictionary = currentSnapshot?.dictionary
    const entry = dictionary?.entries.find((item) => item.id === selectedEntryId)
    if (!dictionary || !entry || busy) return
    const contexts = contextIdsForEntry(entry.id)
    const message = deleteGlobally
      ? t(`删除“${entry.label}”及其在 ${contexts.length} 个场景中的全部规则？`, `Delete “${entry.label}” and all of its rules in ${contexts.length} contexts?`)
      : t(`从当前场景移除“${entry.label}”？其他场景不会改变。`, `Remove “${entry.label}” from this context? Other contexts will not change.`)
    if (!window.confirm(message)) return
    busy = true; error = ''; notice = ''
    try {
      await api.deleteCorrectionEntry({
        transaction_id: crypto.randomUUID(),
        expected_revision: currentSnapshot.formal_name_migration.expected_revision,
        expected_sha256: currentSnapshot.formal_name_migration.expected_sha256,
        domain_id: selectedDomainId,
        entry_id: entry.id,
        delete_globally: deleteGlobally,
      })
      await refreshCommitted({ entryId: '' })
      notice = deleteGlobally ? t('词条已删除', 'Entry deleted') : t('已从当前场景移除', 'Removed from this context')
      await api.toast('success', notice)
    } catch (value) { error = value instanceof Error ? value.message : String(value) }
    finally { busy = false }
  }

  async function openDictionary() {
    try { const { path } = await api.dictionaryPath(); await api.openInEditor(path) }
    catch (value) { error = value instanceof Error ? value.message : String(value) }
  }

  async function openSource(path: string) {
    try { await api.openInEditor(path) }
    catch (value) { error = value instanceof Error ? value.message : String(value) }
  }

  function formatBatchTime(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    const pad = (part: number) => String(part).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function openBatchMenu(event: MouseEvent, batch: ReviewBatch) {
    event.preventDefault()
    if (hasAcceptedProposals(batch)) {
      batchMenu = null
      return
    }
    const width = 190
    const height = 42
    batchMenu = {
      runId: batch.run_id,
      x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - height - 6)),
    }
  }

  async function deleteBatch(runId: string) {
    batchMenu = null
    const batch = snapshot?.batches.find((item) => item.run_id === runId)
    if (!batch || hasAcceptedProposals(batch)) return
    if (!window.confirm(t(`删除 ${formatBatchTime(batch.imported_at)} 导入的待审数据集？`, `Delete the review dataset imported at ${formatBatchTime(batch.imported_at)}?`))) return
    for (const key of Object.keys(edited)) if (key.startsWith(`${runId}\u0000`)) delete edited[key]
    for (const key of Object.keys(evidence)) if (key.startsWith(`${runId}\u0000`)) delete evidence[key]
    selected = new Set()
    await run(() => api.deleteBatch(runId), t('待审数据集已删除', 'Review dataset deleted'))
  }

  onMount(() => {
    disposed = false
    initializeAndRefresh()
    window.addEventListener('click', suppressClickAfterDrag, true)
    window.addEventListener('pointerdown', resetDragClick, true)
    window.addEventListener('scroll', cancelEntryDrag, true)
    return () => {
      disposed = true
      cancelEntryDrag()
      window.removeEventListener('click', suppressClickAfterDrag, true)
      window.removeEventListener('pointerdown', resetDragClick, true)
      window.removeEventListener('scroll', cancelEntryDrag, true)
    }
  })
</script>

<svelte:window onclick={() => batchMenu = null}
  onpointermove={moveEntryPointer} onpointerup={finishEntryDrag} onpointercancel={cancelEntryPointer} onblur={cancelEntryDrag}
  onkeydown={(event) => { if (event.key === 'Escape') { batchMenu = null; cancelEntryDrag() } }} />

<svelte:head><title>{t('沟通转写勘误', 'Conversation Transcript Corrections')}</title></svelte:head>

<main>
  <header class="app-header">
    <div>
      <h1>{t('沟通转写勘误', 'Conversation Transcript Corrections')}</h1>
      <p>{t('整理你参与的沟通转写，经确认后按场景复用人名与术语。', 'Review transcription terms from conversations you participate in, then reuse them by context.')}</p>
    </div>
    {#if snapshot?.dictionary && !initializationError}<button class="secondary" onclick={openDictionary}>{t('打开勘误表', 'Open Corrections')}</button>{/if}
  </header>

  {#if !initializationError}
    <nav class="tabs" aria-label={t('沟通转写勘误页面', 'Conversation Transcript Corrections sections')}>
      {#each [['dictionary', t('勘误词典', 'Corrections Dictionary')], ['pending', t('待确认', 'Review')], ['history', t('历史', 'History')], ['settings', t('设置', 'Settings')]] as item}
        <button class:active={tab === item[0]} aria-current={tab === item[0] ? 'page' : undefined} onclick={() => tab = item[0] as Tab}>{item[1]}</button>
      {/each}
    </nav>
  {/if}

  {#if error}<div class="banner error" role="alert">{error}</div>{/if}
  {#if needsReload}<button onclick={reloadDictionary} disabled={busy}>{t('重新加载', 'Reload')}</button>{/if}
  {#if notice}<div class="banner success" role="status">{notice}</div>{/if}

  {#if snapshot?.dictionary && !initializationError && (snapshot.formal_name_migration.required || renamingFormalNames)}
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

  {#if initializationError}
    <section class="empty-state">
      <h2>{t('初始化未通过', 'Initialization failed')}</h2>
      <p role="alert">{initializationError}</p>
      <p>{t('请检查当前 Vault、可信基线与 Host 身份服务后重试。', 'Check the current Vault, reviewed baseline, and Host identity service, then retry.')}</p>
      <button class="primary" onclick={initializeAndRefresh} disabled={busy}>{t('重试初始化', 'Retry initialization')}</button>
    </section>
  {:else if !snapshot}
    <div class="loading">{t('正在准备沟通转写勘误…', 'Preparing Conversation Transcript Corrections…')}</div>
  {:else if !snapshot.dictionary}
    {#if snapshot.status.status === 'not_created'}
      <section class="empty-state">
        <h2>{t('初始化尚未完成', 'Initialization is incomplete')}</h2>
        <p>{t('请检查当前 Vault 与 Host 身份服务后重试。词典不会使用手工填写的身份。', 'Check the current Vault and Host identity service, then retry. The dictionary never uses a manually entered identity.')}</p>
        <button class="primary" onclick={initializeAndRefresh} disabled={busy}>{t('重试初始化', 'Retry initialization')}</button>
      </section>
    {:else}
      <section class="empty-state">
        <h2>{t('勘误词典需要检查', 'Corrections Dictionary needs review')}</h2>
        <p>{snapshot.status.error || t('勘误表未通过可信基线检查。', 'Corrections did not pass the reviewed baseline check.')}</p>
        <button onclick={openDictionary}>{t('打开勘误表检查', 'Open Corrections')}</button>
      </section>
    {/if}
  {:else if tab === 'pending'}
    <section class="import-bar">
      <div><h2>{t('历史整理', 'Historical review')}</h2><p>{t('导入生成 Skill 输出的 Vault 相对路径。勘误表在你确认前不会改变。', 'Import a Vault-relative dataset created by the generation skill. Corrections do not change until you approve them.')}</p></div>
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
            <button class:selected={selectedBatchId === batch.run_id} title={batch.run_id} onclick={() => { selectedBatchId = batch.run_id; selected = new Set() }} oncontextmenu={(event) => openBatchMenu(event, batch)}>
              <strong>{formatBatchTime(batch.imported_at)}</strong><span>{pendingProposals(batch).length} {t('项待确认', 'pending')}</span>
              <small>{batch.dataset.coverage.processed}/{batch.dataset.coverage.discovered} {t('份来源已处理', 'sources processed')} · {batch.run_id.slice(0, 8)}</small>
            </button>
          {/each}
        </aside>
        {#if currentBatch()}
          {@const batch = currentBatch()!}
          <section class="proposal-pane">
            <div class="batch-summary">
              <div><h2>{t('待审数据集', 'Review dataset')}</h2><p>{batch.dataset.state} · {batch.dataset.coverage.chunks_processed}/{batch.dataset.coverage.chunks_planned} chunks · {batch.dataset.conflicts.length} {t('个冲突', 'conflicts')}</p></div>
              <div class="selection-actions"><button onclick={() => selectAll(batch)}>{t('全选', 'Select all')}</button><button onclick={() => invertSelection(batch)}>{t('反选', 'Invert')}</button></div>
            </div>
            {#if batch.dataset.conflicts.length || batch.dataset.unresolved.length}
              <div class="unresolved-banner">
                <strong>{t('仍有需要单独处理的项目', 'Some items still need separate review')}</strong>
                <span>{t('未关联到所选提案的冲突不会阻止审批；若选中关联项，请修改选择或导入修订后的数据集。', 'Conflicts unrelated to the selection do not block approval. If a selected item is involved, revise the selection or import a corrected dataset.')}</span>
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
            <footer class="commit-bar"><div><span>{selectedWithDependencies(batch).length} {t('项待审批（含依赖）', 'items to approve including dependencies')}</span>{#if selectedConflictCount(batch)}<small class="blocking-reason">{t(`所选内容涉及 ${selectedConflictCount(batch)} 个未解决冲突`, `${selectedConflictCount(batch)} unresolved conflicts affect the selection`)}</small>{:else if snapshot.formal_name_migration.required}<small class="blocking-reason">{t('请先完成上方正式名确认', 'Confirm formal names above first')}</small>{/if}</div><button class="primary" onclick={() => commitSelected(batch)} disabled={busy || selected.size === 0 || selectedConflictCount(batch) > 0 || snapshot.formal_name_migration.required}>{t('审批通过并加入勘误表', 'Approve and add to Corrections')}</button></footer>
          </section>
        {/if}
      </div>
    {/if}
  {:else if tab === 'dictionary'}
    <fieldset class="dictionary-fieldset" disabled={needsReload}>
    <div class="dictionary-heading">
      <div><h2>{t('勘误词典', 'Corrections Dictionary')}</h2><p>{t('先选择沟通场景，再维护该场景中的词条。正式名和别名会在所有场景共用。', 'Choose a conversation context, then maintain its entries. Formal names and aliases are shared across contexts.')}</p></div>
      <button onclick={beginNewDomain} disabled={busy || snapshot.formal_name_migration.required}>{t('新增场景', 'New context')}</button>
    </div>
    <div class="dictionary-layout">
      <section class="dictionary-column context-column" aria-label={t('场景', 'Contexts')}>
        <div class="column-title"><strong>{t('场景', 'Contexts')}</strong><span>{dictionaryDomains().length}</span></div>
        <div class="dictionary-list">
          {#each dictionaryDomains() as domain}
            <button class:selected={!addingDomain && selectedDomainId === domain.id} class:drop-target={dropDomainId === domain.id}
              data-drop-domain={domain.id} disabled={busy} onclick={() => selectDomain(domain.id)}>
              <strong>{domain.name}</strong><small>{entriesForDomain(domain.id).length} {t('个词条', 'entries')}</small>
            </button>
          {/each}
          {#if addingDomain}<button class="selected draft-item"><strong>{t('新场景', 'New context')}</strong><small>{t('尚未保存', 'Not saved')}</small></button>{/if}
        </div>
        <p class="list-caption">{t('将词条拖到场景中即可移动。公共场景收纳尚未分配的词条。', 'Drag entries onto a context to move them. Public holds unassigned entries.')}</p>
      </section>

      <section class="dictionary-column entry-column" aria-label={t('词条', 'Entries')}>
        <div class="column-title"><strong>{t('词条', 'Entries')}</strong>{#if selectedDomainId}<div class="column-actions">{#if unattachedEntries(selectedDomainId).length}<button onclick={beginAddSharedEntry} disabled={busy || snapshot.formal_name_migration.required}>{t('添加已有', 'Add existing')}</button>{/if}<button onclick={beginNewEntry} disabled={busy || snapshot.formal_name_migration.required}>{t('新增', 'New')}</button></div>{/if}</div>
        {#if addingDomain}
          <div class="column-empty"><p>{t('保存第一个词条时会同时创建场景。', 'The context will be created with its first entry.')}</p></div>
        {:else if selectedDomainId}
          {#if addingSharedEntry}
            <div class="dictionary-list shared-entry-list">
              <small class="list-caption">{t('选择一个共享词条加入当前场景', 'Choose a shared entry for this context')}</small>
              {#each unattachedEntries(selectedDomainId) as entry}<button class:selected={selectedEntryId === entry.id} onclick={() => selectSharedEntry(entry.id)}><strong>{entry.label}</strong><small>{entry.kind} · {t('已用于', 'used in')} {contextIdsForEntry(entry.id).length} {t('个场景', 'contexts')}</small></button>{/each}
            </div>
          {:else}
            <div class="dictionary-list">
              {#each entriesForDomain(selectedDomainId) as entry}
                <button class="entry-drag-handle" class:selected={selectedEntryId === entry.id} class:dragging={draggingEntry?.entryId === entry.id} onclick={() => selectEntry(entry.id)}
                  draggable="false" ondragstart={(event) => event.preventDefault()} onpointerdown={(event) => beginEntryDrag(event, entry.id)}
                  onlostpointercapture={cancelEntryPointer} title={t('拖到左侧场景以移动词条', 'Drag to a context to move this entry')}>
                  <strong>{entry.label}</strong><small>{entry.kind} · {snapshot.dictionary.rules.filter((rule) => rule.domain_id === selectedDomainId && rule.target?.entry_id === entry.id).length} {t('条规则', 'rules')}</small>
                </button>
              {/each}
              {#if !selectedEntryId && correctionDraft.formalName === '' && entriesForDomain(selectedDomainId).length > 0}<button class="selected draft-item"><strong>{t('新词条', 'New entry')}</strong><small>{t('尚未保存', 'Not saved')}</small></button>{/if}
            </div>
          {/if}
          {#if entriesForDomain(selectedDomainId).length === 0 && selectedEntryId === '' && !addingSharedEntry}<div class="column-empty"><p>{t('这个场景还没有词条。', 'This context has no entries yet.')}</p><button class="primary" onclick={beginNewEntry}>{t('新增词条', 'New entry')}</button></div>{/if}
          {#if preserveRules(selectedDomainId).length}<details class="preserve-rules"><summary>{t(`保留规则 ${preserveRules(selectedDomainId).length}`, `${preserveRules(selectedDomainId).length} preserve rules`)}</summary><ul>{#each preserveRules(selectedDomainId) as rule}<li><code>{rule.observed}</code></li>{/each}</ul></details>{/if}
        {:else}<div class="column-empty"><p>{t('请先选择或新增场景。', 'Choose or create a context first.')}</p></div>{/if}
      </section>

      <section class="dictionary-column editor-column" aria-label={t('词条编辑', 'Entry editor')}>
        {#if addingSharedEntry && !selectedEntryId}
          <div class="editor-empty"><p>{t('从中间列表选择要加入当前场景的共享词条。', 'Choose a shared entry from the middle list.')}</p></div>
        {:else if addingDomain || selectedDomainId}
          <div class="editor-title">
            <div><strong>{addingSharedEntry ? t('添加共享词条', 'Add shared entry') : selectedEntryId ? t('编辑词条', 'Edit entry') : t('新增词条', 'New entry')}</strong>{#if selectedEntryId}<small>{selectedEntryId}</small>{/if}</div>
            <label class="kind-field"><span>{t('类型', 'Type')}</span><select bind:value={correctionDraft.kind} disabled={busy}><option value="person">{t('人物', 'Person')}</option><option value="product">{t('产品', 'Product')}</option><option value="organization">{t('组织', 'Organization')}</option><option value="project">{t('项目', 'Project')}</option><option value="acronym">{t('缩写', 'Acronym')}</option><option value="technical_term">{t('术语', 'Technical term')}</option><option value="other">{t('其他', 'Other')}</option></select></label>
          </div>
          {#if addingDomain}<label><span>{t('场景名称', 'Context name')}</span><input bind:value={newDomainName} placeholder={t('例如：产品周会', 'For example: Product weekly')} disabled={busy} /></label>{/if}
          <label><span>{t('正式名', 'Formal name')}</span><input bind:value={correctionDraft.formalName} placeholder={t('最终统一输出的写法', 'The final spelling used in output')} disabled={busy} /></label>
          <label><span>{t('别名', 'Aliases')}</span><input bind:value={correctionDraft.aliases} placeholder={t('用逗号或分号隔开，例如：Bruce，滔哥', 'Separate with commas or semicolons')} disabled={busy} /></label>
          <label><span>{t('可能的错误名', 'Possible transcription errors')}</span><input bind:value={correctionDraft.mistakenForms} placeholder={t('只用于当前场景，例如：伟涛；伟韬', 'Current context only; separate with commas or semicolons')} disabled={busy} /></label>
          <p class="editor-help">{t('正式名和别名属于同一个共享词条；可能的错误名只在当前场景生效。最终输出始终使用正式名。', 'The formal name and aliases belong to one shared entry. Possible errors apply only in this context. Output always uses the formal name.')}</p>
          <div class="editor-actions">
            <button class="primary" onclick={saveCorrectionEntry} disabled={busy || snapshot.formal_name_migration.required || (addingDomain && !newDomainName.trim()) || !correctionDraft.formalName.trim()}>{t('保存', 'Save')}</button>
            {#if selectedEntryId && !addingSharedEntry}<button onclick={beginMerge} disabled={busy || snapshot.formal_name_migration.required || snapshot.dictionary.entries.length < 2}>{t('合并到…', 'Merge into…')}</button>{/if}
            {#if selectedEntryId && contextIdsForEntry(selectedEntryId).includes(selectedDomainId) && contextIdsForEntry(selectedEntryId).length > 1}<button onclick={() => deleteCorrectionEntry(false)} disabled={busy}>{t('从当前场景移除', 'Remove from context')}</button>{/if}
            {#if selectedEntryId && contextIdsForEntry(selectedEntryId).includes(selectedDomainId)}<button class="danger-button" onclick={() => deleteCorrectionEntry(true)} disabled={busy}>{t('删除词条', 'Delete entry')}</button>{/if}
          </div>
          {#if selectedEntryId && contextIdsForEntry(selectedEntryId).includes(selectedDomainId)}
            <div class="move-controls">
              <label><span>{t('移动到场景', 'Move to context')}</span><select bind:value={moveTargetId} disabled={busy || snapshot.formal_name_migration.required}><option value="">{t('选择目标场景', 'Choose a context')}</option>{#each dictionaryDomains().filter((domain) => domain.id !== selectedDomainId) as domain}<option value={domain.id}>{domain.name}</option>{/each}</select></label>
              <button disabled={busy || !moveTargetId || snapshot.formal_name_migration.required} onclick={() => moveEntry(selectedEntryId, selectedDomainId, moveTargetId)}>{t('移动', 'Move')}</button>
            </div>
          {/if}
          {#if merging}
            <div class="merge-panel" role="region" aria-label={t('合并词条', 'Merge entries')}>
              <strong>{t('选择保留的目标词条', 'Choose the entry to keep')}</strong>
              <label><span>{t('搜索正式名或别名', 'Search formal name or alias')}</span><input bind:value={mergeSearch} oninput={() => mergeTargetId = ''} disabled={busy} /></label>
              <label><span>{t('合并到', 'Merge into')}</span><select bind:value={mergeTargetId} size={5} disabled={busy}><option value="" disabled>{t('选择目标词条', 'Choose target entry')}</option>{#each mergeTargets() as entry}<option value={entry.id}>{entry.label} · {entry.kind} · {contextIdsForEntry(entry.id).map((id) => dictionaryDomains().find((domain) => domain.id === id)?.name || id).join('、')} · {entry.id}</option>{/each}</select></label>
              {#if !mergeTargets().length}<p class="muted">{t('没有匹配的词条', 'No matching entries')}</p>{/if}
              <p class="editor-help">{t('保留目标词条的正式名和类型；合并两者的别名、场景和规则。当前词条的正式名将保留为别名。', 'Keep the target formal name and type. Combine aliases, contexts and rules; retain this formal name as an alias.')}</p>
              <div class="merge-actions"><button class="primary" onclick={mergeEntries} disabled={busy || !mergeTargetId}>{t('确认合并', 'Confirm merge')}</button><button onclick={() => merging = false} disabled={busy}>{t('取消', 'Cancel')}</button></div>
            </div>
          {/if}
          {#if snapshot.formal_name_migration.required}<p class="blocking-reason">{t('请先完成页面上方的正式名确认。', 'Confirm formal names above before editing.')}</p>{/if}
        {:else}<div class="editor-empty"><p>{t('选择左侧场景开始维护。', 'Choose a context to begin.')}</p></div>{/if}
      </section>
    </div>
    </fieldset>
  {:else if tab === 'history'}
    <section><h2>{t('提交历史', 'Review history')}</h2><p>{t('当前版本', 'Current revision')}: {snapshot.dictionary.revision} · {snapshot.dictionary.updated_at}</p>{#each snapshot.batches as batch}<article class="history-row"><strong>{batch.run_id}</strong><span>{Object.values(batch.proposal_states).filter((state) => state.status === 'accepted').length} {t('项已接受', 'accepted')}</span><small>{batch.imported_at}</small></article>{/each}</section>
  {:else}
    <section><h2>{t('设置', 'Settings')}</h2><label><span>{t('勘误表路径', 'Corrections path')}</span><input value={snapshot.settings.dictionary_path} readonly /></label><p class="muted">{t(`生成 Skill 已安装到 Vault 的 ${snapshot.agent_integration.skill_path}。`, `The generation skill is installed at ${snapshot.agent_integration.skill_path} in this Vault.`)}</p><p class="muted">{t(`调用说明由 ${snapshot.agent_integration.agents_path} 中的受管理区块提供。`, `Usage instructions are provided by the managed block in ${snapshot.agent_integration.agents_path}.`)}</p><button onclick={openDictionary}>{t('在编辑器中打开', 'Open in editor')}</button></section>
  {/if}
</main>

{#if draggingEntry}
  <div class="entry-drag-preview" aria-hidden="true" style={`left:${dragX}px;top:${dragY}px`}>{snapshot?.dictionary?.entries.find((entry) => entry.id === draggingEntry!.entryId)?.label}</div>
{/if}

{#if batchMenu}
  <div class="batch-context-menu menu-panel" role="menu" tabindex="-1" style={`left:${batchMenu.x}px;top:${batchMenu.y}px`}>
    <button class="batch-delete menu-row" role="menuitem" onclick={() => deleteBatch(batchMenu!.runId)}>{t('删除待审数据集', 'Delete review dataset')}</button>
  </div>
{/if}

<style>
  :global(*){box-sizing:border-box} :global(body){margin:0;background:var(--ui-background,#f5f5f7);color:var(--ui-text,#1d1d1f);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif} button,input,select,textarea{font:inherit} button{border:1px solid var(--ui-border,#d0d0d5);border-radius:8px;background:var(--ui-control,#fff);color:inherit;padding:7px 12px;cursor:pointer} button:disabled{opacity:.5;cursor:default} button.primary{background:var(--ui-accent,#0a84ff);border-color:var(--ui-accent,#0a84ff);color:white} button.secondary{white-space:nowrap} button.danger-button{color:var(--ui-danger,#b42318);margin-left:auto} main{min-height:100vh;padding:22px 26px}.app-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.app-header h1{font-size:25px;margin:0 0 4px}.app-header p{margin:0;color:var(--ui-text-secondary,#666);max-width:720px}.tabs{display:flex;gap:4px;border-bottom:1px solid var(--ui-border,#ddd);margin:20px 0}.tabs button{border:0;background:none;border-radius:6px 6px 0 0;padding:9px 14px;color:var(--ui-text-secondary,#666)}.tabs button.active{color:var(--ui-accent,#0a84ff);box-shadow:inset 0 -2px var(--ui-accent,#0a84ff)}.banner{padding:10px 12px;border-radius:8px;margin-bottom:12px}.banner.error{background:#ff3b3018;color:#c3271f}.banner.success{background:#34c75918;color:#217a37}section{background:var(--ui-surface,#fff);border:1px solid var(--ui-border,#ddd);border-radius:12px;padding:18px;margin-bottom:16px}section h2{margin:0 0 10px;font-size:18px}label{display:grid;gap:5px;margin:10px 0}label span{font-size:12px;color:var(--ui-text-secondary,#666)}input,select,textarea{width:100%;border:1px solid var(--ui-border,#ccc);border-radius:7px;background:var(--ui-input,#fff);color:inherit;padding:8px 9px}textarea{resize:vertical}.empty-state{max-width:640px;margin:50px auto;text-align:left}.empty-state.compact{margin:20px auto}.teaching-example{margin-top:14px;border:1px dashed var(--ui-border,#ccc);border-radius:10px;padding:13px;background:var(--ui-selection,#0a84ff0a)}.teaching-example p{margin:10px 0}.example-heading{display:flex;justify-content:space-between;gap:12px}.example-heading span,.teaching-example small{color:var(--ui-text-secondary,#666)}.migration-panel{border-color:#ff9f0a;background:#ff9f0a0d}.migration-panel>p{color:var(--ui-text-secondary,#666)}.migration-panel>button+button{margin-left:8px}.migration-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;margin:14px 0}.migration-list article{border:1px solid var(--ui-border,#ddd);border-radius:9px;padding:10px;background:var(--ui-surface,#fff)}.migration-list p{font-size:13px}.migration-list ul{margin:7px 0;padding-left:18px}.import-bar{display:flex;align-items:flex-end;justify-content:space-between;gap:22px}.import-bar p,.batch-summary p{margin:4px 0;color:var(--ui-text-secondary,#666)}.import-controls{display:flex;gap:8px;min-width:min(480px,50%)}.review-layout{display:grid;grid-template-columns:230px 1fr;gap:14px}.batch-list{display:flex;flex-direction:column;gap:7px}.batch-list button{text-align:left;display:grid;gap:3px;background:transparent}.batch-list button.selected{background:var(--ui-selection,#0a84ff18);border-color:var(--ui-accent,#0a84ff)}.batch-list span,.batch-list small{color:var(--ui-text-secondary,#666)}.proposal-pane{padding:0;overflow:hidden}.batch-summary,.commit-bar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 18px}.selection-actions{display:flex;gap:7px}.commit-bar>div{display:grid;gap:3px}.blocking-reason{color:var(--ui-danger,#b42318)}.unresolved-banner{margin:0 18px 12px;padding:10px 12px;border-radius:8px;background:#ff9f0a18;color:#7a4c00;display:grid;gap:3px;font-size:13px}.unresolved-banner details{margin-top:4px}.unresolved-banner pre{max-height:180px;overflow:auto;white-space:pre-wrap;color:inherit}.proposal-list{border-top:1px solid var(--ui-border,#ddd);border-bottom:1px solid var(--ui-border,#ddd);max-height:510px;overflow:auto;padding:10px}.proposal-list article{border:1px solid var(--ui-border,#ddd);border-radius:10px;padding:12px;margin-bottom:9px}.proposal-list article.selected{border-color:var(--ui-accent,#0a84ff);background:var(--ui-selection,#0a84ff0f)}.select-row{display:flex;align-items:center;gap:9px;margin:0}.select-row input{width:auto}.select-row span{margin-left:auto}.reason{font-size:13px;color:var(--ui-text-secondary,#666)}.reference-summary{display:grid;gap:3px;margin:10px 0;padding:8px 9px;border-radius:7px;background:var(--ui-selection,#0a84ff0a)}.reference-summary span{font-size:12px;color:var(--ui-text-secondary,#666)}.reference-summary strong{font-size:13px}.evidence-toggle{margin:0 0 6px;padding:4px 8px;font-size:12px}.evidence-list{display:grid;gap:7px;margin:4px 0 10px}.evidence-list blockquote{margin:0;padding:9px 10px;border-left:3px solid var(--ui-accent,#0a84ff);background:var(--ui-selection,#0a84ff0a);border-radius:0 7px 7px 0}.evidence-list p{margin:0 0 6px;white-space:pre-wrap}.evidence-list footer{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--ui-text-secondary,#666);font-size:12px}.evidence-list footer button{padding:3px 7px}.evidence-list small{display:block;margin-top:5px;color:var(--ui-text-secondary,#666)}.preserve{font-size:13px}.history-row{border:1px solid var(--ui-border,#ddd);border-radius:9px;padding:12px;display:grid;grid-template-columns:1fr auto auto;gap:14px;margin-bottom:8px}.dictionary-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:12px}.dictionary-heading h2{margin:0 0 4px;font-size:20px}.dictionary-heading p{margin:0;color:var(--ui-text-secondary,#666)}.dictionary-layout{display:grid;grid-template-columns:minmax(180px,1fr) minmax(210px,1.15fr) minmax(360px,2fr);gap:12px;align-items:stretch}.dictionary-column{padding:0;margin:0;min-height:440px;overflow:hidden}.column-title{min-height:49px;padding:12px 14px;border-bottom:1px solid var(--ui-border,#ddd);display:flex;align-items:center;justify-content:space-between;gap:8px}.column-title>span{color:var(--ui-text-secondary,#666);font-size:12px}.column-title button{padding:4px 8px}.column-actions{display:flex;gap:5px}.dictionary-list{display:grid;padding:8px;gap:4px}.dictionary-list>button{display:grid;gap:3px;text-align:left;border-color:transparent;background:transparent;padding:9px 10px}.dictionary-list>button small{color:var(--ui-text-secondary,#666)}.dictionary-list>button.selected{border-color:var(--ui-accent,#0a84ff);background:var(--ui-selection,#0a84ff12)}.dictionary-list>button.draft-item{border-style:dashed}.list-caption{padding:4px 10px;color:var(--ui-text-secondary,#666)}.preserve-rules{margin:6px 14px 14px;color:var(--ui-text-secondary,#666);font-size:12px}.preserve-rules ul{margin:7px 0;padding-left:20px}.column-empty,.editor-empty{padding:18px;color:var(--ui-text-secondary,#666)}.column-empty p,.editor-empty p{margin:0 0 12px}.editor-column{padding:16px 18px}.editor-title{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}.editor-title>div{display:grid;gap:3px}.editor-title small{color:var(--ui-text-secondary,#666)}.kind-field{display:flex;align-items:center;gap:8px;margin:0}.kind-field select{width:auto;min-width:130px}.editor-help{font-size:12px;line-height:1.5;color:var(--ui-text-secondary,#666);margin:12px 0 16px}.editor-actions{display:flex;align-items:center;gap:8px;border-top:1px solid var(--ui-border,#ddd);padding-top:14px}.muted{color:var(--ui-text-secondary,#666)}.loading{padding:60px;text-align:center}.batch-context-menu{position:fixed;z-index:1000;min-width:184px}.batch-context-menu .batch-delete{width:100%;border:0;background:transparent;text-align:left;color:var(--ui-danger,#b42318)}.batch-context-menu .batch-delete:hover{background:#d44a4a;color:#fff}
  .dictionary-fieldset{border:0;padding:0;margin:0;min-width:0}
  .dictionary-list>button.drop-target{outline:2px solid var(--ui-accent,#0a84ff);background:var(--ui-selection,#0a84ff18)}
  .dictionary-list>button.entry-drag-handle{cursor:grab;user-select:none;-webkit-user-select:none;-webkit-user-drag:none;touch-action:none}
  .dictionary-list>button.dragging{opacity:.55;cursor:grabbing}
  .entry-drag-preview{position:fixed;z-index:1100;pointer-events:none;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--ui-surface,#fff);border:1px solid var(--ui-accent,#0a84ff);box-shadow:0 5px 18px #0002;border-radius:8px;padding:8px 12px}
  .move-controls{display:flex;align-items:flex-end;gap:8px;margin-top:14px}.move-controls label{flex:1;margin:0}
  .merge-panel{border:1px solid var(--ui-border,#ddd);border-radius:9px;padding:14px;margin-top:16px}.merge-actions{display:flex;gap:8px}
  .editor-actions{flex-wrap:wrap}
  @media(max-width:900px){.dictionary-layout{grid-template-columns:1fr 1fr}.editor-column{grid-column:1/-1;min-height:0}}
  @media(max-width:760px){main{padding:16px}.app-header{display:block}.app-header button{margin-top:12px}.import-bar{display:block}.import-controls{min-width:0;width:100%}.review-layout{grid-template-columns:1fr}.batch-list{flex-direction:row;overflow:auto}.batch-list button{min-width:190px}.history-row{grid-template-columns:1fr}.commit-bar{position:sticky;bottom:0;background:var(--ui-surface,#fff)}.dictionary-heading{align-items:flex-start}.dictionary-layout{grid-template-columns:1fr}.dictionary-column{min-height:0}.editor-column{grid-column:auto}.editor-actions{flex-wrap:wrap}button.danger-button{margin-left:0}}
</style>
