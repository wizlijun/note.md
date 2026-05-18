# mdrelay Cloudflare Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Worker that brokers WSS connections between a single M↓ host (which holds the UDS link to OpenClaw) and N remote M↓ devices that have paired with that host. The worker authenticates devices via HMAC-signed tokens, fans messages across the host/remote pool through a Durable Object, and buffers messages destined for offline peers (≤ 1 MB / 50 frames / 24 h). No end-to-end encryption — WSS is the security layer; the worker can read all chat content.

**Architecture:** Single Cloudflare Worker (`mdeditor/mdrelay/`) using Durable Objects for stateful per-pairing fan-out. One DO instance per pairing. Pairing flow: host calls `/pair/create` → gets a 6-block hex code + DO id → remote calls `/pair/claim` with the code → DO admits the remote and issues a long-lived `device_token` (HMAC over `{pairing_id, device_id, role}`). WS endpoints `/ws/host` and `/ws/remote` accept a `?token=` query and hand the socket to the DO. The DO has a list of active WS objects per role and an offline buffer per device.

**Tech Stack:** TypeScript (ES2022), Cloudflare Workers runtime (matches existing `worker/` module: `wrangler ^3`, `@cloudflare/workers-types ^4`, vitest with `@cloudflare/vitest-pool-workers`). Durable Objects with hibernation API for cheap idle connections. `crypto.subtle.HMAC` for token signing.

**Spec:** `mdeditor/docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md` (commit `9f31934`). Section 3 + 3.5 + 3.6.

**Depends on:** Nothing — independently developable and testable using `wrangler dev` plus synthetic host/remote WS clients in `vitest`.

---

## File Structure

All paths relative to `/Users/bruce/git/mdeditor/`:

| Path | Responsibility |
|---|---|
| `mdrelay/package.json` | npm metadata; dev deps (wrangler, vitest, workers-types, vitest-pool-workers) |
| `mdrelay/wrangler.toml` | Worker name, compatibility date, Durable Object binding, secret bindings |
| `mdrelay/tsconfig.json` | TS settings; mirrors `worker/tsconfig.json` |
| `mdrelay/vitest.config.ts` | Tests run inside workerd via `@cloudflare/vitest-pool-workers` |
| `mdrelay/src/index.ts` | Fetch handler: routes (`/pair/*`, `/ws/host`, `/ws/remote`, `/device/revoke`, `/health`) |
| `mdrelay/src/auth.ts` | Generate/verify pairing codes and device tokens; HMAC-SHA256 wrapper |
| `mdrelay/src/pair.ts` | Pairing endpoints implementation (`POST /pair/create`, `POST /pair/claim`) |
| `mdrelay/src/relay-do.ts` | `RelayDO` Durable Object: WS fan-out, offline buffering, revocation |
| `mdrelay/src/envelope.ts` | Envelope schema (`{to, from, ...payload}`) + JSON-shape validators |
| `mdrelay/src/types.ts` | Shared TS types (`PairingMeta`, `DeviceRole`, etc.) |
| `mdrelay/tests/pair.test.ts` | Pair create/claim flow tests |
| `mdrelay/tests/ws-host.test.ts` | Host connects, remote connects, message round-trip |
| `mdrelay/tests/offline-buffer.test.ts` | Host offline → buffered → host reconnects → drain |
| `mdrelay/tests/revoke.test.ts` | Revoke kicks device |
| `mdrelay/README.md` | Deploy + secrets + curl smoke tests |

---

## Task 1: Scaffolding

**Files:**
- Create: `mdrelay/package.json`
- Create: `mdrelay/wrangler.toml`
- Create: `mdrelay/tsconfig.json`
- Create: `mdrelay/vitest.config.ts`
- Create: `mdrelay/src/index.ts`

- [ ] **Step 1: Make directory**

```bash
mkdir -p /Users/bruce/git/mdeditor/mdrelay/src /Users/bruce/git/mdeditor/mdrelay/tests
```

- [ ] **Step 2: Write `mdrelay/package.json`**

