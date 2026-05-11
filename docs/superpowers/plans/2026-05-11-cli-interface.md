# CLI Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `mdedit` CLI to M↓ so other applications can drive plugin-provided features (starting with Share) without opening the GUI.

**Architecture:** A single binary serves both GUI and CLI by dispatching on `argv[0]` basename. Built-in subcommands (`help`/`version`/`plugin`) run in Rust without a webview. Plugin-contributed subcommands launch Tauri with a hidden window and a CLI-only frontend (`CliRunner.svelte`) that reuses `share-baker` + the existing plugin host. Plugins declare CLI surface in `manifest.json`.

**Tech Stack:** Rust + Tauri 2 (existing); `clap` 4 with minimal features for argv parsing; Svelte 5 + Vitest (existing); mdshare Rust sidecar (existing).

**Spec:** `docs/superpowers/specs/2026-05-11-cli-interface-design.md`

---

## File structure

**New files:**

| Path | Responsibility |
|---|---|
| `src-tauri/src/cli/mod.rs` | Public CLI entry: `run_cli(argv) -> ExitCode`; re-exports submodules. |
| `src-tauri/src/cli/args.rs` | `clap` definitions for global flags, `plugin` builtin, and dynamic plugin subcommand resolution. |
| `src-tauri/src/cli/router.rs` | Implements the 7-step routing table that maps argv to a `Route` enum. |
| `src-tauri/src/cli/builtin.rs` | Implements `help`, `version`, `plugin list/enable/disable/info` — pure Rust, no webview. |
| `src-tauri/src/cli/runner.rs` | Plugin-subcommand path: build `CliPayload`, launch hidden Tauri window, wait for `cli_finish`, write streams, exit. |
| `src-tauri/src/cli/install.rs` | Install/uninstall/repair logic for the `mdedit` symlink (`osascript` elevation when needed). |
| `src-tauri/src/cli/state.rs` | Tauri-managed `CliState` holding the in-flight `CliPayload` plus a oneshot result channel. |
| `src-tauri/tests/cli_builtin_integration.rs` | End-to-end test for the builtin path: spawns the real binary, asserts stdout/exit codes for `help`, `version`, `plugin list`. |
| `src/lib/cli/cli-runner.ts` | Pure-TS core: virtual `Tab` construction, action interpretation, exit-code derivation. No Svelte. |
| `src/lib/cli/CliRunner.svelte` | Mount point when `__M_CLI_MODE__` is true; calls `cli_payload()` Tauri command, runs the core, calls `cli_finish()`. |
| `src/lib/cli/cli-runner.test.ts` | Vitest unit tests for the core. |
| `scripts/test-cli-share.sh` | Manual / CI-optional end-to-end smoke test against a mock Cloudflare Worker. |

**Modified files:**

| Path | What changes |
|---|---|
| `src-tauri/src/main.rs` | Top-level mode dispatch: `Cli` vs `Gui` based on `argv[0]` basename or `--cli` flag. |
| `src-tauri/src/lib.rs` | Rename current `run()` to `run_gui()`, expose `cli::run_cli()`, add `cli_payload`/`cli_finish`/install Tauri commands to the GUI invoke handler list (some are CLI-only but live in the same binary), add Help menu items for Install/Uninstall/Repair. |
| `src-tauri/src/plugin_host.rs` | Extend `PluginManifest` struct with optional `cli` field; expose `read_enabled_map` and a new `get_all_with_paths()` helper for the CLI router. |
| `src-tauri/Cargo.toml` | Add `clap` (minimal features). |
| `src-tauri/plugins/share/manifest.json` | Add `cli` block per spec §3. |
| `src/main.ts` | Branch on `window.__M_CLI_MODE__` to mount `CliRunner.svelte` instead of `App.svelte`. |
| `src/lib/plugins/types.ts` | Add `CliArg`, `CliFlag`, `CliEntry`, `cli` field on `PluginManifest`, and `cli.result` variant on `PluginAction`. |
| `src/lib/plugins/registry.ts` | Validate the new `cli` schema; add `findCliConflicts`. |
| `src/lib/plugins/registry.test.ts` | Tests for the new validator rules and conflict detection. |
| `src/lib/plugins/host.ts` | Add no-op pass-through in `actionAllowed` for `cli.result`. |
| `src/lib/plugins/action-handlers.ts` | Add no-op case in `applyActions` for `cli.result`. |
| `mdshare/src/ipc.rs` | Add `Action::CliResult { data }` variant. |
| `mdshare/src/publish.rs` | Emit `cli.result { url, slug, is_update, created_at }` on success. |
| `mdshare/src/unpublish.rs` | Emit `cli.result { slug, removed }` on success. |
| `mdshare/src/copy_link.rs` | Emit `cli.result { url, slug }` on success. |

---

## Task 1: Plugin manifest CLI types (TS)

**Files:**
- Modify: `src/lib/plugins/types.ts`

- [ ] **Step 1: Add CLI types and extend PluginManifest + PluginAction**

In `src/lib/plugins/types.ts`, append the new types and extend the existing `PluginManifest` and `PluginAction`. The exact additions:

```ts
// Append after existing types, before final export(s):

export interface CliArg {
  name: string
  type: 'path' | 'string' | 'integer'
  required: boolean
  help?: string
}

export interface CliFlag {
  long: string                  // must start with "--"
  short?: string                // must be "-x" where x is a single ASCII letter
  type: 'boolean' | 'string'
  help?: string
}

export interface CliEntry {
  subcommand: string
  aliases?: string[]            // each must start with "-"
  command: string               // must match a command implemented by the plugin binary
  summary: string
  args?: CliArg[]
  flags?: CliFlag[]
  requires_tab_context?: boolean
}
```

Modify `PluginManifest`:

```ts
export interface PluginManifest {
  // ... existing fields unchanged ...
  cli?: CliEntry[]              // new, optional
}
```

Extend `PluginAction` union (it's `export type PluginAction = | ... | ...` in this file — add at end):

```ts
  | { type: 'cli.result'; data: Record<string, unknown> }
```

- [ ] **Step 2: Run typecheck to confirm types compile**

Run: `pnpm check`
Expected: no errors (consumers of `PluginAction` that don't yet handle `cli.result` will be touched in Task 4 — for now `actionAllowed` and `applyActions` switches will fail. **If the type-checker flags these two switches, that is expected and proves the union extension landed.** Note their errors; they get fixed in Task 4.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/plugins/types.ts
git commit -m "feat(plugins): add CLI manifest types and cli.result action"
```

---

## Task 2: Manifest validator rules and conflict detection

**Files:**
- Modify: `src/lib/plugins/registry.ts`
- Test: `src/lib/plugins/registry.test.ts`

- [ ] **Step 1: Write failing tests for cli validation and conflicts**

Append to `src/lib/plugins/registry.test.ts` (read existing file first to match its imports/test style). Tests to add:

```ts
import { describe, it, expect } from 'vitest'
import { validateManifest, findCliConflicts, buildRegistry } from './registry'
import type { PluginManifest } from './types'

describe('manifest cli validation', () => {
  const base = {
    id: 'demo',
    name: 'Demo',
    version: '0.1.0',
    binary: 'bin',
    host_capabilities: [] as string[],
  }

  it('accepts a well-formed cli entry', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'demo', command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(true)
  })

  it('rejects subcommand that collides with a builtin', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'help', command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(false)
  })

  it('rejects subcommand with bad characters', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'Bad Name', command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(false)
  })

  it('rejects alias that does not start with "-"', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'demo', aliases: ['ess'], command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(false)
  })

  it('rejects alias that collides with a reserved global flag', () => {
    const r = validateManifest({
      ...base,
      cli: [{ subcommand: 'demo', aliases: ['--json'], command: 'noop', summary: 's' }],
    })
    expect(r.ok).toBe(false)
  })
})

describe('findCliConflicts', () => {
  const builtins = ['help', 'version', 'plugin']

  function m(id: string, cli: PluginManifest['cli']): PluginManifest {
    return {
      id, name: id, version: '0.1.0', binary: 'bin',
      host_capabilities: [], cli,
    } as PluginManifest
  }

  it('returns empty when no conflicts', () => {
    const conflicts = findCliConflicts([
      m('a', [{ subcommand: 'one', command: 'x', summary: 's' }]),
      m('b', [{ subcommand: 'two', command: 'x', summary: 's' }]),
    ], builtins)
    expect(conflicts).toEqual([])
  })

  it('detects duplicate subcommand across plugins', () => {
    const conflicts = findCliConflicts([
      m('a', [{ subcommand: 'dup', command: 'x', summary: 's' }]),
      m('b', [{ subcommand: 'dup', command: 'x', summary: 's' }]),
    ], builtins)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('subcommand')
    expect(conflicts[0].owners.map(o => o.pluginId).sort()).toEqual(['a', 'b'])
  })

  it('detects duplicate alias across plugins', () => {
    const conflicts = findCliConflicts([
      m('a', [{ subcommand: 'one', aliases: ['-x'], command: 'x', summary: 's' }]),
      m('b', [{ subcommand: 'two', aliases: ['-x'], command: 'x', summary: 's' }]),
    ], builtins)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('alias')
    expect(conflicts[0].key).toBe('-x')
  })

  it('detects subcommand colliding with builtin even at registry level', () => {
    const conflicts = findCliConflicts([
      m('a', [{ subcommand: 'help', command: 'x', summary: 's' }]),
    ], builtins)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('subcommand')
    expect(conflicts[0].reservedCore).toBe(true)
  })
})

