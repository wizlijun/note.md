// mdrelay/src/index.ts
export interface Env {
  RELAY: DurableObjectNamespace;
  SIGNING_KEY: string;
}

export { RelayDO } from "./relay-do.js";

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
