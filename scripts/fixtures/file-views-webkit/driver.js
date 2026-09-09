(() => {
  const scenario = '__SCENARIO__'
  const plugin = location.protocol === 'plugin:'
  const checks = []
  const traffic = []
  let writes = 0
  let settings = {}
  const report = (value) => window.webkit.messageHandlers.qa.postMessage({ frame: plugin ? 'plugin' : 'host', scenario, ...value })
  const check = (condition, message) => { if (!condition) throw new Error(message); checks.push(message) }
  const wait = async (fn, message, timeout = 7000) => {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const value = fn()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error(message)
  }
  window.addEventListener('message', event => {
    if (!event.data?.type?.startsWith('file_view.')) return
    const sourceMatches = plugin ? event.source === window.parent : event.source === document.querySelector('iframe')?.contentWindow
    const detail = { type: event.data.type, origin: event.origin, sourceMatches, requestId: event.data.requestId }
    traffic.push(detail)
    report({ kind: 'traffic', ...detail })
    if (plugin && event.data.type === 'file_view.open') {
      check(event.origin === 'tauri://localhost' && sourceMatches, 'plugin receives the exact tauri://localhost parent origin/source')
      report({ kind: 'plugin-complete', checks, writes })
    }
  })
  window.addEventListener('error', event => report({ kind: 'failed', error: event.message }))
  window.addEventListener('unhandledrejection', event => report({ kind: 'failed', error: String(event.reason) }))

  const run = async () => {
    if (plugin) {
      check(!!window.notemd && Object.isFrozen(window.notemd), 'production external bridge initializes under the unchanged CSP')
      check(window.notemd.pluginId === 'notemd.timeline', 'external bridge carries the actual plugin identity')
      check(document.querySelector('script[src="/__notemd_bridge__.js"]') !== null, 'HTML loads the same-origin bridge synchronously')
      return
    }

    const frame = await wait(() => document.querySelector('iframe'), 'host did not mount the view iframe')
    check(frame.getAttribute('sandbox') === 'allow-scripts allow-same-origin allow-forms', 'actual FilePluginView uses the intended sandbox')
    if (scenario !== 'unsupported') {
      await wait(() => !frame.classList.contains('pending'), 'actual FilePluginView did not acknowledge file_view.ready')
      check(traffic.some(item => item.type === 'file_view.ready' && item.origin === 'plugin://notemd.timeline' && item.sourceMatches), 'host accepts the exact plugin://notemd.timeline origin/source')
      const rich = document.querySelector('[role=tab]')
      check(rich?.getAttribute('aria-label') === '预览（富文本）', 'host exposes Rich in the unified view switch')
      rich.click()
    }
    const fallback = scenario === 'unsupported'
      ? await wait(() => document.querySelector('.file-plugin-fallback'), 'actual FilePluginView did not fall back')
      : null
    if (scenario === 'unsupported') check(traffic.some(item => item.type === 'file_view.fallback' && item.origin === 'plugin://notemd.timeline' && item.sourceMatches), 'host receives the exact plugin fallback origin/source')
    if (scenario === 'supported') await wait(() => !document.querySelector('iframe'), 'host Rich switch did not unmount the plugin iframe')
    check(!document.querySelector('iframe'), 'fallback unmounts the plugin iframe')
    check(document.querySelector('textarea')?.value === window.fixtureContent, 'fallback retains the exact original Markdown snapshot')
    if (fallback) check(fallback.textContent.includes('文件视图无法解析此文档'), 'unsupported content reports the parser fallback')
    report({ kind: 'complete', checks, traffic, banner: fallback?.textContent ?? '' })
  }
  document.addEventListener('DOMContentLoaded', () => run().catch(error => report({ kind: 'failed', error: String(error), checks, traffic })), { once: true })
})()
