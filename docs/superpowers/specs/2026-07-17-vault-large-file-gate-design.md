# Vault 同步:大文件门禁 + 托盘黄灯 + 启停简化

日期:2026-07-17
状态:设计已确认,待写实施计划

## 背景

桌面版 vault(sotvault)有一套自动 git 同步循环(`src-tauri/src/vault_sync/`):
30s 周期 + 文件监听触发 `do_sync` → `git_ops::sync()`(stash + rebase 模型)。

现状痛点:

1. `git_ops::sync()` 在两处无条件 `git add -A`(`git_ops.rs:57`、`:74`),任何粘进
   vault 的大文件都会被提交进历史。一旦某文件 >100MB,GitHub 直接拒收 push,
   触发 `sync()` 里 `push failed (will retry)` 的**永久重试死循环**;即便 <100MB,
   大二进制也会永久留在 git 历史里让仓库膨胀。
2. GitHub.com **服务端无法**配置"单文件 ≤10MB"上限(那是 Enterprise 的
   pre-receive hook 才有);阈值只能客户端自己拦。
3. 托盘红绿灯只有"红(问题)/绿(活跃)/灰(停止)"三态,无法表达"有待处理大文件"
   这种非致命警告。
4. 托盘的"开始同步/停止同步"是历史遗留的手动开关,与"配置后即自动同步"的产品
   预期不符;且"选文件夹"这条配置路径**不会自动启动**同步循环。
5. 手动"立即同步"与后台周期同步都直接调 `do_sync`,**无互斥**,理论上并发跑 git。

## 目标

- **不用 Git LFS**(用户明确否决:破坏 file-over-app "裸 clone / Obsidian 直接可读"
  原则,且有配额成本)。改为**门禁式拦截**:>10MB 文件不进 commit,警告用户手动处理。
- 托盘增加**黄灯**警告档 + 点击展开待处理大文件子菜单(引导用户挪走)。
- 简化托盘同步控制:**配置后即自动同步**,只保留"立即同步",删除"开始/停止"。
- 同步**串行化**,同步进行中禁用"立即同步"。

## 非目标(YAGNI)

- 不做 Git LFS 任何形态。
- 不装 git pre-commit hook(只在同步代码里拦;命令行手动 commit 不受约束)。
- 不给被排除文件写 `.gitignore`(保持无状态自愈)。
- 不改初始化流程(桌面版本就没有集中的 git init;iOS clone、独立 CLI `vaultgitsync`
  各自独立,均不在本次范围)。
- 阈值先做成常量,不接 settings UI(日后需要再说)。

---

## A. 大文件门禁(vault_sync 后端)

### A1. 新模块 `src-tauri/src/vault_sync/large_files.rs`

职责单一:检测工作区里超阈值的待提交文件。

```rust
pub const LARGE_FILE_THRESHOLD: u64 = 10 * 1024 * 1024; // 10 MiB

/// 返回工作区里 size > 阈值 的待提交文件(相对 repo 根的路径)。
/// 只看 untracked(??) / added / modified 的条目 —— 即"将要进 commit 的新内容"。
pub fn detect_oversized(repo: &Path) -> GitResult<Vec<String>> {
    // git status --porcelain
    // 逐行解析,取 untracked(??)/A/M/AM/ M 等状态的路径
    // 对每个路径 std::fs::metadata(repo.join(path)).len() > LARGE_FILE_THRESHOLD 则收集
}
```

要点:
- 阈值判定用严格大于(`>`):正好 10 MiB 不算,10 MiB + 1 字节才算。
- 路径解析要处理 porcelain 的带引号/重命名情况;重命名不在门禁关注范围(门禁只拦
  "新进来的大内容"),实现时对无法 stat 的条目安全跳过。

### A2. 改 `git_ops::sync()`

把两处 `git add -A`(`git_ops.rs:57` 无 remote 分支、`:74` rebase 后)统一换成 helper:

```rust
/// git add -A,然后把超阈值文件撤出暂存(留在工作区),返回被排除清单。
fn stage_except_oversized(repo: &Path) -> GitResult<Vec<String>> {
    let oversized = super::large_files::detect_oversized(repo)?;
    run_git(repo, &["add", "-A"])?;
    for f in &oversized {
        let _ = run_git(repo, &["reset", "--", f]); // 撤出暂存,不删文件
    }
    Ok(oversized)
}
```

提交守卫:把 `git_ops.rs:83` 的 `if has_changes(repo)?` 换成"**暂存区**是否有内容"的判断:

```rust
// 只有暂存区非空才 commit,避免"本轮只剩一个被排除的大文件"时
// git commit 因 "nothing to commit" 报非零退出、被上层误判为 Error。
let staged_dirty = run_git(repo, &["diff", "--cached", "--quiet"]).is_err();
if staged_dirty {
    run_git(repo, &["commit", "-m", &format!("vault: auto-sync {ts}")])?;
}
```

