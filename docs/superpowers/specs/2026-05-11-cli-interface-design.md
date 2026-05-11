# CLI Interface — Design

**Status**: Brainstorm complete; pending implementation plan
**Date**: 2026-05-11
**Owner**: bruce@hemory.com
**Platform spec**: `docs/superpowers/specs/2026-05-08-plugin-system-design.md`
**Driving use case**: Other applications invoke `mdedit -s xxx.md` to render
a markdown file with the user's settings and publish it via the Share plugin,
receiving the resulting URL on stdout.

## Goal

Add a command-line interface to M↓ so that **other applications and scripts
can drive plugin-provided features without opening the GUI**.

Concretely:

```bash
$ mdedit -s draft.md
https://mdeditor-share.your-account.workers.dev/2026-05-11-draft-abc
```

The CLI is a **general mechanism**: any plugin can declare CLI commands in
its `manifest.json` and have them surfaced through `mdedit`. The first plugin
to use it is Share; md2pdf and future plugins follow the same contract.

The CLI:

- Is a single binary `mdedit`, installed via a Help menu item (VS Code style)
- Reuses the existing plugin pipeline end-to-end (manifest, plugin host,
  one-shot subprocess, settings store, share-baker)
- Runs in **headless mode**: the M↓ binary detects CLI invocation, hides the
  window, runs the requested command, exits
- Is independent of the GUI: no interference when M↓ is already open

## Non-goals (v1)

- ❌ Windows / Linux support (M↓ currently ships only macOS .dmg)
- ❌ Reimplementing the markdown render pipeline in Rust (drift risk)
- ❌ Native Node / Bun renderer sidecar (avoid second runtime)
- ❌ Long-running CLI daemon or warmed Tauri process
- ❌ stdin input (`cat foo.md | mdedit -s -`) — must be a real file
- ❌ Multi-file batch (`mdedit -s a.md b.md c.md`) — single-file only
- ❌ User-defined aliases, user-defined PATH directories
- ❌ Hot reload / live update of CLI commands at runtime
- ❌ Plugin sandboxing beyond what the plugin system already provides
- ❌ Marketplace / signing / trust UX for CLI extensions
- ❌ Reading or writing the running GUI's in-memory state via IPC (the CLI
  spawns its own headless process; share.records is read/written through the
  on-disk settings store, with last-writer-wins on concurrent share of the
  same file accepted as a v1 limitation)

When (if) any of these become real needs, they extend this spec rather than
replace it.

## Motivating principles

1. **One binary, two faces.** M↓ ships exactly one executable. CLI mode is a
   branch taken by `argv[0]` basename / explicit flag, not a separate
   product.
2. **Plugins drive everything.** The main program knows about *built-in*
   subcommands (`help`, `version`, `plugin`) and nothing else. `share`,
   `pdf`, and every future command is contributed by a plugin manifest.
3. **Render parity is non-negotiable.** The CLI must produce the same HTML
   as the GUI. The only way to achieve that today is to reuse the frontend
   pipeline (moraya / marked / KaTeX / highlight.js / mermaid) by running a
   hidden webview.
4. **The GUI is never disturbed.** CLI invocations spawn their own process,
   bypass `tauri-plugin-single-instance`, never steal focus, never appear
   in the dock.
5. **Unix-friendly output.** stdout carries the result (URL). stderr carries
   progress and errors. Non-TTY stdout auto-suppresses progress chrome. JSON
   mode is opt-in for callers who want structured metadata.

## Architecture

