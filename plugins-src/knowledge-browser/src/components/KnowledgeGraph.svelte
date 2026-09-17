<script module lang="ts">
  import type { DatasetIndexes, KnowledgeDataset } from '../lib/types'

  export type KnowledgeGraphText = (key: string, values?: Record<string, string | number>) => string

  export interface KnowledgeGraphProps {
    dataset: KnowledgeDataset
    indexes: DatasetIndexes
    selectedId?: string | null
    text: KnowledgeGraphText
    onSelect: (id: string) => void
    onOpenRecord: (id: string) => void
  }
</script>

<script lang="ts">
  import cytoscape, { type Core, type EventObjectEdge, type EventObjectNode, type StylesheetJson } from 'cytoscape'
  import { onDestroy, onMount } from 'svelte'
  import { buildKnowledgeGraph, type GraphScope, type KnowledgeGraphEdge, type KnowledgeGraphModel, type KnowledgeGraphNode } from '../lib/graph-model'

  let { dataset, indexes, selectedId = null, text, onSelect, onOpenRecord }: KnowledgeGraphProps = $props()

  const kindOrder = ['entities', 'concepts', 'claims', 'events', 'narratives', 'relations'] as const
  const shapes: Record<(typeof kindOrder)[number], string> = {
    entities: 'ellipse', concepts: 'round-rectangle', claims: 'rectangle',
    events: 'hexagon', narratives: 'round-tag', relations: 'diamond',
  }
  const kindColors: Record<(typeof kindOrder)[number], string> = {
    entities: '#0a84ff', concepts: '#8e5ad7', claims: '#d97706',
    events: '#16803a', narratives: '#d33a78', relations: '#5865d8',
  }
  const relationPalette = ['#1473e6', '#8b5cf6', '#d97706', '#0f8a5f', '#d43f64', '#6b7280', '#0891b2', '#a855f7']
  const levels: Record<(typeof kindOrder)[number], number> = {
    entities: 1, concepts: 1, claims: 2, events: 2, narratives: 2, relations: 3,
  }

  let scope = $state<GraphScope>('all')
  let projectionCenterId = $state<string | null>(null)
  let graphElement = $state<HTMLDivElement>()
  let mounted = $state(false)
  let graphReady = $state(false)
  let selection = $state<{ kind: 'node' | 'edge'; id: string } | null>(null)
  let cy: Core | undefined
  let resizeObserver: ResizeObserver | undefined
  let themeObserver: MutationObserver | undefined
  let colorSchemeQuery: MediaQueryList | undefined
  let renderFrame = 0

  const model = $derived(buildKnowledgeGraph(dataset, indexes, { scope, centerId: projectionCenterId }))
  const visibleKinds = $derived(kindOrder.filter(kind => model.nodes.some(node => node.kind === kind)))
  const activeNode = $derived(selection?.kind === 'node' ? model.nodes.find(node => node.id === selection!.id) ?? null : null)
  const activeEdge = $derived(selection?.kind === 'edge' ? model.edges.find(edge => edge.id === selection!.id) ?? null : null)
  const connections = $derived.by(() => {
    if (!activeNode) return [] as Array<{ edge: KnowledgeGraphEdge; other: KnowledgeGraphNode }>
    return model.edges.flatMap(edge => {
      if (edge.source !== activeNode.id && edge.target !== activeNode.id) return []
      const otherId = edge.source === activeNode.id ? edge.target : edge.source
      const other = model.nodes.find(node => node.id === otherId)
      return other ? [{ edge, other }] : []
    })
  })

  function relationColor(type: string): string {
    let hash = 0
    for (let index = 0; index < type.length; index++) hash = ((hash << 5) - hash + type.charCodeAt(index)) | 0
    return relationPalette[Math.abs(hash) % relationPalette.length]
  }

  function cssColor(property: string, fallback: string): string {
    if (!graphElement) return fallback
    const probe = document.createElement('span')
    probe.style.position = 'fixed'; probe.style.pointerEvents = 'none'; probe.style.color = property
    graphElement.appendChild(probe)
    const color = getComputedStyle(probe).color || fallback
    probe.remove()
    return color
  }

  function nodeElements(current: KnowledgeGraphModel) {
    const surface = cssColor('var(--ui-surface, Canvas)', '#ffffff')
    const foreground = cssColor('CanvasText', '#1f2937')
    return current.nodes.map(node => ({
      data: {
        id: node.id, label: compact(node.label, node.kind === 'relations' ? 18 : 11), subtitle: node.subtitle,
        shape: shapes[node.kind], border: kindColors[node.kind], fill: surface, foreground,
        size: node.kind === 'relations' ? 62 : node.importance === 0 ? 78 : 66,
        labelWidth: node.kind === 'relations' ? 56 : node.importance === 0 ? 70 : 58,
        level: levels[node.kind],
      },
    }))
  }

  function edgeElements(current: KnowledgeGraphModel) {
    const secondary = cssColor('var(--ui-secondary, GrayText)', '#6b7280')
    return current.edges.map(edge => ({
      data: {
        id: edge.id, source: edge.source, target: edge.target, label: edge.label,
        relationType: edge.relationType,
        color: edge.layer === 'relation' ? relationColor(edge.relationType) : secondary,
        width: edge.layer === 'relation' ? Math.max(1.4, 3.2 - (edge.priority ?? 3) * .45) : 1,
      },
      classes: edge.layer,
    }))
  }

  function compact(value: string, length: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized
  }

  function reducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  function graphStyle(): StylesheetJson {
    const accent = cssColor('var(--ui-accent, AccentColor)', '#0a84ff')
    const surface = cssColor('var(--ui-surface, Canvas)', '#ffffff')
    return [
      { selector: 'node', style: {
        width: 'data(size)', height: 'data(size)', shape: 'data(shape)',
        'background-color': 'data(fill)', 'border-color': 'data(border)', 'border-width': 3,
        label: 'data(label)', color: 'data(foreground)', 'font-size': 11, 'font-weight': 600,
        'text-wrap': 'wrap', 'text-max-width': 'data(labelWidth)', 'text-valign': 'center', 'text-margin-y': 0,
        'text-background-opacity': 0,
        'overlay-opacity': 0,
      } },
      { selector: 'node.graph-selected', style: { 'border-color': accent, 'border-width': 4, 'outline-color': accent, 'outline-width': 6, 'outline-opacity': .14 } },
      { selector: 'node.graph-muted', style: { opacity: .2 } },
      { selector: 'edge', style: {
        width: 'data(width)', 'line-color': 'data(color)', 'target-arrow-color': 'data(color)',
        'target-arrow-shape': 'none', 'curve-style': 'bezier', opacity: .62,
        label: '', color: 'data(color)', 'font-size': 10,
        'text-background-color': surface, 'text-background-opacity': .94, 'text-background-padding': 3,
        'overlay-padding': 10, 'overlay-opacity': 0,
      } },
      { selector: 'edge.reference', style: { 'line-style': 'dashed', 'target-arrow-shape': 'none', opacity: .36 } },
      { selector: 'edge.graph-connected', style: { opacity: .95 } },
      { selector: 'edge.graph-selected', style: { width: 3, opacity: 1, label: 'data(label)', 'z-index': 20 } },
      { selector: 'edge.graph-muted', style: { opacity: .08 } },
    ] as unknown as StylesheetJson
  }

  function syncSelection(): void {
    if (!cy || !selection) return
    cy.elements().removeClass('graph-selected graph-connected graph-muted')
    if (selection.kind === 'node') {
      const node = cy.getElementById(selection.id)
      if (!node.length) return
      const neighborhood = node.closedNeighborhood()
      node.addClass('graph-selected'); node.connectedEdges().addClass('graph-connected')
      cy.elements().difference(neighborhood).addClass('graph-muted')
    } else {
      const edge = cy.getElementById(selection.id)
      if (!edge.length) return
      const focus = edge.union(edge.connectedNodes())
      edge.addClass('graph-selected'); cy.elements().difference(focus).addClass('graph-muted')
    }
  }

  function selectNode(id: string, center = false): void {
    if (!model.nodes.some(node => node.id === id)) return
    selection = { kind: 'node', id }; onSelect(id); syncSelection()
    if (center && cy) {
      const node = cy.getElementById(id)
      if (node.length) {
        if (reducedMotion()) { cy.center(node); cy.zoom(Math.max(cy.zoom(), .9)) }
        else cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), .9) }, { duration: 180 })
      }
    }
  }

  function selectEdge(id: string): void {
    if (!model.edges.some(edge => edge.id === id)) return
    selection = { kind: 'edge', id }; syncSelection()
  }

  function renderGraph(current: KnowledgeGraphModel): void {
    if (!graphElement || !mounted) return
    cy?.destroy(); cy = undefined; graphReady = false
    if (typeof ResizeObserver === 'undefined' || navigator.userAgent.toLowerCase().includes('jsdom')) return
    cy = cytoscape({
      container: graphElement,
      elements: [...nodeElements(current), ...edgeElements(current)],
      style: graphStyle(),
      layout: {
        name: 'concentric', animate: false, fit: true, padding: 44, avoidOverlap: true,
        minNodeSpacing: 34, spacingFactor: 1.15,
        concentric: node => Number(node.data('level')), levelWidth: () => 1,
      },
      minZoom: .25, maxZoom: 2.5, wheelSensitivity: .18, boxSelectionEnabled: false,
    })
    cy.on('tap', 'node', (event: EventObjectNode) => selectNode(event.target.id()))
    cy.on('tap', 'edge', (event: EventObjectEdge) => selectEdge(event.target.id()))
    graphReady = true; syncSelection()
  }

  function scheduleRender(): void {
    cancelAnimationFrame(renderFrame)
    renderFrame = requestAnimationFrame(() => renderGraph(model))
  }

  function fitGraph(): void {
    if (!cy) return
    if (reducedMotion()) cy.fit(cy.elements(), 34)
    else cy.animate({ fit: { eles: cy.elements(), padding: 34 }, duration: 180 })
  }

  function setScope(next: GraphScope): void {
    if (next === 'focus') projectionCenterId = selectedId
    scope = next
  }

  $effect(() => {
    const current = model
    if (!mounted) return
    cancelAnimationFrame(renderFrame)
    renderFrame = requestAnimationFrame(() => renderGraph(current))
  })

  $effect(() => {
    const preferred = selectedId && model.nodes.some(node => node.id === selectedId) ? selectedId : model.nodes[0]?.id
    if (!selection || (selection.kind === 'node' && !model.nodes.some(node => node.id === selection!.id)) || (selection.kind === 'edge' && !model.edges.some(edge => edge.id === selection!.id))) {
      selection = preferred ? { kind: 'node', id: preferred } : null
    } else if (selectedId && selection.kind === 'node' && selection.id !== selectedId && model.nodes.some(node => node.id === selectedId)) {
      selection = { kind: 'node', id: selectedId }
    }
  })

  onMount(() => {
    projectionCenterId = selectedId; mounted = true
    scheduleRender()
    if (graphElement && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => { cy?.resize(); cy?.fit(undefined, 34) })
      resizeObserver.observe(graphElement)
    }
    themeObserver = new MutationObserver(scheduleRender)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] })
    if (typeof matchMedia === 'function') {
      colorSchemeQuery = matchMedia('(prefers-color-scheme: dark)')
      colorSchemeQuery.addEventListener('change', scheduleRender)
    }
  })

  onDestroy(() => {
    mounted = false; cancelAnimationFrame(renderFrame); resizeObserver?.disconnect(); themeObserver?.disconnect()
    colorSchemeQuery?.removeEventListener('change', scheduleRender); cy?.destroy()
  })