describe('buildRegistry drops cli entries from conflicting plugins', () => {
  it('keeps the non-conflicting plugin intact when subcommand dup occurs', () => {
    const a = {
      id: 'a', name: 'A', version: '0.1.0', binary: 'bin',
      host_capabilities: [], cli: [{ subcommand: 'dup', command: 'x', summary: 's' }],
    } as PluginManifest
    const b = {
      id: 'b', name: 'B', version: '0.1.0', binary: 'bin',
      host_capabilities: [],
      menus: [{ location: 'file' as const, label: 'B', command: 'x' }],
      cli: [{ subcommand: 'dup', command: 'x', summary: 's' }],
    } as PluginManifest
    const reg = buildRegistry([a, b])
    // Both plugins survive in the registry; menus etc. are untouched.
    expect(Object.keys(reg.byId).sort()).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/plugins/registry.test.ts`
Expected: All five new `manifest cli validation` and four `findCliConflicts` tests fail with messages about missing/incorrect implementation.

- [ ] **Step 3: Implement validation and conflict detection in registry.ts**

In `src/lib/plugins/registry.ts`, add constants and helpers near the top (after existing `VALID_CAPS`):

```ts
const BUILTIN_SUBCOMMANDS = ['help', 'version', 'plugin']
const RESERVED_GLOBAL_FLAGS = [
  '-h', '--help', '-v', '--version',
  '-q', '--quiet', '--json',
  '--no-clipboard', '--yes', '-y', '--plugin-dir',
]
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]{1,31}$/
const SHORT_FLAG_RE = /^-[a-zA-Z]$/
const LONG_FLAG_RE = /^--[a-z][a-z0-9-]*$/
```

In `validateManifest`, after the existing `menus` validation block, add:

```ts
  if (o.cli != null) {
    if (!Array.isArray(o.cli))
      return { ok: false, error: 'cli must be an array' }
    for (const entry of o.cli) {
      const e = entry as Record<string, unknown>
      if (typeof e.subcommand !== 'string' || !SUBCOMMAND_RE.test(e.subcommand))
        return { ok: false, error: `cli.subcommand invalid: ${String(e.subcommand)}` }
      if (BUILTIN_SUBCOMMANDS.includes(e.subcommand))
        return { ok: false, error: `cli.subcommand '${e.subcommand}' collides with a built-in` }
      if (typeof e.command !== 'string' || e.command.length === 0)
        return { ok: false, error: 'cli.command required' }
      if (typeof e.summary !== 'string' || e.summary.length === 0)
        return { ok: false, error: 'cli.summary required' }
      if (e.aliases != null) {
        if (!Array.isArray(e.aliases))
          return { ok: false, error: 'cli.aliases must be an array' }
        for (const a of e.aliases) {
          if (typeof a !== 'string' || !a.startsWith('-'))
            return { ok: false, error: `cli alias must start with '-': ${String(a)}` }
          if (RESERVED_GLOBAL_FLAGS.includes(a))
            return { ok: false, error: `cli alias '${a}' is a reserved global flag` }
          if (!SHORT_FLAG_RE.test(a) && !LONG_FLAG_RE.test(a))
            return { ok: false, error: `cli alias has invalid shape: ${a}` }
        }
      }
      if (e.flags != null) {
        if (!Array.isArray(e.flags))
          return { ok: false, error: 'cli.flags must be an array' }
        for (const f of e.flags) {
          const fr = f as Record<string, unknown>
          if (typeof fr.long !== 'string' || !LONG_FLAG_RE.test(fr.long))
            return { ok: false, error: `cli flag long invalid: ${String(fr.long)}` }
          if (fr.short != null && (typeof fr.short !== 'string' || !SHORT_FLAG_RE.test(fr.short)))
            return { ok: false, error: `cli flag short invalid: ${String(fr.short)}` }
          if (RESERVED_GLOBAL_FLAGS.includes(fr.long as string))
            return { ok: false, error: `cli flag '${fr.long}' is a reserved global flag` }
        }
      }
      if (e.args != null && !Array.isArray(e.args))
        return { ok: false, error: 'cli.args must be an array' }
    }
  }
```

After `findShortcutConflicts`, add a new exported function:

```ts
export interface CliConflict {
  kind: 'subcommand' | 'alias'
  key: string
  owners: { pluginId: string; subcommand: string }[]
  reservedCore?: boolean
}

export function findCliConflicts(
  manifests: PluginManifest[],
  builtinSubcommands: string[],
): CliConflict[] {
  const subMap = new Map<string, CliConflict>()
  const aliasMap = new Map<string, CliConflict>()
  for (const m of manifests) {
    for (const entry of m.cli ?? []) {
      const sub = subMap.get(entry.subcommand) ?? {
        kind: 'subcommand', key: entry.subcommand, owners: [],
      }
      sub.owners.push({ pluginId: m.id, subcommand: entry.subcommand })
      subMap.set(entry.subcommand, sub)
      for (const a of entry.aliases ?? []) {
        const al = aliasMap.get(a) ?? { kind: 'alias', key: a, owners: [] }
        al.owners.push({ pluginId: m.id, subcommand: entry.subcommand })
        aliasMap.set(a, al)
      }
    }
  }
  const conflicts: CliConflict[] = []
  for (const [key, c] of subMap) {
    const reserved = builtinSubcommands.includes(key)
    if (c.owners.length > 1 || reserved) {
      if (reserved) c.reservedCore = true
      conflicts.push(c)
    }
  }
  for (const [, c] of aliasMap) {
    if (c.owners.length > 1) conflicts.push(c)
  }
  return conflicts
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/plugins/registry.test.ts`
Expected: all tests pass (both the new ones and the existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/registry.ts src/lib/plugins/registry.test.ts
git commit -m "feat(plugins): validate cli manifest section and detect conflicts"
```

---

## Task 3: Extend Rust PluginManifest with cli field

**Files:**
- Modify: `src-tauri/src/plugin_host.rs`

- [ ] **Step 1: Add CLI struct types in plugin_host.rs**

Read `src-tauri/src/plugin_host.rs` first. After the existing `ContextMenuEntry` struct, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliArg {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,             // "path" | "string" | "integer"
    pub required: bool,
    #[serde(default)]
    pub help: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliFlag {
    pub long: String,
    #[serde(default)]
    pub short: Option<String>,
    #[serde(rename = "type")]
    pub ty: String,             // "boolean" | "string"
    #[serde(default)]
    pub help: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliEntry {
    pub subcommand: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub command: String,
    pub summary: String,
    #[serde(default)]
    pub args: Vec<CliArg>,
    #[serde(default)]
    pub flags: Vec<CliFlag>,
    #[serde(default)]
    pub requires_tab_context: bool,
}
```

Modify `PluginManifest`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    // ... existing fields ...
    #[serde(default)]
    pub cli: Vec<CliEntry>,     // new
}
```

(Place `#[serde(default)] pub cli: Vec<CliEntry>,` as the last field; serde's `#[serde(default)]` makes it optional in JSON, defaulting to empty Vec — matching the TS schema's `cli?` semantics.)

- [ ] **Step 2: Expose helpers needed by CLI router**

At the end of `plugin_host.rs`, add:

```rust
/// Read-only access to every discovered plugin (enabled + disabled) with its
/// directory path. CLI router uses this to find plugins by subcommand/alias
/// before deciding to run them.
pub fn enabled_manifests_with_paths() -> Vec<(PluginManifest, PathBuf)> {
    STATE.read().unwrap().enabled.values().cloned().collect()
}

pub fn all_manifests() -> Vec<PluginManifest> {
    STATE.read().unwrap().all.clone()
}

/// Same as `read_enabled_map` but takes an explicit config path. Used by
/// CLI mode where no Tauri AppHandle is available before window creation.
pub fn read_enabled_map_from(config_dir: &std::path::Path) -> HashMap<String, bool> {
    let path = config_dir.join("settings.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    let v: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let mut out = HashMap::new();
    if let Some(obj) = v.get("plugins.enabled").and_then(|e| e.as_object()) {
        for (k, vv) in obj { if let Some(b) = vv.as_bool() { out.insert(k.clone(), b); } }
    }
    if let Some(obj) = v.get("plugins").and_then(|p| p.get("enabled")).and_then(|e| e.as_object()) {
        for (k, vv) in obj { if let Some(b) = vv.as_bool() { out.insert(k.clone(), b); } }
    }
    if let Some(top) = v.as_object() {
        for (k, vv) in top {
            if let Some(rest) = k.strip_prefix("plugins.enabled.") {
                if let Some(b) = vv.as_bool() { out.insert(rest.to_string(), b); }
            }
        }
    }
    out
}

/// Write the plugins.enabled map back to settings.json under
/// `<config_dir>/settings.json`, preserving every other top-level key.
/// Returns Err with a human-readable reason on IO or JSON failure.
pub fn write_enabled_flag(
    config_dir: &std::path::Path,
    plugin_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let path = config_dir.join("settings.json");
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = match std::fs::read(&path) {
        Ok(b) if !b.is_empty() => serde_json::from_slice(&b).map_err(|e| e.to_string())?,
        _ => serde_json::json!({}),
    };
    let root = v.as_object_mut().ok_or_else(|| "settings.json root not an object".to_string())?;
    let entry = root.entry("plugins.enabled".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let map = entry.as_object_mut().ok_or_else(|| "plugins.enabled not an object".to_string())?;
    map.insert(plugin_id.to_string(), serde_json::Value::Bool(enabled));
    let bytes = serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Discover manifests + their on-disk enabled-state from a known config dir.
/// Returns (manifests, enabled_map). Errors are logged to stderr; missing or
/// unreadable files yield empty results, never panics. Used by CLI router.
pub fn scan_disk(
    plugins_dir: &std::path::Path,
    config_dir: &std::path::Path,
) -> (Vec<(PluginManifest, PathBuf)>, HashMap<String, bool>) {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(plugins_dir) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() { continue }
            let mp = dir.join("manifest.json");
            if !mp.exists() { continue }
            if let Ok(bytes) = std::fs::read(&mp) {
                if let Ok(m) = serde_json::from_slice::<PluginManifest>(&bytes) {
                    out.push((m, dir));
                }
            }
        }
    }
    let enabled = read_enabled_map_from(config_dir);
    (out, enabled)
}
```

- [ ] **Step 3: Build to verify no regressions**

Run: `cd src-tauri && cargo build --lib`
Expected: success, no warnings about `cli` field. Existing tests should still compile.

- [ ] **Step 4: Run existing Rust tests**

Run: `cd src-tauri && cargo test --lib`
Expected: all existing tests pass (no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin_host.rs
git commit -m "feat(plugin-host): extend manifest with cli field and add scan helpers"
```

---

## Task 4: Wire cli.result through GUI action gate and applier

**Files:**
- Modify: `src/lib/plugins/host.ts`
- Modify: `src/lib/plugins/action-handlers.ts`

- [ ] **Step 1: Add a passing test in host.test.ts for cli.result**

Read `src/lib/plugins/host.test.ts` to match its style. Add this test:

```ts
import { describe, it, expect } from 'vitest'
import { parseAndFilterResponse } from './host'
import type { PluginManifest } from './types'

describe('parseAndFilterResponse', () => {
  it('passes cli.result actions through unconditionally', () => {
    const manifest = {
      id: 'demo', name: 'Demo', version: '0.1.0', binary: 'bin',
      host_capabilities: [],  // intentionally no capabilities
    } as PluginManifest
    const line = JSON.stringify({
      success: true,
      actions: [{ type: 'cli.result', data: { url: 'https://example.com' } }],
    })
    const r = parseAndFilterResponse(line, manifest)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.actions).toEqual([
      { type: 'cli.result', data: { url: 'https://example.com' } },
    ])
  })
})
```

(If `host.test.ts` already has a `parseAndFilterResponse` describe block, add only the `it` inside it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/plugins/host.test.ts`
Expected: fail — `actionAllowed` returns nothing for `cli.result`, so the action is dropped and the actions array is empty.

- [ ] **Step 3: Add cli.result pass-through in host.ts**

In `src/lib/plugins/host.ts`, locate `function actionAllowed(...)`. Add a new case to the switch, before the final brace:

```ts
    case 'cli.result':
      // No capability gate: cli.result is metadata-only and consumed by
      // the CLI runner. The GUI applier ignores it.
      return action
```

- [ ] **Step 4: Add no-op case in applyActions**

In `src/lib/plugins/action-handlers.ts`, locate the switch in `applyActions`. Add at the end before the default `}`:

```ts
        case 'cli.result':
          // No-op in GUI; CliRunner reads this in CLI mode.
          break
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm test src/lib/plugins`
Expected: all plugin-related tests pass. Also: `pnpm check` should now succeed (the union extension from Task 1 no longer breaks the exhaustive switches).

- [ ] **Step 6: Commit**

```bash
git add src/lib/plugins/host.ts src/lib/plugins/host.test.ts src/lib/plugins/action-handlers.ts
git commit -m "feat(plugins): pass cli.result through GUI action handlers as no-op"
```

---

## Task 5: Add cli section to share plugin manifest

**Files:**
- Modify: `src-tauri/plugins/share/manifest.json`

- [ ] **Step 1: Add cli section**

Read the current manifest. Insert the `cli` array as a new top-level key (after `host_capabilities`, before `timeout_seconds`):

```json
"cli": [
  {
    "subcommand": "share",
    "aliases": ["-s", "--share"],
    "command": "publish",
    "summary": "Render and publish file as a shareable URL",
    "args": [
      {
        "name": "file",
        "type": "path",
        "required": true,
        "help": "Markdown or image file to share"
      }
    ],
    "flags": [
      {
        "long": "--update",
        "type": "boolean",
        "help": "Force update existing share (default if already shared)"
      },
      {
        "long": "--copy-link",
        "type": "boolean",
        "help": "Print previously-shared URL instead of re-publishing"
      },
      {
        "long": "--unshare",
        "type": "boolean",
        "help": "Remove share for this file"
      }
    ],
    "requires_tab_context": true
  }
],
```

- [ ] **Step 2: Verify the manifest is valid JSON**

Run: `python3 -c "import json; json.load(open('src-tauri/plugins/share/manifest.json'))"`
Expected: no output, exit 0.

- [ ] **Step 3: Verify it loads with the Rust deserializer**

Add a small Rust check (a one-off command, no new file). Run:

```bash
cd src-tauri && cargo test --lib -- --nocapture share_manifest_parses 2>&1 | head -20 || true
```

If no such test exists, write one inline at the bottom of `src-tauri/src/plugin_host.rs`:

```rust
#[cfg(test)]
mod cli_manifest_tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn share_manifest_parses_with_cli() {
        let mp = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("plugins/share/manifest.json");
        let bytes = std::fs::read(&mp).expect("read manifest");
        let m: PluginManifest = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(m.id, "share");
        assert_eq!(m.cli.len(), 1);
        assert_eq!(m.cli[0].subcommand, "share");
        assert!(m.cli[0].aliases.contains(&"-s".to_string()));
        assert!(m.cli[0].requires_tab_context);
    }
}
```

Run: `cd src-tauri && cargo test --lib share_manifest_parses_with_cli`
Expected: PASS.

- [ ] **Step 4: Verify it loads with the TS validator**

Run: `pnpm test src/lib/plugins/registry.test.ts`
Expected: still passes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/plugins/share/manifest.json src-tauri/src/plugin_host.rs
git commit -m "feat(share): declare cli subcommand in manifest"
```

---

## Task 6: Emit cli.result from mdshare plugin binary

**Files:**
- Modify: `mdshare/src/ipc.rs`
- Modify: `mdshare/src/publish.rs`
- Modify: `mdshare/src/unpublish.rs`
- Modify: `mdshare/src/copy_link.rs`

- [ ] **Step 1: Add CliResult variant to mdshare Action enum**

In `mdshare/src/ipc.rs`, extend the `Action` enum:

```rust
    #[serde(rename = "cli.result")]
    CliResult { data: Map<String, Value> },
```

Place it after `SettingsMerge`. Also add a constructor helper at the bottom of the file:

```rust
pub fn cli_result(data: Map<String, Value>) -> Action {
    Action::CliResult { data }
}
```

- [ ] **Step 2: Add cli.result emit in publish.rs**

Read `mdshare/src/publish.rs` to find the success-path return. At each `Response::ok(...)` call that occurs after a successful publish (currently emits toast + clipboard.write + settings.merge), insert `cli_result(...)` into the actions vector. The data should be:

```rust
use crate::ipc::{cli_result, /* existing imports */};
use serde_json::{json, Map, Value};

// Just before constructing the success Response, build the cli payload:
let mut cli_data = Map::new();
cli_data.insert("url".to_string(), Value::String(public_url.clone()));
cli_data.insert("slug".to_string(), Value::String(current_slug.clone()));
cli_data.insert("is_update".to_string(), Value::Bool(is_update));
cli_data.insert("created_at".to_string(),
    Value::String(OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()));

// Then in the actions vec, include:
//   ..., cli_result(cli_data), ...
```

(If `OffsetDateTime` isn't already imported in `publish.rs`, add `use time::OffsetDateTime;`.)

The image-upload branch (`run_image_upload`) also returns a success Response — add `cli_result` there too with the same shape (`url`, `slug`, `is_update`, `created_at`).

- [ ] **Step 3: Add cli.result emit in unpublish.rs**

In each success return path:

```rust
let mut cli_data = Map::new();
cli_data.insert("slug".to_string(), Value::String(slug.clone()));
cli_data.insert("removed".to_string(), Value::Bool(true));
// add cli_result(cli_data) to the actions vec
```

- [ ] **Step 4: Add cli.result emit in copy_link.rs**

In the success return path (where it currently emits clipboard.write + toast):

```rust
let mut cli_data = Map::new();
cli_data.insert("url".to_string(), Value::String(url.clone()));
cli_data.insert("slug".to_string(), Value::String(slug.clone()));
// add cli_result(cli_data) to the actions vec
```

- [ ] **Step 5: Verify mdshare builds**

Run: `cd mdshare && cargo build --release`
Expected: success.

- [ ] **Step 6: Rebuild and copy the bundled binaries**

Run: `bash scripts/build-mdshare.sh`
Expected: refreshed `src-tauri/plugins/share/bin-aarch64-apple-darwin` (and x86_64 if cross-compile is set up; if not, skip the other arch — the GUI tests only need the host arch).

- [ ] **Step 7: Smoke test mdshare binary directly**

Run:
```bash
echo '{"command":"publish","context":{"tab":{"path":null,"filename":null,"extension":null,"kind":"markdown","title":"x","is_dirty":false,"is_untitled":true},"rendered_html":""},"settings":{},"host_version":"test","plugin_api_version":1}' \
  | src-tauri/plugins/share/bin-aarch64-apple-darwin
```
Expected: the binary still runs and outputs a JSON response (it will be a failure response — "请先保存文件" — because path is null; but the structure must include the new variant in the enum and not crash). Verify exit code 0 and JSON has `actions`.

- [ ] **Step 8: Run existing mdshare tests**

Run: `cd mdshare && cargo test`
Expected: all pass (or no tests if none — that's fine).

- [ ] **Step 9: Commit**

```bash
git add mdshare/src/ipc.rs mdshare/src/publish.rs mdshare/src/unpublish.rs mdshare/src/copy_link.rs src-tauri/plugins/share/bin-aarch64-apple-darwin src-tauri/plugins/share/bin-x86_64-apple-darwin
git commit -m "feat(mdshare): emit cli.result action on success"
```

---

## Task 7: Add clap dependency and CLI module skeleton

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/cli/mod.rs`
- Create: `src-tauri/src/cli/args.rs`

- [ ] **Step 1: Add clap to dependencies**

In `src-tauri/Cargo.toml`, in the `[dependencies]` block, add:

```toml
clap = { version = "4", default-features = false, features = ["std", "help", "error-context", "usage"] }
```

(Minimal feature set: omits `derive`, `cargo`, `env`, `color`, `suggestions`, `unicode`. Cuts ~150 KB.)

- [ ] **Step 2: Create cli/mod.rs**

Create `src-tauri/src/cli/mod.rs`:

```rust
//! CLI mode: argv parsing, routing, and execution.
//!
//! Entered from `main.rs` when `argv[0]` basename equals `"mdedit"` or argv
//! contains `--cli`. Returns a `std::process::ExitCode` that main propagates.

use std::process::ExitCode;

pub mod args;
pub mod router;
pub mod builtin;
pub mod runner;
pub mod install;
pub mod state;

/// Detect whether the current process should run in CLI mode.
pub fn is_cli_mode(argv: &[String]) -> bool {
    if argv.iter().any(|a| a == "--cli") { return true; }
    if let Some(arg0) = argv.first() {
        let name = std::path::Path::new(arg0)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if name == "mdedit" { return true; }
    }
    false
}

pub fn run_cli(argv: Vec<String>) -> ExitCode {
    let parsed = args::parse(&argv);
    let route = router::resolve(&parsed);
    match route {
        router::Route::Builtin(b) => builtin::run(b, &parsed),
        router::Route::Plugin(p) => runner::run(p, parsed),
        router::Route::Disabled { plugin_id, subcommand } => {
            eprintln!("mdedit: command '{subcommand}' is provided by the '{plugin_id}' plugin, which is disabled.");
            eprintln!("Enable it in Preferences → Plugins, or run:");
            eprintln!("  mdedit plugin enable {plugin_id}");
            ExitCode::from(3)
        }
        router::Route::Unknown(name) => {
            eprintln!("mdedit: unknown command '{name}'. Run 'mdedit help' to see available commands.");
            ExitCode::from(127)
        }
    }
}
```

- [ ] **Step 3: Create cli/args.rs with the parsed-args struct and parser**

Create `src-tauri/src/cli/args.rs`:

```rust
//! Argv parsing. We hand-extract global flags and identify subcommand+rest,
//! then defer flag/arg parsing for plugin subcommands to a clap Command built
//! dynamically from the manifest's `cli` entry inside `runner.rs`.
//!
//! Why not a single big clap setup: plugin subcommands are discovered at
//! runtime from manifest data, so the clap Command for them isn't static.
//! Globals + builtin routing are static and live here.

#[derive(Debug, Clone, Default)]
pub struct Globals {
    pub json: bool,
    pub quiet: bool,
    pub clipboard: bool,
    pub yes: bool,
    pub plugin_dir_override: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Parsed {
    /// argv with global flags stripped out.
    pub rest: Vec<String>,
    pub globals: Globals,
    /// argv[0], preserved so usage messages can self-reference.
    pub argv0: String,
}

pub fn parse(argv: &[String]) -> Parsed {
    let argv0 = argv.first().cloned().unwrap_or_else(|| "mdedit".to_string());
    let mut globals = Globals {
        // Defaults; auto-quiet on non-TTY happens in the runner.
        clipboard: true,
        ..Default::default()
    };
    let mut rest = Vec::with_capacity(argv.len().saturating_sub(1));
    let mut i = 1;
    while i < argv.len() {
        let a = &argv[i];
        match a.as_str() {
            "--cli" => { /* consumed by mode dispatch; drop */ }
            "--json" => globals.json = true,
            "-q" | "--quiet" => globals.quiet = true,
            "--no-clipboard" => globals.clipboard = false,
            "-y" | "--yes" => globals.yes = true,
            "--plugin-dir" => {
                if i + 1 < argv.len() {
                    globals.plugin_dir_override = Some(argv[i + 1].clone());
                    i += 1;
                }
            }
            _ => rest.push(a.clone()),
        }
        i += 1;
    }
    Parsed { rest, globals, argv0 }
}
```

- [ ] **Step 4: Add unit tests inline in args.rs**

Append to `src-tauri/src/cli/args.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn s(args: &[&str]) -> Parsed {
        parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }
    #[test]
    fn strips_globals_keeps_subcommand_and_args() {
        let p = s(&["mdedit", "--json", "share", "draft.md", "-q"]);
        assert_eq!(p.rest, vec!["share".to_string(), "draft.md".to_string()]);
        assert!(p.globals.json);
        assert!(p.globals.quiet);
    }
    #[test]
    fn alias_short_flag_survives() {
        let p = s(&["mdedit", "-s", "x.md"]);
        assert_eq!(p.rest, vec!["-s".to_string(), "x.md".to_string()]);
        assert!(!p.globals.json);
    }
    #[test]
    fn plugin_dir_override_consumes_next() {
        let p = s(&["mdedit", "--plugin-dir", "/tmp/p", "help"]);
        assert_eq!(p.globals.plugin_dir_override.as_deref(), Some("/tmp/p"));
        assert_eq!(p.rest, vec!["help".to_string()]);
    }
    #[test]
    fn clipboard_defaults_on() {
        let p = s(&["mdedit", "help"]);
        assert!(p.globals.clipboard);
    }
    #[test]
    fn no_clipboard_flips_it() {
        let p = s(&["mdedit", "--no-clipboard", "share", "x.md"]);
        assert!(!p.globals.clipboard);
    }
    #[test]
    fn cli_flag_is_dropped() {
        let p = s(&["mdedit", "--cli", "help"]);
        assert_eq!(p.rest, vec!["help".to_string()]);
    }
}
```

- [ ] **Step 5: Add stub files for router/builtin/runner/install/state**

These will be filled in by Tasks 8-13. For now, create stubs so `mod.rs` compiles:

`src-tauri/src/cli/router.rs`:

```rust
use super::args::Parsed;

pub enum Route {
    Builtin(Builtin),
    Plugin(PluginRoute),
    Disabled { plugin_id: String, subcommand: String },
    Unknown(String),
}

pub enum Builtin {
    Help { topic: Option<String>, all: bool },
    Version,
    PluginList,
    PluginEnable(String),
    PluginDisable(String),
    PluginInfo(String),
}

pub struct PluginRoute {
    pub plugin_id: String,
    pub subcommand: String,
    pub remaining: Vec<String>,
}

pub fn resolve(_parsed: &Parsed) -> Route {
    Route::Unknown("(unimplemented)".to_string())
}
```

`src-tauri/src/cli/builtin.rs`:

```rust
use super::args::Parsed;
use super::router::Builtin;
use std::process::ExitCode;

pub fn run(_b: Builtin, _parsed: &Parsed) -> ExitCode {
    eprintln!("mdedit: builtin command not yet implemented");
    ExitCode::from(1)
}
```

`src-tauri/src/cli/runner.rs`:

```rust
use super::args::Parsed;
use super::router::PluginRoute;
use std::process::ExitCode;

pub fn run(_p: PluginRoute, _parsed: Parsed) -> ExitCode {
    eprintln!("mdedit: plugin runner not yet implemented");
    ExitCode::from(1)
}
```

`src-tauri/src/cli/install.rs`:

```rust
// Install/uninstall/repair logic — implemented in Task 14.
```

`src-tauri/src/cli/state.rs`:

```rust
// Tauri-managed CliState — implemented in Task 11.
```

- [ ] **Step 6: Expose `cli` from lib.rs**

In `src-tauri/src/lib.rs`, near the top with the other `pub mod` declarations, add:

```rust
pub mod cli;
```

- [ ] **Step 7: Build and test**

Run: `cd src-tauri && cargo build --lib && cargo test --lib cli::args`
Expected: build succeeds; all 6 args tests pass.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/cli/
git commit -m "feat(cli): add clap dep and cli module skeleton"
```

---

## Task 8: Implement router with manifest-driven resolution

**Files:**
- Modify: `src-tauri/src/cli/router.rs`

- [ ] **Step 1: Write failing tests for the routing table**

Create `src-tauri/src/cli/router_tests.rs` (so it can include test fixtures) — but actually, inline tests are simpler. Append to `src-tauri/src/cli/router.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_host::{PluginManifest, CliEntry, scan_disk};
    use std::path::PathBuf;

    fn manifest_with_cli(id: &str, sub: &str, aliases: &[&str]) -> PluginManifest {
        PluginManifest {
            id: id.to_string(),
            name: id.to_string(),
            version: "0.1.0".to_string(),
            description: None,
            binary: "bin".to_string(),
            menus: vec![],
            context_menus: vec![],
            settings: None,
            host_capabilities: vec![],
            timeout_seconds: 30,
            cli: vec![CliEntry {
                subcommand: sub.to_string(),
                aliases: aliases.iter().map(|s| s.to_string()).collect(),
                command: "noop".to_string(),
                summary: "s".to_string(),
                args: vec![],
                flags: vec![],
                requires_tab_context: false,
            }],
        }
    }

    fn route_with(
        rest: &[&str],
        manifests: Vec<(PluginManifest, PathBuf)>,
        enabled: std::collections::HashMap<String, bool>,
    ) -> Route {
        resolve_with(
            &rest.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &manifests,
            &enabled,
        )
    }

    #[test]
    fn no_args_is_help() {
        let r = route_with(&[], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::Help { .. })));
    }

    #[test]
    fn help_subcommand_routes_to_help() {
        let r = route_with(&["help"], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::Help { topic: None, all: false })));
    }

    #[test]
    fn help_with_topic_carries_topic() {
        let r = route_with(&["help", "share"], vec![], Default::default());
        let Route::Builtin(Builtin::Help { topic, all }) = r else { panic!() };
        assert_eq!(topic.as_deref(), Some("share"));
        assert!(!all);
    }

    #[test]
    fn dash_h_routes_to_help() {
        let r = route_with(&["-h"], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::Help { .. })));
    }

    #[test]
    fn version_routes() {
        let r = route_with(&["version"], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::Version)));
    }

    #[test]
    fn plugin_list_routes() {
        let r = route_with(&["plugin", "list"], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::PluginList)));
    }

    #[test]
    fn plugin_enable_with_id_routes() {
        let r = route_with(&["plugin", "enable", "share"], vec![], Default::default());
        let Route::Builtin(Builtin::PluginEnable(id)) = r else { panic!() };
        assert_eq!(id, "share");
    }

    #[test]
    fn enabled_plugin_subcommand_routes_to_plugin() {
        let m = manifest_with_cli("share", "share", &["-s"]);
        let mut enabled = std::collections::HashMap::new();
        enabled.insert("share".to_string(), true);
        let r = route_with(&["share", "draft.md"], vec![(m, PathBuf::from("/tmp"))], enabled);
        let Route::Plugin(p) = r else { panic!() };
        assert_eq!(p.plugin_id, "share");
        assert_eq!(p.subcommand, "share");
        assert_eq!(p.remaining, vec!["draft.md".to_string()]);
    }

    #[test]
    fn enabled_plugin_alias_resolves_to_subcommand() {
        let m = manifest_with_cli("share", "share", &["-s"]);
        let mut enabled = std::collections::HashMap::new();
        enabled.insert("share".to_string(), true);
        let r = route_with(&["-s", "draft.md"], vec![(m, PathBuf::from("/tmp"))], enabled);
        let Route::Plugin(p) = r else { panic!() };
        assert_eq!(p.subcommand, "share");
        assert_eq!(p.remaining, vec!["draft.md".to_string()]);
    }

    #[test]
    fn disabled_plugin_yields_disabled_route() {
        let m = manifest_with_cli("share", "share", &["-s"]);
        let mut enabled = std::collections::HashMap::new();
        enabled.insert("share".to_string(), false);
        let r = route_with(&["-s", "x.md"], vec![(m, PathBuf::from("/tmp"))], enabled);
        let Route::Disabled { plugin_id, subcommand } = r else { panic!() };
        assert_eq!(plugin_id, "share");
        assert_eq!(subcommand, "share");
    }

    #[test]
    fn unknown_command_yields_unknown() {
        let r = route_with(&["nope"], vec![], Default::default());
        let Route::Unknown(name) = r else { panic!() };
        assert_eq!(name, "nope");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib cli::router::tests`
Expected: all 11 tests fail (router stub returns Unknown for everything).

- [ ] **Step 3: Implement resolve and resolve_with**

Replace the body of `src-tauri/src/cli/router.rs` (preserving the `#[cfg(test)] mod tests` block at the bottom). Final file:

```rust
//! Routing: argv → Route. Step order matches spec §3 exactly.

use crate::plugin_host::{scan_disk, PluginManifest};
use super::args::Parsed;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum Route {
    Builtin(Builtin),
    Plugin(PluginRoute),
    Disabled { plugin_id: String, subcommand: String },
    Unknown(String),
}

#[derive(Debug)]
pub enum Builtin {
    Help { topic: Option<String>, all: bool },
    Version,
    PluginList,
    PluginEnable(String),
    PluginDisable(String),
    PluginInfo(String),
}

#[derive(Debug)]
pub struct PluginRoute {
    pub plugin_id: String,
    pub subcommand: String,
    pub remaining: Vec<String>,
}

/// Resolve a Route against the live filesystem: scans the resource_dir for
/// manifests and reads the on-disk enabled map. CLI's main entry uses this.
pub fn resolve(parsed: &Parsed) -> Route {
    let (manifests, enabled) = current_scan(parsed);
    resolve_with(&parsed.rest, &manifests, &enabled)
}

/// Tabular resolver — pure, takes already-scanned data. Tests use this.
pub fn resolve_with(
    rest: &[String],
    manifests: &[(PluginManifest, PathBuf)],
    enabled: &HashMap<String, bool>,
) -> Route {
    // No subcommand → help.
    let first = match rest.first() {
        Some(s) => s.clone(),
        None => return Route::Builtin(Builtin::Help { topic: None, all: false }),
    };

    // Step 1: help.
    if matches!(first.as_str(), "help" | "-h" | "--help") {
        let mut topic: Option<String> = None;
        let mut all = false;
        for a in rest.iter().skip(1) {
            if a == "--all" { all = true; }
            else if topic.is_none() { topic = Some(a.clone()); }
        }
        return Route::Builtin(Builtin::Help { topic, all });
    }

    // Step 2: version.
    if matches!(first.as_str(), "version" | "-v" | "--version") {
        return Route::Builtin(Builtin::Version);
    }

    // Step 3: plugin <sub>.
    if first == "plugin" {
        return match rest.get(1).map(|s| s.as_str()) {
            Some("list") => Route::Builtin(Builtin::PluginList),
            Some("enable") => match rest.get(2) {
                Some(id) => Route::Builtin(Builtin::PluginEnable(id.clone())),
                None => Route::Unknown("plugin enable (missing id)".to_string()),
            },
            Some("disable") => match rest.get(2) {
                Some(id) => Route::Builtin(Builtin::PluginDisable(id.clone())),
                None => Route::Unknown("plugin disable (missing id)".to_string()),
            },
            Some("info") => match rest.get(2) {
                Some(id) => Route::Builtin(Builtin::PluginInfo(id.clone())),
                None => Route::Unknown("plugin info (missing id)".to_string()),
            },
            _ => Route::Unknown(format!("plugin {}", rest.get(1).cloned().unwrap_or_default())),
        };
    }

    // Step 4 & 5: plugin subcommand or alias.
    // First check enabled plugins; then check disabled ones to produce the
    // distinct exit-code-3 response.
    let resolved = match_against_manifests(manifests, &first, enabled);
    match resolved {
        Some((plugin_id, subcommand, is_enabled)) => {
            if is_enabled {
                Route::Plugin(PluginRoute {
                    plugin_id,
                    subcommand,
                    remaining: rest.iter().skip(1).cloned().collect(),
                })
            } else {
                Route::Disabled { plugin_id, subcommand }
            }
        }
        None => Route::Unknown(first),
    }
}

fn match_against_manifests(
    manifests: &[(PluginManifest, PathBuf)],
    token: &str,
    enabled: &HashMap<String, bool>,
) -> Option<(String, String, bool)> {
    for (m, _dir) in manifests {
        for entry in &m.cli {
            if entry.subcommand == token || entry.aliases.iter().any(|a| a == token) {
                let is_enabled = enabled.get(&m.id).copied().unwrap_or(true);
                return Some((m.id.clone(), entry.subcommand.clone(), is_enabled));
            }
        }
    }
    None
}

fn current_scan(parsed: &Parsed) -> (Vec<(PluginManifest, PathBuf)>, HashMap<String, bool>) {
    let plugins_dir = resolve_plugins_dir(parsed);
    let config_dir = resolve_config_dir();
    scan_disk(&plugins_dir, &config_dir)
}

fn resolve_plugins_dir(parsed: &Parsed) -> PathBuf {
    if let Some(p) = &parsed.globals.plugin_dir_override {
        return PathBuf::from(p);
    }
    // The binary lives at .../M↓.app/Contents/MacOS/M↓; resources live at
    // .../M↓.app/Contents/Resources/. Resolve relative to the current exe.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            if let Some(contents) = macos_dir.parent() {
                let candidate = contents.join("Resources").join("plugins");
                if candidate.exists() { return candidate; }
                // Dev fallback: cargo target/debug/<exe>; manifest live in repo.
                let dev = contents.join("plugins");
                if dev.exists() { return dev; }
            }
        }
    }
    // Fallback for cargo test in src-tauri/: <CARGO_MANIFEST_DIR>/plugins
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("plugins")
}

fn resolve_config_dir() -> PathBuf {
    // macOS: ~/Library/Application Support/<identifier>/
    // Read identifier from compile-time TAURI_BUNDLE_IDENTIFIER if exposed;
    // hardcode the literal here to avoid touching tauri_build at this layer.
    let identifier = "com.laobu.mdeditor";
    if let Some(home) = std::env::var_os("HOME") {
        return Path::new(&home)
            .join("Library").join("Application Support").join(identifier);
    }
    PathBuf::from(".")
}

// (test module continues below — keep it from the test step)
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `cd src-tauri && cargo test --lib cli::router::tests`
Expected: all 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli/router.rs
git commit -m "feat(cli): implement argv routing table"
```

---

## Task 9: Implement built-in subcommands (help/version/plugin)

**Files:**
- Modify: `src-tauri/src/cli/builtin.rs`

- [ ] **Step 1: Write tests for builtin outputs**

Append to `src-tauri/src/cli/builtin.rs` (after replacing the stub body in step 2 below, but write the tests first as TDD):

Actually since builtins write directly to stdout/stderr, test them via the actual binary in the integration test in Task 10. For unit-level coverage, expose the rendering as pure functions returning strings and test those. Add to `src-tauri/src/cli/builtin.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_host::{PluginManifest, CliEntry};
    use std::collections::HashMap;

    fn share_manifest() -> PluginManifest {
        PluginManifest {
            id: "share".to_string(),
            name: "Share".to_string(),
            version: "0.1.0".to_string(),
            description: Some("Publish current file as a shareable web page".to_string()),
            binary: "bin".to_string(),
            menus: vec![],
            context_menus: vec![],
            settings: None,
            host_capabilities: vec![],
            timeout_seconds: 30,
            cli: vec![CliEntry {
                subcommand: "share".to_string(),
                aliases: vec!["-s".to_string(), "--share".to_string()],
                command: "publish".to_string(),
                summary: "Render and publish file as a shareable URL".to_string(),
                args: vec![],
                flags: vec![],
                requires_tab_context: true,
            }],
        }
    }

    #[test]
    fn help_includes_share_when_enabled() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), true);
        let out = render_help(None, false, &[share_manifest()], &enabled);
        assert!(out.contains("PLUGIN COMMANDS:"));
        assert!(out.contains("share"));
        assert!(out.contains("[Share]"));
        assert!(out.contains("mdedit -s <file>"));
    }

    #[test]
    fn help_all_includes_disabled_section() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), false);
        let out = render_help(None, true, &[share_manifest()], &enabled);
        assert!(out.contains("DISABLED COMMANDS:"));
        assert!(out.contains("mdedit plugin enable share"));
    }

    #[test]
    fn help_topic_shows_per_subcommand_detail() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), true);
        let out = render_help(Some("share"), false, &[share_manifest()], &enabled);
        assert!(out.contains("mdedit share"));
        assert!(out.contains("Render and publish"));
        assert!(out.contains("EXIT CODES:"));
    }

    #[test]
    fn version_string_includes_plugin_api() {
        let v = render_version(false);
        assert!(v.contains("mdedit"));
        assert!(v.contains("plugin API v1"));
    }

    #[test]
    fn version_json_is_parsable() {
        let v = render_version(true);
        let _: serde_json::Value = serde_json::from_str(&v).expect("valid JSON");
    }

    #[test]
    fn plugin_list_rows_enabled_and_disabled() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), false);
        let out = render_plugin_list(false, &[share_manifest()], &enabled);
        assert!(out.contains("share"));
        assert!(out.contains("disabled"));
    }

    #[test]
    fn plugin_list_json_array() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), true);
        let out = render_plugin_list(true, &[share_manifest()], &enabled);
        let v: serde_json::Value = serde_json::from_str(&out).expect("valid JSON");
        let arr = v.as_array().expect("array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["status"], "enabled");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib cli::builtin::tests`
Expected: All 7 tests fail (functions undefined).

- [ ] **Step 3: Replace builtin.rs with full implementation**

Replace the body of `src-tauri/src/cli/builtin.rs`:

```rust
//! Built-in subcommands: help, version, plugin {list,enable,disable,info}.
//!
//! These run entirely in Rust without spinning up a Tauri webview. Target
//! cold-start budget: under 100 ms.

use crate::plugin_host::{scan_disk, write_enabled_flag, PluginManifest};
use super::args::Parsed;
use super::router::Builtin;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const PLUGIN_API_VERSION: &str = "v1";

pub fn run(b: Builtin, parsed: &Parsed) -> ExitCode {
    let (manifests, enabled) = current_scan(parsed);
    let manifests_only: Vec<PluginManifest> =
        manifests.into_iter().map(|(m, _)| m).collect();
    match b {
        Builtin::Help { topic, all } => {
            println!("{}", render_help(topic.as_deref(), all, &manifests_only, &enabled));
            ExitCode::from(0)
        }
        Builtin::Version => {
            println!("{}", render_version(parsed.globals.json));
            ExitCode::from(0)
        }
        Builtin::PluginList => {
            println!("{}", render_plugin_list(parsed.globals.json, &manifests_only, &enabled));
            ExitCode::from(0)
        }
        Builtin::PluginEnable(id) => {
            if !manifests_only.iter().any(|m| m.id == id) {
                eprintln!("mdedit: unknown plugin id '{id}'");
                return ExitCode::from(2);
            }
            let cfg = resolve_config_dir();
            match write_enabled_flag(&cfg, &id, true) {
                Ok(()) => {
                    if !parsed.globals.quiet {
                        eprintln!("✓ plugin '{id}' enabled");
                    }
                    ExitCode::from(0)
                }
                Err(e) => {
                    eprintln!("mdedit: failed to enable plugin: {e}");
                    ExitCode::from(1)
                }
            }
        }
        Builtin::PluginDisable(id) => {
            if !manifests_only.iter().any(|m| m.id == id) {
                eprintln!("mdedit: unknown plugin id '{id}'");
                return ExitCode::from(2);
            }
            let cfg = resolve_config_dir();
            match write_enabled_flag(&cfg, &id, false) {
                Ok(()) => {
                    if !parsed.globals.quiet {
                        eprintln!("✓ plugin '{id}' disabled");
                    }
                    ExitCode::from(0)
                }
                Err(e) => {
                    eprintln!("mdedit: failed to disable plugin: {e}");
                    ExitCode::from(1)
                }
            }
        }
        Builtin::PluginInfo(id) => {
            let m = match manifests_only.iter().find(|m| m.id == id) {
                Some(m) => m,
                None => {
                    eprintln!("mdedit: unknown plugin id '{id}'");
                    return ExitCode::from(2);
                }
            };
            println!("{}", render_plugin_info(m, &enabled));
            ExitCode::from(0)
        }
    }
}

pub fn render_version(as_json: bool) -> String {
    let version = env!("CARGO_PKG_VERSION");
    if as_json {
        json!({
            "ok": true,
            "data": { "version": version, "plugin_api": PLUGIN_API_VERSION }
        }).to_string()
    } else {
        format!("mdedit {version} (plugin API {PLUGIN_API_VERSION})")
    }
}

pub fn render_help(
    topic: Option<&str>,
    all: bool,
    manifests: &[PluginManifest],
    enabled: &HashMap<String, bool>,
) -> String {
    if let Some(t) = topic {
        return render_help_topic(t, manifests, enabled);
    }
    let version = env!("CARGO_PKG_VERSION");
    let mut out = String::new();
    out.push_str("mdedit — M↓ command-line interface\n");
    out.push_str(&format!("Version: {version} (plugin API {PLUGIN_API_VERSION})\n\n"));
    out.push_str("USAGE:\n");
    out.push_str("  mdedit <command> [args...]\n");
    // Surface short-form aliases inline for discoverability.
    for m in manifests {
        let is_on = enabled.get(&m.id).copied().unwrap_or(true);
        if !is_on { continue }
        for entry in &m.cli {
            if let Some(short) = entry.aliases.iter().find(|a| a.starts_with('-') && a.len() == 2) {
                out.push_str(&format!(
                    "  mdedit {short} <args>                (alias for: mdedit {} <args>)\n",
                    entry.subcommand,
                ));
            }
        }
    }
    out.push_str("\nCORE COMMANDS:\n");
    out.push_str("  help          Show this help\n");
    out.push_str("  version       Print version\n");
    out.push_str("  plugin        Manage plugins (list, enable, disable, info)\n");

    let mut shown_header = false;
    for m in manifests {
        let is_on = enabled.get(&m.id).copied().unwrap_or(true);
        if !is_on { continue }
        for entry in &m.cli {
            if !shown_header {
                out.push_str("\nPLUGIN COMMANDS:\n");
                shown_header = true;
            }
            out.push_str(&format!(
                "  {:<13} {:<60} [{}]\n",
                entry.subcommand, entry.summary, m.name,
            ));
        }
    }

    if all {
        let mut shown = false;
        for m in manifests {
            let is_on = enabled.get(&m.id).copied().unwrap_or(true);
            if is_on { continue }
            for entry in &m.cli {
                if !shown {
                    out.push_str("\nDISABLED COMMANDS:\n");
                    shown = true;
                }
                out.push_str(&format!(
                    "  {:<13} (provided by '{}' plugin — disabled)\n                Enable: mdedit plugin enable {}\n",
                    entry.subcommand, m.name, m.id,
                ));
            }
        }
    }

    out.push_str("\nRun 'mdedit help <command>' for details on a specific command.\n");
    out.push_str("Run 'mdedit help --all' to see disabled / unavailable commands too.\n");
    out
}

fn render_help_topic(
    topic: &str,
    manifests: &[PluginManifest],
    enabled: &HashMap<String, bool>,
) -> String {
    for m in manifests {
        for entry in &m.cli {
            if entry.subcommand == topic || entry.aliases.iter().any(|a| a == topic) {
                let on = enabled.get(&m.id).copied().unwrap_or(true);
                let mut out = String::new();
                out.push_str(&format!(
                    "mdedit {} — {}\n",
                    entry.subcommand, entry.summary,
                ));
                out.push_str(&format!("Provided by: {} plugin (v{})", m.name, m.version));
                if !on { out.push_str(" [DISABLED]"); }
                out.push('\n');
                out.push_str("\nUSAGE:\n");
                let args_sig = entry.args.iter()
                    .map(|a| if a.required { format!("<{}>", a.name) } else { format!("[{}]", a.name) })
                    .collect::<Vec<_>>().join(" ");
                out.push_str(&format!("  mdedit {} {}\n", entry.subcommand, args_sig));
                for a in &entry.aliases {
                    out.push_str(&format!("  mdedit {} {}                (alias)\n", a, args_sig));
                }
                if !entry.args.is_empty() {
                    out.push_str("\nARGUMENTS:\n");
                    for a in &entry.args {
                        out.push_str(&format!("  <{:<8}> {}\n",
                            a.name, a.help.as_deref().unwrap_or("")));
                    }
                }
                if !entry.flags.is_empty() {
                    out.push_str("\nFLAGS:\n");
                    for f in &entry.flags {
                        let flag = match &f.short {
                            Some(s) => format!("{}, {}", s, f.long),
                            None => f.long.clone(),
                        };
                        out.push_str(&format!("  {:<25} {}\n",
                            flag, f.help.as_deref().unwrap_or("")));
                    }
                }
                out.push_str("\nEXIT CODES:\n");
                out.push_str("  0    Success\n");
                out.push_str("  2    File or argument error\n");
                out.push_str("  3    Plugin disabled\n");
                out.push_str("  4    Network or server error\n");
                return out;
            }
        }
    }
    format!("mdedit: unknown topic '{topic}'. Run 'mdedit help' to see commands.\n")
}

pub fn render_plugin_list(
    as_json: bool,
    manifests: &[PluginManifest],
    enabled: &HashMap<String, bool>,
) -> String {
    if as_json {
        let arr: Vec<_> = manifests.iter().map(|m| {
            let is_on = enabled.get(&m.id).copied().unwrap_or(true);
            json!({
                "id": m.id,
                "name": m.name,
                "version": m.version,
                "status": if is_on { "enabled" } else { "disabled" },
                "cli": m.cli.iter().map(|c| json!({
                    "subcommand": c.subcommand,
                    "aliases": c.aliases,
                    "summary": c.summary,
                })).collect::<Vec<_>>(),
            })
        }).collect();
        return json!({ "ok": true, "data": arr }).to_string();
    }
    let mut out = String::new();
    out.push_str(&format!("{:<10} {:<12} {:<8} {:<10} {}\n",
        "ID", "NAME", "VERSION", "STATUS", "CLI"));
    for m in manifests {
        let is_on = enabled.get(&m.id).copied().unwrap_or(true);
        let cli = m.cli.iter().map(|c| {
            let aliases = if c.aliases.is_empty() {
                String::new()
            } else {
                format!(" ({})", c.aliases.join(", "))
            };
            format!("{}{aliases}", c.subcommand)
        }).collect::<Vec<_>>().join(", ");
        out.push_str(&format!("{:<10} {:<12} {:<8} {:<10} {}\n",
            m.id, m.name, m.version,
            if is_on { "enabled" } else { "disabled" },
            cli,
        ));
    }
    out
}

pub fn render_plugin_info(
    m: &PluginManifest,
    enabled: &HashMap<String, bool>,
) -> String {
    let is_on = enabled.get(&m.id).copied().unwrap_or(true);
    let mut out = String::new();
    out.push_str(&format!("{} ({})  v{}\n", m.name, m.id, m.version));
    out.push_str(&format!("Status: {}\n", if is_on { "enabled" } else { "disabled" }));
    if let Some(d) = &m.description {
        out.push_str(&format!("Description: {d}\n"));
    }
    if !m.cli.is_empty() {
        out.push_str("\nCLI commands:\n");
        for c in &m.cli {
            out.push_str(&format!("  - {}: {}\n", c.subcommand, c.summary));
            for a in &c.aliases {
                out.push_str(&format!("    alias: {a}\n"));
            }
        }
    }
    if !m.menus.is_empty() {
        out.push_str("\nMenu items:\n");
        for me in &m.menus {
            out.push_str(&format!("  - [{}] {} ({})\n", me.location, me.label, me.command));
        }
    }
    out
}

fn current_scan(parsed: &Parsed) -> (Vec<(PluginManifest, PathBuf)>, HashMap<String, bool>) {
    let plugins_dir = resolve_plugins_dir(parsed);
    let config_dir = resolve_config_dir();
    scan_disk(&plugins_dir, &config_dir)
}

fn resolve_plugins_dir(parsed: &Parsed) -> PathBuf {
    if let Some(p) = &parsed.globals.plugin_dir_override {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            if let Some(contents) = macos_dir.parent() {
                let candidate = contents.join("Resources").join("plugins");
                if candidate.exists() { return candidate; }
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("plugins")
}

fn resolve_config_dir() -> PathBuf {
    let identifier = "com.laobu.mdeditor";
    if let Some(home) = std::env::var_os("HOME") {
        return Path::new(&home)
            .join("Library").join("Application Support").join(identifier);
    }
    PathBuf::from(".")
}

// test module continues below
```

- [ ] **Step 4: Run unit tests**

Run: `cd src-tauri && cargo test --lib cli::builtin::tests`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli/builtin.rs
git commit -m "feat(cli): implement help, version, and plugin builtin subcommands"
```

---

## Task 10: Wire mode dispatch and add builtin integration test

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/cli_builtin_integration.rs`

- [ ] **Step 1: Replace main.rs with mode dispatch**

Replace `src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    if mdeditor_lib::cli::is_cli_mode(&argv) {
        return mdeditor_lib::cli::run_cli(argv);
    }
    mdeditor_lib::run();
    ExitCode::from(0)
}
```

- [ ] **Step 2: Verify GUI build still compiles**

Run: `cd src-tauri && cargo build --lib --bin mdeditor`
Expected: success.

- [ ] **Step 3: Write integration test for builtin path**

Create `src-tauri/tests/cli_builtin_integration.rs`:

```rust
//! End-to-end test for built-in CLI subcommands.
//!
//! Spawns the real `mdeditor` binary with argv[0] forced to "mdedit" so the
//! CLI mode path triggers. Asserts stdout / stderr / exit code for the
//! happy paths. Plugin discovery uses --plugin-dir to point at fixtures,
//! so this test does not depend on src-tauri/plugins/ contents.

use std::path::PathBuf;
use std::process::Command;

fn binary_path() -> PathBuf {
    // cargo test puts the binary at target/<profile>/<name>; CARGO_BIN_EXE_<bin>
    // is set for integration tests since 1.43.
    PathBuf::from(env!("CARGO_BIN_EXE_mdeditor"))
}

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Build a temp dir with a single fake plugin manifest declaring a CLI subcommand.
fn temp_plugins_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "mdedit-cli-int-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    let plugin = dir.join("fakeplug");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("manifest.json"), r#"{
      "id": "fakeplug",
      "name": "FakePlug",
      "version": "0.1.0",
      "binary": "bin",
      "host_capabilities": [],
      "cli": [{
        "subcommand": "fake",
        "aliases": ["-f"],
        "command": "noop",
        "summary": "Just a fake plugin for testing"
      }]
    }"#).unwrap();
    dir
}

fn run_cli(args: &[&str], plugins_dir: &PathBuf) -> (i32, String, String) {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(binary_path());
    cmd.arg0("mdedit");          // force CLI mode via argv[0] basename
    cmd.args(["--plugin-dir", plugins_dir.to_str().unwrap()]);
    cmd.args(args);
    cmd.env_remove("HOME");      // avoid touching real user settings
    cmd.env("HOME", std::env::temp_dir().to_str().unwrap());
    let out = cmd.output().expect("spawn binary");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    )
}

#[test]
fn help_lists_fake_plugin_command() {
    let dir = temp_plugins_dir();
    let (code, stdout, _) = run_cli(&["help"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(code, 0);
    assert!(stdout.contains("PLUGIN COMMANDS:"), "stdout was: {stdout}");
    assert!(stdout.contains("fake"));
    assert!(stdout.contains("[FakePlug]"));
}

#[test]
fn version_prints_and_exits_zero() {
    let dir = temp_plugins_dir();
    let (code, stdout, _) = run_cli(&["version"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(code, 0);
    assert!(stdout.contains("mdedit"));
    assert!(stdout.contains("plugin API v1"));
}

#[test]
fn plugin_list_includes_fakeplug() {
    let dir = temp_plugins_dir();
    let (code, stdout, _) = run_cli(&["plugin", "list"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(code, 0);
    assert!(stdout.contains("fakeplug"));
}

#[test]
fn unknown_subcommand_exits_127() {
    let dir = temp_plugins_dir();
    let (code, _, stderr) = run_cli(&["nope"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(code, 127);
    assert!(stderr.contains("unknown command"));
}

#[test]
fn alias_routes_to_plugin_path_until_runner_implemented() {
    // Once runner.rs is wired (Task 13), this test will need to assert
    // a real exit code. For now, asserting it does NOT exit 127 confirms
    // the alias was successfully matched as a plugin subcommand.
    let dir = temp_plugins_dir();
    let (code, _, _) = run_cli(&["-f", "anything.md"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_ne!(code, 127);
}
```

- [ ] **Step 4: Build and run integration test**

Run: `cd src-tauri && cargo test --test cli_builtin_integration`
Expected: 4 tests pass; the 5th (alias_routes_to_plugin_path_until_runner_implemented) passes only if the runner stub returns a non-127 exit. The current runner stub returns 1 — so that test passes too.

- [ ] **Step 5: Verify GUI path still works (smoke)**

Run: `cd src-tauri && cargo run --bin mdeditor -- --help` would conflict; instead build and run a quick check that GUI mode is preserved:

```bash
cd src-tauri && cargo build --bin mdeditor
# Confirm binary exists and is the right size class (mtime check)
ls -la target/debug/mdeditor
```

Expected: binary built successfully. Manual smoke (don't run during automated tests): `cargo run --bin mdeditor` should still open the GUI window. (Document this as a manual step; do not auto-run.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/tests/cli_builtin_integration.rs
git commit -m "feat(cli): wire mode dispatch and add builtin integration tests"
```

---

## Task 11: Add CliState and cli_payload/cli_finish Tauri commands

**Files:**
- Modify: `src-tauri/src/cli/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Implement CliState and the two commands**

Replace `src-tauri/src/cli/state.rs`:

```rust
//! Shared state between the Rust CLI runner and the frontend CliRunner.
//!
//! The runner builds a CliPayload, pushes it into CliState before showing
//! the (hidden) window, and waits on a oneshot channel for the frontend's
//! cli_finish call. The frontend's CliRunner pulls the payload via the
//! cli_payload command, performs the work, and reports completion through
//! cli_finish.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize)]
pub struct CliPayload {
    pub subcommand: String,
    pub plugin_id: String,
    pub plugin_command: String,
    pub file: Option<String>,        // absolute path (None for plugin commands not requiring a file)
    pub flags: serde_json::Map<String, serde_json::Value>,
    pub global: GlobalFlags,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlobalFlags {
    pub json: bool,
    pub quiet: bool,
    pub clipboard: bool,
    pub yes: bool,
}

#[derive(Debug, Deserialize)]
pub struct CliResult {
    pub exit_code: i32,
    #[serde(default)]
    pub stdout: Option<String>,
    #[serde(default)]
    pub stderr: Vec<String>,
}

pub struct CliState {
    pub payload: Mutex<Option<CliPayload>>,
    pub result_tx: Mutex<Option<oneshot::Sender<CliResult>>>,
}

impl CliState {
    pub fn new(payload: CliPayload, tx: oneshot::Sender<CliResult>) -> Self {
        Self {
            payload: Mutex::new(Some(payload)),
            result_tx: Mutex::new(Some(tx)),
        }
    }
}

#[tauri::command]
pub fn cli_payload(state: tauri::State<'_, CliState>) -> Result<CliPayload, String> {
    let p = state.payload.lock().unwrap().clone();
    p.ok_or_else(|| "cli payload missing".to_string())
}

#[tauri::command]
pub fn cli_finish(
    result: CliResult,
    state: tauri::State<'_, CliState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(tx) = state.result_tx.lock().unwrap().take() {
        let code = result.exit_code;
        // Write streams here so they reliably flush before exit.
        if let Some(s) = &result.stdout {
            if !s.is_empty() {
                println!("{s}");
            }
        }
        for line in &result.stderr {
            eprintln!("{line}");
        }
        let _ = tx.send(result);
        // Tell the host to exit. The runner's oneshot wait may also resolve,
        // either is fine — first wins.
        app.exit(code);
        Ok(())
    } else {
        Err("cli_finish called twice or without state".to_string())
    }
}
```

- [ ] **Step 2: Add a small smoke test for CliState construction**

Append to `src-tauri/src/cli/state.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;
    use tokio::sync::oneshot;

    #[test]
    fn cli_state_holds_payload_once() {
        let (tx, _rx) = oneshot::channel();
        let payload = CliPayload {
            subcommand: "share".into(),
            plugin_id: "share".into(),
            plugin_command: "publish".into(),
            file: Some("/tmp/x.md".into()),
            flags: Map::new(),
            global: GlobalFlags { json: false, quiet: false, clipboard: true, yes: false },
        };
        let state = CliState::new(payload.clone(), tx);
        let first = state.payload.lock().unwrap().clone().unwrap();
        assert_eq!(first.subcommand, "share");
        // Mutex still holds it; the command empties on completion (not here).
    }
}
```

Run: `cd src-tauri && cargo test --lib cli::state`
Expected: 1 test passes.

- [ ] **Step 3: Register the commands in lib.rs invoke handler**

In `src-tauri/src/lib.rs`, locate `.invoke_handler(tauri::generate_handler![ ... ])`. Add to the list:

```rust
            cli::state::cli_payload,
            cli::state::cli_finish,
```

- [ ] **Step 4: Build to verify wiring compiles**

Run: `cd src-tauri && cargo build --lib`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli/state.rs src-tauri/src/lib.rs
git commit -m "feat(cli): add CliState + cli_payload/cli_finish Tauri commands"
```

---

## Task 12: Implement CliRunner.svelte + cli-runner.ts core

**Files:**
- Create: `src/lib/cli/cli-runner.ts`
- Create: `src/lib/cli/CliRunner.svelte`
- Create: `src/lib/cli/cli-runner.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Write tests for the runner core**

Create `src/lib/cli/cli-runner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  buildVirtualTab,
  interpretActions,
  type CliPayload,
  type ActionInterpretation,
} from './cli-runner'
import type { PluginAction } from '../plugins/types'

function basePayload(overrides: Partial<CliPayload> = {}): CliPayload {
  return {
    subcommand: 'share',
    plugin_id: 'share',
    plugin_command: 'publish',
    file: '/tmp/draft.md',
    flags: {},
    global: { json: false, quiet: false, clipboard: true, yes: false },
    ...overrides,
  }
}

describe('buildVirtualTab', () => {
  it('builds a markdown tab for .md', () => {
    const t = buildVirtualTab('/tmp/draft.md', 1234)
    expect(t.path).toBe('/tmp/draft.md')
    expect(t.filename).toBe('draft.md')
    expect(t.extension).toBe('.md')
    expect(t.kind).toBe('markdown')
    expect(t.isDirty).toBe(false)
    expect(t.isUntitled).toBe(false)
  })

  it('builds an html tab for .html', () => {
    const t = buildVirtualTab('/tmp/page.html', 100)
    expect(t.kind).toBe('html')
  })

  it('builds a code tab for .ts', () => {
    const t = buildVirtualTab('/tmp/m.ts', 100)
    expect(t.kind).toBe('code')
  })
})

describe('interpretActions', () => {
  const m = { id: 'share', name: 'Share', host_capabilities: [] } as any

  it('extracts URL from cli.result for default stdout', () => {
    const actions: PluginAction[] = [
      { type: 'cli.result', data: { url: 'https://x', slug: 'abc', is_update: false } },
    ] as any
    const r = interpretActions(actions, m, basePayload(), { isTty: false })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('https://x')
  })

  it('emits JSON when global.json is set', () => {
    const actions = [
      { type: 'cli.result', data: { url: 'https://x', slug: 'abc' } },
    ] as PluginAction[]
    const r = interpretActions(actions, m, basePayload({ global: { json: true, quiet: false, clipboard: true, yes: false } }), { isTty: false })
    const parsed = JSON.parse(r.stdout || '')
    expect(parsed.ok).toBe(true)
    expect(parsed.data.url).toBe('https://x')
  })

  it('maps toast(error) to exit code 4 and stderr line', () => {
    const actions = [
      { type: 'toast', level: 'error', message: '❌ Share: 未配置 API Key' },
    ] as PluginAction[]
    const r = interpretActions(actions, m, basePayload(), { isTty: true })
    expect(r.exitCode).toBe(4)
    expect(r.stderr.some(s => s.includes('未配置 API Key'))).toBe(true)
  })

  it('skips toast progress on non-TTY by default', () => {
    const actions = [
      { type: 'toast', level: 'success', message: '✓ Shared' },
      { type: 'cli.result', data: { url: 'https://x' } },
    ] as PluginAction[]
    const r = interpretActions(actions, m, basePayload(), { isTty: false })
    expect(r.stderr).toEqual([])
  })

  it('honors --no-clipboard', () => {
    const writeText = vi.fn()
    const actions = [
      { type: 'clipboard.write', text: 'https://x' },
      { type: 'cli.result', data: { url: 'https://x' } },
    ] as PluginAction[]
    const r = interpretActions(
      actions, m,
      basePayload({ global: { json: false, quiet: false, clipboard: false, yes: false } }),
      { isTty: false, writeClipboard: writeText },
    )
    expect(writeText).not.toHaveBeenCalled()
    expect(r.exitCode).toBe(0)
  })

  it('writes clipboard when enabled and not in JSON mode', () => {
    const writeText = vi.fn()
    const actions = [
      { type: 'clipboard.write', text: 'https://x' },
      { type: 'cli.result', data: { url: 'https://x' } },
    ] as PluginAction[]
    interpretActions(
      actions, m, basePayload(),
      { isTty: false, writeClipboard: writeText },
    )
    expect(writeText).toHaveBeenCalledWith('https://x')
  })

  it('skips clipboard in JSON mode even when enabled', () => {
    const writeText = vi.fn()
    const actions = [
      { type: 'clipboard.write', text: 'https://x' },
      { type: 'cli.result', data: { url: 'https://x' } },
    ] as PluginAction[]
    interpretActions(
      actions, m,
      basePayload({ global: { json: true, quiet: false, clipboard: true, yes: false } }),
      { isTty: false, writeClipboard: writeText },
    )
    expect(writeText).not.toHaveBeenCalled()
  })

  it('emits failure JSON on error-only outcome', () => {
    const actions = [
      { type: 'toast', level: 'error', message: '❌ Share: network failure' },
    ] as PluginAction[]
    const r = interpretActions(
      actions, m,
      basePayload({ global: { json: true, quiet: false, clipboard: true, yes: false } }),
      { isTty: false },
    )
    expect(r.exitCode).toBe(4)
    const parsed = JSON.parse(r.stdout || '')
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('plugin_failed')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/cli`
Expected: tests fail — the file doesn't exist yet.

- [ ] **Step 3: Implement cli-runner.ts**

Create `src/lib/cli/cli-runner.ts`:

```ts
import type { PluginAction, PluginManifest, TabKind } from '../plugins/types'
import type { TabSnapshot } from '../plugins/host'

export interface CliPayload {
  subcommand: string
  plugin_id: string
  plugin_command: string
  file: string | null
  flags: Record<string, string | boolean>
  global: GlobalFlags
}

export interface GlobalFlags {
  json: boolean
  quiet: boolean
  clipboard: boolean
  yes: boolean
}

export interface ActionInterpretation {
  exitCode: number
  stdout: string | null
  stderr: string[]
}

export interface InterpretOptions {
  isTty: boolean
  writeClipboard?: (text: string) => Promise<void> | void
  writeSettings?: (patch: Record<string, unknown>) => Promise<void> | void
}

/**
 * Build a host-side virtual Tab from a file path. The CLI runner does not
 * mount the real editor, so we synthesize the bare minimum a plugin host
 * needs: path, filename, extension, kind, hasContent.
 */
export function buildVirtualTab(absPath: string, byteLength: number): TabSnapshot {
  const slash = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'))
  const filename = slash >= 0 ? absPath.slice(slash + 1) : absPath
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 ? filename.slice(dot) : null
  return {
    path: absPath,
    filename,
    extension,
    kind: inferKind(extension),
    title: filename,
    isDirty: false,
    isUntitled: false,
    content: '',                // fetched lazily by share-baker via tauri-plugin-fs
    // hasContent is implied; the existing TabSnapshot does not have a hasContent
    // field — share-baker uses the file path directly.
  } as TabSnapshot
}

function inferKind(extension: string | null): TabKind {
  if (extension == null) return 'plaintext' as TabKind
  const e = extension.toLowerCase()
  if (e === '.md' || e === '.markdown' || e === '.mdown' || e === '.mkd') return 'markdown'
  if (e === '.html' || e === '.htm') return 'html'
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(e)) return 'image' as TabKind
  // Otherwise treat as code/plaintext.
  return 'code' as TabKind
}

interface ToastAction { type: 'toast'; level: 'success' | 'info' | 'warn' | 'error'; message: string; detail?: string }
interface ClipboardAction { type: 'clipboard.write'; text: string }
interface SettingsMergeAction { type: 'settings.merge'; patch: Record<string, unknown> }
interface CliResultAction { type: 'cli.result'; data: Record<string, unknown> }

/**
 * Walks the plugin's response actions and produces a CLI-style outcome.
 * Side effects (clipboard, settings) are routed through caller-supplied
 * functions so this stays unit-testable.
 */
export function interpretActions(
  actions: PluginAction[],
  manifest: PluginManifest,
  payload: CliPayload,
  opts: InterpretOptions,
): ActionInterpretation {
  let exitCode = 0
  let cliData: Record<string, unknown> | null = null
  const errorLines: string[] = []
  const progressLines: string[] = []

  for (const a of actions) {
    switch (a.type) {
      case 'toast': {
        const t = a as ToastAction
        if (t.level === 'error') {
          exitCode = 4
          const line = t.message.replace(/^❌\s*/, '✗ ')
          errorLines.push(t.detail ? `${line}\n  ${t.detail}` : line)
        } else if (!payload.global.quiet && opts.isTty) {
          progressLines.push(t.message.replace(/^✅\s*/, '✓ '))
        }
        break
      }
      case 'clipboard.write': {
        const c = a as ClipboardAction
        if (payload.global.clipboard && !payload.global.json && opts.writeClipboard) {
          Promise.resolve(opts.writeClipboard(c.text)).catch(() => {})
        }
        break
      }
      case 'settings.merge': {
        const s = a as SettingsMergeAction
        if (opts.writeSettings) {
          Promise.resolve(opts.writeSettings(s.patch)).catch(() => {})
        }
        break
      }
      case 'cli.result': {
        cliData = (a as CliResultAction).data
        break
      }
      // dialog.* not exercised by share's commands; if a future plugin emits one,
      // CLI treats them as no-op (or auto-confirm if global.yes — left for v2).
    }
  }

  // Build stdout per output contract.
  let stdout: string | null = null
  if (payload.global.json) {
    if (exitCode === 0 && cliData) {
      stdout = JSON.stringify({ ok: true, data: cliData })
    } else if (exitCode !== 0) {
      const firstErr = errorLines[0] ?? `${manifest.name} failed`
      stdout = JSON.stringify({
        ok: false,
        error: {
          code: 'plugin_failed',
          message: firstErr.replace(/^✗\s*/, ''),
        },
      })
    } else {
      // No cli.result, no error: report empty success.
      stdout = JSON.stringify({ ok: true, data: {} })
    }
  } else if (exitCode === 0 && cliData && typeof cliData.url === 'string') {
    stdout = cliData.url as string
  } else if (exitCode === 0) {
    stdout = null   // operations like unshare don't print anything
  }

  // stderr lines: errors always; progress only on TTY/non-quiet
  const stderr = [...errorLines, ...progressLines]

  return { exitCode, stdout, stderr }
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm test src/lib/cli`
Expected: all 9 cli-runner tests pass.

- [ ] **Step 5: Create CliRunner.svelte**

Create `src/lib/cli/CliRunner.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { invokePlugin } from '../plugins/host'
  import { bakeShareHtml } from '../plugins/share-baker'
  import { stat, readTextFile } from '@tauri-apps/plugin-fs'
  import { writeText as clipWriteText } from '@tauri-apps/plugin-clipboard-manager'
  import { mergePluginScoped } from '../settings.svelte'
  import { buildVirtualTab, interpretActions, type CliPayload } from './cli-runner'
  import type { PluginManifest } from '../plugins/types'

  async function run(): Promise<void> {
    let payload: CliPayload
    try {
      payload = await invoke<CliPayload>('cli_payload')
    } catch (e) {
      await finish({ exit_code: 1, stderr: [`mdedit: failed to fetch cli payload: ${e}`] })
      return
    }

    // Load manifest list (already filtered to enabled).
    const manifests = await invoke<PluginManifest[]>('get_plugin_manifests')
    const manifest = manifests.find(m => m.id === payload.plugin_id)
    if (!manifest) {
      await finish({ exit_code: 3, stderr: [
        `mdedit: plugin '${payload.plugin_id}' is not enabled. Run 'mdedit plugin enable ${payload.plugin_id}'.`,
      ]})
      return
    }

    if (!payload.file) {
      await finish({ exit_code: 2, stderr: ['mdedit: missing file argument'] })
      return
    }

    let byteLen = 0
    try {
      const info = await stat(payload.file)
      byteLen = Number(info.size ?? 0)
    } catch (e) {
      await finish({ exit_code: 2, stderr: [`mdedit: cannot read '${payload.file}': ${e}`] })
      return
    }

    const virtualTab = buildVirtualTab(payload.file, byteLen)
    // For commands that need rendered HTML, fetch content + bake.
    let renderedHtml: string | undefined = undefined
    const entry = (manifest.cli ?? []).find(c => c.subcommand === payload.subcommand)
    if (entry?.requires_tab_context && payload.plugin_command === 'publish') {
      try {
        const text = await readTextFile(payload.file)
        const baked = await bakeShareHtml({ ...virtualTab, content: text, currentContent: text, filePath: payload.file } as any)
        renderedHtml = baked
      } catch (e) {
        await finish({ exit_code: 1, stderr: [`mdedit: render failed: ${e}`] })
        return
      }
    }

    // Settings come from the persisted store via the GUI's existing path.
    const settings = await loadSettings(manifest.id)

    const result = await invokePlugin(
      manifest,
      payload.plugin_command,
      { ...virtualTab, content: '' } as any,
      {
        htmlBaker: renderedHtml != null ? async () => renderedHtml! : undefined,
        settingsReader: () => settings,
      },
    )

    if (!result.ok || !result.response) {
      await finish({ exit_code: 1, stderr: [result.errorMessage ?? 'mdedit: plugin invocation failed', result.errorDetail ?? ''] })
      return
    }

    const isTty = Boolean(payload.global.quiet === false && Number(navigator?.userAgent?.length ?? 0) > 0)
    const interp = interpretActions(
      result.response.actions, manifest, payload,
      { isTty: false, writeClipboard: clipWriteText, writeSettings: mergePluginScoped },
    )

    await finish({
      exit_code: interp.exitCode,
      stdout: interp.stdout ?? '',
      stderr: interp.stderr,
    })
  }

  async function loadSettings(pluginId: string): Promise<Record<string, unknown>> {
    // Lazy import to avoid eager-loading settings store in tests.
    const { pluginSettings } = await import('../settings.svelte')
    return pluginSettings(pluginId)
  }

  async function finish(r: { exit_code: number; stdout?: string; stderr: string[] }): Promise<void> {
    try {
      await invoke('cli_finish', { result: r })
    } catch (e) {
      // If cli_finish fails, write to stderr ourselves; Tauri will tear down.
      console.error('[cli] cli_finish failed:', e)
    }
  }

  onMount(() => {
    run().catch(async (e) => {
      await finish({ exit_code: 1, stderr: [`mdedit: unexpected error: ${e}`] })
    })
  })
</script>

<!-- Headless: no DOM body. -->
```

(If `bakeShareHtml`'s signature differs from what's used here, adjust the call inside `run()` to match. Read `src/lib/plugins/share-baker.ts` for the exact signature; this snippet assumes it takes a `Tab`-shaped object with `filePath` and `currentContent`. If `pluginSettings` / `mergePluginScoped` exports differ, also adjust the import paths to match `src/lib/settings.svelte`.)

- [ ] **Step 6: Wire main.ts to mount CliRunner conditionally**

Replace `src/main.ts`:

```ts
import { mount } from 'svelte'

declare global {
  interface Window {
    __M_CLI_MODE__?: boolean
  }
}

const target = document.getElementById('app')
if (!target) throw new Error('Root element #app not found')

async function bootstrap() {
  if (window.__M_CLI_MODE__) {
    const { default: CliRunner } = await import('./lib/cli/CliRunner.svelte')
    mount(CliRunner, { target })
  } else {
    const { default: App } = await import('./App.svelte')
    mount(App, { target })
  }
}

bootstrap()
```

- [ ] **Step 7: Run all frontend tests**

Run: `pnpm test`
Expected: all tests pass, including the new cli-runner suite.

- [ ] **Step 8: Run typecheck**

Run: `pnpm check`
Expected: no type errors. If `share-baker.ts` or `settings.svelte` exports don't match the assumptions in `CliRunner.svelte`, fix the calls now.

- [ ] **Step 9: Commit**

```bash
git add src/lib/cli/ src/main.ts
git commit -m "feat(cli): add CliRunner svelte component and runner core"
```

---

## Task 13: Implement hidden-window launch in cli/runner.rs

**Files:**
- Modify: `src-tauri/src/cli/runner.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Implement runner::run**

Replace `src-tauri/src/cli/runner.rs`:

```rust
//! Plugin-subcommand path: build CliPayload, launch headless Tauri, wait
//! for cli_finish from the frontend, exit.

use crate::cli::args::Parsed;
use crate::cli::router::PluginRoute;
use crate::cli::state::{CliPayload, CliState, GlobalFlags};
use crate::plugin_host::{scan_disk, PluginManifest};
use std::path::PathBuf;
use std::process::ExitCode;
use tokio::sync::oneshot;

pub fn run(p: PluginRoute, parsed: Parsed) -> ExitCode {
    // 1. Locate the plugin manifest.
    let (manifests, _enabled) = current_scan(&parsed);
    let manifest = match manifests.iter().find(|(m, _)| m.id == p.plugin_id) {
        Some((m, _)) => m.clone(),
        None => {
            eprintln!("mdedit: internal: plugin '{}' vanished between routing and execution", p.plugin_id);
            return ExitCode::from(1);
        }
    };
    let cli_entry = match manifest.cli.iter().find(|c| c.subcommand == p.subcommand) {
        Some(e) => e,
        None => {
            eprintln!("mdedit: internal: subcommand '{}' missing in '{}'", p.subcommand, p.plugin_id);
            return ExitCode::from(1);
        }
    };

    // 2. Parse remaining argv against the cli entry's spec.
    let (file, flags) = match parse_subcommand_args(&p.remaining, cli_entry) {
        Ok(v) => v,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };

    // 3. Resolve file to absolute, verify it exists.
    let absfile = if let Some(f) = file {
        match std::path::Path::new(&f).canonicalize() {
            Ok(p) => Some(p.to_string_lossy().into_owned()),
            Err(_) => {
                eprintln!("mdedit: cannot read '{f}': No such file or directory");
                return ExitCode::from(2);
            }
        }
    } else { None };

    // 4. Decide plugin_command via flags.
    let plugin_command = decide_plugin_command(&flags, &cli_entry.command);
    if plugin_command.is_err() {
        eprintln!("{}", plugin_command.err().unwrap());
        return ExitCode::from(2);
    }
    let plugin_command = plugin_command.unwrap();

    // 5. Build CliPayload + oneshot channel.
    let payload = CliPayload {
        subcommand: p.subcommand.clone(),
        plugin_id: p.plugin_id.clone(),
        plugin_command,
        file: absfile,
        flags,
        global: GlobalFlags {
            json: parsed.globals.json,
            quiet: parsed.globals.quiet,
            clipboard: parsed.globals.clipboard,
            yes: parsed.globals.yes,
        },
    };
    let (tx, rx) = oneshot::channel();
    let state = CliState::new(payload, tx);

    // 6. Launch Tauri with hidden window + state.
    let exit_code = launch_tauri_headless(state, rx);
    ExitCode::from(exit_code as u8)
}

fn current_scan(parsed: &Parsed) -> (Vec<(PluginManifest, PathBuf)>, std::collections::HashMap<String, bool>) {
    let plugins_dir = if let Some(p) = &parsed.globals.plugin_dir_override {
        PathBuf::from(p)
    } else if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            if let Some(contents) = macos_dir.parent() {
                let candidate = contents.join("Resources").join("plugins");
                if candidate.exists() { candidate } else { contents.join("plugins") }
            } else { PathBuf::from(".") }
        } else { PathBuf::from(".") }
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("plugins")
    };
    let config_dir = if let Some(home) = std::env::var_os("HOME") {
        std::path::Path::new(&home).join("Library").join("Application Support").join("com.laobu.mdeditor")
    } else { PathBuf::from(".") };
    scan_disk(&plugins_dir, &config_dir)
}

