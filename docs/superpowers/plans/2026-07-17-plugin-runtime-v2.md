# 子项目①：插件运行时 v2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 v2 插件运行时（长驻子进程 + NDJSON JSON-RPC 2.0、sidex 生命周期语义、capability 执法、protocol 契约单源、Rust SDK），并把 md2pdf 迁移为第一个 v2 插件——全程隐藏在内部 flag 之后，不影响现有用户。

**Architecture:** 三个新 crate（`plugin-protocol` 契约单源 → schemars 生成 JSON Schema → 生成 TS 类型；`notemd-plugin-sdk` 封装协议循环；md2pdf 增加 v2 服务二进制）。src-tauri 新增 `plugin_runtime` 模块（发现/state.json/进程监督/生命周期状态机/host API 分发），与 v1 one-shot 系统并存，经 **adapter 把 v2 manifest 映射为 v1 `PluginManifest` 形状**复用全部既有菜单/CLI/前端收集机制。md2pdf v2 服务进程对每次导出**派生兄弟 v1 二进制**完成渲染（WKWebView 管线要求主线程 + `NSApplication.run()` 生命周期，长驻进程内反复 run/stop 有风险；派生模式 100% 复用已验证路径，先例：sidex 的 rust-language-extension 包裹 rust-analyzer）。

**Tech Stack:** Rust（tokio/serde/schemars/jsonschema）、Tauri v2、TypeScript（json-schema-to-typescript 生成）、shell fixture 集成测试（沿用 `src-tauri/tests/fixtures/` 模式）。

**Spec:** `docs/superpowers/specs/2026-07-16-plugin-system-v2-design.md` §1-§6、§14 第①期。

**记录在案的两处 spec 偏离（Task 13 回写）：**
1. §5 的 `host.renderer.html` 拉模式**推迟**（非取消）：①期沿用执行时推模式（前端在 `plugin_v2_execute` 的 context 里注入 `rendered_html`，与 v1 完全一致）。拉模式需要 Rust→webview 渲染 RPC 整套机制，①期唯一消费者 md2pdf 用推模式即可全覆盖（YAGNI）。
2. §5 "TS 类型为源"调整为 **`plugin-protocol` Rust crate 为源**（schemars 生成 Schema → 生成 TS）：宿主与 SDK 都是 Rust，Rust 为源消除最大的一致性面；§2 "JSON Schema 单源校验"语义不变。
3. §4.2 内存监控（512MiB 告警）推迟到子项目③（徽标需要市场窗口承载）。

**Flag：** settings.json 顶层 `"plugins_v2.enabled": true` 或环境变量 `NOTEMD_PLUGINS_V2=1`（读取模式仿 `read_saved_locale`，lib.rs:1327-1345；env 先例 `MDEDITOR_KEYCHAIN_STUB_DIR`）。默认关。

**工作区纪律：** 在 worktree `.claude/worktrees/core-ize-six-plugins`（分支 worktree-core-ize-six-plugins）上继续堆叠。每次提交精确 `git add` 列出的文件，绝不 `add -A`。

---

## 文件结构总览

```
plugin-protocol/                    # 新 crate：契约单源
  Cargo.toml
  src/lib.rs                        # ManifestV2 + JSON-RPC 信封 + 方法负载类型（serde+schemars）
  src/bin/gen-schema.rs             # 生成 protocol/schema/*.json
protocol/schema/                    # 生成产物（提交入库，CI diff 校验）
  manifest-v2.schema.json
  rpc.schema.json
notemd-plugin-sdk/                  # 新 crate：插件作者 SDK
  Cargo.toml
  src/lib.rs                        # NotemdPlugin trait + serve() 协议循环 + host 客户端
md2pdf/
  src/bin/v2.rs                     # 新：v2 服务二进制（SDK，导出时派生兄弟 v1 bin）
  manifest.v2.json                  # 新：v2 manifest
src-tauri/src/plugin_runtime/
  mod.rs                            # init(flag 门控)、STATE、对外入口
  state.rs                          # <app_data>/plugins/state.json 读写
  discovery.rs                      # 扫描 <app_data>/plugins/<id>/current/manifest.json + 校验
  process.rs                        # PluginProcess：spawn/握手/NDJSON RPC/超时/stderr→日志/优雅关停
  lifecycle.rs                      # 状态机 + 激活事件匹配 + 崩溃退避熔断 + 空闲关停
  host_api.rs                       # host.* 方法分发 + capability 门 + plugin-toast 事件
  adapter.rs                        # ManifestV2 → v1 PluginManifest（菜单/CLI/前端复用）
  commands.rs                       # tauri 命令：get_plugin_manifests_v2 / plugin_v2_execute / …
src-tauri/tests/
  plugin_runtime_integration.rs     # 集成测试
  fixtures/v2/ok.sh|slow.sh|crash-activate.sh|crash-loop.sh|idle.sh   # shell fixture
scripts/
  gen-plugin-protocol.sh            # cargo gen-schema + json2ts + （CI 模式）git diff 校验
  build-md2pdf-v2.sh                # 双架构构建 v2 包内容
  dev-install-plugin.sh             # 开发期安装到 <app_data>/plugins/
src/lib/plugins/v2/
  protocol.gen.ts                   # 生成的 TS 类型（提交入库）
```

关键既有锚点（侦察核实）：v1 `PluginManifest`/STATE/`collect_top_menu_items` 在 `src-tauri/src/plugin_host.rs:44-71,156-164,469-490`；`invoke_handler` 注册在 `src-tauri/src/lib.rs:843-948`；`plugin_host::init` 调用在 lib.rs:984；菜单构建 lib.rs:1005-1009；`parsePluginMenuId` 以 `:` 分隔（`menu-registry.ts:29-35`，含点的 id 如 `notemd.md2pdf` 安全）；CLI 注入点 `append_core_cli_stubs`（`runner.rs:148-159`）；`dispatchPlugin` 泛型路径 `App.svelte:341-415`；fixture 模式 `src-tauri/tests/plugin_host_integration.rs:4-15`。

---

### Task 1: `plugin-protocol` crate——契约类型 + Schema 生成

**Files:**
- Create: `plugin-protocol/Cargo.toml`、`plugin-protocol/src/lib.rs`、`plugin-protocol/src/bin/gen-schema.rs`
- Create（生成后提交）: `protocol/schema/manifest-v2.schema.json`、`protocol/schema/rpc.schema.json`

- [ ] **Step 1: Cargo.toml**

```toml
[package]
name = "plugin-protocol"
version = "0.1.0"
edition = "2021"
description = "note.md plugin system v2 wire contract — single source of truth"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = "0.8"
semver = "1"

[dev-dependencies]
jsonschema = "0.18"
```

- [ ] **Step 2: src/lib.rs——manifest v2 与 JSON-RPC 类型（spec §2/§4.4/§5 的机器可读形式）**

