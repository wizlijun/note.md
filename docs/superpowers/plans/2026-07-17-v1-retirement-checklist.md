# v1 插件机制退役清单（子项目④c）

> **破坏性、门控。** 本清单**只在满足两个前提后**执行：
> 1. 用户对整个 v2 栈完成 GUI 实机验证（⓪core 化 + ① md2pdf v2 + ② roam-import v2 + ③ 市场安装/卸载 + ②b openclaw v2 + ④a base custom-editor 穿刺）；
> 2. base 迁移（④T3）与 exlibris 迁移（④T4）均已完成并验证。
>
> 退役会删除 v1 回退路径。执行前确认 v2 对应功能在真实环境可用。删除应分插件小步提交，每步跑全量测试。

本清单在 worktree `core-ize-six-plugins` 分支上编写；执行时逐项 grep 确认无残留引用、测试保持绿、并手测该功能经 v2 可用。

---

## A. 五插件 v1 前端删除

| 插件 | 删除 | 验证 |
|---|---|---|
| roam-import | `src/roam-import-app.svelte`、`src/roam-import-main.ts`、`roam-import.html`、`src/lib/roam-import/`（整目录） | grep `roam-import` src/ 无引用；v2 `notemd.roam-import` 可 File▸Import 打开导入 |
| openclaw | `src/chat-app.svelte`、`src/chat-main.ts`、`chat.html`、`src/lib/openclaw/`、`src/components/chat/`（整目录） | grep `openclaw`/`chat-` src/ 无引用；v2 `notemd.openclaw-chat` Window 菜单可开、可连、流式可见 |
| base | `src/lib/base/`、`src/components/BaseView.svelte`；`EditorPane.svelte` 的 `kind==='base'` 分支（改为 custom 走 iframe） | grep `BaseView`/`lib/base` 无引用；`.base` 经 v2 custom-editor 打开 |
| md2pdf | 无独立前端（走通用 dispatch） | — |
| share（已 core 化，非退役对象） | — | — |

- `vite.config.ts` rollupOptions 删 `chat`、`roamImport` 入口（保留 index/insights/preview；plugin-market 若已加则留）。
- `src/App.svelte` `dispatchPlugin` 删 `pluginId==='roam-import'`、`pluginId==='base'`、`notemd.cef-fixture`（fixture 也退役）等 v1/fixture 分支。
- i18n：删 `roamImport.*`（16 键）、`chat.*`/`openclaw.*`、`base.*` 键（v2 插件各自内联了 strings）——四语言同步；grep 键名确认无 `t('roamImport...` 等残留。

## B. 五插件 v1 后端删除

| 删除 | 验证 |
|---|---|
| `src-tauri/src/openclaw/`（整目录，1.26k 行）+ lib.rs 中 openclaw 命令注册（invoke_handler 的 11 项）+ `show_chat_window` + tray-openclaw（菜单项 + 事件 arm + is_plugin_enabled 判定）+ openclaw state init | cargo build；grep `openclaw` src-tauri/src 无引用（除非有他用）；tray 无 OpenClaw 项 |
| `src-tauri/plugins/{md2pdf,roam-import,openclaw-chat,base}/`（manifest + bin）+ `src-tauri/plugins/placeholder` 若空 | 目录只剩 README（bundle glob 锚点）；`get_all_plugin_manifests` 返回空 v1 列表 |
| `md2pdf/` crate（若 v2 md2pdf 派生的是 v2 crate 而非此 v1 crate——**注意**：v2 md2pdf 的 `md2pdf-v2` bin **派生兄弟 v1 `md2pdf` bin** 渲染。退役 v1 bundled 插件 ≠ 删 md2pdf crate。md2pdf crate 仍产出 v1+v2 两个 bin 供 v2 插件包用。**保留 md2pdf crate**，只删 `src-tauri/plugins/md2pdf/`） | v2 md2pdf 导出仍可用（派生的兄弟 bin 在插件包内） |
| `show_roam_import_window`、`show_insights_window`（insights 是 core，**不删**——保留）、`show_chat_window` | 保留 insights；删 roam/chat 窗口函数 |
| `src-tauri/capabilities/default.json` windows 删 `chat`、`roam-import`（保留 main/cli/insights/preview/plugin-market） | 新窗口经 plugin-* 授权，旧项无用 |
| lib.rs `build_menu` / dispatch 中 base 的 `New Base` 硬编码、`show_roam_import_window` 命令注册 | cargo build |

## C. v1 one-shot 机制评估（谨慎）

