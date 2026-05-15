# iOS Vault GitHub Sync —— 设计稿

> 在 iOS app 上增加 GitHub 仓库同步与离线阅读/编辑能力：用户配置一个 vault（GitHub 仓库 + PAT），App 把仓库 clone 到沙箱内 Documents 目录，提供文件夹树式浏览，使用 mdeditor 查看或编辑；手动 + 前台进入时自动 fetch / commit / push，沿用 macOS vault_sync 的冲突策略。

## §1 总体架构

**核心选择：纯 libgit2（`git2` crate）实现，iOS-only，cfg 屏蔽 macOS。**

macOS 现有的 `src-tauri/src/vault_sync/` 用系统 `git` CLI（`std::process::Command`），在 iOS 上**不可用**（无 fork/exec、无系统 git、沙箱限制）。iOS 走完全独立的新模块 `src-tauri/src/vault_ios/`，用 libgit2 做 fetch/pull/commit/push。pure-Rust + vendored libgit2 + vendored OpenSSL，HTTPS only。PAT 通过 libgit2 的 `credentials_cb` 注入为 `UserPass{ username: "x-access-token", password: PAT }`。

macOS 端**不动**：iOS 上的 `vault_ios` 是独立模块，cfg-gated；macOS 继续用现有的 CLI-based `vault_sync`。未来如果想统一到 libgit2，独立排期。

### 1.1 与现有 iOS 代码的契合点

| 现有 | 怎么用 |
|---|---|
| `src/lib/platform.svelte.ts` | `isIOS` gate 新 UI / Rust commands |
| `src/components/DrawerNav.svelte` | 扩展为 Vault 浏览器（新增 "Vault" 分区），保留现有 Recent |
| `src/components/SettingsDialog.svelte` | 新增 "Vault" tab（仅 iOS 显示） |
| `src/components/MobileToolbar.svelte` | 去掉 `formFactor === 'phone'` 限制，让 ☰ 抽屉按钮在 iPad 上也显示 |
| `src/lib/tabs.svelte.ts::openFile(path)` | 文件列表点击 → 调现有 `openFile` 即可（文件就在沙箱里） |
| `Documents/`（`UIFileSharingEnabled=true`） | vault 仓库存放点 `Documents/Vault/`（单 vault，就是工作树根，无 repo 子目录） |
| `@tauri-apps/plugin-os` | 已在 ios-port 里使用 |

### 1.2 新增代码概览（约 ~600 行 Rust + ~40 行 Swift + ~500 行 TS/Svelte）

**Rust（新增 `src-tauri/src/vault_ios/`）：**

| 文件 | 职责 |
|---|---|
| `mod.rs` | Tauri commands、`VaultIosManager` 状态机、init/卸载 |
| `clone.rs` | 首次 clone（带凭据回调），进度通过 `vault_clone_progress` 事件流出 |
| `sync.rs` | 单次同步循环：fetch / rebase / stash / commit / push |
| `conflict.rs` | 冲突时本地版本另存为 `<file>.conflict.<ts>.<ext>` 并保留远端 |
| `keychain.rs` | 通过 Swift 桥读写 iOS Keychain |

**Swift（追加到现有 `IOSBridge.swift` 框架内）：**

`Keychain.swift`，封装 `SecItemAdd` / `SecItemCopyMatching` / `SecItemDelete`，对外暴露三个 Tauri Plugin 命令：`keychain_set` / `keychain_get` / `keychain_delete`。

**前端（新增）：**

| 文件 | 职责 |
|---|---|
| `src/lib/vault.svelte.ts` | Vault 响应式状态 store + TS 包装 Tauri 命令 |
| `src/lib/vault-list.ts` | 文件类型白名单过滤、`.git` 隐藏、扩展名分类 |
| `src/components/VaultBrowser.svelte` | DrawerNav 内嵌的层级浏览组件 |
| `src/components/VaultSettingsTab.svelte` | Settings → Vault tab |

**前端（改动）：**

| 文件 | 改动 |
|---|---|
| `src/components/DrawerNav.svelte` | 加 Vault 分区，宿主 `VaultBrowser` |
| `src/components/SettingsDialog.svelte` | iOS 上加 Vault tab |
| `src/components/MobileToolbar.svelte` | 去掉 ☰ 按钮的 `formFactor === 'phone'` 限制 |
| `src/App.svelte` | 监听 `tauri://focus` + `visibilitychange` 触发同步 |
| `src-tauri/Cargo.toml` | `[target.'cfg(target_os = "ios")']` 加 `git2 = { version = "0.19", default-features = false, features = ["vendored-libgit2", "vendored-openssl"] }` |
| `src-tauri/src/lib.rs` | iOS 编译时注册 `vault_ios` 的命令 |