```rust
//! Plugin system v2 wire contract. THE single source of truth:
//! `gen-schema` emits JSON Schemas (protocol/schema/), from which the TS
//! types (src/lib/plugins/v2/protocol.gen.ts) are generated. CI diffs both.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 2;

// ── Manifest v2 (spec §2) ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ManifestV2 {
    pub manifest_version: u32,              // 必须 == 2
    pub id: String,                         // publisher.name
    pub name: String,
    pub version: String,                    // semver
    pub kind: PluginKind,                   // 本期仅 native
    pub engines: Engines,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub binary: std::collections::BTreeMap<String, String>, // target triple → 包内相对路径
    #[serde(default)]
    pub ui: Option<String>,                 // ②期使用；本期仅透传
    pub activation: Activation,
    #[serde(default)]
    pub contributes: Contributes,
    pub capabilities: Vec<String>,          // 见 host_api::method_capability
    #[serde(default)]
    pub request_timeout_seconds: Option<u64>, // 默认 30，上限 300
    #[serde(default)]
    pub idle_shutdown_seconds: Option<u64>,
    #[serde(default)]
    pub i18n: Option<serde_json::Value>,    // 结构同 v1 PluginI18n，宿主透传不解释
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind { Native, Wasm }       // wasm 仅保留字面量（spec §15）

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Engines { pub notemd: String }  // semver range，如 ">=6.717.0"

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Activation { pub events: Vec<String> }
// 合法事件（spec §4.3）：`*`、`onStartupFinished`、`onCommand:<c>`、`onCli:<sub>`、`onFileType:<ext>`

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Contributes {
    pub menus: Vec<serde_json::Value>,          // 语义同 v1 MenuEntry；宿主经 adapter 透传
    pub context_menus: Vec<serde_json::Value>,  // 语义同 v1 ContextMenuEntry
    pub windows: Vec<serde_json::Value>,        // ②期消费；本期校验为数组即可
    pub custom_editors: Vec<serde_json::Value>, // ④期消费
    pub settings: Option<serde_json::Value>,    // 语义同 v1 settings
    pub cli: Vec<serde_json::Value>,            // 语义同 v1 CliEntry
}

// ── JSON-RPC 2.0 信封（NDJSON，一行一条）────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcRequest {
    pub jsonrpc: String,                    // "2.0"
    pub id: Option<u64>,                    // None ⇒ notification
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcError { pub code: i64, pub message: String }

pub const ERR_CAPABILITY_DENIED: i64 = -32001;
pub const ERR_METHOD_NOT_FOUND: i64 = -32601;

// ── 宿主→插件方法负载（spec §4.4）───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InitializeParams {
    pub protocol_version: u32,
    pub host_version: String,
    pub locale: String,
    pub theme: String,
    pub plugin_root: String,                // 插件安装目录（current/）
    pub data_dir: String,                   // <app_data>/plugin_data/<id>/
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActivateParams { pub event: String }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExecuteCommandParams {
    pub command: String,
    pub context: serde_json::Value,         // 形状与 v1 PluginRequest.context 一致（含 tab / rendered_html / output_path / cli args+flags）
}

// ── 插件→宿主方法（host.*；capability 映射见 host_api）──────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToastParams {
    pub level: String,                      // success|info|warn|error
    pub message: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LogParams { pub message: String }

// ── Manifest 校验 ───────────────────────────────────────────────────────

pub fn validate_manifest(m: &ManifestV2, host_version: &str) -> Result<(), String> {
    if m.manifest_version != 2 { return Err(format!("manifest_version {} != 2", m.manifest_version)); }
    let id_re_ok = {
        let parts: Vec<&str> = m.id.split('.').collect();
        parts.len() == 2 && parts.iter().all(|p| !p.is_empty()
            && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
    };
    if !id_re_ok { return Err(format!("id '{}' must be publisher.name ([a-z0-9-])", m.id)); }
    semver::Version::parse(&m.version).map_err(|e| format!("version: {e}"))?;
    let req = semver::VersionReq::parse(&m.engines.notemd).map_err(|e| format!("engines.notemd: {e}"))?;
    let host = semver::Version::parse(host_version).map_err(|e| format!("host version: {e}"))?;
    if !req.matches(&host) { return Err(format!("requires notemd {}, host is {host}", m.engines.notemd)); }
    if m.kind == PluginKind::Wasm { return Err("kind 'wasm' is reserved, not yet supported".into()); }
    for ev in &m.activation.events {
        let ok = ev == "*" || ev == "onStartupFinished"
            || ev.strip_prefix("onCommand:").map_or(false, |s| !s.is_empty())
            || ev.strip_prefix("onCli:").map_or(false, |s| !s.is_empty())
            || ev.strip_prefix("onFileType:").map_or(false, |s| !s.is_empty());
        if !ok { return Err(format!("unknown activation event '{ev}'")); }
    }
    Ok(())
}
```

- [ ] **Step 3: src/bin/gen-schema.rs**

```rust
use schemars::schema_for;
use std::{fs, path::Path};

fn main() {
    // 输出目录：仓库根 protocol/schema/（crate 在根目录，向上一级）
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/schema");
    fs::create_dir_all(&out).unwrap();
    let manifest = schema_for!(plugin_protocol::ManifestV2);
    fs::write(out.join("manifest-v2.schema.json"),
        serde_json::to_string_pretty(&manifest).unwrap() + "\n").unwrap();
    // rpc.schema.json：信封 + 全部负载类型合并为 definitions
    let mut rpc = serde_json::json!({ "$defs": {} });
    macro_rules! add { ($t:ty) => {{
        let s = schema_for!($t);
        rpc["$defs"][stringify!($t)] = serde_json::to_value(s).unwrap();
    }}}
    add!(plugin_protocol::RpcRequest); add!(plugin_protocol::RpcResponse);
    add!(plugin_protocol::RpcError); add!(plugin_protocol::InitializeParams);
    add!(plugin_protocol::ActivateParams); add!(plugin_protocol::ExecuteCommandParams);
    add!(plugin_protocol::ToastParams); add!(plugin_protocol::LogParams);
    fs::write(out.join("rpc.schema.json"),
        serde_json::to_string_pretty(&rpc).unwrap() + "\n").unwrap();
    println!("schemas written to {}", out.display());
}
```

- [ ] **Step 4: 单元测试（lib.rs 底部 `#[cfg(test)]`）**——validate_manifest 的通过/拒绝各用例：合法样例（照抄 Task 11 的 md2pdf manifest.v2.json 内容）、manifest_version=1 拒、id 无点拒、engines 不满足拒、wasm 拒、未知激活事件拒；RpcRequest/Response serde 往返；生成 schema 后用 `jsonschema` crate 校验合法样例通过、非法样例失败。

- [ ] **Step 5: 运行** `cargo test --manifest-path plugin-protocol/Cargo.toml` → PASS；`cargo run --manifest-path plugin-protocol/Cargo.toml --bin gen-schema` → 生成两个 schema 文件。

- [ ] **Step 6: Commit**

```bash
git add plugin-protocol/ protocol/schema/
git commit -m "feat(plugin-v2): plugin-protocol crate — manifest v2 + JSON-RPC contract, schema generation"
```

---

### Task 2: TS 类型生成 + CI 校验脚本

**Files:**
- Create: `scripts/gen-plugin-protocol.sh`、`src/lib/plugins/v2/protocol.gen.ts`（生成）
- Modify: `package.json`（devDep `json-schema-to-typescript` + scripts）

- [ ] **Step 1:** `pnpm add -D json-schema-to-typescript`

- [ ] **Step 2: scripts/gen-plugin-protocol.sh**

```bash
#!/usr/bin/env bash
# Regenerate the plugin v2 contract artifacts from the Rust source of truth.
# --check: fail if regeneration produces a diff (CI mode).
set -euo pipefail
cd "$(dirname "$0")/.."

cargo run --quiet --manifest-path plugin-protocol/Cargo.toml --bin gen-schema

mkdir -p src/lib/plugins/v2
{
  echo "/* AUTO-GENERATED by scripts/gen-plugin-protocol.sh — DO NOT EDIT."
  echo "   Source of truth: plugin-protocol/src/lib.rs */"
  npx json2ts --no-additionalProperties protocol/schema/manifest-v2.schema.json
  npx json2ts --no-additionalProperties protocol/schema/rpc.schema.json
} > src/lib/plugins/v2/protocol.gen.ts

if [[ "${1:-}" == "--check" ]]; then
  git diff --exit-code protocol/schema src/lib/plugins/v2/protocol.gen.ts \
    || { echo "❌ protocol artifacts out of date — run scripts/gen-plugin-protocol.sh"; exit 1; }
fi
echo "✓ protocol artifacts up to date"
```

- [ ] **Step 3: package.json scripts** 增加 `"gen:protocol": "bash scripts/gen-plugin-protocol.sh"` 与 `"check:protocol": "bash scripts/gen-plugin-protocol.sh --check"`。

- [ ] **Step 4:** 运行 `pnpm gen:protocol` 生成 `protocol.gen.ts`；`pnpm check` 确认 0 错误（生成文件参与类型检查）；`pnpm check:protocol` → ✓。

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-plugin-protocol.sh src/lib/plugins/v2/protocol.gen.ts package.json pnpm-lock.yaml
git commit -m "feat(plugin-v2): generated TS protocol types + drift check script"
```

---

### Task 3: `notemd-plugin-sdk` crate

**Files:**
- Create: `notemd-plugin-sdk/Cargo.toml`、`notemd-plugin-sdk/src/lib.rs`

- [ ] **Step 1: Cargo.toml**

```toml
[package]
name = "notemd-plugin-sdk"
version = "0.1.0"
edition = "2021"
description = "SDK for note.md v2 plugins: NDJSON JSON-RPC loop + host client"

