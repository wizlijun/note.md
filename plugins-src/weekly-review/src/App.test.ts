import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'
import type { NotemdBridge } from './lib/bridge'

type Entry = { name: string; is_dir: boolean }
type Vault = Record<string, Entry[]>
const file = (name: string): Entry => ({ name, is_dir: false })
const dir = (name: string): Entry => ({ name, is_dir: true })

function button(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!match) throw new Error(`button not found: ${text}`)
  return match
}

function day(month: number, date: number): Element {
  const grid = document.querySelectorAll('.month')[month - 1]
  const match = [...(grid?.querySelectorAll('.day') ?? [])]
    .find((candidate) => candidate.querySelector('.num')?.textContent === String(date))
  if (!match) throw new Error(`day not found: ${month}-${date}`)
  return match
}

function timeline(month: number, date: number): HTMLButtonElement | null {
  return day(month, date).querySelector('button[aria-label="打开时间线"]')
}

function mockHost(vault: Vault) {
  const opened: string[] = []
  const request = vi.fn(async (method: string, params?: unknown) => {
    const path = (params as { path?: string } | undefined)?.path ?? ''
    if (method === 'host.vault.info') return { root: '/vault', wiki_dir: null, daily_dir: 'dailynote' }
    if (method === 'host.vault.exists') return { exists: Object.hasOwn(vault, path) }
    if (method === 'host.vault.list') {
      if (!Object.hasOwn(vault, path)) throw new Error(`missing directory: ${path}`)
      return { entries: [...vault[path]].sort((a, b) => a.name.localeCompare(b.name)) }
    }
    if (method === 'host.editor.open') { opened.push(path); return { ok: true } }
    if (method === 'host.toast') return {}
    throw new Error(`unexpected RPC: ${method}`)
  })
  window.notemd = {
    pluginId: 'notemd.weekly-review', locale: 'zh', theme: 'light', request,
    onMessage: () => {},
  } satisfies NotemdBridge
  return { opened, request }
}

describe('weekly review timeline navigation', () => {
  let app: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'))
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    localStorage.clear()
  })

  afterEach(async () => {
    if (app) await unmount(app)
    app = undefined
    document.body.innerHTML = ''
    localStorage.clear()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('opens a daily timeline without opening its weekly review and excludes previews and directories', async () => {
    const host = mockHost({
      'weekly-review': [file('2026-W37-weekly-review.md')],
      diary: [
        file('2026-09-09.timeline.md'),
        file('2026-09-10.timeline.preview.md'),
        dir('2026-09-11.timeline.md'),
      ],
      dailynote: [dir('2026')],
      'dailynote/2026': [file('2026-09-09.note.md')],
    })
    app = mount(App, { target: document.body })
    await vi.waitFor(() => expect(timeline(9, 9)).not.toBeNull())
    expect(timeline(9, 10)).toBeNull()
    expect(timeline(9, 11)).toBeNull()
    expect(document.querySelectorAll('button[aria-label="打开时间线"]')).toHaveLength(1)
    expect(day(9, 9).querySelector('button[aria-label="打开笔记大纲"]')).not.toBeNull()
    expect(document.querySelector('.legend')?.textContent).toContain('有时间线(点时钟)')

    timeline(9, 9)!.click()
    await tick()
    expect(host.opened).toEqual(['diary/2026-09-09.timeline.md'])
    day(9, 9).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(host.opened).toEqual([
      'diary/2026-09-09.timeline.md', 'weekly-review/2026-W37-weekly-review.md',
    ])
  })

  it('shows a year containing only archived timelines and keeps it available after year navigation', async () => {
    const host = mockHost({
      diary: [dir('2025')],
      'diary/2025': [
        file('2025-12-31.timeline.md'),
        file('2025-12-30.timeline.preview.md'),
        dir('2025-12-29.timeline.md'),
      ],
    })
    app = mount(App, { target: document.body })
    await vi.waitFor(() => expect(timeline(12, 31)).not.toBeNull())
    expect(button('2025').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelectorAll('button[aria-label="打开时间线"]')).toHaveLength(1)
    timeline(12, 31)!.click()
    expect(host.opened).toEqual(['diary/2025/2025-12-31.timeline.md'])

    document.querySelector<HTMLButtonElement>('button[aria-label="下一年"]')!.click()
    await tick()
    expect(document.querySelector('.yearart')?.textContent).toBe('2026')
    expect(document.querySelectorAll('button[aria-label="打开时间线"]')).toHaveLength(0)
    button('2025').click()
    await vi.waitFor(() => expect(timeline(12, 31)).not.toBeNull())
  })

  it('includes years containing only root timelines and prefers the root document for duplicate dates', async () => {
    const host = mockHost({
      diary: [dir('2025'), file('2025-12-31.timeline.md'), file('2026-09-09.timeline.md')],
      'diary/2025': [file('2025-12-30.timeline.md'), file('2025-12-31.timeline.md')],
    })
    app = mount(App, { target: document.body })
    await vi.waitFor(() => expect(timeline(9, 9)).not.toBeNull())
    expect(button('2026').getAttribute('aria-pressed')).toBe('true')
    button('2025').click()
    await vi.waitFor(() => expect(timeline(12, 30)).not.toBeNull())
    expect(document.querySelectorAll('button[aria-label="打开时间线"]')).toHaveLength(2)
    timeline(12, 31)!.click()
    timeline(12, 30)!.click()
    expect(host.opened).toEqual([
      'diary/2025-12-31.timeline.md', 'diary/2025/2025-12-30.timeline.md',
    ])
    button('2026').click()
    await vi.waitFor(() => expect(timeline(9, 9)).not.toBeNull())
    expect(document.querySelectorAll('button[aria-label="打开时间线"]')).toHaveLength(1)
  })

  it.each(['diary', 'diary/2025'])('rebuild refreshes added and removed timelines in %s', async (path) => {
    const vault: Vault = {
      'weekly-review': [file('2025-W37-weekly-review.md')],
      diary: path === 'diary' ? [] : [dir('2025')],
      [path]: [file('2025-09-09.timeline.md')],
    }
    const host = mockHost(vault)
    app = mount(App, { target: document.body })
    await vi.waitFor(() => expect(timeline(9, 9)).not.toBeNull())
    vault[path] = [file('2025-09-10.timeline.md')]
    button('↻ 重构').click()
    await vi.waitFor(() => {
      expect(timeline(9, 9)).toBeNull()
      expect(timeline(9, 10)).not.toBeNull()
    })
    timeline(9, 10)!.click()
    expect(host.opened).toEqual([`${path}/2025-09-10.timeline.md`])

    vault[path] = []
    button('↻ 重构').click()
    await vi.waitFor(() => expect(timeline(9, 10)).toBeNull())
    expect(document.querySelectorAll('button[aria-label="打开时间线"]')).toHaveLength(0)
  })
})
