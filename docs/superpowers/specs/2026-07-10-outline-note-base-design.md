# `.note.md` 大纲笔记基础功能升级 — Design

**Date:** 2026-07-10
**Status:** Approved，待实现
**关联:**
- 修订 [2026-07-09-outline-notes-design.md](./2026-07-09-outline-notes-design.md)（伴生文件后缀、面板编辑语义）
- 修订 [2026-07-09-outline-independent-view-design.md](./2026-07-09-outline-independent-view-design.md)（R3 默认可编辑 → 本设计改为只读预览）

## Summary

把 `.note.md` 处理方式升级为**产品级基础功能**：

- 后缀语义：`.note.md` 表示"大纲笔记格式"，只描述格式，不描述从属关系。
- 打开行为（硬性规则）：插件 `outline-notes` **启用**时，任何 `.note.md` 在任何入口
  打开，一律用**大纲视图全屏 tab** 编辑，绝不用普通 markdown 编辑器；插件**未启用**
  时降级为普通 markdown 编辑器。普通 `.md` 照旧。
- 从属关系推断（硬性规则）：`xxx.note.md` 同目录存在同名 `xxx.md` → 它是该文档的
  批注（伴生）文件；不存在 → 独立笔记。**不得**用目录白名单等其他方式判断。
- vault（`sotvault_vault_root`，git 同步根）内目录约定：
  - `vault/{wikipage}/`：独立 wiki 笔记，文件名 `{title-slug}.note.md`
  - `vault/{dailynote}/{yyyy}/`：每日/月度/年度笔记
  - 其他任意目录：普通文档 `xxx.md` + 同目录批注 `xxx.note.md`
  - `wikipage`、`dailynote` 目录名为**全局可配置**，默认值即字面 `wikipage`、`dailynote`
- 全 vault 一个 `[[title]]` 命名空间，跨目录全局解析；索引是派生数据可随时全量重建，
  文件是唯一事实源。

## 决策记录（与用户逐条确认）

| 决策点 | 结论 |
|---|---|
| 后缀 `.notes.md`(现状) vs `.note.md`(规范) | 统一为 `.note.md`，存量自动迁移 |
| 伴生侧边栏去留 | 保留但**只读**（预览 + 跳转/编辑入口） |
| 建 wiki 页入口 | 仅"点击未解析 `[[title]]` 时创建"这一个入口 |
| "打开今天的 dailynote"入口 | 系统托盘（TrayIcon）菜单项 |
| 全屏大纲架构 | 方案 A：大纲作为 tab 视图，树变更序列化回 `tab.currentContent` |
| 应用内文件重命名 + 改名联动 | **本次不做**（应用内无重命名入口，规则暂无触发点，见"暂缓项"） |

---

## 1. 后缀统一与迁移（`.notes.md` → `.note.md`）

- `companionPathFor()`（`src/lib/outline/store.svelte.ts`）、`pageNameOf()`
  （`backlinks.ts`）等所有引用改为 `.note.md`。
- 自动迁移（git 可追溯，不做备份副本）：
  1. vault 全量索引构建时，发现 `*.notes.md` 就地重命名为 `*.note.md`；
     目标已存在则跳过并 toast 提示。
  2. 打开 `xxx.md` 时若只有旧后缀伴生文件，先迁移再挂载。
- 迁移完成前，解析/配对逻辑同时识别旧后缀作为遗留兼容。

## 2. 文件格式：YAML front-matter + 嵌套无序列表

- `parseOutline` / `serializeOutline`（`src/lib/outline/markdown.ts`）扩展：
  识别并保留头部 YAML front-matter；至少含 `title`（原始标题，未 slug 化）、
  `created`、`updated`；未知键（如迁移来源的 `roam-uid`）原样保留；
  `updated` 每次落盘时刷新。
- 新建的独立笔记/日记生成完整 front-matter；存量无 front-matter 的文件在
  下次保存时补上（`title` 取文件名去后缀，`created` 取文件 birthtime，取不到用当前时间）。
- 正文为 markdown 无序列表嵌套（`- ` + 两空格缩进表示层级），保证任何纯文本
  编辑器可读。既有 `type::` / `id::` / `collapsed::` 等属性行格式不变。
- 正文支持 `[[title]]` 双链语法（解析规则见 §5）。

## 3. 打开行为：大纲全屏 tab（方案 A）

- `classifyPath`（`src/lib/fs.ts`）识别 `.note.md`：插件启用 → 新 kind
  `outline`；未启用 → 照旧 `markdown`。kind 在打开时决定；切换插件开关后
  已开 tab 不动，重开生效。
- App.svelte：kind 为 `outline` 的 tab，rich 模式渲染新的全屏大纲编辑组件
  （复用 OutlineNode / SlashMenu / LinkAutocomplete / NodeContextMenu 等）；
  **source 模式切到原文编辑**（SourceView 直接工作在 `currentContent` 上）。
- 数据流：大纲组件每次树变更 `serializeOutline` 回写 `tab.currentContent`
  → 脏标记、Cmd+S、autosave、外部变更横幅、关闭确认全部复用 tabs 既有机制，
  大纲**不再有独立写盘管线**。
- store 重构：`src/lib/outline/store.svelte.ts` 的全局单例状态改为**可实例化**
  （每个大纲 tab 一棵树 + 独立选区/编辑态），旧全局实例留给只读侧边栏。

