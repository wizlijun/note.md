# @openclaw/mdeditor

OpenClaw channel plugin: bridges a local note.md desktop client to OpenClaw via a
Unix Domain Socket. No TCP/HTTP/WS ports are opened by this plugin.

## Install (local path)

In `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "mdeditor": { "type": "localPath", "path": "extensions/mdeditor" }
    }
  },
  "channels": {
    "mdeditor": {
      "enabled": true,
      "accounts": {
        "default": {
          "socketPath": "~/.openclaw/mdeditor.sock"
        }
      }
    }
  }
}
```

`accessToken` is auto-generated on first launch and persisted into the config
via `api.config.write`. To rotate, delete it and restart OpenClaw.

## Test

    cd ~/git/openclaw/extensions/mdeditor
    pnpm test

## Wire protocol

See `mdeditor/docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md`
sections 2.2-2.3.