```
                                    ┌────────────────────────────────────────────┐
                                    │ /Applications/M↓.app/Contents/MacOS/M↓     │
   /usr/local/bin/mdedit ──symlink─→│ (single binary; two entry modes)           │
                                    │                                            │
                                    │ ┌────────────────────────────────────────┐ │
                                    │ │ Rust main()                            │ │
                                    │ │   basename(argv[0]) == "mdedit"        │ │
                                    │ │   or argv contains --cli               │ │
                                    │ │   → Mode::Cli                          │ │
                                    │ │   else → Mode::Gui                     │ │
                                    │ └────────────────────────────────────────┘ │
                                    │              │                  │          │
                                    │   ┌──────────┘                  └────────┐ │
                                    │   ↓                                      ↓ │
                                    │ ┌──────────────────┐  ┌──────────────────┐ │
                                    │ │ run_cli(args)    │  │ run_gui()        │ │
                                    │ │  ① route argv    │  │  (existing path) │ │
                                    │ │  ② builtin or    │  │  - single-instance│ │
                                    │ │     plugin?      │  │  - deep-link     │ │
                                    │ │  ③ if builtin →  │  │  - tray + menus  │ │
                                    │ │     Rust-only,   │  │  - file assoc    │ │
                                    │ │     no webview   │  │  - visible window│ │
                                    │ │  ④ if plugin →   │  └──────────────────┘ │
                                    │ │     hidden Tauri │                       │
                                    │ │     window +     │                       │
                                    │ │     CliRunner    │                       │
                                    │ └────────┬─────────┘                       │
                                    └──────────┼────────────────────────────────-┘
                                               │
                              ┌────────────────┴──────────────────┐
                              │                                   │
                              ↓                                   ↓
                ┌─────────────────────────────┐    ┌────────────────────────────┐
                │ Frontend CliRunner.svelte   │    │ Plugin binary              │
                │ (loaded instead of App)     │    │ src-tauri/plugins/share/   │
                │   - reads cli_payload       │    │   bin-<arch>               │
                │   - calls share-baker       │    │                            │
                │   - dispatches plugin-host  │───→│ stdin  ← request JSON      │
                │   - interprets actions      │←───│ stdout → response JSON     │
                │   - writes stdout / stderr  │    │                            │
                │   - app.exit(code)          │    └────────────────────────────┘
                └─────────────────────────────┘
```

### Three independent units

#### Unit 1: `src-tauri/src/cli/*` — Rust-side CLI entry & router

**Location**: `src-tauri/src/cli/{mod,args,router,builtin,runner}.rs`

**Job**: detect CLI mode, parse argv, route to either built-in subcommands
(Rust-only path, no webview) or plugin subcommands (launch Tauri with hidden
window and a CLI-only frontend).

**Public surface**:

```rust
pub fn run_cli(argv: Vec<String>) -> ExitCode;
```

**Pipeline**:

