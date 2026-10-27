// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { fromStore, writable } from 'svelte/store'
import PlaceMenu from './PlaceMenu.svelte'
import PlaceSheet from './PlaceSheet.svelte'
import { setLocale } from '../lib/strings'
import type { WorkspaceItem } from '../lib/repository'

const mounted: ReturnType<typeof mount>[] = []
const item: WorkspaceItem = {
  key: 'inbox/tasks/a.md', state: 'capture', title: '交付版本', path: 'inbox/tasks/a.md',
  created: '2026-10-28T00:00:00Z', proofed: false, orphan: false,
  relinkCandidates: [], relinkMatch: null,
}

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component)
  document.body.innerHTML = ''
  setLocale('en')
})

function menu(withNote: boolean) {
  setLocale('zh')
  const anchor = document.createElement('button')
  document.body.appendChild(anchor)
  const callbacks = { onCancel: vi.fn(), onSelect: vi.fn(), onMore: vi.fn(), onCompleteWithNote: vi.fn() }
  mounted.push(mount(PlaceMenu, { target: document.body, props: {
    anchor, itemTitle: item.title, saving: false, ...callbacks,
    onCompleteWithNote: withNote ? callbacks.onCompleteWithNote : undefined,
  } }))
  flushSync()
  return callbacks
}

function submit() {
  document.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
  flushSync()
}

function enter(value: string) {
  const textarea = document.querySelector('textarea')!
  textarea.value = value
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
  flushSync()
}

describe('completion note', () => {
  it.each([false, true])('keeps existing menu actions and keyboard indices (note enabled: %s)', (withNote) => {
    const callbacks = menu(withNote)
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(rows.map((row) => row.textContent)).toEqual([
      ...(withNote ? ['完成并记一笔'] : []), '现在推进', '等待回收', '以后再看', '完成', '停止', '转移他人', '更多…',
    ])
    const panel = document.querySelector<HTMLElement>('[role="menu"]')!
    const key = (key: string) => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      flushSync()
    }
    for (const row of rows) {
      key('ArrowDown')
      expect(document.activeElement).toBe(row)
      expect(row.classList.contains('active')).toBe(true)
    }
    key('Home')
    expect(document.activeElement).toBe(rows[0])
    key('End')
    expect(document.activeElement).toBe(rows.at(-1))
    rows.at(-1)!.click()
    expect(callbacks.onMore).toHaveBeenCalledOnce()
    rows.find((row) => row.textContent === '完成')!.click()
    expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith({ route: 'settle', exit: { kind: 'done' }, status_only: true })
    if (withNote) {
      rows[0].click()
      expect(callbacks.onCompleteWithNote).toHaveBeenCalledOnce()
    }
  })

  it('focuses the required multiline note and completes only after text is entered', async () => {
    setLocale('zh')
    const onSubmit = vi.fn(async () => {})
    mounted.push(mount(PlaceSheet, { target: document.body, props: {
      item, saving: false, completionNote: true, initialRoute: 'wait', initialProjects: ['Hidden draft'],
      onCancel: vi.fn(), onReminder: vi.fn(), onSubmit,
    } }))
    flushSync()
    await Promise.resolve()
    const textarea = document.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    expect(textarea.closest('label')?.textContent).toContain('一句话补充')
    expect(textarea.getAttribute('aria-required')).toBe('true')
    expect(document.querySelector('.routes, .reminder-entry, .project-picker, select')).toBeNull()
    expect(document.querySelector('[type="submit"]')?.textContent).toBe('完成')
    enter(' \n ')
    submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')).toBeTruthy()
    const note = '已发出交付包\n验证链接：https://example.com/release'
    enter(note)
    submit()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ route: 'settle', exit: { kind: 'done' }, result: note })
  })

  it('keeps failed content visible and read-only while retry sends the same payload', () => {
    const locked = fromStore(writable(false))
    const error = fromStore(writable<string | undefined>(undefined))
    const onSubmit = vi.fn(async () => {})
    mounted.push(mount(PlaceSheet, { target: document.body, props: {
      item, saving: false, completionNote: true,
      get completionNoteLocked() { return locked.current },
      get completionNoteError() { return error.current },
      onCancel: vi.fn(), onSubmit,
    } }))
    flushSync()
    enter('Same completion\nSame evidence')
    submit()
    locked.current = true
    error.current = '保存未完成，请重试'
    flushSync()
    const textarea = document.querySelector('textarea')!
    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toBe('Same completion\nSame evidence')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(error.current)
    expect(document.querySelector('select, input, .routes, .project-picker')).toBeNull()
    submit()
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1]).toEqual(onSubmit.mock.calls[0])
  })

  it('disables submission and editing while saving', () => {
    const saving = fromStore(writable(false))
    const onSubmit = vi.fn(async () => {})
    mounted.push(mount(PlaceSheet, { target: document.body, props: {
      item, get saving() { return saving.current }, completionNote: true, onCancel: vi.fn(), onSubmit,
    } }))
    flushSync()
    enter('Finished')
    saving.current = true
    flushSync()
    expect(document.querySelector('textarea')!.readOnly).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true)
    submit()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