```json
{
  "name": "mdrelay",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "wrangler": "^3",
    "@cloudflare/workers-types": "^4",
    "@cloudflare/vitest-pool-workers": "^0.5",
    "typescript": "^5",
    "vitest": "^2.1"
  }
}
```

- [ ] **Step 3: Write `mdrelay/wrangler.toml`**

```toml
name = "mdrelay"
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "RELAY"
class_name = "RelayDO"

[[migrations]]
tag = "v1"
new_classes = ["RelayDO"]

# Secret SIGNING_KEY is set via:
#   wrangler secret put SIGNING_KEY
# Locally for dev, set in .dev.vars:
#   SIGNING_KEY=dev-only-key-do-not-deploy

# Custom domain (set after pointing DNS):
# routes = [
#   { pattern = "relay.example.com/*", custom_domain = true }
# ]
```

- [ ] **Step 4: Write `mdrelay/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 5: Write `mdrelay/vitest.config.ts`**

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
```

- [ ] **Step 6: Write `mdrelay/src/index.ts` (placeholder routes)**

```typescript
// mdrelay/src/index.ts
export interface Env {
  RELAY: DurableObjectNamespace;
  SIGNING_KEY: string;
}

export { RelayDO } from "./relay-do.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/health":
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      default:
        return new Response("not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 7: Write a stub `mdrelay/src/relay-do.ts` so the import resolves**

```typescript
// mdrelay/src/relay-do.ts
export class RelayDO {
  constructor(_state: DurableObjectState, _env: unknown) {}
  async fetch(_req: Request): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  }
}
```

- [ ] **Step 8: Add a dev secret file**

```bash
echo 'SIGNING_KEY=dev-key-do-not-deploy-32bytes-min' > /Users/bruce/git/mdeditor/mdrelay/.dev.vars
```

Also add `.dev.vars` to `.gitignore` at the project level if not already present:
```bash
grep -q '^\.dev\.vars$' /Users/bruce/git/mdeditor/.gitignore || echo '.dev.vars' >> /Users/bruce/git/mdeditor/.gitignore
```

- [ ] **Step 9: Install deps and verify wrangler dev boots**

```bash
cd /Users/bruce/git/mdeditor/mdrelay && pnpm install
cd /Users/bruce/git/mdeditor/mdrelay && pnpm dev &
sleep 4
curl -sf http://127.0.0.1:8787/health
kill %1
```
Expected: `{"ok":true}`.

- [ ] **Step 10: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add mdrelay .gitignore && git commit -m "feat(mdrelay): scaffold worker + DO binding"
```

---

## Task 2: Types + envelope schema

**Files:**
- Create: `mdrelay/src/types.ts`
- Create: `mdrelay/src/envelope.ts`

- [ ] **Step 1: Write `types.ts`**

```typescript
// mdrelay/src/types.ts
export type DeviceRole = "host" | "remote";

export interface PairingMeta {
  pairingId: string;
  createdAt: number;
  hostDeviceId: "host";
}

export interface DeviceTokenPayload {
  pairingId: string;
  deviceId: string;        // "host" or "remote:<id>"
  role: DeviceRole;
  issuedAt: number;
}

export interface PairingCode {
  code: string;            // 6 blocks of 3 hex chars, separated by -
  pairingId: string;
  expiresAt: number;       // ms
}

export interface BufferedFrame {
  to: string;              // routing destination ("host" or "remote:<id>" or "broadcast")
  from: string;
  pairingId: string;
  bytes: number;           // payload size for accounting
  body: string;            // raw JSON text (what we send over WS)
  ts: number;
}
```

- [ ] **Step 2: Write `envelope.ts`**

```typescript
// mdrelay/src/envelope.ts
export interface EnvelopeRouting {
  to: "host" | string;     // string = "remote:<deviceId>" or "broadcast"
  from: "host" | string;
}

export function isValidEnvelope(obj: unknown): obj is EnvelopeRouting & Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.to !== "string" || typeof o.from !== "string") return false;
  if (o.to !== "host" && o.to !== "broadcast" && !o.to.startsWith("remote:")) return false;
  if (o.from !== "host" && !o.from.startsWith("remote:")) return false;
  return true;
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add mdrelay && git commit -m "feat(mdrelay): types + envelope schema"
```

