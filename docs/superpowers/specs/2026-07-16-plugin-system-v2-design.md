# 插件体系 v2 设计（Plugin System v2）

- 日期：2026-07-16
- 状态：设计已获批准（运行时选型、UI 机制、分节设计均经用户确认）
- 前置分析：`docs/2026-07-16-sidex-plugin-spec-and-notemd-improvements.md`（sidex 规范全量整理 + 现状盘点，所有论断附源码出处）

## 0. 判定与范围（用户已定，不再讨论）

### 0.1 归属判定

| 归属 | 成员 | 含义 |
|---|---|---|
| **核心特性**（6） | sotvault、outline-notes、folder-view、share、git-history、reading-insights | 不再以插件形态存在：删 manifest、退出插件设置页、不可停用；菜单/i18n/入口全部内化为 core |
| **市场插件**（5，首批） | md2pdf、roam-import、openclaw-chat、exlibris、base | 独立插件包，经插件市场下载安装/更新，完全参考 sidex 的规范、加载机制、生命周期 |

### 0.2 已确认的关键决策

1. **生态定位**：官方插件为主，规范预留第三方（签名/manifest 按开放设计；WASM 沙箱等重投入延后）。
2. **exlibris 形态**：改造为 note.md 内的窗口插件（前端资产随插件包、后端逻辑进插件进程；独立 app 停止发布）。
3. **分发渠道**：notemd.net 体系下的 CF Worker 注册表（索引 + 下载 + 匿名统计）。
4. **base 节奏**：首批就上，"tab 内嵌自定义编辑器"机制一步到位。
5. **运行时选型**：方案 B——单 kind「原生长驻进程」，移植 sidex 的规范语义（否决 Node kind：用户机器无 Node；否决现阶段 WASM kind：md2pdf 依赖 WKWebView/PDFKit、openclaw-chat 依赖 UDS，首批插件零个能落 WASM，来源见前置分析）。
6. **自定义编辑器载体**：iframe + `plugin://` 自定义协议（不依赖 Tauri 多 webview unstable 特性）。
7. **版本号规则不变**：沿用日期版本号规则（(年-2020).(月×100+日).(当日第几次)），不引入营销版本号。

---

## 1. 术语与插件包格式

- **插件包**：`<id>-<version>-<arch>.notemdpkg`，即 tar.gz，附**分离式 minisign（ed25519）签名**文件。
- 包内布局：

```
manifest.json          # v2 规范（必需）
bin/<binary>           # 后端二进制（可选；按 arch 分包，包内不再区分架构目录）
ui/...                 # 前端资产（可选；独立 Vite 构建产物，纯静态）
icon.png               # 市场展示（可选）
CHANGELOG.md           # 市场展示（可选）
```

- 双架构各出一个包（沿用 per-arch 发布约定）；纯 UI/无二进制插件可出单一 `universal` 包。

## 2. Manifest v2 规范

```jsonc
{
  "manifest_version": 2,                     // 必需，固定 2；缺失或为 1 视为旧格式拒载
  "id": "notemd.md2pdf",                     // 必需，publisher.name 全限定 id，[a-z0-9-]+\.[a-z0-9-]+
  "name": "Export to PDF",                   // 必需，英文基线显示名
  "version": "1.0.0",                        // 必需，semver
  "kind": "native",                          // 必需；本期仅实现 "native"，保留 "wasm" 字面量
  "engines": { "notemd": ">=6.716.7" },      // 必需，最低宿主版本（semver range），不满足拒载
  "description": "...",                      // 可选
  "binary": {                                // 有后端时必需；键为 target triple。
    "aarch64-apple-darwin": "bin/md2pdf",    // per-arch 包只需含自己架构的键；
    "x86_64-apple-darwin": "bin/md2pdf"      // 宿主按运行架构取键，缺失即拒载
  },
  "ui": "ui/",                               // 有前端资产时必需，包内相对目录
  "activation": {
    "events": ["onCommand:export", "onCli:pdf"]   // 必需（可为 ["*"]）
  },
  "contributes": {                           // 全部可选；宿主代码不得出现插件 id 字面量
    "menus": [...],                          // 语义同 v1 MenuEntry（location/submenu/label/shortcut/command/enabled_when/prompt）
    "context_menus": [...],                  // 语义同 v1 ContextMenuEntry
    "windows": [{
      "id": "main", "entry": "index.html", "title": "…",
      "width": 900, "height": 640, "min_width": 640, "min_height": 480,
      "singleton": true
    }],
    "custom_editors": [{
      "id": "base-table", "file_extensions": [".base"],
      "entry": "editor.html", "display_name": "Base Table"
    }],
    "settings": { "tab_label": "…", "schema": [...] },   // 语义同 v1 SettingsField
    "cli": [...]                             // 语义同 v1 CliEntry
  },
  "capabilities": ["vault.read", "toast"],   // 必需（可为空数组），见 §5
  "request_timeout_seconds": 30,             // 可选，单次 JSON-RPC 请求超时，默认 30，上限 300
  "idle_shutdown_seconds": 120,              // 可选；设置后空闲此秒数自动 deactivate；缺省=不自动关停
  "i18n": { "zh": { ... }, "ja": { ... } }   // 可选，语义同 v1 PluginI18n，扩展 windows/custom_editors 标题键
}
```

校验规则：JSON Schema 单源（见 §6），安装时与加载时双重校验；校验失败拒载并在市场窗口给出错误详情。

## 3. 安装布局、签名与完整性

```
<app_data>/plugins/
  state.json                      # 已装清单：{ "<id>": { "version": "1.1.0", "enabled": true } }
  notemd.md2pdf/
    1.0.0/                        # 按版本落盘（manifest.json、bin/、ui/ 原样解压）
    1.1.0/
    current -> 1.1.0              # symlink 原子切换；保留上一版本目录用于回滚
```

