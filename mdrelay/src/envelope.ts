// mdrelay/src/envelope.ts

// Allowed routing addresses on the wire. Literal type lets the compiler catch
// mistakes at call sites in addition to the runtime guard below.
export type RoutingAddress = "host" | "broadcast" | `remote:${string}`;

export interface EnvelopeRouting {
  to: RoutingAddress;
  // `from` cannot be "broadcast" — only host or a specific remote sends a frame.
  from: Exclude<RoutingAddress, "broadcast">;
}

export function isValidEnvelope(obj: unknown): obj is EnvelopeRouting & Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.to !== "string" || typeof o.from !== "string") return false;
  if (o.to !== "host" && o.to !== "broadcast" && !o.to.startsWith("remote:")) return false;
  if (o.from !== "host" && !o.from.startsWith("remote:")) return false;
  return true;
}
