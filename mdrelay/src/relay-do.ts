// mdrelay/src/relay-do.ts
import type { Env } from "./index.js";

interface PendingPair {
  pairingId: string;
  expiresAt: number;
}

export class RelayDO implements DurableObject {
  private static MAX_FRAMES = 50;
  private static MAX_BYTES = 1024 * 1024;
  private static MAX_AGE_MS = 24 * 60 * 60 * 1000;

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/pending/put":  return this.pendingPut(req);
      case "/pending/pop":  return this.pendingPop(req);
      case "/notify-claim": return this.notifyClaim(req);
      case "/ws":           return this.handleWs(req);
      default: return new Response("not found", { status: 404 });
    }
  }

  private async handleWs(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const role = url.searchParams.get("role") as "host" | "remote";
    // deviceId from the token may be "host" or "remote:<id>". Normalise to a
    // short id (strip the "remote:" prefix) so the tag is always "role:shortId".
    const rawDevice = url.searchParams.get("device") ?? "";
    const shortId = rawDevice.startsWith("remote:") ? rawDevice.slice("remote:".length) : rawDevice;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, [`${role}:${shortId}`]);
    await this.drainBuffer(server, shortId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.state.getTags(ws);
    const senderTag = tags[0] ?? "";
    const [, senderDeviceId] = senderTag.split(":");

    let text: string;
    if (typeof message === "string") text = message;
    else { text = new TextDecoder().decode(message); }

    let obj: Record<string, unknown>;
    try { obj = JSON.parse(text); } catch { return; }
    const to = typeof obj.to === "string" ? obj.to : null;
    if (!to) return;

    if (to === "broadcast") {
      this.broadcastExcept(senderDeviceId, text);
    } else if (to === "host") {
      await this.deliverOrBuffer("host", text);
    } else if (to.startsWith("remote:")) {
      await this.deliverOrBuffer(to.slice("remote:".length), text);
    }
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // hibernation handles reconnects; nothing to do.
  }

  private getSocketsByDevice(deviceId: string): WebSocket[] {
    const all = this.state.getWebSockets();
    return all.filter((ws) => {
      const tags = this.state.getTags(ws);
      if (deviceId === "host") return tags.some((t) => t === "host:host");
      return tags.some((t) => t === `remote:${deviceId}`);
    });
  }

  private broadcastExcept(senderDeviceId: string, text: string): void {
    const all = this.state.getWebSockets();
    for (const ws of all) {
      const tags = this.state.getTags(ws);
      const tag = tags[0] ?? "";
      // Don't echo a broadcast back to its sender:
      // - host-sent broadcast: skip the host socket
      // - remote-sent broadcast: skip that specific remote (matched on next line)
      if (tag === `host:host` && senderDeviceId === "host") continue;
      if (tag === `remote:${senderDeviceId}`) continue;
      try { ws.send(text); } catch { /* hibernated dropouts are recovered next message */ }
    }
  }

  private async deliverOrBuffer(deviceId: string, text: string): Promise<void> {
    const sockets = this.getSocketsByDevice(deviceId);
    let delivered = 0;
    for (const ws of sockets) {
      try {
        ws.send(text);
        delivered++;
      } catch { /* this socket failed; try others */ }
    }
    if (delivered === 0) {
      await this.pushBuffer(deviceId, text);
    }
  }

  private bufferKey(deviceId: string): string { return `buf:${deviceId}`; }

  private async pushBuffer(deviceId: string, text: string): Promise<void> {
    const key = this.bufferKey(deviceId);
    const buf = (await this.state.storage.get<{ ts: number; text: string }[]>(key)) ?? [];
    const now = Date.now();
    buf.push({ ts: now, text });

    // Age-based pruning.
    while (buf.length > 0 && now - buf[0].ts > RelayDO.MAX_AGE_MS) buf.shift();

    // Frame-count pruning.
    while (buf.length > RelayDO.MAX_FRAMES) buf.shift();

    // Byte-cap pruning.
    let bytes = buf.reduce((acc, f) => acc + f.text.length, 0);
    while (bytes > RelayDO.MAX_BYTES && buf.length > 0) {
      bytes -= buf[0].text.length;
      buf.shift();
    }

    await this.state.storage.put(key, buf);
  }

  private async drainBuffer(ws: WebSocket, deviceId: string): Promise<void> {
    const key = this.bufferKey(deviceId);
    const buf = (await this.state.storage.get<{ ts: number; text: string }[]>(key)) ?? [];
    if (buf.length === 0) return;
    await this.state.storage.delete(key);
    for (const f of buf) {
      try { ws.send(f.text); } catch { break; }
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