退役五插件后，**是否还有任何 v1 插件**？（md2pdf/roam-import/openclaw-chat/base 全迁 v2；share/sotvault 等六项已 core 化。）若确认零 v1 插件：

- `src-tauri/src/plugin_host.rs`：`run_plugin_binary`、`invoke_plugin` 命令、v1 一次性子进程协议可删。
- **但 adapter 依赖 v1 `PluginManifest` 形状**（`plugin_runtime::adapter::to_v1` 把 v2 manifest 映射成 v1 形状以复用菜单/CLI/设置收集机制）。删 v1 前必须评估：
  - 方案 A（省力）：保留 `PluginManifest` struct 与 `collect_top_menu_items`/`get_plugin_manifests` 收集机制，只删 `run_plugin_binary`/`invoke_plugin`（v1 执行路径）。adapter 继续用 v1 形状。**推荐**——收集机制是纯数据，无害。
  - 方案 B（彻底）：把收集机制改为直接吃 v2 ManifestV2，删 v1 PluginManifest。工作量大，收益小。
- `plugin_host.rs` 的 `get_all_plugin_manifests`（PluginsSettingsTab 已退役，市场窗口用 `plugin_market_installed`）——评估是否还有消费者；无则删。
- CLI `builtin.rs` 的 v1 `scan_disk`/`current_scan`——v2 stub 注入仍需扫描机制；保留结构，评估 v1 磁盘扫描是否可简化。

## D. deps 清理

删除后 grep 确认 src-tauri/Cargo.toml 中以下 dep 无他用再删（**逐个 grep 全 src-tauri/src**）：
- `tokio-tungstenite`、`qrcode`、`gethostname`、`urlencoding`——openclaw 专用，移进 `plugins-src/openclaw/backend` 后可删（**确认 mdrelay/其他无用**）。
- `objc2-*`/`objc2-web-kit`/`objc2-pdf-kit`——md2pdf 专用；但 md2pdf crate 保留（见 B），这些 dep 在 md2pdf/Cargo.toml 不在 src-tauri——**src-tauri 本无这些 dep，无需动**。
- `yaml`（package.json）——base 前端专用，base 迁 v2 后（`plugins-src/base` 自带 yaml dep）可从根 package.json 删（确认无他用：grep `from 'yaml'` src/）。
- `url`、`reqwest`、`hmac`、`sha2`、`hex`、`rand`、`futures-util`——**多处共用（updater/installer/share/sotvault），勿删**。

## E. 独立 app 退役

- **exlibris 独立 app**：迁 v2 窗口插件后（④T4），停止发布独立 dmg；冻结 `exlibris-v` tag 线；`scripts/release-exlibris.sh` 加注释归档（不删脚本，留历史）；`exlibris/` 目录保留源码但不再进 CI/release（`.github/workflows` 中 exlibris 相关 job 若有则停用）。托盘 "Open Books" 改为打开 v2 exlibris 插件窗口。
- 记忆：`[[project-exlibris-release-conventions]]` 需更新为"已迁 v2 插件"。

## F. flag 转正决策（留用户）

`plugins_v2.enabled` 目前是内测 flag（默认关，settings.json 或 `NOTEMD_PLUGINS_V2=1`）。退役 v1 后 v2 是唯一路径，flag 必须转正。选项：
- **方案 A**：删 flag，v2 恒开。前提：市场已部署（③ 用户步骤完成，真签名密钥就位），否则用户装不了插件、md2pdf/roam/base/openclaw 全不可用（灾难）。
- **方案 B**：flag 默认开、保留开关（可关回退——但 v1 已删，关了就没插件）。
- **方案 C**：分两步——先 flag 默认开发一版观察，再下一版删 flag + 删 v1。**推荐**：降低"删 v1 + 转正"同版本的风险。
- **强依赖**：flag 转正 = 市场必须可用（③ 的 CF 部署 + 真签名密钥 + 首批插件上架）。退役 v1 与市场上线是同一件事的两面。

## 执行顺序建议

1. base 迁移（④T3，穿刺通过后）+ exlibris 迁移（④T4）完成并验证。
2. 用户 GUI 全栈验证。
3. 市场部署（③ 用户步骤：真密钥 + CF + 首批插件上架）。
4. 本清单 A→B 分插件删（每步全量测试 + 手测 v2 对应功能）。
5. C（v1 one-shot 机制，方案 A 保留收集机制）。
6. D（deps 逐个 grep 后删）。
7. E（exlibris 独立 app 退役）。
8. F（flag 转正，方案 C 分两版）。
9. 合 main + 发布（日期版本号）。
