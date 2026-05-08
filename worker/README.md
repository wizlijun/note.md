# mdeditor-share Worker

Cloudflare Worker backing the M↓ "Share" plugin. Three routes, KV-backed.

## Routes

- `POST /publish` — `Authorization: Bearer <SHARE_API_KEY>`. Body: `{slug, edit_token, html, expires_in_seconds?, metadata}`.
- `GET /:slug` — public; returns the stored HTML or a 410 page.
- `DELETE /:slug` — `Authorization: Bearer <SHARE_API_KEY>`. Body: `{edit_token}`.

## One-time setup

```bash
cd worker
pnpm install
wrangler login

# Create the KV namespace; copy the printed `id` into `kv_namespaces[0].id`
# inside wrangler.toml.
wrangler kv:namespace create SHARES

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
```
