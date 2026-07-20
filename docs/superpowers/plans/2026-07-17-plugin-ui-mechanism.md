# 子项目②：插件 UI 机制 + roam-import 迁移 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立插件自带 UI 的机制——`plugin://` 自定义协议 serve 插件静态资产、fetch-RPC 受限桥（零 Tauri IPC 注入）、宿主开窗——并把 roam-import 迁移为第一个纯 UI 型 v2 插件。openclaw-chat 迁移因体量（1.2k 前端 + 1.26k Rust 状态机）拆分为后续独立计划（②b）。

**Architecture（关键决策，实现者必读）:**
1. **plugin 窗口不加入任何 capability** → Tauri IPC 全拒（比"注入受限 API"更强的隔离，且符合既有"窗口不进 capabilities 即命令静默拒绝"的机制事实）。
2. **桥 = `plugin://` 协议上的 fetch**：GET `plugin://<id>/<path>` serve `<install>/current/ui/` 静态资产（穿越防护 + mime + CSP 响应头）；POST `plugin://<id>/__rpc__` 承载 UI→宿主调用，**以请求 Origin（= plugin://<id>）为插件身份**，按该插件 manifest capabilities 执法——与插件进程共用同一张方法-能力表。
3. **宿主→UI 推送**：`window.eval("window.__notemd_dispatch(<json>)")`（宿主持有 WebviewWindow 句柄）；桥的 init script 注入 `window.notemd = { locale, theme, pluginId, request(), onMessage() }`。
4. **纯 UI 插件**：manifest v2 的 `binary` 变为可选（`binary` 与 `ui` 至少其一）；roam-import v2 无后端进程，导入逻辑（本就是自包含 TS 库）随 UI bundle 走，文件读写改经 `host.vault.*`/`host.dialog.*` RPC。
5. **开窗触发**：window contribution 增加 `open_command` 字段；前端 v2 分发时命令命中某窗口的 open_command → 调 `plugin_v2_open_window` 而非 execute。

**Tech Stack:** Tauri v2 `register_uri_scheme_protocol`（http::Request/Response 带 method+body+Origin）、WebviewWindowBuilder + initialization_script、独立 Vite 构建插件 UI bundle。

**已核实锚点：** 窗口单例模式样例 lib.rs:377-396（show_insights_window）；capabilities/default.json windows 为精确列表；CSP 当前 null；vite 多入口 rollupOptions（vite.config.ts:30-38）；roam-import UI=249 行（roam-import-app.svelte 231 行 + `src/lib/roam-import/` 自包含库），依赖 settings/sotvault/outlineDirs 三个 store + tauri fs/dialog/clipboard 插件 + 18 个 i18n 键，**无 Rust 后端**；plugin_runtime 缝隙：host_api::method_capability（host_api.rs:19-26）、make_sink_for_app（:113-124）、SpawnCtx（lifecycle.rs:97-109）、InitializeParams.theme 现为空串。

**工作区纪律：** 同一 worktree 分支继续堆叠；精确 git add；全程 v2 flag 门控，flag off 零行为变化（含 plugin:// handler：注册无法按 flag 条件化，handler 内部对未知 id/flag off 一律 404）。

---

### Task 1: protocol crate——binary 可选 + 窗口贡献类型化

**Files:** Modify `plugin-protocol/src/lib.rs`；regenerate `protocol/schema/` + `src/lib/plugins/v2/protocol.gen.ts`