1. Parse argv using `clap` (or hand-rolled parser if `clap` is too large for
   M↓'s size budget; M↓ currently uses no CLI crate). Identify:
   - Global flags: `--json`, `--quiet`/`-q`, `--no-clipboard`, `--yes`/`-y`,
     `--plugin-dir <path>`
   - Subcommand: `help` / `version` / `plugin` / `<plugin-subcommand>`
   - Aliases (`-s` → `share`) resolved by the router against the manifest
     registry
2. Read manifest registry from disk:
   - Default location: `<resource-dir>/plugins/<id>/manifest.json` for every
     subdirectory under the app bundle's resources
   - Read plugin enabled-state from the on-disk store (the same JSON file
     `tauri-plugin-store` would mount, located under the platform's app data
     directory)
   - **Rust parses only the subset of manifest fields the CLI router needs**
     (`id`, `name`, `version`, `cli`, and the plugin's declared `command`
     identifiers). Settings schema, menus, and `enabled_when` expressions
     are not touched on the Rust side — the TS validator remains the
     authoritative manifest schema check, and the Rust struct is a minimal
     projection. This keeps the two parsers from drifting in scope.
3. Route per §3 routing table (see Routing section below)
4. For built-in subcommands → handle in Rust, write stdout/stderr, exit
5. For plugin subcommands → build a `cli::CliPayload`, launch Tauri with
   hidden window, inject payload as init script global, return whatever exit
   code the frontend asks for

**Argv parser choice for v1**: use `clap` with minimal features (no `derive`,
no `cargo`, no `env`) for maintainability. `clap` adds roughly 100–200 KB to
the binary; M↓'s release profile already uses `opt-level = "z"` + LTO +
strip. If post-implementation measurements show the size delta is
unacceptable, the parser is encapsulated in `cli/args.rs` and can be
swapped for a hand-rolled equivalent without disturbing the rest of the
design.

**Tests** (`src-tauri/tests/cli_router.rs`):
- Route resolution for builtins, aliases, conflicts, unknown commands
- Help text snapshot for `mdedit help`, `mdedit help share`
- Exit code matrix per the table in §5

#### Unit 2: `src/lib/cli/cli-runner.ts` + `src/lib/cli/CliRunner.svelte` — Frontend CLI executor

**Location**: `src/lib/cli/` (new directory)

**Job**: when `window.__M_CLI_MODE__` is true, the frontend skips
`App.svelte` entirely and mounts `CliRunner.svelte`. The runner reads the
CLI payload, builds a virtual `Tab`, calls `share-baker.bakeShareHtml`,
dispatches to the existing `plugin-host`, and interprets returned actions
through a CLI-specific lens.

**Public surface**:

```ts
// New Tauri command exposed by Rust:
//   #[command] fn cli_payload() -> CliPayload
// CliRunner pulls this on mount.

export interface CliPayload {
  subcommand: string                    // e.g. "share"
  plugin_id: string                     // e.g. "share"
  plugin_command: string                // e.g. "publish" | "unpublish" | "copy-link"
  file: string                          // absolute path (validated by Rust)
  flags: Record<string, string | boolean>
  global: {
    json: boolean
    quiet: boolean
    clipboard: boolean
    yes: boolean
  }
}

export interface CliResult {
  exit_code: number                     // see exit code table
  stdout?: string                       // payload to print (URL or JSON)
  stderr?: string[]                     // error/progress lines (already filtered for quiet/TTY)
}
```

**Pipeline**:

1. On mount, call `cli_payload()` Tauri command → `CliPayload`
2. Build a virtual `Tab`:
   - `path = payload.file`
   - `filename = basename(payload.file)`
   - `extension = ext(payload.file)`
   - `kind = inferKind(payload.file)` — same logic as opening a file in GUI
   - `hasContent` set by reading file size > 0
3. For `requires_tab_context: true` subcommands needing rendered HTML
   (`share publish`): call `bakeShareHtml(virtualTab)`. For other plugin
   commands (`share unpublish`, `share copy-link`): skip baking.
4. Load plugin settings via the same `plugin-host` path the GUI uses
5. Call `pluginHost.invoke({ plugin_id, command, context, settings })`
6. Walk `Response.actions[]`:
   - `toast(success)` → push `"✓ " + msg` into `stderr` lines if TTY/not quiet
   - `toast(error)` → push `"✗ " + msg` into `stderr`; set `exit_code = 4`
   - `clipboard.write(text)` → if `global.clipboard`, execute via
     `tauri-plugin-clipboard-manager`; in JSON mode always skip
   - `settings.merge(patch)` → persist via plugin host's settings handler
     (existing code path; no CLI-specific logic)
   - `dialog.confirm` → in CLI: treat as confirmed if `global.yes`, else
     decline (currently no `share` action requires confirm; this is
     forward-compatible for plugins like md2pdf overwrite prompts)
   - `cli.result({ data })` (NEW action type) → cache `data`; final stdout
     comes from this
7. Build final stdout per §5 output contract
8. Tell Rust to write stdout/stderr/exit via a new `cli_finish(result)`
   Tauri command. Rust then calls `app.exit(result.exit_code)`.

**Why `cli.result` rather than scraping toast/clipboard text**: extracting
the URL from a toast's free-text message is fragile (localization, copy
edits, prefix changes). Adding one explicit action makes the structured
data flow unambiguous and forward-compatible.

**Tests** (`src/lib/cli/cli-runner.test.ts`):
- Payload → virtual Tab construction (md, html, image extensions)
- Action interpretation table: every action type × CLI flag matrix
- Render error path → `exit_code = 1`, `error.code = "render_failed"`
- Plugin timeout → `exit_code = 1`, `error.code = "plugin_failed"`

#### Unit 3: Manifest `cli` schema & registry — additive plugin platform extension

**Location**: extends `src/lib/plugins/{types,registry}.ts` and
`src-tauri/plugins/share/manifest.json`

