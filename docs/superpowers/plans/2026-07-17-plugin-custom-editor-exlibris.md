# 子项目④：自定义编辑器机制 + base/exlibris 迁移 + v1 退役

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 tab 内嵌自定义编辑器机制（iframe + `plugin://` + parent↔iframe postMessage，宿主拥有文档 I/O），迁移 base 与 exlibris，最后退役全部 v1 插件机制。全程 v2 flag 门控。

**分期与门控（用户已定）：**
- **④a 自定义编辑器机制 + fixture**：本会话构建（可测层 + fixture）。iframe 焦点/Cmd+S/滚动只能真机验证 → **穿刺 GUI 手测是用户步骤**。
- **④b exlibris 迁移**：窗口插件（类 openclaw：UI 窗口 + 后端 crate），本会话完整做。
- **base 本体迁移**：门控在用户对 ④a fixture 的 GUI 穿刺验证通过之后（机制若不可行则调整设计，如降级为窗口编辑器）。
- **④c v1 退役**：**破坏性、门控在用户对整个 v2 栈的 GUI 实机验证通过之后**——本会话只写退役清单/计划，不执行删除。

**Architecture（自定义编辑器机制，穿刺验证目标）：** 主窗口的 tab 内容区渲染 `<iframe src="plugin://<id>/editor.html">`。宿主 serve 该 HTML 时**注入桥 <script>**（iframe 拿不到 initialization_script，改为 HTML 响应内联注入）——iframe 内 `window.notemd.request()` 经 fetch `plugin://<id>/__rpc__` 照常访问 host.* 方法（Origin=plugin://<id> 认证）。**文档通道走 parent↔iframe postMessage**（主 app 持有 iframe 元素）：主 app 读文件 → `iframe.contentWindow.postMessage({type:'custom_editor.open', uri, content}, 'plugin://<id>')`；iframe 编辑 → `parent.postMessage({type:'change', content}, '*')` → 主 app 收 → `setContent(tabId, content)`（翻转 dirty）；Cmd+S 走既有 saveActive（读 tab.currentContent 写盘），iframe 不碰磁盘。未装插件时 `.base` 降级为纯文本 tab + 提示条（file-over-app）。

**已核实：** EditorPane.svelte:84-122 tab 内容 switch（kind='base' 分支 :98）；TabKind='markdown|html|code|spreadsheet|base'（types.ts:146）；tabs.svelte.ts saveActive:302-327 / setContent:268-271 / isDirty:40-42 / openFile:166-170（classifyPath null 抛错,无降级）；fs.ts:78 `.base`→kind base；windows.rs bridge_script/protocol.rs serve；base 前端 src/lib/base + BaseView.svelte（yaml 解析,applyRaw→setContent）；App.svelte:373 base 分派。exlibris：独立 app（src-tauri 后端 import 管线/calibre/规则/verify + Svelte 前端 + 自己的 updater），tag 前缀 exlibris-v,scripts/release-exlibris.sh。

**工作区纪律：** 同分支堆叠；精确 git add；不删 v1（base/exlibris/openclaw v1 全留至 ④c，且 ④c 门控用户验证）。

---

### Task 1: 自定义编辑器机制——iframe 桥注入 + 协议 + tab 集成

**Files:** Modify `src-tauri/src/plugin_runtime/protocol.rs`（serve HTML 注入桥）、`plugin-protocol/src/lib.rs`（custom_editor 协议类型）、`src/lib/plugins/types.ts`（TabKind 'custom' + editorId）、`src/lib/plugins/custom-editors.ts`（新：扩展名→编辑器注册表,从 v2 manifests 建）、`src/components/CustomEditorIframe.svelte`（新）、`src/components/EditorPane.svelte`（渲染分支）、`src/lib/tabs.svelte.ts`（openFile 降级 + custom kind）

