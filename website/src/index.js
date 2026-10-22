// notemd.net edge worker: force HTTPS, resolve /download, then serve static
// assets. Runs before the asset router (run_worker_first) so plain-HTTP hits
// get a 301 to https instead of being served directly. Everything else is
// delegated to the [assets] binding, preserving html_handling / SPA fallback.

import {
  GH_REPO,
  RELEASES_PAGE,
  detectTarget,
  linuxUrlFromReleasePages,
  macDownloadUrl,
  macUrlFromReleasePages,
  windowsUrlFromManifest,
  windowsUrlFromReleasePages,
} from "./resolve-download.js";

const LATEST_JSON_URL = `https://github.com/${GH_REPO}/releases/latest/download/latest.json`;
const RELEASES_API_URL = `https://api.github.com/repos/${GH_REPO}/releases`;
const UA = "notemd-site-worker";
const RELEASES_PER_PAGE = 100; // GitHub's maximum; pagination handles older platform builds

const MANIFEST_TTL_S = 300; // 5 min — keeps GitHub traffic to ~1 hit per POP per TTL
const RELEASES_TTL_S = 1800; // 30 min — shared by platform release lookups
const RESOLVED_TTL_S = 600; // 10 min — a resolved installer URL is stable
const LKG_TTL_S = 60 * 60 * 24 * 30; // 30 d — last known good, the failure net
const ARCH_HINTS = "Sec-CH-UA-Arch, Sec-CH-UA-Bitness";

function withArchitectureHints(response, download = false) {
  const result = new Response(response.body, response);
  result.headers.set("Accept-CH", ARCH_HINTS);
  if (download) {
    // First direct navigation also needs the hints, before any redirect.
    result.headers.set("Critical-CH", ARCH_HINTS);
    result.headers.set("Vary", `User-Agent, Accept-Language, ${ARCH_HINTS}`);
    result.headers.set("Cache-Control", "no-store");
  }
  return result;
}