- `state.json` 是插件启停与版本的**唯一事实源**；`settings.json` 的 `plugins.enabled.*` 在迁移完成后退役。
- 安装流程：下载 → **sha256 校验**（对照市场索引）→ **minisign 验签**（公钥内置 app，失败硬拒）→ 解压到版本目录 → 切 `current` → 写 `state.json`。
- 升级：同流程装新版本目录 → 若插件 Active 先 `$deactivate` → 切 symlink → 按需重新激活。失败回滚 = 切回旧 symlink。
- 卸载：deactivate → 删插件目录 → 更新 `state.json`（`plugin_data/<id>/` 用户数据保留，卸载对话框提供"同时删除数据"勾选）。

## 4. 运行时与生命周期（sidex 语义移植）

### 4.1 进程模型

每个 **enabled 且被激活** 的插件 = 一个长驻子进程（比 sidex 共享 host 更强的隔离：单插件崩溃不波及他人）。通信：**NDJSON JSON-RPC 2.0 over stdio**（sidex Node host 协议）。插件 stdout 保留给协议；stderr 由宿主捕获落 `<app_log>/plugins/<id>.log`（滚动，上限 5MB）。

### 4.2 状态机

```
Installed → Enabled(Inactive) ─激活事件命中→ Activating → Active
Active ─$deactivate(5s 优雅关停，超时 kill)→ Inactive
Active ─进程异常退出→ Crashed(n) ─n<3(10 分钟窗口)→ 自动重启(退避 0s/5s/30s)
Crashed(3) → Disabled(crash-loop) + 市场窗口徽标提示
```

- 激活串行化：同一插件的激活请求排队（对齐 sidex 的激活队列）。
- 内存监控：RSS 超 512MiB 记警告日志 + 市场窗口徽标；不强杀（对齐 sidex 阈值语义，去掉它的 1GiB critical——先观察）。
- **启停即时生效**：enable → 重收集 contributes（菜单/设置/CLI/编辑器关联）；disable → deactivate + 摘除 contributes。不再要求重启。

### 4.3 激活事件

| 事件 | 触发 |
|---|---|
| `*` | 宿主启动完成即激活（慎用） |
| `onStartupFinished` | 主窗口就绪后激活（openclaw-chat 类常驻服务） |
| `onCommand:<command>` | 对应菜单/右键项首次触发 |
| `onCli:<subcommand>` | 对应 CLI 子命令调用 |
| `onFileType:<ext>` | 打开关联扩展名文件（base） |

### 4.4 握手与方法面

握手：宿主 spawn 进程 → `$initialize { protocol_version: 2, host_version, locale, theme, plugin_root, data_dir }` → 插件回 `{ ok: true }` →（按需）`$activate { event }`。`protocol_version` 不匹配 → 拒载并提示升级。

宿主 → 插件：

| 方法 | 说明 |
|---|---|
| `$initialize` / `$activate` / `$deactivate` | 生命周期 |
| `command.execute { command, context }` | 菜单/右键/CLI 触发；context 含 v1 的 tab 快照、output_path、CLI args/flags |
| `ui.message { surface_id, payload }` | 来自插件 UI（窗口/编辑器 iframe）的桥消息 |
| `custom_editor.open { editor_id, uri, content }` / `custom_editor.will_save { uri }` / `custom_editor.closed { uri }` | 自定义编辑器文档生命周期（文档 I/O 宿主所有，见 §7.3） |
| `editor.event { type, payload }` | 已订阅的宿主事件推送（文档打开/保存等） |

插件 → 宿主：`host.*` 方法组，见 §5。

## 5. 宿主 API 与 capability 执法

方法组按 manifest `capabilities` 授权分发；未授权方法返回 JSON-RPC error `-32001 capability_denied`。

| 方法组 | capability | 说明 |
|---|---|---|
| `host.log.info/warn/error` | 免授权 | 落插件日志 |
| `host.toast` | `toast` | 语义同 v1 action |
| `host.dialog.confirm/message/open/save` | `dialog` | 新增 open/save 文件对话框（roam-import 选文件用） |
| `host.clipboard.write` | `clipboard.write` | |
| `host.settings.get/set` | `settings` | 只见 `<id>.*` scope（自己的 scope 天然可写，取代 v1 的 `settings.write:<scope>` 细分） |
| `host.storage.get/set/delete/list` | `storage` | `<app_data>/plugin_data/<id>/` 下的 KV 与文件（对齐 sidex per-extension storage 一等 API） |
| `host.secrets.get/set/delete` | `secrets` | macOS Keychain，service 名含插件 id |
| `host.vault.read/write/list/stat` | `vault.read` / `vault.write` | 路径规范化后限定 vault 根内，越界返回 error；这是 roam-import/exlibris/base 的主通道 |
| `host.renderer.html { path? }` | `renderer.html` | 宿主按当前主题渲染 tab/文件为 HTML（md2pdf 用；v1 的推模式改为拉模式） |
| `host.editor.events.subscribe { types }` | `editor.events` | 订阅后经 `editor.event` 推送 |
| `host.window.open/close/focus { window_id }` | 免授权（限自身 contributes.windows）（②b/未来：host_api 尚未实现该方法组） | |
| `host.ui.post { surface_id, payload }` | `ui`（限自身 surface；与 §20 一致——实现要求 `ui` capability，未授权返回 `-32001`） | 向自己的窗口/编辑器 iframe 推消息 |

**边界的严谨声明**：native kind 下，capability 对**宿主中转的 API 强执法**；但插件进程自身直连 fs/net 无法被宿主拦截。本期信任模型 = 签名保证来源（仅官方签名可安装）+ capability 约束宿主面。真沙箱（wasm kind 或 OS 级）是第三方开放时的前置项，本期明确不做、不假装有。

契约单源：`protocol/` 目录，TS 类型定义为源 → 生成 JSON Schema → CI 校验（① 所有官方插件 manifest 过 schema；② Rust 端 serde 结构与 schema 往返一致）。SDK 类型从同一源生成。

