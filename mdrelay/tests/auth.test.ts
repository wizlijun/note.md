// mdrelay/tests/auth.test.ts
import { describe, it, expect } from "vitest";
import { signDeviceToken, verifyDeviceToken, generatePairingCode } from "../src/auth.js";

const KEY = "test-signing-key-min-32-bytes-long-xx";

describe("device tokens", () => {
  it("signs and verifies", async () => {
    const payload = { pairingId: "p1", deviceId: "remote:abc", role: "remote" as const, issuedAt: Date.now() };
    const tok = await signDeviceToken(payload, KEY);
    expect(typeof tok).toBe("string");
    const parsed = await verifyDeviceToken(tok, KEY);
    expect(parsed?.deviceId).toBe("remote:abc");
    expect(parsed?.pairingId).toBe("p1");
  });

  it("rejects tampered token", async () => {
    const tok = await signDeviceToken({ pairingId: "p", deviceId: "remote:x", role: "remote", issuedAt: 0 }, KEY);
    const bad = tok.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
    const parsed = await verifyDeviceToken(bad, KEY);
    expect(parsed).toBeNull();
  });

  it("rejects token signed with different key", async () => {
    const tok = await signDeviceToken({ pairingId: "p", deviceId: "host", role: "host", issuedAt: 0 }, KEY);
    const parsed = await verifyDeviceToken(tok, "other-key-min-32-bytes-different-xx");
    expect(parsed).toBeNull();
  });
});

describe("pairing codes", () => {
  it("creates a 6-block hex code", () => {
    const pc = generatePairingCode();
    expect(pc.code).toMatch(/^[0-9a-f]{3}(-[0-9a-f]{3}){5}$/);
    expect(pc.pairingId).toMatch(/^p-[0-9a-f]{16}$/);
    expect(pc.expiresAt).toBeGreaterThan(Date.now());
  });
});
