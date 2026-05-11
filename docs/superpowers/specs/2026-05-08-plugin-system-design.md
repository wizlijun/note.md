# Plugin System — Design

**Status**: Brainstorm complete; pending implementation plan
**Date**: 2026-05-08
**Owner**: bruce@hemory.com
**Driving use case**: "Share via Cloudflare" feature — see companion spec
`2026-05-08-mdshare-plugin-design.md`

## Goal

Introduce a minimal in-app plugin abstraction so that **infrequently-used
features can live outside the main program**, keeping M↓'s core small,
fast-launching, and lean in memory.

The plugin system enables out-of-process features (starting with file sharing
via Cloudflare Workers) to integrate with M↓ via menu items, context-menu
items, keyboard shortcuts, and a Preferences settings tab — all declaratively
contributed — and to execute as short-lived subprocesses communicating with
the host over stdin/stdout JSON.

This spec defines **only the platform**. The first plugin implementation is a
separate spec.

## Motivating principles

These principles drive every design decision below; non-negotiable.

1. **The main program stays small and fast to launch.** A user who never
   touches a plugin pays effectively nothing for the plugin system: no extra
   bundled libraries, no warmed runtimes, no background processes.
2. **Infrequently-used features belong outside.** "Share to web", "publish
   to blog", "export to S3" — features used a few times per session at
   most — are exactly the candidates for plugin-ization. Core editing,
   rendering, file watching, autosave stay in the main program.
3. **Plugins are dormant until invoked.** No plugin code (binary) runs at
   M↓ startup. Only manifest JSON files are read — a one-time, cheap parse.
4. **Plugin processes are ephemeral.** Each invocation spawns the binary,
   does one thing, exits. No long-running plugin daemons add to memory or
   warm-up cost.
5. **Adding a plugin must not slow startup.** The cost of registering a
   plugin at startup is bounded to: read one ~1 KB JSON file, validate it,
   add a few menu items. No I/O against the plugin binary itself.

## Non-goals (v1)

The system is intentionally narrow:

- ❌ Running any plugin code at startup (would violate the
  fast-launch principle)
- ❌ Pre-warming plugin processes, caching binaries in RAM, or any other
  mechanism that trades memory for invocation latency
- ❌ Third-party plugin install / uninstall / update UI — only plugins bundled
  with M↓ are supported
- ❌ Sandboxing beyond OS process isolation (no seccomp / capability
  enforcement at the syscall layer)
- ❌ Inter-plugin calls or plugin-to-plugin dependencies
- ❌ A complete expression language for `enabled_when` — only dotted paths,
  bracketed indexing, and unary `!`
- ❌ Plugin-registered renderers (the existing `src/lib/adapters/renderer-registry.ts`
  is unrelated and stays as is)
- ❌ Bidirectional / streaming IPC — strictly one request, one response
- ❌ Hot reload / live update of plugins
- ❌ Marketplace, signing, or trust UX

When (if) any of these become real needs, they extend this spec rather than
replace it.

## Driving requirements (from the share use case)

The share feature drives these concrete requirements that the platform must
satisfy:

1. Add a menu item to the **File** menu with a global shortcut (`Cmd+Shift+L`).
2. Add three more menu items whose **enabled state** depends on whether the
   current tab has been shared before.
3. Add a **right-click context menu item** on tabs.
4. Add a **Preferences tab** with four settings fields (string, secret, select,
   boolean).
5. The plugin needs the **rendered HTML** of the current tab (not just the
   raw source) — to avoid renderer drift between the desktop view and the
   shared output.
6. The plugin needs to **read and write its own settings**, including a
   `share.records` map persisted across launches.
7. The plugin needs to **write to the clipboard**, **show toasts**, and (in
   rare cases) **show a confirm dialog**.
8. The plugin must run reliably on both `aarch64-apple-darwin` and
   `x86_64-apple-darwin`, since M↓ ships a universal binary.

These requirements directly shape the host-capabilities and action sets below.
A second plugin (e.g. blog-publish, export-to-S3) should fit through the same
contract without changes.

## Architecture

