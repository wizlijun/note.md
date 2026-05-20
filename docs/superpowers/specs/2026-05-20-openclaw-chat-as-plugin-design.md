# OpenClaw Chat 改造为插件 — 设计

日期: 2026-05-20
状态: Draft
前置: `docs/superpowers/specs/2026-05-18-openclaw-chat-plugin-design.md`（原始 OpenClaw chat 集成）、`docs/superpowers/specs/2026-05-08-plugin-system-design.md`（插件系统）

## 概述

把当前内建在 mdeditor 中的 OpenClaw chat 功能改造为 mdeditor 插件体系内的一个 **builtin 类型插件**，并将其默认设置为 **不加载（disabled by default）**。

## 目标

- OpenClaw chat 作为一个独立的、可在 Preferences > Plugins 中开关的功能存在
- 全新安装与现有用户一律默认 disabled（"没什么用户"，无需迁移）
- Disabled 时，OpenClaw 相关的 tray 菜单项、设置标签页、`chat` 窗口、Tauri commands、CLI 子命令全部不存在或返回明确错误
- Enabled 时（重启后），所有功能恢复到当前内建版本完全一致的体验
- 代码组织保持原状：`src-tauri/src/openclaw/`、`src/lib/openclaw/`、`src/components/chat/`、`src-tauri/resources/openclaw-plugin/` 不搬迁
- 插件主机系统获得对 "builtin"（无 binary、由主程序静态链接）类型插件的支持，留作未来其它内建功能复用

## 非目标

- 抽出独立 sidecar 二进制 / 独立 Svelte bundle（与现有插件主机能力不匹配，工作量过大）
- 旧 `settings.json` 顶层 `openclaw` 字段到 `plugins["openclaw-chat"].*` 的数据迁移（用户决定不考虑）
- 修改 OpenClaw 协议、UDS / WSS / pairing 行为
- 修改 `src-tauri/resources/openclaw-plugin/`（那是 mdeditor 提供给 OpenClaw 端加载的 channel plugin，id 为 `mdeditor`，与本设计的 `openclaw-chat` 是不同实体）

## 架构总览

```
                ┌───────────────────────────────────────────────┐
                │  src-tauri/plugins/openclaw-chat/manifest.json│  (新增, kind=builtin)
                └────────────────────┬──────────────────────────┘
                                     │ scan_disk
                                     ▼
                ┌───────────────────────────────────────────────┐
                │   plugin_host: STATE.enabled / STATE.all      │
                └────────────────────┬──────────────────────────┘
                                     │ is_plugin_enabled("openclaw-chat")?
            ┌────────────────────────┼────────────────────────┐
            ▼                        ▼                        ▼
   ┌────────────────┐    ┌────────────────────┐    ┌──────────────────────┐
   │ Rust (lib.rs)  │    │ Frontend (Svelte)  │    │ CLI (cli/openclaw.rs)│
   │ - init_state   │    │ - chat 窗口创建    │    │ - 子命令报错         │
   │ - 11 commands  │    │ - Settings tab     │    │                      │
   │ - tray 项      │    │ - vault-link 解析  │    │                      │
   └────────────────┘    └────────────────────┘    └──────────────────────┘
```

**插件 ID:** `openclaw-chat`

**Manifest 新字段 `kind: "builtin"`:** 表示无 binary、由主程序静态链接。`plugin_host::init` 扫到这个 kind 时仍登记到 `STATE.all` / `STATE.enabled`，但绝不调用 `pick_binary_for_arch` / `run_plugin_binary`。它的唯一作用是出现在 Preferences > Plugins 的开关列表里、被各处代码用 `is_plugin_enabled("openclaw-chat")` 查询。

**单一真相源:** `is_plugin_enabled("openclaw-chat")`，由 Rust 侧 `plugin_host` 决定。
- 前端通过新增的 IPC `is_plugin_enabled` 拉取并缓存到 `activePluginIds: Set<string>`
- 后端 Rust 直接 `plugin_host::is_plugin_enabled(...)` 同步查询
- CLI 通过 `plugin_host::read_enabled_map` 读 `settings.json`

**默认值反转:** `read_enabled_map` 当前对未知 key 默认返回 `true`（external 插件默认开）。Builtin 类型默认值改为 manifest 的 `default_enabled` 字段，缺省 `false`。

## Manifest schema 改动

### 新文件 `src-tauri/plugins/openclaw-chat/manifest.json`

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

### `PluginManifest` struct 扩展（`src-tauri/src/plugin_host.rs:17`）

