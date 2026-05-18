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
