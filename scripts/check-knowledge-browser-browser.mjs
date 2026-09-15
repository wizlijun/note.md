#!/usr/bin/env node
// Production Knowledge Browser bundle + real host FilePluginView/CSP on two origins.
// Uses only synthetic fixtures from plugins-src/knowledge-browser/fixtures.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(join(tmpdir(), 'notemd-knowledge-browser-'))
const buildRoot = join(root, 'plugins-src/knowledge-browser/dist')
const productionRoot = join(output, 'plugin')
const protocolRoot = join(output, 'protocol-source')
const fixtureRoot = join(root, 'plugins-src/knowledge-browser/fixtures')
const valid = await readFile(join(fixtureRoot, 'minimal-valid.json'), 'utf8')
const transcript = await readFile(join(fixtureRoot, 'release-transcript.md'), 'utf8')
const calls = []
const results = []
const servers = []
const errors = []
const requestedAssets = new Set()
let pluginOrigin = ''
let delayNextWorker = false
let browser

function command(program, args, cwd, env = {}) {
  const result = spawnSync(program, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${program} failed:\n${result.stdout}\n${result.stderr}`)
}

async function check(name, run) {
  await run()
  results.push({ name, status: 'passed' })
  console.log('PASS', name)
}

command('pnpm', ['--filter', 'knowledge-browser', 'build'], root)
await cp(buildRoot, productionRoot, { recursive: true })
// The reusable Rust exporter probes /index.html. This plugin intentionally has
// browser.html + viewer.html, so give the exporter a temporary viewer alias,
// then derive both served documents from its bridge-injected output.
await cp(buildRoot, protocolRoot, { recursive: true })
await writeFile(join(protocolRoot, 'index.html'), await readFile(join(buildRoot, 'viewer.html')))
command('cargo', ['test', '--lib', 'plugin_runtime::protocol::tests::export_webkit_protocol_fixture', '--', '--exact'], join(root, 'src-tauri'), {
  NOTEMD_WEBKIT_PLUGIN_ID: 'notemd.knowledge-browser',
  NOTEMD_WEBKIT_PLUGIN_ROOT: protocolRoot,
  NOTEMD_WEBKIT_PROTOCOL_FIXTURE: productionRoot,
})
const csp = await readFile(join(productionRoot, 'plugin-csp.txt'), 'utf8')
const injectedViewer = await readFile(join(productionRoot, 'index.html'), 'utf8')
await writeFile(join(productionRoot, 'viewer.html'), injectedViewer)
await writeFile(join(productionRoot, 'browser.html'), injectedViewer
  .replace('<title>Extracted Knowledge</title>', '<title>Knowledge Browser</title>')
  .replace('data-entry="viewer"', 'data-entry="browser"'))

// Production artifact audit is deliberately independent of the browser fixture.
const assetNames = await readdir(join(buildRoot, 'assets'))
const workerAsset = assetNames.find(name => /^dataset\.worker-[\w-]+\.js$/.test(name))
assert.ok(workerAsset, 'production bundle must contain the dataset Worker')
const javascript = (await Promise.all(assetNames.filter(name => name.endsWith('.js')).map(name => readFile(join(buildRoot, 'assets', name), 'utf8')))).join('\n')
assert.doesNotMatch(javascript, /\beval\s*\(/, 'production bundle must not use eval')
assert.doesNotMatch(javascript, /\bnew\s+Function\s*\(/, 'production bundle must not use new Function')
assert.doesNotMatch(javascript, /\bfetch\s*\(\s*['"`]https?:/i, 'production bundle must not fetch a remote URL')

async function rpc(req, res) {
  let id = null
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    id = request.id
    const { method, params } = request
    calls.push(structuredClone(request))
    let value
    if (method === 'host.vault.info') value = { root: '/fixture-vault', wiki_dir: 'wiki', daily_dir: 'diary' }
    else if (method === 'host.vault.list') {
      assert.equal(params.path, 'research')
      value = { entries: [{ name: 'release.knowledge.json', is_dir: false }, { name: 'ordinary.json', is_dir: false }] }
    } else if (method === 'host.vault.read') {
      if (params.path === 'research/release.knowledge.json') value = { content: valid }
      else if (params.path === 'fixtures/release-transcript.md') value = { content: transcript }
      else throw new Error(`Missing synthetic Vault file: ${params.path}`)
    } else if (method === 'host.vault.read_bytes') {
      if (params.path !== 'fixtures/release-transcript.md') throw new Error(`Missing synthetic Vault bytes: ${params.path}`)
      value = { base64: Buffer.from(transcript).toString('base64') }
    } else if (method === 'host.vault.exists') value = { exists: true }
    else if (method === 'host.dialog.open') value = { paths: ['/fixture-selected/manual.json'] }
    else if (method === 'host.fs.read_text') value = { content: valid }
    else if (method === 'host.editor.open' || method === 'host.clipboard.write' || method === 'host.settings.set') value = { ok: true }
    else if (method === 'host.settings.get') value = { settings: {} }
    else throw new Error(`Unexpected fixture RPC: ${method}`)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: value }))
  } catch (error) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error) } }))
  }
}