- [ ] Step 1: protocol.rs——serve `text/html` 且路径匹配某插件 custom_editors.entry 时,在响应 body 注入 `<script>${bridge_script(plugin_id, locale, theme)}</script>`（bridge_script 已存在于 windows.rs——抽为 pub(crate) 复用；注入位置:`<head>` 后或 body 首）。普通窗口 entry 不注入（窗口走 initialization_script）——区分:custom_editor 的 HTML 请求如何标识?决策:**所有** plugin:// 的 html 响应都注入桥 script（幂等——窗口已有 initialization_script 定义 window.notemd,注入的 script 检测 `if(!window.notemd)` 才定义；这样窗口与 iframe 统一）。改 bridge_script 首行加 `if (window.notemd) return;` 守卫（IIFE 内）。
- [ ] Step 2: plugin-protocol 加 custom_editor 消息类型（走 postMessage,非 JSON-RPC,但类型共享给 TS）:`CustomEditorOpen { uri, content, editor_id }`、`CustomEditorChange { content }`、`CustomEditorSave { uri }`（仅 TS 侧用,Rust 不处理——这些是 parent↔iframe,不经 host）。**决策**:custom_editor 消息纯前端(主 app↔iframe),不进 Rust/protocol crate；仅在 `src/lib/plugins/v2/custom-editor-msg.ts` 定义 TS 类型。跳过 protocol crate 改动。
- [ ] Step 3: types.ts:TabKind 加 `'custom'`；Tab 加可选 `editorId?: string`、`editorPluginId?: string`。custom-editors.ts:`buildCustomEditorRegistry(manifests)` → `Map<ext, {pluginId, editorId, entry}>`（扫 v2 manifests 的 contributes.custom_editors.file_extensions）；`customEditorFor(ext): entry | null`。
- [ ] Step 4: tabs.svelte.ts openFile:classifyPath 得 kind；若 ext 命中 customEditorFor → kind='custom' + editorId/editorPluginId；classifyPath null 时,若有 custom editor 则 custom,否则**降级 kind='code'（纯文本）而非抛错**（file-over-app;.base 未装插件→文本打开）。
- [ ] Step 5: CustomEditorIframe.svelte:props tab；渲染 `<iframe src={plugin://pluginId/entry} sandbox="allow-scripts allow-same-origin">`；onload 后 postMessage `custom_editor.open{uri:tab.filePath, content:tab.currentContent, editor_id}` 给 iframe.contentWindow（targetOrigin `plugin://<id>`）；listen window 'message' 事件（校验 event.origin===plugin://<id> + event.source===iframe.contentWindow）:`change` → setContent(tab.id, content)。卸载解绑。
- [ ] Step 5b: EditorPane.svelte:kind==='custom' 分支渲染 `<CustomEditorIframe {tab} />`（在 base 分支位置附近,`{#key tab.id}`）。保留 base 分支不动（v1 base 仍用,直到 base 迁移）。
- [ ] Step 6: 单测:buildCustomEditorRegistry（manifests→map）、customEditorFor、openFile 降级（无 editor 的未知扩展→code 不抛错）。Rust:protocol serve html 注入桥（handle_parsed 对 .html 响应含 bridge script + `if(window.notemd)return` 守卫）。
- [ ] Step 7: `cargo test` + `pnpm check && pnpm vitest run` → PASS。Commit `feat(plugin-v2): custom-editor mechanism — iframe bridge injection + postMessage doc channel + tab integration`。

---

### Task 2: fixture 自定义编辑器插件 + 穿刺手测清单

**Files:** Create `plugins-src/custom-editor-fixture/`（Vite ui-only 插件:一个 textarea 编辑器,收 custom_editor.open 填充,input 时 postMessage change）；manifest（custom_editors: [{id, file_extensions:['.cef'], entry:'editor.html'}]，menus New 命令）；dev-install 分支

