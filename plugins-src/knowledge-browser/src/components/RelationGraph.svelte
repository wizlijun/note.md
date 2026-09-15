<script module lang="ts">
  import type { DatasetIndexes, Relation } from '../lib/types'

  export type RelationGraphText = (key: string, values?: Record<string, string | number>) => string

  export interface RelationGraphProps {
    relations: readonly Relation[]
    indexes: DatasetIndexes
    centerId?: string | null
    text: RelationGraphText
    onSelectRelation: (relation: Relation) => void
    onNavigate: (id: string) => void
  }
</script>

<script lang="ts">
  import { relationStatement, roleEntries, sourceLabel } from '../lib/normalizer'
  import { recordLabel } from '../lib/types'

  let {
    relations,
    indexes,
    centerId = null,
    text,
    onSelectRelation,
    onNavigate,
  }: RelationGraphProps = $props()

  interface Participant {
    role: string
    ref: string
    label: string
  }

  interface GraphGroup {
    relation: Relation
    statement: string
    participants: Participant[]
    top: number
    centerY: number
    height: number
  }

  function participantLabel(ref: string): string {
    const node = indexes.nodesById.get(ref)
    if (node) return recordLabel(node)
    const source = indexes.sourcesById.get(ref)
    return source ? sourceLabel(source) : ref
  }

  function compact(value: string, length = 34): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized
  }

  const groups = $derived.by(() => {
    let top = 24
    return relations.map(relation => {
      const participants = roleEntries(relation.args).map(item => ({ ...item, label: participantLabel(item.ref) }))
      const height = Math.max(104, participants.length * 58 + 18)
      const group: GraphGroup = {
        relation,
        statement: relationStatement(relation, indexes)[0] ?? `${relation.type} · ${relation.id}`,
        participants,
        top,
        centerY: top + height / 2,
        height,
      }
      top += height + 24
      return group
    })
  })

  const graphHeight = $derived(Math.max(180, groups.reduce((height, group) => height + group.height + 24, 24)))

  function activate(event: KeyboardEvent, action: () => void): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    action()
  }
</script>

