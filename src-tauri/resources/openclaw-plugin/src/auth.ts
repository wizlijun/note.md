import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Frame } from "./protocol.js";

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

export function wrapForWire(frame: Frame, token: string): string {
  const { mac: _discard, ...frameWithoutMac } = frame as Record<string, unknown>;
  const body = JSON.stringify(frameWithoutMac);
  const mac = signFrame(body, token);
  return JSON.stringify({ ...frameWithoutMac, mac });
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
