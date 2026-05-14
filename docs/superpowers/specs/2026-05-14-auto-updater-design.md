# Auto Updater 设计文档

**日期**: 2026-05-14
**状态**: 已批准，待实现

## 背景与目标

mdeditor 当前通过 GitHub Releases 发布 macOS `.dmg`，老用户每次升级都要去 release 页面手动下载、拖拽安装。从 codex (`~/git/codex`) 借鉴启动检测 + 升级提示的 UX，结合 Tauri v2 官方 `tauri-plugin-updater` 的签名校验和原地替换能力，给 mdeditor 加上**安静、可控、签名验证**的自动升级。

## 设计来源对照（codex → mdeditor）

codex 是 CLI/TUI，"升级"实际是 shell-out 调用 npm/brew 或下载 `install.sh` 管道到 sh，**不**自己下载校验二进制。这条路对已签名的 macOS Tauri app 不合适（Gatekeeper、签名链）。

本设计只**借鉴 codex 的 UX 模式**：

| codex 模式 | mdeditor 落地 |
|---|---|
| 启动后台异步 check_version | 启动后 1.5s 触发 background check |
| 20h 本地 cache（`~/.codex/version.json`） | 同样 20h，落 `appConfigDir/updater.json` |
| 三选项："立即更新 / 跳过 / 跳过此版本" | 改为顶部 banner 的弱提示（不打断写作） |
| 跳过的版本写本地 | `dismissed_version` 同样持久化 |
| 配置开关 `check_for_update_on_startup` | 设置面板里加 toggle |

**不**借鉴的部分：

- codex 的"shell-out 到包管理器"路径 → 用 Tauri updater 取代
- codex 的强制模态弹窗 → 改成顶部条
- codex 的多 channel（npm/brew/standalone）→ 单一 channel（GitHub Releases）

## 架构

```
启动 (1.5s 延迟)
  │
  ▼
UpdaterStore.init() ── 读本地 updater.json (last_checked_at, dismissed_version)
  │
  ├─ < 20h 内查过 → 用 cache 决定要不要显示顶部条
  │
  └─ ≥ 20h or 首次 → invoke @tauri-apps/plugin-updater check()
            │  GET https://github.com/wizlijun/MdEditor/
            │       releases/latest/download/latest.json
            │  ed25519 签名验证
            ▼
      Update { version, notes } | null
            │
            ▼
顶部 UpdateBanner ："v2.2.0 可用 [查看详情] [×]"
            │ 点 [×]
            ▼
      dismissed_version = 2.2.0  (本版本不再提示)
            │ 点 [查看详情]
            ▼
UpdateDialog (changelog + 立即更新按钮)
            │ 点"立即更新"
            ▼
update.downloadAndInstall(onProgress)
            │ 进度 0%→100%
            ▼
对话框换"重启完成更新"按钮 → @tauri-apps/plugin-process relaunch()
```

## 文件改动清单

### Rust (`src-tauri/`)

| 文件 | 改动 |
|---|---|
| `Cargo.toml` | 加 `tauri-plugin-updater = "2"`、`tauri-plugin-process = "2"` |
| `tauri.conf.json` | `plugins.updater` 块（endpoints、pubkey）；`bundle.createUpdaterArtifacts = true` |
| `src/lib.rs` | `.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_process::init())` |
| `capabilities/default.json` | 加 `updater:default`、`process:allow-restart` |

### 前端 (`src/`)

| 文件 | 改动 |
|---|---|
| `src/lib/updater.svelte.ts` | **新增** — 状态机 store（idle / checking / available / downloading / ready / error）；20h TTL；dismissed/last_checked_at 持久化 |
| `src/components/UpdateBanner.svelte` | **新增** — 顶部条 |
| `src/components/UpdateDialog.svelte` | **新增** — changelog + 进度 + 重启按钮 |
| `src/App.svelte`（或主 layout） | 挂载 UpdateBanner（全局） |
| `src/components/SettingsDialog.svelte` | 加 "检查更新" 按钮、当前版本显示、"启动时检查更新" toggle |
| `package.json` | 加 `@tauri-apps/plugin-updater`、`@tauri-apps/plugin-process` |

## 状态机

