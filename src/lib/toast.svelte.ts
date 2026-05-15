import type { ToastLevel } from './plugins/types'
import { settings } from './settings.svelte'

export interface ToastItem {
  id: number
  level: ToastLevel
  message: string
  detail?: string
}

interface PushOpts {
  level: ToastLevel
  message: string
  detail?: string
  /** ms before auto-dismiss; 0 = sticky. If omitted, falls back to the
   *  global `settings.toastAutoClose` preference (on → 4000ms, off → 0). */
  autoDismissMs?: number
}

export const TOAST_AUTO_DISMISS_MS = 4000

export const toasts = $state<{ list: ToastItem[] }>({ list: [] })

let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

const MSG_MAX = 200
const DETAIL_MAX = 2048

export function pushToast(opts: PushOpts): number {
  const id = nextId++
  const item: ToastItem = {
    id,
    level: opts.level,
    message: opts.message.slice(0, MSG_MAX),
    detail: opts.detail ? opts.detail.slice(0, DETAIL_MAX) : undefined,
  }
  toasts.list = [...toasts.list, item]
  const ms = opts.autoDismissMs ?? (settings.toastAutoClose ? TOAST_AUTO_DISMISS_MS : 0)
  if (ms > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), ms))
  }
  return id
}

export function dismissToast(id: number): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  toasts.list = toasts.list.filter((t) => t.id !== id)
}

export function scheduleAutoDismiss(id: number, ms: number): void {
  const existing = timers.get(id)
  if (existing) clearTimeout(existing)
  if (ms > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), ms))
  } else {
    timers.delete(id)
  }
}

export function clearToasts(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  toasts.list = []
  nextId = 1
}
