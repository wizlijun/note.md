// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import type { FrontmatterViewFactory } from '@moraya/core'
import { settings } from './settings.svelte'
import { desktopFrontmatterFactory, readonlyDesktopFrontmatterFactory } from './frontmatter-preference.svelte'

const handles: { destroy(): void }[] = []
const raw = '# keep comment\ntitle: Draft\ncount: 3\n'
function render(factory: FrontmatterViewFactory = desktopFrontmatterFactory, onChange = vi.fn()) {
  const container = document.createElement('div'); document.body.append(container)
  const handle = factory.render(container, raw, onChange)!
  handles.push(handle)
  flushSync()
  return { container, handle, onChange }
}
function hide(value: boolean) {
  settings.hideRichFrontmatter = value
  flushSync()
}
beforeEach(() => { settings.hideRichFrontmatter = true })
afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy()
  document.body.replaceChildren()
  settings.hideRichFrontmatter = true
  flushSync()
})

it('starts hidden without rendering metadata or writing source, then lazily reveals its panel', () => {
  const { container, onChange } = render()
  expect(container.hidden).toBe(true)
  expect(container.style.display).toBe('none')
  expect(container.childNodes.length).toBe(0)
  hide(false)
  expect(container.hidden).toBe(false)
  expect(container.style.display).toBe('')
  expect(container.querySelector('details')).toBeTruthy()
  expect(container.querySelector('.fm-editable')).toBeTruthy()
  expect(onChange).not.toHaveBeenCalled()
})

it('honours a previously saved visible preference at first mount', () => {
  hide(false)
  const { container, onChange } = render()
  expect(container.hidden).toBe(false)
  expect(container.querySelector('.frontmatter-summary')).toBeTruthy()
  expect(onChange).not.toHaveBeenCalled()
})

it('preserves the same expanded panel and YAML across repeated visibility toggles', () => {
  const { container, onChange } = render()
  hide(false)
  const details = container.querySelector('details')!
  details.open = true
  details.dispatchEvent(new Event('toggle'))
  for (let i = 0; i < 3; i++) {
    hide(true); expect(container.hidden).toBe(true)
    hide(false); expect(container.hidden).toBe(false)
    expect(container.querySelector('details')).toBe(details)
    expect(details.open).toBe(true)
    expect(container.querySelectorAll('details')).toHaveLength(1)
  }
  expect(onChange).not.toHaveBeenCalled()
})

it('updates multiple live views together while keeping readonly metadata non-editable', () => {
  const first = render(), second = render(), readonly = render(readonlyDesktopFrontmatterFactory)
  hide(false)
  for (const view of [first, second, readonly]) expect(view.container.hidden).toBe(false)
  expect(first.container.querySelector('.fm-editable')).toBeTruthy()
  expect(second.container.querySelector('.fm-editable')).toBeTruthy()
  expect(readonly.container.querySelector('[contenteditable="true"]')).toBeNull()
  expect(readonly.container.textContent).toContain('Draft')
  hide(true)
  for (const view of [first, second, readonly]) {
    expect(view.container.hidden).toBe(true)
    expect(view.onChange).not.toHaveBeenCalled()
  }
})

it('stops observing a destroyed view', () => {
  const { container, handle, onChange } = render()
  handle.destroy()
  hide(false)
  expect(container.hidden).toBe(true)
  expect(container.childNodes.length).toBe(0)
  expect(onChange).not.toHaveBeenCalled()
})

it('retains scalar editing and untouched comments when metadata is shown', () => {
  hide(false)
  const { container, onChange } = render()
  const cell = container.querySelector<HTMLElement>('.fm-editable')!
  cell.textContent = 'Revised'
  cell.dispatchEvent(new FocusEvent('blur'))
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange.mock.calls[0][0]).toBe('# keep comment\ntitle: Revised\ncount: 3\n')
})

it('commits a focused draft before a preference change hides the panel', () => {
  hide(false)
  const { container, onChange } = render()
  container.querySelector('details')!.open = true
  const cell = container.querySelector<HTMLElement>('.fm-editable')!
  cell.focus()
  expect(document.activeElement).toBe(cell)
  cell.textContent = 'Unblurred draft'
  hide(true)
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange.mock.calls[0][0]).toBe('# keep comment\ntitle: Unblurred draft\ncount: 3\n')
  expect(container.hidden).toBe(true)
  expect(document.activeElement).not.toBe(cell)
})
