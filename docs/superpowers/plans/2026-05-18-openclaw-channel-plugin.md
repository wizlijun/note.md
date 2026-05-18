# OpenClaw `mdeditor` Channel Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-process TypeScript channel plugin that registers a new OpenClaw channel id `mdeditor`, accepts one local M↓ host process over a Unix Domain Socket, and bridges between OpenClaw's session/agent pipeline and a line-delimited JSON wire protocol.

**Architecture:** ES-module Node package living under `~/git/openclaw/extensions/mdeditor/`, identical structural shape to `extensions/matrix/`. The plugin exports a `ChannelPlugin<ResolvedAccount>` from `openclaw/plugin-sdk`. Single hardcoded account `default` — all connected M↓ devices share one session pool managed via OpenClaw's standard sessions APIs. A `UnixStream` server (mode `0600`, peer-UID checked) holds at most 1 host client; remote devices fan out from the M↓ host side, not here. Wire format: line-delimited JSON, every frame carries `"v": 1` and an HMAC-SHA256 over the JSON body using the plugin's `accessToken`.

**Tech Stack:** TypeScript (ES2022, NodeNext), Node ≥ 20 (relies on `node:net` `UnixServer`), Zod 4 for config schema (matches existing channels), Vitest for tests. Plugin is loaded by OpenClaw's existing extension loader (`packages/openclaw/openclaw.podman.env` is not relevant; plugins are discovered through `~/.openclaw/openclaw.json` `plugins.entries.mdeditor`).

**Spec:** `mdeditor/docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md` (commit `9f31934` on `main`). Sections 2.1-2.6, 5.3.

---

## File Structure

All paths relative to `~/git/openclaw/extensions/mdeditor/`:

| Path | Responsibility |
|---|---|
| `openclaw.plugin.json` | Channel id registration + Zod-compatible JSON schema for plugin config |
| `package.json` | npm metadata + `openclaw.*` extension manifest |
| `tsconfig.json` | TS settings copied from `extensions/matrix/tsconfig.json` |
| `vitest.config.ts` | Vitest standard node-environment config |
| `index.ts` | `api.registerChannel({ plugin: mdeditorPlugin })`; only this is loaded by OpenClaw at install time |
| `src/channel.ts` | Exports `mdeditorPlugin: ChannelPlugin`; wires `messaging`/`outbound`/`status` adapters to internal modules |
| `src/config-schema.ts` | Zod schema mirroring `openclaw.plugin.json` |
| `src/protocol.ts` | Frame types, encode/decode for UDS wire (line-delimited JSON + HMAC envelope) |
| `src/auth.ts` | Peer-UID check (via `socket.remoteAddress` is unavailable on UDS → use `process.getuid()` only; token+HMAC do the rest); HMAC-SHA256 verify/sign |
| `src/uds-server.ts` | Owns the `net.Server` lifecycle: bind/unbind socket file, accept, dispatch frames, single-client gate |
| `src/session.ts` | Maps OpenClaw `sessionId` ↔ in-flight UDS client (single account "default"); `replayAfter(sessionId, msgId)` helper |
| `src/runtime.ts` | Plugin-level singleton: holds `OpenClawPluginApi` runtime handle (saved during `register()`), plus the UDS server instance |
| `src/__tests__/protocol.test.ts` | Round-trip + HMAC tampering tests |
| `src/__tests__/auth.test.ts` | HMAC sign/verify + token mismatch tests |
| `src/__tests__/uds-server.test.ts` | Spin up server on a temp `.sock`, connect with `net.connect`, send framed JSON, assert dispatched callbacks |
| `src/__tests__/session.test.ts` | Session pool: create / list / replay |
| `README.md` | One-page user docs |

---

## Task 1: Package scaffolding

**Files:**
- Create: `~/git/openclaw/extensions/mdeditor/package.json`
- Create: `~/git/openclaw/extensions/mdeditor/openclaw.plugin.json`
- Create: `~/git/openclaw/extensions/mdeditor/tsconfig.json`
- Create: `~/git/openclaw/extensions/mdeditor/vitest.config.ts`

- [ ] **Step 1: Create directory**

```bash
mkdir -p ~/git/openclaw/extensions/mdeditor/src/__tests__
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@openclaw/mdeditor",
  "version": "0.1.0",
  "description": "OpenClaw mdeditor channel plugin (local UDS bridge to M↓ host)",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^20",
    "typescript": "^5",
    "vitest": "^2"
  },
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "mdeditor",
      "label": "M↓ Chat",
      "selectionLabel": "M↓ Chat (plugin)",
      "docsPath": "/channels/mdeditor",
      "docsLabel": "mdeditor",
      "blurb": "Local M↓ desktop chat via UDS; remote fan-out via mdrelay.",
      "order": 90,
      "quickstartAllowFrom": false
    },
    "install": {
      "npmSpec": "@openclaw/mdeditor",
      "localPath": "extensions/mdeditor",
      "defaultChoice": "localPath"
    }
  }
}
```