## 4. 伴生侧边栏只读化

- OutlinePanel 变为只读预览：展示伴生大纲，点击节点/标题跳转到对应大纲 tab
  （未打开则打开），面板顶部加"编辑"按钮。
- 自动派生（引文同步）从面板移到**大纲 tab 挂载时**执行：打开伴生型
  `.note.md` 的大纲 tab 时，对其主文档跑一次 `syncAutoItems`。面板本身
  不再写盘。已知代价：主文档编辑期间派生条目不实时刷新，需打开大纲 tab。
- 面板与大纲 tab 同时存在时：面板镜像 tab 的实时内容（只读），不产生双写。

## 4.5 FolderView 对 `.note.md` 的特殊呈现

- **独立笔记**（同目录无同名 `xxx.md`）：行保留，图标换成专属 note 图标
  （与现有 15×15 描边 SVG 风格一致）。
- **伴生笔记**（同目录存在同名 `xxx.md`）：**隐藏 `xxx.note.md` 行**，
  在 `xxx.md` 行文件名后显示"有笔记"角标。
- 角标可点击：直接打开对应大纲笔记 tab（行主体照旧打开 `xxx.md`）。
- 实现位置：`readFolder()`（`src/lib/folder-view.svelte.ts`）分类阶段做同目录
  配对——给 `xxx.md` 条目打 `hasNote: true` 并剔除配对的 `.note.md` 条目；
  迁移完成前旧后缀 `.notes.md` 同样参与配对。
- 此呈现**不随插件开关变化**（是格式语义的呈现）；插件未启用时角标点开
  进普通 markdown 编辑器（降级规则）。

## 5. 全局链接命名空间（vault 级索引）

- 索引根从"文件夹视图根"升级为 **vault 根**（`sotvault_vault_root`）；
  递归索引全部 `.md` / `.note.md`（≤1MB，跳过点目录/符号链接）。
- `[[title]]` 解析优先级：front-matter `title` 匹配（大小写不敏感）→
  文件名 slug 兜底。跨所有目录全局解析，不按目录隔离。
- slug 化：中文等非 ASCII 保留原文，替换文件系统非法字符
  `/ \ : * ? " < > |`。
- **title/slug 碰撞**：以 front-matter `title` 为准；索引构建时检测碰撞，
  toast 警告并列出冲突文件路径；**不自动改名**，不阻塞索引。
- 点击未解析 `[[title]]` → 在 `vault/{wikipage}/` 创建
  `{title-slug}.note.md`（front-matter `title` 存原始标题）并以大纲 tab 打开。
  文件在 vault 外时维持现状行为。
- 索引为派生数据，可随时全量重建；文件是唯一事实源。

## 6. Dailynote

- 全局配置：`wikipage` / `dailynote` 目录名，settings store 持久化，
  默认 `wikipage`、`dailynote`；配置 UI 放大纲插件设置页。
- 路径与命名（front-matter `title` 即日期字符串本身）：
  - 每日：`vault/{dailynote}/{yyyy}/{yyyy-MM-dd}.note.md`
  - 月度总结：`vault/{dailynote}/{yyyy}/{yyyy-MM}.note.md`
  - 年度总结：`vault/{dailynote}/{yyyy}/{yyyy}.note.md`
  - 文件名字典序即时间序，无需额外排序逻辑。
- 托盘菜单加 **"Today's Note"**（i18n）：Rust 端 `build_tray_menu` 加菜单项，
  点击发事件到主窗口 → 前端 `ensureDailyNote(today)` 按需创建目标文件
  （含 front-matter 和空大纲，按需建 `{yyyy}` 目录）→ `openFile` 以大纲 tab
  打开并前置窗口。插件未启用时同样可用，文件进普通 markdown 编辑器（降级规则）。
- 日期链接**规范形式**：`[[yyyy-MM-dd]]` / `[[yyyy-MM]]` / `[[yyyy]]` 直接按
  路径规则解析到 dailynote 文件（先于索引匹配），点击时不存在则走
  `ensureDailyNote` 创建。**不支持**其他日期书写格式的链接解析。

## 7. 暂缓项（本次明确不做）

- **应用内文件重命名与"改名联动"**：规范要求对 `xxx.md` 重命名时同一原子操作
  同步重命名配对 `xxx.note.md`（防批注孤儿）。当前应用内无重命名入口，规则
  暂无触发点；未来加入重命名功能时**必须**实现 `renamePair()` 原子联动。
- 普通 `.md` 富文本编辑器内的 `[[title]]` 补全/渲染增强（维持现状）。

## 8. 测试与验收

- 单测：slugify、front-matter 解析/序列化往返、`companionPathFor`、
  日期链接解析、`ensureDailyNote` 路径推导、title 解析优先级、碰撞检测、
  迁移改名逻辑、FolderView 配对合并。
- GUI 改动（全屏大纲 tab、只读面板、FolderView 角标、托盘项）按惯例
  dev 实机验证后再发布。

## 实施分期（每期可独立合入）

1. **格式与后缀**：`.note.md` 统一 + 迁移 + front-matter 支持
2. **大纲 tab**：classify、store 实例化重构、全屏编辑组件、面板只读化、FolderView 呈现
3. **vault 索引**：全局命名空间、title 优先解析、碰撞报告、wikipage 创建
4. **dailynote**：目录名配置、托盘入口、ensureDailyNote、日期链接规范解析
