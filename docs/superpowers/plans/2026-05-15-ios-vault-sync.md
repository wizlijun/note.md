# iOS Vault GitHub Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 iOS app 上增加 GitHub 仓库同步与离线阅读/编辑能力：用户配置 PAT，App 把 GitHub 仓库 clone 到 `Documents/Vault/`，提供文件夹树式浏览，使用 mdeditor 查看/编辑；手动 + 前台进入时自动 fetch / commit / push，冲突沿用 macOS 策略保存 `.conflict.<ts>` 副本。

**Architecture:** 新增 Rust 模块 `src-tauri/src/vault_ios/`（仅 iOS 编译），用 `git2` crate（vendored libgit2 + vendored OpenSSL）做所有 Git 操作；Swift 桥通过 `SecItemAdd` 等存 PAT 到 Keychain；前端在 `src/lib/vault.svelte.ts` 维护响应式状态，新增 `VaultSettingsTab.svelte` 和 `VaultBrowser.svelte`，扩展 `DrawerNav.svelte` 与 `SettingsDialog.svelte`，前台触发挂在 `App.svelte`。macOS 端不动，所有变更 `#[cfg(target_os = "ios")]` 屏蔽。

**Tech Stack:** Rust + `git2 = "0.19"` (vendored-libgit2 + vendored-openssl), Tauri 2, Swift/UIKit (Keychain Services), Svelte 5 runes, TypeScript, Vitest, cargo test.

**Spec reference:** `docs/superpowers/specs/2026-05-15-ios-vault-sync-design.md`

**Branch context:** Plan executes on `feature/ios-port`. Worktree at `.worktrees/ios-port/` already has uncommitted WIP (Cargo.lock / lib.rs / icons / etc.) — every task below commits **specific files only** (never `git add -A`), to avoid swallowing unrelated WIP.

---

## File Structure

### New files

| Path | Purpose |
|---|---|
| `src-tauri/src/vault_ios/mod.rs` | Tauri commands、`VaultIosManager` 状态机、模块 init |
| `src-tauri/src/vault_ios/path.rs` | `resolve_vault_path` helper（可注入 base，方便测试） |
| `src-tauri/src/vault_ios/list_dir.rs` | `vault_list_dir` 实现：枚举工作树文件、白名单过滤、`.git` 隐藏 |
| `src-tauri/src/vault_ios/keychain.rs` | Rust 端 Keychain 包装（iOS 调 Swift；non-iOS 用文件桩） |
| `src-tauri/src/vault_ios/clone.rs` | 首次 clone + 进度 event |
| `src-tauri/src/vault_ios/sync.rs` | 单次 sync 循环（fetch / fast-forward / stash / rebase / commit / push） |
| `src-tauri/src/vault_ios/conflict.rs` | 冲突处理：保留本地为 `.conflict.<ts>` 副本，工作树取远端 |
| `src-tauri/src/vault_ios/sig.rs` | author signature 构造（从 settings 读 name/email） |
| `src-tauri/src/vault_ios/tests/mod.rs` | cargo test 集成测试入口（仅在 macOS host 跑） |
| `src-tauri/gen/apple/Sources/Plugins/IOSBridge/Keychain.swift` | Swift Keychain 命令 |
| `src/lib/vault.svelte.ts` | 前端响应式状态 store + invoke 包装 |
| `src/lib/vault-list.ts` | 文件类型白名单过滤（前端兜底） |
| `src/lib/vault.test.ts` | store 状态机 + 30s 去重 tests |
| `src/lib/vault-list.test.ts` | 白名单 / 扩展名分类 tests |
| `src/components/VaultSettingsTab.svelte` | Settings → Vault tab UI |
| `src/components/VaultBrowser.svelte` | 抽屉里嵌的层级浏览 |

### Modified files

| Path | Change |
|---|---|
| `src-tauri/Cargo.toml` | iOS target 加 `git2`；添加 `dirs`、`base64` 依赖（如未存在） |
| `src-tauri/src/lib.rs` | iOS 编译时注册 `vault_ios` 命令；`setup()` 中 `vault_ios::init(&app.handle())` |
| `src/components/SettingsDialog.svelte` | iOS 上加 Vault tab |
| `src/components/DrawerNav.svelte` | 加 Vault 分区，宿主 `VaultBrowser` |
| `src/components/MobileToolbar.svelte` | 去掉 ☰ 按钮的 `formFactor === 'phone'` 限制 |
| `src/App.svelte` | iOS 上挂 `tauri://focus` + `visibilitychange` → `syncNow()` |
| `src/main.ts` | 启动时 `vault.refreshStatus()` 把 store 初始化 |
| `README.md` | iOS smoke 第 96–110 条 |

---

## Phase 0 — De-risk libgit2 on iOS

### Task 1: 验证 `git2 + vendored-libgit2 + vendored-openssl` 能为 iOS arm64 编译通过

**Files:**
- Modify: `src-tauri/Cargo.toml`

这一步**先做**，否则后面所有 Rust 工作都白搭。如果失败，要重新评估：换 `gitoxide`、或暂时降级为只读 vault（用 HTTPS GET archive zip）。

- [ ] **Step 1: 加 git2 依赖**

在 `src-tauri/Cargo.toml` 找到现有的 `[target.'cfg(target_os = "ios")'.dependencies]` 段（若不存在则在文件末尾创建），加入：

```toml
[target.'cfg(target_os = "ios")'.dependencies]
git2 = { version = "0.19", default-features = false, features = ["vendored-libgit2", "vendored-openssl"] }
```

如果还需在 macOS host 上跑 cargo test 验证 vault_ios 逻辑（本计划是这么做的），那 macOS 段也加：

```toml
[target.'cfg(not(target_os = "ios"))'.dependencies]
git2 = { version = "0.19", default-features = false, features = ["vendored-libgit2", "vendored-openssl"] }
```

- [ ] **Step 2: 验证 macOS host 上能编译**

Run:
```bash
cd .worktrees/ios-port/src-tauri
cargo build --release 2>&1 | tail -5
```

Expected: 编译通过（首次会下载 libgit2 + openssl 源码并 vendor 编译，可能耗时 3–8 分钟）。

如果失败，错误大概率是 OpenSSL 找不到 Perl 或 CMake。在 macOS 上 `brew install cmake perl` 然后重试。

- [ ] **Step 3: 验证 iOS arm64 target 能链接**

Run:
```bash
rustup target add aarch64-apple-ios
cd .worktrees/ios-port/src-tauri
cargo build --target aarch64-apple-ios --release 2>&1 | tail -10
```

Expected: 编译通过，产出 `target/aarch64-apple-ios/release/libapp_lib.a`（或类似名）。

**如果这一步失败：** 停下来。stop and report 给用户：错误信息 + 怀疑的原因（libgit2 sysroot? OpenSSL 交叉编译?）。这是 spec §6 列出的 P0 风险，需要决定下一步走 gitoxide 还是别的路径。

- [ ] **Step 4: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/Cargo.toml
git -C .worktrees/ios-port commit -m "build(vault): add git2 with vendored libgit2 + openssl"
```

注：如果 `Cargo.lock` 也被改动了（多半会），一并加上：`git add src-tauri/Cargo.lock`。但要先 diff 看看 lock 里只有 git2/openssl-sys 相关项，没有意外的其他改动；如果有，可能本来就是 worktree 里的 WIP 顺带也 lock 进来了，那就 `git stash` 当前的 lock 改动再加只属于本任务的部分（实际操作：`git add -p src-tauri/Cargo.lock` 选择性 stage）。

---

## Phase 1 — Rust foundation

### Task 2: vault_ios 模块骨架 + 类型 + 状态机

**Files:**
- Create: `src-tauri/src/vault_ios/mod.rs`

- [ ] **Step 1: 创建模块文件**

写 `src-tauri/src/vault_ios/mod.rs`:

```rust
//! iOS-only vault sync module. macOS continues to use `vault_sync` (CLI-based).
//!
//! Architecture: pure libgit2 (`git2` crate) with vendored libgit2 + OpenSSL.
//! PAT credentials live in iOS Keychain via a Swift bridge.

#![cfg(any(target_os = "ios", test))]

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub mod path;
pub mod list_dir;
pub mod keychain;
pub mod sig;

#[cfg(any(target_os = "ios", test))]
pub mod clone;
#[cfg(any(target_os = "ios", test))]
pub mod sync;
#[cfg(any(target_os = "ios", test))]
pub mod conflict;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    NotConfigured,
    Cloning,
    Idle,
    Syncing,
    Error,
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultStatus {
    pub state: SyncState,
    pub last_sync: Option<u64>,         // epoch ms
    pub error_message: Option<String>,
    pub has_conflicts: bool,
    pub configured: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VaultConfigure {
    pub remote_url: String,
    pub branch: String,
    pub pat: String,
    pub author_name: String,
    pub author_email: String,
}

#[derive(Debug)]
pub enum VaultError {
    NotConfigured,
    NetworkError(String),
    AuthFailed,
    NotFoundOrNoAccess,
    RebaseFailed,
    PushRejected(String),
    FsError(String),
    GitError(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::NotConfigured => write!(f, "vault not configured"),
            Self::NetworkError(s) => write!(f, "network: {s}"),
            Self::AuthFailed => write!(f, "auth failed"),
            Self::NotFoundOrNoAccess => write!(f, "not found / no access"),
            Self::RebaseFailed => write!(f, "rebase failed"),
            Self::PushRejected(s) => write!(f, "push rejected: {s}"),
            Self::FsError(s) => write!(f, "fs: {s}"),
            Self::GitError(s) => write!(f, "git: {s}"),
        }
    }
}

impl From<git2::Error> for VaultError {
    fn from(e: git2::Error) -> Self {
        let msg = e.message().to_string();
        match e.class() {
            git2::ErrorClass::Net | git2::ErrorClass::Http => Self::NetworkError(msg),
            git2::ErrorClass::Reference if e.code() == git2::ErrorCode::Auth => Self::AuthFailed,
            _ if msg.contains("authentication") || msg.contains("401") => Self::AuthFailed,
            _ if msg.contains("404") || msg.contains("not found") => Self::NotFoundOrNoAccess,
            _ => Self::GitError(msg),
        }
    }
}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self { Self::FsError(e.to_string()) }
}

pub struct VaultIosManager {
    pub state: Mutex<SyncState>,
    pub last_sync: Mutex<Option<u64>>,
    pub error_msg: Mutex<Option<String>>,
    pub has_conflicts: Mutex<bool>,
    pub remote_url: Mutex<Option<String>>,
    pub branch: Mutex<String>,
    pub author_name: Mutex<String>,
    pub author_email: Mutex<String>,
}

impl VaultIosManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SyncState::NotConfigured),
            last_sync: Mutex::new(None),
            error_msg: Mutex::new(None),
            has_conflicts: Mutex::new(false),
            remote_url: Mutex::new(None),
            branch: Mutex::new("main".into()),
            author_name: Mutex::new("mdeditor on iOS".into()),
            author_email: Mutex::new(String::new()),
        }
    }

    pub fn snapshot_status(&self, configured: bool) -> VaultStatus {
        VaultStatus {
            state: *self.state.lock().unwrap(),
            last_sync: *self.last_sync.lock().unwrap(),
            error_message: self.error_msg.lock().unwrap().clone(),
            has_conflicts: *self.has_conflicts.lock().unwrap(),
            configured,
        }
    }
}

#[tauri::command]
pub fn vault_status(app: AppHandle) -> VaultStatus {
    let mgr = app.state::<Arc<VaultIosManager>>();
    let configured = mgr.remote_url.lock().unwrap().is_some();
    mgr.snapshot_status(configured)
}

