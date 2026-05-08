# mdshare Plugin — Design

**Status**: Brainstorm complete; pending implementation plan
**Date**: 2026-05-08
**Owner**: bruce@hemory.com
**Platform spec**: `docs/superpowers/specs/2026-05-08-plugin-system-design.md`
**Driving brainstorm**: Q1–Q10 decisions captured below

## Goal

Add a **Share Current File** feature to M↓ that, in one click, publishes the
active tab's content as a beautiful self-contained HTML page served from a
tiny Cloudflare Worker. Recipients just open the URL — no login, no install,
content renders identically to what the user sees in M↓.

This is the first real user of the plugin platform, validating that
non-trivial features can live entirely outside the main program.

## Non-goals (v1)

- ❌ Account / login / multi-user
- ❌ Real-time collaboration or comments
- ❌ Read tracking, view counts, analytics
- ❌ Custom themes or templates
- ❌ Editing the share from the recipient's browser
- ❌ Multi-device sync of "my shares" (the records map is local-only)
- ❌ Anything beyond Markdown / HTML / code-as-fenced-block (the editor's
  three rich-mode kinds)
- ❌ Cloudflare features beyond Workers + KV (no R2, no D1, no Durable Objects)
- ❌ Inline-rendered Mermaid / Graphviz diagrams in shared output. Code blocks
  with ```mermaid / ```dot are passed through as syntax-highlighted code
  in v1. Adding the offscreen-DOM render pass (as pdf-export does) is a
  v2 enhancement.

## Brainstorm decisions (locked from prior session)

| # | Decision | Rationale |
|---|---|---|
| Q1 | **A** — Desktop pre-renders to self-contained HTML | Reuse moraya pipeline → recipient sees exactly what M↓ shows; Worker stays trivial |
| Q2 | **B + C** — Idempotent update + optional expiry | Stable URLs through edits; expiry as Preferences-level default |
| Q3 | **A** — Global `SHARE_API_KEY` | No "user" concept; Q3.B device tokens were over-engineered for solo use |
| Q4 | **D** — Slug = `YYYY-MM-DD-<filename-slug>-<3-char-suffix>` | Readable + collision-resistant + unguessable enough for casual privacy |
| Q5 | **A** — Images inlined as base64 | One self-contained blob, no asset routes, no GC |
| Q6 | **A** — Workers KV only | Simplest possible storage; one binding |
| Q7 | **C** — Domain configurable in Preferences (default `*.workers.dev`) | Lets users start free, upgrade to custom domain by editing one setting |
| Q8 | **A** — Minimal menu + `Cmd+Shift+L` | No floaters, no per-share dialogs; defaults in Preferences |
| Q9 | Silent overwrite on republish; default expiry "never"; menu + Preferences both unshare; pre-upload size check; toast on errors | |
| Q10 | Double-theme CSS + `prefers-color-scheme`; minimal shell (filename + date); minimal 410 page; **mobile-optimized viewport** | Recipient experience |

## Platform extension required

The share plugin's `enabled_when` expressions need to test whether the
current tab's path is a key in the `share.records` map:

```
settings["share.records"][currentTab.path]
```

The platform's `enabled_when` parser today only supports a literal string
or a single identifier inside `[ ]`. It does **not** support a multi-segment
path like `currentTab.path` inside the brackets. Trying to parse the above
expression throws.

**Required change** (small, additive — no breaking semantics):

In `src/lib/plugins/enabled-when.ts`, extend the bracket-index rule to
accept a full path (which is then evaluated and its result used as the
lookup key). Concretely:

```
path  := segment ( "." segment | "[" indexExpr "]" )*
indexExpr := quoted-string                          // literal key (existing)
           | path                                   // NEW: computed key
```

Implementation outline:
- Parser: in `parsePath`, when encountering `[`, peek the next token. If
  it's a quoted-string, consume it as before. If it's an identifier,
  recursively call `parsePath` to consume the full nested path, then
  expect `]`.
- AST: `Node` of kind `path` already has `segments: string[]`. Extend to
  `segments: (string | { computed: Node })[]` so a segment can be either
  a literal key or a computed-from-path key.
