# VaultGitSync — mdeditor 集成设计

日期: 2026-05-12
状态: Draft

## 概述

将 vaultgitsync（基于 Git/GitHub 的文件自动同步服务）集成到 mdeditor 中，作为内置 Rust 模块运行。用户通过 tray 菜单控制同步服务的启停、查看状态和日志。

## 目标

- 文件变更后即时（2秒 debounce）自动 commit + push 到 GitHub
- 定时 pull（30秒）获取远端变更
- 冲突时保留双方版本，不覆盖任何数据
- 通过 tray 菜单提供启停控制、状态展示、日志查看

## 架构

```
┌─────────────────────────────────────────────┐
│  mdeditor (Tauri app)                       │
│                                             │
│  ┌───────────────┐   ┌──────────────────┐  │
│  │  Tray Menu    │   │  Log Window      │  │
│  │  (动态更新)    │   │  (WebView)       │  │
│  └───────┬───────┘   └────────▲─────────┘  │
│          │                     │            │
│  ┌───────▼─────────────────────┴─────────┐  │
│  │  vault_sync module (Rust)             │  │
│  │                                       │  │
│  │  ┌─────────┐  ┌────────┐  ┌───────┐  │  │
│  │  │ Watcher │  │ GitOps │  │ State │  │  │
│  │  │ (notify)│  │(git cli)│  │ Mgr  │  │  │
│  │  └────┬────┘  └────▲───┘  └───┬───┘  │  │
│  │       │            │          │       │  │
│  │       └──debounce──┘          │       │  │
│  │                               │       │  │
│  │  ┌────────────────────────────▼────┐  │  │
│  │  │  Log Ring Buffer (内存, 1000行) │  │  │
│  │  └────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
         │
         ▼
   GitHub (private repo)
```

## 模块结构

```
src-tauri/src/vault_sync/
├── mod.rs          # 公开接口、Tauri commands
├── service.rs      # 后台服务生命周期（start/stop/状态）
├── watcher.rs      # 文件监听 (notify crate)
├── git_ops.rs      # Git 操作 (调用 git CLI)
├── conflict.rs     # 冲突检测与处理
└── log_buffer.rs   # 环形日志缓冲
```

## Tray 菜单设计

现有菜单:
```
Show M↓
─────────
Quit M↓
```

集成后:
```
Show M↓
─────────────────────
Vault Sync: Running ✓     (状态指示，禁用态不可点击)
  Start Sync               (运行时 disabled)
  Stop Sync                (停止时 disabled)
  Sync Now                 (手动触发)
  View Log…                (打开日志窗口)
─────────────────────
Quit M↓
```

状态文字变化:
- 未配置: `Vault Sync: Not Configured`
- 已停止: `Vault Sync: Stopped`
- 运行中: `Vault Sync: Running`
- 同步中: `Vault Sync: Syncing…`
- 有冲突: `Vault Sync: Conflict!`
- 出错:   `Vault Sync: Error`

## 同步流程

### 触发条件

1. 文件变更（notify 监听） → 2秒 debounce → sync()
2. 定时器 → 每30秒 → sync()
3. 用户手动 → "Sync Now" 菜单 → sync()

### sync() 核心逻辑

```
1. 获取 sync_lock（Mutex，保证串行）
2. git fetch origin main
3. 检查本地是否有未提交变更
4. 如果有本地变更:
   a. git add -A
   b. git stash push -m "vaultgitsync-auto"
   c. git rebase origin/main
      - 如果 rebase 失败 → abort → stash pop → 记录错误 → 退出
   d. git stash pop
      - 如果 pop 冲突 → 走冲突处理
   e. git add -A
   f. git commit -m "vault: auto-sync <timestamp>"
   g. git push origin main
      - 如果 push 失败 → 记录警告 → 下次重试
5. 如果无本地变更:
   a. git pull --ff-only origin main
      - 如果 ff-only 失败 → git pull --rebase
```

### 冲突处理

策略: 保留双方版本，不自动合并内容，不覆盖任何数据。

```
检测到冲突文件 notes/foo.md:
  1. 将本地版本(ours)保存为 notes/foo.conflict.<YYYYMMDDHHmmss>.md
  2. 接受远端版本: git checkout --theirs notes/foo.md
  3. git add 冲突文件 + 备份文件
  4. commit + push
  5. 更新状态为 "Conflict!"
  6. 写入日志: "冲突: notes/foo.md，本地版本已保存为 foo.conflict.20260512143022.md"
```

用户可通过日志窗口看到冲突信息，手动对比合并后删除 `.conflict.*` 文件。

## 配置

存储在 tauri-plugin-store 的 settings.json 中:

```json
{
  "vault_sync.enabled": true,
  "vault_sync.repo_path": "/Users/bruce/Documents/vault",
  "vault_sync.remote": "origin",
  "vault_sync.branch": "main",
  "vault_sync.auto_start": true,
  "vault_sync.debounce_ms": 2000,
  "vault_sync.pull_interval_secs": 30
}
```

首次使用需要:
1. 用户在 Preferences 中配置 repo_path（已 clone 好的 git 仓库路径）
2. 仓库需已配置好 GitHub remote 和认证（SSH key 或 credential helper）

## 日志窗口

- 独立 WebView 窗口，标题 "Vault Sync Log"
- 显示最近 1000 条日志（环形缓冲）
- 每条日志: `[时间] [级别] 消息`
- 实时更新（通过 Tauri event 推送到前端）
- 支持滚动查看历史

前端实现:
- 页面文件: `src/vault-sync-log.html`（独立入口，不走主 SPA 路由）
- 在 `tauri.conf.json` 的 windows 配置中注册为可创建窗口
- 监听 `vault-sync-log` 事件，追加到 `<pre>` 容器
- 窗口大小: 600x400，可调整，标题 "Vault Sync Log"

## Tauri Commands

```rust
#[tauri::command] fn vault_sync_start(app: AppHandle) -> Result<(), String>
#[tauri::command] fn vault_sync_stop(app: AppHandle) -> Result<(), String>
#[tauri::command] fn vault_sync_now(app: AppHandle) -> Result<(), String>
#[tauri::command] fn vault_sync_status(app: AppHandle) -> VaultSyncStatus
#[tauri::command] fn vault_sync_logs(app: AppHandle) -> Vec<LogEntry>
```

## 状态管理

```rust
enum SyncState {
    NotConfigured,
    Stopped,
    Running,
    Syncing,
    Conflict,
    Error(String),
}
```

状态变更时:
1. 更新内存中的 state
2. 动态更新 tray 菜单项文字和 enabled 状态
3. 发送 `vault-sync-state-changed` 事件到前端

## 依赖变更

在 `src-tauri/Cargo.toml` 新增:
```toml
notify = { version = "7", default-features = false, features = ["macos_fsevent"] }
```

Git 操作通过 `std::process::Command` 调用系统 git（不引入 libgit2 依赖，保持二进制体积小）。

## 不做的事

- 不提供 GitHub token/SSH key 管理（用户自行配置系统 git 认证）
- 不提供仓库初始化 UI（用户自行 git clone）
- 不做文件级别的 diff/merge UI（冲突时保留双方文件，用户用外部工具合并）
- 不监听 `.git/` 目录变更
- 不同步 `.gitignore` 中排除的文件

## 测试策略

- 单元测试: git_ops 模块的 sync 逻辑（用临时 git 仓库）
- 集成测试: watcher + git_ops 联动
- 手动测试: tray 菜单交互、日志窗口、冲突场景
