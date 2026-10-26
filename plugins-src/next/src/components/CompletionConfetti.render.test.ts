// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import CompletionConfetti from './CompletionConfetti.svelte'

let component: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (component) unmount(component)
  component = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('CompletionConfetti', () => {
  it('shows decorative confetti briefly and removes it after 1800 ms', () => {
    vi.useFakeTimers()
    component = mount(CompletionConfetti, { target: document.body })
    flushSync()

    expect(document.querySelector('[data-completion-confetti]')?.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelectorAll('[data-completion-confetti] i').length).toBeGreaterThan(0)
    vi.advanceTimersByTime(1799)
    flushSync()
    expect(document.querySelector('[data-completion-confetti]')).toBeTruthy()
    vi.advanceTimersByTime(1)
    flushSync()
    expect(document.querySelector('[data-completion-confetti]')).toBeNull()
  })

  it('respects reduced-motion preferences and never renders an animation', () => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...media, matches: true })
    component = mount(CompletionConfetti, { target: document.body })
    flushSync()

    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(document.querySelector('[data-completion-confetti]')).toBeNull()
  })
})
