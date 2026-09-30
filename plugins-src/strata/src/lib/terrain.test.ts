import { describe, expect, it } from 'vitest'
import { buildAtlas } from './atlas'
import { calculateMasses, CONTOUR_LEVELS, KERNEL_INTEGRAL, TerrainEngine } from './terrain'
import type { TerrainInputNode } from './types-terrain'

export function fixture(count: number): TerrainInputNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 'node-' + i.toString().padStart(5, '0'), title: `知识 ${i}`,
    features: [`domain${i % 5}`, `topic${i % 17}`, `specific${i}`],
    sourceGroups: [{ groupId: 'source-' + i, groupVersion: 'v1', priority: 1 + i % 3,
      dates: [i % 2 ? '2026-09-20' : '2026-09-29'] }],
  }))
}
const all = { from: '2026-09-01', to: '2026-09-30' }
function inside(x: number, y: number, ring: number[][]): boolean {
  let result = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result
  }
  return result
}

describe('frozen atlas and source budgets', () => {
  it('is independent of input order and date masks; preserves old coordinates on additions', () => {
    const nodes = fixture(40), atlas = buildAtlas(nodes, 'epoch')
    const reversed = buildAtlas([...nodes].reverse(), 'epoch')
    expect(reversed.nodes).toEqual(atlas.nodes)
    expect(reversed.domains).toEqual(atlas.domains)
    const updated = buildAtlas(fixture(41), 'epoch', atlas)
    for (const node of atlas.nodes) {
      const next = updated.nodes.find(n => n.id === node.id)!
      expect([next.x, next.y, next.parentTopic]).toEqual([node.x, node.y, node.parentTopic])
    }
    expect(updated.diagnostics.rebuildSuggested).toBe(true)
    expect(atlas.nodes.every(node => node.x >= 0 && node.x <= 1 && node.y >= 0 && node.y <= 1)).toBe(true)
    for (const topic of atlas.topics) expect(atlas.domains.find(domain => domain.id === topic.parentId)?.memberIds).toEqual(expect.arrayContaining(topic.memberIds))
  })

  it('freezes complete source membership and deduplicates repeated support', () => {
    const common = { groupId: 'book', groupVersion: 'v1', priority: 4, canonicalIds: ['a', 'b', 'not-yet-drawable'] }
    const atlas = buildAtlas([
      { id: 'a', title: 'A', sourceGroups: [{ ...common, dates: ['2026-09-01'] }, { ...common, dates: ['2026-09-01'] }] },
      { id: 'b', title: 'B', sourceGroups: [{ ...common, dates: ['2026-09-20'] }] },
    ], 'epoch')
    const full = calculateMasses(atlas, all), narrow = calculateMasses(atlas, { from: '2026-09-01', to: '2026-09-01' })
    expect(full[0]).toBeCloseTo(2 * (1 - Math.exp(-2)) / 3, 7)
    expect(narrow[0]).toBe(full[0]); expect(narrow[1]).toBe(0)
    expect(full[0]).toBe(full[1])
    expect(() => calculateMasses(atlas, { from: '2026-10-01', to: '2026-09-01' })).toThrow()
  })

  it('never treats unknown confidentiality as public', () => {
    const nodes = fixture(2); nodes[0].confidentiality = 'unknown'; nodes[1].confidentiality = 'explicitly_public'
    const masses = calculateMasses(buildAtlas(nodes, 'epoch'), { ...all, includePublic: false })
    expect(masses[0]).toBeGreaterThan(0); expect(masses[1]).toBe(0)
  })

  it('names Chinese clusters with complete source phrases, never tokenizer bigrams', () => {
    const nodes = fixture(3).map((node, i) => ({ ...node, title: `下次行动之前核对第${i + 1}份原文证据`, features: ['原文证据核对', '知识来源追溯'] }))
    const labeled = buildAtlas(nodes, 'chinese-names')
    for (const cluster of [...labeled.domains, ...labeled.topics]) {
      for (const phrase of cluster.name.split(' · ')) expect(['原文证据核对', '知识来源追溯']).toContain(phrase)
    }
    const fallback = buildAtlas(nodes.map(node => ({ ...node, features: [] })), 'chinese-fallback')
    for (const cluster of [...fallback.domains, ...fallback.topics]) expect(nodes.map(node => node.title)).toContain(cluster.name)
  })
})