---

## §2 认证 & 凭据存储

### 2.1 PAT 取得流程（用户操作）

1. 用户去 `github.com/settings/personal-access-tokens/new`（fine-grained）。
2. Repository access：选他的 vault 仓库（或 All repositories）。
3. Permissions → Repository → **Contents: Read and write**（其它权限不勾，最小授权）。
4. 拷贝 token（`github_pat_...` 开头），粘到 App。

Vault Settings tab 里加一行"📖 如何生成 Token"链接，点击调 `openUrl('https://github.com/settings/personal-access-tokens/new')` 跳到 Safari。

### 2.2 凭据存储：iOS Keychain（via Swift 桥）

不存到 `tauri-plugin-store`（settings.json 在沙箱里，丢手机被解锁后可读）。Keychain item 用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`（解锁后才可读；不随 iCloud 钥匙串同步到别的设备）。

Keychain item 标识：

- service: `com.bruce.mdeditor.vault`
- account: `pat`（单 vault，account 固定）
- value: PAT 字符串

Swift API（封装在 IOSBridge 里）：

```swift
@objc public func keychainSet(_ invoke: Invoke) throws    // { value: string } → resolve()
@objc public func keychainGet(_ invoke: Invoke) throws    // → resolve({ value: string | null })
@objc public func keychainDelete(_ invoke: Invoke) throws // → resolve()
```

实现要点（Swift）：

```swift
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.bruce.mdeditor.vault",
    kSecAttrAccount as String: "pat",
    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    kSecValueData as String: valueData,
]
// upsert: 先 SecItemDelete 再 SecItemAdd
```

Rust 侧 `keychain.rs` 通过标准 Tauri plugin 协议调上述三个命令（不直接调 Swift）。

### 2.3 libgit2 凭据注入

```rust
use git2::{Cred, FetchOptions, RemoteCallbacks};

let pat = keychain::get_pat()?;
let mut cb = RemoteCallbacks::new();
cb.credentials(|_url, _user, _allowed| {
    Cred::userpass_plaintext("x-access-token", &pat)
});

let mut fo = FetchOptions::new();
fo.remote_callbacks(cb);
```

fetch 和 push 都用这一份 fo（push 用对应的 `PushOptions`，结构相同）。

### 2.4 Settings UI 上的安全行为

- PAT 输入框 `type="password"`，UI 上不显示已存的 token，只显示"✓ Token 已配置（去更新）"或"❌ 未配置（去添加）"。
- "Disconnect vault" 按钮 → 二次确认 → 调 `keychainDelete` + 删本地 vault 目录 + 清 settings 里的 vault 配置。

### 2.5 git author（commit 身份）

设置里两个字段（带默认值）：

- Author name —— 默认 `mdeditor on iOS`
- Author email —— 默认通过 PAT 调 GitHub API `GET https://api.github.com/user`（带 `Authorization: Bearer <PAT>` header）拿当前用户的 `login`，回填 `<login>@users.noreply.github.com`。失败则留空让用户手填。

调用时机：用户在 `VaultSettingsTab` 输入 PAT 后立即触发一次（不等到 clone），同步阻塞 ≤ 3s；失败则忽略。

---

## §3 Rust sync 模块（vault_ios）

### 3.1 Tauri 命令清单

| 命令 | 入参 | 出参 | 用途 |
|---|---|---|---|
| `vault_configure` | `{ remote_url, branch, pat, author_name, author_email }` | `{ ok }` | 写 settings + Keychain，clone 仓库 |
| `vault_clone_progress` | （Tauri event） | `{ stage, received_objects, total_objects, bytes }` | clone 进度推送 |
| `vault_sync_now` | 无 | `{ state, last_sync, conflicts: number }` | 单次同步循环 |
| `vault_status` | 无 | `VaultStatus`（state + last_sync + error_message + has_conflicts） | UI 查状态 |
| `vault_list_dir` | `{ rel_path: string }` | `Array<{ name, kind: 'file' \| 'dir', size, mtime, ext }>` | 文件浏览 |
| `vault_disconnect` | 无 | `{ ok }` | 删本地 vault + Keychain |

