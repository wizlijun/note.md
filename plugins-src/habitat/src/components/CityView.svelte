<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { growthStateLabels, type ConceptGrowthProfile } from '../lib/concept-growth'
  import { CityScene, type SceneStatus } from '../lib/city-scene'
  import { UNASSIGNED_TOPIC, typeLabel, type GraphLayer, type FamilyCounts } from '../lib/domain'
  import type { Attention, Edge, FocusContext, Layout, Membership, Node } from '../lib/types'

  let { nodes, layout, edges, memberships = [], topics = [], keywordGraph = false, conceptGraph = false, layer = 'main', includeStatistical = false, growth = new Map<string, ConceptGrowthProfile>(), recentFocus, attention = [], oncommunity, families, selectedId, scopeKey = '', changedIds = new Set<string>(), onselect }: { nodes: Node[]; layout: Layout[]; edges: Edge[]; memberships?: Membership[]; topics?: Node[]; keywordGraph?: boolean; conceptGraph?: boolean; layer?: GraphLayer; includeStatistical?: boolean; growth?: Map<string, ConceptGrowthProfile>; recentFocus?: FocusContext; attention?: Attention[]; oncommunity?: (id: string) => void; families: Map<string, FamilyCounts>; selectedId: string; scopeKey?: string; changedIds?: Set<string>; onselect: (id: string) => void } = $props()
  const nodeUnit = $derived(conceptGraph ? layer === 'main' ? '个概念 / 项目' : layer === 'background' ? '个背景实体' : '个节点' : keywordGraph ? '个关键词' : '个结构对象')
  let canvas: HTMLCanvasElement
  let container = $state<HTMLDivElement>()
  let scene: CityScene | null = null
  let ready = $state(false), unavailable = $state(false), status = $state.raw<SceneStatus>({ labels: [], count: 0 })
  let previousScope: string | null = null
  $effect(() => {
    const data = { nodes, layout, edges, memberships, topics, keywordGraph, conceptGraph, attention, growth }, currentScope = scopeKey
    if (ready && scene) untrack(() => { scene!.setData(data, previousScope !== currentScope); previousScope = currentScope })
  })
  $effect(() => { if (ready) scene?.setSelected(selectedId, changedIds) })
  function select(id: string) { onselect(id) }
  onMount(() => {
    if (!window.WebGLRenderingContext) { unavailable = true; return }
    try { scene = new CityScene(canvas, value => status = value, select) } catch { unavailable = true; return }
    const resize = () => { const r = container!.getBoundingClientRect(); scene?.resize(Math.max(1,r.width),Math.max(1,r.height)) }
    const observer = new ResizeObserver(resize); observer.observe(container!); resize()
    const media = window.matchMedia('(prefers-color-scheme: dark)'), theme = () => scene?.setDark(media.matches)
    theme(); media.addEventListener('change',theme); ready = true
    return () => { observer.disconnect(); media.removeEventListener('change',theme); scene?.dispose(); scene = null }
  })
</script>