```
idle ──check()──> checking ──成功有新版──> available ──用户点更新──> downloading ──完成──> ready ──relaunch──> (终)
                              │                                          │
                              ├─无新版──> uptodate                       └─失败──> error
                              │
                              └─失败──> error
```

- `error` 状态在 banner 上**不显示**（静默失败），只在 Settings 的"检查更新"按钮显示明确报错
- `available` 状态读 `dismissed_version`：若 == 最新版，则 banner 隐藏但 Settings 仍可见

## 持久化

文件：`<appConfigDir>/updater.json`（macOS: `~/Library/Application Support/com.wizlijun.mdeditor/updater.json`）

```json
{
  "last_checked_at": "2026-05-14T12:34:56Z",
  "latest_version_seen": "2.2.0",
  "dismissed_version": "2.2.0",
  "check_on_startup": true
}
```

- `check_on_startup`: 默认 true，用户可在 Settings 关闭
- `last_checked_at`: 不管成功失败都更新（避免反复重试干扰）
- `dismissed_version`: 用户点 banner 的 `×` 时写入

## 触发规则

1. App 启动后 1500 ms 触发（不抢首屏渲染）
2. 若 `check_on_startup == false` → 跳过
3. 若 `now() - last_checked_at < 20h` → 跳过网络请求，但仍要根据 `latest_version_seen vs current vs dismissed_version` 决定显示 banner
4. 否则发请求；不管结果如何，更新 `last_checked_at`
5. Settings 里的"检查更新"按钮**无视 cache**，每次都强制查

## Release 流程改动 (`scripts/release.sh`)

**前提**：本项目所有 release 产物**固定**为单一 macOS universal `.dmg`，不再分 per-arch（见 memory）。

| 步骤 | 现状 | 改后 |
|---|---|---|
| Build target | 默认 native arch，可选 `--universal` | **始终**走 universal-apple-darwin 分支，去掉 `UNIVERSAL` 条件 |
| DMG 命名 | `MdEditor-{VERSION}-{universal\|aarch64\|x86_64}.dmg` | 固定 `MdEditor-{VERSION}-universal.dmg` |
| Updater 产物 | 无 | `tauri build` 在 `TAURI_SIGNING_PRIVATE_KEY` 已 export 时自动产出 `MdEditor.app.tar.gz` + `.sig` |
| latest.json | 无 | 脚本生成；`platforms.darwin-x86_64` 和 `platforms.darwin-aarch64` 两个 key 指向**同一个** universal 包（Tauri updater 协议要求按平台分 key） |
| 上传 | `gh release upload $TAG <dmg>` | 加上 `MdEditor.app.tar.gz`, `MdEditor.app.tar.gz.sig`, `latest.json` |

`latest.json` 样例：

```json
{
  "version": "2.2.0",
  "notes": "见 https://github.com/wizlijun/MdEditor/releases/tag/v2.2.0",
  "pub_date": "2026-05-14T00:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "signature": "<base64 from .sig>",
      "url": "https://github.com/wizlijun/MdEditor/releases/download/v2.2.0/MdEditor.app.tar.gz"
    },
    "darwin-aarch64": {
      "signature": "<同上>",
      "url": "<同上>"
    }
  }
}
```

## 密钥管理

- `pnpm tauri signer generate -w ~/.tauri/mdeditor.key`（一次性）
- 公钥（base64 字符串）→ `tauri.conf.json` 的 `plugins.updater.pubkey`
- 私钥放 macOS Keychain：`security add-generic-password -a "$(whoami)" -s "tauri-updater-mdeditor" -w "$(cat ~/.tauri/mdeditor.key)"`
- `release.sh` 在 build 前：`export TAURI_SIGNING_PRIVATE_KEY="$(security find-generic-password -s tauri-updater-mdeditor -w)"`
- 私钥**绝不入 repo**，`~/.tauri/mdeditor.key` 用完应删除（已在 Keychain 里）

## 错误处理

| 场景 | 行为 |
|---|---|
| 网络失败 / GitHub 503 | 静默；更新 `last_checked_at` 防止反复重试；Settings 里点"检查更新"才显示错误 |
| 签名校验失败 | Tauri updater 自动拒绝并报错；前端把 error 状态记入 store；只在 Settings 显示，banner 不出 |
| 下载中网络断 | UpdateDialog 显示重试按钮，已下载部分会被 Tauri 清理 |
| 重启失败 | 提示用户手动重启 |
| 用户在升级流程中关闭 App | 已下载产物被丢弃，下次启动重新走流程 |

