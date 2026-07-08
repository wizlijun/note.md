/// Per-slug audience aggregator. One instance per share slug (addressed by
/// `idFromName(slug)`), so heartbeats for different shares never contend.
export class SlugAnalytics {
  private state: DurableObjectState
  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/hit' && req.method === 'POST') {
      // Aggregation added in a later task.
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/stats' && req.method === 'GET') {
      // Query added in a later task.
      return Response.json({ total_ms: 0, unique_readers: 0, days: {} })
    }
    return new Response('Not Found', { status: 404 })
  }
}

/** Same slug grammar the share endpoints already accept. */
export const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/
