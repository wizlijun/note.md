# sidex 插件体系规范整理 与 note.md 插件机制改进建议

- 日期：2026-07-16
- 分析对象：`/Users/bruce/git/sidex`（Tauri + Rust 代码编辑器，VS Code 架构移植）与本项目 note.md（mdeditor）
- 方法：两轮源码勘查 + 关键论断逐条回读源码核实。所有断言均附 `文件:行号` 出处；未能直接核实的推断会明确标注。

---

## 一、sidex 插件体系规范（整理）

### 1.1 总体架构：双运行时

sidex 的"扩展"有两种形态，统一到同一个 `ExtensionManifest` 结构（`crates/sidex-extensions/src/manifest.rs:21-24, 31-84`）：

| 形态 | Manifest | 打包 | 运行时 |
|---|---|---|---|
| **Node 扩展** | `package.json`（VS Code 兼容全字段） | `.vsix`（ZIP） | 独立 Node.js 子进程（extension host），JSON-RPC 2.0 over stdin/stdout（`host.rs:174-195`） |
| **WASM 扩展** | `sidex.toml`（TOML） | 目录（manifest + wasm 二进制） | Wasmtime Component Model，WIT 绑定直连宿主（`src-tauri/src/commands/extension_wasm.rs`） |

设计立场（`ARCHITECTURE.md`）：VS Code 进程模型原样移植到 Tauri——extension host 保持为独立 Node 进程，可独立崩溃/重启而不影响主程序；WASM 是新增的"原生、免 Node、内存隔离"路线。

### 1.2 Manifest 规范

**WASM 扩展 `sidex.toml`**（实例：`examples/hello-extension/sidex.toml`，解析：`manifest.rs:179-217`）：

```toml
[extension]
id = "publisher.name"       # 必填，全限定 id
name = "Display Name"       # 必填
version = "0.1.0"           # 必填，semver
description = "..."         # 可选
wasm = "target/wasm32-wasip2/release/ext.wasm"  # 必填，二进制相对路径

[activation]
events = ["onLanguage:rust"]   # 可选，激活事件

[contributes]
languages = [...]
commands = [{ id = "...", title = "..." }]
```

**Node 扩展 `package.json`**：完整 VS Code 兼容——`name/version/displayName/publisher/main/browser/activationEvents/contributes/engines.vscode`（`manifest.rs:31-84`）。`contributes` 覆盖 commands、keybindings、menus、languages、grammars、themes、snippets、configuration、views、debuggers、taskDefinitions（`manifest.rs:107-132`）。

**版本化**：WIT world 声明 `package sidex:extension@0.1.0`（`sidex-extension-sdk/wit/world.wit:1`）；Node host 对外报告的 API 版本钉在 VS Code 基线 `"1.93.0"`（`manifest.rs:567`）。

### 1.3 隔离与权限模型

- **WASM**：Component Model 内存隔离，扩展无法直接触碰文件系统/网络，一切经 WIT 定义的宿主 API 中转。
- **Node**：仅有 OS 进程边界，扩展可自由使用全部 Node API（fs、net、child_process）。
- **没有显式权限/能力系统**——遍查 `crates/sidex-extensions/` 与 WIT 定义，不存在 permission/capability 枚举。WASM 的约束是"API 面即权限"的隐式模型；Node 侧完全裸奔。

### 1.4 宿主 API 面

单一 WIT 文件定义全部契约（`sidex-extension-sdk/wit/world.wit`，922 行，3 个 interface：`common-types` / `host-api` / `extension-api`，共 **267 个函数声明**，实测 `grep -c ': func('`）。`host-api`（`world.wit:541-760`）按域分组：

- 日志/通知/输出通道；诊断（publish/clear diagnostics）
- workspace（配置读写、find-files、文档开存、workspace/global state KV）
- 文件系统（read/write/delete/rename/copy/stat/list，含 bytes 变体）
- 文档与编辑器（选区、可见范围、reveal、snippet、decorations）
- 窗口 UI（input box、quick pick、open/save dialog、status bar、progress）
- 命令（register/execute/list）；语言注册；SCM；Tasks；Debug（DAP）；Notebook；Testing；文件监听；剪贴板/环境信息；扩展自身信息 + **per-extension storage 与 secrets 存取**（`world.wit:718-731`）
- `extension-api`（`world.wit:766+`）：扩展需实现的导出面——`activate()/deactivate()` + 全套 LSP provider（completion/hover/definition/references/formatting/inlay hints/semantic tokens 等，`world.wit:800-837`）

