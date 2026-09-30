/// <reference types="node" />
import { expect, it } from 'vitest'
import process from 'node:process'
import { buildAtlas } from './atlas'
import { TerrainEngine } from './terrain'
import type { TerrainInputNode } from './types-terrain'

/** Opt-in, reproducible CPU/RSS measurement. RSS includes the Vitest process, not just Worker. */
it.skipIf(process.env.STRATA_BENCH !== '1')('measures 32k atlas and date updates without an all-pairs graph', () => {
  const before = process.memoryUsage(), started = performance.now()
  const nodes: TerrainInputNode[] = Array.from({ length: 32_000 }, (_, i) => ({
    id: `n${i.toString().padStart(5, '0')}`, title: `知识 ${i}`,
    features: [`领域${i % 37}`, `主题${i % 211}`, `概念${i % 503}`, `唯一${i}`],
    sourceGroups: [{ groupId: `g${Math.floor(i / 4)}`, groupVersion: '1', priority: 1 + i % 4,
      dates: [`2026-09-${String(1 + i % 30).padStart(2, '0')}`] }],
  }))
  const atlas = buildAtlas(nodes, 'bench-v1'), atlasMs = performance.now() - started
  const kernelStart = performance.now(), engine = new TerrainEngine(atlas), kernelsMs = performance.now() - kernelStart
  const samples: number[] = [], outputs: Record<string, unknown>[] = []
  for (let i = 0; i < 8; i++) {
    const t = performance.now()
    const result = engine.render({ from: `2026-09-${String(1 + i * 2).padStart(2, '0')}`, to: '2026-09-30' }, { width: 512, height: 512, contourStep: 3 })
    samples.push(performance.now() - t)
    outputs.push({ selected: result.stats.selectedNodes, fieldIntegral: result.stats.fieldIntegral, totalMass: result.stats.totalMass,
      kernelBytes: result.stats.kernelBytes, vertices: result.stats.contourVertices, truncated: result.stats.contoursTruncated, unresolvedPeaks: result.stats.unresolvedPeaks })
    expect(result.stats.kernelBytes).toBeLessThan(26 * 1024 * 1024)
    expect(result.stats.fieldIntegral / (result.stats.totalMass * (2 * Math.PI * (48 / 4096) ** 2))).toBeCloseTo(1, 4)
  }
  const warm = samples.slice(1).sort((a, b) => a - b), after = process.memoryUsage()
  console.log('STRATA_BENCH ' + JSON.stringify({ nodes: nodes.length, graphEdges: atlas.diagnostics.graphEdges,
    domains: atlas.domains.length, topics: atlas.topics.length, crowdedNodes: atlas.diagnostics.crowdedNodes,
    atlasMs, kernelsMs, updateMs: samples, warmP95Ms: warm[Math.ceil(warm.length * .95) - 1],
    rssBefore: before.rss, rssAfter: after.rss, heapUsedAfter: after.heapUsed, arrayBuffersAfter: after.arrayBuffers,
    processMaxRssKiB: process.resourceUsage().maxRSS, outputs }))
}, 120_000)
