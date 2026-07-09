# Outline Notes（大纲笔记）— Design

**Date:** 2026-07-09
**Status:** Approved (design), pending implementation plan

## Summary

新增**大纲笔记**内置功能：开启后，主编辑区**右侧**出现一个大纲笔记面板，
为当前打开的 markdown 文件提供 Roam/hulunote 式的大纲编辑体验——无限层级
bullet、缩进/反缩进、折叠、拖拽、`[[页面链接]]` 与反向链接、`/` 斜杠命令菜单、
`[[` 自动补全、可配置快捷键。

大纲内容存为主文件的**伴生文件**（`foo.md` → `foo.outline.md`），**永不修改
原文**。首次打开时从原文提取标题/列表结构生成初始大纲。

交互逻辑与行内语法移植自开源项目 hulunote
（`~/git/hulunote/hulunote`，ClojureScript → TypeScript 翻译重写），
主要来源：`render.cljs`（大纲交互）、`parser.cljc`（行内文法）、
`shortcuts.cljs`（快捷键引擎）、`db.cljs`（分数排序模型）。

## Positioning

这是**内置 Svelte 功能模块**，不是 binary 命令插件——现有插件系统
（`src/lib/plugins/`）只支持一次性动作（toast/剪贴板/设置合并），无法承载
持久 UI 面板。先例：FolderView（左侧面板）、CsvEditor（内置编辑器）。

桌面优先；iOS 路径本期不触碰（面板 gated on `platformName !== 'ios'`）。

## 开关与入口

- `settings.outline = { enabled: boolean, panelWidth: number, shortcuts: Record<string, string> }`，
  持久化走现有 tauri Store（`settings.svelte.ts` 模式）。默认 `enabled: false`。
- SettingsDialog 新增"大纲笔记"开关；关闭时**无任何 UI 痕迹**。
- 开启后：编辑区右上出现面板切换按钮（与 ModeToggle 同区域风格），
  默认快捷键 `Mod+Shift+O`（可配置）。仅 markdown 类标签页可用；
  `*.outline.md` 自身的标签页不显示按钮（避免大纲套大纲）。

## Layout & Components

- `src/App.svelte` 的 `section.pane`（flex row）内，`<EditorPane>` **右侧**渲染
  `<OutlinePanel>`，与左侧 FolderView 对称。
- 面板左缘有可拖拽 splitter（默认 360px，min 240，max 640），宽度持久化。
- 新文件：

```
src/lib/outline/                    纯逻辑，每个文件配 vitest 测试
  model.ts          节点树模型与操作原语
  markdown.ts       伴生文件 markdown ↔ 节点树 双向转换
  extract.ts        从主文件提取生成初始大纲
  parser.ts         hulunote 行内文法解析器（→ AST）
  commands.ts       大纲编辑命令（indent/outdent/建节点/移动/折叠/删除/合并）
  shortcuts.ts      快捷键引擎（归一化、显示、匹配、冲突检测）
  backlinks.ts      文件夹级 [[链接]] 索引与反链查询
  completion.ts     [[ 自动补全与 / 斜杠菜单的数据源
  store.svelte.ts   面板反应式状态（当前树、编辑焦点、菜单状态、脏标记）
src/components/outline/
  OutlinePanel.svelte       面板容器：头部（标题、重新提取按钮）+ 树 + 反链区
  OutlineNode.svelte        递归节点：bullet、折叠三角、contenteditable、拖拽
  InlineRender.svelte       AST → 渲染（失焦态）
  SlashMenu.svelte          / 命令浮层
  LinkAutocomplete.svelte   [[ 补全浮层
  NodeContextMenu.svelte    右键菜单
  BacklinksSection.svelte   反向链接区（面板底部）
```

## 数据模型（源：hulunote `db.cljs` + `render.cljs`）

```ts
interface OutlineNode {
  id: string          // 懒分配：仅当被 ((引用)) 时才生成并写入文件
  parentId: string | null
  order: number       // 分数排序：插入取相邻两序中值，不重排兄弟
  content: string     // 原始行内文本（含 [[..]] 等语法）
  collapsed: boolean
}
```

- 树 = 父引用 + 同级 `order` 排序（hulunote `same-deep-order` 模型）。
- `calculate-order-between` / `normalize-sibling-orders` 逻辑照搬：
  当两序间隔小于阈值时对该层兄弟做一次归一化重排。

## 伴生文件格式

