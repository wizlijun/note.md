// mdrelay/tests/ws-host.test.ts
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function pairAndClaim(hostname = "test") {
  const create = await (await SELF.fetch("https://x/pair/create", { method: "POST" })).json() as { code: string; pairingId: string };
  const host = await (await SELF.fetch("https://x/pair/host-bootstrap", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingId: create.pairingId }),
  })).json() as { device_token: string };
  const remote = await (await SELF.fetch("https://x/pair/claim", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: create.code, hostname }),
  })).json() as { device_token: string; deviceId: string };
  return { hostToken: host.device_token, remoteToken: remote.device_token, pairingId: create.pairingId, remoteDeviceId: remote.deviceId };
}

async function openWS(role: "host" | "remote", token: string): Promise<WebSocket> {
  const resp = await SELF.fetch(`https://x/ws/${role}?token=${encodeURIComponent(token)}`, {
    headers: { upgrade: "websocket", connection: "upgrade" },
  });
  if (resp.status !== 101) throw new Error("ws upgrade failed: " + resp.status);
  const ws = resp.webSocket!;
  ws.accept();
  return ws;
}

describe("ws fan-out", () => {
  it("host→remote and remote→host messages are routed", async () => {
    const tokens = await pairAndClaim();
    const hostWs = await openWS("host", tokens.hostToken);
    const remoteWs = await openWS("remote", tokens.remoteToken);

    const remoteRecv: string[] = [];
    remoteWs.addEventListener("message", (e) => remoteRecv.push(typeof e.data === "string" ? e.data : ""));

    hostWs.send(JSON.stringify({ to: `remote:${tokens.remoteDeviceId.split(":")[1]}`, from: "host", type: "agent.message.end", text: "hi from host" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(remoteRecv.length).toBe(1);
    expect(remoteRecv[0]).toContain("hi from host");

    const hostRecv: string[] = [];
    hostWs.addEventListener("message", (e) => hostRecv.push(typeof e.data === "string" ? e.data : ""));
    remoteWs.send(JSON.stringify({ to: "host", from: tokens.remoteDeviceId, type: "user.message", text: "hello back" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(hostRecv.length).toBe(1);
    expect(hostRecv[0]).toContain("hello back");

    hostWs.close(); remoteWs.close();
  });

  it("rejects ws with invalid token", async () => {
    const resp = await SELF.fetch("https://x/ws/host?token=bad", {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    expect(resp.status).toBe(401);
  });
});
