import type { Atlas, AtlasCluster, AtlasNode, TerrainInputNode } from './types-terrain'

export const ATLAS_VERSION = 'strata-atlas/1'
export const WORLD_SIZE = 4096
const MAX_TERMS = 32, MAX_POSTING = 32, MAX_CANDIDATES = 256, MAX_NEIGHBORS = 12
const STOP = new Set('the a an and or of to in for is are on with this that from as by at it be 的 了 和 是 在 与 及 一个 我们 你们'.split(' '))

export function stableHash(value: string, salt = 0): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619)
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  return (h ^ (h >>> 13)) >>> 0
}
export const seeded = (id: string, salt = 0): number => stableHash(id, salt) / 4294967296

/** Explicit index features are preferred; the title fallback is only lexical organization. */
function terms(node: TerrainInputNode): string[] {
  const source = (node.features?.length ? node.features : [node.title]).join(' ').normalize('NFKC').toLowerCase()
  const found = source.match(/[\p{L}\p{N}_-]+/gu) || []
  const values: string[] = []
  for (const word of found) {
    if (STOP.has(word)) continue
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 2) {
      for (let i = 0; i < word.length - 1; i++) values.push(word.slice(i, i + 2))
    } else values.push(word)
  }
  return [...new Set(values)].slice(0, 128)
}

interface Vector { terms: string[]; weights: number[]; norm: number }
interface Graph { offsets: Uint32Array; targets: Uint32Array; weights: Float32Array; keys: string[] }

function graphFromMaps(rows: Map<number, number>[], keys: string[]): Graph {
  const offsets = new Uint32Array(rows.length + 1)
  for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + rows[i].size
  const targets = new Uint32Array(offsets[rows.length]), weights = new Float32Array(targets.length)
  rows.forEach((row, i) => {
    let at = offsets[i]
    for (const [j, weight] of [...row].sort((a, b) => a[0] - b[0])) { targets[at] = j; weights[at++] = weight }
  })
  return { offsets, targets, weights, keys }
}

function cosine(a: Vector, b: Vector): number {
  let i = 0, j = 0, dot = 0
  while (i < a.terms.length && j < b.terms.length) {
    if (a.terms[i] === b.terms[j]) { dot += a.weights[i++] * b.weights[j++] }
    else if (a.terms[i] < b.terms[j]) i++
    else j++
  }
  return dot / ((a.norm * b.norm) || 1)
}

/** Approximate sparse neighbors, never an N×N similarity matrix. */
function buildGraph(nodes: TerrainInputNode[], frozenIdf?: Record<string, number>): { graph: Graph; idf: Record<string, number> } {
  const nodeTerms = nodes.map(terms), frequency = new Map<string, number>()
  for (const list of nodeTerms) for (const term of list) frequency.set(term, (frequency.get(term) || 0) + 1)
  const idf: Record<string, number> = Object.create(null)
  for (const [term, count] of frequency) idf[term] = frozenIdf?.[term] ?? Math.log(1 + nodes.length / (1 + count))
  const vectors: Vector[] = nodeTerms.map(list => {
    const selected = list.filter(term => (frequency.get(term)! <= Math.max(8, nodes.length * .6)))
      .sort((a, b) => idf[b] - idf[a] || a.localeCompare(b)).slice(0, MAX_TERMS).sort()
    const weights = selected.map(term => idf[term])
    return { terms: selected, weights, norm: Math.sqrt(weights.reduce((sum, w) => sum + w * w, 0)) }
  })
  const postings = new Map<string, { index: number; hash: number }[]>()
  vectors.forEach((vector, i) => {
    for (const term of vector.terms) {
      const list = postings.get(term) || []
      const value = { index: i, hash: stableHash(nodes[i].id + '\0' + term) }
      if (list.length < MAX_POSTING) { list.push(value); list.sort((a, b) => a.hash - b.hash || a.index - b.index) }
      else if (value.hash < list[list.length - 1].hash) {
        list[list.length - 1] = value; list.sort((a, b) => a.hash - b.hash || a.index - b.index)
      }
      postings.set(term, list)
    }
  })
  const rows = nodes.map(() => new Map<number, number>()), byId = new Map(nodes.map((node, i) => [node.id, i]))
  const link = (a: number, b: number, weight: number) => {
    if (a === b) return
    rows[a].set(b, Math.max(rows[a].get(b) || 0, weight))
    rows[b].set(a, Math.max(rows[b].get(a) || 0, weight))
  }
  vectors.forEach((vector, i) => {
    const candidates = new Map<number, number>()
    const rare = [...vector.terms].sort((a, b) => (frequency.get(a)! - frequency.get(b)!) || a.localeCompare(b)).slice(0, 16)
    for (const term of rare) for (const { index } of postings.get(term) || []) {
      if (index !== i) candidates.set(index, (candidates.get(index) || 0) + idf[term] ** 2)
    }
    const neighbors = [...candidates].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_CANDIDATES)
      .map(([j]) => [j, cosine(vector, vectors[j])] as const).filter(([, score]) => score > .08)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_NEIGHBORS)
    for (const [j, score] of neighbors) link(i, j, score)
    for (const id of [...new Set(nodes[i].links || [])].sort().slice(0, 8)) {
      const j = byId.get(id); if (j !== undefined) link(i, j, 1)
    }
  })
  return { graph: graphFromMaps(rows, nodes.map(node => node.id)), idf }
}