- 命名：`<stem>.outline.md`（`foo.md` → `foo.outline.md`，`foo.markdown` 同样
  → `foo.outline.md`），与主文件同目录。
- 内容为标准 markdown 无序列表：每节点以 `- <content>` 起行，两空格缩进表层级；
  节点内容可多行（如围栏代码块），续行缩进对齐到 content 列（Logseq 同款），
  解析时归回同一节点。
- 节点属性行（Logseq 风格 `key:: value`）紧跟节点行、多缩进两空格，
  **仅在非默认值时写入**：
  - `id:: <uuid>` — 节点被块引用时；
  - `collapsed:: true` — 节点折叠时。
- **验收：markdown ↔ 树 往返无损**（含属性行）；普通 markdown 阅读器打开
  伴生文件仍是可读的缩进列表。

## 首次提取（extract.ts）

主文件 → 初始大纲的规则（仅在伴生文件不存在时执行；原文只读）：

- 跳过 frontmatter；
- `#`~`######` 标题 → 节点，层级按标题级别相对嵌套；
- 列表项（`-`/`*`/`+`/有序）→ 按缩进嵌套在最近标题之下；
- 段落 → 最近标题下的单节点（全文为 content）；
- 围栏代码块 → 单节点，content 保留完整 ``` 围栏。

面板头部提供"重新从原文提取"按钮，覆盖现有大纲前弹确认对话框
（走现有 dialogs.ts）。

## 大纲交互（源：hulunote `render.cljs`，功能完整移植）

编辑态每节点一个 contenteditable（hulunote 行为：编辑显示原始文本，
失焦渲染行内语法）。

固定按键（不可配置，编辑器语义）：
- `Enter` → 在下方建兄弟节点（光标在行首时在上方建，即 `create-sibling-above!`）；
- `Backspace` 于行首 → 与上一可见节点合并；空节点删除；
- `↑`/`↓` 于行首/行尾 → 跨可见节点移动焦点（`get-prev/next-visible-nav`）；
- 输入 `[` 后再输 `[` → 自动补全为 `[[]]` 并弹出补全菜单。

可配置快捷键（默认值，Settings 可改）：
- `Tab` / `Shift+Tab` — 缩进 / 反缩进（`indent-nav!` / `outdent-nav!`）；
- `Mod+ArrowUp` — 折叠/展开当前节点；
- `Alt+ArrowUp` / `Alt+ArrowDown` — 节点上移/下移（同级换序）；
- `Mod+Shift+O` — 面板显示/隐藏；
- `Mod+B` / `Mod+I` — 行内 `**粗体**` / `__斜体__` 包裹（`apply-inline-wrap!`）。

拖拽移动：拖 bullet，按 hulunote `detect-drop-mode` 判定——落点在目标节点
下缘 → 后置兄弟（`move-nav-after!`）；落点带缩进偏移 → 成为子节点
（`move-nav-to-child!`）。禁止拖入自身后代（`valid-drop-target?`）。

右键菜单：复制文本、复制子树为 markdown、复制块引用 `((id))`（触发懒分配 id）、
删除（含子树，确认）。

## 行内文法（源：hulunote `parser.cljc`，完全按 hulunote 语义）

`parser.ts` 将 Instaparse 文法翻译为 TS 递归下降解析器，输出 AST：

- `[[页面链接]]`（内容可嵌套 `[[..]]`）；
- `#标签` 与 `#[[多词标签]]`；
- `((块引用))`（id 为 `[a-zA-Z0-9_-]+`）；
- `**粗体**`、`__斜体__`、`~~删除线~~`、`^^高亮^^`、`` `行内代码` ``；
- `[文字](url)` 链接、`![alt](url)` 图片、裸 http(s) URL；
- 围栏代码块节点整体渲染为代码块。

**不采用**现有 `wikilink-plugin.ts` 的 `[[目标|别名]]` 语法（已裁决）；
wikilink-plugin 仅继续服务 rich 模式，两者互不影响。

渲染（InlineRender.svelte）：页面链接/标签可点击（打开或创建对应文件夹内
`.md`，复用 tabs.svelte.ts 的 openPath）；块引用悬停显示被引节点内容、
点击跳转；主题样式全部走现有 CSS 变量（**不移植** hulunote theme.cljs，已裁决）。

## 双向链接与反链（backlinks.ts）

- 索引范围：**当前打开的文件夹**（FolderView 根目录；未开文件夹时仅索引
  已打开标签页）。
- 扫描所有 `.md`（含伴生文件）中的 `[[目标]]` 与 `#标签`，目标解析为文件
  stem（`foo.outline.md` 与 `foo.md` 同属页面 "foo"），大小写不敏感。
- BacklinksSection 显示：引用当前页面的 (文件, 节点文本) 列表，点击打开
  对应文件。
- 文件变更增量更新：复用现有 file-watcher 事件重扫单文件。
- 性能护栏：仅解析 ≤ 1MB 的 md 文件；索引在首次打开面板时惰性构建。

## `/` 斜杠菜单与 `[[` 自动补全

- 节点编辑态输入 `/`（行首或空格后）弹 SlashMenu：页面链接、粗体、斜体、
  删除线、高亮、行内代码、代码块。↑↓ 选择、Enter 确认、Esc 关闭、
  继续输入过滤（hulunote `filtered-slash-commands` 语义）。
- `[[` 弹 LinkAutocomplete：候选 = 文件夹内页面名（backlinks 索引提供），
  按输入过滤；Enter 选中项替换 `[[query]]`；无选中项时保留手输文字成链
  （hulunote `confirm-page-link-entry!` 语义）；`]]` 或 Esc 关闭。
- 两菜单均为面板内绝对定位浮层，锚定光标位置。

## 可配置快捷键（shortcuts.ts，源：hulunote `shortcuts.cljs`）

- 按键归一化（`normalize-shortcut`）、Mac/Win 修饰键显示（`display-shortcut`
  的 ⌘/Ctrl 映射）、`event->shortcut` 匹配、`editable-target?` 作用域判定。
- SettingsDialog"大纲笔记"区内提供逐条改绑 UI（点击输入框按下新组合键），
  与核心快捷键及插件快捷键冲突时提示（复用 `findShortcutConflicts` 的
  reserved 列表思路）。
- 存储于 `settings.outline.shortcuts`，缺省回退默认表。

## 保存与错误处理

- 面板编辑 → store 树变更 → 序列化 markdown → 写伴生文件。写入时机：
  跟随现有 autoSave 设置（debounce 同现有值）；关闭标签页/失焦面板兜底保存。
- 伴生文件被外部修改（file-watcher 事件）：面板无未保存改动则静默重载；
  有则显示与现有 ExternalChangeBanner 一致的提示条。
- 写入失败 → 现有 toast 错误通道；解析失败的行降级为纯文本节点（不丢内容）。
- 主文件只读打开，任何路径都不写主文件（**验收：原文件字节级不变**）。

## i18n

新增文案走现有 `src/lib/i18n`（中英两份）：面板标题、按钮、设置项、
菜单项、确认对话框。

## Testing

遵循仓库惯例（lib 逻辑全测）：

- `markdown.test.ts` — 往返无损（属性行、深层嵌套、空节点、特殊字符）；
- `parser.test.ts` — hulunote 文法用例（嵌套页面链接、标签变体、转义、URL 截断）；
- `extract.test.ts` — 标题/列表/段落/代码块/frontmatter 提取；
- `model.test.ts` / `commands.test.ts` — 分数排序、归一化、indent/outdent、
  合并删除、拖拽目标合法性；
- `backlinks.test.ts` — 索引、增量更新、大小写、页面名解析；
- `shortcuts.test.ts` — 归一化、平台显示、冲突检测；
- `completion.test.ts` — 过滤与确认语义。

组件层以 `pnpm check`（svelte-check）+ 手动验证清单兜底。

## 验收标准

1. markdown ↔ 大纲树往返无损（含 `id::` / `collapsed::`）；
2. 原文件在任何操作路径下字节级不被修改；
3. parser 通过 hulunote 文法移植用例；
4. 开关关闭时无任何 UI 痕迹；`pnpm test` / `pnpm check` 全绿；
5. 手动清单：开启开关 → 打开 md → 面板提取生成大纲 → Enter/Tab/折叠/拖拽/
   斜杠菜单/[[补全/反链跳转逐项可用 → 重启后伴生文件与面板宽度恢复。

## Out of Scope（本期不做）

- iOS 适配；大纲内 mermaid/KaTeX 渲染；Vault 全局反链；
- 块引用的跨文件嵌入编辑（transclusion，只做悬停预览与跳转）；
- 主编辑区与大纲面板的双向同步（原文永远只读）。
