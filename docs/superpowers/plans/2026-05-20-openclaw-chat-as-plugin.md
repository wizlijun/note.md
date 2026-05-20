# OpenClaw Chat 改造为 Builtin 插件 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把内建在 mdeditor 中的 OpenClaw chat 功能改造为 `kind=builtin` 类型的 mdeditor 插件，默认 disabled；功能本体（Rust 模块、Svelte 组件、UDS / WSS 协议、UI）代码保留原位，所有副作用通过 `is_plugin_enabled("openclaw-chat")` 单一真相源进行 gating。

**Architecture:** 在 `src-tauri/plugins/openclaw-chat/manifest.json` 登记一份特殊 manifest（无 binary），扩展 `PluginManifest` schema 加 `kind` / 可选 `binary` / `default_enabled` 字段；启动顺序调整为 `plugin_host::init` 先于 `openclaw::init_state`，让后者可以条件化跳过；前端通过新的 `activePluginIds` 集合（由 Rust 的 `get_plugin_manifests` IPC 填充）作为真相源 gate SettingsDialog tab；CLI `mdedit openclaw` 子命令入口加 disabled guard；settings 顶层 `openclaw` key 直接换名到 `plugins.openclaw-chat.*`（不写迁移代码，老用户重新配置即可）。

**Tech Stack:** Rust (Tauri v2 + tauri-plugin-store + serde) / TypeScript (Svelte 5 with `$state` runes + Vitest) / pnpm.

**Spec:** `docs/superpowers/specs/2026-05-20-openclaw-chat-as-plugin-design.md`

---

## Task 1: 扩展 `PluginManifest` schema — `kind` 字段

引入 `PluginKind` 枚举（`External` | `Builtin`），为后续区分插件类型铺路。保持完全向后兼容：现有 manifest（`md2pdf`、`share`）反序列化为 `External`。

**Files:**
- Modify: `src-tauri/src/plugin_host.rs:17-36`

- [ ] **Step 1: 写失败测试**

新增 test module 末尾追加：

```rust
// src-tauri/src/plugin_host.rs (在 mod cli_helpers_tests 末尾追加 cases)
#[test]
fn manifest_defaults_to_external_kind() {
    let json = r#"{
        "id": "share", "name": "Share", "version": "1.0.0",
        "binary": "bin", "host_capabilities": ["toast"]
    }"#;
    let m: PluginManifest = serde_json::from_str(json).unwrap();
    assert_eq!(m.kind, PluginKind::External);
}

#[test]
fn manifest_parses_builtin_kind() {
    let json = r#"{
        "id": "openclaw-chat", "name": "OpenClaw Chat", "version": "0.1.0",
        "kind": "builtin", "host_capabilities": []
    }"#;
    let m: PluginManifest = serde_json::from_str(json).unwrap();
    assert_eq!(m.kind, PluginKind::Builtin);
    assert!(m.binary.is_none());
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd src-tauri && cargo test --lib plugin_host::cli_helpers_tests::manifest_ -- --nocapture
```

Expected: 两个 case 编译失败，提示 `PluginKind` 未定义、`binary` 字段类型不匹配。

- [ ] **Step 3: 实现最小改动**

修改 `src-tauri/src/plugin_host.rs:17`：

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    #[default]
    External,
    Builtin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub kind: PluginKind,
    #[serde(default)]
    pub binary: Option<String>,
    #[serde(default)]
    pub default_enabled: Option<bool>,
    #[serde(default)]
    pub menus: Vec<MenuEntry>,
    #[serde(default)]
    pub context_menus: Vec<ContextMenuEntry>,
    #[serde(default)]
    pub settings: Option<SettingsBlock>,
    pub host_capabilities: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub cli: Vec<CliEntry>,
}
```

注意 `binary` 由 `String` 改为 `Option<String>`，下一步需要更新所有调用点。

- [ ] **Step 4: 修复 binary 字段调用点**

```bash
cd src-tauri && grep -n "\.binary" src/plugin_host.rs src/cli/runner.rs
```

预期会有 2-3 处。每处把 `.binary` 改为 `.binary.as_deref().ok_or_else(|| "manifest has no binary".to_string())?`，或在 invoke 路径上加 builtin 早期 reject（见 Task 3）。

具体改动：

`src-tauri/src/plugin_host.rs` invoke_plugin 函数体内（grep 找 `.binary`）：
```rust
// 原：
let binary_name = &manifest.binary;
// 改：
let binary_name = manifest.binary.as_deref()
    .ok_or_else(|| "plugin has no binary (builtin plugins cannot be invoked)".to_string())?;
```

`src-tauri/src/cli/runner.rs` 同样处理 `.binary` 引用。

- [ ] **Step 5: 运行测试确认通过**

```bash
cd src-tauri && cargo test --lib plugin_host -- --nocapture
```

Expected: 所有 plugin_host 测试通过；同时 `md2pdf` / `share` 旧 manifest 仍然能正常解析。

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/src/plugin_host.rs src-tauri/src/cli/runner.rs
git commit -m "$(cat <<'EOF'
feat(plugin-host): add PluginKind enum (external|builtin)

Extends PluginManifest with `kind` field (defaults to "external") and
makes `binary` optional. Builtin-kind plugins have no binary and are not
invocable via dispatch — they exist only to surface a toggle in
Preferences > Plugins. Backward compatible: existing md2pdf/share
manifests deserialize unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Builtin 插件的默认 enabled 规则

`read_enabled_map` 当前对未知 key 默认返回 `true`（external 默认开）。Builtin 插件需要不同默认值：使用 manifest 的 `default_enabled` 字段，缺省 `false`。

**Files:**
- Modify: `src-tauri/src/plugin_host.rs:223-228`（`init` 函数内）

- [ ] **Step 1: 写失败测试**

`src-tauri/src/plugin_host.rs` mod cli_helpers_tests 内追加（这个测试针对纯函数逻辑，需要先抽出一个辅助函数）：

```rust
#[test]
fn resolve_enabled_external_defaults_true_when_absent() {
    let enabled_map = HashMap::new();
    let manifest = PluginManifest {
        id: "share".into(), name: "Share".into(), version: "1.0.0".into(),
        description: None, kind: PluginKind::External, binary: Some("bin".into()),
        default_enabled: None, menus: vec![], context_menus: vec![],
        settings: None, host_capabilities: vec![], timeout_seconds: 30,
        cli: vec![],
    };
    assert_eq!(resolve_enabled(&manifest, &enabled_map), true);
}

