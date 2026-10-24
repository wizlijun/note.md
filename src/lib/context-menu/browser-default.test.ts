/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { installBrowserContextMenuGuard } from './browser-default'

let uninstall: (() => void) | undefined
afterEach(() => { uninstall?.(); document.body.replaceChildren() })

it('prevents the browser menu on blank space and leaves custom menus working', () => {
  uninstall = installBrowserContextMenuGuard()
  const empty = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  document.body.dispatchEvent(empty)
  expect(empty.defaultPrevented).toBe(true)

  const button = document.createElement('button')
  document.body.append(button)
  const openMenu = vi.fn()
  button.addEventListener('contextmenu', openMenu)
  const custom = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  button.dispatchEvent(custom)
  expect(custom.defaultPrevented).toBe(true)
  expect(openMenu).toHaveBeenCalledOnce()
})

it('prevents defaults before a surface stops propagation and supports cleanup', () => {
  uninstall = installBrowserContextMenuGuard()
  const image = document.createElement('img')
  document.body.append(image)
  image.addEventListener('contextmenu', event => event.stopImmediatePropagation())
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  image.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  uninstall()
  const after = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  image.dispatchEvent(after)
  expect(after.defaultPrevented).toBe(false)
})