**Job**: let plugins declare CLI commands in their manifest. Validate and
detect conflicts at startup, mirroring how menus and shortcuts work.

**Type additions** (`src/lib/plugins/types.ts`):

```ts
export interface CliArg {
  name: string                          // positional name
  type: 'path' | 'string' | 'integer'   // v1 only these three
  required: boolean
  help?: string
}

export interface CliFlag {
  long: string                          // e.g. "--unshare"
  short?: string                        // e.g. "-u" (must not conflict with global flags)
  type: 'boolean' | 'string'
  help?: string
}

export interface CliEntry {
  subcommand: string                    // e.g. "share"; globally unique among plugins + builtins
  aliases?: string[]                    // top-level aliases like ["-s", "--share"]; each must start with '-'
  command: string                       // maps to plugin binary's command field (must be a declared plugin command)
  summary: string                       // single-line shown in `mdedit help`
  args?: CliArg[]
  flags?: CliFlag[]
  requires_tab_context?: boolean        // true means CliRunner must build a virtual Tab and (if applicable) bake HTML
}

export interface PluginManifest {
  // ... existing fields ...
  cli?: CliEntry[]                      // NEW; optional
}

// PluginAction gains one variant:
export type PluginAction =
  | /* ...existing... */
  | { type: 'cli.result'; data: Record<string, unknown> }
```

**Validation additions** (`src/lib/plugins/registry.ts`):

- `subcommand` must match `/^[a-z][a-z0-9-]{1,31}$/`
- `subcommand` must not collide with built-ins: `help`, `version`, `plugin`
- Each `aliases[i]` must start with `-` and must not collide with reserved
  global flags (`-h`, `--help`, `-v`, `--version`, `-q`, `--quiet`,
  `--json`, `--no-clipboard`, `--yes`, `-y`, `--plugin-dir`)
- `command` must reference a command implemented by the plugin binary
  (same validation rule used by `menus[].command`)
- New `findCliConflicts(manifests, builtinSubcommands)` returns conflicts
  by `subcommand` and by `alias`. Conflicting entries are dropped at
  registry build time and logged; the plugin's other manifest features
  (menus, settings) are unaffected.

**share plugin manifest patch**:

```json
"cli": [
  {
    "subcommand": "share",
    "aliases": ["-s", "--share"],
    "command": "publish",
    "summary": "Render and publish file as a shareable URL",
    "args": [
      { "name": "file", "type": "path", "required": true,
        "help": "Markdown or image file to share" }
    ],
    "flags": [
      { "long": "--update", "type": "boolean",
        "help": "Force update existing share (default if already shared)" },
      { "long": "--copy-link", "type": "boolean",
        "help": "Print previously-shared URL instead of re-publishing" },
      { "long": "--unshare", "type": "boolean",
        "help": "Remove share for this file" }
    ],
    "requires_tab_context": true
  }
]
```

The single `share` subcommand fans out to three plugin binary commands
(`publish` / `unpublish` / `copy-link`) via mutually-exclusive flags. This
avoids three top-level subcommand names crowding the `mdedit help` listing.

**Plugin binary change** (mdshare, all three commands): emit one additional
action `cli.result` with `{ url, slug, is_update, created_at }` on success,
in addition to the existing toast/clipboard/settings.merge actions. The GUI
action handler (`src/lib/plugins/action-handlers.ts`) gains a no-op case for
`cli.result` so that the existing GUI flow is not regressed by plugin
binaries that now always emit it. CliRunner uses `cli.result` as the
single source of truth for stdout payload.

**Tests** (`src/lib/plugins/registry.test.ts`):
- Validator: malformed `cli` entries rejected
- `findCliConflicts`: duplicate subcommand across plugins, duplicate alias,
  alias collides with global flag, subcommand collides with builtin
- Conflicting entries dropped; rest of plugin survives

## Routing

`cli/router.rs` resolves argv to an action in this exact order. Stop at
first match.