<section class="relation-graph" aria-labelledby="relation-graph-heading">
  <header>
    <div>
      <h2 id="relation-graph-heading">{text('graph.title')}</h2>
      <p>{text('graph.summary', { relations: relations.length })}</p>
    </div>
  </header>

  {#if relations.length === 0}
    <p class="empty" role="status">{text('graph.empty')}</p>
  {:else}
    <div class="canvas" aria-label={text('graph.canvasLabel')}>
      <svg viewBox={`0 0 900 ${graphHeight}`} role="img" aria-labelledby="relation-graph-heading graph-description">
        <desc id="graph-description">{text('graph.description')}</desc>
        {#each groups as group (group.relation.id)}
          {#each group.participants as participant, index (`${group.relation.id}:${participant.role}:${participant.ref}:${index}`)}
            {@const participantY = group.top + 38 + index * 58}
            <line class="role-line" x1="340" y1={group.centerY} x2="570" y2={participantY} />
            <rect class="role-label-bg" x="410" y={((group.centerY + participantY) / 2) - 10} width="94" height="20" rx="10" />
            <text class="role-label" x="457" y={((group.centerY + participantY) / 2) + 4} text-anchor="middle">{compact(participant.role, 14)}</text>
          {/each}

          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <g
            class="node relation-node"
            role="button"
            tabindex="0"
            aria-label={text('graph.relationNode', { id: group.relation.id, type: group.relation.type })}
            onclick={() => onSelectRelation(group.relation)}
            onkeydown={(event) => activate(event, () => onSelectRelation(group.relation))}
          >
            <rect x="60" y={group.centerY - 37} width="280" height="74" rx="10" />
            <text x="78" y={group.centerY - 10}>
              <tspan class="node-title">P{group.relation.p} · {compact(group.relation.type, 27)}</tspan>
              <tspan class="node-detail" x="78" dy="23">{compact(group.statement, 39)}</tspan>
            </text>
          </g>

          {#each group.participants as participant, index (`node:${group.relation.id}:${participant.role}:${participant.ref}:${index}`)}
            {@const participantY = group.top + 38 + index * 58}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <g
              class="node participant-node"
              class:center={participant.ref === centerId}
              class:missing={!indexes.nodesById.has(participant.ref) && !indexes.sourcesById.has(participant.ref)}
              role="button"
              tabindex="0"
              aria-label={text('graph.participantNode', { role: participant.role, label: participant.label })}
              onclick={() => onNavigate(participant.ref)}
              onkeydown={(event) => activate(event, () => onNavigate(participant.ref))}
            >
              <rect x="570" y={participantY - 23} width="270" height="46" rx="9" />
              <text x="588" y={participantY + 5} class="node-title">{compact(participant.label, 35)}</text>
            </g>
          {/each}
        {/each}
      </svg>
    </div>

    <section class="equivalent-list" aria-labelledby="relation-list-heading">
      <h3 id="relation-list-heading">{text('graph.equivalentList')}</h3>
      <ol>
        {#each groups as group (group.relation.id)}
          <li>
            <button class="relation-link" type="button" onclick={() => onSelectRelation(group.relation)}>
              <strong>P{group.relation.p} · {group.relation.type}</strong>
              <span>{group.statement}</span>
            </button>
            <ul>
              {#each group.participants as participant, index (`list:${group.relation.id}:${participant.role}:${participant.ref}:${index}`)}
                <li>
                  <span class="role">{participant.role}</span>
                  <button type="button" class:center={participant.ref === centerId} onclick={() => onNavigate(participant.ref)}>
                    {participant.label} <code>{participant.ref}</code>
                  </button>
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ol>
    </section>
  {/if}
</section>

<style>
  .relation-graph { min-width: 0; min-height: 0; overflow: auto; color: CanvasText; }
  header { padding: 16px 18px 10px; }
  h2, h3 { margin: 0; }
  h2 { font-size: 18px; }
  h3 { font-size: 14px; }
  header p { margin: 5px 0 0; color: var(--ui-secondary, GrayText); font-size: 12px; }
  .canvas { width: 100%; min-width: 0; overflow: hidden; padding: 0 10px; box-sizing: border-box; }
  svg { display: block; width: 100%; max-width: 980px; height: auto; margin: auto; }
  .role-line { stroke: var(--ui-separator-strong, color-mix(in srgb, CanvasText 35%, transparent)); stroke-width: 1.5; }
  .role-label-bg { fill: var(--ui-surface, Canvas); stroke: var(--ui-separator, color-mix(in srgb, CanvasText 16%, transparent)); }
  .role-label { fill: var(--ui-secondary, GrayText); font-size: 11px; }
  .node { cursor: pointer; outline: none; }
  .node rect { fill: var(--ui-surface, Canvas); stroke: var(--ui-control-border, color-mix(in srgb, CanvasText 22%, transparent)); stroke-width: 1.5; }
  .node:hover rect { fill: var(--ui-hover, color-mix(in srgb, CanvasText 7%, Canvas)); }
  .node:focus-visible rect { stroke: var(--ui-accent, AccentColor); stroke-width: 3; }
  .relation-node rect { fill: var(--ui-selection, color-mix(in srgb, AccentColor 11%, Canvas)); stroke: var(--ui-accent, AccentColor); }
  .participant-node.center rect { fill: var(--ui-selection, color-mix(in srgb, AccentColor 15%, Canvas)); stroke: var(--ui-accent, AccentColor); }
  .participant-node.missing rect { stroke: var(--ui-danger, #b42318); stroke-dasharray: 5 3; }
  .node text { pointer-events: none; fill: CanvasText; }
  .node-title { font-size: 14px; font-weight: 650; }
  .node-detail { fill: var(--ui-secondary, GrayText); font-size: 12px; font-weight: 400; }

  .equivalent-list { min-width: 0; padding: 14px 18px 26px; border-top: 1px solid var(--ui-separator, color-mix(in srgb, CanvasText 16%, transparent)); }
  ol, ul { min-width: 0; padding-inline-start: 22px; }
  ol > li { margin: 12px 0 18px; }
  ul > li { display: flex; min-width: 0; align-items: baseline; gap: 8px; margin: 6px 0; }
  button { max-width: 100%; border: 1px solid var(--ui-control-border, color-mix(in srgb, CanvasText 20%, transparent)); border-radius: 7px; background: var(--ui-surface, Canvas); color: inherit; font: inherit; cursor: pointer; }
  button:hover { background: var(--ui-hover, color-mix(in srgb, CanvasText 7%, transparent)); }
  button:focus-visible { outline: 2px solid var(--ui-accent, AccentColor); outline-offset: 2px; }
  .relation-link { display: grid; width: 100%; gap: 4px; padding: 8px 10px; text-align: start; }
  .relation-link span { overflow-wrap: anywhere; color: var(--ui-secondary, GrayText); }
  ul button { min-width: 0; padding: 4px 8px; overflow-wrap: anywhere; text-align: start; }
  ul button.center { border-color: var(--ui-accent, AccentColor); }
  .role { flex: 0 1 11rem; min-width: 0; color: var(--ui-secondary, GrayText); font-size: 12px; overflow-wrap: anywhere; }
  code { color: var(--ui-secondary, GrayText); font-size: 11px; }
  .empty { padding: 36px 18px; color: var(--ui-secondary, GrayText); text-align: center; }

  @media (max-width: 639px) {
    header, .equivalent-list { padding-inline: 12px; }
    .canvas { padding-inline: 4px; }
    ul > li { align-items: stretch; flex-direction: column; gap: 3px; }
    .role { flex: none; }
  }
</style>
