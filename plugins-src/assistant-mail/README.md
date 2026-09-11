# Assistant Mail Plugin

Plugin v2 client for the independent `assistant-mail-worker/` deployment. It
stores raw MIME and structured source records only under the host-provided
private plugin `data_dir`; it never writes those records into the Vault.

## Security boundary

- `config.json` contains only the Worker origin.
- The single Worker access key is stored in macOS Keychain under service
  `net.notemd.assistant-mail`, account `worker-access-key`.
- CLI commands never accept or return the key and never return raw MIME,
  subjects, bodies, headers or unmasked sender addresses.
- Deletion has no CLI execute command. The trusted plugin window can load the
  exact plan ID produced by an Agent's CLI call, display that plan/hash, require
  the user to type `DELETE`, and re-fetch the plan before committing it.

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