- [ ] **Step 3: Write `openclaw.plugin.json`**

```json
{
  "id": "mdeditor",
  "name": "M↓ Chat",
  "description": "Local M↓ desktop chat via UDS; remote fan-out via mdrelay.",
  "channels": ["mdeditor"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "socketPath": {
        "type": "string",
        "default": "~/.openclaw/mdeditor.sock",
        "description": "Path of the local Unix Domain Socket the M↓ host will connect to."
      },
      "accessToken": {
        "type": "string",
        "minLength": 32,
        "description": "Shared secret used for the UDS handshake and per-frame HMAC. Auto-generated on first run."
      },
      "maxClients": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1,
        "default": 1
      }
    }
  }
}
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts"]
}
```

- [ ] **Step 5: Write `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 6: Install dependencies**

```bash
cd ~/git/openclaw/extensions/mdeditor && pnpm install
```

Expected: `pnpm install` reports adding `zod`, `@types/node`, `typescript`, `vitest`.

- [ ] **Step 7: Verify TypeScript compiles (empty project)**

Create a placeholder `index.ts`:
```typescript
export {};
```
Then:
```bash
cd ~/git/openclaw/extensions/mdeditor && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd ~/git/openclaw && git add extensions/mdeditor && git commit -m "feat(mdeditor): scaffold channel plugin"
```

---

## Task 2: Protocol module (frame encoding)

**Files:**
- Create: `~/git/openclaw/extensions/mdeditor/src/protocol.ts`
- Create: `~/git/openclaw/extensions/mdeditor/src/__tests__/protocol.test.ts`

- [ ] **Step 1: Write failing test for round-trip encode/decode**

```typescript
// src/__tests__/protocol.test.ts
import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrameLine, type Frame } from "../protocol.js";