```
                        ┌─────────────────────────────┐
                        │   M↓ (Tauri main process)   │
                        │                             │
                        │  ┌─────────────────────┐    │
   App start ──scan──→  │  │ plugin-registry.ts  │    │
                        │  │  reads manifests    │    │
                        │  └──────────┬──────────┘    │
                        │             │               │
                        │  ┌──────────┴──────────┐    │
                        │  │ menu-registry.ts    │    │
                        │  │ settings-registry.ts│    │
                        │  └──────────┬──────────┘    │
                        │             │               │
                        │  ┌──────────┴──────────┐    │
                        │  │ Tauri menu / dialog │    │
                        │  │ / settings UI       │    │
                        │  └──────────┬──────────┘    │
                        │             │               │
                        │             │ user click    │
                        │             ↓               │
                        │  ┌─────────────────────┐    │
                        │  │ plugin-host.ts      │    │
                        │  │ (TS frontend)       │    │
                        │  └──────────┬──────────┘    │
                        │             │ invoke        │
                        │             ↓               │
                        │  ┌─────────────────────┐    │
                        │  │ plugin_host.rs      │    │
                        │  │ (Rust backend)      │    │
                        │  └──────────┬──────────┘    │
                        └─────────────┼───────────────┘
                                      │
                                      │ Command::spawn
                                      ↓
                        ┌─────────────────────────────┐
                        │   plugin binary             │
                        │   (one-shot subprocess)     │
                        │                             │
                        │   stdin  ←  request JSON    │
                        │   stdout →  response JSON   │
                        │   stderr →  log lines       │
                        └─────────────────────────────┘
```

### Process model

- **One-shot subprocess.** Each invocation spawns the plugin binary, sends one
  JSON line on stdin, reads one JSON line from stdout, then waits for exit.
  No long-lived processes, no heartbeat, no restart logic.
- **Rationale.** Plugins are invoked by user gestures (menu click). Latency
  budget is hundreds of milliseconds. Rust binaries cold-start in 30–60 ms;
  the JSON round-trip dominates only when the payload is large (e.g.
  rendered HTML). Statelessness eliminates whole categories of bugs (memory
  leaks, hung daemons, restart races).
- **Timeout.** Default 30 seconds; overridable per plugin via
  `manifest.timeout_seconds`. On timeout the host kills the process group
  (SIGKILL), emits a toast `❌ <plugin name> 未响应`, and discards stderr
  except for the last 1 KB which is shown in the toast detail expander.
- **Stderr.** Captured in full but capped at 16 KB. Forwarded to the
  developer console (`console.warn` prefixed `[plugin:<id>]`) for debugging,
  and to the toast detail expander on errors.
- **Concurrency.** Each invocation is independent. The host does not
  serialise calls, but the UI may (e.g. menu item is disabled while its own
  invocation is in flight). Two different commands can run in parallel.

### IPC payloads

#### Request (host → plugin, stdin, single line of UTF-8 JSON, terminated by `\n`)

```json
{
  "command": "publish",
  "context": {
    "tab": {
      "path": "/Users/bruce/notes/foo.md",
      "filename": "foo.md",
      "extension": "md",
      "is_dirty": false,
      "is_untitled": false
    },
    "rendered_html": "<!doctype html>...",
    "raw_content": "# Foo\n..."
  },
  "settings": {
    "share.baseUrl": "https://...",
    "share.apiKey": "<api-key-string>",
    "share.defaultExpiry": "never",
    "share.slugRandomSuffix": true,
    "share.records": { "/Users/bruce/notes/foo.md": { "slug": "...", "editToken": "..." } }
  },
  "host_version": "0.2.0",
  "plugin_api_version": 1
}
```

- `command` is one of the values referenced by the plugin's `menus[].command`
  or `context_menus[].command` (see manifest below).