```rust
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,

    // 新增：缺省为 External，保持现有 manifest 向后兼容
    #[serde(default = "default_kind")]
    pub kind: PluginKind,

    // 改为 Option：builtin 不需要 binary
    #[serde(default)]
    pub binary: Option<String>,

    // 新增：仅 builtin 使用，缺省 false
    #[serde(default)]
    pub default_enabled: Option<bool>,

    /* 其它字段不动 */
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    #[default]
    External,
    Builtin,
}
```

`md2pdf` / `share` 的 manifest 字段 `"binary": "bin"` 反序列化为 `Some("bin")`，invoke 路径上把 `.binary` 改成 `.binary.as_deref().ok_or(...)`。

### `read_enabled_map` 默认值逻辑（`plugin_host.rs:227`）

```rust
let is_enabled = match enabled_map.get(&manifest.id) {
    Some(&v) => v,
    None => match manifest.kind {
        PluginKind::External => true,                              // 保持原有行为
        PluginKind::Builtin  => manifest.default_enabled.unwrap_or(false),
    },
};
```

### 新增公开 API + IPC

```rust
// plugin_host.rs
pub fn is_plugin_enabled(id: &str) -> bool {
    STATE.read().unwrap().enabled.contains_key(id)
}

#[tauri::command]
pub fn plugin_is_enabled(id: String) -> bool { is_plugin_enabled(&id) }
```

### Dispatch 路径 guard

invoke / cli runner 入口加：

```rust
if matches!(manifest.kind, PluginKind::Builtin) {
    return Err("builtin plugins cannot be invoked via dispatch".into());
}
```

Builtin 插件没有 binary，走到这里说明 manifest 配错了 menus / cli，提早 reject。

## Rust 侧（`lib.rs` / `openclaw/`）gating

### 启动顺序调整

`plugin_host::init` 必须提前到 `openclaw::init_state` 之前。当前 `lib.rs:682-685` 顺序相反，需要交换。

### `OpenclawState` 拆分

`init_state` 现在做的事：连接 UDS、加载 relay 凭证、启后台任务。拆为两条路径：

```rust
// src-tauri/src/openclaw/state.rs
impl OpenclawState {
    pub fn new_disabled() -> Self { /* 全空字段，is_enabled = false */ }
    pub fn is_enabled(&self) -> bool { /* ... */ }
}

// lib.rs setup
let openclaw_state = if plugin_host::is_plugin_enabled("openclaw-chat") {
    openclaw::init_state(&app.handle())     // 现状：连接、加载、后台任务
} else {
    OpenclawState::new_disabled()           // 零副作用
};
app.manage(openclaw_state);
```

理由：Tauri 的 `app.state::<T>()` 在 T 未 manage 时会 panic；保留 manage 但内部为空是最低风险路径。

### 11 个 OpenClaw command 入口 guard

`src-tauri/src/openclaw/commands.rs` 每个 `#[tauri::command]` 函数早期加：

```rust
if !state.is_enabled() {
    return Err("openclaw-chat plugin is disabled".into());
}
```

Commands 列表（来自 `lib.rs:615-625`）:
`openclaw_connect`, `openclaw_send`, `openclaw_disconnect`, `openclaw_pair_create`, `openclaw_pair_claim`, `openclaw_revoke_device`, `openclaw_forget_device`, `openclaw_list_devices`, `openclaw_approve_pending`, `openclaw_reject_pending`, `openclaw_upload_attachment`.

### Tray "OpenClaw" 菜单项（`lib.rs:717, 741, 763`）

Disabled 时：
- 不构造 `openclaw_item`
- `MenuBuilder` 链上不 `.item(&openclaw_item)`
- `on_menu_event` 的 `"tray-openclaw"` 分支保留（永远不被触发）

### `chat` 窗口：从静态改动态

`tauri.conf.json` 当前在 `app.windows[1]` 静态声明 `chat` 窗口（`visible: false`），启动时自动创建。改动：

1. **从 `tauri.conf.json` 删除 `chat` 窗口定义**（只剩 `main`）
2. **`show_chat_window`（`lib.rs:340`）改为按需创建**：

```rust
fn show_chat_window<R: Runtime>(app: &AppHandle<R>) {
    if !plugin_host::is_plugin_enabled("openclaw-chat") { return; }
    let win = app.get_webview_window("chat").or_else(|| {
        WebviewWindowBuilder::new(app, "chat", WebviewUrl::App("chat.html".into()))
            .title("OpenClaw")
            .inner_size(480.0, 720.0)
            .min_inner_size(360.0, 480.0)
            .visible(false)
            .build()
            .ok()
    });
    if let Some(w) = win {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
```

