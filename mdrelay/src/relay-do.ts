// mdrelay/src/relay-do.ts
export class RelayDO {
  constructor(_state: DurableObjectState, _env: unknown) {}
  async fetch(_req: Request): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  }
}