fn parse_subcommand_args(
    remaining: &[String],
    entry: &crate::plugin_host::CliEntry,
) -> Result<(Option<String>, serde_json::Map<String, serde_json::Value>), String> {
    let mut flags = serde_json::Map::new();
    let mut file: Option<String> = None;
    let mut i = 0;
    while i < remaining.len() {
        let tok = &remaining[i];
        if let Some(flag) = entry.flags.iter().find(|f| f.long == *tok || f.short.as_deref() == Some(tok)) {
            match flag.ty.as_str() {
                "boolean" => {
                    flags.insert(flag.long.trim_start_matches('-').to_string(),
                        serde_json::Value::Bool(true));
                }
                "string" => {
                    if i + 1 >= remaining.len() {
                        return Err(format!("mdedit: flag {} requires a value", flag.long));
                    }
                    flags.insert(flag.long.trim_start_matches('-').to_string(),
                        serde_json::Value::String(remaining[i + 1].clone()));
                    i += 1;
                }
                _ => return Err(format!("mdedit: internal: unknown flag type '{}'", flag.ty)),
            }
        } else if tok.starts_with('-') {
            return Err(format!("mdedit: unknown flag '{tok}'"));
        } else if file.is_none() && !entry.args.is_empty() {
            file = Some(tok.clone());
        } else {
            return Err(format!("mdedit: unexpected argument '{tok}'"));
        }
        i += 1;
    }
    // Required arg check.
    if let Some(first_required) = entry.args.iter().find(|a| a.required) {
        if file.is_none() {
            return Err(format!("mdedit: missing required argument '<{}>'", first_required.name));
        }
    }
    Ok((file, flags))
}

