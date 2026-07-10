# AGENTS.md 一等公民（tray 编辑入口 + CLAUDE.md 自动镜像）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vault 根目录 AGENTS.md 成为真相源——tray 一键编辑、任何改动自动镜像为 CLAUDE.md、CLAUDE.md 偏离时弹窗二选一。

**Architecture:** 新建独立 Rust 模块 `src-tauri/src/agents_sync/`（与 `vault_sync` 平级、生命周期解耦）：notify 非递归监听 vault 根目录 + 500ms 防抖，基线 hash 持久化在 app 配置目录 `agents_sync.json`，三态判定为纯函数可单测。tray 菜单项、setup 初始化、vault 路径变更钩子集成在 `lib.rs`。

**Tech Stack:** Rust / Tauri 2、notify 7（macos_fsevent）、tauri-plugin-dialog 2、sha2（复用 `sotvault::logic::sha256_hex`）。

**Spec:** `docs/superpowers/specs/2026-07-10-agents-md-sync-design.md`

**约定提醒（CLAUDE.md/memory）：**
- 全部完成且 check+test 通过后自动 commit；但这是 GUI/tray 改动，**发布前必须先 dev 实机验证**（Task 7）。
- 本仓库 Rust 测试跑法：`cargo test --manifest-path src-tauri/Cargo.toml <filter>`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| Create `src-tauri/templates/AGENTS.md` | 内置英文模板（打包资源，`include_str!` 嵌入） |
| Create `src-tauri/src/agents_sync/logic.rs` | 纯判定函数 `decide()` + `PairState`/`SyncAction` 类型 + 单测 |
| Create `src-tauri/src/agents_sync/baseline.rs` | 基线 hash 的 load/save（`agents_sync.json`）+ 单测 |
| Create `src-tauri/src/agents_sync/watcher.rs` | notify 非递归 watcher，只放行 AGENTS.md/CLAUDE.md 事件 + 单测 |
| Create `src-tauri/src/agents_sync/mod.rs` | 编排：init/restart/run_check/冲突弹窗/edit_agents_md |
| Modify `src-tauri/src/lib.rs` | mod 声明、menu_label、build_tray_menu、tray 事件、setup init、pick_sync_folder_inner 钩子 |

---

### Task 1: 内置 AGENTS.md 模板

**Files:**
- Create: `src-tauri/templates/AGENTS.md`

- [ ] **Step 1: 写模板文件**

内容为 spec 中已确认的英文模板，原文照抄：

```markdown
# AGENTS.md

Guidance for AI agents working in this vault. This file is the source of
truth; CLAUDE.md is an auto-generated copy — edit AGENTS.md only.

## Vault layout

- `dailynote/` — daily outline notes, organized as
  `yyyy/yyyy-MM-dd.note.md` (e.g. `2026/2026-07-10.note.md`).
  Monthly and yearly summaries live in the same year folder as
  `yyyy-MM.note.md` and `yyyy.note.md`.
- `wikipage/` — default home of global wikilink pages. Each page is an
  outline note named `title.note.md`, created when a `[[title]]` link is
  first resolved.
- `sync/` — markdown documents copied in from outside the vault (the
  editor's sync-to-vault feature). Each file is a snapshot of an external
  original; edits here do not flow back to the source file.
- Any other folder — regular markdown documents (`xxx.md`), optionally
  with a companion outline note beside them (see below).

## The `.note.md` suffix

- A file ending in `.note.md` is an **outline note**: a bullet-list
  outline with per-node metadata, edited in a dedicated outline view.
- **Companion rule:** if `xxx.note.md` sits next to `xxx.md` in the same
  folder, the two are companions — the `.note.md` holds outline
  annotations for the main document. Treat them as a pair:
  - Do not edit, rename, move, or delete one without the other.
  - Do not "fix" the outline structure of a `.note.md` file; its format
    is managed by the editor.

## House rules

- (Add your own project conventions below.)
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/templates/AGENTS.md
git commit -m "feat(agents-sync): built-in AGENTS.md template describing vault layout"
```