---

## Task 3: Auth — pairing codes + device tokens

**Files:**
- Create: `mdrelay/src/auth.ts`
- Create: `mdrelay/tests/auth.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd /Users/bruce/git/mdeditor/mdrelay && pnpm test tests/auth.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mdrelay/src/auth.ts`**

```typescript
// mdrelay/src/auth.ts
import type { DeviceTokenPayload, PairingCode } from "./types.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signDeviceToken(p: DeviceTokenPayload, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(p)));
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}

export async function verifyDeviceToken(token: string, secret: string): Promise<DeviceTokenPayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const key = await importKey(secret);
  let sigBytes: Uint8Array;
  try { sigBytes = b64urlDecode(sig); } catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(body));
  if (!ok) return null;
  try {
    const json = dec.decode(b64urlDecode(body));
    return JSON.parse(json) as DeviceTokenPayload;
  } catch { return null; }
}

const PAIRING_TTL_MS = 2 * 60 * 1000;

function hex(n: number): string {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generatePairingCode(): PairingCode {
  const blocks = Array.from({ length: 6 }, () => hex(2).slice(0, 3));
  return {
    code: blocks.join("-"),
    pairingId: "p-" + hex(8),
    expiresAt: Date.now() + PAIRING_TTL_MS,
  };
}
```

- [ ] **Step 4: Run, confirm pass**

```bash
cd /Users/bruce/git/mdeditor/mdrelay && pnpm test tests/auth.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add mdrelay && git commit -m "feat(mdrelay): hmac device tokens + pairing code gen"
```

---

## Task 4: Pairing endpoints

**Files:**
- Create: `mdrelay/src/pair.ts`
- Modify: `mdrelay/src/index.ts`
- Create: `mdrelay/tests/pair.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run, confirm fail**

Expected: 404s (routes not implemented yet).

- [ ] **Step 3: Implement `pair.ts`**

```typescript
// mdrelay/src/pair.ts
import { generatePairingCode, signDeviceToken } from "./auth.js";
import type { Env } from "./index.js";

const PENDING_KEY = (code: string) => `pair:${code}`;
const PENDING_TTL_MS = 2 * 60 * 1000;

interface PendingPair {
  pairingId: string;
  expiresAt: number;
}

// Pending pairs live in DO storage too (one DO per pairingId), but we also
// need a code → pairingId index keyed in a singleton DO so /pair/claim can
// look them up by code. We use a special DO id ("__pending_index__").
function pendingIndex(env: Env): DurableObjectStub {
  const id = env.RELAY.idFromName("__pending_index__");
  return env.RELAY.get(id);
}

export async function handlePairCreate(_req: Request, env: Env): Promise<Response> {
  const pc = generatePairingCode();
  await pendingIndex(env).fetch("https://do/pending/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pc.code, pairingId: pc.pairingId, expiresAt: pc.expiresAt }),
  });
  return new Response(JSON.stringify({
    code: pc.code,
    pairingId: pc.pairingId,
    expiresAt: pc.expiresAt,
  }), { headers: { "content-type": "application/json" } });
}

export async function handlePairClaim(req: Request, env: Env): Promise<Response> {
  let body: { code?: string; hostname?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  if (!body.code) return new Response("missing code", { status: 400 });

  const popResp = await pendingIndex(env).fetch("https://do/pending/pop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: body.code }),
  });
  if (popResp.status === 404) return new Response("invalid or expired code", { status: 404 });
  const pending = await popResp.json() as PendingPair;

  const deviceId = "remote:" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const token = await signDeviceToken({
    pairingId: pending.pairingId,
    deviceId,
    role: "remote",
    issuedAt: Date.now(),
  }, env.SIGNING_KEY);

  // Notify the host DO of the claim so it can push an "approval pending" event.
  const hostStub = env.RELAY.get(env.RELAY.idFromName(pending.pairingId));
  await hostStub.fetch("https://do/notify-claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, hostname: body.hostname ?? "unknown" }),
  });

  return new Response(JSON.stringify({
    pairingId: pending.pairingId,
    deviceId,
    device_token: token,
  }), { headers: { "content-type": "application/json" } });
}

