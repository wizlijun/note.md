# Vault 大文件门禁 + 托盘黄灯 + 启停简化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vault 自动 git 同步时,把 >阈值(默认 10MB,vault 级可配)的新文件拦在 commit 外并警告用户手动处理;托盘增加黄灯 + 大文件子菜单;删除开始/停止同步(配置即自动同步)并对同步加互斥锁 + 同步中禁用"立即同步"。

**Architecture:** 后端 `vault_sync` 在 `git add` 前用新模块 `large_files` 检测超阈值文件并 `git reset` 撤出暂存(无状态,每轮重算);阈值存进现成的 `{vault}/.notemd/settings.json`(随 git 同步)。托盘四态(红>黄>绿>灰)由 `refresh_tray_status` 依据一个正交的 `skipped_large_files` 标志驱动。同步串行化用 `Mutex<()>` gate。

**Tech Stack:** Rust (Tauri v2, git CLI via `std::process::Command`)、Svelte 5 runes、自研 i18n(`src/lib/i18n/*.ts` 扁平点分键)。

**设计文档:** `docs/superpowers/specs/2026-07-17-vault-large-file-gate-design.md`

**通用命令:**
- Rust 测试:`cd src-tauri && cargo test <name>`
- Rust 编译检查:`cd src-tauri && cargo check`
- 前端类型检查:`pnpm check`(或 `pnpm svelte-check`)

**提交纪律(重要):** 本 main worktree 常被兄弟会话共享。每步 `git add` **只精确 add 本步涉及的文件**,绝不 `git add -A` / `git add .`。

---

## Task 1: VaultSettings 加大文件阈值字段

**Files:**
- Modify: `src-tauri/src/sotvault/vault_settings.rs`

- [ ] **Step 1: 写失败测试**

在 `vault_settings.rs` 的 `mod tests` 里追加:

```rust
    #[test]
    fn merge_sets_and_validates_threshold() {
        let out = merge(VaultSettings::default(), None, None, None, Some(25)).unwrap();
        assert_eq!(out.large_file_threshold_mb, Some(25));
        // 0 被拒绝(0 = 无意义,门禁侧会回退默认)
        assert!(merge(VaultSettings::default(), None, None, None, Some(0)).is_err());
    }

    #[test]
    fn merge_keeps_threshold_when_none() {
        let base = VaultSettings { large_file_threshold_mb: Some(50), ..Default::default() };
        let out = merge(base, Some("box".into()), None, None, None).unwrap();
        assert_eq!(out.large_file_threshold_mb, Some(50));
    }

    #[test]
    fn threshold_round_trips() {
        let dir = TempDir::new().unwrap();
        let s = VaultSettings { large_file_threshold_mb: Some(10), ..Default::default() };
        write(dir.path(), &s).unwrap();
        assert_eq!(read(dir.path()), s);
    }
```

- [ ] **Step 2: 运行,确认编译失败**

Run: `cd src-tauri && cargo test -p <crate> merge_sets_and_validates_threshold 2>&1 | head -30`
Expected: 编译错误 —— `VaultSettings` 无 `large_file_threshold_mb` 字段、`merge` 参数数量不符。

- [ ] **Step 3: 加字段 + merge 参数**

在 struct 里(`dailynote_dir` 之后)加字段:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dailynote_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large_file_threshold_mb: Option<u32>,
}
```

改 `merge` 签名与实现:

```rust
pub fn merge(
    base: VaultSettings,
    sync_dir: Option<String>,
    wikipage_dir: Option<String>,
    dailynote_dir: Option<String>,
    large_file_threshold_mb: Option<u32>,
) -> Result<VaultSettings, String> {
    let mut out = base;
    if let Some(v) = sync_dir {
        out.sync_dir = Some(validate_rel_dir(&v)?);
    }
    if let Some(v) = wikipage_dir {
        out.wikipage_dir = Some(validate_rel_dir(&v)?);
    }
    if let Some(v) = dailynote_dir {
        out.dailynote_dir = Some(validate_rel_dir(&v)?);
    }
    if let Some(mb) = large_file_threshold_mb {
        if mb == 0 {
            return Err("large file threshold must be at least 1 MB".into());
        }
        out.large_file_threshold_mb = Some(mb);
    }
    Ok(out)
}
```

- [ ] **Step 4: 修既有 merge 测试调用点**

`vault_settings.rs` 里既有测试 `merge_keeps_untouched_fields`、`merge_rejects_invalid_provided_value` 调用 `merge(...)` 是 4 参数,给它们末尾补 `None`:
- `merge(base, Some("box".into()), None, None)` → `merge(base, Some("box".into()), None, None, None)`
- `merge(VaultSettings::default(), Some("../x".into()), None, None)` → 末尾补 `, None`

同时 struct 字面量 `VaultSettings { sync_dir: ..., wikipage_dir: ..., dailynote_dir: None }`(测试 `write_then_read_round_trips`、`merge_keeps_untouched_fields`)已有显式全字段的,给它们加 `large_file_threshold_mb: None`。

- [ ] **Step 5: 运行测试**

Run: `cd src-tauri && cargo test -p <crate> vault_settings 2>&1 | tail -20`
Expected: 全绿(含新加 3 个)。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/sotvault/vault_settings.rs
git commit -m "feat(vault): add large_file_threshold_mb to vault settings"
```

---

## Task 2: notemd_vault_settings_set 透传阈值形参

**Files:**
- Modify: `src-tauri/src/sotvault/mod.rs:300-311`

- [ ] **Step 1: 改命令签名 + merge 调用**

把 `notemd_vault_settings_set` 改为:

```rust
#[tauri::command]
pub fn notemd_vault_settings_set(
    app: AppHandle,
    sync_dir: Option<String>,
    wikipage_dir: Option<String>,
    dailynote_dir: Option<String>,
    large_file_threshold_mb: Option<u32>,
) -> Result<vault_settings::VaultSettings, String> {
    let vault_root = resolve_vault_root(&app).ok_or("Vault not configured")?;
    let base = vault_settings::read(&vault_root);
    let merged = vault_settings::merge(
        base,
        sync_dir,
        wikipage_dir,
        dailynote_dir,
        large_file_threshold_mb,
    )?;
    vault_settings::write(&vault_root, &merged)?;
    Ok(merged)
}
```

- [ ] **Step 2: 检查其它 merge 调用点**

Run: `cd src-tauri && grep -rn "vault_settings::merge" src/`
Expected: 只有 `mod.rs` 这一处非测试调用(已在 Step 1 补参)。若有其它,补末尾 `None`。