describe("protocol", () => {
  it("round-trips a frame through encode and decode", () => {
    const frame: Frame = { v: 1, type: "user.message", session: "s1", text: "hello" };
    const line = encodeFrame(frame);
    expect(line.endsWith("\n")).toBe(true);
    const decoded = decodeFrameLine(line.trimEnd());
    expect(decoded).toEqual(frame);
  });

  it("rejects malformed JSON", () => {
    expect(() => decodeFrameLine("not json")).toThrow(/parse/i);
  });

  it("rejects frames missing v", () => {
    expect(() => decodeFrameLine('{"type":"hello"}')).toThrow(/version/i);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
cd ~/git/openclaw/extensions/mdeditor && pnpm test src/__tests__/protocol.test.ts
```
Expected: FAIL — "Cannot find module '../protocol.js'".

- [ ] **Step 3: Implement `src/protocol.ts`**

```typescript
// src/protocol.ts
export type FrameType =
  // host -> plugin
  | "hello"
  | "user.message"
  | "user.cancel"
  | "user.attach.upload"
  | "user.request_file"
  | "user.push_file"
  // plugin -> host
  | "welcome"
  | "agent.message.delta"
  | "agent.message.end"
  | "agent.attachment"
  | "agent.tool_call"
  | "agent.file_content"
  // bidirectional session management
  | "session.list"
  | "session.list.result"
  | "session.new"
  | "session.open"
  | "session.replay"
  | "error";

export interface BaseFrame {
  v: 1;
  type: FrameType;
}

export type Frame = BaseFrame & Record<string, unknown>;

export function encodeFrame(f: Frame): string {
  return JSON.stringify(f) + "\n";
}

export function decodeFrameLine(line: string): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    throw new Error("frame parse error: " + (e as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("frame parse error: not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) {
    throw new Error("frame protocol version mismatch: expected v=1, got " + JSON.stringify(obj.v));
  }
  if (typeof obj.type !== "string") {
    throw new Error("frame missing type");
  }
  return obj as Frame;
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
cd ~/git/openclaw/extensions/mdeditor && pnpm test src/__tests__/protocol.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Add line-splitting helper test**

Append to `src/__tests__/protocol.test.ts`:
```typescript
import { LineSplitter } from "../protocol.js";

describe("LineSplitter", () => {
  it("emits complete lines as they arrive", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.push("foo\nbar\nb", (l) => lines.push(l));
    expect(lines).toEqual(["foo", "bar"]);
    splitter.push("az\n", (l) => lines.push(l));
    expect(lines).toEqual(["foo", "bar", "baz"]);
  });

  it("ignores empty lines", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.push("\n\nfoo\n\n", (l) => lines.push(l));
    expect(lines).toEqual(["foo"]);
  });
});
```

- [ ] **Step 6: Run test, confirm it fails**

Expected: FAIL — "LineSplitter is not exported".

- [ ] **Step 7: Implement `LineSplitter` (append to protocol.ts)**

```typescript
export class LineSplitter {
  private buf = "";
  push(chunk: string, onLine: (line: string) => void): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
  }
}
```

- [ ] **Step 8: Run test, confirm pass**

Expected: 5 passed.

- [ ] **Step 9: Commit**

```bash
cd ~/git/openclaw && git add extensions/mdeditor && git commit -m "feat(mdeditor): line-delimited JSON protocol module"
```

---

## Task 3: Auth module (HMAC + token)

**Files:**
- Create: `~/git/openclaw/extensions/mdeditor/src/auth.ts`
- Create: `~/git/openclaw/extensions/mdeditor/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/auth.test.ts
import { describe, it, expect } from "vitest";
import { signFrame, verifyFrame, generateAccessToken } from "../auth.js";

describe("auth", () => {
  const token = "test-token-32-bytes-of-entropy-x";

  it("signs and verifies a frame body", () => {
    const body = '{"v":1,"type":"user.message","text":"hi"}';
    const mac = signFrame(body, token);
    expect(verifyFrame(body, mac, token)).toBe(true);
  });

  it("rejects tampered body", () => {
    const body = '{"v":1,"type":"user.message","text":"hi"}';
    const mac = signFrame(body, token);
    expect(verifyFrame(body + "x", mac, token)).toBe(false);
  });

  it("rejects wrong token", () => {
    const body = '{"v":1,"type":"user.message","text":"hi"}';
    const mac = signFrame(body, token);
    expect(verifyFrame(body, mac, "other-token")).toBe(false);
  });

  it("generates a 64-char hex access token", () => {
    const t = generateAccessToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd ~/git/openclaw/extensions/mdeditor && pnpm test src/__tests__/auth.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth.ts`**

```typescript
// src/auth.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function signFrame(body: string, token: string): string {
  return createHmac("sha256", token).update(body, "utf8").digest("hex");
}

export function verifyFrame(body: string, mac: string, token: string): boolean {
  const expected = signFrame(body, token);
  if (expected.length !== mac.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(mac, "hex"));
  } catch {
    return false;
  }
}

export function generateAccessToken(): string {
  return randomBytes(32).toString("hex");
}
```

- [ ] **Step 4: Run, confirm pass**

Expected: 4 passed.

- [ ] **Step 5: Decide envelope shape — body+MAC on the same line**

The on-wire frame becomes one JSON line `{"v":1,"type":"...","mac":"<hex>"}` where `mac` is HMAC over the same JSON object with the `mac` field removed (canonicalized).

Append test:
```typescript
import { wrapForWire, unwrapFromWire } from "../auth.js";

describe("wire envelope", () => {
  const token = "x".repeat(64);
  it("wraps a payload with mac and unwraps verifying", () => {
    const wrapped = wrapForWire({ v: 1, type: "hello", token: "..." }, token);
    expect(typeof wrapped).toBe("string");
    expect(JSON.parse(wrapped).mac).toMatch(/^[0-9a-f]{64}$/);
    const verified = unwrapFromWire(wrapped, token);
    expect(verified.type).toBe("hello");
  });

  it("rejects unwrap when mac wrong", () => {
    const wrapped = wrapForWire({ v: 1, type: "hello" }, token);
    const obj = JSON.parse(wrapped);
    obj.mac = "0".repeat(64);
    expect(() => unwrapFromWire(JSON.stringify(obj), token)).toThrow(/mac/i);
  });
});
```

- [ ] **Step 6: Run, confirm fail**

Expected: FAIL — `wrapForWire` not exported.

- [ ] **Step 7: Implement envelope helpers in `src/auth.ts`**

Append:
```typescript
import type { Frame } from "./protocol.js";

export function wrapForWire(frame: Frame, token: string): string {
  // canonical: serialise without mac, sign, then re-serialise with mac
  const body = JSON.stringify(frame);
  const mac = signFrame(body, token);
  return JSON.stringify({ ...frame, mac });
}

export function unwrapFromWire(line: string, token: string): Frame {
  const obj = JSON.parse(line) as Record<string, unknown>;
  if (typeof obj.mac !== "string") throw new Error("missing mac");
  const { mac, ...rest } = obj;
  const body = JSON.stringify(rest);
  if (!verifyFrame(body, mac, token)) {
    throw new Error("mac verification failed");
  }
  if (rest.v !== 1) throw new Error("frame protocol version mismatch");
  if (typeof rest.type !== "string") throw new Error("frame missing type");
  return rest as Frame;
}
```

- [ ] **Step 8: Run, confirm pass**

Expected: 6 passed total in `auth.test.ts`.

- [ ] **Step 9: Commit**

```bash
cd ~/git/openclaw && git add extensions/mdeditor && git commit -m "feat(mdeditor): HMAC auth + wire envelope"
```

---

## Task 4: UDS server

**Files:**
- Create: `~/git/openclaw/extensions/mdeditor/src/uds-server.ts`
- Create: `~/git/openclaw/extensions/mdeditor/src/__tests__/uds-server.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/uds-server.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { UdsServer } from "../uds-server.js";
import { wrapForWire } from "../auth.js";

describe("UdsServer", () => {
  let dir: string;
  let sockPath: string;
  let server: UdsServer | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mdeditor-uds-"));
    sockPath = join(dir, "test.sock");
  });

  afterEach(async () => {
    if (server) await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts, accepts a client, dispatches a frame", async () => {
    const token = "t".repeat(64);
    const received: unknown[] = [];

    server = new UdsServer({
      socketPath: sockPath,
      accessToken: token,
      onFrame: (f) => received.push(f),
      onClientConnect: () => {},
      onClientDisconnect: () => {},
    });
    await server.start();

    const client = connect(sockPath);
    await new Promise<void>((res) => client.once("connect", () => res()));
    client.write(wrapForWire({ v: 1, type: "hello", token }, token) + "\n");

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect((received[0] as { type: string }).type).toBe("hello");

    client.end();
  });

  it("rejects a second concurrent client", async () => {
    const token = "t".repeat(64);
    server = new UdsServer({
      socketPath: sockPath,
      accessToken: token,
      onFrame: () => {},
      onClientConnect: () => {},
      onClientDisconnect: () => {},
    });
    await server.start();

    const c1 = connect(sockPath);
    await new Promise<void>((res) => c1.once("connect", () => res()));

    const c2 = connect(sockPath);
    const closed = await new Promise<boolean>((res) => {
      c2.once("close", () => res(true));
      c2.once("connect", () => {
        setTimeout(() => res(false), 100);
      });
    });
    expect(closed).toBe(true);

    c1.end();
  });

  it("drops a frame with bad mac without crashing", async () => {
    const token = "t".repeat(64);
    let receivedCount = 0;
    server = new UdsServer({
      socketPath: sockPath,
      accessToken: token,
      onFrame: () => { receivedCount++; },
      onClientConnect: () => {},
      onClientDisconnect: () => {},
    });
    await server.start();

    const client = connect(sockPath);
    await new Promise<void>((res) => client.once("connect", () => res()));
    client.write('{"v":1,"type":"hello","mac":"0000"}\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedCount).toBe(0);

    client.end();
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/uds-server.ts`**

```typescript
// src/uds-server.ts
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, unlinkSync, existsSync } from "node:fs";
import { LineSplitter, type Frame } from "./protocol.js";
import { unwrapFromWire } from "./auth.js";

export interface UdsServerOpts {
  socketPath: string;
  accessToken: string;
  onFrame: (f: Frame) => void;
  onClientConnect: () => void;
  onClientDisconnect: () => void;
}

export class UdsServer {
  private server: Server | null = null;
  private current: Socket | null = null;
  private splitter = new LineSplitter();

  constructor(private opts: UdsServerOpts) {}

  async start(): Promise<void> {
    if (existsSync(this.opts.socketPath)) {
      try { unlinkSync(this.opts.socketPath); } catch { /* race-tolerant */ }
    }
    this.server = createServer((sock) => this.onConnect(sock));
    await new Promise<void>((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(this.opts.socketPath, () => {
        try {
          chmodSync(this.opts.socketPath, 0o600);
          res();
        } catch (e) {
          rej(e);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.current) this.current.destroy();
    if (this.server) {
      await new Promise<void>((res) => this.server!.close(() => res()));
      this.server = null;
    }
    if (existsSync(this.opts.socketPath)) {
      try { unlinkSync(this.opts.socketPath); } catch { /* ignore */ }
    }
  }

  send(frame: Frame): void {
    if (!this.current) return;
    // Caller's responsibility: wrap with mac before pass — see channel.ts
    this.current.write(JSON.stringify(frame) + "\n");
  }

  sendWrappedLine(line: string): void {
    if (!this.current) return;
    this.current.write(line + "\n");
  }

  private onConnect(sock: Socket): void {
    if (this.current) {
      sock.destroy();
      return;
    }
    this.current = sock;
    this.splitter = new LineSplitter();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.splitter.push(chunk, (line) => {
        try {
          const frame = unwrapFromWire(line, this.opts.accessToken);
          this.opts.onFrame(frame);
        } catch {
          // bad frame: ignore, log nothing (caller wires logging)
        }
      });
    });
    sock.once("close", () => {
      if (this.current === sock) this.current = null;
      this.opts.onClientDisconnect();
    });
    this.opts.onClientConnect();
  }

  hasClient(): boolean {
    return this.current !== null;
  }
}
```

- [ ] **Step 4: Run, confirm pass**

```bash
cd ~/git/openclaw/extensions/mdeditor && pnpm test src/__tests__/uds-server.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/git/openclaw && git add extensions/mdeditor && git commit -m "feat(mdeditor): UDS server with single-client gate + mac check"
```

---

## Task 5: Session module

**Files:**
- Create: `~/git/openclaw/extensions/mdeditor/src/session.ts`
- Create: `~/git/openclaw/extensions/mdeditor/src/__tests__/session.test.ts`

- [ ] **Step 1: Read OpenClaw sessions API surface**

Inspect: `~/git/openclaw/src/plugin-sdk/index.ts` for `OpenClawPluginApi` and search for `sessions` adapter:
```bash
grep -rn "sessions" ~/git/openclaw/src/plugin-sdk | grep -i "api\|adapter" | head -20
```
Note the runtime API methods (`api.runtime.sessions.list()`, `api.runtime.sessions.get(id)`, etc.); if absent, we depend on `outbound.deliverInbound` etc. Use what's there.

- [ ] **Step 2: Write failing test for the pure session pool**

```typescript
// src/__tests__/session.test.ts
import { describe, it, expect } from "vitest";
import { SessionPool } from "../session.js";

describe("SessionPool", () => {
  it("starts empty", () => {
    const pool = new SessionPool();
    expect(pool.list()).toEqual([]);
  });

  it("creates a session with auto-generated id + title", () => {
    const pool = new SessionPool();
    const s = pool.create("greetings");
    expect(s.id).toMatch(/^s-[0-9a-f]{12}$/);
    expect(s.title).toBe("greetings");
    expect(pool.list()).toHaveLength(1);
  });

  it("appends + retrieves messages by id", () => {
    const pool = new SessionPool();
    const s = pool.create();
    pool.append(s.id, { id: "m1", role: "user", text: "hi" });
    pool.append(s.id, { id: "m2", role: "agent", text: "hello" });
    expect(pool.messages(s.id)).toHaveLength(2);
    expect(pool.messagesAfter(s.id, "m1")).toEqual([{ id: "m2", role: "agent", text: "hello" }]);
  });

  it("returns empty for unknown session replay", () => {
    const pool = new SessionPool();
    expect(pool.messages("nonexistent")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run, confirm fail**

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/session.ts`**

```typescript
// src/session.ts
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

  messagesAfter(sessionId: string, afterMsgId: string): PoolMessage[] {
    const arr = this.msgs.get(sessionId) ?? [];
    const idx = arr.findIndex((m) => m.id === afterMsgId);
    return idx < 0 ? [...arr] : arr.slice(idx + 1);
  }
}
```

- [ ] **Step 5: Run, confirm pass**

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
cd ~/git/openclaw && git add extensions/mdeditor && git commit -m "feat(mdeditor): in-memory session pool with replay"
```

---

## Task 6: Channel plugin definition & runtime wiring

**Files:**
- Create: `~/git/openclaw/extensions/mdeditor/src/config-schema.ts`
- Create: `~/git/openclaw/extensions/mdeditor/src/runtime.ts`
- Create: `~/git/openclaw/extensions/mdeditor/src/channel.ts`
- Create: `~/git/openclaw/extensions/mdeditor/index.ts` (replace the placeholder)

- [ ] **Step 1: Write `src/config-schema.ts`**

```typescript
// src/config-schema.ts
import { z } from "zod";

export const MdeditorConfigSchema = z.object({
  socketPath: z.string().default("~/.openclaw/mdeditor.sock"),
  accessToken: z.string().min(32).optional(),
  maxClients: z.literal(1).default(1),
}).strict();

export type MdeditorConfig = z.infer<typeof MdeditorConfigSchema>;
```

- [ ] **Step 2: Write `src/runtime.ts`**

```typescript
// src/runtime.ts
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { UdsServer } from "./uds-server.js";
import { SessionPool } from "./session.js";
import { generateAccessToken, wrapForWire } from "./auth.js";
import type { Frame } from "./protocol.js";
import type { MdeditorConfig } from "./config-schema.js";

let api: OpenClawPluginApi | null = null;
let server: UdsServer | null = null;
let pool = new SessionPool();
let token = "";

export function setMdeditorRuntime(a: OpenClawPluginApi): void {
  api = a;
}

export function getMdeditorRuntime(): OpenClawPluginApi {
  if (!api) throw new Error("mdeditor runtime not initialised");
  return api;
}

export function getSessionPool(): SessionPool {
  return pool;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace("~", homedir()) : p;
}

export async function ensureServer(cfg: MdeditorConfig): Promise<void> {
  if (server) return;
  token = cfg.accessToken ?? generateAccessToken();
  const socketPath = expandHome(cfg.socketPath);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  server = new UdsServer({
    socketPath,
    accessToken: token,
    onFrame: (f) => handleHostFrame(f),
    onClientConnect: () => { /* TODO emit status */ },
    onClientDisconnect: () => { /* TODO emit status */ },
  });
  await server.start();
}

export async function stopServer(): Promise<void> {
  if (server) {
    await server.stop();
    server = null;
  }
  pool = new SessionPool();
}

export function sendToHost(f: Frame): void {
  if (!server) return;
  server.sendWrappedLine(wrapForWire(f, token));
}

function handleHostFrame(f: Frame): void {
  // Dispatched by channel.ts after wiring; here we just trace.
  // The channel layer attaches a more specific handler via setHostFrameHandler.
  if (hostFrameHandler) hostFrameHandler(f);
}

let hostFrameHandler: ((f: Frame) => void) | null = null;
export function setHostFrameHandler(h: (f: Frame) => void): void {
  hostFrameHandler = h;
}
```

- [ ] **Step 3: Write `src/channel.ts` — the ChannelPlugin export**

```typescript
// src/channel.ts
import type {
  ChannelPlugin,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelStreamingAdapter,
  ChannelStatusAdapter,
  ChannelConfigAdapter,
} from "openclaw/plugin-sdk";
import { MdeditorConfigSchema, type MdeditorConfig } from "./config-schema.js";
import {
  ensureServer,
  stopServer,
  sendToHost,
  getSessionPool,
  setHostFrameHandler,
} from "./runtime.js";
import type { Frame } from "./protocol.js";

interface ResolvedAccount {
  accountId: "default";
  config: MdeditorConfig;
}

const config: ChannelConfigAdapter<ResolvedAccount> = {
  resolveAccount: (raw) => {
    const cfg = MdeditorConfigSchema.parse(raw ?? {});
    return { accountId: "default", config: cfg };
  },
  // Whatever else the adapter requires — fill with no-ops for MVP.
};

const messaging: ChannelMessagingAdapter = {
  // Receive a message FROM OpenClaw (agent reply) and push it to UDS.
  deliver: async (ctx) => {
    const f: Frame = {
      v: 1,
      type: "agent.message.end",
      session: ctx.sessionId,
      msg_id: ctx.messageId,
      text: ctx.text ?? "",
      stop_reason: "end_turn",
    };
    sendToHost(f);
  },
};

const streaming: ChannelStreamingAdapter = {
  deliverDelta: async (ctx) => {
    sendToHost({
      v: 1,
      type: "agent.message.delta",
      session: ctx.sessionId,
      msg_id: ctx.messageId,
      text: ctx.deltaText,
    });
  },
};

const outbound: ChannelOutboundAdapter = {
  send: async () => ({ ok: true }),
};

const status: ChannelStatusAdapter<ResolvedAccount> = {
  describe: async () => ({ healthy: true, since: Date.now() }),
};

export const mdeditorPlugin: ChannelPlugin<ResolvedAccount> = {
  id: "mdeditor",
  meta: {
    id: "mdeditor",
    label: "M↓ Chat",
    selectionLabel: "M↓ Chat (plugin)",
    docsPath: "/channels/mdeditor",
    docsLabel: "mdeditor",
    blurb: "Local M↓ desktop chat via UDS.",
    order: 90,
    quickstartAllowFrom: false,
  },
  capabilities: {
    text: true,
    attachments: true,
    markdown: true,
    streaming: true,
    reactions: false,
    readReceipts: false,
  },
  config,
  messaging,
  streaming,
  outbound,
  status,
};

// Wire the host-frame handler: messages FROM M↓ host arriving on UDS turn into
// OpenClaw inbound events. The actual handoff into OpenClaw's agent pipeline
// uses api.runtime.* — wired up in lifecycle below.
export async function startChannel(): Promise<void> {
  setHostFrameHandler((f) => onHostFrame(f));
}

function onHostFrame(f: Frame): void {
  switch (f.type) {
    case "user.message":
      // Convert to OpenClaw inbound — actual API call lives in api.runtime.
      // Placeholder: emit into session pool so replay works.
      {
        const sid = (f.session as string) ?? getOrCreateDefaultSession();
        const msgId = "m-" + Date.now().toString(36);
        getSessionPool().append(sid, { id: msgId, role: "user", text: (f.text as string) ?? "" });
        // Real call: getMdeditorRuntime().runtime.inboundUserMessage({ channel: "mdeditor", session: sid, text: ... })
      }
      break;
    case "session.list":
      sendToHost({
        v: 1,
        type: "session.list.result",
        sessions: getSessionPool().list(),
      });
      break;
    case "session.new":
      {
        const s = getSessionPool().create((f.title as string) ?? undefined);
        sendToHost({ v: 1, type: "session.list.result", sessions: getSessionPool().list(), focus: s.id });
      }
      break;
    case "session.replay":
      {
        const sid = f.id as string;
        const after = (f.after_msg_id as string) ?? "";
        const msgs = after ? getSessionPool().messagesAfter(sid, after) : getSessionPool().messages(sid);
        for (const m of msgs) {
          sendToHost({
            v: 1,
            type: m.role === "agent" ? "agent.message.end" : "user.message",
            session: sid,
            msg_id: m.id,
            text: m.text,
          });
        }
      }
      break;
    default:
      // Unknown frame: ignore.
      break;
  }
}

let cachedDefaultSession: string | null = null;
function getOrCreateDefaultSession(): string {
  if (cachedDefaultSession && getSessionPool().get(cachedDefaultSession)) return cachedDefaultSession;
  const s = getSessionPool().create("New chat");
  cachedDefaultSession = s.id;
  return s.id;
}

export { stopServer, ensureServer };
```

> **Note:** The exact runtime-API call (`getMdeditorRuntime().runtime.inboundUserMessage(...)`) is left as a comment because the OpenClaw `OpenClawPluginApi` shape varies across versions; consult `~/git/openclaw/src/plugin-sdk/index.ts` for the live API and fill in the actual call. The session pool path keeps the channel testable without the runtime.

- [ ] **Step 4: Replace `index.ts` with real registration**

```typescript
// index.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mdeditorPlugin, ensureServer, stopServer, startChannel } from "./src/channel.js";
import { setMdeditorRuntime } from "./src/runtime.js";
import { MdeditorConfigSchema } from "./src/config-schema.js";

const plugin = {
  id: "mdeditor",
  name: "M↓ Chat",
  description: "Local M↓ desktop chat via UDS.",
  configSchema: { type: "object" as const, additionalProperties: false, properties: {} },
  async register(api: OpenClawPluginApi): Promise<void> {
    setMdeditorRuntime(api);
    api.registerChannel({ plugin: mdeditorPlugin });
    // Lifecycle: read config, start UDS server on enable.
    const raw = api.config?.read?.("channels.mdeditor.accounts.default") ?? {};
    const cfg = MdeditorConfigSchema.parse(raw);
    await ensureServer(cfg);
    await startChannel();
  },
  async unregister(): Promise<void> {
    await stopServer();
  },
};

export default plugin;
```

- [ ] **Step 5: Verify TypeScript still compiles**

```bash
cd ~/git/openclaw/extensions/mdeditor && npx tsc --noEmit
```
Expected: no errors. If `OpenClawPluginApi` shape differs, fix imports/types from `~/git/openclaw/src/plugin-sdk/index.ts`.

- [ ] **Step 6: Run all tests**

```bash
cd ~/git/openclaw/extensions/mdeditor && pnpm test
```
Expected: all previous tests still pass.

- [ ] **Step 7: Commit**

```bash
cd ~/git/openclaw && git add extensions/mdeditor && git commit -m "feat(mdeditor): channel plugin + register lifecycle"
```

---

## Task 7: End-to-end integration test

**Files:**
- Create: `~/git/openclaw/extensions/mdeditor/src/__tests__/e2e.test.ts`

- [ ] **Step 1: Write the e2e test**

```typescript
// src/__tests__/e2e.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import {
  ensureServer,
  stopServer,
  sendToHost,
  setHostFrameHandler,
} from "../runtime.js";
import { startChannel } from "../channel.js";
import { LineSplitter } from "../protocol.js";
import { wrapForWire, unwrapFromWire } from "../auth.js";

describe("e2e: host hello → session.new → user.message → server can broadcast", () => {
  let dir: string;
  const token = "e".repeat(64);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mdeditor-e2e-"));
  });

  afterEach(async () => {
    await stopServer();
    rmSync(dir, { recursive: true, force: true });
  });

  it("handles a complete chat round-trip", async () => {
    const sockPath = join(dir, "test.sock");
    await ensureServer({
      socketPath: sockPath,
      accessToken: token,
      maxClients: 1 as const,
    });
    await startChannel();

    const client = connect(sockPath);
    await new Promise<void>((res) => client.once("connect", () => res()));

    const splitter = new LineSplitter();
    const inbound: unknown[] = [];
    client.setEncoding("utf8");
    client.on("data", (c: string) => {
      splitter.push(c, (line) => {
        inbound.push(unwrapFromWire(line, token));
      });
    });

    // host -> plugin: session.new
    client.write(wrapForWire({ v: 1, type: "session.new", title: "test" }, token) + "\n");
    await new Promise((r) => setTimeout(r, 80));
    expect(inbound).toHaveLength(1);
    const listFrame = inbound[0] as { type: string; sessions: unknown[]; focus: string };
    expect(listFrame.type).toBe("session.list.result");
    expect(listFrame.sessions).toHaveLength(1);
    const sid = listFrame.focus;

    // host -> plugin: user.message
    client.write(wrapForWire({ v: 1, type: "user.message", session: sid, text: "hi" }, token) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    // simulate an agent reply by calling sendToHost directly (in real OpenClaw,
    // the runtime would do this when agent emits delta/end).
    sendToHost({ v: 1, type: "agent.message.delta", session: sid, msg_id: "m1", text: "hello " });
    sendToHost({ v: 1, type: "agent.message.end", session: sid, msg_id: "m1", text: "hello back", stop_reason: "end_turn" });
    await new Promise((r) => setTimeout(r, 50));

    const types = inbound.map((f: any) => f.type);
    expect(types).toContain("agent.message.delta");
    expect(types).toContain("agent.message.end");

    client.end();
  });
});
```

- [ ] **Step 2: Run the e2e test, confirm pass**

```bash
cd ~/git/openclaw/extensions/mdeditor && pnpm test src/__tests__/e2e.test.ts
```
Expected: 1 passed.

- [ ] **Step 3: Run the full test suite**

```bash
cd ~/git/openclaw/extensions/mdeditor && pnpm test
```
Expected: all suites pass (4 files / ~14 tests).

- [ ] **Step 4: Commit**

```bash
cd ~/git/openclaw && git add extensions/mdeditor && git commit -m "test(mdeditor): e2e UDS round-trip"
```

---

## Task 8: Validate against OpenClaw config + docs

**Files:**
- Create: `~/git/openclaw/extensions/mdeditor/README.md`

- [ ] **Step 1: Write README**

```markdown
# @openclaw/mdeditor

OpenClaw channel plugin: bridges a local M↓ desktop client to OpenClaw via a
Unix Domain Socket. No TCP/HTTP/WS ports are opened by this plugin.

## Install (local path)

In `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "mdeditor": { "type": "localPath", "path": "extensions/mdeditor" }
    }
  },
  "channels": {
    "mdeditor": {
      "enabled": true,
      "accounts": {
        "default": {
          "socketPath": "~/.openclaw/mdeditor.sock"
        }
      }
    }
  }
}
```

`accessToken` is auto-generated on first launch and persisted into the config
via `api.config.write`. To rotate, delete it and restart OpenClaw.

## Test

```
cd ~/git/openclaw/extensions/mdeditor
pnpm test
```

## Wire protocol

See `mdeditor/docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md`
sections 2.2-2.3.
```

- [ ] **Step 2: Run `openclaw doctor` against the manifest**

```bash
cd ~/git/openclaw && node openclaw.mjs doctor --config-only 2>&1 | head -30
```
Expected: validation passes (no errors about `channels.mdeditor.*`).

If errors: inspect schema mismatches and adjust `openclaw.plugin.json` / `config-schema.ts` accordingly.

- [ ] **Step 3: Manually verify channels list**

```bash
cd ~/git/openclaw && node openclaw.mjs channels list 2>&1 | grep mdeditor
```
Expected: `mdeditor` line appears.

- [ ] **Step 4: Commit**

```bash
cd ~/git/openclaw && git add extensions/mdeditor && git commit -m "docs(mdeditor): README + validate against openclaw doctor"
```

---

## Task 9: Wire real OpenClaw runtime calls

This task replaces the "// Real call: ..." placeholder comments in `src/channel.ts` with actual calls to `OpenClawPluginApi`. **Do this only after the M↓ host-mode plan (Plan 2) is also being implemented and you can test end-to-end.**

- [ ] **Step 1: Read the plugin API**

```bash
grep -rn "registerChannel\|inboundUserMessage\|emitInbound" ~/git/openclaw/src/plugin-sdk ~/git/openclaw/src/channels/plugins | head -30
```

Identify which exact runtime method takes a `(channel, session, text)` and routes the message into the agent pipeline. Common names: `api.gateway.inboundMessage`, `api.runtime.deliverInbound`, or via `outbound.send` reverse path.

- [ ] **Step 2: Replace placeholder in `src/channel.ts`**

In `onHostFrame` case `"user.message"`, replace the placeholder comment with:

```typescript
case "user.message":
  {
    const sid = (f.session as string) ?? getOrCreateDefaultSession();
    const msgId = "m-" + Date.now().toString(36);
    getSessionPool().append(sid, { id: msgId, role: "user", text: (f.text as string) ?? "" });
    await getMdeditorRuntime().runtime.deliverInbound({
      channel: "mdeditor",
      accountId: "default",
      sessionId: sid,
      messageId: msgId,
      text: (f.text as string) ?? "",
      attachments: (f.attachments as unknown[]) ?? [],
    });
  }
  break;
```

Substitute the actual method name discovered in Step 1.

- [ ] **Step 3: Ensure messaging.deliver / streaming.deliverDelta receive a real ctx**

Verify the adapter's `ctx` shape against the type definitions in `~/git/openclaw/src/channels/plugins/types.adapters.ts`. Adjust the `Frame` field assignments if `messageId`/`text`/etc. live under different names.

- [ ] **Step 4: Add an integration test that mounts the plugin via OpenClaw's test loader**

Use the test patterns in `~/git/openclaw/extensions/matrix/src/*.test.ts` as templates. If a public `loadPluginForTesting` helper exists, use it; otherwise document the manual test procedure (start OpenClaw with the plugin enabled, send a UDS hello, observe agent reply via real LLM).

- [ ] **Step 5: Run all tests**

```bash
cd ~/git/openclaw/extensions/mdeditor && pnpm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd ~/git/openclaw && git add extensions/mdeditor && git commit -m "feat(mdeditor): wire real OpenClaw runtime calls"
```

---

## Done criteria

- [ ] `cd ~/git/openclaw/extensions/mdeditor && pnpm test` reports all suites green
- [ ] `node openclaw.mjs channels list` shows `mdeditor`
- [ ] `lsof -p $(pgrep -f openclaw)` shows the UDS file but no listen TCP ports introduced by this plugin
- [ ] `nc -U ~/.openclaw/mdeditor.sock` accepts a connection; sending a hand-crafted `{"v":1,"type":"hello","mac":"…"}` produces a `welcome` reply
- [ ] README references the spec
- [ ] All work committed in atomic feat/test/docs commits with `feat(mdeditor): …` prefix