- Evaluator: in `lookup`, for a literal segment, use as before. For a
  `{ computed: Node }` segment, recursively evaluate the inner node, coerce
  its value to a string, and use that as the lookup key.
- Tests: add cases covering `a[b.c]`, `a["literal"][b.c]`, missing inner
  path → falsy lookup.

This change ships in Task 1 of the Spec 2 implementation plan — before
mdshare uses it.

## Architecture

```
                                          ┌──────────────────────────┐
                                          │  M↓ (Tauri main process) │
                                          │                          │
   ┌──────────────────────┐    Cmd+Shift+L│  ┌────────────────────┐  │
   │ User: writes a .md   │ ──────────────│→ │ App.svelte         │  │
   │ file in M↓           │               │  │ menu-event handler │  │
   └──────────────────────┘               │  └─────────┬──────────┘  │
                                          │            │             │
                                          │            ▼             │
                                          │  ┌────────────────────┐  │
                                          │  │ share-baker.ts     │  │
                                          │  │ (host-side, NEW)   │  │
                                          │  │ - moraya render    │  │
                                          │  │ - inline images    │  │
                                          │  │ - light+dark CSS   │  │
                                          │  │ - viewport + shell │  │
                                          │  └─────────┬──────────┘  │
                                          │            │ self-       │
                                          │            │ contained   │
                                          │            │ HTML string │
                                          │            ▼             │
                                          │  ┌────────────────────┐  │
                                          │  │ plugin host        │  │
                                          │  │ (platform code)    │  │
                                          │  └─────────┬──────────┘  │
                                          └────────────┼─────────────┘
                                                       │ stdin JSON
                                                       ▼
                                          ┌──────────────────────────┐
                                          │  mdshare (Rust sidecar)  │
                                          │  src-tauri/plugins/share │
                                          │  - generate slug         │
                                          │  - HTTP POST to Worker   │
                                          │  - emit toast / clipboard│
                                          │    / settings.merge      │
                                          │    actions               │
                                          └────────────┬─────────────┘
                                                       │ HTTPS
                                                       ▼
   ┌──────────────────────┐                ┌──────────────────────────┐
   │ Recipient's browser  │ ◀──── HTTPS ── │ Cloudflare Worker        │
   │ (PC / Mobile)        │     GET /:slug │ - POST /publish          │
   │ Sees rendered page   │                │ - GET /:slug             │
   └──────────────────────┘                │ - DELETE /:slug          │
                                           │           │              │
                                           │           ▼              │
                                           │ ┌──────────────────────┐ │
                                           │ │ Workers KV: SHARES   │ │
                                           │ │ key: <slug>          │ │
                                           │ │ value: HTML blob     │ │
                                           │ │ metadata: {token,…}  │ │
                                           │ └──────────────────────┘ │
                                           └──────────────────────────┘
```

## Three independent units

### Unit 1: `share-baker.ts` — M↓ host-side renderer (new)

**Location:** `src/lib/plugins/share-baker.ts` (TypeScript, in M↓ frontend)

**Job:** Take a tab and produce one self-contained HTML string suitable for
Workers KV (≤ 25 MB, no external assets).

**Public API:**

```ts
import type { Tab } from '../tabs.svelte'

export async function bakeShareHtml(tab: Tab): Promise<string>
```

**Pipeline (in order):**

1. **Render markdown / html** through the same moraya pipeline that
   `pdf-export.ts` uses (marked + KaTeX + highlight.js + mermaid). For HTML
   tabs: pass content through directly. For code tabs: wrap in
   `<pre><code class="language-X">…</code></pre>`.
2. **Inline `<img>`s.** Walk the rendered DOM, find every `<img src="">`,
   resolve relative or `file://` URLs against the tab's `filePath`, read the
   bytes via `@tauri-apps/plugin-fs`, base64-encode, and rewrite `src` to a
   `data:` URL with the right MIME. On read failure, replace with the alt
   text in italic.
3. **Inline KaTeX SVG / Mermaid SVG** — already inline after moraya
   rendering, but verify no remaining external `<link rel=stylesheet>` or
   `<script src>`.