所有可失败调用返回 `result<T, string>`，错误以字符串上抛。

### 1.5 生命周期与激活事件

**安装 → 发现 → 加载 → 激活 → 停用 → 卸载**（`installer.rs:14-96`、`registry.rs:37-158`、`activation.rs:14-138`、`host.rs:365-479`）：

- **发现**：扫描 `~/.sidex/extensions/` 及 `~/.vscode/extensions/`、`~/.cursor/extensions/` 等目录找 `package.json`/`sidex.toml`；同 id 取最高版本去重；带硬编码禁用前缀名单（如 cursor 系，`registry.rs:156`）。
- **懒激活**：11 类激活事件——`*`、`onLanguage:`、`onCommand:`、`onView:`、`onFileSystem:`、`onUri`、`onDebug`、`onDebugResolve:`、`onDebugAdapterProtocolTracker:`、`workspaceContains:`、`onStartupFinished`。manifest 只读进内存，二进制到事件命中才装载执行。
- **激活串行化**：激活请求进队列逐个 drain（`host.rs:604-640`）。
- **停用**：JSON-RPC `$deactivateExtension` → 扩展 `deactivate()`；host 关停等 5 秒优雅退出，超时强杀（`host.rs:464`）。
- **更新**：卸载旧版 + 全量重装，无增量。

### 1.6 SDK 与开发者流程

`sidex-extension-sdk`：Rust crate，`wit-bindgen` 从 WIT 自动生成绑定；扩展作者实现 `SidexExtension` trait（即 `extension-api` 的 Guest），`export_extension!` 宏导出（`sidex-extension-sdk/src/lib.rs:48-75`）。构建：`cargo build --target wasm32-wasip2 --release`。目录放进扩展目录即被发现。参考实现：`examples/hello-extension/`（命令 + completion provider）、`extensions-rust/rust-language-extension/`（`onLanguage:rust` 懒激活，包一层 rust-analyzer 子进程做 LSP 转发）。

### 1.7 健壮性

- **崩溃恢复**：host 进程崩溃自动重启，上限 3 次（`MAX_CRASH_RESTARTS = 3`，`host.rs:135, 654-684`），超限禁用该 host。
- **内存监控**：512 MiB 告警 / 1 GiB 严重（`host.rs:133-134`），仅告警不强杀。
- **输入校验**：manifest 解析失败拒载并带上下文报错；WASM 二进制、Node 入口文件存在性预检（`manifest.rs:312-387`）。
- **WASM panic** 被 trap 住，不拖垮宿主。

### 1.8 分发

Open VSX 兼容市场，默认走自建 Cloudflare Worker 代理 `https://marketplace.siden.ai/api`（`marketplace.rs:24`），可配置自定义 URL；响应缓存 5 分钟。**无签名校验**——`installer.rs`/`vsix.rs` 中无任何 signature/hash 验证逻辑，VSIX 原样解压。

### 1.9 规范要点提炼（可移植的设计原则）

1. **单一契约文件**：全部宿主↔扩展 API 收敛在一个带版本号的 IDL（WIT）里，绑定代码生成，杜绝口头协议漂移。
2. **声明式贡献点 + 命令式 API 双轨**：静态可枚举的（菜单/命令/配置 schema）进 manifest，动态行为走 API。
3. **懒激活事件**：扩展默认不跑，事件命中才付启动成本。
4. **宿主进程与扩展进程解耦**：扩展崩溃可恢复、可计数、可熔断。
5. **per-extension storage/secrets 作为一等 API**：扩展不自己找地方存东西。
6. **兼容既有生态的 manifest**（VS Code/Open VSX）换取存量扩展。
7. **明确的短板（引以为戒）**：无权限模型、无签名校验、Node 侧无沙箱。

---

## 二、note.md 插件机制现状

