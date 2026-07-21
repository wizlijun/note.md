import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { LogLine } from './console-bridge'

export const MAX_LINES = 3000

/** Cap to the newest MAX_LINES; identity when already under the cap. */
export function capLines(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines
}

export function createLogsStore() {
  let lines = $state<LogLine[]>([])
  let categoryFilter = $state<string>('all')

  async function start(): Promise<() => void> {
    const snap = await invoke<LogLine[]>('logs_get_snapshot').catch(() => [] as LogLine[])
    lines = capLines(snap)
    const unLine = await listen<LogLine>('log://line', (e) => {
      lines = capLines([...lines, e.payload])
    })
    const unFilter = await listen<string>('nav://logs-filter', (e) => {
      categoryFilter = e.payload
    })
    return () => { unLine(); unFilter() }
  }

  async function clear(): Promise<void> {
    lines = []
    await invoke('logs_clear').catch(() => {})
  }

  return {
    get lines() { return lines },
    get categoryFilter() { return categoryFilter },
    set categoryFilter(v: string) { categoryFilter = v },
    start,
    clear,
  }
}