pub fn init(app: &AppHandle) {
    use tauri_plugin_store::StoreExt;
    let mgr = Arc::new(VaultIosManager::new());

    if let Ok(store) = app.store("settings.json") {
        if let Some(url) = store.get("vault_ios.remote_url").and_then(|v| v.as_str().map(String::from)) {
            *mgr.remote_url.lock().unwrap() = Some(url);
            *mgr.state.lock().unwrap() = SyncState::Idle;
        }
        if let Some(b) = store.get("vault_ios.branch").and_then(|v| v.as_str().map(String::from)) {
            *mgr.branch.lock().unwrap() = b;
        }
        if let Some(n) = store.get("vault_ios.author_name").and_then(|v| v.as_str().map(String::from)) {
            *mgr.author_name.lock().unwrap() = n;
        }
        if let Some(e) = store.get("vault_ios.author_email").and_then(|v| v.as_str().map(String::from)) {
            *mgr.author_email.lock().unwrap() = e;
        }
    }

    app.manage(mgr);
}
```

- [ ] **Step 2: 让 lib.rs 引入模块**

在 `src-tauri/src/lib.rs` 顶部 module 声明区（搜 `pub mod plugin_host`）下加：

```rust
#[cfg(target_os = "ios")]
pub mod vault_ios;
```

`invoke_handler` 的 iOS 分支里加 `vault_ios::vault_status`：

```rust
#[cfg(target_os = "ios")]
{ tauri::generate_handler![
    plugin_host::get_plugin_manifests,
    plugin_host::get_all_plugin_manifests,
    plugin_host::invoke_plugin,
    vault_ios::vault_status,
] }
```

`setup()` 在 iOS 分支里调 `vault_ios::init`，找到现有 `plugin_host::init(&app.handle());` 行的位置加：

```rust
#[cfg(target_os = "ios")]
vault_ios::init(&app.handle());
```

- [ ] **Step 3: 验证编译**

Run:
```bash
cd .worktrees/ios-port/src-tauri
cargo build --target aarch64-apple-ios 2>&1 | tail -5
```

Expected: 编译通过，没有 warning（如果有 warning 说类型未使用，按提示 `#[allow(dead_code)]` 或先忽略，会在后续 task 中被消化）。

- [ ] **Step 4: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/src/vault_ios src-tauri/src/lib.rs
git -C .worktrees/ios-port commit -m "feat(vault): module skeleton + status types"
```

---

### Task 3: `resolve_vault_path` helper（可注入 base）

**Files:**
- Create: `src-tauri/src/vault_ios/path.rs`
- Create: `src-tauri/src/vault_ios/tests/mod.rs` (or extend if exists)

- [ ] **Step 1: 写失败的测试**

创建 `src-tauri/src/vault_ios/tests/mod.rs`:

```rust
use std::path::PathBuf;

#[test]
fn vault_path_under_documents() {
    let base = PathBuf::from("/tmp/foo");
    let p = crate::vault_ios::path::resolve_vault_path(&base);
    assert_eq!(p, PathBuf::from("/tmp/foo/Vault"));
}

#[test]
fn vault_path_handles_trailing_slash() {
    let base = PathBuf::from("/tmp/foo/");
    let p = crate::vault_ios::path::resolve_vault_path(&base);
    assert_eq!(p, PathBuf::from("/tmp/foo/Vault"));
}
```

- [ ] **Step 2: 跑测试看失败**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests 2>&1 | tail -10`
Expected: 编译失败 `module path` 不存在。

- [ ] **Step 3: 实现 path.rs**

写 `src-tauri/src/vault_ios/path.rs`:

```rust
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Append "Vault" subdir to the given base. Pure function for testability.
pub fn resolve_vault_path(base: &Path) -> PathBuf {
    base.join("Vault")
}

/// Production helper: read iOS document directory from the app handle.
#[cfg(any(target_os = "ios", target_os = "macos"))]
pub fn vault_path(app: &tauri::AppHandle) -> Result<PathBuf, super::VaultError> {
    let doc = app.path().document_dir()
        .map_err(|e| super::VaultError::FsError(format!("document_dir: {e}")))?;
    Ok(resolve_vault_path(&doc))
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests 2>&1 | tail -10`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/src/vault_ios/path.rs src-tauri/src/vault_ios/tests
git -C .worktrees/ios-port commit -m "feat(vault): resolve_vault_path helper + tests"
```

---

## Phase 2 — File listing

### Task 4: 文件类型白名单 + `list_dir` 实现

**Files:**
- Create: `src-tauri/src/vault_ios/list_dir.rs`
- Modify: `src-tauri/src/vault_ios/tests/mod.rs`

- [ ] **Step 1: 写失败的测试**

在 `tests/mod.rs` 追加：

```rust
use std::fs;
use tempfile::tempdir;

#[test]
fn list_dir_filters_by_whitelist_and_hides_dotgit() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Whitelisted files
    fs::write(root.join("readme.md"), "x").unwrap();
    fs::write(root.join("a.txt"), "y").unwrap();
    fs::write(root.join("photo.png"), &[0u8; 8]).unwrap();
    fs::create_dir(root.join("subdir")).unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join("ignore.pdf"), "z").unwrap();
    fs::write(root.join(".DS_Store"), "").unwrap();

    let entries = crate::vault_ios::list_dir::list(root, "").unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

    assert!(names.contains(&"readme.md"));
    assert!(names.contains(&"a.txt"));
    assert!(names.contains(&"photo.png"));
    assert!(names.contains(&"subdir"));
    assert!(!names.contains(&".git"));
    assert!(!names.contains(&"ignore.pdf"));
    assert!(!names.contains(&".DS_Store"));
}

#[test]
fn list_dir_returns_kind_and_size() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("foo.md"), "hello world").unwrap();
    fs::create_dir(root.join("sub")).unwrap();

    let entries = crate::vault_ios::list_dir::list(root, "").unwrap();
    let md = entries.iter().find(|e| e.name == "foo.md").unwrap();
    assert_eq!(md.kind, "file");
    assert_eq!(md.size, Some(11));
    assert_eq!(md.ext.as_deref(), Some("md"));

    let sub = entries.iter().find(|e| e.name == "sub").unwrap();
    assert_eq!(sub.kind, "dir");
    assert_eq!(sub.size, None);
}

#[test]
fn list_dir_relative_path_navigates() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("notes")).unwrap();
    fs::write(root.join("notes/today.md"), "x").unwrap();

    let entries = crate::vault_ios::list_dir::list(root, "notes").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "today.md");
}

#[test]
fn list_dir_rejects_path_traversal() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let result = crate::vault_ios::list_dir::list(root, "../etc");
    assert!(result.is_err());
}
```

需要在 `Cargo.toml` 的 `[dev-dependencies]` 加 `tempfile = "3"`（如果已有可跳过）。

- [ ] **Step 2: 跑测试看失败**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::list_dir 2>&1 | tail -10`
Expected: 编译失败 `module list_dir` 不存在。

- [ ] **Step 3: 实现 list_dir.rs**

写 `src-tauri/src/vault_ios/list_dir.rs`:

```rust
use std::path::Path;
use serde::Serialize;

use super::{VaultError, path::vault_path};

const ALLOWED_EXTS: &[&str] = &[
    "md", "markdown", "mdown", "mkd",
    "html", "htm",
    "txt", "log", "csv", "tsv", "env",
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "avif",
];

#[derive(Debug, Clone, Serialize)]
pub struct ListEntry {
    pub name: String,
    pub kind: String,       // "file" | "dir"
    pub size: Option<u64>,  // None for dirs
    pub mtime: Option<u64>, // epoch ms
    pub ext: Option<String>,
}

fn is_whitelisted_file(name: &str) -> bool {
    if let Some(idx) = name.rfind('.') {
        let ext = name[idx + 1..].to_ascii_lowercase();
        ALLOWED_EXTS.contains(&ext.as_str())
    } else {
        false
    }
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || name == ".DS_Store"
}

pub fn list(root: &Path, rel_path: &str) -> Result<Vec<ListEntry>, VaultError> {
    // Path traversal guard: rel_path can be empty, or a `/`-separated descendant.
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err(VaultError::FsError(format!("invalid rel_path: {rel_path}")));
    }

    let target = if rel_path.is_empty() { root.to_path_buf() } else { root.join(rel_path) };
    if !target.starts_with(root) {
        return Err(VaultError::FsError("path traversal".into()));
    }
    if !target.is_dir() {
        return Err(VaultError::FsError(format!("not a directory: {}", target.display())));
    }

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&target)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name) { continue; }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let kind = if metadata.is_dir() { "dir" } else { "file" };
        if kind == "file" && !is_whitelisted_file(&name) { continue; }

        let size = if metadata.is_file() { Some(metadata.len()) } else { None };
        let mtime = metadata.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        let ext = name.rfind('.').map(|i| name[i + 1..].to_ascii_lowercase());

        out.push(ListEntry {
            name,
            kind: kind.into(),
            size,
            mtime,
            ext,
        });
    }

    // Folders first, then files, both alphabetical.
    out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()),
    });

    Ok(out)
}

#[tauri::command]
pub fn vault_list_dir(app: tauri::AppHandle, rel_path: String) -> Result<Vec<ListEntry>, String> {
    let root = vault_path(&app).map_err(|e| e.to_string())?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    list(&root, &rel_path).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::list_dir 2>&1 | tail -10`
Expected: 4 passed.

- [ ] **Step 5: 注册命令到 invoke_handler**

修改 `src-tauri/src/lib.rs` 的 iOS 分支，加 `vault_ios::list_dir::vault_list_dir`：

```rust
#[cfg(target_os = "ios")]
{ tauri::generate_handler![
    plugin_host::get_plugin_manifests,
    plugin_host::get_all_plugin_manifests,
    plugin_host::invoke_plugin,
    vault_ios::vault_status,
    vault_ios::list_dir::vault_list_dir,
] }
```

- [ ] **Step 6: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/src/vault_ios/list_dir.rs src-tauri/src/vault_ios/tests src-tauri/src/lib.rs src-tauri/Cargo.toml
git -C .worktrees/ios-port commit -m "feat(vault): list_dir command + whitelist filter"
```

---

## Phase 3 — Keychain bridge

### Task 5: Swift `Keychain.swift` + Tauri commands

**Files:**
- Create: `src-tauri/gen/apple/Sources/Plugins/IOSBridge/Keychain.swift` (or wherever existing IOSBridge lives; verify path first)

- [ ] **Step 1: 确认 Swift bridge 位置**

Run: `find .worktrees/ios-port/src-tauri/gen/apple -name "*.swift" 2>/dev/null | head`

如果不存在任何 IOSBridge 文件夹，按 spec §1.2 创建 `src-tauri/gen/apple/Sources/Plugins/IOSBridge/` 目录。如果已有 IOSBridge 框架（例如做 share-sheet 推迟项时建过），把 Keychain.swift 放进去和现有 plugin 共用框架。

实际找到的现有 Swift 路径将作为 Plugin 注册位置；记下来用在 Xcode project 引用。

- [ ] **Step 2: 写 Keychain.swift**

```swift
import Foundation
import Security
import Tauri

// MARK: - Keychain helpers
enum KeychainErr: Error { case osStatus(OSStatus) }

private func service() -> String { "com.bruce.mdeditor.vault" }

private func baseQuery(account: String) -> [String: Any] {
    return [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service(),
        kSecAttrAccount as String: account,
    ]
}

