export interface Env {
  SHARES: KVNamespace
  SHARE_API_KEY: string
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.slice(1) // strip leading slash
    if (req.method === 'POST' && path === 'publish') {
      return new Response('not implemented', { status: 501 })
    }
    if (req.method === 'GET' && path) {
      return new Response('not implemented', { status: 501 })
    }
    if (req.method === 'DELETE' && path) {
      return new Response('not implemented', { status: 501 })
    }
    return new Response('Not Found', { status: 404 })
  }
}
