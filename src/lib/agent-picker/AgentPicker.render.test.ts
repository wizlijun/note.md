// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, unmount } from 'svelte'
import AgentPicker from './AgentPicker.svelte'

let component: ReturnType<typeof mount> | undefined
afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mountPicker(selected = 'claude') {
  component = mount(AgentPicker, { target: document.body, props: {
    options: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }],
    selected, onselect: () => {}, label: (key: string) => key,
  } })
  flushSync()
  return document.querySelector<HTMLButtonElement>('[aria-haspopup=menu]')!
}

async function openMenu(trigger: HTMLButtonElement) {
  trigger.focus()
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  flushSync()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  return [...document.querySelectorAll<HTMLButtonElement>('.menu-panel .menu-row')]
}

describe('shared agent picker keyboard interaction', () => {
  it('uses the shared menu and returns focus after selecting or dismissing', async () => {
    let selected = ''
    component = mount(AgentPicker, { target: document.body, props: {
      options: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }],
      selected: 'claude', onselect: (id: string) => { selected = id }, label: (key: string) => key,
    } })
    flushSync()
    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup=menu]')!
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    flushSync()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const items = [...document.querySelectorAll<HTMLButtonElement>('.menu-panel .menu-row')]
    expect(items).toHaveLength(2)
    expect(document.activeElement).toBe(items[0])
    items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(items[1])
    items[1].click()
    flushSync()
    expect(selected).toBe('codex')
    expect(document.activeElement).toBe(trigger)
    expect(document.querySelector('[role=menu]')).toBeNull()
    trigger.click()
    flushSync()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    flushSync()
    expect(document.querySelector('[role=menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('commits the measured, visible menu before trying to focus its selected provider', async () => {
    const nativeFocus = HTMLElement.prototype.focus
    const focusedVisibility: string[] = []
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      const menu = this.closest<HTMLElement>('[role=menu]')
      if (menu) focusedVisibility.push(menu.style.visibility)
      nativeFocus.call(this, options)
    })

    const items = await openMenu(mountPicker('codex'))
    // happy-dom permits focusing visibility:hidden nodes; verify the actual
    // DOM commit at the moment focus is invoked, not just its activeElement.
    expect(focusedVisibility).toEqual([''])
    expect(document.activeElement).toBe(items[1])
  })

  it('wraps arrow navigation and supports Home, End and Tab dismissal', async () => {
    const trigger = mountPicker()
    const items = await openMenu(trigger)
    const press = (key: string) => document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    )
    press('ArrowUp')
    expect(document.activeElement).toBe(items[1])
    press('ArrowDown')
    expect(document.activeElement).toBe(items[0])
    press('End')
    expect(document.activeElement).toBe(items[1])
    press('Home')
    expect(document.activeElement).toBe(items[0])
    press('Tab')
    flushSync()
    expect(document.querySelector('[role=menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('does not move focus when dismissed before the measurement frame', async () => {
    const trigger = mountPicker()
    trigger.focus()
    trigger.click()
    flushSync()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    flushSync()
    const next = document.createElement('button')
    document.body.append(next)
    next.focus()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(document.querySelector('[role=menu]')).toBeNull()
    expect(document.activeElement).toBe(next)
  })
})

it('keeps unavailable providers selectable by default on existing surfaces', async () => {
  const selected = vi.fn()
  component = mount(AgentPicker, { target: document.body, props: {
    options: [{ id: 'claude', name: 'Claude', harness: { harness: 'Claude Code', ok: false, hint: 'credentials missing' } }, { id: 'codex', name: 'Codex' }],
    selected: 'codex', onselect: selected, label: (key: string) => key,
  } })
  flushSync()
  const rows = await openMenu(document.querySelector<HTMLButtonElement>('[aria-haspopup=menu]')!)
  expect(rows[0].disabled).toBe(false)
  rows[0].click()
  expect(selected).toHaveBeenCalledWith('claude')
})

it('supports NEXT initial-open picker with disabled providers, hint and warning', async () => {
  const selected = vi.fn()
  component = mount(AgentPicker, { target: document.body, props: {
    options: [{ id: 'claude', name: 'Claude', harness: { harness: 'Claude Code', ok: false, hint: 'safety unverified', warning: 'expired credentials' } }, { id: 'codex', name: 'Codex' }],
    selected: 'claude', initialOpen: true, disableUnavailable: true, onselect: selected, label: (key: string) => key,
  } })
  flushSync()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const rows = [...document.querySelectorAll<HTMLButtonElement>('.menu-row')]
  expect(rows[0].disabled).toBe(true)
  expect(rows[0].textContent).toContain('safety unverified')
  expect(rows[0].textContent).toContain('expired credentials')
  rows[0].click()
  expect(selected).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(rows[1])
})