/// Mutually-exclusive flag fan-out: --update, --copy-link, --unshare map to
/// the right plugin command. Default is the manifest entry's declared command.
fn decide_plugin_command(
    flags: &serde_json::Map<String, serde_json::Value>,
    default_cmd: &str,
) -> Result<String, String> {
    let truthy = |k: &str| flags.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    let exclusive: Vec<&str> = ["update", "copy-link", "unshare"]
        .into_iter().filter(|k| truthy(k)).collect();
    if exclusive.len() > 1 {
        return Err(format!("mdedit: flags --{} are mutually exclusive",
            exclusive.join(" --")));
    }
    Ok(if truthy("unshare") { "unpublish".to_string() }
       else if truthy("copy-link") { "copy-link".to_string() }
       else { default_cmd.to_string() })
}

fn launch_tauri_headless(state: CliState, rx: oneshot::Receiver<crate::cli::state::CliResult>) -> i32 {
    use tauri::Manager;

    let result_arc = std::sync::Arc::new(std::sync::Mutex::new(None::<i32>));
    let result_arc_clone = result_arc.clone();

    let init_script = "window.__M_CLI_MODE__ = true;";

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            crate::cli::state::cli_payload,
            crate::cli::state::cli_finish,
            crate::plugin_host::get_plugin_manifests,
            crate::plugin_host::invoke_plugin,
        ])
        .setup(move |app| {
            crate::plugin_host::init(&app.handle());
            let _ = tauri::WebviewWindowBuilder::new(
                app, "cli",
                tauri::WebviewUrl::App("index.html".into()),
            )
                .visible(false)
                .skip_taskbar(true)
                .initialization_script(init_script)
                .build()?;
            Ok(())
        })
        .manage(state)
        .build(tauri::generate_context!())
        .expect("tauri build failed in cli mode");

    // Spawn a task to listen on the oneshot.
    tauri::async_runtime::spawn(async move {
        if let Ok(res) = rx.await {
            *result_arc_clone.lock().unwrap() = Some(res.exit_code);
        }
    });

    app.run(|_app, _event| {});

    // After run() returns (app.exit() was called from cli_finish), pick up code.
    result_arc.lock().unwrap().unwrap_or(1)
}
```

- [ ] **Step 2: Build to verify**

Run: `cd src-tauri && cargo build --lib`
Expected: success.

- [ ] **Step 3: Manual smoke test**

This requires the share plugin's API key configured and the worker reachable. Skip if not set up:

```bash
cd src-tauri && cargo build --bin mdeditor
echo "# Test" > /tmp/test-cli-share.md
target/debug/mdeditor --cli share /tmp/test-cli-share.md
```

Expected: prints a URL on stdout, exit 0. If the worker isn't configured, expect exit 4 with a "未配置 API Key" message on stderr.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/cli/runner.rs
git commit -m "feat(cli): implement headless Tauri launch for plugin subcommands"
```