async function fixtureServer(kind) {
  const server = await createServer({
    root,
    configFile: false,
    cacheDir: join(output, `vite-${kind}`),
    resolve: { dedupe: ['svelte'] },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [{
      name: `knowledge-browser-${kind}`,
      enforce: 'pre',
      transform(code, id) {
        if (kind === 'host' && id.endsWith('/src/components/FilePluginView.svelte')) {
          assert.ok(code.includes('`plugin://${view.pluginId}`'))
          return code.replace('`plugin://${view.pluginId}`', JSON.stringify(pluginOrigin))
        }
      },
      configureServer(vite) {
        vite.middlewares.use('/__rpc__', rpc)
        if (kind === 'plugin') {
          vite.middlewares.use(async (req, res, next) => {
            const pathname = new URL(req.url ?? '/', 'http://fixture').pathname
            if (!['/browser.html', '/viewer.html', '/__notemd_bridge__.js'].includes(pathname)
              && !/^\/assets\/[\w.-]+\.(?:js|css)$/.test(pathname)) { next(); return }
            requestedAssets.add(pathname)
            if (delayNextWorker && pathname.includes('dataset.worker-')) {
              delayNextWorker = false
              await new Promise(resolveDelay => setTimeout(resolveDelay, 300))
            }
            const file = join(productionRoot, pathname.slice(1))
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Content-Type', pathname.endsWith('.html') ? 'text/html; charset=utf-8' : pathname.endsWith('.css') ? 'text/css' : 'text/javascript')
            if (pathname.endsWith('.html')) res.setHeader('Content-Security-Policy', csp)
            res.end(await readFile(file))
          })
        } else {
          vite.middlewares.use('/knowledge-host', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(await vite.transformIndexHtml('/knowledge-host', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="fixture"></div><script type="module">import {mount} from "svelte";import App from "/scripts/fixtures/knowledge-browser-browser.svelte";mount(App,{target:document.getElementById("fixture")});</script></body></html>'))
          })
        }
      },
    }, svelte()],
  })
  servers.push(server)
  await server.listen()
  return `http://127.0.0.1:${server.httpServer.address().port}`
}

try {
  pluginOrigin = await fixtureServer('plugin')
  const hostOrigin = await fixtureServer('host')
  assert.notEqual(pluginOrigin, hostOrigin)
  const { chromium } = process.env.PLAYWRIGHT_MODULE
    ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href) : await import('playwright')
  browser = await chromium.launch({
    headless: process.env.KNOWLEDGE_BROWSER_HEADED !== '1',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(`host: ${String(error)}`))
  const plugin = () => page.frameLocator('iframe[data-plugin-view-id="notemd.knowledge-browser"]')
  const ready = async () => page.locator('.file-plugin-view[aria-busy="false"]').waitFor()

  await page.goto(`${hostOrigin}/knowledge-host`)
  await check('valid fixture completes the real file_view.ready handshake without changing source bytes', async () => {
    await ready()
    await plugin().getByRole('heading', { name: '提取知识浏览器', exact: true }).waitFor()
    const viewTabs = page.getByRole('tab')
    assert.equal(await viewTabs.count(), 3)
    assert.deepEqual(await viewTabs.evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-selected'))), ['false', 'false', 'true'])
    assert.equal(await plugin().locator('.topbar > .dataset-actions').count(), 1)
    assert.equal(await plugin().getByRole('button', { name: '编辑 JSON 原文', exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => window.__knowledgeBrowser.content), valid)
    assert.equal(await page.evaluate(() => window.__knowledgeBrowser.initial), valid)
    assert.match(await plugin().locator('.statusbar').textContent(), /ready/)
    await viewTabs.nth(1).click()
    const source = page.getByRole('textbox', { name: 'JSON 源码', exact: true })
    await source.waitFor()
    assert.equal(await source.inputValue(), valid)
    await viewTabs.nth(2).click()
    await ready()
    await plugin().getByRole('heading', { name: '提取知识浏览器', exact: true }).waitFor()
  })

  await check('forged origin and stale requestId cannot complete a pending host view; the production Worker does', async () => {
    const large = `${valid}${' '.repeat(1_100_000)}`
    delayNextWorker = true
    await page.evaluate(content => window.__knowledgeBrowser.reload(content), large)
    await page.locator('.file-plugin-view[aria-busy="true"]').waitFor()
    const remainedBusy = await page.evaluate(({ pluginOrigin }) => {
      window.__knowledgeBrowser.forgeHostReply(pluginOrigin, 999_999)
      window.__knowledgeBrowser.forgeHostReply('https://evil.example', 2)
      return document.querySelector('.file-plugin-view')?.getAttribute('aria-busy')
    }, { pluginOrigin })
    assert.equal(remainedBusy, 'true')
    await ready()
    assert.equal(await page.evaluate(() => window.__knowledgeBrowser.content), large)
    assert.ok(requestedAssets.has(`/assets/${workerAsset}`), `Worker asset was not requested: ${workerAsset}`)
  })

  await check('invalid JSON falls back to the exact host editor bytes and a valid reload recovers', async () => {
    const broken = '{"schema":"knowledge-representation-dataset/3.0.0", broken'
    await page.evaluate(content => window.__knowledgeBrowser.reload(content), broken)
    const fallback = page.getByRole('textbox', { name: 'JSON 编辑器', exact: true })
    await fallback.waitFor()
    assert.equal(await fallback.inputValue(), broken)
    assert.equal(await page.evaluate(() => window.__knowledgeBrowser.content), broken)
    const ordinary = '{"name":"ordinary"}'
    await page.evaluate(content => window.__knowledgeBrowser.reload(content), ordinary)
    await fallback.waitFor()
    assert.equal(await fallback.inputValue(), ordinary)
    await page.evaluate(content => window.__knowledgeBrowser.reload(content), valid)
    await ready()
  })

  await check('reading, relation, time and diagnostics surfaces are reachable from the production view', async () => {
    await plugin().getByRole('button', { name: '阅读', exact: true }).click()
    await plugin().getByRole('region', { name: '知识详情' }).waitFor()
    await plugin().locator('select').nth(0).selectOption('relations')
    await plugin().locator('[data-record-button]').filter({ hasText: 'r1' }).click()
    await plugin().getByRole('button', { name: '关系', exact: true }).click()
    await plugin().getByRole('heading', { name: '局部关系', exact: true }).waitFor()
    assert.ok(await plugin().getByRole('button', { name: /关系 r1/ }).count())
    await plugin().getByRole('button', { name: '时间', exact: true }).click()
    await plugin().getByLabel('时间维度').selectOption('system')
    await plugin().getByRole('heading', { name: '时间阅读', exact: true }).waitFor()
    await plugin().getByText('2026-09-15T10:00:00Z', { exact: true }).waitFor()
    await plugin().getByRole('button', { name: '诊断', exact: true }).click()
    await plugin().getByRole('heading', { name: '数据诊断', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__knowledgeBrowser.content), valid)
  })

  await check('320, 768 and 1280 pixel layouts have no outer horizontal overflow', async () => {
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      const overflow = await plugin().locator('body').evaluate(body => Math.max(body.scrollWidth, document.documentElement.scrollWidth) - innerWidth)
      assert.ok(overflow <= 1, `${width}px plugin overflow: ${overflow}`)
      const hostOverflow = await page.locator('body').evaluate(body => Math.max(body.scrollWidth, document.documentElement.scrollWidth) - innerWidth)
      assert.ok(hostOverflow <= 1, `${width}px host overflow: ${hostOverflow}`)
      await page.screenshot({ path: join(output, `viewer-${width}.png`) })
    }
  })

  await check('browser.html scans and loads a Vault dataset through its standalone entry', async () => {
    const standalone = await context.newPage()
    standalone.on('pageerror', error => errors.push(`browser: ${String(error)}`))
    await standalone.goto(`${pluginOrigin}/browser.html`)
    const select = standalone.getByLabel('数据集')
    await select.locator('option[value="research/release.knowledge.json"]').waitFor({ state: 'attached' })
    await select.selectOption('research/release.knowledge.json')
    await standalone.getByText('合成发布流程阅读测试', { exact: true }).waitFor()
    await standalone.getByRole('heading', { name: '提取知识浏览器', exact: true }).waitFor()
    assert.ok(calls.some(call => call.method === 'host.vault.list' && call.params.path === 'research'))
    assert.ok(calls.some(call => call.method === 'host.vault.read' && call.params.path === 'research/release.knowledge.json'))
    await standalone.screenshot({ path: join(output, 'browser-standalone.png') })
    await standalone.close()
  })

  assert.deepEqual(errors, [])
  const report = {
    output,
    browser: browser.version(),
    results,
    workerAsset,
    csp,
    boundaries: 'Production Knowledge Browser bundle and Worker; real host FilePluginView/ModeToggle; Rust-injected bridge and CSP; isolated synthetic Vault RPC.',
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(error.stack ?? error)
  console.error('Browser errors:', errors)
  process.exitCode = 1
} finally {
  await browser?.close()
  await Promise.all(servers.map(server => server.close()))
}