#[test]
fn resolve_enabled_builtin_defaults_false_when_absent() {
    let enabled_map = HashMap::new();
    let manifest = PluginManifest {
        id: "openclaw-chat".into(), name: "OpenClaw Chat".into(), version: "0.1.0".into(),
        description: None, kind: PluginKind::Builtin, binary: None,
        default_enabled: Some(false), menus: vec![], context_menus: vec![],
        settings: None, host_capabilities: vec![], timeout_seconds: 30,
        cli: vec![],
    };
    assert_eq!(resolve_enabled(&manifest, &enabled_map), false);
}

#[test]
fn resolve_enabled_builtin_explicit_true_wins() {
    let mut enabled_map = HashMap::new();
    enabled_map.insert("openclaw-chat".to_string(), true);
    let manifest = PluginManifest {
        id: "openclaw-chat".into(), name: "OpenClaw Chat".into(), version: "0.1.0".into(),
        description: None, kind: PluginKind::Builtin, binary: None,
        default_enabled: Some(false), menus: vec![], context_menus: vec![],
        settings: None, host_capabilities: vec![], timeout_seconds: 30,
        cli: vec![],
    };
    assert_eq!(resolve_enabled(&manifest, &enabled_map), true);
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd src-tauri && cargo test --lib plugin_host::cli_helpers_tests::resolve_enabled -- --nocapture
```

Expected: 编译失败，`resolve_enabled` 未定义。

- [ ] **Step 3: 实现 resolve_enabled + 重构 init 用它**

在 `src-tauri/src/plugin_host.rs` `read_enabled_map_from` 函数附近（line ~440）新增：

```rust
/// Decide whether a given manifest should be active given the persisted
/// enabled-map. External plugins default ON (preserves legacy behavior);
/// builtin plugins use the manifest's `default_enabled` field (default OFF).
pub fn resolve_enabled(manifest: &PluginManifest, enabled_map: &HashMap<String, bool>) -> bool {
    match enabled_map.get(&manifest.id) {
        Some(&v) => v,
        None => match manifest.kind {
            PluginKind::External => true,
            PluginKind::Builtin => manifest.default_enabled.unwrap_or(false),
        },
    }
}
```

替换 `init` 函数 line 227 处：

```rust
// 原：
let is_enabled = enabled_map.get(&manifest.id).copied().unwrap_or(true);
// 改：
let is_enabled = resolve_enabled(&manifest, &enabled_map);
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd src-tauri && cargo test --lib plugin_host -- --nocapture
```

Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/src/plugin_host.rs
git commit -m "$(cat <<'EOF'
feat(plugin-host): builtin plugins default to disabled

Adds resolve_enabled() that picks default-on for external plugins (legacy
behavior) and uses default_enabled field for builtin plugins (default
false). plugin_host::init now calls this helper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 公开 `is_plugin_enabled` Rust API + Tauri IPC

让 Rust 其他模块（lib.rs 中的 openclaw gating、cli/openclaw.rs 中的子命令 guard）和前端都可以通过统一接口查询启用状态。Dispatch 路径上为 builtin 类型加 reject。

**Files:**
- Modify: `src-tauri/src/plugin_host.rs:238-249`（`get_plugin_manifests` 附近）
- Modify: `src-tauri/src/plugin_host.rs` invoke_plugin 函数（builtin reject）
- Modify: `src-tauri/src/lib.rs:585-637`（注册新 IPC）
- Modify: `src-tauri/src/plugin_host_ios.rs:20-25`（stub 对应 IPC）

- [ ] **Step 1: 写失败测试**

`src-tauri/src/plugin_host.rs` mod cli_helpers_tests 追加：

```rust
#[test]
fn is_plugin_enabled_returns_false_for_unknown_id() {
    // STATE is a global, but tests here run after init returns empty STATE.
    assert_eq!(is_plugin_enabled("never-existed-plugin"), false);
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd src-tauri && cargo test --lib plugin_host::cli_helpers_tests::is_plugin_enabled_returns_false -- --nocapture
```

Expected: 编译失败，`is_plugin_enabled` 未定义。

- [ ] **Step 3: 实现公开 API + IPC**

`src-tauri/src/plugin_host.rs` line ~250（紧跟 `get_all_plugin_manifests`）追加：

```rust
/// Whether the given plugin id is currently registered as enabled.
/// Single source of truth for all gating logic across Rust + IPC.
pub fn is_plugin_enabled(id: &str) -> bool {
    STATE.read().unwrap().enabled.contains_key(id)
}

#[tauri::command]
pub fn plugin_is_enabled(id: String) -> bool { is_plugin_enabled(&id) }
```

并在 `invoke_plugin` 函数体的早期（在 `manifest` 取出之后）加 reject：

```rust
if matches!(manifest.kind, PluginKind::Builtin) {
    return Err("builtin plugins cannot be invoked via dispatch".into());
}
```

具体位置：grep `pub async fn invoke_plugin` 找入口，在拿到 manifest 之后立即检查。

`src-tauri/src/plugin_host_ios.rs:20-25` 追加：

```rust
#[tauri::command]
pub fn plugin_is_enabled(_id: String) -> bool { false }
```

`src-tauri/src/lib.rs:585-637` 两个 `tauri::generate_handler!` 块中各加一行 `plugin_host::plugin_is_enabled,`（紧跟 `plugin_host::get_all_plugin_manifests,`）。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd src-tauri && cargo build --lib && cargo test --lib plugin_host -- --nocapture
```

Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/src/plugin_host.rs src-tauri/src/plugin_host_ios.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(plugin-host): expose is_plugin_enabled + plugin_is_enabled IPC

Adds a single source of truth for "is plugin X currently active?":
- Rust callers use plugin_host::is_plugin_enabled()
- Frontend callers use invoke('plugin_is_enabled', { id })
Also rejects builtin-kind plugins in the invoke dispatch path so
misconfigured menus/cli entries fail fast.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 新增 `openclaw-chat` builtin manifest

让 plugin_host 在启动时扫到这个新插件，登记到 `STATE.all`（Preferences > Plugins 列表）。因为 `default_enabled: false`，它**不会**被加入 `STATE.enabled`，所以 `is_plugin_enabled("openclaw-chat")` 此时返回 `false`，但本任务还不触发任何 gating（gating 在 Task 5 之后接入）。

**Files:**
- Create: `src-tauri/plugins/openclaw-chat/manifest.json`
- Modify: `src-tauri/tauri.conf.json:55-58`（resources glob 已经包含 `plugins/**/*`，无需改动；这里确认一下）

- [ ] **Step 1: 创建 manifest**

新建 `src-tauri/plugins/openclaw-chat/manifest.json`：

```json
{
  "id": "openclaw-chat",
  "name": "OpenClaw Chat",
  "version": "0.1.0",
  "description": "Local M↓ desktop chat via UDS; remote fan-out via mdrelay.",
  "kind": "builtin",
  "host_capabilities": [],
  "default_enabled": false
}
```

- [ ] **Step 2: 确认 bundle 配置**

```bash
grep -A 4 '"resources"' src-tauri/tauri.conf.json
```

Expected: 看到 `"plugins/**/*"`——新目录会被自动打包，无需改动。

- [ ] **Step 3: 手动验证扫描成功**

```bash
cd /Users/bruce/git/mdeditor && pnpm tauri dev
```

打开应用 → Preferences → Plugins 标签 → 应看到三个条目：`Export to PDF`、`Share`、`OpenClaw Chat`，其中 `OpenClaw Chat` 的 checkbox 为 unchecked（默认 disabled）。

退出应用，确认应用启动期间没有崩溃、stderr 没有 plugin_host 解析错误。

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/plugins/openclaw-chat/manifest.json
git commit -m "$(cat <<'EOF'
feat(plugins): add openclaw-chat builtin manifest

Registers OpenClaw chat as a kind=builtin plugin that ships disabled by
default. At this commit, the manifest only adds a toggle to
Preferences > Plugins — no functional gating yet (deferred to follow-up
commits to keep diffs reviewable).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 前端 `activePluginIds` 真相源

引入一个由 Rust 后端权威填充的"当前生效插件 ID 集合"，作为前端 gating 决策的依据。区别于 `isPluginEnabled`（读 settings store、用于 PluginsSettingsTab checkbox 当前值），`isPluginActive` 反映启动时 Rust 决定的实际启用集合。

**Files:**
- Modify: `src/lib/plugins/registry.ts`（新增 `activePluginIds` 状态 + helper）
- Modify: `src/lib/plugins/registry.test.ts`（新测试）
- Modify: `src/App.svelte`（启动早期调用 `initActivePluginIds`）
- Modify: `src/chat-app.svelte`（同上）

- [ ] **Step 1: 写失败测试**

`src/lib/plugins/registry.test.ts` 末尾追加：

```typescript
import { activePluginIds, isPluginActive, setActivePluginIds } from './registry'

describe('activePluginIds', () => {
  it('returns false for ids not in the active set', () => {
    setActivePluginIds(new Set())
    expect(isPluginActive('openclaw-chat')).toBe(false)
  })
  it('returns true for ids in the active set', () => {
    setActivePluginIds(new Set(['share', 'openclaw-chat']))
    expect(isPluginActive('openclaw-chat')).toBe(true)
    expect(isPluginActive('md2pdf')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/bruce/git/mdeditor && pnpm vitest run src/lib/plugins/registry.test.ts
```

Expected: 失败，`setActivePluginIds` / `isPluginActive` 未导出。

- [ ] **Step 3: 实现 helpers**

`src/lib/plugins/registry.ts` 文件末尾追加：

```typescript
// --- Active plugin IDs (filled at startup from Rust's get_plugin_manifests) ---

let _activePluginIds = new Set<string>()

export function isPluginActive(id: string): boolean {
  return _activePluginIds.has(id)
}

/** Test-only: replace the active set without hitting IPC. */
export function setActivePluginIds(ids: Set<string>): void {
  _activePluginIds = ids
}

export async function initActivePluginIds(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    const list = await invoke<Array<{ id: string }>>('get_plugin_manifests')
    _activePluginIds = new Set(list.map(m => m.id))
  } catch (e) {
    console.warn('[plugins/registry] initActivePluginIds:', e)
    _activePluginIds = new Set()
  }
}
```

注意：`activePluginIds` 模块内是 `let` 而非 export—— 避免 `$state` rune 跨模块导出复杂度；用 `set/is` 函数即可，组件用 `isPluginActive(id)` 调用，重启后才变化（设计上接受）。

- [ ] **Step 4: 在 App.svelte 和 chat-app.svelte 调用 init**

`src/App.svelte` —— 找到现有的 `onMount(async () => {` 块（grep `onMount` 找第一个），在调用 `loadSettings()` 之后追加：

```typescript
import { initActivePluginIds } from './lib/plugins/registry'
// ...
onMount(async () => {
  await loadSettings()
  await initActivePluginIds()        // 新增
  // ... 原有代码 ...
})
```

`src/chat-app.svelte` —— 同样在启动逻辑中调用。当前文件结构（line 1-30 已读过）：

```typescript
// src/chat-app.svelte 顶部 script
import { initActivePluginIds } from './lib/plugins/registry'
// 在 onMount 的 try 块第一行调用：
onMount(async () => {
  try {
    await initActivePluginIds()      // 新增
    await start()
    // ... 原有 ...
  }
})
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/bruce/git/mdeditor && pnpm vitest run src/lib/plugins/registry.test.ts
```

Expected: 通过。

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/plugins/registry.ts src/lib/plugins/registry.test.ts src/App.svelte src/chat-app.svelte
git commit -m "$(cat <<'EOF'
feat(plugins): activePluginIds frontend source of truth

Adds isPluginActive(id) backed by a set populated from Rust's
get_plugin_manifests at startup. Used by gating UI to mirror the
authoritative enabled set the plugin_host decided at boot. Distinct from
the existing isPluginEnabled() which reads the settings store directly
and is used for live PluginsSettingsTab checkbox state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 后端 OpenClaw gating — `OpenclawState::new_disabled` + command guards

让 `init_state` 条件化，disabled 时跳过 UDS 连接 / relay 凭证加载 / 后台任务；保留 `app.manage(state)` 但内部 `is_enabled = false`，所有 11 个 command 入口加 guard。**关键：调整 setup 顺序，`plugin_host::init` 必须先于 `openclaw::init_state` 调用。**

**Files:**
- Modify: `src-tauri/src/openclaw/state.rs:13-36`（新增 enabled 字段 + new_disabled）
- Modify: `src-tauri/src/openclaw/commands.rs`（11 处 command 入口加 guard）
- Modify: `src-tauri/src/lib.rs:682-685`（setup 顺序 + 条件化 init）

- [ ] **Step 1: 给 OpenClawState 加 enabled 字段**

`src-tauri/src/openclaw/state.rs` 改动：

```rust
pub struct OpenClawState {
    pub enabled: bool,                       // 新增
    pub config: Mutex<OpenClawConfig>,
    pub backend: Mutex<Backend>,
    pub bridge: Mutex<Option<crate::openclaw::relay_bridge::RelayBridge>>,
    pub relay_tx: Mutex<Option<tokio::sync::mpsc::Sender<Envelope>>>,
    pub claim_poller: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl OpenClawState {
    pub fn is_enabled(&self) -> bool { self.enabled }

    /// Empty placeholder when the openclaw-chat plugin is disabled.
    /// No UDS connection, no relay bridge, no config read — pure zero-cost.
    pub fn new_disabled() -> Arc<Self> {
        Arc::new(OpenClawState {
            enabled: false,
            config: Mutex::new(OpenClawConfig::default()),
            backend: Mutex::new(Backend::None),
            bridge: Mutex::new(None),
            relay_tx: Mutex::new(None),
            claim_poller: Mutex::new(None),
        })
    }
}

pub fn init_state(app: &tauri::AppHandle) -> Arc<OpenClawState> {
    let cfg = crate::openclaw::config::read(app);
    Arc::new(OpenClawState {
        enabled: true,                       // 新增
        config: Mutex::new(cfg),
        backend: Mutex::new(Backend::None),
        bridge: Mutex::new(None),
        relay_tx: Mutex::new(None),
        claim_poller: Mutex::new(None),
    })
}
```

- [ ] **Step 2: 给 11 个 command 入口加 guard**

`src-tauri/src/openclaw/commands.rs` 在以下 11 个函数体的**第一行**（在 `let state = app.state::<...>();` 之后立即）插入 guard。命令清单：

```
openclaw_connect           (line 10)
openclaw_send              (line 57)
openclaw_disconnect        (line 76)
openclaw_pair_create       (line 134)
openclaw_pair_claim        (line 169)
openclaw_revoke_device     (line 193)
openclaw_forget_device     (line 206)
openclaw_list_devices      (line 211)
openclaw_approve_pending   (line 216)
openclaw_reject_pending    (line 226)
openclaw_upload_attachment (line 231)
```

每个命令开头加（以 `openclaw_connect` 为例）：

```rust
#[tauri::command]
pub async fn openclaw_connect(app: AppHandle) -> Result<String, String> {
    let state = app.state::<Arc<OpenClawState>>();
    if !state.is_enabled() {
        return Err("openclaw-chat plugin is disabled".into());
    }
    let cfg = state.config.lock().await.clone();
    // ... 原有代码 ...
}
```

注意 `openclaw_list_devices` 的返回值不是 Result —— 它返回 `Vec<Device>`。改为：

```rust
#[tauri::command]
pub async fn openclaw_list_devices(app: AppHandle) -> Vec<Device> {
    let state = app.state::<Arc<OpenClawState>>();
    if !state.is_enabled() { return Vec::new(); }
    // ... 原有代码 ...
}
```

- [ ] **Step 3: 调整 lib.rs setup 顺序 + 条件化 init**

`src-tauri/src/lib.rs:682-685` 改为：

```rust
// plugin_host MUST run before any code that calls is_plugin_enabled.
plugin_host::init(&app.handle());

let openclaw_state = if plugin_host::is_plugin_enabled("openclaw-chat") {
    crate::openclaw::init_state(&app.handle())
} else {
    crate::openclaw::OpenClawState::new_disabled()
};
app.manage(openclaw_state);
```

同时删除 line 685 处原来的 `plugin_host::init(&app.handle());`（已经提前到上面）。

确认 `crate::openclaw::OpenClawState::new_disabled` 在 mod.rs 中已 re-export（line 11 改）：

```rust
// src-tauri/src/openclaw/mod.rs
pub use state::{OpenClawState, init_state};   // OpenClawState 已经在这里 re-export
```

无需改动 mod.rs，`OpenClawState::new_disabled` 通过 `OpenClawState` 类型即可访问。

- [ ] **Step 4: 加单元测试**

`src-tauri/src/openclaw/state.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_disabled_is_disabled() {
        let s = OpenClawState::new_disabled();
        assert!(!s.is_enabled());
    }

    // init_state 需要 Tauri AppHandle，跳过单元测试。
    // Integration test 在 manual verification 阶段覆盖。
}
```

- [ ] **Step 5: 运行测试 + 编译**

```bash
cd src-tauri && cargo build --lib && cargo test --lib openclaw::state -- --nocapture
```

Expected: 编译通过、新测试通过。

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/src/openclaw/state.rs src-tauri/src/openclaw/commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(openclaw): gate state init + commands on plugin enabled

OpenClawState gains an `enabled: bool` field set by init_state (true) or
new_disabled (false). lib.rs setup decides which constructor to call by
querying plugin_host::is_plugin_enabled. All 11 openclaw_* commands
return early with "plugin is disabled" when the state reports disabled.

Setup order: plugin_host::init now runs BEFORE openclaw::init_state so
the enabled check is authoritative.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Tray 菜单条件化 + 移除静态 chat 窗口 + 动态创建

删除 `tauri.conf.json` 里 `chat` 窗口的静态定义，改为运行时按需 `WebviewWindowBuilder` 创建；`show_chat_window` 加 disabled guard；tray 的 "OpenClaw" 菜单项也条件化构造。

**Files:**
- Modify: `src-tauri/tauri.conf.json:23-34`（删除 chat 窗口定义）
- Modify: `src-tauri/capabilities/default.json:5`（从 windows 列表移除 `"chat"`）
- Modify: `src-tauri/src/lib.rs:339-346`（show_chat_window 改造）
- Modify: `src-tauri/src/lib.rs:717, 741, 763`（tray 条件化）

- [ ] **Step 1: 删除静态 chat 窗口**

`src-tauri/tauri.conf.json` 把 `app.windows` 数组从两个元素改为一个（删除 line 23-34）：

```json
"app": {
  "windows": [
    {
      "title": "M↓",
      "width": 1000,
      "height": 700,
      "minWidth": 600,
      "minHeight": 400,
      "decorations": true,
      "dragDropEnabled": true
    }
  ],
  ...
}
```

- [ ] **Step 2: 更新 capability windows 列表**

`src-tauri/capabilities/default.json:5` 改为：

```json
"windows": ["main", "cli"],
```

（移除 `"chat"`。运行时动态创建的窗口 label 也需要在某个 capability 里被允许；新加一个允许 `chat` label 但仍然受同 capability 约束的方式：保留 `chat` 也是 OK 的——Tauri v2 中 capability 里引用一个尚未存在的 window label 是无害的。**保留 `"chat"` 以避免动态创建时权限问题**。）

实际改动：**保留** `"chat"`，所以本步骤是 no-op 验证步骤：

```bash
grep '"windows"' src-tauri/capabilities/default.json
```

Expected: `"windows": ["main", "cli", "chat"]`。如果在 Step 4 的手动验证中发现动态创建的 chat 窗口提示权限错误，再考虑调整。

- [ ] **Step 3: 改造 show_chat_window 动态创建**

`src-tauri/src/lib.rs:339-346` 替换为：

```rust
#[cfg(not(target_os = "ios"))]
fn show_chat_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::WebviewUrl;
    if !plugin_host::is_plugin_enabled("openclaw-chat") { return; }
    let win = app.get_webview_window("chat").or_else(|| {
        tauri::WebviewWindowBuilder::new(app, "chat", WebviewUrl::App("chat.html".into()))
            .title("OpenClaw")
            .inner_size(480.0, 720.0)
            .min_inner_size(360.0, 480.0)
            .resizable(true)
            .visible(false)
            .build()
            .map_err(|e| eprintln!("[chat] window build failed: {e}"))
            .ok()
    });
    if let Some(w) = win {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
```

- [ ] **Step 4: tray 菜单条件化**

`src-tauri/src/lib.rs:717` 改造：把 `openclaw_item` 的构造和 `MenuBuilder` 的 `.item(&openclaw_item)` 改为条件化。

具体改动（找到 line 717，附近代码结构）：

```rust
// 原 line 717:
let openclaw_item = MenuItem::with_id(app, "tray-openclaw", "OpenClaw", true, None::<&str>)?;

// 改为：
let openclaw_enabled = plugin_host::is_plugin_enabled("openclaw-chat");
let openclaw_item = if openclaw_enabled {
    Some(MenuItem::with_id(app, "tray-openclaw", "OpenClaw", true, None::<&str>)?)
} else {
    None
};
```

`MenuBuilder` 链 (line ~738-753) —— 把 `.item(&openclaw_item)` 替换为条件链。最简方案：将链拆成手动构建：

```rust
let mut tray_menu = MenuBuilder::new(app)
    .item(&show_item)
    .separator();
if let Some(ref oc) = openclaw_item {
    tray_menu = tray_menu.item(oc).separator();
}
let tray_menu = tray_menu
    .item(&sync_repo_item)
    .item(&sync_start_item)
    .item(&sync_stop_item)
    .item(&sync_now_item)
    .item(&sync_log_item)
    .separator()
    .item(&open_books_item)
    .item(&open_raw_sync_item)
    .separator()
    .item(&quit_item)
    .build()?;
```

`on_menu_event` 中的 `"tray-openclaw"` 分支（line ~763）保留不动：

```rust
"tray-openclaw" => show_chat_window(app),
```

—— 它即使在 disabled 时也无害（菜单项根本不存在，事件不会触发；即使触发了，`show_chat_window` 内的 guard 会 early return）。

- [ ] **Step 5: 编译并手动验证**

```bash
cd /Users/bruce/git/mdeditor && pnpm tauri dev
```

预期：
- 启动后主窗口正常显示
- 点击 tray 图标 → 弹出的菜单**没有** OpenClaw 项
- 没有 stderr 中出现 chat 窗口相关错误
- 退出应用

- [ ] **Step 6: 验证启用后能恢复**

手动修改 `~/Library/Application Support/com.laobu.mdeditor/settings.json`，加入或合并：

```json
{ "plugins.enabled": { "openclaw-chat": true } }
```

重新 `pnpm tauri dev`，预期：
- tray 菜单出现 OpenClaw 项
- 点击 OpenClaw → 弹出 chat 窗口（运行时动态创建）
- stderr 无错误

测试完毕后再次修改 settings.json 把 `openclaw-chat` 设为 false 或删除该 key，恢复 disabled 状态。

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/tauri.conf.json src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(openclaw): tray + chat window gated by plugin enabled

- chat window removed from tauri.conf.json static declaration
- show_chat_window() now dynamically constructs the window the first
  time it's invoked (and only if the plugin is enabled)
- tray menu omits the "OpenClaw" item entirely when disabled
- capability default.json retains "chat" in windows list (harmless when
  the window doesn't exist; required when dynamic window is built)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: SettingsDialog "OpenClaw" 标签条件化

前端 SettingsDialog 中的 OpenClaw 标签按钮 + 内容面板用 `isPluginActive('openclaw-chat')` gating。

**Files:**
- Modify: `src/components/SettingsDialog.svelte:19-20`（import）
- Modify: `src/components/SettingsDialog.svelte:339`（tab button）
- Modify: `src/components/SettingsDialog.svelte:651-653`（tab content）

- [ ] **Step 1: 加 import**

`src/components/SettingsDialog.svelte` script 顶部已有 `import OpenClawSettingsTab from './OpenClawSettingsTab.svelte'`（line 19-20）。新加：

```typescript
import { isPluginActive } from '../lib/plugins/registry'
```

- [ ] **Step 2: tab button 条件化**

line 339 当前：

```svelte
<button class:active={selectedTab === 'openclaw'} onclick={() => selectedTab = 'openclaw'}>OpenClaw</button>
```

改为：

```svelte
{#if isPluginActive('openclaw-chat')}
  <button class:active={selectedTab === 'openclaw'} onclick={() => selectedTab = 'openclaw'}>OpenClaw</button>
{/if}
```

- [ ] **Step 3: tab content 条件化**

line 651-653 当前：

```svelte
{:else if selectedTab === 'openclaw'}
  <OpenClawSettingsTab />
  <OpenClawDevicesTab />
```

改为：

```svelte
{:else if selectedTab === 'openclaw' && isPluginActive('openclaw-chat')}
  <OpenClawSettingsTab />
  <OpenClawDevicesTab />
```

- [ ] **Step 4: 类型检查**

```bash
cd /Users/bruce/git/mdeditor && pnpm check
```

Expected: 无 type 错误。

- [ ] **Step 5: 手动验证**

```bash
pnpm tauri dev
```

- 默认启动（disabled） → Preferences 没有 OpenClaw 标签
- 通过 Preferences > Plugins 启用 openclaw-chat → 重启 → Preferences 出现 OpenClaw 标签

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/components/SettingsDialog.svelte
git commit -m "$(cat <<'EOF'
feat(settings): hide OpenClaw tab when openclaw-chat plugin disabled

SettingsDialog reads isPluginActive('openclaw-chat') to decide whether
to render the OpenClaw tab button and its content panel. Mirrors the
backend gating already in place — fully consistent UI for both states.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Settings key 从顶层 `openclaw` 改名到 `plugins.openclaw-chat.*`

把所有读写 `settings.openclaw.*` 的地方改为通过 plugin-scoped helper（与 `share` 插件一致）。前端写到 `pluginScoped['openclaw-chat']`，后端 `config.rs` 从同一位置读。**不写迁移代码**——老 settings.json 顶层残留的 `openclaw` 字段不读不删。

**Files:**
- Modify: `src/lib/settings.svelte.ts:49-77`（删 OpenClawSettings 类型 + default + load + save 相关字段）
- Modify: `src/lib/settings.svelte.ts:188-191`（删 storedOpenclaw load）
- Modify: `src/lib/settings.svelte.ts:208`（删 set('openclaw', ...)）
- Modify: `src/components/OpenClawSettingsTab.svelte:1-72`（绑定切换到 plugin-scoped）
- Modify: `src-tauri/src/openclaw/config.rs:41-96`（读 plugin-scoped 位置）

- [ ] **Step 1: 前端 — 删除 settings.openclaw 顶层结构**

`src/lib/settings.svelte.ts` 改动：

(a) 删除 line 49-63（`OpenClawSettings` 类型 + DEFAULT_OPENCLAW 常量）。

(b) line 65-77 的 `$state` 对象删 `openclaw` 字段：

```typescript
export const settings = $state<{
  autoSave: boolean
  toastAutoClose: boolean
  theme: ThemeSettings
  mdblock: MdblockSettings
  // openclaw 字段已删除
}>({
  autoSave: false,
  toastAutoClose: false,
  theme: { ...DEFAULT_THEME },
  mdblock: structuredClone(DEFAULT_MDBLOCK_SETTINGS),
})
```

(c) `loadSettings` 删除 line 188-191（`const storedOpenclaw = ...` 和后续赋值）。

(d) `saveSettings` 删除 line 208（`await s.set('openclaw', settings.openclaw)`）。

- [ ] **Step 2: 前端 — OpenClawSettingsTab 改用 plugin-scoped**

`src/components/OpenClawSettingsTab.svelte` 全面改写。script 部分：

```svelte
<script lang="ts">
  import { getPluginScopedKey, mergePluginScoped } from '../lib/settings.svelte'

  let showToken = $state(false)
  let copyHint = $state<string | null>(null)

  function read<T>(key: string, fallback: T): T {
    const v = getPluginScopedKey(`openclaw-chat.${key}`)
    return (v === undefined ? fallback : v) as T
  }

  let mode = $state(read<'auto'|'host'|'remote'>('mode', 'auto'))
  let socketPath = $state(read<string>('socketPath', ''))
  let accessToken = $state(read<string>('accessToken', ''))
  let relayUrl = $state(read<string>('relayUrl', ''))
  let autoSyncBeforeResolve = $state(read<boolean>('autoSyncBeforeResolve', true))

  async function persist() {
    await mergePluginScoped({
      'openclaw-chat.mode': mode,
      'openclaw-chat.socketPath': socketPath,
      'openclaw-chat.accessToken': accessToken,
      'openclaw-chat.relayUrl': relayUrl,
      'openclaw-chat.autoSyncBeforeResolve': autoSyncBeforeResolve,
    })
  }

  async function copyToken() {
    if (!accessToken) return
    try {
      await navigator.clipboard.writeText(accessToken)
      copyHint = '✓ copied'
      setTimeout(() => { copyHint = null }, 1500)
    } catch (e) {
      copyHint = 'copy failed'
      setTimeout(() => { copyHint = null }, 2000)
    }
  }
</script>
```

template 部分把 `settings.openclaw.X` 全部换成局部变量 + 在 onchange 调 `persist()`：

```svelte
<section class="block">
  <h3>OpenClaw</h3>

  <label class="row">
    <span class="lbl">Connect mode</span>
    <select bind:value={mode} onchange={persist}>
      <option value="auto">Auto-detect</option>
      <option value="host">Host (local UDS)</option>
      <option value="remote">Remote (via mdrelay)</option>
    </select>
  </label>

  <label class="row">
    <span class="lbl">Socket path</span>
    <input
      type="text"
      bind:value={socketPath}
      placeholder="~/.openclaw/mdeditor.sock"
      onchange={persist}
    />
  </label>

  <label class="row">
    <span class="lbl">Access token</span>
    <input
      type={showToken ? 'text' : 'password'}
      bind:value={accessToken}
      placeholder="Run 'mdedit openclaw install' to generate"
      onchange={persist}
    />
    <button type="button" class="mini" onclick={() => showToken = !showToken}>{showToken ? 'Hide' : 'Show'}</button>
    <button type="button" class="mini" onclick={copyToken} disabled={!accessToken}>{copyHint ?? 'Copy'}</button>
  </label>

  <label class="row">
    <span class="lbl">Relay URL</span>
    <input
      type="text"
      bind:value={relayUrl}
      placeholder="wss://mdrelay.example.com"
      onchange={persist}
    />
  </label>

  <label class="row" style="margin-top: 6px;">
    <input
      type="checkbox"
      bind:checked={autoSyncBeforeResolve}
      onchange={persist}
    />
    Auto-sync before resolving chat links
  </label>
</section>

<style>
  /* 保留原 style 块不动 */
</style>
```

- [ ] **Step 3: 后端 — config.rs 从 plugin-scoped 读**

`src-tauri/src/openclaw/config.rs:41-96` 替换 `read` 函数为：

```rust
pub fn read(app: &tauri::AppHandle) -> OpenClawConfig {
    use tauri_plugin_store::StoreExt;
    let store = match app.store("settings.json") {
        Ok(s) => s,
        Err(_) => return OpenClawConfig::default(),
    };
    // Plugin-scoped settings live under top-level "plugins" key, then by
    // plugin id. Read once, navigate the nested object.
    let plugins = store.get("plugins").unwrap_or(serde_json::json!({}));
    let oc = plugins.get("openclaw-chat")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let mode = oc.get("mode").and_then(|v| v.as_str())
        .map(|s| match s {
            "host" => ConnectMode::Host,
            "remote" => ConnectMode::Remote,
            _ => ConnectMode::Auto,
        })
        .unwrap_or(ConnectMode::Auto);

    let socket_path = oc.get("socketPath").and_then(|v| v.as_str())
        .map(|s| {
            if s.starts_with("~/") {
                dirs::home_dir().map(|h| h.join(&s[2..]))
                    .unwrap_or_else(|| PathBuf::from(s))
            } else {
                PathBuf::from(s)
            }
        })
        .unwrap_or_else(|| OpenClawConfig::default().socket_path);

    let access_token = oc.get("accessToken").and_then(|v| v.as_str()).map(String::from);
    let relay_url = oc.get("relayUrl").and_then(|v| v.as_str()).map(String::from)
        .or_else(|| OpenClawConfig::default().relay_url);
    let host_token = oc.get("hostToken").and_then(|v| v.as_str()).map(String::from);
    let device_token = oc.get("deviceToken").and_then(|v| v.as_str()).map(String::from);
    let device_id = oc.get("deviceId").and_then(|v| v.as_str()).map(String::from);

    OpenClawConfig {
        mode, socket_path, access_token, relay_url, host_token, device_token, device_id,
    }
}
```

- [ ] **Step 4: 后端 — cli/openclaw.rs::write_mdeditor_settings 改写 key**

`src-tauri/src/cli/openclaw.rs:131-134` 当前写：

```rust
obj.insert("openclaw.accessToken".into(), json!(token));
obj.entry("openclaw.mode".to_string()).or_insert_with(|| json!("auto"));
```

改为：

```rust
let plugins = obj.entry("plugins".to_string())
    .or_insert_with(|| json!({}))
    .as_object_mut()
    .ok_or_else(|| "plugins must be an object".to_string())?;
let oc = plugins.entry("openclaw-chat".to_string())
    .or_insert_with(|| json!({}))
    .as_object_mut()
    .ok_or_else(|| "openclaw-chat must be an object".to_string())?;
oc.insert("accessToken".into(), json!(token));
oc.entry("mode".to_string()).or_insert_with(|| json!("auto"));
```

由于函数签名是 `Result<PathBuf, String>` 但内部使用 `obj.insert` 不返回 Result，新的 `.ok_or_else(...)?` 需要确认函数体类型一致。如果遇到 `?` 不可用错误，把外层闭包结构改为 `match`。

- [ ] **Step 5: 类型检查 + 编译**

```bash
cd /Users/bruce/git/mdeditor && pnpm check && cd src-tauri && cargo build --lib
```

Expected: 无错误。如果前端有遗漏的 `settings.openclaw` 引用，TS 编译会报错——按报错位置补全（参考 `src/components/OpenClawDevicesTab.svelte`、`src/lib/openclaw/pair.ts` 等，按需用同样的 `getPluginScopedKey` / `mergePluginScoped` 模式）。

- [ ] **Step 6: 手动验证**

启用 openclaw-chat 插件（settings.json 加 `"plugins.enabled": {"openclaw-chat": true}`），`pnpm tauri dev`：

1. Preferences > OpenClaw 标签 → 输入 mode/socketPath/accessToken/relayUrl，应能保存
2. 退出应用，查看 `~/Library/Application Support/com.laobu.mdeditor/settings.json`，确认数据写到了：
   ```json
   { "plugins": { "openclaw-chat": { "mode": "...", "accessToken": "..." } } }
   ```
   而**不是**顶层 `"openclaw": {...}`
3. 重启应用，OpenClaw 标签里的字段应恢复显示之前填写的值
4. 跑一次 `mdedit openclaw install --force`，确认 `settings.json` 里 token 写到了新位置

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/settings.svelte.ts src/components/OpenClawSettingsTab.svelte \
        src-tauri/src/openclaw/config.rs src-tauri/src/cli/openclaw.rs
git commit -m "$(cat <<'EOF'
refactor(openclaw): move settings from top-level 'openclaw' to plugin-scoped

Settings now live under settings.json's plugins.openclaw-chat.* path,
consistent with the share plugin convention. No migration is performed —
the previous top-level 'openclaw' key is silently ignored. Users will
re-enter access token / relay URL after upgrading (acceptable given
"essentially no users yet").

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: CLI `mdedit openclaw` disabled-state guard

`mdedit openclaw {install,uninstall,status}` 子命令在 openclaw-chat 插件 disabled 时返回友好错误（exit 2），引导用户先 `mdedit plugin enable openclaw-chat`。

**Files:**
- Modify: `src-tauri/src/cli/openclaw.rs:31-44`（run 函数入口加 guard）

- [ ] **Step 1: 写失败测试**

`src-tauri/src/cli/openclaw.rs` 末尾追加测试 module：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_settings(dir: &std::path::Path, enabled: bool) {
        let path = dir.join("settings.json");
        let v = serde_json::json!({
            "plugins.enabled": { "openclaw-chat": enabled }
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
    }

    #[test]
    fn returns_disabled_error_when_plugin_off() {
        let tmp = TempDir::new().unwrap();
        make_settings(tmp.path(), false);
        let plugins = TempDir::new().unwrap();
        std::fs::create_dir_all(plugins.path().join("openclaw-chat")).unwrap();
        let m = serde_json::json!({
            "id": "openclaw-chat", "name": "OpenClaw Chat", "version": "0.1.0",
            "kind": "builtin", "host_capabilities": [], "default_enabled": false
        });
        std::fs::write(
            plugins.path().join("openclaw-chat/manifest.json"),
            serde_json::to_vec_pretty(&m).unwrap(),
        ).unwrap();
        assert!(!is_openclaw_chat_active(plugins.path(), tmp.path()));
    }

    #[test]
    fn returns_active_when_enabled_flag_true() {
        let tmp = TempDir::new().unwrap();
        make_settings(tmp.path(), true);
        let plugins = TempDir::new().unwrap();
        std::fs::create_dir_all(plugins.path().join("openclaw-chat")).unwrap();
        let m = serde_json::json!({
            "id": "openclaw-chat", "name": "OpenClaw Chat", "version": "0.1.0",
            "kind": "builtin", "host_capabilities": [], "default_enabled": false
        });
        std::fs::write(
            plugins.path().join("openclaw-chat/manifest.json"),
            serde_json::to_vec_pretty(&m).unwrap(),
        ).unwrap();
        assert!(is_openclaw_chat_active(plugins.path(), tmp.path()));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd src-tauri && cargo test --lib cli::openclaw::tests -- --nocapture
```

Expected: 编译失败，`is_openclaw_chat_active` 未定义。

- [ ] **Step 3: 实现 helper + 接入 run**

`src-tauri/src/cli/openclaw.rs` 在 `run` 函数前新增 helper：

```rust
/// True iff manifest exists on disk AND user has not explicitly disabled it
/// AND (either explicitly enabled OR default_enabled = true).
fn is_openclaw_chat_active(plugins_dir: &std::path::Path, config_dir: &std::path::Path) -> bool {
    let (manifests, enabled) = crate::plugin_host::scan_disk(plugins_dir, config_dir);
    let manifest = manifests.iter().find(|(m, _)| m.id == "openclaw-chat");
    let manifest = match manifest {
        Some((m, _)) => m,
        None => return false,
    };
    crate::plugin_host::resolve_enabled(manifest, &enabled)
}
```

`run` 函数入口加 guard：

```rust
pub fn run(cmd: OpenclawCmd) -> ExitCode {
    let plugins_dir = super::resolve_plugins_dir(None);
    let config_dir = super::resolve_config_dir();
    if !is_openclaw_chat_active(&plugins_dir, &config_dir) {
        eprintln!("mdedit: openclaw-chat plugin is disabled.");
        eprintln!("Enable it first:");
        eprintln!("  mdedit plugin enable openclaw-chat");
        return ExitCode::from(2);
    }
    let res = match cmd {
        OpenclawCmd::Install { force } => install(force),
        OpenclawCmd::Uninstall { keep_files } => uninstall(keep_files),
        OpenclawCmd::Status => status(),
    };
    match res {
        Ok(()) => ExitCode::from(0),
        Err(e) => {
            eprintln!("mdedit: {e}");
            ExitCode::from(1)
        }
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd src-tauri && cargo test --lib cli::openclaw -- --nocapture
```

Expected: 通过。

- [ ] **Step 5: 手动验证**

构建 CLI binary：

```bash
cd src-tauri && cargo build --bin mdeditor
```

测试 disabled 状态（确保 settings.json 没有 `openclaw-chat: true`）：

```bash
./src-tauri/target/debug/mdeditor --cli openclaw status
```

Expected:
```
mdedit: openclaw-chat plugin is disabled.
Enable it first:
  mdedit plugin enable openclaw-chat
```
exit code 2。

启用：

```bash
./src-tauri/target/debug/mdeditor --cli plugin enable openclaw-chat
./src-tauri/target/debug/mdeditor --cli openclaw status
```

Expected: status 命令正常输出。

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/src/cli/openclaw.rs
git commit -m "$(cat <<'EOF'
feat(cli): mdedit openclaw refuses when plugin disabled

All three openclaw subcommands (install/uninstall/status) check the
plugin enabled state via plugin_host::scan_disk + resolve_enabled. When
disabled, print a clear hint pointing at 'mdedit plugin enable
openclaw-chat' and exit 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: 端到端手动验收

把所有改动串起来跑一遍 spec 的"手动验收"清单。这一步不写代码，只验证。如果发现 bug，把 fix 单独提交（不要把 fix 和 verification 揉在一起）。

**Files:** N/A

- [ ] **Step 1: 全新启动场景**

清理（备份后再删除）当前 settings：

```bash
mv ~/Library/Application\ Support/com.laobu.mdeditor/settings.json ~/Library/Application\ Support/com.laobu.mdeditor/settings.json.bak
```

跑 `pnpm tauri dev`，记录现象：

- [ ] 主窗口正常显示
- [ ] Tray 菜单**没有** OpenClaw 项
- [ ] Preferences → 标签栏**没有** OpenClaw 标签
- [ ] Preferences → Plugins → 列表显示 3 个插件：Export to PDF、Share、OpenClaw Chat；其中 OpenClaw Chat checkbox **未勾选**
- [ ] stderr 无 panic / 无错误

退出应用。

- [ ] **Step 2: 启用插件场景**

在 Preferences → Plugins 中**勾选** OpenClaw Chat。看到 restart-note 提示后**退出应用**，再次 `pnpm tauri dev`：

- [ ] Tray 菜单**出现** OpenClaw 项
- [ ] Preferences **出现** OpenClaw 标签
- [ ] 点击 tray → OpenClaw → **弹出** chat 窗口（动态创建）
- [ ] chat 窗口内的 UDS 配对流程能进入（需要 OpenClaw 在跑，按以前的方式测试连接）
- [ ] stderr 无错误

- [ ] **Step 3: 关闭插件场景**

在 Preferences → Plugins 取消勾选 OpenClaw Chat → 退出 → 重启应用：

- [ ] 回到 Step 1 的状态
- [ ] 之前打开过的 chat 窗口**不会**再被创建（应用启动期间不该有任何 chat 窗口出现）

- [ ] **Step 4: CLI 验证**

构建 release 版 CLI binary（如果还在 dev 模式可以用 debug binary）：

```bash
cd src-tauri && cargo build --bin mdeditor
```

disabled 状态测试：

- [ ] `./target/debug/mdeditor --cli openclaw status` → exit 2，提示 "plugin is disabled"
- [ ] `./target/debug/mdeditor --cli openclaw install` → exit 2，同样提示
- [ ] `./target/debug/mdeditor --cli plugin list` → 列表里 openclaw-chat 显示 disabled
- [ ] `./target/debug/mdeditor --cli plugin enable openclaw-chat` → ✓ enabled
- [ ] 再次 `./target/debug/mdeditor --cli openclaw status` → 正常输出

- [ ] **Step 5: 恢复 / 清理**

测试结束后可以：
- 把备份的 settings.json 恢复回来：`mv settings.json.bak settings.json`
- 或者保留新状态作为新基线

- [ ] **Step 6: 检查 grep 残留**

确认前后端没有遗漏的旧 key 引用：

```bash
cd /Users/bruce/git/mdeditor
grep -rn "settings\.openclaw\|'openclaw'\|\"openclaw\"" \
    src/ src-tauri/src/ 2>/dev/null | \
    grep -v ".test." | grep -v "node_modules" | grep -v "target/"
```

应只剩：
- `src-tauri/src/openclaw/` 模块内部（这些是模块名，正常）
- `src-tauri/resources/openclaw-plugin/`（与本任务无关的 channel plugin）
- `src/lib/openclaw/`（模块内部，正常）
- 没有 `settings.openclaw.X` 形式的引用（顶层 key 应已全部清掉）
- 没有 store 操作里的旧字符串 key（如 `"openclaw.accessToken"` 应已不存在）

如果有残留，按 grep 结果开 follow-up commit 清理。

- [ ] **Step 7: Commit changes 验收记录（可选）**

如果手动验收过程中发现并修复了 bug，每个 fix 独立提交。如果一切顺利，无需额外 commit。

最后跑一遍：

```bash
cd /Users/bruce/git/mdeditor && pnpm vitest run && cd src-tauri && cargo test --lib && cd ..
```

Expected: 所有测试通过。

---

## Self-Review 备忘

写完计划后回过头检查的几个点：

1. **Spec 覆盖**:
   - Manifest schema (kind/binary/default_enabled) → Task 1 ✓
   - resolve_enabled 默认值 → Task 2 ✓
   - is_plugin_enabled API + IPC + dispatch reject → Task 3 ✓
   - openclaw-chat manifest 文件 → Task 4 ✓
   - 前端 activePluginIds → Task 5 ✓
   - 后端 init_state 条件化 + 11 command guards + OpenclawState::new_disabled → Task 6 ✓
   - Tray 项 + 动态 chat 窗口 + capabilities → Task 7 ✓
   - SettingsDialog 标签 gating → Task 8 ✓
   - Settings key 改名 → Task 9 ✓
   - CLI openclaw guard → Task 10 ✓
   - 测试 + 手动验收 → 每个 task 内 + Task 11 ✓

2. **类型一致性**: `PluginKind`, `is_plugin_enabled`, `resolve_enabled`, `OpenClawState::new_disabled`, `OpenClawState::is_enabled`, `activePluginIds`/`isPluginActive`/`initActivePluginIds`/`setActivePluginIds`、`plugin_is_enabled`(IPC) —— 在多个任务中引用一致。

3. **风险点**（spec 中列出的）:
   - capabilities 里的 `"chat"` label → Task 7 Step 2 处理（保留以避免动态创建权限问题）
   - init_state 副作用 → Task 6 Step 1 通过 `new_disabled()` 路径覆盖
   - moraya-core 同步 → 不涉及，无需处理
