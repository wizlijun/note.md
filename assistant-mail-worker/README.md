# Assistant Mail Worker

Cloudflare Email Worker for note.md's assistant-mail intake. It is kept in the
same repository as `mdeditor-share`, but deploys as a separate Worker with
separate storage, credentials, routes, and rollback boundaries.

## Current production deployment

As of 2026-09-11, the independent service is deployed at
`https://mail.5000g.com` (with
`https://notemd-assistant-mail.oldbruce.workers.dev` retained as a deployment
fallback) with:

- Email Routing: `xiaobu@5000g.com` → `notemd-assistant-mail` (active);
- custom domain: `mail.5000g.com`, under the same `5000g.com` zone as the
  Share Worker;
- exact allowed SMTP envelope sender: `newbruce@gmail.com`;
- D1: `notemd-assistant-mail` in APAC;
- R2: `notemd-assistant-mail-raw` and its preview bucket;
- Queue: `notemd-assistant-mail-processing` with a separate dead-letter queue;
- `ASSISTANT_MAIL_ACCESS_KEY` provisioned as a hidden Worker secret and stored
  locally in the plugin's macOS Keychain entry.

This status confirms infrastructure and routing only. No live email was sent as
part of deployment, and the M0 content-processing limitations documented in the
design spec still apply.

## Security boundary

- Email Routing must route exactly one assistant address to this Worker.
- `ALLOWED_FORWARDER` and `ASSISTANT_MAIL_ADDRESS` are matched
  case-insensitively and exactly against the SMTP **envelope sender and
  recipient** (`message.from` / `message.to`). A mismatch calls `setReject()`
  before reading the raw stream or persisting anything. Display names and inner
  `From:` / `To:` headers are not used for admission.
- HTTP endpoints require the single deployment credential in
  `Authorization: Bearer <ASSISTANT_MAIL_ACCESS_KEY>`.
- The access key must be stored by the note.md plugin in the operating-system
  keychain. Never put it in a Vault file, ordinary plugin settings, command-line
  argument, log, or Agent prompt.
- Raw mail is always returned as a download with `message/rfc822`, `nosniff`,
  and `no-store`; the Worker never renders HTML or loads remote resources.
- The Worker authenticates the plugin deployment, not an individual Agent.
  The plugin keeps the key out of Agent-visible interfaces and requires a
  trusted user gesture before it calls the deletion execute endpoint. If a
  client supplies `X-Agent-Id`, it is recorded only as a sanitized
  `unverified:` hint; the M0 plugin does not claim per-Agent identity or local
  query audit, and the single Bearer key cannot provide either cryptographically.

## Storage and recovery model

Accepted raw messages are first written to `staging/<source-id>.eml` in private
R2, then recorded in D1 as `received_pending`. Queue consumption copies them to
`raw/<source-id>.eml`, removes staging, marks them `ready`, and emits a monotonic
change. The scheduled handler retries pending promotions, so a Queue dispatch
failure does not lose an accepted message.

D1 records sources, every accepted/duplicate delivery, incremental changes,
minimal access audit events, deletion plans, and deletion jobs. Message bodies
are never copied into D1. Exact duplicates share one source while retaining an
auditable delivery row.

R2 and D1 do not share a transaction. The staging state machine deliberately
makes every interrupted transition retryable. Operational monitoring should
alert on old `received_pending` sources and failed deletion jobs.

## HTTP API

All JSON responses use `{ "data": ... }`; errors use
`{ "error": { "code": "...", "message": "..." } }`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/whoami` | Validate the service, mailbox, forwarder, and key fingerprint |
| `GET` | `/v1/status` | Coverage, source/delivery counts, and change high-watermark |
| `GET` | `/v1/changes?after=&limit=` | Monotonic upsert/tombstone feed; cursor is opaque |
| `GET` | `/v1/sources?limit=` | List non-deleted source metadata |
| `GET` | `/v1/sources/:id` | Get non-deleted source metadata |
| `GET` | `/v1/sources/:id/raw` | Download raw MIME for local plugin processing |
| `GET` | `/v1/messages/:id/raw` | Compatibility alias for the raw download |
| `POST` | `/v1/deletion-plans` | Freeze an exact deletion impact plan |
| `GET` | `/v1/deletion-plans/:id` | Inspect the frozen plan and hash |
| `POST` | `/v1/deletion-plans/:id/execute` | Confirm and execute that exact plan |
| `GET` | `/v1/deletion-jobs/:id` | Inspect deletion/retry status |

Create a plan with an explicit bounded ID list:

```json
{ "source_ids": ["00000000-0000-4000-8000-000000000001"] }
```

After the plugin displays the complete impact to the user, execute it with the
unchanged hash:

```json
{ "plan_hash": "<sha256 from plan>", "confirmation": "DELETE" }
```

Execution first marks every source `deleting` and appends a tombstone in one D1
batch. Every source/raw read then returns `410`, even if R2 deletion subsequently
fails. The deletion job removes all possible staging/final R2 keys, verifies
their absence, clears source headers/content hashes and delivery content hashes,
sanitizes the completed plan, and marks the sources deleted. A failed job
remains unreadable and is retried by the scheduled handler. Minimal audit
records and tombstones remain; they contain identifiers and operation facts,
not message content.

Cloudflare R2 deletion is strongly consistent, but D1 Time Travel may retain
database history for the account's configured platform window. Restoring D1
must be followed by replaying retained tombstones before read traffic is
enabled. See Cloudflare's [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
and [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
documentation.

## Local setup

1. Install dependencies with `pnpm install`.
2. Run `pnpm test` and `pnpm typecheck`.
3. For a new environment, create separate production D1, R2, processing Queue,
   and dead-letter Queue.
4. Set that environment's D1 `database_id`, `ALLOWED_FORWARDER`, and
   `ASSISTANT_MAIL_ADDRESS` in `wrangler.toml`.
6. Generate a random 256-bit key locally and provide it interactively with
   `pnpm wrangler secret put ASSISTANT_MAIL_ACCESS_KEY`. Do not commit the value.
7. Configure Cloudflare Email Routing for the single assistant address.
8. Deploy with `pnpm deploy` only after verifying the production bindings.

`wrangler.toml` intentionally contains no account ID or real secret. Resource
names and the non-secret D1 identifier are committed; the access key is not.