- [ ] **Step 3: 编译检查**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: 通过(Tauri command 参数增加会自动进 invoke_handler,无需改注册)。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/sotvault/mod.rs
git commit -m "feat(vault): thread large_file_threshold_mb through settings command"
```

---

## Task 3: large_files 模块 — 阈值解析 + 超标检测

**Files:**
- Create: `src-tauri/src/vault_sync/large_files.rs`
- Modify: `src-tauri/src/vault_sync/mod.rs`(加 `pub mod large_files;`)

- [ ] **Step 1: 注册模块**

在 `src-tauri/src/vault_sync/mod.rs` 顶部模块声明区(`pub mod conflict;` 附近)加:

```rust
pub mod large_files;
```

- [ ] **Step 2: 写失败测试(新建文件带测试)**

创建 `src-tauri/src/vault_sync/large_files.rs`:

```rust
//! 同步门禁:检测工作区里将要进 commit 的超阈值文件。阈值来自 vault 级
//! 配置 `{vault}/.notemd/settings.json`(随 git 同步),默认 10 MB。
//! 无状态:每轮 sync 重算,文件被用户挪走/压缩后清单自然为空。

use std::path::Path;

use super::git_ops::{run_git, GitResult};

/// 阈值缺省值(MB)。与前端 DEFAULT_LARGE_FILE_THRESHOLD_MB 对齐。
pub const DEFAULT_LARGE_FILE_THRESHOLD_MB: u32 = 10;

/// 从 vault 配置解析出有效阈值(字节)。缺省/0 → 默认 10 MB。
pub fn resolve_threshold_bytes(vault_root: &Path) -> u64 {
    let mb = crate::sotvault::vault_settings::read(vault_root)
        .large_file_threshold_mb
        .filter(|&m| m > 0)
        .unwrap_or(DEFAULT_LARGE_FILE_THRESHOLD_MB);
    mb as u64 * 1024 * 1024
}

/// 解析一行 `git status --porcelain` 输出,返回其"待提交"文件的工作区相对路径。
/// 只关心新进来的内容:untracked(`??`)与暂存/工作区的 A/M。忽略删除、重命名旧名。
fn pending_path(line: &str) -> Option<String> {
    if line.len() < 4 {
        return None;
    }
    let (status, rest) = line.split_at(2);
    let path = rest.trim();
    let x = status.as_bytes()[0];
    let y = status.as_bytes()[1];
    // 未跟踪
    if status == "??" {
        return Some(unquote(path));
    }
    // 新增/修改(任一侧)。跳过删除(D)。重命名取新名(-> 之后)。
    if x == b'D' || y == b'D' {
        return None;
    }
    if matches!(x, b'A' | b'M' | b'R' | b'C') || matches!(y, b'A' | b'M') {
        let name = path.rsplit(" -> ").next().unwrap_or(path);
        return Some(unquote(name));
    }
    None
}

