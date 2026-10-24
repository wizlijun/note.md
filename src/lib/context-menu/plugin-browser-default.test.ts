/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

// Execute the production bridge template with the same named JSON substitutions
// and escaped braces as Rust format!, without booting a native Tauri window.
function pluginBridge(): string {
  const source = readFileSync('src-tauri/src/plugin_runtime/windows.rs', 'utf8')
  const template = source.match(/pub\(crate\) fn bridge_script\([\s\S]*?r#"([\s\S]*?)"#/)
  if (!template) throw new Error('Plugin bridge template missing')
  const values: Record<string, string> = { pid: 'test.plugin', loc: 'en', thm: 'default' }
  return template[1].replace(/\{\{|\}\}|\{(pid|loc|thm)\}/g, (match, key) => key ? JSON.stringify(values[key]) : match[0])
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it('plugin bridge prevents default menus once while preserving plugin custom handlers', () => {
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  const frame = iframe.contentWindow!, doc = iframe.contentDocument!
  const register = vi.spyOn(doc, 'addEventListener')
  const execute = new Function('window', 'document', 'localStorage', pluginBridge())
  execute(frame, doc, frame.localStorage)
  execute(frame, doc, frame.localStorage)
  expect(register.mock.calls.filter(([type]) => type === 'contextmenu')).toHaveLength(1)

  const image = doc.createElement('img')
  doc.body.append(image)
  const openMenu = vi.fn((event: Event) => event.stopImmediatePropagation())
  image.addEventListener('contextmenu', openMenu)
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  image.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(openMenu).toHaveBeenCalledOnce()
  const blank = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  doc.body.dispatchEvent(blank)
  expect(blank.defaultPrevented).toBe(true)
})
