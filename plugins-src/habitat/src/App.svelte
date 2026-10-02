<script lang="ts">
  import { onMount } from 'svelte'
  import CityView from './components/CityView.svelte'
  import { api } from './lib/bridge'
  import { UNASSIGNED_TOPIC, causeLabel, dateLabel, edgeLabel, errorText, filterNodes, graphNodes, isKeywordGraph, locatorLabel, nodeFamilyCounts, statusLabel, typeLabel } from './lib/domain'
  import type { Diff, Job, Snapshot, State, Version } from './lib/types'

  let hostState = $state.raw<State | null>(null), snapshot = $state.raw<Snapshot | null>(null)
  let job = $state<Job | null>(null), loading = $state(true), starting = $state(false), stopping = $state(false)
  let error = $state(''), notice = $state(''), selectedId = $state(''), query = $state(''), topic = $state(''), page = $state(0)
  let showHistory = $state(false), showCoverage = $state(false), historyLoading = $state(false), versionLoading = $state(false), diffLoading = $state(false)
  let versions = $state<Version[]>([]), activeCommit = $state(''), compareFrom = $state(''), compareTo = $state(''), diff = $state.raw<Diff | null>(null)
  let historyTruncated = $state(false)
  let opening = $state('')
  let previewMode = $state(false)
  let disposed = false, stateEpoch = 0, versionEpoch = 0, diffEpoch = 0, historyEpoch = 0, polling = false, jobEpoch = 0
  const busy = $derived(job?.state === 'running' || starting)
  const keywordGraph = $derived(isKeywordGraph(snapshot))
  const knowledgeNodes = $derived(graphNodes(snapshot))
  const filtered = $derived(filterNodes(snapshot, query, topic))
  const topics = $derived(snapshot?.nodes.filter(n => n.nodeType === 'topic') ?? [])
  const topicSizes = $derived.by(() => { const sizes = new Map<string, number>(); for (const member of snapshot?.memberships ?? []) { if (keywordGraph && member.role !== 'primary') continue; sizes.set(member.topic, (sizes.get(member.topic) ?? 0) + 1) }; return sizes })
  const pageCount = $derived(Math.max(1, Math.ceil(filtered.length / 60)))
  const pageItems = $derived(filtered.slice(Math.min(page, pageCount - 1) * 60, (Math.min(page, pageCount - 1) + 1) * 60))
  const selected = $derived(snapshot?.nodes.find(n => n.id === selectedId))
  const nodeById = $derived(new Map(snapshot?.nodes.map(n => [n.id, n]) ?? []))
  const sourceById = $derived(new Map(snapshot?.sources.map(s => [s.id, s]) ?? []))
  const selectedEvidence = $derived.by(() => { const ids = new Set(selected?.evidence ?? []); return ids.size ? snapshot?.evidence.filter(e => ids.has(e.id)) ?? [] : [] })
  const selectedMemberships = $derived(snapshot?.memberships.filter(m => m.node === selectedId) ?? [])
  const selectedEdges = $derived(snapshot?.edges.filter(e => e.participants.some(p => p.node === selectedId)) ?? [])
  const changedIds = $derived(new Set(diff ? [...diff.added, ...diff.changed, ...diff.renamed].map(n => n.id) : []))
  const coverage = $derived(snapshot?.meta.coverage)
  const families = $derived(nodeFamilyCounts(snapshot))
  const selectedFamilies = $derived(families.get(selectedId))
  const progress = $derived(job?.total ? Math.min(100, Math.round(job.processed / job.total * 100)) : 0)

  function selectCommunity(id: string) { topic = id; query = ''; page = 0; selectedId = ''; notice = '' }
  function select(id: string) { selectedId = id; notice = '' }
  function clearForVault() { ++versionEpoch; ++diffEpoch; ++historyEpoch; ++jobEpoch; snapshot = null; activeCommit = ''; previewMode = false; selectedId = ''; topic = ''; query = ''; page = 0; diff = null; versions = []; historyTruncated = false; compareFrom = ''; compareTo = ''; versionLoading = false; historyLoading = false; diffLoading = false; starting = false }
  function showPreview() { if (!hostState?.preview) return; ++versionEpoch; activeCommit = ''; previewMode = true; snapshot = hostState.preview; selectedId = ''; topic = ''; query = ''; page = 0; diff = null }
  async function loadState() {
    const epoch = ++stateEpoch
    try {
      const next = await api.state()
      if (disposed || epoch !== stateEpoch) return
      if (hostState?.vaultKey && next.vaultKey !== hostState.vaultKey) clearForVault()
      if (hostState?.snapshot?.meta.snapshotId !== next.snapshot?.meta.snapshotId) { ++diffEpoch; diff = null; diffLoading = false }
      hostState = next; job = next.job
      if (next.readOnlyPreview && next.preview) { previewMode = true; snapshot = next.preview }
      else if (previewMode && next.preview) snapshot = next.preview
      else if (!activeCommit) { previewMode = false; snapshot = next.snapshot }
      error = ''
    } catch (e) {
      if (disposed || epoch !== stateEpoch) return
      clearForVault(); hostState = null; job = null; error = errorText(e)
    } finally { if (!disposed && epoch === stateEpoch) loading = false }
  }
  async function generate() {
    if (busy) return
    if (hostState?.pending) { await recoverPending(false); return }
    const epoch = ++jobEpoch; starting = true; error = ''; notice = ''
    try {
      const next = await api.generate()
      if (disposed || epoch !== jobEpoch) return
      job = next
      if (next.state !== 'running') await loadState()
    } catch (e) { if (!disposed && epoch === jobEpoch) error = errorText(e) }
    finally { if (!disposed && epoch === jobEpoch) starting = false }
  }
  async function recoverPending(restart: boolean) {
    if (starting) return
    const vaultKey = hostState?.vaultKey
    starting = true; error = ''
    try {
      if (restart) await api.discardPending(); else await api.retrySave()
      if (disposed) return
      await loadState()
      if (showHistory) await loadHistory()
      starting = false
      if (restart && hostState?.vaultKey === vaultKey && !hostState?.pending && !error) await generate()
    } catch (e) { if (!disposed) error = errorText(e) }
    finally { if (!disposed) starting = false }
  }
  async function cancel() {
    if (stopping) return
    const epoch = ++jobEpoch
    stopping = true
    try { const next = await api.cancel(); if (!disposed && epoch === jobEpoch) job = next }
    catch (e) { if (!disposed && epoch === jobEpoch) error = errorText(e) }
    finally { if (!disposed) stopping = false }
  }
  async function poll() {
    if (disposed || polling || job?.state !== 'running') return
    polling = true; const id = job.id, epoch = jobEpoch
    try {
      const next = await api.job()
      if (disposed || epoch !== jobEpoch || job?.id !== id) return
      job = next
      if (!next || next.state !== 'running') { await loadState(); if (showHistory) await loadHistory() }
    } catch (e) { if (!disposed && epoch === jobEpoch) error = errorText(e) }
    finally { polling = false }
  }
  async function loadHistory() {
    const epoch = ++historyEpoch; historyLoading = true
    try {
      const result = await api.history()
      if (disposed || epoch !== historyEpoch) return
      versions = result.versions; historyTruncated = result.truncated === true
      if (!versions.some(v => v.commit === compareFrom)) compareFrom = versions[1]?.commit ?? versions[0]?.commit ?? ''
    } catch (e) { if (!disposed && epoch === historyEpoch) error = errorText(e) }
    finally { if (!disposed && epoch === historyEpoch) historyLoading = false }
  }
  async function toggleHistory() { showHistory = !showHistory; if (showHistory) await loadHistory() }
  async function readVersion(commit: string) {
    const epoch = ++versionEpoch; versionLoading = true; error = ''
    if (!commit) { activeCommit = ''; previewMode = false; snapshot = hostState?.snapshot ?? null; if (!snapshot?.nodes.some(n => n.id === selectedId)) selectedId = ''; if (!snapshot?.nodes.some(n => n.id === topic)) topic = ''; versionLoading = false; return }
    try {
      const result = await api.version(commit)
      if (disposed || epoch !== versionEpoch) return
      snapshot = result.snapshot; activeCommit = commit; previewMode = false
      if (!snapshot.nodes.some(n => n.id === selectedId)) selectedId = ''
      if (!snapshot.nodes.some(n => n.id === topic)) topic = ''
      page = 0
    } catch (e) { if (!disposed && epoch === versionEpoch) error = errorText(e) }
    finally { if (!disposed && epoch === versionEpoch) versionLoading = false }
  }
  async function compare() {
    if (!compareFrom) return
    const epoch = ++diffEpoch; diffLoading = true; diff = null; error = ''
    try { const result = await api.diff(compareFrom, compareTo || undefined); if (!disposed && epoch === diffEpoch) diff = result }
    catch (e) { if (!disposed && epoch === diffEpoch) error = errorText(e) }
    finally { if (!disposed && epoch === diffEpoch) diffLoading = false }
  }
  async function openEvidence(id: string) {
    opening = id; notice = ''; const epoch = versionEpoch
    try { const target = await api.open(id, activeCommit || undefined, previewMode); if (!disposed && epoch === versionEpoch) notice = `已打开来源 · ${locatorLabel(target.locator)}` }
    catch (e) { if (!disposed && epoch === versionEpoch) error = errorText(e) }
    finally { if (!disposed) opening = '' }
  }
  onMount(() => {
    void loadState()
    const timer = setInterval(poll, 1500), focus = () => { if (!starting) void loadState() }
    window.addEventListener('focus', focus)
    return () => { disposed = true; ++stateEpoch; ++versionEpoch; ++diffEpoch; ++historyEpoch; ++jobEpoch; clearInterval(timer); window.removeEventListener('focus', focus) }
  })