---

### Task 2: 判定逻辑纯函数（TDD）

**Files:**
- Create: `src-tauri/src/agents_sync/logic.rs`
- Create: `src-tauri/src/agents_sync/mod.rs`（本任务只放 `pub mod logic;`，后续任务扩充）
- Modify: `src-tauri/src/lib.rs`（mod 声明）

- [ ] **Step 1: 创建模块骨架 + 失败的测试**

`src-tauri/src/agents_sync/mod.rs`：

```rust
pub mod logic;
```

`src-tauri/src/lib.rs` 在 `pub mod vault_sync;` 声明之后（约 line 30）加：

```rust
#[cfg(not(target_os = "ios"))]
pub mod agents_sync;
```

`src-tauri/src/agents_sync/logic.rs`（先只写类型签名的空实现 + 测试；`decide` 先 `todo!()`）：

```rust
//! Pure decision logic for the AGENTS.md → CLAUDE.md mirror.
//! Hashes are SHA-256 hex of file contents; `None` means the file is missing.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PairState {
    pub agents_hash: Option<String>,
    pub claude_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncAction {
    /// Nothing to do.
    None,
    /// Copy AGENTS.md over CLAUDE.md, then record the baseline.
    MirrorToClaude,
    /// Files already identical; just record the baseline.
    RefreshBaseline,
    /// CLAUDE.md diverged on its own (or state is ambiguous); ask the user.
    PromptConflict,
}

pub fn decide(current: &PairState, baseline: &PairState) -> SyncAction {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(agents: Option<&str>, claude: Option<&str>) -> PairState {
        PairState {
            agents_hash: agents.map(String::from),
            claude_hash: claude.map(String::from),
        }
    }

    #[test]
    fn agents_missing_does_nothing_even_if_claude_exists() {
        // 不从 CLAUDE.md 反向生成（spec「不做的事」）
        assert_eq!(decide(&pair(None, Some("c1")), &PairState::default()), SyncAction::None);
        assert_eq!(decide(&pair(None, None), &PairState::default()), SyncAction::None);
    }

    #[test]
    fn claude_missing_mirrors() {
        assert_eq!(decide(&pair(Some("a1"), None), &PairState::default()), SyncAction::MirrorToClaude);
    }

    #[test]
    fn identical_and_matching_baseline_is_noop() {
        let cur = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &cur.clone()), SyncAction::None);
    }

    #[test]
    fn identical_but_stale_baseline_refreshes() {
        // 如 git pull 拉下已同步好的两份
        let cur = pair(Some("a2"), Some("a2"));
        let base = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &base), SyncAction::RefreshBaseline);
    }

    #[test]
    fn only_agents_changed_mirrors() {
        let cur = pair(Some("a2"), Some("a1"));
        let base = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &base), SyncAction::MirrorToClaude);
    }

    #[test]
    fn only_claude_changed_prompts() {
        let cur = pair(Some("a1"), Some("c2"));
        let base = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &base), SyncAction::PromptConflict);
    }

    #[test]
    fn both_changed_and_divergent_prompts() {
        // 不静默覆盖，防丢外部写入内容
        let cur = pair(Some("a2"), Some("c2"));
        let base = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &base), SyncAction::PromptConflict);
    }

    #[test]
    fn first_run_with_divergent_pair_prompts() {
        // baseline 文件不存在 → 默认空基线
        let cur = pair(Some("a1"), Some("c1"));
        assert_eq!(decide(&cur, &PairState::default()), SyncAction::PromptConflict);
    }

    #[test]
    fn divergent_but_baseline_unchanged_prompts() {
        // 理论上不该出现（基线只在一致时写入），保险起见也弹窗
        let cur = pair(Some("a1"), Some("c1"));
        assert_eq!(decide(&cur, &cur.clone()), SyncAction::PromptConflict);
    }

    #[test]
    fn self_write_suppression_via_baseline() {
        // 镜像写入后基线即等于当前 → watcher 回环事件判为 None
        let cur = pair(Some("a2"), Some("a2"));
        assert_eq!(decide(&cur, &cur.clone()), SyncAction::None);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agents_sync::logic`