| # | Pattern | Action |
|---|---------|--------|
| 1 | `argv[1] ∈ {help, -h, --help}` | Show builtin help; exit 0 |
| 2 | `argv[1] ∈ {version, -v, --version}` | Show version; exit 0 |
| 3 | `argv[1] == "plugin"` | Dispatch to `cli::builtin::plugin_cmd(argv[2..])` |
| 4 | `argv[1] == subcommand` of an **enabled** plugin manifest's `cli` entry | Launch headless Tauri with that `CliPayload` |
| 5 | `argv[1] ∈ aliases` of an **enabled** plugin manifest's `cli` entry | Same as 4, with subcommand resolved from the alias's owner |
| 6 | `argv[1]` matches a subcommand or alias of an **installed but disabled** plugin | Print remediation hint; exit 3 |
| 7 | Otherwise | Print "unknown command", suggest `mdedit help`; exit 127 |

**Aliases work even at `argv[1]`**: `mdedit -s draft.md` → step 5 matches
`-s` → resolves to plugin `share`, subcommand `share`, with remaining argv
parsed against that subcommand's args/flags spec.

**Global flags** can appear before or after the subcommand (e.g.
`mdedit --json -s foo.md` and `mdedit -s foo.md --json` are equivalent).

## Built-in subcommands

These are implemented entirely in Rust and **do not start a webview**.
Cold start budget: under 100 ms.

| Command | Behavior |
|---|---|
| `mdedit help [<subcommand>] [--all]` | List enabled commands; `--all` adds disabled/uninstalled with reasons; `help <sub>` shows arguments, flags, exit codes, examples for a specific subcommand |
| `mdedit version` | Print `mdedit X.Y.Z (plugin API v1)`; `--json` for structured |
| `mdedit plugin list` | Table of id / name / version / status / cli surface; `--json` supported |
| `mdedit plugin enable <id>` | Flip the enabled flag in the settings store; verify manifest exists; exit 0 on success, 2 if id unknown |
| `mdedit plugin disable <id>` | Reverse of above |
| `mdedit plugin info <id>` | Show full manifest summary including all menus, contexts, settings, CLI entries |

`help` output spec:

```
mdedit — M↓ command-line interface
Version: 0.6.2 (plugin API v1)

USAGE:
  mdedit <command> [args...]
  mdedit -s <file>                  (alias for: mdedit share <file>)

CORE COMMANDS:
  help          Show this help
  version       Print version
  plugin        Manage plugins (list, enable, disable, info)

PLUGIN COMMANDS:
  share         Render and publish file as a shareable URL          [Share]

Run 'mdedit help <command>' for details on a specific command.
Run 'mdedit help --all' to see disabled / unavailable commands too.
```

## End-to-end flow: `mdedit -s draft.md`

```
1.  /usr/local/bin/mdedit  argv = ["mdedit", "-s", "draft.md"]
                          → exec /Applications/M↓.app/Contents/MacOS/M↓
                          (symlink follow; macOS preserves argv[0])
2.  Rust main()            basename(argv[0]) == "mdedit" → Mode::Cli
3.  cli::router            alias "-s" matched at routing step 5
                          → resolves to plugin "share", subcommand "share"
4.  cli::router            plugin "share" enabled? yes
                          (if no: exit 3 with remediation hint)
5.  cli::args              parse remaining argv against share manifest:
                          file = abs("draft.md") (cwd-relative)
                          flags = { update:false, copy_link:false,
                                    unshare:false }
                          global = { json:false, quiet:auto-by-tty,
                                     clipboard:true, yes:false }
                          fail with exit 2 if file missing/unreadable
6.  cli::runner            decide plugin_command:
                          - unshare=true → "unpublish"
                          - copy_link=true → "copy-link"
                          - else → "publish"  (idempotent over share.records)
7.  Launch Tauri           build CliPayload; inject window.__M_CLI_MODE__
                          + cli_payload; build WindowBuilder with
                          visible:false, skip_taskbar:true; skip
                          single-instance + deep-link plugin registration
8.  Frontend main.ts       sees __M_CLI_MODE__ → mounts CliRunner.svelte
                          (not App.svelte)
9.  CliRunner              builds virtual Tab; if requires_tab_context:
                          await bakeShareHtml(virtualTab); load plugin
                          settings; call pluginHost.invoke(...)
10. Plugin host            spawns src-tauri/plugins/share/bin-<arch>
                          with stdin JSON, 30s timeout (existing path)
11. CliRunner              walks Response.actions[]:
                          - toast(success) → stderr "✓ ..."
                          - toast(error)   → stderr "✗ ..." + exit_code = 4
                          - clipboard.write(url) → system clipboard
                          - settings.merge → store (share.records updated)
                          - cli.result({ url, slug, ... }) → stdout source
12. CliRunner → Rust       call cli_finish({ exit_code, stdout, stderr });
                          Rust writes streams; app.exit(exit_code)
```

