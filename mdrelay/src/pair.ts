// mdrelay/src/pair.ts
import { generatePairingCode, signDeviceToken } from "./auth.js";
import type { Env } from "./index.js";

interface PendingPair {
  pairingId: string;
  expiresAt: number;
}

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