## 6. SDK

`notemd-plugin-sdk`（Rust crate，workspace 内，随规范同版本发布）：

- stdio NDJSON JSON-RPC 循环（tokio）、`$initialize/$activate/$deactivate` 脚手架；
- `trait NotemdPlugin { fn activate(...); fn deactivate(); fn execute_command(...); fn on_ui_message(...); ... }` + 导出宏（对位 sidex-extension-sdk 的 `SidexExtension` trait + `export_extension!`）；
- `host` 客户端模块：全部 `host.*` 方法的类型化封装；
- 协议类型（从 `protocol/` 生成）。

前端侧提供 `@notemd/plugin-ui`（npm workspace 包）：`window.notemd` 桥的类型声明 + 请求/事件封装 + 主题/locale 工具。

## 7. 插件 UI 机制

### 7.1 `plugin://` 协议与桥

- 宿主注册自定义协议 `plugin://<id>/<path>`，从 `<install>/current/ui/` serve 静态资产；目录穿越防护（规范化后必须落在 ui/ 内）。
- 插件 webview **不注入 Tauri API**。宿主用 initialization script 注入受限桥：

```ts
window.notemd = {
  locale, theme,                                  // $initialize 同款上下文
  request(method, params): Promise<any>,          // 白名单方法，经宿主转发插件后端或宿主自身
  postMessage(payload): void,                     // → 插件后端 ui.message
  onMessage(cb), onThemeChange(cb)
}
```

- 桥的底层是一个 Tauri command（`plugin_bridge`），按窗口 label ↔ 插件 id 绑定鉴权：A 插件的 webview 无法冒充 B。
- CSP：`default-src 'self' plugin://<id>`；禁远程脚本/样式（供应链净化）。UI 需要网络时走后端进程，不在 webview 里直连。
- 插件窗口必须自声明 `color-scheme: light dark`（既有独立窗口深浅色约定），SDK 模板内置。

### 7.2 窗口插件（roam-import / openclaw-chat / exlibris）

- 宿主按 `contributes.windows` 开窗：label 固定为 `plugin-<id>-<window_id>`，Tauri capabilities 用 `plugin-*` glob 只授予 `plugin_bridge` 一个命令（沿用"独立窗口必须进 capabilities allowlist"的教训，用 glob 一次解决）。
- `singleton: true` 时重复打开 = focus 已有窗口。
- 窗口生命周期与插件进程解耦：关窗不 deactivate（除非 idle_shutdown 到期）；deactivate 时宿主关闭该插件所有窗口。

### 7.3 自定义编辑器（base）

- `TabKind` 的 `'base'` 泛化为 `'custom'`；扩展名 → 编辑器的关联表由已装插件的 `contributes.custom_editors` 在运行时构建。
- tab 内容区渲染 iframe → `plugin://<id>/editor.html`，postMessage 桥（与 7.1 同一 API 面）。
- **文档 I/O 宿主所有**（file-over-app + 统一保存管线）：宿主读文件 → `custom_editor.open` 交给插件/iframe；编辑产生的内容变更经桥回传宿主（宿主管 dirty 标记、Cmd+S、保存对话框、autosave 语义）；插件后端只做领域逻辑（base 的目录元数据扫描走 `host.vault.*`）。
- **降级路径**：未安装/已禁用对应插件时，关联文件以纯文本 tab 打开 + 顶部提示条（"安装 Base 插件以表格视图打开"→ 市场入口）。数据永远可读，符合 file-over-app。

## 8. 插件市场

### 8.1 服务端（CF Worker）

- Worker：`notemd-plugins`，路由 `plugins.notemd.net`（实施时可并入 notemd-site 路由，域名非契约）。
- API：
  - `GET /api/index.json` — 全量索引，CDN 缓存 5 分钟；
  - `GET /api/download/<id>/<version>/<arch>` — 302 → R2 制品（`.notemdpkg` + `.minisig`）；
  - `POST /api/stats/install { id, version }` — 匿名计数，fire-and-forget，客户端失败静默。
- 索引条目 schema：`{ id, version, min_host, archs: [...], size, sha256: {arch: hex}, name, description, i18n: {locale: {name, description}}, icon_url, changelog_url, published_at }`。
- 索引由发布脚本生成并写 KV；无数据库。制品存 R2 bucket（国内可达性优于 GitHub 直连）。

### 8.2 客户端

- **「插件市场」独立核心窗口**（非插件）：浏览/搜索 → 详情（描述/版本/changelog/所需 capability 展示）→ 安装/更新/卸载/启停；已装插件的设置入口也在此。
- 现有 PluginsSettingsTab 退役；设置页只留一个"插件市场…"入口。
- 更新检查：启动后台拉 index，**默认开、设置页有开关**（consent 原则）；有更新在市场入口出徽标，不自动安装。
- CLI：`notemd plugin list | install <id> | update [<id>] | remove <id> | enable <id> | disable <id>`（注意 CLI 前端 store 未加载的既有坑，插件安装态一律读 `state.json` 不读前端 store）。

### 8.3 发布链

`scripts/release-plugin.sh <plugin> [version]`：构建双架构二进制 + `pnpm build` UI 资产 → 打包 tar.gz → minisign 签名 → sha256 → 上传 R2 → 更新 KV 索引。私钥仅发布机持有；版本号沿用日期规则或插件自身 semver（**插件包用独立 semver**，与宿主日期版本号解耦——engines 字段负责关联）。

## 9. 六插件 core 化（子项目⓪，可先行）