export async function handleHostBootstrap(req: Request, env: Env): Promise<Response> {
  // Allow a host to obtain its own device_token if it doesn't have one yet.
  // (In production this is keyed off a host-side secret; for MVP we accept any caller.)
  const body = await req.json() as { pairingId: string };
  if (!body.pairingId) return new Response("missing pairingId", { status: 400 });
  const token = await signDeviceToken({
    pairingId: body.pairingId,
    deviceId: "host",
    role: "host",
    issuedAt: Date.now(),
  }, env.SIGNING_KEY);
  return new Response(JSON.stringify({ device_token: token }), { headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 4: Update `index.ts` to route pair endpoints**

Replace the body of `fetch`:

```typescript
import { handlePairCreate, handlePairClaim, handleHostBootstrap } from "./pair.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case "/health":
          return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
        case "/pair/create":
          if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
          return handlePairCreate(req, env);
        case "/pair/claim":
          if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
          return handlePairClaim(req, env);
        case "/pair/host-bootstrap":
          if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
          return handleHostBootstrap(req, env);
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (e) {
      return new Response("error: " + (e as Error).message, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Extend `relay-do.ts` with the pending-index handlers**

```typescript
// mdrelay/src/relay-do.ts (replace stub)
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
    // Auto-clean expired entries (best effort).
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    return new Response("ok");
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
    // Stash for the host to fetch on next connect.
    const list = (await this.state.storage.get<unknown[]>("pending-claims")) ?? [];
    list.push({ ...body, at: Date.now() });
    await this.state.storage.put("pending-claims", list);
    return new Response("ok");
  }

  async alarm(): Promise<void> {
    // Sweep expired pending pairs.
    const all = await this.state.storage.list<PendingPair>({ prefix: "pending:" });
    const now = Date.now();
    for (const [key, value] of all) {
      if (value.expiresAt < now) await this.state.storage.delete(key);
    }
  }
}
```

- [ ] **Step 6: Run pair tests, expect pass**

```bash
cd /Users/bruce/git/mdeditor/mdrelay && pnpm test tests/pair.test.ts
```
Expected: 4 passed.

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add mdrelay && git commit -m "feat(mdrelay): pair create/claim + pending DO index"
```

---

## Task 5: WS endpoints + DO connection management

**Files:**
- Modify: `mdrelay/src/index.ts`
- Modify: `mdrelay/src/relay-do.ts`
- Create: `mdrelay/tests/ws-host.test.ts`

- [ ] **Step 1: Write a WS round-trip test**

```typescript
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
```

- [ ] **Step 2: Update `index.ts` to route WS**

Add to the route table:

```typescript
import { verifyDeviceToken } from "./auth.js";

case "/ws/host":
case "/ws/remote": {
  const tokenParam = url.searchParams.get("token") ?? "";
  const payload = await verifyDeviceToken(tokenParam, env.SIGNING_KEY);
  if (!payload) return new Response("unauthorized", { status: 401 });
  const expectedRole = url.pathname === "/ws/host" ? "host" : "remote";
  if (payload.role !== expectedRole) return new Response("role mismatch", { status: 401 });
  const stub = env.RELAY.get(env.RELAY.idFromName(payload.pairingId));
  // Forward the upgrade to the DO; pass headers + role + deviceId.
  const forwarded = new Request(`https://do/ws?role=${payload.role}&device=${encodeURIComponent(payload.deviceId)}`, req);
  return stub.fetch(forwarded);
}
```

- [ ] **Step 3: Implement WS routing in `relay-do.ts`**

Extend `RelayDO.fetch`:

```typescript
case "/ws":  return this.handleWs(req);
```

And add:

```typescript
private async handleWs(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const role = url.searchParams.get("role") as "host" | "remote";
  const deviceId = url.searchParams.get("device") ?? "";

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  this.state.acceptWebSocket(server, [`${role}:${deviceId}`]);
  // Drain offline buffer if any.
  await this.drainBuffer(server, deviceId);
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

  // Route.
  if (to === "broadcast") {
    this.broadcastExcept(senderDeviceId, text);
  } else if (to === "host") {
    this.deliverOrBuffer("host", text);
  } else if (to.startsWith("remote:")) {
    this.deliverOrBuffer(to.slice("remote:".length), text);
  }
}