4. **Apply mobile-responsive CSS.** Inline these rules to the document
   `<style>`:
   - `<meta name="viewport" content="width=device-width, initial-scale=1">`
   - `img { max-width: 100%; height: auto; }`
   - `pre { overflow-x: auto; }` and `code { word-wrap: break-word; }`
   - `.katex-display { overflow-x: auto; }`
   - Body font-size scales with `clamp(15px, 2.4vw, 18px)`
5. **Bake light + dark themes.** Inline two CSS rule blocks: default (light)
   colors, plus `@media (prefers-color-scheme: dark) { ... }` overrides.
   Borrow palette from M↓'s rich-mode CSS. The recipient's OS preference
   selects automatically.
6. **Add minimal shell.** Inject:
   - `<header>`: filename (basename, no path) + ISO date stamp in small text
   - `<main>`: rendered content
   - `<footer>`: tiny "shared via M↓" line linking to the project README
7. **Return** a single string starting with `<!doctype html>`.

**Size guard:** if the resulting string exceeds 25 MB, throw an `Error` with
message `"share_too_large:<bytes>"`. The plugin binary's caller (App.svelte
listener) translates this to a localized toast.

**Tests:** `share-baker.test.ts` with vitest + happy-dom covering:
- Markdown → HTML round-trip
- HTML tab passthrough
- Code tab wrapping
- Image inlining: relative path, `file://`, missing file (alt fallback)
- Theme blocks both present, `@media` query well-formed
- Viewport meta present
- Mermaid / KaTeX outputs survive intact
- Size > 25 MB → throws

### Unit 2: `mdshare` Rust plugin (sidecar binary)

**Location:** `mdshare/` (new top-level directory, separate Cargo workspace)

**Build artifacts:** `src-tauri/plugins/share/bin-{aarch64,x86_64}-apple-darwin`
(copied from `mdshare/target/<triple>/release/mdshare`)

**Dependencies (kept minimal):**
- `serde`, `serde_json` — IPC
- `time` v0.3 — date formatting (smaller than `chrono`)
- `ureq` v2 — synchronous HTTP client (no tokio bloat for one-shot CLI)
- `rand` v0.8 — slug suffix
- That's it. Target binary size: < 4 MB stripped per arch.

**Source layout:**

```
mdshare/
  Cargo.toml
  src/
    main.rs          # entry: read stdin JSON, dispatch by command, write stdout JSON
    ipc.rs           # PluginRequest / PluginResponse / PluginAction types
    slug.rs          # generateSlug + tests
    publish.rs       # POST /publish flow
    unpublish.rs     # DELETE /:slug flow
    copy_link.rs     # local-only: re-emit clipboard.write + toast for an existing share
```

**Manifest (`src-tauri/plugins/share/manifest.json`):**

```json
{
  "id": "share",
  "name": "Share",
  "version": "0.1.0",
  "description": "Publish current file as a shareable web page",
  "binary": "bin",
  "menus": [
    {
      "location": "file",
      "label": "Share Current File...",
      "shortcut": "Cmd+Shift+L",
      "command": "publish",
      "enabled_when": "currentTab.hasContent"
    },
    {
      "location": "file",
      "label": "Unshare Current File...",
      "command": "unpublish",
      "enabled_when": "settings[\"share.records\"][currentTab.path]"
    },
    {
      "location": "file",
      "label": "Copy Share Link",
      "command": "copy-link",
      "enabled_when": "settings[\"share.records\"][currentTab.path]"
    }
  ],
  "context_menus": [
    {
      "location": "tab",
      "label": "Share This Tab...",
      "command": "publish",
      "enabled_when": "currentTab.hasContent"
    }
  ],
  "settings": {
    "tab_label": "Share",
    "schema": [
      { "key": "share.baseUrl", "type": "string", "label": "Service Base URL", "default": "https://mdeditor-share.your-account.workers.dev", "placeholder": "https://share.example.com" },
      { "key": "share.apiKey", "type": "secret", "label": "API Key" },
      { "key": "share.defaultExpiry", "type": "select", "label": "Default expiry", "options": ["never", "7d", "30d", "90d"], "default": "never" },
      { "key": "share.slugRandomSuffix", "type": "boolean", "label": "Append 3-char random suffix to URL (recommended)", "default": true }
    ]
  },
  "host_capabilities": [
    "renderer.html",
    "settings.read",
    "settings.write:share.records",
    "clipboard.write",
    "toast",
    "dialog"
  ],
  "timeout_seconds": 30
}
```

