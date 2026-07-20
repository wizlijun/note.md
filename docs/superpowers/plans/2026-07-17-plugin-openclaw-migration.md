# 子项目②b：openclaw-chat 迁移（双向插件窗口通道 + 流式）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立"插件窗口 UI ↔ 自己插件进程"的双向通道（UI→进程请求转发 + 进程→窗口流式推送 `host.ui.post`），并把 openclaw-chat（1.26k 行 Rust 异步状态机 + 聊天 UI）迁移为第一个"有后端进程 + 长连流式"的 v2 窗口插件。全程 v2 flag 门控；v1 openclaw 保留至④退役。

**Architecture:** 现有 v2 桥只有「UI→host 的 host.* 请求」+「host→UI 单向 push（仅 host 代码可调 push_to_window）」。②b 补两条：(1) **UI→插件进程**：UI 的 `notemd.request(method,…)` 若 method 非 `host.*`（约定 `plugin.*`）→ ui_rpc 转发给该插件进程的新入站方法 `ui.request{method,params}`（SDK 暴露 `on_ui_request`）→ 回传结果；(2) **进程→UI**：插件进程调 `host.ui.post{window_id,payload}`（新 capability `ui`，仅进程侧 make_sink）→ host `push_to_window`。openclaw 后端整体搬进插件二进制（UDS/relay/pair/protocol/devices/config），reader 循环在 `$activate` 起、每帧 `host.ui.post` 推给窗口；native 二进制有全 fs 权限，直接读 settings.json / 写设备文件（无需新 storage host 方法）。UI 用 `notemd.request('plugin.…')` 替 invoke、`notemd.onMessage` 替 listen。

**Tech Stack:** notemd-plugin-sdk（扩 on_ui_request）、tokio-tungstenite/futures-util/url/urlencoding/qrcode/gethostname/rand（移进插件 crate）、独立 Vite 插件 UI。

**已核实：** openclaw 后端 11 命令 + 事件 `openclaw://{frame,status,error,relay-status,relay-error,pending-claim}`（commands.rs 各 emit 行）；前端 client.svelte.ts start()/handleFrame（流式 delta 累加）、commands.ts 的 invoke/listen 包装；v2 桥 windows.rs push_to_window/dispatch_eval/bridge_script、ui_rpc.rs dispatch、host_api.rs method_capability、process.rs HostSink、lifecycle ensure_active；host 胶水 show_chat_window(lib.rs:355-369)、tray-openclaw(lib.rs:1119,1125-1127)、capabilities windows "chat"。

**工作区纪律：** 同分支堆叠；精确 git add；flag off 时新方法一律拒；不删 v1（src/chat-*、src/lib/openclaw、src-tauri/src/openclaw、show_chat_window 保留至④）。

---

### Task 1: SDK on_ui_request + protocol ui.request/ui.post 类型

**Files:** Modify `notemd-plugin-sdk/src/lib.rs`、`plugin-protocol/src/lib.rs`；regen schema/TS

- [ ] Step 1: plugin-protocol 加 `UiRequestParams { method: String, params: Value }`（宿主→插件 `ui.request`）与 `UiPostParams { window_id: String, payload: Value }`（插件→宿主 `host.ui.post`），schemars 派生。regen `pnpm gen:protocol`。
- [ ] Step 2: SDK `NotemdPlugin` trait 加 `fn on_ui_request(&mut self, host: &Host, method: &str, params: Value) -> Result<Value,String> { Err("no ui handler".into()) }`（默认实现，向后兼容 md2pdf/roam）；serve_io 的方法分发加 `"ui.request" => plugin.on_ui_request(...)`。Host 加 `pub fn ui_post(&self, window_id: &str, payload: Value)`（发 `host.ui.post` 通知）。
- [ ] Step 3: SDK 单测（duplex）：宿主发 `ui.request{method:"x",params}` → on_ui_request 返回值回传；插件调 host.ui_post → 写出 `host.ui.post` 通知行。
- [ ] Step 4: `cargo test` SDK + protocol；`pnpm check:protocol`。Commit `feat(plugin-v2): SDK on_ui_request + ui.request/ui.post protocol types`。

---

### Task 2: 宿主双向通道——ui_rpc 转发 + host.ui.post 推送

**Files:** Modify `src-tauri/src/plugin_runtime/{host_api.rs,ui_rpc.rs,windows.rs,lifecycle.rs,process.rs,commands.rs}`