private func upsert(account: String, value: String) throws {
    let data = value.data(using: .utf8) ?? Data()

    // Remove existing first (SecItemAdd would otherwise error if exists).
    SecItemDelete(baseQuery(account: account) as CFDictionary)

    var attrs = baseQuery(account: account)
    attrs[kSecValueData as String] = data
    attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(attrs as CFDictionary, nil)
    if status != errSecSuccess { throw KeychainErr.osStatus(status) }
}

private func fetch(account: String) throws -> String? {
    var query = baseQuery(account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    if status == errSecItemNotFound { return nil }
    if status != errSecSuccess { throw KeychainErr.osStatus(status) }
    guard let data = item as? Data, let s = String(data: data, encoding: .utf8) else { return nil }
    return s
}

private func remove(account: String) throws {
    let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound {
        throw KeychainErr.osStatus(status)
    }
}

// MARK: - Tauri plugin
class KeychainPlugin: Plugin {
    @objc public func set(_ invoke: Invoke) throws {
        struct Args: Decodable { let account: String; let value: String }
        let a = try invoke.parseArgs(Args.self)
        do { try upsert(account: a.account, value: a.value); invoke.resolve() }
        catch { invoke.reject("keychain set failed: \(error)") }
    }

    @objc public func get(_ invoke: Invoke) throws {
        struct Args: Decodable { let account: String }
        let a = try invoke.parseArgs(Args.self)
        do {
            if let v = try fetch(account: a.account) {
                invoke.resolve(["value": v])
            } else {
                invoke.resolve(["value": NSNull()])
            }
        } catch { invoke.reject("keychain get failed: \(error)") }
    }

    @objc public func delete(_ invoke: Invoke) throws {
        struct Args: Decodable { let account: String }
        let a = try invoke.parseArgs(Args.self)
        do { try remove(account: a.account); invoke.resolve() }
        catch { invoke.reject("keychain delete failed: \(error)") }
    }
}

@_cdecl("init_plugin_keychain")
func initPluginKeychain() -> Plugin { return KeychainPlugin() }
```

**额外命令：标记目录排除 iCloud 备份**

在同一个 `KeychainPlugin` 类（或单独一个 plugin，按现有 IOSBridge 结构）加：

```swift
@objc public func markExcludedFromBackup(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let a = try invoke.parseArgs(Args.self)
    var url = URL(fileURLWithPath: a.path)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
        try url.setResourceValues(values)
        invoke.resolve()
    } catch {
        invoke.reject("exclude from backup failed: \(error)")
    }
}
```

前端通过 `invoke('plugin:keychain|markExcludedFromBackup', { path })` 调用。

- [ ] **Step 3: 在 `project.yml` 或 `mdeditor.xcodeproj` 把 Keychain.swift 加入编译目标**

打开 `src-tauri/gen/apple/project.yml`（如果用 XcodeGen）或直接编辑 pbxproj，把新文件加入 `mdeditor_iOS` target 的 sources。

注：此步具体改动取决于现有 Xcode project 结构。如果 IOSBridge.swift 已经在编译，把 Keychain.swift 放同目录并跟它走相同的添加方式。如果不熟悉 pbxproj 操作，最稳妥是 `tauri ios open` 打开 Xcode → File → Add Files → 选 Keychain.swift → 勾选 mdeditor_iOS target → save，再 `git diff` 看 pbxproj 改动 commit。

- [ ] **Step 4: 验证 iOS 编译还通过**

Run:
```bash
cd .worktrees/ios-port
pnpm tauri ios build --debug 2>&1 | tail -20
```

Expected: build 成功（或至少到 link 阶段不报 Keychain 相关错；如果其他 WIP 把 build 卡住，记下来不算本任务失败）。

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/gen/apple/Sources/Plugins/IOSBridge/Keychain.swift src-tauri/gen/apple/project.yml src-tauri/gen/apple/mdeditor.xcodeproj/project.pbxproj
git -C .worktrees/ios-port commit -m "feat(vault): Swift Keychain bridge"
```

---

### Task 6: Rust `keychain.rs` 包装（iOS via Tauri invoke, 非 iOS 用文件桩）

**Files:**
- Create: `src-tauri/src/vault_ios/keychain.rs`
- Modify: `src-tauri/src/vault_ios/tests/mod.rs`

- [ ] **Step 1: 写失败的测试**

在 `tests/mod.rs` 追加：

```rust
#[test]
fn keychain_stub_roundtrip() {
    let dir = tempdir().unwrap();
    std::env::set_var("MDEDITOR_KEYCHAIN_STUB_DIR", dir.path());
    crate::vault_ios::keychain::stub::set("pat", "secret-token").unwrap();
    let got = crate::vault_ios::keychain::stub::get("pat").unwrap();
    assert_eq!(got.as_deref(), Some("secret-token"));
    crate::vault_ios::keychain::stub::delete("pat").unwrap();
    let gone = crate::vault_ios::keychain::stub::get("pat").unwrap();
    assert_eq!(gone, None);
    std::env::remove_var("MDEDITOR_KEYCHAIN_STUB_DIR");
}
```

- [ ] **Step 2: 跑测试看失败**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::keychain 2>&1 | tail -10`
Expected: 编译失败 `module keychain` 不存在。

- [ ] **Step 3: 实现 keychain.rs**

写 `src-tauri/src/vault_ios/keychain.rs`:

```rust
use super::VaultError;

/// Read PAT from secure storage.
///
/// On iOS: invokes the Swift Keychain plugin (`plugin:keychain|get`).
/// On other targets (cargo test on macOS): reads from a JSON file under
/// `$MDEDITOR_KEYCHAIN_STUB_DIR`, so unit tests work without real Keychain.
pub fn get_pat() -> Result<String, VaultError> {
    #[cfg(target_os = "ios")]
    { return ios::get("pat")?.ok_or(VaultError::NotConfigured); }

    #[cfg(not(target_os = "ios"))]
    { return stub::get("pat")?.ok_or(VaultError::NotConfigured); }
}

#[cfg(target_os = "ios")]
pub mod ios {
    use super::VaultError;
    use tauri::AppHandle;

    // We don't have an AppHandle in pure sync code paths, so we use the
    // app handle managed via global state. In practice Tauri commands invoked
    // from the front-end pass the AppHandle in; for background sync threads
    // we pass it as a parameter (see sync.rs).
    pub fn set(_account: &str, _value: &str) -> Result<(), VaultError> {
        // Note: iOS keychain access from Rust is mediated via the front-end
        // calling the Swift plugin directly (vault_configure flow), so this
        // function is only used from internal Rust code paths post-config.
        // We currently treat write via the explicit configure command path,
        // not from arbitrary Rust threads, so this is intentionally unimplemented.
        Err(VaultError::FsError("keychain set must go via plugin:keychain|set from JS".into()))
    }

    pub fn get(_account: &str) -> Result<Option<String>, VaultError> {
        // Same caveat as above. The actual Get from Rust would need an
        // AppHandle to invoke the plugin. We refactor sync.rs to pass the
        // PAT in directly (read by front-end before invoking sync) — see
        // Task 11 / 12. So this stub returns NotConfigured to enforce that.
        Err(VaultError::NotConfigured)
    }

    pub fn delete(_account: &str) -> Result<(), VaultError> {
        Err(VaultError::FsError("keychain delete must go via plugin:keychain|delete from JS".into()))
    }
}

#[cfg(not(target_os = "ios"))]
pub mod stub {
    use super::VaultError;
    use std::path::PathBuf;

    fn dir() -> PathBuf {
        std::env::var("MDEDITOR_KEYCHAIN_STUB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("mdeditor-keychain-stub"))
    }

    fn path(account: &str) -> PathBuf {
        dir().join(format!("{account}.txt"))
    }

    pub fn set(account: &str, value: &str) -> Result<(), VaultError> {
        std::fs::create_dir_all(dir())?;
        std::fs::write(path(account), value)?;
        Ok(())
    }

    pub fn get(account: &str) -> Result<Option<String>, VaultError> {
        let p = path(account);
        if !p.exists() { return Ok(None); }
        Ok(Some(std::fs::read_to_string(p)?))
    }

    pub fn delete(account: &str) -> Result<(), VaultError> {
        let p = path(account);
        if p.exists() { std::fs::remove_file(p)?; }
        Ok(())
    }
}
```

**架构决定**：iOS Rust 不直接 invoke Keychain plugin（Tauri sync 调用 plugin 在 Rust 端比较绕）。取而代之，前端在调 `vault_sync_now` / `vault_configure` 前先用 `invoke('plugin:keychain|get', { account: 'pat' })` 取 PAT，作为参数传给 Rust 命令。Rust 拿到 PAT 直接喂给 libgit2 credentials callback。这种方式：
- Rust 侧不依赖 Tauri Plugin 通讯（避免 sync command 内嵌套 plugin invoke）
- PAT 只在内存生存一次 invoke 的时间
- 测试时用 stub 文件桩，自然走通

- [ ] **Step 4: 跑测试看通过**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::keychain 2>&1 | tail -10`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/src/vault_ios/keychain.rs src-tauri/src/vault_ios/tests
git -C .worktrees/ios-port commit -m "feat(vault): keychain rust wrapper + macos file stub for tests"
```

---

## Phase 4 — Sync engine

### Task 7: Author signature helper

**Files:**
- Create: `src-tauri/src/vault_ios/sig.rs`
- Modify: `src-tauri/src/vault_ios/tests/mod.rs`

- [ ] **Step 1: 写失败的测试**

在 `tests/mod.rs` 追加：

```rust
#[test]
fn sig_uses_configured_name_and_email() {
    let mgr = crate::vault_ios::VaultIosManager::new();
    *mgr.author_name.lock().unwrap() = "Alice".into();
    *mgr.author_email.lock().unwrap() = "a@example.com".into();
    let sig = crate::vault_ios::sig::author_sig(&mgr).unwrap();
    assert_eq!(sig.name(), Some("Alice"));
    assert_eq!(sig.email(), Some("a@example.com"));
}

#[test]
fn sig_falls_back_when_email_empty() {
    let mgr = crate::vault_ios::VaultIosManager::new();
    *mgr.author_name.lock().unwrap() = "Bob".into();
    // email left empty
    let sig = crate::vault_ios::sig::author_sig(&mgr).unwrap();
    assert_eq!(sig.email(), Some("noreply@mdeditor.local"));
}
```

- [ ] **Step 2: 跑测试看失败**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::sig 2>&1 | tail -10`
Expected: 失败 `module sig` 不存在。

- [ ] **Step 3: 实现 sig.rs**

写 `src-tauri/src/vault_ios/sig.rs`:

```rust
use git2::Signature;
use super::{VaultError, VaultIosManager};

pub fn author_sig<'a>(mgr: &VaultIosManager) -> Result<Signature<'a>, VaultError> {
    let name = mgr.author_name.lock().unwrap().clone();
    let mut email = mgr.author_email.lock().unwrap().clone();
    if email.is_empty() {
        email = "noreply@mdeditor.local".into();
    }
    Signature::now(&name, &email).map_err(VaultError::from)
}

pub fn timestamp_compact() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let tod = secs % 86400;
    let h = tod / 3600;
    let m = (tod % 3600) / 60;
    let s = tod % 60;
    // YYYYMMDD-HHMMSS (UTC, no DST math, approximate calendar)
    let mut y = 1970u64;
    let mut rem = days;
    loop {
        let dy = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 366 } else { 365 };
        if rem < dy { break; }
        rem -= dy;
        y += 1;
    }
    let mt: [u64; 12] = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
        [31,29,31,30,31,30,31,31,30,31,30,31]
    } else {
        [31,28,31,30,31,30,31,31,30,31,30,31]
    };
    let mut mo = 1u64;
    for &d in &mt { if rem < d { break; } rem -= d; mo += 1; }
    let day = rem + 1;
    format!("{y:04}{mo:02}{day:02}-{h:02}{m:02}{s:02}")
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::sig 2>&1 | tail -10`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/src/vault_ios/sig.rs src-tauri/src/vault_ios/tests
git -C .worktrees/ios-port commit -m "feat(vault): author signature + timestamp helper"
```

---

### Task 8: Clone 实现（vault_configure 命令）

**Files:**
- Create: `src-tauri/src/vault_ios/clone.rs`
- Modify: `src-tauri/src/vault_ios/tests/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败的集成测试（本地裸仓 → clone 到 tmpdir）**

在 `tests/mod.rs` 追加：

```rust
use std::process::Command;

fn make_bare_remote() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempdir().unwrap();
    let remote = dir.path().join("remote.git");
    Command::new("git").args(["init", "--bare", remote.to_str().unwrap()]).output().unwrap();

    // Add an initial commit via a clone, then push.
    let work = dir.path().join("work");
    Command::new("git").args(["clone", remote.to_str().unwrap(), work.to_str().unwrap()]).output().unwrap();
    std::fs::write(work.join("README.md"), "hello").unwrap();
    Command::new("git").args(["-C", work.to_str().unwrap(), "config", "user.email", "t@t.test"]).output().unwrap();
    Command::new("git").args(["-C", work.to_str().unwrap(), "config", "user.name", "t"]).output().unwrap();
    Command::new("git").args(["-C", work.to_str().unwrap(), "add", "."]).output().unwrap();
    Command::new("git").args(["-C", work.to_str().unwrap(), "commit", "-m", "init"]).output().unwrap();
    Command::new("git").args(["-C", work.to_str().unwrap(), "push", "origin", "HEAD:main"]).output().unwrap();

    let keep = tempfile::TempDir::new().unwrap();
    let _ = (work, dir);
    (keep, remote)
}

#[test]
fn clone_local_bare_repo_succeeds() {
    let (_keep, remote) = make_bare_remote();
    let dest = tempdir().unwrap();
    let vault_dir = dest.path().join("Vault");

    let res = crate::vault_ios::clone::clone_repo(
        remote.to_str().unwrap(),
        "main",
        "fake-pat-not-checked-for-local-path",
        &vault_dir,
        |_progress| {},
    );
    assert!(res.is_ok(), "clone failed: {res:?}");
    assert!(vault_dir.join("README.md").exists());
    assert!(vault_dir.join(".git").exists());
}
```

注：local path remote 不需要凭据，credentials callback 不会被触发，PAT 字符串可随意。这测的是 clone 流程本身，不测 HTTPS 鉴权。

- [ ] **Step 2: 跑测试看失败**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::clone 2>&1 | tail -10`
Expected: 失败 `module clone` 不存在。

- [ ] **Step 3: 实现 clone.rs**

写 `src-tauri/src/vault_ios/clone.rs`:

```rust
use std::path::Path;
use git2::{build::RepoBuilder, FetchOptions, RemoteCallbacks, Cred, Progress};

use super::VaultError;

pub struct CloneProgress {
    pub stage: String,
    pub received_objects: usize,
    pub total_objects: usize,
    pub bytes: usize,
}

pub fn clone_repo<P: Fn(CloneProgress)>(
    remote_url: &str,
    branch: &str,
    pat: &str,
    dest: &Path,
    on_progress: P,
) -> Result<(), VaultError> {
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }

    let pat_owned = pat.to_string();
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_url, _username_from_url, _allowed| {
        Cred::userpass_plaintext("x-access-token", &pat_owned)
    });
    cb.transfer_progress(|stats: Progress| {
        on_progress(CloneProgress {
            stage: "receiving".into(),
            received_objects: stats.received_objects(),
            total_objects: stats.total_objects(),
            bytes: stats.received_bytes(),
        });
        true
    });

    let mut fo = FetchOptions::new();
    fo.remote_callbacks(cb);

    let mut builder = RepoBuilder::new();
    builder.fetch_options(fo);
    builder.branch(branch);

    builder.clone(remote_url, dest).map_err(VaultError::from)?;

    // Mark the vault directory as excluded from iCloud backup.
    // libgit2 doesn't set extended attributes, and Tauri's path API doesn't
    // expose this; we use a tiny Foundation FFI from Rust on iOS targets.
    #[cfg(target_os = "ios")]
    let _ = mark_excluded_from_backup(dest);

    Ok(())
}

/// Set `NSURLIsExcludedFromBackupKey=true` on the given path so iOS skips
/// iCloud backup for this directory. No-op on non-iOS targets.
///
/// We bridge through Foundation directly rather than adding another Swift
/// command, since this is a single CFURL setResourceValue call.
#[cfg(target_os = "ios")]
fn mark_excluded_from_backup(_path: &Path) -> Result<(), VaultError> {
    // Implementation: use `objc2` crate or direct extern bindings to
    // call `-[NSURL setResourceValue:forKey:error:]` with the
    // `NSURLIsExcludedFromBackupKey` constant.
    //
    // To avoid pulling in `objc2`, we instead extend the Swift bridge
    // (Task 5) with a `markExcludedFromBackup(path:)` command and invoke
    // it from front-end after vault_configure resolves. See Task 5 Step 6
    // for the Swift addition.
    //
    // This Rust function is a stub; the actual call happens TS-side in
    // configureVault() after vault_configure resolves (see Task 11).
    Ok(())
}
```

注：实际的 `NSURLIsExcludedFromBackupKey` 设置在 Task 5（Swift 桥）和 Task 11（TS 调用）协作完成。这里 Rust 留个 stub 作占位。

- [ ] **Step 4: 跑测试看通过**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::clone 2>&1 | tail -15`
Expected: 1 passed.

- [ ] **Step 5: 添加 `vault_configure` 命令**

在 `src-tauri/src/vault_ios/mod.rs` 追加：

```rust
use tauri::Emitter;
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub async fn vault_configure(
    app: AppHandle,
    cfg: VaultConfigure,
) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultIosManager>>();

    // Save non-secret config to settings.json.
    if let Ok(store) = app.store("settings.json") {
        let _ = store.set("vault_ios.remote_url", serde_json::json!(&cfg.remote_url));
        let _ = store.set("vault_ios.branch", serde_json::json!(&cfg.branch));
        let _ = store.set("vault_ios.author_name", serde_json::json!(&cfg.author_name));
        let _ = store.set("vault_ios.author_email", serde_json::json!(&cfg.author_email));
        let _ = store.save();
    }

    *mgr.remote_url.lock().unwrap() = Some(cfg.remote_url.clone());
    *mgr.branch.lock().unwrap() = cfg.branch.clone();
    *mgr.author_name.lock().unwrap() = cfg.author_name.clone();
    *mgr.author_email.lock().unwrap() = cfg.author_email.clone();
    *mgr.state.lock().unwrap() = SyncState::Cloning;
    let _ = app.emit("vault-status-changed", ());

    let dest = path::vault_path(&app).map_err(|e| e.to_string())?;
    let app_for_progress = app.clone();
    let clone_result = clone::clone_repo(
        &cfg.remote_url,
        &cfg.branch,
        &cfg.pat,
        &dest,
        move |p| {
            let _ = app_for_progress.emit("vault-clone-progress", serde_json::json!({
                "stage": p.stage,
                "received_objects": p.received_objects,
                "total_objects": p.total_objects,
                "bytes": p.bytes,
            }));
        },
    );

    match clone_result {
        Ok(()) => {
            *mgr.state.lock().unwrap() = SyncState::Idle;
            *mgr.last_sync.lock().unwrap() = Some(now_ms());
            *mgr.error_msg.lock().unwrap() = None;
            let _ = app.emit("vault-status-changed", ());
            Ok(())
        }
        Err(e) => {
            *mgr.state.lock().unwrap() = SyncState::Error;
            *mgr.error_msg.lock().unwrap() = Some(e.to_string());
            let _ = app.emit("vault-status-changed", ());
            Err(e.to_string())
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
```

- [ ] **Step 6: 注册命令**

`src-tauri/src/lib.rs` 的 iOS 分支补 `vault_ios::vault_configure`。

- [ ] **Step 7: 验证 iOS 编译还通过**

Run: `cd .worktrees/ios-port/src-tauri && cargo build --target aarch64-apple-ios 2>&1 | tail -5`
Expected: 编译通过。

- [ ] **Step 8: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/src/vault_ios/clone.rs src-tauri/src/vault_ios/mod.rs src-tauri/src/vault_ios/tests src-tauri/src/lib.rs
git -C .worktrees/ios-port commit -m "feat(vault): clone + vault_configure command"
```

---

### Task 9: `sync_once` 实现（fast-forward + dirty path + 冲突）

**Files:**
- Create: `src-tauri/src/vault_ios/sync.rs`
- Create: `src-tauri/src/vault_ios/conflict.rs`
- Modify: `src-tauri/src/vault_ios/tests/mod.rs`
- Modify: `src-tauri/src/vault_ios/mod.rs`

- [ ] **Step 1: 写失败的测试 —— clean workdir fast-forward 场景**

在 `tests/mod.rs` 追加：

```rust
fn clone_with_local_path(remote: &Path) -> tempfile::TempDir {
    let dest = tempdir().unwrap();
    let vault = dest.path().join("Vault");
    crate::vault_ios::clone::clone_repo(
        remote.to_str().unwrap(),
        "main",
        "n/a",
        &vault,
        |_| {},
    ).unwrap();
    dest
}

#[test]
fn sync_clean_workdir_fast_forwards() {
    let (_keep, remote) = make_bare_remote();
    let local = clone_with_local_path(&remote);
    let vault = local.path().join("Vault");

    // Make remote commit by going through bare repo's working clone.
    let work = tempdir().unwrap();
    Command::new("git").args(["clone", remote.to_str().unwrap(), work.path().to_str().unwrap()]).output().unwrap();
    std::fs::write(work.path().join("new.md"), "hi").unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "add", "."]).output().unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "config", "user.email", "t@t"]).output().unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "config", "user.name", "t"]).output().unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "commit", "-m", "remote"]).output().unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "push"]).output().unwrap();

    let mgr = crate::vault_ios::VaultIosManager::new();
    *mgr.author_name.lock().unwrap() = "T".into();
    *mgr.author_email.lock().unwrap() = "t@t".into();

    let outcome = crate::vault_ios::sync::sync_once(&mgr, &vault, "main", remote.to_str().unwrap(), "fake-pat").unwrap();
    assert!(matches!(outcome, crate::vault_ios::sync::SyncOutcome::PullOnly));
    assert!(vault.join("new.md").exists());
}

#[test]
fn sync_dirty_workdir_commits_and_pushes() {
    let (_keep, remote) = make_bare_remote();
    let local = clone_with_local_path(&remote);
    let vault = local.path().join("Vault");

    std::fs::write(vault.join("README.md"), "edited").unwrap();

    let mgr = crate::vault_ios::VaultIosManager::new();
    *mgr.author_name.lock().unwrap() = "T".into();
    *mgr.author_email.lock().unwrap() = "t@t".into();

    let outcome = crate::vault_ios::sync::sync_once(&mgr, &vault, "main", remote.to_str().unwrap(), "fake-pat").unwrap();
    assert!(matches!(outcome, crate::vault_ios::sync::SyncOutcome::Pushed { .. }));

    // Verify remote has the new commit by re-cloning.
    let verify = tempdir().unwrap();
    Command::new("git").args(["clone", remote.to_str().unwrap(), verify.path().to_str().unwrap()]).output().unwrap();
    assert_eq!(std::fs::read_to_string(verify.path().join("README.md")).unwrap(), "edited");
}
```

- [ ] **Step 2: 跑测试看失败**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::sync 2>&1 | tail -15`
Expected: 失败 `module sync` 不存在。