function localMove(graph: Graph, gamma: number): number[] {
  const count = graph.keys.length, community = Array.from({ length: count }, (_, i) => i)
  const degrees = new Float64Array(count), totals = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    for (let edge = graph.offsets[i]; edge < graph.offsets[i + 1]; edge++) degrees[i] += graph.weights[edge]
    totals[i] = degrees[i]
  }
  const m2 = degrees.reduce((a, b) => a + b, 0)
  if (!m2) return community
  for (let round = 0; round < 8; round++) {
    let moved = false
    for (let i = 0; i < count; i++) {
      if (!degrees[i]) continue
      const current = community[i], weights = new Map<number, number>()
      for (let edge = graph.offsets[i]; edge < graph.offsets[i + 1]; edge++) {
        const j = graph.targets[edge]; if (j === i) continue
        const c = community[j]; weights.set(c, (weights.get(c) || 0) + graph.weights[edge])
      }
      totals[current] -= degrees[i]
      let best = current, gain = (weights.get(current) || 0) - gamma * degrees[i] * totals[current] / m2
      for (const [candidate, weight] of weights) {
        const value = weight - gamma * degrees[i] * totals[candidate] / m2
        if (value > gain + 1e-10 || (Math.abs(value - gain) <= 1e-10 && graph.keys[candidate] < graph.keys[best])) {
          best = candidate; gain = value
        }
      }
      totals[best] += degrees[i]
      if (best !== current) { community[i] = best; moved = true }
    }
    if (!moved) break
  }
  return community
}

/** Four bounded contractions, eight deterministic local-move rounds per level. */
function communities(original: Graph, gamma: number): number[] {
  let graph = original, membership = Array.from({ length: original.keys.length }, (_, i) => i)
  for (let level = 0; level < 4; level++) {
    const labels = localMove(graph, gamma), unique = [...new Set(labels)].sort((a, b) => graph.keys[a].localeCompare(graph.keys[b]))
    const dense = new Map(unique.map((id, i) => [id, i])), groups = labels.map(label => dense.get(label)!)
    membership = membership.map(i => groups[i])
    if (unique.length === graph.keys.length || unique.length <= 1) break
    const rows = unique.map(() => new Map<number, number>()), keys = unique.map(() => '')
    for (let i = 0; i < graph.keys.length; i++) {
      const a = groups[i]; if (!keys[a] || graph.keys[i] < keys[a]) keys[a] = graph.keys[i]
      for (let edge = graph.offsets[i]; edge < graph.offsets[i + 1]; edge++) {
        const b = groups[graph.targets[edge]]; rows[a].set(b, (rows[a].get(b) || 0) + graph.weights[edge])
      }
    }
    graph = graphFromMaps(rows, keys)
  }
  return membership
}

function groupMembers(labels: number[]): number[][] {
  const groups = new Map<number, number[]>()
  labels.forEach((label, i) => { const list = groups.get(label) || []; list.push(i); groups.set(label, list) })
  return [...groups.values()].sort((a, b) => a[0] - b[0])
}