- `context.rendered_html` is included **only if** the plugin's manifest
  declares `host_capabilities` includes `renderer.html`. Same for
  `context.raw_content` and `renderer.raw`. If neither is declared, the
  whole `context.tab` block is still included (it's cheap metadata only).
- `settings` is included **only if** the plugin declares `settings.read`,
  and even then is restricted to `<plugin-id>.*` keys defined in the
  plugin's own settings schema. Other settings keys are not visible to
  the plugin.
- `plugin_api_version` is a single integer. v1 only; future bumps reserved
  for breaking changes (none planned).

#### Response (plugin → stdout, single line of UTF-8 JSON)

```json
{
  "success": true,
  "actions": [
    { "type": "toast",            "level": "success", "message": "✅ ...", "detail": "https://..." },
    { "type": "clipboard.write",  "text": "https://..." },
    { "type": "settings.merge",   "patch": { "share.records": { "...": { "slug": "...", "editToken": "..." } } } }
  ]
}
```

Or:

```json
{
  "success": false,
  "actions": [
    { "type": "toast", "level": "error", "message": "❌ 分享失败：网络错误", "detail": "fetch timeout after 10s" }
  ]
}
```

Rules:
- `actions` is executed by the host in array order.
- An action whose `type` is not in the plugin's declared `host_capabilities`
  is **dropped silently with a `console.warn`** (no toast — the plugin author
  should fix their manifest).
- An action whose `patch` references settings keys outside the plugin's
  scope (`<plugin-id>.*`) is rejected with the same warning.
- An invalid response (non-JSON, missing `success`, malformed `actions`) is
  reported as `❌ <plugin name>: 协议错误` toast.
- `success` is purely informational — the actions list is what the host
  acts on. (E.g. some plugins might return `success: true` while still
  surfacing a warning toast.)

### Host capabilities

Capability strings declared in `manifest.host_capabilities`. The host honours
exactly these and rejects anything else. Capabilities are declarative — they
gate both what the request payload contains AND which action types the plugin
may emit.

| Capability | What it enables | Notes |
|---|---|---|
| `renderer.html` | `context.rendered_html` populated | Host runs the moraya pipeline + image-inline pass before invoke |
| `renderer.raw` | `context.raw_content` populated | Cheap; just read tab buffer |
| `settings.read` | `settings` field populated | Always scoped to `<plugin-id>.*` |
| `settings.write:<scope>` | `settings.merge` action allowed for keys matching the scope. Scope is either an exact key (`share.records`) or a single trailing wildcard (`share.*` matches `share.foo` but not `share.foo.bar`). Multiple `settings.write:<scope>` capabilities may be declared | Always implicitly scoped under `<plugin-id>.*` — a plugin cannot escape its own namespace |
| `clipboard.write` | `clipboard.write` action allowed | Tauri `clipboard-manager` plugin |
| `toast` | `toast` action allowed | Maps to in-app Toast component |
| `dialog` | `dialog.confirm` and `dialog.message` actions allowed | Tauri `dialog` plugin |

For v1, exactly these seven capabilities exist. New capabilities require
extending the host (and the manifest validator), which is intentional.

### Actions

Action types emitted by plugins:

- `toast`
  ```json
  { "type": "toast", "level": "success" | "info" | "warn" | "error",
    "message": "string ≤ 200 chars",
    "detail": "optional string ≤ 2KB, shown in expandable details" }
  ```
- `clipboard.write`
  ```json
  { "type": "clipboard.write", "text": "string ≤ 1MB" }
  ```
- `settings.merge`
  ```json
  { "type": "settings.merge", "patch": { "<plugin-id>.<key>": <any-json> } }
  ```
  Replaces the value at each fully-qualified key in the existing settings
  store. The patch is treated as a flat key→value map: each key replaces its
  prior value entirely (no recursive object merge). Plugins that need to
  preserve other entries under the same parent key (e.g. `share.records`
  storing many file paths) MUST read the current value with `settings.read`
  and write back the full updated map. Keys outside the plugin's declared
  `settings.write:*` scopes are dropped.
- `dialog.confirm` (Note: blocking; plugin process has already exited, so this
  is fire-and-forget — the plugin cannot get the user's answer in v1. Use it
  for "are you sure?" follow-ups that produce a *new* invocation rather than
  in-flow decisions.)
  ```json
  { "type": "dialog.confirm", "title": "...", "message": "...",
    "if_confirm_invoke": "command-id" }
  ```
  When the user clicks confirm, the host re-invokes the plugin with that
  command and the same context. Cancel is a no-op.
- `dialog.message`
  ```json
  { "type": "dialog.message", "title": "...", "message": "...", "level": "info" | "warn" | "error" }
  ```

These five action types cover the share use case. Adding more (`open.url`,
`save.dialog`, `notification`) is a Spec 2 / future-spec discussion.

## Manifest format

`manifest.json` lives next to the plugin binary. Schema:

```jsonc
{
  "id": "share",                    // unique kebab-case; becomes settings prefix
  "name": "Share via Cloudflare",   // human-readable; shown in error toasts
  "version": "1.0.0",
  "description": "Publish current file as a shareable web page",

  "binary": "bin",                  // basename; host probes per platform (see below)

  "menus": [
    {
      "location": "file" | "edit" | "view" | "window" | "help" | "plugins",
      "label": "Share Current File...",
      "shortcut": "Cmd+Shift+L",    // optional; conflict-checked on registration
      "command": "publish",
      "enabled_when": "currentTab.hasContent"  // optional; default true
    }
  ],

  "context_menus": [
    {
      "location": "tab" | "editor",
      "label": "Share This Tab...",
      "command": "publish",
      "enabled_when": "currentTab.hasContent"
    }
  ],

  "settings": {
    "tab_label": "分享",            // Preferences tab title
    "schema": [
      { "key": "share.baseUrl",          "type": "string",  "label": "Base URL",  "default": "...", "placeholder": "..." },
      { "key": "share.apiKey",           "type": "secret",  "label": "API Key" },
      { "key": "share.defaultExpiry",    "type": "select",  "label": "默认有效期", "options": ["never","7d","30d","90d"], "default": "never" },
      { "key": "share.slugRandomSuffix", "type": "boolean", "label": "URL 添加 3 位随机后缀（推荐）", "default": true }
    ]
  },

  "host_capabilities": [
    "renderer.html", "settings.read", "settings.write:share.records",
    "clipboard.write", "toast", "dialog"
  ],

  "timeout_seconds": 30
}
```

### Binary resolution

`binary: "bin"` is resolved by suffixing the current platform target triple:

```
plugins/<id>/bin-aarch64-apple-darwin
plugins/<id>/bin-x86_64-apple-darwin
```

For a universal Tauri build, both must exist. The host picks based on the
running architecture. Missing binary → manifest is rejected at scan time
with a `console.error` (does not crash the app).

### `enabled_when` mini-expression

Supported grammar (intentionally tiny):

```
expr  := atom | "!" atom | atom "&&" atom | atom "||" atom
atom  := path | "(" expr ")" | "true" | "false"
path  := segment ( "." segment | "[" segment "]" )*
segment := identifier | quoted-string
```

Truthiness: standard JS (non-empty string, non-zero, non-null, non-empty
object/array → true).

The evaluation context exposes:
```ts
{
  currentTab: { path: string | null, filename: string | null,
                extension: string | null, hasContent: boolean,
                isDirty: boolean, isUntitled: boolean } | null,
  settings: { ... full plugin-scoped settings, lazy-evaluated ... }
}
```

Implementation: a hand-written recursive-descent parser of about 80 lines,
fully unit-tested. **No `eval`, no JS engine, no third-party expression
library.**

## File layout

### New files

```
src-tauri/
  plugins/                            # NEW directory; v1 ships empty (Spec 2 adds share/)
  src/
    plugin_host.rs                    # NEW — Rust host: spawn, IPC, timeout
  tests/
    fixtures/                         # NEW — shell-script test plugins (echo, sleep, crash, ...)

src/
  lib/
    plugins/                          # NEW — frontend host module
      registry.ts                     # scan + parse manifests, expose registry
      registry.test.ts
      menu-registry.ts                # build Tauri menus from manifests
      settings-registry.ts            # collect plugin settings schemas
      enabled-when.ts                 # mini-expression parser & evaluator
      enabled-when.test.ts
      host.ts                         # public: invokePlugin(id, command, context)
      host.test.ts
      action-handlers.ts              # apply toast/clipboard/settings.merge/dialog actions
      action-handlers.test.ts
      types.ts                        # shared TS types (Manifest, Request, Response, …)
  components/
    Toast.svelte                      # NEW — minimal in-app toast (right-bottom, auto-dismiss)
```

### Modified files

- `src-tauri/src/lib.rs` — add `mod plugin_host;`; register `invoke_plugin`
  and `get_plugin_manifests` Tauri commands; refactor menu construction so
  plugin-contributed items can be appended after the static items.
- `src-tauri/Cargo.toml` — add `tokio` features for process+timeout if not
  already enabled (`process`, `time`); add `serde_json`.
- `src-tauri/tauri.conf.json` — add `plugins/**` to `bundle.resources` so
  the `.app` includes them; ensure macOS code-signing covers them.
- `src/components/SettingsDialog.svelte` — render plugin-contributed tabs
  by querying `settings-registry.ts`.
- `src/lib/commands.ts` — extend the existing keyboard-shortcut map so
  plugin shortcuts route to `host.invokePlugin`. Detect collisions at
  startup and warn.
- `src/lib/settings.svelte.ts` — allow plugin-scoped keys (`<plugin-id>.*`)
  to be read/written through a typed accessor; existing M↓ keys remain
  untouched.

### Spec docs

```
docs/superpowers/specs/
  2026-05-08-plugin-system-design.md   # this file
  2026-05-09-mdshare-plugin-design.md  # next; references this
```

### Bundling

The `src-tauri/plugins/` directory is registered in `tauri.conf.json` under
`bundle.resources` so `cargo tauri build` copies the whole tree into the
`.app` bundle. At runtime, `plugin_host.rs` resolves the absolute path via
`tauri::path::resource_dir()`.

## Lifecycle

### Startup (must stay cheap)

Hard budget: plugin-system startup work must add **< 20 ms** to M↓ launch
on a 2020-era Mac with 5 plugins installed. Anything that grows with plugin
count (binary size, runtime warm-up) is forbidden at startup.

1. Tauri main process boots; `lib.rs` initializes plugins via
   `plugin_host::init(&app)`.
2. Rust scans `<resource_dir>/plugins/*/manifest.json` — a synchronous
   filesystem walk over a tiny directory. Only `manifest.json` files are
   read; **plugin binaries are never opened or `stat`'d at this stage**.
3. Each manifest is JSON-parsed and validated against a JSON Schema
   (rejected manifests `eprintln!` and skip; do not block boot).
4. Validated manifests are passed to the frontend lazily via a
   `get_plugin_manifests` Tauri command — invoked when the menu bar or
   Preferences first needs them, not on the boot critical path.
5. Frontend `registry.ts` populates the in-memory plugin registry, then:
   - `menu-registry.ts` calls into Tauri's menu APIs to add items (this is
     the only IO touching plugin metadata; binaries remain on disk untouched)
   - `settings-registry.ts` registers tabs with `SettingsDialog.svelte`