Expected: FAIL / panic `not yet implemented`（`todo!()`）。

- [ ] **Step 3: 实现 `decide`**

替换 `todo!()`：

```rust
pub fn decide(current: &PairState, baseline: &PairState) -> SyncAction {
    let agents = match &current.agents_hash {
        Some(h) => h,
        None => return SyncAction::None, // never reverse-generate from CLAUDE.md
    };
    match &current.claude_hash {
        None => SyncAction::MirrorToClaude,
        Some(claude) if claude == agents => {
            if current == baseline {
                SyncAction::None
            } else {
                SyncAction::RefreshBaseline
            }
        }
        Some(_) => {
            let agents_changed = current.agents_hash != baseline.agents_hash;
            let claude_changed = current.claude_hash != baseline.claude_hash;
            match (agents_changed, claude_changed) {
                (true, false) => SyncAction::MirrorToClaude,
                // CLAUDE.md 单独变、两者都变、或基线状态存疑：一律弹窗，不静默覆盖
                _ => SyncAction::PromptConflict,
            }
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agents_sync::logic`
Expected: 10 passed。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agents_sync/ src-tauri/src/lib.rs
git commit -m "feat(agents-sync): pure three-state decision logic with baseline hashes"
```

---

### Task 3: 基线持久化（TDD）

**Files:**
- Create: `src-tauri/src/agents_sync/baseline.rs`
- Modify: `src-tauri/src/agents_sync/mod.rs`

- [ ] **Step 1: 声明模块 + 失败的测试**

`mod.rs` 加一行 `pub mod baseline;`。

`src-tauri/src/agents_sync/baseline.rs`（函数体先 `todo!()`）：

```rust
//! Persist the last-synced hash pair to `agents_sync.json` in the app config
//! dir, so divergence that happened while the app was closed is still caught.

use super::logic::PairState;
use std::path::Path;

pub fn load(path: &Path) -> PairState {
    todo!()
}

pub fn save(path: &Path, state: &PairState) {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("agents_sync.json");
        assert_eq!(load(&p), PairState::default());
    }

    #[test]
    fn corrupt_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("agents_sync.json");
        std::fs::write(&p, "not json").unwrap();
        assert_eq!(load(&p), PairState::default());
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("agents_sync.json");
        let s = PairState {
            agents_hash: Some("a1".into()),
            claude_hash: Some("c1".into()),
        };
        save(&p, &s);
        assert_eq!(load(&p), s);
    }

    #[test]
    fn save_creates_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested/agents_sync.json");
        save(&p, &PairState::default());
        assert_eq!(load(&p), PairState::default());
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agents_sync::baseline`
Expected: FAIL / panic `not yet implemented`。

- [ ] **Step 3: 实现**

```rust
pub fn load(path: &Path) -> PairState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, state: &PairState) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(path, json);
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agents_sync::baseline`
Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agents_sync/
git commit -m "feat(agents-sync): persist baseline hash pair to agents_sync.json"
```

---

### Task 4: 文件 watcher（TDD 过滤逻辑）

**Files:**
- Create: `src-tauri/src/agents_sync/watcher.rs`
- Modify: `src-tauri/src/agents_sync/mod.rs`

参考实现：`src-tauri/src/vault_sync/watcher.rs`（同一套 notify 用法，区别是
NonRecursive + 按文件名过滤）。

- [ ] **Step 1: 声明模块 + 失败的测试**

`mod.rs` 加一行 `pub mod watcher;`。