- [ ] **Step 3: 实现 conflict.rs**

写 `src-tauri/src/vault_ios/conflict.rs`:

```rust
use std::path::Path;
use git2::{Repository, build::CheckoutBuilder};

use super::VaultError;
use super::sig::timestamp_compact;

/// Walk conflicted index entries. For each:
///   1. Copy the working-tree file (which holds OUR version after stash-pop) to
///      `<basename>.conflict.<ts><.ext>`
///   2. Check out the THEIRS version into the working tree
///   3. Stage both files
pub fn handle(repo: &Repository, log: &mut Vec<String>) -> Result<(), VaultError> {
    let workdir = repo.workdir().ok_or_else(|| VaultError::FsError("no workdir".into()))?.to_path_buf();
    let ts = timestamp_compact();

    let mut index = repo.index()?;
    let conflicts: Vec<_> = index.conflicts()?.collect::<Result<Vec<_>, _>>()?;

    for c in &conflicts {
        // The "our" side is in c.our; path is encoded as bytes.
        let our_entry = match c.our.as_ref() {
            Some(e) => e,
            None => continue,
        };
        let path_str = std::str::from_utf8(&our_entry.path).map_err(|e| VaultError::FsError(e.to_string()))?;
        let file_path = workdir.join(path_str);

        if file_path.exists() {
            let conflict_path = make_conflict_path(&file_path, &ts);
            if let Err(e) = std::fs::copy(&file_path, &conflict_path) {
                tracing::warn!("conflict copy failed for {}: {}", path_str, e);
                continue;
            }
            log.push(conflict_path.display().to_string());
        }
    }

    // Checkout theirs for each conflicted path.
    let mut co = CheckoutBuilder::new();
    co.force().use_theirs(true);
    for c in &conflicts {
        if let Some(e) = c.their.as_ref().or(c.our.as_ref()) {
            if let Ok(p) = std::str::from_utf8(&e.path) {
                co.path(p);
            }
        }
    }
    repo.checkout_index(Some(&mut index), Some(&mut co))?;

    // Re-stage everything (including the .conflict backups).
    let mut index2 = repo.index()?;
    index2.add_all(["."].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index2.write()?;

    Ok(())
}

fn make_conflict_path(file_path: &Path, ts: &str) -> std::path::PathBuf {
    let stem = file_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = file_path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{stem}.conflict.{ts}{ext}"))
}
```

- [ ] **Step 4: 实现 sync.rs**

写 `src-tauri/src/vault_ios/sync.rs`:

```rust
use std::path::Path;
use git2::{
    Repository, FetchOptions, PushOptions, RemoteCallbacks, Cred,
    IndexAddOption, build::CheckoutBuilder,
};

use super::{VaultError, VaultIosManager, conflict, sig::{author_sig, timestamp_compact}};

#[derive(Debug)]
pub enum SyncOutcome {
    PullOnly,
    NoOp,
    Pushed { conflicts: Vec<String> },
}

fn make_credentials_cb<'a>(pat: &'a str) -> RemoteCallbacks<'a> {
    let pat_owned = pat.to_string();
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_url, _user, _allowed| {
        Cred::userpass_plaintext("x-access-token", &pat_owned)
    });
    cb
}

fn has_workdir_changes(repo: &Repository) -> Result<bool, VaultError> {
    let statuses = repo.statuses(None)?;
    Ok(!statuses.is_empty())
}

fn fast_forward(repo: &Repository, branch: &str) -> Result<(), VaultError> {
    let refname = format!("refs/remotes/origin/{branch}");
    let remote_oid = repo.refname_to_id(&refname)?;
    let mut local_ref = repo.find_reference(&format!("refs/heads/{branch}"))?;
    local_ref.set_target(remote_oid, "vault: ff")?;
    repo.set_head(&format!("refs/heads/{branch}"))?;
    let mut co = CheckoutBuilder::new();
    co.force();
    repo.checkout_head(Some(&mut co))?;
    Ok(())
}

pub fn sync_once(
    mgr: &VaultIosManager,
    vault_dir: &Path,
    branch: &str,
    _remote_url_for_logging: &str,
    pat: &str,
) -> Result<SyncOutcome, VaultError> {
    let repo = Repository::open(vault_dir)?;
    let mut conflicts_log = Vec::<String>::new();

    // 1. fetch
    {
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(make_credentials_cb(pat));
        repo.find_remote("origin")?.fetch(&[branch], Some(&mut fo), None)?;
    }

    let dirty = has_workdir_changes(&repo)?;

    if !dirty {
        // Try fast-forward.
        let local_oid = repo.refname_to_id(&format!("refs/heads/{branch}"))?;
        let remote_oid = repo.refname_to_id(&format!("refs/remotes/origin/{branch}"))?;
        if local_oid == remote_oid {
            return Ok(SyncOutcome::NoOp);
        }
        let merge_base = repo.merge_base(local_oid, remote_oid).ok();
        if merge_base == Some(local_oid) {
            fast_forward(&repo, branch)?;
            return Ok(SyncOutcome::PullOnly);
        }
        // Divergence with no local changes — should be rare; do rebase-style attempt.
        // Pragmatically: reset --hard origin/branch (safe since no local changes).
        let target = repo.find_object(remote_oid, None)?;
        repo.reset(&target, git2::ResetType::Hard, None)?;
        return Ok(SyncOutcome::PullOnly);
    }

    // 2. Dirty path: stash → rebase → pop → handle conflicts → commit → push.
    let sig = author_sig(mgr)?;
    let mut repo_mut = Repository::open(vault_dir)?;
    let _stash_oid = repo_mut.stash_save(&sig, "vault-auto", None)?;

    // Rebase HEAD onto origin/branch.
    let remote_oid = repo.refname_to_id(&format!("refs/remotes/origin/{branch}"))?;
    let onto = repo.find_annotated_commit(remote_oid)?;
    let head = repo.head()?.peel_to_commit()?;
    let upstream = repo.find_annotated_commit(head.id())?;

    let mut rebase = match repo.rebase(Some(&upstream), Some(&onto), Some(&onto), None) {
        Ok(r) => r,
        Err(_) => {
            let _ = repo_mut.stash_pop(0, None);
            return Err(VaultError::RebaseFailed);
        }
    };

    while let Some(op) = rebase.next() {
        op.map_err(VaultError::from)?;
        rebase.commit(None, &sig, None).map_err(VaultError::from)?;
    }
    rebase.finish(Some(&sig)).map_err(VaultError::from)?;

    // 3. Pop stash; on conflict, run conflict::handle.
    let pop_result = repo_mut.stash_pop(0, None);
    if let Err(e) = pop_result {
        if e.code() == git2::ErrorCode::Conflict || e.message().contains("conflict") {
            conflict::handle(&repo, &mut conflicts_log)?;
            *mgr.has_conflicts.lock().unwrap() = !conflicts_log.is_empty();
        } else {
            return Err(VaultError::from(e));
        }
    }

    // 4. add -A + commit.
    let mut index = repo.index()?;
    index.add_all(["."].iter(), IndexAddOption::DEFAULT, None)?;
    index.write()?;

    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let parent = repo.head()?.peel_to_commit()?;
    let parent_tree = parent.tree()?;
    if tree.id() != parent_tree.id() {
        let msg = format!("vault: auto-sync {}", timestamp_compact());
        repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &[&parent])?;
    }

    // 5. push.
    {
        let mut po = PushOptions::new();
        po.remote_callbacks(make_credentials_cb(pat));
        let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch);
        repo.find_remote("origin")?.push(&[&refspec], Some(&mut po))?;
    }

    Ok(SyncOutcome::Pushed { conflicts: conflicts_log })
}
```

- [ ] **Step 5: 跑测试看通过**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests::sync 2>&1 | tail -15`
Expected: 2 passed.

- [ ] **Step 6: 添加 `vault_sync_now` 命令**

在 `src-tauri/src/vault_ios/mod.rs` 追加：

```rust
#[tauri::command]
pub async fn vault_sync_now(app: AppHandle, pat: String) -> Result<VaultStatus, String> {
    let mgr = app.state::<Arc<VaultIosManager>>();

    let configured = mgr.remote_url.lock().unwrap().is_some();
    if !configured {
        *mgr.state.lock().unwrap() = SyncState::Error;
        *mgr.error_msg.lock().unwrap() = Some("not configured".into());
        return Err("vault not configured".into());
    }

    *mgr.state.lock().unwrap() = SyncState::Syncing;
    *mgr.error_msg.lock().unwrap() = None;
    let _ = app.emit("vault-status-changed", ());

    let vault_dir = path::vault_path(&app).map_err(|e| e.to_string())?;
    if !vault_dir.join(".git").exists() {
        *mgr.state.lock().unwrap() = SyncState::NotConfigured;
        let _ = app.emit("vault-status-changed", ());
        return Err("vault directory missing".into());
    }

    let branch = mgr.branch.lock().unwrap().clone();
    let remote_url = mgr.remote_url.lock().unwrap().clone().unwrap_or_default();

    let mgr_clone = Arc::clone(&mgr);
    let result = tokio::task::spawn_blocking(move || {
        sync::sync_once(&mgr_clone, &vault_dir, &branch, &remote_url, &pat)
    }).await.map_err(|e| e.to_string())?;

    match result {
        Ok(_outcome) => {
            *mgr.state.lock().unwrap() = SyncState::Idle;
            *mgr.last_sync.lock().unwrap() = Some(now_ms());
            let _ = app.emit("vault-status-changed", ());
            Ok(mgr.snapshot_status(true))
        }
        Err(e) => {
            *mgr.state.lock().unwrap() = SyncState::Error;
            *mgr.error_msg.lock().unwrap() = Some(e.to_string());
            let _ = app.emit("vault-status-changed", ());
            Err(e.to_string())
        }
    }
}
```

注：`mgr.state.lock().unwrap()` 的取用方式需要 `let mgr = app.state::<Arc<VaultIosManager>>();` 提供 deref，`Arc` 不直接 deref 到 mutex，但 `app.state()` 返回的 `State<Arc<T>>` 是 `Deref<Target = Arc<T>>`，再调 `.state.lock()` 需要 `(**mgr).state.lock()` 或先 `let mgr = mgr.inner().clone();`。具体写法按 Tauri 2 实际 API 调整（参考 macOS `vault_sync::vault_sync_now`）。

- [ ] **Step 7: 注册命令**

`src-tauri/src/lib.rs` iOS 分支补 `vault_ios::vault_sync_now`。

- [ ] **Step 8: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/src/vault_ios src-tauri/src/lib.rs
git -C .worktrees/ios-port commit -m "feat(vault): sync_once + vault_sync_now command"
```

---

### Task 10: 冲突场景集成测试 + `vault_disconnect` 命令

**Files:**
- Modify: `src-tauri/src/vault_ios/tests/mod.rs`
- Modify: `src-tauri/src/vault_ios/mod.rs`

- [ ] **Step 1: 写冲突测试**

