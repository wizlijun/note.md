// src/lib/openclaw/protocol.ts
export interface PoolSession { id: string; title?: string; createdAt?: number; updatedAt?: number }

export type Frame =
  | { type: 'hello'; token: string; device: string }
  | { type: 'welcome'; channel_caps: string[] }
  | { type: 'user.message'; session: string; text: string; attachments?: unknown[] }
  | { type: 'user.cancel'; session: string; msg_id: string }
  | { type: 'user.request_file'; session: string; path: string }
  | { type: 'agent.message.delta'; session: string; msg_id: string; text: string }
  | { type: 'agent.message.end'; session: string; msg_id: string; text: string; stop_reason?: string }
  | { type: 'agent.file_content'; session: string; path: string; content: string; media_type?: string }
  | { type: 'session.list' }
  | { type: 'session.list.result'; sessions: PoolSession[]; focus?: string }
  | { type: 'session.new'; title?: string }
  | { type: 'session.open'; id: string }
  | { type: 'session.replay'; id: string; after_msg_id?: string }

export interface Message {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  streaming?: boolean
}
