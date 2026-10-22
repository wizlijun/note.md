#!/usr/bin/env node
// Production plugin acceptance. Host RPC is an isolated fixture; no Vault is read or written.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseDocument } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.TIMELINE_REVIEW_OUTPUT ?? join(root, 'tasks/timeline-importance-browser'))
await mkdir(output, { recursive: true })
const build = spawnSync('pnpm', ['--filter', 'timeline', 'build'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`)
const content = await readFile(join(root, 'scripts/fixtures/timeline-importance.md'), 'utf8')
const html = (await readFile(join(root, 'plugins-src/timeline/dist/index.html'), 'utf8')).replace('<head>', '<head><script src="/fixture-bridge.js"></script>')
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href) : await import('playwright')
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://fixture').pathname
    res.setHeader('Cache-Control', 'no-store')
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe title="Timeline" src="/plugin/index.html${new URL(req.url, 'http://fixture').search}" style="display:block;width:100vw;height:100vh;border:0"></iframe><script>window.events=[];window.failSave=false;addEventListener("message",e=>{events.push(e.data);if(e.data.type==="file_view.save"){window.savedContent=e.data.content;document.querySelector("iframe").contentWindow.postMessage({type:"file_view.save_result",requestId:e.data.requestId,operationId:e.data.operationId,ok:!window.failSave,error:"disk full"},location.origin);window.openTimeline(e.data.content,e.data.requestId+1,true)}});window.openTimeline=(content,requestId=1,editable=false)=>document.querySelector("iframe").contentWindow.postMessage({type:"file_view.open",viewId:"timeline",requestId,capabilities:{edit:editable},uri:"/fixture-vault/diary/2026-10-21.timeline.md",content},location.origin)</script></body></html>`)
    } else if (path === '/plugin/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html)
    } else if (path === '/fixture-bridge.js') {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(`window.requests=[];window.notemd=Object.freeze({locale:new URL(location.href).searchParams.get('lang')||'zh',theme:'light',async request(method,params){window.requests.push({method,params});if(method==='host.settings.get')return {settings:{}};if(method==='host.vault.info')return {root:'/fixture-vault'};if(method==='host.editor.open')return {};throw Error('Unexpected RPC: '+method)}});`)
    } else if (/^\/plugin\/assets\/[\w.-]+\.(js|css)$/.test(path)) {
      res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript')
      res.end(await readFile(join(root, 'plugins-src/timeline/dist', path.slice('/plugin/'.length))))
    } else { res.statusCode = 404; res.end() }
  } catch (error) { res.statusCode = 500; res.end(String(error)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
const errors = []
const checks = []
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, colorScheme: 'light' })
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const frame = page.frameLocator('iframe')
  await frame.locator('.app').waitFor()
  const open = async (text, id) => {
    await page.evaluate(({ text, id }) => window.openTimeline(text, id), { text, id })
    await page.waitForFunction(id => window.events.some(e => e.requestId === id), id)
  }
  await open(content, 1)
  assert.equal(await frame.locator('.event').count(), 4)
  assert.equal(await frame.locator('.event[data-importance="high"]').count(), 3)
  assert.equal(await frame.locator('.event[data-importance="normal"] .anomaly-label').count(), 1)
  assert.equal(await frame.locator('.importance-legend').count(), 1)
  assert.equal(await frame.locator('.event .importance-label').count(), 4)
  assert.ok(!(await frame.locator('.events').innerText()).includes('event:'))
  checks.push('production bundle renders independent importance/anomaly, category and stable IDs')

  for (const [name, width, scheme] of [['light', 1100, 'light'], ['dark', 1100, 'dark'], ['narrow-light', 390, 'light'], ['narrow-dark', 390, 'dark']]) {
    await page.setViewportSize({ width, height: 850 })
    await page.emulateMedia({ colorScheme: scheme })
    await frame.locator('.event[data-item-id="fault"]').scrollIntoViewIfNeeded()
    const sizes = await frame.locator('body').evaluate(body => ({ width: innerWidth, max: Math.max(body.scrollWidth, document.documentElement.scrollWidth) }))
    assert.ok(sizes.max <= sizes.width + 1, `${name}: no page overflow`)
    const labels = await frame.locator('.event .importance-label, .event .anomaly-label').evaluateAll(nodes => nodes.map(node => {
      const label = node.getBoundingClientRect(), card = node.closest('.event').getBoundingClientRect()
      return { text: node.textContent, fits: label.left >= card.left && label.right <= card.right + 1 && label.top >= card.top && label.bottom <= card.bottom + 1 }
    }))
    assert.ok(labels.every(label => label.fits), `${name}: badges not clipped: ${JSON.stringify(labels)}`)
    const inline = await frame.locator('.event').evaluateAll(nodes => nodes.every(node => {
      const heading = node.querySelector('.event-top').getBoundingClientRect()
      const badges = node.querySelector('.assessment-labels').getBoundingClientRect()
      const range = node.querySelector('.event-time').getBoundingClientRect()
      return badges.top >= heading.top && badges.bottom <= heading.bottom + 1 && range.top >= heading.bottom - 1
    }))
    assert.ok(inline, `${name}: status shares the title row, time stays on the second row`)
    if (width === 390) {
      const widest = await frame.locator('.event').evaluateAll(nodes => Math.max(...nodes.map(node => node.getBoundingClientRect().width)))
      assert.ok(widest <= width - 80, `${name}: each card can fit the viewport without hiding its status (${widest}px)`)
    }
    assert.equal(Math.round((await frame.locator('.event[data-item-id="fault"]').boundingBox()).height), 44)
    assert.ok((await frame.locator('.event[data-item-id="fault"]').boundingBox()).height >= 44)
    await frame.locator('.schedule-scroll').evaluate(node => { node.scrollLeft = 0 })
    await page.screenshot({ path: join(output, `importance-${name}.png`) })
    await frame.locator('.event[data-item-id="meeting"]').click()
    assert.equal(await frame.locator('.assessment').count(), 3)
    assert.match(await frame.locator('.detail').innerText(), /逐项完成例行检查/)
    assert.match(await frame.locator('.detail').innerText(), /s01.*L12-L18/s)
    assert.match(await frame.locator('.detail').innerText(), /未知/)
    assert.match(await frame.locator('.source-limit').innerText(), /行号/)
    await page.screenshot({ path: join(output, `importance-detail-${name}.png`) })
    await frame.locator('.assessment').last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(output, `importance-child-${name}.png`) })
    await page.keyboard.press('Escape')
    await frame.locator('.detail').waitFor({ state: 'detached' })
    assert.equal(await frame.locator('.event[data-item-id="meeting"]').evaluate(node => document.activeElement === node), true)
  }
  checks.push('light/dark and 390px: overlap/zero-duration badges fit; nested details and keyboard focus verified')
  await page.setViewportSize({ width: 1100, height: 760 })
  await frame.locator('.event[data-item-id="meeting"]').focus()
  await page.keyboard.press('Enter')
  await frame.locator('.detail').waitFor()
  await frame.getByRole('button', { name: /合成证据/ }).click()
  const rpc = await frame.locator('body').evaluate(() => window.requests.filter(r => r.method === 'host.editor.open'))
  assert.deepEqual(rpc, [{ method: 'host.editor.open', params: { path: 'notes/example.md' } }])
  await page.keyboard.press('Escape')
  checks.push('keyboard opens details; source uses existing file-only navigation contract')

  await open(content.replace('importance: high', 'importance: invalid'), 2)
  assert.equal(await page.evaluate(() => events.find(e => e.requestId === 2).type), 'file_view.fallback')
  const legacy = '---\ntype: Timeline\n---\n- 09:00–09:00 — 生活：旧记录 [来源](../notes/example.md#L12)'
  await open(legacy, 3)
  assert.equal(await frame.locator('.event[data-importance="unknown"]').count(), 1)
  assert.equal(await frame.locator('.event .anomaly-label').count(), 0)
  assert.match(await frame.locator('.event').innerText(), /待判断/)
  await frame.locator('.event').click()
  assert.match(await frame.locator('.detail').innerText(), /尚未判断/)
  checks.push('invalid metadata emits whole-document fallback; legacy remains unknown without normality claim')
  await page.goto(`http://127.0.0.1:${server.address().port}/?lang=en`)
  await frame.locator('.app').waitFor()
  await open(legacy, 4)
  await frame.locator('.event').click()
  assert.match(await frame.locator('.assessment-reason').innerText(), /This legacy document has not been assessed/)
  await open(content.replace('instant:\n    importance: high', 'instant:\n    importance: unknown'), 5)
  await page.setViewportSize({ width: 390, height: 850 })
  const pending = frame.locator('.event[data-item-id="instant"]')
  assert.match(await pending.innerText(), /Pending review/)
  assert.match(await pending.innerText(), /Anomaly/)
  await pending.scrollIntoViewIfNeeded()
  const fits = await pending.evaluate(node => [...node.querySelectorAll('.importance-label, .anomaly-label')].every(label => label.getBoundingClientRect().right <= node.getBoundingClientRect().right))
  assert.ok(fits, 'English pending/anomaly badges fit a short card')
  assert.equal(Math.round((await pending.boundingBox()).height), 44)
  const row = await pending.evaluate(node => {
    const heading = node.querySelector('.event-top').getBoundingClientRect()
    const badges = node.querySelector('.assessment-labels').getBoundingClientRect()
    return badges.top >= heading.top && badges.bottom <= heading.bottom + 1
  })
  assert.ok(row, 'English long status badges stay on the title row')
  const visible = await pending.evaluate(node => {
    const card = node.getBoundingClientRect()
    return card.left >= 0 && card.right <= innerWidth
  })
  assert.ok(visible, 'The complete English short card including its right-aligned badges fits at 390px')
  await page.screenshot({ path: join(output, 'importance-english-narrow.png') })
  await page.setViewportSize({ width: 1100, height: 760 })
  await open(content.replace('09:40–10:10', '09:40–10:22'), 6)
  const threshold = frame.locator('.event[data-item-id="visit"]')
  const textFits = await threshold.evaluate(node => {
    const text = node.querySelector('.event-text')
    if (!text) return true
    return text.getBoundingClientRect().height >= parseFloat(getComputedStyle(text).lineHeight)
  })
  assert.ok(textFits, 'Cards around 64px never show half a description line')
  await page.screenshot({ path: join(output, 'importance-description-threshold.png') })
  checks.push('English legacy explanation and short Pending review + Anomaly badges fit at 390px')
  // Exercise editing against an isolated host protocol fixture, including a dirty failed save.
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await frame.locator('.app').waitFor()
  await page.evaluate(text => window.openTimeline(text, 10, true), content)
  await frame.locator('.event[data-item-id="visit"]').click()
  await frame.locator('.edit-event').first().click()
  await frame.getByRole('textbox', { name: '标题', exact: true }).fill('探访更新')
  await frame.getByRole('textbox', { name: '事件描述', exact: true }).fill('确认后续安排')
  await frame.getByRole('textbox', { name: '开始时间', exact: true }).fill('09:35:15')
  await frame.getByRole('textbox', { name: '结束时间', exact: true }).fill('10:15')
  await frame.getByRole('combobox', { name: '重要程度', exact: true }).selectOption('normal')
  await frame.getByRole('combobox', { name: '反常标签', exact: true }).selectOption('flagged')
  for (const [name, width, scheme] of [['edit-light', 1100, 'light'], ['edit-dark', 1100, 'dark'], ['edit-narrow', 390, 'light'], ['edit-narrow-dark', 390, 'dark']]) {
    await page.setViewportSize({ width, height: 850 })
    await page.emulateMedia({ colorScheme: scheme })
    await frame.locator('.event-editor').scrollIntoViewIfNeeded()
    assert.ok(await frame.locator('.event-editor input, .event-editor textarea, .event-editor select').evaluateAll(nodes => nodes.every(node => {
      const r = node.getBoundingClientRect(); return r.width > 40 && r.left >= 0 && r.right <= innerWidth
    })), `${name}: editing fields fit viewport`)
    await page.screenshot({ path: join(output, `${name}.png`) })
    await frame.getByRole('combobox', { name: '反常标签', exact: true }).scrollIntoViewIfNeeded()
    assert.ok(await frame.getByRole('combobox', { name: '反常标签', exact: true }).isVisible())
    await page.screenshot({ path: join(output, `${name}-anomaly.png`) })
  }
  await page.evaluate(() => { window.failSave = true })
  await frame.getByRole('button', { name: '保存', exact: true }).click()
  await frame.locator('.edit-error').waitFor()
  assert.match(await frame.locator('.edit-error').innerText(), /disk full/)
  assert.equal(await frame.getByRole('textbox', { name: '标题', exact: true }).inputValue(), '探访更新')
  assert.equal(await frame.getByRole('combobox', { name: '反常标签', exact: true }).inputValue(), 'flagged')
  await page.evaluate(() => { window.failSave = false })
  await frame.getByRole('button', { name: '保存', exact: true }).click()
  await frame.locator('.event-editor').waitFor({ state: 'detached' })
  const saved = await page.evaluate(() => window.savedContent)
  assert.match(saved, /09:35:15–10:15 — 探访更新：确认后续安排/)
  assert.match(saved, /importance_origin: manual/)
  const savedMetadata = parseDocument(saved.split('---')[1]).toJS().event_metadata.visit
  assert.equal(savedMetadata.anomaly.status, 'flagged')
  assert.equal(savedMetadata.anomaly.origin, 'manual')
  assert.deepEqual(savedMetadata.anomaly.evidence, [])
  assert.equal(await frame.locator('.event[data-item-id="visit"] .anomaly-label').count(), 1)
  assert.match(await frame.locator('.detail').innerText(), /手动标记为反常/)
  assert.equal(await frame.locator('.event[data-item-id="visit"] strong').innerText(), '探访更新')
  assert.equal(await frame.locator('.event[data-item-id="visit"]').getAttribute('data-importance'), 'normal')
  assert.match(await frame.locator('.detail').innerText(), /手动设置/)
  await frame.locator('.edit-event').first().click()
  await frame.getByRole('textbox', { name: '标题', exact: true }).fill('取消的标题')
  await frame.getByRole('combobox', { name: '反常标签', exact: true }).selectOption('none')
  await frame.getByRole('textbox', { name: '标题', exact: true }).press('Escape')
  await frame.locator('.event-editor').waitFor({ state: 'detached' })
  assert.equal(await frame.locator('.event[data-item-id="visit"] strong').innerText(), '探访更新')
  assert.equal(await frame.locator('.event[data-item-id="visit"] .anomaly-label').count(), 1, 'cancel keeps persisted anomaly')
  assert.equal(await page.evaluate(() => window.savedContent), saved)
  await frame.locator('.edit-event').first().click()
  assert.equal(await frame.getByRole('combobox', { name: '反常标签', exact: true }).inputValue(), 'flagged')
  await frame.getByRole('combobox', { name: '反常标签', exact: true }).selectOption('none')
  await frame.getByRole('button', { name: '保存', exact: true }).click()
  await frame.locator('.event-editor').waitFor({ state: 'detached' })
  assert.equal(await frame.locator('.event[data-item-id="visit"] .anomaly-label').count(), 0, 'clearing anomaly updates the saved card')
  assert.match(await frame.locator('.detail').innerText(), /手动标记未发现反常/)
  checks.push('edit title, description, second-precision times and importance; light/dark/390px form; failed save retains draft and retries; saved card refreshes; Escape cancels without writing')
  // Both editing entry points must independently persist anomaly on legacy documents.
  const legacyNested = '---\ntype: Timeline\ncustom: "keep me"\n---\n- 09:00–10:00 — 父活动：保留父内容\n  - 09:10–09:20 — 子议题：保留子内容\n'
  await page.evaluate(text => window.openTimeline(text, 30, true), legacyNested)
  await frame.locator('.event').click()
  await frame.getByRole('button', { name: '编辑 子议题', exact: true }).click()
  assert.equal(await frame.getByRole('combobox', { name: '反常标签', exact: true }).inputValue(), 'unknown')
  await frame.getByRole('combobox', { name: '反常标签', exact: true }).selectOption('flagged')
  await frame.getByRole('button', { name: '保存', exact: true }).click()
  await frame.locator('.event-editor').waitFor({ state: 'detached' })
  const nestedSaved = await page.evaluate(() => window.savedContent)
  assert.match(nestedSaved, /custom: "keep me"/)
  assert.match(nestedSaved, /origin: manual/)
  assert.equal(await frame.locator('.event .anomaly-label').count(), 0, 'child anomaly does not mark parent card')
  assert.equal(await frame.locator('.child .anomaly-label').count(), 1)
  assert.match(await frame.locator('.child .anomaly-assessment').innerText(), /手动标记为反常/)
  await frame.getByRole('button', { name: '编辑 子议题', exact: true }).click()
  assert.equal(await frame.getByRole('combobox', { name: '反常标签', exact: true }).inputValue(), 'flagged')
  await frame.getByRole('combobox', { name: '反常标签', exact: true }).selectOption('unknown')
  await frame.getByRole('button', { name: '保存', exact: true }).click()
  await frame.locator('.event-editor').waitFor({ state: 'detached' })
  assert.equal(await frame.locator('.child .anomaly-label').count(), 0)
  assert.match(await frame.locator('.child .anomaly-assessment').innerText(), /手动标记为待判断/)
  const nestedUnknown = await page.evaluate(() => window.savedContent)
  await page.evaluate(text => window.openTimeline(text, 40, true), nestedUnknown)
  await frame.locator('.event').click()
  await frame.getByRole('button', { name: '编辑 子议题', exact: true }).click()
  assert.equal(await frame.getByRole('combobox', { name: '反常标签', exact: true }).inputValue(), 'unknown')
  await frame.getByRole('button', { name: '取消', exact: true }).click()
  await page.evaluate(text => window.openTimeline(text, 50, false), nestedUnknown)
  await frame.locator('.event').click()
  assert.equal(await frame.locator('.edit-event').count(), 0)
  assert.equal(await frame.getByRole('combobox', { name: '反常标签', exact: true }).count(), 0)
  assert.match(await frame.locator('.edit-limit').innerText(), /升级|只读/)
  await page.goto(`http://127.0.0.1:${server.address().port}/?lang=en`)
  await frame.locator('.app').waitFor()
  await page.evaluate(text => window.openTimeline(text, 60, true), nestedUnknown)
  await frame.locator('.event').click()
  await frame.getByRole('button', { name: 'Edit 子议题', exact: true }).click()
  assert.deepEqual(await frame.getByRole('combobox', { name: 'Anomaly tag', exact: true }).locator('option').allTextContents(), ['Anomaly', 'No anomaly found', 'Pending review'])
  await frame.getByRole('button', { name: 'Cancel', exact: true }).click()
  checks.push('anomaly is independent: set/remove on parent; legacy nested set/pending/reopen preserve parent and unknown frontmatter; cancellation preserves saved value; old host exposes no editor')
  assert.deepEqual(errors, [])
  const report = { browser: browser.version(), boundary: 'Actual production Timeline bundle, browser DOM and file_view messages; isolated host RPC fixture, no native installation or Vault access.', checks, errors }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0]
  await page?.screenshot({ path: join(output, 'failure.png') })
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
