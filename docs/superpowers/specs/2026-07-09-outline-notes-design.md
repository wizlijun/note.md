# Outline Notes（大纲笔记）— Design

**Date:** 2026-07-09（修订 v3：独立设置标签 + 面板隐藏/搜索按钮）  
**Status:** Implemented；v3 增量随 3.17.13 发布

## Summary

新增**大纲笔记插件**（builtin 前端插件，可启用/关闭，关闭时零资源占用）。  
启用后与 Folder View 对称：编辑区**右侧**多一个 **Outliner View**，为当前  
markdown 文件提供大纲笔记面板。

大纲内容有三个来源：

1. **TOC 自动同步**——主文档的标题层级实时同步为大纲骨架；
2. **高亮自动同步**——用户在主文档中 `^^标注^^` 的内容，按其所在 TOC 层级  
   位置同步为大纲项；**取消标注后对应大纲项自动删除**；
3. **手写笔记**——用户在大纲中手工书写的节点，享受完整大纲交互  
   （hulunote 式：缩进/折叠/拖拽/`[[链接]]`/`/` 菜单/反链），  
   自动重算/重新生成时**永不被修改**。

每个自动项记录主文档**相对行号锚点**；点击大纲项反向跳转到原文位置。  
原文变化时通过 debounce 重派生 + diff 匹配重算锚点与自动项，  
另提供手动"重新生成"。大纲存为主文件的**伴生文件**  
（`foo.md` → `foo.notes.md`），**永不修改原文**。

交互逻辑与行内语法移植自开源项目 hulunote（ClojureScript → TypeScript
翻译重写），参考文件清单见下节。

## 参考代码仓库

**hulunote**（移植来源）：`/Users/bruce/git/hulunote/hulunote`

| 参考文件（`src/cljs/hulunote/` 下） | 移植内容 → 目标文件 |
|---|---|
| `render.cljs` | 大纲全部交互：建/删/缩进/折叠/拖拽（`detect-drop-mode`、`move-nav-after!`、`move-nav-to-child!`）、键盘处理（`handle-key-down`）、`/` 菜单（`filtered-slash-commands`、`execute-slash-command!`）、`[[` 补全（`update-page-link-menu!`、`confirm-page-link-entry!`）、行内包裹（`apply-inline-wrap!`）→ `commands.ts`、`completion.ts`、组件层 |
| `db.cljs` | 节点模型（id/parid/same-deep-order）、分数排序（`calculate-order-between`、`normalize-sibling-orders!` 在 render.cljs）→ `model.ts` |
| `parser.cljc` | Instaparse 行内文法（页面链接/标签/块引用/粗斜删高/代码/URL/图片）→ `parser.ts` |
| `shortcuts.cljs` | 按键归一化、Mac/Win 显示、事件匹配、作用域判定 → `shortcuts.ts` |
| `settings/hotkeys.cljs` | 快捷键改绑设置 UI 交互 → 设置页大纲区 |
| `single_note.cljs` | 子树 → markdown 序列化（`get-all-navs-content`）→ `markdown.ts` 与右键"复制子树为 markdown" |
| `components.cljs` | AST → 渲染（`parse-and-render`）→ `InlineRender.svelte` |

**mdeditor 内部先例**（集成模式参照）：

- `src-tauri/plugins/folder-view/manifest.json` — builtin 插件清单格式；
- `src/lib/folder-view.svelte.ts` + `src/components/FolderView.svelte` —
  前端插件状态管理（`plugins.enabled`）、侧面板布局/splitter/持久化；
- `src/App.svelte` `dispatchPlugin` 的 `folder-view` 分支 — View 菜单命令拦截；
- `src/lib/slash-menu/` — 浮层菜单组件模式；
- `src/lib/plugins/registry.ts` `findShortcutConflicts` — 快捷键冲突检测。

## Positioning：builtin 前端插件（Folder View 同款机制）

完全复用现有 builtin 插件模式：

- `src-tauri/plugins/outline-notes/manifest.json`，`"kind": "builtin"`，  
  `"default_enabled": false`；声明 View 菜单项 "Outliner View"  
  （默认快捷键 `Cmd+Shift+O`，command `toggle`）+ i18n（zh/ja）。