## UI 细节

**顶部条 (`UpdateBanner.svelte`)**

```
┌────────────────────────────────────────────────────────────┐
│ ✨ MdEditor v2.2.0 可用              [查看详情]  [×]         │
└────────────────────────────────────────────────────────────┘
```

- 高度约 32px，浅色背景（不抢眼），右上角 `×` 点击触发 dismiss
- 仅当 `state == available && latest != dismissed` 显示
- 进入 `downloading` / `ready` 后顶部条样式切换为进度/重启状态

**详情对话框 (`UpdateDialog.svelte`)**

```
┌─ MdEditor v2.2.0 可用 ───────────────────┐
│                                          │
│ 当前版本：v2.1.0                          │
│                                          │
│ 更新内容：                                 │
│   <changelog from latest.json.notes>     │
│                                          │
│   [跳过此版本]  [稍后]  [立即更新]         │
└──────────────────────────────────────────┘
```

下载中：

```
┌─ 正在下载 v2.2.0 ────────────────────────┐
│ ████████████████░░░░░░  62%               │
│                       [取消]              │
└──────────────────────────────────────────┘
```

下载完成：

```
┌─ 准备就绪 ──────────────────────────────┐
│ v2.2.0 已下载，重启应用即可完成更新。       │
│                  [稍后重启]  [立即重启]    │
└──────────────────────────────────────────┘
```

**Settings 面板加入项**

- 显示当前版本号（只读）
- "启动时检查更新" toggle（绑定 `check_on_startup`）
- "立即检查更新" 按钮（无视 20h cache）
- 上次检查时间（小字灰色）

## 测试

| 类型 | 覆盖 |
|---|---|
| 单元 | `updater.svelte.ts` 状态转换；20h cache 判断；dismissed 与 current/latest 的比较逻辑 |
| 集成 | 手动跑端到端：build 一个带 updater 的 v2.2.0-rc → 安装 → 改版本到 v2.2.0 build → run rc 验证看到 banner → 点更新 → 验证替换 + 重启 → 验证新版本号 |
| 边界 | 老用户首次升级（2.1.0 没有 updater）必须手动装 2.2.0；README 写明 |

## 部署里程碑 / 用户需要额外做的事

| # | 事项 | 时机 |
|---|---|---|
| 1 | `pnpm tauri signer generate` 生成密钥对；私钥进 Keychain | 实现前一次性 |
| 2 | 公钥贴进 `tauri.conf.json` | 实现期间 |
| 3 | `release.sh` 改造同时引入 universal-only 硬编码 | 实现期间 |
| 4 | **第一次带 updater 的 release（v2.2.0）发布后**，要在 README / 网站说明：v2.1.x 老用户需要手动下载安装一次 | v2.2.0 发布时 |
| 5 | **打开 Apple 公证**：`.app.tar.gz` 内容必须公证，否则替换后 Gatekeeper 仍拦。release.sh 已留 `APPLE_ID` / `APPLE_PASSWORD` 钩子，必须配齐 | v2.2.0 发布前 |
| 6 | 端到端测试通跑一次 | 合并前 |

## 不在范围内

- 灰度发布 / channel（stable/beta）
- Windows / Linux 升级路径（mdeditor 目前只发 macOS）
- Sidecar (md2pdf, mdshare) 独立升级 —— 它们打在 .app 里随主 app 升级，无需单独动作
- 强制升级（critical security update 强制安装而不能 dismiss）
- 升级前自动备份用户配置

## 风险

| 风险 | 缓解 |
|---|---|
| 私钥泄漏 | Keychain + 不入 repo；若泄漏，需出一个换 pubkey 的 release，老客户手动下载 |
| GitHub Releases CDN 缓存延迟（几分钟） | 用户最多晚几分钟看到 banner，可接受 |
| Tauri updater 在替换 .app 时遇到 in-use 资源 | Tauri 已处理；测试覆盖此场景 |
| 用户禁用网络后 banner 永不消失 | check_on_startup toggle + dismissed_version 持久化已覆盖 |
