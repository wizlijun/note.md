# Assistant Mail Plugin

Plugin v2 client for the independent `assistant-mail-worker/` deployment. It
stores raw MIME and structured source records only under the host-provided
private plugin `data_dir`; it never writes those records into the Vault.

## Security boundary

- `config.json` contains only the Worker origin.
- Release builds accept only `https://mail.5000g.com` and its named Worker
  fallback, preventing a settings change from forwarding the retained key to
  an arbitrary origin.
- The single Worker access key is stored in macOS Keychain under service
  `net.notemd.assistant-mail`, account `worker-access-key`.
- CLI commands never accept or return the key and never return raw MIME,
  subjects, bodies, headers or unmasked sender addresses.
- The trusted plugin window separately lists every locally archived message and
  renders only decoded plain text. HTML and remote resources are never rendered;
  Agent CLI projections remain metadata-only.
- Sender filtering is a user-controlled Worker policy. Opening setup mode allows
  provider forwarding confirmation mail for one hour, after which strict mode
  returns automatically. Save the exact SMTP envelope sender and enable strict
  filtering after confirmation. Recipient validation cannot be turned off.
- Deletion has no CLI execute command. The trusted plugin window can load the
  exact plan ID produced by an Agent's CLI call, display that plan/hash, require
  the user to type `DELETE`, and re-fetch the plan before committing it.

The supported Agent contract is the plugin CLI above. The current native plugin
runtime is not an operating-system security boundary against another process
already running as the same macOS user: such a process may be able to inspect
the private archive or invoke the plugin protocol directly. Strong isolation
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