| 插件 | 动作 |
|---|---|
| sotvault | 删 manifest；File 菜单项 + i18n 迁 core（`en.ts` 系扁平键）；`syncCurrentToVault` 路由改 core 菜单直连 |
| outline-notes / folder-view / git-history | 删 manifest；View 菜单项迁 core；`registerBuiltinSideViews` 改为 core 侧栏的正式注册（不再是"插件的硬编码"，而是 core 的正当代码）；视图开关状态存储不变 |
| share | 删 manifest + 删 bin；**桌面/CLI 切换到 `src/lib/share` 既有 TS 实现（与 iOS 同源），mdshare crate、二进制与 build:mdshare 发布步骤整体退役**（实施勘查修订，优于原"编译进 src-tauri"方案：消除 Rust/TS 双实现）；菜单/右键/设置页/CLI `share` 全部内化，CLI 保留旧 `ok/data` JSON 信封与 exit-4 失败契约；`share_db.json` 与 vault-homing 前置保持现状（已是 core 语义） |
| reading-insights | 删 manifest；insights 窗口转正为 core 窗口；CLI `report` 内化；`available_when: vaultConfigured` 语义移入 core 菜单判定 |

统一动作：这 6 个退出 `plugins.enabled` 判定与插件设置页；`get_all_plugin_manifests` 等接口不再返回它们；用户不可停用（菜单项的 enabled_when 继续按上下文置灰）。

## 10. 五插件迁移（子项目④，按序验证机制）

| 序 | 插件 | 迁移要点 | 验证的机制层 |
|---|---|---|---|
| 1 | md2pdf | 二进制包 SDK JSON-RPC 层；`renderer.html` 改拉模式；`idle_shutdown_seconds: 120`；菜单/prompt/CLI 语义不变 | 运行时 + CLI + 懒激活 |
| 2 | roam-import | 导入逻辑从 src-tauri 抽出进插件二进制（vault 写走 `host.vault.*`）；向导 UI（roam-import-app.svelte）迁插件 `ui/` 独立构建；删 `show_roam_import_window` | 窗口 UI + 桥 + dialog.open |
| 3 | openclaw-chat | chat UI 迁 `ui/`；UDS 服务与 mdrelay 客户端从 src-tauri 抽出进插件进程；激活 `onStartupFinished`（启用时常驻）；删 `show_chat_window` | 常驻服务 + 崩溃恢复 |
| 4 | base | `src/lib/base` 表格 UI 迁 `ui/editor.html`；元数据扫描进插件后端；`TabKind 'base'` → `'custom'` 泛化；File▸New Base 来自 contributes | 自定义编辑器全链路 |
| 5 | exlibris | Svelte 前端迁 `ui/`（复用其 src）；src-tauri 逻辑（导入管线/calibre/规则/verify）迁插件二进制；托盘 "Open Books" 改为激活插件窗口；**独立 app 停止发布，exlibris-v tag 线冻结**，其 updater 废弃 | 大型插件综合验收 |

**全部迁完后的退役清单**：v1 one-shot 协议（`plugin_host.rs` 的 `run_plugin_binary`/`invoke_plugin` 路径）、App.svelte 全部插件 id 分支与 share 前置特例（share 已 core 化）、三个硬编码窗口函数、`src-tauri/plugins/` bundle 目录与打包 glob、`settings.json` 的 `plugins.enabled`。验收标准：宿主代码 grep 不到任何市场插件的 id 字面量。

## 11. 老用户迁移

- 升级后首启：读旧 `plugins.enabled` + builtin default，若用户原来启用着首批插件中的任何一个 → 一次性迁移向导："以下功能已移至插件市场"，列表 + 一键批量安装（显式确认后才联网下载）。
- 跳过向导的兜底：`.base` 文件打开为文本 + 安装提示条；`notemd pdf` 未装插件时输出 `plugin not installed; run: notemd plugin install notemd.md2pdf`。
- exlibris 老用户：独立 app 内不再收到更新；note.md 托盘入口在未装插件时弹安装引导。

## 12. 错误处理汇总

| 场景 | 行为 |
|---|---|
| 验签/sha256 失败 | 硬拒安装，市场窗口报错并保留日志 |
| manifest schema 校验失败 / engines 不满足 / protocol_version 不匹配 | 拒载；市场详情页显示原因（含"请升级 note.md"） |
| 激活失败（`$activate` 返回 error 或握手超时 10s） | 状态回 Inactive，toast + 日志 |
| 单请求超时（`request_timeout_seconds`） | 该请求返回 error；不杀进程（区别于 v1 的整进程超时） |
| 进程崩溃 | §4.2 熔断；crash-loop 后市场徽标 + 详情页显示 stderr 尾部 |
| 下载中断 | 整包重试（包均为 MB 级，不做断点续传） |
| 升级切换失败 | symlink 回滚旧版本，市场报错 |

## 13. 测试策略

- **契约测试**：`protocol/` schema 双端往返（TS ↔ Rust serde）；fixture 插件（tests/fixtures 内最小 SDK 插件）跑握手/激活/超时/崩溃重启/capability 拒绝全用例。
- **市场**：Worker vitest（index/download/stats）；安装器单测（验签失败/回滚路径用 tempdir）。
- **迁移回归**：每个插件迁移后跑其现有功能清单；GUI 部分按惯例出手动测试步骤由用户实机验证（dev 构建先行，涉及窗口/布局改动不直接发）。
- CI 门：check + test + schema 校验 + fixture 集成测试。

## 14. 分期交付

| 期 | 内容 | 发布 |
|---|---|---|
| ⓪ | 六插件 core 化 | 随常规版本先行发布（日期版本号照常） |
| ① | 运行时 v2 + protocol/ + SDK + md2pdf 迁移 | 内部 flag，不对外 |
| ② | UI 机制（plugin:// + 桥 + 窗口）+ roam-import + openclaw-chat | 内部 |
| ③ | 市场 Worker + 市场窗口 + 安装/升级/CLI + 签名发布链 | 内部 |
| ④ | 自定义编辑器 + base + exlibris + 迁移向导 + v1 机制退役 | **聚合为一次大版本对外发布**，版本号按当日日期规则推导 |

## 15. 明确不做（本期）

