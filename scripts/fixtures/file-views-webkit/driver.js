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
  const button = (label) => [...document.querySelectorAll('button')].find(node => node.textContent.includes(label))
  window.addEventListener('message', event => {
    if (!event.data?.type?.startsWith('file_view.')) return
    const sourceMatches = plugin ? event.source === window.parent : event.source === document.querySelector('iframe')?.contentWindow
    const detail = { type: event.data.type, origin: event.origin, sourceMatches, requestId: event.data.requestId }
    traffic.push(detail)
    report({ kind: 'traffic', ...detail })
    if (plugin && scenario === 'unsupported' && event.data.type === 'file_view.open') {
      check(event.origin === 'tauri://localhost' && sourceMatches, 'plugin receives the exact tauri://localhost parent origin/source')
      report({ kind: 'plugin-complete', checks, writes })
    }
  })
  window.addEventListener('error', event => report({ kind: 'failed', error: event.message }))
  window.addEventListener('unhandledrejection', event => report({ kind: 'failed', error: String(event.reason) }))

  if (plugin) {
    window.notemd = {
      locale: 'zh', theme: 'light',
      request: async (method, params) => {
        if (method === 'host.settings.get') return { settings: structuredClone(settings) }
        if (method === 'host.settings.set') {
          check(params.key === 'classification', 'only classification settings are written')
          settings[params.key] = structuredClone(params.value)
          writes += 1
          return {}
        }
        throw new Error(`Unexpected fixture RPC: ${method}`)
      },
    }
  }

  const run = async () => {
    if (plugin) {
      if (scenario === 'unsupported') return
      await wait(() => traffic.find(item => item.type === 'file_view.open'), 'plugin did not receive file_view.open')
      check(traffic[0].origin === 'tauri://localhost' && traffic[0].sourceMatches, 'plugin receives the exact tauri://localhost parent origin/source')
      await wait(() => document.querySelectorAll('.event').length === 2, 'timeline blocks did not render')
      check(document.querySelector('.event').dataset.category === 'work', 'development starts in blue Work')
      await wait(() => button('分类设置') && !button('分类设置').disabled, 'category settings remain unavailable')
      button('分类设置').click()
      const category = await wait(() => document.querySelector('[data-rule-id="development"] select'), 'settings did not open')
      category.value = 'interest'
      category.dispatchEvent(new Event('change', { bubbles: true }))
      button('保存分类').click()
      await wait(() => !document.querySelector('.settings'), 'form save did not close the settings panel')
      check(writes === 1, 'sandbox allow-forms and production CSP permit one prevented form save')
      check(settings.classification.find(rule => rule.id === 'development').category === 'interest', 'classification is persisted to isolated memory fixture')
      check(document.querySelector('.event').dataset.category === 'interest', 'saved rule immediately changes the block to green Interests')
      button('分类设置').click()
      check((await wait(() => document.querySelector('[data-rule-id="development"] select'), 'settings did not reopen')).value === 'interest', 'reopened settings retain the changed category')
      button('取消').click()

      let preventedNavigation = false
      document.addEventListener('securitypolicyviolation', event => {
        if (event.effectiveDirective === 'form-action') preventedNavigation = true
      })
      const form = document.createElement('form')
      form.action = 'plugin://notemd.timeline/forbidden-submit'
      document.body.append(form)
      form.submit()
      await wait(() => preventedNavigation, 'production form-action none did not block native form navigation')
      check(location.href === 'plugin://notemd.timeline/index.html', 'form-action none keeps the plugin document on its entry URL')
      form.remove()
      await wait(() => document.querySelectorAll('.event').length === 2, 'timeline did not return after closing settings')
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      report({ kind: 'plugin-complete', checks, writes })
      await wait(() => window.qaSnapshotDone, 'native timeline screenshot did not complete')
      button('编辑 Markdown').click()
      return
    }

    const frame = await wait(() => document.querySelector('iframe'), 'host did not mount the view iframe')
    check(frame.getAttribute('sandbox') === 'allow-scripts allow-same-origin allow-forms', 'actual FilePluginView uses the intended sandbox')
    if (scenario !== 'unsupported') {
      await wait(() => !frame.classList.contains('pending'), 'actual FilePluginView did not acknowledge file_view.ready')
      check(traffic.some(item => item.type === 'file_view.ready' && item.origin === 'plugin://notemd.timeline' && item.sourceMatches), 'host accepts the exact plugin://notemd.timeline origin/source')
    }
    const fallback = await wait(() => document.querySelector('.file-plugin-fallback'), 'actual FilePluginView did not fall back')
    check(traffic.some(item => item.type === 'file_view.fallback' && item.origin === 'plugin://notemd.timeline' && item.sourceMatches), 'host receives the exact plugin fallback origin/source')
    check(!document.querySelector('iframe'), 'fallback unmounts the plugin iframe')
    check(document.querySelector('textarea')?.value === window.fixtureContent, 'fallback retains the exact original Markdown snapshot')
    check(fallback.textContent.includes(scenario === 'unsupported' ? '文件视图无法解析此文档' : '正在使用默认编辑器'), 'fallback distinguishes unsupported content from the explicit Edit action')
    report({ kind: 'complete', checks, traffic, banner: fallback.textContent })
  }
  document.addEventListener('DOMContentLoaded', () => run().catch(error => report({ kind: 'failed', error: String(error), checks, traffic })), { once: true })
})()