function linuxDownloadChoice(request, arch, format) {
  const language = request.headers.get("Accept-Language")?.match(/^(zh|de|ja)\b/i)?.[1]?.toLowerCase() ?? "en";
  const [title, architectureExplanation, formatExplanation] = {
    en: ["Choose your Linux download", "Your browser did not identify a supported 64-bit architecture. Select the package for your computer.", "Choose the package format for your Linux distribution. Omarchy / Arch use .pkg.tar.zst; Debian / Ubuntu use .deb."],
    zh: ["选择 Linux 下载版本", "浏览器未能提供受支持的 64 位架构信息。请选择与你电脑匹配的安装包。", "请选择 Linux 发行版使用的包格式：Omarchy / Arch 使用 .pkg.tar.zst；Debian / Ubuntu 使用 .deb。"],
    de: ["Linux-Download auswählen", "Der Browser hat keine unterstützte 64-Bit-Architektur erkannt. Wähle das Paket für deinen Computer.", "Wähle das Paketformat für deine Linux-Distribution: Omarchy / Arch verwenden .pkg.tar.zst, Debian / Ubuntu verwenden .deb."],
    ja: ["Linux 版を選択", "ブラウザーから対応する 64 ビットのアーキテクチャを確認できませんでした。お使いのコンピューターに合うパッケージを選択してください。", "Linux ディストリビューションの形式を選択してください。Omarchy / Arch は .pkg.tar.zst、Debian / Ubuntu は .deb を使用します。"],
  }[language];
  const recommended = { en: "Recommended", zh: "推荐", de: "Empfohlen", ja: "おすすめ" }[language];
  const explanation = format ? architectureExplanation : formatExplanation;
  const choices = format
    ? [["aarch64", "ARM64 / aarch64"], ["x86_64", "Intel / AMD64 / x86_64"]].map(([value, label]) =>
      `<a href="/download?os=linux&amp;format=${format}&amp;arch=${value}">${label} (${format === "deb" ? ".deb" : ".pkg.tar.zst"})</a>`)
    : [["arch", `Omarchy / Arch (.pkg.tar.zst) · ${recommended}`], ["deb", "Debian / Ubuntu (.deb)"]].map(([value, label]) =>
      `<a href="/download?os=linux&amp;format=${value}${arch ? `&amp;arch=${arch}` : ""}">${label}</a>`);
  return new Response(`<!doctype html><html lang="${language}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — note.md</title>
<style>:root{color-scheme:light dark}body{font:17px/1.6 system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1.5rem}h1{font-size:1.8rem}a{display:block;margin:1rem 0;padding:1rem;border:1px solid;border-radius:.6rem;color:inherit;text-decoration:none}a:hover,a:focus-visible{outline:2px solid}</style>
<main><h1>${title}</h1><p>${explanation}</p>
${choices.join("\n")}</main></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// Per-isolate memory cache in front of the Cache API, so warm isolates skip
// even the local cache lookup.
const mem = new Map(); // cache name → { value, expiresAt }

function memGet(name) {
  const hit = mem.get(name);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  mem.delete(name);
  return null;
}

function memPut(name, value, ttlS) {
  mem.set(name, { value, expiresAt: Date.now() + ttlS * 1000 });
}

// Synthetic same-zone cache keys; the real GitHub URLs redirect (302 → S3),
// which makes them poor cache keys.
const cacheKey = (name) => new Request(`https://notemd.net/__cache/${name}`);

// Reads honour whatever TTL the write used: the Cache API expires the entry on
// its own Cache-Control, and the memory mirror is refreshed with the remaining
// max-age parsed back off the cached response.
async function cacheReadJson(name) {
  const hit = memGet(name);
  if (hit !== null) return hit;
  const res = await caches.default.match(cacheKey(name));
  if (!res) return null;
  const ttl = Number(res.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] ?? 60);
  const value = await res.json();
  memPut(name, value, ttl);
  return value;
}

function cacheWriteJson(ctx, name, value, ttlS) {
  memPut(name, value, ttlS);
  const res = new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttlS}`,
    },
  });
  ctx.waitUntil(caches.default.put(cacheKey(name), res));
}

async function fetchJson(url, name, ttlS, ctx) {
  const cached = await cacheReadJson(name);
  if (cached !== null) return cached;
  const upstream = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!upstream.ok) throw new Error(`${name} fetch failed: ${upstream.status}`);
  const value = await upstream.json();
  cacheWriteJson(ctx, name, value, ttlS);
  return value;
}

const fetchManifest = (ctx) => fetchJson(LATEST_JSON_URL, "latest.json", MANIFEST_TTL_S, ctx);
const fetchReleasesPage = (page, ctx) =>
  fetchJson(
    `${RELEASES_API_URL}?per_page=${RELEASES_PER_PAGE}&page=${page}`,
    `releases-${page}.json`,
    RELEASES_TTL_S,
    ctx,
  );

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

// Resolve the installer URL for one (os, arch), with the last known good URL
// as the failure net. Windows packages are built on a second machine *after*
// the macOS release (docs/windows-agent-brief.md), so the newest tag's
// latest.json may carry only darwin-* entries for a while — hence the
// releases-list scan, and hence caring about the last URL that did work.
async function resolveInstaller(target, ctx) {
  const { os, arch, format } = target;
  const platformKey = `${os}${os === "linux" ? `-${format}` : ""}-${arch}`;
  const freshKey = `dl/${platformKey}`;
  const lkgKey = `dl-lkg/${platformKey}`;

  const fresh = await cacheReadJson(freshKey).catch(() => null);
  if (fresh?.url) return fresh.url;

  let url = null;
  if (os !== "linux") {
    try {
      const manifest = await fetchManifest(ctx);
      url = os === "mac" ? macDownloadUrl(manifest, arch) : windowsUrlFromManifest(manifest, arch);
    } catch (e) {
      console.warn("[/download] manifest unavailable:", e);
    }
  }

  if (!url) {
    try {
      const select = os === "mac" ? macUrlFromReleasePages
        : os === "linux" ? linuxUrlFromReleasePages : windowsUrlFromReleasePages;
      const findRelease = (releaseArch) =>
        select((page) => fetchReleasesPage(page, ctx), releaseArch, RELEASES_PER_PAGE, format);
      url = await findRelease(arch);
      // Windows on ARM supports x64 emulation. Linux must match native arch.
      if (!url && os === "windows" && arch !== "x86_64") url = await findRelease("x86_64");
    } catch (e) {
      console.warn("[/download] releases list unavailable:", e);
    }
  }

  if (url) {
    cacheWriteJson(ctx, freshKey, { url }, RESOLVED_TTL_S);
    cacheWriteJson(ctx, lkgKey, { url }, LKG_TTL_S);
    return url;
  }

  // Serving a slightly older installer that certainly exists beats dropping a
  // download click onto the releases list page.
  const lkg = await cacheReadJson(lkgKey).catch(() => null);
  return lkg?.url ?? null;
}

// GET /download[?os=mac|windows|linux][&arch=aarch64|x86_64] → 302 to the installer.
//
// Precedence: explicit ?os=/?arch= > negotiated client hints > trusted UA.
// Linux requires an explicit package format; unknown architecture also gets a choice.
// UA strings cannot reliably distinguish Intel
// from Apple Silicon (Safari reports Intel on both), so the homepage carries
// an explicit Intel fallback link instead. Visitors we can't serve a binary to
// (mobile, crawlers) get the releases page rather than a download that
// won't run.
async function handleDownload(request, ctx) {
  const url = new URL(request.url);
  const target = detectTarget({
    ua: request.headers.get("User-Agent") || "",
    osParam: url.searchParams.get("os"),
    archParam: url.searchParams.get("arch"),
    archHint: request.headers.get("Sec-CH-UA-Arch"),
    bitnessHint: request.headers.get("Sec-CH-UA-Bitness"),
  });
  if (!target) return redirect(RELEASES_PAGE);
  if (target.os === "linux") {
    const format = url.searchParams.get("format");
    target.format = format === "deb" || format === "arch" ? format : null;
    // Architecture hints do not identify the Linux distribution or its package manager.
    if (!target.format || !target.arch) return linuxDownloadChoice(request, target.arch, target.format);
  }

  try {
    return redirect((await resolveInstaller(target, ctx)) ?? RELEASES_PAGE);
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
      return withArchitectureHints(await handleDownload(request, ctx), true);
    }
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    return withArchitectureHints(await env.ASSETS.fetch(request));
  },
};
