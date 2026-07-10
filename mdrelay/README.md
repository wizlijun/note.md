# mdrelay

Cloudflare Worker brokering WSS connections between one note.md host (paired to a
local OpenClaw) and N remote note.md devices. WSS-only — no end-to-end encryption.
Spec: `docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md`,
Section 3.

## Local dev

    pnpm install
    echo 'SIGNING_KEY=$(openssl rand -hex 32)' > .dev.vars
    pnpm dev          # http://127.0.0.1:8787
    pnpm test         # vitest-in-workerd

## Deploy

    wrangler secret put SIGNING_KEY   # set a strong production secret (>= 32 bytes)
    wrangler deploy

Add the custom domain by uncommenting `routes` in `wrangler.toml` and pointing
your DNS at Cloudflare.

## Endpoints

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET  | `/health` | none | - | `{"ok":true}` |
| POST | `/pair/create` | none | - | `{ code, pairingId, expiresAt }` |
| POST | `/pair/host-bootstrap` | none | `{ pairingId }` | `{ device_token }` |
| POST | `/pair/claim` | none | `{ code, hostname? }` | `{ device_token, pairingId, deviceId }` |
| GET  | `/ws/host?token=...` | device_token (host) | upgrade | WS |
| GET  | `/ws/remote?token=...` | device_token (remote) | upgrade | WS |
| POST | `/device/revoke` | Bearer host token | `{ deviceId }` | `ok` |
| GET  | `/device/pending-claims` | Bearer host token | - | JSON array |

## Limits

- Pairing code: 2 minutes, single-use
- Offline buffer per device: max 50 frames OR 1 MB OR 24h (whichever hits first)
- WS frame routing: `to ∈ {"host","remote:<id>","broadcast"}`, `from` matches sender

## Wire frame

    {
      "to": "host" | "remote:<deviceId>" | "broadcast",
      "from": "host" | "remote:<deviceId>",
      ... payload fields per spec Section 2.3 ...
    }
