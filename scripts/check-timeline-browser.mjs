#!/usr/bin/env node
// Exercises the real host view and Timeline plugin on two isolated HTTP origins.
// Native settings/navigation boundaries use an in-memory fixture, never a Vault.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-timeline-browser.mjs
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = process.env.TIMELINE_REVIEW_OUTPUT ?? await mkdtemp(join(tmpdir(), 'notemd-timeline-browser-'))
await mkdir(output, { recursive: true })
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href) : await import('playwright')
const state = { classification: undefined, failSave: false, failLoad: false, noPlugin: false, opened: [], saves: 0 }
const results = []
const servers = []
const errors = []
const diagnostics = []
let pluginOrigin = ''
let browser

function fixtureServer(kind) {
  return createServer({ root, configFile: false, cacheDir: join(output, `vite-${kind}`), resolve: { dedupe: ['svelte'] },
    optimizeDeps: { entries: kind === 'host' ? ['scripts/fixtures/timeline-browser.svelte'] : ['plugins-src/timeline/src/App.svelte'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
    plugins: [{ name: `timeline-browser-${kind}`, enforce: 'pre',
      transform(code, id) {
        if (kind === 'host' && id.endsWith('/src/components/FilePluginView.svelte')) {
          assert.ok(code.includes('`plugin://${view.pluginId}`'), 'host fixture must replace only the plugin origin')
          return code.replace('`plugin://${view.pluginId}`', JSON.stringify(pluginOrigin))
        }
        return null
      },
      configureServer(vite) {
        vite.middlewares.use('/timeline-rpc', async (req, res) => {
          try {
            let body = ''
            for await (const chunk of req) body += chunk
            const { method, params } = JSON.parse(body)
            let value
            if (method === 'host.settings.get') {
              if (state.failLoad) throw new Error('Synthetic settings read failure')
              value = { settings: state.classification === undefined ? {} : { classification: state.classification } }
            } else if (method === 'host.settings.set') {
              if (state.failSave) throw new Error('Synthetic settings write failure')
              assert.equal(params.key, 'classification')
              state.classification = structuredClone(params.value)
              state.saves++
              value = { ok: true }
            } else if (method === 'host.vault.info') value = { root: '/fixture-vault' }
            else if (method === 'host.editor.open') { state.opened.push(params.path); value = { ok: true } }
            else throw new Error(`Unimplemented fixture RPC: ${method}`)
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ value }))
          } catch (error) {
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: String(error) }))
          }
        })
        vite.middlewares.use('/timeline-rogue', (req, res) => {
          const url = new URL(req.url, 'http://fixture')
          res.setHeader('Content-Type', 'text/html')
          res.end(`<script>parent.postMessage({type:'file_view.fallback',requestId:${Number(url.searchParams.get('requestId'))}}, ${JSON.stringify(url.searchParams.get('target'))})</script>`)
        })
        vite.middlewares.use(kind === 'host' ? '/timeline-host' : '/timeline-plugin.html', async (req, res, next) => {
          if (req.url?.includes('html-proxy')) { next(); return }
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          if (kind === 'plugin') res.setHeader('Content-Security-Policy', "form-action 'none'")
          if (kind === 'plugin' && state.noPlugin) { res.end('<!doctype html><title>Unresponsive plugin fixture</title>'); return }
          const module = kind === 'host' ? '/scripts/fixtures/timeline-browser.svelte' : '/plugins-src/timeline/src/App.svelte'
          res.end(await vite.transformIndexHtml(`/timeline-${kind}`, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="${kind === 'host' ? 'fixture' : 'app'}"></div><script type="module">
            import { mount } from 'svelte';
            import App from ${JSON.stringify(module)};
            ${kind === 'plugin' ? `window.notemd = { locale:'zh-CN', theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light', async request(method,params) { const response=await fetch('/timeline-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});const result=await response.json();if(result.error)throw new Error(result.error);return result.value; } };` : ''}
            mount(App,{target:document.getElementById(${JSON.stringify(kind === 'host' ? 'fixture' : 'app')})});
          </script></body></html>`))
        })
      },
    }, svelte()],
  })
}

async function check(name, run) {
  await run()
  results.push({ name, status: 'passed' })
  console.log('PASS', name)
}

try {
  const pluginServer = await fixtureServer('plugin'); servers.push(pluginServer); await pluginServer.listen()
  pluginOrigin = `http://127.0.0.1:${pluginServer.httpServer.address().port}`
  const hostServer = await fixtureServer('host'); servers.push(hostServer); await hostServer.listen()
  const hostOrigin = `http://127.0.0.1:${hostServer.httpServer.address().port}`
  assert.notEqual(hostOrigin, pluginOrigin)
  browser = await chromium.launch({ headless: process.env.TIMELINE_REVIEW_HEADED !== '1', ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: 'light', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.push(message.text()) })
  page.on('requestfailed', (request) => diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`))
  const plugin = () => page.frameLocator('iframe[title="2026-09-08.timeline.md"]')
  const iframe = () => page.locator('iframe[title="2026-09-08.timeline.md"]')
  const waitReady = async () => {
    await page.locator('.file-plugin-view[aria-busy="false"]').waitFor({ timeout: 12_000 })
    await plugin().locator('.event').first().waitFor()
  }
  await page.goto(`${hostOrigin}/timeline-host`)

  await check('cross-origin handshake renders all five categories and seven activity blocks', async () => {
    await waitReady()
    assert.equal(await plugin().locator('.event').count(), 7)
    const categories = await plugin().locator('.event').evaluateAll((nodes) => [...new Set(nodes.map((node) => node.dataset.category))].sort())
    assert.deepEqual(categories, ['interest', 'leisure', 'life', 'other', 'work'])
    assert.equal(await page.evaluate(() => window.__timelineBrowser.content === window.__timelineBrowser.initial), true)
    const instant = plugin().getByRole('button', { name: /12:45.*沟通/ })
    assert.ok((await instant.boundingBox()).height >= 38, 'zero-duration records keep a usable hit target')
  })

  await check('light, dark and 390px schedule screenshots fit the window', async () => {
    for (const variant of ['light', 'dark', 'narrow']) {
      await page.emulateMedia({ colorScheme: variant === 'light' ? 'light' : 'dark' })
      await page.setViewportSize(variant === 'narrow' ? { width: 390, height: 740 } : { width: 1100, height: 760 })
      await plugin().locator('.app').evaluate((node) => new Promise((resolve) => requestAnimationFrame(() => resolve(node.clientWidth))))
      const overflow = await plugin().locator('body').evaluate((body) => ({ viewport: innerWidth, body: body.scrollWidth, html: document.documentElement.scrollWidth }))
      assert.ok(Math.max(overflow.body, overflow.html) <= overflow.viewport + 1, `${variant}: no page overflow ${JSON.stringify(overflow)}`)
      await page.screenshot({ path: join(output, `timeline-${variant}.png`) })
    }
    await page.setViewportSize({ width: 1100, height: 760 }); await page.emulateMedia({ colorScheme: 'light' })
  })

  await check('activity details preserve nested topics and navigate to the real source RPC', async () => {
    await plugin().getByRole('button', { name: /09:00.*开发/ }).click()
    await plugin().getByRole('heading', { name: '开发', exact: true }).waitFor()
    assert.ok((await plugin().locator('.detail').innerText()).includes('验证来源链接与跨窗口消息'))
    await plugin().getByRole('button', { name: '开发记录', exact: false }).click()
    await assertEventually(() => state.opened.includes('agent/browser-example.md'))
    await page.screenshot({ path: join(output, 'timeline-detail.png') })
    await plugin().getByRole('button', { name: '关闭详情', exact: true }).click()
  })

  await check('classification write failure keeps the draft; retry persists and recolors', async () => {
    await plugin().getByRole('button', { name: '分类设置', exact: false }).click()
    const rule = plugin().locator('[data-rule-id="development"]')
    await rule.locator('input').first().fill('编码与实现')
    await rule.locator('select').selectOption('interest')
    state.failSave = true
    await plugin().getByRole('button', { name: '保存分类', exact: true }).click()
    await plugin().getByRole('alert').waitFor()
    assert.equal(await rule.locator('input').first().inputValue(), '编码与实现')
    assert.equal(await rule.locator('select').inputValue(), 'interest')
    assert.equal(state.saves, 0)
    await page.screenshot({ path: join(output, 'timeline-settings-failure.png') })
    state.failSave = false
    await plugin().getByRole('button', { name: '保存分类', exact: true }).click()
    await plugin().locator('.settings').waitFor({ state: 'detached' })
    assert.equal(state.saves, 1)
    assert.equal(state.classification.find((entry) => entry.id === 'development').name, '编码与实现')
    assert.equal(await plugin().getByRole('button', { name: /09:00.*开发/ }).getAttribute('data-category'), 'interest')
    assert.equal(await page.evaluate(() => window.__timelineBrowser.content === window.__timelineBrowser.initial), true)
    await plugin().getByRole('button', { name: '分类设置', exact: false }).click()
    await page.setViewportSize({ width: 390, height: 740 })
    const overflow = await plugin().locator('body').evaluate((body) => Math.max(body.scrollWidth, document.documentElement.scrollWidth) - innerWidth)
    assert.ok(overflow <= 1, 'narrow classification settings fit')
    await page.screenshot({ path: join(output, 'timeline-settings-narrow.png') })
    await plugin().getByRole('button', { name: '取消', exact: true }).click()
    await page.setViewportSize({ width: 1100, height: 760 })
  })

  await check('manual edit fallback preserves bytes and returns to the persisted classification', async () => {
    await plugin().getByRole('button', { name: '编辑 Markdown', exact: false }).click()
    await page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true }).waitFor()
    const source = await page.evaluate(() => window.__timelineBrowser.initial)
    assert.equal(await page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true }).inputValue(), source)
    await page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true }).fill(source.replace('木工与设计基础', '木工、绘画与设计基础'))
    assert.equal(await iframe().count(), 0, 'typing never kicks the user out of Markdown')
    await page.getByRole('button', { name: '返回文件视图', exact: true }).click()
    await waitReady()
    assert.ok(await plugin().getByRole('button', { name: /绘画与设计基础/ }).count())
    assert.equal(await plugin().getByRole('button', { name: /09:00.*开发/ }).getAttribute('data-category'), 'interest')
  })

  await check('external reload replaces the displayed snapshot and parsing failure falls back', async () => {
    await page.evaluate(() => window.__timelineBrowser.reload(window.__timelineBrowser.initial.replace('学习木工与设计基础', '外部重载后的阅读内容')))
    await waitReady()
    await plugin().getByRole('button', { name: /外部重载后的阅读内容/ }).waitFor()
    await page.evaluate(() => window.__timelineBrowser.reload('---\ntype: Timeline\n---\n- 25:00–26:00 — 开发：无效时间。'))
    await page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true }).waitFor()
    assert.ok((await page.locator('.file-plugin-fallback').innerText()).includes('无法解析'))
    await page.screenshot({ path: join(output, 'timeline-parse-fallback.png') })
    await page.evaluate(() => window.__timelineBrowser.reload(window.__timelineBrowser.initial))
    await waitReady()
  })

  await check('same-origin rogue iframe and wrong-origin parent cannot forge a fallback', async () => {
    const requestId = await page.evaluate(() => window.__timelineBrowser.events.filter((event) => event.type === 'file_view.ready').at(-1).requestId)
    const count = await page.evaluate(() => window.__timelineBrowser.events.length)
    await page.evaluate(({ origin, host, id }) => {
      const rogue = document.createElement('iframe'); rogue.id = 'rogue'; rogue.hidden = true
      rogue.src = `${origin}/timeline-rogue?requestId=${id}&target=${encodeURIComponent(host)}`
      document.body.append(rogue)
      window.postMessage({ type: 'file_view.fallback', requestId: id }, location.origin)
    }, { origin: pluginOrigin, host: hostOrigin, id: requestId })
    await page.waitForFunction((count) => window.__timelineBrowser.events.length >= count + 2, count)
    assert.equal(await page.locator('.file-plugin-view').getAttribute('aria-busy'), 'false')
    assert.equal(await page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true }).count(), 0)
    await page.locator('#rogue').evaluate((node) => node.remove())
  })

  await check('source mode, unsupported metadata and plugin removal retain Markdown', async () => {
    await page.evaluate(() => window.__timelineBrowser.setMode('source'))
    await page.getByRole('textbox', { name: 'Markdown 源码', exact: true }).waitFor()
    assert.equal(await iframe().count(), 0)
    await page.evaluate(() => window.__timelineBrowser.setMode('rich')); await waitReady()
    await page.evaluate(() => window.__timelineBrowser.setEnabled(false))
    await page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true }).waitFor()
    await page.evaluate(() => { window.__timelineBrowser.setContent('# 普通 Markdown'); window.__timelineBrowser.setEnabled(true) })
    assert.equal(await iframe().count(), 0)
    await page.evaluate(() => window.__timelineBrowser.reload(window.__timelineBrowser.initial)); await waitReady()
  })

  await check('settings load failure offers a retry and never overwrites persisted data', async () => {
    state.failLoad = true
    await page.evaluate(() => window.__timelineBrowser.setMode('source'))
    await page.getByRole('textbox', { name: 'Markdown 源码', exact: true }).waitFor()
    await page.evaluate(() => window.__timelineBrowser.setMode('rich')); await waitReady()
    await plugin().getByRole('alert').waitFor()
    assert.equal(await plugin().getByRole('button', { name: '分类设置', exact: false }).isDisabled(), true)
    assert.equal(state.saves, 1)
    state.failLoad = false
    await plugin().getByRole('button', { name: '重试', exact: true }).click()
    await plugin().getByRole('alert').waitFor({ state: 'detached' })
    await plugin().locator('.event[data-category="interest"]').filter({ hasText: '开发' }).waitFor()
    assert.equal(await plugin().getByRole('button', { name: /09:00.*开发/ }).getAttribute('data-category'), 'interest')
  })

  await check('corrupt stored classification opens a repair draft and never writes on cancel', async () => {
    state.classification = { invalid: true }
    await page.evaluate(() => window.__timelineBrowser.setMode('source'))
    await page.getByRole('textbox', { name: 'Markdown 源码', exact: true }).waitFor()
    await page.evaluate(() => window.__timelineBrowser.setMode('rich')); await waitReady()
    await plugin().getByRole('button', { name: '重新设置分类', exact: true }).click()
    await plugin().locator('.settings').waitFor()
    assert.equal(await plugin().locator('.rule').count(), 7)
    await plugin().getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(state.saves, 1)
    assert.deepEqual(state.classification, { invalid: true })
    await plugin().getByRole('button', { name: '重新设置分类', exact: true }).click()
    await plugin().getByRole('button', { name: '保存分类', exact: true }).click()
    await plugin().locator('.settings').waitFor({ state: 'detached' })
    assert.equal(state.saves, 2)
    assert.equal(state.classification.length, 7)
  })

  await check('an unresponsive real iframe reaches the host loading deadline', async () => {
    state.noPlugin = true
    await page.evaluate(() => window.__timelineBrowser.setMode('source'))
    await page.getByRole('textbox', { name: 'Markdown 源码', exact: true }).waitFor()
    await page.evaluate(() => window.__timelineBrowser.setMode('rich'))
    await page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true }).waitFor({ timeout: 10_000 })
    assert.ok((await page.locator('.file-plugin-fallback').innerText()).includes('未能载入'))
    state.noPlugin = false
    await page.getByRole('button', { name: '返回文件视图', exact: true }).click(); await waitReady()
  })

  assert.deepEqual(errors, [], 'no uncaught browser errors')
  await context.close()
  const report = { browser: browser.version(), output, nativeBoundary: 'In-memory fixture RPC; real cross-origin host and plugin Svelte components', results }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(error.stack ?? String(error))
  console.error('Browser errors:', errors)
  console.error('Browser diagnostics:', diagnostics)
  console.error('Artifacts:', output)
  const page = browser?.contexts()[0]?.pages()[0]
  if (page) await page.screenshot({ path: join(output, 'timeline-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser?.close()
  await Promise.all(servers.map((server) => server.close()))
}

async function assertEventually(predicate) {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(predicate())
}