- 插件设置页（PluginsSettingsTab）自动出现启停开关，状态存共享的  
  `plugins.enabled` 表（`isPluginEnabled('outline-notes')`）。
- `App.svelte` 的 `dispatchPlugin` 拦截 `outline-notes`/`toggle` 走前端逻辑  
  （同 `folder-view` 分支）。

**关闭时零资源**：大纲模块整体经 `import()` 懒加载——未启用或未显示时不加载  
代码、不挂编辑监听、不建反链索引、不 mount 组件；关闭插件时完全 teardown  
（退订、清索引、卸组件）。

桌面优先；iOS 路径本期不触碰。

## Layout

- `App.svelte` 的 `section.pane` 内，`<EditorPane>` **右侧**渲染  
  `<OutlinePanel>`（gated on `platformName !== 'ios' && outline.enabled && outline.visible`），与左侧 FolderView 对称。
- 面板左缘可拖拽 splitter（默认 360px，min 240，max 640），宽度与可见性  
  持久化（folder-view.svelte.ts 同款 Store 用法）。
- 仅 markdown 类标签页可用；`*.notes.md` 自身的标签页不启用面板。

## 数据模型（源：hulunote `db.cljs`，扩展节点来源与锚点）

```ts
type NodeSource = 'toc' | 'highlight' | 'manual'

interface OutlineNode {
  id: string            // 稳定 id；auto 节点跨重算保持（diff 匹配）
  parentId: string | null
  order: number         // 分数排序（hulunote calculate-order-between）
  content: string       // 行内文本（含 [[..]] 等语法）
  collapsed: boolean
  source: NodeSource
  anchorLine?: number   // auto 节点：主文档 1-based 相对行号
}
```

- 树 = 父引用 + 同级 `order`；间隔过小时对该层做一次归一化重排  
  （hulunote `normalize-sibling-orders!`）。
- `id` 懒持久化：手写节点被 `((引用))` 或 auto 节点挂有手写子节点时写入文件。

## 派生与实时同步（derive.ts + sync.ts）

**派生规则**（主文档 → auto 节点集）：

- 跳过 frontmatter 与围栏代码块内部；
- `#`\~`######` 标题 → `toc` 节点，层级按标题级别相对嵌套；
- `^^文本^^` 与 `==文本==`（mdeditor rich 模式二者同为 highlight mark，  
  统一捕获）→ `highlight` 节点，挂在其所在位置最近的上方标题对应的  
  `toc` 节点之下；标题之前的高亮挂根；
- 每个 auto 节点记录 `anchorLine` = 标题行 / 高亮起始行的 1-based 行号。

**实时同步**（主编辑区 → 大纲）：

- 订阅当前 tab 的内容变化（`tab.currentContent` 反应式 / 编辑 onChange），  
  debounce \~300ms 重派生；
- 新旧 auto 节点集做 **diff 匹配**（按 source + 文本 + 相对次序，LCS 式），  
  匹配成功的节点保持 `id` 不变——折叠状态与其下手写子节点因此存活，  
  仅更新 content 与 `anchorLine`；
- 新增 → 插入对应位置；消失（标题删除 / **高亮标记取消**）→ 删除该 auto  
  节点，其下手写子树**重挂到最近存活的祖先**（最终兜底挂根），不丢内容；
- 外部文件变更（file-watcher）→ 同一重派生管线。

**手动"重新生成"**：面板头部按钮，强制全量重派生（绕过 diff 的 id 保持，  
用于结构混乱时兜底），手写节点仍按"重挂最近祖先"规则保留，覆盖前确认。

**编辑权限**：auto 节点（toc/highlight）内容与结构**只读**——其文本与层级  
由主文派生，且原文只读是硬约束（不做大纲→原文回写）；可折叠、可在其下  
添加手写子节点。手写节点开放全部编辑与结构操作。

## 反向跳转（点大纲 → 原文位置）

