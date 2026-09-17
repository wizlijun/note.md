<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onDestroy, onMount } from 'svelte'
  import DetailPane from './components/DetailPane.svelte'
  import DiagnosticsView from './components/DiagnosticsView.svelte'
  import RecordList from './components/RecordList.svelte'
  import RelationGraph from './components/RelationGraph.svelte'
  import TimelineView, { type TimelineEntry } from './components/TimelineView.svelte'
  import {
    copyText, onFileViewOpen, openEditor, vaultInfo, vaultRead, vaultReadBytes,
  } from './lib/bridge'
  import { relationParticipants } from './lib/indexes'
  import { buildViewRecords, evidenceLabel, relationStatement, sourceLabel, type ViewRecord } from './lib/normalizer'
  import { serializeKnowledgeReference } from './lib/navigation'
  import { parseDatasetAsync } from './lib/worker-client'
  import { queryRecords } from './lib/query'
  import { locateQuote, parseSourceLocation, resolveSourceUri } from './lib/source-resolver'
  import { parseTimeValue } from './lib/time'
  import { CURRENT_DATASET_SCHEMA, LEGACY_DATASET_SCHEMA } from './lib/types'
  import type { Diagnostic, Evidence, KnowledgeKind, ParseResult, Relation, Source } from './lib/types'

  type Category = KnowledgeKind | 'all' | 'sources' | 'evidence'
  type Mode = 'reading' | 'relations' | 'timeline' | 'diagnostics'
  type TimeDimension = 'event' | 'valid' | 'source' | 'system'

  const zh = (window.notemd?.locale ?? navigator.language).startsWith('zh')
  const table: Record<string, [string, string]> = {
    'product': ['提取知识浏览器', 'Knowledge Browser'],
    'loading': ['正在解析与建立索引…', 'Parsing and indexing…'],
    'search': ['搜索当前数据集…', 'Search this dataset…'], 'filters': ['筛选', 'Filters'],
    'empty.dataset': ['当前 JSON 不是可识别的 v3 知识数据集。', 'The current JSON is not a recognized v3 knowledge dataset.'],
    'entry.viewer': ['知识文件视图', 'Knowledge file view'],
    'scope': ['研究范围', 'Research scope'], 'questions': ['研究问题', 'Research questions'], 'selection': ['提取门槛', 'Selection'],
    'action.openEditor': ['在编辑器打开', 'Open in editor'],
    'action.copyReference': ['复制知识引用', 'Copy knowledge reference'], 'action.copyRaw': ['复制原始对象', 'Copy raw object'],
    'action.readSource': ['读取原文片段', 'Read source excerpt'], 'action.openRecord': ['打开对象', 'Open record'],
    'action.retry': ['重试', 'Retry'], 'action.close': ['关闭', 'Close'], 'action.back': ['返回上一对象', 'Back to previous record'],
    'copied': ['已复制', 'Copied'],
    'mode.reading': ['阅读', 'Reading'], 'mode.relations': ['关系', 'Relations'], 'mode.timeline': ['时间', 'Time'], 'mode.diagnostics': ['诊断', 'Diagnostics'],
    'kind.all': ['全部知识', 'All knowledge'], 'kind.entities': ['实体', 'Entities'], 'kind.concepts': ['概念', 'Concepts'], 'kind.claims': ['主张', 'Claims'],
    'kind.events': ['事件', 'Events'], 'kind.narratives': ['叙事', 'Narratives'], 'kind.relations': ['关系', 'Relations'], 'kind.sources': ['来源', 'Sources'], 'kind.evidence': ['证据', 'Evidence'],
    'importance.all': ['全部重要性', 'All importance'], 'importance.core': ['核心', 'Core'], 'importance.supporting': ['支撑', 'Supporting'],
    'status.candidate': ['候选（协议默认）', 'Candidate (protocol default)'], 'status.contested': ['有争议', 'Contested'], 'status.supported': ['来源声明已支持', 'Source-declared supported'],
    'status.confirmed': ['来源声明已确认', 'Source-declared confirmed'], 'status.superseded': ['来源声明已取代', 'Source-declared superseded'], 'status.retracted': ['来源声明已撤回', 'Source-declared retracted'],
    'recordList.ariaLabel': ['知识结果', 'Knowledge results'], 'recordList.results': ['{count} 个结果', '{count} results'], 'recordList.empty': ['没有符合当前条件的知识。', 'No knowledge matches the current filters.'], 'recordList.context': ['关联上下文', 'Related context'],
    'detail.ariaLabel': ['知识详情', 'Knowledge detail'], 'detail.empty': ['从列表选择一条知识。', 'Select a knowledge record.'], 'detail.tabs': ['详情页签', 'Detail tabs'],
    'detail.tab.details': ['详情', 'Details'], 'detail.tab.evidence': ['证据', 'Evidence'], 'detail.tab.raw': ['原始记录', 'Raw record'], 'detail.content': ['内容', 'Content'],
    'detail.related': ['关联对象与关系', 'Related objects and relations'], 'detail.noRelated': ['没有直接结构引用。', 'No direct structural references.'], 'detail.missingRecord': ['缺失引用', 'Missing record'],
    'detail.directEvidence': ['直接证据 · {count}', 'Direct evidence · {count}'], 'detail.noEvidence': ['没有直接证据。', 'No direct evidence.'], 'detail.missingEvidence': ['证据引用已断开。', 'Evidence reference is missing.'],
    'field.why': ['保留理由', 'Why retained'], 'field.entityType': ['实体类型', 'Entity type'], 'field.aliases': ['别名', 'Aliases'], 'field.description': ['说明', 'Description'], 'field.identity': ['身份声明', 'Identity declaration'],
    'field.definition': ['定义', 'Definition'], 'field.criteria': ['成立标准', 'Criteria'], 'field.excludes': ['排除边界', 'Exclusions'], 'field.claimKind': ['主张类型', 'Claim kind'], 'field.claimant': ['主张者', 'Claimant'], 'field.about': ['谈及对象', 'About'],
    'field.conditions': ['条件', 'Conditions'], 'field.exceptions': ['例外', 'Exceptions'], 'field.reason': ['推理', 'Reasoning'], 'field.eventType': ['事件类型', 'Event type'], 'field.eventState': ['事件状态', 'Event state'], 'field.roles': ['参与角色', 'Participant roles'], 'field.place': ['地点', 'Place'],
    'field.narrativeType': ['叙事类型', 'Narrative type'], 'field.thesis': ['中心命题', 'Thesis'], 'field.mode': ['叙事来源', 'Narrative mode'], 'field.members': ['阅读链', 'Reading chain'], 'field.alternatives': ['替代解释', 'Alternatives'],
    'field.priority': ['关系 Priority', 'Relation Priority'], 'field.relationType': ['关系类型', 'Relation type'], 'field.statement': ['关系陈述', 'Relation statement'], 'field.claimReferences': ['引用主张', 'Claim references'], 'field.singleSourceReason': ['单来源理由', 'Single-source reason'],
    'field.eventTime': ['事件时间', 'Event time'], 'field.validTime': ['有效时间', 'Valid time'], 'field.scope': ['局部作用范围', 'Local scope'], 'field.limits': ['已知限制', 'Known limits'], 'field.authority': ['来源记录的审核信息', 'Source-recorded review information'],
    'field.epistemicStrength': ['证据强度', 'Evidence strength'], 'field.epistemicBasis': ['证据依据', 'Evidence basis'], 'field.epistemicReason': ['强度说明', 'Strength rationale'],
    'field.score': ['抽取/分类分数', 'Extraction/classification score'], 'field.revision': ['修订号', 'Revision'], 'field.operation': ['修订动作', 'Revision operation'], 'field.parents': ['父版本', 'Parents'],
    'field.speaker': ['证据说话人', 'Evidence speaker'], 'field.sourceTime': ['来源时间', 'Source time'], 'field.evidenceRole': ['证据作用', 'Evidence role'], 'field.sourceUri': ['来源 URI', 'Source URI'],
    'value.unknown': ['未知', 'Unknown'], 'time.unknown': ['未知', 'Unknown'], 'time.notApplicable': ['不适用', 'Not applicable'], 'time.unstandardized': ['未标准化时间：{value}', 'Unstandardized time: {value}'],
    'time.range': ['{start} 至 {end}', '{start} to {end}'], 'time.openStart': ['开放起点', 'Open start'], 'time.openEnd': ['开放终点', 'Open end'],
    'time.kind.point': ['时间点', 'Point'], 'time.kind.range': ['区间', 'Range'], 'time.kind.unknown': ['未知', 'Unknown'], 'time.kind.not-applicable': ['不适用', 'Not applicable'], 'time.kind.unstandardized': ['未标准化', 'Unstandardized'],
    'graph.title': ['局部关系', 'Local relations'], 'graph.summary': ['{relations} 个完整关系组', '{relations} complete relation groups'], 'graph.empty': ['当前对象没有可浏览的显式关系。', 'No browsable explicit relations for this object.'],
    'graph.canvasLabel': ['关系节点与参与角色图', 'Relation nodes and participant roles'], 'graph.description': ['线条只表示角色参与，不表示因果方向。', 'Lines show role participation, not causal direction.'],
    'graph.relationNode': ['关系 {id}，类型 {type}', 'Relation {id}, type {type}'], 'graph.participantNode': ['角色 {role}，{label}', 'Role {role}, {label}'], 'graph.equivalentList': ['等价可访问关系清单', 'Equivalent accessible relation list'],
    'timeline.title': ['时间阅读', 'Timeline'], 'timeline.count': ['{count} 项', '{count} items'], 'timeline.empty': ['当前维度没有可显示的时间记录。', 'No time records for this dimension.'], 'timeline.context': ['关联上下文', 'Related context'],
    'timeline.dimension.event': ['事件时间', 'Event time'], 'timeline.dimension.valid': ['有效时间', 'Valid time'], 'timeline.dimension.source': ['来源时间', 'Source time'], 'timeline.dimension.system': ['系统记录时间', 'System record time'],
    'diagnostics.title': ['数据诊断', 'Data diagnostics'], 'diagnostics.summary': ['{errors} 个错误 · {warnings} 个警告', '{errors} errors · {warnings} warnings'], 'diagnostics.counts': ['浏览与隔离计数', 'Browse and isolation counts'],
    'diagnostics.browseable': ['可浏览 {count}', 'Browsable {count}'], 'diagnostics.isolated': ['已隔离 {count}', 'Isolated {count}'], 'diagnostics.referenceIssues': ['引用问题 {count}', 'Reference issues {count}'], 'diagnostics.empty': ['未发现结构或引用问题。这不表示知识事实已核实。', 'No structural or reference issues found. This does not verify the knowledge as fact.'], 'diagnostics.suggestion': ['恢复建议', 'Recovery'],
    'severity.error': ['错误', 'Error'], 'severity.warning': ['警告', 'Warning'],
  }
  function text(key: string, values: Record<string, string | number> = {}): string {
    let value = table[key]?.[zh ? 0 : 1] ?? key
    for (const [name, replacement] of Object.entries(values)) value = value.replaceAll(`{${name}}`, String(replacement))
    return value
  }

  let result = $state<ParseResult | null>(null)
  let records = $state<ViewRecord[]>([])
  let loading = $state(false)
  let error = $state('')
  let notice = $state('')
  let query = $state('')
  let category = $state<Category>('claims')
  let importance = $state<'all' | 'core' | 'supporting'>('all')
  let priority = $state<'all' | '0' | '1' | '2' | '3'>('all')
  let mode = $state<Mode>('reading')
  let timeDimension = $state<TimeDimension>('event')
  let selectedId = $state<string | null>(null)
  let history = $state<string[]>([])
  let selectedSourceId = $state<string | null>(null)
  let selectedEvidenceId = $state<string | null>(null)
  let datasetPath = $state('')
  let preview = $state<{ title: string; status: string; content: string; path?: string } | null>(null)
  let activeLoad = 0
  let unsubscribe: (() => void) | undefined

  const knowledgeKinds = new Set<KnowledgeKind>(['entities', 'concepts', 'claims', 'events', 'narratives', 'relations'])
  const filtered = $derived.by(() => {
    if (!result?.indexes || category === 'sources' || category === 'evidence') return []
    const kinds = category === 'all' ? knowledgeKinds : new Set<KnowledgeKind>([category])
    const importances = importance === 'all' ? undefined : new Set<0 | 1>([importance === 'core' ? 0 : 1])
    const priorities = priority === 'all' ? undefined : new Set<0 | 1 | 2 | 3>([Number(priority) as 0 | 1 | 2 | 3])
    return queryRecords(records, { query, datasetId: result.dataset?.id, kinds, importance: importances, priorities, indexes: result.indexes }).map(match => match.record as ViewRecord)
  })
  const selected = $derived(records.find(record => record.id === selectedId) ?? null)
  const selectedSource = $derived(result?.dataset?.sources.find(source => source.id === selectedSourceId) ?? null)
  const selectedEvidence = $derived(result?.dataset?.evidence.find(item => item.id === selectedEvidenceId) ?? null)
  const relationView = $derived.by(() => {
    if (!result?.dataset || !result.indexes) return [] as Relation[]
    const candidates = selected && 'p' in selected.raw ? [selected.raw] : selectedId ? result.indexes.relationsByParticipant.get(selectedId) ?? [] : result.dataset.relations
    const chosen: Relation[] = []; let nodes = 0; let lines = 0
    for (const relation of candidates) {
      const participantCount = relationParticipants(relation).length
      if (chosen.length && (nodes + participantCount + 1 > 80 || lines + participantCount > 120)) break
      chosen.push(relation); nodes += participantCount + 1; lines += participantCount
    }
    return chosen
  })
  const comparison = $derived.by(() => {
    const indexes = result?.indexes
    if (!indexes || !selected || !('p' in selected.raw) || !['contradicts', 'supersedes', 'corrects', 'version_of'].includes(selected.raw.type)) return null
    const participants = relationParticipants(selected.raw).filter(item => indexes.nodesById.has(item.ref)).slice(0, 2)
    if (participants.length < 2) return null
    return participants.map(item => ({ ...item, record: indexes.nodesById.get(item.ref)! }))
  })
  const timelineEntries = $derived.by((): TimelineEntry[] => {
    if (!result?.dataset) return []
    if (timeDimension === 'system') return [{ key: `system:${result.dataset.id}`, label: result.dataset.scope.purpose, secondary: result.dataset.id, time: result.dataset.generated.at, timeKind: 'point', sortKey: result.dataset.generated.at }]
    if (timeDimension === 'source') return result.dataset.evidence.map((item, index) => {
      const parsed = parseTimeValue(item.at, 'at' in item)
      return { key: `source:${item.id}`, label: item.quote ?? `${item.s} · ${item.loc}`, secondary: item.id, time: item.at,
        timeKind: parsed.kind === 'open-range' || parsed.kind === 'invalid-range' ? 'unstandardized' : parsed.kind, sortKey: parsed.start === undefined ? undefined : String(parsed.start).padStart(16, '0'), group: item.s }
    })
    return records.map(record => {
      const field = timeDimension as 'event' | 'valid'; const present = field in record.raw; const value = record.raw[field]; const parsed = parseTimeValue(value, present)
      const kind = parsed.kind === 'open-range' || parsed.kind === 'invalid-range' ? 'unstandardized' : parsed.kind
      return { key: `${field}:${record.id}`, label: record.label, secondary: record.secondary, record, time: value, timeKind: kind, sortKey: parsed.start === undefined ? undefined : String(parsed.start).padStart(16, '0') } as TimelineEntry
    })
  })
  const visibleSources = $derived((result?.dataset?.sources ?? []).filter(source => !query.trim() || `${source.id} ${source.title ?? ''} ${source.uri}`.normalize('NFKC').toLocaleLowerCase().includes(query.normalize('NFKC').toLocaleLowerCase())))
  const visibleEvidence = $derived((result?.dataset?.evidence ?? []).filter(item => !query.trim() || `${item.id} ${item.s} ${item.loc} ${item.quote ?? ''}`.normalize('NFKC').toLocaleLowerCase().includes(query.normalize('NFKC').toLocaleLowerCase())))

  async function portableDatasetPath(uri: string): Promise<string> {
    if (!uri.startsWith('/')) return uri
    try {
      const root = (await vaultInfo()).root?.replace(/\\/g, '/').replace(/\/$/, '')
      const normalized = uri.replace(/\\/g, '/')
      if (root && normalized.startsWith(`${root}/`)) {
        const relative = normalized.slice(root.length + 1)
        if (relative && !relative.split('/').some(part => !part || part === '.' || part === '..')) return relative
      }
    } catch { /* An external dialog file has no Vault-relative identity. */ }
    return uri
  }

  async function applyContent(content: string, uri: string, signal?: AbortSignal): Promise<boolean> {
    const load = ++activeLoad; loading = true; error = ''; notice = ''; preview = null
    try {
      const parsed = await parseDatasetAsync(content, uri, signal)
      if (signal?.aborted || load !== activeLoad) return false
      const schema = parsed.raw && typeof parsed.raw === 'object' ? (parsed.raw as { schema?: unknown }).schema : undefined
      const recognized = parsed.status !== 'invalid'
        || schema === CURRENT_DATASET_SCHEMA
        || schema === LEGACY_DATASET_SCHEMA
      if (!recognized) {
        result = null; records = []; selectedId = null
        return false
      }
      result = parsed; datasetPath = await portableDatasetPath(uri)
      if (parsed.dataset && parsed.indexes) {
        records = buildViewRecords(parsed.dataset, parsed.indexes)
        category = parsed.dataset.claims.length ? 'claims' : 'all'
        const initial = records.find(record => category === 'all' || record.kind === category)
        selectedId = initial?.id ?? null; history = []; selectedSourceId = parsed.dataset.sources[0]?.id ?? null; selectedEvidenceId = parsed.dataset.evidence[0]?.id ?? null
        mode = parsed.diagnostics.some(item => item.severity === 'error') ? 'diagnostics' : 'reading'
      } else { records = []; selectedId = null; mode = 'diagnostics' }
      return true
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) error = cause instanceof Error ? cause.message : String(cause)
      return false
    } finally { if (load === activeLoad) loading = false }
  }

  function selectRecord(record: ViewRecord): void {
    if (selectedId && selectedId !== record.id) history = [...history, selectedId].slice(-100)
    selectedId = record.id; selectedSourceId = null; selectedEvidenceId = null
  }
  function navigate(id: string): void {
    const record = records.find(item => item.id === id)
    if (record) { selectRecord(record); category = record.kind; mode = 'reading'; return }
    const source = result?.indexes?.sourcesById.get(id)
    if (source) { category = 'sources'; selectedSourceId = source.id; mode = 'reading' }
  }
  function back(): void { const previous = history.at(-1); if (previous) { selectedId = previous; history = history.slice(0, -1) } }
  async function reportCopy(value: string): Promise<void> { try { await copyText(value); notice = text('copied') } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) } }
  async function copyReference(record: ViewRecord): Promise<void> {
    if (!result?.dataset || !datasetPath || datasetPath.startsWith('/')) { error = zh ? '外部文件没有可移植的 Vault 相对路径。' : 'External files do not have a portable Vault-relative path.'; return }
    await reportCopy(serializeKnowledgeReference({ path: datasetPath, dataset: result.dataset.id, ref: record.id, snapshot: result.snapshotHash }))
  }
  function excerptFor(textValue: string, evidence: Evidence): string {
    const normalized = textValue.replace(/\r\n?/g, '\n'); const lines = normalized.split('\n'); const loc = parseSourceLocation(evidence.loc)
    if (loc.kind === 'lines' && loc.startLine && loc.endLine && loc.startLine <= lines.length) {
      const from = Math.max(0, loc.startLine - 6); const to = Math.min(lines.length, loc.endLine + 5)
      return lines.slice(from, to).map((line, index) => `${from + index + 1}\t${line}`).join('\n')
    }
    if (evidence.quote) {
      const found = locateQuote(normalized, evidence.quote)
      if (found.kind === 'quote' && found.matches?.length) {
        const at = found.matches[0]; const before = normalized.slice(0, at).split('\n').length; const from = Math.max(0, before - 6); const to = Math.min(lines.length, before + evidence.quote.split('\n').length + 5)
        const note = found.matches.length > 1 ? `${zh ? '精确引文有多个命中' : 'Multiple exact quote matches'}: ${found.matches.length}\n\n` : ''
        return note + lines.slice(from, to).map((line, index) => `${from + index + 1}\t${line}`).join('\n')
      }
    }
    return `${zh ? '未能自动定位；显示前 200 行。' : 'Could not locate automatically; showing the first 200 lines.'}\n\n${lines.slice(0, 200).map((line, index) => `${index + 1}\t${line}`).join('\n')}`
  }
  async function digestBase64(base64: string): Promise<string> {
    const raw = atob(base64); const bytes = Uint8Array.from(raw, char => char.charCodeAt(0)); const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  }
  async function readSource(evidence: Evidence, source?: Source): Promise<void> {
    if (!source) { error = zh ? '证据引用的来源不存在。' : 'The evidence source is missing.'; return }
    const resolution = resolveSourceUri(source.uri, datasetPath.startsWith('/') ? undefined : datasetPath)
    if (resolution.kind !== 'vault' || !resolution.vaultPath) { preview = { title: sourceLabel(source), status: resolution.reason ?? resolution.kind, content: evidence.quote ?? source.uri }; return }
    try {
      const content = await vaultRead(resolution.vaultPath); let version = source.v === null ? (zh ? '来源版本未知' : 'Source version unknown') : (zh ? '来源版本未核对' : 'Source version not checked')
      if (source.v?.startsWith('sha256:')) {
        try { const actual = await digestBase64(await vaultReadBytes(resolution.vaultPath)); version = actual === source.v.slice(7) ? (zh ? '来源内容版本一致' : 'Source bytes match the recorded version') : (zh ? '当前来源与抽取版本不同' : 'Current source differs from the extraction version') } catch { version = zh ? '来源字节超限或无法读取，版本未核对' : 'Source bytes unavailable or too large; version not checked' }
      }
      preview = { title: evidenceLabel(evidence, source), status: version, content: excerptFor(content, evidence), path: resolution.vaultPath }
    } catch (cause) { preview = { title: sourceLabel(source), status: zh ? '来源缺失、无权限或无法读取' : 'Source missing, denied, or unreadable', content: cause instanceof Error ? cause.message : String(cause) } }
  }

  function timelineSelect(item: TimelineEntry): void {
    if (item.record) selectRecord(item.record)
    else if (item.key.startsWith('source:')) { category = 'evidence'; selectedEvidenceId = item.key.slice(7); mode = 'reading' }
  }
  function selectDiagnostic(item: Diagnostic): void { if (item.objectId) navigate(item.objectId) }

  onMount(() => {
    loading = true
    unsubscribe = onFileViewOpen((snapshot, signal) => applyContent(snapshot.content, snapshot.uri, signal))
  })
  onDestroy(() => { activeLoad++; unsubscribe?.() })
