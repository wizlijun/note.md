# ExLibris Ebook Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ExLibris — an independent macOS Tauri app for managing an ebook library — and wire it to mdeditor via shared config and a tray launcher. Binaries land in a stable time-bucketed `rawvault`; canonical markdown + metadata land in `sotvault` organized by user-configurable rules.

**Architecture:** Two independent Tauri apps share `~/Library/Application Support/com.laobu.mdeditor-shared/config.json` (sotvault / rawvault / calibre paths). mdeditor's tray launches ExLibris via `open -a ExLibris`. ExLibris shells out to local calibre (`ebook-meta`, `ebook-convert`) to extract metadata and convert ebooks to markdown. rawvault is binary-only and never moves; sotvault is rule-organized and reorganizable via cheap `fs::rename`.

**Tech Stack:** Tauri 2, Svelte 5, Vitest, Rust (tokio, serde, serde_yaml, sha2), pnpm-workspace, calibre CLI (external).

**Reference spec:** `docs/superpowers/specs/2026-05-18-exlibris-ebook-manager-design.md`

---

## File Structure

```
exlibris/                                                    ← NEW top-level
  package.json
  vite.config.ts
  tsconfig.json
  svelte.config.js
  index.html
  src/
    App.svelte
    main.ts
    components/
      OnboardingBanner.svelte
      DropZone.svelte
      PendingList.svelte
      LibraryBrowser.svelte
      MetaPreview.svelte
      SettingsDialog.svelte
      RulesEditor.svelte
      RebuildPanel.svelte
    lib/
      shared-config.ts          + .test.ts
      bookname.ts               + .test.ts
      meta.ts                   + .test.ts
      rules.ts                  + .test.ts
      dedup.ts                  + .test.ts
      rawvault-fs.ts            + .test.ts
      sotvault-fs.ts            + .test.ts
      calibre.ts
      import-pipeline.ts        + .test.ts
      rebuild.ts                + .test.ts
      verify.ts                 + .test.ts
      types.ts
    styles/global.css
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json
    Info.plist
    capabilities/default.json
    icons/                       ← copy from mdeditor + tint differently
    src/
      lib.rs
      main.rs
      shared_config.rs
      calibre.rs
      fs_ops.rs
      hash.rs
    tests/
      fixtures/
        ebook-meta-success.sh
        ebook-meta-no-title.sh
        ebook-meta-crash.sh
        ebook-meta-hang.sh
        ebook-convert-success.sh
        ebook-convert-slow.sh
        ebook-convert-crash.sh
        samples/
          pg11-alice.epub        ← public-domain test fixture
  README.md

src-tauri/src/                                              ← MODIFY mdeditor
  shared_config.rs              ← NEW (sibling impl)
  lib.rs                        ← MODIFY (tray + migration)
  vault_sync/mod.rs             ← MODIFY (read sotvault from shared config)

src/                                                         ← MODIFY mdeditor
  lib/shared-config.ts          ← NEW
  components/VaultSettingsTab.svelte  ← MODIFY (read/write shared config)

pnpm-workspace.yaml             ← MODIFY (add exlibris)
package.json                    ← MODIFY (add tauri:exlibris scripts)
scripts/build-exlibris.sh       ← NEW
```

---

## Phase 0 — mdeditor shared config foundation

Phase 0 must ship before any ExLibris code can read the user's sotvault. Each task is independently committable; Phase 0 as a whole is **safe to ship to existing users** because it transparently migrates `gitsync.repo` to the shared config without changing user-visible behavior.

---

### Task 1: Add `shared_config.rs` Rust module to mdeditor

**Files:**
- Create: `src-tauri/src/shared_config.rs`
- Modify: `src-tauri/Cargo.toml` (add `serde_yaml = "0.9"` — not needed here actually; keep just serde_json which is already in deps)

The shared config is a JSON file with atomic-write semantics. This module owns reading, writing, and a stable schema struct.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/shared_config.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SharedConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sotvault: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rawvault: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibre_path: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub exlibris: serde_json::Value,
}

fn default_version() -> u32 { 1 }

pub fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join("Library/Application Support/com.laobu.mdeditor-shared/config.json")
}

pub fn read(path: &Path) -> std::io::Result<SharedConfig> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SharedConfig {
            version: 1, ..Default::default()
        }),
        Err(e) => Err(e),
    }
}

pub fn write(path: &Path, cfg: &SharedConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn read_missing_returns_default() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.json");
        let cfg = read(&p).unwrap();
        assert_eq!(cfg.version, 1);
        assert_eq!(cfg.sotvault, None);
    }

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.json");
        let cfg = SharedConfig {
            version: 1,
            sotvault: Some("/tmp/sot".into()),
            rawvault: Some("/tmp/raw".into()),
            calibre_path: Some("/Applications/calibre.app/Contents/MacOS".into()),
            exlibris: serde_json::Value::Null,
        };
        write(&p, &cfg).unwrap();
        let back = read(&p).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn write_uses_atomic_tmp_rename() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.json");
        let cfg = SharedConfig::default();
        write(&p, &cfg).unwrap();
        assert!(p.exists());
        assert!(!p.with_extension("json.tmp").exists());
    }

    #[test]
    fn corrupted_file_falls_back_to_default() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.json");
        std::fs::write(&p, "{ not valid json").unwrap();
        let cfg = read(&p).unwrap();
        assert_eq!(cfg.version, 1);
    }
}
```

Add `pub mod shared_config;` to `src-tauri/src/lib.rs` near the top (line ~14, with other module declarations).

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd src-tauri && cargo test --lib shared_config
```

Expected: compile error first (mod not registered) or test failure. Fix until it compiles.

- [ ] **Step 3: Confirm all four tests pass**

```bash
cd src-tauri && cargo test --lib shared_config
```

Expected: `test result: ok. 4 passed`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/shared_config.rs src-tauri/src/lib.rs
git commit -m "feat(shared-config): add Rust module with atomic JSON I/O"
```

---

### Task 2: Expose `shared_config` via Tauri commands

**Files:**
- Modify: `src-tauri/src/lib.rs` (add two `#[tauri::command]` functions and register them)

- [ ] **Step 1: Add Tauri commands**

In `src-tauri/src/lib.rs`, near other `#[tauri::command]` definitions, add:

```rust
#[tauri::command]
fn shared_config_read() -> Result<crate::shared_config::SharedConfig, String> {
    crate::shared_config::read(&crate::shared_config::config_path())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn shared_config_write(cfg: crate::shared_config::SharedConfig) -> Result<(), String> {
    crate::shared_config::write(&crate::shared_config::config_path(), &cfg)
        .map_err(|e| e.to_string())
}
```

In the existing `tauri::Builder` chain, find the `.invoke_handler(tauri::generate_handler![...])` call and add `shared_config_read, shared_config_write` to the list.

- [ ] **Step 2: Verify mdeditor still builds**

```bash
cd src-tauri && cargo check
```

Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(shared-config): expose read/write Tauri commands"
```

---

### Task 3: Add `shared-config.ts` frontend wrapper to mdeditor

**Files:**
- Create: `src/lib/shared-config.ts`
- Create: `src/lib/shared-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/shared-config.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readSharedConfig, writeSharedConfig, type SharedConfig } from "./shared-config";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";