### 2.1 模型概述

与 sidex 的"长驻 extension host"截然不同，note.md 是**一次性子进程模型**：

- **发现**：启动时只扫 `<resource_dir>/plugins/*/manifest.json`，绝不碰二进制（`src-tauri/src/plugin_host.rs:227-274`）；启停判定三层：显式 `plugins.enabled.<id>` > builtin 的 `default_enabled` > external 默认开（`plugin_host.rs:175-206`）。
- **调用**：菜单/CLI 触发时按架构挑二进制（`bin-aarch64-apple-darwin` / `bin-x86_64-apple-darwin`）spawn，请求 JSON 一行写 stdin，读 stdout 第一行为响应，stderr 截 16KB，超时（默认 30s）强杀（`plugin_host.rs:326-401`）。
- **协议**：`PluginRequest`（含 `plugin_api_version: 1`、tab 上下文、按能力注入的 `rendered_html`/`raw_content`）→ `PluginResponse{ success, actions[] }`（`src/lib/plugins/types.ts:115-141`）。
- **能力白名单**：manifest 声明 `host_capabilities`（`renderer.html/raw`、`settings.read`、`settings.write:<scope>`、`clipboard.write`、`toast`、`dialog`，`types.ts:1-9`）；宿主对**输入侧**（是否给内容）和**输出侧**（actions 逐条过滤，未声明即丢弃并告警）双向执法（`src/lib/plugins/host.ts:79-104`）。

### 2.2 声明式扩展点（manifest 已覆盖）

菜单（六个位置 + submenu + 快捷键 + `enabled_when` 表达式 + save-dialog prompt）、右键菜单（tab/editor）、设置页（`tab_label` + 四种字段类型 schema）、CLI 子命令（含冲突检测，`registry.ts:78-178`）、manifest 内嵌 i18n（`types.ts:68-75`）、整插件 `available_when` 门控。

### 2.3 硬编码扩展点（manifest 未覆盖）

1. **侧栏**：分发已通用化（`App.svelte:348` 经 `getSideView`/`toggleSideView` 走注册表），但**注册**仍硬编码在 `registerBuiltinSideViews()`（`src/lib/side-panel/registry.svelte.ts:141-163`），folder-view/outline-notes/git-history 的 side/order 写死在代码。
2. **独立窗口**：roam-import/insights/chat 三个窗口各有一个 Rust 函数（`src-tauri/src/lib.rs:353-420`）+ App.svelte 里 `if (pluginId === 'roam-import')` 式路由。
3. **前端处理器路由**：sotvault/roam-import/base 在 `dispatchPlugin` 里逐个 `if` 分支（`App.svelte:352-363`）。
4. **share 专属前置步骤**：publish 前的 vault-homing（`App.svelte:383-395`）和 `bakeShareHtml` 烘焙是 share 独享的一等集成。
5. **settings 特例**：`share.records` 单独落 `share_db.json`，读写路径都有 `if (pluginId === 'share')`（`src/lib/settings.svelte.ts:298-300, 365-370`）。
6. **启停需重启**：manifest 在 boot 时缓存，toggle 后菜单/设置页要下次启动才生效。

### 2.4 现状盘点（10 个 builtin）

| 插件 | 二进制 | 声明式用到 | 硬编码依赖 |
|---|---|---|---|
| md2pdf | ✅ | 菜单+prompt+CLI+capability | 无（唯一"纯规范"插件） |
| share | ✅ | 菜单+右键+设置+CLI+capability | vault-homing 前置、HTML 烘焙、share_db.json |
| base / sotvault / roam-import | ❌ | 菜单 | dispatchPlugin if 分支（+窗口） |
| folder-view / outline-notes / git-history | ❌ | 菜单 | 侧栏注册表硬编码 |
| reading-insights / openclaw-chat | ❌ | CLI（insights） | Rust 窗口函数 |

**结论**：10 个插件里只有 1 个完全活在规范内；manifest 对"进程型插件"表达力足够，对"前端型插件"（侧栏/窗口/宿主函数）没有词汇，全靠三处硬编码（App.svelte、lib.rs、registry.svelte.ts）兜底。

---

## 三、对比分析

