<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { api } from './lib/bridge'
  import { collaborationReview, defaultObservationRange, errorText, jobLabels, jobResultsSignature, localRecentDates, localYesterday, outcomeLabels, queueItemLabels, queueItemState, queueSettled, supportedProviders, supportsAgency, validateObservationRange } from './lib/domain'
  import type { Batch, DaySummary, Job, Provider, Scan } from './lib/types'
  import EpisodeDetail from './lib/EpisodeDetail.svelte'
  let date = $state(localYesterday())
  const defaultRange = defaultObservationRange()
  let generationMode = $state<'single' | 'range'>('single')
  let rangeStart = $state(defaultRange.start)
  let rangeEnd = $state(defaultRange.end)
  let batch = $state<Batch | null>(null)
  let scan = $state<Scan | null>(null)
  let scanLoading = $state(false)
  let scanError = $state('')
  const recentDates = localRecentDates()
  let history = $state<DaySummary[]>([])
  let job = $state<Job | null>(null)
  let providers = $state<Provider[]>([])
  let harness = $state('')
  let providerError = $state('')
  let error = $state('')
  let pollError = $state('')
  let loading = $state(true)
  let busy = $state(false)
  let saving = $state(false)
  let stopping = $state(false)
  let selectedId = $state('')
  let showExcluded = $state(false)
  let expandedColumns = $state<Record<string, boolean>>({})
  let requestVersion = 0
  let scanRequestVersion = 0
  let polling = false
  let disposed = false
  let jobRevision = 0
  let lastResultsSignature = ''
  let pendingResultRefresh = false
  let resultRefreshVersion = 0
  let restoredGenerationMode = false
  const summary = $derived(collaborationReview(batch))
  const running = $derived(job?.state === 'running')
  const range = $derived(validateObservationRange(rangeStart, rangeEnd))
  const selectedProvider = $derived(providers.find(p => p.id === harness))
  const available = $derived(supportsAgency(selectedProvider))
  const visibleEpisodes = $derived(batch?.episodes.filter(e => showExcluded || !batch?.reviews[e.id]?.excluded) ?? [])
  const selected = $derived(visibleEpisodes.find(e => e.id === selectedId) ?? visibleEpisodes[0])
  const olderHistory = $derived(history.filter(day => !recentDates.includes(day.date)))
  async function load() {
    const version = ++requestVersion
    const requestedDate = date
    const expectedJobRevision = jobRevision
    loading = true; error = ''; batch = null; selectedId = ''; expandedColumns = {}
    const scanPromise = refreshScan(requestedDate, version)
    try {
      const result = await api.snapshot(requestedDate)
      if (disposed || version !== requestVersion) return
      batch = result.batch; history = result.history
      if (jobRevision === expectedJobRevision) {
        job = result.job; jobRevision++
        lastResultsSignature = jobResultsSignature(job); pendingResultRefresh = false
      }
      if (!restoredGenerationMode) {
        if (result.job?.start_date && result.job.end_date) {
          generationMode = result.job.start_date === result.job.end_date ? 'single' : 'range'
          rangeStart = result.job.start_date; rangeEnd = result.job.end_date
        }
        restoredGenerationMode = true
      }
    } catch (e) { if (!disposed && version === requestVersion) error = errorText(e) }
    finally { if (!disposed && version === requestVersion) loading = false }
    await scanPromise
  }
  async function loadProviders() {
    providerError = ''
    try {
      const result = await api.providers()
      if (disposed) return
      providers = supportedProviders(result.providers)
      let saved = ''
      try { saved = localStorage.getItem('notemd.agent.provider.agency') ?? '' } catch { /* Optional preference. */ }
      harness = harness || saved || providers.find(p => p.id === result.default)?.id || providers[0]?.id || ''
    } catch (e) { if (!disposed) providerError = errorText(e) }
  }
  function chooseProvider() { try { localStorage.setItem('notemd.agent.provider.agency', harness) } catch { /* Optional preference. */ } }
  async function scanSources() {
    if (busy || loading || scanLoading || saving || running) return
    await refreshScan(date, requestVersion)
  }
  async function refreshScan(requestedDate: string, viewVersion: number) {
    const version = ++scanRequestVersion
    const current = () => !disposed && viewVersion === requestVersion && version === scanRequestVersion
    scanLoading = true; scanError = ''; scan = null
    try { const result = await api.scan(requestedDate); if (current()) scan = result }
    catch (e) { if (current()) scanError = errorText(e) }
    finally { if (current()) scanLoading = false }
  }
  async function observe() {
    if (!available || busy || loading || scanLoading || saving || running || stopping || (generationMode === 'range' && range.error)) return
    busy = true; error = ''; pollError = ''
    try {
      const result = generationMode === 'range' ? await api.observeRange(rangeStart, rangeEnd, harness) : await api.observe(date, harness)
      if (disposed) return
      acceptJob(result)
      if (result.state !== 'running') await refreshPendingResults()
    }
    catch (e) { if (!disposed) error = errorText(e) }
    finally { busy = false }
  }
  function acceptJob(result: Job) {
    job = result; jobRevision++
    pendingResultRefresh = jobResultsSignature(result) !== lastResultsSignature
  }
  async function refreshPendingResults() {
    const version = requestVersion
    const refreshVersion = ++resultRefreshVersion
    const signature = jobResultsSignature(job)
    const result = await api.snapshot(date)
    if (disposed || version !== requestVersion || refreshVersion !== resultRefreshVersion) return
    history = result.history
    // Preserve the current selection, expanded columns and unsaved note when
    // another day in the queue finishes. A new batch alone replaces this view.
    if (batch?.id !== result.batch?.id || batch?.rule_version !== result.batch?.rule_version) batch = result.batch
    lastResultsSignature = signature
    pendingResultRefresh = jobResultsSignature(job) !== signature
  }
  async function stopQueue() {
    if (!running || !job?.items?.length || job.stop_requested || stopping) return
    stopping = true; error = ''
    try {
      const result = await api.stopQueue()
      if (disposed) return
      acceptJob(result)
      if (result.state !== 'running') await refreshPendingResults()
    } catch (e) { if (!disposed) error = errorText(e) }
    finally { stopping = false }
  }
  async function pollJob() {
    if (polling || disposed) return
    polling = true
    try {
      const expectedJobRevision = jobRevision
      const result = await api.job()
      if (disposed) return
      if (!result && running) { pollError = '暂时无法找到任务状态，将继续检查。'; return }
      if (result && jobRevision === expectedJobRevision) acceptJob(result)
      if (pendingResultRefresh && !busy && !saving && !loading) await refreshPendingResults()
      pollError = ''
    } catch (e) { if (!disposed) pollError = `任务状态暂不可用：${errorText(e)}` }
    finally { polling = false }
  }
  async function saveReview(excluded: boolean, note: string) {
    if (!batch || !selected || saving || busy || loading || running) return
    const original = batch
    saving = true; error = ''
    try { const updated = await api.review(date, batch.id, selected.id, excluded, note); if (!disposed && batch?.id === original.id) batch = updated }
    catch (e) { if (!disposed) error = errorText(e) }
    finally { saving = false }
  }
  async function openSource(sourceId: string, line: number) {
    error = ''
    try { await api.openSource(date, sourceId, line) } catch (e) { if (!disposed) error = errorText(e) }
  }
  async function selectEpisode(id: string) {
    selectedId = id
    await tick()
    document.getElementById('episode-detail')?.focus()
  }
  function chooseDate(next: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || saving || busy) return
    date = next; void load()
  }
  onMount(() => {
    void load(); void loadProviders()
    const timer = setInterval(() => { void pollJob() }, 2000)
    return () => { disposed = true; requestVersion++; clearInterval(timer) }
  })
