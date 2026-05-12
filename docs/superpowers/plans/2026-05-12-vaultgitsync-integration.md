# VaultGitSync Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate vaultgitsync as a built-in Rust module in mdeditor with tray menu control, real-time file sync to GitHub, and conflict-safe handling.

**Architecture:** A `vault_sync` module inside `src-tauri/src/` manages file watching (notify crate), git operations (git CLI), state, and a log ring buffer. The tray menu is extended with sync controls. A separate lightweight HTML window shows logs.

**Tech Stack:** Rust, Tauri 2, notify crate (FSEvents), std::process::Command (git CLI), tokio

---

## File Structure

```
src-tauri/src/vault_sync/
  mod.rs          - Public API: Tauri commands, init, state types
  service.rs      - Background service lifecycle (start/stop/sync loop)
  watcher.rs      - File system watcher (notify crate)
  git_ops.rs      - Git CLI wrapper (fetch/stash/rebase/push/conflict)
  conflict.rs     - Conflict detection and safe resolution
  log_buffer.rs   - Ring buffer for log entries + event emission

src/vault-sync-log.html  - Standalone log viewer page

Modify:
  src-tauri/src/lib.rs        - Add vault_sync module, tray menu items, commands
  src-tauri/Cargo.toml        - Add notify dependency
  src-tauri/tauri.conf.json   - (optional) register log window
```

---

### Task 1: Add notify dependency and create module skeleton

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/vault_sync/mod.rs`
- Create: `src-tauri/src/vault_sync/log_buffer.rs`
- Create: `src-tauri/src/vault_sync/git_ops.rs`
- Create: `src-tauri/src/vault_sync/watcher.rs`
- Create: `src-tauri/src/vault_sync/service.rs`
- Create: `src-tauri/src/vault_sync/conflict.rs`

- [ ] **Step 1: Add notify to Cargo.toml**

Add under `[dependencies]`:
```toml
notify = { version = "7", default-features = false, features = ["macos_fsevent"] }
```

- [ ] **Step 2: Create mod.rs with state types and command stubs**

```rust
pub mod conflict;
pub mod git_ops;
pub mod log_buffer;
pub mod service;
pub mod watcher;

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use log_buffer::LogBuffer;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    NotConfigured,
    Stopped,
    Running,
    Syncing,
    Conflict,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultSyncStatus {
    pub state: SyncState,
    pub repo_path: Option<String>,
    pub last_sync: Option<String>,
    pub error_message: Option<String>,
}

pub struct VaultSyncManager {
    pub state: Mutex<SyncState>,
    pub repo_path: Mutex<Option<String>>,
    pub remote: String,
    pub branch: String,
    pub logs: LogBuffer,
    pub last_sync: Mutex<Option<String>>,
    pub error_msg: Mutex<Option<String>>,
    pub stop_flag: Mutex<bool>,
}

impl VaultSyncManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SyncState::NotConfigured),
            repo_path: Mutex::new(None),
            remote: "origin".into(),
            branch: "main".into(),
            logs: LogBuffer::new(1000),
            last_sync: Mutex::new(None),
            error_msg: Mutex::new(None),
            stop_flag: Mutex::new(false),
        }
    }
}

#[tauri::command]
pub fn vault_sync_start(app: AppHandle) -> Result<(), String> {
    service::start(&app)
}

#[tauri::command]
pub fn vault_sync_stop(app: AppHandle) -> Result<(), String> {
    service::stop(&app)
}

#[tauri::command]
pub fn vault_sync_now(app: AppHandle) -> Result<(), String> {
    service::sync_once(&app)
}

#[tauri::command]
pub fn vault_sync_status(app: AppHandle) -> VaultSyncStatus {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let state = *mgr.state.lock().unwrap();
    let repo_path = mgr.repo_path.lock().unwrap().clone();
    let last_sync = mgr.last_sync.lock().unwrap().clone();
    let error_message = mgr.error_msg.lock().unwrap().clone();
    VaultSyncStatus { state, repo_path, last_sync, error_message }
}

