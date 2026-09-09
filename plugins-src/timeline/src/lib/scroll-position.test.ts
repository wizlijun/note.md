import { describe, expect, it } from 'vitest'
import { scrollTimelineToMinute, timelineScrollTop } from './scroll-position'

describe('timeline opening position', () => {
  it('maps the requested time and clamps it to the scrollable range', () => {
    expect(timelineScrollTop(9 * 60, 8 * 60, 16, 1000)).toBe(112)
    expect(timelineScrollTop(7 * 60, 8 * 60, 16, 1000)).toBe(0)
    expect(timelineScrollTop(23 * 60, 8 * 60, 16, 900)).toBe(900)
  })

  it('positions the actual scroll container using the rendered schedule offset', () => {
    const scroller = document.createElement('div')
    const schedule = document.createElement('div')
    Object.defineProperties(scroller, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 } })
    Object.defineProperty(schedule, 'offsetTop', { value: 15 })
    scrollTimelineToMinute(scroller, schedule, 9 * 60, 8 * 60)
    expect(scroller.scrollTop).toBe(127)
  })
})