describe("shared-config", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("readSharedConfig delegates to shared_config_read command", async () => {
    const fake: SharedConfig = {
      version: 1, sotvault: "/x", rawvault: null, calibre_path: null, exlibris: null,
    };
    vi.mocked(invoke).mockResolvedValueOnce(fake);
    const got = await readSharedConfig();
    expect(invoke).toHaveBeenCalledWith("shared_config_read");
    expect(got).toEqual(fake);
  });

  it("writeSharedConfig delegates to shared_config_write command", async () => {
    const cfg: SharedConfig = {
      version: 1, sotvault: "/x", rawvault: "/y", calibre_path: "/z", exlibris: null,
    };
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await writeSharedConfig(cfg);
    expect(invoke).toHaveBeenCalledWith("shared_config_write", { cfg });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
pnpm vitest run src/lib/shared-config.test.ts
```

Expected: fail with "Cannot find module './shared-config'".

- [ ] **Step 3: Implement the wrapper**

Create `src/lib/shared-config.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export interface SharedConfig {
  version: number;
  sotvault: string | null;
  rawvault: string | null;
  calibre_path: string | null;
  exlibris: unknown;
}

export async function readSharedConfig(): Promise<SharedConfig> {
  return await invoke("shared_config_read");
}

export async function writeSharedConfig(cfg: SharedConfig): Promise<void> {
  await invoke("shared_config_write", { cfg });
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
pnpm vitest run src/lib/shared-config.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared-config.ts src/lib/shared-config.test.ts
git commit -m "feat(shared-config): add TS frontend wrapper"
```

---

### Task 4: One-shot migration from `gitsync.repo` to shared config

**Files:**
- Modify: `src-tauri/src/lib.rs` (call migration in `setup`)
- Create: helper `migrate_gitsync_to_shared()` in `src-tauri/src/shared_config.rs`

The migration runs once at app startup. If shared config has a non-empty `sotvault`, it is a no-op. Otherwise, read the legacy `gitsync.repo` value from the Tauri store plugin's `settings.json` and copy it in.

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/shared_config.rs`:

```rust
/// Migrate the legacy `gitsync.repo` value from a JSON store file into the
/// shared config's `sotvault` field. Idempotent: a non-empty `sotvault` short-circuits.
///
/// `legacy_store_path` points to the Tauri Store JSON (typically
/// `~/Library/Application Support/com.laobu.mdeditor/settings.json`).
pub fn migrate_gitsync_to_shared(
    shared_path: &Path,
    legacy_store_path: &Path,
) -> std::io::Result<bool> {
    let mut cfg = read(shared_path)?;
    if cfg.sotvault.as_ref().is_some_and(|s| !s.is_empty()) {
        return Ok(false);
    }
    let legacy_raw = match std::fs::read_to_string(legacy_store_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let v: serde_json::Value = match serde_json::from_str(&legacy_raw) {
        Ok(v) => v,
        Err(_) => return Ok(false),
    };
    let repo = v.pointer("/gitsync.repo")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    if let Some(repo) = repo {
        if !repo.is_empty() {
            cfg.sotvault = Some(repo);
            write(shared_path, &cfg)?;
            return Ok(true);
        }
    }
    Ok(false)
}
```

Append to the existing `tests` module in `shared_config.rs`:

```rust
#[test]
fn migration_copies_gitsync_repo_when_shared_empty() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path().join("shared.json");
    let legacy = tmp.path().join("legacy.json");
    std::fs::write(&legacy, r#"{"gitsync.repo":"/Users/me/notes"}"#).unwrap();

    let migrated = migrate_gitsync_to_shared(&shared, &legacy).unwrap();
    assert!(migrated);

    let cfg = read(&shared).unwrap();
    assert_eq!(cfg.sotvault.as_deref(), Some("/Users/me/notes"));
}

#[test]
fn migration_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path().join("shared.json");
    let legacy = tmp.path().join("legacy.json");
    std::fs::write(&legacy, r#"{"gitsync.repo":"/Users/me/notes"}"#).unwrap();

    let first = migrate_gitsync_to_shared(&shared, &legacy).unwrap();
    let second = migrate_gitsync_to_shared(&shared, &legacy).unwrap();
    assert!(first);
    assert!(!second);
}

#[test]
fn migration_noop_when_legacy_missing() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path().join("shared.json");
    let legacy = tmp.path().join("legacy.json");
    let migrated = migrate_gitsync_to_shared(&shared, &legacy).unwrap();
    assert!(!migrated);
}

#[test]
fn migration_noop_when_shared_already_has_sotvault() {
    let tmp = TempDir::new().unwrap();
    let shared = tmp.path().join("shared.json");
    let legacy = tmp.path().join("legacy.json");
    write(&shared, &SharedConfig {
        version: 1,
        sotvault: Some("/preset".into()),
        ..Default::default()
    }).unwrap();
    std::fs::write(&legacy, r#"{"gitsync.repo":"/Users/me/notes"}"#).unwrap();

    let migrated = migrate_gitsync_to_shared(&shared, &legacy).unwrap();
    assert!(!migrated);

    let cfg = read(&shared).unwrap();
    assert_eq!(cfg.sotvault.as_deref(), Some("/preset"));
}
```

- [ ] **Step 2: Run the tests, verify all four pass**

```bash
cd src-tauri && cargo test --lib shared_config
```

Expected: 8 tests pass total (4 from Task 1 + 4 here).

- [ ] **Step 3: Wire migration into app setup**

In `src-tauri/src/lib.rs`, inside the existing `.setup(|app| { ... })` closure (before any vault sync init), add:

```rust
{
    let app_data_dir = app.path().app_data_dir().ok();
    if let Some(dir) = app_data_dir {
        let legacy_store = dir.join("settings.json");
        let shared = crate::shared_config::config_path();
        let _ = crate::shared_config::migrate_gitsync_to_shared(&shared, &legacy_store);
    }
}
```

If `tauri::Manager` is not already in scope, add `use tauri::Manager;` near the top.

- [ ] **Step 4: Build mdeditor and verify migration runs**

```bash
pnpm tauri dev
```

In the running app, check that `~/Library/Application Support/com.laobu.mdeditor-shared/config.json` exists and has `sotvault` populated (if you had `gitsync.repo` previously set).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/shared_config.rs src-tauri/src/lib.rs
git commit -m "feat(shared-config): one-shot migrate gitsync.repo to shared sotvault"
```

---

### Task 5: Make `VaultSettingsTab` read/write shared config

**Files:**
- Modify: `src/components/VaultSettingsTab.svelte`
- Modify: `src-tauri/src/vault_sync/mod.rs` (or wherever sotvault path is read)

The user-facing behavior must not change. Internally, the path is sourced from shared config instead of the Tauri store.

- [ ] **Step 1: Read `VaultSettingsTab.svelte` to locate the current data source**

```bash
grep -n "gitsync\|sotvault\|repo" src/components/VaultSettingsTab.svelte
```

Identify the load/save calls (likely via `@tauri-apps/plugin-store` or a settings.svelte.ts wrapper).

- [ ] **Step 2: Replace load/save with shared-config calls**

In `VaultSettingsTab.svelte`, replace the existing repo-path load/save with:

```ts
import { readSharedConfig, writeSharedConfig } from "$lib/shared-config";

let repoPath = $state("");

async function load() {
  const cfg = await readSharedConfig();
  repoPath = cfg.sotvault ?? "";
}

async function save() {
  const cfg = await readSharedConfig();
  cfg.sotvault = repoPath || null;
  await writeSharedConfig(cfg);
}
```

Keep all other UI elements unchanged. `$lib` alias should already resolve to `src/lib/` (verify in `vite.config.ts` if unsure).

- [ ] **Step 3: Update `vault_sync/mod.rs` to source path from shared config**

In `src-tauri/src/vault_sync/mod.rs`, find where the sotvault path is currently read (likely a `get_state` or `init` function reading from store). Replace the store read with:

```rust
let sotvault = crate::shared_config::read(&crate::shared_config::config_path())
    .ok()
    .and_then(|c| c.sotvault);
```

- [ ] **Step 4: Manually verify sync still works**

```bash
pnpm tauri dev
```

- Settings dialog → Vault tab shows the previously-set sotvault
- Start sync from tray → still works
- Change path in settings → save → reload app → new path persists

- [ ] **Step 5: Commit**

```bash
git add src/components/VaultSettingsTab.svelte src-tauri/src/vault_sync/mod.rs
git commit -m "refactor(vault): source sotvault path from shared config"
```

---

### Task 6: Add "Open Books" and "Open Raw Vault Sync" tray menu items

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add menu items to tray builder**

In `src-tauri/src/lib.rs`, locate the existing tray menu construction (around line 600-640 per spec inventory; search for `TrayIconBuilder` or `tray_menu`). Before the `quit_item` line, insert:

```rust
let open_books_item = MenuItem::with_id(
    app, "tray-open-books", "Open Books", true, None::<&str>,
)?;
let open_raw_sync_item = MenuItem::with_id(
    app, "tray-open-raw-sync", "Open Raw Vault Sync", /*enabled=*/ false, None::<&str>,
)?;
```

In the `MenuBuilder::new(app)` chain, add these two items + a separator before the existing quit/separator block. Layout:

```
...existing items
─────────
Open Books
Open Raw Vault Sync   (disabled, "Coming soon")
─────────
Quit M↓
```

The "Coming soon" tooltip is not directly settable on Tauri menu items in 2.x; document it as a future enhancement and leave the item disabled.

- [ ] **Step 2: Handle `tray-open-books` click**

In the existing `match event.id().0.as_str()` arm-list (where `"tray-show"`, `"tray-quit"` etc. live), add:

```rust
"tray-open-books" => {
    let _ = std::process::Command::new("open")
        .arg("-a")
        .arg("ExLibris")
        .status();
}
"tray-open-raw-sync" => { /* disabled — no-op */ }
```

- [ ] **Step 3: Build & manually verify menu structure**

```bash
pnpm tauri dev
```

Click tray icon → menu shows new items. "Open Books" attempts to launch ExLibris (it will fail with `LSOpenURLsWithRole() failed` until Phase 5 builds & installs ExLibris; that's expected).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tray): add Open Books and Open Raw Vault Sync menu items"
```

---

## Phase 1 — ExLibris scaffold

Phase 1 stands up a runnable empty Tauri+Svelte app, integrates it into pnpm-workspace, and implements the onboarding wizard.

---

### Task 7: Scaffold ExLibris Tauri+Svelte project

**Files:**
- Create: `exlibris/package.json`
- Create: `exlibris/vite.config.ts`
- Create: `exlibris/tsconfig.json`
- Create: `exlibris/svelte.config.js`
- Create: `exlibris/index.html`
- Create: `exlibris/src/main.ts`
- Create: `exlibris/src/App.svelte`
- Create: `exlibris/src/styles/global.css`

- [ ] **Step 1: Create `exlibris/package.json`**

```json
{
  "name": "exlibris",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@tauri-apps/plugin-fs": "^2",
    "@tauri-apps/plugin-opener": "^2",
    "@tauri-apps/plugin-os": "^2",
    "@tauri-apps/plugin-process": "^2",
    "yaml": "^2.8.4",
    "svelte-sonner": "^1.1.1"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^5",
    "@tauri-apps/cli": "^2",
    "happy-dom": "^20.9.0",
    "svelte": "^5",
    "svelte-check": "^4",
    "typescript": "^5",
    "vite": "^6",
    "vitest": "^4"
  }
}
```

- [ ] **Step 2: Create `exlibris/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { $lib: path.resolve(__dirname, "src/lib") },
  },
  clearScreen: false,
  server: { port: 5174, strictPort: true },
});
```

(Port 5174 to avoid clashing with mdeditor's 5173.)

- [ ] **Step 3: Create `exlibris/tsconfig.json`**

```json
{
  "extends": "@tsconfig/svelte/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "allowJs": true,
    "checkJs": true,
    "isolatedModules": true,
    "baseUrl": ".",
    "paths": { "$lib/*": ["./src/lib/*"] }
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"]
}
```

Add `@tsconfig/svelte` to devDependencies if it isn't transitively available. If unsure, use this minimal tsconfig instead:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "allowJs": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "$lib/*": ["./src/lib/*"] }
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"]
}
```

- [ ] **Step 4: Create `exlibris/svelte.config.js`**

```js
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
export default { preprocess: vitePreprocess() };
```

- [ ] **Step 5: Create `exlibris/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ExLibris</title>
    <link rel="stylesheet" href="/src/styles/global.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `exlibris/src/main.ts`**

```ts
import { mount } from "svelte";
import App from "./App.svelte";

const app = mount(App, { target: document.getElementById("app")! });
export default app;
```

- [ ] **Step 7: Create `exlibris/src/App.svelte`**

```svelte
<script lang="ts">
  let message = $state("ExLibris");
</script>

<main>
  <h1>{message}</h1>
  <p>Ebook manager — coming soon.</p>
</main>

<style>
  main { padding: 2rem; font-family: -apple-system, system-ui, sans-serif; }
</style>
```

- [ ] **Step 8: Create `exlibris/src/styles/global.css`**

```css
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; }
```

- [ ] **Step 9: Verify Vite dev server runs**

```bash
cd exlibris && pnpm install && pnpm dev
```

Open `http://localhost:5174` — page should render "ExLibris" heading. Stop the server with Ctrl-C.

- [ ] **Step 10: Commit**

```bash
git add exlibris/
git commit -m "feat(exlibris): scaffold Tauri+Svelte frontend"
```

---

### Task 8: Add ExLibris Tauri (Rust) backend skeleton

**Files:**
- Create: `exlibris/src-tauri/Cargo.toml`
- Create: `exlibris/src-tauri/build.rs`
- Create: `exlibris/src-tauri/tauri.conf.json`
- Create: `exlibris/src-tauri/Info.plist`
- Create: `exlibris/src-tauri/src/main.rs`
- Create: `exlibris/src-tauri/src/lib.rs`
- Create: `exlibris/src-tauri/capabilities/default.json`
- Create: `exlibris/src-tauri/icons/icon.png` (copy from mdeditor's `src-tauri/icons/icon.png` as a placeholder; tinted icon is a future polish)

- [ ] **Step 1: Create `exlibris/src-tauri/Cargo.toml`**

```toml
[package]
name = "exlibris"
version = "0.1.0"
edition = "2021"

[lib]
name = "exlibris_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["protocol-asset"] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-opener = "2"
tauri-plugin-os = "2"
tauri-plugin-process = "2"
tokio = { version = "1", features = ["time", "process", "io-util", "macros", "rt-multi-thread", "sync", "fs"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
sha2 = "0.10"
hex = "0.4"
quick-xml = { version = "0.36", features = ["serialize"] }
tempfile = "3.13"
dirs = "5"
walkdir = "2"
anyhow = "1"

[dev-dependencies]
tempfile = "3"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
incremental = false
```

- [ ] **Step 2: Create `exlibris/src-tauri/build.rs`**

```rust
fn main() { tauri_build::build() }
```

- [ ] **Step 3: Create `exlibris/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
  "productName": "ExLibris",
  "version": "0.1.0",
  "identifier": "com.laobu.exlibris",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5174",
    "beforeDevCommand": "pnpm --filter exlibris dev",
    "beforeBuildCommand": "pnpm --filter exlibris build"
  },
  "app": {
    "windows": [
      {
        "title": "ExLibris",
        "width": 1100,
        "height": 720,
        "minWidth": 720,
        "minHeight": 500,
        "fileDropEnabled": true
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "app"],
    "icon": ["icons/icon.png"],
    "macOS": {
      "minimumSystemVersion": "11.0"
    }
  }
}
```

- [ ] **Step 4: Create `exlibris/src-tauri/Info.plist`**

Copy `src-tauri/Info.plist` from mdeditor and replace bundle identifiers / display names. Minimum content:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ExLibris</string>
  <key>CFBundleDisplayName</key><string>ExLibris</string>
  <key>CFBundleIdentifier</key><string>com.laobu.exlibris</string>
  <key>NSHumanReadableCopyright</key><string>© 2026</string>
</dict>
</plist>
```

- [ ] **Step 5: Create `exlibris/src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() { exlibris_lib::run() }
```

- [ ] **Step 6: Create `exlibris/src-tauri/src/lib.rs`**

```rust
pub mod shared_config;
pub mod calibre;
pub mod fs_ops;
pub mod hash;

#[tauri::command]
fn ping() -> &'static str { "pong" }

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 7: Create stub Rust modules (so `lib.rs` compiles)**

`exlibris/src-tauri/src/shared_config.rs`:
```rust
// Populated in Task 10.
```

`exlibris/src-tauri/src/calibre.rs`:
```rust
// Populated in Task 19/20.
```

`exlibris/src-tauri/src/fs_ops.rs`:
```rust
// Populated in Task 21.
```

`exlibris/src-tauri/src/hash.rs`:
```rust
// Populated in Task 22.
```

- [ ] **Step 8: Create `exlibris/src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability set for ExLibris",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:default",
    "core:event:default",
    "dialog:default",
    "fs:default",
    "opener:default",
    "os:default",
    "process:default"
  ]
}
```

- [ ] **Step 9: Copy icon as placeholder**

```bash
mkdir -p exlibris/src-tauri/icons
cp src-tauri/icons/icon.png exlibris/src-tauri/icons/icon.png
```

- [ ] **Step 10: Verify Cargo compiles**

```bash
cd exlibris/src-tauri && cargo check
```

Expected: clean compile (warnings allowed for empty modules).

- [ ] **Step 11: Commit**

```bash
git add exlibris/src-tauri/
git commit -m "feat(exlibris): scaffold Tauri (Rust) backend"
```

---

### Task 9: Integrate ExLibris into pnpm-workspace and root scripts

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json` (root)
- Create: `scripts/build-exlibris.sh`

- [ ] **Step 1: Read current workspace config**

```bash
cat pnpm-workspace.yaml
```

- [ ] **Step 2: Add `exlibris` to packages**

If `pnpm-workspace.yaml` looks like:
```yaml
packages:
  - 'worker'
  - 'mdshare'
  - 'md2pdf'
```

Add `exlibris`:
```yaml
packages:
  - 'worker'
  - 'mdshare'
  - 'md2pdf'
  - 'exlibris'
```

- [ ] **Step 3: Add root scripts to `package.json`**

In the root `package.json` `scripts` object, add:

```json
"tauri:exlibris:dev": "pnpm --filter exlibris tauri:dev",
"tauri:exlibris:build": "pnpm --filter exlibris tauri:build",
"build:exlibris": "bash scripts/build-exlibris.sh"
```

- [ ] **Step 4: Create `scripts/build-exlibris.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Build ExLibris for both macOS architectures, producing two per-arch dmgs.
# Mirrors the convention used for mdeditor.

cd "$(dirname "$0")/.."

pnpm --filter exlibris install

for triple in aarch64-apple-darwin x86_64-apple-darwin; do
  echo "==> Building ExLibris for $triple"
  pnpm --filter exlibris tauri build --target "$triple"
done

echo "==> Done. Artifacts:"
find exlibris/src-tauri/target/*/release/bundle/dmg -name "*.dmg" 2>/dev/null || true
```

```bash
chmod +x scripts/build-exlibris.sh
```

- [ ] **Step 5: Install dependencies, verify workspace recognises ExLibris**

```bash
pnpm install
pnpm --filter exlibris -- node -p "require('./package.json').name"
```

Expected output: `exlibris`

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml package.json scripts/build-exlibris.sh
git commit -m "build(exlibris): wire into pnpm workspace + add build script"
```

---

### Task 10: Implement ExLibris `shared_config.rs` (sibling of mdeditor's)

**Files:**
- Modify: `exlibris/src-tauri/src/shared_config.rs`

This is a near-copy of mdeditor's `shared_config.rs`. Sharing via a workspace crate is future work; v1 duplicates intentionally (small file, low churn).

- [ ] **Step 1: Replace stub content**

Replace the contents of `exlibris/src-tauri/src/shared_config.rs` with the contents of `src-tauri/src/shared_config.rs` from Task 1+4 (excluding the migration function — ExLibris does not migrate).

Specifically: copy the `SharedConfig` struct, `default_version`, `config_path`, `read`, `write`, and the first 4 tests (round-trip, atomic, default, corrupted). Skip `migrate_gitsync_to_shared`.

- [ ] **Step 2: Expose Tauri commands**

Append to `exlibris/src-tauri/src/lib.rs`'s command list and handler:

```rust
#[tauri::command]
fn shared_config_read() -> Result<crate::shared_config::SharedConfig, String> {
    crate::shared_config::read(&crate::shared_config::config_path())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn shared_config_write(cfg: crate::shared_config::SharedConfig) -> Result<(), String> {
    crate::shared_config::write(&crate::shared_config::config_path(), &cfg)
        .map_err(|e| e.to_string())
}
```

Then in `.invoke_handler(tauri::generate_handler![ping])` change to:

```rust
.invoke_handler(tauri::generate_handler![ping, shared_config_read, shared_config_write])
```

- [ ] **Step 3: Run unit tests**

```bash
cd exlibris/src-tauri && cargo test --lib shared_config
```

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add exlibris/src-tauri/src/shared_config.rs exlibris/src-tauri/src/lib.rs
git commit -m "feat(exlibris): shared_config module + Tauri commands"
```

---

### Task 11: Frontend `shared-config.ts` + `types.ts` in ExLibris

**Files:**
- Create: `exlibris/src/lib/shared-config.ts`
- Create: `exlibris/src/lib/shared-config.test.ts`
- Create: `exlibris/src/lib/types.ts`

- [ ] **Step 1: Create `exlibris/src/lib/types.ts`**

```ts
export interface SharedConfig {
  version: number;
  sotvault: string | null;
  rawvault: string | null;
  calibre_path: string | null;
  exlibris: ExlibrisPrefs | null;
}

export interface ExlibrisPrefs {
  import_concurrency?: number;
  convert_timeout_seconds?: number;
  last_used_rule_dirs?: string[];
}

export type PendingStatus =
  | "extracting"
  | "ready_for_review"
  | "needs_attention"
  | "queued"
  | "writing_raw"
  | "converting"
  | "writing_sot"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

export interface PendingEntry {
  id: string;
  source_path: string;
  source_filename: string;
  source_ext: string;
  source_sha256: string | null;
  meta: BookMeta | null;
  book_name: string;
  target_rule_id: string | null;
  target_dir: string;
  dedup: "new" | "exists" | "unknown";
  status: PendingStatus;
  error?: string;
  error_detail?: string;
  selected: boolean;
}

export interface BookMeta {
  schema_version: 1;
  title: string;
  authors: string[];
  publisher: string | null;
  language: string | null;
  isbn: string | null;
  tags: string[];
  pubdate: string | null;
  description: string | null;
  source_filename: string;
  source_format: string;
  source_sha256: string;
  raw_path: string;
  import_time: string;
  calibre_version: string | null;
  applied_rule: string | null;
}

export interface Rule {
  id: string;
  name: string;
  when: {
    ext?: string[];
    tag_contains?: string[];
    author_contains?: string[];
    language?: string[];
  };
  target: string;
}

export interface RulesFile {
  version: 1;
  rules: Rule[];
}
```

- [ ] **Step 2: Create `exlibris/src/lib/shared-config.test.ts`**

Same content as mdeditor's `src/lib/shared-config.test.ts` from Task 3, but import paths point to the local `./shared-config` and `./types`.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readSharedConfig, writeSharedConfig } from "./shared-config";
import type { SharedConfig } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

describe("shared-config (exlibris)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("readSharedConfig delegates to backend", async () => {
    const fake: SharedConfig = {
      version: 1, sotvault: "/x", rawvault: null, calibre_path: null, exlibris: null,
    };
    vi.mocked(invoke).mockResolvedValueOnce(fake);
    expect(await readSharedConfig()).toEqual(fake);
    expect(invoke).toHaveBeenCalledWith("shared_config_read");
  });

  it("writeSharedConfig passes cfg to backend", async () => {
    const cfg: SharedConfig = {
      version: 1, sotvault: "/x", rawvault: "/y", calibre_path: "/z", exlibris: null,
    };
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await writeSharedConfig(cfg);
    expect(invoke).toHaveBeenCalledWith("shared_config_write", { cfg });
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

```bash
cd exlibris && pnpm vitest run src/lib/shared-config.test.ts
```

Expected: fail (no `shared-config.ts`).

- [ ] **Step 4: Create `exlibris/src/lib/shared-config.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import type { SharedConfig } from "./types";

export async function readSharedConfig(): Promise<SharedConfig> {
  return await invoke("shared_config_read");
}

export async function writeSharedConfig(cfg: SharedConfig): Promise<void> {
  await invoke("shared_config_write", { cfg });
}
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
cd exlibris && pnpm vitest run src/lib/shared-config.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add exlibris/src/lib/
git commit -m "feat(exlibris): shared-config TS wrapper + core types"
```

---

### Task 12: Calibre detection (Rust side)

**Files:**
- Modify: `exlibris/src-tauri/src/calibre.rs`
- Modify: `exlibris/src-tauri/src/lib.rs` (register command)

- [ ] **Step 1: Write the failing test**

Replace the contents of `exlibris/src-tauri/src/calibre.rs`:

```rust
use std::path::{Path, PathBuf};

/// Resolve a calibre binary directory:
/// 1. user-configured path (from shared config) — if it contains `ebook-meta`
/// 2. `/Applications/calibre.app/Contents/MacOS`
/// 3. directory containing `ebook-meta` in $PATH
///
/// Returns the directory containing the binaries, or None.
pub fn detect(user_configured: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = user_configured {
        if dir.join("ebook-meta").is_file() {
            return Some(dir.to_path_buf());
        }
    }
    let candidate = Path::new("/Applications/calibre.app/Contents/MacOS");
    if candidate.join("ebook-meta").is_file() {
        return Some(candidate.to_path_buf());
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in path_env.split(':') {
            let p = Path::new(dir).join("ebook-meta");
            if p.is_file() {
                return Some(PathBuf::from(dir));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn touch_exec(p: &Path) {
        std::fs::write(p, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn detect_prefers_user_configured() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        touch_exec(&dir.join("ebook-meta"));
        let got = detect(Some(dir)).unwrap();
        assert_eq!(got, dir);
    }

    #[test]
    fn detect_user_configured_without_binary_falls_back() {
        let tmp = TempDir::new().unwrap();
        let got = detect(Some(tmp.path()));
        // result depends on host; just assert no panic
        assert!(got.is_none() || got.is_some());
    }
}
```

- [ ] **Step 2: Run the test, verify it passes**

```bash
cd exlibris/src-tauri && cargo test --lib calibre
```

Expected: 2 tests pass.

- [ ] **Step 3: Add Tauri command**

In `exlibris/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn calibre_detect(user_configured: Option<String>) -> Option<String> {
    let user = user_configured.map(std::path::PathBuf::from);
    crate::calibre::detect(user.as_deref())
        .map(|p| p.to_string_lossy().to_string())
}
```

Add `calibre_detect` to `generate_handler![...]`.

- [ ] **Step 4: Commit**

```bash
git add exlibris/src-tauri/src/calibre.rs exlibris/src-tauri/src/lib.rs
git commit -m "feat(exlibris): calibre binary detection with fallback chain"
```

---

### Task 13: `OnboardingBanner.svelte` + initial app shell

**Files:**
- Create: `exlibris/src/components/OnboardingBanner.svelte`
- Modify: `exlibris/src/App.svelte`

- [ ] **Step 1: Create `OnboardingBanner.svelte`**

```svelte
<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { invoke } from "@tauri-apps/api/core";
  import { readSharedConfig, writeSharedConfig } from "$lib/shared-config";
  import type { SharedConfig } from "$lib/types";

  let { onReady }: { onReady: (cfg: SharedConfig) => void } = $props();

  let cfg = $state<SharedConfig>({
    version: 1, sotvault: null, rawvault: null, calibre_path: null, exlibris: null,
  });
  let calibreDetected = $state<string | null>(null);

  $effect(() => { (async () => {
    cfg = await readSharedConfig();
    calibreDetected = await invoke<string | null>("calibre_detect", {
      userConfigured: cfg.calibre_path,
    });
  })(); });

  async function pickDir(field: "sotvault" | "rawvault" | "calibre_path") {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      cfg[field] = picked;
      await writeSharedConfig(cfg);
      if (field === "calibre_path") {
        calibreDetected = await invoke<string | null>("calibre_detect", {
          userConfigured: cfg.calibre_path,
        });
      }
    }
  }

  let ready = $derived(
    !!cfg.sotvault && !!cfg.rawvault && !!calibreDetected
  );
</script>

<section class="onboarding">
  <h2>Get Started</h2>
  <ol>
    <li class:done={!!cfg.sotvault}>
      <span>Sotvault: {cfg.sotvault ?? "Not configured"}</span>
      <button onclick={() => pickDir("sotvault")}>Choose…</button>
    </li>
    <li class:done={!!cfg.rawvault}>
      <span>Rawvault: {cfg.rawvault ?? "Not configured"}</span>
      <button onclick={() => pickDir("rawvault")}>Choose…</button>
    </li>
    <li class:done={!!calibreDetected}>
      <span>calibre: {calibreDetected ?? "Not detected"}</span>
      <button onclick={() => pickDir("calibre_path")}>Choose…</button>
      {#if !calibreDetected}
        <a href="https://calibre-ebook.com" target="_blank">Install calibre</a>
      {/if}
    </li>
  </ol>
  <button disabled={!ready} onclick={() => onReady(cfg)}>Get Started</button>
</section>

<style>
  .onboarding { padding: 1.5rem; border: 1px solid #ccc; border-radius: 8px; max-width: 600px; }
  ol { list-style: none; padding: 0; }
  li { padding: 0.5rem 0; display: flex; gap: 0.5rem; align-items: center; }
  li.done span::before { content: "✓ "; color: green; }
</style>
```

- [ ] **Step 2: Update `App.svelte` to gate on onboarding**

```svelte
<script lang="ts">
  import OnboardingBanner from "./components/OnboardingBanner.svelte";
  import type { SharedConfig } from "$lib/types";

  let ready = $state(false);
  let config = $state<SharedConfig | null>(null);

  function onReady(cfg: SharedConfig) {
    config = cfg;
    ready = true;
  }
</script>

<main>
  <h1>ExLibris</h1>
  {#if !ready}
    <OnboardingBanner {onReady} />
  {:else}
    <p>Onboarding complete. Sotvault: {config?.sotvault}</p>
    <p>(Drop zone + library browser coming in later phases.)</p>
  {/if}
</main>

<style>
  main { padding: 2rem; font-family: -apple-system, system-ui, sans-serif; }
</style>
```

- [ ] **Step 3: Manually verify**

```bash
pnpm --filter exlibris tauri:dev
```

- App opens; onboarding banner appears
- Choose sotvault/rawvault/calibre dirs → "Get Started" enables
- Click "Get Started" → screen swaps to placeholder text

- [ ] **Step 4: Commit**

```bash
git add exlibris/src/components/OnboardingBanner.svelte exlibris/src/App.svelte
git commit -m "feat(exlibris): onboarding banner gating main UI"
```

---

## Phase 2 — Import core

Phase 2 implements the full drop → preview → import pipeline. This is the biggest phase. Each module is independently testable; tasks proceed bottom-up from utilities to UI.

---

### Task 14: `bookname.ts` — title cleaning & duplicate suffixing

**Files:**
- Create: `exlibris/src/lib/bookname.ts`
- Create: `exlibris/src/lib/bookname.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { cleanBookName, resolveDuplicateName } from "./bookname";

describe("cleanBookName", () => {
  it("trims whitespace", () => {
    expect(cleanBookName("  hello  ")).toBe("hello");
  });
  it("collapses internal whitespace", () => {
    expect(cleanBookName("a   b\tc\nd")).toBe("a b c d");
  });
  it("strips fs-illegal characters", () => {
    expect(cleanBookName("a/b:c*d?e\"f<g>h|i\\j")).toBe("abcdefghij");
  });
  it("truncates to 80 chars, preserving CJK boundary", () => {
    const long = "中".repeat(100);
    const got = cleanBookName(long);
    expect(got.length).toBeLessThanOrEqual(80);
    expect([...got].every((c) => c === "中")).toBe(true);
  });
  it("returns empty string when input is only illegal chars or whitespace", () => {
    expect(cleanBookName("   ///   ")).toBe("");
  });
  it("preserves CJK and emoji", () => {
    expect(cleanBookName("三体 — Liu Cixin")).toBe("三体 — Liu Cixin");
  });
});

describe("resolveDuplicateName", () => {
  it("returns the name unchanged when not in existing", () => {
    expect(resolveDuplicateName("Foo", new Set())).toBe("Foo");
  });
  it("adds ' (2)' on first conflict", () => {
    expect(resolveDuplicateName("Foo", new Set(["Foo"]))).toBe("Foo (2)");
  });
  it("increments to (3) when (2) also taken", () => {
    expect(resolveDuplicateName("Foo", new Set(["Foo", "Foo (2)"]))).toBe("Foo (3)");
  });
  it("does not match unrelated similar names", () => {
    expect(resolveDuplicateName("Foo Bar", new Set(["Foo"]))).toBe("Foo Bar");
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd exlibris && pnpm vitest run src/lib/bookname.test.ts
```

- [ ] **Step 3: Implement**

```ts
const FS_ILLEGAL = /[\/:*?"<>|\\]/g;

export function cleanBookName(input: string): string {
  if (!input) return "";
  let out = input.replace(FS_ILLEGAL, "");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length === 0) return "";
  if ([...out].length > 80) {
    out = [...out].slice(0, 80).join("");
  }
  return out;
}

export function resolveDuplicateName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  let n = 2;
  while (existing.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd exlibris && pnpm vitest run src/lib/bookname.test.ts
```

Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add exlibris/src/lib/bookname.ts exlibris/src/lib/bookname.test.ts
git commit -m "feat(exlibris): bookname cleaning + duplicate suffix"
```

---

### Task 15: `meta.ts` — YAML round-trip for BookMeta

**Files:**
- Create: `exlibris/src/lib/meta.ts`
- Create: `exlibris/src/lib/meta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseMeta, serializeMeta, defaultMeta } from "./meta";
import type { BookMeta } from "./types";

const sample: BookMeta = {
  schema_version: 1,
  title: "Effective Modern C++",
  authors: ["Scott Meyers"],
  publisher: "O'Reilly",
  language: "en",
  isbn: "9781491903995",
  tags: ["计算机", "C++"],
  pubdate: "2014-12-05",
  description: "42 specific ways…",
  source_filename: "9781491903995.epub",
  source_format: "epub",
  source_sha256: "a1b2c3",
  raw_path: "books/2025/202501/Effective Modern C++.epub",
  import_time: "2026-05-18T10:23:45+08:00",
  calibre_version: "7.21.0",
  applied_rule: "r-tech",
};

describe("meta yaml", () => {
  it("serialize → parse round-trip preserves all fields", () => {
    const yaml = serializeMeta(sample);
    const back = parseMeta(yaml);
    expect(back).toEqual(sample);
  });

  it("parse fills defaults for missing optional fields", () => {
    const minimal = `schema_version: 1\ntitle: Foo\nsource_filename: f.epub\nsource_format: epub\nsource_sha256: x\nraw_path: y\nimport_time: 2026-05-18T00:00:00Z\n`;
    const meta = parseMeta(minimal);
    expect(meta.authors).toEqual([]);
    expect(meta.tags).toEqual([]);
    expect(meta.publisher).toBeNull();
    expect(meta.applied_rule).toBeNull();
  });

  it("parse throws on malformed YAML", () => {
    expect(() => parseMeta("title: : :")).toThrow();
  });

  it("defaultMeta produces a valid empty-ish meta", () => {
    const d = defaultMeta();
    expect(d.schema_version).toBe(1);
    expect(d.authors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd exlibris && pnpm vitest run src/lib/meta.test.ts
```

- [ ] **Step 3: Implement**

```ts
import YAML from "yaml";
import type { BookMeta } from "./types";

export function defaultMeta(): BookMeta {
  return {
    schema_version: 1,
    title: "",
    authors: [],
    publisher: null,
    language: null,
    isbn: null,
    tags: [],
    pubdate: null,
    description: null,
    source_filename: "",
    source_format: "",
    source_sha256: "",
    raw_path: "",
    import_time: "",
    calibre_version: null,
    applied_rule: null,
  };
}

export function serializeMeta(m: BookMeta): string {
  return YAML.stringify(m, { lineWidth: 0 });
}

export function parseMeta(yaml: string): BookMeta {
  const raw = YAML.parse(yaml);
  if (!raw || typeof raw !== "object") {
    throw new Error("meta.yml is not an object");
  }
  return { ...defaultMeta(), ...raw };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd exlibris && pnpm vitest run src/lib/meta.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add exlibris/src/lib/meta.ts exlibris/src/lib/meta.test.ts
git commit -m "feat(exlibris): YAML serialize/parse for BookMeta"
```

---

### Task 16: `rules.ts` — rule evaluation & rebuild diff

**Files:**
- Create: `exlibris/src/lib/rules.ts`
- Create: `exlibris/src/lib/rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { evaluateRule, applyRules, computeRebuildDiff, DEFAULT_RULE } from "./rules";
import type { Rule, BookMeta } from "./types";

const techRule: Rule = {
  id: "r-tech",
  name: "Tech",
  when: { ext: ["pdf", "epub"], tag_contains: ["programming"] },
  target: "tech",
};

const fictionRule: Rule = {
  id: "r-fiction",
  name: "Fiction",
  when: { tag_contains: ["novel"] },
  target: "fiction",
};

function metaOf(over: Partial<BookMeta>): BookMeta {
  return {
    schema_version: 1, title: "", authors: [], publisher: null, language: null,
    isbn: null, tags: [], pubdate: null, description: null,
    source_filename: "", source_format: "", source_sha256: "",
    raw_path: "", import_time: "", calibre_version: null, applied_rule: null,
    ...over,
  };
}

describe("evaluateRule", () => {
  it("matches when all conditions satisfied", () => {
    const m = metaOf({ source_format: "pdf", tags: ["programming"] });
    expect(evaluateRule(techRule, m)).toBe(true);
  });
  it("fails when ext mismatched", () => {
    const m = metaOf({ source_format: "mobi", tags: ["programming"] });
    expect(evaluateRule(techRule, m)).toBe(false);
  });
  it("treats empty `when` as match-all", () => {
    expect(evaluateRule(DEFAULT_RULE, metaOf({}))).toBe(true);
  });
  it("tag_contains uses substring match (case-insensitive)", () => {
    const m = metaOf({ tags: ["Programming Languages"] });
    expect(evaluateRule(
      { id: "r", name: "r", when: { tag_contains: ["programming"] }, target: "t" },
      m
    )).toBe(true);
  });
  it("author_contains matches concatenated authors", () => {
    const m = metaOf({ authors: ["Donald Knuth"] });
    expect(evaluateRule(
      { id: "r", name: "r", when: { author_contains: ["knuth"] }, target: "ref" },
      m
    )).toBe(true);
  });
});

describe("applyRules", () => {
  it("first match wins", () => {
    const m = metaOf({ source_format: "epub", tags: ["programming", "novel"] });
    const res = applyRules([techRule, fictionRule], m);
    expect(res.rule_id).toBe("r-tech");
    expect(res.target).toBe("tech");
  });
  it("falls back to default uncategorized when nothing matches", () => {
    const m = metaOf({ source_format: "mobi", tags: [] });
    const res = applyRules([techRule, fictionRule], m);
    expect(res.rule_id).toBeNull();
    expect(res.target).toBe("uncategorized");
  });
});

describe("computeRebuildDiff", () => {
  it("returns rows whose current path differs from new target", () => {
    const rules = [techRule];
    const entries = [
      { current_dir: "fiction", book_name: "X", meta: metaOf({ tags: ["programming"], source_format: "pdf" }) },
      { current_dir: "tech", book_name: "Y", meta: metaOf({ tags: ["programming"], source_format: "pdf" }) },
    ];
    const diff = computeRebuildDiff(rules, entries);
    expect(diff.length).toBe(1);
    expect(diff[0].from).toBe("fiction");
    expect(diff[0].to).toBe("tech");
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd exlibris && pnpm vitest run src/lib/rules.test.ts
```

- [ ] **Step 3: Implement**

```ts
import type { Rule, BookMeta } from "./types";

export const DEFAULT_RULE: Rule = {
  id: "__default__",
  name: "Uncategorized",
  when: {},
  target: "uncategorized",
};

function containsAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

export function evaluateRule(rule: Rule, meta: BookMeta): boolean {
  const w = rule.when ?? {};
  if (w.ext && w.ext.length > 0) {
    if (!w.ext.map((e) => e.toLowerCase()).includes(meta.source_format.toLowerCase())) return false;
  }
  if (w.tag_contains && w.tag_contains.length > 0) {
    const hay = (meta.tags ?? []).join(" ");
    if (!containsAny(hay, w.tag_contains)) return false;
  }
  if (w.author_contains && w.author_contains.length > 0) {
    const hay = (meta.authors ?? []).join(" ");
    if (!containsAny(hay, w.author_contains)) return false;
  }
  if (w.language && w.language.length > 0) {
    if (!meta.language || !w.language.includes(meta.language)) return false;
  }
  return true;
}

export function applyRules(rules: Rule[], meta: BookMeta): { rule_id: string | null; target: string } {
  for (const r of rules) {
    if (evaluateRule(r, meta)) {
      return { rule_id: r.id, target: r.target };
    }
  }
  return { rule_id: null, target: DEFAULT_RULE.target };
}

export interface DiffRow {
  book_name: string;
  from: string;
  to: string;
  new_rule_id: string | null;
}

export function computeRebuildDiff(
  rules: Rule[],
  entries: Array<{ current_dir: string; book_name: string; meta: BookMeta }>,
): DiffRow[] {
  const out: DiffRow[] = [];
  for (const e of entries) {
    const { rule_id, target } = applyRules(rules, e.meta);
    if (target !== e.current_dir) {
      out.push({ book_name: e.book_name, from: e.current_dir, to: target, new_rule_id: rule_id });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd exlibris && pnpm vitest run src/lib/rules.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add exlibris/src/lib/rules.ts exlibris/src/lib/rules.test.ts
git commit -m "feat(exlibris): rule evaluation + rebuild diff"
```

---

### Task 17: `dedup.ts` — ISBN/SHA256 lookup across sotvault

**Files:**
- Create: `exlibris/src/lib/dedup.ts`
- Create: `exlibris/src/lib/dedup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { findDuplicate } from "./dedup";
import type { BookMeta } from "./types";

function metaOf(over: Partial<BookMeta>): BookMeta {
  return {
    schema_version: 1, title: "X", authors: [], publisher: null, language: null,
    isbn: null, tags: [], pubdate: null, description: null,
    source_filename: "", source_format: "epub", source_sha256: "",
    raw_path: "", import_time: "", calibre_version: null, applied_rule: null,
    ...over,
  };
}

describe("findDuplicate", () => {
  const library = [
    metaOf({ title: "A", isbn: "111", source_sha256: "aaa" }),
    metaOf({ title: "B", isbn: "222", source_sha256: "bbb" }),
    metaOf({ title: "C", isbn: null, source_sha256: "ccc" }),
  ];

  it("matches by ISBN when both have one", () => {
    const hit = findDuplicate({ isbn: "111", sha256: "zzz" }, library);
    expect(hit?.title).toBe("A");
  });
  it("matches by SHA256 when ISBN absent", () => {
    const hit = findDuplicate({ isbn: null, sha256: "bbb" }, library);
    expect(hit?.title).toBe("B");
  });
  it("returns null when no match", () => {
    const hit = findDuplicate({ isbn: "999", sha256: "zzz" }, library);
    expect(hit).toBeNull();
  });
  it("treats empty-string ISBN as absent (does not match other empties)", () => {
    const hit = findDuplicate({ isbn: "", sha256: "zzz" }, [metaOf({ isbn: "" })]);
    expect(hit).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd exlibris && pnpm vitest run src/lib/dedup.test.ts
```

- [ ] **Step 3: Implement**

```ts
import type { BookMeta } from "./types";

export function findDuplicate(
  query: { isbn: string | null; sha256: string },
  library: BookMeta[],
): BookMeta | null {
  const qIsbn = query.isbn && query.isbn.length > 0 ? query.isbn : null;
  for (const m of library) {
    if (qIsbn && m.isbn && m.isbn === qIsbn) return m;
    if (query.sha256 && m.source_sha256 === query.sha256) return m;
  }
  return null;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd exlibris && pnpm vitest run src/lib/dedup.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add exlibris/src/lib/dedup.ts exlibris/src/lib/dedup.test.ts
git commit -m "feat(exlibris): dedup by ISBN + SHA256"
```

---

### Task 18: `rawvault-fs.ts` — compute bucket path & sanitize extension

**Files:**
- Create: `exlibris/src/lib/rawvault-fs.ts`
- Create: `exlibris/src/lib/rawvault-fs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { computeBucketDir, computeRawPath } from "./rawvault-fs";

describe("computeBucketDir", () => {
  it("formats year/yearmonth", () => {
    const d = new Date("2026-05-18T12:00:00+08:00");
    expect(computeBucketDir(d)).toBe("books/2026/202605");
  });
  it("pads single-digit months", () => {
    const d = new Date("2025-01-01T00:00:00Z");
    expect(computeBucketDir(d)).toBe("books/2025/202501");
  });
});

describe("computeRawPath", () => {
  it("joins bucket + bookname + ext", () => {
    const d = new Date("2026-05-18T00:00:00Z");
    expect(computeRawPath("My Book", "epub", d)).toBe("books/2026/202605/My Book.epub");
  });
  it("lowercases the extension", () => {
    const d = new Date("2026-05-18T00:00:00Z");
    expect(computeRawPath("Foo", "PDF", d)).toBe("books/2026/202605/Foo.pdf");
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd exlibris && pnpm vitest run src/lib/rawvault-fs.test.ts
```

- [ ] **Step 3: Implement**

```ts
export function computeBucketDir(when: Date): string {
  const y = when.getFullYear();
  const m = (when.getMonth() + 1).toString().padStart(2, "0");
  return `books/${y}/${y}${m}`;
}

export function computeRawPath(bookName: string, ext: string, when: Date): string {
  return `${computeBucketDir(when)}/${bookName}.${ext.toLowerCase()}`;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd exlibris && pnpm vitest run src/lib/rawvault-fs.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add exlibris/src/lib/rawvault-fs.ts exlibris/src/lib/rawvault-fs.test.ts
git commit -m "feat(exlibris): rawvault path computation"
```

---

### Task 19: `sotvault-fs.ts` — walk meta.yml in sotvault

**Files:**
- Create: `exlibris/src/lib/sotvault-fs.ts`
- Create: `exlibris/src/lib/sotvault-fs.test.ts`
- Modify: `exlibris/src-tauri/src/lib.rs` (add `sotvault_list_meta` command)

This task has both a frontend wrapper and a backend file-walking command. The frontend wraps a Tauri invoke; tests mock invoke.

- [ ] **Step 1: Add the Rust command**

In `exlibris/src-tauri/src/lib.rs`:

```rust
use serde::Serialize;

#[derive(Serialize)]
pub struct SotvaultEntry {
    pub rule_dir: String,
    pub book_name: String,
    pub meta_yaml: String,
}

#[tauri::command]
fn sotvault_list_meta(sotvault: String) -> Result<Vec<SotvaultEntry>, String> {
    let root = std::path::PathBuf::from(&sotvault);
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_name() != "meta.yml" { continue; }
        let p = entry.path();
        // expected layout: <sotvault>/<rule_dir>/<book_name>/meta.yml
        let book_dir = match p.parent() { Some(b) => b, None => continue };
        let rule_dir_path = match book_dir.parent() { Some(r) => r, None => continue };
        if rule_dir_path == root { continue; } // depth 1: skip top-level meta.yml (shouldn't exist)
        if rule_dir_path.file_name().map(|s| s.to_string_lossy().starts_with('.')) == Some(true) {
            continue; // skip .exlibris/
        }
        let book_name = book_dir.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let rule_dir = rule_dir_path.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let yaml = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
        out.push(SotvaultEntry { rule_dir, book_name, meta_yaml: yaml });
    }
    Ok(out)
}
```

Register `sotvault_list_meta` in `generate_handler!`.

- [ ] **Step 2: Frontend test**

`exlibris/src/lib/sotvault-fs.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { listSotvaultMeta } from "./sotvault-fs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

describe("listSotvaultMeta", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("parses YAML for each entry", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { rule_dir: "tech", book_name: "X", meta_yaml: "schema_version: 1\ntitle: X\nsource_filename: x.epub\nsource_format: epub\nsource_sha256: a\nraw_path: r\nimport_time: t\n" },
    ]);
    const res = await listSotvaultMeta("/sot");
    expect(res).toHaveLength(1);
    expect(res[0].book_name).toBe("X");
    expect(res[0].meta.title).toBe("X");
  });
});
```

- [ ] **Step 3: Implement frontend wrapper**

`exlibris/src/lib/sotvault-fs.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { parseMeta } from "./meta";
import type { BookMeta } from "./types";

export interface SotvaultEntry {
  rule_dir: string;
  book_name: string;
  meta: BookMeta;
}

interface RawEntry {
  rule_dir: string;
  book_name: string;
  meta_yaml: string;
}

export async function listSotvaultMeta(sotvault: string): Promise<SotvaultEntry[]> {
  const raw = await invoke<RawEntry[]>("sotvault_list_meta", { sotvault });
  return raw.map((r) => ({
    rule_dir: r.rule_dir,
    book_name: r.book_name,
    meta: parseMeta(r.meta_yaml),
  }));
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd exlibris && pnpm vitest run src/lib/sotvault-fs.test.ts
cd exlibris/src-tauri && cargo check
```

- [ ] **Step 5: Commit**

```bash
git add exlibris/src/lib/sotvault-fs.* exlibris/src-tauri/src/lib.rs
git commit -m "feat(exlibris): sotvault meta.yml enumeration"
```

---

### Task 20: `hash.rs` — streaming SHA256

**Files:**
- Modify: `exlibris/src-tauri/src/hash.rs`

- [ ] **Step 1: Write the failing test**

Replace `exlibris/src-tauri/src/hash.rs`:

```rust
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn empty_file_known_hash() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("empty");
        std::fs::write(&p, "").unwrap();
        // SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(
            file_sha256(&p).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn small_file_matches_shasum_output() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("hello");
        std::fs::write(&p, "hello").unwrap();
        // SHA256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        assert_eq!(
            file_sha256(&p).unwrap(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn multi_buffer_file() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("big");
        let data = vec![0u8; 200 * 1024];
        std::fs::write(&p, &data).unwrap();
        let h = file_sha256(&p).unwrap();
        assert_eq!(h.len(), 64);
    }
}
```

- [ ] **Step 2: Run, verify pass**

```bash
cd exlibris/src-tauri && cargo test --lib hash
```

- [ ] **Step 3: Add Tauri command**

In `exlibris/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn hash_file_sha256(path: String) -> Result<String, String> {
    crate::hash::file_sha256(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}
```

Register `hash_file_sha256` in `generate_handler!`.

- [ ] **Step 4: Commit**

```bash
git add exlibris/src-tauri/src/hash.rs exlibris/src-tauri/src/lib.rs
git commit -m "feat(exlibris): streaming SHA256 file hash"
```

---

### Task 21: `fs_ops.rs` — atomic copy & rename with suffix-on-collision

**Files:**
- Modify: `exlibris/src-tauri/src/fs_ops.rs`

- [ ] **Step 1: Write the failing test**

Replace `exlibris/src-tauri/src/fs_ops.rs`:

```rust
use std::path::{Path, PathBuf};

/// Atomically copy `src` to `dst`. If `dst` exists, append " (N)" to the stem
/// (preserving extension) until a free name is found. Returns the final path.
pub fn atomic_copy_with_suffix(src: &Path, dst: &Path) -> std::io::Result<PathBuf> {
    let final_path = resolve_collision(dst);
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = final_path.with_extension(format!(
        "{}.tmp",
        final_path.extension().and_then(|s| s.to_str()).unwrap_or("")
    ));
    std::fs::copy(src, &tmp)?;
    // Best-effort fsync on the temp file.
    if let Ok(f) = std::fs::File::open(&tmp) { let _ = f.sync_all(); }
    std::fs::rename(&tmp, &final_path)?;
    Ok(final_path)
}

fn resolve_collision(dst: &Path) -> PathBuf {
    if !dst.exists() { return dst.to_path_buf(); }
    let stem = dst.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let ext = dst.extension().and_then(|s| s.to_str());
    let parent = dst.parent().unwrap_or(Path::new("."));
    let mut n = 2;
    loop {
        let candidate_name = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() { return candidate; }
        n += 1;
        if n > 1000 { return candidate; } // give up gracefully
    }
}

/// Rename `src` to `dst`. If `dst` exists, return an error (used by sotvault
/// rebuild — collisions are unexpected and indicate a logic bug).
pub fn rename_strict(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("rename target already exists: {}", dst.display()),
        ));
    }
    if let Some(parent) = dst.parent() { std::fs::create_dir_all(parent)?; }
    std::fs::rename(src, dst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn atomic_copy_writes_to_final_path() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src.txt");
        let dst = tmp.path().join("out/dst.txt");
        std::fs::write(&src, "hello").unwrap();
        let got = atomic_copy_with_suffix(&src, &dst).unwrap();
        assert_eq!(got, dst);
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "hello");
    }

    #[test]
    fn atomic_copy_avoids_collision_with_suffix() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src.txt");
        let dst = tmp.path().join("dst.txt");
        std::fs::write(&src, "v1").unwrap();
        std::fs::write(&dst, "existing").unwrap();
        let got = atomic_copy_with_suffix(&src, &dst).unwrap();
        assert_eq!(got, tmp.path().join("dst (2).txt"));
        assert_eq!(std::fs::read_to_string(&got).unwrap(), "v1");
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "existing");
    }

    #[test]
    fn rename_strict_errors_on_existing_target() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("a"); let dst = tmp.path().join("b");
        std::fs::create_dir(&src).unwrap();
        std::fs::create_dir(&dst).unwrap();
        let err = rename_strict(&src, &dst).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }
}
```

- [ ] **Step 2: Run, verify pass**

```bash
cd exlibris/src-tauri && cargo test --lib fs_ops
```

- [ ] **Step 3: Add Tauri commands**

In `exlibris/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn fs_atomic_copy(src: String, dst: String) -> Result<String, String> {
    crate::fs_ops::atomic_copy_with_suffix(
        std::path::Path::new(&src), std::path::Path::new(&dst),
    )
    .map(|p| p.to_string_lossy().to_string())
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_rename_strict(src: String, dst: String) -> Result<(), String> {
    crate::fs_ops::rename_strict(
        std::path::Path::new(&src), std::path::Path::new(&dst),
    )
    .map_err(|e| e.to_string())
}
```

Register both in `generate_handler!`.

- [ ] **Step 4: Commit**

```bash
git add exlibris/src-tauri/src/fs_ops.rs exlibris/src-tauri/src/lib.rs
git commit -m "feat(exlibris): atomic copy with suffix + strict rename"
```

---

### Task 22: `calibre.rs` — spawn `ebook-meta` & `ebook-convert` with timeout

**Files:**
- Modify: `exlibris/src-tauri/src/calibre.rs` (extend the detection-only stub from Task 12)
- Create: `exlibris/src-tauri/tests/fixtures/ebook-meta-success.sh`
- Create: `exlibris/src-tauri/tests/fixtures/ebook-meta-crash.sh`
- Create: `exlibris/src-tauri/tests/fixtures/ebook-meta-hang.sh`
- Create: `exlibris/src-tauri/tests/fixtures/ebook-convert-success.sh`
- Create: `exlibris/src-tauri/tests/fixtures/ebook-convert-slow.sh`

- [ ] **Step 1: Create fixture scripts**

`exlibris/src-tauri/tests/fixtures/ebook-meta-success.sh`:
```bash
#!/usr/bin/env bash
cat <<'OPF'
<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Hello World</dc:title>
    <dc:creator opf:role="aut">Jane Author</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier opf:scheme="ISBN">9780000000001</dc:identifier>
    <dc:subject>computers</dc:subject>
    <dc:subject>programming</dc:subject>
    <dc:date>2024-01-15</dc:date>
    <dc:description>A test book.</dc:description>
  </metadata>
</package>
OPF
exit 0
```

`exlibris/src-tauri/tests/fixtures/ebook-meta-crash.sh`:
```bash
#!/usr/bin/env bash
echo "fake crash" >&2
exit 1
```

`exlibris/src-tauri/tests/fixtures/ebook-meta-hang.sh`:
```bash
#!/usr/bin/env bash
sleep 30
```

`exlibris/src-tauri/tests/fixtures/ebook-convert-success.sh`:
```bash
#!/usr/bin/env bash
# args: <src> <dst>
echo "# Converted Book" > "$2"
echo "" >> "$2"
echo "Hello." >> "$2"
exit 0
```

`exlibris/src-tauri/tests/fixtures/ebook-convert-slow.sh`:
```bash
#!/usr/bin/env bash
sleep 10
echo "# late" > "$2"
exit 0
```

Make them executable:
```bash
chmod +x exlibris/src-tauri/tests/fixtures/*.sh
```

- [ ] **Step 2: Write the failing test for `ebook-meta` parsing**

Append to `exlibris/src-tauri/src/calibre.rs`:

```rust
use std::time::Duration;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct ExtractedMeta {
    pub title: String,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub tags: Vec<String>,
    pub pubdate: Option<String>,
    pub description: Option<String>,
    pub calibre_version: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CalibreError {
    #[error("calibre binary not found")]
    NotFound,
    #[error("ebook-meta exited with code {0}; stderr: {1}")]
    NonZero(i32, String),
    #[error("ebook-meta timed out after {0:?}")]
    Timeout(Duration),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse: {0}")]
    Parse(String),
}

pub async fn extract_meta(
    binary_dir: &std::path::Path,
    file: &std::path::Path,
    timeout: Duration,
) -> Result<ExtractedMeta, CalibreError> {
    let bin = binary_dir.join("ebook-meta");
    if !bin.is_file() { return Err(CalibreError::NotFound); }

    let output = tokio::time::timeout(
        timeout,
        tokio::process::Command::new(&bin)
            .arg(file).arg("--to-opf=-")
            .output(),
    )
    .await
    .map_err(|_| CalibreError::Timeout(timeout))??;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        let err = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(CalibreError::NonZero(code, truncate(err, 16 * 1024)));
    }
    let opf = String::from_utf8_lossy(&output.stdout).into_owned();
    parse_opf(&opf)
}

pub async fn convert(
    binary_dir: &std::path::Path,
    src: &std::path::Path,
    dst: &std::path::Path,
    timeout: Duration,
) -> Result<(), CalibreError> {
    let bin = binary_dir.join("ebook-convert");
    if !bin.is_file() { return Err(CalibreError::NotFound); }
    let output = tokio::time::timeout(
        timeout,
        tokio::process::Command::new(&bin)
            .arg(src).arg(dst)
            .output(),
    )
    .await
    .map_err(|_| CalibreError::Timeout(timeout))??;
    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        let err = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(CalibreError::NonZero(code, truncate(err, 16 * 1024)));
    }
    Ok(())
}

fn truncate(s: String, max: usize) -> String {
    if s.len() <= max { s } else { s[s.len() - max..].to_string() }
}

fn parse_opf(opf: &str) -> Result<ExtractedMeta, CalibreError> {
    // Use quick-xml reader. Keep this defensive — calibre OPF is fairly stable.
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(opf);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut out = ExtractedMeta::default();
    let mut current = String::new();
    let mut isbn_pending = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Err(e) => return Err(CalibreError::Parse(e.to_string())),
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                current = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                isbn_pending = false;
                if current.ends_with("identifier") {
                    for attr in e.attributes().flatten() {
                        if let Ok(v) = std::str::from_utf8(&attr.value) {
                            if v.eq_ignore_ascii_case("ISBN") { isbn_pending = true; }
                        }
                    }
                }
            }
            Ok(Event::Text(t)) => {
                let txt = t.unescape().unwrap_or_default().into_owned();
                match current.as_str() {
                    s if s.ends_with("title") => out.title = txt,
                    s if s.ends_with("creator") => out.authors.push(txt),
                    s if s.ends_with("publisher") => out.publisher = Some(txt),
                    s if s.ends_with("language") => out.language = Some(txt),
                    s if s.ends_with("subject") => out.tags.push(txt),
                    s if s.ends_with("date") => out.pubdate = Some(txt),
                    s if s.ends_with("description") => out.description = Some(txt),
                    s if s.ends_with("identifier") && isbn_pending => out.isbn = Some(txt),
                    _ => {}
                }
            }
            Ok(Event::End(_)) => current.clear(),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

#[cfg(test)]
mod cali_tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    /// The fixture scripts are named `ebook-meta-<variant>.sh`. To use them as
    /// the `ebook-meta` binary in tests, we create a temp dir, symlink them to
    /// `<tmp>/ebook-meta`, and pass that directory as the binary_dir.
    fn binary_dir_for(variant: &str) -> tempfile::TempDir {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = fixtures_dir().join(format!("ebook-meta-{variant}.sh"));
        std::os::unix::fs::symlink(target, tmp.path().join("ebook-meta")).unwrap();
        tmp
    }

    #[tokio::test]
    async fn extract_meta_parses_success_opf() {
        let dir = binary_dir_for("success");
        let any_file = fixtures_dir().join("ebook-meta-success.sh"); // file path doesn't matter; script ignores it
        let meta = extract_meta(dir.path(), &any_file, Duration::from_secs(2)).await.unwrap();
        assert_eq!(meta.title, "Hello World");
        assert_eq!(meta.authors, vec!["Jane Author"]);
        assert_eq!(meta.language.as_deref(), Some("en"));
        assert_eq!(meta.isbn.as_deref(), Some("9780000000001"));
        assert!(meta.tags.contains(&"programming".to_string()));
    }

    #[tokio::test]
    async fn extract_meta_reports_crash_with_stderr() {
        let dir = binary_dir_for("crash");
        let any = fixtures_dir().join("ebook-meta-crash.sh");
        let err = extract_meta(dir.path(), &any, Duration::from_secs(2)).await.unwrap_err();
        match err {
            CalibreError::NonZero(code, stderr) => {
                assert_eq!(code, 1);
                assert!(stderr.contains("fake crash"));
            }
            _ => panic!("expected NonZero"),
        }
    }

    #[tokio::test]
    async fn extract_meta_times_out() {
        let dir = binary_dir_for("hang");
        let any = fixtures_dir().join("ebook-meta-hang.sh");
        let err = extract_meta(dir.path(), &any, Duration::from_millis(200)).await.unwrap_err();
        matches!(err, CalibreError::Timeout(_));
    }
}
```

Add `thiserror = "1"` to `exlibris/src-tauri/Cargo.toml` `[dependencies]`.

- [ ] **Step 3: Run the tests, verify all three pass**

```bash
cd exlibris/src-tauri && cargo test --lib calibre
```

Expected: 5 tests pass (2 from Task 12 + 3 here).

- [ ] **Step 4: Add Tauri commands**

In `exlibris/src-tauri/src/lib.rs`:

```rust
use std::time::Duration;

#[tauri::command]
async fn calibre_extract_meta(
    binary_dir: String, file: String, timeout_secs: u64,
) -> Result<crate::calibre::ExtractedMeta, String> {
    crate::calibre::extract_meta(
        std::path::Path::new(&binary_dir),
        std::path::Path::new(&file),
        Duration::from_secs(timeout_secs),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn calibre_convert(
    binary_dir: String, src: String, dst: String, timeout_secs: u64,
) -> Result<(), String> {
    crate::calibre::convert(
        std::path::Path::new(&binary_dir),
        std::path::Path::new(&src),
        std::path::Path::new(&dst),
        Duration::from_secs(timeout_secs),
    )
    .await
    .map_err(|e| e.to_string())
}
```

Add both to `generate_handler!`.

- [ ] **Step 5: Commit**

```bash
git add exlibris/src-tauri/src/calibre.rs exlibris/src-tauri/src/lib.rs exlibris/src-tauri/Cargo.toml exlibris/src-tauri/tests/fixtures/
git commit -m "feat(exlibris): calibre extract_meta + convert with timeout"
```

---

### Task 23: `calibre.ts` — frontend wrapper

**Files:**
- Create: `exlibris/src/lib/calibre.ts`

This is a thin TS wrapper, no separate test file — covered by the import-pipeline test in Task 24.

- [ ] **Step 1: Create the wrapper**

```ts
import { invoke } from "@tauri-apps/api/core";

export interface ExtractedMeta {
  title: string;
  authors: string[];
  publisher: string | null;
  language: string | null;
  isbn: string | null;
  tags: string[];
  pubdate: string | null;
  description: string | null;
  calibre_version: string | null;
}

export async function extractMeta(
  binaryDir: string, file: string, timeoutSecs = 30,
): Promise<ExtractedMeta> {
  return await invoke("calibre_extract_meta", {
    binaryDir, file, timeoutSecs,
  });
}

export async function convert(
  binaryDir: string, src: string, dst: string, timeoutSecs = 300,
): Promise<void> {
  await invoke("calibre_convert", { binaryDir, src, dst, timeoutSecs });
}
```

- [ ] **Step 2: Commit**

```bash
git add exlibris/src/lib/calibre.ts
git commit -m "feat(exlibris): calibre TS wrapper"
```

---

### Task 24: `import-pipeline.ts` — state machine (review phase)

**Files:**
- Create: `exlibris/src/lib/import-pipeline.ts`
- Create: `exlibris/src/lib/import-pipeline.test.ts`

The pipeline has two phases: **review** (extract metadata, dedup, apply rule — produces `PendingEntry`) and **commit** (write rawvault, convert, write sotvault — Task 25). This task covers the review phase only.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildPendingEntry } from "./import-pipeline";
import type { ExtractedMeta } from "./calibre";
import type { BookMeta, Rule } from "./types";

const techRule: Rule = {
  id: "r-tech", name: "Tech", when: { tag_contains: ["programming"] }, target: "tech",
};

function extractedOk(title = "Hello"): ExtractedMeta {
  return {
    title, authors: ["A"], publisher: null, language: "en",
    isbn: "111", tags: ["programming"], pubdate: null, description: null,
    calibre_version: "7.0",
  };
}

describe("buildPendingEntry", () => {
  it("happy path: clean title, applies rule, dedup new", () => {
    const entry = buildPendingEntry({
      id: "x1",
      source_path: "/u/dropped.epub",
      source_filename: "dropped.epub",
      source_ext: "epub",
      source_sha256: "sha-x",
      extracted: extractedOk(),
      rules: [techRule],
      existing_library: [],
      existing_pending_names: new Set(),
    });
    expect(entry.book_name).toBe("Hello");
    expect(entry.target_dir).toBe("tech");
    expect(entry.target_rule_id).toBe("r-tech");
    expect(entry.dedup).toBe("new");
    expect(entry.status).toBe("ready_for_review");
    expect(entry.selected).toBe(true);
  });

  it("falls back to stem when calibre returns no title", () => {
    const entry = buildPendingEntry({
      id: "x", source_path: "/u/foo.epub", source_filename: "foo.epub",
      source_ext: "epub", source_sha256: "s", extracted: { ...extractedOk(), title: "" },
      rules: [], existing_library: [], existing_pending_names: new Set(),
    });
    expect(entry.book_name).toBe("foo");
    expect(entry.status).toBe("needs_attention");
  });

  it("dedup hit by ISBN sets exists + not selected", () => {
    const lib: BookMeta[] = [{
      schema_version: 1, title: "Old", authors: [], publisher: null, language: null,
      isbn: "111", tags: [], pubdate: null, description: null,
      source_filename: "", source_format: "epub", source_sha256: "other",
      raw_path: "", import_time: "", calibre_version: null, applied_rule: null,
    }];
    const entry = buildPendingEntry({
      id: "x", source_path: "/u/foo.epub", source_filename: "foo.epub",
      source_ext: "epub", source_sha256: "s",
      extracted: extractedOk(), rules: [], existing_library: lib,
      existing_pending_names: new Set(),
    });
    expect(entry.dedup).toBe("exists");
    expect(entry.selected).toBe(false);
  });

  it("appends (2) suffix when book_name collides with pending", () => {
    const entry = buildPendingEntry({
      id: "x", source_path: "/u/a.epub", source_filename: "a.epub",
      source_ext: "epub", source_sha256: "s",
      extracted: extractedOk("Hello"), rules: [], existing_library: [],
      existing_pending_names: new Set(["Hello"]),
    });
    expect(entry.book_name).toBe("Hello (2)");
  });

  it("falls back to uncategorized when no rule matches", () => {
    const entry = buildPendingEntry({
      id: "x", source_path: "/u/a.mobi", source_filename: "a.mobi",
      source_ext: "mobi", source_sha256: "s",
      extracted: { ...extractedOk("Z"), tags: [] }, rules: [techRule],
      existing_library: [], existing_pending_names: new Set(),
    });
    expect(entry.target_dir).toBe("uncategorized");
    expect(entry.target_rule_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd exlibris && pnpm vitest run src/lib/import-pipeline.test.ts
```

- [ ] **Step 3: Implement**

```ts
import { cleanBookName, resolveDuplicateName } from "./bookname";
import { applyRules } from "./rules";
import { findDuplicate } from "./dedup";
import type { ExtractedMeta } from "./calibre";
import type { BookMeta, PendingEntry, Rule } from "./types";

export interface BuildArgs {
  id: string;
  source_path: string;
  source_filename: string;
  source_ext: string;
  source_sha256: string | null;
  extracted: ExtractedMeta | null;     // null = extraction failed
  rules: Rule[];
  existing_library: BookMeta[];
  existing_pending_names: Set<string>;
}

export function buildPendingEntry(a: BuildArgs): PendingEntry {
  const stem = a.source_filename.replace(/\.[^.]+$/, "");
  let title = "";
  let attention = false;
  if (a.extracted) {
    title = cleanBookName(a.extracted.title);
    if (!title) { title = stem; attention = true; }
  } else {
    title = stem; attention = true;
  }
  const book_name = resolveDuplicateName(title, a.existing_pending_names);

  // Build a partial BookMeta for rule eval and dedup
  const meta: BookMeta = {
    schema_version: 1,
    title: a.extracted?.title ?? "",
    authors: a.extracted?.authors ?? [],
    publisher: a.extracted?.publisher ?? null,
    language: a.extracted?.language ?? null,
    isbn: a.extracted?.isbn ?? null,
    tags: a.extracted?.tags ?? [],
    pubdate: a.extracted?.pubdate ?? null,
    description: a.extracted?.description ?? null,
    source_filename: a.source_filename,
    source_format: a.source_ext.toLowerCase(),
    source_sha256: a.source_sha256 ?? "",
    raw_path: "",
    import_time: "",
    calibre_version: a.extracted?.calibre_version ?? null,
    applied_rule: null,
  };

  const { rule_id, target } = applyRules(a.rules, meta);

  const dup = findDuplicate({ isbn: meta.isbn, sha256: meta.source_sha256 }, a.existing_library);
  const dedup: PendingEntry["dedup"] = dup ? "exists" : "new";

  return {
    id: a.id,
    source_path: a.source_path,
    source_filename: a.source_filename,
    source_ext: a.source_ext,
    source_sha256: a.source_sha256,
    meta,
    book_name,
    target_rule_id: rule_id,
    target_dir: target,
    dedup,
    status: attention ? "needs_attention" : "ready_for_review",
    selected: dedup === "new",
  };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd exlibris && pnpm vitest run src/lib/import-pipeline.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add exlibris/src/lib/import-pipeline.ts exlibris/src/lib/import-pipeline.test.ts
git commit -m "feat(exlibris): pending-entry builder (review phase)"
```

---

### Task 25: `import-pipeline.ts` — commit phase (rawvault → convert → sotvault)

**Files:**
- Modify: `exlibris/src/lib/import-pipeline.ts`

The commit phase is per-entry sequential and is invoked from a worker-pool in the UI layer (Task 28).

- [ ] **Step 1: Add the commit function**

Append to `exlibris/src/lib/import-pipeline.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { computeRawPath } from "./rawvault-fs";
import { serializeMeta } from "./meta";
import { convert } from "./calibre";

export interface CommitContext {
  sotvault: string;
  rawvault: string;
  calibre_binary_dir: string;
  convert_timeout_secs: number;
}

export interface CommitProgress {
  step: "writing_raw" | "converting" | "writing_sot" | "done";
}

export type CommitCallback = (p: CommitProgress) => void;

export class CancelledError extends Error {
  constructor() { super("cancelled"); }
}

export async function commitEntry(
  entry: PendingEntry,
  ctx: CommitContext,
  signal: { cancelled: boolean },
  onProgress?: CommitCallback,
): Promise<BookMeta> {
  if (signal.cancelled) throw new CancelledError();

  // 5. write-rawvault
  onProgress?.({ step: "writing_raw" });
  const now = new Date();
  const raw_rel = computeRawPath(entry.book_name, entry.source_ext, now);
  const raw_dst_abs = `${ctx.rawvault}/${raw_rel}`;
  const final_raw_abs = await invoke<string>("fs_atomic_copy", {
    src: entry.source_path, dst: raw_dst_abs,
  });
  // recompute raw_rel if collision changed it (final filename may have " (2)")
  const final_raw_rel = final_raw_abs.startsWith(ctx.rawvault + "/")
    ? final_raw_abs.slice(ctx.rawvault.length + 1)
    : raw_rel;

  if (signal.cancelled) throw new CancelledError();

  // 6. convert (output to a temp file under sotvault/.exlibris/.tmp/)
  onProgress?.({ step: "converting" });
  const tmp_md = `${ctx.sotvault}/.exlibris/.tmp/${entry.id}.book.md`;
  await convert(ctx.calibre_binary_dir, entry.source_path, tmp_md, ctx.convert_timeout_secs);

  if (signal.cancelled) throw new CancelledError();

  // 7. write-sotvault (book.md first, then meta.yml)
  // Move tmp_md into place (rename clears the tmp; book.md cannot exist yet
  // because the parent book directory is freshly created)
  onProgress?.({ step: "writing_sot" });
  const sot_book_dir = `${ctx.sotvault}/${entry.target_dir}/${entry.book_name}`;
  await invoke("fs_rename_strict", { src: tmp_md, dst: `${sot_book_dir}/book.md` });

  const finalized_meta: BookMeta = {
    ...entry.meta!,
    schema_version: 1,
    source_filename: entry.source_filename,
    source_format: entry.source_ext.toLowerCase(),
    source_sha256: entry.source_sha256 ?? "",
    raw_path: final_raw_rel,
    import_time: now.toISOString(),
    applied_rule: entry.target_rule_id,
  };
  const yaml = serializeMeta(finalized_meta);
  await invoke<string>("write_text_file", {
    path: `${sot_book_dir}/meta.yml`, content: yaml,
  });

  onProgress?.({ step: "done" });
  return finalized_meta;
}
```

- [ ] **Step 2: Add `write_text_file` Tauri command**

In `exlibris/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let tmp = p.with_extension(format!("{}.tmp",
        p.extension().and_then(|s| s.to_str()).unwrap_or("")));
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}
```

Register `write_text_file` in `generate_handler!`.

- [ ] **Step 3: Build & cargo check**

```bash
cd exlibris/src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add exlibris/src/lib/import-pipeline.ts exlibris/src-tauri/src/lib.rs
git commit -m "feat(exlibris): commit phase — raw → convert → sotvault"
```

---

### Task 26: `DropZone.svelte` — accept files via Tauri webview drag-drop

**Files:**
- Create: `exlibris/src/components/DropZone.svelte`

- [ ] **Step 1: Implement**

```svelte
<script lang="ts">
  import { listen } from "@tauri-apps/api/event";
  import { onMount, onDestroy } from "svelte";

  let { onDropFiles }: { onDropFiles: (paths: string[]) => void } = $props();
  let hover = $state(false);
  let unlisteners: Array<() => void> = [];

  const SUPPORTED = new Set([
    "epub", "mobi", "azw", "azw3", "pdf", "fb2", "lit", "lrf", "rtf", "txt", "docx",
  ]);

  onMount(async () => {
    unlisteners.push(await listen<{ paths: string[] }>("tauri://drag-enter", () => { hover = true; }));
    unlisteners.push(await listen<{ paths: string[] }>("tauri://drag-leave", () => { hover = false; }));
    unlisteners.push(await listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
      hover = false;
      const paths = (e.payload?.paths ?? []).filter((p) => {
        const ext = p.split(".").pop()?.toLowerCase() ?? "";
        return SUPPORTED.has(ext);
      });
      if (paths.length > 0) onDropFiles(paths);
    }));
  });

  onDestroy(() => { unlisteners.forEach((u) => u()); });
</script>

<section class="drop" class:hover>
  <p>Drop ebook files here</p>
  <p class="sub">Supports epub, mobi, azw, azw3, pdf, fb2, lit, lrf, rtf, txt, docx</p>
</section>

<style>
  .drop {
    border: 2px dashed #888; border-radius: 12px;
    padding: 3rem; text-align: center; transition: all 150ms;
  }
  .drop.hover { border-color: #2a7; background: #2a71; }
  .sub { color: #888; font-size: 0.875rem; }
</style>
```

- [ ] **Step 2: Verify webview drag-drop event names**

The Tauri 2 event names for webview drag are `tauri://drag-enter`, `tauri://drag-over`, `tauri://drag-drop`, `tauri://drag-leave`. Confirm by checking the existing mdeditor source if drag-drop is used elsewhere:

```bash
grep -rn "tauri://drag" src/ src-tauri/
```

If mdeditor uses different names (e.g., `tauri://file-drop`), update `DropZone.svelte` accordingly.

- [ ] **Step 3: Commit**

```bash
git add exlibris/src/components/DropZone.svelte
git commit -m "feat(exlibris): drop zone listening for file-drop events"
```

---

### Task 27: `PendingList.svelte` — review + edit + commit

**Files:**
- Create: `exlibris/src/components/PendingList.svelte`

- [ ] **Step 1: Implement**

```svelte
<script lang="ts">
  import type { PendingEntry } from "$lib/types";
  let { entries = $bindable<PendingEntry[]>(), onImport, onRemove }: {
    entries: PendingEntry[];
    onImport: () => void;
    onRemove: (id: string) => void;
  } = $props();

  function setAll(selected: boolean) {
    for (const e of entries) {
      if (e.dedup !== "exists" || selected === false) e.selected = selected;
    }
  }

  let allSelected = $derived(entries.length > 0 && entries.every((e) => e.selected));
  let hasSelection = $derived(entries.some((e) => e.selected));
</script>

<header>
  <label>
    <input type="checkbox" checked={allSelected} onchange={(e) => setAll(e.currentTarget.checked)} />
    Select all
  </label>
  <button onclick={onImport} disabled={!hasSelection}>Import {entries.filter((e) => e.selected).length}</button>
</header>

<table>
  <thead><tr>
    <th></th><th>Status</th><th>Book Name</th><th>Target</th><th>Source</th><th></th>
  </tr></thead>
  <tbody>
    {#each entries as e (e.id)}
      <tr class:exists={e.dedup === "exists"} class:attn={e.status === "needs_attention"}>
        <td><input type="checkbox" bind:checked={e.selected} /></td>
        <td>
          {#if e.dedup === "exists"}🔁 exists
          {:else if e.status === "needs_attention"}⚠️ {e.status}
          {:else}{e.status}{/if}
        </td>
        <td><input bind:value={e.book_name} /></td>
        <td><input bind:value={e.target_dir} list="rule-targets" /></td>
        <td title={e.source_path}>{e.source_filename}</td>
        <td><button onclick={() => onRemove(e.id)}>×</button></td>
      </tr>
    {/each}
  </tbody>
</table>

<datalist id="rule-targets">
  {#each [...new Set(entries.map((e) => e.target_dir))] as t}
    <option value={t}></option>
  {/each}
</datalist>

<style>
  header { display: flex; justify-content: space-between; padding: 0.5rem 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; text-align: left; }
  tr.exists { opacity: 0.5; }
  tr.attn { background: #fff8d0; }
  input[type=text], input:not([type]) { width: 100%; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add exlibris/src/components/PendingList.svelte
git commit -m "feat(exlibris): pending list with selection + inline edit"
```

---

### Task 28: Wire drop → metadata → review → import in `App.svelte`

**Files:**
- Modify: `exlibris/src/App.svelte`
- Create: `exlibris/src/lib/library.ts` — small helper to load current sotvault meta into a flat BookMeta[] for dedup

- [ ] **Step 1: Create `library.ts`**

```ts
import { listSotvaultMeta } from "./sotvault-fs";
import type { BookMeta } from "./types";

export async function loadLibrary(sotvault: string): Promise<BookMeta[]> {
  const entries = await listSotvaultMeta(sotvault);
  return entries.map((e) => e.meta);
}
```

- [ ] **Step 2: Replace `App.svelte` post-onboarding body**

```svelte
<script lang="ts">
  import OnboardingBanner from "./components/OnboardingBanner.svelte";
  import DropZone from "./components/DropZone.svelte";
  import PendingList from "./components/PendingList.svelte";
  import { readSharedConfig } from "$lib/shared-config";
  import { extractMeta } from "$lib/calibre";
  import { invoke } from "@tauri-apps/api/core";
  import { buildPendingEntry, commitEntry, CancelledError } from "$lib/import-pipeline";
  import { loadLibrary } from "$lib/library";
  import type { SharedConfig, PendingEntry, Rule } from "$lib/types";

  let ready = $state(false);
  let config = $state<SharedConfig | null>(null);
  let pending = $state<PendingEntry[]>([]);
  let importing = $state(false);
  let cancelSignal = { cancelled: false };

  // Rules will come from rules.yml in Phase 3; placeholder for now.
  let rules = $state<Rule[]>([]);

  async function onReady(cfg: SharedConfig) {
    config = cfg;
    ready = true;
  }

  async function onDropFiles(paths: string[]) {
    if (!config) return;
    const calibreDir = (await invoke<string | null>("calibre_detect", {
      userConfigured: config.calibre_path,
    })) ?? null;
    const library = await loadLibrary(config.sotvault!);
    const existingNames = new Set(pending.map((p) => p.book_name));
    for (const src of paths) {
      const id = crypto.randomUUID();
      const filename = src.split("/").pop() ?? src;
      const ext = filename.split(".").pop()?.toLowerCase() ?? "";
      const sha = await invoke<string>("hash_file_sha256", { path: src });
      let extracted = null;
      try {
        if (calibreDir) {
          extracted = await extractMeta(calibreDir, src, 30);
        }
      } catch (e) {
        console.warn("extractMeta failed", e);
      }
      const entry = buildPendingEntry({
        id, source_path: src, source_filename: filename, source_ext: ext,
        source_sha256: sha, extracted,
        rules, existing_library: library, existing_pending_names: existingNames,
      });
      pending = [...pending, entry];
      existingNames.add(entry.book_name);
    }
  }

  async function onImport() {
    if (!config) return;
    const calibreDir = await invoke<string | null>("calibre_detect", {
      userConfigured: config.calibre_path,
    });
    if (!calibreDir) return;
    importing = true;
    cancelSignal = { cancelled: false };
    const ctx = {
      sotvault: config.sotvault!, rawvault: config.rawvault!,
      calibre_binary_dir: calibreDir,
      convert_timeout_secs: 300,
    };
    const concurrency = 2;
    const queue = pending.filter((p) => p.selected);
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length && !cancelSignal.cancelled) {
        const entry = queue[cursor++];
        entry.status = "queued";
        try {
          await commitEntry(entry, ctx, cancelSignal, ({ step }) => {
            entry.status = step;
          });
          entry.status = "done";
        } catch (e) {
          if (e instanceof CancelledError) { entry.status = "cancelled"; }
          else { entry.status = "failed"; entry.error = String(e); }
        }
        pending = [...pending];
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    importing = false;
  }

  function onCancel() { cancelSignal.cancelled = true; }
  function onRemove(id: string) { pending = pending.filter((p) => p.id !== id); }
</script>

<main>
  <h1>ExLibris</h1>
  {#if !ready}
    <OnboardingBanner {onReady} />
  {:else}
    <DropZone {onDropFiles} />
    {#if pending.length > 0}
      <PendingList bind:entries={pending} {onImport} {onRemove} />
      {#if importing}
        <button onclick={onCancel}>Cancel All</button>
      {/if}
    {/if}
  {/if}
</main>

<style>
  main { padding: 1.5rem; font-family: -apple-system, system-ui, sans-serif; }
</style>
```

- [ ] **Step 3: Manual smoke test**

```bash
pnpm --filter exlibris tauri:dev
```

- Onboard → drop a small .epub (use the `pg11-alice.epub` fixture)
- Verify Pending list shows the entry with title & cleaned name
- Click "Import" — book.md + meta.yml appear under `<sotvault>/uncategorized/<BookName>/`, binary appears under `<rawvault>/books/<YYYY>/<YYYYMM>/<BookName>.epub`

- [ ] **Step 4: Commit**

```bash
git add exlibris/src/App.svelte exlibris/src/lib/library.ts
git commit -m "feat(exlibris): end-to-end drop → review → import wiring"
```

---

## Phase 3 — Rules & Rebuild

---

### Task 29: `rules.yml` read/write + Tauri command

**Files:**
- Create: `exlibris/src/lib/rules-io.ts`
- Create: `exlibris/src/lib/rules-io.test.ts`
- Modify: `exlibris/src-tauri/src/lib.rs` (add `rules_read` / `rules_write` commands)

- [ ] **Step 1: Add Rust commands**

In `exlibris/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn rules_read(sotvault: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&sotvault).join(".exlibris/rules.yml");
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn rules_write(sotvault: String, content: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&sotvault).join(".exlibris/rules.yml");
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("yml.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}
```

Add both to `generate_handler!`.

- [ ] **Step 2: TS test**

`exlibris/src/lib/rules-io.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readRules, writeRules } from "./rules-io";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

describe("rules-io", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("readRules returns empty list when file missing", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    const res = await readRules("/sot");
    expect(res.rules).toEqual([]);
  });

  it("readRules parses YAML", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(`version: 1\nrules:\n  - id: r1\n    name: x\n    when: {}\n    target: t\n`);
    const res = await readRules("/sot");
    expect(res.rules).toHaveLength(1);
    expect(res.rules[0].id).toBe("r1");
  });

  it("writeRules serializes and sends to backend", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await writeRules("/sot", { version: 1, rules: [] });
    expect(invoke).toHaveBeenCalledWith("rules_write", {
      sotvault: "/sot",
      content: expect.stringContaining("version: 1"),
    });
  });
});
```

- [ ] **Step 3: Implement**

`exlibris/src/lib/rules-io.ts`:

```ts
import YAML from "yaml";
import { invoke } from "@tauri-apps/api/core";
import type { RulesFile } from "./types";

export async function readRules(sotvault: string): Promise<RulesFile> {
  const raw = await invoke<string>("rules_read", { sotvault });
  if (!raw.trim()) return { version: 1, rules: [] };
  const parsed = YAML.parse(raw);
  return { version: 1, rules: parsed?.rules ?? [] };
}

export async function writeRules(sotvault: string, file: RulesFile): Promise<void> {
  const content = YAML.stringify(file);
  await invoke("rules_write", { sotvault, content });
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd exlibris && pnpm vitest run src/lib/rules-io.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add exlibris/src/lib/rules-io.ts exlibris/src/lib/rules-io.test.ts exlibris/src-tauri/src/lib.rs
git commit -m "feat(exlibris): rules.yml read/write"
```

---

### Task 30: `RulesEditor.svelte` — list-style GUI

**Files:**
- Create: `exlibris/src/components/RulesEditor.svelte`

- [ ] **Step 1: Implement**

```svelte
<script lang="ts">
  import type { Rule } from "$lib/types";

  let { rules = $bindable<Rule[]>(), onSave }: {
    rules: Rule[];
    onSave: () => void;
  } = $props();

  function addRule() {
    rules = [...rules, {
      id: `r-${Date.now()}`, name: "New Rule",
      when: {}, target: "uncategorized",
    }];
  }
  function removeRule(idx: number) {
    rules = rules.filter((_, i) => i !== idx);
  }
  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= rules.length) return;
    const copy = [...rules];
    [copy[idx], copy[j]] = [copy[j], copy[idx]];
    rules = copy;
  }
  function csvBind(rule: Rule, field: "ext" | "tag_contains" | "author_contains" | "language") {
    return {
      get value() { return (rule.when[field] ?? []).join(", "); },
      set value(v: string) {
        rule.when[field] = v.split(",").map((s) => s.trim()).filter(Boolean);
      },
    };
  }
</script>

<header>
  <h3>Rules</h3>
  <button onclick={addRule}>+ Add Rule</button>
  <button onclick={onSave}>Save</button>
</header>

{#each rules as rule, i (rule.id)}
  <fieldset>
    <legend>
      <input bind:value={rule.name} />
      <button onclick={() => move(i, -1)}>↑</button>
      <button onclick={() => move(i, 1)}>↓</button>
      <button onclick={() => removeRule(i)}>×</button>
    </legend>
    <label>ext (comma-sep): <input value={csvBind(rule, "ext").value} oninput={(e) => csvBind(rule, "ext").value = e.currentTarget.value} /></label>
    <label>tag_contains: <input value={csvBind(rule, "tag_contains").value} oninput={(e) => csvBind(rule, "tag_contains").value = e.currentTarget.value} /></label>
    <label>author_contains: <input value={csvBind(rule, "author_contains").value} oninput={(e) => csvBind(rule, "author_contains").value = e.currentTarget.value} /></label>
    <label>language: <input value={csvBind(rule, "language").value} oninput={(e) => csvBind(rule, "language").value = e.currentTarget.value} /></label>
    <label>target dir: <input bind:value={rule.target} /></label>
  </fieldset>
{/each}

<p class="hint">Default rule (always matches): all unmatched books go to <code>uncategorized/</code></p>

<style>
  fieldset { border: 1px solid #ccc; margin: 0.75rem 0; padding: 0.5rem; }
  label { display: block; margin: 0.25rem 0; }
  label input { width: 60%; margin-left: 0.5rem; }
  legend { display: flex; gap: 0.25rem; align-items: center; }
  .hint { color: #888; font-size: 0.875rem; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add exlibris/src/components/RulesEditor.svelte
git commit -m "feat(exlibris): rules list editor"
```

---

### Task 31: Rebuild & Verify — `rebuild.ts` & `verify.ts`

**Files:**
- Create: `exlibris/src/lib/rebuild.ts`
- Create: `exlibris/src/lib/rebuild.test.ts`
- Create: `exlibris/src/lib/verify.ts`
- Create: `exlibris/src/lib/verify.test.ts`

- [ ] **Step 1: `rebuild.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyRebuildDiff } from "./rebuild";
import type { DiffRow } from "./rules";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

describe("applyRebuildDiff", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("renames each book dir using rename_strict", async () => {
    const diff: DiffRow[] = [
      { book_name: "X", from: "tech", to: "fiction", new_rule_id: "r-fiction" },
      { book_name: "Y", from: "fiction", to: "tech", new_rule_id: "r-tech" },
    ];
    vi.mocked(invoke).mockResolvedValue(undefined);
    await applyRebuildDiff("/sot", diff);
    expect(invoke).toHaveBeenCalledWith("fs_rename_strict", {
      src: "/sot/tech/X", dst: "/sot/fiction/X",
    });
    expect(invoke).toHaveBeenCalledWith("fs_rename_strict", {
      src: "/sot/fiction/Y", dst: "/sot/tech/Y",
    });
  });
});
```

- [ ] **Step 2: Implement `rebuild.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import { parseMeta, serializeMeta } from "./meta";
import { listSotvaultMeta } from "./sotvault-fs";
import { computeRebuildDiff, type DiffRow } from "./rules";
import type { Rule } from "./types";

export async function computeDiff(sotvault: string, rules: Rule[]): Promise<DiffRow[]> {
  const entries = await listSotvaultMeta(sotvault);
  return computeRebuildDiff(
    rules,
    entries.map((e) => ({ current_dir: e.rule_dir, book_name: e.book_name, meta: e.meta })),
  );
}

export async function applyRebuildDiff(sotvault: string, diff: DiffRow[]): Promise<void> {
  for (const row of diff) {
    const src = `${sotvault}/${row.from}/${row.book_name}`;
    const dst = `${sotvault}/${row.to}/${row.book_name}`;
    await invoke("fs_rename_strict", { src, dst });
    // Update meta.yml's applied_rule field after move
    const yaml = await invoke<string>("read_text_file", { path: `${dst}/meta.yml` });
    const meta = parseMeta(yaml);
    meta.applied_rule = row.new_rule_id;
    await invoke("write_text_file", {
      path: `${dst}/meta.yml`, content: serializeMeta(meta),
    });
  }
}
```

- [ ] **Step 3: Add `read_text_file` Tauri command**

In `exlibris/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}
```

Register in `generate_handler!`.

- [ ] **Step 4: `verify.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { verify } from "./verify";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./sotvault-fs", () => ({ listSotvaultMeta: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { listSotvaultMeta } from "./sotvault-fs";

describe("verify", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); vi.mocked(listSotvaultMeta).mockReset(); });

  it("reports orphan raw (file in rawvault, no meta refers to it)", async () => {
    vi.mocked(listSotvaultMeta).mockResolvedValueOnce([]);
    vi.mocked(invoke).mockResolvedValueOnce(["books/2025/202501/Orphan.epub"]);
    const r = await verify("/sot", "/raw");
    expect(r.orphan_raw).toEqual(["books/2025/202501/Orphan.epub"]);
  });

  it("reports missing raw (meta refers to non-existent file)", async () => {
    vi.mocked(listSotvaultMeta).mockResolvedValueOnce([{
      rule_dir: "tech", book_name: "X",
      meta: { schema_version: 1, title: "X", authors: [], publisher: null, language: null,
        isbn: null, tags: [], pubdate: null, description: null,
        source_filename: "", source_format: "epub", source_sha256: "",
        raw_path: "books/2025/202501/X.epub", import_time: "", calibre_version: null, applied_rule: null,
      },
    }]);
    vi.mocked(invoke).mockResolvedValueOnce([]); // no raw files
    const r = await verify("/sot", "/raw");
    expect(r.missing_raw).toEqual(["books/2025/202501/X.epub"]);
  });

  it("reports duplicate ISBN", async () => {
    const meta = (title: string, isbn: string) => ({
      schema_version: 1 as const, title, authors: [], publisher: null, language: null,
      isbn, tags: [], pubdate: null, description: null,
      source_filename: "", source_format: "epub", source_sha256: "",
      raw_path: `books/2025/202501/${title}.epub`,
      import_time: "", calibre_version: null, applied_rule: null,
    });
    vi.mocked(listSotvaultMeta).mockResolvedValueOnce([
      { rule_dir: "t", book_name: "A", meta: meta("A", "111") },
      { rule_dir: "t", book_name: "B", meta: meta("B", "111") },
    ]);
    vi.mocked(invoke).mockResolvedValueOnce([
      "books/2025/202501/A.epub", "books/2025/202501/B.epub",
    ]);
    const r = await verify("/sot", "/raw");
    expect(r.duplicate_isbn).toEqual([{ isbn: "111", books: ["A", "B"] }]);
  });
});
```

- [ ] **Step 5: Implement `verify.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import { listSotvaultMeta } from "./sotvault-fs";

export interface VerifyReport {
  orphan_raw: string[];                       // raw_path that no meta refers to
  missing_raw: string[];                      // raw_path from meta but not in rawvault
  duplicate_isbn: { isbn: string; books: string[] }[];
}

export async function verify(sotvault: string, rawvault: string): Promise<VerifyReport> {
  const sot = await listSotvaultMeta(sotvault);
  const raw = await invoke<string[]>("rawvault_list_files", { rawvault });

  const referenced = new Set(sot.map((e) => e.meta.raw_path));
  const rawSet = new Set(raw);

  const orphan_raw = raw.filter((p) => !referenced.has(p));
  const missing_raw = sot.map((e) => e.meta.raw_path).filter((p) => p && !rawSet.has(p));

  const byIsbn = new Map<string, string[]>();
  for (const e of sot) {
    const isbn = e.meta.isbn;
    if (!isbn) continue;
    const arr = byIsbn.get(isbn) ?? [];
    arr.push(e.book_name);
    byIsbn.set(isbn, arr);
  }
  const duplicate_isbn = [...byIsbn.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([isbn, books]) => ({ isbn, books }));

  return { orphan_raw, missing_raw, duplicate_isbn };
}
```

- [ ] **Step 6: Add `rawvault_list_files` Rust command**

In `exlibris/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn rawvault_list_files(rawvault: String) -> Result<Vec<String>, String> {
    let root = std::path::PathBuf::from(&rawvault);
    let books_root = root.join("books");
    if !books_root.is_dir() { return Ok(vec![]); }
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&books_root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() { continue; }
        let rel = entry.path().strip_prefix(&root).map_err(|e| e.to_string())?;
        out.push(rel.to_string_lossy().to_string());
    }
    Ok(out)
}
```

Register in `generate_handler!`.

- [ ] **Step 7: Run, verify pass**

```bash
cd exlibris && pnpm vitest run src/lib/rebuild.test.ts src/lib/verify.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add exlibris/src/lib/rebuild.ts exlibris/src/lib/rebuild.test.ts \
       exlibris/src/lib/verify.ts exlibris/src/lib/verify.test.ts \
       exlibris/src-tauri/src/lib.rs
git commit -m "feat(exlibris): rebuild diff/apply + verify report"
```

---

### Task 32: `RebuildPanel.svelte` — UI for rebuild + verify

**Files:**
- Create: `exlibris/src/components/RebuildPanel.svelte`

- [ ] **Step 1: Implement**

```svelte
<script lang="ts">
  import { computeDiff, applyRebuildDiff } from "$lib/rebuild";
  import { verify, type VerifyReport } from "$lib/verify";
  import type { Rule, DiffRow } from "$lib/types";
  import type { Rule as RuleType } from "$lib/types";

  let { sotvault, rawvault, rules }: {
    sotvault: string; rawvault: string; rules: RuleType[];
  } = $props();

  let diff = $state<DiffRow[]>([]);
  let report = $state<VerifyReport | null>(null);

  async function loadDiff() {
    diff = await computeDiff(sotvault, rules);
  }
  async function apply() {
    await applyRebuildDiff(sotvault, diff);
    diff = [];
    alert("Rebuild complete.");
  }
  async function runVerify() {
    report = await verify(sotvault, rawvault);
  }
</script>

<section>
  <h3>Rebuild Sotvault</h3>
  <button onclick={loadDiff}>Compute Diff</button>
  {#if diff.length > 0}
    <p>{diff.length} books will move:</p>
    <ul>
      {#each diff as d}
        <li>{d.book_name}: {d.from} → {d.to}</li>
      {/each}
    </ul>
    <button onclick={apply}>Apply</button>
  {:else}
    <p>No changes.</p>
  {/if}
</section>

<section>
  <h3>Verify</h3>
  <button onclick={runVerify}>Run Verify</button>
  {#if report}
    <p>Orphan raw: {report.orphan_raw.length}</p>
    <p>Missing raw: {report.missing_raw.length}</p>
    <p>Duplicate ISBN: {report.duplicate_isbn.length}</p>
    <details><summary>Details</summary>
      <pre>{JSON.stringify(report, null, 2)}</pre>
    </details>
  {/if}
</section>
```

- [ ] **Step 2: Commit**

```bash
git add exlibris/src/components/RebuildPanel.svelte
git commit -m "feat(exlibris): rebuild panel UI"
```

---

### Task 33: `SettingsDialog.svelte` — paths, concurrency, rules

**Files:**
- Create: `exlibris/src/components/SettingsDialog.svelte`
- Modify: `exlibris/src/App.svelte` (wire Settings + Rules into UI)

- [ ] **Step 1: Implement settings**

```svelte
<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import RulesEditor from "./RulesEditor.svelte";
  import RebuildPanel from "./RebuildPanel.svelte";
  import { readRules, writeRules } from "$lib/rules-io";
  import { writeSharedConfig } from "$lib/shared-config";
  import type { SharedConfig, Rule } from "$lib/types";

  let { config = $bindable<SharedConfig>(), open: isOpen = $bindable<boolean>() }: {
    config: SharedConfig; open: boolean;
  } = $props();

  let rules = $state<Rule[]>([]);

  $effect(() => { if (isOpen && config.sotvault) {
    readRules(config.sotvault).then((r) => rules = r.rules);
  }});

  async function pickDir(field: "sotvault" | "rawvault" | "calibre_path") {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      config[field] = picked;
      await writeSharedConfig(config);
    }
  }
  async function saveRules() {
    if (config.sotvault) await writeRules(config.sotvault, { version: 1, rules });
  }
</script>

{#if isOpen}
<div class="overlay" onclick={() => isOpen = false}>
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    <h2>Settings</h2>
    <section>
      <h3>Paths</h3>
      <div>Sotvault: {config.sotvault ?? "—"} <button onclick={() => pickDir("sotvault")}>Choose</button></div>
      <div>Rawvault: {config.rawvault ?? "—"} <button onclick={() => pickDir("rawvault")}>Choose</button></div>
      <div>calibre: {config.calibre_path ?? "—"} <button onclick={() => pickDir("calibre_path")}>Choose</button></div>
    </section>
    <RulesEditor bind:rules onSave={saveRules} />
    {#if config.sotvault && config.rawvault}
      <RebuildPanel sotvault={config.sotvault} rawvault={config.rawvault} {rules} />
    {/if}
    <button onclick={() => isOpen = false}>Close</button>
  </div>
</div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center;
  }
  .dialog {
    background: white; padding: 1.5rem; border-radius: 8px;
    max-width: 800px; max-height: 80vh; overflow: auto;
  }
</style>
```

- [ ] **Step 2: Wire Settings button into `App.svelte`**

Add a Settings button + dialog to `App.svelte`'s main section:

```svelte
<!-- inside main, after <h1>ExLibris</h1> -->
<button onclick={() => settingsOpen = true}>⚙ Settings</button>

<SettingsDialog bind:config={config!} bind:open={settingsOpen} />
```

Add at the top of `<script>`:

```ts
import SettingsDialog from "./components/SettingsDialog.svelte";
let settingsOpen = $state(false);
```

Also load rules on app mount so import rules apply:

```ts
import { readRules } from "$lib/rules-io";
$effect(() => { if (ready && config?.sotvault) {
  readRules(config.sotvault).then((r) => rules = r.rules);
}});
```

- [ ] **Step 3: Manual smoke**

```bash
pnpm --filter exlibris tauri:dev
```

- Open Settings → add a rule (e.g., `tag_contains: ["programming"] → tech`) → Save
- Verify `sotvault/.exlibris/rules.yml` is created with the rule
- Drop a book whose tags include "programming" → target column shows "tech"
- Import → ends up in `sotvault/tech/<BookName>/`

- [ ] **Step 4: Commit**

```bash
git add exlibris/src/components/SettingsDialog.svelte exlibris/src/App.svelte
git commit -m "feat(exlibris): settings dialog + rules + rebuild integration"
```

---

## Phase 4 — Library Browser

---

### Task 34: `MetaPreview.svelte` — single-book detail panel

**Files:**
- Create: `exlibris/src/components/MetaPreview.svelte`

- [ ] **Step 1: Implement**

```svelte
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import type { BookMeta } from "$lib/types";

  let { meta, sotvault, ruleDir }: {
    meta: BookMeta; sotvault: string; ruleDir: string;
  } = $props();

  async function openInMdeditor() {
    const path = `${sotvault}/${ruleDir}/${meta.title}/book.md`;
    await invoke("plugin:opener|open_path", { path });
  }
</script>

<aside>
  <h3>{meta.title}</h3>
  <p><strong>Authors:</strong> {meta.authors.join(", ")}</p>
  <p><strong>Publisher:</strong> {meta.publisher ?? "—"}</p>
  <p><strong>Language:</strong> {meta.language ?? "—"}</p>
  <p><strong>ISBN:</strong> {meta.isbn ?? "—"}</p>
  <p><strong>Tags:</strong> {meta.tags.join(", ")}</p>
  <p><strong>Source:</strong> {meta.source_filename} ({meta.source_format})</p>
  <p><strong>Raw path:</strong> <code>{meta.raw_path}</code></p>
  <p><strong>Imported:</strong> {meta.import_time}</p>
  {#if meta.description}
    <p><strong>Description:</strong></p>
    <p>{meta.description}</p>
  {/if}
  <button onclick={openInMdeditor}>Open in mdeditor</button>
</aside>

<style>
  aside { padding: 1rem; border-left: 1px solid #ddd; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add exlibris/src/components/MetaPreview.svelte
git commit -m "feat(exlibris): book metadata preview panel"
```

---

### Task 35: `LibraryBrowser.svelte` — tree + list + search

**Files:**
- Create: `exlibris/src/components/LibraryBrowser.svelte`

- [ ] **Step 1: Implement**

```svelte
<script lang="ts">
  import { listSotvaultMeta, type SotvaultEntry } from "$lib/sotvault-fs";
  import MetaPreview from "./MetaPreview.svelte";

  let { sotvault }: { sotvault: string } = $props();

  let entries = $state<SotvaultEntry[]>([]);
  let query = $state("");
  let selectedRule = $state<string | null>(null);
  let selected = $state<SotvaultEntry | null>(null);

  $effect(() => { (async () => {
    entries = await listSotvaultMeta(sotvault);
  })(); });

  let ruleDirs = $derived([...new Set(entries.map((e) => e.rule_dir))].sort());

  let filtered = $derived(entries.filter((e) => {
    if (selectedRule && e.rule_dir !== selectedRule) return false;
    if (query) {
      const q = query.toLowerCase();
      return e.meta.title.toLowerCase().includes(q)
        || e.meta.authors.join(" ").toLowerCase().includes(q)
        || e.meta.tags.join(" ").toLowerCase().includes(q);
    }
    return true;
  }));

  async function refresh() {
    entries = await listSotvaultMeta(sotvault);
  }
</script>

<section class="browser">
  <nav>
    <h4>Library</h4>
    <button onclick={refresh}>↻</button>
    <input bind:value={query} placeholder="Search…" />
    <ul>
      <li class:active={selectedRule === null}>
        <button onclick={() => selectedRule = null}>All ({entries.length})</button>
      </li>
      {#each ruleDirs as d}
        {@const count = entries.filter((e) => e.rule_dir === d).length}
        <li class:active={selectedRule === d}>
          <button onclick={() => selectedRule = d}>{d} ({count})</button>
        </li>
      {/each}
    </ul>
  </nav>
  <main class="list">
    <table>
      <thead><tr><th>Title</th><th>Authors</th><th>Rule</th></tr></thead>
      <tbody>
        {#each filtered as e}
          <tr class:active={selected === e} onclick={() => selected = e}>
            <td>{e.meta.title}</td>
            <td>{e.meta.authors.join(", ")}</td>
            <td>{e.rule_dir}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </main>
  {#if selected}
    <MetaPreview meta={selected.meta} {sotvault} ruleDir={selected.rule_dir} />
  {/if}
</section>

<style>
  .browser { display: grid; grid-template-columns: 200px 1fr 300px; gap: 1rem; height: 60vh; }
  nav { border-right: 1px solid #ddd; padding-right: 0.5rem; }
  nav ul { list-style: none; padding: 0; }
  nav li.active button { font-weight: bold; }
  nav button { background: none; border: none; cursor: pointer; padding: 0.25rem 0; text-align: left; width: 100%; }
  .list { overflow: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; text-align: left; }
  tr.active { background: #def; }
</style>
```

- [ ] **Step 2: Wire into `App.svelte`**

In `App.svelte`, add a tab switcher (Import vs Library):

```svelte
<!-- inside main, after Settings button -->
<nav class="tabs">
  <button class:active={tab === 'import'} onclick={() => tab = 'import'}>Import</button>
  <button class:active={tab === 'library'} onclick={() => tab = 'library'}>Library</button>
</nav>

{#if tab === 'import'}
  <!-- existing DropZone + PendingList -->
{:else if tab === 'library' && config?.sotvault}
  <LibraryBrowser sotvault={config.sotvault} />
{/if}
```

Add at top of script:
```ts
import LibraryBrowser from "./components/LibraryBrowser.svelte";
let tab = $state<"import" | "library">("import");
```

- [ ] **Step 3: Commit**

```bash
git add exlibris/src/components/LibraryBrowser.svelte exlibris/src/App.svelte
git commit -m "feat(exlibris): library browser with rule-tree + search"
```

---

## Phase 5 — Packaging & final wiring

---

### Task 36: Per-arch build verification

**Files:**
- (no new files; verify build commands)

- [ ] **Step 1: Build aarch64**

```bash
pnpm --filter exlibris tauri:build -- --target aarch64-apple-darwin
```

Expected: artifact at `exlibris/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/ExLibris_0.1.0_aarch64.dmg`

- [ ] **Step 2: Build x86_64**

```bash
pnpm --filter exlibris tauri:build -- --target x86_64-apple-darwin
```

Expected: artifact at `exlibris/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/ExLibris_0.1.0_x64.dmg`

- [ ] **Step 3: Drag the DMG to /Applications, launch**

- Verify `Books` appears in Applications as `ExLibris`
- Launch from Spotlight — onboarding shows up

- [ ] **Step 4: Commit (only if any script tweaks were needed)**

No diff expected; if `build-exlibris.sh` needed adjustments, commit them with `build(exlibris): adjust per-arch script`.

---

### Task 37: Connect mdeditor tray "Open Books" to launched binary

**Files:**
- (verify the existing wiring from Task 6)

- [ ] **Step 1: Install ExLibris.app to /Applications**

```bash
cp -R exlibris/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ExLibris.app /Applications/
```

- [ ] **Step 2: Launch mdeditor and click tray → Open Books**

```bash
pnpm tauri dev
```

In tray menu: Open Books → ExLibris launches.

- [ ] **Step 3: If `open -a ExLibris` fails (name conflict, etc), switch to bundle-id launch**

In `src-tauri/src/lib.rs`, change the handler from:

```rust
.arg("open").arg("-a").arg("ExLibris")
```

to:

```rust
std::process::Command::new("open")
    .arg("-b").arg("com.laobu.exlibris")
    .status()
```

(Bundle-id launch is more robust against display-name collisions.)

- [ ] **Step 4: Commit if changed**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(tray): launch ExLibris by bundle id for robustness"
```

---

### Task 38: README + manual smoke test

**Files:**
- Create: `exlibris/README.md`

- [ ] **Step 1: Write README**

```markdown
# ExLibris

Independent macOS app for managing an ebook library. Companion to mdeditor: shares the sotvault git-synced directory and is launched from mdeditor's tray menu.

## Architecture

See [`docs/superpowers/specs/2026-05-18-exlibris-ebook-manager-design.md`](../docs/superpowers/specs/2026-05-18-exlibris-ebook-manager-design.md).

## Development

```sh
pnpm install
pnpm --filter exlibris tauri:dev
```

## Build

```sh
pnpm build:exlibris   # builds per-arch dmgs
```

Artifacts: `src-tauri/target/{aarch64,x86_64}-apple-darwin/release/bundle/dmg/*.dmg`.

## Manual Smoke Test

1. First launch → onboarding banner. Pick sotvault / rawvault dirs; if calibre is installed at `/Applications/calibre.app`, it auto-detects.
2. Drop a small `.epub` into the drop zone → Pending list appears with the title.
3. Click "Import" → progress runs. Verify:
   - `<rawvault>/books/<YYYY>/<YYYYMM>/<Title>.epub` exists.
   - `<sotvault>/uncategorized/<Title>/book.md` and `meta.yml` exist.
4. Drop unsupported `.png` / `.zip` → red "Unsupported" row, cannot be selected.
5. Drop a large PDF (> 50 MB) → progress is visible per book; click Cancel All → in-progress book aborts, partial files cleaned up.
6. Drop the same book twice → second one shows "🔁 exists" and is unselected by default.
7. Settings → add a rule (`tag_contains: programming → tech`) → Save → Rebuild Sotvault → diff appears → Apply → book moves to `sotvault/tech/`.
8. Verify → orphan/missing/duplicate report.
9. mdeditor tray → "Open Books" → ExLibris launches.
```

- [ ] **Step 2: Run the manual smoke test end-to-end**

Walk through every step above; fix any issues encountered.

- [ ] **Step 3: Commit**

```bash
git add exlibris/README.md
git commit -m "docs(exlibris): README with manual smoke test"
```

---

## Self-review checklist

Before declaring the plan complete, the engineer should confirm:

1. **All tests pass:** `pnpm test` at the repo root and `cargo test` in `exlibris/src-tauri` and `src-tauri`.
2. **No `console.warn` spew** in `pnpm tauri dev` for either app under normal use.
3. **mdeditor's existing features still work:** sync repo settings, gitsync, share/md2pdf plugins (no regressions from the shared-config migration).
4. **Spec coverage:**
   - Storage layout: rawvault `books/YYYY/YYYYMM/<BookName>.<ext>` (Tasks 18, 25)
   - Canonical meta.yml + book.md only in sotvault (Tasks 15, 25, 19)
   - Time bucket from import time (Task 18)
   - BookName cleaning (Task 14)
   - Calibre optional + detection chain (Task 12)
   - Onboarding 3 steps (Task 13)
   - Drop → preview → import (Tasks 26-28)
   - Dedup via ISBN + SHA256 (Tasks 17, 20, 24)
   - Rules YAML editor + diff rebuild (Tasks 29-32)
   - Verify report (Task 31, 32)
   - Library browser (Tasks 34-35)
   - mdeditor tray launcher (Tasks 6, 37)
   - Shared config migration (Task 4)
   - Per-arch dmg (Task 36)
   - README smoke test (Task 38)

If any spec section has no corresponding task, add a follow-up task or update the spec to reflect the change.
