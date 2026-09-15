import { describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_READ_CONCURRENCY, matchesDatasetName, normalizeDatasetDirectory,
  scanDatasetDirectory, summarizeDataset,
} from './directory'

function dataset(id: string, purpose = '测试') {
  return JSON.stringify({
    schema: 'knowledge-representation-dataset/3.0.0', id,
    generated: { at: '2026-09-15T00:00:00Z' }, scope: { purpose },
    sources: [], evidence: [], entities: [{}], concepts: [], claims: [{}, {}], events: [], narratives: [], relations: [{}],
  })
}

describe('dataset directory discovery', () => {
  it('matches only the two product file-name forms and rejects unsafe roots', () => {
    expect(matchesDatasetName('notes-knowledge-v3.json')).toBe(true)
    expect(matchesDatasetName('notes.knowledge.json')).toBe(true)
    expect(matchesDatasetName('knowledge.json')).toBe(false)
    expect(matchesDatasetName('notes.json')).toBe(false)
    expect(normalizeDatasetDirectory('./research/')).toBe('research')
    for (const path of ['', '../research', '/research', '.notemd/data', 'research/node_modules/data']) {
      expect(normalizeDatasetDirectory(path)).toBeNull()
    }
  })

  it('summarizes without retaining the full source and distinguishes unsupported data', async () => {
    await expect(summarizeDataset('research/a.knowledge.json', dataset('ks_a'))).resolves.toMatchObject({
      title: 'a', status: 'available', datasetId: 'ks_a', purpose: '测试',
      counts: { entities: 1, claims: 2, relations: 1 },
    })
    await expect(summarizeDataset('research/a.knowledge.json', '{"schema":"knowledge-representation-dataset/2.0.0"}')).resolves.toMatchObject({ status: 'unsupported' })
    await expect(summarizeDataset('research/a.knowledge.json', '{bad')).resolves.toMatchObject({ status: 'invalid' })
  })

  it('uses direct children by default, recurses when requested, and skips control directories', async () => {
    const tree: Record<string, Array<{ name: string; is_dir: boolean }>> = {
      research: [{ name: 'b.knowledge.json', is_dir: false }, { name: 'ignore.json', is_dir: false }, { name: 'nested', is_dir: true }, { name: '.notemd', is_dir: true }],
      'research/nested': [{ name: 'a-knowledge-v3.json', is_dir: false }],
    }
    const io = { list: vi.fn(async path => tree[path] ?? []), read: vi.fn(async path => dataset(path.endsWith('b.knowledge.json') ? 'ks_same' : 'ks_nested')) }
    const direct = await scanDatasetDirectory(io)
    expect(direct.items.map(item => item.path)).toEqual(['research/b.knowledge.json'])
    const recursive = await scanDatasetDirectory(io, { recursive: true })
    expect(recursive.items.map(item => item.path)).toEqual(['research/b.knowledge.json', 'research/nested/a-knowledge-v3.json'])
    expect(io.list).not.toHaveBeenCalledWith('research/.notemd')
  })

  it('never exceeds two concurrent reads and marks duplicate dataset snapshots', async () => {
    let active = 0
    let peak = 0
    const io = {
      list: async () => Array.from({ length: 4 }, (_, i) => ({ name: `${i}.knowledge.json`, is_dir: false })),
      read: async (path: string) => {
        active++; peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 10))
        active--
        return dataset('ks_shared', path.startsWith('research/0') ? 'different' : 'same')
      },
    }
    const result = await scanDatasetDirectory(io)
    expect(peak).toBe(DIRECTORY_READ_CONCURRENCY)
    expect(result.items.every(item => item.copyState === 'different-snapshot')).toBe(true)
  })

  it('cancellation preserves completed items and stops scheduling more reads', async () => {
    const controller = new AbortController()
    let reads = 0
    const io = {
      list: async () => Array.from({ length: 5 }, (_, i) => ({ name: `${i}.knowledge.json`, is_dir: false })),
      read: async () => { reads++; if (reads === 1) controller.abort(); return dataset(`ks_${reads}`) },
    }
    const result = await scanDatasetDirectory(io, { signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(result.items).toHaveLength(1)
    expect(reads).toBe(1)
  })
})