`src-tauri/src/agents_sync/watcher.rs`（`should_process` 先 `todo!()`）：

```rust
//! Non-recursive watch on the vault root; only AGENTS.md / CLAUDE.md events
//! pass through. Debouncing happens in the consumer thread (mod.rs).

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

pub const AGENTS_FILE: &str = "AGENTS.md";
pub const CLAUDE_FILE: &str = "CLAUDE.md";

pub fn start(vault_root: &Path, tx: mpsc::Sender<()>) -> notify::Result<RecommendedWatcher> {
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if should_process(&event) {
                    let _ = tx.send(());
                }
            }
        },
        notify::Config::default().with_poll_interval(Duration::from_secs(2)),
    )?;
    watcher.watch(vault_root, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

fn should_process(event: &Event) -> bool {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind};
    use std::path::PathBuf;

    fn modify_event(name: &str) -> Event {
        Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from(format!("/vault/{name}")))
    }

    #[test]
    fn agents_and_claude_pass() {
        assert!(should_process(&modify_event("AGENTS.md")));
        assert!(should_process(&modify_event("CLAUDE.md")));
    }

    #[test]
    fn other_files_are_ignored() {
        assert!(!should_process(&modify_event("README.md")));
        assert!(!should_process(&modify_event("agents.md.tmp")));
    }

    #[test]
    fn create_and_remove_pass_access_does_not() {
        let create = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/vault/AGENTS.md"));
        assert!(should_process(&create));
        let access = Event::new(EventKind::Access(notify::event::AccessKind::Any))
            .add_path(PathBuf::from("/vault/AGENTS.md"));
        assert!(!should_process(&access));
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agents_sync::watcher`
Expected: FAIL / panic `not yet implemented`。

- [ ] **Step 3: 实现 `should_process`**

```rust
fn should_process(event: &Event) -> bool {
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return false;
    }
    event.paths.iter().any(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == AGENTS_FILE || n == CLAUDE_FILE)
            .unwrap_or(false)
    })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agents_sync::watcher`
Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agents_sync/
git commit -m "feat(agents-sync): non-recursive vault-root watcher filtered to AGENTS/CLAUDE"
```

---

### Task 5: 编排层 mod.rs（init / run_check / 冲突弹窗 / 编辑入口）

**Files:**
- Modify: `src-tauri/src/agents_sync/mod.rs`

无法单测（需要 AppHandle），以编译通过 + Task 7 实机验证兜底。判定与
IO 已在 Task 2-4 覆盖。

依赖的 lib.rs 私有函数（`pick_sync_folder_inner`、`read_saved_locale`、
`show_main_window`、`emit_open_file_delayed`）定义在 crate 根，子模块
`agents_sync` 天然可见（Rust 私有性对后代模块开放），用 `crate::` 路径
直接调用，无需改可见性。

- [ ] **Step 1: 写完整 mod.rs**

整文件替换为：

```rust
//! AGENTS.md first-class support: watch the vault root, mirror AGENTS.md to
//! CLAUDE.md on any change, and prompt when CLAUDE.md diverges on its own.
//! Lifecycle is independent of vault_sync's git loop — active whenever a
//! vault path is configured. See
//! docs/superpowers/specs/2026-07-10-agents-md-sync-design.md.

pub mod baseline;
pub mod logic;
pub mod watcher;

use logic::{PairState, SyncAction};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tauri::Manager;

pub const TEMPLATE: &str = include_str!("../../templates/AGENTS.md");

pub struct AgentsSyncState {
    /// Bumped on every (re)start; stale watcher threads exit when they notice.
    generation: AtomicU64,
    /// True while the conflict dialog is on screen (suppresses re-prompts).
    prompting: AtomicBool,
}

impl AgentsSyncState {
    fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            prompting: AtomicBool::new(false),
        }
    }
}

