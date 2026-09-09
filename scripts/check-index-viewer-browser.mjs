#!/usr/bin/env node
// Isolated production UI + real host view/bridge/CSP. Uses only synthetic assets.
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(join(tmpdir(), 'notemd-index-viewer-'))
console.log('Artifacts:', output)
const pluginRoot = join(root, 'plugins-src/index-viewer/dist')
const servedRoot = join(output, 'plugin')
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`)
}
run('pnpm', ['--filter', 'index-viewer', 'build'], root)
await cp(pluginRoot, servedRoot, { recursive: true })
run('cargo', ['test', '--lib', 'plugin_runtime::protocol::tests::export_webkit_protocol_fixture', '--', '--exact'], join(root, 'src-tauri'), {
  NOTEMD_WEBKIT_PLUGIN_ID: 'notemd.index-viewer', NOTEMD_WEBKIT_PLUGIN_ROOT: pluginRoot, NOTEMD_WEBKIT_PROTOCOL_FIXTURE: servedRoot,
})
const csp = await readFile(join(servedRoot, 'plugin-csp.txt'), 'utf8')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright')
const calls = [], results = [], errors = [], servers = []
let pluginOrigin = '', browser
const coverPaths = new Set(['assets/covers/blue-book.png', 'assets/covers/green-book.png'])
let missingFiles = false
async function serve(kind) {
  const server = await createServer({ root, configFile: false, cacheDir: join(output, `vite-${kind}`),
    resolve: { dedupe: ['svelte'] }, optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [{ name: `index-fixture-${kind}`, enforce: 'pre',
      transform(code, id) {
        if (kind === 'host' && id.endsWith('/src/components/FilePluginView.svelte')) {
          assert.ok(code.includes('`plugin://${view.pluginId}`'))
          return code.replace('`plugin://${view.pluginId}`', JSON.stringify(pluginOrigin))
        }
      },
      configureServer(vite) {
        vite.middlewares.use('/__rpc__', async (req, res) => {
          let id = null
          try {
            let body = ''; for await (const chunk of req) body += chunk
            const request = JSON.parse(body); id = request.id; calls.push(request)
            const { method, params } = request
            let value
            if (method === 'host.vault.info') value = { root: '/fixture-vault' }
            else if (method === 'host.editor.open') {
              if (missingFiles) throw new Error('File does not exist')
              value = { ok: true }
            } else if (method === 'host.vault.read_bytes') {
              if (!coverPaths.has(params.path)) throw new Error('Cover unavailable')
              value = { base64: (await readFile(join(root, 'skills/file-index', params.path))).toString('base64') }
            } else throw new Error(`Unexpected RPC: ${method}`)
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result: value }))
          } catch (error) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error) } })) }
        })
        if (kind === 'plugin') {
          vite.middlewares.use(async (req, res, next) => {
            const path = new URL(req.url, 'http://fixture').pathname
            if (path === '/__notemd_bridge__.js' || path === '/index.html' || /^\/assets\/[\w.-]+\.(?:js|css)$/.test(path)) {
              res.setHeader('Content-Type', path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript')
              if (path.endsWith('.html')) res.setHeader('Content-Security-Policy', csp)
              res.end(await readFile(join(servedRoot, path.slice(1)))); return
            }
            next()
          })
        } else vite.middlewares.use('/index-host', async (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(await vite.transformIndexHtml('/index-host', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="fixture"></div><script type="module">import {mount} from "svelte";import App from "/scripts/fixtures/index-viewer-browser.svelte";mount(App,{target:document.getElementById("fixture")});</script></body></html>'))
        })
      },
    }, svelte()],
  })
  servers.push(server); await server.listen()
  return `http://127.0.0.1:${server.httpServer.address().port}`
}
async function check(name, run) { await run(); results.push({ name, status: 'passed' }); console.log('PASS', name) }
try {
  pluginOrigin = await serve('plugin')
  const hostOrigin = await serve('host')
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: 'light', reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(String(error)))
  const plugin = () => page.frameLocator('iframe[title="demo.index.md"]')
  const ready = async () => page.locator('.file-plugin-view[aria-busy="false"]').waitFor()
  const load = async (name) => {
    const content = await readFile(join(root, 'skills/file-index/assets', `${name}.index.md`), 'utf8')
    await page.evaluate(content => window.__indexBrowser.reload(content), content)
    await ready()
    await plugin().locator(`[data-view="${name}"]`).waitFor()
    return content
  }
  await page.goto(`${hostOrigin}/index-host`)
  await check('real host handshake and two-dimensional board', async () => {
    await ready()
    assert.equal(await plugin().locator('.board-cell').count(), 8)
    assert.equal(await plugin().locator('.card').count(), 4)
    assert.equal(await plugin().locator('.lane-title').count(), 2)
    assert.equal(await plugin().locator('body').evaluate(() => window.notemd.pluginId), 'notemd.index-viewer')
    await page.screenshot({ path: join(output, 'board-light.png') })
  })
  await check('all four templates and layouts retain source bytes', async () => {
    for (const view of ['table', 'list', 'gallery', 'board']) {
      const content = await load(view)
      assert.equal(await page.evaluate(() => window.__indexBrowser.content), content)
      if (view === 'gallery') {
        await plugin().locator('.cover img').first().waitFor()
        await plugin().locator('.cover img').first().evaluate(img => img.decode())
        assert.equal(await plugin().locator('.cover img').count(), 2)
      }
      await page.screenshot({ path: join(output, `${view}-light.png`) })
    }
  })
  await check('uneven list indentation preserves record ownership and all layouts', async () => {
    const source = await readFile(join(root, 'skills/file-index/assets/board.index.md'), 'utf8')
    let index = 0
    const content = source.split('\n').map(line => /^\s*- /.test(line) ? ['', ' ', '\t', '       '][index++ % 4] + line.trimStart() : line).join('\n')
    await page.evaluate(content => window.__indexBrowser.reload(content), content)
    await ready()
    await plugin().locator('[data-view="board"]').waitFor()
    assert.equal(await plugin().locator('.board-cell').count(), 8)
    assert.equal(await plugin().locator('.card').count(), 4)
    assert.equal(await plugin().locator('.lane-title').count(), 2)
    assert.equal(await page.evaluate(() => window.__indexBrowser.content), content)
    for (const name of ['表格', '分组列表', '封面画廊', '泳道看板']) {
      await plugin().getByRole('button', { name, exact: true }).click()
      await plugin().getByRole('button', { name: '需求清单（演示）', exact: true }).waitFor()
    }
  })
  await check('layout switch, search, grouping and file navigation', async () => {
    await plugin().getByRole('button', { name: '表格', exact: true }).click()
    await plugin().locator('tbody tr').first().waitFor()
    await plugin().getByRole('searchbox').fill('需求')
    assert.equal(await plugin().locator('tbody tr').count(), 1)
    const opened = page.waitForResponse(response => response.url().endsWith('/__rpc__') && response.request().postDataJSON()?.method === 'host.editor.open')
    await plugin().getByRole('button', { name: '需求清单（演示）', exact: true }).click()
    await opened
    assert.ok(calls.some(call => call.method === 'host.editor.open' && call.params.path === 'assets/examples/requirements.md'))
    await plugin().getByRole('searchbox').fill('')
    await plugin().getByRole('button', { name: '分组列表', exact: true }).click()
    await plugin().getByLabel('分组字段', { exact: true }).selectOption('项目')
    assert.equal(await plugin().locator('.list-group').count(), 2)
    missingFiles = true
    await plugin().getByRole('button', { name: '需求清单（演示）', exact: true }).click()
    await plugin().getByRole('alert').waitFor()
    missingFiles = false
  })
  await check('dark and narrow galleries remain readable and covers recover to placeholders', async () => {
    await load('gallery')
    for (const variant of ['dark', 'narrow']) {
      await page.emulateMedia({ colorScheme: variant === 'dark' ? 'dark' : 'light' })
      await page.setViewportSize(variant === 'narrow' ? { width: 390, height: 844 } : { width: 1280, height: 850 })
      await plugin().locator('.cover img').first().waitFor()
      const overflow = await plugin().locator('body').evaluate(body => Math.max(body.scrollWidth, document.documentElement.scrollWidth) - innerWidth)
      assert.ok(overflow <= 1, `No outer overflow: ${overflow}`)
      await page.screenshot({ path: join(output, `gallery-${variant}.png`) })
    }
    const content = (await readFile(join(root, 'skills/file-index/assets/gallery.index.md'), 'utf8')).replace('covers/blue-book.png', 'covers/missing.png')
    await page.evaluate(content => window.__indexBrowser.reload(content), content)
    await plugin().getByText('封面无法加载', { exact: true }).waitFor()
  })
  await check('invalid format falls back; Source and plugin mode preserve editable Markdown', async () => {
    const malformed = '# 索引\n\n- [文件](file.md)\n- 状态：已读\n- 状态：冲突值\n'
    await page.evaluate(content => window.__indexBrowser.reload(content), malformed)
    assert.equal(await page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true }).inputValue(), malformed)
    await page.evaluate(content => window.__indexBrowser.reload(content), await readFile(join(root, 'skills/file-index/assets/table.index.md'), 'utf8'))
    await ready()
    await page.getByRole('tab', { name: '源码（Cmd+/）', exact: true }).click()
    await page.getByRole('textbox', { name: 'Markdown 源码', exact: true }).waitFor()
    await page.getByRole('tab', { name: '使用“文件索引”查看', exact: true }).click()
    await ready()
  })
  assert.deepEqual(errors, [])
  assert.ok(calls.every(call => ['host.vault.info', 'host.vault.read_bytes', 'host.editor.open'].includes(call.method)))
  const report = { output, browser: browser.version(), results, boundaries: 'Real host FilePluginView + ModeToggle; production index bundle and Rust bridge/CSP; isolated read-only fixture RPC' }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(error.stack ?? error)
  console.error('Browser errors:', errors)
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  process.exitCode = 1
} finally { await browser?.close(); await Promise.all(servers.map(server => server.close())) }