**Commands handled by the Rust binary:**

#### `publish`

Input (relevant fields from request):
- `context.rendered_html` — the baked HTML
- `context.tab.path` (used to look up existing record)
- `context.tab.filename`
- `settings["share.baseUrl"]`, `settings["share.apiKey"]`,
  `settings["share.defaultExpiry"]`, `settings["share.slugRandomSuffix"]`,
  `settings["share.records"]`

Logic:
1. Look up `records[tab.path]`. If present:
   - `slug = existing.slug`
   - `edit_token = existing.edit_token`
   - This is a **republish** (silent overwrite per Q9.1A)
2. Else (new share):
   - Build `slug` from `slug::generate(filename, suffix_enabled)`
   - Generate `edit_token` (32 bytes random hex)
3. Compute `expires_in_seconds` from `defaultExpiry` setting
4. POST `<baseUrl>/publish`:
   - Header: `Authorization: Bearer <apiKey>`
   - Body: `{ slug, edit_token, html, expires_in_seconds?, metadata: { original_filename, source_ext } }`
5. On 409 (slug conflict, only possible when republishing same slug from
   different machine): retry up to 3 times with `-2`, `-3` suffixes
6. On success: emit actions
   ```json
   [
     { "type": "settings.merge", "patch": { "share.records": <merged map> } },
     { "type": "clipboard.write", "text": "<full URL>" },
     { "type": "toast", "level": "success", "message": "✅ Shared (link copied):", "detail": "<full URL>" }
   ]
   ```
7. On failure: a single toast action with the appropriate Chinese message
   per Q9.5 + spec error table (network error, 401, 413, 5xx, etc.)

#### `unpublish`

Input: same context + records map.

Logic:
1. Look up `records[tab.path]`. If absent, emit a toast warning and exit.
2. DELETE `<baseUrl>/<slug>` with `Authorization: Bearer <apiKey>` and JSON
   body `{ edit_token }`.
3. On success or 404 (already gone): emit
   ```json
   [
     { "type": "settings.merge", "patch": { "share.records": <map without this entry> } },
     { "type": "toast", "level": "success", "message": "Share revoked" }
   ]
   ```
4. On 401/403/network error: toast with detail.

#### `copy-link`

Input: same context.

Logic:
1. Look up `records[tab.path]`. If absent, emit toast warning.
2. Build URL from `baseUrl + slug`.
3. Emit `clipboard.write` + `toast` actions. No HTTP call — purely local.

**Slug generation (`mdshare/src/slug.rs`):**

```rust
/// Spec rules:
/// 1. Format: YYYY-MM-DD-<filename-slug>[-<3-char suffix>]
/// 2. ASCII alphanumerics preserved, lowercased
/// 3. Spaces, _, . → -; consecutive `-` collapsed; leading/trailing `-` trimmed
/// 4. Length capped at 40 chars (filename portion)
/// 5. Non-ASCII filenames: stripped; if the result is empty, fall back to
///    "untitled-<8-char-hex of content hash>"
/// 6. If filename already starts with YYYY-MM-DD, don't double-prefix
/// 7. Suffix: 3 chars from base62 (0-9a-zA-Z), default ON, configurable OFF
pub fn generate(filename: Option<&str>, content: &str, with_suffix: bool) -> String { … }
```

**IPC types (`mdshare/src/ipc.rs`):**

Mirror the platform's `PluginRequest` / `PluginResponse` / `PluginAction`
shapes via `serde`. Concrete fields needed by mdshare:

```rust
#[derive(Deserialize)]
struct Request {
    command: String,
    context: Context,
    settings: Option<serde_json::Map<String, serde_json::Value>>,
    // host_version, plugin_api_version ignored
}

#[derive(Deserialize)]
struct Context {
    tab: TabMeta,
    rendered_html: Option<String>,
    // raw_content not needed
}

#[derive(Deserialize)]
struct TabMeta {
    path: Option<String>,
    filename: Option<String>,
    // extension, is_dirty, is_untitled ignored
}

#[derive(Serialize)]
struct Response {
    success: bool,
    actions: Vec<Action>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Action {
    #[serde(rename = "toast")]
    Toast { level: String, message: String, detail: Option<String> },
    #[serde(rename = "clipboard.write")]
    ClipboardWrite { text: String },
    #[serde(rename = "settings.merge")]
    SettingsMerge { patch: serde_json::Map<String, serde_json::Value> },
}
```

