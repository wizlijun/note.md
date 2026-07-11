// notemd.net edge worker: force HTTPS, resolve /download, then serve static
// assets. Runs before the asset router (run_worker_first) so plain-HTTP hits
// get a 301 to https instead of being served directly. Everything else is
// delegated to the [assets] binding, preserving html_handling / SPA fallback.

const GH_REPO = "wizlijun/note.md";
const LATEST_JSON_URL = `https://github.com/${GH_REPO}/releases/latest/download/latest.json`;
const RELEASES_PAGE = `https://github.com/${GH_REPO}/releases`;
const MANIFEST_TTL_S = 300; // 5 min — keeps GitHub traffic to ~1 hit per POP per TTL

// Per-isolate memory cache in front of the Cache API, so warm isolates skip
// even the local cache lookup.
let memManifest = null;
let memFetchedAt = 0;

async function fetchManifest(ctx) {
  const now = Date.now();
  if (memManifest && now - memFetchedAt < MANIFEST_TTL_S * 1000) return memManifest;

  const cache = caches.default;
  // Synthetic same-zone key; the real GitHub URL redirects (302 → S3) which
  // makes it a poor cache key.
  const cacheKey = new Request("https://notemd.net/__cache/latest.json");
  let res = await cache.match(cacheKey);
  if (!res) {
    const upstream = await fetch(LATEST_JSON_URL, {
      redirect: "follow",
      headers: { "User-Agent": "notemd-site-worker" },
    });
    if (!upstream.ok) throw new Error(`latest.json fetch failed: ${upstream.status}`);
    const body = await upstream.text();
    res = new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${MANIFEST_TTL_S}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  memManifest = await res.json();
  memFetchedAt = now;
  return memManifest;
}

// Sec-CH-UA-Arch arrives quoted ("arm"); query params come from us or from
// users hand-editing URLs, so accept the common spellings.
function normalizeArch(raw) {
  if (!raw) return null;
  const v = raw.toLowerCase().replace(/"/g, "");
  if (v === "aarch64" || v === "arm64" || v === "arm") return "aarch64";
  if (v === "x86_64" || v === "x64" || v === "x86" || v === "amd64" || v === "intel") return "x86_64";
  return null;
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

// GET /download[?arch=aarch64|x86_64] → 302 to the latest .dmg for that arch.
//
// Arch precedence: explicit ?arch= > Sec-CH-UA-Arch client hint (Chromium
// only) > aarch64. Headers cannot reliably distinguish Intel from Apple
// Silicon (Safari reports Intel on both), so the homepage carries an explicit
// Intel fallback link instead. Non-mac visitors without ?arch= land on the
// releases page rather than downloading a binary that won't run.
async function handleDownload(request, ctx) {
  const url = new URL(request.url);
  const explicit = normalizeArch(url.searchParams.get("arch"));
  const hinted = normalizeArch(request.headers.get("Sec-CH-UA-Arch"));
  const ua = request.headers.get("User-Agent") || "";
  const isMac = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad|iPod/.test(ua);

  if (!explicit && !isMac) return redirect(RELEASES_PAGE);
  const arch = explicit ?? hinted ?? "aarch64";

  try {
    const manifest = await fetchManifest(ctx);
    const version = manifest.version;
    // Derive the tag from the updater tarball URL (…/releases/download/<tag>/…)
    // rather than assuming v<version>, so a tag-format change can't break us.
    const platformUrl = manifest.platforms?.[`darwin-${arch}`]?.url ?? "";
    const tag = platformUrl.match(/\/releases\/download\/([^/]+)\//)?.[1] ?? `v${version}`;
    const dmg = `https://github.com/${GH_REPO}/releases/download/${tag}/note.md-${version}-${arch}.dmg`;
    return redirect(dmg);
  } catch (e) {
    // Never dead-end a download click; the releases page always works.
    console.warn("[/download] falling back to releases page:", e);
    return redirect(RELEASES_PAGE);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // /download resolves before the HTTPS upgrade: its target is already an
    // https URL, so redirecting straight there saves a hop (and keeps the
    // route testable under `wrangler dev`, which presents requests as http).
    if (url.pathname === "/download" || url.pathname === "/download/") {
      return handleDownload(request, ctx);
    }
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