Variants:

| Invocation | Step changes |
|---|---|
| `mdedit share draft.md --unshare` | Step 6 picks `unpublish`; step 9 skips `bakeShareHtml`; step 11: no URL on stdout (exit 0 on success) |
| `mdedit share draft.md --copy-link` | Step 6 picks `copy-link`; step 9 skips baking; step 11: cli.result returns previously-stored URL |
| `mdedit -s draft.md --json` | Step 12 stdout = single-line JSON; stderr remains for fatal errors only |

## Installation

A Help-menu item (and Preferences "CLI" section) lets users install/uninstall
the `mdedit` symlink without leaving M↓.

**Menu**:

```
[Help]
  ├─ About M↓
  ├─ ────────────────────
  ├─ Install 'mdedit' Command in PATH...   ← new
  ├─ Uninstall 'mdedit' Command            ← shown only when installed
  ├─ Repair 'mdedit' Command               ← shown only when symlink target is stale
  └─ ...
```

**Install flow**:

1. Native macOS dialog prompts for destination:
   - `/usr/local/bin` (recommended; admin required)
   - `/opt/homebrew/bin` (Apple Silicon Homebrew)
   - `~/.local/bin` (no admin; PATH advisory)
2. For admin-required paths: run `osascript -e 'do shell script "..."
   with administrator privileges'`, which triggers the macOS auth prompt.
3. For `~/.local/bin`: `mkdir -p` if needed; create symlink without
   elevation; if PATH does not include the directory, show a toast with
   the line to add to the user's shell rc.
4. The symlink target is
   `/Applications/M↓.app/Contents/MacOS/M↓` (the literal binary path that
   exists today; `productName` in `tauri.conf.json` is `M↓`).
5. On success: toast `'mdedit' installed at <path>`. Preferences "CLI"
   section refreshes.

**Repair flow**: at app launch, if the Preferences "CLI" state shows
"installed" but the recorded symlink target no longer resolves to the
current `M↓.app` location, show "Repair" in Help and a Preferences notice.

**Uninstall flow**: reverse symlink creation, with the same elevation if
the path was originally admin-required.

**State persistence**: the install location is stored in the app settings
(`cli.installed_path: string | null`) so Repair / Uninstall know where to
look without re-probing every candidate directory.

## Output and exit codes

**Streams**:

| Stream | Default mode | `--json` mode |
|---|---|---|
| stdout | URL (or empty for unshare/disable-cases) | Single-line JSON object |
| stderr | Progress (TTY only) + errors + warnings | Errors only (human-readable, parallel to JSON) |
| `--quiet`/`-q` | Suppresses progress; fatal errors still emitted | Same |
| non-TTY stdout | Auto-quiet (no spinner glyphs / progress) | — |

**Exit code table**:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Unexpected internal error (panic, plugin crash, plugin timeout, render error) |
| `2` | Argument or input error (file missing, unreadable, bad flag, unknown plugin id for `plugin enable/disable`) |
| `3` | Plugin installed but disabled |
| `4` | Plugin reported failure (network, API error, validation, "请先保存文件", "未配置 API Key", etc.) |
| `127` | Unknown command or plugin not installed |

**JSON schema** (stable; bumping requires deprecation cycle):

