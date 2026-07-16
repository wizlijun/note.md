# @openclaw/notemd

OpenClaw channel plugin: bridges a local note.md desktop client to OpenClaw via a
Unix Domain Socket. No TCP/HTTP/WS ports are opened by this plugin.

## Install (local path)

In `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "notemd": { "type": "localPath", "path": "extensions/notemd" }
    }
  },
  "channels": {
    "notemd": {
      "enabled": true,
      "accounts": {
        "default": {
          "socketPath": "~/.openclaw/notemd.sock"
        }
      }
    }
  }
}
```

`accessToken` is auto-generated on first launch and persisted into the config
via `api.config.write`. To rotate, delete it and restart OpenClaw.

## Test

    cd ~/git/openclaw/extensions/notemd
    pnpm test

## Wire protocol

See `notemd/docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md`
sections 2.2-2.3.