</script>

<main class="ui-surface">
  <header><div><h1>Agency</h1><p class="subtitle">复盘与 AI 的协作：目标进展、额外负担与能力扩展。</p></div><label class="date-label">观察日期<input aria-label="观察日期" type="date" value={date} disabled={busy || saving} onchange={event => chooseDate(event.currentTarget.value)} /></label></header>
  <div class="toolbar"><label>Agent <select aria-label="Agent" bind:value={harness} onchange={chooseProvider} disabled={busy || running || stopping}>
    {#if harness && !selectedProvider}<option value={harness} disabled>{harness}（不可用）</option>
    {:else if !providers.length}<option value="">未发现可用 Agent</option>{/if}
    {#each providers as provider}<option value={provider.id} disabled={!supportsAgency(provider)}>{provider.name}{supportsAgency(provider) ? '' : provider.harness?.ok ? '（需更新 Agent 以支持 Agency 隔离观测）' : '（不可用）'}</option>{/each}
    </select></label><label>生成范围 <select aria-label="生成范围" value={generationMode} onchange={event => generationMode = event.currentTarget.value === 'range' ? 'range' : 'single'} disabled={busy || running || stopping}><option value="single">单日</option><option value="range">日期范围</option></select></label>
    <button disabled={loading || scanLoading || busy || saving || running} onclick={scanSources}>扫描来源</button>
    {#if providers.length}<button class="primary" disabled={!available || loading || scanLoading || busy || saving || running || stopping || (generationMode === 'range' && !!range.error)} onclick={observe}>{busy ? '处理中…' : generationMode === 'range' ? range.error ? '批量生成' : `批量生成 ${range.days} 天` : batch ? '重新生成观察' : '生成观察'}</button>{/if}
  </div>
  {#if generationMode === 'range'}<div class="range-controls"><label>开始日期<input aria-label="开始日期" type="date" bind:value={rangeStart} disabled={busy || running || stopping} /></label><span>至</span><label>结束日期<input aria-label="结束日期" type="date" bind:value={rangeEnd} disabled={busy || running || stopping} /></label></div>
    {#if range.error}<p class="range-error" role="alert">{range.error}</p>{:else}<p class="caption">含首尾共 {range.days} 天，按日期顺序生成。右上角“观察日期”只切换正在查看的报告，不改变此范围。</p>{/if}
  {/if}
  {#if providerError}<p class="notice">无法读取 Agent：{providerError} <button onclick={loadProviders}>重试</button></p>{/if}
  {#if !providerError && !available}<p class="notice">{selectedProvider?.harness?.ok ? '需更新 Agent 以支持 Agency 隔离观测。' : '请启用可用的 Codex、Claude 或 DeepSeek Agent 后生成观察。'}现有记录与来源扫描仍可使用。</p>{/if}
  {#if batch}<p class="caption">生成于 {batch.created_at} · {batch.provider}。相同来源与规则会复用结果并保留校正；来源变化时产生新批次，旧批次的校正仍保留，但不会自动套用。</p>{/if}
  {#if job}<section class="job-panel" aria-label="生成任务"><div class="job" class:failed={job.state === 'failed'} role="status"><strong>{job.start_date && job.end_date ? `${job.start_date} 至 ${job.end_date}` : job.date} · {jobLabels[job.state]}</strong><span>{job.error || job.message}</span>{#if !job.items?.length && job.date !== date}<button disabled={busy || saving} onclick={() => chooseDate(job!.date)}>查看该日期</button>{/if}</div>
    {#if job.items?.length}
      <div class="queue-actions"><strong>进度 {queueSettled(job)}/{job.items.length} 天已结束</strong>
        {#if running}<button disabled={stopping || job.stop_requested} onclick={stopQueue}>{stopping ? '正在请求停止…' : job.stop_requested ? '已请求停止' : '完成当前后停止'}</button>{/if}
      </div>
      <p class="caption">{job.stop_requested ? '未开始的日期已取消；当前生成会继续到结束。' : '按日期顺序处理；某一天失败不会阻止后续日期。点击日期查看已有结果。'}</p>
      <details class="queue-details" open><summary>每日进度</summary><ol class="queue-items">{#each job.items as item}
        {@const state = queueItemState(item, job.stop_requested)}
        <li class:failed={state === 'failed'}><button disabled={busy || saving} onclick={() => chooseDate(item.date)} aria-label={`查看 ${item.date} 的报告`}>{item.date}</button><span class="item-state">{queueItemLabels[state]}</span><span class="item-message">{item.error || item.message}</span>{#if item.episodes !== undefined}<small>{item.episodes} 个片段</small>{/if}</li>
      {/each}</ol></details>
    {/if}
  </section>{/if}
  {#if pollError}<p class="notice" role="status">{pollError}</p>{/if}
  {#if error}<div class="error" role="alert">{error}<button disabled={busy || saving} onclick={load}>重新加载</button></div>{/if}
  <nav aria-label="最近七天"><span>最近七天</span>{#each recentDates as day}<button class:current={day === date} aria-current={day === date ? 'date' : undefined} disabled={busy || saving} onclick={() => chooseDate(day)}>{day}{day === recentDates[0] ? ' · 今天' : ''}<small>{history.some(item => item.date === day) || batch?.date === day ? '已生成' : '未生成'}</small></button>{/each}</nav>
  {#if olderHistory.length}<nav aria-label="历史日期"><span>更早的观察</span>{#each olderHistory as day}<button class:current={day.date === date} aria-current={day.date === date ? 'date' : undefined} disabled={busy || saving} onclick={() => chooseDate(day.date)}>{day.date}<small>{day.episodes} 片段</small></button>{/each}</nav>{/if}
  <section class="coverage" aria-labelledby="coverage-title"><h2 id="coverage-title">来源覆盖</h2>
    {#if scanLoading}<p role="status">正在扫描 {date} 的最新来源…</p>{/if}
    {#if scanError}<p class="error" role="alert">{date} 来源扫描失败：{scanError}。不能据此判断当天没有来源。</p>{/if}
    {#if scan}<p>检查 {scan.considered} 条记录 · 纳入 {scan.sources.length} 条 · 排除 {scan.excluded.length} 条</p>
      <details><summary>查看 {date} 纳入的最新来源（{scan.sources.length}）</summary><ul>{#each scan.sources as source}<li><strong>{source.title}</strong><span class="path">{source.path}</span><span>开始：{source.started} · 结束：{source.ended}</span></li>{:else}<li>本次扫描没有纳入来源。</li>{/each}</ul></details>
      {#if scan.excluded.length}<details><summary>查看来源排除原因</summary><ul>{#each scan.excluded as item}<li><span class="path">{item.path}</span><span>{item.reason}</span></li>{/each}</ul></details>{/if}
      {#if scan.warnings[0]}<p class="notice">{scan.warnings[0]}</p>{/if}
      {#if scan.warnings.length > 1}<details class="coverage-warnings"><summary>跨日与覆盖提醒（{scan.warnings.length - 1}）</summary>{#each scan.warnings.slice(1) as warning}<p class="notice">{warning}</p>{/each}</details>{/if}
    {/if}
    {#if batch}<p class="caption">已存观察仍基于生成时的 {batch.scan.sources.length} 条来源；上方最新扫描不会改写已存结果。</p>{/if}
    {#if batch?.skipped_sources.length}<details><summary>已存观察中未提取片段的来源（{batch.skipped_sources.length}）</summary><ul>{#each batch.skipped_sources as item}<li><span class="path">{batch.scan.sources.find(s => s.id === item.source_id)?.title ?? item.source_id}</span><span>{item.reason}</span></li>{/each}</ul></details>{/if}
    <p class="caption">日期依据来源记录的起止时间筛选。跨日会话可能在多日出现；不代表当天的独立互动次数或投入时长。</p>
  </section>
  {#if loading}<p class="empty" role="status">正在读取观察…</p>
  {:else if batch}<section aria-labelledby="review-title"><div class="section-title"><h2 id="review-title">协作复盘</h2><span class="caption">计入 {summary.included} 个片段 · 人工排除 {summary.excluded} 个</span></div><p class="caption">AI 生成，待你核对。只呈现有原文依据的变化；AI 自述完成不代表结果已独立核验。</p>
    {#if summary.legacy}<p class="notice">旧版报告，重新生成可补充协作复盘。当前仅保留目标状态与已有摩擦记录，不从三维线索推断能力扩展。</p>{/if}
    <div class="review-columns">{#each summary.columns as column}<section class="review-column" aria-label={column.label} data-column={column.key}><h3>{column.label}</h3><p class="caption">{column.description}</p>
      {#each column.items.slice(0, expandedColumns[column.key] ? column.items.length : 3) as item}<button class="finding" onclick={() => selectEpisode(item.episode.id)}><strong>{item.episode.title}</strong><span>{item.note}</span><small>{outcomeLabels[item.episode.outcome]}{item.episode.outcome === 'assistant_reported' ? ' · 尚未独立核验' : ''}</small>{#if item.legacy}<small>旧版记录 · 未结构化核对</small>{:else}<small>{item.evidence_indices.map(i => `引文 ${i + 1}`).join('、')} · 查看详情</small>{/if}</button>
      {:else}<p class="unknown">{column.unknown}</p>{/each}
      {#if column.items.length > 3}<button class="show-more" aria-expanded={!!expandedColumns[column.key]} onclick={() => expandedColumns[column.key] = !expandedColumns[column.key]}>{expandedColumns[column.key] ? '收起' : `显示更多 ${column.items.length - 3} 项`}</button>{/if}
      {#if column.items.length}<p class="caption">未列出的片段保持未知。</p>{/if}
    </section>{/each}</div></section>
    {#if summary.experiment}<aside class="suggestion" aria-label="可选实验"><h2>一个可选的小实验</h2><p><strong>行动：</strong>{summary.experiment.action}</p><p><strong>如何检验：</strong>{summary.experiment.check}</p><button onclick={() => selectEpisode(summary.experiment!.episode.id)}>查看对应片段：{summary.experiment.episode.title}</button><p class="caption">{summary.experiment.evidence_indices.map(i => `引文 ${i + 1}`).join('、')}。这是一条建议，不会自动创建任务或承诺。</p></aside>{/if}
    <section class="episodes" aria-label="观察片段"><div class="episode-list"><div class="list-title"><h2>观察片段</h2><label><input type="checkbox" bind:checked={showExcluded} />显示已排除</label></div>
      {#each visibleEpisodes as episode}<button class="episode" class:selected={selected?.id === episode.id} aria-pressed={selected?.id === episode.id} onclick={() => selectedId = episode.id}><strong>{episode.title}</strong><span>{outcomeLabels[episode.outcome]}{batch.reviews[episode.id]?.excluded ? ' · 已排除' : ''}</span></button>
      {:else}<p class="empty">{batch.episodes.length ? '所有片段均已排除。勾选“显示已排除”可查看或恢复。' : '本批没有足够证据提取观察片段。'}</p>{/each}</div>
      {#if selected}{#key `${batch.id}/${selected.id}`}<EpisodeDetail episode={selected} legacy={summary.legacy} source={batch.scan.sources.find(s => s.id === selected.source_id)} review={batch.reviews[selected.id] ?? { excluded: false, note: '' }} saving={saving || busy || !!running} onSave={saveReview} onOpen={openSource} />{/key}
      {:else}<div class="empty">有可用片段后，会在这里显示判断依据与原文引文。</div>{/if}
    </section>
  {:else}<div class="empty"><h2>这一天还未生成观察</h2><p>未生成不代表没有来源。打开或切换日期会自动扫描，生成观察仍需手动点击。</p><p>只分析已记录的互动；没有记录的行动保持未知。</p></div>{/if}
</main>

<style>
  :global(body) { margin: 0; background: Canvas; } :global(*) { box-sizing: border-box; }
  main { max-width: 1280px; padding: 28px 32px 40px; margin: 0 auto; }
  header, .toolbar, .section-title { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  header { justify-content: space-between; margin-bottom: 22px; }
  h1 { font-size: 26px; letter-spacing: -.5px; margin: 0; } h2 { font-size: 15px; margin: 0 0 10px; } h3 { font-size: 13px; margin: 0; }
  p { line-height: 1.65; margin: 6px 0; } .subtitle { color: var(--ui-secondary); }
  .date-label { display: flex; align-items: center; gap: 10px; }
  button, input[type='date'], select { background: var(--ui-surface); color: inherit; border: 1px solid var(--ui-control-border); border-radius: 6px; padding: 7px 10px; }
  button { cursor: pointer; } button:hover:not(:disabled) { background: var(--ui-hover); } button:disabled { opacity: .5; }
  .primary { background: var(--ui-accent); color: var(--ui-accent-foreground); border-color: var(--ui-accent); }
  .primary:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-accent) 90%, black); }
  .toolbar { margin-bottom: 12px; } .toolbar label { display: flex; align-items: center; gap: 8px; }
  .range-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0; }
  .range-controls label { display: flex; align-items: center; gap: 8px; }
  .range-error { color: var(--ui-danger); font-size: 12px; }
  .caption { font-size: 12px; color: var(--ui-secondary); }
  .notice, .job, .error { padding: 10px 14px; background: var(--ui-bg); border-radius: 8px; margin: 12px 0; overflow-wrap: anywhere; }
  .job, .error { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; } .job span { flex: 1; min-width: 120px; } .failed, .error { color: var(--ui-danger); }
  .job-panel { margin: 16px 0; }
  .queue-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .queue-items { list-style: none; padding: 0; max-height: 260px; overflow-y: auto; }
  .queue-items li { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--ui-separator); }
  .queue-items button, .item-state { flex-shrink: 0; }
  .item-message { flex: 1; min-width: 120px; overflow-wrap: anywhere; }
  nav { display: flex; gap: 8px; overflow-x: auto; align-items: center; margin: 20px 0; padding: 4px 2px; }
  nav > span { flex-shrink: 0; color: var(--ui-secondary); font-size: 12px; } nav button { white-space: nowrap; border-color: var(--ui-separator); } nav small { margin-left: 6px; color: var(--ui-secondary); } nav .current { background: var(--ui-selection); border-color: var(--ui-accent); }
  .coverage { padding: 18px 20px; background: var(--ui-bg); border: 1px solid var(--ui-separator); border-radius: 10px; margin: 20px 0 24px; }
  details { margin: 10px 0; } summary { cursor: pointer; color: var(--ui-secondary); } details ul { padding-left: 18px; max-height: 240px; overflow: auto; } details li { margin: 8px 0; } details li span { display: block; }
  .path { color: var(--ui-secondary); font-size: 12px; overflow-wrap: anywhere; }
  .section-title { justify-content: space-between; } .section-title h2 { margin-bottom: 0; }
  .review-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 18px 0 24px; }
  .review-column { padding: 18px; border: 1px solid var(--ui-separator); border-radius: 10px; }
  .finding { display: block; width: 100%; text-align: left; padding: 12px; margin-top: 12px; border-color: var(--ui-separator); }
  .finding strong, .finding span, .finding small { display: block; line-height: 1.65; overflow-wrap: anywhere; }
  .finding span { margin: 8px 0; } .finding small { font-size: 12px; color: var(--ui-secondary); }
  .show-more { margin-top: 12px; }
  .unknown { padding: 16px 0; color: var(--ui-secondary); }
  .suggestion { border-left: 3px solid var(--ui-control-border); padding: 4px 16px; margin-bottom: 24px; }
  .episodes { border: 1px solid var(--ui-separator); border-radius: 10px; display: grid; grid-template-columns: minmax(230px, 30%) minmax(0, 1fr); overflow: hidden; }
  .episode-list { border-right: 1px solid var(--ui-separator); background: var(--ui-bg); padding: 14px; } .list-title { padding: 4px 4px 14px; } .list-title label { font-size: 12px; color: var(--ui-secondary); display: flex; align-items: center; gap: 6px; }
  .episode { width: 100%; text-align: left; padding: 12px; border-color: transparent; background: transparent; margin: 2px 0; } .episode.selected { background: var(--ui-selection); } .episode strong { display: block; font-weight: 500; line-height: 1.6; } .episode span { display: block; color: var(--ui-secondary); font-size: 12px; margin-top: 6px; }
  .empty { padding: 34px 20px; text-align: center; color: var(--ui-secondary); }
  @media (max-width: 760px) { main { padding: 20px 16px; } .review-columns { grid-template-columns: 1fr; } .episodes { grid-template-columns: 1fr; } .episode-list { border-right: 0; border-bottom: 1px solid var(--ui-separator); } }
</style>