[dependencies]
plugin-protocol = { path = "../plugin-protocol" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["io-std", "io-util", "macros", "rt", "sync", "time"] }

[dev-dependencies]
tokio = { version = "1", features = ["full"] }
```

- [ ] **Step 2: src/lib.rs——trait + serve 循环 + host 客户端**

```rust
//! note.md v2 plugin SDK. Implement [`NotemdPlugin`], call [`serve`] from main.
//! Protocol: NDJSON JSON-RPC 2.0 over stdio (stdout is protocol-only; log via
//! `Host::log_*` or stderr, which the host captures to the plugin log file).

use plugin_protocol as proto;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

pub use plugin_protocol::{ExecuteCommandParams, InitializeParams, ToastParams};

/// 插件实现面（①期最小集；后续期次按 spec §4.4 增补方法）。
pub trait NotemdPlugin: Send + 'static {
    fn activate(&mut self, host: &Host, params: &proto::ActivateParams) -> Result<(), String>;
    fn deactivate(&mut self, host: &Host);
    fn execute_command(&mut self, host: &Host, params: &proto::ExecuteCommandParams)
        -> Result<Value, String>;
    /// $initialize 到达时回调（可选覆写；默认记录 host 上下文即可）。
    fn initialize(&mut self, _host: &Host, _params: &proto::InitializeParams) {}
}

/// 插件→宿主调用句柄。克隆廉价；内部经 channel 写 stdout。
#[derive(Clone)]
pub struct Host {
    tx: mpsc::UnboundedSender<OutMsg>,
    next_id: std::sync::Arc<AtomicU64>,
    pending: std::sync::Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<proto::RpcResponse>>>>,
}

enum OutMsg { Line(String) }

impl Host {
    pub fn log_info(&self, m: &str) { self.notify("host.log.info", json!({"message": m})); }
    pub fn log_warn(&self, m: &str) { self.notify("host.log.warn", json!({"message": m})); }
    pub fn log_error(&self, m: &str) { self.notify("host.log.error", json!({"message": m})); }
    pub fn toast(&self, level: &str, message: &str, detail: Option<&str>) {
        self.notify("host.toast", json!({"level": level, "message": message, "detail": detail}));
    }
    fn notify(&self, method: &str, params: Value) {
        let req = proto::RpcRequest { jsonrpc: "2.0".into(), id: None, method: method.into(), params };
        let _ = self.tx.send(OutMsg::Line(serde_json::to_string(&req).unwrap()));
    }
    /// 需要返回值的宿主调用（①期插件端暂无消费者，保留给后续期次）。
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let req = proto::RpcRequest { jsonrpc: "2.0".into(), id: Some(id), method: method.into(), params };
        self.tx.send(OutMsg::Line(serde_json::to_string(&req).unwrap())).map_err(|e| e.to_string())?;
        let resp = rx.await.map_err(|e| e.to_string())?;
        match (resp.result, resp.error) {
            (Some(v), _) => Ok(v),
            (_, Some(e)) => Err(format!("{}: {}", e.code, e.message)),
            _ => Err("empty response".into()),
        }
    }
}

/// 主循环。从 stdin 读宿主消息，分发给插件实现；stdout 只写协议行。
/// 收到 `$deactivate` 后调用 `deactivate` 并干净退出（进程退出即优雅关停）。
pub async fn serve<P: NotemdPlugin>(plugin: P) {
    serve_io(plugin, tokio::io::stdin(), tokio::io::stdout()).await;
}

/// 可注入 IO 的实现，供单元测试用内存管道驱动。
pub async fn serve_io<P, R, W>(mut plugin: P, reader: R, writer: W)
where P: NotemdPlugin, R: tokio::io::AsyncRead + Unpin + Send + 'static, W: AsyncWrite + Unpin + Send + 'static {
    let (tx, mut rx) = mpsc::unbounded_channel::<OutMsg>();
    let host = Host { tx, next_id: Default::default(), pending: Default::default() };
    // writer task：串行化 stdout 写。
    let writer_task = tokio::spawn(async move {
        let mut w = writer;
        while let Some(OutMsg::Line(l)) = rx.recv().await {
            if w.write_all(l.as_bytes()).await.is_err() { break }
            if w.write_all(b"\n").await.is_err() { break }
            let _ = w.flush().await;
        }
    });
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() { continue }
        // 宿主→插件：request；插件 request 的应答：response（路由给 pending）。
        if let Ok(resp) = serde_json::from_str::<proto::RpcResponse>(&line) {
            if resp.result.is_some() || resp.error.is_some() {
                if let Some(tx) = host.pending.lock().await.remove(&resp.id) { let _ = tx.send(resp); }
                continue;
            }
        }
        let req: proto::RpcRequest = match serde_json::from_str(&line) { Ok(r) => r, Err(_) => continue };
        let reply = |id: u64, result: Result<Value, String>| {
            let resp = match result {
                Ok(v) => proto::RpcResponse { jsonrpc: "2.0".into(), id, result: Some(v), error: None },
                Err(m) => proto::RpcResponse { jsonrpc: "2.0".into(), id,
                    result: None, error: Some(proto::RpcError { code: -32000, message: m }) },
            };
            OutMsg::Line(serde_json::to_string(&resp).unwrap())
        };
        match req.method.as_str() {
            "$initialize" => {
                if let Ok(p) = serde_json::from_value(req.params) { plugin.initialize(&host, &p); }
                if let Some(id) = req.id { let _ = host.tx.send(reply(id, Ok(json!({"ok": true})))); }
            }
            "$activate" => {
                let r = serde_json::from_value(req.params).map_err(|e| e.to_string())
                    .and_then(|p| plugin.activate(&host, &p)).map(|_| json!({"ok": true}));
                if let Some(id) = req.id { let _ = host.tx.send(reply(id, r)); }
            }
            "$deactivate" => {
                plugin.deactivate(&host);
                if let Some(id) = req.id { let _ = host.tx.send(reply(id, Ok(json!({"ok": true})))); }
                break; // 干净退出
            }
            "command.execute" => {
                let r = serde_json::from_value(req.params).map_err(|e| e.to_string())
                    .and_then(|p| plugin.execute_command(&host, &p));
                if let Some(id) = req.id { let _ = host.tx.send(reply(id, r)); }
            }
            other => {
                if let Some(id) = req.id {
                    let resp = proto::RpcResponse { jsonrpc: "2.0".into(), id, result: None,
                        error: Some(proto::RpcError { code: proto::ERR_METHOD_NOT_FOUND,
                            message: format!("unknown method {other}") }) };
                    let _ = host.tx.send(OutMsg::Line(serde_json::to_string(&resp).unwrap()));
                }
            }
        }
    }
    drop(host);
    let _ = writer_task.await;
}
```

- [ ] **Step 3: 单元测试**（`tokio::io::duplex` 内存管道驱动 `serve_io`）：① $initialize→{ok:true}；② $activate 成功/失败（error 上抛）；③ command.execute 返回 result；④ 插件在 execute 里调 host.toast → 写出一条 notification（无 id）；⑤ $deactivate → 回应后循环退出；⑥ 未知方法 → -32601。测试用一个记录调用的 `TestPlugin`。

- [ ] **Step 4:** `cargo test --manifest-path notemd-plugin-sdk/Cargo.toml` → PASS。

- [ ] **Step 5: Commit**

```bash
git add notemd-plugin-sdk/
git commit -m "feat(plugin-v2): notemd-plugin-sdk — NotemdPlugin trait + NDJSON JSON-RPC serve loop + host client"
```

---

### Task 4: 运行时脚手架——flag/state.json/发现与校验

**Files:**
- Create: `src-tauri/src/plugin_runtime/mod.rs`、`state.rs`、`discovery.rs`
- Modify: `src-tauri/Cargo.toml`（加 `plugin-protocol = { path = "../plugin-protocol" }`、`semver = "1"`）、`src-tauri/src/lib.rs`（mod 声明 + init 调用）

- [ ] **Step 1: mod.rs——flag 与全局 STATE**

```rust
//! Plugin runtime v2 (spec §3-§5). Coexists with the v1 one-shot host until
//! all first-batch plugins migrate (子项目④). Everything is gated behind
//! `plugins_v2.enabled` in settings.json or NOTEMD_PLUGINS_V2=1.