it('renders the data-source footer for a single unavailable provider', async () => {
  component = mount(AgentPicker, { target: document.body, props: {
    options: [{ id: 'claude', name: 'Claude', harness: { harness: 'Claude Code', ok: false, version: '2.1', default_model: 'model', hint: 'unverified' } }],
    selected: 'claude', initialOpen: true, disableUnavailable: true,
    footer: createRawSnippet(() => ({ render: () => '<p>Task files, read only</p>' })),
    onselect: vi.fn(), label: (key: string) => key,
  } })
  flushSync()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  expect(document.querySelector('[role=menu]')).not.toBeNull()
  expect(document.querySelector('.footer')?.textContent).toContain('Task files, read only')
  expect(document.querySelector('.dt')?.textContent).toContain('2.1')
  expect(document.querySelector('.hint')?.textContent).toContain('unverified')
  expect(document.activeElement).toBe(document.querySelector('[role=menu]'))
})

describe('externally anchored agent menu', () => {
  async function mountAnchored(options = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }]) {
    const anchor = document.createElement('button')
    anchor.textContent = '▼'
    document.body.append(anchor)
    anchor.focus()
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      top: 70, left: 100, width: 30, height: 24, right: 130, bottom: 94, x: 100, y: 70, toJSON() {},
    })
    const onclose = vi.fn()
    const onselect = vi.fn()
    component = mount(AgentPicker, { target: document.body, props: {
      options, selected: 'claude', anchor, initialOpen: true, disableUnavailable: true,
      onclose, onselect, label: (key: string) => key,
    } })
    flushSync()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    return { anchor, onclose, onselect, menu: document.querySelector<HTMLElement>('[role=menu]')! }
  }

  it('opens directly at the external button without another trigger and closes after selection', async () => {
    const { anchor, menu, onclose, onselect } = await mountAnchored()
    expect(document.querySelector('.by')).toBeNull()
    expect(menu.style.top).toBe('98px')
    expect(menu.style.left).toBe('130px')
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')]
    expect(document.activeElement).toBe(rows[0])
    rows[1].click()
    flushSync()
    expect(onselect).toHaveBeenCalledExactlyOnceWith('codex')
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(anchor)
    expect(document.querySelector('[role=menu]')).toBeNull()
  })

  it('restores the captured anchor when selection clears the parent menu state', async () => {
    const button = document.createElement('button')
    document.body.append(button)
    let menuAnchor: HTMLElement | null = button
    const calls: string[] = []
    component = mount(AgentPicker, { target: document.body, props: {
      options: [{ id: 'claude', name: 'Claude' }], selected: 'claude', initialOpen: true,
      get anchor() { return menuAnchor },
      onselect: () => {
        expect(menuAnchor).toBe(button)
        calls.push('select')
        menuAnchor = null
      },
      onclose: () => { calls.push('close') },
      label: (key: string) => key,
    } })
    flushSync()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    document.querySelector<HTMLButtonElement>('[role=menuitemradio]')!.click()
    flushSync()
    expect(calls).toEqual(['select', 'close'])
    expect(document.querySelector('[role=menu]')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it.each(['Escape', 'Tab'])('notifies the owner and restores anchor focus on %s', async key => {
    const { anchor, onclose } = await mountAnchored()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    flushSync()
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(anchor)
    expect(document.querySelector('[role=menu]')).toBeNull()
  })

  it('leaves anchor clicks to the owner and dismisses outside without stealing focus', async () => {
    const { anchor, menu, onclose } = await mountAnchored()
    const caret = document.createElement('span')
    anchor.append(caret)
    caret.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    flushSync()
    expect(onclose).not.toHaveBeenCalled()
    expect(menu.isConnected).toBe(true)
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    flushSync()
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(outside)
    expect(menu.isConnected).toBe(false)
  })

  it('focuses an empty menu so Tab and Escape can still dismiss it', async () => {
    const { menu, anchor, onclose } = await mountAnchored([])
    expect(document.activeElement).toBe(menu)
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    flushSync()
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(anchor)
  })
})