- 点击 auto 节点（或其跳转图标）→ 主编辑区滚动定位到 `anchorLine`：
  - source 模式：按行号直接定位高亮该行；
  - rich 模式：以 `anchorLine` 映射的标题/高亮文本在文档中定位第一个匹配  
    （行号 → 序列化 markdown 的行 → moraya 编辑器位置），滚动至视口并闪烁；
- 锚点因实时同步始终新鲜（每次重派生全量重算行号），无需独立的行号  
  平移修正；同步 debounce 窗口内的点击按当前文本内容兜底搜索。

## 伴生文件格式

- 命名：`<stem>.notes.md`（`foo.md` → `foo.notes.md`），与主文件同目录；标准 markdown 无序列表，  
  `- <content>` 起行，两空格缩进表层级；节点内容可多行（续行缩进对齐到  
  content 列，Logseq 同款），解析归回同一节点。
- 节点属性行（`key:: value`，紧跟节点行、多缩进两空格，仅非默认值写入）：
  - `type:: toc` / `type:: highlight` —— auto 节点标记（无此属性 = 手写）；
  - `line:: <n>` —— auto 节点锚点行号；
  - `id:: <uuid>` —— 被块引用或需要稳定身份时；
  - `collapsed:: true` —— 折叠时。
- **验收：markdown ↔ 树 往返无损**（含全部属性行）；普通阅读器打开仍是  
  可读缩进列表。

## 大纲交互（源：hulunote `render.cljs`，作用于手写节点）

编辑态节点为 contenteditable（hulunote 行为：编辑显示原始文本，失焦渲染  
行内语法）。

固定按键：`Enter` 下方建兄弟（行首则上方建）；行首 `Backspace` 与上一可见  
节点合并、空节点删除；行首/行尾 `↑`/`↓` 跨可见节点移动焦点；`[` 后再输  
`[` 自动补 `]]` 并弹补全菜单。

可配置快捷键（默认，Settings 可改）：`Tab`/`Shift+Tab` 缩进/反缩进；  
`Mod+ArrowUp` 折叠/展开（auto 节点亦可）；`Alt+ArrowUp/Down` 同级上移/下移；  
`Mod+B`/`Mod+I` 行内粗体/斜体包裹（`apply-inline-wrap!`）。

拖拽移动（仅手写节点可拖；落点可为任意节点）：hulunote `detect-drop-mode`  
——落点下缘 → 后置兄弟；缩进偏移 → 成为子节点；禁止拖入自身后代。

右键菜单：复制文本、复制子树为 markdown、复制块引用 `((id))`（懒分配 id）、  
删除（手写节点，含子树确认）；auto 节点菜单为：跳转原文、复制文本、  
复制子树为 markdown。

## 行内文法（源：hulunote `parser.cljc`，完全按 hulunote 语义）

`parser.ts` 将 Instaparse 文法翻译为 TS 递归下降解析器，输出 AST：  
`[[页面链接]]`（可嵌套）、`#标签` 与 `#[[多词标签]]`、`((块引用))`、  
`**粗体**`、`__斜体__`、`~~删除线~~`、`^^高亮^^`、``行内代码``、  
`[文字](url)`、`![alt](url)`、裸 http(s) URL；围栏代码块节点整体渲染。

**不采用**现有 `wikilink-plugin.ts` 的 `[[目标|别名]]` 语法（已裁决）；  
wikilink-plugin 仅继续服务 rich 模式，互不影响。

渲染（InlineRender.svelte）：页面链接/标签可点击（打开/创建文件夹内同名  
`.md`，复用 tabs 的 openPath）；块引用悬停预览、点击跳转；样式全部走现有  
CSS 变量（**不移植** hulunote theme.cljs，已裁决）。

## 双向链接与反链（backlinks.ts）

- 索引范围：**当前打开的文件夹**（FolderView 根目录；未开文件夹时仅索引  
  已打开标签页）；
- 扫描 `.md`（含伴生文件）中的 `[[目标]]` 与 `#标签`，目标解析为文件 stem  
  （`foo.notes.md` 与 `foo.md` 同属页面 "foo"），大小写不敏感；
- BacklinksSection（面板底部）显示引用当前页面的 (文件, 节点文本) 列表，  
  点击打开对应文件；
