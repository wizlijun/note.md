import { mkdirSync } from "node:fs";
// src/runtime.ts
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { generateAccessToken, wrapForWire } from "./auth.js";
import type { MdeditorConfig } from "./config-schema.js";
import type { Frame } from "./protocol.js";
import { SessionPool } from "./session.js";
import { UdsServer } from "./uds-server.js";

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
    onClientConnect: () => {
      /* TODO emit status */
    },
    onClientDisconnect: () => {
      /* TODO emit status */
    },
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
  if (hostFrameHandler) hostFrameHandler(f);
}

let hostFrameHandler: ((f: Frame) => void) | null = null;
export function setHostFrameHandler(h: (f: Frame) => void): void {
  hostFrameHandler = h;
}