fn vault_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mgr = app.state::<Arc<crate::vault_sync::VaultSyncManager>>();
    let guard = mgr.repo_path.lock().unwrap();
    guard.as_deref().map(PathBuf::from)
}

fn baseline_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("agents_sync.json"))
}

fn hash_of(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| crate::sotvault::logic::sha256_hex(&b))
}

fn current_state(root: &Path) -> PairState {
    PairState {
        agents_hash: hash_of(&root.join(watcher::AGENTS_FILE)),
        claude_hash: hash_of(&root.join(watcher::CLAUDE_FILE)),
    }
}

/// Call once at app setup, after vault_sync::init.
pub fn init(app: &tauri::AppHandle) {
    app.manage(AgentsSyncState::new());
    if let Some(root) = vault_root(app) {
        start(app, &root);
    }
}

/// Call when the vault folder changes (tray picker).
pub fn restart(app: &tauri::AppHandle, root: &str) {
    start(app, Path::new(root));
}

fn start(app: &tauri::AppHandle, root: &Path) {
    let state = app.state::<AgentsSyncState>();
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel::<()>();
    let root = root.to_path_buf();
    let app = app.clone();
    std::thread::spawn(move || {
        // The watcher lives in this thread; dropping it on exit stops events.
        let _watcher = match watcher::start(&root, tx) {
            Ok(w) => w,
            Err(_) => return,
        };
        // Startup check catches divergence that happened while the app was
        // closed (baseline is persisted).
        run_check(&app, &root);
        loop {
            let stale = || {
                app.state::<AgentsSyncState>().generation.load(Ordering::SeqCst) != my_gen
            };
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(()) => {
                    // Debounce: swallow the burst, then act once.
                    while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
                    if stale() {
                        return;
                    }
                    run_check(&app, &root);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if stale() {
                        return;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

fn run_check(app: &tauri::AppHandle, root: &Path) {
    let state = app.state::<AgentsSyncState>();
    if state.prompting.load(Ordering::SeqCst) {
        return;
    }
    let Some(bp) = baseline_path(app) else { return };
    let current = current_state(root);
    let base = baseline::load(&bp);
    match logic::decide(&current, &base) {
        SyncAction::None => {}
        SyncAction::RefreshBaseline => baseline::save(&bp, &current),
        SyncAction::MirrorToClaude => {
            let ok = std::fs::copy(
                root.join(watcher::AGENTS_FILE),
                root.join(watcher::CLAUDE_FILE),
            )
            .is_ok();
            if ok {
                // Re-hash after the write so baseline == on-disk state; the
                // watcher event for our own write then decides to None.
                baseline::save(&bp, &current_state(root));
            }
        }
        SyncAction::PromptConflict => prompt_conflict(app, root),
    }
}

fn prompt_conflict(app: &tauri::AppHandle, root: &Path) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let state = app.state::<AgentsSyncState>();
    if state.prompting.swap(true, Ordering::SeqCst) {
        return;
    }
    let locale = crate::read_saved_locale(app);
    let (msg, merge_label, overwrite_label) = match locale.as_str() {
        "zh" => (
            "CLAUDE.md 已被修改，与 AGENTS.md 不一致。",
            "合回 AGENTS.md",
            "用 AGENTS.md 覆盖",
        ),
        "ja" => (
            "CLAUDE.md が変更され、AGENTS.md と一致しません。",
            "AGENTS.md に取り込む",
            "AGENTS.md で上書き",
        ),
        _ => (
            "CLAUDE.md has been modified and no longer matches AGENTS.md.",
            "Merge into AGENTS.md",
            "Overwrite with AGENTS.md",
        ),
    };
    let app = app.clone();
    let root = root.to_path_buf();
    app.clone()
        .dialog()
        .message(msg)
        .title("AGENTS.md")
        .buttons(MessageDialogButtons::OkCancelCustom(
            merge_label.into(),
            overwrite_label.into(),
        ))
        .show(move |merge_back| {
            // Whole-file copy either way; no text merge (spec).
            let (from, to) = if merge_back {
                (root.join(watcher::CLAUDE_FILE), root.join(watcher::AGENTS_FILE))
            } else {
                (root.join(watcher::AGENTS_FILE), root.join(watcher::CLAUDE_FILE))
            };
            let _ = std::fs::copy(&from, &to);
            if let Some(bp) = baseline_path(&app) {
                baseline::save(&bp, &current_state(&root));
            }
            let state = app.state::<AgentsSyncState>();
            state.prompting.store(false, Ordering::SeqCst);
        });
}

/// Tray entry point: ensure AGENTS.md exists (template on first use), sync,
/// and open it in the main window.
pub fn edit_agents_md(app: &tauri::AppHandle) {
    if let Some(root) = vault_root(app) {
        open_agents_in_editor(app, &root);
    } else {
        // No vault yet: reuse the folder picker, then open. The picker's
        // shared path (pick_sync_folder_inner) also calls restart() for us.
        let app = app.clone();
        crate::pick_sync_folder_inner(&app.clone(), move |path| {
            open_agents_in_editor(&app, Path::new(&path));
        });
    }
}

fn open_agents_in_editor(app: &tauri::AppHandle, root: &Path) {
    let agents = root.join(watcher::AGENTS_FILE);
    if !agents.exists() {
        let _ = std::fs::write(&agents, TEMPLATE);
    }
    // Mirrors CLAUDE.md (or prompts if a foreign CLAUDE.md already diverges —
    // safer than clobbering it with the fresh template).
    run_check(app, root);
    crate::show_main_window(app);
    if let Some(p) = agents.to_str() {
        crate::emit_open_file_delayed(app, p);
    }
}
```

- [ ] **Step 2: 编译检查**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过（若 `show_main_window` / `emit_open_file_delayed` 泛型推导报错，在调用处显式使用具体 `tauri::AppHandle` 已满足；如
`MessageDialogButtons::OkCancelCustom` 变体名不符，查
`tauri-plugin-dialog` 2.x 文档用等价的双自定义按钮变体替换）。

- [ ] **Step 3: 跑全部 agents_sync 测试防回归**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agents_sync`
Expected: 17 passed（10 + 4 + 3）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/agents_sync/
git commit -m "feat(agents-sync): orchestration — watcher thread, conflict dialog, tray edit entry"
```

---

### Task 6: lib.rs 集成（tray 菜单项 + 初始化 + vault 路径变更钩子）

**Files:**
- Modify: `src-tauri/src/lib.rs`

五处改动（mod 声明已在 Task 2 完成）：

- [ ] **Step 1: menu_label 加三语文案**

`menu_label` 的 match（`src-tauri/src/lib.rs` ~line 1033，`tray.openRawSync` 之后）加：

```rust
        "tray.editAgents" => ("Edit AGENTS.md…", "编辑 AGENTS.md…", "AGENTS.md を編集…"),
```

- [ ] **Step 2: build_tray_menu 加菜单项**

`build_tray_menu`（~line 1071）中，`sync_log_item` 之后加：

```rust
    let edit_agents_item = MenuItem::with_id(app, "tray-edit-agents", menu_label(locale, "tray.editAgents"), true, None::<&str>)?;
```

菜单组装处，`.item(&sync_log_item)` 之后加 `.item(&edit_agents_item)`
（仍在 Vault 区块内、`separator()` 之前）：

```rust
        .item(&sync_log_item)
        .item(&edit_agents_item)
        .separator()
```

注意：`build_tray_menu` 是泛型 `<R: tauri::Runtime>`，而
`agents_sync::edit_agents_md` 接收具体 `tauri::AppHandle`——菜单项本身
只需 id，无冲突。

- [ ] **Step 3: tray 事件处理**

tray 事件 match（~line 792，`"tray-sync-log"` 分支之后）加：

```rust
                            "tray-edit-agents" => agents_sync::edit_agents_md(app),
```

- [ ] **Step 4: setup 初始化 + vault 路径变更钩子**

`vault_sync::init(&app.handle());`（~line 731）之后加：

```rust
                agents_sync::init(&app.handle());
```

`pick_sync_folder_inner`（~line 495）内 `update_tray_repo_label(&app_clone, &path_str);` 之后加：

```rust
                agents_sync::restart(&app_clone, &path_str);
```

- [ ] **Step 5: 编译 + 全量 Rust 测试**

Run: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过，全部测试 pass。

- [ ] **Step 6: 前端 check + test（惯例门禁）**

Run: `pnpm check && pnpm test`
Expected: 无错误（本 feature 不动前端，跑一遍防意外）。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tray): Edit AGENTS.md menu entry + agents_sync init/restart wiring"
```

---

### Task 7: dev 实机验证（GUI 惯例，发布前必做）

**Files:** 无代码改动。方法参照 memory `reference_dev_gui_verification`
（dev 构建 + osascript + /tmp/mdeditor.log + screencapture）。

- [ ] **Step 1: 起 dev 构建**

Run: `pnpm tauri dev`（后台，日志导 /tmp/mdeditor.log）

- [ ] **Step 2: 验证清单（逐项截图/确认）**

1. tray 菜单出现「Edit AGENTS.md…」，切 zh/ja 后文案正确（`set_menu_locale`
   会重建 tray 菜单，切语言即可验）。
2. vault 根无 AGENTS.md 时点菜单：生成模板、同目录出现相同内容的
   CLAUDE.md、主窗口打开 AGENTS.md。
3. 外部改 AGENTS.md（`echo "\n- test rule" >> $VAULT/AGENTS.md`）：
   ≤2 秒内 CLAUDE.md 跟进一致，无弹窗、无死循环（日志确认只 mirror 一次，
   自写抑制生效）。
4. 外部改 CLAUDE.md：弹原生对话框；点「合回 AGENTS.md」→ AGENTS.md 变成
   CLAUDE.md 内容；再改一次 CLAUDE.md，点「用 AGENTS.md 覆盖」→ CLAUDE.md
   被覆盖回来。弹窗期间再改文件不连环弹。
5. 关闭 app → 外部改 CLAUDE.md → 重启 app：启动即弹偏离对话框
   （基线持久化生效）。
6. tray 重新选 vault 文件夹：watcher 跟到新目录（在新目录改 AGENTS.md
   能触发镜像）。

- [ ] **Step 3: 验证通过后按惯例合并/发布**

按 memory 惯例：check+test 已过、实机验证通过 → 自动 commit/push；发布
走独立 worktree 流程（`feedback_release_isolated_worktree`）。

---

## Self-Review 记录

- **Spec 覆盖**：tray 入口（Task 6）、模板创建（Task 1/5）、单向镜像 + 自写抑制（Task 2/5）、偏离弹窗三语（Task 5）、基线持久化 + 离线检测（Task 3/5 启动检查）、vault 路径变更重启（Task 5/6）、三态判定含 both-changed（Task 2）——无缺口。
- **占位符**：无 TBD/TODO；`todo!()` 仅为 TDD 红灯步骤，同任务内即替换。
- **类型一致性**：`PairState`/`SyncAction`/`decide` 签名 Task 2 定义、Task 5 使用一致；`AGENTS_FILE`/`CLAUDE_FILE` 常量 Task 4 定义、Task 5 引用；`sha256_hex` 复用 `sotvault::logic`（已确认 pub）。
- **偏离 spec 的一处细化**：AGENTS.md 缺失但 CLAUDE.md 已存在且内容不同时，创建模板后走 `run_check` 弹窗而非直接镜像——避免模板静默覆盖外部工具写好的 CLAUDE.md（更安全，方向与 spec「不静默覆盖」一致）。