- file-watcher 事件驱动单文件增量重扫；索引在面板首次显示时惰性构建，  
  插件关闭时释放；仅解析 ≤ 1MB 的 md 文件。

## `/` 斜杠菜单与 `[[` 自动补全（手写节点编辑态）

- `/`（行首或空格后）弹 SlashMenu：页面链接、粗体、斜体、删除线、高亮、  
  行内代码、代码块；↑↓ 选择、Enter 确认、Esc 关闭、继续输入过滤  
  （hulunote `filtered-slash-commands` 语义）；
- `[[` 弹 LinkAutocomplete：候选 = 文件夹内页面名，输入过滤；Enter 替换  
  `[[query]]`；无选中项保留手输文字成链（`confirm-page-link-entry!` 语义）；  
  `]]`/Esc 关闭；
- 均为面板内锚定光标的绝对定位浮层。

## 可配置快捷键（shortcuts.ts，源：hulunote `shortcuts.cljs`）

按键归一化（`normalize-shortcut`）、Mac/Win 修饰显示（`display-shortcut`）、  
`event->shortcut` 匹配、`editable-target?` 作用域。设置页"大纲笔记"区逐条  
改绑（按下新组合键录入），冲突时提示（对照核心/插件 shortcut 表，复用  
`findShortcutConflicts` 思路）。存 `settings.outline.shortcuts`，缺省回退  
默认表。

## 保存与错误处理

- 大纲变更（手写编辑、同步重算、折叠）→ 序列化 → 写伴生文件：跟随现有  
  autoSave 设置 debounce；关标签页/失焦面板兜底保存；
- 伴生文件被外部修改：面板无未保存改动则静默重载（重载后立即对当前主文  
  重跑一次同步），有则显示 ExternalChangeBanner 同款提示条；
- 写入失败 → 现有 toast 错误通道；解析失败的行降级为手写纯文本节点；
- 主文件在任何路径下只读（**验收：原文件字节级不变**）。

## 代码结构

```
src-tauri/plugins/outline-notes/manifest.json   builtin 插件清单
src/lib/outline/                     纯逻辑，每文件配 vitest；经 import() 懒加载
  model.ts / markdown.ts / parser.ts / commands.ts / shortcuts.ts /
  backlinks.ts / completion.ts
  derive.ts        主文 → TOC/高亮 auto 节点集（含 anchorLine）
  sync.ts          debounce 重派生 + diff 匹配 + 手写子树重挂
  reveal.ts        anchorLine → 主编辑区定位（source/rich 两路）
  store.svelte.ts  面板反应式状态 + enabled/visible/width 持久化
src/components/outline/
  OutlinePanel.svelte / OutlineNode.svelte / InlineRender.svelte /
  SlashMenu.svelte / LinkAutocomplete.svelte / NodeContextMenu.svelte /
  BacklinksSection.svelte
```

## i18n

新增文案走现有 `src/lib/i18n`（中英）+ manifest 内 zh/ja；面板标题、按钮、  
设置项、菜单、确认对话框。

## Testing

- `derive.test.ts` — 标题层级/高亮归属/代码块与 frontmatter 跳过/anchorLine；
- `sync.test.ts` — diff 匹配保 id、折叠与手写子树存活、取消高亮删除对应项、  
  手写子树重挂最近祖先、重新生成语义；
- `markdown.test.ts` — 往返无损（type::/line::/id::/collapsed::、多行节点、  
  深层嵌套、特殊字符）；
- `parser.test.ts` — hulunote 文法用例（嵌套页面链接、标签变体、URL 截断）；
- `model.test.ts` / `commands.test.ts` — 分数排序、归一化、结构操作、  
  auto 节点只读约束、拖拽合法性；
- `backlinks.test.ts` / `shortcuts.test.ts` / `completion.test.ts` — 同前；
- 组件层以 `pnpm check` + 手动验证清单兜底。

## 验收标准

1. 插件关闭：无任何 UI 痕迹，`src/lib/outline/**` 代码不被加载，无监听/索引；
2. markdown ↔ 大纲树往返无损；原文件任何路径下字节级不变；
3. 主文编辑标题/增删 `^^高亮^^` → 面板 ≤1s 内同步；取消高亮 → 对应项消失  
   且其手写子节点重挂保留；