### 3.2 状态机

```
NotConfigured → (vault_configure) → Cloning → Idle
                                         ↓
                              (vault_sync_now)
                                         ↓
                                     Syncing → Idle
                                          ↘ Conflict（本地存了 .conflict 文件，但 sync 继续完成）
                                          ↘ Error（网络/认证失败，停在 Idle 但带 error_msg）
```

状态存在 `Arc<Mutex<VaultIosManager>>`，挂 `app.state()`。前端通过 `vault_status` 命令读 + 监听 `vault-status-changed` event 推送（每次状态变化时 emit）。

### 3.3 单次同步循环（`sync.rs`）

沿用 macOS `src-tauri/src/vault_sync/git_ops.rs::sync` 的语义，改用 libgit2：

`vault_path()` 在 Rust 端固定为 `<NSDocumentDirectory>/Vault/`，通过 Tauri 的 `path_resolver().document_dir()` 取得；其下直接是 Git 工作树根（含 `.git/`）。

```rust
pub fn sync_once(mgr: &VaultIosManager) -> Result<SyncOutcome, VaultError> {
    let repo = Repository::open(&vault_path())?;
    let branch = mgr.branch.lock().unwrap().clone();
    let pat = keychain::get_pat()?;
    let mut conflicts_log = Vec::<String>::new();

    let mut fo = FetchOptions::new();
    fo.remote_callbacks(make_credentials_cb(&pat));

    // 1. fetch origin/<branch>
    repo.find_remote("origin")?.fetch(&[&branch], Some(&mut fo), None)?;

    let has_local = has_workdir_changes(&repo)?;

    if !has_local {
        // 快进 pull
        fast_forward_to_origin(&repo, &branch)?;
        return Ok(SyncOutcome::PullOnly);
    }

    // 2. 有本地改动 → 暂存 / rebase / 还原
    let stash_oid = repo.stash_save(&author_sig(mgr), "vault-auto", None)?;

    match rebase_onto_origin(&repo, &branch) {
        Ok(()) => {
            // 3. 把 stash 恢复回来
            match repo.stash_pop(0, None) {
                Ok(()) => {}
                Err(e) if is_conflict(&e) => conflict::handle(&repo, &mut conflicts_log)?,
                Err(e) => return Err(e.into()),
            }
        }
        Err(_) => {
            rebase_abort(&repo);
            repo.stash_pop(0, None).ok();
            return Err(VaultError::RebaseFailed);  // 下一次再试
        }
    }

    // 4. add -A + commit
    let tree_id = stage_all(&repo)?;
    let parent = repo.head()?.peel_to_commit()?;
    let sig = author_sig(mgr);
    let msg = format!("vault: auto-sync {}", timestamp_compact());
    repo.commit(Some("HEAD"), &sig, &sig, &msg, &repo.find_tree(tree_id)?, &[&parent])?;

    // 5. push
    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(make_credentials_cb(&pat));
    repo.find_remote("origin")?.push(&[&refspec(&branch)], Some(&mut push_opts))?;

    Ok(SyncOutcome::Pushed { conflicts: conflicts_log })
}
```

### 3.4 冲突处理（`conflict.rs`）

与 macOS `src-tauri/src/vault_sync/conflict.rs` 语义完全一致：

- 检测到 stash_pop 冲突 → 遍历 index 中 `is_conflicted()` 的 entry
- 把本地工作树版本拷贝成 `<basename>.conflict.<YYYYMMDD-HHMMSS><.ext>`
- 用 libgit2 的 checkout-theirs 把工作树文件覆盖为远端版本（`Checkout::theirs()`）
- 把"本地保留"文件 + 修复后的原文件都 add 到 index
- 继续 sync，把 `.conflict.*` 副本一起 commit & push 上去（用户在桌面/网页上能看见自己之前的版本）

### 3.5 错误归类

```rust
pub enum VaultError {
    NotConfigured,
    NetworkError(String),       // libgit2 transport error
    AuthFailed,                 // 401/403 → 提示用户重新生成 PAT
    NotFoundOrNoAccess,         // 404 → PAT 权限不够 / 仓库名错
    RebaseFailed,               // 本地改动和远端冲突且无法合并
    PushRejected(String),       // non-fast-forward / protected branch
    FsError(String),
    GitError(String),
}
```

每种错误对应一条 toast 文案：

