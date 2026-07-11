// notemd.net edge worker: force HTTPS, then serve static assets.
// Runs before the asset router (run_worker_first) so plain-HTTP hits get a
// 301 to https instead of being served directly. Everything else is delegated
// to the [assets] binding, preserving html_handling / SPA fallback.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