- [ ] Step 1: host_api::method_capability 加 `"host.ui.post" => Some("ui")`；进程侧 make_sink 加 `host.ui.post` 分支：解析 UiPostParams → `windows::push_to_window(app, plugin_id, window_id, payload)`（make_sink_for_app 已持 app）→ 回 `{ok:true}`（notification 无 id 则不回）。
- [ ] Step 2: lifecycle：加 `pub async fn ui_request(&self, method: &str, params: Value) -> Result<Value,String>`——`ensure_active` 后 `proc.request("ui.request", {method,params})`，刷新 last_activity。（openclaw 是 window 插件、无激活事件命中 command——window 打开时需先激活：见 Step 4。）
- [ ] Step 3: ui_rpc dispatch：method 不以 `host.` 开头时（约定 UI 调 `plugin.<x>` 或直接透传）→ 走新 `forward_to_plugin(app, plugin_id, method, params)`：取该插件 lifecycle → `ensure_active(Trigger::Startup)` → `ui_request(method,params)` → 结果作为 RpcResponse.result。能力门：转发类方法不查 host capability（属插件自身 API 面，由插件 on_ui_request 自行校验）——但仅当该 plugin_id 有 window 打开时允许（Origin 已证明是该插件窗口）。
- [ ] Step 4: windows::open_plugin_window：build 窗口后 `ensure_active(Trigger::Startup)`（让后端进程在 UI 前就绪，reader 可即时推 frame）。commands.rs 的 plugin_v2_open_window 已调 open_plugin_window，无需另改。
- [ ] Step 5: 集成测试（fixture）：见 Task 3 的 streaming fixture——此处先加纯层单测：method 路由（host.* vs plugin.*）、host.ui.post make_sink 分支产出 push。
- [ ] Step 6: `cargo test` + `cargo build`。Commit `feat(plugin-v2): bidirectional window channel — ui.request forward + host.ui.post push`。

---

### Task 3: streaming fixture 插件 + 端到端集成测试

**Files:** Create `src-tauri/tests/fixtures/v2-stream/`（manifest + ui + a small SDK-based binary? 用 shell fixture 模拟）；tests

- [ ] Step 1: fixture：一个用 notemd-plugin-sdk 写的最小二进制插件 `stream-fixture`（$activate 起一个 tokio interval，每 100ms `host.ui_post("main", {seq})` 3 次；on_ui_request("echo",p) 回 p）。放 `src-tauri/tests/fixtures/v2-stream/`（Cargo 子 crate 或 tests 内联构建——择简，参照 md2pdf v2 的 CARGO_BIN_EXE 手法：把 fixture 做成 tests 目录下的独立 bin target）。
- [ ] Step 2: 集成测试（plugin_runtime_integration 或新文件）：spawn fixture 进程（经 lifecycle）→ 模拟 window（用一个记录 push 的 stub 替 push_to_window——push_to_window 拆出可注入 sink 层）→ 断言：ui.request echo 往返、$activate 后收到 ≥3 条 host.ui.post seq。
- [ ] Step 3: `cargo test` → PASS。Commit `test(plugin-v2): streaming fixture plugin + bidirectional channel integration`。

---

### Task 4: openclaw 插件后端 crate

**Files:** Create `plugins-src/openclaw/backend/`（Rust crate：Cargo.toml + src/，从 src-tauri/src/openclaw 移植逻辑，用 SDK）

- [ ] Step 1: 新 crate `notemd-openclaw`（bin，依赖 notemd-plugin-sdk + tokio-tungstenite/futures-util/url/urlencoding/qrcode/gethostname/rand/reqwest/hmac/sha2/hex）。**拷贝**（非移动，v1 留存）uds_client/relay_client/relay_bridge/protocol/pair/config/devices 的逻辑，去掉 tauri 依赖：
  - 事件不再 `app.emit`，改 `host.ui_post("main", {kind:"frame"|"status"|..., data})`；
  - 命令改为 `on_ui_request(method, params)` 分派：`connect/send/disconnect/pair_create/pair_claim/revoke_device/forget_device/list_devices/approve_pending/reject_pending/upload_attachment`（11 个，参数同 v1）；
  - state 从 app.state 改为插件内 `struct OpenClawPlugin { state: Arc<...> }`；config 读 settings.json（InitializeParams.data_dir 旁或 app_config——插件拿不到 app_config_dir，改为读 `plugin_root`/env 定位，或 host.vault.info 无关——**决策**：openclaw config 存自己的 `<data_dir>/config.json`（InitializeParams.data_dir 已给），devices 存 `<data_dir>/devices.json`；从 v1 的 settings.json 迁移一次）；
  - $activate：起 reader（若已配置自动 connect？保留 v1 语义：connect 由 UI 触发）。
