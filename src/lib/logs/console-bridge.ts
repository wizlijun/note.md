import { invoke } from '@tauri-apps/api/core'

export interface LogLine {
  ts: string
  source: string
  category: string
  level: string
  message: string
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return `${a.name}: ${a.message}`
  try { return JSON.stringify(a) } catch { return String(a) }
}

let patched = false

/** Idempotent. Patches console.* to also forward into the backend log bus.
 *  HARD RULE: call the native console first, then report; swallow report
 *  failures — otherwise a reporting error logs, which re-enters here → loop. */
export function installConsoleBridge(): void {
  if (patched) return
  patched = true
  const map = [
    ['debug', 'debug'],
    ['info', 'info'],
    ['info', 'log'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const
  for (const [level, method] of map) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      original(...args)
      const message = args.map(stringifyArg).join(' ')
      void invoke('logs_append_frontend', { level, message }).catch(() => {})
    }
  }
}