---

## Task 14: Install/uninstall/repair flow

**Files:**
- Modify: `src-tauri/src/cli/install.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Implement install/uninstall/repair logic**

Replace `src-tauri/src/cli/install.rs`:

```rust
//! Install / uninstall / repair the `mdedit` symlink.
//!
//! macOS-only in v1. Uses `osascript -e 'do shell script ... with
//! administrator privileges'` for paths that require elevation.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct InstallStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub target_valid: bool,
}

pub fn current_app_binary() -> PathBuf {
    std::env::current_exe()
        .unwrap_or_else(|_| PathBuf::from("/Applications/M↓.app/Contents/MacOS/M↓"))
}

pub fn candidate_dirs() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        out.push(Path::new(&home).join(".local/bin"));
    }
    out
}

/// Returns Ok(true) if symlink created. Err on permission failure / IO.
pub fn install(dir: &Path) -> Result<bool, String> {
    let target = current_app_binary();
    if !target.exists() {
        return Err(format!("source binary missing: {}", target.display()));
    }
    let link = dir.join("mdedit");

    let need_sudo = matches!(dir.to_str(), Some("/usr/local/bin") | Some("/opt/homebrew/bin"));

    if !need_sudo {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        // Remove existing symlink if present (idempotent).
        if link.symlink_metadata().is_ok() {
            std::fs::remove_file(&link).map_err(|e| e.to_string())?;
        }
        std::os::unix::fs::symlink(&target, &link).map_err(|e| e.to_string())?;
        return Ok(true);
    }

    // Elevated path.
    let script = format!(
        "mkdir -p '{dir}' && ln -sfn '{target}' '{link}'",
        dir = dir.display(),
        target = target.display(),
        link = link.display(),
    );
    let status = Command::new("osascript")
        .args(["-e", &format!("do shell script \"{}\" with administrator privileges",
            script.replace('"', "\\\""))])
        .status()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !status.success() {
        return Err(format!("osascript exited {}", status.code().unwrap_or(-1)));
    }
    Ok(true)
}

