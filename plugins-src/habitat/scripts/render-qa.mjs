#!/usr/bin/env node
// Isolated browser harness: the injected QA endpoints are never part of the plugin build.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { loadSnapshot } from './preview.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const snapshotPath = value('--snapshot')
if (!snapshotPath) throw new Error('Usage: node scripts/render-qa.mjs --snapshot /path/current.jsonl [--output /path/qa] [--hardware]')
const hardware = args.includes('--hardware')
const output = resolve(value('--output', resolve(root, '../../tasks/design/habitat-render-qa')))
await mkdir(output, { recursive: true })
const snapshot = await loadSnapshot(resolve(snapshotPath))
const data = JSON.stringify({ nodes: snapshot.nodes, layout: snapshot.layout, edges: snapshot.edges })
const harness = `
import { CityScene } from '/src/lib/city-scene.ts';
const data = await (await fetch('/__qa/data')).json();
const subsetNodes = data.nodes.filter((node, index) => index < 480 || ['hemory', 'note.md', 'bushcraft'].includes(node.label.toLowerCase()));
const subsetIds = new Set(subsetNodes.map(node => node.id));
const subset = { nodes: subsetNodes, layout: data.layout.filter(item => subsetIds.has(item.id)), edges: data.edges.filter(edge => edge.participants.every(item => subsetIds.has(item.node))) };
let scene, status, firstReadyMs, selections = [];
const canvas = document.querySelector('canvas');
function create() {
  canvas.dataset.ready = 'false';
  scene = new CityScene(canvas, value => { status = value; if (firstReadyMs === undefined && canvas.dataset.ready === 'true') firstReadyMs = performance.now() }, id => { selections.push(id); scene.setSelected(id, new Set()) });
  scene.resize(innerWidth, innerHeight); scene.setDark(false); scene.setData(data, true);
}
function ready() { canvas.dataset.ready = 'false' }
window.__cityQA = {
  get status() { return status }, get selections() { return selections },
  get nodeCount() { return data.nodes.length },
  get subsetCount() { return subsetNodes.length },
  get firstReadyMs() { return firstReadyMs },
  get ordinaryId() { return data.nodes.find(node => node.nodeType === 'concept' && node.status === 'observed' && data.layout.some(layout => layout.id === node.id))?.id },
  rebuild() { ready(); scene.setData(data, false) },
  subset() { ready(); scene.setData(subset, true) },
  restore() { ready(); scene.setData(data, true) },
  highlightAll() { ready(); scene.setSelected('', new Set(data.nodes.map(node => node.id))) },
  clearSelection() { ready(); scene.setSelected('', new Set()) },
  select(id) { ready(); scene.setSelected(id, new Set([id])) },
  focus(id) { ready(); scene.focus(id) },
  dark(value) { ready(); scene.setDark(value) },
  resize() { ready(); scene.resize(innerWidth, innerHeight) },
  rotate() { ready(); scene.rotate() },
  zoom() { ready(); scene.zoom(1.3) },
  fit() { ready(); scene.fit() },
  dispose() { scene.dispose(); canvas.dataset.ready = 'disposed' },
  create,
};
create();
`
const vite = await createServer({
  root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{ name: 'isolated-city-qa', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = request.url?.split('?')[0]
      const content = path === '/__qa/' ? ['text/html', '<!doctype html><html><head><meta charset="utf-8"><base href="/"><link rel="icon" href="data:,"><style>html,body{margin:0;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style></head><body><canvas></canvas><script type="module" src="/__qa/harness.js"></script></body></html>']
        : path === '/__qa/harness.js' ? ['application/javascript', harness]
        : path === '/__qa/data' ? ['application/json', data] : null
      if (!content) return next()
      response.setHeader('Content-Type', content[0]); response.setHeader('Cache-Control', 'no-store'); response.end(content[1])
    })
  } }],
})
let browser
const report = { startedAt: new Date().toISOString(), requestedRenderer: hardware ? 'hardware' : 'swiftshader', snapshotId: snapshot.meta.snapshotId, nodes: snapshot.nodes.length, checks: [], rotations: [], rebuilds: [], errors: [], warnings: [], externalRequests: [], failedRequests: [], screenshots: [] }
const save = () => writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
try {
  await vite.listen()
  const address = vite.httpServer.address(), origin = `http://127.0.0.1:${address.port}`
  const playwrightModule = value('--playwright', process.env.PLAYWRIGHT_MODULE)
  const { chromium } = await import(playwrightModule ? pathToFileURL(resolve(playwrightModule)).href : 'playwright').catch(() => { throw new Error('Playwright is required for browser QA; pass --playwright /absolute/path/to/playwright/index.mjs or set PLAYWRIGHT_MODULE.') })
  browser = await chromium.launch({ executablePath: value('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), headless: true, args: hardware ? ['--enable-webgl'] : ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => report.errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); if (message.type() === 'warning') report.warnings.push(message.text()) })
  page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
  // Observe without interception: Playwright function/regexp route matchers turn
  // on a global Fetch interception that can cancel already-consumed GLB streams.
  // Any external request fails this QA run; local traffic uses native browser fetch.
  page.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) report.externalRequests.push(url.href)
  })
  const ready = async () => {
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.ready === 'true' || window.__cityQA?.status?.error, null, { timeout: 120000 })
    const error = await page.evaluate(() => window.__cityQA.status?.error)
    assert.equal(error, undefined)
  }
  const metrics = () => page.evaluate(() => ({ ...document.querySelector('canvas').dataset }))
  const screenshot = async name => { await page.screenshot({ path: resolve(output, `${name}.png`) }); report.screenshots.push(`${name}.png`) }
  const action = async (name, argument) => { await page.evaluate(([name, argument]) => window.__cityQA[name](argument), [name, argument]); await ready() }
  await page.goto(origin + '/__qa/', { waitUntil: 'networkidle', timeout: 120000 }); await ready()
  report.firstFrame = await metrics()
  report.firstReadyMs = await page.evaluate(() => window.__cityQA.firstReadyMs)
  report.renderer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    const extension = gl.getExtension('WEBGL_debug_renderer_info')
    return { vendor: gl.getParameter(extension?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR), renderer: gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER), version: gl.getParameter(gl.VERSION) }
  })
  report.hardwareConfirmed = !/swiftshader|llvmpipe|software|softpipe/i.test(report.renderer.renderer) && /apple|nvidia|radeon|intel|adreno|mali/i.test(report.renderer.renderer)
  if (hardware) assert.ok(report.hardwareConfirmed, `hardware requested but renderer is ${report.renderer.renderer}`)
  console.log(`City QA renderer: ${report.renderer.renderer}; first ready ${report.firstReadyMs.toFixed(1)} ms`)
  await screenshot('overview')
  const initialLabels = await page.evaluate(() => window.__cityQA.status.labels)
  for (let index = 0; index < 8; index++) { await action('rotate'); report.rotations.push(await metrics()) }
  const submissions = report.rotations.map(sample => Number(sample.renderMs)).sort((a, b) => a - b)
  report.submissionTiming = { firstRenderMs: Number(report.firstFrame.renderMs), warmedRotationMinMs: submissions[0], warmedRotationMedianMs: (submissions[3] + submissions[4]) / 2, warmedRotationMaxMs: submissions[7] }
  report.timingNote = 'firstReadyMs is browser navigation to the first ready callback (includes dev-module loading, snapshot, assets and scene build). renderMs is CPU-side JavaScript renderer.render submission duration, not GPU frame duration or FPS. Rotation samples are eight successive 45-degree turns. firstRenderMs is the first renderer.render call in this browser context and includes required shader compilation/resource upload; OS/driver shader caches may already be warm, so this is not a guaranteed cold-driver-cache measurement.'
  // WebGL uploads culled geometries lazily. Warm every direction, then rebuild at
  // the original camera pose before comparing identical rebuilds for leaks.
  await action('rebuild'); report.baseline = await metrics()
  assert.equal(Number(report.baseline.districtLabels), Number(report.baseline.parcels), 'every overview parcel has a visible marker')
  const labelIds = await page.evaluate(() => window.__cityQA.status.labels.map(label => label.id))
  assert.equal(new Set(labelIds).size, labelIds.length, 'district and selected labels have unique identities')
  assert.ok(Number(report.baseline.models) > 100, 'real snapshot should render a populated city')
  assert.ok(Number(report.baseline.triangles) > 100000, 'real GLB geometry should be present')
  assert.equal(await page.evaluate(() => window.__cityQA.status.count), snapshot.nodes.length)
  for (let index = 0; index < 20; index++) {
    await action('rebuild'); const sample = await metrics(); report.rebuilds.push(sample)
    assert.equal(sample.geometries, report.baseline.geometries, `GPU geometry count grew at rebuild ${index + 1}`)
    assert.equal(sample.textures, report.baseline.textures, `GPU texture count grew at rebuild ${index + 1}`)
    if ((index + 1) % 5 === 0) console.log(`City QA: ${index + 1}/20 rebuilds stable (${sample.geometries} geometries, ${sample.textures} textures)`)
  }
  report.checks.push('20 real-snapshot rebuilds keep GPU geometry/texture counts stable')
  report.historyHighlights = []
  for (let index = 0; index < 5; index++) {
    await action('highlightAll'); const sample = await metrics(); report.historyHighlights.push(sample)
    assert.ok(Number(sample.drawCalls) - Number(report.baseline.drawCalls) <= 2, 'all-node history rings should be batched')
    assert.equal(sample.geometries, report.historyHighlights[0].geometries)
    assert.equal(sample.textures, report.baseline.textures)
  }
  await screenshot('history-all-changed'); await action('clearSelection')
  assert.equal((await metrics()).geometries, report.baseline.geometries)
  report.checks.push('all 32K changed IDs use batched rings, repeated highlighting remains stable and clearing releases rings')
  report.subsetRestores = []
  for (let index = 0; index < 5; index++) {
    await action('subset')
    assert.equal(await page.evaluate(() => window.__cityQA.status.count), await page.evaluate(() => window.__cityQA.subsetCount))
    const subset = await metrics()
    if (!index) await screenshot('subset')
    await action('restore'); const restored = await metrics()
    assert.equal(await page.evaluate(() => window.__cityQA.status.count), snapshot.nodes.length)
    assert.equal(restored.geometries, report.baseline.geometries, 'restoring original full data must restore the same geometry count')
    assert.equal(restored.textures, report.baseline.textures, 'restoring original full data must restore the same texture count')
    assert.deepEqual(await page.evaluate(() => window.__cityQA.status.labels.map(label => label.id).sort()), initialLabels.map(label => label.id).sort(), 'landmark identities must survive subset/full transitions')
    report.subsetRestores.push({ subset, restored })
  }
  report.checks.push('five subset/full-data transitions restore all nodes, label identities and GPU resource counts')
  const hero = await page.evaluate(() => window.__cityQA.status.labels.find(label => label.name.toLowerCase() === 'hemory') ?? window.__cityQA.status.labels[0])
  assert.ok(hero, 'city should expose a selectable label')
  await action('select', hero.id); await action('focus', hero.id)
  assert.ok(await page.evaluate(id => window.__cityQA.status.labels.some(label => label.id === id && label.selected), hero.id))
  assert.equal((await metrics()).ready, 'true')
  await screenshot('focus')
  // Focused campuses have an open courtyard; sample neighboring visible building pixels.
  let picked = false
  for (const [dx, dy] of [[-70, 0], [70, 0], [0, -70], [0, 70], [-110, -50], [110, -50], [-50, 110], [50, 110], [0, 0]]) {
    await page.mouse.click(720 + dx, 500 + dy)
    picked = await page.evaluate(id => window.__cityQA.selections.includes(id), hero.id)
    if (picked) break
  }
  assert.ok(picked, 'mouse picking should select the focused knowledge ID')
  report.checks.push('selection labels, focus and actual mouse picking preserve knowledge ID')
  for (const [name, screenshotName] of [['note.md', 'note-campus'], ['bushcraft', 'camp']]) {
    const target = initialLabels.find(label => label.name.toLowerCase() === name)
    assert.ok(target, `missing ${name} landmark in real snapshot`)
    await action('fit'); await action('select', target.id); await action('focus', target.id); await screenshot(screenshotName)
  }
  const ordinary = initialLabels.find(label => !['hemory', 'note.md', 'bushcraft'].includes(label.name.toLowerCase()))?.id ?? await page.evaluate(() => window.__cityQA.ordinaryId)
  assert.ok(ordinary, 'real snapshot should contain an ordinary neighborhood')
  await action('fit'); await action('select', ordinary); await action('focus', ordinary); await screenshot('neighborhood')
  report.checks.push('note.md campus, Bushcraft camp and ordinary neighborhood close-up screenshots')
  await action('rotate'); await action('zoom'); await action('dark', true); await screenshot('dark')
  await page.setViewportSize({ width: 780, height: 900 }); await action('resize'); await screenshot('narrow')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 780)
  report.checks.push('rotate, zoom, dark theme and narrow resize render successfully')
  await action('dark', false); await action('fit')
  await page.evaluate(() => window.__cityQA.dispose())
  assert.equal((await metrics()).ready, 'disposed')
  await page.mouse.move(250, 250); await page.mouse.click(250, 250)
  assert.equal((await metrics()).ready, 'disposed', 'disposed scene should not schedule event renders')
  await page.setViewportSize({ width: 1440, height: 1000 }); await action('create')
  report.recreated = await metrics()
  assert.equal(report.recreated.geometries, report.firstFrame.geometries)
  assert.equal(report.recreated.textures, report.firstFrame.textures)
  await screenshot('recreated')
  report.checks.push('dispose removes interaction handlers; fresh scene recreates with same resource counts')
  assert.deepEqual(report.externalRequests, [])
  assert.deepEqual(report.failedRequests, [])
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.warnings, [])
  report.checks.push('all resources load locally with no browser errors, warnings or failed requests')
  report.passed = true
  console.log(`City QA passed: ${report.checks.length} checks, evidence in ${output}`)
} catch (error) {
  report.passed = false; report.failure = String(error); throw error
} finally {
  report.finishedAt = new Date().toISOString(); await save()
  await browser?.close(); await vite.close()
}
