import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from './Page.svelte'

const { loadPage } = vi.hoisted(() => ({ loadPage: vi.fn() }))
vi.mock('../lib/bridge', () => ({ loadPage }))

describe('page viewport lifecycle', () => {
  let component: ReturnType<typeof mount> | undefined
  let notify: IntersectionObserverCallback
  let observer: IntersectionObserver
  const createObjectURL = vi.fn(() => 'blob:page')
  const revokeObjectURL = vi.fn()
  const disconnect = vi.fn()

  beforeEach(() => {
    loadPage.mockReset()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    disconnect.mockClear()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; observer = this as unknown as IntersectionObserver }
      observe() {}
      disconnect = disconnect
    })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
  })

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  async function setup() {
    component = mount(Page, { target: document.body, props: { cacheKey: 'cache', index: 3, label: '第 4 页' } })
    await tick()
  }

  function intersect(isIntersecting: boolean) {
    notify([{ target: document.querySelector('article')!, isIntersecting } as unknown as IntersectionObserverEntry], observer)
  }

  it('fetches only near the viewport, releases blobs on exit and reloads on return', async () => {
    loadPage.mockResolvedValue('<svg></svg>')
    await setup()
    expect(loadPage).not.toHaveBeenCalled()
    intersect(true)
    await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    expect(loadPage).toHaveBeenCalledWith('cache', 3)
    intersect(false)
    await tick()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:page')
    expect(document.querySelector('img')).toBeNull()
    intersect(true)
    await vi.waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2))
    await tick()
    expect(document.querySelector('img')).not.toBeNull()
    await unmount(component!)
    component = undefined
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it.each(['unmount', 'exit'] as const)('never creates a blob from late data after %s', async action => {
    let finish!: (svg: string) => void
    loadPage.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await setup()
    intersect(true)
    if (action === 'unmount') {
      await unmount(component!)
      component = undefined
    } else intersect(false)
    finish('<svg></svg>')
    await tick()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('shows a failed page request and can retry without remounting', async () => {
    loadPage.mockRejectedValueOnce(new Error('Page unavailable')).mockResolvedValueOnce('<svg></svg>')
    await setup()
    intersect(true)
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Page unavailable'))
    document.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    expect(loadPage).toHaveBeenCalledTimes(2)
  })
})