- Node.js 扩展 kind、WASM kind 实现（manifest 仅保留 `kind` 字面量）、Open VSX/VSIX 兼容、第三方提交审核流程、真沙箱、增量/差分更新、Windows/Linux 插件包（跟随宿主平台策略）。

## 16. 风险清单

1. **exlibris 改造体量**（整 app 迁形态）——排在最后、且有前四个插件磨平机制后进行；其独立 app 可作为回退方案多保留一个发布周期。
2. **iframe 编辑器的体验风险**（焦点/快捷键/滚动与 tab 系统的协同）——base 迁移前先用 fixture 编辑器做穿刺验证。
3. **旧 one-shot 与新运行时并存期**——①〜③ 期间 md2pdf 新旧双轨只跑新轨（内部 flag），避免双协议长期共存。
4. **CLI 与前端 store 的既有坑**——所有插件安装态判断走 `state.json`（Rust 侧），不依赖前端 store 初始化。

## 17. 实施记录（子项目①，2026-07-17）

子项目①（运行时 v2 + protocol + SDK + md2pdf 迁移）已在分支 worktree-core-ize-six-plugins 实现（603f362..baf3e7e），内部 flag：settings.json `"plugins_v2.enabled": true` 或 `NOTEMD_PLUGINS_V2=1`。

**计划内偏离（原因在计划文档头部）：**
1. §5 `host.renderer.html` 拉模式推迟：①期沿用执行时推模式（前端 `plugin_v2_execute` 的 context 注入 `rendered_html`，与 v1 一致）。拉模式待有会话中重渲染需求的消费者再建（需 Rust→webview 渲染 RPC）。
2. §5 契约单源调整为 `plugin-protocol` Rust crate（schemars → JSON Schema → 生成 TS），非"TS 为源"；§2 的 Schema 单源校验语义不变，CI 由 `pnpm check:protocol` 把关漂移。
3. §4.2 内存监控（512MiB 告警）推迟到子项目③（徽标需市场窗口承载）。

**实现中确立的事实：**
- **md2pdf 派生渲染模式**：WKWebView/PDFKit 管线要求 macOS 主线程 + `NSApplication.run()` 生命周期，长驻进程内反复 run/stop 不可靠。v2 服务二进制（`md2pdf-v2`，SDK 协议循环）对每次导出派生包内兄弟 v1 二进制完成渲染——一次一进程、路径与 v1 逐字节相同（先例：sidex 的 rust-language-extension 包裹 rust-analyzer）。
- **协议细节**：notification 序列化为 `"id": null`（非严格省略 id 成员）——两端都用 plugin-protocol crate，自洽；第三方接严格 JSON-RPC 库时需注意（②期 SDK 文档标注）。
- **SDK 限制**：trait 方法同步且运行在读循环任务上，插件在 `execute_command` 内阻塞等待 `Host::request` 会死锁响应路由——①期 host.* 均为通知型无消费者；给 `Host::request` 加消费者的期次必须先解此约束（读循环与执行解耦）。
- **CLI**：v2 manifest 经 adapter 合流进 router/runner 扫描（flag 门控）；headless Tauri 注册 `plugin_v2_execute` 并在 setup 跑 `plugin_runtime::init`。v2 安装根 = `dirs::data_dir()/net.notemd.app/plugins`（与 Tauri app_data_dir 等价，有测试钉住）。
- **内测期命名**：v2 md2pdf 菜单标 "Export to PDF (v2)…"、CLI 子命令 `pdf2`，与 v1 并存不打架；**④期正式切换待办**：改回 `Export to PDF…`/`pdf`、补 manifest i18n、删除 v1 bundled md2pdf 与 one-shot 机制。
- 运行时测试基建：shell fixture（tests/fixtures/v2/）+ 10 个集成用例覆盖握手/超时/崩溃熔断/空闲关停/capability 拒绝/真实 make_sink 链路。
- **①期启停边界**：v2 插件不出现在设置页插件列表（get_all_plugin_manifests 未合流）与 notemd plugin list/enable/disable/info、notemd help；启停唯一入口是 state.json + 重启；③期市场窗口接管。
- **settings 通道递延**：adapter 透传 contributes.settings 会让设置页渲染 v2 设置 tab，但①期无 host.settings 通道、执行上下文不带 settings——v2 插件声明 settings 属②期功能；md2pdf v2 未声明。
- **onCli/onFileType 触发器①期不生成**（plugin_v2_execute 一律 Trigger::Command；激活匹配仅 startup 生效）——④期使激活事件 load-bearing 时补齐。

## 18. 实施记录（子项目②）

子项目②（插件 UI 机制 + roam-import 迁移）已实现在分支 worktree-core-ize-six-plugins，全程 v2 flag 门控。

**相对 spec §7 的设计偏离（已实现方案更强）：**
- **桥 = plugin:// 上的 fetch-RPC，而非 §7.1 的"受限桥 + plugin_bridge command"**：plugin 窗口**不加入任何 capability**（Tauri IPC 全拒，比"注入受限 API"隔离更彻底）。UI→宿主调用走 `POST plugin://<id>/__rpc__`，**以请求 Origin 认证插件身份**，按该插件 manifest capabilities 执法——与插件进程共用同一张方法-能力表（host_api::method_capability）。宿主→UI 推送用 `WebviewWindow::eval("window.__notemd_dispatch(...)")`。桥 API：`window.notemd = { pluginId, locale, theme, request(method,params), onMessage(cb) }`，由 `windows::bridge_script` 经 initialization_script 注入。
- **窗口注册用 `register_asynchronous_uri_scheme_protocol` + 每请求独立线程**：WKWebView 在主线程投递自定义 scheme 请求，主线程上 `block_on(dialog)` 会冻结 run loop 并与需要主线程的原生 dialog 死锁；handler 从 spawned 线程跑，`block_on(ui_rpc::dispatch)` off-main-thread 安全。
- **窗口 label = `plugin-<id 点转横>-<window_id>`，不进 capabilities**（原 §7.2 设想 plugin-* glob 授 bridge 命令——桥不再是 Tauri 命令，无此需要）。

