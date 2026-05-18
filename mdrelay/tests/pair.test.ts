// mdrelay/tests/pair.test.ts
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("pairing endpoints", () => {
  it("create returns code + pairingId", async () => {
    const r = await SELF.fetch("https://x/pair/create", { method: "POST" });
    expect(r.status).toBe(200);
    const body = await r.json() as { code: string; pairingId: string; expiresAt: number };
    expect(body.code).toMatch(/^[0-9a-f]{3}(-[0-9a-f]{3}){5}$/);
    expect(body.pairingId).toMatch(/^p-[0-9a-f]{16}$/);
  });

  it("claim with valid code returns device_token", async () => {
    const create = await (await SELF.fetch("https://x/pair/create", { method: "POST" })).json() as { code: string; pairingId: string };
    const claim = await SELF.fetch("https://x/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: create.code, hostname: "test-remote" }),
    });
    expect(claim.status).toBe(200);
    const body = await claim.json() as { device_token: string; pairingId: string; deviceId: string };
    expect(body.pairingId).toBe(create.pairingId);
    expect(body.deviceId).toMatch(/^remote:/);
    expect(body.device_token).toContain(".");
  });

  it("claim with invalid code returns 404", async () => {
    const r = await SELF.fetch("https://x/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "000-000-000-000-000-000" }),
    });
    expect(r.status).toBe(404);
  });

  it("claim twice fails (single-use)", async () => {
    const create = await (await SELF.fetch("https://x/pair/create", { method: "POST" })).json() as { code: string };
    await SELF.fetch("https://x/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: create.code }) });
    const r2 = await SELF.fetch("https://x/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: create.code }) });
    expect(r2.status).toBe(404);
  });
});
