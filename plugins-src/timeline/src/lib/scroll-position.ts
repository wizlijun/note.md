import { PIXELS_PER_MINUTE } from './layout'

export function timelineScrollTop(targetMinute: number, timelineStart: number, contentTop: number, maximum: number): number {
  const desired = contentTop + (targetMinute - timelineStart) * PIXELS_PER_MINUTE
  return Math.min(Math.max(0, desired), Math.max(0, maximum))
}

/** Align the requested wall-clock time with the visible top of the schedule. */
export function scrollTimelineToMinute(scroller: HTMLElement, schedule: HTMLElement, targetMinute: number, timelineStart: number): void {
  const maximum = scroller.scrollHeight - scroller.clientHeight
  scroller.scrollTop = timelineScrollTop(targetMinute, timelineStart, schedule.offsetTop + 16, maximum)
}