async webSocketClose(ws: WebSocket): Promise<void> {
  // hibernation handles reconnects; nothing to do.
  void ws;
}

private getSocketsByDevice(deviceId: string): WebSocket[] {
  // Tags assigned at accept: "host:host" or "remote:<deviceId>"
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
    if (tag === `host:host` && senderDeviceId === "host") continue;
    if (tag === `remote:${senderDeviceId}`) continue;
    try { ws.send(text); } catch { /* hibernated dropouts are recovered next message */ }
  }
}

private async deliverOrBuffer(deviceId: string, text: string): Promise<void> {
  const sockets = this.getSocketsByDevice(deviceId);
  if (sockets.length > 0) {
    for (const ws of sockets) {
      try { ws.send(text); } catch { /* fall through to buffer */ }
    }
    return;
  }
  await this.pushBuffer(deviceId, text);
}
```

Add stubs that Task 6 will fill:

```typescript
private async drainBuffer(_ws: WebSocket, _deviceId: string): Promise<void> { /* Task 6 */ }
private async pushBuffer(_deviceId: string, _text: string): Promise<void> { /* Task 6 */ }
```

- [ ] **Step 4: Run, confirm WS test pass**

```bash
cd /Users/bruce/git/mdeditor/mdrelay && pnpm test tests/ws-host.test.ts
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add mdrelay && git commit -m "feat(mdrelay): WS fan-out via DO with role-tagged sockets"
```

---

## Task 6: Offline buffer (≤ 1 MB / 50 frames / 24 h)

**Files:**
- Modify: `mdrelay/src/relay-do.ts`
- Create: `mdrelay/tests/offline-buffer.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
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
```

- [ ] **Step 2: Run, confirm fail**

Expected: assertions fail (stubs are empty).

- [ ] **Step 3: Implement buffer storage in `relay-do.ts`**

Replace stubs and add limits:

```typescript
private static MAX_FRAMES = 50;
private static MAX_BYTES = 1024 * 1024;
private static MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd /Users/bruce/git/mdeditor/mdrelay && pnpm test tests/offline-buffer.test.ts
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add mdrelay && git commit -m "feat(mdrelay): offline buffer with 50/1MB/24h limits"
```

---

## Task 7: Device revocation

**Files:**
- Modify: `mdrelay/src/index.ts`
- Modify: `mdrelay/src/relay-do.ts`
- Create: `mdrelay/tests/revoke.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
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
```

- [ ] **Step 2: Add revoke route to `index.ts`**

```typescript
import { verifyDeviceToken } from "./auth.js";