6. Each menu item's click handler calls
   `host.invokePlugin(plugin_id, command, buildContext())` — **this is the
   first time the plugin binary is read off disk in the user's session.**

### Per-invocation flow

1. UI gesture → `host.invokePlugin('share', 'publish', context)`.
2. Frontend gathers `context`:
   - Reads current tab metadata
   - If plugin has `renderer.html`: re-renders current tab via moraya
     and inlines images (using the same logic the share-spec defines —
     the call site is the **share plugin spec**, not this one; this spec
     just defines that `renderer.html` *is* a capability and what it
     produces)
   - Reads scoped settings from the store
3. Frontend invokes Tauri command `invoke_plugin(id, command, request_json)`.
4. Rust host:
   - Looks up manifest; resolves binary path
   - `tokio::process::Command::spawn` with stdin/stdout/stderr piped
   - Writes `request_json + "\n"` to stdin, closes stdin
   - Reads first line of stdout (up to first `\n`) under the timeout. Any
     additional stdout bytes after the first line are discarded.
   - Reads stderr to EOF concurrently (capped at 16 KB)
   - Awaits exit; treats non-zero exit as failure even if stdout had a
     valid response line
5. Rust returns `Result<String, PluginError>` to frontend.
6. Frontend parses response JSON; validates against plugin's declared
   `host_capabilities`; runs `action-handlers.ts` to apply each action in
   order.