**Records-map handling:** Per the platform's `settings.merge` shallow-replace
semantics, mdshare must always send back the **full updated** `share.records`
map (read existing → mutate → write whole map). The map is stored as:

```json
{
  "share.records": {
    "/Users/bruce/notes/foo.md": {
      "slug": "2026-05-08-foo-x7k",
      "edit_token": "<hex>",
      "url": "https://.../2026-05-08-foo-x7k",
      "created_at": "2026-05-08T19:30:00Z",
      "expires_at": null,
      "filename": "foo.md"
    }
  }
}
```

Untitled (unsaved) buffers: the plugin emits a toast `Please save the file first`
and exits — no slug, no record.

### Unit 3: Cloudflare Worker

**Location:** `worker/` (new top-level directory, separate Cargo-equivalent
project — npm-managed Wrangler workspace)

**Files:**

```
worker/
  package.json           # devDeps: wrangler, @cloudflare/workers-types, typescript, vitest
  wrangler.toml          # name, main, kv_namespaces, compatibility_date, optional routes
  tsconfig.json
  src/
    index.ts             # ~150 lines, three routes
  tests/
    index.test.ts        # Miniflare-based tests for full publish→get→update→delete cycle
```

**`wrangler.toml`:**

```toml
name = "mdeditor-share"
main = "src/index.ts"
compatibility_date = "2026-05-01"

kv_namespaces = [
  { binding = "SHARES", id = "<filled in after `wrangler kv:namespace create`>" }
]

# Custom domain (commented out by default; user uncomments after DNS setup):
# routes = [
#   { pattern = "share.example.com/*", custom_domain = true }
# ]
```

**Three routes:**

#### `POST /publish`

Headers: `Authorization: Bearer <SHARE_API_KEY>` (compared against
`env.SHARE_API_KEY` secret).

Body (validated via JSON schema check):

```ts
{
  slug: string,                         // regex: /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(-[a-zA-Z0-9]{2,4})?$/
  edit_token: string,                   // 32-64 chars hex
  html: string,                         // ≤ 25 MB
  expires_in_seconds?: number,          // optional, > 0
  metadata: {
    original_filename: string,
    source_ext: string,
  }
}
```

Logic:
1. Reject 401 if `Authorization` missing/wrong.
2. Reject 400 if slug regex doesn't match.
3. Reject 413 if html.length > 25 MB.
4. `existing = await SHARES.getWithMetadata(slug)`.
5. If `existing.value`:
   - Compare `existing.metadata.edit_token === request.edit_token`.
   - Mismatch → return 409 `{"error":"slug_conflict"}`.
   - Match → overwrite with new HTML + new TTL; preserve `created_at`.
6. Else (new):
   - `SHARES.put(slug, html, { expirationTtl?, metadata: {...} })`.
7. Respond 200 with `{ slug, edit_token, url: <baseUrl>/<slug> }`.

#### `GET /:slug`

1. `result = await SHARES.getWithMetadata(slug)`.
2. If null or expired (TTL handled by KV): respond 410 with the minimal HTML
   page from Q10.3A.
3. Else respond 200 with `Content-Type: text/html; charset=utf-8`,
   `Cache-Control: public, max-age=300, s-maxage=86400`,
   `X-Robots-Tag: noindex` (Q10 — keep search engines out).

#### `DELETE /:slug`

1. Reject 401 if no Bearer token.
2. Body: `{ edit_token: string }`.
3. `existing = await SHARES.getWithMetadata(slug)`.
4. If null: 404.
5. If `existing.metadata.edit_token !== request.edit_token`: 403.
6. `SHARES.delete(slug)` → 204.

**KV schema:**