<div class="city-canvas" bind:this={container}>
  <canvas bind:this={canvas} aria-label="知识城市三维沙盘；拖动旋转，右键拖动平移，滚轮缩放。所有对象也可从结构列表访问。"></canvas>
  <div class="map-caption" class:closer={(status.zoom ?? 1) > 1.3}><span class="eyebrow">A LIVING ATLAS OF YOUR MIND</span><h2 class="map-heading">{recentFocus ? `近期关注 · 最近 ${recentFocus.windowDays} 天` : '知识正在成为一座城'}<span>{recentFocus ? `截至 ${recentFocus.asOf} · 主动记录与反复提及` : 'KNOWLEDGE CITY'}</span></h2><p class="map-mini-stat"><strong>{status.count.toLocaleString()}</strong> {nodeUnit}<span> / {status.aggregated ? `街区总览 · ${status.rendered?.toLocaleString()} 座代表建筑` : conceptGraph ? '一节点一栋 · 独立地址' : keywordGraph ? '一词一栋 · 独立地址' : '对象细节 · 独立地址'}</span></p><small>{conceptGraph ? layer === 'background' ? '人物、工具与资料保留独立身份 · 原始来源可追溯' : layer === 'all' ? '概念、明确项目与背景实体分型呈现' : '主城呈现概念与明确项目 · 建筑随记录积累生长' : recentFocus ? '关注线索的本次快照 · 时间窗口推进后可淡出，历史仍保留' : keywordGraph ? '一栋主体建筑对应一个概念 · 建筑级别随记录积累生长' : '旧版对象图 · 街区按空间聚合，建筑代表结构对象'}</small></div>
  <div class="city-labels">
    {#each status.labels as label (label.id)}
      <button class="city-label" class:district={!!label.district} class:compact={label.compact} class:edge-left={label.x < 132} class:edge-right={label.x > (container?.clientWidth ?? 600) - 132} class:landmark={label.district?.kind === '项目园区' || label.district?.kind === '探索营地'} class:active={label.selected} class:growing={label.growthState === 'growth'} class:rebuilding={label.growthState === 'rebuilding'} class:dormant={label.growthState === 'dormant'} class:context-label={conceptGraph ? !['keyword', 'project'].includes(label.kind) : label.attentionCategory === 'context'} style:left={`${label.x}px`} style:top={`${label.y}px`} style:--label-width={`${label.width ?? 185}px`} data-concept={label.district ? undefined : label.nodeId ?? label.id} data-parcel={label.district ? label.id : undefined} aria-label={label.district ? `${label.name} · ${label.district.kind} · ${label.district.count.toLocaleString()} ${conceptGraph ? '个节点' : keywordGraph ? '个关键词' : '个对象'}` : label.name} onclick={() => { scene?.focus(label.nodeId ?? label.id); if (label.district?.unassigned && oncommunity) oncommunity(UNASSIGNED_TOPIC); else if (label.district?.topicId && oncommunity) oncommunity(label.district.topicId); else select(label.nodeId ?? label.id) }} title={label.district ? `${label.district.kind} · ${label.name}${keywordGraph ? '' : '（代表名称）'}${label.district.contextName ? '\n原社区：' + label.district.contextName : ''}\n${label.district.count.toLocaleString()} ${conceptGraph ? '个节点' : keywordGraph ? '个关键词' : '个对象'} · ${label.district.unassigned ? '仅为空间收纳，不表示彼此相关；点击查看待连接节点' : label.district.topicId ? '点击查看该社区节点' : '点击靠近并查看依据'}` : `${label.name} · ${label.growth ?? typeLabel(label.kind, conceptGraph)}${label.growthState ? ' · ' + growthStateLabels[label.growthState] : ''} · 点击查看来源依据`}><span class="label-dot"></span><span class="label-name">{label.name}</span>{#if label.growth || (conceptGraph && !label.district)}<small class="building-level">{label.growth ?? typeLabel(label.kind, conceptGraph)}</small>{/if}{#if label.district}<small class="district-count">{label.district.count.toLocaleString()} {conceptGraph ? '个节点' : keywordGraph ? '个关键词' : '个对象'}</small>{/if}</button>
    {/each}
  </div>
  {#if status.hover}<div class="map-tooltip" style:left={`${Math.min(status.hover.x+14, (container?.clientWidth ?? 600)-215)}px`} style:top={`${Math.max(12,status.hover.y-65)}px`}><strong>{status.hover.name}</strong><span>{status.hover.growth ?? typeLabel(status.hover.kind, conceptGraph)} · 点击查看依据</span></div>{/if}
  {#if unavailable}<div class="canvas-fallback">此环境暂不支持三维画布，请从左侧结构列表浏览全部知识。</div>{:else if status.error}<div class="canvas-fallback">城市模型加载失败，请重新打开此页面。<small>{status.error}</small></div>{:else if !ready || status.loading}<div class="canvas-fallback">正在搭建你的城市…</div>{/if}
  <div class="map-controls"><button aria-label="旋转城市" onclick={() => scene?.rotate()}>↻</button><span></span><button aria-label="缩小" onclick={() => scene?.zoom(.8)}>−</button><button aria-label="回到全景" onclick={() => scene?.fit()}>全景</button><button aria-label="放大" onclick={() => scene?.zoom(1.25)}>＋</button></div>
  <div class="map-legend">{#if conceptGraph && layer === 'background'}<span>人物 · 工具 · 资料作品 · 待辨认词项</span>{:else if keywordGraph}<span class="growth-legend">茅草屋 <b>→</b> 木屋 <b>→</b> 住宅 <b>→</b> 工作室 <b>→</b> 楼宇 <b>→</b> 摩天楼</span><span class="road-label">{conceptGraph ? includeStatistical ? '道路含原文陈述、明确链接与统计关联' : '道路仅呈现原文陈述与明确链接' : '记录积累决定建筑 · 关系支持决定路宽'}</span>{:else}<span><i class="swatch project"></i>项目园区</span><span><i class="swatch concept"></i>概念街区</span><span><i class="swatch topic"></i>主题绿地</span><span><i class="swatch material"></i>材料聚落</span>{/if}</div>
  <div class="city-interaction-hint">拖动旋转 · 右键平移 · 滚轮探索</div>
</div>

<style>
  .map-caption small { display:block; max-width:370px; }
  .map-caption.closer { opacity:0; }
  .city-labels { position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:1; }
  .city-label { position:absolute; transform:translate(-50%,-100%); display:flex; align-items:center; gap:6px; max-width:185px; padding:6px 10px; border:1px solid #ffffffae; background:#fffdf3ee; box-shadow:0 3px 10px #223a2920; border-radius:7px; font-size:11px; font-weight:550; color:#365448; white-space:nowrap; pointer-events:auto; }
  .city-label .label-name { overflow:hidden;text-overflow:ellipsis; }
  .city-label.district { max-width:var(--label-width); padding:3px 5px; gap:4px; font-size:9px; border-radius:5px; background:#fffff2df; }
  .city-label.landmark,.city-label.active { max-width:185px; padding:6px 10px; font-size:11px; z-index:2; }
  .city-label.compact { width:12px;height:12px;padding:3px;border-radius:50%;gap:0; }
  .city-label.compact .label-name,.city-label.compact .building-level { display:none; }
  .building-level { font-size:8px; color:#8c7959; font-weight:400; padding-left:4px; border-left:1px solid #a8926b40; }
  .city-label:not(.district) { max-width:var(--label-width); padding:4px 6px; font-size:10px; gap:4px; }
  .city-label:not(.district):hover { z-index:6; width:max-content; max-width:260px; height:auto; border-radius:6px; padding:5px 8px; gap:4px; }
  .city-label:not(.district):hover .label-name,.city-label:not(.district):hover .building-level { display:block; }
  .city-label:not(.district).compact { width:12px; height:12px; padding:3px; gap:0; }
  .city-label:not(.district).compact:hover { width:max-content; height:auto; padding:5px 8px; gap:4px; }
  .growth-legend b { font-weight:400; opacity:.45; }
  .district-count { display:none;font-size:9px;font-weight:400;color:inherit;opacity:.75; }
  .city-label.district:hover,.city-label.district:focus-visible { z-index:6; max-width:260px;width:max-content;height:auto;padding:6px 9px;gap:5px;border-radius:6px;background:#fffff4;box-shadow:0 3px 12px #223a2940; }
  .city-label.district:hover .label-name,.city-label.district:focus-visible .label-name { display:block;max-width:165px; }
  .city-label.district:hover .district-count,.city-label.district:focus-visible .district-count { display:block; }
  .city-label.district::after { height:4px;bottom:-5px; }
  .city-label.compact::after { display:none; }
  .city-label.edge-left:hover,.city-label.edge-left:focus-visible { transform:translate(0,-100%); }
  .city-label.edge-right:hover,.city-label.edge-right:focus-visible { transform:translate(-100%,-100%); }
  .city-label::after { content:''; position:absolute; left:50%; bottom:-8px; height:8px; border-left:1px solid #66827580; }
  .city-label.context-label { background:#edf2efde;border-color:#b5c2b8;color:#64786d;font-weight:400; }
  .city-label.active { color:#895827; border-color:#bc935e; background:#fff5df; }
  .city-label.growing .label-dot { background:#668e56; box-shadow:0 0 0 2px #87a97520; }
  .city-label.rebuilding .label-dot { background:#c4944a; border-radius:1px; }
  .city-label.dormant .label-dot { background:#a1a798; }
  .label-dot { width:5px;height:5px;border-radius:50%;background:#89a67b;flex-shrink:0; }
  .city-label.active .label-dot { background:#bf8849; }
  .city-interaction-hint { position:absolute;left:24px;bottom:66px;font-size:10px;color:#647b6d;letter-spacing:.5px;pointer-events:none; }
  .map-controls>span { height:15px;width:1px;background:var(--hb-line);margin:0 3px; }
  .map-heading>span { display:block;font-size:9px;letter-spacing:3px;font-weight:400;margin-top:8px;color:var(--hb-muted); }
  @media(prefers-color-scheme:dark) { .city-label,.city-label.district { background:#233930ed;border-color:#8eab803f;color:#e4e8d5; }.city-label.district:hover,.city-label.district:focus-visible{background:#314a3a;color:#e4e8d5;}.city-label.active { color:#edc38b;background:#394133;border-color:#b99e6f; }.city-interaction-hint{color:#a7bbae;} }
  @media(max-width:800px) { .city-interaction-hint { display:none; }.map-caption small { display:none; } }
</style>
