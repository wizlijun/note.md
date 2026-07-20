// src/lib/openclaw/commands.ts — v2 bridge port of the v1 Tauri command layer.
//
// v1 used `invoke('openclaw_X', args)` + three `listen('openclaw://…')` streams.
// v2 has ONE channel each way:
//  · UI → process: `request('X', params)` (bridge prefixes `plugin.`; the host
//    forwards to the backend process, which sees the clean method name).
//  · process → UI: a SINGLE `onMessage` dispatcher fans the `{kind, data}`
//    envelope out to the frame/status/error/pending-claim subscribers.
//
// Backend params are snake_case (device_id / bytes_b64 / …) — the bridge passes
// them through verbatim, so we no longer rely on Tauri's camelCase conversion.

import { request, onMessage, type HostMessage } from '../bridge'
import type { Frame } from './protocol'

// ── UI → backend requests ────────────────────────────────────────────────────

export async function connect(): Promise<string> {
  return request('connect') // 'host' | 'remote'
}

export async function disconnect(): Promise<void> {
  await request('disconnect')
}

export async function send(frame: Frame): Promise<void> {
  await request('send', { frame })
}

// ── process → UI fan-out ─────────────────────────────────────────────────────
//
// Subscribers register a callback and get an unsubscribe fn (matching the v1
// listen() shape so client.svelte / PendingClaimToast keep their teardown).

type Cb<T> = (v: T) => void

const frameCbs = new Set<Cb<Frame>>()
const statusCbs = new Set<Cb<string>>()
const errorCbs = new Set<Cb<string>>()
const pendingCbs = new Set<Cb<unknown>>()

let dispatcherInstalled = false

/** Route one backend `{kind, data}` push to the matching subscriber set. */
function routeByKind(m: HostMessage): void {
  switch (m.kind) {
    case 'frame':
      frameCbs.forEach((cb) => cb(m.data as Frame))
      break
    case 'status':
      statusCbs.forEach((cb) => cb(String(m.data)))
      break
    case 'error':
      errorCbs.forEach((cb) => cb(String(m.data)))
      break
    case 'pending-claim':
      pendingCbs.forEach((cb) => cb(m.data))
      break
    default:
      // relay-status / relay-error etc. are informational; ignore unknown kinds.
      break
  }
}

/**
 * Install the ONE `onMessage` dispatcher. Idempotent — the host's `onMessage`
 * appends a listener each call, so we must register exactly once for the window
 * lifetime (subscribers come and go via the Set registries above).
 */
export function startBridge(): void {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  onMessage(routeByKind)
}

export function onFrame(cb: Cb<Frame>): () => void {
  frameCbs.add(cb)
  return () => frameCbs.delete(cb)
}

export function onStatus(cb: Cb<string>): () => void {
  statusCbs.add(cb)
  return () => statusCbs.delete(cb)
}

export function onError(cb: Cb<string>): () => void {
  errorCbs.add(cb)
  return () => errorCbs.delete(cb)
}

export function onPendingClaimMsg(cb: Cb<unknown>): () => void {
  pendingCbs.add(cb)
  return () => pendingCbs.delete(cb)
}