| 枚举 | 文案 |
|---|---|
| `NotConfigured` | `❌ Vault: 未配置` |
| `NetworkError` | `❌ Vault: 网络错误` |
| `AuthFailed` | `❌ Vault: 鉴权失败，请去 Vault 设置更新 PAT` |
| `NotFoundOrNoAccess` | `❌ Vault: 仓库不存在或 PAT 无权访问` |
| `RebaseFailed` | `⚠️ Vault: 自动合并失败，本次跳过；下次再试` |
| `PushRejected` | `❌ Vault: 推送被拒绝（${detail}）` |
| `FsError` / `GitError` | `❌ Vault: ${detail}` |

### 3.6 Cargo.toml 增量

```toml
[target.'cfg(target_os = "ios")'.dependencies]
git2 = { version = "0.19", default-features = false, features = ["vendored-libgit2", "vendored-openssl"] }
```

`vendored-libgit2` 编译 libgit2 进 binary（不依赖系统库，iOS 必须）；`vendored-openssl` 让 OpenSSL 也静态进来（iOS 上 SecureTransport 后端的 git2 兼容性需要专门测，v1 先用 vendored OpenSSL 简化）。

包体增量预估：libgit2 + OpenSSL 静态库约 **+6–8 MB** 到 IPA。DoD 阶段实测确认；若超 30MB 包体红线，再切换到 SecureTransport 后端。

---

## §4 UI 改动

### 4.1 Vault Settings tab（仅 iOS）

`SettingsDialog.svelte` 加一个 Vault tab，位置在 Core / Share 之间。组件 `VaultSettingsTab.svelte`：

```
┌─ Vault ───────────────────────────────┐
│ Status: ✓ Synced 2 min ago            │
│ Repo:   github.com/wizlijun/notes.git │
│ Branch: main                          │
│                                       │
│ [立即同步]  [断开 Vault]                │
│                                       │
│ ─────────────────────────────────────  │
│ Configuration                         │
│  Remote URL  [https://...........]   │
│  Branch      [main             ]     │
│  PAT         [✓ 已配置 / 更新...]      │
│              📖 如何生成 Token         │
│  Author Name [mdeditor on iOS  ]     │
│  Author Email[wizlijun@users.... ]   │
│  [保存配置]                            │
│                                       │
│ ─────────────────────────────────────  │
│ Conflicts (3 files)              [详情]│
│  notes/today.conflict.2026...        │
│  ...                                  │
│ ⚠️ 请勿在 Files App 内修改/删除 Vault │
└───────────────────────────────────────┘
```

行为：

- "立即同步"按钮 → `vault_sync_now`，按钮上转圈直到 store 状态变 `Idle`
- "断开 Vault" → 二次确认对话框（"会删除本地 Vault 副本与 PAT，远端仓库不受影响"） → `vault_disconnect`
- PAT 输入：只有在没配置 OR 用户点"更新"时才显示输入框；保存时调 `vault_configure`
- 配置改动需要重 clone 的情况：远端 URL 改变 → 二次确认"重新 clone 会先删除本地副本"

### 4.2 DrawerNav 扩展（iPhone + iPad 抽屉）

现状（来自 `DrawerNav.svelte`）：☰ → 📂 Open File + Recent + ⚙️ Settings。
新版本，仅 iOS 上多一个分区：

```
┌─ Drawer ─────────────────┐
│ M↓                       │
│ 📂 Open File             │
│                          │
│ ── Vault ──         [↻]  │  ← 同步按钮，spinner 在同步
│ 📁 daily                 │
│ 📁 projects              │
│ 📄 README.md             │
│ 📄 ideas.md              │
│ ...                      │
│                          │
│ ── Recent ──             │
│ ideas.md                 │
│ notes/today.md           │
│                          │
│ ⚙️ Settings              │
└──────────────────────────┘
```

行为：

- 顶部 `Vault` 标签右侧一个同步按钮（圆形箭头图标）：点击调 `vault_sync_now`；同步中转 spinner；hover/long-press 显示最近一次同步时间。
- Vault 区显示**当前层级**的子文件夹和文件。点子文件夹 → 抽屉内 push 一层（面包屑出现 "Vault › daily"，左侧加返回按钮）。点文件 → 关闭抽屉 + `openFile(absPath)`（沿用现有 tabs/openFile 流程）。
- 文件类型按扩展名打小图标：`.md` 📝 / `.html` 🌐 / `.txt` `.log` 📄 / `.png` `.jpg` ... 🖼。
- **过滤**：列表只显示 mdeditor 能打开的类型（白名单：md, markdown, mdown, mkd, html, htm, txt, log, csv, tsv, env, jpg, jpeg, png, gif, webp, svg, bmp, heic, heif, avif）；其它类型（`.git`、`.DS_Store`、可执行、PDF、视频等）不显示。
- **隐藏 `.git` 目录**：硬编码不可见。
- **空状态**：vault 未配置 → "去设置 → Vault 配置仓库"（点跳到 Settings 的 Vault tab）；已配置但目录为空 → "Vault 为空"。