function induced(graph: Graph, members: number[]): Graph {
  const ids = new Map(members.map((id, i) => [id, i])), rows = members.map(() => new Map<number, number>())
  members.forEach((id, i) => {
    for (let edge = graph.offsets[id]; edge < graph.offsets[id + 1]; edge++) {
      const j = ids.get(graph.targets[edge]); if (j !== undefined) rows[i].set(j, graph.weights[edge])
    }
  })
  return graphFromMaps(rows, members.map(i => graph.keys[i]))
}

interface Rect { x: number; y: number; width: number; height: number }
/** Reserved rectangles make every circle placement bounded and collision-free. */
function slots(weights: number[], rect: Rect): Rect[] {
  const result: Rect[] = new Array(weights.length)
  function split(from: number, to: number, area: Rect): void {
    if (to - from === 1) { result[from] = area; return }
    let total = 0; for (let i = from; i < to; i++) total += weights[i]
    let cut = from + 1, first = weights[from]
    while (cut < to - 1 && first + weights[cut] / 2 < total / 2) first += weights[cut++]
    const fraction = Math.max(.1, Math.min(.9, first / total))
    if (area.width >= area.height) {
      split(from, cut, { ...area, width: area.width * fraction })
      split(cut, to, { ...area, x: area.x + area.width * fraction, width: area.width * (1 - fraction) })
    } else {
      split(from, cut, { ...area, height: area.height * fraction })
      split(cut, to, { ...area, y: area.y + area.height * fraction, height: area.height * (1 - fraction) })
    }
  }
  if (weights.length) split(0, weights.length, rect)
  return result
}

function titleFor(members: number[], nodes: TerrainInputNode[]): string {
  const scores = new Map<string, number>()
  // Internal CJK bigrams are useful for similarity but are not human-readable topic names.
  // Only original, complete source features may label a cluster; otherwise retain a real title.
  for (const i of members) for (const feature of new Set((nodes[i].features || []).slice(0, MAX_TERMS))) {
    const name = feature.normalize('NFKC').trim()
    if (name.length < 2 || name.length > 36 || STOP.has(name.toLowerCase())) continue
    scores.set(name, (scores.get(name) || 0) + 1)
  }
  const labels = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([term]) => term)
  return labels.join(' · ') || nodes[members[0]]?.title || '未归类'
}

function circle(rect: Rect): { x: number; y: number; radius: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, radius: Math.min(rect.width, rect.height) * .45 }
}

export function buildAtlas(input: TerrainInputNode[], epoch: string, previous?: Atlas): Atlas {
  const start = performance.now(), nodes = [...input].sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('STRATA 节点 ID 重复')
  if (previous?.epoch === epoch && previous.version === ATLAS_VERSION) return updateAtlas(nodes, previous, start)
  const { graph, idf } = buildGraph(nodes)
  const domainMembers = groupMembers(communities(graph, .6))
  const domainSlots = slots(domainMembers.map(group => Math.sqrt(group.length)), { x: .035, y: .035, width: .93, height: .93 })
  const domains: AtlasCluster[] = [], topics: AtlasCluster[] = [], placed: AtlasNode[] = []
  domainMembers.forEach((members, domainIndex) => {
    const d = circle(domainSlots[domainIndex]), domainId = 'domain:' + nodes[members[0]].id
    domains.push({ id: domainId, name: titleFor(members, nodes), ...d, memberIds: members.map(i => nodes[i].id) })
    const groups = members.length <= 8 ? [members] : groupMembers(communities(induced(graph, members), 1.2)).map(group => group.map(i => members[i]))
    const side = d.radius * 1.4, topicSlots = slots(groups.map(group => Math.sqrt(group.length)), { x: d.x - side / 2, y: d.y - side / 2, width: side, height: side })
    groups.forEach((items, groupIndex) => {
      const t = groups.length === 1 ? { ...d, radius: d.radius * .87 } : circle(topicSlots[groupIndex])
      const topicId = 'topic:' + nodes[items[0]].id
      topics.push({ id: topicId, parentId: domainId, name: titleFor(items, nodes), ...t, memberIds: items.map(i => nodes[i].id) })
      const unit = t.radius / Math.max(2, Math.sqrt(items.length) * 1.1)
      // Equal-area sunflower slots: deterministic O(N), no pairwise collision loop.
      items.forEach((i, j) => {
        const angle = j * 2.399963229728653 + seeded(topicId) * Math.PI * 2
        const distance = items.length === 1 ? 0 : t.radius * .78 * Math.sqrt((j + .5) / items.length)
        placed.push({ ...nodes[i], x: t.x + Math.cos(angle) * distance, y: t.y + Math.sin(angle) * distance,
          radius: unit * .3, parentTopic: topicId, parentDomain: domainId, crowded: unit < 1 / WORLD_SIZE })
      })
    })
  })
  placed.sort((a, b) => a.id.localeCompare(b.id))
  return { version: ATLAS_VERSION, epoch, worldSize: WORLD_SIZE, nodes: placed, domains, topics, idf,
    diagnostics: { graphEdges: graph.targets.length / 2, crowdedNodes: placed.filter(node => node.crowded).length,
      rebuildSuggested: placed.some(node => node.crowded), elapsedMs: performance.now() - start } }
}

