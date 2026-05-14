# mdeditor-share Worker

Cloudflare Worker backing the M↓ "Share" plugin. KV holds shared HTML; R2 holds uploaded images and short videos.

## Routes

### HTML shares (KV-backed)

- `POST /publish` — `Authorization: Bearer <SHARE_API_KEY>`. Body: `{slug, edit_token, html, expires_in_seconds?, metadata}`. **Default TTL is 7 days** when `expires_in_seconds` is omitted.
- `GET /:slug` — public; returns the stored HTML or a 410 page.
- `DELETE /:slug` — `Authorization: Bearer <SHARE_API_KEY>`. Body: `{edit_token}`.

### MCP (JSON-RPC 2.0 — for LLM agents)

- `POST /mcp` — same Bearer auth. Streamable HTTP transport, single endpoint.
  Response is `application/json` by default, or `text/event-stream` when the
  client sends `Accept: text/event-stream`.
- `GET /mcp` — returns `405 Method Not Allowed` per MCP Streamable HTTP spec:
  this server has no server-initiated messages to push, so it explicitly
  declines the GET stream channel. Clients should fall back to POST-only mode.
- `DELETE /mcp` — public; returns `204` (idempotent session terminate).

Protocol versions advertised: `2024-11-05`, `2025-03-26`, `2025-06-18`. The
server echoes whichever version the client requests in `initialize`; unknown
values fall back to `2025-06-18`. See [MCP for agents](#mcp-for-agents) below.

### Media uploads (R2-backed)

- `POST /upload` — `Authorization: Bearer <SHARE_API_KEY>`. Headers:
  - `Content-Type` (required) — must be one of: `image/jpeg`, `image/png`, `image/gif`,
    `image/webp`, `image/svg+xml`, `image/avif`, `image/heic`, `image/heif`,
    `video/mp4`, `video/webm`, `video/quicktime`.
  - `X-Edit-Token` (required) — 16–128 chars, `[a-zA-Z0-9]`.
  - `X-Filename` (optional) — original filename.
  - `X-Expires-In` (optional, ≥60) — seconds until expiry. **Defaults to 7 days** when omitted.
  Body: raw file bytes (≤ 50 MB). Magic-byte sniffing rejects mismatched content.
  Returns `{id, ext, url, edit_token, expires_at, size_bytes}`.
- `GET /f/:id.:ext` — public; streams the file with `Cache-Control: immutable`,
  `Accept-Ranges: bytes`, and Range request support. SVG responses additionally
  set `Content-Security-Policy`, `Content-Disposition: inline`, and `X-Content-Type-Options: nosniff`
  to neutralize embedded scripts.
- `DELETE /f/:id.:ext` — `Authorization: Bearer <SHARE_API_KEY>`. Body: `{edit_token}`.

Expired media is lazily deleted on the first GET after `expires_at`.

## One-time setup

```bash
cd worker
pnpm install
wrangler login

# Create the KV namespace; copy the printed `id` into `kv_namespaces[0].id`
# inside wrangler.toml.
wrangler kv:namespace create SHARES

# Create the R2 bucket for media uploads. The names below match wrangler.toml.
wrangler r2 bucket create mdeditor-share-media
wrangler r2 bucket create mdeditor-share-media-preview   # used by `wrangler dev`

# Generate and store the API key as a secret. Use the same value in M↓
# Preferences → Share → API Key.
openssl rand -hex 32 | wrangler secret put SHARE_API_KEY

# Deploy.
wrangler deploy
```

The deploy step prints the public URL (`https://mdeditor-share.<account>.workers.dev`).
Paste this into M↓ Preferences → Share → Service Base URL.

## Custom domain (optional)

1. Make sure your domain is on Cloudflare (DNS proxied through Cloudflare).
2. Uncomment the `routes` block in `wrangler.toml` and set the pattern to your subdomain.
3. `wrangler deploy` again.

## MCP for agents

The worker exposes every capability over the Model Context Protocol so an LLM
agent can publish, fetch, and delete shares with a single endpoint.

**Connect:** point any MCP client at `https://<your-worker-host>/mcp` with the
header `Authorization: Bearer <SHARE_API_KEY>`. Transport is Streamable HTTP:
clients may POST JSON-RPC and either accept `application/json` (classic single
response) or `text/event-stream` (each response delivered as one SSE `message`
event). `GET /mcp` returns `405` because every tool resolves synchronously and
this server has nothing to push; `DELETE /mcp` is accepted to satisfy the
session-terminate semantics in newer clients.

**Methods supported:** `initialize`, `tools/list`, `tools/call`, `ping`,
`notifications/initialized`. Unknown methods return JSON-RPC `-32601`.

**Tools:**

| Name | Purpose |
|---|---|
| `share_publish_html` | Publish self-contained HTML at a slug. |
| `share_get_html` | Fetch a published share by slug (HTML + metadata). |
| `share_delete` | Delete an HTML share. Requires the original `edit_token`. |
| `share_upload_media` | Upload an image or short video (≤50 MB, body base64-encoded). |
| `share_get_media_meta` | Look up metadata for a previously uploaded media file. |
| `share_delete_media` | Delete a previously uploaded media file. |

Call `tools/list` to retrieve the full JSON Schema for each tool — every
description includes constraints (slug pattern, size limits, supported MIME
types, edit_token semantics) the agent needs to call the tool correctly.

**Conventions:**
- All tools accept and return JSON. `share_upload_media` carries binary as
  `body_base64` (standard alphabet, padding optional).
- Tool failures return `{ isError: true, content: [{ type: 'text', text: '<json error>' }] }`
  with a stable `error` code (`bad_slug`, `slug_conflict`, `not_found`,
  `forbidden`, `payload_too_large`, `magic_mismatch`, `unsupported_media_type`,
  `bad_edit_token`, `bad_args`, `bad_base64`).
- For uploads larger than ~30 MB the agent should call HTTP `POST /upload`
  directly with raw bytes — base64-in-JSON inflates the payload by ~33%.

**Quick example (curl):**

```bash
# 1) handshake
curl -sX POST https://<host>/mcp \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# 2) list tools
curl -sX POST https://<host>/mcp \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) call a tool
curl -sX POST https://<host>/mcp \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"share_publish_html",
        "arguments":{"slug":"2026-05-08-hello-abc","edit_token":"'"$(openssl rand -hex 16)"'","html":"<!doctype html><p>hi</p>"}
      }}'
```

## Local development

```bash
pnpm dev        # wrangler dev with Miniflare
pnpm test       # vitest + Miniflare
```

## Storage layout

```
SHARES (KV namespace)
  key:      <slug>                       e.g. 2026-05-08-trip-notes-x7k
  value:    <self-contained HTML blob>
  metadata: {edit_token, created_at, expires_at, original_filename,
             source_ext, size_bytes}
  TTL:      respects `expires_in_seconds` from publish requests

MEDIA (R2 bucket: mdeditor-share-media)
  key:            f/<id>.<ext>           e.g. f/x7k9p2qm0abc.png
  body:           raw file bytes (≤ 50 MB)
  httpMetadata:   {contentType}
  customMetadata: {edit_token, original_filename (URI-encoded),
                   expires_at (ISO or empty), size_bytes}
  expiry:         lazy — checked on GET, expired objects are deleted
                  on first read after expires_at
```