3. **检查 `src-tauri/capabilities/*.json`** 是否在某个 capability 的 `windows` 列表里命名了 `chat`。如果在，可保留（label 引用不存在的窗口在 Tauri v2 中是无害的）；如果触发警告则同步移除。

### vault-link 解析（`App.svelte:111`）

`editor://open-path` 事件监听是无条件的；保持原状。Disabled 时没有 chat 窗口能发事件，监听器空跑无害。这样未来开启插件后 vault-link 立即可用，无需重新接线。

## 前端 gating

### `activePluginIds` 真相源（`src/lib/plugins/registry.ts`）

```ts
export let activePluginIds = $state(new Set<string>())

export async function initActivePluginIds() {
  const list = await invoke<PluginManifest[]>('get_plugin_manifests')
  activePluginIds = new Set(list.map(m => m.id))
}

export function isPluginActive(id: string): boolean {
  return activePluginIds.has(id)
}
```

`get_plugin_manifests` 这个 IPC 已经只返回 enabled 的 manifests（由 Rust 侧的 `STATE.enabled` 决定），完美对应"运行时实际生效的插件集合"。

在 `App.svelte` 和 `chat-app.svelte` 的 `onMount` 早期调用一次 `initActivePluginIds()`。

`src/lib/settings.svelte.ts:364` 的 `isPluginEnabled`（读 settings store）保留给 PluginsSettingsTab 的 checkbox 当前值用途，不改其行为。

### SettingsDialog（`SettingsDialog.svelte:339, 651-653`）

```svelte
{#if isPluginActive('openclaw-chat')}
  <button class:active={selectedTab === 'openclaw'} ...>OpenClaw</button>
{/if}

...

{:else if selectedTab === 'openclaw' && isPluginActive('openclaw-chat')}
  <OpenClawSettingsTab />
  <OpenClawDevicesTab />
{/if}
```

边界情况：用户在 Plugins 标签把 openclaw-chat 关掉但未重启，`activePluginIds` 仍是旧值，OpenClaw 标签仍可见——这是可接受的过渡态，现有 `restart-note` 已提示"改动需要重启后生效"。

### Settings key 改名

```diff
- settings.openclaw.accessToken
+ // 走现有的 plugin-scoped helper
+ getPluginScopedAll('openclaw-chat').accessToken
```

`src/lib/settings.svelte.ts` 改动：
- 删 `openclaw: OpenClawSettings`（line 70）
- 删 default openclaw（line 76）
- 删 load openclaw（line 188-189）
- 删 save openclaw（line 208）

OpenClaw 模块所有读写处改为 `getPluginScopedAll('openclaw-chat')` / `setPluginScopedMany` 路径（与 `share` 插件用法一致）。

老 `settings.json` 顶层若残留 `openclaw` 字段，启动时不读不删，留着无害。

### 前端改动文件清单

```
src/lib/plugins/registry.ts                  # 新增 activePluginIds
src/lib/settings.svelte.ts                   # 删 openclaw 顶层
src/lib/openclaw/client.svelte.ts            # accessToken / socketPath 读写
src/lib/openclaw/devices.svelte.ts           # 配对设备读写
src/lib/openclaw/pair.ts                     # 配对凭证读写
src/components/OpenClawSettingsTab.svelte    # UI 绑定
src/components/OpenClawDevicesTab.svelte     # UI 绑定
src/components/SettingsDialog.svelte         # tab gating
src/App.svelte                               # 启动时 initActivePluginIds()
src/chat-app.svelte                          # 启动时 initActivePluginIds()
```

## CLI disabled-state 行为

### `mdedit openclaw {install,uninstall,status}`

`src-tauri/src/cli/openclaw.rs::run` 入口加 guard：

```rust
pub fn run(cmd: OpenclawCmd) -> ExitCode {
    let (manifests, enabled) = current_scan_with_cfg();
    let active = is_active_after_defaults(&manifests, &enabled, "openclaw-chat");
    if !active {
        eprintln!("mdedit: openclaw-chat plugin is disabled. \
                   Run `mdedit plugin enable openclaw-chat` first.");
        return ExitCode::from(2);
    }
    /* 现有 install / uninstall / status 逻辑不动 */
}
```

`is_active_after_defaults` 复用与 `plugin_host` 相同的 builtin 默认值逻辑——必要时抽到 `plugin_host` 作为公共函数。