#[tauri::command]
pub fn vault_sync_logs(app: AppHandle) -> Vec<log_buffer::LogEntry> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    mgr.logs.entries()
}

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    // Read config from settings, set up manager state
    // Called from lib.rs setup
}
```

- [ ] **Step 3: Create log_buffer.rs**

```rust
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

pub struct LogBuffer {
    entries: Mutex<VecDeque<LogEntry>>,
    capacity: usize,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
        }
    }

    pub fn push(&self, level: &str, message: &str) {
        let entry = LogEntry {
            timestamp: now_str(),
            level: level.to_string(),
            message: message.to_string(),
        };
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= self.capacity {
            entries.pop_front();
        }
        entries.push_back(entry);
    }

    pub fn entries(&self) -> Vec<LogEntry> {
        self.entries.lock().unwrap().iter().cloned().collect()
    }
}

fn now_str() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
```

- [ ] **Step 4: Create git_ops.rs stub**

```rust
use std::path::Path;
use std::process::Command;

pub type GitResult<T> = Result<T, String>;

pub fn run_git(repo: &Path, args: &[&str]) -> GitResult<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("git spawn: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

pub fn has_changes(repo: &Path) -> GitResult<bool> {
    let out = run_git(repo, &["status", "--porcelain"])?;
    Ok(!out.trim().is_empty())
}

pub fn fetch(repo: &Path, remote: &str, branch: &str) -> GitResult<()> {
    run_git(repo, &["fetch", remote, branch])?;
    Ok(())
}

pub fn sync(repo: &Path, remote: &str, branch: &str) -> GitResult<()> {
    fetch(repo, remote, branch)?;

    if !has_changes(repo)? {
        let ff = run_git(repo, &["pull", "--ff-only", remote, branch]);
        if ff.is_err() {
            run_git(repo, &["pull", "--rebase", remote, branch])?;
        }
        return Ok(());
    }

    run_git(repo, &["add", "-A"])?;
    run_git(repo, &["stash", "push", "-m", "vaultgitsync-auto"])?;

    let rebase = run_git(repo, &["rebase", &format!("{remote}/{branch}")]);
    if rebase.is_err() {
        let _ = run_git(repo, &["rebase", "--abort"]);
        let _ = run_git(repo, &["stash", "pop"]);
        return Err("rebase failed, skipping cycle".into());
    }

    let pop = run_git(repo, &["stash", "pop"]);
    if pop.is_err() {
        super::conflict::handle_conflicts(repo)?;
    }

    run_git(repo, &["add", "-A"])?;

    if has_changes(repo)? {
        let ts = chrono_now();
        run_git(repo, &["commit", "-m", &format!("vault: auto-sync {ts}")])?;
    }

    let push = run_git(repo, &["push", remote, branch]);
    if let Err(e) = push {
        return Err(format!("push failed (will retry): {e}"));
    }

    Ok(())
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
```

- [ ] **Step 5: Create conflict.rs**

```rust
use std::path::Path;
use super::git_ops::{run_git, GitResult};

pub fn handle_conflicts(repo: &Path) -> GitResult<()> {
    let status = run_git(repo, &["status", "--porcelain"])?;
    let timestamp = ts_now();

    for line in status.lines() {
        if line.starts_with("UU ") || line.starts_with("AA ") {
            let file = line[3..].trim();
            let file_path = repo.join(file);

            if file_path.exists() {
                let conflict_name = make_conflict_name(file, &timestamp);
                let conflict_path = repo.join(&conflict_name);
                let _ = std::fs::copy(&file_path, &conflict_path);
            }

            let _ = run_git(repo, &["checkout", "--theirs", file]);
            let _ = run_git(repo, &["add", file]);
        }
    }

    run_git(repo, &["add", "-A"])?;
    Ok(())
}

fn make_conflict_name(file: &str, timestamp: &str) -> String {
    let path = Path::new(file);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let parent = path.parent().unwrap_or(Path::new(""));
    parent.join(format!("{stem}.conflict.{timestamp}{ext}")).to_string_lossy().to_string()
}

fn ts_now() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
```

- [ ] **Step 6: Create watcher.rs**

```rust
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

pub fn start(repo_path: &Path, tx: mpsc::Sender<()>) -> notify::Result<RecommendedWatcher> {
    let watch_path = repo_path.to_path_buf();
    let filter_path = watch_path.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if should_process(&event, &filter_path) {
                    let _ = tx.send(());
                }
            }
        },
        notify::Config::default().with_poll_interval(Duration::from_secs(2)),
    )?;

    watcher.watch(watch_path.as_ref(), RecursiveMode::Recursive)?;
    Ok(watcher)
}

