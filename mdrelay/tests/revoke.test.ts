// mdrelay/tests/revoke.test.ts
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("device revoke", () => {
  it("revoked remote token cannot reconnect", async () => {
    // pair
    const create = await (await SELF.fetch("https://x/pair/create", { method: "POST" })).json() as { code: string; pairingId: string };
    const host = await (await SELF.fetch("https://x/pair/host-bootstrap", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId: create.pairingId }),
    })).json() as { device_token: string };
    const remote = await (await SELF.fetch("https://x/pair/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: create.code }),
    })).json() as { device_token: string; deviceId: string };

    // host revokes the remote
    const rev = await SELF.fetch("https://x/device/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + host.device_token },
      body: JSON.stringify({ deviceId: remote.deviceId }),
    });
    expect(rev.status).toBe(200);

    // remote tries to open ws
    const resp = await SELF.fetch(`https://x/ws/remote?token=${encodeURIComponent(remote.device_token)}`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    expect(resp.status).toBe(403);
  });

  it("rejects revoke from non-host", async () => {
    const resp = await SELF.fetch("https://x/device/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer not-a-real-token" },
      body: JSON.stringify({ deviceId: "remote:x" }),
    });
    expect(resp.status).toBe(401);
  });
});
