/** Run: node src/lib/terrain.benchmark.mjs [report.json]
 * Uses the actual module Worker entry with a Node worker_threads transport adapter.
 * This measures CPU, structured-clone overhead and the isolate's memory, not WebKit/GPU.
 */
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.resolve('vite'))
const { build } = require('esbuild')
const directory = await mkdtemp(join(tmpdir(), 'strata-bench-'))
const workerPath = join(directory, 'worker.mjs')
await build({
  stdin: { contents: `
    import { parentPort } from 'node:worker_threads';
    import v8 from 'node:v8';
    import process from 'node:process';
    globalThis.self = { onmessage: null, postMessage(message, transfer) {
      const memory = process.memoryUsage();
      parentPort.postMessage({ ...message, benchmark: { memory, heap: v8.getHeapStatistics() } }, transfer);
    }};
    await import('./terrain.worker.ts');
    parentPort.on('message', data => globalThis.self.onmessage({ data }));
  `, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: workerPath,
})

const count = 32_000, width = 768, height = 512
const nodes = Array.from({ length: count }, (_, i) => ({
  id: `n${String(i).padStart(5, '0')}`, title: `知识 ${i}`,
  features: [`domain${i % 37}`, `topic${i % 211}`, `concept${i % 503}`, `unique${i}`],
  sourceGroups: [{ groupId: `g${Math.floor(i / 4)}`, groupVersion: '1', priority: 1 + i % 4,
    dates: [`2026-09-${String(1 + i % 30).padStart(2, '0')}`] }],
}))
const worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: 128 } })
const samples = []
let retainedResult
try {
  const request = (message) => new Promise((resolve, reject) => {
    const onError = error => { worker.off('message', onMessage); reject(error) }
    const onMessage = result => { worker.off('error', onError); result.error ? reject(new Error(result.error)) : resolve(result) }
    worker.once('message', onMessage); worker.once('error', onError); worker.postMessage(message)
  })
  for (let i = 0; i < 9; i++) {
    const started = performance.now()
    const response = await request({ id: i + 1, action: i ? 'render' : 'build',
      ...(i ? {} : { nodes, epoch: 'benchmark-module-worker/v1' }),
      selection: { from: `2026-09-${String(1 + i * 2).padStart(2, '0')}`, to: '2026-09-30' },
      options: { width, height, contourStep: 3 } })
    retainedResult = response.result
    samples.push({ id: i, roundTripMs: performance.now() - started, ...response.result.stats,
      atlasMs: response.result.layout?.diagnostics.elapsedMs,
      workerHeapUsed: response.benchmark.memory.heapUsed,
      workerExternal: response.benchmark.memory.external,
      workerArrayBuffers: response.benchmark.memory.arrayBuffers,
      processRss: response.benchmark.memory.rss })
  }
  const sorted = samples.slice(1).map(sample => sample.roundTripMs).sort((a, b) => a - b)
  const result = {
    measuredAt: new Date().toISOString(), runtime: process.version, platform: process.platform, architecture: process.arch,
    nodes: count, grid: [width, height], contourStep: 3, workerOldGenerationLimitMiB: 128,
    memoryScope: 'workerHeapUsed/external describe the actual Worker isolate; processRss includes parent and Worker. This is Node, not WebKit/GPU.',
    warmRoundTripP95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
    maxObservedWorkerHeapAndExternalBytes: Math.max(...samples.map(sample => sample.workerHeapUsed + sample.workerExternal)),
    samples,
    lastContourCount: retainedResult.contours.length,
  }
  const json = JSON.stringify(result, null, 2)
  if (process.argv[2]) await writeFile(process.argv[2], json + '\n')
  console.log(json)
} finally {
  await worker.terminate()
  await rm(directory, { recursive: true, force: true })
}