**机制新增：**
- **binary 可选**（ui-only 插件）：manifest v2 的 `binary` 与 `ui` 至少其一；discovery 对无 binary 插件跳过架构二进制检查（②T5 修了 ②T1 漏改 discovery 的 bug）。
- **窗口贡献类型化**：`Contributes.windows: Vec<WindowContribution>`（id/entry/title/尺寸/singleton/open_command）。
- **open_command 路由**：菜单命令命中某窗口的 open_command → adapter 编成 `open_windows: {command→window_id}` 透传前端 → 前端调 `plugin_v2_open_window` 而非 execute。
- **host 方法（UI 与进程共用能力门）**：dialog.open/save、vault.info/read/write/exists/list/mkdir、fs.read_text/read_bytes（仅 dialog 返回过的路径可读，按插件精确授权）、clipboard.write、toast、log.*。

**openclaw-chat 拆分为子项目②b**：其 1.26k 行 Rust 异步状态机（UDS + mdrelay + 配对轮询 + 设备持久化，绑定 app 生命周期）体量远超 roam-import，需独立进程化迁移 + 桥新增网络/长连方法，另立计划。②只交付 UI 机制 + roam-import。

**④期退役清单追加**（v1 roam-import）：`src/roam-import-app.svelte`、`src/lib/roam-import/`、`src/roam-import-main.ts`、`roam-import.html`、`show_roam_import_window`(lib.rs)、App.svelte 的 `pluginId==='roam-import'` 分支、vite.config.ts 的 roamImport 入口、capabilities windows 的 "roam-import"、host i18n 的 16 个 roamImport.* 键、`src-tauri/plugins/roam-import/` v1 manifest。

- **桥安全边界（②已实现）**：plugin:// 资产穿越防护(decode→component ..校验→canonicalize→component-wise 包含)、Origin 服务端认证 RPC、能力 deny-by-default 全方法覆盖、vault 路径 canonicalize 包含校验、fs.read:dialog 按插件+精确路径授权、读写各 10MB 上限、CSP(default/script/style/img/connect + object/base/form/frame 全锁)、grant 随窗口关闭清理。flag off 时 handler 全 404。
- **开放第三方前必做（②未做，非内部flag阻塞）**：① 安装/启用期能力消费同意 UI + 校验 capability 串白名单（③市场窗口承载）；② RPC 加 per-window nonce 防御纵深（多窗口/非 macOS webview 前）；③ vault.write 频率/磁盘配额与每请求线程数上限。
- **roam-import .zip 支持经 host.fs.read_bytes(base64+fflate) 恢复**，与 v1 一致（④期退役 v1 无功能回退）。

## 19. 实施记录（子项目③）

- **安装安全（③已实现）**：.notemdpkg=zip；下载 sha256 + minisign 验签（写盘前，硬编码 PLUGIN_REGISTRY_PUBKEY），GUI/CLI 同管线同公钥、无 --force 跳过；zip-slip 双重防护（enclosed_name+containment）；解压总量上限 200MiB 防压缩炸弹；consent 展示的能力 = 已装签名 manifest 的 capabilities = 运行时 host_api 执法源（三者同一）。
- **无重启**：install/uninstall/set_enabled → reconcile(重扫 STATE + deactivate 移除项) + 原生菜单重建；新插件菜单项/命令/窗口即时可用。
- **注册表**：CF Worker notemd-plugins（KV index + R2 pkgs），index.json 未签名但包已签名——恶意 index 至多 DoS 或在我方已签制品间替换/降级，无法装入未签名代码。
- **用户步骤（发布前必做）**：① minisign 生成生产签名密钥对（私钥离线保管）→ 替换 market.rs 的 PLUGIN_REGISTRY_PUBKEY（当前是测试公钥）；② 建 CF KV namespace + R2 bucket notemd-plugins + plugins.notemd.net 自定义域 + repo secret CLOUDFLARE_API_TOKEN；③ 首次 wrangler deploy；④ 发布用 release-plugins.sh + gen-plugin-index.mjs + wrangler r2/kv 上传。
- **开放第三方前必做（③未做）**：下载降级保护（签名 index 或版本下限）；commit 时断言已装能力==preview 能力；②评审遗留的 per-window nonce / vault.write 配额；symlink zip 条目已加测试。

## 20. 实施记录（子项目②b：openclaw 迁移）

子项目②b（openclaw-chat 迁移 + 双向流式窗口通道）已实现在分支 worktree-core-ize-six-plugins，flag 门控；v1 openclaw 保留至④退役。

**新增机制——双向插件窗口通道：**
- **UI→插件进程（ui.request）**：插件窗口 UI 调 `notemd.request('plugin.<name>', params)` → ui_rpc 判定非 `host.*` 方法 → 转发给该插件进程的 `ui.request{method,params}` 入站方法（SDK `NotemdPlugin::on_ui_request`）→ 回传结果。`plugin.` 前缀被 host 剥除,插件见干净方法名。转发类方法**不走 host capability 门**(是插件自身 API,由 Origin=该插件窗口认证);仅 `host.*` 走能力门。
- **插件进程→UI（host.ui.post）**：插件调 `Host::ui_post(window_id, payload)` → `host.ui.post` 通知(capability `ui`,仅进程侧 make_sink)→ host `push_to_window` eval 推送。可从 spawned reader task 调用(Host 是 Clone,ui_post 走克隆的 mpsc sender)——这是流式的关键。
- 机制经 streaming fixture(shell)端到端验证:ui.request echo/ping 往返 + $activate 后 ≥3 条 host.ui.post seq 有序推达。