4. 点击 auto 节点 → 主编辑区（source 与 rich 两模式）定位到对应位置；
5. 重新生成后手写节点全部保留；
6. `pnpm test` / `pnpm check` 全绿；
7. 手动清单：插件页启用 → View 菜单/快捷键开面板 → TOC 出现 → 打高亮出现  
   → 手写子节点 → 改原文标题 → 大纲跟随且手写保留 → 重启后一切恢复。

## 修订 v3：独立设置标签 + 面板隐藏/搜索按钮

本次迭代不改同步/保存/伴生文件逻辑，仅调整设置归置与面板头部工具栏。

### 1. 大纲设置独立成 Settings 标签

- 原先大纲快捷键改绑 UI 内嵌在 **Settings → Core** 标签内、以
  `isPluginEnabled('outline-notes')` 门控。改为**独立标签**：
  - 标签条新增 `settings.tab.outline`（"大纲笔记" / "Outline" / "アウトライン"），
    紧随 OpenClaw 标签之后；
  - 门控从 `isPluginEnabled`（持久化的"下次启动是否加载"）改为
    **`isPluginActive('outline-notes')`**——即插件**已实际加载**时才出现，
    与 OpenClaw 标签同款语义（`_activePluginIds` 来自 `get_plugin_manifests`）；
  - 快捷键区块整体迁入该标签的内容分支，Core 标签不再承载大纲设置；
  - 移除 SettingsDialog 中不再使用的 `isPluginEnabled` import。
- **视图菜单入口**：无需新增——manifest 已声明 `location: "view"` 的
  "大纲视图"（`Cmd+Shift+O`，command `toggle`），经 Rust 注册为原生 View
  菜单项。不再叠加重复项。

### 2. OutlinePanel 头部工具栏

`header` 布局：`[« 隐藏]  标题(flex:1)  [⌕ 搜索] [⟳ 刷新] [＋ 加笔记]`

- **左上角隐藏按钮**（`«`）→ `setOutlineVisible(false)`，整体收起面板，
  与 View 菜单 / `Cmd+Shift+O` 联动，可见性持久化到 store（既有 API）。
- **右上角搜索按钮**（`⌕`，toggle）→ 在 header 下展开输入框：
  - 对**当前文档大纲**做大小写不敏感子串过滤；命中节点 + 其祖先路径保留，
    其余隐藏；无视折叠（命中项始终展开可见）；清空 / Esc / 关闭即恢复全量；
  - 实现：给 `OutlineNode` 增可选 prop **`visibleIds: Set<string> | null`**，
    `null` = 现有全量渲染（零行为变化）；非 null 时按集合过滤子节点、并以
    `visibleIds ? kids.length>0 : !collapsed` 决定是否展开子树；
  - 面板层 `visibleIds` 为 `$derived`：遍历 `outline.tree.nodes`，命中节点沿
    `parentId` 链补齐祖先入集合；`searchQuery` 为空时返回 `null`；
  - **搜索期间隐藏 BacklinksSection**（`{#if !visibleIds}`）。
- `⟳` 即原有"重新生成"（从源文重建），承担"刷新"语义；`＋` 加根笔记保留。

### 3. i18n

新增键（en/zh/ja）：`settings.tab.outline`、`outline.hide`、`outline.search`、
`outline.searchPlaceholder`、`outline.noSearchResults`。

### 4. 验收（v3 增量）

- 插件未加载时：Settings 无"大纲笔记"标签；加载后出现且仅含快捷键区；
- 面板 `«` 收起面板、菜单项状态联动；
- `⌕` 过滤：输入即时收敛到命中项 + 祖先路径，清空恢复，搜索时反链区隐藏；
- `pnpm check` 0 error、`pnpm test` 全绿（859 tests）。

## Out of Scope（本期不做）

- iOS 适配；大纲内 mermaid/KaTeX 渲染；Vault 全局反链；
- 块引用跨文件嵌入编辑（只做悬停预览与跳转）；
- 大纲 → 原文回写（原文永远只读；auto 节点在大纲中只读）。