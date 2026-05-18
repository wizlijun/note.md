// mdrelay/src/relay-do.ts
import type { Env } from "./index.js";

interface PendingPair {
  pairingId: string;
  expiresAt: number;
}

export class RelayDO implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/pending/put":  return this.pendingPut(req);
      case "/pending/pop":  return this.pendingPop(req);
      case "/notify-claim": return this.notifyClaim(req);
      default: return new Response("not found", { status: 404 });
    }
  }

  private async pendingPut(req: Request): Promise<Response> {
    const body = await req.json() as { code: string; pairingId: string; expiresAt: number };
    await this.state.storage.put(`pending:${body.code}`, {
      pairingId: body.pairingId,
      expiresAt: body.expiresAt,
    } satisfies PendingPair);
    await this.scheduleAlarm();
    return new Response("ok");
  }

  /** Schedule a GC alarm; call this from production bootstrap if desired. */
  private async scheduleAlarm(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }

  private async pendingPop(req: Request): Promise<Response> {
    const body = await req.json() as { code: string };
    const pending = await this.state.storage.get<PendingPair>(`pending:${body.code}`);
    if (!pending) return new Response("not found", { status: 404 });
    if (pending.expiresAt < Date.now()) {
      await this.state.storage.delete(`pending:${body.code}`);
      return new Response("expired", { status: 404 });
    }
    await this.state.storage.delete(`pending:${body.code}`);
    return new Response(JSON.stringify(pending), { headers: { "content-type": "application/json" } });
  }

  private async notifyClaim(req: Request): Promise<Response> {
    const body = await req.json() as { deviceId: string; hostname: string };
    const list = (await this.state.storage.get<unknown[]>("pending-claims")) ?? [];
    list.push({ ...body, at: Date.now() });
    await this.state.storage.put("pending-claims", list);
    return new Response("ok");
  }

  async alarm(): Promise<void> {
    const all = await this.state.storage.list<PendingPair>({ prefix: "pending:" });
    const now = Date.now();
    for (const [key, value] of all) {
      if (value.expiresAt < now) await this.state.storage.delete(key);
    }
  }
}