/// git 对含空格/非 ASCII 的路径会加引号,这里只做最小去引号(去首尾双引号)。
fn unquote(p: &str) -> String {
    let t = p.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// 返回工作区里 size > 阈值 的待提交文件(相对 repo 根路径)。无法 stat 的条目安全跳过。
pub fn detect_oversized(repo: &Path) -> GitResult<Vec<String>> {
    let threshold = resolve_threshold_bytes(repo);
    let status = run_git(repo, &["status", "--porcelain"])?;
    let mut out = Vec::new();
    for line in status.lines() {
        let Some(rel) = pending_path(line) else { continue };
        let abs = repo.join(&rel);
        if let Ok(meta) = std::fs::metadata(&abs) {
            if meta.is_file() && meta.len() > threshold {
                out.push(rel);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").args(args).current_dir(dir).status().unwrap();
        assert!(ok.success(), "git {:?} failed", args);
    }

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        git(dir.path(), &["init", "-q"]);
        dir
    }

    fn write_bytes(dir: &Path, name: &str, len: usize) {
        std::fs::write(dir.join(name), vec![b'x'; len]).unwrap();
    }

    #[test]
    fn detects_only_oversized_untracked() {
        let dir = init_repo();
        write_bytes(dir.path(), "small.bin", 1024);              // 1 KB
        write_bytes(dir.path(), "big.bin", 11 * 1024 * 1024);    // 11 MB > 10 MB
        let found = detect_oversized(dir.path()).unwrap();
        assert_eq!(found, vec!["big.bin".to_string()]);
    }

    #[test]
    fn threshold_boundary_is_strict_greater_than() {
        let dir = init_repo();
        write_bytes(dir.path(), "exact.bin", 10 * 1024 * 1024);      // 正好 10 MB → 不算
        write_bytes(dir.path(), "over.bin", 10 * 1024 * 1024 + 1);   // +1 字节 → 算
        let mut found = detect_oversized(dir.path()).unwrap();
        found.sort();
        assert_eq!(found, vec!["over.bin".to_string()]);
    }

    #[test]
    fn respects_configured_threshold_from_vault_settings() {
        let dir = init_repo();
        // 配 5 MB 阈值
        crate::sotvault::vault_settings::write(
            dir.path(),
            &crate::sotvault::vault_settings::VaultSettings {
                large_file_threshold_mb: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        write_bytes(dir.path(), "six.bin", 6 * 1024 * 1024); // 6 MB > 5 MB
        let found = detect_oversized(dir.path()).unwrap();
        assert!(found.contains(&"six.bin".to_string()));
    }
}
```

- [ ] **Step 3: 运行测试,确认通过**

Run: `cd src-tauri && cargo test large_files 2>&1 | tail -25`
Expected: 3 个测试全 PASS。(注意 `respects_configured_threshold` 会把 `.notemd/settings.json` 写进临时 repo,`detect_oversized` 会把它当 untracked 但它 <5MB 不入选。)

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/vault_sync/large_files.rs src-tauri/src/vault_sync/mod.rs
git commit -m "feat(vault-sync): detect oversized pending files against vault threshold"
```

---

## Task 4: SyncReport 类型 + Manager 字段(mod.rs)

**Files:**
- Modify: `src-tauri/src/vault_sync/mod.rs`

- [ ] **Step 1: 加 SyncReport 与 VaultSyncStatus 字段**

在 `mod.rs` 里 `VaultSyncStatus` 定义处加字段,并新增 `SyncReport`:

```rust
/// 一轮同步的结果摘要。目前只带被门禁排除的大文件清单(相对路径)。
#[derive(Debug, Default, Clone)]
pub struct SyncReport {
    pub skipped_large: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultSyncStatus {
    pub state: SyncState,
    pub repo_path: Option<String>,
    pub last_sync: Option<String>,
    pub error_message: Option<String>,
    pub git_available: bool,
    pub skipped_large_files: Vec<String>,
}
```

- [ ] **Step 2: 加 Manager 字段(sync_gate + skipped_large_files)**

在 `VaultSyncManager` struct 里加两字段:

```rust
    pub git_available: Mutex<bool>,
    pub stop_flag: Mutex<bool>,
    /// 串行化 do_sync:后台循环阻塞持有,手动 sync_once 用 try_lock。
    pub sync_gate: Mutex<()>,
    /// 最近一轮被门禁排除的大文件(相对 repo 根路径)。正交于 SyncState。
    pub skipped_large_files: Mutex<Vec<String>>,
```

在 `VaultSyncManager::new()` 里补初值:

```rust
            git_available: Mutex::new(true),
            stop_flag: Mutex::new(false),
            sync_gate: Mutex::new(()),
            skipped_large_files: Mutex::new(Vec::new()),
```

- [ ] **Step 3: 更新 vault_sync_status 命令带出新字段**

改 `vault_sync_status`(mod.rs)构造 `VaultSyncStatus` 处:

```rust
    let git_available = *mgr.git_available.lock().unwrap();
    let skipped_large_files = mgr.skipped_large_files.lock().unwrap().clone();
    VaultSyncStatus { state, repo_path, last_sync, error_message, git_available, skipped_large_files }
```

- [ ] **Step 4: 编译检查**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: 报错在 `git_ops::sync` 返回类型 / `service::do_sync` 处理(下一 Task 修);`mod.rs` 本身应无错。若只剩 `git_ops`/`service` 相关错误,继续。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/vault_sync/mod.rs
git commit -m "feat(vault-sync): add SyncReport, sync_gate and skipped_large_files to manager"
```

---

## Task 5: git_ops::sync 门禁 + 提交守卫 + 返回 SyncReport

**Files:**
- Modify: `src-tauri/src/vault_sync/git_ops.rs`

- [ ] **Step 1: 写失败测试**

在 `git_ops.rs` 末尾(`chrono_now` 之后)加测试模块:

```rust
#[cfg(test)]
mod gate_tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(dir: &std::path::Path, args: &[&str]) {
        assert!(Command::new("git").args(args).current_dir(dir).status().unwrap().success());
    }

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        git(dir.path(), &["init", "-q"]);
        git(dir.path(), &["config", "user.email", "t@t"]);
        git(dir.path(), &["config", "user.name", "t"]);
        dir
    }

    #[test]
    fn stage_except_oversized_leaves_big_file_unstaged() {
        let dir = init_repo();
        std::fs::write(dir.path().join("small.md"), "hi").unwrap();
        std::fs::write(dir.path().join("big.bin"), vec![b'x'; 11 * 1024 * 1024]).unwrap();
        let skipped = stage_except_oversized(dir.path()).unwrap();
        assert_eq!(skipped, vec!["big.bin".to_string()]);
        let staged = run_git(dir.path(), &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged.contains("small.md"));
        assert!(!staged.contains("big.bin"));
    }

    #[test]
    fn sync_no_remote_skips_big_and_commits_rest() {
        let dir = init_repo();
        std::fs::write(dir.path().join("note.md"), "content").unwrap();
        std::fs::write(dir.path().join("huge.bin"), vec![b'x'; 11 * 1024 * 1024]).unwrap();
        let report = sync(dir.path(), "origin", "main").unwrap();
        assert_eq!(report.skipped_large, vec!["huge.bin".to_string()]);
        // note.md 进了 commit,huge.bin 没进
        let tree = run_git(dir.path(), &["ls-tree", "-r", "--name-only", "HEAD"]).unwrap();
        assert!(tree.contains("note.md"));
        assert!(!tree.contains("huge.bin"));
    }

    #[test]
    fn sync_only_big_file_makes_no_commit() {
        let dir = init_repo();
        // 先来一个初始 commit,好有 HEAD
        std::fs::write(dir.path().join("seed.md"), "seed").unwrap();
        git(dir.path(), &["add", "seed.md"]);
        git(dir.path(), &["commit", "-q", "-m", "seed"]);
        let head_before = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap();
        // 只丢一个大文件
        std::fs::write(dir.path().join("only.bin"), vec![b'x'; 11 * 1024 * 1024]).unwrap();
        let report = sync(dir.path(), "origin", "main").unwrap();
        assert_eq!(report.skipped_large, vec!["only.bin".to_string()]);
        let head_after = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(head_before, head_after, "不应产生空 commit");
    }
}
```

- [ ] **Step 2: 运行,确认失败**

Run: `cd src-tauri && cargo test gate_tests 2>&1 | tail -20`
Expected: 编译失败 —— `stage_except_oversized` 未定义、`sync` 返回 `()` 无 `.skipped_large`。

- [ ] **Step 3: 加 helper + 改 sync 签名/实现**

在 `git_ops.rs` 顶部 `use` 区确保能引用 `SyncReport`:文件已 `use ...`;在函数区加:

```rust
use super::SyncReport;

/// git add -A,然后把超阈值文件撤出暂存(仍留在工作区),返回被排除清单。
fn stage_except_oversized(repo: &Path) -> GitResult<Vec<String>> {
    let oversized = super::large_files::detect_oversized(repo)?;
    run_git(repo, &["add", "-A"])?;
    for f in &oversized {
        let _ = run_git(repo, &["reset", "--", f]);
    }
    Ok(oversized)
}

/// 暂存区是否有待提交内容(用于提交守卫)。
fn has_staged(repo: &Path) -> bool {
    run_git(repo, &["diff", "--cached", "--quiet"]).is_err()
}
```

把 `sync` 的签名改为 `-> GitResult<SyncReport>`,并把两处 `run_git(repo, &["add", "-A"])?;` 替换、加提交守卫、返回报告。完整替换后的 `sync` 主体如下:

```rust
pub fn sync(repo: &Path, remote: &str, branch: &str) -> GitResult<SyncReport> {
    let has_remote = run_git(repo, &["remote", "get-url", remote]).is_ok();
    let mut skipped_large: Vec<String> = Vec::new();

    if has_remote {
        let fetch_ok = fetch(repo, remote, branch).is_ok();

        if !has_changes(repo)? {
            if fetch_ok {
                let ff = run_git(repo, &["pull", "--ff-only", remote, branch]);
                if ff.is_err() {
                    let _ = run_git(repo, &["pull", "--rebase", remote, branch]);
                }
            }
            return Ok(SyncReport { skipped_large });
        }

        skipped_large = stage_except_oversized(repo)?;

        if fetch_ok {
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

            // stash pop / 冲突处理会重新引入改动,再跑一次门禁保证大文件不漏网。
            let more = stage_except_oversized(repo)?;
            for f in more {
                if !skipped_large.contains(&f) {
                    skipped_large.push(f);
                }
            }
        }
    } else {
        if !has_changes(repo)? {
            return Ok(SyncReport { skipped_large });
        }
        skipped_large = stage_except_oversized(repo)?;
    }

    if has_staged(repo) {
        let ts = chrono_now();
        run_git(repo, &["commit", "-m", &format!("vault: auto-sync {ts}")])?;
    }

    if has_remote {
        let push = run_git(repo, &["push", remote, branch]);
        if let Err(e) = push {
            return Err(format!("push failed (will retry): {e}"));
        }
    }

    Ok(SyncReport { skipped_large })
}
```

> 注:原 `sync` 里 `run_git(repo, &["add", "-A"])?;`(rebase 后那处,原 `git_ops.rs:74`)现由 `stage_except_oversized` 取代;原 `if has_changes(repo)?` 提交判断(原 `:83`)改为 `if has_staged(repo)`。

- [ ] **Step 4: 运行测试**

Run: `cd src-tauri && cargo test gate_tests 2>&1 | tail -25`
Expected: 3 个 PASS。

- [ ] **Step 5: 编译检查(service 会因返回类型变化报错,下一 Task 修)**

Run: `cd src-tauri && cargo check 2>&1 | grep -A3 "service.rs" | head`
Expected: 仅 `service.rs` 处 `sync(...)` 返回值使用不匹配 —— 预期,下一 Task 处理。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/vault_sync/git_ops.rs
git commit -m "feat(vault-sync): gate oversized files out of commit, return SyncReport"
```

---

## Task 6: service.rs — 串行化 gate + 手动 try_lock + 写 skipped_large_files

**Files:**
- Modify: `src-tauri/src/vault_sync/service.rs`

- [ ] **Step 1: 手动同步用 try_lock**

改 `sync_once`(原 `service.rs:48-58`):

```rust
pub fn sync_once(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<Arc<VaultSyncManager>>();
    let repo_path = mgr.repo_path.lock().unwrap().clone()
        .ok_or("Not configured")?;
    let repo = PathBuf::from(&repo_path);
    let remote = mgr.remote.clone();
    let branch = mgr.branch.clone();

    // 正在同步则跳过(手动 kick 冗余),不排队。
    match mgr.sync_gate.try_lock() {
        Ok(_guard) => do_sync(app, &repo, &remote, &branch),
        Err(_) => mgr.logs.push("INFO", "sync already in progress, skipped"),
    }
    Ok(())
}
```

- [ ] **Step 2: 后台循环持有 gate(阻塞)**

在 `run_loop` 里,两处调用 `do_sync(&app, &repo, &remote, &branch);`(初始同步 + 循环体末尾)各自改为先拿锁:

```rust
    // Initial sync immediately on start
    {
        let mgr = app.state::<Arc<VaultSyncManager>>();
        let _guard = mgr.sync_gate.lock().unwrap();
        do_sync(&app, &repo, &remote, &branch);
    }
```

以及循环体末尾那处同样包成:

```rust
        {
            let mgr = app.state::<Arc<VaultSyncManager>>();
            let _guard = mgr.sync_gate.lock().unwrap();
            do_sync(&app, &repo, &remote, &branch);
        }
```

> 注意:`do_sync` 内部已 `app.state::<...VaultSyncManager>()` 多次取用,持 `sync_gate` 期间不要再去锁 `sync_gate`,避免死锁(do_sync 不碰 sync_gate)。

- [ ] **Step 3: do_sync 消费 SyncReport 写 skipped_large_files**

在 `do_sync` 里 `match git_ops::sync(repo, remote, branch)` 的 `Ok` 分支,把 `Ok(())` 改为 `Ok(report)` 并写标志:

```rust
    match git_ops::sync(repo, remote, branch) {
        Ok(report) => {
            *mgr.skipped_large_files.lock().unwrap() = report.skipped_large.clone();
            if !report.skipped_large.is_empty() {
                mgr.logs.push(
                    "WARN",
                    &format!("{} file(s) over the size limit were left out of sync: {}",
                        report.skipped_large.len(),
                        report.skipped_large.join(", ")),
                );
            }
            let ts = format!("{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default().as_secs());
            *mgr.last_sync.lock().unwrap() = Some(ts);
            *mgr.error_msg.lock().unwrap() = None;
            set_state(app, SyncState::Running);
            mgr.logs.push("INFO", "Sync completed");

            // ...(保留原有 head_after / recents-synced 逻辑不变)...
        }
        Err(e) => {
            // ...(保留原有 Err 分支不变)...
        }
    }
```

> `set_state(app, SyncState::Running)` 会触发 `refresh_tray_status`,而 Task 8 会让它读 `skipped_large_files` 决定黄灯 —— 因此**必须先写 `skipped_large_files` 再 `set_state`**(如上顺序)。

- [ ] **Step 4: 编译检查**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: 通过。

- [ ] **Step 5: 跑全部 vault_sync 测试**

Run: `cd src-tauri && cargo test vault_sync 2>&1 | tail -15; cargo test large_files 2>&1 | tail -5; cargo test gate_tests 2>&1 | tail -5`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/vault_sync/service.rs
git commit -m "feat(vault-sync): serialize sync via gate, record skipped large files"
```

---

## Task 7: 生成黄灯图标资源

**Files:**
- Create: `src-tauri/icons/tray-icon-warning.png`
- Create: `src-tauri/icons/dot-yellow.png`

- [ ] **Step 1: 由现有红色版本重着色生成琥珀黄**

优先用 ImageMagick;没有则用 sips 兜底(macOS 自带,但 sips 不能改色相,用 ImageMagick 更佳)。先探测:

Run: `which magick convert 2>/dev/null; ls src-tauri/icons/tray-icon-error.png src-tauri/icons/dot-red.png`

若有 ImageMagick(`magick` 或 `convert`):

```bash
cd src-tauri/icons
# 红→琥珀黄:色相旋转约 +40°(红 ~0° → 黄 ~45°)。数值以实机观感为准。
magick tray-icon-error.png -modulate 100,100,140 tray-icon-warning.png
magick dot-red.png       -modulate 100,100,140 dot-yellow.png
```

若无 ImageMagick,退而用纯色点(dot 是纯色圆,可接受),托盘主图标黄版则复制红版占位并在 GUI 验证时替换:

```bash
cd src-tauri/icons
# 占位:先复制,GUI 验证阶段由用户/后续替换成真正的黄色资源
cp dot-red.png dot-yellow.png
cp tray-icon-error.png tray-icon-warning.png
```

- [ ] **Step 2: 确认文件存在且非空**

Run: `ls -l src-tauri/icons/tray-icon-warning.png src-tauri/icons/dot-yellow.png`
Expected: 两个文件都存在、大小 > 0。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/icons/tray-icon-warning.png src-tauri/icons/dot-yellow.png
git commit -m "assets(tray): add yellow warning tray icon and dot"
```

> 观感由用户在最终 GUI 验证时确认;不满意可重生成后 amend/replace。

---

## Task 8: 托盘四态图标 + 黄点(refresh_tray_status)

**Files:**
- Modify: `src-tauri/src/lib.rs`(`status_dot_image` ~716-727、`refresh_tray_status` 735-776)

- [ ] **Step 1: status_dot_image 支持黄点**

把 `status_dot_image` 改为接收"是否有待处理大文件":

```rust
fn status_dot_image(state: vault_sync::SyncState, has_large: bool) -> Option<Image<'static>> {
    use vault_sync::SyncState;
    let bytes: &'static [u8] = if state.is_problem() {
        include_bytes!("../icons/dot-red.png")
    } else if has_large {
        include_bytes!("../icons/dot-yellow.png")
    } else if matches!(state, SyncState::Running | SyncState::Syncing) {
        include_bytes!("../icons/dot-green.png")
    } else {
        include_bytes!("../icons/dot-grey.png")
    };
    Image::from_bytes(bytes).ok()
}
```

- [ ] **Step 2: refresh_tray_status 读大文件标志 + 四态主图标**

在 `refresh_tray_status` 里 `let problem = state.is_problem();` 之后加:

```rust
    let skipped_large = mgr.skipped_large_files.lock().unwrap().clone();
    let has_large = !skipped_large.is_empty();
```

把主图标选择改为四态:

```rust
        let icon = if problem {
            Image::from_bytes(include_bytes!("../icons/tray-icon-error.png"))
        } else if has_large {
            Image::from_bytes(include_bytes!("../icons/tray-icon-warning.png"))
        } else if active {
            Image::from_bytes(include_bytes!("../icons/tray-icon-active.png"))
        } else {
            Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        };
```

把状态行 dot 调用改为传 `has_large`:

```rust
            let _ = item.set_icon(status_dot_image(state, has_large));
```

- [ ] **Step 3: 修 build_tray_menu 里的 status_dot_image 调用**

`build_tray_menu`(~1373)里 `(label, status_dot_image(state))` 改为:

```rust
        let has_large = !mgr.skipped_large_files.lock().unwrap().is_empty();
        (label, status_dot_image(state, has_large))
```

(该处已在 `let mgr = ...` 作用域内。)

- [ ] **Step 4: 编译检查**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tray): yellow warning state when large files are pending"
```

---

## Task 9: 大文件子菜单 + 点击在 Finder 选中 + 变化才重建

**Files:**
- Modify: `src-tauri/src/lib.rs`(`build_tray_menu`、`on_menu_event`、状态定义区 ~46-50、`refresh_tray_status`、`.manage()` 注册区)

- [ ] **Step 1: 加 TrayShownLargeFiles 状态**

在状态定义区(`TrayStatusItem` 附近 ~46-50)加:

```rust
#[cfg(not(target_os = "ios"))]
pub struct TrayShownLargeFiles(pub Mutex<Vec<String>>);
```

在 `.manage(...)` 注册区(与 `TrayStatusItem`/`TrayRepoItem` 一起注册的地方)加:

```rust
        .manage(TrayShownLargeFiles(std::sync::Mutex::new(Vec::new())))
```

> 用 `grep -n "TrayStatusItem(Mutex::new\|\.manage(TrayStatusItem" src-tauri/src/lib.rs` 定位注册点,照抄其风格。

- [ ] **Step 2: build_tray_menu 插入大文件子菜单**

在 `build_tray_menu` 里,状态行 `status_item` 之后、`sync_now_item` 之前,构造可选子菜单。先读当前清单:

```rust
    let large_files: Vec<String> = {
        let mgr = app.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
        mgr.skipped_large_files.lock().unwrap().clone()
    };
    let large_submenu = if large_files.is_empty() {
        None
    } else {
        let header = IconMenuItem::with_id(
            app, "tray-large-header",
            menu_label(locale, "tray.largeFiles.header"),
            /*enabled=*/ false, None, None::<&str>,
        )?;
        let title = menu_label(locale, "tray.largeFiles.title")
            .replace("{n}", &large_files.len().to_string());
        let sub = SubmenuBuilder::with_id(app, "tray-large-files", &title).item(&header);
        let mut sub = sub;
        for (i, f) in large_files.iter().enumerate() {
            let name = std::path::Path::new(f)
                .file_name().and_then(|s| s.to_str()).unwrap_or(f);
            let it = MenuItem::with_id(
                app, &format!("tray-large-file:{i}"), name, true, None::<&str>,
            )?;
            sub = sub.item(&it);
        }
        Some(sub.build()?)
    };
```

把菜单组装处(原 `.item(&status_item).item(&sync_start_item)...`)改为在 status 之后条件插入子菜单(注意 Task 10 会删除 start/stop,这里先只加子菜单):

```rust
    let mut b2 = b
        .item(&sync_repo_item)
        .item(&status_item);
    if let Some(ref sm) = large_submenu {
        b2 = b2.item(sm);
    }
    let menu = b2
        .item(&sync_now_item)
        .item(&sync_log_item)
        .item(&edit_agents_item)
        .separator()
        .item(&open_books_item)
        .item(&open_raw_sync_item)
        .separator()
        .item(&quit_item)
        .build()?;
```

> 需要 `use tauri::menu::SubmenuBuilder;`(确认文件顶部 menu 相关 `use`;`Submenu` 已在用,补 `SubmenuBuilder`)。

- [ ] **Step 3: on_menu_event 加大文件点击 → Finder 选中**

在 `.on_menu_event(|app, event| { match event.id().0.as_str() { ... }})` 的 `match` 里,`_ => {}` 之前加一个前缀分支(match 无法直接前缀匹配,用 `id if id.starts_with(...)`):

把 `match event.id().0.as_str() {` 结构改为先取 `let id = event.id().0.as_str();`,在 `_ => {}` 前加:

```rust
            id if id.starts_with("tray-large-file:") => {
                if let Some(idx) = id.strip_prefix("tray-large-file:").and_then(|s| s.parse::<usize>().ok()) {
                    let mgr = app.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
                    let files = mgr.skipped_large_files.lock().unwrap().clone();
                    let repo = mgr.repo_path.lock().unwrap().clone();
                    if let (Some(rel), Some(root)) = (files.get(idx), repo) {
                        let abs = std::path::Path::new(&root).join(rel);
                        let _ = std::process::Command::new("open").arg("-R").arg(abs).status();
                    }
                }
            }
```

- [ ] **Step 4: refresh_tray_status 里"仅当清单变化才重建菜单"**

在 `refresh_tray_status` 末尾(状态行更新之后)加:

```rust
    // 大文件清单变化时重建托盘菜单(变长的子菜单只能整表重建)。
    if let Some(shown) = app.try_state::<TrayShownLargeFiles>() {
        let mut shown = shown.0.lock().unwrap();
        if *shown != skipped_large {
            *shown = skipped_large.clone();
            drop(shown);
            let locale = read_saved_locale(app);
            if let Some(tray) = app.tray_by_id("main") {
                if let Ok((menu, repo_item, status_item)) = build_tray_menu(app, &locale) {
                    *app.state::<TrayRepoItem>().0.lock().unwrap() = Some(repo_item);
                    *app.state::<TrayStatusItem>().0.lock().unwrap() = Some(status_item);
                    let _ = tray.set_menu(Some(menu));
                }
            }
        }
    }
```

> `build_tray_menu` 返回 3 元组不变(子菜单不需要 stash 句柄,靠重建刷新)。

- [ ] **Step 5: 编译检查**

Run: `cd src-tauri && cargo check 2>&1 | tail -25`
Expected: 通过。若报 `SubmenuBuilder` 未导入,在 lib.rs 顶部 `use tauri::menu::{...}` 补上。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tray): large-files submenu revealing each file in Finder"
```

---

## Task 10: 删除开始/停止同步 + 配置即自动同步 + init 去 gate + 同步中禁用立即同步

**Files:**
- Modify: `src-tauri/src/lib.rs`(`build_tray_menu`、`on_menu_event`、`pick_sync_folder`、`pick_repo_and_start`/`save_sync_enabled`、状态定义/注册区、`refresh_tray_status`、`set_menu_locale`)
- Modify: `src-tauri/src/vault_sync/mod.rs`(`init` 去 auto_start gate)

- [ ] **Step 1: build_tray_menu 删除 start/stop 项**

删掉这两行定义:

```rust
    let sync_start_item = MenuItem::with_id(app, "tray-sync-start", menu_label(locale, "tray.startSync"), true, None::<&str>)?;
    let sync_stop_item = MenuItem::with_id(app, "tray-sync-stop", menu_label(locale, "tray.stopSync"), true, None::<&str>)?;
```

并从菜单组装里删掉 `.item(&sync_start_item).item(&sync_stop_item)`(Task 9 Step 2 已重写组装块,此处确认其中不含 start/stop)。

- [ ] **Step 2: sync_now 存句柄以便禁用**

改 `build_tray_menu` 返回类型与末尾。签名:

```rust
fn build_tray_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    locale: &str,
) -> tauri::Result<(Menu<R>, MenuItem<R>, IconMenuItem<R>, MenuItem<R>)> {
```

末尾:

```rust
    Ok((menu, sync_repo_item, status_item, sync_now_item))
```

加状态类型(状态定义区):

```rust
#[cfg(not(target_os = "ios"))]
pub struct TraySyncNowItem(pub Mutex<Option<MenuItem<tauri::Wry>>>);
```

在 `.manage(...)` 注册区加:

```rust
        .manage(TraySyncNowItem(std::sync::Mutex::new(None)))
```

- [ ] **Step 3: 修所有 build_tray_menu 调用点(接第 4 个返回值 + 存句柄)**

有三处调用 `build_tray_menu`:初始构建(tray 创建处)、`set_menu_locale`、`refresh_tray_status`(Task 9 Step 4 新增)。各处解构改为 4 元组并 stash sync_now 句柄。例如 `set_menu_locale`:

```rust
        let (tray_menu, sync_repo_item, status_item, sync_now_item) =
            build_tray_menu(&app, &locale).map_err(|e| e.to_string())?;
        *app.state::<TrayRepoItem>().0.lock().unwrap() = Some(sync_repo_item);
        *app.state::<TrayStatusItem>().0.lock().unwrap() = Some(status_item);
        *app.state::<TraySyncNowItem>().0.lock().unwrap() = Some(sync_now_item);
        tray.set_menu(Some(tray_menu)).map_err(|e| e.to_string())?;
```

初始 tray 创建处(`grep -n "build_tray_menu" src-tauri/src/lib.rs` 定位那处 `let (tray_menu, ...) = build_tray_menu(...)`)同样解构 4 元组并 stash 三个句柄。Task 9 Step 4 的 refresh 重建块也补 `sync_now_item` 解构与 stash。

- [ ] **Step 4: on_menu_event 删除 start/stop 分支**

删掉:

```rust
            "tray-sync-start" => { pick_repo_and_start(app); }
            "tray-sync-stop" => {
                let _ = vault_sync::vault_sync_stop(app.clone());
                save_sync_enabled(app, false);
                update_tray_icon(app, false);
            }
```

- [ ] **Step 5: pick_sync_folder 配置后自动启动同步**

把 `pick_sync_folder`(原 `lib.rs:565-567`)改为配置完即启动:

```rust
#[cfg(not(target_os = "ios"))]
fn pick_sync_folder(app: &tauri::AppHandle) {
    let app_clone = app.clone();
    pick_sync_folder_inner(app, move |_path| {
        let _ = vault_sync::vault_sync_start(app_clone.clone());
        refresh_tray_status(&app_clone);
    });
}
```

删除现已无用的 `pick_repo_and_start`(原 `545-562`)与 `save_sync_enabled`(原 `623-630`)。

Run: `cd src-tauri && grep -rn "pick_repo_and_start\|save_sync_enabled" src/`
Expected: 无剩余引用(若 `on_menu_event` 还有 `tray-sync-start` 已在 Step 4 删)。

- [ ] **Step 6: init 去掉 auto_start 门禁**

改 `src-tauri/src/vault_sync/mod.rs` 的 `init`:把读 `auto_start` 并据此决定是否 start 的分支,改为"只要配了 repo_path 就无条件 start"。将原:

```rust
        let auto_start = store.get("vault_sync.auto_start")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        if auto_start {
            *mgr.state.lock().unwrap() = SyncState::Stopped;
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let _ = service::start(&app_clone);
                crate::update_tray_icon(&app_clone, true);
            });
        } else {
            *mgr.state.lock().unwrap() = SyncState::Stopped;
        }
```

替换为:

```rust
        // 配置即自动同步:不再有"停止同步"入口,故只要有 repo_path 就无条件启动。
        *mgr.state.lock().unwrap() = SyncState::Stopped;
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let _ = service::start(&app_clone);
            crate::update_tray_icon(&app_clone, true);
        });
```

(`store` 变量若因此不再被用于读取,检查是否仍需要;`store` 仍用于其它读取则保留。用 `cargo check` 的 unused 警告确认。)

- [ ] **Step 7: refresh_tray_status 里同步中禁用 sync_now**

在 `refresh_tray_status` 末尾加:

```rust
    if let Some(sn) = app.try_state::<TraySyncNowItem>() {
        if let Some(item) = sn.0.lock().unwrap().as_ref() {
            let _ = item.set_enabled(state != vault_sync::SyncState::Syncing);
        }
    }
```

- [ ] **Step 8: 编译检查 + 全量 Rust 测试**

Run: `cd src-tauri && cargo check 2>&1 | tail -25 && cargo test vault_sync 2>&1 | tail -10`
Expected: 编译通过(允许 `update_tray_icon`/`tray.startSync`/`tray.stopSync` i18n 键等 unused 警告);测试全绿。

- [ ] **Step 9: 提交**

```bash
git add src-tauri/src/lib.rs src-tauri/src/vault_sync/mod.rs
git commit -m "feat(tray): drop start/stop, auto-sync on configure, disable Sync Now while syncing"
```

---

## Task 11: 前端 vault-settings 阈值 store + 设置 UI

**Files:**
- Modify: `src/lib/vault-settings.svelte.ts`
- Modify: `src/components/SettingsDialog.svelte`
- Modify: `src/lib/vault-settings.test.ts`(若断言了 DTO 形状)

- [ ] **Step 1: store 加阈值字段与保存函数**

改 `src/lib/vault-settings.svelte.ts`:

DTO 加字段:

```ts
export interface VaultSettingsDto {
  syncDir?: string | null
  wikipageDir?: string | null
  dailynoteDir?: string | null
  largeFileThresholdMb?: number | null
}

/** 大文件阈值默认值(MB);镜像 Rust DEFAULT_LARGE_FILE_THRESHOLD_MB。 */
export const DEFAULT_LARGE_FILE_THRESHOLD_MB = 10
```

state 加字段:

```ts
export const vaultSettings = $state<{
  syncDir: string
  largeFileThresholdMb: number
  vaultPath: string | null
  loaded: boolean
}>({
  syncDir: DEFAULT_SYNC_DIR,
  largeFileThresholdMb: DEFAULT_LARGE_FILE_THRESHOLD_MB,
  vaultPath: null,
  loaded: false,
})
```

`loadVaultSettings` 里补:

```ts
  vaultSettings.syncDir = dto?.syncDir ?? DEFAULT_SYNC_DIR
  vaultSettings.largeFileThresholdMb = dto?.largeFileThresholdMb ?? DEFAULT_LARGE_FILE_THRESHOLD_MB
  vaultSettings.loaded = true
```

新增保存函数:

```ts
/** 持久化大文件阈值(MB,>=1)。后端校验;不改 vault 目录结构,故无需 refreshSotvault。 */
export async function saveLargeFileThreshold(mb: number): Promise<void> {
  const merged = await invoke<VaultSettingsDto>('notemd_vault_settings_set', {
    largeFileThresholdMb: mb,
  })
  vaultSettings.largeFileThresholdMb =
    merged?.largeFileThresholdMb ?? DEFAULT_LARGE_FILE_THRESHOLD_MB
}
```

- [ ] **Step 2: SettingsDialog 加阈值输入项**

在 `src/components/SettingsDialog.svelte` 顶部 import 补:

```ts
  import { vaultSettings, loadVaultSettings, saveSyncDir, saveLargeFileThreshold, DEFAULT_SYNC_DIR, DEFAULT_LARGE_FILE_THRESHOLD_MB } from '../lib/vault-settings.svelte'
```

在 script 区(`syncDirDraft` 附近)加 draft + 保存处理:

```ts
  let thresholdDraft = $state(DEFAULT_LARGE_FILE_THRESHOLD_MB)
  let thresholdBusy = $state(false)
```

在既有 `$effect(() => { if (!open) return; void loadVaultSettings().then(...) })` 的 `.then` 回调里补:

```ts
    void loadVaultSettings().then(() => {
      syncDirDraft = vaultSettings.syncDir
      thresholdDraft = vaultSettings.largeFileThresholdMb
    })
```

加保存函数:

```ts
  async function onSaveThreshold() {
    const mb = Math.max(1, Math.floor(Number(thresholdDraft) || DEFAULT_LARGE_FILE_THRESHOLD_MB))
    thresholdBusy = true
    try {
      await saveLargeFileThreshold(mb)
      thresholdDraft = vaultSettings.largeFileThresholdMb
      pushToast({ level: 'success', message: t('vaultSync.saved') })
    } catch (e) {
      pushToast({ level: 'error', message: t('vaultSync.saveFailed', { error: String(e) }), detail: String(e) })
    } finally {
      thresholdBusy = false
    }
  }
```

在 `vaultSync` section(`relPath` 那个 `<label class="row">` 之后、`</section>` 之前)加输入行:

```svelte
          <label class="row">
            <span class="lbl">{t('vaultSync.largeFileThreshold')}</span>
            <input type="number" min="1" step="1" bind:value={thresholdDraft}
              disabled={!vaultSettings.vaultPath || thresholdBusy} />
            <button onclick={onSaveThreshold}
              disabled={!vaultSettings.vaultPath || thresholdBusy}>{t('vaultSync.save')}</button>
          </label>
```

- [ ] **Step 3: 前端类型检查**

Run: `pnpm check 2>&1 | tail -20`
Expected: 无 vault-settings / SettingsDialog 相关类型错误。

- [ ] **Step 4: 提交**

```bash
git add src/lib/vault-settings.svelte.ts src/components/SettingsDialog.svelte
git commit -m "feat(settings): configurable large-file threshold (MB) in vault settings"
```

---

## Task 12: 前端 toast + VaultSettingsTab 同步中禁用

**Files:**
- Modify: `src/lib/vault.svelte.ts`
- Modify: `src/components/VaultSettingsTab.svelte`

- [ ] **Step 1: skipped_large_files 弹 toast**

在 `src/lib/vault.svelte.ts` 处理同步状态的地方(现有读 `s.has_conflicts` 弹 `vault.syncedWithConflicts` 的同一函数,约 `:78-81`),在读取 status 后加:

```ts
    if (s.skipped_large_files && s.skipped_large_files.length > 0) {
      pushToast({
        level: 'warn',
        message: t('vault.largeFileSkipped', { count: s.skipped_large_files.length }),
      })
    }
```

> `s` 是 `vault_sync_status` / iOS status 的返回对象。确认其 TS 类型(若有显式 interface)补 `skipped_large_files?: string[]`。

- [ ] **Step 2: VaultSettingsTab 的"立即同步"同步中禁用**

在 `src/components/VaultSettingsTab.svelte` 的 Sync Now 按钮(`onclick` 调 syncNow 那个)`disabled` 条件里并入 `vaultStore.state === 'syncing'`。例如:

```svelte
<button onclick={onSyncNow} disabled={busy || vaultStore.state === 'syncing'}>
  {t('vault.syncNow')}
</button>
```

> 用 `grep -n "syncNow\|vault.syncNow" src/components/VaultSettingsTab.svelte` 定位实际按钮,把 `vaultStore.state === 'syncing'` 并入其既有 `disabled`。

- [ ] **Step 3: 前端类型检查**

Run: `pnpm check 2>&1 | tail -20`
Expected: 无相关类型错误。

- [ ] **Step 4: 提交**

```bash
git add src/lib/vault.svelte.ts src/components/VaultSettingsTab.svelte
git commit -m "feat(vault-ui): warn toast for skipped large files, disable Sync Now while syncing"
```

---

## Task 13: i18n 键(en/zh/ja/de + 托盘元组表)

**Files:**
- Modify: `src/lib/i18n/en.ts`、`zh.ts`、`ja.ts`、`de.ts`
- Modify: `src-tauri/src/lib.rs`(托盘 `menu_label` 元组表 ~1230-1315)

- [ ] **Step 1: 前端 i18n 键(四语言)**

在每个 `src/lib/i18n/<lang>.ts` 的 `vault.*` 区加 `vault.largeFileSkipped`,`vaultSync.*` 区加 `vaultSync.largeFileThreshold`:

en.ts:
```ts
  'vault.largeFileSkipped': '⚠️ Vault: {count} file(s) over the size limit were not synced — move them out of the vault',
  'vaultSync.largeFileThreshold': 'Large-file limit (MB)',
```

zh.ts:
```ts
  'vault.largeFileSkipped': '⚠️ Vault：{count} 个超过大小限制的文件未同步 —— 请移出 vault',
  'vaultSync.largeFileThreshold': '大文件上限 (MB)',
```

ja.ts:
```ts
  'vault.largeFileSkipped': '⚠️ Vault：サイズ上限を超える {count} 件のファイルは同期されません —— vault から移動してください',
  'vaultSync.largeFileThreshold': '大きいファイルの上限 (MB)',
```

de.ts:
```ts
  'vault.largeFileSkipped': '⚠️ Vault: {count} Datei(en) über dem Größenlimit wurden nicht synchronisiert — aus dem Vault verschieben',
  'vaultSync.largeFileThreshold': 'Limit für große Dateien (MB)',
```

- [ ] **Step 2: 确认插值语法**

Run: `grep -n "saveFailed\|{error}\|{count}\|{time}" src/lib/i18n/en.ts | head`
Expected: 现有键用 `{name}` 花括号插值(如 `{error}`/`{time}`),确认 `{count}` 一致。若项目用别的插值风格,照现有风格改。

- [ ] **Step 3: 托盘元组表加大文件键**

在 `src-tauri/src/lib.rs` 的 `menu_label` 元组表(~1230-1315,形如 `"tray.syncNow" => ("Sync Now", "立即同步", ...)`)加两行:

```rust
        "tray.largeFiles.title" => ("⚠️ {n} file(s) too large", "⚠️ {n} 个文件过大", "⚠️ {n} 件のファイルが大きすぎます", "⚠️ {n} Datei(en) zu groß"),
        "tray.largeFiles.header" => ("Over the limit — not synced. Move out of the vault:", "超过上限,未同步。请移出 vault:", "上限超過 —— 未同期。vault から移動してください:", "Über dem Limit — nicht synchronisiert. Aus dem Vault verschieben:"),
```

> Task 9 里 title 用 `.replace("{n}", ...)` 展开;header 无插值。

- [ ] **Step 4: 编译 + 类型检查**

Run: `cd src-tauri && cargo check 2>&1 | tail -8 && cd .. && pnpm check 2>&1 | tail -10`
Expected: 均通过。

- [ ] **Step 5: 提交**

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts src/lib/i18n/de.ts src-tauri/src/lib.rs
git commit -m "i18n: large-file skip toast, threshold label, tray large-files submenu"
```

---

## Task 14: 全量校验 + dev 构建交付 GUI 验证

**Files:** 无(校验 + 交付)

- [ ] **Step 1: 后端全量测试 + 检查**

Run: `cd src-tauri && cargo test 2>&1 | tail -20 && cargo check 2>&1 | tail -5`
Expected: 测试全绿,check 通过。

- [ ] **Step 2: 前端检查**

Run: `pnpm check 2>&1 | tail -15`
Expected: 无新增错误。

- [ ] **Step 3: 起 dev 构建**

Run: `pnpm tauri dev`(或项目既有 dev 命令;见 CLAUDE.md / package.json scripts)
Expected: app 起来,托盘出现。

- [ ] **Step 4: 交付手动验证清单(不代跑桌面自动化)**

把以下清单交用户在其机器上实机验证(见 memory `feedback_no_ui_automation_user_tests`):

1. 往 vault 丢一个 >10MB 文件 + 改一个小 md → 托盘转黄;`⚠️ N 个文件过大` 子菜单出现,含该文件;点它在 Finder 选中;弹 warn toast;小 md 正常同步进 commit,大文件未进。
2. 把大文件挪出 vault → 下一轮(≤30s 或点"立即同步")托盘恢复绿、子菜单消失。
3. 设置里把"大文件上限"改成如 5 MB → 丢一个 6MB 文件被拦;改回 10 → 6MB 不再被拦。设置随 `.notemd/settings.json` 提交、能被别的设备 clone 到。
4. 运行时用"Vault: 选文件夹"配置一个新 vault → 立即自动开始同步(不再需要"开始同步");菜单里已无"开始/停止同步"。
5. 同步进行中 → 托盘"立即同步"置灰、前端 VaultSettingsTab 的按钮也置灰;结束恢复。
6. 黄图标/黄点观感确认(不满意则重生成 Task 7 资源)。

- [ ] **Step 5: 用户确认后收尾**

GUI 验证通过后,按项目发布约定处理(见 memory `feedback_auto_release`:GUI 改动须先 dev 实机验证再发布)。本计划实现完成。

---

## Self-Review 记录

- **Spec 覆盖:** A(Task 3/5/6)、B(Task 7/8/9)、C(Task 4/6/10)、D(Task 12/13)、E(Task 1/2/11) 均有对应任务。
- **类型一致:** `SyncReport { skipped_large }`(mod.rs)↔ git_ops 返回 ↔ service 消费一致;`skipped_large_files`(manager 字段 + VaultSyncStatus + 前端 DTO `skipped_large_files`)一致;`large_file_threshold_mb`(Rust)↔ `largeFileThresholdMb`(TS camelCase,Tauri 自动转换)一致;`status_dot_image(state, has_large)` 两个调用点(refresh + build_tray_menu)签名一致;`build_tray_menu` 4 元组返回在三处调用点一致更新。
- **无占位符:** 每步均有实际代码/命令。图标生成给了 ImageMagick + 无工具兜底两条路径。