</script>

<section class="knowledge-graph" aria-labelledby="knowledge-graph-title">
  <header class="graph-header">
    <div>
      <p class="eyebrow">{text('graph.eyebrow')}</p>
      <h2 id="knowledge-graph-title">{text('graph.networkTitle')}</h2>
      <p class="summary">{text('graph.networkSummary', { nodes: model.nodes.length, edges: model.edges.length })}</p>
    </div>
    <div class="graph-actions">
      <div class="scope-toggle" role="group" aria-label={text('graph.scopeLabel')}>
        <button type="button" aria-pressed={scope === 'all'} onclick={() => setScope('all')}>{text('graph.scopeAll')}</button>
        <button type="button" aria-pressed={scope === 'focus'} disabled={!selectedId} onclick={() => setScope('focus')}>{text('graph.scopeFocus')}</button>
      </div>
      <button class="fit" type="button" onclick={fitGraph}>{text('graph.fit')}</button>
    </div>
  </header>

  {#if model.truncated.nodes || model.truncated.edges}
    <p class="limit-note" role="status">{text('graph.truncated', { nodes: model.truncated.nodes, edges: model.truncated.edges })}</p>
  {/if}

  <div class="graph-layout">
    <figure class="plot">
      <div class="jump-row">
        <label for="graph-jump">{text('graph.jump')}</label>
        <select id="graph-jump" value={activeNode?.id ?? ''} onchange={(event) => selectNode(event.currentTarget.value, true)}>
          {#each visibleKinds as kind}
            <optgroup label={text(`kind.${kind}`)}>
              {#each model.nodes.filter(node => node.kind === kind) as node}<option value={node.id}>{node.label} · {node.id}</option>{/each}
            </optgroup>
          {/each}
        </select>
      </div>
      {#if model.nodes.length}
        <div class="graph-canvas" bind:this={graphElement} role="img" aria-label={text('graph.canvasLabel')}>
          {#if !graphReady}<span class="canvas-fallback">{text('graph.canvasFallback')}</span>{/if}
        </div>
      {:else}
        <p class="empty" role="status">{text('graph.networkEmpty')}</p>
      {/if}
      <figcaption class="legend">
        <div class="node-legend" aria-label={text('graph.nodeLegend')}>
          {#each visibleKinds as kind}<span><i style={`--kind-color:${kindColors[kind]};--kind-shape:${kind === 'entities' ? '50%' : kind === 'relations' ? '2px' : '6px'}`}></i>{text(`kind.${kind}`)}</span>{/each}
        </div>
        <div class="edge-legend" aria-label={text('graph.edgeLegend')}>
          {#each model.relationTypes as relationType}<span><i style={`--edge-color:${relationColor(relationType)}`}></i>{relationType}</span>{/each}
          <span><i class="reference-line"></i>{text('graph.referenceEdge')}</span>
        </div>
        <p>{text('graph.description')} {text('graph.interactionHint')}</p>
      </figcaption>
    </figure>

    <aside class="graph-detail" aria-live="polite" aria-label={text('graph.detailLabel')}>
      {#if activeNode}
        <p class="eyebrow">{text(`kind.${activeNode.kind}`)} · {activeNode.id}</p>
        <h3>{activeNode.label}</h3>
        <p class="meta">{activeNode.subtitle} · {activeNode.importance === 0 ? text('importance.core') : text('importance.supporting')}</p>
        {#if activeNode.record.epistemic}<p class="meta">{text('field.epistemicStrength')}<strong>{activeNode.record.epistemic.strength}</strong></p>{/if}
        <p class="why">{activeNode.record.why}</p>
        <section>
          <h4>{text('graph.connections', { count: connections.length })}</h4>
          <div class="connection-list">
            {#each connections.slice(0, 8) as connection}
              <button type="button" onclick={() => selectNode(connection.other.id, true)}>
                <span>{connection.other.label}</span><small>{connection.edge.layer === 'relation' ? connection.edge.relationType : connection.edge.label}</small>
              </button>
            {:else}<p class="meta">{text('graph.noConnections')}</p>{/each}
          </div>
        </section>
        <button class="open-record" type="button" onclick={() => onOpenRecord(activeNode!.id)}>{text('graph.openReading')}</button>
      {:else if activeEdge}
        {@const source = model.nodes.find(node => node.id === activeEdge.source)}
        {@const target = model.nodes.find(node => node.id === activeEdge.target)}
        <p class="eyebrow">{activeEdge.layer === 'relation' ? text('graph.explicitRelation') : text('graph.structuralReference')}</p>
        <h3>{activeEdge.relationType}</h3>
        <p class="meta">{text('graph.role')} · {activeEdge.label}</p>
        <section>
          <h4>{text('graph.endpoints')}</h4>
          <div class="connection-list">
            {#if source}<button type="button" onclick={() => selectNode(source.id, true)}><span>{source.label}</span><small>{source.id}</small></button>{/if}
            {#if target}<button type="button" onclick={() => selectNode(target.id, true)}><span>{target.label}</span><small>{target.id}</small></button>{/if}
          </div>
        </section>
      {:else}
        <p class="meta">{text('graph.selectPrompt')}</p>
      {/if}
    </aside>
  </div>

  <details class="accessible-list">
    <summary>{text('graph.accessibleList', { count: model.edges.length })}</summary>
    <ul>
      {#each model.edges as edge}
        {@const source = model.nodes.find(node => node.id === edge.source)}
        {@const target = model.nodes.find(node => node.id === edge.target)}
        <li><button type="button" onclick={() => selectEdge(edge.id)}>{source?.label ?? edge.source} — {edge.relationType} / {edge.label} → {target?.label ?? edge.target}</button></li>
      {/each}
    </ul>
  </details>
</section>

<style>
  .knowledge-graph { min-width: 0; min-height: 0; padding: 16px 18px 24px; color: CanvasText; }
  .graph-header { display: flex; min-width: 0; align-items: flex-start; justify-content: space-between; gap: 18px; }
  h2, h3, h4, p, figure { margin: 0; } h2 { font-size: 20px; } h3 { margin-top: 4px; font-size: 19px; line-height: 1.35; overflow-wrap: anywhere; } h4 { font-size: 13px; }
  .eyebrow { color: var(--ui-tertiary, GrayText); font-size: 10px; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; }
  .summary, .meta { margin-top: 5px; color: var(--ui-secondary, GrayText); font-size: 12px; }
  .graph-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  .scope-toggle { display: flex; padding: 2px; border: 1px solid var(--ui-separator); border-radius: 8px; background: var(--ui-bg); }
  button, select { color: inherit; font: inherit; }
  button { cursor: pointer; }
  .scope-toggle button, .fit { min-height: 31px; padding: 5px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--ui-secondary); }
  .scope-toggle button[aria-pressed='true'] { background: var(--ui-surface); color: CanvasText; box-shadow: 0 1px 3px #0002; }
  .scope-toggle button:disabled { cursor: default; opacity: .4; }
  .fit { border: 1px solid var(--ui-control-border); background: var(--ui-surface); color: CanvasText; }
  .limit-note { margin-top: 10px; padding: 7px 9px; border-radius: 7px; background: color-mix(in srgb, var(--ui-accent, AccentColor) 8%, var(--ui-surface)); color: var(--ui-secondary); font-size: 12px; }
  .graph-layout { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) clamp(300px, 27vw, 370px); gap: 16px; margin-top: 14px; }
  .plot { min-width: 0; }
  .jump-row { display: flex; min-width: 0; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--ui-secondary); font-size: 12px; }
  .jump-row select { min-width: 0; min-height: 31px; flex: 1; padding: 4px 8px; border: 1px solid var(--ui-control-border); border-radius: 7px; background: var(--ui-surface); }
  .graph-canvas { position: relative; width: 100%; height: clamp(390px, 58vh, 650px); overflow: hidden; border: 1px solid var(--ui-separator); border-radius: 12px; background: var(--ui-surface); }
  .canvas-fallback { position: absolute; inset: 0; display: grid; place-items: center; padding: 18px; color: var(--ui-tertiary); font-size: 12px; text-align: center; }
  .graph-canvas :global(canvas) { position: relative; z-index: 1; }
  .legend { display: grid; gap: 7px; margin-top: 10px; color: var(--ui-secondary); font-size: 11px; }
  .node-legend, .edge-legend { display: flex; min-width: 0; flex-wrap: wrap; gap: 7px 14px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .node-legend i { width: 10px; height: 10px; border: 2px solid var(--kind-color); border-radius: var(--kind-shape); background: var(--ui-surface); }
  .edge-legend i { width: 20px; border-top: 2px solid var(--edge-color); }
  .edge-legend i.reference-line { border-top: 1px dashed var(--ui-secondary); }
  .graph-detail { min-width: 0; min-height: 250px; padding: 16px; border-radius: 12px; background: var(--ui-bg); overflow-wrap: anywhere; }
  .graph-detail .why { margin-top: 14px; line-height: 1.55; }
  .graph-detail section { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--ui-separator); }
  .connection-list { display: grid; gap: 3px; margin-top: 7px; }
  .connection-list button { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 10px; padding: 7px 8px; border: 0; border-radius: 6px; background: transparent; text-align: left; }
  .connection-list button:hover { background: var(--ui-hover); }
  .connection-list span { min-width: 0; overflow-wrap: anywhere; } .connection-list small { flex: none; color: var(--ui-tertiary); }
  .open-record { width: 100%; min-height: 34px; margin-top: 16px; padding: 6px 10px; border: 1px solid var(--ui-accent, AccentColor); border-radius: 7px; background: var(--ui-accent, AccentColor); color: var(--ui-accent-fg, white); font-weight: 600; }
  .accessible-list { margin-top: 14px; border-top: 1px solid var(--ui-separator); color: var(--ui-secondary); font-size: 12px; }
  .accessible-list summary { min-height: 36px; padding: 9px 0; cursor: pointer; }
  .accessible-list ul { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; }
  .accessible-list button { width: 100%; padding: 7px 9px; border: 0; border-radius: 6px; background: transparent; text-align: left; }
  .accessible-list button:hover { background: var(--ui-hover); }
  .empty { display: grid; min-height: 320px; place-items: center; color: var(--ui-secondary); }
  button:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--ui-accent, AccentColor); outline-offset: 2px; }

  @media (max-width: 899px) { .graph-layout { grid-template-columns: 1fr; } .graph-canvas { height: min(520px, 55vh); } }
  @media (max-width: 639px) {
    .knowledge-graph { padding: 12px; } .graph-header { flex-direction: column; } .graph-actions, .scope-toggle { width: 100%; }
    .scope-toggle button { flex: 1; } .fit { flex: 1; } .graph-canvas { height: 420px; }
  }
  @media (pointer: coarse) { .scope-toggle button, .fit, .jump-row select, .connection-list button, .open-record, .accessible-list summary { min-height: 44px; } }
</style>