**openclaw 迁移：**
- 后端 1.26k 行(UDS/relay/relay_bridge/protocol/pair/config/devices)整体移进插件 crate `plugins-src/openclaw/backend`(binary `notemd-openclaw`,SDK 驱动),native 二进制**全 fs/net 权限直连**(tokio-tungstenite/reqwest/qrcode 等移进 crate,不经 host 中转);事件 `app.emit("openclaw://…")` → `host.ui_post("main",{kind,data})`;11 命令 → `on_ui_request` 分派;async 体经 block_in_place+Handle::block_on,connect 只 spawn reader 不阻塞读循环(多线程 runtime)。
- **config/devices 存 `<data_dir>/{config,devices}.json`,不迁 v1 状态**(用户在 v2 窗口重新配对)——聊天/配对插件可接受。
- UI 移进 `plugins-src/openclaw`(Vite 独立项目),`invoke('openclaw_X')`→`bridge.request('X')`,3 个 `listen('openclaw://…')`→1 个 `onMessage` 按 kind 分派;13 个 i18n 键内联。
- **功能 parity 缺口**:`editor_open_remote_buffer` + bound-mode 文件操作(links.ts 的 file_exists/vault_sync_now 等)无独立等价物,已 stub;web 模式下 `isBoundMode` 恒 false 故不可达,`agent.file_content` 记录后丢弃。若要恢复 bound-mode(把远程聊天里的文件打进主编辑器 tab),需新 host 方法(host.editor.open_buffer 之类),留后续。
- tray 迁移延④(①期 tray 硬编码);v2 用 Window▸OpenClaw (v2) 菜单项开窗。

**④退役清单追加**(openclaw v1):`src/chat-*`、`src/lib/openclaw`、`src/components/chat`、`src-tauri/src/openclaw`、show_chat_window(lib.rs)、tray-openclaw、chat.html、vite chat 入口、capabilities "chat";tokio-tungstenite/qrcode/gethostname/urlencoding 等 deps 若 v1 删净且无他用可从 src-tauri/Cargo.toml 移除(exlibris/其他勿误删)。

## 21. 实施记录（子项目④：自定义编辑器 + exlibris）

子项目④（自定义编辑器机制 + base/exlibris 迁移 + v1 退役）部分实现在分支 worktree-core-ize-six-plugins，flag 门控。**base 本体迁移与 v1 退役门控在用户 GUI 验证之后**（本会话未执行）。

