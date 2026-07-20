// src/lib/openclaw/client.svelte.ts — v2 bridge port of the chat state machine.
//
// Verbatim from v1 except the command/listen wiring: start() installs ONE
// onMessage dispatcher (commands.startBridge) and registers frame/status/error
// subscribers, instead of three separate `await listen(...)` streams.

import { connect, disconnect, send, onFrame, onStatus, onError, startBridge } from './commands'
import type { Frame, Message, PoolSession } from './protocol'

// v1 opened received files in the host editor via a Tauri command. A standalone
// plugin window has no editor to open into, so `agent.file_content` frames are
// logged and dropped until the settings-tab bound mode lands (P2.9).
async function openRemoteFile(path: string, _content: string): Promise<void> {
  console.info('[openclaw] agent.file_content received (no editor in v2 window):', path)
}

export const state = $state({
  status: 'idle' as 'idle' | 'connecting' | 'connected' | 'disconnected',
  sessions: [] as PoolSession[],
  currentSessionId: null as string | null,
  messagesBySession: {} as Record<string, Message[]>,
  error: null as string | null,
})

let unsubFrame: (() => void) | null = null
let unsubStatus: (() => void) | null = null
let unsubError: (() => void) | null = null

export async function start(): Promise<string> {
  startBridge()
  unsubFrame = onFrame(handleFrame)
  unsubStatus = onStatus((s) => { state.status = (s.startsWith('disconnected') ? 'disconnected' : (s as typeof state.status)) })
  unsubError = onError((e) => { state.error = e })
  const mode = await connect()  // 'host' | 'remote'
  await send({ type: 'session.list' })
  return mode
}

export async function stop(): Promise<void> {
  await disconnect()
  unsubFrame?.(); unsubStatus?.(); unsubError?.()
}

function ensureBucket(sid: string): Message[] {
  if (!state.messagesBySession[sid]) state.messagesBySession[sid] = []
  return state.messagesBySession[sid]
}

function handleFrame(f: Frame): void {
  switch (f.type) {
    case 'session.list.result':
      state.sessions = f.sessions
      if (f.focus) state.currentSessionId = f.focus
      else if (!state.currentSessionId && f.sessions[0]) state.currentSessionId = f.sessions[0].id
      break
    case 'agent.message.delta': {
      const bucket = ensureBucket(f.session)
      let m = bucket.find((x) => x.id === f.msg_id)
      if (!m) { m = { id: f.msg_id, role: 'agent', text: '', streaming: true }; bucket.push(m) }
      m.text += f.text
      m.streaming = true
      break
    }
    case 'agent.message.end': {
      const bucket = ensureBucket(f.session)
      let m = bucket.find((x) => x.id === f.msg_id)
      if (!m) { m = { id: f.msg_id, role: 'agent', text: f.text, streaming: false }; bucket.push(m) }
      else { m.text = f.text || m.text; m.streaming = false }
      break
    }
    case 'agent.file_content': {
      void openRemoteFile(f.path, f.content)
      break
    }
  }
}

export async function sendUserMessage(text: string): Promise<void> {
  const sid = state.currentSessionId
  if (!sid) {
    await send({ type: 'session.new', title: text.slice(0, 40) })
    return
  }
  const msgId = 'm-' + Math.random().toString(36).slice(2, 10)
  ensureBucket(sid).push({ id: msgId, role: 'user', text, streaming: false })
  await send({ type: 'user.message', session: sid, text })
}

export async function newSession(title?: string): Promise<void> {
  await send({ type: 'session.new', title })
}

export async function openSession(id: string): Promise<void> {
  state.currentSessionId = id
  await send({ type: 'session.replay', id })
}