### `mdedit plugin {list,enable,disable,info}`

不改。基于 manifest 扫描结果工作，自动包含新的 `openclaw-chat` 条目。`mdedit plugin enable openclaw-chat` / `mdedit plugin disable openclaw-chat` 直接生效。

## 测试

### 单元测试（Rust）

- `plugin_host::read_enabled_map` 加 3 个 case：
  - builtin manifest + 无 enabled key → disabled
  - builtin manifest + `enabled=true` → enabled
  - builtin manifest + `enabled=false` → disabled
- `is_plugin_enabled` 公开 API（构造 STATE，断言）
- `cli/openclaw.rs::run` 的 disabled 分支（通过临时 `MDEDIT_CONFIG_DIR` 注入）
- `openclaw::commands` 在 `state.is_enabled() == false` 时返回 Err（抽 1-2 个代表性 command）

### 前端测试（Vitest）

- `src/lib/plugins/registry.test.ts`：`activePluginIds` / `isPluginActive` 行为
- `src/lib/settings.test.ts`：plugin-scoped key 读写，确认 `openclaw` 顶层 key 不再写出

### 手动验收

跑 `pnpm tauri dev`，按下列步骤逐条确认（类型检查与单测通过不算）：

1. **全新启动**（清理 `settings.json` 或新建用户目录）→ 主窗口正常；tray 无 OpenClaw 项；SettingsDialog 无 OpenClaw 标签；Preferences > Plugins 列表里 openclaw-chat 显示为 off
2. **启用**：勾选 openclaw-chat → 重启 → tray 出现 OpenClaw；SettingsDialog 出现 OpenClaw 标签；点击 tray > OpenClaw 弹出 chat 窗口；UDS 配对流程能走通
3. **再次关闭**并重启 → 回到状态 1；chat 窗口完全不创建
4. **CLI**：disabled 时 `mdedit openclaw status` 返回友好错误退出码 2；`mdedit plugin enable openclaw-chat` 写入成功；再次 `mdedit openclaw status` 正常输出

## 落地阶段

每阶段独立可提交可回滚。

| 阶段 | 改动 | 验收 |
|---|---|---|
| **S1** | `PluginManifest` 扩展（`kind`/`binary?`/`default_enabled`）；`read_enabled_map` 支持 builtin 默认；`is_plugin_enabled` 公开 + IPC | 单测通过；`md2pdf` / `share` 行为不变（向后兼容） |
| **S2** | 新增 `src-tauri/plugins/openclaw-chat/manifest.json`；前端 `activePluginIds` + Plugins 列表多出一行（默认 off） | 启动主窗口；OpenClaw 仍像现在一样工作（过渡态：默认 off 但功能未 gate） |
| **S3** | `lib.rs` 接入 gating：`init_state` 条件化、tray 项条件化、`OpenclawState::new_disabled`、`chat` 窗口动态创建、`tauri.conf.json` 删除 `chat`、11 个 command 入口 guard | 全新启动 → tray / 标签 / 窗口全部消失；勾选 enable + 重启 → 全部回来 |
| **S4** | Settings key 改名（顶层 `openclaw` → `plugins["openclaw-chat"]`），所有前端读写改 plugin-scoped | 启用插件后 access token / 设备列表 / 配对正常 |
| **S5** | CLI `mdedit openclaw` disabled-state guard | `mdedit openclaw status` 在 disabled 时友好报错 |
| **S6** | 测试补全 + 手动验收清单走一遍 | 全绿 |

## 风险

1. **`tauri.conf.json` 移除 `chat` 窗口** —— 落地前 `grep '"chat"' src-tauri/capabilities/`，确认 capability 文件没有依赖该 label。
2. **`init_state` 副作用** —— 改成条件化前确认没有别的模块依赖 `app.state::<OpenclawState>()` 总是存在（除 openclaw 自身的 commands）。`new_disabled()` 路径覆盖类型层，但要保证 disabled 时不启动 UDS server / 不监听端口 / 不读 token 文件。
3. **moraya-core 同步缓存** —— 不涉及，但落地前确认 `pnpm sync:core` 干净，避免 Vite deps 缓存把旧 OpenClaw 代码塞回来掩盖问题。

## 不在本设计范围

- 给其它内建功能（vault sync、updater、themes）也包成 builtin 插件 — 等本设计跑通且模式得到验证后另议
- 引入 dynamic enable/disable（运行时切换而非重启）— 现有插件系统都靠重启生效，保持一致
