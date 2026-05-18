// src/lib/openclaw/commands.ts
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Frame } from './protocol'

export async function connect(): Promise<string> {
  return invoke('openclaw_connect')
}

export async function disconnect(): Promise<void> {
  return invoke('openclaw_disconnect')
}

export async function send(frame: Frame): Promise<void> {
  return invoke('openclaw_send', { frame })
}

export async function onFrame(cb: (f: Frame) => void): Promise<UnlistenFn> {
  return listen<Frame>('openclaw://frame', (e) => cb(e.payload))
}

export async function onStatus(cb: (s: string) => void): Promise<UnlistenFn> {
  return listen<string>('openclaw://status', (e) => cb(e.payload))
}

export async function onError(cb: (s: string) => void): Promise<UnlistenFn> {
  return listen<string>('openclaw://error', (e) => cb(e.payload))
}