`sync()` 返回值由 `GitResult<()>` 改为 `GitResult<SyncReport>`:

```rust
pub struct SyncReport {
    pub skipped_large: Vec<String>, // 本轮被排除的大文件(相对路径)
}
```

无 remote 分支同样收集被排除清单(即便不 push,也不该把大文件提交进本地历史)。

### A3. 无状态自愈

不写 `.gitignore`、不装 hook。每轮 `detect_oversized` 重算:用户把大文件删掉/移出/
压缩到阈值以下后,下一轮清单自然为空,警告消失。

---

## B. 托盘黄灯 + 大文件子菜单

大文件被排除**不算同步失败**:`git_ops::sync()` 仍返回 `Ok`,状态回到正常 `Running`,
**不**引入新的 `SyncState`,也**不**用 `Conflict`/`Error`(那俩表示同步挂了)。
"有待处理大文件"是一个**正交于 SyncState 的警告标志**。

### B1. 数据

`VaultSyncManager`(`vault_sync/mod.rs`)新增:

```rust
pub skipped_large_files: Mutex<Vec<String>>, // 最近一轮被排除的大文件(相对 repo 根路径)
```

`service::do_sync` 在每轮同步成功后,用 `SyncReport.skipped_large` **覆盖**它(空/非空都写,
才能在用户处理完后清空)。同时进 `VaultSyncStatus`(见 D 前端)。

### B2. 图标资源

新增两个资源(`src-tauri/icons/`):
- `tray-icon-warning.png` —— 托盘主图标的黄/琥珀徽标版本
- `dot-yellow.png` —— 菜单状态行的黄点

生成方式:用 sips/ImageMagick 把现有 `tray-icon-error.png` / `dot-red.png` 的徽标
色相旋到琥珀黄。**最终观感以用户实机确认为准**,不满意可重生成。

### B3. 图标/状态行优先级(`refresh_tray_status`, lib.rs:735)

新的四态优先级:

```
红(is_problem)  >  黄(skipped_large 非空)  >  绿(active=Running|Syncing)  >  灰
```

- 主图标:红 → `tray-icon-error.png`;黄 → `tray-icon-warning.png`;绿 → `tray-icon-active.png`;灰 → `tray-icon.png`。
- 状态行 dot:`status_dot_image` 增加 `has_large: bool` 参数,`is_problem` → dot-red,
  否则 `has_large` → dot-yellow,否则按原逻辑 green/grey。
- tooltip 追加大文件警告一行。

### B4. 大文件子菜单

仅当 `skipped_large` 非空时,在状态行下方插入一个子菜单 `⚠️ N 个文件过大`:
- 顶部一条**禁用**提示行:"超过 10 MB,未同步。请移出 vault:"
- 每个大文件一行,id `tray-large-file:<idx>`,label 为文件名;点击 →
  `open -R <绝对路径>`(在 Finder 里选中它,方便挪走)。绝对路径 = `repo_path.join(rel)`。

菜单为变长结构,沿用 `set_menu_locale` 的**整表重建**方式(`build_tray_menu`)。
为避免每 30s 无谓重建,新增状态 `TrayShownLargeFiles(Mutex<Vec<String>>)` 做快照 diff:
`refresh_tray_status` 里,仅当 `skipped_large != shown` 时才重建整个托盘菜单;
图标与 dot 每轮就地更新(便宜)。

### B5. 点击处理(`on_menu_event`, lib.rs:1035)

新增分支:id 以 `tray-large-file:` 开头 → 解析 idx → 从 `skipped_large` 快照取相对路径
→ `open -R <绝对路径>`。

---

## C. 托盘同步控制简化 + 串行化

### C1. 配置即自动同步

- `pick_sync_folder`(`lib.rs:565`)的默认 `on_done` 从空 `|_| {}` 改为:配置完成后
  调 `vault_sync::vault_sync_start` 启动同步循环。这样"Vault: 选文件夹"= 配置 + 自动同步,
  取代原"开始同步"。
- `init()`(`vault_sync/mod.rs`)**去掉 `auto_start` 门禁**:只要 `repo_path` 已配置就
  无条件启动同步。保留写 `auto_start=true` 做向后兼容,但不再拿它 gate(消除历史上
  被"停止同步"写成 `false` 而永久钉死的包袱)。

### C2. 删除开始/停止

- 删除托盘菜单项 `tray-sync-start`、`tray-sync-stop` 及其 `on_menu_event` 分支。
- 清理因此变死的 `pick_repo_and_start`(逻辑折进 `pick_sync_folder`)、`save_sync_enabled`。
- 托盘同步区最终保留:`Vault: <路径>`(改文件夹)、状态行、**立即同步**、查看日志、
  编辑 AGENTS.md。

### C3. 同步串行化(sync mutex)

