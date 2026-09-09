import { describe, expect, it } from 'vitest'
import { formatDuration, formatTime, layoutTimeline, PIXELS_PER_MINUTE } from './layout'
import type { TimelineItem } from './parser'

const item = (id: string, start: number, end: number): TimelineItem => ({ id, start, end, action: '开发', text: id, links: [], children: [] })

describe('timeline layout', () => {
  it('uses the first and last visible hour and positions by elapsed time', () => {
    const result = layoutTimeline([item('later', 690, 750), item('first', 555, 600)])
    expect(result.ticks).toEqual([540, 600, 660, 720, 780])
    expect(result.blocks[0]).toMatchObject({ top: 15 * PIXELS_PER_MINUTE, height: 45 * PIXELS_PER_MINUTE - 3, column: 0, columns: 1 })
    expect(result.blocks[1].top).toBe(150 * PIXELS_PER_MINUTE)
  })

  it('avoids collisions for overlaps, zero-duration and short events and reuses lanes', () => {
    const events = [item('long', 540, 620), item('short', 542, 542), item('next', 545, 546), item('reuse', 590, 605), item('separate', 720, 780)]
    const { blocks } = layoutTimeline(events)
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j]
      if (a.column === b.column) expect(Math.min(a.top + a.height, b.top + b.height)).toBeLessThanOrEqual(Math.max(a.top, b.top))
    }
    expect(blocks.find((block) => block.item.id === 'reuse')?.column).toBe(1)
    expect(blocks.slice(0, 4).map((block) => block.columns)).toEqual([3, 3, 3, 3])
    expect(blocks[4].columns).toBe(1)
  })

  it('keeps midnight continuation and second precision visible', () => {
    expect(formatTime(1440)).toBe('00:00 +1')
    expect(formatTime(540.5)).toBe('09:00:30')
    expect(formatDuration(item('x', 540, 540.5), true)).toBe('30 秒')
    expect(formatDuration(item('x', 540, 630), false)).toBe('1h 30m')
    expect(layoutTimeline([item('night', 1430, 1470)]).ticks).toEqual([1380, 1440, 1500])
  })

  it('handles empty days without inventing a time range', () => {
    expect(layoutTimeline([])).toEqual({ blocks: [], ticks: [], height: 0, columns: 1 })
  })
})
