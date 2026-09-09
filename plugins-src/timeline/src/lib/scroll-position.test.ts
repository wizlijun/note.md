import { describe, expect, it } from 'vitest'
import { scrollTimelineToMinute, timelineScrollTop } from './scroll-position'

function rectAt(top: number): DOMRect {
  return { x: 0, y: top, top, right: 0, bottom: top, left: 0, width: 0, height: 0, toJSON: () => ({}) }
}

describe('timeline opening position', () => {
  it('maps the requested time and clamps it to the scrollable range', () => {
    expect(timelineScrollTop(9 * 60, 8 * 60, 16, 1000)).toBe(112)
    expect(timelineScrollTop(7 * 60, 8 * 60, 16, 1000)).toBe(0)
    expect(timelineScrollTop(23 * 60, 8 * 60, 16, 900)).toBe(900)
  })

  it('ignores page chrome above the scroll container when positioning the schedule', () => {
    const scroller = document.createElement('div')
    const schedule = document.createElement('div')
    Object.defineProperties(scroller, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 } })
    Object.defineProperties(scroller, { getBoundingClientRect: { value: () => rectAt(192) } })
    Object.defineProperties(schedule, {
      offsetTop: { value: 207 },
      getBoundingClientRect: { value: () => rectAt(207) },
    })
    scrollTimelineToMinute(scroller, schedule, 9 * 60, 8 * 60)
    expect(scroller.scrollTop).toBe(127)
  })

  it('keeps the same target when repositioning a container that was already scrolled', () => {
    const scroller = document.createElement('div')
    const schedule = document.createElement('div')
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1200 },
      clientHeight: { value: 400 },
      getBoundingClientRect: { value: () => rectAt(192) },
    })
    Object.defineProperties(schedule, {
      offsetTop: { value: 207 },
      getBoundingClientRect: { value: () => rectAt(-135) },
    })
    scroller.scrollTop = 342
    scrollTimelineToMinute(scroller, schedule, 9 * 60, 8 * 60)
    expect(scroller.scrollTop).toBe(127)
  })
})
