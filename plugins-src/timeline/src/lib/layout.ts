import type { TimelineItem } from './parser'

export interface TimelineBlock {
  item: TimelineItem
  top: number
  height: number
  column: number
  columns: number
}

export const PIXELS_PER_MINUTE = 1.6
const MIN_BLOCK_HEIGHT = 38

/** Lay out visible intervals, including the minimum hit area of short events. */
export function layoutTimeline(items: TimelineItem[]) {
  if (!items.length) return { blocks: [] as TimelineBlock[], ticks: [] as number[], height: 0, columns: 1 }
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end)
  const start = Math.floor(sorted[0].start / 60) * 60
  const blocks: TimelineBlock[] = []
  let cluster: TimelineBlock[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity
  let maxBottom = 0
  let columns = 1

  function finishCluster() {
    for (const block of cluster) block.columns = laneEnds.length
    columns = Math.max(columns, laneEnds.length)
    cluster = []
    laneEnds = []
  }

  for (const item of sorted) {
    const top = (item.start - start) * PIXELS_PER_MINUTE
    const height = Math.max(MIN_BLOCK_HEIGHT, (item.end - item.start) * PIXELS_PER_MINUTE - 3)
    // A 3px gutter also keeps adjacent short cards visually separate.
    if (top >= clusterEnd) finishCluster()
    let column = laneEnds.findIndex((end) => end <= top)
    if (column < 0) column = laneEnds.length
    laneEnds[column] = top + height + 3
    clusterEnd = Math.max(clusterEnd, top + height + 3)
    const block = { item, top, height, column, columns: 1 }
    blocks.push(block)
    cluster.push(block)
    maxBottom = Math.max(maxBottom, top + height)
  }
  finishCluster()
  const end = start + Math.ceil(maxBottom / PIXELS_PER_MINUTE / 60) * 60
  const ticks: number[] = []
  for (let minute = start; minute <= end; minute += 60) ticks.push(minute)
  return { blocks, ticks, height: (end - start) * PIXELS_PER_MINUTE, columns }
}

export function formatTime(minute: number): string {
  const seconds = Math.round(minute * 60)
  const day = Math.floor(seconds / 86400)
  const time = `${String(Math.floor(seconds / 3600) % 24).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}`
  const precise = seconds % 60 ? `${time}:${String(seconds % 60).padStart(2, '0')}` : time
  return day ? `${precise} +${day}` : precise
}

export function formatDuration(item: Pick<TimelineItem, 'start' | 'end'>, zh: boolean): string {
  const seconds = Math.max(0, Math.round((item.end - item.start) * 60))
  if (seconds < 60) return zh ? `${seconds} 秒` : `${seconds}s`
  const minutes = Math.round(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return zh ? `${minutes} 分钟` : `${minutes}m`
  return zh ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${hours}h${rest ? ` ${rest}m` : ''}`
}