pub mod adapter;
pub mod commands;
pub mod discovery;
pub mod host_api;
pub mod lifecycle;
pub mod process;
pub mod state;

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

pub struct RuntimeState {
    pub enabled_flag: bool,
    /// id → (manifest, install_dir<current/>)
    pub plugins: HashMap<String, (plugin_protocol::ManifestV2, std::path::PathBuf)>,
}

pub static STATE: LazyLock<RwLock<RuntimeState>> =
    LazyLock::new(|| RwLock::new(RuntimeState { enabled_flag: false, plugins: HashMap::new() }));

pub fn v2_flag_enabled<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    if std::env::var("NOTEMD_PLUGINS_V2").map_or(false, |v| v == "1") { return true }
    // 读法仿 read_saved_locale（lib.rs:1327-1345）
    let Ok(dir) = tauri::Manager::path(app).app_config_dir() else { return false };
    let Ok(text) = std::fs::read_to_string(dir.join("settings.json")) else { return false };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    json.get("plugins_v2.enabled").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// setup 阶段调用（plugin_host::init 之后）。flag 关 ⇒ 空 STATE，零成本。
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let flag = v2_flag_enabled(app);
    let mut st = STATE.write().unwrap();
    st.enabled_flag = flag;
    if !flag { return }
    let host_version = app.package_info().version.to_string();
    match discovery::scan(app, &host_version) {
        Ok(map) => st.plugins = map,
        Err(e) => eprintln!("[plugin_runtime] scan failed: {e}"),
    }
    eprintln!("[plugin_runtime] v2 enabled, {} plugin(s)", st.plugins.len());
}
```

- [ ] **Step 2: state.rs——`<app_data>/plugins/state.json`（spec §3 唯一事实源）**

```rust
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::{Path, PathBuf}};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct InstallState { #[serde(default)] pub installed: BTreeMap<String, InstalledPlugin> }

#[derive(Debug, Serialize, Deserialize)]
pub struct InstalledPlugin { pub version: String, pub enabled: bool }

pub fn plugins_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    tauri::Manager::path(app).app_data_dir().ok().map(|d| d.join("plugins"))
}

