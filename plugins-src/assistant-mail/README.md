# Assistant Mail Plugin

Plugin v2 client for the independent `assistant-mail-worker/` deployment. It
stores raw MIME and structured source records only under the host-provided
private plugin `data_dir`; it never writes those records into the Vault.

## Security boundary

- `config.json` contains only the Worker origin.
- The manifest declares `vault.read` and `vault.write` so installation consent
  accurately discloses the Vault-local credential access.
- Release builds accept only `https://mail.5000g.com` and its named Worker
  fallback, preventing a settings change from forwarding the retained key to
  an arbitrary origin.
- The single Worker access key is stored as
  `<vault>/.notemd/assistant-mail/.local/access-key`. The plugin creates the
  plugin and `.local` directories with mode `0700`, writes the key atomically
  with mode `0600`, rejects symlinked internal paths, and maintains
  `<vault>/.notemd/assistant-mail/.gitignore` with `.local/`.
- CLI commands never accept or return the key and never return raw MIME,
  subjects, bodies, headers or unmasked sender addresses.
- The trusted plugin window separately lists every locally archived message.
  HTML MIME parts are bounded, sanitized and rendered inside an empty-permission
  sandbox iframe with a deny-by-default CSP; scripts, forms, frames, navigation
  attributes and remote resources are removed or blocked. Plain-text messages
  use an escaped text fallback. Agent CLI projections remain metadata-only.
- Sender filtering is a user-controlled Worker policy. Opening setup mode allows
  provider forwarding confirmation mail for one hour, after which strict mode
  returns automatically. Save the exact SMTP envelope sender and enable strict
  filtering after confirmation. Recipient validation cannot be turned off.
- Deletion has no CLI execute command. The trusted plugin window can load the
  exact plan ID produced by an Agent's CLI call, display that plan/hash, require
  the user to type `DELETE`, and re-fetch the plan before committing it.

The key file is plaintext inside the Vault. `.gitignore` prevents note.md's Git
sync from committing it, but does not protect it from another process or Agent
already running as the same OS user, nor from non-Git backup/sync software. The
supported Agent contract is the metadata-only plugin CLI; strong isolation
would require a host-owned secret/decryption broker in a later host version.

## CLI

```text
notemd mail-status
notemd mail-sync
notemd mail-query [--text ...] [--status ...] [--date YYYY-MM-DD --timezone Asia/Taipei] [--limit 20]
notemd mail-delete-plan --source-ids uuid-1,uuid-2
notemd mail-delete-status (--plan uuid | --job uuid)
```

`mail-query` always returns a fail-closed metadata projection and local
coverage/gap information. A date and an IANA timezone must be supplied
together; the plugin never guesses the system timezone.

## Development checks

```sh
cargo test --locked --manifest-path plugins-src/assistant-mail/backend/Cargo.toml
pnpm --filter assistant-mail-plugin check
pnpm --filter assistant-mail-plugin test
pnpm --filter assistant-mail-plugin build
scripts/dev-install-plugin.sh assistant-mail
```