### Errors

| Failure | Detection | User-facing | Internal |
|---|---|---|---|
| Manifest malformed at scan time | JSON Schema validation | Nothing (not yet active) | `eprintln!` on Rust side; not in toast |
| Binary missing | scan time | Nothing | `eprintln!` |
| Subprocess spawn fails | invoke time | `❌ <name>: 启动失败` toast | OS error in detail |
| Subprocess timeout | invoke time | `❌ <name>: 未响应（30s）` | last 1 KB stderr in detail |
| Plugin returns non-zero exit code | invoke time | `❌ <name>: 异常退出（code N）` | last 1 KB stderr in detail |
| Plugin stdout not valid JSON | invoke time | `❌ <name>: 协议错误` | first 1 KB stdout in detail |
| Action references undeclared capability | action handling | Action dropped silently | `console.warn` |
| `settings.merge` patch outside scope | action handling | Action dropped silently | `console.warn` |
| Action handler throws (e.g. clipboard fails) | action handling | `❌ <name>: <action> 失败` | error in detail |

The principle: **no plugin failure can crash the editor** and **no plugin
failure is silent to the user** (except action drops, which are author
errors not user concerns).

## Security posture

- Plugins are **trusted** in v1 because they ship inside the M↓ `.app` bundle
  and are signed as part of M↓'s code signature. There is no third-party
  installation channel.