### 4.3 MobileToolbar 调整（iPad 也能开抽屉）

把 `MobileToolbar.svelte:14` 的 `{#if formFactor.value === 'phone'}` 限制移除，让 ☰ 按钮在 iPad 上也显示。iPad 上点开同一个 DrawerNav 抽屉。

### 4.4 前台触发同步（`App.svelte`）

```ts
import { listen } from '@tauri-apps/api/event'

// 仅 iOS 且 vault 已配置时挂监听
if (await isIOS() && vaultStore.configured) {
  listen('tauri://focus', () => { vault.syncNow() })  // 切回前台
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') vault.syncNow()
  })
}
```

**去重**：若上次同步在 30 秒内已成功（`vaultStore.lastSync > now - 30000` 且 `state === 'idle'`），跳过本次触发（避免快速 App 切换刷屏）。

### 4.5 Toast 反馈策略

- 同步成功且**有变化**（pull 或 push 任意）：success toast `✓ Vault 同步完成`
- 同步成功但**无任何变化**：不弹 toast（静默），避免吵
- 同步失败：error toast，文案按错误类型分（见 §3.5）
- 发生冲突：warn toast `⚠️ Vault: 同步完成，N 个本地修改保留为 .conflict 副本`

### 4.6 响应式状态（`src/lib/vault.svelte.ts`）

```ts
export const vaultStore = $state<{
  configured: boolean
  state: 'idle' | 'cloning' | 'syncing' | 'error' | 'conflict'
  lastSync: number | null         // epoch ms
  errorMsg: string | null
  hasConflicts: boolean
}>({ configured: false, state: 'idle', lastSync: null, errorMsg: null, hasConflicts: false })

export async function syncNow(): Promise<void> { /* invoke('vault_sync_now') + 更新 store */ }
export async function refreshStatus(): Promise<void> { /* invoke('vault_status') */ }
```

启动时（`main.ts`）调一次 `refreshStatus()` 把 store 初始化。

---

## §5 测试

### 5.1 单元测试（Vitest）

新增：

- `src/lib/vault.test.ts` —— store 状态机转换；`syncNow` 在并发触发时的 30s 去重
- `src/lib/vault-list.test.ts` —— 文件类型白名单过滤（.git 隐藏、扩展名分类、未知类型剔除）

现有 toast / share / platform / fs / tabs 等测试**不动**。

### 5.2 Rust 测试（cargo test，macOS 上跑）

git2 跨平台，可以在 macOS 上测：

- `vault_ios::sync` 在 fresh repo + dirty workdir / clean workdir 两种路径下行为正确
- `vault_ios::conflict::handle` 生成 `.conflict.<ts>` 副本且 stage 进 index
- `vault_ios::keychain` 在 macOS 测试时降级用 `~/.cache/mdeditor-test-keychain.json` 文件桩（cfg-gated `#[cfg(not(target_os = "ios"))]`）

### 5.3 手工 smoke（README iOS 段第 96–110 条）