/** Existing coordinates survive updates. New items use bounded reserved local slots. */
function updateAtlas(nodes: TerrainInputNode[], previous: Atlas, start: number): Atlas {
  const old = new Map(previous.nodes.map(node => [node.id, node])), allowed = new Set(nodes.map(node => node.id))
  const domains = previous.domains.map(cluster => ({ ...cluster, memberIds: cluster.memberIds.filter(id => allowed.has(id)) }))
  const topics = previous.topics.map(cluster => ({ ...cluster, memberIds: cluster.memberIds.filter(id => allowed.has(id)) }))
  const byTopic = new Map(topics.map(topic => [topic.id, topic])), placed: AtlasNode[] = []
  const featureTopics = new Map<string, Set<string>>()
  for (const node of nodes) {
    const prior = old.get(node.id); if (!prior) continue
    for (const term of terms(node).slice(0, MAX_TERMS)) {
      const candidates = featureTopics.get(term) || new Set<string>()
      if (candidates.size < MAX_POSTING) candidates.add(prior.parentTopic)
      featureTopics.set(term, candidates)
    }
  }
  let additions = 0
  for (const node of nodes) {
    const existing = old.get(node.id)
    if (existing) { placed.push({ ...existing, ...node }); continue }
    additions++
    const linked = (node.links || []).map(id => old.get(id)).find(Boolean)
    const scores = new Map<string, number>()
    for (const term of terms(node).slice(0, MAX_TERMS)) for (const id of featureTopics.get(term) || []) scores.set(id, (scores.get(id) || 0) + (previous.idf[term] || 1))
    const best = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
    let topic = (linked && byTopic.get(linked.parentTopic)) || (best ? byTopic.get(best) : undefined)
    if (!topics.length) return buildAtlas(nodes, previous.epoch)
    if (!topic) {
      // Unrelated new content is explicitly unclassified, never attached to a random topic.
      const id = 'topic:unclassified-additions', domainId = 'domain:unclassified-additions'
      topic = byTopic.get(id)
      if (!topic) {
        topic = { id, parentId: domainId, name: '新材料 · 待整理', x: .5, y: .975, radius: .02, memberIds: [] }
        topics.push(topic); byTopic.set(id, topic)
        domains.push({ id: domainId, name: '待整理', x: .5, y: .975, radius: .023, memberIds: [] })
      }
    }
    const angle = seeded(node.id, 91) * Math.PI * 2, radius = topic.radius * (.81 + seeded(node.id, 97) * .1)
    placed.push({ ...node, x: topic.x + Math.cos(angle) * radius, y: topic.y + Math.sin(angle) * radius,
      radius: Math.min(.003, topic.radius / Math.sqrt(topic.memberIds.length + 1) * .15),
      parentTopic: topic.id, parentDomain: topic.parentId!, crowded: true })
    topic.memberIds.push(node.id)
    domains.find(domain => domain.id === topic.parentId)?.memberIds.push(node.id)
  }
  const indices = new Map(nodes.map((node, i) => [node.id, i]))
  for (const cluster of [...domains, ...topics]) if (cluster.memberIds.length) {
    cluster.name = titleFor(cluster.memberIds.map(id => indices.get(id)!).filter(i => i !== undefined), nodes)
  }
  return { ...previous, nodes: placed, domains: domains.filter(d => d.memberIds.length), topics: topics.filter(t => t.memberIds.length),
    diagnostics: { ...previous.diagnostics, crowdedNodes: placed.filter(node => node.crowded).length,
      rebuildSuggested: additions > 0 || previous.diagnostics.rebuildSuggested, elapsedMs: performance.now() - start } }
}