</script>

<div class="habitat">
  <header class="toolbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M4 23 20 14 36 23 20 32Z" fill="currentColor" opacity=".14"/><path d="m8 21 8-5 8 5v12l-8 5-8-5Z" fill="currentColor" opacity=".55"/><path d="m19 9 8-5 8 5v19l-8 5-8-5Z" fill="currentColor"/><path d="m19 9 8 5 8-5M27 14v19" stroke="#fbf8ef" stroke-width="1.2" opacity=".55"/><path d="m8 21 8 5 8-5M16 26v12" stroke="#fbf8ef" stroke-width="1.2" opacity=".6"/></svg></span><div>HABITAT <small>心城</small><span class="brand-sub">A PLACE FOR IDEAS TO GROW</span></div></div>
    <div class="toolbar-center">{#if snapshot}<span class="version-dot"></span><span>{previewMode ? '未保存预览' : activeCommit ? '历史版本' : '当前结构'} · {dateLabel(snapshot.meta.generatedAt)}</span>{:else}<span>你的 Vault，一座正在形成的城市</span>{/if}</div>
    <div class="toolbar-actions"><button class:active={showHistory} disabled={!hostState?.historyAvailable && !hostState?.readOnlyPreview} onclick={toggleHistory}>历史</button><button class:active={showCoverage} disabled={!snapshot} onclick={() => showCoverage = !showCoverage}>覆盖范围</button><button class="primary" disabled={busy || loading} onclick={generate}>{starting ? '正在启动…' : hostState?.pending ? '重试保存' : snapshot ? '重新解析' : '生成知识结构'}</button></div>
  </header>
  {#if error}<div class="banner error" role="alert"><span>{error}</span><button onclick={() => { error = ''; void loadState() }}>重试读取</button></div>{/if}
  {#if notice}<div class="banner notice" role="status">{notice}<button aria-label="关闭提示" onclick={() => notice = ''}>×</button></div>{/if}
  {#if job?.state === 'running'}<div class="job-bar" role="status"><span class="pulse"></span><strong>{job.message || '正在提取知识结构'}</strong><progress max="100" value={job.total ? progress : undefined}></progress><span>{job.processed.toLocaleString()}{job.total ? ` / ${job.total.toLocaleString()}` : ''}</span><button disabled={stopping} onclick={cancel}>{stopping ? '正在取消…' : '取消'}</button></div>{:else if job?.state === 'failed'}<div class="banner error" role="alert">{job.error || job.message || '本次解析未完成'}<span>上个已保存版本仍可浏览。</span></div>{:else if job?.state === 'cancelled'}<div class="banner notice">本次解析已取消，已保存的版本保持不变。</div>{/if}
  {#if hostState?.pending}<div class="banner notice"><span>结构版本尚未完成 Git 保存。重试后才会进入已保存历史。</span><button disabled={busy} onclick={() => recoverPending(true)}>保留草稿并重新解析</button></div>{/if}
  {#if hostState?.historyError}<div class="banner notice">历史保存暂不可用：{hostState.historyError}</div>{/if}
  {#if hostState?.preview && !previewMode}<div class="banner notice"><span>本次解析有一份尚未进入 Git 历史的完整预览。</span><button onclick={showPreview}>查看未保存预览</button></div>{/if}
  {#if previewMode}<div class="historical-bar"><span>{hostState?.readOnlyPreview ? '只读预览 · 未存入 Vault · 本地服务不连接 note.md 宿主' : '未保存预览 · 尚未成为历史版本'}</span>{#if !hostState?.readOnlyPreview}<button onclick={() => readVersion('')}>返回当前结构</button>{/if}</div>{/if}
  {#if activeCommit}<div class="historical-bar"><span>正在只读浏览历史 · {activeCommit.slice(0, 10)} · {snapshot ? causeLabel(snapshot.meta.changeCause) : ''}</span><button onclick={() => readVersion('')}>返回当前结构</button></div>{/if}
  <div class="workspace">
    {#if snapshot}
      <aside class="directory" aria-label="知识结构列表">
        <div class="directory-kicker">YOUR KNOWLEDGE ATLAS</div><div class="section-title"><span>探索这座城市</span><small>{knowledgeNodes.length.toLocaleString()} {keywordGraph ? '个关键词' : '个对象'}</small></div>
        <label class="search"><span aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span><input aria-label="搜索概念与别名" placeholder="搜索概念与别名" bind:value={query} oninput={() => page = 0}></label>
        <select aria-label="筛选主题" bind:value={topic} onchange={() => page = 0}><option value="">全部主题</option>{#if keywordGraph}<option value={UNASSIGNED_TOPIC}>待连接关键词（尚无社区）</option>{/if}{#each topics as item}<option value={item.id}>{item.label} · {topicSizes.get(item.id) ?? 0} {keywordGraph ? '个关键词' : '个对象'}</option>{/each}</select>
        <div class="list-meta">{filtered.length.toLocaleString()} {keywordGraph ? '个关键词' : '个对象'} <span>{keywordGraph ? '来源与关键词分开呈现' : '旧版对象图'}</span></div>
        <div class="node-list">{#each pageItems as node (node.id)}<button class:selected={node.id === selectedId} class="node-row" onclick={() => select(node.id)}><span class="node-glyph" class:project={node.nodeType === 'project'} class:topic={node.nodeType === 'topic'} aria-hidden="true">{node.nodeType === 'project' ? '▥' : node.nodeType === 'topic' ? '▱' : '▰'}</span><span><strong>{node.label}</strong><small>{typeLabel(node.nodeType)} · {statusLabel(node.status)}</small></span></button>{/each}{#if !filtered.length}<p class="quiet-empty">没有匹配的对象。试试其他词，或切换到全部主题。</p>{/if}</div>
        <div class="pagination"><button aria-label="上一页" disabled={page === 0} onclick={() => page--}>‹</button><span>{Math.min(page + 1, pageCount)} / {pageCount}</span><button aria-label="下一页" disabled={page + 1 >= pageCount} onclick={() => page++}>›</button></div>
        <div class="directory-footer">{snapshot.edges.length.toLocaleString()} 条关系 <span>·</span> {snapshot.sources.length.toLocaleString()} 份来源</div>
      </aside>
      <main class="landscape" aria-label="知识城市">
        <CityView nodes={filtered} layout={snapshot.layout} edges={snapshot.edges} memberships={snapshot.memberships} {topics} {keywordGraph} oncommunity={selectCommunity} {families} {selectedId} {changedIds} scopeKey={(hostState?.vaultKey ?? '') + '\0' + query + '\0' + topic} onselect={select} />
        {#if !snapshot.nodes.length}<div class="empty-overlay"><h2>材料已读取，结构尚待形成</h2><p>这次解析没有找到可展示的概念。可查看覆盖范围和未归属材料。</p></div>{/if}
        {#if versionLoading}<div class="loading-overlay" role="status">正在读取历史版本…</div>{/if}
        {#if selected}<section class="detail-panel" aria-label="概念详情">
          <div class="detail-heading"><span class="eyebrow">{typeLabel(selected.nodeType)} / {statusLabel(selected.status)}</span><button aria-label="关闭详情" onclick={() => selectedId = ''}>×</button></div>
          <h2>{selected.label}</h2>
          {#if selected.intentStatus}<p class="metadata">意图状态：{statusLabel(selected.intentStatus)}</p>{/if}
          {#if selected.aliases?.length}<p class="metadata">别名：{selected.aliases.join(' · ')}</p>{/if}
          {#if selectedFamilies}<p class="metadata">已核对来源组 {selectedFamilies.verified} · 暂定 {selectedFamilies.provisional} · 谱系未知 {selectedFamilies.unresolved}</p>{/if}
          {#if selectedMemberships.length}<div class="memberships">{#each selectedMemberships as membership}<button onclick={() => selectCommunity(membership.topic)}>{nodeById.get(membership.topic)?.label ?? membership.topic}<small>{statusLabel(membership.role)}</small></button>{/each}</div>{/if}
          <div class="detail-scroll"><h3>来源依据 <small>{selectedEvidence.length}</small></h3>
          {#each selectedEvidence.slice(0, 40) as evidence}
            {@const source = sourceById.get(evidence.source)}
            <div class="evidence-card"><div class="evidence-path">{source?.path ?? '来源记录不可用'}</div><p>{locatorLabel(evidence.locator)}</p><div class="evidence-meta"><span>{statusLabel(evidence.authorship)}</span><span>{statusLabel(evidence.verification)}</span>{#if evidence.granularity === 'whole_source' || evidence.granularity === 'file'}<span>文件级依据</span>{/if}</div><button disabled={!source || opening === evidence.id} onclick={() => openEvidence(evidence.id)}>{opening === evidence.id ? '正在核对…' : '核对并打开原文'} ↗</button></div>
          {/each}
          {#if !selectedEvidence.length}<p class="muted">没有直接原文依据；可通过主题成员继续查看。</p>{:else if selectedEvidence.length > 40}<p class="muted">先展示前 40 条依据，共 {selectedEvidence.length} 条。</p>{/if}
          {#if selectedEdges.length}<h3>相关关系 <small>{selectedEdges.length}</small></h3>{#if keywordGraph}<p class="muted">统计共现表示关键词在至少两个去重来源组的短段落或大纲节点中共同出现，不自动推断因果、归属等语义事实；未知谱系不等于独立来源。</p>{/if}{#each selectedEdges.slice(0, 20) as edge}<div class="relation-card"><div><strong title={edge.edgeType}>{edgeLabel(edge.edgeType)}</strong><small>{edge.status === 'imported' ? 'AI 提取声明' : statusLabel(edge.status)}</small></div>{#each edge.participants.filter(p => p.node !== selectedId).slice(0, 8) as participant}<button onclick={() => select(participant.node)}>{nodeById.get(participant.node)?.label ?? participant.node}<small>{participant.role}</small></button>{/each}<p>已核对来源组 {edge.verifiedFamilies} · 暂定 {edge.provisionalFamilies} · 谱系未知 {edge.unresolvedLineage}</p></div>{/each}{/if}</div>
          <div class="detail-footnote">{hostState?.readOnlyPreview ? '本地预览仅展示定位，打开原文需在 note.md 中核对。' : '位置与材料结构，不代表掌握程度。'}</div>
        </section>{/if}
      </main>
    {:else}
      <main class="empty-state"><div class="empty-symbol" aria-hidden="true">⌂</div><span class="eyebrow">HABITAT · YOUR KNOWLEDGE, IN PLACE</span><h1>{loading ? '正在打开你的城市…' : busy ? '第一座城市正在形成' : '从你的材料开始一座城'}</h1><p>从 Vault 中的概念、链接和来源依据提取结构。<br>每个已保存版本，都能回看它如何形成。</p>{#if !loading && !busy}<button class="primary" onclick={generate}>生成知识结构</button>{/if}<small>本地解析 · 保留候选状态 · 不改写原始笔记</small></main>
    {/if}
    {#if showHistory}<aside class="history-pane" aria-label="结构版本历史"><div class="section-title"><span>城市的形成</span><button aria-label="关闭历史" onclick={() => showHistory = false}>×</button></div><p class="muted">每个版本保留当时的结构。选择版本只改变当前视图。</p><button class="current-version" class:selected={!activeCommit} onclick={() => readVersion('')}>当前结构</button>
      {#if historyLoading}<p role="status">正在读取历史…</p>{:else if !versions.length}<p class="quiet-empty">还没有已保存的历史版本。</p>{/if}
      <div class="version-list">{#each versions as version}<button class="version-row" class:selected={activeCommit === version.commit} onclick={() => readVersion(version.commit)}><span class="timeline-dot"></span><div><strong>{dateLabel(version.generatedAt)}</strong><span>{causeLabel(version.changeCause)}</span><small>{version.nodes} 个对象 · {version.edges} 条关系 · {version.commit.slice(0, 7)}</small></div></button>{/each}</div>
      {#if historyTruncated}<p class="muted">这里只显示最近100个结构版本；更早版本仍保存在Vault的Git历史中</p>{/if}
      {#if versions.length}<section class="compare-controls"><h3>比较两个版本</h3><label>从<select aria-label="比较起始版本" bind:value={compareFrom} onchange={() => { ++diffEpoch; diff = null; diffLoading = false }}>{#each versions as v}<option value={v.commit}>{dateLabel(v.generatedAt)} · {v.commit.slice(0, 7)}</option>{/each}</select></label><label>到<select aria-label="比较目标版本" bind:value={compareTo} onchange={() => { ++diffEpoch; diff = null; diffLoading = false }}><option value="">当前结构</option>{#each versions as v}<option value={v.commit}>{dateLabel(v.generatedAt)} · {v.commit.slice(0, 7)}</option>{/each}</select></label><button class="primary" disabled={diffLoading || !compareFrom || compareFrom === compareTo} onclick={compare}>{diffLoading ? '正在比较…' : '查看结构变化'}</button></section>{/if}
      {#if diff}<section class="diff-result" aria-label="版本差异"><h3>结构变化</h3><p class="muted">{diff.causes.map(causeLabel).join(' · ') || '无结构变化'}{#if !diff.comparable} · 分析条件不同，不作知识增长比较{/if}</p>{#each diff.warnings as warning}<p class="diff-warning">{warning}</p>{/each}<div class="diff-counts"><span><strong>+{diff.added.length}</strong>{diff.comparable ? '新出现' : '新增输出'}</span><span><strong>−{diff.removed.length}</strong>{diff.comparable ? '不再出现' : '不再输出'}</span><span><strong>{diff.renamed.length}</strong>改名</span></div>
        {#each [['新增', diff.added], ['不再出现', diff.removed], ['内容变化', diff.changed]] as [label, items]}{#if (items as typeof diff.added).length}<h4>{label}</h4><ul>{#each (items as typeof diff.added).slice(0, 12) as node}<li>{node.label}</li>{/each}</ul>{#if (items as typeof diff.added).length > 12}<p class="muted">共 {(items as typeof diff.added).length} 项，先展示 12 项。</p>{/if}{/if}{/each}
        {#if diff.renamed.length}<h4>改名</h4><ul>{#each diff.renamed.slice(0, 12) as item}<li>{item.before} → {item.after}</li>{/each}</ul>{/if}<p class="diff-summary">关系 +{diff.edgesAdded.length} / −{diff.edgesRemoved.length} / 更新 {diff.edgesChanged.length}<br>归属变化 {diff.membershipChanges} · 地块变化 {diff.layoutChanges}</p><p class="muted">变化来自内容、依据或解析方法；不直接代表认知变化。</p></section>{/if}
    </aside>{/if}
    {#if showCoverage && coverage}<aside class="coverage-pane" aria-label="解析覆盖范围"><div class="section-title"><span>解析覆盖范围</span><button aria-label="关闭覆盖范围" onclick={() => showCoverage = false}>×</button></div><dl><dt>索引文件</dt><dd>{coverage.indexed.toLocaleString()}</dd><dt>已解析</dt><dd>{coverage.parsed.toLocaleString()}</dd><dt>不可用</dt><dd>{coverage.unavailable.toLocaleString()}</dd><dt>已排除</dt><dd>{coverage.excluded.toLocaleString()}</dd><dt>已有知识数据集</dt><dd>{coverage.knowledgeDatasets.toLocaleString()}</dd><dt>知识数据记录</dt><dd>{coverage.knowledgeRecords.toLocaleString()}</dd><dt>已导入记录</dt><dd>{coverage.importedRecords.toLocaleString()}</dd><dt>隔离记录</dt><dd>{coverage.isolatedRecords.toLocaleString()}</dd><dt>未投影记录</dt><dd>{coverage.unprojectedRecords.toLocaleString()}</dd><dt>未归属来源</dt><dd>{coverage.unassignedSources.toLocaleString()}</dd><dt>待解析链接</dt><dd>{coverage.unresolvedLinks.toLocaleString()}</dd></dl><p class="muted">覆盖量描述本次读取范围；文件数量不等于知识数量。</p>{#if snapshot}<p class="metadata">{snapshot.meta.algorithm.version}<br>{snapshot.meta.snapshotId.slice(0, 20)}…</p>{/if}{#if coverage.diagnosticCount}<p class="muted">共 {coverage.diagnosticCount} 项诊断，先展示前 40 项。</p>{/if}{#each coverage.diagnostics.slice(0, 40) as item}<div class="diagnostic"><strong>{item.code}</strong><p>{item.message}</p><small>{item.path}</small></div>{/each}</aside>{/if}
  </div>
  <footer class="statusbar"><span>{snapshot ? `${coverage?.parsed.toLocaleString()} 份材料已解析` : '等待生成知识结构'}</span><span>{previewMode ? '未保存预览 · 不在历史中' : activeCommit ? '历史视图 · 只读' : hostState?.pending ? '等待 Git 保存' : snapshot ? '持久坐标 · 原文可回溯' : '本地解析，无需调用模型'}</span><span>{snapshot ? `${snapshot.meta.algorithm.version}` : 'HABITAT'}</span></footer>
</div>