```
key:      <slug>                       (~30-40 bytes string)
value:    <self-contained HTML>        (≤ 25 MB)
metadata: {
  edit_token: string,
  created_at: ISO-8601 string,
  expires_at: ISO-8601 string | null,
  original_filename: string,
  source_ext: string,
  size_bytes: number,
}
```

**410 page (returned for missing/expired):**

```html
<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Link expired — M↓</title>
<style>body{font-family:system-ui,sans-serif;max-width:36em;margin:6em auto;padding:0 1em;color:#333}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style>
</head><body>
<h1>This share link doesn't exist or has expired.</h1>
<p><small>Powered by <a href="https://github.com/wizlijun/MdEditor">M↓</a>.</small></p>
</body></html>
```

## Wiring `share-baker` into App.svelte

The platform's plugin host throws `"plugin needs renderer.html but no
htmlBaker provided"` when a plugin declares `renderer.html` but the call site
doesn't pass an `htmlBaker`. mdshare declares this capability, so App.svelte
must pass one.

Modify `src/App.svelte`'s plugin dispatch (search for the existing
`invokePlugin(m, command, snap, { settingsReader: ... })` call):

```ts
import { bakeShareHtml } from './lib/plugins/share-baker'

const result = await invokePlugin(m, command, snap, {
  settingsReader: (id) => getPluginScopedAll(id),
  htmlBaker: async (snapshot) => {
    // Plugin host gives us a TabSnapshot, but bakeShareHtml needs a real Tab
    // (it reads filePath, kind, etc.). Look it up by path.
    const tab = tabs.find((t) => t.filePath === snapshot.path)
    if (!tab) throw new Error('share-baker: no matching open tab')
    return bakeShareHtml(tab)
  },
})
```

**Note:** the `htmlBaker` runs synchronously-blocking on the user's click. For
a typical 50KB markdown with a few inlined images, this takes 100-300ms.
Image-heavy documents (10+ images) might hit 1-2s. Acceptable given user
expectation of "this is uploading."

## Build & deploy

### Building the plugin binary

`scripts/build-mdshare.sh`:

```bash
#!/usr/bin/env bash
# Build the mdshare CLI for both macOS architectures and copy to plugins dir.
set -e
cd "$(dirname "$0")/.."

# Ensure both targets are installed.
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# Build release binaries.
( cd mdshare && cargo build --release --target aarch64-apple-darwin )
( cd mdshare && cargo build --release --target x86_64-apple-darwin )

# Copy and rename into the plugin dir.
mkdir -p src-tauri/plugins/share
cp mdshare/target/aarch64-apple-darwin/release/mdshare \
   src-tauri/plugins/share/bin-aarch64-apple-darwin
cp mdshare/target/x86_64-apple-darwin/release/mdshare \
   src-tauri/plugins/share/bin-x86_64-apple-darwin
chmod +x src-tauri/plugins/share/bin-*-apple-darwin

# Strip for size.
strip src-tauri/plugins/share/bin-*-apple-darwin

echo "mdshare binaries built."
```

Add a `pnpm` script: `"build:mdshare": "bash scripts/build-mdshare.sh"`.

The release script (`release.sh`) should run `pnpm build:mdshare` before
`pnpm tauri build` so the bundled `.app` includes fresh binaries.

### Deploying the Worker

One-time setup, documented in `worker/README.md`:

```bash
cd worker
pnpm install
wrangler login
wrangler kv:namespace create SHARES
# → copy the printed id into wrangler.toml under [[kv_namespaces]]
wrangler secret put SHARE_API_KEY
# → enter a randomly generated string (e.g. `openssl rand -hex 32`)
wrangler deploy
# → prints the *.workers.dev URL
```

Then in M↓ Preferences → Share tab:
- Set "Service Base URL" to the printed URL
- Set "API Key" to the same string used above

For custom domain: uncomment the `routes` block in `wrangler.toml`, point
DNS at Cloudflare, redeploy.

## Error handling matrix