describe('shared conservative scalar field', () => {
  it('is deterministic, positive, empty at zero, monotone across dates, and conserves mass', () => {
    const atlas = buildAtlas(fixture(40), 'epoch'), engine = new TerrainEngine(atlas)
    const full = engine.render(all, { width: 192, height: 192, contourStep: 6 })
    const repeated = engine.render(all, { width: 192, height: 192, contourStep: 6 })
    expect(repeated.field).toEqual(full.field)
    const partial = engine.render({ from: '2026-09-29', to: '2026-09-30' }, { width: 192, height: 192, contourStep: 6 })
    expect(partial.field.every((value, i) => value <= full.field[i] + 1e-6)).toBe(true)
    expect(full.field.every(value => Number.isFinite(value) && value >= 0)).toBe(true)
    expect(full.stats.fieldIntegral / (full.stats.totalMass * KERNEL_INTEGRAL)).toBeCloseTo(1, 6)
    expect(full.contours.every(contour => CONTOUR_LEVELS.includes(contour.value))).toBe(true)
    const empty = engine.render({ from: '2020-01-01', to: '2020-01-02' })
    expect(empty.field.every(value => value === 0)).toBe(true)
    expect(empty.contours).toHaveLength(0); expect(empty.peakAnchors).toHaveLength(0)
  })

  it('integrates tiles from the same frozen field without renormalizing visible mass', () => {
    const engine = new TerrainEngine(buildAtlas(fixture(12), 'epoch'))
    const coarse = engine.render(all, { width: 64, height: 64, contourStep: 12 })
    const fine = engine.render(all, { width: 128, height: 128, contourStep: 12 })
    expect(fine.stats.fieldIntegral).toBeCloseTo(coarse.stats.fieldIntegral, 7)
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const at = 2 * y * 128 + 2 * x
      expect(coarse.field[y * 64 + x]).toBeCloseTo((fine.field[at] + fine.field[at + 1] + fine.field[at + 128] + fine.field[at + 129]) / 4, 5)
    }
    const tile = engine.render(all, { width: 64, height: 64, bounds: { x: .25, y: .25, width: .5, height: .5 }, contourStep: 12 })
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) expect(tile.field[y * 64 + x]).toBeCloseTo(fine.field[(y + 32) * 128 + x + 32], 5)
  })

  it('reports unresolved peaks at insufficient resolution and resolves focused child peaks', () => {
    const atlas = buildAtlas(fixture(40), 'epoch'), engine = new TerrainEngine(atlas)
    const full = engine.render(all, { width: 512, height: 512, contourStep: 3 })
    expect(full.peakAnchors).toHaveLength(40)
    expect(full.peakAnchors.filter(peak => peak.resolved).length).toBe(40)
    expect(new Set(full.peakAnchors.filter(p => p.resolved).map(p => `${p.x}:${p.y}`)).size).toBe(full.peakAnchors.filter(p => p.resolved).length)
    const peaks = full.peakAnchors.map(peak => [peak.x * 512, peak.y * 512])
    const exclusive = new Set<number>()
    for (const contour of full.contours) for (const polygon of contour.coordinates) {
      for (const ring of polygon) {
        expect(ring.length).toBeGreaterThanOrEqual(4)
        expect(ring[0]).toEqual(ring[ring.length - 1])
      }
      const members = peaks.map(([x, y], i) => inside(x, y, polygon[0]) && !polygon.slice(1).some(hole => inside(x, y, hole)) ? i : -1).filter(i => i >= 0)
      if (members.length === 1) exclusive.add(members[0])
    }
    expect(exclusive.size).toBe(40)
  })

  it('keeps wide slopes continuous when the viewport oversamples the fixed 128-cell basis', () => {
    const engine = new TerrainEngine(buildAtlas(fixture(1), 'smooth-wide-slopes'))
    const result = engine.render(all, { width: 512, height: 512, contourStep: 12 })
    // This strip lies outside the compact local peak: only the broad, continuous slope remains.
    let plateaus = 0
    for (let x = 42; x < 101; x++) {
      const a = result.field[154 * 512 + x], b = result.field[154 * 512 + x + 1]
      if (Math.abs(a - b) <= Math.max(1e-12, Math.abs(a) * 1e-6)) plateaus++
    }
    expect(plateaus).toBeLessThan(6)
  })
})