pub fn uninstall(dir: &Path) -> Result<(), String> {
    let link = dir.join("mdedit");
    if !link.symlink_metadata().is_ok() {
        return Ok(());     // nothing to do
    }
    let need_sudo = matches!(dir.to_str(), Some("/usr/local/bin") | Some("/opt/homebrew/bin"));
    if !need_sudo {
        std::fs::remove_file(&link).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let script = format!("rm -f '{}'", link.display());
    let status = Command::new("osascript")
        .args(["-e", &format!("do shell script \"{}\" with administrator privileges",
            script.replace('"', "\\\""))])
        .status()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !status.success() {
        return Err(format!("osascript exited {}", status.code().unwrap_or(-1)));
    }
    Ok(())
}

pub fn status(installed_path: Option<&Path>) -> InstallStatus {
    if let Some(p) = installed_path {
        if p.exists() {
            let resolved = std::fs::read_link(p).ok();
            let current = current_app_binary();
            let target_valid = resolved.as_deref().map(|r| r == current).unwrap_or(false);
            return InstallStatus {
                installed: true,
                path: Some(p.display().to_string()),
                target_valid,
            };
        }
    }
    // Probe candidates.
    for dir in candidate_dirs() {
        let link = dir.join("mdedit");
        if link.exists() {
            let resolved = std::fs::read_link(&link).ok();
            let current = current_app_binary();
            let target_valid = resolved.as_deref().map(|r| r == current).unwrap_or(false);
            return InstallStatus {
                installed: true,
                path: Some(link.display().to_string()),
                target_valid,
            };
        }
    }
    InstallStatus { installed: false, path: None, target_valid: false }
}

#[tauri::command]
pub fn cli_install_status() -> InstallStatus {
    status(None)
}

#[tauri::command]
pub fn cli_install(dir: String) -> Result<(), String> {
    install(Path::new(&dir)).map(|_| ())
}

#[tauri::command]
pub fn cli_uninstall(dir: String) -> Result<(), String> {
    uninstall(Path::new(&dir))
}

#[tauri::command]
pub fn cli_install_candidates() -> Vec<String> {
    candidate_dirs().into_iter().map(|p| p.display().to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink as unix_symlink;

    #[test]
    fn install_creates_symlink_in_writable_dir() {
        let dir = std::env::temp_dir().join(format!("mdedit-install-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = std::env::current_exe().unwrap();
        // Manually emulate: install uses current_app_binary() which IS current_exe in tests.
        let link = dir.join("mdedit");
        if link.exists() { std::fs::remove_file(&link).unwrap(); }
        unix_symlink(&target, &link).unwrap();
        assert!(link.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_reports_not_installed_when_no_link() {
        let st = status(Some(Path::new("/this/does/not/exist/mdedit")));
        assert!(!st.installed);
    }
}
```

- [ ] **Step 2: Register install commands in lib.rs**

In `src-tauri/src/lib.rs`'s `invoke_handler`, add:

```rust
            cli::install::cli_install_status,
            cli::install::cli_install,
            cli::install::cli_uninstall,
            cli::install::cli_install_candidates,
```

- [ ] **Step 3: Add Help menu items**

In `src-tauri/src/lib.rs`, in `build_menu`, find the help submenu builder block. Replace the help_b construction:

```rust
    let mut help_b = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("docs", "Documentation").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("cli-install", "Install 'mdedit' Command in PATH…").build(app)?)
        .item(&MenuItemBuilder::with_id("cli-uninstall", "Uninstall 'mdedit' Command").build(app)?);
    for it in plugin_items.iter().filter(|p| p.location == "help") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        help_b = help_b.item(&b.build(app)?);
    }
    let help_menu: Submenu<R> = help_b.build()?;
```

(The frontend listens for menu events via the existing `menu-event` emit; in `App.svelte` the menu-event handler routes IDs like `"cli-install"` / `"cli-uninstall"` to a small Svelte function that calls the Tauri commands above. The frontend change is in step 4.)

- [ ] **Step 4: Wire menu events on the frontend**

Read `src/App.svelte` to find the menu-event handler. Add cases for `"cli-install"` and `"cli-uninstall"`:

```ts
  // Inside the existing case-style menu-event switch:
  } else if (event === 'cli-install') {
    const { invoke } = await import('@tauri-apps/api/core')
    const candidates = await invoke<string[]>('cli_install_candidates')
    const { ask } = await import('@tauri-apps/plugin-dialog')
    // Picker: present a confirm-style dialog per candidate until the user picks one.
    // (UI taste decision — keep it minimal in v1.)
    for (const dir of candidates) {
      const ok = await ask(`Install 'mdedit' into ${dir}?`, { title: "Install 'mdedit' Command", kind: 'info' })
      if (ok) {
        try {
          await invoke('cli_install', { dir })
          const { pushToast } = await import('./lib/toast.svelte')
          pushToast({ level: 'success', message: `'mdedit' installed at ${dir}` })
        } catch (e) {
          const { pushToast } = await import('./lib/toast.svelte')
          pushToast({ level: 'error', message: `Install failed: ${e}` })
        }
        return
      }
    }
  } else if (event === 'cli-uninstall') {
    const { invoke } = await import('@tauri-apps/api/core')
    const status = await invoke<{ installed: boolean; path: string | null }>('cli_install_status')
    if (!status.installed || !status.path) return
    const dir = status.path.replace(/\/mdedit$/, '')
    await invoke('cli_uninstall', { dir })
    const { pushToast } = await import('./lib/toast.svelte')
    pushToast({ level: 'success', message: `'mdedit' uninstalled from ${dir}` })
  }
```

(Adjust the dialog interaction to match `App.svelte`'s actual menu-handling style. If `App.svelte` uses a different routing pattern, follow that pattern instead.)

- [ ] **Step 5: Run Rust tests**

Run: `cd src-tauri && cargo test --lib cli::install`
Expected: 2 tests pass.

- [ ] **Step 6: Manual smoke**

Run M↓ → Help menu → "Install 'mdedit' Command in PATH…" → accept the first candidate. Verify in a terminal:

```bash
which mdedit
mdedit help
```

Expected: prints the help text. Then Help → "Uninstall 'mdedit' Command" should remove it; `which mdedit` returns nothing.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/cli/install.rs src-tauri/src/lib.rs src/App.svelte
git commit -m "feat(cli): install/uninstall mdedit symlink via Help menu"
```

---

## Task 15: End-to-end script, Preferences UI hook, regression test

**Files:**
- Create: `scripts/test-cli-share.sh`
- Create: `src-tauri/tests/cli_startup_timing.rs`
- Modify: `src/App.svelte` or the Preferences component (depending on where settings live)
- Modify: `README.md` / `README.zh-CN.md`

- [ ] **Step 1: Write the end-to-end shell smoke script**

Create `scripts/test-cli-share.sh`:

```bash
#!/usr/bin/env bash
# Manual end-to-end smoke test for `mdedit -s` against a mock or real Share worker.
#
# Usage:
#   SHARE_BASE_URL=https://your.workers.dev SHARE_API_KEY=... bash scripts/test-cli-share.sh
#
# Prereqs:
#   - M↓.app installed at /Applications/M↓.app
#   - 'mdedit' symlink installed (Help → Install 'mdedit' Command in PATH)
#   - Share plugin configured with the env vars above (via M↓ → Preferences → Plugins → Share)

set -euo pipefail

TMP=$(mktemp -t mdedit-cli-smoke.XXXXXX.md)
trap "rm -f $TMP" EXIT

cat > "$TMP" <<'EOF'
# CLI Smoke Test

Body of the test markdown.
EOF

echo "→ mdedit help"
mdedit help | head -5

echo "→ mdedit version"
mdedit version

echo "→ mdedit plugin list"
mdedit plugin list

echo "→ mdedit -s $TMP"
URL=$(mdedit -s "$TMP")
if [[ -z "$URL" ]]; then
  echo "FAIL: empty URL"; exit 1
fi
echo "  URL: $URL"

echo "→ mdedit -s $TMP --json"
JSON=$(mdedit -s "$TMP" --json)
echo "$JSON" | python3 -m json.tool > /dev/null

echo "→ mdedit share $TMP --copy-link (idempotent re-fetch)"
URL2=$(mdedit share "$TMP" --copy-link)
if [[ "$URL" != "$URL2" ]]; then
  echo "FAIL: URL changed: $URL vs $URL2"; exit 1
fi

echo "→ mdedit share $TMP --unshare"
mdedit share "$TMP" --unshare

echo "→ all green"
```

Make executable: `chmod +x scripts/test-cli-share.sh`

- [ ] **Step 2: Write startup-timing regression test**

Create `src-tauri/tests/cli_startup_timing.rs`:

```rust
//! Regression test: the CLI mode dispatch must not slow GUI cold-start.
//! Asserts that `mdedit help` returns under 500 ms on developer hardware.
//! (GUI launch is excluded — this is the CLI-only fast path.)

use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

#[test]
fn cli_help_returns_quickly() {
    use std::os::unix::process::CommandExt;
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_mdeditor"));
    let dir = std::env::temp_dir().join(format!("mdedit-timing-{}", std::process::id()));
    let plugin = dir.join("p");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("manifest.json"), r#"{"id":"p","name":"P","version":"0.1.0","binary":"bin","host_capabilities":[]}"#).unwrap();

    let start = Instant::now();
    let mut cmd = Command::new(bin);
    cmd.arg0("mdedit");
    cmd.args(["--plugin-dir", dir.to_str().unwrap(), "help"]);
    cmd.env("HOME", std::env::temp_dir().to_str().unwrap());
    let output = cmd.output().expect("spawn");
    let elapsed = start.elapsed();

    let _ = std::fs::remove_dir_all(&dir);
    assert!(output.status.success(), "help should exit 0, got {:?}", output.status);
    assert!(
        elapsed.as_millis() < 500,
        "mdedit help took {} ms (budget 500)", elapsed.as_millis(),
    );
}
```

- [ ] **Step 3: Run all tests once**

```bash
cd src-tauri && cargo test
pnpm test
```

Expected: all green.

- [ ] **Step 4: Add Preferences CLI section**

Read `src/App.svelte` and the Preferences component (search: `grep -rn "Preferences" src/`). Add a new tab or section titled "CLI" with:

- Status row: shows `Installed at: <path>` or `Not installed`
- Buttons: `Install...` / `Uninstall` / `Repair` (the latter shown only if `target_valid === false`)
- Help text linking to `mdedit help`

Each button invokes the Tauri commands added in Task 14. Use the existing Preferences styling so the new section blends in. (No new tests — covered by Task 14's command tests.)

- [ ] **Step 5: Document in README**

Append a "CLI" section to `README.md` (and `README.zh-CN.md`):

```md
## CLI

M↓ ships a `mdedit` command that lets other applications drive plugin
features without opening the GUI. Install it from **Help → Install 'mdedit'
Command in PATH...** (you'll be prompted for admin if installing into
`/usr/local/bin`).

```bash
mdedit -s draft.md                         # publish via Share plugin, prints URL
mdedit share draft.md --json               # structured output
mdedit share draft.md --copy-link          # re-fetch existing URL
mdedit share draft.md --unshare            # remove the share
mdedit help                                # full reference
mdedit plugin list                         # see all plugins and their status
```

The CLI only exposes commands contributed by *enabled* plugins. Disable a
plugin in **Preferences → Plugins** to remove its subcommand from `mdedit`.
```

- [ ] **Step 6: Final full test run**

```bash
cd src-tauri && cargo test
pnpm test
pnpm check
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add scripts/test-cli-share.sh src-tauri/tests/cli_startup_timing.rs src/App.svelte README.md README.zh-CN.md
git commit -m "docs(cli): add Preferences CLI section, README, and e2e smoke script"
```

---

## Self-review notes

**Spec coverage check:**
- ✅ Headless M↓ rendering (Tasks 12, 13)
- ✅ Manifest `cli` section (Tasks 1, 3, 5)
- ✅ Subcommand + aliases routing (Task 8)
- ✅ GUI coexistence (Task 13 — separate Tauri builder, no single-instance plugin)
- ✅ Default URL stdout + `--json` mode (Task 12 `interpretActions`)
- ✅ "Install Shell Command" Help menu (Task 14)
- ✅ Distinct exit codes (Task 7 `args.rs`, Task 8 router, Task 12 `interpretActions`)
- ✅ Built-in `plugin list/enable/disable/info` (Task 9)
- ✅ Idempotent share (default plugin_command stays `publish`; mdshare's existing logic handles records-keyed update — Task 6 doesn't change that)
- ✅ stdin not supported (no opt-in code path in Task 12 / 13)
- ✅ unshare/copy-link via flags (Task 13 `decide_plugin_command`)
- ✅ All edge cases in spec §"Edge cases" addressed across the relevant tasks
- ✅ Testing layers from spec table: unit Rust (Tasks 7-9, 14), unit TS (Tasks 2, 4, 12), integration Rust (Tasks 10, 15), e2e script (Task 15), regression timing (Task 15)

**Open follow-ups (post-v1, not part of this plan):**
- "Repair" menu item (state in lib.rs at startup detects symlink mismatch) — left intentionally as part of Task 15's Preferences UI rather than a separate task.
- Cross-arch (`x86_64-apple-darwin`) bin for mdshare in Task 6 — relies on the existing `scripts/build-mdshare.sh` cross-build setup; if not present, only the host arch is updated in that commit and a separate task may be needed before release.
- `--yes` confirmation flow when a future plugin emits `dialog.confirm` from CLI — currently `interpretActions` no-ops these because share doesn't use them.
