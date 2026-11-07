#!/usr/bin/env node
// Read-only verification. Cumulative reports are deduplicated by exact run data,
// never by repeat number (a second independent batch also starts at repeat 0).
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import { corpus, quantiles } from './corpus.mjs'

const sha = data => createHash('sha256').update(data).digest('hex')
const fixtures = new Map()
export function verifyRun(run) {
  const units = run.fixture.utf16_units
  if (!fixtures.has(units)) fixtures.set(units, corpus(units))
  const fixture = fixtures.get(units)
  const { markdown, ...metadata } = fixture
  assert.deepEqual(run.fixture, metadata, 'corpus metadata differs')
  assert(['rich', 'minimal'].includes(run.mode), 'unknown editor mode')
  assert(Number.isSafeInteger(run.warmup) && run.warmup >= 0)
  assert(Number.isSafeInteger(run.samples) && run.samples > 0)
  assert.equal(run.raw.length, run.samples, 'sample count differs')
  for (const metric of ['synchronous_dispatch_ms', 'dispatch_to_raf_opportunity_ms']) {
    const samples = run.raw.map(sample => sample[metric])
    assert(samples.every(n => Number.isFinite(n) && n >= 0), 'invalid sample')
    assert.deepEqual(run[metric], quantiles(samples), 'reported quantiles differ')
  }
  let expected = markdown, growth = 0
  for (let i = 0; i < run.warmup + run.samples; i++) {
    const input = fixture.input_sequence[i % fixture.input_sequence.length]
    const marker = fixture.markers[i % fixture.markers.length]
    expected = expected.replace(marker, input + marker)
    growth += input.length
  }
  assert.deepEqual(run.correctness, { exact_text: true, text_growth: growth, expected_growth: growth, markers_intact: true })
  assert.equal(run.final_text_sha256, sha(expected), 'independent final-text replay differs')
  assert(run.mode === 'minimal' ? run.plugin_count === 0 : run.plugin_count > 2, 'incorrect editor plugin set')
  return run.warmup === 1000 && run.samples === 100
}

export function summarizeRuns(reports) {
  const unique = new Map()
  let duplicateCopies = 0
  for (const report of reports) for (const run of report.programmatic) {
    const key = sha(JSON.stringify(run))
    if (unique.has(key)) duplicateCopies++
    else unique.set(key, run)
  }
  const groups = new Map(), excluded = []
  for (const run of unique.values()) {
    if (!verifyRun(run)) {
      excluded.push({ mode: run.mode, utf16: run.fixture.utf16_units, warmup: run.warmup, samples: run.samples })
      continue
    }
    const key = `${run.mode}:${run.fixture.utf16_units}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(run)
  }
  const rows = [...groups].map(([key, runs]) => ({
    key, formal_repeats: runs.length,
    exactly_five_repeats: runs.length === 5 && runs.map(r => r.repeat).sort().join(',') === '0,1,2,3,4',
    corpus_sha256: runs[0].fixture.sha256,
    synchronous_dispatch_ms: quantiles(runs.flatMap(r => r.raw.map(s => s.synchronous_dispatch_ms))),
    dispatch_to_raf_opportunity_ms: quantiles(runs.flatMap(r => r.raw.map(s => s.dispatch_to_raf_opportunity_ms))),
    per_repeat: runs.map(r => ({ repeat: r.repeat, mount_ms: r.mount_ms, synchronous_p95_ms: r.synchronous_dispatch_ms.p95, raf_opportunity_p95_ms: r.dispatch_to_raf_opportunity_ms.p95, final_text_sha256: r.final_text_sha256 })),
    exact_text_independently_replayed: true,
  }))
  return { duplicate_cumulative_copies_ignored: duplicateCopies, excluded_nonstandard_runs: excluded, groups: rows,
    complete_normal_matrix: ['rich:10000', 'rich:100000', 'minimal:10000', 'minimal:100000'].every(key => rows.some(row => row.key === key && row.exactly_five_repeats)),
    physical_input_to_frame_gate: 'NOT_MEASURED',
    scope: 'Programmatic dispatch and next rAF opportunity only. rAF is not paint/presentation. No disk/network persistence or physical keyboard latency measured.' }
}

async function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const directory = path.resolve(process.argv[2] ?? path.join(repo, 'tasks/sumi-native/host-acceptance/vault/inbox/sumi-benchmark-results'))
  const web = path.resolve(process.argv[3] ?? path.join(repo, 'tasks/sumi-native/host-acceptance/seed/plugins/notemd.sumi/current/ui/benchmark'))
  const files = (await readdir(directory)).filter(name => /^web-.*\.json$/.test(name)).sort()
  assert(files.length, 'no reports found')
  const reports = [], evidence = [], checkedBuilds = new Set()
  const fontManifest = JSON.parse(await readFile(path.join(repo, 'src-tauri/resources/sumi/manifest.json'), 'utf8'))
  for (const file of files) {
    const bytes = await readFile(path.join(directory, file)), report = JSON.parse(bytes)
    assert.equal(report.schema, 1)
    assert.equal(report.physical_input_to_frame_ms, null, 'proxy result must not claim physical input latency')
    assert.deepEqual(report.viewport, { width: 900, height: 650, font_size: 22, line_height: 1.6 })
    assert.deepEqual(report.fonts, fontManifest, 'font manifest differs')
    const buildKey = sha(JSON.stringify(report.build))
    if (!checkedBuilds.has(buildKey)) {
      for (const [relative, digest] of Object.entries(report.build.sources)) {
        assert.equal(sha(await readFile(path.join(repo, relative))), digest, `source changed: ${relative}`)
      }
      for (const [relative, digest] of Object.entries(report.build.artifacts)) {
        assert.equal(sha(await readFile(path.join(web, relative))), digest, `installed artifact changed: ${relative}`)
      }
      for (const asset of report.fonts.assets) {
        assert.equal(sha(await readFile(path.join(web, 'fonts', asset.file))), asset.sha256, `font/license changed: ${asset.file}`)
      }
      checkedBuilds.add(buildKey)
    }
    reports.push(report)
    evidence.push({ file, sha256: sha(bytes), build_identity_sha256: buildKey, build_base_commit: report.build.git_head, source_artifact_font_hashes_match: true, machine: report.build.machine, user_agent: report.user_agent, screen: report.screen })
  }
  assert.equal(checkedBuilds.size, 1, 'mixed benchmark builds must be reported separately')
  console.log(JSON.stringify({ evidence, ...summarizeRuns(reports) }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