</script>

<main class="knowledge-app ui-surface viewer">
  <header class="topbar">
    <div class="identity">
      <span class="eyebrow">{text('entry.viewer')}</span>
      <h1>{text('product')}</h1>
    </div>
  </header>

  {#if result?.dataset}
    <section class="context">
      <div><strong>{text('scope')}</strong><span>{result.dataset.scope.purpose}</span></div>
      {#if result.dataset.scope.questions.length}<div><strong>{text('questions')}</strong><span>{result.dataset.scope.questions.join(' · ')}</span></div>{/if}
      {#if result.dataset.selection}<div><strong>{text('selection')}</strong><span>{result.dataset.selection.profile} · ≥ {result.dataset.selection.minimum_strength}</span></div>{/if}
    </section>
    <section class="toolbar">
      <label class="search"><span aria-hidden="true">⌕</span><input type="search" placeholder={text('search')} bind:value={query} /></label>
      <label><span class="sr-only">{zh ? '类别' : 'Category'}</span><select bind:value={category} onchange={() => { if (category === 'relations') priority = priority === 'all' ? 'all' : priority }}>
        {#each ['claims','all','entities','concepts','events','narratives','relations','sources','evidence'] as kind}<option value={kind}>{text(`kind.${kind}`)}</option>{/each}
      </select></label>
      {#if category !== 'sources' && category !== 'evidence'}<label><span class="sr-only">{zh ? '重要性' : 'Importance'}</span><select bind:value={importance}><option value="all">{text('importance.all')}</option><option value="core">{text('importance.core')}</option><option value="supporting">{text('importance.supporting')}</option></select></label>{/if}
      {#if category === 'relations'}<label><span class="sr-only">Priority</span><select bind:value={priority}><option value="all">P0–P3</option>{#each [0,1,2,3] as p}<option value={String(p)}>P{p}</option>{/each}</select></label>{/if}
      <div class="modes" role="group" aria-label={zh ? '阅读方式' : 'Reading mode'}>
        {#each ['reading','relations','timeline','diagnostics'] as value}<button type="button" aria-pressed={mode === value} onclick={() => mode = value as Mode}>{text(`mode.${value}`)}</button>{/each}
      </div>
      {#if mode === 'timeline'}<select aria-label={zh ? '时间维度' : 'Time dimension'} bind:value={timeDimension}>{#each ['event','valid','source','system'] as value}<option value={value}>{text(`timeline.dimension.${value}`)}</option>{/each}</select>{/if}
    </section>
  {/if}

  {#if error}<div class="banner error" role="alert">{error}<button aria-label={text('action.close')} onclick={() => error = ''}>×</button></div>{/if}
  {#if notice}<div class="banner" role="status">{notice}<button aria-label={text('action.close')} onclick={() => notice = ''}>×</button></div>{/if}

  {#if loading}<section class="empty-state" role="status"><span class="spinner" aria-hidden="true"></span><p>{text('loading')}</p></section>
  {:else if !result}<section class="empty-state"><h2>{text('product')}</h2><p>{text('empty.dataset')}</p></section>
  {:else if !result.dataset || !result.indexes}
    <DiagnosticsView diagnostics={result.diagnostics} text={text} onSelect={selectDiagnostic} />
  {:else}
    <div class="workspace" class:single={mode !== 'reading'}>
      {#if mode === 'reading'}
        <aside class="results" class:hidden-mobile={!!selected && category !== 'sources' && category !== 'evidence'}>
          {#if category === 'sources'}
            <div class="simple-list" role="listbox">{#each visibleSources as source}<button class:selected={source.id === selectedSourceId} onclick={() => { selectedSourceId = source.id; selectedEvidenceId = null }}>{sourceLabel(source)}<small>{source.id} · {source.uri}</small></button>{:else}<p>{text('recordList.empty')}</p>{/each}</div>
          {:else if category === 'evidence'}
            <div class="simple-list" role="listbox">{#each visibleEvidence as item}<button class:selected={item.id === selectedEvidenceId} onclick={() => { selectedEvidenceId = item.id; selectedSourceId = null }}>{item.quote ?? `${item.s} · ${item.loc}`}<small>{item.id} · {item.loc}</small></button>{:else}<p>{text('recordList.empty')}</p>{/each}</div>
          {:else}<RecordList records={filtered as ViewRecord[]} {selectedId} text={text} onSelect={selectRecord} />{/if}
        </aside>
        <section class="reader" class:visible-mobile={!!selected || category === 'sources' || category === 'evidence'}>
          {#if history.length && selected}<button class="back" type="button" onclick={back}>← {text('action.back')}</button>{/if}
          {#if category === 'sources' && selectedSource}
            <article class="aux-detail"><p class="eyebrow">{selectedSource.id} · {text('kind.sources')}</p><h2>{sourceLabel(selectedSource)}</h2><dl><div><dt>URI</dt><dd>{selectedSource.uri}</dd></div><div><dt>{zh ? '版本' : 'Version'}</dt><dd>{selectedSource.v ?? text('time.unknown')}</dd></div><div><dt>{zh ? '证据链分组' : 'Evidence-chain group'}</dt><dd>{selectedSource.group ?? selectedSource.id}</dd></div></dl></article>
          {:else if category === 'evidence' && selectedEvidence}
            {@const source = result.indexes.sourcesById.get(selectedEvidence.s)}
            <article class="aux-detail"><p class="eyebrow">{selectedEvidence.id} · {text('kind.evidence')}</p><h2>{source ? sourceLabel(source) : selectedEvidence.s}</h2>{#if selectedEvidence.quote}<blockquote>{selectedEvidence.quote}</blockquote>{/if}<dl><div><dt>{zh ? '原文定位' : 'Location'}</dt><dd>{selectedEvidence.loc}</dd></div><div><dt>{text('field.speaker')}</dt><dd>{selectedEvidence.speaker ?? '—'}</dd></div></dl><button onclick={() => readSource(selectedEvidence, source)}>{text('action.readSource')}</button></article>
          {:else}<DetailPane record={selected} indexes={result.indexes} text={text} onNavigate={navigate} onCopyRaw={(raw) => reportCopy(JSON.stringify(raw))} onCopyReference={copyReference} onReadSource={readSource} />{/if}
        </section>
      {:else if mode === 'relations'}
        <div class="relation-mode">
          {#if comparison}
            <section class="comparison" aria-labelledby="comparison-title">
              <header><p class="eyebrow">{zh ? '显式关系比较' : 'Explicit relation comparison'}</p><h2 id="comparison-title">{selected?.raw && 'type' in selected.raw ? selected.raw.type : ''}</h2><p>{zh ? '比较只呈现来源记录的差异，不自动裁决哪一边正确。' : 'This comparison shows source-recorded differences and does not decide which side is correct.'}</p></header>
              <div class="comparison-columns">{#each comparison as side}
                <article><p class="eyebrow">{side.role} · {side.ref}</p><button class="comparison-title" onclick={() => navigate(side.ref)}>{'name' in side.record ? side.record.name : 'term' in side.record ? side.record.term : 'title' in side.record ? side.record.title : 'text' in side.record ? side.record.text : side.record.id}</button>
                  <dl>{#each ['scope','if','unless','event','valid','status','ev','rev','op','parents'] as field}<div><dt>{field}</dt><dd>{field in side.record ? JSON.stringify((side.record as unknown as Record<string, unknown>)[field]) : (zh ? '字段缺失' : 'Field absent')}</dd></div>{/each}</dl>
                </article>
              {/each}</div>
            </section>
          {/if}
          <RelationGraph relations={relationView} indexes={result.indexes} centerId={selectedId} text={text} onSelectRelation={(relation) => navigate(relation.id)} onNavigate={navigate} />
        </div>
      {:else if mode === 'timeline'}
        <TimelineView dimension={timeDimension} entries={timelineEntries} text={text} onSelect={timelineSelect} />
      {:else}
        <DiagnosticsView diagnostics={result.diagnostics} browseableCount={records.length} isolatedCount={result.dataset.entities.length + result.dataset.concepts.length + result.dataset.claims.length + result.dataset.events.length + result.dataset.narratives.length + result.dataset.relations.length - records.length} referenceIssueCount={result.diagnostics.filter(item => item.code.includes('ref') || item.code.includes('evidence') || item.code.includes('source')).length} text={text} onSelect={selectDiagnostic} />
      {/if}
    </div>
  {/if}

  {#if preview}
    <div class="preview" role="dialog" aria-modal="true" aria-labelledby="preview-title">
      <header><div><p class="eyebrow">{preview.status}</p><h2 id="preview-title">{preview.title}</h2></div><button type="button" onclick={() => preview = null} aria-label={text('action.close')}>×</button></header>
      <pre>{preview.content}</pre>
      {#if preview.path}<footer><button type="button" onclick={() => openEditor(preview!.path!)}>{text('action.openEditor')}</button></footer>{/if}
    </div>
  {/if}

  {#if result}<footer class="statusbar"><span>{datasetPath}</span><span>{result.snapshotHash.slice(0, 12)} · {result.status} · {result.diagnostics.length} {zh ? '项诊断' : 'diagnostics'}</span></footer>{/if}
</main>

<style>
  :global(html), :global(body), :global(#app) { margin: 0; min-width: 0; min-height: 100%; height: 100%; }
  :global(*) { box-sizing: border-box; }
  button, input, select { font: inherit; }
  button { color: inherit; cursor: pointer; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--ui-accent, AccentColor); outline-offset: 2px; }
  .knowledge-app { display: grid; min-width: 0; min-height: 100vh; height: 100vh; grid-template-rows: auto auto auto auto minmax(0, 1fr) auto; overflow: hidden; background: var(--ui-surface, Canvas); color: CanvasText; }
  .topbar { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 18px; padding: 18px 24px 12px; border-bottom: 1px solid var(--ui-separator); }
  .identity { min-width: 0; } .eyebrow { margin: 0 0 3px; color: var(--ui-tertiary, GrayText); font-size: 10px; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; }
  h1 { margin: 0; font-size: 22px; letter-spacing: -.025em; } h2 { overflow-wrap: anywhere; }
  .toolbar select, .back, .aux-detail button, .preview button { min-height: 31px; padding: 5px 9px; border: 1px solid var(--ui-control-border); border-radius: 7px; background: var(--ui-surface); }
  .context { display: flex; min-width: 0; flex-wrap: wrap; gap: 8px 24px; padding: 8px 24px; border-bottom: 1px solid var(--ui-separator); background: var(--ui-bg); font-size: 12px; }
  .context div { display: flex; min-width: 0; gap: 7px; } .context strong { flex: none; } .context span { min-width: 0; color: var(--ui-secondary); overflow-wrap: anywhere; }
  .toolbar { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 8px; padding: 9px 24px; border-bottom: 1px solid var(--ui-separator); }
  .search { display: flex; min-width: 170px; flex: 1; align-items: center; gap: 7px; padding: 6px 9px; border: 1px solid var(--ui-control-border); border-radius: 7px; color: var(--ui-tertiary); }
  .search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: CanvasText; }
  .toolbar select { max-width: 190px; background: var(--ui-surface); color: CanvasText; }
  .modes { display: flex; padding: 2px; border: 1px solid var(--ui-separator); border-radius: 8px; background: var(--ui-bg); }
  .modes button { padding: 5px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--ui-secondary); }
  .modes button[aria-pressed='true'] { background: var(--ui-surface); color: CanvasText; box-shadow: 0 1px 3px #0002; }
  .banner { display: flex; justify-content: space-between; gap: 8px; padding: 7px 24px; background: color-mix(in srgb, var(--ui-accent, AccentColor) 10%, var(--ui-surface)); font-size: 12px; }
  .banner.error { color: var(--ui-danger, #b42318); background: color-mix(in srgb, var(--ui-danger, #b42318) 8%, var(--ui-surface)); }
  .banner button { border: 0; background: transparent; color: inherit; }
  .workspace { display: grid; min-width: 0; min-height: 0; grid-template-columns: minmax(280px, 360px) minmax(400px, 1fr); overflow: hidden; }
  .workspace.single { display: block; overflow: auto; } .results { min-width: 0; min-height: 0; overflow: auto; border-right: 1px solid var(--ui-separator); }
  .reader { min-width: 0; min-height: 0; overflow: auto; } .back { margin: 10px 14px 0; }
  .simple-list { display: grid; min-width: 0; }
  .simple-list > button { display: grid; min-width: 0; gap: 4px; padding: 11px 12px; border: 0; border-bottom: 1px solid var(--ui-separator); background: transparent; text-align: left; overflow-wrap: anywhere; }
  .simple-list > button:hover { background: var(--ui-hover); } .simple-list > button.selected { background: var(--ui-selection); }
  .simple-list small { color: var(--ui-secondary); overflow-wrap: anywhere; }
  .aux-detail { max-width: 900px; padding: 20px; } .aux-detail h2 { margin-top: 4px; } .aux-detail blockquote { padding-left: 12px; border-left: 3px solid var(--ui-accent); white-space: pre-wrap; }
  .aux-detail dl > div { display: grid; grid-template-columns: 160px 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--ui-separator); }
  .aux-detail dt { color: var(--ui-secondary); } .aux-detail dd { margin: 0; overflow-wrap: anywhere; }
  .relation-mode { min-width: 0; }
  .comparison { min-width: 0; padding: 16px 18px; border-bottom: 1px solid var(--ui-separator); }
  .comparison > header h2 { margin: 3px 0; font-size: 18px; } .comparison > header p:last-child { margin: 4px 0 12px; color: var(--ui-secondary); font-size: 12px; }
  .comparison-columns { display: grid; min-width: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .comparison article { min-width: 0; padding: 12px; border: 1px solid var(--ui-separator); border-radius: 9px; }
  .comparison-title { max-width: 100%; padding: 0; border: 0; background: transparent; color: var(--ui-accent-text, AccentColor); font-weight: 650; text-align: left; overflow-wrap: anywhere; }
  .comparison dl { margin: 10px 0 0; } .comparison dl div { display: grid; min-width: 0; grid-template-columns: 70px minmax(0, 1fr); gap: 8px; padding: 5px 0; border-top: 1px solid var(--ui-separator); }
  .comparison dt { color: var(--ui-secondary); font-size: 11px; } .comparison dd { margin: 0; overflow-wrap: anywhere; font-size: 12px; }
  .empty-state { display: grid; place-content: center; justify-items: center; min-height: 0; padding: 40px 24px; color: var(--ui-secondary); text-align: center; }
  .empty-state h2 { color: CanvasText; } .empty-state p { max-width: 520px; line-height: 1.6; }
  .spinner { width: 22px; height: 22px; border: 2px solid var(--ui-separator); border-top-color: var(--ui-accent, AccentColor); border-radius: 50%; animation: spin .8s linear infinite; }
  .statusbar { display: flex; min-width: 0; justify-content: space-between; gap: 14px; padding: 6px 16px; border-top: 1px solid var(--ui-separator); color: var(--ui-tertiary); font-size: 10px; }
  .statusbar span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview { position: fixed; inset: 6%; z-index: 20; display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid var(--ui-control-border); border-radius: 12px; background: var(--ui-surface); box-shadow: 0 18px 70px #0005; }
  .preview header { display: flex; min-width: 0; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--ui-separator); }
  .preview h2 { margin: 3px 0 0; font-size: 17px; } .preview pre { margin: 0; padding: 15px; overflow: auto; background: var(--ui-bg); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .preview footer { padding: 10px 15px; border-top: 1px solid var(--ui-separator); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  @media (max-width: 759px) {
    .topbar { align-items: flex-start; flex-direction: column; padding: 13px 14px 10px; }
    .context, .toolbar { padding-inline: 14px; } .toolbar { align-items: stretch; } .search { flex-basis: 100%; }
    .workspace { display: block; overflow: auto; } .results, .reader { border: 0; }
    .results.hidden-mobile { display: none; } .reader:not(.visible-mobile) { display: none; }
    .statusbar { display: grid; } .preview { inset: 0; border: 0; border-radius: 0; }
    .aux-detail dl > div { grid-template-columns: 1fr; gap: 4px; }
    .comparison-columns { grid-template-columns: 1fr; }
  }
  @media (max-width: 399px) { .modes { width: 100%; overflow-x: auto; } }
</style>
