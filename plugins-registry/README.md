# notemd-plugins registry Worker

Cloudflare Worker backing the note.md v2 **plugin marketplace**. KV holds the
published `index.json`; R2 holds the `.notemdpkg` packages and their `.minisig`
signatures. The desktop client
(`src-tauri/src/plugin_runtime/market.rs`) reads this worker at
`https://plugins.notemd.net`; the CLI (`notemd plugin install/update/remove`)
uses the same endpoints.

Packages are minisign-signed and sha256-pinned in the index, so integrity is
verified **client-side**. Every route here is public — there is nothing secret
to protect on read, which is why CORS is `*`.

## Routes

- `GET /api/index.json` — the published index verbatim from KV key `index`
  (`{"plugins":[]}` when unpublished). `content-type: application/json`,
  `cache-control: public, max-age=300`, `access-control-allow-origin: *`.
- `GET /api/download/<id>/<version>/<arch>` — streams R2 object
  `<id>/<version>/<arch>.notemdpkg` as `application/octet-stream`. `404` if
  absent.
- `GET /api/download/<id>/<version>/<arch>.minisig` — streams R2 object
  `<id>/<version>/<arch>.notemdpkg.minisig` (the detached minisign signature).
  The client's signature URL is always the package URL + `.minisig`.
- `POST /api/stats/install` — body `{id,version}`; bumps KV counter
  `stats:<id>`. Fire-and-forget: **always** returns `200 {"ok":true}`, even on a
  malformed body or a KV error, so install telemetry can never block or surface
  to the user.
- `OPTIONS *` → `204` CORS preflight. Wrong method → `405`. Unknown path →
  `404`.

### R2 key layout

```
<id>/<version>/<arch>.notemdpkg           # the gzip'd-tar package
<id>/<version>/<arch>.notemdpkg.minisig   # detached minisign signature
```

e.g. `notemd.md2pdf/1.2.0/aarch64-apple-darwin.notemdpkg`.

## One-time setup (user steps — NOT done by CI)

The GitHub Actions workflow only runs `wrangler deploy`; it does **not** create
the KV namespace, R2 bucket, or custom domain. Do these once by hand:

```bash
cd plugins-registry
pnpm install          # isolated: this dir has its own lockfile, it is NOT in
                      # the pnpm workspace (matches worker/)
wrangler login

# 1. Create the KV namespace, then paste the printed `id` into
#    kv_namespaces[0].id in wrangler.toml (replacing REPLACE_WITH_KV_NAMESPACE_ID).
wrangler kv namespace create INDEX

# 2. Create the R2 buckets. Names match wrangler.toml.
wrangler r2 bucket create notemd-plugins
wrangler r2 bucket create notemd-plugins-preview   # used by `wrangler dev` / tests

# 3. First deploy.
wrangler deploy
```

### Custom domain `plugins.notemd.net`

`wrangler.toml` already declares the `plugins.notemd.net` custom-domain route.
For it to bind:

1. `notemd.net` must be a zone on your Cloudflare account (DNS on Cloudflare).
2. `wrangler deploy` provisions the route + certificate for `plugins.notemd.net`.

Until DNS resolves, the worker is also reachable at
`https://notemd-plugins.<account>.workers.dev`. The client's base URL is
overridable via note.md `settings.json` → `plugins_v2.registry_url` if you need
to point at the `workers.dev` host or a mirror during setup.

### CI deploy secret

The `.github/workflows/deploy-plugins-registry.yml` workflow deploys on every
push to `main` that touches `plugins-registry/**`. It needs the repo secret
**`CLOUDFLARE_API_TOKEN`** (a token with *Edit Cloudflare Workers* permission on
this account) — the same secret the share worker uses. Create it under
*Settings → Secrets and variables → Actions* if it does not already exist.

## Publishing flow — how index.json + packages get into KV/R2

Content is produced by the release pipeline (Task 5,
`scripts/release-plugins.sh` + `scripts/gen-plugin-index.mjs`), which:

1. builds each plugin, packages it into `.notemdpkg`, signs it with minisign
   (`.notemdpkg.minisig`), and computes its sha256;
2. generates `dist-plugins/index.json` (the `RegistryEntry[]` shape this worker
   serves — id / version / min_host / archs / size / sha256 / name /
   download-URLs, etc.).

Upload the artifacts to R2 and publish the index to KV (these are the `wrangler`
commands the release script prints at the end — run them manually, they are the
`.notemdpkg` upload + index publish, not part of CI):

```bash
# Packages + signatures → R2, keyed <id>/<version>/<arch>.notemdpkg[.minisig]
wrangler r2 object put notemd-plugins/notemd.md2pdf/1.2.0/aarch64-apple-darwin.notemdpkg \
  --file dist-plugins/notemd.md2pdf/1.2.0/aarch64-apple-darwin.notemdpkg
wrangler r2 object put notemd-plugins/notemd.md2pdf/1.2.0/aarch64-apple-darwin.notemdpkg.minisig \
  --file dist-plugins/notemd.md2pdf/1.2.0/aarch64-apple-darwin.notemdpkg.minisig

# The full index → KV key `index`
wrangler kv key put index --path dist-plugins/index.json --binding INDEX
```

Reading the install counter for a plugin:

```bash
wrangler kv key get stats:notemd.md2pdf --binding INDEX
```

## Development & tests

```bash
cd plugins-registry
pnpm install
pnpm test          # vitest + @cloudflare/vitest-pool-workers (miniflare KV/R2)
pnpm dev           # wrangler dev — local worker against the preview bucket
```
