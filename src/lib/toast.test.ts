import { describe, it, expect, beforeEach, vi } from 'vitest'
import { toasts, pushToast, dismissToast, clearToasts } from './toast.svelte'

describe('toast queue', () => {
  beforeEach(() => clearToasts())

  it('starts empty', () => {
    expect(toasts.list).toEqual([])
  })

  it('pushes a toast and assigns a unique id', () => {
    const id1 = pushToast({ level: 'success', message: 'a' })
    const id2 = pushToast({ level: 'error', message: 'b' })
    expect(toasts.list.length).toBe(2)
    expect(id1).not.toBe(id2)
    expect(toasts.list[0].message).toBe('a')
  })

  it('dismisses a toast by id', () => {
    const id = pushToast({ level: 'info', message: 'x' })
    dismissToast(id)
    expect(toasts.list).toEqual([])
  })

  it('truncates messages at 200 chars and details at 2KB', () => {
    const longMsg = 'a'.repeat(500)
    const longDetail = 'b'.repeat(5000)
    pushToast({ level: 'info', message: longMsg, detail: longDetail })
    expect(toasts.list[0].message.length).toBe(200)
    expect(toasts.list[0].detail!.length).toBe(2048)
  })

  it('auto-dismisses after the configured timeout', async () => {
    vi.useFakeTimers()
    pushToast({ level: 'success', message: 'z', autoDismissMs: 3000 })
    expect(toasts.list.length).toBe(1)
    vi.advanceTimersByTime(3000)
    expect(toasts.list).toEqual([])
    vi.useRealTimers()
  })
})