fn should_process(event: &Event, repo_path: &Path) -> bool {
    let all_git = event.paths.iter().all(|p| {
        p.strip_prefix(repo_path)
            .map(|rel| rel.starts_with(".git"))
            .unwrap_or(false)
    });
    if all_git {
        return false;
    }
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}
```

- [ ] **Step 7: Create service.rs**

```rust
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use super::{git_ops, watcher, LogBuffer, SyncState, VaultSyncManager};

pub fn start(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let repo_path = mgr.repo_path.lock().unwrap().clone()
        .ok_or("Vault sync not configured: no repo_path")?;
    let repo = PathBuf::from(&repo_path);

    if !repo.join(".git").exists() {
        return Err(format!("Not a git repo: {repo_path}"));
    }

    {
        let mut stop = mgr.stop_flag.lock().unwrap();
        *stop = false;
    }
    set_state(app, SyncState::Running);
    mgr.logs.push("INFO", "Sync started");

    let app_handle = app.clone();
    let remote = mgr.remote.clone();
    let branch = mgr.branch.clone();

    std::thread::spawn(move || {
        run_loop(app_handle, repo, remote, branch);
    });

    Ok(())
}

pub fn stop(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    {
        let mut stop = mgr.stop_flag.lock().unwrap();
        *stop = true;
    }
    set_state(app, SyncState::Stopped);
    mgr.logs.push("INFO", "Sync stopped");
    Ok(())
}

pub fn sync_once(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let repo_path = mgr.repo_path.lock().unwrap().clone()
        .ok_or("Not configured")?;
    let repo = PathBuf::from(&repo_path);
    let remote = mgr.remote.clone();
    let branch = mgr.branch.clone();

    do_sync(app, &repo, &remote, &branch);
    Ok(())
}