| 维度 | sidex | note.md | 评判 |
|---|---|---|---|
| 进程模型 | 长驻 extension host（Node/Wasmtime） | 一次性子进程 | 各适其所：sidex 要伺服 LSP 这类长会话；note.md 的导出/分享是一次性事务，长驻是负资产 |
| 权限模型 | **无**（WASM 靠 API 面隐式约束） | 显式 capability 白名单，双向执法 | **note.md 领先**。但注意：capability 只管宿主中转的数据/动作，二进制本身仍是全权限进程 |
| 声明式贡献点 | 全量（VS Code contributes 11 类） | 菜单/右键/设置/CLI 4 类；侧栏/窗口缺失 | sidex 领先，是本次最值得借鉴处 |
| 懒加载 | 激活事件驱动 | 天然懒（用时才 spawn） | 等价；note.md 免费获得 |
| 启停生效 | 运行时 activate/deactivate | 需重启 | sidex 领先 |
| API 契约 | 单一 WIT 文件，版本化，代码生成 | TS/Rust 两份手工镜像 struct + `plugin_api_version` | sidex 领先（note.md 的 TS/Rust manifest 结构靠人肉同步，`plugin_host.rs:44-71` vs `types.ts:77-99`） |
| 崩溃/资源治理 | 3 次重启熔断 + 内存监控 | 超时强杀 + stderr 截断 | 各自匹配自身模型，note.md 现阶段够用 |
| 分发/签名 | Open VSX 市场，**无签名** | 随 app 打包，无外部加载 | 两边都没解决第三方信任；sidex 的缺口是前车之鉴 |
| i18n | VS Code %key% 机制（Node 侧） | manifest 内嵌 per-locale 覆盖 | note.md 更自洽 |
| 沙箱 | WASM Component Model（仅 WASM 形态） | 无 | 若 note.md 开放第三方插件，WASM 是现成答案 |

---

## 四、改进建议（按优先级）

原则：**不照搬 sidex 的架构，借鉴它的规范化方法**。note.md 的一次性子进程 + capability 白名单模型与产品体量匹配，且权限设计优于 sidex，应保留为基座。改进方向是补齐 manifest 的表达力，把三处硬编码收编进规范。

### P1-1 新增 `contributes.side_panel` / `contributes.window` 声明式贡献点

manifest 增加：

```jsonc
"side_panel": { "side": "left" | "right", "order": 0, "component": "folder-view" },
"window":     { "entry": "insights.html", "title_key": "insights.title",
                "width": 900, "height": 640, "singleton": true }
```

- 侧栏：`registerBuiltinSideViews()` 改为遍历 manifest 生成注册（组件本身仍是前端代码，`component` 是前端组件注册表的 key——builtin 插件的组件在编译期打包，这里只是把 side/order/可见性从代码移进 manifest）。分发层已通用，无需改动。
- 窗口：Rust 侧收敛成一个泛化 `show_plugin_window(plugin_id)` 命令，从 manifest 读 entry/尺寸/单例性，替掉三个手写函数。注意每个窗口 label 仍需进 `capabilities/default.json` 的 windows 白名单（既有约定）。
- 消除现状痛点 1、2；新增窗口型插件从"改 4 处"降为"改 manifest + 建 entry html"。

### P1-2 前端处理器路由声明化，废除 `dispatchPlugin` 的 if 链

菜单项增加 `handler` 字段：

```jsonc
{ "command": "create", "handler": "host" }   // 缺省 "binary"
```

`handler: "host"` 时查前端命令注册表 `hostCommands['<plugin_id>:<command>']`——各 builtin 在自己的模块里注册处理函数（sotvault→syncCurrentToVault、base→createNewBase、窗口型→openPluginWindow）。`dispatchPlugin` 只剩两条路径：查注册表、或 spawn 二进制。消除痛点 3。

### P1-3 插件数据文件规范化，消灭 `share.records` 特例

引入约定：capability `storage.file` + 宿主 API 将 `<app_data>/plugin_data/<plugin_id>.json` 的读写作为标准 action（对应 sidex 的 per-extension storage 一等 API）。`share.records` 迁移过去，删除 settings.svelte.ts 里两处 `if (pluginId === 'share')`。消除痛点 5。secret 类字段将来可同理引入 `secrets.*` capability（sidex 的 secrets API 是好参照，`world.wit:726-731`）。

