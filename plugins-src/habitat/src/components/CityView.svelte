<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { CityScene, type SceneStatus } from '../lib/city-scene'
  import { typeLabel, type FamilyCounts } from '../lib/domain'
  import type { Edge, Layout, Node } from '../lib/types'

  let { nodes, layout, edges, families, selectedId, scopeKey = '', changedIds = new Set<string>(), onselect }: { nodes: Node[]; layout: Layout[]; edges: Edge[]; families: Map<string, FamilyCounts>; selectedId: string; scopeKey?: string; changedIds?: Set<string>; onselect: (id: string) => void } = $props()
  let canvas: HTMLCanvasElement
  let container = $state<HTMLDivElement>()
  let scene: CityScene | null = null
  let ready = $state(false), unavailable = $state(false), status = $state.raw<SceneStatus>({ labels: [], count: 0 })
  let previousScope: string | null = null
  $effect(() => {
    const data = { nodes, layout, edges }, currentScope = scopeKey
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
  <div class="map-caption"><span class="eyebrow">A LIVING ATLAS OF YOUR MIND</span><h2 class="map-heading">知识正在成为一座城<span>KNOWLEDGE CITY</span></h2><p class="map-mini-stat"><strong>{status.count.toLocaleString()}</strong> 个结构对象<span> / {status.aggregated ? `街区总览 · ${status.rendered?.toLocaleString()} 座代表建筑` : '对象细节 · 独立地址'}</span></p><small>项目园区、概念街区与探索营地 · 总览建筑代表同一空间街区中的对象</small></div>
  <div class="city-labels">
    {#each status.labels as label (label.id)}
      <button class="city-label" class:active={label.selected} style:left={`${label.x}px`} style:top={`${label.y}px`} onclick={() => select(label.id)} ondblclick={() => scene?.focus(label.id)} title={`${label.name} · ${typeLabel(label.kind)}`}><span class="label-dot"></span><span>{label.name}</span></button>
    {/each}
  </div>
  {#if status.hover}<div class="map-tooltip" style:left={`${Math.min(status.hover.x+14, (container?.clientWidth ?? 600)-215)}px`} style:top={`${Math.max(12,status.hover.y-65)}px`}><strong>{status.hover.name}</strong><span>{typeLabel(status.hover.kind)} · 点击查看依据</span></div>{/if}
  {#if unavailable}<div class="canvas-fallback">此环境暂不支持三维画布，请从左侧结构列表浏览全部知识。</div>{:else if !ready}<div class="canvas-fallback">正在搭建你的城市…</div>{/if}
  <div class="map-controls"><button aria-label="旋转城市" onclick={() => scene?.rotate()}>↻</button><span></span><button aria-label="缩小" onclick={() => scene?.zoom(.8)}>−</button><button aria-label="回到全景" onclick={() => scene?.fit()}>全景</button><button aria-label="放大" onclick={() => scene?.zoom(1.25)}>＋</button></div>
  <div class="map-legend"><span><i class="swatch project"></i>项目园区</span><span><i class="swatch concept"></i>概念街区</span><span><i class="swatch topic"></i>主题绿地</span><span><i class="swatch material"></i>材料聚落</span><span class="road-label">金色联系 · 虚线候选 · 铺装与树木仅为景观</span></div>
  <div class="city-interaction-hint">拖动旋转 · 右键平移 · 滚轮探索</div>
</div>

<style>
  .map-caption small { display:block; max-width:370px; }
  .city-labels { position:absolute; inset:0; pointer-events:none; overflow:hidden; }
  .city-label { position:absolute; transform:translate(-50%,-100%); display:flex; align-items:center; gap:6px; max-width:185px; padding:6px 10px; border:1px solid #ffffffae; background:#fffdf3ee; box-shadow:0 3px 10px #223a2920; border-radius:7px; font-size:11px; font-weight:550; color:#365448; white-space:nowrap; pointer-events:auto; }
  .city-label>span:last-child { overflow:hidden;text-overflow:ellipsis; }
  .city-label::after { content:''; position:absolute; left:50%; bottom:-8px; height:8px; border-left:1px solid #66827580; }
  .city-label.active { color:#895827; border-color:#bc935e; background:#fff5df; }
  .label-dot { width:5px;height:5px;border-radius:50%;background:#89a67b;flex-shrink:0; }
  .city-label.active .label-dot { background:#bf8849; }
  .city-interaction-hint { position:absolute;left:24px;bottom:66px;font-size:10px;color:#647b6d;letter-spacing:.5px;pointer-events:none; }
  .map-controls>span { height:15px;width:1px;background:var(--hb-line);margin:0 3px; }
  .map-heading>span { display:block;font-size:9px;letter-spacing:3px;font-weight:400;margin-top:8px;color:var(--hb-muted); }
  @media(prefers-color-scheme:dark) { .city-label { background:#233930ed;border-color:#8eab803f;color:#e4e8d5; }.city-label.active { color:#edc38b;background:#394133;border-color:#b99e6f; }.city-interaction-hint{color:#a7bbae;} }
  @media(max-width:800px) { .city-interaction-hint { display:none; }.map-caption small { display:none; } }
</style>