`VaultSyncManager` 新增 `sync_gate: Mutex<()>`:
- 后台循环路径(`run_loop` → `do_sync`):**阻塞 lock** 持有 gate 跑完整轮同步。
- 手动 `sync_once`(`service.rs`):**try_lock**,拿不到锁说明正在同步 → 记一条
  `INFO "sync already in progress, skipped"` 日志并直接返回(手动 kick 冗余,无需排队)。

实现上把 `do_sync` 的 git 触碰部分置于 gate 之内;两个调用点各自决定阻塞/try。

### C4. 同步中禁用"立即同步"

- `build_tray_menu` 里把 `tray-sync-now` 的 `MenuItem` 句柄存进新状态
  `TraySyncNowItem(Mutex<Option<MenuItem<Wry>>>)`(仿 `TrayStatusItem`)。
- `refresh_tray_status` 里 `set_enabled(state != SyncState::Syncing)`。因 `do_sync`
  起止各调一次 `set_state`(Syncing → Running/Error),托盘刷新自动在同步期间灰掉按钮、
  结束恢复。
- `set_menu_locale` 重建菜单时同样重新捕获该句柄。

---

## D. 提示与 i18n

### D1. 前端 toast + 状态

- `VaultSyncStatus`(`vault_sync/mod.rs`)新增 `skipped_large_files: Vec<String>`,
  `vault_sync_status` 命令带出。
- 前端 `vaultStore`(`src/lib/vault.svelte.ts`)读到 `skipped_large_files` 非空 →
  弹 warn toast `vault.largeFileSkipped`:"⚠️ Vault:N 个超过 10 MB 的文件未同步,
  请手动处理"。
- `VaultSettingsTab.svelte` 的"立即同步"按钮:`vaultStore.state === 'syncing'` 时 disabled
  (与托盘一致)。

### D2. i18n key

- 前端(自研 i18n,`src/i18n/en.ts` 扁平点分键 + 各语言 Partial):
  `vault.largeFileSkipped`(带数量插值)。
- 托盘(`lib.rs` 内 en/zh/ja/de 元组表,~line 1230):
  `tray.largeFiles.title`("⚠️ {n} file(s) too large" / "⚠️ {n} 个文件过大" / …)、
  `tray.largeFiles.header`("Over 10 MB — not synced. Move out of your vault:" / …)。

---

## 测试

### Rust 单元测试(`large_files` + `git_ops`)

在临时 git repo 内:
- `detect_oversized`:小文件不返回;>10MiB 文件返回;边界(正好 10MiB 不算、+1 算)。
- `stage_except_oversized`:大文件未暂存(`git diff --cached --name-only` 不含它),
  其余文件已暂存。
- 提交守卫:本轮只有一个大文件时,`git commit` 不产生新 commit(HEAD 不变),
  且 `SyncReport.skipped_large` 含该文件。
- sync mutex:并发调用时 try_lock 路径正确跳过(可用共享 `Mutex` + 两线程断言其一被跳过)。

### GUI 验证(托盘 / 前端)

托盘与前端属 GUI,按既有约定:**只出 dev 构建 + 手动测试步骤交用户实机验证**,
不在用户桌面跑 osascript 自动化(见 memory `feedback_no_ui_automation_user_tests`、
`feedback_gui_verify_desktop_contention`)。手动验证清单至少覆盖:
1. 往 vault 丢一个 >10MB 文件 → 托盘转黄、子菜单出现该文件、点击在 Finder 选中、
   toast 弹出;其余小改动照常同步。
2. 挪走该大文件 → 下一轮托盘恢复绿、子菜单消失。
3. 运行时"选文件夹"配置一个新 vault → 立即自动开始同步(无需"开始同步")。
4. 同步进行中 → 托盘"立即同步"与前端按钮均置灰;同步结束恢复。
5. 黄图标观感确认。

---

## 涉及文件一览

后端:
- `src-tauri/src/vault_sync/large_files.rs`(新增)
- `src-tauri/src/vault_sync/git_ops.rs`(sync 门禁 + SyncReport + 提交守卫)
- `src-tauri/src/vault_sync/service.rs`(串行化 gate、sync_once try_lock、
  写 skipped_large_files)
- `src-tauri/src/vault_sync/mod.rs`(SyncReport/字段/sync_gate/VaultSyncStatus)
- `src-tauri/src/lib.rs`(托盘四态图标、黄 dot、大文件子菜单、点击处理、
  删开始/停止、pick_sync_folder 自动启动、init 去 gate、TraySyncNowItem 禁用、
  TrayShownLargeFiles、i18n 元组)
- `src-tauri/icons/tray-icon-warning.png`、`dot-yellow.png`(新增资源)

前端:
- `src/lib/vault.svelte.ts`(skipped_large_files → toast)
- `src/components/VaultSettingsTab.svelte`(Sync Now 同步中禁用)
- `src/i18n/en.ts` 及各语言 Partial(`vault.largeFileSkipped`)