- [ ] Step 2: manifest.v2.json：id `notemd.openclaw-chat`，binary（双架构），ui `ui/`，windows [{id:"main",entry:"index.html",title:"OpenClaw",width:480,height:720,min_width:360,min_height:480,open_command:"open"}]，capabilities ["ui","toast"]（ui.post + toast；网络/fs 由进程直连,不经 host），activation ["onCommand:open","onStartupFinished"?——否，UI 触发 connect，用 onCommand:open]。menus? v1 无菜单（tray only）——v2 加一个 File 或 Window 菜单项 open，或保留 tray（tray 迁移复杂，①期 tray 硬编码；②b 加一个菜单项 open 打开窗口，tray 留到④）。
- [ ] Step 3: crate 单测（协议 HMAC、config/devices 读写往返、on_ui_request 分派 echo）。
- [ ] Step 4: `cargo test -p notemd-openclaw`。Commit `feat(plugin-v2): openclaw plugin backend crate (UDS/relay/pair moved off tauri)`。

---

### Task 5: openclaw 插件 UI

**Files:** Create `plugins-src/openclaw/`（Vite 项目：拷 chat-app.svelte + components/chat + lib/openclaw，改桥接）

- [ ] Step 1: 脚手架 Vite+Svelte（同 roam-import 模式，base './'，dist→ui/）。加进 pnpm-workspace（plugins-src/* 已含）。
- [ ] Step 2: 移植 UI（拷贝 v1）：`commands.ts` 的 `invoke('openclaw_x', args)` → `notemd.request('plugin.x', args)`；`listen('openclaw://frame', cb)` → `notemd.onMessage(m => { if (m.kind==='frame') cb(m.data) })`（onMessage 收所有 kind，按 kind 分派 frame/status/error/pending-claim）；i18n 本地化（~5 键内联）；color-scheme。
- [ ] Step 3: manifest 拷进 plugins-src/openclaw（Task 4 的 manifest.v2.json 引用 ui/ = 本项目 dist）。
- [ ] Step 4: dev-install-plugin.sh 加 openclaw 分支（构建 backend crate 双架构 bin + UI dist → 安装树）。
- [ ] Step 5: `pnpm --filter openclaw-plugin check && build` + 全量回归。Commit `feat(plugin-v2): openclaw plugin UI (bridge-based, streaming via onMessage)`。

---

### Task 6: spec 回写 + 多轮 review

- [ ] Step 1: spec §20「实施记录（子项目②b）」：双向窗口通道（ui.request 转发 + host.ui.post，capability `ui`）；openclaw 后端进插件进程（native 全权限直连网络/fs，config/devices 存 data_dir）；UI 桥接 onMessage 多 kind 分派；tray 迁移留④；④退役清单加 openclaw v1（src/chat-*、src/lib/openclaw、src-tauri/src/openclaw、show_chat_window、tray-openclaw、chat.html、capabilities "chat"、tokio-tungstenite 等 deps 若 v1 删净可从 src-tauri 移除）。
- [ ] Step 2: 全量回归 + 三视角 review（执行/安全[新 ui 通道:仅本插件窗口可转发、host.ui.post 只推自己窗口]/集成[streaming 正确性、$activate 竞态、flag-off]）→ 修复轮收敛。
- [ ] Step 3: Commit + 汇报。

---

## Self-Review 记录

- **Spec 覆盖**：§4.4 的 ui.message/host.ui.post（T1/T2 以 ui.request/host.ui.post 实现，命名对齐记 T6）、§14 openclaw 迁移（T4/T5）。
- **占位符**：config/devices 存 data_dir 的一次性迁移（T4 Step1 决策明确）；tray 迁移延④（明确）；fixture bin 构建手法（T3 Step1 参照 md2pdf v2 CARGO_BIN_EXE）。
- **类型一致性**：UiRequestParams/UiPostParams（T1）↔ on_ui_request/ui_post（SDK T1）↔ ui_rpc forward/make_sink host.ui.post（T2）三处一致；capability `ui` 贯穿 T2/T4。
- **风险**：streaming 背压（UI 渲染慢于 frame）——①期不做背压，记 T6；$activate 与 window build 竞态（T2 Step4 先激活后建窗？——build 窗口后激活即可，reader 推送时窗口已在，push_to_window 找不到窗口则静默丢弃，可接受）；插件进程崩溃重启后 UDS/relay 重连——依赖 v1 重连逻辑随搬，crash 熔断可能与重连交互（记 T6 观察）。