- [ ] Step 1: `ManifestV2.binary` 语义改为可选（字段本就 `#[serde(default)]`，改 validate）：`validate_manifest` 增加规则——`binary` 为空 map 且 `ui` 为 None → Err("plugin must provide binary and/or ui")；其余不变。
- [ ] Step 2: 新增类型化窗口贡献并替换 `Contributes.windows: Vec<serde_json::Value>`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WindowContribution {
    pub id: String,                 // 窗口 id（label = plugin-<sanitized plugin id>-<id>）
    pub entry: String,              // ui/ 内相对路径，如 "index.html"
    #[serde(default)]
    pub title: Option<String>,      // 缺省用插件 name
    pub width: f64,
    pub height: f64,
    #[serde(default)] pub min_width: Option<f64>,
    #[serde(default)] pub min_height: Option<f64>,
    #[serde(default = "default_true")] pub singleton: bool,
    /// contributes.menus 中命中此 command 的菜单项 = 打开本窗口（不走 command.execute）。
    #[serde(default)] pub open_command: Option<String>,
}
fn default_true() -> bool { true }
```

`Contributes.windows: Vec<WindowContribution>`。校验：validate_manifest 中 windows 非空时要求 `ui.is_some()`；entry 不得含 `..`；id 限 `[a-z0-9-]+`。
- [ ] Step 3: 更新 lib.rs 内测试（样例 manifest 增加一个带 windows 的用例 + ui-only 合法用例 + binary+ui 双缺拒绝用例）；`cargo test` plugin-protocol → PASS。
- [ ] Step 4: `pnpm gen:protocol`；`pnpm check && pnpm check:protocol` → PASS（adapter 透传 windows 的 serde_json 转换兼容性：adapter.rs to_v1 不映射 windows——确认其现走 contributes.menus/cli/settings，无需改）。
- [ ] Step 5: Commit `feat(plugin-v2): optional binary (ui-only plugins) + typed window contributions`（plugin-protocol/、protocol/schema/、src/lib/plugins/v2/protocol.gen.ts、受影响 src-tauri 编译修补一并列出）。

---

### Task 2: plugin:// 协议——静态资产 + RPC 端点骨架

**Files:** Create `src-tauri/src/plugin_runtime/protocol.rs`；Modify `plugin_runtime/mod.rs`、`src-tauri/src/lib.rs`（Builder 注册）

- [ ] Step 1: protocol.rs 纯函数核心（全部可单测，无 AppHandle）：

```rust
/// GET 资产解析：plugin://<id>/<path> → 文件绝对路径。
/// 防护：id 必须在已加载插件表中且有 ui 目录；path 规范化后必须仍在 ui 根内。
pub fn resolve_asset(ui_root: &Path, url_path: &str) -> Result<PathBuf, AssetError>
// AssetError { NotFound, Traversal } ；url_path 为空/"/" → index.html 不隐式——由 entry 显式指定，
// 但目录路径尾随 "/" → 追加 "index.html"（约定）。
pub fn mime_for(path: &Path) -> &'static str  // html/js/css/json/svg/png/jpg/woff2/wasm + octet-stream 兜底
pub fn csp_header(plugin_id: &str) -> String
// "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
// （'self' 在 plugin://<id> origin 下即本插件；禁一切远程加载——spec §7.1）
```

- [ ] Step 2: handler 注册（lib.rs Builder 链，`.setup(` 之前）：

```rust
.register_uri_scheme_protocol("plugin", |ctx, request| {
    crate::plugin_runtime::protocol::handle(ctx.app_handle(), request)
})
```

`handle(app, request) -> http::Response<Vec<u8>>`：解析 host=plugin id（STATE 查表；flag off/未知 id → 404）；`POST /__rpc__` → Task 3 的 `ui_rpc::dispatch`（Origin 头必须等于 `plugin://<id>`，否则 403）；GET → resolve_asset → 200 + mime + CSP（仅 html 加 CSP 头）+ `Cache-Control: no-cache`；错误映射 404/403。iOS：整模块已在 not-ios 门内；lib.rs 的注册调用同样 cfg 门控（Builder 链上用 `#[cfg]` 拆分——参照 lib.rs 既有 cfg 分支写法，若 Builder 链内不便，条件编译整段）。
- [ ] Step 3: 单元测试：resolve_asset 正常/尾随斜杠/`..` 穿越拒绝/符号链接逃逸拒绝（canonicalize 后前缀校验）；mime 表；csp 串。集成测试（无 webview，直接调 handle 需要 AppHandle——将 handle 拆为 `handle_parsed(state_view, method, id, path, origin, body)` 纯层测试 + AppHandle 薄壳）。
- [ ] Step 4: `cargo test` → PASS；Commit `feat(plugin-v2): plugin:// scheme — asset serving with traversal guard, CSP, RPC endpoint skeleton`。

---

### Task 3: ui_rpc——UI 发起的宿主调用（与进程侧共用能力执法）

**Files:** Create `src-tauri/src/plugin_runtime/ui_rpc.rs`；Modify `host_api.rs`（方法表扩充）、`mod.rs`

- [ ] Step 1: host_api::method_capability 扩充（进程侧与 UI 侧同表）：

```rust
"host.dialog.open" | "host.dialog.save" => Some("dialog"),
"host.vault.info" => Some("vault.read"),
"host.vault.read" | "host.vault.exists" | "host.vault.list" => Some("vault.read"),
"host.vault.write" | "host.vault.mkdir" => Some("vault.write"),
```

- [ ] Step 2: ui_rpc.rs：`pub async fn dispatch(app, plugin_id, capabilities, body: RpcRequest) -> RpcResponse`：
  - capability 门（复用 method_capability，未授权 -32001）；
  - `host.toast`/`host.log.*`：复用 host_api 现有实现（重构出共用函数，避免复制——host_api 的 make_sink 闭包体拆出 `pub(crate) fn handle_common(method, params, plugin_id, log_dir, emitter) -> Option<Result<Value,String>>`，sink 与 ui_rpc 都调它）；
  - `host.dialog.open { title?, filters?, directory? } -> { paths: [..] | null }`：tauri_plugin_dialog 的 Rust API（blocking_pick_files/blocking_pick_folder——用 async 版本 + oneshot，参照 crate 文档；App 内已有 dialog 插件）；`host.dialog.save` 同理；
  - `host.vault.info -> { root: string|null, wiki_dir: string|null, daily_dir: string|null }`：root 从 sotvault 配置读取（**实现前先查**：`grep -rn "vault_root\|sotvault_vault_root" src-tauri/src/sotvault/` 找现成命令/函数复用）；wiki/daily 目录取自前端 outlineDirs 的持久化键（**先查** `grep -rn "outline.dirs\|wikiDir\|dailyDir" src src-tauri` 定位 settings 键名，Rust 直读 settings.json 同键）；找不到即返回 null 并在报告注明；
  - `host.vault.read/write/exists/list/mkdir { path }`：path 必须相对且规范化后落在 vault root 内（root 为 null → Err "vault_required"）；write 建父目录；list 返回文件名数组；
  - 全部错误以 RpcError 返回（code -32000，message 带 kind 前缀如 "vault_required: …"）。
- [ ] Step 3: 单元测试（tempdir 假 vault root 注入——vault root 读取函数做成可注入/可覆写的纯层）：越界路径拒绝、vault_required、read/write/mkdir/list 往返、capability 拒绝、dialog 方法在无头环境返回可控错误（跳过真弹窗——dialog 调用经 trait/闭包注入，测试注入 stub）。
- [ ] Step 4: `cargo test` → PASS；Commit `feat(plugin-v2): ui_rpc — dialog/vault host methods shared with process-side capability gate`。

---

### Task 4: 窗口打开 + 桥注入 + 宿主推送

**Files:** Create `src-tauri/src/plugin_runtime/windows.rs`；Modify `commands.rs`（新命令）、`lib.rs`（注册）、`src/App.svelte`（v2 分发 open_command 分支）

- [ ] Step 1: windows.rs：

```rust
pub fn window_label(plugin_id: &str, window_id: &str) -> String
// "plugin-" + plugin_id.replace('.', "-") + "-" + window_id （label 字符集安全）

pub fn open_plugin_window<R: Runtime>(app, plugin_id: &str, window_id: &str) -> Result<(), String>
// STATE 查 manifest → contributes.windows 找 id → singleton: get_webview_window(label) 命中则 show+focus；
// 否则 WebviewWindowBuilder::new(app, label, WebviewUrl::External(
//     format!("plugin://{plugin_id}/{entry}").parse().unwrap()))
//   .title(title.unwrap_or(manifest.name))
//   .inner_size(w,h).min_inner_size(...).resizable(true).visible(false)
//   .initialization_script(&bridge_script(plugin_id, locale, theme))
//   .build() → show/unminimize/set_focus（样式照抄 show_insights_window lib.rs:377-396）

pub fn bridge_script(plugin_id: &str, locale: &str, theme: &str) -> String
// 注入：window.notemd = Object.freeze({
//   pluginId, locale, theme,
//   async request(method, params) {
//     const r = await fetch('/__rpc__', { method:'POST', headers:{'content-type':'application/json'},
//       body: JSON.stringify({ jsonrpc:'2.0', id: __seq++, method, params }) })
//     const j = await r.json();
//     if (j.error) throw new Error(j.error.code + ': ' + j.error.message);
//     return j.result;
//   },
//   onMessage(cb) { __listeners.push(cb) },
// });
// window.__notemd_dispatch = (payload) => __listeners.forEach(cb => cb(payload));
// 注意 fetch('/__rpc__') 相对路径在 plugin://<id>/ origin 下解析为 plugin://<id>/__rpc__。

pub fn push_to_window<R: Runtime>(app, plugin_id, window_id, payload: &serde_json::Value)
// get_webview_window(label) → win.eval(format!("window.__notemd_dispatch({})", payload)) —— JSON 串安全转义
```

- [ ] Step 2: commands.rs 新命令 `plugin_v2_open_window(app, plugin_id, window_id) -> Result<(),String>`（调 windows::open_plugin_window）；lib.rs invoke_handler 注册。theme 取值：与 CLI 一致的 `settings.theme` 键直读 settings.json（缺省 "default"）；locale 用 read_saved_locale。
- [ ] Step 3: App.svelte v2 分发：在 `m.manifest_version === 2` 分支开头——

```ts
          const win = (m as any).contributes_windows_open?.[command]  // 不引入新字段：由 adapter 透传？
```

**实现方式（定案）**：adapter to_v1 时把 `contributes.windows` 中含 open_command 的映射编成附加字段 `open_windows: { [command]: window_id }` 放进 v1 形状（TS types.ts 加可选 `open_windows?: Record<string,string>`）；前端分支：

```ts
          const openWin = m.open_windows?.[command]
          if (openWin) { await invoke('plugin_v2_open_window', { pluginId: m.id, windowId: openWin }); return }
```

- [ ] Step 4: 单元测试：window_label 转换；bridge_script 含 pluginId/locale/theme 与 __rpc__ 字面；adapter open_windows 映射。
- [ ] Step 5: `cargo test` + `pnpm check && pnpm vitest run` → PASS；Commit `feat(plugin-v2): plugin windows — open command routing, bridge injection, host push`。

---

### Task 5: fixture UI 插件 + 端到端集成测试（协议层）

**Files:** Create `src-tauri/tests/fixtures/v2-ui/`（manifest.json + ui/index.html + ui/app.js）；tests 追加

- [ ] Step 1: fixture：ui-only manifest（id `test.ui-fixture`，windows:[{id:"main",entry:"index.html",width:400,height:300,open_command:"open"}]，capabilities:["toast","vault.read"]）+ 极简 index.html/app.js（调 notemd.request('host.vault.info')）。
- [ ] Step 2: 集成测试（无 webview，测纯层）：discovery 加载 ui-only manifest 通过（无 binary）；resolve_asset 对 fixture ui/ 生效；`handle_parsed` GET index.html → 200+CSP，POST __rpc__ toast（Origin 正确）→ ok，Origin 伪造 → 403，capability 外方法 → -32001。
- [ ] Step 3: `cargo test` → PASS；Commit `test(plugin-v2): ui fixture plugin + protocol/rpc integration coverage`。

---

### Task 6: roam-import v2 迁移（纯 UI 插件）

**Files:** Create `plugins-src/roam-import/`（独立 Vite 项目：package.json、vite.config.ts、index.html、src/…）；Create `plugins-src/roam-import/manifest.v2.json`；Modify `scripts/dev-install-plugin.sh`（通用化：接受插件目录参数）

- [ ] Step 1: 脚手架 `plugins-src/roam-import/`：Vite + svelte 单页（复用 repo 根 devDependencies——package.json 用 workspace 根依赖即可，`pnpm-workspace.yaml` 若未含 plugins-src 需加入；构建产物 `dist/` 即插件包 `ui/`）。
- [ ] Step 2: 移植 UI：拷贝 `src/roam-import-app.svelte`（231 行）与 `src/lib/roam-import/` 库进插件项目（**拷贝而非移动**——v1 入口保留到④期退役）；替换宿主依赖：
  - `loadSettings/sotvaultStore/outlineDirs` → `await notemd.request('host.vault.info')`（root/wiki_dir/daily_dir）；
  - `@tauri-apps/plugin-dialog open()` → `notemd.request('host.dialog.open', { filters:[{name:'JSON',extensions:['json']}] })`；
  - `@tauri-apps/plugin-fs readFile/readTextFile/exists/mkdir/writeTextFile` → `host.vault.*`（读导出 JSON 是 vault 外文件！→ dialog.open 返回绝对路径后用 **新增** `host.fs.read_text { path }`——**回到 Task 3 补**：`host.fs.read_text` capability `fs.read:dialog`——仅允许读取本会话内经 host.dialog.open 返回过的路径（宿主记录已授权路径集，spec §5 的 fs.read:prompt 语义）。在 Task 3 的方法表与测试中一并实现，此处只是消费）；
  - `clipboard writeText` → 复用 `host.toast`？不——日志复制功能改为 `host.clipboard.write`（方法表已有 capability 定义 `clipboard.write`，Task 3 一并实现：tauri_plugin_clipboard_manager Rust API）；
  - i18n：18 个键的 4 语言字符串内联为插件本地 `strings.ts`（从 src/lib/i18n/{en,zh,ja,de}.ts 摘抄 roamImport.* 原文），`notemd.locale` 选语言；
  - `getCurrentWindow().setTitle` → 删（窗口标题由 manifest title + i18n 由宿主 adapter 透传的 manifest.i18n 解决——windows 贡献标题本地化①期从简：manifest.title 固定英文，④期统一）。
- [ ] Step 3: manifest.v2.json：id `notemd.roam-import`，无 binary，`ui: "ui/"`，windows:[{id:"main",entry:"index.html",title:"Import from Roam Research",width:680,height:620,min_width:520,min_height:420,open_command:"open"}]，menus:[{location:"file",submenu:"import",label:"Roam Research (v2)",command:"open"}]，capabilities:["dialog","vault.read","vault.write","fs.read:dialog","clipboard.write","toast"]，activation events ["onCommand:open"]（纯 UI 插件无进程，激活事件仅为语义占位——记录之）。
- [ ] Step 4: dev-install-plugin.sh 通用化：`dev-install-plugin.sh [--release] [plugin-dir]`，md2pdf 默认；roam-import 分支：`pnpm --filter roam-import-plugin build`（或 cd 构建）→ 拷 dist/ 为 ui/ + manifest → state.json。
- [ ] Step 5: 构建 + 安装 + `cargo test`/`pnpm check`/`pnpm vitest run` 全绿；手动 E2E 步骤写入脚本尾注释（flag 开 → File▸Import▸Roam Research (v2) → 选文件 → 导入到 vault → 与 v1 结果 diff 抽查）。
- [ ] Step 6: Commit `feat(plugin-v2): roam-import migrated as the first ui-only v2 plugin`。

---

### Task 7: spec 回写 + 多轮 review

- [ ] Step 1: spec 追加 `## 18. 实施记录（子项目②）`：fetch-RPC 桥设计（窗口零 capability、Origin 认证、eval 推送）及其相对 spec §7.1 "受限桥 + plugin_bridge command" 的偏离理由（隔离更强、无 capability 面）；binary 可选；open_command 机制；host.fs.read:dialog 语义；openclaw-chat 拆分为②b 的决定；④期退役清单追加（v1 roam-import 前端入口/window fn/i18n 键）。
- [ ] Step 2: 全量回归 + 两视角并行 review（执行链路正确性 / 集成盲区）→ 修复 → 验证轮，收敛为止（沿用⓪①的评审模式）。
- [ ] Step 3: Commit + 汇报。

---

## Self-Review 记录

- **Spec 覆盖**：§7.1（协议+桥：T2/T4，偏离记录 T7）、§7.2（窗口：T4；label 规则改为 `plugin-<id>-<win>` 且不入 capabilities——偏离原 "plugin-* glob 授 bridge 命令"设计，理由见 Architecture#1-2）、§5 增量方法（dialog/vault/fs.read:dialog/clipboard：T3/T6）、§2 manifest（binary 可选+windows 类型化：T1）、§14 ②期界定（roam-import 交付、openclaw-chat 拆②b：T7 记录）。
- **占位符**：T3 vault info 的 wiki/daily 键名与 dialog Rust API 细节为"先查再实现"指令（含 grep 命令与回退行为），非 TBD；T6 移植为逐项映射清单。
- **类型一致性**：WindowContribution.open_command ↔ adapter open_windows ↔ App.svelte open_windows 三处命名一致；handle_parsed/resolve_asset/dispatch 签名在 T2/T3/T5 引用一致。
- **风险**：WebviewUrl::External 承载自定义 scheme 在 macOS WKWebView 的兼容性——T4 实现者若 build 失败改用 `WebviewUrl::CustomProtocol`/`Url::parse` 变体并报告；fetch 相对路径在自定义 scheme origin 下的解析——bridge 测试页（fixture）在 T5 手动验证一次，若相对路径不解析改用绝对 `plugin://<id>/__rpc__`。