```rust
#[test]
fn sync_conflict_keeps_local_as_conflict_file() {
    let (_keep, remote) = make_bare_remote();
    let local = clone_with_local_path(&remote);
    let vault = local.path().join("Vault");

    // Remote changes README.md
    let work = tempdir().unwrap();
    Command::new("git").args(["clone", remote.to_str().unwrap(), work.path().to_str().unwrap()]).output().unwrap();
    std::fs::write(work.path().join("README.md"), "remote-version").unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "add", "."]).output().unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "config", "user.email", "t@t"]).output().unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "config", "user.name", "t"]).output().unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "commit", "-m", "remote edit"]).output().unwrap();
    Command::new("git").args(["-C", work.path().to_str().unwrap(), "push"]).output().unwrap();

    // Local also changes README.md (different content)
    std::fs::write(vault.join("README.md"), "local-version").unwrap();

    let mgr = crate::vault_ios::VaultIosManager::new();
    *mgr.author_name.lock().unwrap() = "T".into();
    *mgr.author_email.lock().unwrap() = "t@t".into();

    let outcome = crate::vault_ios::sync::sync_once(&mgr, &vault, "main", remote.to_str().unwrap(), "fake-pat").unwrap();
    match outcome {
        crate::vault_ios::sync::SyncOutcome::Pushed { conflicts } => {
            assert!(!conflicts.is_empty(), "expected conflict log entries");
        }
        other => panic!("expected Pushed with conflicts, got {other:?}"),
    }

    // The .conflict.<ts>.md file should exist alongside README.md
    let entries: Vec<_> = std::fs::read_dir(&vault).unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(entries.iter().any(|n| n.starts_with("README.conflict.") && n.ends_with(".md")),
        "no conflict backup file found in {entries:?}");

    // The README.md itself should be the remote version (theirs).
    assert_eq!(std::fs::read_to_string(vault.join("README.md")).unwrap(), "remote-version");
}
```

- [ ] **Step 2: 跑测试看通过**

Run: `cd .worktrees/ios-port/src-tauri && cargo test --lib vault_ios::tests 2>&1 | tail -15`
Expected: 全部 passed（先前 + 这条）。

- [ ] **Step 3: 添加 `vault_disconnect` 命令**

在 `mod.rs` 追加：

```rust
#[tauri::command]
pub async fn vault_disconnect(app: AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultIosManager>>();

    let vault_dir = path::vault_path(&app).map_err(|e| e.to_string())?;
    if vault_dir.exists() {
        std::fs::remove_dir_all(&vault_dir).map_err(|e| e.to_string())?;
    }

    if let Ok(store) = app.store("settings.json") {
        let _ = store.delete("vault_ios.remote_url");
        let _ = store.delete("vault_ios.branch");
        let _ = store.delete("vault_ios.author_name");
        let _ = store.delete("vault_ios.author_email");
        let _ = store.save();
    }

    *mgr.remote_url.lock().unwrap() = None;
    *mgr.state.lock().unwrap() = SyncState::NotConfigured;
    *mgr.last_sync.lock().unwrap() = None;
    *mgr.error_msg.lock().unwrap() = None;
    *mgr.has_conflicts.lock().unwrap() = false;
    let _ = app.emit("vault-status-changed", ());
    Ok(())
}
```

- [ ] **Step 4: 注册命令**

`lib.rs` iOS 分支补 `vault_ios::vault_disconnect`。

- [ ] **Step 5: 验证 iOS 编译通过**

Run: `cd .worktrees/ios-port/src-tauri && cargo build --target aarch64-apple-ios 2>&1 | tail -5`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git -C .worktrees/ios-port add src-tauri/src/vault_ios src-tauri/src/lib.rs
git -C .worktrees/ios-port commit -m "feat(vault): conflict integration test + disconnect command"
```

---

## Phase 5 — TypeScript layer

### Task 11: `vault.svelte.ts` 状态 store + invoke 包装

**Files:**
- Create: `src/lib/vault.svelte.ts`
- Create: `src/lib/vault.test.ts`

- [ ] **Step 1: 写失败的测试**

写 `src/lib/vault.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { vaultStore, syncNow, refreshStatus, _resetForTests } from './vault.svelte'

describe('vault store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTests()
  })

  it('refreshStatus updates store from invoke result', async () => {
    ;(invoke as any).mockResolvedValueOnce({
      state: 'idle', last_sync: 123, error_message: null, has_conflicts: false, configured: true,
    })
    await refreshStatus()
    expect(vaultStore.configured).toBe(true)
    expect(vaultStore.state).toBe('idle')
    expect(vaultStore.lastSync).toBe(123)
  })

  it('syncNow dedups within 30s window', async () => {
    ;(invoke as any).mockResolvedValue({
      state: 'idle', last_sync: Date.now(), error_message: null, has_conflicts: false, configured: true,
    })

    await syncNow()
    const callCount1 = (invoke as any).mock.calls.length
    await syncNow()
    const callCount2 = (invoke as any).mock.calls.length

    // First call invokes vault_sync_now (preceded by plugin:keychain|get).
    // Second call within 30s should NOT re-invoke vault_sync_now.
    const syncCalls1 = (invoke as any).mock.calls.filter((c: any[]) => c[0] === 'vault_sync_now').length
    expect(syncCalls1).toBe(1)
    expect(callCount2).toBe(callCount1) // no new calls
  })

  it('syncNow allows re-trigger after 30s', async () => {
    ;(invoke as any).mockResolvedValue({
      state: 'idle', last_sync: Date.now(), error_message: null, has_conflicts: false, configured: true,
    })

    await syncNow()
    // Force lastSync back 31s
    vaultStore.lastSync = Date.now() - 31_000
    await syncNow()

    const syncCalls = (invoke as any).mock.calls.filter((c: any[]) => c[0] === 'vault_sync_now').length
    expect(syncCalls).toBe(2)
  })

  it('syncNow propagates error to errorMsg', async () => {
    ;(invoke as any).mockImplementation((cmd: string) => {
      if (cmd === 'plugin:keychain|get') return Promise.resolve({ value: 'pat' })
      if (cmd === 'vault_sync_now') return Promise.reject('Vault: 鉴权失败')
      return Promise.resolve(null)
    })
    await syncNow().catch(() => {})
    expect(vaultStore.errorMsg).toContain('鉴权失败')
  })
})
```

- [ ] **Step 2: 跑测试看失败**

Run: `cd .worktrees/ios-port && pnpm vitest run src/lib/vault.test.ts 2>&1 | tail -10`
Expected: 失败（模块不存在）。

- [ ] **Step 3: 实现 vault.svelte.ts**

写 `src/lib/vault.svelte.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { pushToast } from './toast.svelte'

export type VaultState = 'idle' | 'cloning' | 'syncing' | 'error' | 'conflict' | 'not_configured'

interface VaultStatusFromRust {
  state: string
  last_sync: number | null
  error_message: string | null
  has_conflicts: boolean
  configured: boolean
}

export const vaultStore = $state<{
  configured: boolean
  state: VaultState
  lastSync: number | null
  errorMsg: string | null
  hasConflicts: boolean
}>({ configured: false, state: 'not_configured', lastSync: null, errorMsg: null, hasConflicts: false })

const SYNC_COOLDOWN_MS = 30_000

export function _resetForTests() {
  vaultStore.configured = false
  vaultStore.state = 'not_configured'
  vaultStore.lastSync = null
  vaultStore.errorMsg = null
  vaultStore.hasConflicts = false
}

function applyStatus(s: VaultStatusFromRust) {
  vaultStore.configured = s.configured
  vaultStore.state = (s.state as VaultState)
  vaultStore.lastSync = s.last_sync
  vaultStore.errorMsg = s.error_message
  vaultStore.hasConflicts = s.has_conflicts
}

export async function refreshStatus(): Promise<void> {
  try {
    const s = await invoke<VaultStatusFromRust>('vault_status')
    applyStatus(s)
  } catch (e) {
    vaultStore.errorMsg = String(e)
  }
}

async function readPat(): Promise<string | null> {
  try {
    const r = await invoke<{ value: string | null }>('plugin:keychain|get', { account: 'pat' })
    return r.value
  } catch {
    return null
  }
}

export async function syncNow(): Promise<void> {
  // 30s dedup: skip if last successful sync within window AND state is idle.
  if (vaultStore.state === 'idle' && vaultStore.lastSync !== null) {
    if (Date.now() - vaultStore.lastSync < SYNC_COOLDOWN_MS) return
  }
  if (vaultStore.state === 'syncing' || vaultStore.state === 'cloning') return
  if (!vaultStore.configured) return

  const pat = await readPat()
  if (!pat) {
    vaultStore.errorMsg = 'PAT not in Keychain'
    return
  }

  const before = vaultStore.lastSync
  try {
    const s = await invoke<VaultStatusFromRust>('vault_sync_now', { pat })
    applyStatus(s)
    const after = s.last_sync
    // Toast strategy (spec §4.5):
    //   - Success with change (push or pull): "✓ Vault 同步完成"
    //   - Success no change: silent
    //   - Conflict: "⚠️ Vault: 同步完成，N 个本地修改保留为 .conflict 副本"
    //   - Error: handled in catch block below
    if (s.has_conflicts) {
      pushToast({ level: 'warn', message: `⚠️ Vault: 同步完成，部分本地修改保留为 .conflict 副本` })
    } else if (after !== before) {
      // For now we conservatively show on every successful invocation that
      // resulted in a new last_sync timestamp. Rust returns SyncOutcome::NoOp
      // for no-change case but the current command unifies status; refine
      // when Rust emits a `changed: bool` field.
      pushToast({ level: 'success', message: '✓ Vault 同步完成' })
    }
  } catch (e) {
    const msg = typeof e === 'string' ? e : String(e)
    vaultStore.errorMsg = msg
    vaultStore.state = 'error'
    // Map Rust error string → friendly Chinese toast (spec §3.5).
    let friendly = `❌ Vault: ${msg}`
    if (msg.includes('auth') || msg.includes('鉴权')) friendly = '❌ Vault: 鉴权失败，请去 Vault 设置更新 PAT'
    else if (msg.includes('network') || msg.includes('网络')) friendly = '❌ Vault: 网络错误'
    else if (msg.includes('not found') || msg.includes('404')) friendly = '❌ Vault: 仓库不存在或 PAT 无权访问'
    else if (msg.includes('rebase')) friendly = '⚠️ Vault: 自动合并失败，本次跳过；下次再试'
    pushToast({ level: msg.includes('rebase') ? 'warn' : 'error', message: friendly, detail: msg })
    throw e
  }
}

export async function configureVault(opts: {
  remoteUrl: string
  branch: string
  pat: string
  authorName: string
  authorEmail: string
}): Promise<void> {
  // Write PAT to Keychain first
  await invoke('plugin:keychain|set', { account: 'pat', value: opts.pat })

  await invoke('vault_configure', {
    cfg: {
      remote_url: opts.remoteUrl,
      branch: opts.branch,
      pat: opts.pat,
      author_name: opts.authorName,
      author_email: opts.authorEmail,
    },
  })

  // Mark the freshly-cloned vault as excluded from iCloud backup.
  try {
    const { documentDir } = await import('@tauri-apps/api/path')
    const docs = await documentDir()
    const vaultPath = `${docs.replace(/\/$/, '')}/Vault`
    await invoke('plugin:keychain|markExcludedFromBackup', { path: vaultPath })
  } catch (e) {
    // Non-fatal: vault works; iCloud backup will redundantly copy files but
    // it won't break anything. Log and continue.
    console.warn('[vault] mark exclude-from-backup failed:', e)
  }

  await refreshStatus()
}

/// Fetch the authenticated GitHub user's login to default the noreply email.
/// Returns null on any failure (caller should leave the field for manual fill).
export async function fetchGitHubLogin(pat: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.login === 'string' ? data.login : null
  } catch {
    return null
  }
}

