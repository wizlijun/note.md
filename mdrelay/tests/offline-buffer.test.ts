// mdrelay/tests/offline-buffer.test.ts
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function pairAndClaim() {
  const create = await (await SELF.fetch("https://x/pair/create", { method: "POST" })).json() as { code: string; pairingId: string };
  const host = await (await SELF.fetch("https://x/pair/host-bootstrap", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingId: create.pairingId }),
  })).json() as { device_token: string };
  const remote = await (await SELF.fetch("https://x/pair/claim", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: create.code }),
  })).json() as { device_token: string; deviceId: string };
  return { hostToken: host.device_token, remoteToken: remote.device_token, remoteDeviceId: remote.deviceId };
}

async function openWS(role: "host" | "remote", token: string): Promise<WebSocket> {
  const resp = await SELF.fetch(`https://x/ws/${role}?token=${encodeURIComponent(token)}`, {
    headers: { upgrade: "websocket", connection: "upgrade" },
  });
  const ws = resp.webSocket!; ws.accept(); return ws;
}

describe("offline buffer", () => {
  it("buffers host-bound messages when host is offline, drains on reconnect", async () => {
    const tokens = await pairAndClaim();
    const remoteWs = await openWS("remote", tokens.remoteToken);
    // Send while host is offline:
    remoteWs.send(JSON.stringify({ to: "host", from: tokens.remoteDeviceId, type: "user.message", text: "first" }));
    remoteWs.send(JSON.stringify({ to: "host", from: tokens.remoteDeviceId, type: "user.message", text: "second" }));
    await new Promise((r) => setTimeout(r, 50));

    // Host connects:
    const hostWs = await openWS("host", tokens.hostToken);
    const recv: string[] = [];
    hostWs.addEventListener("message", (e) => recv.push(typeof e.data === "string" ? e.data : ""));
    await new Promise((r) => setTimeout(r, 100));

    expect(recv.length).toBeGreaterThanOrEqual(2);
    expect(recv.some((x) => x.includes("first"))).toBe(true);
    expect(recv.some((x) => x.includes("second"))).toBe(true);

    hostWs.close(); remoteWs.close();
  });

  it("drops oldest when buffer exceeds 50 frames", async () => {
    const tokens = await pairAndClaim();
    const remoteWs = await openWS("remote", tokens.remoteToken);
    for (let i = 0; i < 55; i++) {
      remoteWs.send(JSON.stringify({ to: "host", from: tokens.remoteDeviceId, type: "user.message", text: `n${i}` }));
    }
    await new Promise((r) => setTimeout(r, 80));

    const hostWs = await openWS("host", tokens.hostToken);
    const recv: string[] = [];
    hostWs.addEventListener("message", (e) => recv.push(typeof e.data === "string" ? e.data : ""));
    await new Promise((r) => setTimeout(r, 100));

    expect(recv.length).toBeLessThanOrEqual(50);
    expect(recv.some((x) => x.includes("n0"))).toBe(false);    // dropped
    expect(recv.some((x) => x.includes("n54"))).toBe(true);    // kept

    hostWs.close(); remoteWs.close();
  });
});
