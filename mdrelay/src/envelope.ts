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