- Process isolation is the only sandbox: a crashing plugin cannot crash M↓.
- Settings are scoped: a plugin only sees and writes its own `<plugin-id>.*`
  keys. Cross-plugin reads are not supported.
- The `secret` settings field type is stored in the same `settings.json` as
  everything else (no Keychain integration in v1) but the UI shows it as a
  password field. **This is documented as a known limitation.** Keychain
  integration is Future Work.
- Plugins inherit the M↓ process's environment and filesystem permissions.
  They can in theory read arbitrary files outside their scope (e.g. via
  shell escape). This is **acceptable for trusted bundled plugins** and is
  the rationale for not opening third-party install in v1.

## Testing

### Unit tests (vitest + happy-dom)

| Module | Coverage |
|---|---|
| `enabled-when.ts` | parsing edge cases (precedence, parens, missing path → falsy, malformed → throw); evaluation across context shapes |
| `registry.ts` | parsing valid manifest; rejecting invalid (missing fields, wrong types, duplicate ids); platform-binary resolution |
| `menu-registry.ts` | menu items appear under correct location; `enabled_when` re-evaluated on tab change; shortcut conflicts logged |
| `settings-registry.ts` | tab appears in Preferences; schema renders correct field types; defaults applied |
| `host.ts` | request payload construction (with/without `renderer.*`); response parsing; capability filtering of actions; settings-scope filtering |
| `action-handlers.ts` | each action type applied; failures don't break the chain; `dialog.confirm` re-invokes correctly |

### Integration tests (Rust, `cargo test`)

| Test | Coverage |
|---|---|
| `spawn_echo_plugin` | A test fixture that echoes stdin to stdout; verifies basic round-trip |
| `spawn_timeout` | A fixture that sleeps 60s; verifies kill at 30s + correct error code |
| `spawn_crash` | A fixture that exits 1 with stderr; verifies stderr capture + non-zero exit reporting |
| `spawn_garbage_stdout` | A fixture that prints non-JSON; verifies protocol error path |
| `spawn_huge_stdout` | A fixture that prints 100 MB; verifies the host doesn't OOM |
| `startup_does_not_touch_binaries` | Boot M↓ with 5 fixture plugins; assert no binary file was opened (verify via fixture binaries that record an exit code if invoked) |
| `startup_budget` | Boot M↓ with 5 fixture plugins; assert plugin-system init time < 20 ms (logged via instrumentation) |

Test fixtures are tiny shell scripts in `src-tauri/tests/fixtures/`.

### Manual smoke test (added to README §Manual Smoke Test)

**Plugin platform smoke** (will be exercised once the share plugin lands):
- Plugin menu item appears under File menu with shortcut shown
- Disabled state correctly tracks `enabled_when`
- Right-click on tab shows context menu item
- Preferences shows the plugin's tab with all four field types
- Click → toast appears → clipboard contains expected text → settings persist after restart
- Force-kill plugin while running → toast `未响应`; M↓ keeps editing fine
- Swap fixture plugin to one that prints invalid JSON → `协议错误` toast

## Open question (resolved)

**Should plugins be allowed to register new commands invokable from the
command palette in addition to menu items?** — Resolved: no command palette
exists today; treat as Future Work. Menu items + shortcuts cover share's
needs.

## Future work

- Third-party plugin install (`~/Library/Application Support/com.laobu.mdeditor/plugins/`)
  with a trust-on-first-use prompt
- Keychain-backed secret storage for `secret` field type
- A long-running daemon mode (opt-in via manifest) for plugins that benefit
  from caching state in process
- Action types: `open.url`, `save.dialog`, `notification`, `window.create`
- A command palette that aggregates plugin commands
- Plugin-registered renderers (would unify with `renderer-registry.ts`)
- Dynamic permission grant UX for sensitive capabilities

These are deliberately out of v1.
