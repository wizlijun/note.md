<script lang="ts">
  import { onMount, tick } from 'svelte'
  import TerrainMap from './components/TerrainMap.svelte'
  import MeetingDetails from './components/MeetingDetails.svelte'
  import { parseMeetingSnapshot } from './lib/meetings-client'
  import type { MeetingNodeMetadata } from './lib/meetings'
  import { api } from './lib/bridge'
  import { TerrainWorkerClient } from './lib/worker-client'
  import type { Atlas, TerrainBounds, TerrainRenderOptions, TerrainResult } from './lib/types-terrain'
  import type { Dataset, Job, KnowledgeNode, Preferences, Provider, Snapshot } from './lib/types'
  import { confidentialityLabels, errorText, jobLabels, nodeVisible, originLabels, ownerLabels, rangeError, recentRange, restorePreferences, running, sourceFilesForNode, supportsExtraction } from './lib/domain'

  let prefs = $state(restorePreferences())
  let dataset = $state<Dataset>('vault_index')
  const datasetPreferences: Partial<Record<Dataset, Partial<Preferences>>> = {}
  let meetingParse: AbortController | undefined
  const isMeetings = $derived(dataset === 'meetings_knowledge')
  let snapshot = $state.raw<Snapshot | null>(null)
  let terrain = $state.raw<TerrainResult | null>(null)
  let job = $state<Job | null>(null)
  let providers = $state<Provider[]>([])
  let loading = $state(true)
  let computing = $state(false)
  let starting = $state(false)
  let stopping = $state(false)
  let error = $state('')
  let notice = $state('')
  let settings = $state(false)
  let showDirectory = $state(false)
  let showCoverage = $state(false)
  let selectedId = $state('')
  let selectedRelationId = $state('')
  let directoryKind = $state<'knowledge' | 'relations'>('knowledge')
  let directoryDomain = $state('')
  let directoryTopic = $state('')
  let directoryPage = $state(0)
  let search = $state('')
  let maxFiles = $state(120)
  let maxMiB = $state(2)
  let includeConfidential = $state(false)
  let rebuildConfirm = $state(false)
  let map: TerrainMap | undefined
  let closeEvidence = $state<HTMLButtonElement>()
  let worker: TerrainWorkerClient | null = null
  let bounds: TerrainBounds | undefined
  let previousAtlas: Atlas | undefined
  let previousVault = ''
  let epoch = ''
  let requestId = 0
  let preferenceRevision = 0
  let computationId = 0
  let polling = false
  let disposed = false
  let lastJobVersion = ''
  let lastChecked = 0
  let savingPreferences: Promise<unknown> = Promise.resolve()
  const dateError = $derived(rangeError(prefs.from, prefs.to))
  const busy = $derived(running(job))
  const provider = $derived(providers.find(p => p.id === prefs.harness))
  const canExtract = $derived(supportsExtraction(provider))
  const selection = $derived({ from: prefs.from, to: prefs.to, includePublic: prefs.includePublic })
  const visibleNodes = $derived(snapshot?.nodes.filter(n => nodeVisible(n, selection)) ?? [])
  const selected = $derived(visibleNodes.find(n => n.id === selectedId))
  const selectedRelation = $derived(snapshot?.relations.find(r => r.id === selectedRelationId))
  const nodeMap = $derived(new Map(visibleNodes.map(n => [n.id, n])))
  const selectedFiles = $derived(sourceFilesForNode(snapshot?.files ?? [], selected, prefs))
  const verifiedCount = $derived(visibleNodes.filter(n => n.state === 'verified').length)
  const directoryDomains = $derived(terrain?.layout.domains.filter(c => c.memberIds.some(id => nodeMap.has(id))) ?? [])
  const directoryTopics = $derived(terrain?.layout.topics.filter(c => c.parentId === directoryDomain && c.memberIds.some(id => nodeMap.has(id))) ?? [])
  const directoryNodes = $derived(terrain?.layout.nodes.filter(n => nodeMap.has(n.id) && (!directoryTopic || n.parentTopic === directoryTopic) && (!directoryDomain || n.parentDomain === directoryDomain) && (!search || n.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))) ?? [])
  const selectedRelations = $derived(snapshot?.relations.filter(r => r.participants ? r.participants.some(p => p.nodeId === selectedId) : (r.source === selectedId || r.target === selectedId) && nodeMap.has(r.source) && nodeMap.has(r.target)) ?? [])
  const meetingPaths = $derived(new Set(snapshot?.files.filter(f => f.docDate && f.docDate >= prefs.from && f.docDate <= prefs.to).map(f => f.path) ?? []))
  const directoryRelations = $derived(snapshot?.relations.filter(r => r.meeting && meetingPaths.has(r.meeting.datasetPath) && (!search || `${r.title} ${r.type}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))) ?? [])
  const selectedMeetings = $derived(snapshot?.files.filter(f => f.docDate && f.docDate >= prefs.from && f.docDate <= prefs.to).length ?? 0)

  function persist() {
    ++preferenceRevision
    const value = { ...prefs }
    datasetPreferences[dataset] = value
    const datasets = { active: dataset, preferences: { ...datasetPreferences } }
    savingPreferences = savingPreferences.catch(() => {}).then(() => api.saveSettings(value, datasets)).catch(e => { if (!disposed) notice = `浏览偏好未保存：${errorText(e)}` })
  }
  async function loadProviders() {
    try {
      const response = await api.providers()
      if (disposed) return
      providers = response.providers
      if (!providers.some(p => p.id === prefs.harness)) prefs.harness = providers.find(p => p.id === response.default)?.id ?? providers[0]?.id ?? ''
    } catch (e) { if (!disposed) notice = `Agent 暂不可用，本地索引浏览不受影响：${errorText(e)}` }
  }
  async function load(rebuild = false) {
    const id = ++requestId, activeDataset = dataset
    meetingParse?.abort(); const parseController = new AbortController(); meetingParse = parseController
    ++computationId; worker?.cancel()
    loading = true; computing = false; error = ''; directoryPage = 0; snapshot = null; terrain = null; selectedId = ''; selectedRelationId = ''
    if (dateError) { error = dateError; loading = false; return }
    try {
      const range = { from: prefs.from, to: prefs.to }
      let data: Snapshot
      if (activeDataset === 'meetings_knowledge') {
        const input = await api.meetings()
        if (disposed || id !== requestId) return
        data = await parseMeetingSnapshot(input, range, parseController.signal)
      } else data = await api.snapshot(range)
      if (disposed || id !== requestId) return
      if (data.schema !== 'notemd.strata/snapshot/v1' || !Array.isArray(data.nodes)) throw new Error('宿主返回了不兼容的知识快照，请更新插件与宿主。')
      const identity = `${data.vaultKey}:${activeDataset}`
      if (previousVault !== identity) { previousAtlas = undefined; epoch = ''; bounds = undefined; previousVault = identity; directoryDomain = ''; directoryTopic = '' }
      if (!previousAtlas && !rebuild) {
        try { const saved = await api.loadAtlas(data.vaultKey, activeDataset); if (disposed || id !== requestId) return; previousAtlas = saved.atlas ?? undefined }
        catch (e) { if (disposed || id !== requestId) return; notice = `未能恢复地图布局，将依据当前索引生成：${errorText(e)}` }
      }
      if (disposed || id !== requestId) return
      if (rebuild) { previousAtlas = undefined; bounds = undefined; epoch = `${data.vaultKey}:${activeDataset}:${Date.now()}` }
      epoch ||= previousAtlas?.epoch ?? `${data.vaultKey}:${activeDataset}:1`
      snapshot = data; job = data.job; lastJobVersion = signature(job); loading = false; lastChecked = Date.now()
      await compute(true)
    } catch (e) { if (!disposed && id === requestId) { error = errorText(e); snapshot = null; terrain = null; loading = false } }
  }
  async function compute(build = false) {
    if (!snapshot || !worker || dateError) return
    const id = ++computationId, viewId = requestId, data = snapshot, activeDataset = dataset
    computing = true
    try {
      const options: TerrainRenderOptions = { width: 768, height: 512, bounds, contourStep: bounds ? 2 : 3, ...(activeDataset === 'meetings_knowledge' ? { surface: 'meeting' as const } : {}) }
      const output = build ? await worker.build(data.nodes.map(({ id, title, kind, state, features, links, ownerSpecificity, confidentiality, sourceGroups, importance }) => ({ id, title, kind, state, features, links, ownerSpecificity, confidentiality, sourceGroups, importance })), epoch, selection, options, previousAtlas) : await worker.render(selection, options)
      if (disposed || id !== computationId || viewId !== requestId) return
      terrain = output; previousAtlas = output.layout
      if (notice === '来源或索引配置已变化，正在更新地图。') notice = ''
      if (build) api.saveAtlas(data.vaultKey, output.layout, activeDataset)
        .then(() => { if (!disposed && viewId === requestId && notice.startsWith('地图布局未保存：')) notice = '' })
        .catch(e => { if (!disposed && viewId === requestId) notice = `地图布局未保存：${errorText(e)}` })
    } catch (e) { if (!disposed && id === computationId && (e as Error)?.name !== 'AbortError') { error = `地形计算失败：${errorText(e)}`; terrain = null } }
    finally { if (!disposed && id === computationId) computing = false }
  }
  function focusRegion(region?: TerrainBounds) { bounds = region; void compute() }
  function dateChanged() {
    persist(); selectedId = ''; selectedRelationId = ''; directoryPage = 0
    if (isMeetings && snapshot) { if (dateError) { ++computationId; worker?.cancel(); computing = false; error = dateError; terrain = null } else { error = ''; void compute() } }
    else void load()
  }
  function changeDataset(next: string) {
    if (next !== 'vault_index' && next !== 'meetings_knowledge' || next === dataset) return
    datasetPreferences[dataset] = { ...prefs }; dataset = next
    prefs = restorePreferences(datasetPreferences[next]); previousAtlas = undefined; previousVault = ''; epoch = ''; bounds = undefined
    selectedId = ''; selectedRelationId = ''; directoryKind = 'knowledge'; directoryDomain = ''; directoryTopic = ''; search = ''; directoryPage = 0; job = null; notice = ''; showCoverage = false; settings = false
    persist(); void load()
  }
  function setRange(days: string) {
    if (!days) return
    if (days === 'all') {
      const dates = snapshot?.files.flatMap(f => f.docDate ? [f.docDate] : []).sort() ?? []
      Object.assign(prefs, snapshot?.meetings?.dateExtent ?? (dates.length ? { from: dates[0], to: dates[dates.length - 1] } : recentRange()))
    } else Object.assign(prefs, recentRange(Number(days)))
    dateChanged()
  }
  function visibleChanged() { selectedId = ''; persist(); void compute() }
  async function selectNode(id: string) { selectedRelationId = ''; selectedId = id; showDirectory = false; await tick(); closeEvidence?.focus() }
  async function openSource(node: KnowledgeNode, evidenceId?: string) {
    try { await api.openSource(node.id, { from: prefs.from, to: prefs.to }, evidenceId) }
    catch (e) { selectedId = ''; error = `原文暂不可打开：${errorText(e)}`; void checkFreshness(true) }
  }
  async function openMeetingRelation(metadata: MeetingNodeMetadata, sourceId?: string) {
    const data = snapshot, id = requestId
    if (!data || !isMeetings) return
    try { await api.openMeetingSource(data.vaultKey, metadata.datasetPath, metadata.contentHash, sourceId) }
    catch (e) { if (!disposed && id === requestId) notice = `会议来源暂不可打开：${errorText(e)}` }
  }
  async function openMeeting(node: KnowledgeNode, sourceId?: string) { if (node.meeting) await openMeetingRelation(node.meeting, sourceId) }
  async function extract() {
    if (isMeetings) return
    if (!canExtract || busy || loading || dateError || starting) return
    starting = true; error = ''; persist()
    try { const result = await api.extract({ from: prefs.from, to: prefs.to }, prefs.harness, { maxFiles, maxBytes: Math.round(maxMiB * 1024 * 1024), maxSeconds: 1800 }, includeConfidential); if (!disposed) { job = result; lastJobVersion = signature(result); settings = false } }
    catch (e) { if (!disposed) error = errorText(e) }
    finally { if (!disposed) starting = false }
  }
  async function stop() { if (stopping) return; stopping = true; try { job = await api.stop() } catch (e) { error = errorText(e) } finally { stopping = false } }
  async function dismissRecovery() {
    if (!job?.canDismissRecovery || stopping) return
    stopping = true
    try { job = await api.dismissJob(job.id) } catch (e) { error = errorText(e) } finally { stopping = false }
  }
  function signature(value: Job | null): string { return value ? `${value.id}:${value.state}:${value.processed}:${value.reused}:${value.failed}` : '' }
  async function checkFreshness(force = false) {
    if (isMeetings) return
    const data = snapshot
    if (!data || (!force && Date.now() - lastChecked < 10_000)) return
    lastChecked = Date.now()
    try {
      const status = await api.indexStatus(data.snapshotId)
      if (disposed || snapshot !== data) return
      if (!status.valid) {
        selectedId = ''; snapshot = null; terrain = null; worker?.cancel()
        if (status.reason === 'CAPABILITY_DENIED') { error = '索引访问权限已撤回。'; return }
        notice = '来源或索引配置已变化，正在更新地图。'; await load()
      }
    } catch (e) { if (!disposed && snapshot === data) { selectedId = ''; snapshot = null; terrain = null; worker?.cancel(); error = `索引状态无法核实，已收起旧内容：${errorText(e)}` } }
  }
  async function poll() {
    if (polling || disposed) return
    polling = true
    try {
      await checkFreshness()
      if (busy && !isMeetings) {
        const result = await api.job()
        if (disposed) return
        if (result) {
          const changed = signature(result) !== lastJobVersion; job = result
          if (changed && !loading && !starting) { lastJobVersion = signature(result); await load() }
        }
      }
    } catch (e) { if (!disposed) notice = `任务状态暂不可用：${errorText(e)}` }
    finally { polling = false }
  }
  function keydown(e: KeyboardEvent) { if (e.key === 'Escape') { selectedId = ''; selectedRelationId = ''; settings = false; showDirectory = false; showCoverage = false; rebuildConfirm = false } }
  onMount(() => {
    worker = new TerrainWorkerClient()
    const initialRequest = requestId, initialPreferences = preferenceRevision
    void (async () => {
      try {
        const saved = await api.settings()
        if (!disposed && requestId === initialRequest && preferenceRevision === initialPreferences) {
          for (const key of ['vault_index', 'meetings_knowledge'] as const) {
            const value = saved.settings.datasets?.preferences?.[key]
            if (value) datasetPreferences[key] = restorePreferences(value)
          }
          dataset = saved.settings.datasets?.active === 'meetings_knowledge' ? 'meetings_knowledge' : 'vault_index'
          prefs = restorePreferences(datasetPreferences[dataset] ?? (dataset === 'vault_index' ? saved.settings.browser : undefined))
        }
      }
      catch { /* A settings failure does not prevent local index browsing. */ }
      if (!disposed) { void loadProviders(); if (requestId === initialRequest) await load() }
    })()
    const timer = setInterval(poll, 2000)
    const focus = () => { if (!loading) void checkFreshness(true) }
    window.addEventListener('focus', focus)
    return () => { disposed = true; ++requestId; ++computationId; clearInterval(timer); worker?.dispose(); meetingParse?.abort(); window.removeEventListener('focus', focus) }
  })
</script>

<svelte:window onkeydown={keydown} />
<div class="strata ui-surface">
  <header class="toolbar">
    <div class="brand"><span aria-hidden="true">△</span> STRATA <small>层峦</small></div>
    <select class="dataset-select" aria-label="数据集" value={dataset} disabled={busy || starting} onchange={e => changeDataset(e.currentTarget.value)}><option value="vault_index">全 Vault 索引</option><option value="meetings_knowledge">会议知识</option></select>
    <div class="dates"><span>{isMeetings ? '会议日期' : '文档日期'}</span><input aria-label="开始日期" type="date" bind:value={prefs.from} onchange={dateChanged} /><span>—</span><input aria-label="结束日期" type="date" bind:value={prefs.to} onchange={dateChanged} /><select aria-label="日期快捷范围" value="" onchange={e => setRange(e.currentTarget.value)}><option value="">日期范围</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="all">全部日期</option></select></div>
    <div class="toolbar-actions">
      <div class="view-switch" aria-label="地图视角"><button aria-pressed={prefs.view === '2d'} onclick={() => { prefs.view = '2d'; persist() }}>等高线</button><button aria-pressed={prefs.view === '3d'} onclick={() => { prefs.view = '3d'; persist() }}>三维山体</button></div>
      <button aria-pressed={prefs.personal} onclick={() => { prefs.personal = !prefs.personal; persist() }}>{isMeetings ? '核心优先' : '个人优先'}</button>
      <button aria-pressed={prefs.relations} onclick={() => { prefs.relations = !prefs.relations; persist() }}>关系</button>
      <button aria-label="刷新索引与知识" disabled={loading} onclick={() => load()}>刷新</button>
      <button aria-expanded={showDirectory} aria-controls="strata-directory" onclick={() => { showDirectory = !showDirectory; settings = false }} disabled={!terrain}>目录</button>
      <button aria-expanded={settings} aria-controls="strata-settings" onclick={() => { settings = !settings; showDirectory = false }}>设置</button>
    </div>
  </header>
  <main class="map-area">
    <TerrainMap bind:this={map} {dataset} {selectedId} result={terrain} view={prefs.view} personal={prefs.personal} relations={snapshot?.relations ?? []} showRelations={prefs.relations} level={prefs.level} verticalScale={prefs.verticalScale} onselect={selectNode} onview={v => { prefs.view = v; persist() }} onfocus={focusRegion} onerror={message => notice = message} />
    <div class="status" aria-live="polite">
      {#if loading || computing}<span class="progress-dot"></span>{loading ? (isMeetings ? '正在读取会议知识…' : '正在读取索引…') : '正在计算地形…'}
      {:else if snapshot && isMeetings}<button onclick={() => showCoverage = !showCoverage} aria-expanded={showCoverage}>会议知识 · {visibleNodes.length} 条 · {selectedMeetings} 场会议</button>
      {:else if snapshot}<button onclick={() => showCoverage = !showCoverage} aria-expanded={showCoverage}>{verifiedCount ? `${verifiedCount} 个知识点 · ${visibleNodes.length - verifiedCount} 个候选` : `索引候选 · ${visibleNodes.length} 篇`} · {snapshot.coverage.dateInferred} 篇日期推定</button>{/if}
      {#if busy}<span>{jobLabels[job!.state] ?? job!.state} · {job!.processed} / {job!.selected} 篇</span><button disabled={stopping || job!.stopRequested} onclick={stop}>{job!.stopRequested ? '停止已请求' : '停止后续批次'}</button>{/if}
    </div>
    {#if error}<div class="message error" role="alert"><span>{error}</span><button onclick={() => load()} disabled={loading}>重试</button><button aria-label="收起错误" onclick={() => error = ''}>×</button></div>
    {:else if notice}<div class="message" role="status"><span>{notice}</span><button aria-label="收起提示" onclick={() => notice = ''}>×</button></div>{/if}

    {#if settings}
      <section class="settings-panel menu-panel" id="strata-settings" aria-label="地形与深读设置">
        <div class="panel-title"><strong>地图设置</strong><button aria-label="关闭设置" onclick={() => settings = false}>×</button></div>
        <label>显示层级<select bind:value={prefs.level} onchange={persist}><option value="auto">随缩放显示</option><option value="domain">领域</option><option value="topic">主题</option><option value="knowledge">知识点</option></select></label>
        {#if !isMeetings}<label><span>包含明确公开材料</span><input type="checkbox" bind:checked={prefs.includePublic} onchange={visibleChanged} /></label>{/if}
        <label>三维高程倍率 <span>{prefs.verticalScale.toFixed(1)}×</span><input aria-label="三维高程倍率" type="range" min="0.6" max="1.8" step="0.1" bind:value={prefs.verticalScale} onchange={persist} /></label>
        <p class="muted">日期只筛选贡献，保持地图布局与高度刻度。高程表达加权积累，不表示事实真假。</p>
        {#if terrain?.layout.diagnostics.rebuildSuggested}<p class="muted">地图已有拥挤区域，可以重新整理布局。</p>{/if}
        {#if rebuildConfirm}<p>重新整理会改变现有山群位置。</p><div class="inline"><button onclick={() => { rebuildConfirm = false; settings = false; void load(true) }}>重新整理</button><button onclick={() => rebuildConfirm = false}>取消</button></div>{:else}<button class="menu-row" onclick={() => rebuildConfirm = true} disabled={loading || busy}>重新整理地图布局…</button>{/if}
        {#if isMeetings}<hr /><p class="muted">核心与支撑知识按固定权重汇成连续山脊与宽坡。地形以固定尺度平滑表达知识群，单条知识通过近景标记与目录定位，类型用标记颜色区分，关系保留角色。证据强度是抽取记录的声明，不表示事实真假或私密性。点击刷新重新读取会议知识。</p>{:else}
        <hr />
        <div class="panel-title"><strong>从原文深读</strong><button onclick={loadProviders} aria-label="刷新 Agent 列表">↻</button></div>
        <label>Agent<select aria-label="深读 Agent" bind:value={prefs.harness} onchange={persist}><option value="" disabled>选择 Agent</option>{#each providers as p}<option value={p.id} disabled={!supportsExtraction(p)}>{p.name}{supportsExtraction(p) ? '' : '（需更新或配置）'}</option>{/each}</select></label>
        <p class="muted">模型：{provider?.harness?.default_model || '由所选 Agent 的配置决定'}。仅点击“开始深读”才会把本次原文交给该 Agent。</p>
        <label>最多文档数<input aria-label="深读文档预算" type="number" min="1" max="500" bind:value={maxFiles} /></label>
        <label>正文预算（MiB）<input aria-label="深读字节预算" type="number" min="0.1" max="8" step="0.1" bind:value={maxMiB} /></label>
        <label><span>包括明确标为私密的材料</span><input type="checkbox" bind:checked={includeConfidential} /></label>
        <p class="muted">{prefs.from} — {prefs.to} · {snapshot?.coverage.selected ?? 0} 篇匹配，{snapshot?.coverage.confidential ?? 0} 篇明确私密，{snapshot?.coverage.unknownConfidentiality ?? 0} 篇保密性未知。未知材料也在所选范围内，敏感内容请先明确标注。任务最长 30 分钟。</p>
        <button class="primary" onclick={extract} disabled={!canExtract || busy || loading || starting || !!dateError || !Number.isFinite(maxFiles) || maxFiles < 1 || maxFiles > 500 || !Number.isFinite(maxMiB) || maxMiB < .1 || maxMiB > 8}>{starting ? '正在启动…' : '开始深读'}</button>
        {#if !canExtract}<p class="muted">需要支持 STRATA 隔离深读任务的 Agent。本地候选地形仍可使用。</p>{/if}
        {#if job}<div class="job-summary"><strong>{jobLabels[job.state] ?? job.state}</strong><p>{job.message}</p><small>{job.processed} 篇完成 · {job.reused} 篇复用 · {job.skipped} 篇跳过 · {job.failed} 篇失败 · {(job.inputBytes / 1024).toFixed(1)} KiB 已发送</small>{#if job.error}<p role="alert">{job.error}</p>{/if}{#if job.canDismissRecovery}<p>远程任务可能仍在运行。放弃恢复仅解除本地等待，不会撤销已发送内容或取消远程任务。</p><button disabled={stopping} onclick={dismissRecovery}>放弃本次恢复</button>{/if}</div>{/if}
        {/if}
      </section>
    {/if}

    {#if showDirectory && terrain}
      <nav class="directory menu-panel" id="strata-directory" aria-label="知识层级目录">
        <div class="panel-title"><strong>知识目录</strong><button aria-label="关闭目录" onclick={() => showDirectory = false}>×</button></div>
        <input type="search" placeholder={isMeetings ? '查找知识或关系' : '查找知识或候选'} aria-label="查找知识或候选" bind:value={search} oninput={() => directoryPage = 0} />
        {#if isMeetings}<div class="inline"><button aria-pressed={directoryKind === 'knowledge'} onclick={() => { directoryKind = 'knowledge'; directoryPage = 0 }}>知识点</button><button aria-pressed={directoryKind === 'relations'} onclick={() => { directoryKind = 'relations'; directoryPage = 0 }}>关系 · {directoryRelations.length}</button></div>{/if}
        <div class="breadcrumbs"><button onclick={() => { directoryDomain = ''; directoryTopic = ''; directoryPage = 0 }}>全部领域</button>{#if directoryDomain}<span>›</span><button onclick={() => { directoryTopic = ''; directoryPage = 0 }}>{terrain.layout.domains.find(c => c.id === directoryDomain)?.name}</button>{/if}{#if directoryTopic}<span>›</span><span>{terrain.layout.topics.find(c => c.id === directoryTopic)?.name}</span>{/if}</div>
        <div class="directory-items">
          {#if isMeetings && directoryKind === 'relations'}
            {#each directoryRelations.slice(directoryPage * 50, (directoryPage + 1) * 50) as r}<button class="menu-row" onclick={() => { selectedId = ''; selectedRelationId = r.id; showDirectory = false }}><span>{r.title}</span><small>{r.type}</small></button>{/each}
            {#if !directoryRelations.length}<p class="muted">当前日期没有匹配的关系。</p>{/if}
          {:else if search || directoryTopic}
            {#each directoryNodes.slice(directoryPage * 50, (directoryPage + 1) * 50) as n}<button class="menu-row" onclick={() => selectNode(n.id)}><span>{n.title}</span><small>{n.state === 'candidate' ? '候选' : '知识'}</small></button>{/each}
            {#if !directoryNodes.length}<p class="muted">没有匹配的知识点。</p>{/if}
          {:else if directoryDomain}
            {#each directoryTopics as c}<button class="menu-row" onclick={() => { directoryTopic = c.id; directoryPage = 0; map?.focus(c.id) }}><span>{c.name}</span><small>{c.memberIds.filter(id => nodeMap.has(id)).length} ›</small></button>{/each}
          {:else}
            {#each directoryDomains as c}<button class="menu-row" onclick={() => { directoryDomain = c.id; directoryPage = 0; map?.focus(c.id) }}><span>{c.name}</span><small>{c.memberIds.filter(id => nodeMap.has(id)).length} ›</small></button>{/each}
          {/if}
        </div>
        {#if isMeetings && directoryKind === 'relations' && directoryRelations.length > 50}<div class="pagination"><button disabled={!directoryPage} onclick={() => directoryPage--}>上一页</button><span>{directoryPage + 1} / {Math.ceil(directoryRelations.length / 50)}</span><button disabled={(directoryPage + 1) * 50 >= directoryRelations.length} onclick={() => directoryPage++}>下一页</button></div>
        {:else if (search || directoryTopic) && directoryNodes.length > 50}<div class="pagination"><button disabled={!directoryPage} onclick={() => directoryPage--}>上一页</button><span>{directoryPage + 1} / {Math.ceil(directoryNodes.length / 50)}</span><button disabled={(directoryPage + 1) * 50 >= directoryNodes.length} onclick={() => directoryPage++}>下一页</button></div>{/if}
      </nav>
    {/if}

    {#if selected}
      <section class="evidence-panel" aria-label="知识与原文证据">
        <div class="panel-title"><strong>{selected.meeting ? '会议知识与来源' : selected.state === 'verified' ? '原文证据' : '索引候选'}</strong><button bind:this={closeEvidence} aria-label="关闭证据" onclick={() => selectedId = ''}>×</button></div>
        <div class="evidence-body">
          <h2>{selected.title}</h2>
          {#if selected.meeting}<MeetingDetails metadata={selected.meeting} onopen={sourceId => openMeeting(selected, sourceId)} />{:else}
          <p class="metadata">{ownerLabels[selected.ownerSpecificity]} · {confidentialityLabels[selected.confidentiality]} · {selected.kind}</p>
          {#if selected.classificationReason}<p class="muted">{selected.classificationReason}</p>{/if}
          {#if selected.speaker}<p class="muted">陈述者：{selected.speaker}</p>{/if}
          {#if selected.conditions?.length}<p>适用条件：{selected.conditions.join('；')}</p>{/if}
          {#if selected.limits?.length}<p>范围与限制：{selected.limits.join('；')}</p>{/if}
          {#if selected.epistemic}<p class="muted">{selected.epistemic}</p>{/if}
          {#if selected.state === 'candidate'}<p>尚未完成本次原文证据核对；此项暂作地图定位参考。</p><button onclick={() => openSource(selected)}>打开原文</button>{/if}
          {#each selected.evidence as evidence}
            <article class="source"><blockquote>{evidence.quote}</blockquote><p>{evidence.path} · L{evidence.lineStart}–L{evidence.lineEnd}</p><button onclick={() => openSource(selected, evidence.id)}>打开原文</button></article>
          {/each}
          {#each selectedFiles as file}<p class="metadata">{originLabels[file.indexOrigin] ?? file.indexOrigin} · 文档日期 {file.docDate}{file.dateInferred ? '（由修改时间推定）' : ''} · 索引优先级 {file.filePriority.toFixed(3)}</p>{/each}
          {/if}
          {#if selectedRelations.length && isMeetings}<h3>抽取关系 · {selectedRelations.length}</h3>{#each selectedRelations as relation}<details class="related"><summary>{relation.type} · {relation.title}</summary>{#each relation.participants ?? [] as participant}<button disabled={!nodeMap.has(participant.nodeId)} onclick={() => selectNode(participant.nodeId)}>{participant.role} · {snapshot?.nodes.find(n => n.id === participant.nodeId)?.title ?? '当前范围外对象'}</button>{/each}{#if relation.meeting}<MeetingDetails metadata={relation.meeting} onopen={sourceId => openMeetingRelation(relation.meeting!, sourceId)} />{/if}</details>{/each}
          {:else if selectedRelations.length}<h3>有证据的关系</h3>{#each selectedRelations as relation}<div class="related"><button onclick={() => selectNode(relation.source === selected.id ? relation.target : relation.source)}>{relation.type} · {nodeMap.get(relation.source === selected.id ? relation.target : relation.source)?.title}</button><p>{relation.title}</p>{#each relation.evidence as evidence}<blockquote>{evidence.quote}</blockquote>{/each}</div>{/each}{/if}
          {#if selected.state === 'verified'}<p class="muted">“引文已核对”表示来源与结构校验通过，不代表事实已获外部验证。</p>{/if}
        </div>
      </section>
    {/if}

    {#if selectedRelation?.meeting && isMeetings}
      <section class="evidence-panel" aria-label="会议关系详情">
        <div class="panel-title"><strong>会议关系</strong><button aria-label="关闭关系详情" onclick={() => selectedRelationId = ''}>×</button></div>
        <div class="evidence-body"><h2>{selectedRelation.title}</h2><MeetingDetails metadata={selectedRelation.meeting} onopen={sourceId => openMeetingRelation(selectedRelation.meeting!, sourceId)} /></div>
      </section>
    {/if}
    {#if showCoverage && snapshot?.meetings}
      <section class="coverage-panel" aria-label="会议知识覆盖情况"><div class="panel-title"><strong>会议知识覆盖</strong><button aria-label="关闭覆盖情况" onclick={() => showCoverage = false}>×</button></div><dl><dt>知识文件</dt><dd>{snapshot.meetings.datasets}</dd><dt>当前日期会议</dt><dd>{selectedMeetings}</dd><dt>可显示知识</dt><dd>{snapshot.nodes.length}</dd><dt>抽取关系</dt><dd>{snapshot.meetings.relations}</dd><dt>缺少提取结果</dt><dd>{snapshot.meetings.missingKnowledge}</dd><dt>无效文件 / 隔离记录</dt><dd>{snapshot.meetings.invalidFiles} / {snapshot.meetings.isolatedRecords}</dd></dl><p class="muted">读取 ssot/meetings 下标准 knowledge.json；试验副本不重复计入。日期按会议元数据；已有抽取证据未在此次浏览中重新核对原文。</p>{#if snapshot.meetings.diagnosticCount}<details><summary>校验提示 · {snapshot.meetings.diagnosticCount}</summary>{#each snapshot.meetings.diagnostics as d}<p class="muted">{d.message}</p>{/each}</details>{/if}</section>
    {:else if showCoverage && snapshot}
      <section class="coverage-panel" aria-label="索引覆盖情况"><div class="panel-title"><strong>覆盖情况</strong><button aria-label="关闭覆盖情况" onclick={() => showCoverage = false}>×</button></div><dl><dt>已有索引</dt><dd>{snapshot.coverage.indexed} 篇</dd><dt>日期范围</dt><dd>{snapshot.coverage.selected} 篇</dd><dt>已深读</dt><dd>{snapshot.coverage.processed} 篇</dd><dt>仍为候选</dt><dd>{snapshot.coverage.candidate} 篇</dd><dt>本次证据待核对</dt><dd>{snapshot.coverage.proofDeferred ?? 0} 篇</dd><dt>已排除 / 待更新</dt><dd>{snapshot.coverage.excluded} / {snapshot.coverage.stale}</dd><dt>修改时间推定日期</dt><dd>{snapshot.coverage.dateInferred} 篇</dd></dl><p class="muted">布局依据本地索引；深读仅限主动选择的日期和预算。索引仍在建立时，只展示已有覆盖。本次缓存证据最多核对 500 篇 / 16 MiB；超出部分收起引文，可缩小日期后查看。</p></section>
    {/if}
  </main>
</div>