```
96. iOS：未配置 vault → 抽屉 Vault 分区显示"去设置配置仓库"；点跳到 SettingsDialog → Vault tab。
97. 输入 remote URL + PAT + 保存 → toast "正在 clone..." → 完成后抽屉显示 vault 根目录文件。
98. 已配置 vault，杀进程重开 → vault 状态自动恢复，文件列表照旧。
99. 点抽屉里一个 .md 文件 → mdeditor 打开；编辑保存 → 工作树 dirty。
100. 点 vault 区的 [↻] 同步按钮 → spinner → 完成后 toast "✓ Vault 同步完成"；GitHub Web 上能看到新 commit `vault: auto-sync <ts>`。
101. 在另一台设备（macOS / GitHub Web）改一个文件 push → iOS App 切回前台 → 5 秒内自动拉回 → 抽屉里该文件 mtime 更新；打开文件看到新内容。
102. 双向冲突场景：本地编辑文件 A → 远端也改了文件 A → 同步 → toast "⚠️ Vault: 同步完成，1 个本地修改保留为 .conflict 副本" → 抽屉里看到 A.conflict.<ts>.md 在同目录下；GitHub 仓库也收到这两个文件。
103. PAT 失效（手动在 GitHub 上 revoke） → 同步 → toast "❌ Vault: 鉴权失败，请去 Vault 设置更新 PAT"。
104. 飞行模式 → 同步 → toast "❌ Vault: 网络错误"。
105. "断开 Vault" → 二次确认 → 本地 Documents/Vault/ 删除、Keychain item 清除、抽屉 Vault 区回到"未配置"状态；远端仓库不受影响（去 GitHub 检查）。
106. iPad 上 ☰ 按钮显示并能打开抽屉；vault 文件浏览行为与 iPhone 一致。
107. vault 仓库中有图片（.png）→ 抽屉点击 → 进入 mdeditor 图片预览 tab。
108. vault 仓库 .git 目录在抽屉中**不可见**。
109. Files App 进入 Documents/Vault/ → 用户看到完整工作树（含 .git）→ 检查 NSURLIsExcludedFromBackupKey 真的排除 iCloud（在 Files App 顶部不显示云图标）。
110. IPA 包体增量 < 10 MB（baseline 对比 v0.6.0）；总 IPA < 30 MB。
```

---

## §6 风险

| 风险 | 缓解 |
|---|---|
| `git2 = "0.19"` + `vendored-libgit2` + `vendored-openssl` 在 iOS arm64 上能否一次编出来 | 第一个 Task 就是建一个 iOS 编译 spike：写最小的 `git2::Repository::clone` 调用 + `cargo build --target aarch64-apple-ios`，验证 link 成功。如果失败，备选切到 `gitoxide`（`gix` crate）或 `tauri-plugin-shell` 调 bundled binary（成本骤增）。 |
| PAT clone 大仓（>100 MB / >10k 文件）超时 / 内存爆 | `vault_configure` 给一个文件大小上限警示；如果 clone 超过 30s 不动就中断；spec 不解决大仓问题，DoD 写明"v1 支持 < 100MB / < 5k 文件的 vault"。 |
| iOS 沙箱杀掉后台同步进程 | 我们只在前台触发，没有后台任务；同步是 Tauri command 同步阻塞，App 在前台不会被杀。 |
| Keychain item 同步到 iCloud 钥匙串导致泄漏 | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` 已经禁止跨设备同步；spec 里 Swift 桥代码硬编码这个 attribute。 |
| 用户在 Files App 删了 vault 根目录 | 每次 sync 前先 `path.exists() && .git` 检查，找不到就转为 `NotConfigured` 状态并 toast 提示"vault 已不存在，请重新配置"。 |
| libgit2 在 push 大量小文件时内存占用 | git2 默认 pack 算法不算激进；spec 不做特殊优化，DoD 验收时实测一次。 |
| App Store 审核问"vault 用途" | 提交时 Privacy section 写明"用户配置自己的 GitHub 仓库进行同步；App 不收集任何数据，PAT 仅本机 Keychain"；TestFlight 阶段可先不上架公开 review。 |

---

## §7 Definition of Done

- [ ] 单元测试（Vitest）+ Rust 测试全过
- [ ] §5.3 第 96–110 条 smoke 全过
- [ ] IPA 包体 < 30 MB；vault sync 模块增量 < 10 MB
- [ ] macOS 端 70 条原有 smoke + iOS 端 71–95 条原有 smoke 全部回归通过（vault_ios 是 iOS-only 模块，理论上不影响 macOS，但回归一遍兜底）
- [ ] PAT 在 Keychain 而不在 settings.json（用 `security` CLI / `xcrun simctl` 工具在模拟器上验证 settings.json 不包含 PAT 子串）
- [ ] vault 目录的 `NSURLIsExcludedFromBackupKey=true` 设置生效

---

## §8 不在 v1 的事

- OAuth Device Flow 登录（v1 只支持 PAT）
- 多 vault
- 后台周期同步（BGTaskScheduler）
- 全文搜索文件名 / 内容
- vault 内 LFS 大文件支持
- 内嵌的"冲突解决三栏 diff UI"——v1 用户去 macOS / GitHub Web 上手动处理冲突文件
- vault 仓库切到 libgit2 后 macOS 也统一过去——独立排期