### P2-1 启停免重启

toggle 后重新拉取 manifests、重建菜单/设置页/侧栏注册。菜单已有运行时重建能力（i18n 切换即触发），主要工作量在 Rust 侧 `STATE.enabled` 的运行时刷新 + 前端各注册表的重收集。对齐 sidex 的 activate/deactivate 体验。

### P2-2 契约单源化 + 版本策略

- TS 的 `PluginManifest` 与 Rust 镜像 struct 目前人肉同步。建议以 JSON Schema 作为单源（`plugins/manifest.schema.json`），CI 里校验：① 所有 builtin manifest 过 schema；② TS 类型与 schema 一致（`json-schema-to-typescript` 生成或比对）。Rust 侧继续宽松反序列化即可。这是 sidex"单一 WIT 契约"思想在轻量模型下的等价物。
- `plugin_api_version` 已有，补一个 manifest 字段 `min_host_version`，宿主低于此版本时拒载并在设置页说明——为将来外部插件的前向兼容留口子。

### P3 外部插件（若立项）：WASM 路线 + 完整性校验

现有 capability 模型对 builtin 是"诚实系统"——它约束宿主中转什么，但二进制本身以用户全权限运行，对不受信第三方不构成安全边界。若开放外部插件：

1. **运行时选 WASM（wasm32-wasip2 + Component Model）**，直接借鉴 sidex 的做法：宿主 API 用 WIT 定契约（note.md 的 API 面极小——现有 7 个 capability 对应的注入/action 即全部——WIT 文件预计 <100 行，成本远低于 sidex 的 922 行），Wasmtime 跑不受信代码，capability 白名单从"过滤 actions"升级为"决定链接哪些 host 函数"，隐式与显式权限合流。
2. **签名/哈希校验从第一天做**——sidex 的 VSIX 原样解压是明确的反面教材。
3. 发现目录沿用 sidex 模式（`~/.notemd/plugins/` 扫 manifest），复用现有三层启停判定，external 默认值应从"开"改为"关"（现状 `plugin_host.rs` 里 external 缺省启用是为 legacy 兼容，对真外部插件不安全）。

### 不建议采纳

- **VS Code 兼容 manifest / Open VSX 市场**：sidex 做编辑器，吃存量生态是核心收益；note.md 的插件面（导出/分享/面板）与 VS Code 扩展模型不重叠，兼容只会引入巨大的 API 面义务。
- **长驻 extension host + JSON-RPC**：现有插件全是一次性事务，长驻进程带来的崩溃治理、内存监控、生命周期复杂度（sidex 为此写了整套熔断/监控）没有对应收益。何时重新评估：出现真正的会话型插件需求（如 LSP、实时协作）再说。
- **激活事件系统**：一次性 spawn 模型下无意义，`enabled_when`/`available_when` 表达式已覆盖等价需求。

### 落地顺序建议

P1-1 → P1-2 是同一场重构（"贡献点收编"），建议一次做完并以现有 10 个 builtin 全部迁移为验收标准（迁移后 `App.svelte` 的 dispatchPlugin 不应再出现任何插件 id 字面量）；P1-3 可独立；P2 随后；P3 仅在外部插件立项时启动。

---

## 附：核实记录

- sidex 双 manifest 结构、`sidex.toml` 实例、WIT `@0.1.0`、`"1.93.0"` 钉版、`MAX_CRASH_RESTARTS=3`、内存阈值、`marketplace.siden.ai` 默认代理、installer/vsix 无签名逻辑：均已回读源码确认。
- sidex WIT 函数计数（267）为 `grep -c ': func('` 实测。
- note.md `types.ts` 全文、`run_plugin_binary` 全文、`dispatchPlugin` 分支段已回读确认；子代理报告中"侧栏切换硬编码"一说经核实修正为"分发通用、注册硬编码"。
- 子代理报告中 sidex 的 Node/TypeScript 扩展完整示例系推断（repo 内无现成 TS 扩展），本文未采信为事实。
