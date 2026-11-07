import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { corpus, quantiles } from './corpus.mjs'
import { verifyRun, summarizeRuns } from './audit-web-reports.mjs'

function fixture(repeat, standard = true) {
  const { markdown, ...metadata } = corpus(10000)
  const warmup = standard ? 1000 : 20, samples = standard ? 100 : 10
  let text = markdown, growth = 0
  for (let i = 0; i < warmup + samples; i++) {
    const input = metadata.input_sequence[i % 4], marker = metadata.markers[i % 3]
    text = text.replace(marker, input + marker); growth += input.length
  }
  const raw = Array.from({ length: samples }, (_, i) => ({ synchronous_dispatch_ms: i % 5, dispatch_to_raf_opportunity_ms: i % 7 + 6 }))
  return { mode: 'rich', fixture: metadata, repeat, warmup, samples, mount_ms: 12, raw, synchronous_dispatch_ms: quantiles(raw.map(r => r.synchronous_dispatch_ms)), dispatch_to_raf_opportunity_ms: quantiles(raw.map(r => r.dispatch_to_raf_opportunity_ms)), correctness: { exact_text: true, text_growth: growth, expected_growth: growth, markers_intact: true }, final_text_sha256: createHash('sha256').update(text).digest('hex'), plugin_count: 23 }
}
test('excludes quick checks and deduplicates cumulative copies without mixing repeat 0', () => {
  const quick = fixture(0, false), runs = Array.from({ length: 5 }, (_, i) => fixture(i))
  const result = summarizeRuns([{ programmatic: [quick, ...runs] }, { programmatic: [quick, ...runs] }])
  assert.equal(result.duplicate_cumulative_copies_ignored, 6)
  assert.equal(result.excluded_nonstandard_runs.length, 1)
  assert.equal(result.groups[0].formal_repeats, 5)
  assert.equal(result.groups[0].synchronous_dispatch_ms.count, 500)
  assert.equal(result.groups[0].exactly_five_repeats, true)
  assert.equal(result.complete_normal_matrix, false)
  assert.equal(result.physical_input_to_frame_gate, 'NOT_MEASURED')
})
test('independently rejects corrupted text and altered timing quantiles', () => {
  const text = fixture(0); text.final_text_sha256 = '0'.repeat(64)
  assert.throws(() => verifyRun(text), /final-text/)
  const timings = fixture(0); timings.synchronous_dispatch_ms.p95 = 900
  assert.throws(() => verifyRun(timings), /quantiles/)
})
