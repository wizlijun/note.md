// mdrelay/src/index.ts
export interface Env {
  RELAY: DurableObjectNamespace;
  SIGNING_KEY: string;
}

export { RelayDO } from "./relay-do.js";

import { handlePairCreate, handlePairClaim, handleHostBootstrap } from "./pair.js";
import { verifyDeviceToken } from "./auth.js";

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
        case "/ws/host":
        case "/ws/remote": {
          const tokenParam = url.searchParams.get("token") ?? "";
          const payload = await verifyDeviceToken(tokenParam, env.SIGNING_KEY);
          if (!payload) return new Response("unauthorized", { status: 401 });
          const expectedRole = url.pathname === "/ws/host" ? "host" : "remote";
          if (payload.role !== expectedRole) return new Response("role mismatch", { status: 401 });
          const stub = env.RELAY.get(env.RELAY.idFromName(payload.pairingId));
          if (payload.role === "remote") {
            const check = await stub.fetch("https://do/is-revoked", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ deviceId: payload.deviceId }),
            });
            if (check.status === 200 && (await check.text()) === "yes") return new Response("revoked", { status: 403 });
          }
          const forwarded = new Request(`https://do/ws?role=${payload.role}&device=${encodeURIComponent(payload.deviceId)}`, req);
          return stub.fetch(forwarded);
        }
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (e) {
      return new Response("error: " + (e as Error).message, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
