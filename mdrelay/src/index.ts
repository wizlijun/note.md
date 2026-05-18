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