export async function disconnectVault(): Promise<void> {
  await invoke('plugin:keychain|delete', { account: 'pat' })
  await invoke('vault_disconnect')
  await refreshStatus()
}

// Listen for status push events from Rust
let listenerAttached = false
export function attachStatusListener(): void {
  if (listenerAttached) return
  listenerAttached = true
  listen('vault-status-changed', () => { refreshStatus() })
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `cd .worktrees/ios-port && pnpm vitest run src/lib/vault.test.ts 2>&1 | tail -10`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/ios-port add src/lib/vault.svelte.ts src/lib/vault.test.ts
git -C .worktrees/ios-port commit -m "feat(vault): TS store + invoke wrappers + tests"
```

---

### Task 12: `vault-list.ts` 文件类型映射

**Files:**
- Create: `src/lib/vault-list.ts`
- Create: `src/lib/vault-list.test.ts`

- [ ] **Step 1: 写失败的测试**

写 `src/lib/vault-list.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fileIcon, isImage, isText } from './vault-list'

describe('vault-list helpers', () => {
  it('returns correct icon by extension', () => {
    expect(fileIcon('md')).toBe('📝')
    expect(fileIcon('markdown')).toBe('📝')
    expect(fileIcon('html')).toBe('🌐')
    expect(fileIcon('htm')).toBe('🌐')
    expect(fileIcon('txt')).toBe('📄')
    expect(fileIcon('log')).toBe('📄')
    expect(fileIcon('png')).toBe('🖼️')
    expect(fileIcon('jpg')).toBe('🖼️')
    expect(fileIcon('webp')).toBe('🖼️')
    expect(fileIcon('unknown')).toBe('📄')
  })

  it('isImage detects image extensions', () => {
    expect(isImage('png')).toBe(true)
    expect(isImage('jpg')).toBe(true)
    expect(isImage('md')).toBe(false)
  })

  it('isText detects text extensions', () => {
    expect(isText('md')).toBe(true)
    expect(isText('txt')).toBe(true)
    expect(isText('html')).toBe(true)
    expect(isText('png')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试看失败**

Run: `cd .worktrees/ios-port && pnpm vitest run src/lib/vault-list.test.ts 2>&1 | tail -10`
Expected: 失败。

- [ ] **Step 3: 实现 vault-list.ts**

```ts
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd'])
const HTML_EXTS = new Set(['html', 'htm'])
const TEXT_EXTS = new Set(['txt', 'log', 'csv', 'tsv', 'env'])
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'avif'])

export function fileIcon(ext: string): string {
  const e = ext.toLowerCase()
  if (MARKDOWN_EXTS.has(e)) return '📝'
  if (HTML_EXTS.has(e)) return '🌐'
  if (IMAGE_EXTS.has(e)) return '🖼️'
  if (TEXT_EXTS.has(e)) return '📄'
  return '📄'
}

export function isImage(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase())
}

export function isText(ext: string): boolean {
  const e = ext.toLowerCase()
  return MARKDOWN_EXTS.has(e) || HTML_EXTS.has(e) || TEXT_EXTS.has(e)
}

export interface VaultListEntry {
  name: string
  kind: 'file' | 'dir'
  size: number | null
  mtime: number | null
  ext: string | null
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `cd .worktrees/ios-port && pnpm vitest run src/lib/vault-list.test.ts 2>&1 | tail -10`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/ios-port add src/lib/vault-list.ts src/lib/vault-list.test.ts
git -C .worktrees/ios-port commit -m "feat(vault): file icon + type classifier helpers"
```

---

## Phase 6 — UI

### Task 13: `VaultSettingsTab.svelte`

**Files:**
- Create: `src/components/VaultSettingsTab.svelte`

- [ ] **Step 1: 写 VaultSettingsTab.svelte**

```svelte
<script lang="ts">
  import { vaultStore, syncNow, configureVault, disconnectVault, refreshStatus, fetchGitHubLogin } from '../lib/vault.svelte'
  import { ask } from '@tauri-apps/plugin-dialog'
  import { openUrl } from '@tauri-apps/plugin-opener'

  let remoteUrl = $state('')
  let branch = $state('main')
  let pat = $state('')
  let authorName = $state('mdeditor on iOS')
  let authorEmail = $state('')
  let busy = $state(false)
  let saveError = $state<string | null>(null)
  let showPatInput = $state(false)

  $effect(() => { refreshStatus() })

  // When the user finishes typing a PAT, try to fetch their GitHub login
  // and auto-fill the noreply email (spec §2.5). Debounced 800ms; only
  // overwrite empty email field, never clobber user-entered value.
  let emailFetchTimer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    if (!pat || pat.length < 20) return
    if (emailFetchTimer) clearTimeout(emailFetchTimer)
    emailFetchTimer = setTimeout(async () => {
      if (authorEmail.trim() !== '') return  // user already filled it
      const login = await fetchGitHubLogin(pat)
      if (login && authorEmail.trim() === '') {
        authorEmail = `${login}@users.noreply.github.com`
      }
    }, 800)
  })

  async function onSave() {
    saveError = null
    busy = true
    try {
      await configureVault({ remoteUrl, branch, pat, authorName, authorEmail })
      showPatInput = false
      pat = ''
    } catch (e) {
      saveError = String(e)
    } finally {
      busy = false
    }
  }

  async function onDisconnect() {
    const ok = await ask('断开 Vault 将删除本机 Vault 副本和 Keychain 中的 PAT，远端仓库不受影响。继续？', {
      title: 'Disconnect Vault', kind: 'warning',
    })
    if (!ok) return
    busy = true
    try { await disconnectVault() } finally { busy = false }
  }

  function formatLastSync(ms: number | null): string {
    if (!ms) return '从未'
    const diff = Date.now() - ms
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
    return new Date(ms).toLocaleString()
  }

  async function openTokenPage() {
    try { await openUrl('https://github.com/settings/personal-access-tokens/new') } catch {}
  }
</script>

<section class="vault-settings">
  <div class="status-block">
    <div class="status-row">
      <span class="label">Status:</span>
      <span class="state state-{vaultStore.state}">
        {#if vaultStore.state === 'syncing'}同步中…
        {:else if vaultStore.state === 'cloning'}克隆中…
        {:else if vaultStore.state === 'idle'}✓ 上次同步：{formatLastSync(vaultStore.lastSync)}
        {:else if vaultStore.state === 'error'}❌ {vaultStore.errorMsg ?? '未知错误'}
        {:else if vaultStore.state === 'conflict'}⚠️ 有冲突文件
        {:else}未配置
        {/if}
      </span>
    </div>
    {#if vaultStore.configured}
      <div class="actions">
        <button onclick={() => syncNow()} disabled={busy || vaultStore.state === 'syncing'}>
          {vaultStore.state === 'syncing' ? '同步中…' : '立即同步'}
        </button>
        <button class="danger" onclick={onDisconnect} disabled={busy}>断开 Vault</button>
      </div>
    {/if}
  </div>

  <hr />

  <div class="form">
    <label>
      <span>Remote URL</span>
      <input type="text" bind:value={remoteUrl} placeholder="https://github.com/user/repo.git" />
    </label>
    <label>
      <span>Branch</span>
      <input type="text" bind:value={branch} placeholder="main" />
    </label>
    <label class="pat-row">
      <span>Personal Access Token</span>
      {#if !showPatInput && vaultStore.configured}
        <div>
          <span class="badge ok">✓ 已配置</span>
          <button type="button" class="link" onclick={() => (showPatInput = true)}>更新…</button>
        </div>
      {:else}
        <input type="password" bind:value={pat} placeholder="github_pat_..." />
      {/if}
      <button type="button" class="link" onclick={openTokenPage}>📖 如何生成 Token</button>
    </label>
    <label>
      <span>Author Name</span>
      <input type="text" bind:value={authorName} />
    </label>
    <label>
      <span>Author Email</span>
      <input type="text" bind:value={authorEmail} placeholder="user@users.noreply.github.com" />
    </label>
    <button class="primary" onclick={onSave} disabled={busy || !remoteUrl || (!vaultStore.configured && !pat)}>
      {busy ? '保存中…' : '保存配置'}
    </button>
    {#if saveError}
      <p class="error">❌ {saveError}</p>
    {/if}
  </div>

  <hr />

  <p class="note">⚠️ 请勿在 Files App 内修改或删除 Documents/Vault/ 目录，否则同步状态会损坏。</p>
</section>

<style>
  .vault-settings { padding: 8px 0; }
  .status-block { padding: 12px; background: var(--bg-sub, rgba(0,0,0,0.03)); border-radius: 8px; }
  .status-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .label { font-weight: 500; opacity: 0.7; }
  .state-error { color: var(--danger, #e01b24); }
  .state-conflict { color: var(--warn, #f5c211); }
  .actions { display: flex; gap: 8px; margin-top: 8px; }
  .actions button { padding: 6px 14px; }
  .danger { color: var(--danger, #e01b24); }
  hr { border: 0; border-top: 1px solid rgba(0,0,0,0.08); margin: 16px 0; }
  .form label { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .form label > span { font-size: 13px; opacity: 0.8; }
  .form input { padding: 6px 10px; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; font: inherit; }
  .badge.ok { color: var(--accent, #2ec27e); }
  .link { background: transparent; border: 0; padding: 0; color: var(--accent, #3584e4); text-decoration: underline; cursor: pointer; font-size: 12px; }
  .primary { padding: 8px 20px; background: var(--accent, #3584e4); color: white; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .pat-row > div { display: flex; gap: 8px; align-items: center; }
  .error { color: var(--danger, #e01b24); margin-top: 8px; }
  .note { font-size: 12px; opacity: 0.6; }
</style>
```

- [ ] **Step 2: 验证 svelte-check 不增加新错误**

Run: `cd .worktrees/ios-port && pnpm check 2>&1 | grep "VaultSettingsTab" | head`
Expected: 没有 ERROR（warnings 可以有）。

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/ios-port add src/components/VaultSettingsTab.svelte
git -C .worktrees/ios-port commit -m "feat(vault): VaultSettingsTab component"
```

---

### Task 14: `SettingsDialog.svelte` 集成（加 Vault tab，仅 iOS）

**Files:**
- Modify: `src/components/SettingsDialog.svelte`

- [ ] **Step 1: 加 tab 按钮**

在 `src/components/SettingsDialog.svelte` 的 `<nav class="tab-strip">` 内（紧邻 `Core` 按钮之后），加：

```svelte
{#if isIOSPlatform}
  <button class:active={selectedTab === 'vault'} onclick={() => selectedTab = 'vault'}>Vault</button>
{/if}
```

- [ ] **Step 2: 加 tab 内容**

在 `{:else if selectedTab === 'core'} ... {/if}` 块之后、`{:else}` 之前加：

```svelte
{:else if selectedTab === 'vault' && isIOSPlatform}
  <VaultSettingsTab />
```

并在文件顶部 `<script>` 区域加 import：

```ts
import VaultSettingsTab from './VaultSettingsTab.svelte'
```

- [ ] **Step 3: 验证 svelte-check 不增加新错误**

Run: `cd .worktrees/ios-port && pnpm check 2>&1 | grep "SettingsDialog\|VaultSettingsTab" | head`
Expected: 没有 ERROR。

- [ ] **Step 4: Commit**

```bash
git -C .worktrees/ios-port add src/components/SettingsDialog.svelte
git -C .worktrees/ios-port commit -m "feat(vault): wire Vault tab into SettingsDialog (iOS only)"
```

---

### Task 15: `VaultBrowser.svelte` 文件夹树视图

**Files:**
- Create: `src/components/VaultBrowser.svelte`

- [ ] **Step 1: 写 VaultBrowser.svelte**

```svelte
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { vaultStore, syncNow } from '../lib/vault.svelte'
  import { fileIcon, type VaultListEntry } from '../lib/vault-list'
  import { openFile } from '../lib/tabs.svelte'

  let { onCloseDrawer = () => {} }: { onCloseDrawer?: () => void } = $props()

  let breadcrumb = $state<string[]>([])
  let entries = $state<VaultListEntry[]>([])
  let loadError = $state<string | null>(null)

  $effect(() => {
    if (vaultStore.configured) {
      void refresh()
    } else {
      entries = []
    }
  })

  $effect(() => {
    // Refresh when sync completes or breadcrumb changes
    void vaultStore.lastSync
    void breadcrumb
    if (vaultStore.configured) void refresh()
  })

  async function refresh() {
    try {
      const relPath = breadcrumb.join('/')
      entries = await invoke<VaultListEntry[]>('vault_list_dir', { relPath })
      loadError = null
    } catch (e) {
      loadError = String(e)
    }
  }

  function joinRel(name: string): string {
    return [...breadcrumb, name].join('/')
  }

  async function onClickEntry(e: VaultListEntry) {
    if (e.kind === 'dir') {
      breadcrumb = [...breadcrumb, e.name]
    } else {
      // We need the absolute path. Compose from app's documents dir.
      // The TS `documentDir` API can give us the base.
      const { documentDir } = await import('@tauri-apps/api/path')
      const docs = await documentDir()
      const abs = `${docs.replace(/\/$/, '')}/Vault/${joinRel(e.name)}`
      onCloseDrawer()
      try { await openFile(abs) } catch {}
    }
  }

  function up() {
    if (breadcrumb.length > 0) breadcrumb = breadcrumb.slice(0, -1)
  }
</script>

<div class="vault-browser">
  <div class="header">
    <span class="section-label">Vault</span>
    <button class="sync-btn" onclick={() => syncNow()} aria-label="Sync now"
      class:spinning={vaultStore.state === 'syncing' || vaultStore.state === 'cloning'}>
      ↻
    </button>
  </div>

  {#if !vaultStore.configured}
    <p class="empty">未配置 Vault。<br />请去 Settings → Vault 配置仓库。</p>
  {:else}
    {#if breadcrumb.length > 0}
      <div class="breadcrumb">
        <button class="up" onclick={up}>‹ 上级</button>
        <span class="path">Vault › {breadcrumb.join(' › ')}</span>
      </div>
    {/if}

    {#if loadError}
      <p class="error">❌ {loadError}</p>
    {:else if entries.length === 0}
      <p class="empty">Vault 为空</p>
    {:else}
      <ul>
        {#each entries as e (e.name)}
          <li>
            <button class="entry" onclick={() => onClickEntry(e)}>
              <span class="icon">{e.kind === 'dir' ? '📁' : fileIcon(e.ext ?? '')}</span>
              <span class="name">{e.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .vault-browser { display: flex; flex-direction: column; }
  .header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 4px; }
  .section-label { font-size: 12px; opacity: 0.5; text-transform: uppercase; }
  .sync-btn {
    background: transparent; border: 0; padding: 4px 8px; cursor: pointer;
    font-size: 16px; opacity: 0.7;
  }
  .sync-btn:hover { opacity: 1; }
  .sync-btn.spinning { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .breadcrumb { display: flex; align-items: center; gap: 6px; padding: 4px 16px; font-size: 12px; }
  .up { background: transparent; border: 0; padding: 2px 6px; cursor: pointer; color: var(--accent, #3584e4); }
  .path { opacity: 0.6; overflow: hidden; text-overflow: ellipsis; }
  ul { list-style: none; padding: 0; margin: 0; }
  .entry {
    display: flex; align-items: center; gap: 8px; width: 100%;
    text-align: left; padding: 8px 16px; background: transparent;
    border: 0; cursor: pointer; font: inherit;
    border-top: 1px solid rgba(0,0,0,0.04);
  }
  .entry:hover { background: rgba(0,0,0,0.04); }
  .icon { width: 22px; text-align: center; }
  .empty { padding: 12px 16px; opacity: 0.5; font-size: 13px; }
  .error { padding: 8px 16px; color: var(--danger, #e01b24); font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    .entry:hover { background: rgba(255,255,255,0.05); }
    .entry { border-top-color: rgba(255,255,255,0.06); }
  }
</style>
```

- [ ] **Step 2: 验证 svelte-check 不增加 ERROR**

Run: `cd .worktrees/ios-port && pnpm check 2>&1 | grep "VaultBrowser" | head`
Expected: 没有 ERROR。

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/ios-port add src/components/VaultBrowser.svelte
git -C .worktrees/ios-port commit -m "feat(vault): VaultBrowser folder-tree component"
```

---

### Task 16: `DrawerNav.svelte` 嵌入 VaultBrowser

**Files:**
- Modify: `src/components/DrawerNav.svelte`

- [ ] **Step 1: 在 Open File 下、Recent 上面，插入 VaultBrowser**

修改 `src/components/DrawerNav.svelte`，在 `<button class="row primary" ...>📂 Open File</button>` 之后加：

```svelte
<VaultBrowser onCloseDrawer={() => (open = false)} />
```

并在 `<script>` 顶部加 import：

```ts
import VaultBrowser from './VaultBrowser.svelte'
```

- [ ] **Step 2: 验证 svelte-check**

Run: `cd .worktrees/ios-port && pnpm check 2>&1 | grep "DrawerNav" | head`
Expected: 没有 ERROR。

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/ios-port add src/components/DrawerNav.svelte
git -C .worktrees/ios-port commit -m "feat(vault): embed VaultBrowser into DrawerNav"
```

---

### Task 17: `MobileToolbar.svelte` 在 iPad 上也显示 ☰

**Files:**
- Modify: `src/components/MobileToolbar.svelte`

- [ ] **Step 1: 去掉 phone-only 限制**

找到 `src/components/MobileToolbar.svelte:14`:

```svelte
{#if formFactor.value === 'phone'}
  <button class="icon-btn" aria-label="Recent files" title="Recent" onclick={onOpenDrawer}>☰</button>
{/if}
```

改成（去掉 `{#if}` 包裹）：

```svelte
<button class="icon-btn" aria-label="Recent files" title="Recent" onclick={onOpenDrawer}>☰</button>
```

- [ ] **Step 2: 验证 svelte-check + 测试**

Run: `cd .worktrees/ios-port && pnpm vitest run 2>&1 | tail -5 && pnpm check 2>&1 | grep MobileToolbar | head`
Expected: 测试全过；MobileToolbar 无新增 ERROR。

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/ios-port add src/components/MobileToolbar.svelte
git -C .worktrees/ios-port commit -m "feat(vault): show ☰ button on iPad too (allows vault drawer)"
```

---

## Phase 7 — Glue & docs

### Task 18: `App.svelte` 前台触发同步

**Files:**
- Modify: `src/App.svelte`

- [ ] **Step 1: 加触发挂载**

在 `src/App.svelte` 顶部 `<script lang="ts">` 区找到 `onMount(async () => {` 块。在合适位置（已有 `isIOS()` 检查的旁边）加：

```ts
import { vaultStore, refreshStatus, syncNow, attachStatusListener } from './lib/vault.svelte'

// ... inside onMount or a new top-level $effect
if (await isIOS()) {
  attachStatusListener()
  await refreshStatus()

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && vaultStore.configured) {
      void syncNow()
    }
  })
}
```

具体位置和 import 形式按现有 App.svelte 的写法适配（已有 `import { isIOS } ...` 的话直接用）。

- [ ] **Step 2: 验证测试 + svelte-check**

Run: `cd .worktrees/ios-port && pnpm vitest run 2>&1 | tail -5 && pnpm check 2>&1 | grep App.svelte | head`
Expected: 测试全过；App.svelte 无新增 ERROR。

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/ios-port add src/App.svelte
git -C .worktrees/ios-port commit -m "feat(vault): foreground-trigger sync on iOS"
```

---

### Task 19: README iOS smoke items 96–110

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 README iOS smoke 段末尾追加 15 条**

找到 README 的 iOS smoke 段末尾（item 95 后），追加：

```
96. iOS：未配置 vault → 抽屉 Vault 分区显示"去设置配置仓库"；点跳到 SettingsDialog → Vault tab。
97. 输入 remote URL + PAT + 保存 → toast "正在 clone..." → 完成后抽屉显示 vault 根目录文件。
98. 已配置 vault，杀进程重开 → vault 状态自动恢复，文件列表照旧。
99. 点抽屉里一个 .md 文件 → mdeditor 打开；编辑保存 → 工作树 dirty。
100. 点 vault 区的 [↻] 同步按钮 → spinner → 完成后 toast "✓ Vault 同步完成"；GitHub Web 上能看到新 commit `vault: auto-sync <ts>`。
101. 另一台设备改一个文件 push → iOS App 切回前台 → 5 秒内自动拉回 → 抽屉里该文件 mtime 更新；打开文件看到新内容。
102. 双向冲突：本地编辑 A + 远端也改 A → 同步 → toast "⚠️ Vault: 同步完成，1 个本地修改保留为 .conflict 副本" → 抽屉里 A.conflict.<ts>.md 同目录可见；GitHub 仓库收到两个文件。
103. PAT 失效（GitHub revoke） → 同步 → toast "❌ Vault: 鉴权失败，请去 Vault 设置更新 PAT"。
104. 飞行模式 → 同步 → toast "❌ Vault: 网络错误"。
105. "断开 Vault" → 二次确认 → 本地 Documents/Vault/ 删除、Keychain item 清除、抽屉 Vault 区回到"未配置"；远端仓库不受影响。
106. iPad 上 ☰ 按钮显示并能打开抽屉；vault 文件浏览行为与 iPhone 一致。
107. vault 仓库中有 .png → 抽屉点击 → 进入 mdeditor 图片预览 tab。
108. vault 仓库 .git 目录在抽屉中不可见。
109. Files App → Documents/Vault/ → 用户看到完整工作树（含 .git）→ 顶部不显示 iCloud 图标（NSURLIsExcludedFromBackupKey 生效）。
110. IPA 包体增量 < 10 MB（与 v0.6.0 baseline 对比）；总 IPA < 30 MB。
```

- [ ] **Step 2: Commit**

```bash
git -C .worktrees/ios-port add README.md
git -C .worktrees/ios-port commit -m "docs(vault): iOS smoke items 96-110"
```

---

## Final verification

- [ ] **Run all tests (TS + Rust on macOS host)**

```bash
cd .worktrees/ios-port
pnpm vitest run 2>&1 | tail -5
cd src-tauri && cargo test --lib vault_ios 2>&1 | tail -10
```

Expected: 全绿。

- [ ] **Verify iOS build still compiles**

```bash
cd .worktrees/ios-port/src-tauri
cargo build --target aarch64-apple-ios 2>&1 | tail -5
```

Expected: 通过。

- [ ] **Manual smoke (per README items 96–110)** — required for v1 sign-off.

- [ ] **Measure IPA size delta**

```bash
cd .worktrees/ios-port
pnpm tauri ios build 2>&1 | tail -10
ls -la src-tauri/gen/apple/build/Payload/M↓.app/<binary>  # capture size
# compare to v0.6.0 baseline you have from prior release
```

Expected: 增量 < 10 MB；总 IPA < 30 MB（spec DoD）。