fn run_loop(app: AppHandle, repo: PathBuf, remote: String, branch: String) {
    let (tx, rx) = mpsc::channel::<()>();

    let _watcher = match watcher::start(&repo, tx.clone()) {
        Ok(w) => w,
        Err(e) => {
            let mgr = app.state::<Arc<VaultSyncManager>>();
            mgr.logs.push("ERROR", &format!("Watcher failed: {e}"));
            set_state(&app, SyncState::Error);
            return;
        }
    };

    // Periodic trigger
    let tx_periodic = tx.clone();
    let stop_flag = {
        let mgr = app.state::<Arc<VaultSyncManager>>();
        Arc::clone(&Arc::new(Mutex::new(false)))
    };

    let app_for_stop = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(30));
            let mgr = app_for_stop.state::<Arc<VaultSyncManager>>();
            if *mgr.stop_flag.lock().unwrap() {
                break;
            }
            let _ = tx_periodic.send(());
        }
    });

    // Main loop: wait for events with debounce
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(_) => {
                // Debounce 2s
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while std::time::Instant::now() < deadline {
                    let _ = rx.recv_timeout(Duration::from_millis(200));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let mgr = app.state::<Arc<VaultSyncManager>>();
                if *mgr.stop_flag.lock().unwrap() {
                    break;
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        let mgr = app.state::<Arc<VaultSyncManager>>();
        if *mgr.stop_flag.lock().unwrap() {
            break;
        }

        do_sync(&app, &repo, &remote, &branch);
    }
}

fn do_sync(app: &AppHandle, repo: &PathBuf, remote: &str, branch: &str) {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    set_state(app, SyncState::Syncing);
    mgr.logs.push("INFO", "Syncing...");

    match git_ops::sync(repo, remote, branch) {
        Ok(()) => {
            let ts = format!("{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default().as_secs());
            *mgr.last_sync.lock().unwrap() = Some(ts);
            *mgr.error_msg.lock().unwrap() = None;
            set_state(app, SyncState::Running);
            mgr.logs.push("INFO", "Sync completed");
        }
        Err(e) => {
            if e.contains("conflict") || e.contains("Conflict") {
                set_state(app, SyncState::Conflict);
                mgr.logs.push("WARN", &format!("Conflict: {e}"));
            } else {
                *mgr.error_msg.lock().unwrap() = Some(e.clone());
                set_state(app, SyncState::Error);
                mgr.logs.push("ERROR", &e);
            }
        }
    }

    let _ = app.emit("vault-sync-log", ());
}

fn set_state(app: &AppHandle, state: SyncState) {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    *mgr.state.lock().unwrap() = state;
    let _ = app.emit("vault-sync-state-changed", state);
}
```

- [ ] **Step 8: Cargo check**

Run: `cd src-tauri && cargo check`
Expected: compiles with possible warnings

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/vault_sync/ src-tauri/Cargo.toml
git commit -m "feat(vault_sync): add module skeleton with git ops, watcher, service"
```

---

### Task 2: Integrate into lib.rs — tray menu and commands

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add module declaration**

At top of lib.rs after existing module declarations:
```rust
pub mod vault_sync;
```

- [ ] **Step 2: Register Tauri commands in invoke_handler**

Add to the `generate_handler![]` macro:
```rust
vault_sync::vault_sync_start,
vault_sync::vault_sync_stop,
vault_sync::vault_sync_now,
vault_sync::vault_sync_status,
vault_sync::vault_sync_logs,
```

- [ ] **Step 3: Add VaultSyncManager to app state in setup**

In the `.setup(|app| { ... })` closure, before plugin_host::init:
```rust
let vault_mgr = std::sync::Arc::new(vault_sync::VaultSyncManager::new());
app.manage(vault_mgr);
vault_sync::init(&app.handle());
```

- [ ] **Step 4: Extend tray menu with sync items**

Replace the tray menu building section (lines ~281-287) with:
```rust
let show_item = MenuItem::with_id(app, "tray-show", "Show M\u{2193}", true, None::<&str>)?;
let sync_status_item = MenuItem::with_id(app, "tray-sync-status", "Vault Sync: Stopped", false, None::<&str>)?;
let sync_start_item = MenuItem::with_id(app, "tray-sync-start", "Start Sync", true, None::<&str>)?;
let sync_stop_item = MenuItem::with_id(app, "tray-sync-stop", "Stop Sync", false, None::<&str>)?;
let sync_now_item = MenuItem::with_id(app, "tray-sync-now", "Sync Now", true, None::<&str>)?;
let sync_log_item = MenuItem::with_id(app, "tray-sync-log", "View Log\u{2026}", true, None::<&str>)?;
let quit_item = MenuItem::with_id(app, "tray-quit", "Quit M\u{2193}", true, None::<&str>)?;

let tray_menu = MenuBuilder::new(app)
    .item(&show_item)
    .separator()
    .item(&sync_status_item)
    .item(&sync_start_item)
    .item(&sync_stop_item)
    .item(&sync_now_item)
    .item(&sync_log_item)
    .separator()
    .item(&quit_item)
    .build()?;
```

- [ ] **Step 5: Handle new tray menu events**

In the `.on_menu_event` closure:
```rust
"tray-show" => show_main_window(app),
"tray-sync-start" => { let _ = vault_sync::vault_sync_start(app.clone()); }
"tray-sync-stop" => { let _ = vault_sync::vault_sync_stop(app.clone()); }
"tray-sync-now" => { let _ = vault_sync::vault_sync_now(app.clone()); }
"tray-sync-log" => { open_sync_log_window(app); }
"tray-quit" => app.exit(0),
```

- [ ] **Step 6: Add open_sync_log_window helper**

```rust
fn open_sync_log_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("sync-log") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "sync-log",
        tauri::WebviewUrl::App("vault-sync-log.html".into()),
    )
    .title("Vault Sync Log")
    .inner_size(600.0, 400.0)
    .build();
}
```

- [ ] **Step 7: Cargo check**

Run: `cd src-tauri && cargo check`

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(vault_sync): integrate tray menu and commands into lib.rs"
```

---

### Task 3: Create log viewer HTML page

**Files:**
- Create: `src/vault-sync-log.html`

- [ ] **Step 1: Create the HTML file**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Vault Sync Log</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 12px;
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 8px;
      height: 100vh;
      overflow: hidden;
    }
    #log {
      height: 100%;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .info { color: #4ec9b0; }
    .warn { color: #dcdcaa; }
    .error { color: #f44747; }
  </style>
</head>
<body>
  <div id="log"></div>
  <script>
    const { listen, invoke } = window.__TAURI_INTERNALS__ 
      ? { listen: window.__TAURI_INTERNALS__.listen, invoke: window.__TAURI_INTERNALS__.invoke }
      : { listen: () => {}, invoke: () => Promise.resolve([]) };

    const logEl = document.getElementById('log');

    function renderEntry(entry) {
      const line = document.createElement('div');
      line.className = entry.level.toLowerCase();
      line.textContent = `[${entry.timestamp}] [${entry.level}] ${entry.message}`;
      return line;
    }

    async function loadLogs() {
      try {
        const entries = await invoke('vault_sync_logs');
        logEl.innerHTML = '';
        entries.forEach(e => logEl.appendChild(renderEntry(e)));
        logEl.scrollTop = logEl.scrollHeight;
      } catch(e) { console.error(e); }
    }

    loadLogs();

    if (window.__TAURI_INTERNALS__) {
      window.__TAURI_INTERNALS__.listen('vault-sync-log', () => {
        loadLogs();
      });
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/vault-sync-log.html
git commit -m "feat(vault_sync): add log viewer HTML page"
```

---

### Task 4: Read config from settings and auto-start

**Files:**
- Modify: `src-tauri/src/vault_sync/mod.rs` (the `init` function)

- [ ] **Step 1: Implement init() to read settings**

```rust
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let config_dir = match app.path().app_config_dir() {
        Ok(p) => p,
        Err(_) => return,
    };
    let settings_path = config_dir.join("settings.json");
    let bytes = match std::fs::read(&settings_path) {
        Ok(b) => b,
        Err(_) => return,
    };
    let v: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return,
    };

    let repo_path = v.get("vault_sync.repo_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if let Some(ref path) = repo_path {
        let mgr = app.state::<Arc<VaultSyncManager>>();
        *mgr.repo_path.lock().unwrap() = Some(path.clone());

        let auto_start = v.get("vault_sync.auto_start")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if auto_start {
            *mgr.state.lock().unwrap() = SyncState::Stopped;
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let _ = service::start(&app_clone);
            });
        } else {
            *mgr.state.lock().unwrap() = SyncState::Stopped;
        }
    }
}
```

- [ ] **Step 2: Add serde_json to vault_sync/mod.rs imports**

Already available via the crate's existing serde_json dependency.

- [ ] **Step 3: Cargo check**

Run: `cd src-tauri && cargo check`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/vault_sync/mod.rs
git commit -m "feat(vault_sync): read config from settings and support auto-start"
```

---

### Task 5: Full build verification

- [ ] **Step 1: Full cargo build**

Run: `cd src-tauri && cargo build`
Expected: successful compilation

- [ ] **Step 2: Fix any remaining warnings/errors**

Address compiler warnings (unused imports, etc.)

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(vault_sync): complete integration build"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Module skeleton + git ops + watcher | `src-tauri/src/vault_sync/*` |
| 2 | lib.rs integration (tray + commands) | `src-tauri/src/lib.rs` |
| 3 | Log viewer HTML | `src/vault-sync-log.html` |
| 4 | Config reading + auto-start | `vault_sync/mod.rs` |
| 5 | Full build verification | all |
