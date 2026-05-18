import { randomBytes } from "node:crypto";

export interface PoolMessage {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  ts?: number;
  attachments?: unknown[];
}

export interface PoolSession {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

export class SessionPool {
  private sessions = new Map<string, PoolSession>();
  private msgs = new Map<string, PoolMessage[]>();

  list(): PoolSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): PoolSession | undefined {
    return this.sessions.get(id);
  }

  create(title?: string): PoolSession {
    const id = "s-" + randomBytes(6).toString("hex");
    const now = Date.now();
    const s: PoolSession = { id, title, createdAt: now, updatedAt: now };
    this.sessions.set(id, s);
    this.msgs.set(id, []);
    return s;
  }

  // No-op if sessionId is unknown — session may have been evicted or never created.
  append(sessionId: string, msg: PoolMessage): void {
    const arr = this.msgs.get(sessionId);
    if (!arr) return;
    arr.push(msg);
    const s = this.sessions.get(sessionId);
    if (s) s.updatedAt = Date.now();
  }

  messages(sessionId: string): PoolMessage[] {
    return [...(this.msgs.get(sessionId) ?? [])];
  }

  // Returns messages STRICTLY after afterMsgId. Returns empty if afterMsgId is unknown (stale cursor) — caller should fall back to messages() if they want full replay.
  messagesAfter(sessionId: string, afterMsgId: string): PoolMessage[] {
    const arr = this.msgs.get(sessionId) ?? [];
    const idx = arr.findIndex((m) => m.id === afterMsgId);
    return idx < 0 ? [] : arr.slice(idx + 1);
  }
}