- [ ] Step 1: 脚手架（roam-import 模式,ui-only）。editor.html:textarea + 桥脚本消费——监听 message custom_editor.open → textarea.value=content；textarea input → parent.postMessage({type:'change', content:value}, '*')。可选调 host.toast 验证 fetch-RPC 桥在 iframe 内也通。
- [ ] Step 2: manifest.v2.json:id `notemd.cef-fixture`,ui-only,custom_editors + File▸New .cef 菜单（command create → 前端 host 处理器建空 .cef 文件并 openFile）。dev-install 加分支。
- [ ] Step 3: 自动化可测部分（vitest）:CustomEditorIframe 的 message 路由（mock iframe + 派发 message 事件 → setContent 被调）；origin 校验（错误 origin 的 message 被忽略）。
- [ ] Step 4: **穿刺手测清单**（写入插件 README + 报告,用户 GUI 执行）:flag 开 + 装 fixture → File▸New .cef → tab 内出现 iframe textarea → 输入文字 → tab 标题出现 dirty 标记 → Cmd+S 保存成功、dirty 清除 → 关 tab 重开内容保留 → 测 Cmd+Z/Cmd+A/Cmd+C 在 iframe 内、焦点切换、滚动、拖拽。**这些决定 base 能否 tab 内嵌;不通则 base 降级窗口编辑器。**
- [ ] Step 5: `pnpm --filter cef-fixture-plugin build` + 全量回归。Commit `test(plugin-v2): custom-editor fixture plugin +穿刺 checklist`。
- [ ] Step 6: **门控**:base 迁移（Task 3）等用户穿刺验证通过。本会话到此暂停 base，转 exlibris（Task 4）。

---

### Task 3: base 迁移（门控:穿刺通过后）

**Files:** Create `plugins-src/base/`（Vite:BaseView + src/lib/base 移植,桥接 custom_editor.open/change 替 setContent 直连；yaml 解析随迁）；manifest（custom_editors .base + File▸New Base）；dev-install 分支

- [ ] Step 1: 拷贝 src/lib/base + BaseView.svelte 进插件；editor.html 装载 BaseView；applyRaw 的 `setContent` → `parent.postMessage({type:'change', content:yaml})`；初始 content 从 custom_editor.open 收（替代读 tab）；目录扫描（base 列文件夹 markdown 元数据）经 `host.vault.*`（需 vault.read capability）。
- [ ] Step 2: manifest:id `notemd.base`,ui-only,custom_editors [{id:'base-table', file_extensions:['.base'], entry:'editor.html'}],menus File▸New Base(v2),capabilities ['vault.read','toast']。
- [ ] Step 3: dev-install 分支 + 穿刺回归（.base 打开/编辑/保存/未装降级文本）。全量回归。Commit `feat(plugin-v2): base migrated as v2 custom-editor plugin`。

---

### Task 4: exlibris 迁移（窗口插件,类 openclaw）

**Files:** Create `plugins-src/exlibris/{backend/, ...UI}`（后端 crate:import 管线/calibre/规则/verify 移植;UI:exlibris Svelte 前端移植,invoke→bridge.request）；manifest（binary + ui + window open_command）；dev-install 分支

- [ ] Step 1: 侦察 exlibris 的 tauri 命令面（exlibris/src-tauri）→ 后端 crate `notemd-exlibris`（SDK,on_ui_request 分派命令,进度经 host.ui_post 推 UI）。deps（epub 解析/calibre 调用/yaml）移进 crate。exlibris 有自己的 sotvault 共享目录约定——经 host.vault.info 拿 vault root。
- [ ] Step 2: UI:拷 exlibris/src → plugins-src/exlibris,invoke('x')→bridge.request('x'),事件→onMessage。i18n 内联。
- [ ] Step 3: manifest:id `notemd.exlibris`,binary 双架构 + ui,window open_command,capabilities ['ui','vault.read','vault.write','dialog','toast']。tray "Open Books" 迁 Window 菜单项(tray 迁移随④c)。
- [ ] Step 4: dev-install 分支 + 构建验证 + 全量回归。**独立 exlibris app 停止发布记入 ④c**。Commit `feat(plugin-v2): exlibris migrated as a v2 window plugin`。