```json
// Success
{
  "ok": true,
  "data": {
    "url": "https://.../2026-05-11-draft-abc",
    "slug": "2026-05-11-draft-abc",
    "is_update": false,
    "created_at": "2026-05-11T15:24:33Z"
  }
}

// Failure
{
  "ok": false,
  "error": {
    "code": "plugin_disabled",
    "message": "command 'share' is provided by the 'Share' plugin, which is disabled.",
    "hint": "mdedit plugin enable share"
  }
}
```

**Error code enum** (stable):
`unknown_command`, `plugin_disabled`, `plugin_not_installed`, `file_not_found`,
`arg_invalid`, `render_failed`, `plugin_failed`, `network_failed`, `internal`.

## Edge cases

| Scenario | Expected behavior |
|---|---|
| File argument doesn't exist | exit 2; stderr `mdedit: cannot read 'x.md': No such file or directory` |
| File unreadable (permissions) | exit 2; analogous |
| Plugin not installed (no manifest) | exit 127; stderr `mdedit: unknown command 'share'. Run 'mdedit help'.` |
| Plugin installed but disabled | exit 3; stderr `mdedit: command 'share' is provided by the 'Share' plugin, which is disabled. Enable it in Preferences → Plugins, or run: mdedit plugin enable share` |
| Plugin binary missing (corrupt install) | exit 1; stderr includes the expected binary path |
| Plugin binary not executable for current arch | exit 1; stderr includes arch mismatch detail |
| API key / base URL not configured | exit 4; stderr mirrors plugin's existing toast text (`未配置 API Key`) |
| Network failure / non-2xx from worker | exit 4; stderr includes plugin's error message |
| Same file re-shared | exit 0; same URL returned (idempotent update via existing `publish.rs` logic) |
| 30-second plugin timeout | exit 1; stderr `plugin 'share' timed out after 30s` |
| Non-TTY stdout (piped) | Auto-quiet; no spinner chrome; clean URL on stdout |
| `--json` + success | stdout is single-line JSON; stderr silent in quiet/non-TTY |
| `--json` + failure | stdout is single-line JSON with `"ok":false`; exit code unchanged |
| Concurrent `mdedit -s same.md` | Both run independently; settings.merge for `share.records[same.md]` is last-writer-wins on disk. Documented v1 limitation. |
| GUI is already running | No interaction; CLI process spawns its own hidden Tauri instance; GUI stays untouched (single-instance plugin not registered in CLI mode) |
| Symlink target stale (M↓.app moved) | At launch, M↓ detects and offers Repair; CLI still works because `argv[0]` basename is what triggers CLI mode, not the symlink resolution |
| `mdedit` invoked from inside Spotlight or non-shell context | Fine — same code path; no TTY → auto-quiet |
| `--unshare` on a file that was never shared | exit 4; stderr forwards plugin's "未找到分享记录" message |
| `--copy-link` on a file that was never shared | exit 4; same as above |
| `--update --unshare` (mutually exclusive flags) | exit 2; stderr `mdedit: --update and --unshare are mutually exclusive` |

## Testing

| Layer | What | Where |
|---|---|---|
| Unit (Rust) | Argv routing, alias resolution, builtin command execution, manifest validation including new `cli` schema | `src-tauri/src/cli/*` inline tests + `src-tauri/tests/cli_router.rs` |
| Unit (TS) | CliRunner action interpretation, virtual Tab construction, exit code matrix, JSON output shape | `src/lib/cli/cli-runner.test.ts` |
| Unit (TS) | Manifest validator new rules, `findCliConflicts` | `src/lib/plugins/registry.test.ts` (additions) |
| Integration (Rust) | Spawn real binary; assert `mdedit help`, `mdedit version`, `mdedit plugin list`, `mdedit plugin enable/disable` against a temp settings store; assert exit codes | `src-tauri/tests/cli_integration.rs` |
| End-to-end (script) | Mock Cloudflare Worker; run `mdedit -s tmp.md`; assert stdout = URL, exit 0; assert `--json`, `--unshare`, `--copy-link` variants | `scripts/test-cli-share.sh` (manual / CI-optional) |
| Regression | GUI cold-start time within +10ms of baseline (no regression from CLI dispatch) | `src-tauri/tests/startup_timing.rs` |

## File changes summary