pub fn load(root: &Path) -> InstallState {
    std::fs::read(root.join("state.json")).ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(root: &Path, s: &InstallState) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let tmp = root.join("state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, root.join("state.json")).map_err(|e| e.to_string())
}
```

- [ ] **Step 3: discovery.rs**——读 state.json，对每个 `enabled` 条目加载 `<root>/<id>/current/manifest.json`，`plugin_protocol::validate_manifest(&m, host_version)` + `m.id` 与目录名一致性校验 + 当前架构的 `binary` 键存在且文件存在（键 = `std::env::consts::ARCH` 映射：`aarch64`→`aarch64-apple-darwin`、`x86_64`→`x86_64-apple-darwin`）。任何失败：eprintln 记录并跳过该插件（拒载不拖累其他）。返回 `HashMap<String,(ManifestV2, PathBuf)>`（PathBuf = current/ 绝对路径）。

- [ ] **Step 4: 单元测试**（state.rs/discovery.rs 内 `#[cfg(test)]`，tempdir 构造安装树）：state 读写往返 + 原子写；discovery 正常加载、坏 JSON 跳过、engines 不满足跳过、缺架构二进制跳过、disabled 条目跳过。discovery 的 scan 拆一个纯函数 `scan_root(root: &Path, host_version: &str)` 以便脱离 AppHandle 测试（`scan(app,…)` 是对它的薄包装）。

- [ ] **Step 5: lib.rs 接线**——`mod plugin_runtime;` 声明（挨着 `mod plugin_host;`）；`plugin_host::init(&app.handle());` 之后一行加 `plugin_runtime::init(&app.handle());`（lib.rs:984 附近）。iOS：整个模块 `#[cfg(not(target_os = "ios"))]` 门控（与 cli 模块同款）。

- [ ] **Step 6:** `cargo test --manifest-path src-tauri/Cargo.toml plugin_runtime` → PASS；`cargo check` 全绿。

- [ ] **Step 7: Commit**

```bash
git add plugin-protocol/Cargo.toml src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/plugin_runtime/
git commit -m "feat(plugin-v2): runtime scaffold — feature flag, state.json, discovery with validation"
```

（plugin-protocol/Cargo.toml 仅在需要加 feature 时出现在此提交，否则删去。）

---

### Task 5: process.rs——进程通道（spawn/握手/RPC/超时/日志/关停）

**Files:**
- Create: `src-tauri/src/plugin_runtime/process.rs`
- Create: `src-tauri/tests/fixtures/v2/ok.sh`、`slow.sh`、`crash-activate.sh`
- Test: `src-tauri/tests/plugin_runtime_integration.rs`

- [ ] **Step 1: fixtures**（`chmod +x`；模式沿用 `tests/fixtures/echo.sh`）

`ok.sh`——回应 initialize/activate/execute，execute 时先发一条 toast notification：

```bash
#!/bin/sh
# Minimal v2 plugin: NDJSON JSON-RPC over stdio.
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"$initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"$activate"'*)   printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id" ;;
    *'"command.execute"'*)
      printf '{"jsonrpc":"2.0","method":"host.toast","params":{"level":"success","message":"hi"}}\n'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"echo":true}}\n' "$id" ;;
    *'"$deactivate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\n' "$id"; exit 0 ;;
  esac
done
```

`slow.sh`——initialize/activate 正常，execute 收到后 sleep 60（测单请求超时不杀进程）；`crash-activate.sh`——initialize 正常，收到 $activate 直接 `exit 1`（各自照 ok.sh 结构删改，此处不重复全文，实现时以 ok.sh 为模板改对应 case）。

- [ ] **Step 2: process.rs 核心**

```rust
//! One live v2 plugin process: NDJSON JSON-RPC channel + supervision hooks.

use plugin_protocol as proto;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

pub const DEACTIVATE_GRACE_SECS: u64 = 5;   // spec §4.2
pub const DEFAULT_REQUEST_TIMEOUT: u64 = 30; // spec §2
pub const MAX_REQUEST_TIMEOUT: u64 = 300;

/// 宿主侧回调：插件发来的 host.* 请求/通知（由 host_api 处理）。
pub type HostSink = Arc<dyn Fn(proto::RpcRequest) -> Option<proto::RpcResponse> + Send + Sync>;

pub struct PluginProcess {
    child: Mutex<Child>,
    stdin: Mutex<tokio::process::ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<proto::RpcResponse>>>>,
    next_id: AtomicU64,
    pub request_timeout: std::time::Duration,
    /// 读循环任务与进程退出监视由 lifecycle 持有的 JoinHandle 管理。
    pub reader_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl PluginProcess {
    /// spawn + 启动读循环。stderr 追加写入 `<log_dir>/<plugin_id>.log`（上限滚动 5MB：超限时 rename 为 .1 重开）。
    pub async fn spawn(binary: &Path, plugin_id: &str, log_dir: &Path,
                       timeout_secs: u64, host_sink: HostSink) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(binary);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let proc = Arc::new(Self {
            child: Mutex::new(child), stdin: Mutex::new(stdin),
            pending: Default::default(), next_id: AtomicU64::new(1),
            request_timeout: std::time::Duration::from_secs(timeout_secs.clamp(1, MAX_REQUEST_TIMEOUT)),
            reader_task: Mutex::new(None),
        });
        // stderr → 日志文件
        {
            let log_path = log_dir.join(format!("{plugin_id}.log"));
            let _ = std::fs::create_dir_all(log_dir);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    append_log_line(&log_path, &l);
                }
            });
        }
        // stdout 读循环：response → pending；request/notification → host_sink，
        // 有 id 的把 host_sink 的应答写回插件 stdin。
        {
            let me = proc.clone();
            let task = tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() { continue }
                    if let Ok(resp) = serde_json::from_str::<proto::RpcResponse>(&line) {
                        if resp.result.is_some() || resp.error.is_some() {
                            if let Some(tx) = me.pending.lock().await.remove(&resp.id) { let _ = tx.send(resp); }
                            continue;
                        }
                    }
                    if let Ok(req) = serde_json::from_str::<proto::RpcRequest>(&line) {
                        if let Some(resp) = host_sink(req) {
                            let _ = me.write_line(&serde_json::to_string(&resp).unwrap()).await;
                        }
                    }
                }
            });
            *proc.reader_task.lock().await = Some(task);
        }
        Ok(proc)
    }

    async fn write_line(&self, l: &str) -> Result<(), String> {
        let mut w = self.stdin.lock().await;
        w.write_all(l.as_bytes()).await.map_err(|e| e.to_string())?;
        w.write_all(b"\n").await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
    }

    /// 带超时的宿主→插件 request。超时只 fail 该请求（spec §12），不杀进程。
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let req = proto::RpcRequest { jsonrpc: "2.0".into(), id: Some(id), method: method.into(), params };
        self.write_line(&serde_json::to_string(&req).unwrap()).await?;
        match tokio::time::timeout(self.request_timeout, rx).await {
            Err(_) => { self.pending.lock().await.remove(&id); Err(format!("timeout:{}", self.request_timeout.as_secs())) }
            Ok(Err(_)) => Err("channel closed (process died?)".into()),
            Ok(Ok(resp)) => match (resp.result, resp.error) {
                (Some(v), _) => Ok(v),
                (_, Some(e)) => Err(format!("plugin error {}: {}", e.code, e.message)),
                _ => Err("empty response".into()),
            },
        }
    }

    /// $deactivate → 等 5s 优雅退出 → 超时 kill。返回是否优雅。
    pub async fn shutdown(&self) -> bool {
        let graceful = tokio::time::timeout(
            std::time::Duration::from_secs(DEACTIVATE_GRACE_SECS),
            self.request("$deactivate", Value::Null),
        ).await.is_ok();
        let mut child = self.child.lock().await;
        if !graceful { let _ = child.start_kill(); }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
        graceful
    }

    /// 非阻塞检查进程是否已退出（供 lifecycle 崩溃监督轮询/等待）。
    pub async fn try_wait_exit(&self) -> Option<i32> {
        self.child.lock().await.try_wait().ok().flatten().and_then(|s| s.code())
    }
}

fn append_log_line(path: &Path, line: &str) {
    use std::io::Write;
    const MAX: u64 = 5 * 1024 * 1024;
    if std::fs::metadata(path).map(|m| m.len() > MAX).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// 握手 + 激活（lifecycle 调用）。
pub async fn initialize_and_activate(proc: &PluginProcess, init: &proto::InitializeParams, event: &str)
    -> Result<(), String> {
    proc.request("$initialize", serde_json::to_value(init).unwrap()).await
        .map_err(|e| format!("$initialize: {e}"))?;
    proc.request("$activate", serde_json::json!({ "event": event })).await
        .map_err(|e| format!("$activate: {e}"))?;
    Ok(())
}
```

- [ ] **Step 3: 集成测试**（`plugin_runtime_integration.rs`，fixture 路径 helper 仿 `plugin_host_integration.rs:4-6`）：① ok.sh：spawn→initialize_and_activate 成功→`request("command.execute",…)` 返回 `{echo:true}` 且 host_sink 收到一条 `host.toast`→shutdown 优雅=true；② slow.sh（timeout_secs=1）：execute 返回 `timeout:1`，进程仍在（再发 $deactivate 成功）；③ crash-activate.sh：initialize_and_activate 返回 Err，try_wait_exit 观察到退出码 1。

- [ ] **Step 4:** `cargo test --manifest-path src-tauri/Cargo.toml --test plugin_runtime_integration` → PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin_runtime/process.rs src-tauri/tests/plugin_runtime_integration.rs src-tauri/tests/fixtures/v2/
git commit -m "feat(plugin-v2): process channel — spawn/handshake/RPC timeout/stderr log/graceful shutdown"
```

---

### Task 6: lifecycle.rs——状态机、激活事件、崩溃熔断、空闲关停

**Files:**
- Create: `src-tauri/src/plugin_runtime/lifecycle.rs`
- Create: `src-tauri/tests/fixtures/v2/crash-loop.sh`（initialize 后立刻 exit 1）
- Test: 追加到 `src-tauri/tests/plugin_runtime_integration.rs`

- [ ] **Step 1: 激活事件匹配（纯函数）**

```rust
/// spec §4.3 五类事件。trigger 形如 "startup" / "command:export" / "cli:pdf" / "filetype:.base"。
pub fn matches_activation(events: &[String], trigger: &Trigger) -> bool {
    events.iter().any(|ev| match (ev.as_str(), trigger) {
        ("*", _) => true,
        ("onStartupFinished", Trigger::Startup) => true,
        (e, Trigger::Command(c)) => e.strip_prefix("onCommand:") == Some(c.as_str()),
        (e, Trigger::Cli(s)) => e.strip_prefix("onCli:") == Some(s.as_str()),
        (e, Trigger::FileType(x)) => e.strip_prefix("onFileType:") == Some(x.as_str()),
        _ => false,
    })
}

#[derive(Debug, Clone)]
pub enum Trigger { Startup, Command(String), Cli(String), FileType(String) }
```

- [ ] **Step 2: 状态机与监督**——`PluginLifecycle`（每插件一个，`Arc<Mutex<…>>` 存 STATE 旁的运行表 `RUNNING: LazyLock<RwLock<HashMap<String, Arc<PluginLifecycle>>>>`）：

```rust
pub enum Phase { Inactive, Activating, Active(Arc<process::PluginProcess>), Disabled(String) }

pub struct PluginLifecycle {
    pub id: String,
    pub manifest: plugin_protocol::ManifestV2,
    pub install_dir: std::path::PathBuf,
    pub phase: tokio::sync::Mutex<Phase>,
    pub crash_times: std::sync::Mutex<Vec<std::time::Instant>>, // 10 分钟窗口
    pub last_activity: std::sync::Mutex<std::time::Instant>,     // 空闲关停
    /// 测试注入：崩溃重启退避（生产 [0,5,30] 秒）。
    pub backoff_secs: Vec<u64>,
}
```

核心方法（完整实现，此处给语义与签名，实现步骤内联注释必须写明 spec 出处）：
- `ensure_active(self: &Arc<Self>, trigger: &Trigger, app: AppHandle) -> Result<Arc<PluginProcess>, String>`：Active → 直接返回并刷新 last_activity；Inactive/Activating → 串行化激活（Mutex 天然串行，spec §4.2 激活队列语义）：解析当前架构二进制路径 → `process::spawn`（host_sink 来自 host_api::make_sink(id, manifest.capabilities, app)）→ `initialize_and_activate(…, trigger 对应事件名)` → Phase::Active → **启动两个监督任务**：崩溃监视（循环 `try_wait_exit`，每 500ms；观察到非 shutdown 退出 → 记录 crash_times → 窗口内 <3 次 → 按 backoff 等待后自动 `ensure_active(Trigger::Startup)` 重启，≥3 次 → `Phase::Disabled("crash-loop")` + eprintln）与空闲关停（manifest.idle_shutdown_seconds 为 Some 时每 5s 查 last_activity，超时 → `deactivate()`）。Disabled → Err。
- `deactivate(&self)`：Active → `proc.shutdown()` → Inactive（关停前先置 Phase，防崩溃监视误判：用一个 `shutting_down: AtomicBool` 标记）。
- `execute(&self, params: ExecuteCommandParams) -> Result<Value,String>`：`ensure_active` 略过（调用方已确保）→ `proc.request("command.execute", …)` → 刷新 last_activity。
- `startup_activation(app)`：init 后对全部插件跑 `matches_activation(events, Trigger::Startup)`（`*` 与 onStartupFinished 命中）异步激活。

- [ ] **Step 3: 集成测试**：① matches_activation 全事件矩阵（单元）；② crash-loop.sh + backoff_secs=vec![0,0,0]：首次 ensure_active 失败后自动重启 3 次进入 Disabled，再 ensure_active 报 Err("crash-loop")；③ ok.sh + idle_shutdown_seconds=1：激活后 sleep ~2.5s（测试里把空闲轮询间隔注入为 200ms——轮询间隔做成 `PluginLifecycle` 字段默认 5s），Phase 回到 Inactive；再 execute 自动重新激活成功（懒重激活）。

- [ ] **Step 4:** `cargo test --manifest-path src-tauri/Cargo.toml --test plugin_runtime_integration` → PASS（全部旧+新用例）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin_runtime/lifecycle.rs src-tauri/tests/plugin_runtime_integration.rs src-tauri/tests/fixtures/v2/crash-loop.sh
git commit -m "feat(plugin-v2): lifecycle — activation events, crash backoff breaker, idle shutdown"
```

---

### Task 7: host_api.rs——capability 门 + toast/log 分发

**Files:**
- Create: `src-tauri/src/plugin_runtime/host_api.rs`
- Modify: `src/App.svelte`（新增 `plugin-toast` 事件监听）
- Test: `src-tauri/src/plugin_runtime/host_api.rs` 内联单元测试 + 集成测试已有 toast 断言

- [ ] **Step 1: 方法→capability 表与 sink**

```rust
//! Dispatch of plugin→host `host.*` calls with capability enforcement
//! (spec §5). Unauthorized method → JSON-RPC error -32001 capability_denied.

use plugin_protocol as proto;

/// 方法所需 capability；None = 免授权（spec §5 表）。
pub fn method_capability(method: &str) -> Option<&'static str> {
    match method {
        "host.log.info" | "host.log.warn" | "host.log.error" => None,
        "host.toast" => Some("toast"),
        _ => Some("__unknown__"), // 未实现的方法一律拒绝
    }
}

pub fn make_sink<R: tauri::Runtime>(plugin_id: String, capabilities: Vec<String>,
                                    app: tauri::AppHandle<R>, log_dir: std::path::PathBuf)
    -> crate::plugin_runtime::process::HostSink {
    std::sync::Arc::new(move |req: proto::RpcRequest| {
        let reply_err = |id: u64, code: i64, message: String| Some(proto::RpcResponse {
            jsonrpc: "2.0".into(), id, result: None,
            error: Some(proto::RpcError { code, message }),
        });
        let ok = |id: Option<u64>| id.map(|id| proto::RpcResponse {
            jsonrpc: "2.0".into(), id, result: Some(serde_json::json!({"ok": true})), error: None });
        match method_capability(&req.method) {
            Some("__unknown__") => req.id.and_then(|id|
                reply_err(id, proto::ERR_METHOD_NOT_FOUND, format!("unknown method {}", req.method))),
            Some(cap) if !capabilities.iter().any(|c| c == cap) => req.id.and_then(|id|
                reply_err(id, proto::ERR_CAPABILITY_DENIED,
                    format!("method {} requires capability '{cap}'", req.method))),
            _ => match req.method.as_str() {
                m @ ("host.log.info" | "host.log.warn" | "host.log.error") => {
                    if let Ok(p) = serde_json::from_value::<proto::LogParams>(req.params) {
                        let level = m.rsplit('.').next().unwrap_or("info");
                        crate::plugin_runtime::process::append_plugin_log(
                            &log_dir, &plugin_id, level, &p.message);
                    }
                    ok(req.id)
                }
                "host.toast" => {
                    if let Ok(p) = serde_json::from_value::<proto::ToastParams>(req.params) {
                        use tauri::Emitter;
                        let _ = app.emit("plugin-toast", serde_json::json!({
                            "plugin_id": plugin_id, "level": p.level,
                            "message": p.message, "detail": p.detail }));
                    }
                    ok(req.id)
                }
                _ => unreachable!("filtered above"),
            },
        }
    })
}
```

（`append_plugin_log(dir, id, level, msg)`：Task 5 的 `append_log_line` 泛化出的公共函数——`pub(crate) fn append_plugin_log`，行格式 `[{level}] {msg}`；Task 5 实现时直接按此命名。）

- [ ] **Step 2: 单元测试**：capability 拒绝（toast 无 capability → -32001）、未知方法 → -32601、log 免授权写文件（tempdir）。

- [ ] **Step 3: App.svelte 监听 plugin-toast**（listen 集群处，App.svelte:131-161 附近，风格一致）：

```ts
    const unlistenPluginToast = listen<{ level: ToastLevel; message: string; detail?: string }>(
      'plugin-toast', (e) => { pushToast(e.payload) })
```

（`ToastLevel` 已有类型；unlisten 随既有清理模式登记。）

- [ ] **Step 4:** `cargo test --manifest-path src-tauri/Cargo.toml` + `pnpm check` → PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin_runtime/host_api.rs src-tauri/src/plugin_runtime/process.rs src/App.svelte
git commit -m "feat(plugin-v2): host API dispatch with capability gate; plugin-toast bridged to frontend"
```

---

### Task 8: adapter.rs + tauri 命令 + 菜单/manifest 合流

**Files:**
- Create: `src-tauri/src/plugin_runtime/adapter.rs`、`src-tauri/src/plugin_runtime/commands.rs`
- Modify: `src-tauri/src/lib.rs`（invoke_handler 注册 + 菜单合流）、`src-tauri/src/plugin_host.rs`（get_plugin_manifests 合流 + invoke_plugin 拒 v2）
- Modify: `src/lib/plugins/types.ts`（PluginManifest 加可选 `manifest_version?: number`）

- [ ] **Step 1: adapter.rs——ManifestV2 → v1 PluginManifest**

```rust
//! Transitional adapter: expose v2 manifests through the v1 `PluginManifest`
//! shape so ALL existing menu/CLI/settings collection machinery works
//! unchanged. The frontend distinguishes v2 via `manifest_version: Some(2)`.

use crate::plugin_host::PluginManifest;

pub fn to_v1(m: &plugin_protocol::ManifestV2) -> PluginManifest {
    // 经 serde_json 转换：v1 PluginManifest 派生 Deserialize，未知字段忽略。
    let mut v = serde_json::json!({
        "id": m.id, "name": m.name, "version": m.version,
        "kind": "external", "binary": "",
        "host_capabilities": m.capabilities,
        "menus": m.contributes.menus,
        "context_menus": m.contributes.context_menus,
        "cli": m.contributes.cli,
        "manifest_version": 2,
    });
    if let Some(d) = &m.description { v["description"] = serde_json::json!(d); }
    if let Some(s) = &m.contributes.settings { v["settings"] = s.clone(); }
    if let Some(i) = &m.i18n { v["i18n"] = i.clone(); }
    serde_json::from_value(v).expect("v1 manifest shape")
}
```

前提校验：v1 `PluginManifest`（plugin_host.rs:44-71）需要一个可选 `manifest_version: Option<u32>` 字段（serde default）——本 Task 一并添加（Rust + TS types.ts 同步）。若 v1 struct 有 `deny_unknown_fields` 则不需要（侦察确认没有）。

- [ ] **Step 2: commands.rs——tauri 命令**

```rust
#[tauri::command]
pub fn get_plugin_manifests_v2() -> Vec<serde_json::Value> { /* STATE.plugins 的 adapter::to_v1 序列化 */ }

#[tauri::command]
pub async fn plugin_v2_execute(app: tauri::AppHandle, plugin_id: String, command: String,
                               context: serde_json::Value) -> Result<serde_json::Value, String> {
    // 查 RUNNING/STATE → lifecycle.ensure_active(Trigger::Command(command)) →
    // execute(ExecuteCommandParams { command, context })
}
```

- [ ] **Step 3: 合流**：
  - `plugin_host.rs` `get_plugin_manifests`（:277）：返回 v1 enabled 清单后，若 `plugin_runtime::STATE` flag 开则 append `adapter::to_v1` 序列化结果（同 id 时 v2 覆盖 v1——v2 id 是 `notemd.md2pdf` 与 v1 `md2pdf` 不同，天然无碰撞；不做隐式抑制，开发期用 `plugins.enabled.md2pdf=false` 手关 v1，写入 Task 12 的操作说明）。
  - `collect_top_menu_items`（:469）：同样 append v2 manifests 的菜单项（id 仍 `plugin:<id>:<command>` 格式，`notemd.md2pdf` 含点安全——parsePluginMenuId 以 `:` 分隔，menu-registry.ts:29-35 已核实）。
  - `invoke_plugin`（:404）：入口处 `if plugin_id.contains('.') { return Err("v2 plugin: use plugin_v2_execute".into()) }`。
  - lib.rs invoke_handler（:843-948）追加 `plugin_runtime::commands::get_plugin_manifests_v2, plugin_runtime::commands::plugin_v2_execute`。
- [ ] **Step 4: 前端 types.ts**：`PluginManifest` 加 `manifest_version?: number`。
- [ ] **Step 5: Rust 单元测试**：adapter::to_v1 字段映射（menus/cli/settings/i18n 透传、manifest_version=2、capabilities→host_capabilities）。
- [ ] **Step 6:** `cargo test` + `pnpm check && pnpm vitest run` → PASS。
- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/plugin_runtime/adapter.rs src-tauri/src/plugin_runtime/commands.rs src-tauri/src/plugin_host.rs src-tauri/src/lib.rs src/lib/plugins/types.ts
git commit -m "feat(plugin-v2): v1-shape adapter, tauri commands, manifest/menu merge behind flag"
```

---

### Task 9: 前端 dispatch v2 分支

**Files:**
- Modify: `src/App.svelte`（dispatchPlugin 泛型路径，:341-415）
- Modify: `src/lib/plugins/host.ts`（导出 buildContext 或等价上下文构造复用）

- [ ] **Step 1:** dispatchPlugin 在 manifest 查得后、prompt 处理后分叉：

```ts
        if (m.manifest_version === 2) {
          // v2：上下文与 v1 同形（含 rendered_html 推模式注入 + output_path），
          // 但执行走长驻运行时；toast 由插件经 plugin-toast 事件自行发出。
          const context = {
            tab: snapToRequestTab(snap),          // 与 invokePlugin 内部一致的映射
            rendered_html: m.host_capabilities.includes('renderer.html')
              ? await htmlBaker(snap) : undefined,
            output_path: outputPath,
          }
          try {
            await invoke('plugin_v2_execute', { pluginId: m.id, command, context })
          } catch (e) {
            pushToast({ level: 'error', message: t('plugins.internalError', { name: m.name }), detail: String(e) })
          }
          return
        }
```

实现要点：`snapToRequestTab`/`htmlBaker` 复用 invokePlugin 现有内部逻辑——从 host.ts **导出**上下文构造（`export function buildContext(...)`，侦察确认现为模块私有 :29-61），v1 invokePlugin 与 v2 分支共用，不复制。

- [ ] **Step 2:** `pnpm check && pnpm vitest run` → PASS。
- [ ] **Step 3: Commit**

```bash
git add src/App.svelte src/lib/plugins/host.ts
git commit -m "feat(plugin-v2): frontend dispatch路由 v2 manifests through plugin_v2_execute"
```

---

### Task 10: CLI 合流（flag 下 v2 插件可被 `notemd` 调用）

**Files:**
- Modify: `src-tauri/src/cli/runner.rs`（scan 合流 v2 + flag 读取）、`src-tauri/src/cli/router.rs`（测试）
- Modify: `src/lib/cli/CliRunner.svelte`（v2 执行分支）

- [ ] **Step 1:** runner.rs `current_scan`：在 `append_core_cli_stubs` 之后，若 v2 flag 开（CLI 无 AppHandle——`v2_flag_enabled` 拆出纯函数 `v2_flag_enabled_at(config_dir: &Path)`，CLI 用 `super::resolve_config_dir()` 传入；mod.rs 的 AppHandle 版调它），扫描 v2 安装根（`dirs::data_dir()/net.notemd.app/plugins`——与 Tauri app_data_dir 一致性在测试中断言）并 append `adapter::to_v1` 结果（enabled map 插 true）。router 无需改动（泛型匹配吃 adapter 后的 cli 条目）。router.rs 加测试：构造含 v2-adapted manifest 的 scan，`resolve_with(["pdf2","x.md"],…)` 命中（用虚构 id `notemd.fixture` 的 cli 条目，不依赖真插件）。
- [ ] **Step 2:** CliRunner.svelte 泛型插件路径：manifest 查得后 `if (manifest.manifest_version === 2)` → 构造与 GUI 同形 context（复用 buildVirtualTab + buildContext；`requires_tab_context && renderer.html` 时 bake）→ `invoke('plugin_v2_execute', …)` → 结果 Value 作为 `{ok:true,data:<result>}` 输出（`--json`）或按 `data.path`/字符串友好打印；错误 → exit 4 `{ok:false,error:{code:'plugin_failed',message}}`（与既有 md2pdf v1 信封一致，interpretActions 的约定）。
- [ ] **Step 3:** `cargo test` + `pnpm check && pnpm vitest run` → PASS。
- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/cli/runner.rs src-tauri/src/cli/router.rs src-tauri/src/plugin_runtime/mod.rs src/lib/cli/CliRunner.svelte
git commit -m "feat(plugin-v2): CLI scan merges v2 manifests behind flag; CliRunner executes v2 plugins"
```

---

### Task 11: md2pdf v2 二进制 + manifest

**Files:**
- Create: `md2pdf/src/bin/v2.rs`、`md2pdf/manifest.v2.json`
- Modify: `md2pdf/Cargo.toml`（加 SDK 依赖 + bin target）
- Test: `md2pdf/tests/v2_smoke.rs`

- [ ] **Step 1: Cargo.toml 追加**

```toml
[dependencies]
notemd-plugin-sdk = { path = "../notemd-plugin-sdk" }
tokio = { version = "1", features = ["rt", "macros", "io-std", "io-util", "sync", "time"] }

[[bin]]
name = "md2pdf-v2"
path = "src/bin/v2.rs"
```

- [ ] **Step 2: src/bin/v2.rs**——SDK 服务，导出时派生兄弟 v1 二进制（渲染管线要求主线程 NSApplication 生命周期，派生保证每次导出拿到干净主线程，见计划头 Architecture）：

```rust
//! md2pdf v2 plugin: long-running JSON-RPC service. Each export spawns the
//! sibling v1 binary (`md2pdf`) which owns the main-thread WKWebView render
//! loop — the proven v1 path, one pristine process per export.

use notemd_plugin_sdk::{self as sdk, NotemdPlugin};
use serde_json::{json, Value};

struct Md2PdfV2 { v1_bin: std::path::PathBuf }

impl NotemdPlugin for Md2PdfV2 {
    fn activate(&mut self, host: &sdk::Host, _p: &sdk::plugin_protocol::ActivateParams) -> Result<(), String> {
        host.log_info("md2pdf v2 activated");
        Ok(())
    }
    fn deactivate(&mut self, _host: &sdk::Host) {}
    fn execute_command(&mut self, host: &sdk::Host, p: &sdk::ExecuteCommandParams) -> Result<Value, String> {
        if p.command != "export" { return Err(format!("unknown command {}", p.command)) }
        // v1 请求 = { command:"export", context:{...} }（context 与 v2 同形，v1 兼容读取）
        let v1_req = json!({ "command": "export", "context": p.context });
        let out = std::process::Command::new(&self.v1_bin)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn().map_err(|e| format!("spawn v1 renderer: {e}"))
            .and_then(|mut c| {
                use std::io::Write;
                c.stdin.take().unwrap().write_all(v1_req.to_string().as_bytes())?;
                c.wait_with_output()
            }).map_err(|e| e.to_string())?;
        let line = String::from_utf8_lossy(&out.stdout);
        let resp: Value = serde_json::from_str(line.trim())
            .map_err(|e| format!("v1 renderer bad output: {e}"))?;
        if resp["success"] == json!(true) {
            let path = p.context["output_path"].as_str().unwrap_or("");
            host.toast("success", &format!("✅ Exported to {path}"), None);
            Ok(json!({ "path": path }))
        } else {
            // v1 的失败 toast actions 转述为错误
            Err(format!("render failed: {}", resp["actions"]))
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let v1_bin = std::env::current_exe().unwrap().parent().unwrap().join("md2pdf");
    sdk::serve(Md2PdfV2 { v1_bin }).await;
}
```

（SDK 需 `pub use plugin_protocol;` 重导出——Task 3 的 lib.rs 顶部补 `pub use plugin_protocol;`，实现 Task 3 时直接带上。）

- [ ] **Step 3: manifest.v2.json**（Task 1 校验测试的合法样例同源）：

```json
{
  "manifest_version": 2,
  "id": "notemd.md2pdf",
  "name": "Export to PDF",
  "version": "1.0.0",
  "kind": "native",
  "engines": { "notemd": ">=6.716.7" },
  "description": "Export the current Markdown or HTML tab to a typographically-clean A4 PDF",
  "binary": { "aarch64-apple-darwin": "bin/md2pdf-v2", "x86_64-apple-darwin": "bin/md2pdf-v2" },
  "activation": { "events": ["onCommand:export", "onCli:pdf"] },
  "contributes": {
    "menus": [{ "location": "file", "label": "Export to PDF (v2)…", "command": "export",
                "enabled_when": "currentTab.kind == 'markdown' || currentTab.kind == 'html'",
                "prompt": { "kind": "save-dialog", "default_filename": "{stem}.pdf",
                            "filters": [{ "name": "PDF", "extensions": ["pdf"] }] } }],
    "cli": [{ "subcommand": "pdf2", "command": "export",
              "summary": "Export Markdown or HTML file to PDF (v2 runtime)",
              "args": [{ "name": "file", "type": "path", "required": true, "help": "File to export" }],
              "flags": [{ "long": "--output", "short": "-o", "type": "string", "help": "Output PDF path" }],
              "requires_tab_context": true }]
  },
  "capabilities": ["renderer.html", "toast"],
  "request_timeout_seconds": 60,
  "idle_shutdown_seconds": 120
}
```

（内测期菜单标 "(v2)…"、CLI 用 `pdf2`，与 v1 并存不打架；④期正式切换时改回 `Export to PDF…`/`pdf` 并加 i18n——记入 Task 13 备忘。）

- [ ] **Step 4: v2_smoke.rs**——`CARGO_BIN_EXE_md2pdf-v2` + `CARGO_BIN_EXE_md2pdf`（后者拷到 tempdir 同目录名 `md2pdf` 旁再启动 v2？不必：测试里把两个 CARGO_BIN_EXE 拷贝进同一 tempdir 保持兄弟关系）→ 用 std::process 手写 NDJSON：$initialize→$activate→command.execute(export, rendered_html="<h1>X</h1>", output_path=tmp)→断言 stdout 依次有 initialize/activate 应答、一条 host.toast 通知、execute result 带 path；文件存在且 `%PDF` 开头；$deactivate 后进程退出 0。

- [ ] **Step 5:** `cargo test --manifest-path md2pdf/Cargo.toml` → PASS（含原 smoke.rs）。

- [ ] **Step 6: Commit**

```bash
git add md2pdf/Cargo.toml md2pdf/Cargo.lock md2pdf/src/bin/v2.rs md2pdf/manifest.v2.json md2pdf/tests/v2_smoke.rs notemd-plugin-sdk/src/lib.rs
git commit -m "feat(plugin-v2): md2pdf v2 service binary — SDK loop spawning sibling v1 renderer"
```

---

### Task 12: 构建与 dev 安装脚本 + 端到端验证

**Files:**
- Create: `scripts/build-md2pdf-v2.sh`、`scripts/dev-install-plugin.sh`

- [ ] **Step 1: build-md2pdf-v2.sh**——仿 build-md2pdf.sh（双架构 cargo build --release，产出 `md2pdf` 与 `md2pdf-v2` 两个 bin；**不进 src-tauri/plugins**——v2 包活在 app_data）。

- [ ] **Step 2: dev-install-plugin.sh**（当前架构快速安装）：

```bash
#!/usr/bin/env bash
# Dev-install the md2pdf v2 plugin into the local app-data plugins root.
# Usage: scripts/dev-install-plugin.sh [--release]
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE=debug; [[ "${1:-}" == "--release" ]] && PROFILE=release
( cd md2pdf && cargo build $([ "$PROFILE" = release ] && echo --release) --bins )
VERSION=$(python3 -c "import json;print(json.load(open('md2pdf/manifest.v2.json'))['version'])")
ROOT="$HOME/Library/Application Support/net.notemd.app/plugins"
DEST="$ROOT/notemd.md2pdf/$VERSION"
mkdir -p "$DEST/bin"
cp md2pdf/target/$PROFILE/md2pdf "$DEST/bin/"
cp md2pdf/target/$PROFILE/md2pdf-v2 "$DEST/bin/"
cp md2pdf/manifest.v2.json "$DEST/manifest.json"
ln -sfn "$VERSION" "$ROOT/notemd.md2pdf/current"
node -e "
const fs=require('fs');const p='$ROOT/state.json';
const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{installed:{}};
s.installed['notemd.md2pdf']={version:'$VERSION',enabled:true};
fs.writeFileSync(p,JSON.stringify(s,null,2)+'\n');
"
echo "✓ installed notemd.md2pdf@$VERSION (enable flag: settings.json \"plugins_v2.enabled\": true or NOTEMD_PLUGINS_V2=1)"
```

- [ ] **Step 3: 端到端手动步骤（写进脚本尾注释 + 报告）**：`scripts/dev-install-plugin.sh` → `NOTEMD_PLUGINS_V2=1 pnpm tauri dev` → File 菜单出现 "Export to PDF (v2)…" → 导出一份 md 成功 + toast；`notemd pdf2 x.md`（dev CLI 同 flag）出 PDF；重复导出（进程复用）+ 等 120s 空闲后再导出（懒重激活）。自动化兜底已由 Task 5/6/11 集成测试覆盖。

- [ ] **Step 4:** 全量回归：`pnpm check && pnpm vitest run && cargo test --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path plugin-protocol/Cargo.toml && cargo test --manifest-path notemd-plugin-sdk/Cargo.toml && cargo test --manifest-path md2pdf/Cargo.toml && pnpm check:protocol` → 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/build-md2pdf-v2.sh scripts/dev-install-plugin.sh
git commit -m "feat(plugin-v2): build + dev-install scripts for the v2 md2pdf package"
```

---

### Task 13: spec 回写与偏离记录

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-plugin-system-v2-design.md`

- [ ] **Step 1:** 在 spec 末尾（§16 之后）新增 `## 17. 实施记录（子项目①，2026-07-17）`：三条偏离（renderer.html 拉模式推迟→推模式沿用，理由 YAGNI+唯一消费者；契约单源 Rust crate 而非 TS，理由宿主/SDK 均 Rust；内存监控推迟至③）；md2pdf v2 采用"派生兄弟 v1 渲染进程"模式及其主线程约束理由；内测期命名（menu "(v2)"、cli `pdf2`）在④期切换的待办。
- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-16-plugin-system-v2-design.md
git commit -m "docs(specs): record 子项目① implementation deviations and md2pdf sibling-renderer pattern"
```

---

## Self-Review 记录

- **Spec 覆盖**：§2 manifest v2（T1/T11）、§3 安装布局+state.json（T4/T12；签名=③期不做，spec 本就归于安装流）、§4.1 进程模型+NDJSON（T3/T5）、§4.2 状态机/串行激活/熔断/空闲/启停即时（启停即时=v2 STATE 重扫，①期无 UI 入口，enable/disable 走 state.json——④期市场窗口接管，此边界写入 T13）、§4.3 激活事件（T6）、§4.4 握手与方法面（T3/T5；①期方法子集）、§5 capability 执法+契约单源（T7/T1/T2）、§6 SDK（T3）、§12 错误处理（超时不杀进程 T5、拒载 T4、崩溃熔断 T6）、§13 契约测试+fixture（T1/T5/T6/T11）、§14 ①期界定（flag 内测 T4/T12）。
- **占位符扫描**：slow.sh/crash-activate.sh 以 ok.sh 为模板的删改说明含明确 case 行为；lifecycle 状态机给出全部方法签名+语义+监督任务行为；commands.rs 两个命令体为注释描述但引用的 ensure_active/execute/to_v1 均在 T6/T8 有完整定义——补足为可执行指令（实现者按签名+语义写体，无未定义引用）。
- **类型一致性**：`ExecuteCommandParams`/`InitializeParams`/`ToastParams` T1 定义、T3/T5/T7/T11 引用一致；`append_plugin_log` T5 定义 T7 引用（T5 步骤已注明按此命名）；`v2_flag_enabled_at(config_dir)` T10 要求的纯函数拆分回写进 T4 mod.rs 实现要求（实现 T4 时即拆两层）；SDK `pub use plugin_protocol` T11 要求回写进 T3（步骤已注明）。
- **风险**：md2pdf 主线程约束已用派生模式绕开；`schemars 0.8`/`jsonschema 0.18`/`json-schema-to-typescript` 版本以实现时最新兼容为准（若 API 有出入按同语义调整，属 mechanical）。