---

### Task 5: v1 退役计划（写清单,不执行——门控用户 GUI 验证）

**Files:** Create `docs/superpowers/plans/2026-07-17-v1-retirement-checklist.md`（详尽删除清单,分插件）

- [ ] Step 1: 编写退役清单（每项含文件 + 验证方式）:
  - **五插件 v1 前端删除**:src/{roam-import-*,chat-*}、src/lib/{openclaw,roam-import,base}、src/components/{chat,BaseView.svelte}、src/lib/base；vite.config.ts 的 chat/roamImport 入口；chat.html/roam-import.html。
  - **五插件 v1 后端删除**:src-tauri/src/openclaw、src-tauri/plugins/{md2pdf,roam-import,openclaw-chat,base}（manifest + bin）、md2pdf crate、show_{chat,roam_import,insights?}_window、App.svelte 的 pluginId=== 分支、tray-openclaw、capabilities windows 项。
  - **v1 one-shot 机制删除**（若无 v1 插件剩余）:plugin_host.rs 的 run_plugin_binary/invoke_plugin、v1 PluginManifest（若 adapter 仍需 v1 形状则保留结构）、collect_top_menu_items 的 v1 部分。**注意**:adapter 把 v2 映射成 v1 PluginManifest 形状复用收集机制——退役 v1 后需评估是否保留该形状或改为 v2 原生收集。
  - **deps 清理**:tokio-tungstenite/qrcode/gethostname/urlencoding（openclaw 专用,移进插件 crate 后可从 src-tauri 删,确认无他用）；yaml（base 前端）；objc2-*（md2pdf,若 crate 删）。
  - **独立 app**:exlibris app 停止发布,冻结 exlibris-v tag 线,scripts/release-exlibris.sh 归档。
  - **flag 转正**:plugins_v2 从内测 flag 改为默认开?或保持 flag 直到市场部署?——决策留用户。
- [ ] Step 2: 每项标注验证方式（grep 无引用 / 测试仍绿 / 手测该功能经 v2 可用）。
- [ ] Step 3: Commit `docs(plans): v1 retirement checklist (gated on user GUI verification of v2 stack)`。

---

### Task 6: spec 回写 + review

- [ ] Step 1: spec §21「实施记录（子项目④）」:自定义编辑器机制（iframe 桥注入 + postMessage 文档通道 + `if(window.notemd)return` 幂等守卫 + 降级文本）；base/exlibris 迁移;穿刺门控 base 本体;v1 退役门控用户验证。
- [ ] Step 2: 全量回归 + review（机制安全:iframe sandbox/origin 校验/postMessage 认证;集成:dirty/save 正确性;穿刺清单完备）→ 修复轮。
- [ ] Step 3: Commit + 汇报。

---

## Self-Review 记录

- **Spec 覆盖**:§7.3 自定义编辑器（T1/T2）、§0.1 base/exlibris 迁移（T3/T4）、§10 v1 退役（T5,门控）、④期界定（T5 flag 转正决策留用户）。
- **占位符**:base 迁移门控穿刺（T2 Step6 明确暂停）;v1 退役只写不执行（T5 明确）;exlibris 命令面待 T4 Step1 侦察。均为明确门控/侦察指令。
- **类型一致性**:CustomEditorOpen/Change（custom-editor-msg.ts）↔ CustomEditorIframe postMessage ↔ editor.html 消费三处一致;TabKind 'custom' + editorId 贯穿 types/openFile/EditorPane。
- **风险**:iframe 桥注入——html 响应注入 script 需正确定位插入点（`<head>`/body 首）且不破坏插件 HTML;穿刺若发现 Cmd+S/焦点不通→base 降级窗口（T2 Step4 已备降级路径）;postMessage origin 校验必须严（event.origin + event.source 双验,防其他 iframe/窗口伪造）;sandbox 属性权衡（allow-same-origin 让 iframe 可用 plugin:// fetch,但也放宽隔离——评审重点）。