| Failure | Detection | User toast | Internal |
|---|---|---|---|
| Untitled buffer | mdshare CLI checks `tab.path == null` | `❌ Share: 请先保存文件` | exit 0 |
| Empty rendered_html | mdshare CLI | `❌ Share: 内容为空` | exit 0 |
| HTML > 25 MB | share-baker.ts throws `share_too_large:<n>` | `❌ Share: 文档过大（X MB / 上限 25 MB）` | thrown in TS, caught by host |
| Network unreachable | mdshare CLI ureq error | `❌ Share: 网络错误，请检查网络` | stderr details |
| 401 Unauthorized | mdshare CLI HTTP response | `❌ Share: API key 无效，请检查 Preferences` | |
| 413 too large | mdshare CLI HTTP response | `❌ Share: 文档过大` | |
| 409 slug conflict (3 retries failed) | mdshare CLI | `❌ Share: slug 冲突，请稍后重试` | |
| 5xx | mdshare CLI | `❌ Share: 服务器繁忙，请稍后重试` | stderr details |
| Worker timeout (30s) | platform | `❌ Share: 未响应（30s）` | platform-level |

All toasts include `detail` with the technical reason (URL, status code,
error string) for the expandable view.

## Testing

### Unit tests

| Module | What to test |
|---|---|
| `share-baker.ts` (vitest) | rendering happy paths, image inlining, theme blocks present, viewport meta, size limit throws |
| `slug.rs` (cargo test) | ASCII / mixed / pure-Chinese / emoji / empty / long names; date prefix; suffix on/off; "filename starts with date" deduplication |
| `mdshare/src/ipc.rs` (cargo test) | IPC payload roundtrip with serde fixtures |
| `worker/src/index.ts` (vitest + Miniflare) | publish → get → update → delete → 410-after-delete; 401 / 409 / 413 paths; slug regex enforcement |

### Integration / smoke

Add to `mdshare/tests/integration.rs`:
- Spawn the binary, write a fixture request to stdin, parse stdout, assert
  expected actions.

Add to `README.md` (continuing item 49+):

```
49. Plugin: install share — run `pnpm build:mdshare` then deploy the worker;
    paste URL + API key into Preferences → Share. Restart M↓.
50. Cmd+Shift+L on a saved markdown file → toast "✅ Shared (link copied)";
    paste from clipboard → URL works in browser.
51. Same file, edit a paragraph, Cmd+Shift+L again → toast "✅ Shared (link copied)";
    same URL still in clipboard; recipient page shows new content.
52. File → Unshare Current File → toast "Share revoked"; reload recipient
    page → 410 page shown.
53. Right-click a tab → "Share This Tab..." appears; click → publishes.
54. Open M↓ on iPhone Safari → recipient page is readable, no horizontal
    scroll, code blocks scroll within their container.
55. Switch system to dark mode → recipient page automatically switches.
56. Disconnect network, click Cmd+Shift+L → toast "❌ Share: 网络错误";
    M↓ remains responsive throughout.
```

## Open questions

These are minor; defaults below ship in v1 unless you push back:

1. **mdshare repo location** — current spec puts it in M↓'s repo (top-level
   `mdshare/`). Alternative: separate repo published to crates.io / npm.
   **Default:** colocate, as planned.

2. **Date timezone** — slug uses `YYYY-MM-DD` of *what* timezone?
   **Default:** the user's local timezone at publish time. (Worker doesn't
   care; date is just slug filler.)

3. **Untitled buffer behavior** — strict reject vs. allow with `untitled-<hash>`
   slug. Brainstorm Q4.5 said the latter. **Default:** strict reject in v1
   (simpler error message, no risk of leaking unsaved drafts).

4. **`copy-link` shortcut** — the spec doesn't bind a shortcut to the Copy
   Share Link menu item. Would `Cmd+Shift+C` make sense? Conflicts with
   "Copy" probably not, but let's not bind one in v1.

5. **404 handling on DELETE** — if the slug already vanished server-side
   (e.g. expired between user's "Share" and "Unshare"), should the local
   record be wiped silently or surfaced? **Default:** wipe silently; toast
   says "Share revoked" either way.

## Future work

- Multi-device sync of `share.records` (cloud-stored, not local-only)
- View counter (KV counter increment on GET)
- Custom slug input field in a "Share with options..." flow
- Password-protected shares (extra metadata field, gate in Worker)
- Image-heavy documents: spill large attachments to R2, keep KV value small
- Plugin auto-update mechanism (currently manual `pnpm build:mdshare`)