**新增机制——tab 内嵌自定义编辑器（spec §7.3）：**
- **iframe 桥注入**：iframe 拿不到 initialization_script（那是 per-webview-window,非 per-iframe）。改为宿主 serve `plugin://<id>/*.html` 时**在 HTML 响应注入 `<script>${bridge_script}</script>`**（插入 `<head>` 后/body 首,幂等）。bridge_script 首行加 `if(window.notemd)return` 守卫——窗口经 init script + 注入双次运行无害,iframe 仅经注入获得桥。iframe 内 `window.notemd.request()` 经 `fetch('/__rpc__')` 照常访问 host.* 方法（Origin=plugin://<id> 认证）。
- **文档通道走 parent↔iframe postMessage**（不经 Rust）：主 app 持有 iframe 元素,读文件后 `iframe.contentWindow.postMessage({type:'custom_editor.open',uri,content,editorId}, 'plugin://<id>')`；iframe 编辑 → `parent.postMessage({type:'change',content},'*')` → 主 app **严格校验 `event.origin===plugin://<id>` 且 `event.source===iframe.contentWindow`** → `setContent(tabId)`（翻转 dirty）；Cmd+S 走既有 saveActive,iframe 不碰磁盘。
- **CSP**：iframe 被主窗口(tauri://localhost) frame,方向由 `frame-ancestors` 管,而 plugin:// CSP 无此指令 → 允许被 frame;`frame-src 'none'` 只限插件页自身嵌套,不限谁 frame 它。无需改 CSP。
- **降级（file-over-app）**：未装对应插件时,`.base` 等扩展名经 openFile → classifyPath null 且无 custom editor → **降级 kind='code' 纯文本 tab（不再抛错）**。
- **TabKind 加 'custom'**;Tab 加 editorId/editorPluginId/editorEntry;custom-editors.ts 从 v2 manifests 的 contributes.custom_editors 建扩展名→编辑器注册表;adapter 透传 custom_editors 进 v1 形状。
- **穿刺门控**：焦点/Cmd+S/滚动/拖拽只能真机验证。`plugins-src/custom-editor-fixture` + `PROBE.md`（PASS/FAIL 判据）供用户 GUI 穿刺;通过则 base tab 内嵌迁移,不通则 base 降级窗口编辑器。

**exlibris 迁移（v2 窗口插件,类 openclaw,纯请求-响应无流式）：**
- 后端 1157 行(14 命令 + calibre subprocess/shared_config/fs_ops/hash)整体进插件 crate `plugins-src/exlibris/backend`(binary `notemd-exlibris`),全在进程内(native 全 fs 权限);14 命令经 `on_ui_request` 分派,camelCase 参数名保留;async calibre 命令经 block_in_place+block_on。
- **共享配置进程内直读**：`~/Library/Application Support/com.laobu.mdeditor-shared/config.json`(sotvault/rawvault/calibre)——v1/v2 同路径共享,无需 host 桥。
- UI 1656 行整体移进 `plugins-src/exlibris`,invoke→bridge.request;**拖拽改 "Add books…" 按钮(host.dialog.open 多选)**(插件窗口零 Tauri IPC,`listen('tauri://drag-drop')` 不可用;拖拽转发留后续);目录选择器走 host.dialog.open directory。
- **功能缺口**:MetaPreview "在 mdeditor 打开" 因无 host.open 桥,暂以 host.toast 显示路径(host.open 是后续清爽修法)。
- 独立 exlibris app 停止发布记入 v1 退役清单(④c)。

**④c v1 退役**：详尽清单见 `docs/superpowers/plans/2026-07-17-v1-retirement-checklist.md`——**破坏性,门控用户全栈 GUI 验证 + 市场部署**。要点:五插件 v1 前后端删除;md2pdf crate 保留(v2 派生兄弟 v1 bin);v1 one-shot 机制方案 A(保留收集机制,只删执行路径);flag 转正方案 C(分两版:先默认开,再删 flag+删 v1);flag 转正强依赖市场部署(真签名密钥 + CF)。

## 22. 终审结论（跨全部子项目，2026-07-18）

对整条分支（e4f291c..d7a093a，75 提交、7 个子项目：⓪core 化 / ①运行时 / ②UI / ③市场 / ②b 双向通道 / ④自定义编辑器+exlibris）做**四路交叉终审**（安全 / 集成 / 质量 / 修复验证）。结论：**内部 flag（`plugins_v2.enabled`）首方发布就绪（READY）；无 ship-blocker。**

### 安全边界（端到端成立）
- **安装信任链无绕过**：下载 → sha256(constant-time) → minisign 验签，**均在写盘前**；GUI/CLI 同 `verify_and_stage` 管线、同硬编码 `PLUGIN_REGISTRY_PUBKEY`、无 `--force`/skip-verify；`plugin_market_preview` 先验签再返回 manifest → consent 展示的能力=已验签字节的能力；verify 用 tempdir，commit 只搬已验证树，无 TOCTOU。
- **plugin://**：resolve_asset 穿越三重防护（decode→component `..`→canonicalize 包含，含符号链接逃逸）；POST `/__rpc__` 的 Origin 服务端认证（id 取自 URL host，Origin 头 === `plugin://<id>`；WKWebView 自定义 scheme Origin 平台不可伪造）；桥注入的 plugin_id/locale/theme 经 serde_json 转义，无 XSS。
- **能力门 deny-by-default**：未知 `host.*` 方法 fail-closed（-32601）；ui.request 转发路径只对非 `host.*` 方法放行（`host.vault.write` 因前缀命中被路由到能力门，无法经转发绕过）。
- **vault 包含**：read/write/list/mkdir canonicalize-then-prefix（拒 `../`+符号链接），写入 10MB 上限；fs.read_text/read_bytes 仅 dialog 授权路径、grant 按插件隔离、随窗口关闭清理。
- **跨插件隔离**：window label = `plugin-<认证id>-<win>`，plugin_id 恒为认证 id（Origin/进程身份），A 无法开/推/控 B 的窗口。
- **自定义编辑器 postMessage**：origin + source 双验（tab A 的恶意 iframe 无法注入 tab B）；保留扩展名守卫（md/markdown/txt/html 等，前端 custom-editors.ts）防第三方劫持核心文件类型。
- **资源上限**：下载 50MB、解压 200MiB（计实际写入字节非声明 size）、请求超时 30/300s、崩溃熔断×3/10min、日志滚动 5MB。

### 本轮终审修复（e1753b5 / d7a093a）
1. **插件进程 env 隔离**：`PluginProcess::spawn` 加 `env_clear()` + 白名单（HOME/PATH/LANG/LC_ALL/TERM/USER/TMPDIR），插件不再继承 shell 里的 API keys（有 echo-env fixture 测试）。
2. **双 PDF 菜单去重**：flag 开 + 装了 v2 `notemd.<X>` 时，隐藏对应 v1 bundled `<X>`（`merge_dedup_v1_v2`，按 v2 id 的 name-part 抑制 v1，有测试；过渡态直至④c 退役）。
3. **删死命令** `get_plugin_manifests_v2`（注册但零前端调用）。
4. **spec §5 修正**：`host.ui.post` 标注需 `ui` capability（原表格写"免授权"与实现矛盾）。

### 三处审计误报已澄清（非缺陷）
- 保留扩展名守卫**确实存在**（前端 custom-editors.ts，安全/质量审计在 manifest 校验器里找，找错位置）。
- plugins-src 构建产物**根 .gitignore 已全局覆盖**（`dist/` + 各 backend `target/`），git index 零提交产物。
- pair.rs 的 `.unwrap()` **只在 `#[tokio::test]` 里**（测试字面量）；生产 relay 响应解析全 `resp.json::<T>().map_err(...)`——安全审计的"P0 MITM DoS"是误读测试码。

### 第三方开放前必做（内部 flag 首方不阻塞；见 §18/§19 亦有）
1. 真生产 minisign 签名密钥替换 market.rs 的测试公钥（源码已标 "TEST KEY — replace before shipping"）。
2. CSP `style-src 'unsafe-inline'` 收紧为 `'self'`/nonce（当前仅样式面，不可执行脚本）。
3. `plugins-src/sdk/` 共享包消除 roam-import/openclaw/exlibris 三份 bridge.ts 重复（约 75-96 行）。
4. 插件内嵌 strings.ts 是宿主 catalog 冻结拷贝，加 CI 键集比对防漂移（缺键 fallback 英文，不崩）。
5. host.secrets 若实现需连同 env 隔离一并做（spec §5 列出但未实现）。

### 测试基线（全绿）
src-tauri lib 355 + plugin_runtime_integration 12 + plugin_ui 11 + 前端 1296 + protocol 19 + SDK 11 + worker 13 + md2pdf/openclaw(16)/exlibris(24) backend crate 各自绿。唯一 flake=startup_budget/plugin_host_integration 并行负载（隔离全过，与本工程无关）。

### 门控在用户之后（未执行）
- **base 本体迁移**：门控用户对 custom-editor fixture 跑 `plugins-src/custom-editor-fixture/PROBE.md` 的 GUI 穿刺（焦点/Cmd+S/滚动只能真机验）；穿刺过=tab 内嵌，不过=降级窗口编辑器。
- **v1 退役（④c）**：破坏性、删回退路径，门控用户全栈 GUI 验证 + 市场部署（真密钥+CF）。清单见 `docs/superpowers/plans/2026-07-17-v1-retirement-checklist.md`。