case "/device/revoke": {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = await verifyDeviceToken(bearer, env.SIGNING_KEY);
  if (!payload || payload.role !== "host") return new Response("unauthorized", { status: 401 });
  const body = await req.json() as { deviceId: string };
  if (!body.deviceId) return new Response("missing deviceId", { status: 400 });
  const stub = env.RELAY.get(env.RELAY.idFromName(payload.pairingId));
  return stub.fetch("https://do/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: body.deviceId }),
  });
}
```

- [ ] **Step 3: Add revoke storage + WS gate in `relay-do.ts`**

In `RelayDO.fetch` dispatch table:

```typescript
case "/revoke": return this.revoke(req);
```

Add:

```typescript
private async revoke(req: Request): Promise<Response> {
  const body = await req.json() as { deviceId: string };
  const revoked = (await this.state.storage.get<string[]>("revoked")) ?? [];
  if (!revoked.includes(body.deviceId)) revoked.push(body.deviceId);
  await this.state.storage.put("revoked", revoked);
  // Close any active sockets for the revoked device.
  const all = this.state.getWebSockets();
  for (const ws of all) {
    if (this.state.getTags(ws).includes(`remote:${body.deviceId.replace(/^remote:/, "")}`)) {
      try { ws.close(4003, "revoked"); } catch { /* ignore */ }
    }
  }
  return new Response("ok");
}
```

Modify `handleWs` to reject revoked:

```typescript
private async handleWs(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const role = url.searchParams.get("role") as "host" | "remote";
  const deviceId = url.searchParams.get("device") ?? "";
  if (role === "remote") {
    const revoked = (await this.state.storage.get<string[]>("revoked")) ?? [];
    if (revoked.includes(deviceId)) return new Response("revoked", { status: 403 });
  }
  // ... rest unchanged
}
```

But note: the worker-side WS handler returned 401 / 101 directly — the DO sees the upgrade after the worker forwards. So actually we need the WORKER to check revocation before forwarding the upgrade, otherwise revoked clients still see a 101.

**Approach:** check revocation in the worker's `/ws/remote` branch by hitting a new DO endpoint:

In `index.ts` `/ws/remote` branch, before forwarding, add:

```typescript
if (payload.role === "remote") {
  const check = await stub.fetch("https://do/is-revoked", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: payload.deviceId }),
  });
  if (check.status === 200 && (await check.text()) === "yes") return new Response("revoked", { status: 403 });
}
```

In `relay-do.ts`:

```typescript
case "/is-revoked": {
  const body = await req.json() as { deviceId: string };
  const revoked = (await this.state.storage.get<string[]>("revoked")) ?? [];
  return new Response(revoked.includes(body.deviceId) ? "yes" : "no");
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/bruce/git/mdeditor/mdrelay && pnpm test tests/revoke.test.ts
```
Expected: 2 passed.

- [ ] **Step 5: Run the full suite**

```bash
cd /Users/bruce/git/mdeditor/mdrelay && pnpm test
```
Expected: all suites pass (auth, pair, ws-host, offline-buffer, revoke).

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add mdrelay && git commit -m "feat(mdrelay): host-signed device revocation"
```

---

## Task 8: Pending-claims fetch endpoint (for host UI)

Host needs to fetch "new pairing claim waiting for approval" events when it connects. We added them to DO storage already (`notifyClaim`); now expose a fetch path.

**Files:**
- Modify: `mdrelay/src/index.ts`
- Modify: `mdrelay/src/relay-do.ts`

- [ ] **Step 1: Add route**

In `index.ts` switch:
```typescript
case "/device/pending-claims": {
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = await verifyDeviceToken(bearer, env.SIGNING_KEY);
  if (!payload || payload.role !== "host") return new Response("unauthorized", { status: 401 });
  const stub = env.RELAY.get(env.RELAY.idFromName(payload.pairingId));
  return stub.fetch("https://do/pending-claims");
}
```

- [ ] **Step 2: Add DO handler**

```typescript
case "/pending-claims": {
  const list = (await this.state.storage.get<unknown[]>("pending-claims")) ?? [];
  await this.state.storage.delete("pending-claims");
  return new Response(JSON.stringify(list), { headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 3: Smoke test (manual)**

```bash
cd /Users/bruce/git/mdeditor/mdrelay && pnpm dev &
sleep 3
# pair + claim
PAIR_JSON=$(curl -s -X POST http://127.0.0.1:8787/pair/create)
CODE=$(echo "$PAIR_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
PID=$(echo "$PAIR_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['pairingId'])")
HOST_TOK=$(curl -s -X POST -H 'content-type: application/json' -d "{\"pairingId\":\"$PID\"}" http://127.0.0.1:8787/pair/host-bootstrap | python3 -c "import sys,json;print(json.load(sys.stdin)['device_token'])")
curl -s -X POST -H 'content-type: application/json' -d "{\"code\":\"$CODE\",\"hostname\":\"laptop\"}" http://127.0.0.1:8787/pair/claim >/dev/null
curl -s -H "Authorization: Bearer $HOST_TOK" http://127.0.0.1:8787/device/pending-claims
kill %1
```
Expected: a JSON array with a claim record.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add mdrelay && git commit -m "feat(mdrelay): host-fetchable pending claim queue"
```

---

## Task 9: Documentation + deploy notes

**Files:**
- Create: `mdrelay/README.md`

- [ ] **Step 1: Write README**

````markdown
# mdrelay

Cloudflare Worker brokering WSS connections between one M↓ host (paired to a
local OpenClaw) and N remote M↓ devices. WSS-only — no end-to-end encryption.
Spec: `docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md`,
Section 3.

## Local dev

```sh
pnpm install
echo 'SIGNING_KEY=$(openssl rand -hex 32)' > .dev.vars
pnpm dev          # http://127.0.0.1:8787
pnpm test         # vitest-in-workerd
```

## Deploy

```sh
wrangler secret put SIGNING_KEY   # set a strong production secret (≥ 32 bytes)
wrangler deploy
```

Add the custom domain by uncommenting `routes` in `wrangler.toml` and pointing
your DNS at Cloudflare.

## Endpoints

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET  | `/health` | none | — | `{"ok":true}` |
| POST | `/pair/create` | none | — | `{ code, pairingId, expiresAt }` |
| POST | `/pair/host-bootstrap` | none | `{ pairingId }` | `{ device_token }` |
| POST | `/pair/claim` | none | `{ code, hostname? }` | `{ device_token, pairingId, deviceId }` |
| GET  | `/ws/host?token=…` | device_token (host) | upgrade | WS |
| GET  | `/ws/remote?token=…` | device_token (remote) | upgrade | WS |
| POST | `/device/revoke` | Bearer host token | `{ deviceId }` | `ok` |
| GET  | `/device/pending-claims` | Bearer host token | — | JSON array |

## Limits

- Pairing code: 2 minutes, single-use
- Offline buffer per device: max 50 frames OR 1 MB OR 24h (whichever hits first)
- WS frame routing: `to ∈ {"host","remote:<id>","broadcast"}`, `from` matches sender

## Wire frame

```json
{
  "to": "host" | "remote:<deviceId>" | "broadcast",
  "from": "host" | "remote:<deviceId>",
  ... payload fields per spec Section 2.3 ...
}
```
````

- [ ] **Step 2: Commit**

```bash
cd /Users/bruce/git/mdeditor && git add mdrelay/README.md && git commit -m "docs(mdrelay): README with endpoints, limits, deploy"
```

---

## Task 10: CI wiring (optional, do last)

If the project has GitHub Actions, add a job step for mdrelay:

**Files:**
- Modify: `.github/workflows/*.yml` (if present)

- [ ] **Step 1: Find CI config**

```bash
ls /Users/bruce/git/mdeditor/.github/workflows 2>/dev/null
```

If empty, skip this task entirely.

- [ ] **Step 2: Add mdrelay test step**

Append to the existing `ci.yml` (or create one) — match the style of the existing matrix entries:

```yaml
- name: mdrelay tests
  working-directory: ./mdrelay
  run: |
    pnpm install --frozen-lockfile
    pnpm test
```

- [ ] **Step 3: Push and verify CI green**

```bash
cd /Users/bruce/git/mdeditor && git add .github && git commit -m "ci: run mdrelay vitest"
```

---

## Done criteria

- [ ] `pnpm test` in `mdrelay/` reports all suites green
- [ ] `pnpm dev` boots; `curl /health` returns ok
- [ ] Full pairing → host bootstrap → claim → WS host + WS remote → message round-trip works through `wrangler dev`
- [ ] Offline-then-online buffering works within configured limits (50 / 1 MB / 24 h)
- [ ] Revoked remote token returns 403 on subsequent WS connect
- [ ] README documents endpoints, deploy, and limits
- [ ] All work committed in atomic `feat(mdrelay): …` / `test(mdrelay): …` / `docs(mdrelay): …` commits