**New**:
- `src-tauri/src/cli/mod.rs`
- `src-tauri/src/cli/args.rs`
- `src-tauri/src/cli/router.rs`
- `src-tauri/src/cli/builtin.rs`
- `src-tauri/src/cli/runner.rs`
- `src-tauri/tests/cli_router.rs`
- `src-tauri/tests/cli_integration.rs`
- `src-tauri/tests/startup_timing.rs`
- `src/lib/cli/cli-runner.ts`
- `src/lib/cli/CliRunner.svelte`
- `src/lib/cli/cli-runner.test.ts`
- `scripts/test-cli-share.sh`

**Modified**:
- `src-tauri/src/main.rs` — mode dispatch at top of `main()`
- `src-tauri/src/lib.rs` — split `run()` into `run_gui()` and expose
  `cli::run_cli()`; suppress single-instance/deep-link/tray registration
  in CLI mode; build hidden window via `WindowBuilder` when payload
  requires webview
- `src-tauri/Cargo.toml` — add `clap` (or hand-rolled parser equivalent),
  `dirs` for resource-dir resolution
- `src-tauri/plugins/share/manifest.json` — add `cli` section
- `src/main.ts` — branch on `window.__M_CLI_MODE__` to mount CliRunner
  instead of App
- `src/lib/plugins/types.ts` — `CliArg`, `CliFlag`, `CliEntry`, `cli` on
  `PluginManifest`, `cli.result` variant on `PluginAction`
- `src/lib/plugins/registry.ts` — validation for new `cli` schema,
  `findCliConflicts`
- `src/lib/plugins/registry.test.ts` — coverage for above
- `mdshare/src/publish.rs` — emit `cli.result` action on success
- `mdshare/src/unpublish.rs` — emit `cli.result` action on success
- `mdshare/src/copy_link.rs` — emit `cli.result` action on success
- `mdshare/src/ipc.rs` — add `Action::CliResult { data }` variant
- Help menu wiring (`src-tauri/src/lib.rs` menu setup or equivalent
  frontend menu config) — add Install/Uninstall/Repair items
- Preferences UI — add "CLI" section showing install state with
  Install/Uninstall buttons

**Unchanged but relied on**:
- `src/lib/plugins/share-baker.ts` — reused as-is for headless render
- `src/lib/plugins/host.ts` / `runtime.svelte.ts` — reused as-is for
  plugin dispatch
- `src/lib/plugins/settings-registry.ts` — reused as-is for settings reads
- `src-tauri/plugins/share/bin-<arch>` — only its source crate changes;
  the contract over stdin/stdout is unchanged
- All existing plugin tests — no expected regressions

## Decision summary

| Decision | Choice | Rationale |
|---|---|---|
| Q1 Rendering location | **Headless M↓ with hidden webview** | Zero drift vs. GUI; reuses entire frontend pipeline; cold-start cost acceptable for one-shot share |
| Q2 Plugin contribution mechanism | **Manifest `cli` section with subcommand + aliases** | Matches the declarative model used for menus/shortcuts; main program stays plugin-agnostic; `-s` alias preserved |
| Q3 GUI coexistence | **CLI spawns independent process; skips single-instance** | Never disturbs running GUI; supports concurrent invocations; works without GUI |
| Q4 Output format | **Default URL on stdout; `--json` opt-in** | Most Unix-friendly default; structured opt-in for editor integrations and CI |
| Q5 Installation | **Help menu "Install Shell Command"** | VS Code convention; user-controlled; reversible; macOS auth dialog gates admin paths |
| Q6 Disabled plugin handling | **Distinct error message and exit code 3; built-in `plugin enable/disable/list/info` subcommands** | Scripts can dispatch on exit codes; terminal users can self-diagnose |
| Q7c Idempotent share | **Same path → same URL (existing GUI behavior)** | Avoids URL churn for scripts that re-share the same file |
| Q7d stdin input | **Not supported** | `share.records` is keyed by path; stdin would produce orphan entries |
| Q7f unshare/copy-link | **Exposed via flags on `share` subcommand** | Single subcommand name; flag-based fan-out into existing plugin commands |
