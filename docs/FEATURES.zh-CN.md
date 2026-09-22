# note.md —— 完整功能清单

[English](FEATURES.md) · [简体中文](FEATURES.zh-CN.md) · [← README](../README.zh-CN.md)

note.md 今天能做的每一件事。README 讲主张，这里放细节。

## 笔记层

为 AI Agent 原生就绪的笔记系统，逐步落地中：

- [x] **手记（sidecar notes）** —— 阅读 `xxx.md` 时的高亮与评论保存到
      同目录的 `xxx.note.md`。源文档保持干净、可再生成；你的判断成为可检索
      的永久数据。没有同名源文件的 `.note.md` 则是一篇独立笔记。
- [x] **大纲编辑器** —— 所有 `.note.md` 一律以 Roam 风格的大纲视图打开
      （绝不用普通 markdown 编辑器）；大纲持久化为嵌套的 markdown 列表，
      文件在任何编辑器里都可读。
- [x] **每日笔记** —— 独立的「每日笔记」窗口，无限懒加载信息流串起
      `dailynote/yyyy/yyyy-MM-dd.note.md`，一键或托盘直达；`[[yyyy-MM-dd]]`
      为日期链接的规范形式，`[[页面]]` 链接就地打开。
- [x] **Roam Research 同步** —— 继续使用 Roam，同时把页面和每日笔记汇集到
      Vault，供 Agent 统一检索和计算。内置插件支持持续 CLI 同步和全图 JSON
      导入，并将日期页改写为 `[[yyyy-MM-dd]]`、给出断链报告。
- [x] **批注问答闭环** —— 批注里带 `?` 就是向 agent 提的问题；`.note.md`
      承载状态机，外部 agent 扫描处理，答复以 `type:: answer` 节点回来，
      由你决定是否采纳进正文。agent 永远不写源 `.md`。
- [x] **Wiki 页面** —— 可配置的 `wikipage/` 目录下的独立大纲笔记，全 vault
      共用一个 `[[title]]` 命名空间。检索认得它们：精确输入页名时，`[[…]]`
      会创建的那一页被硬置顶。
- [x] **全局索引** —— 全库即时搜索，按来源分层排序，可随时从文件全量重建
      （索引是派生数据，文件是唯一事实源）。查询语法：`tag:` `type:` `path:`
      `ext:` `after:` `before:` `page:[[X]]`
      `origin:human|derived|source|unlabeled`，以及引号短语。原始资料
      （`.srt`/`.vtt`/`.txt` 转写稿）在你指定的目录内收录。重命名与移动靠
      内容 hash 认出，改目录名只更新路径，不重建每个文件。也能无界面使用
      —— 见「为 agent 而生」里的 `notemd search`。（反向链接与 linked
      references 已在 `.note.md` 间生效。）
- [x] **智能查找** —— `Cmd/Ctrl+K` 将自然语言需求变成经过校验的本地检索计划，
      把日期、路径、标签、类型与来源约束同真正的检索词分开。界面优先显示匹配
      笔记与原文预览；快速简答以及交给 Claude、Codex 或 DeepSeek 深入研究都保留
      为用户明确触发的动作。涉及时间的问题会先按冻结的本地日期和时区解算，再
      执行检索。
- [x] **受控个人 Memory** —— agent 可以发现并提出长期主张，但只有用户能确认、
      否认、标为重要或忽略。Role 与 Scope Registry 将身份和工作场景隔离；权威
      修订保存在 `.notemd/memory/`，`USER.md` 与 `MEMORY.md` 是可重建、方便人读的
      投影视图。Memory 还提供受控共写工作区，以稳定块身份、精确版本审阅、可恢复
      草稿和人工采纳来管理 agent 的修改建议。
- [x] **本地 Vault MCP server** —— `notemd mcp` 通过 stdio 提供 MCP，暴露只读
      `search` 与 `vault_info` 工具。它与应用和 CLI 共用热索引，只通过本机套接字或
      命名管道连接正在运行的应用，不开放 TCP 端口，并可在设置中关闭。

## 阅读与批注

- **富文本阅读视图** —— KaTeX 公式、Mermaid 图表、Graphviz（` ```dot ` /
  ` ```graphviz `）、highlight.js 代码高亮；HTML 在沙箱 iframe 中预览；
  约 36 种代码文件渲染为高亮代码块；图片以预览标签打开。渲染器按需加载，
  没有图的文档不付出任何代价。
- **高亮标记**（`^^文字^^` 或 `==文字==`）—— 双模式黄色高亮；源码模式
  `Cmd+H` 快速包裹选区。
- **行内批注** —— 基于 CriticMarkup 的评论与提问，锚在原文里，同步进手记
  大纲；`✦` 代表 AI 写的，`●` 代表你想的。
- **块 ID（mdblock）** —— 每个顶层块（段落、标题、代码块、列表、表格 …）
  获得稳定的 `b-xxxxxx` id，任何位置用 `((path/to/file.md#b-xxxxxx))`
  即可按子页面粒度引用——对人和 agent 同样有效。id 抗编辑（内容 MinHash +
  五轮合并）；块元数据存中央缓存，绝不污染你的文件目录。点击侧栏标记复制
  引用；`Cmd+Enter` 跳转。
- **阅读洞察** —— 逐文档的阅读/编辑投入度存入 vault；任意日期范围
  可从 CLI 或 **View → Reading Insights** 生成 markdown 摘要。
- **附件与视频卡片** —— 文档、音频、视频链接渲染为芯片/卡片；YouTube 与
  Bilibili 链接自动取标题，渲染为品牌色播放卡片。
- **目录视图** —— 以只读大纲显示当前 Markdown（包括尚未保存的标题），点击即可
  跳转；在富文本或源码模式滚动时，当前标题会随阅读位置高亮，重名标题也能正确
  区分。
- **排版书籍** —— 可选的排版阅读器把 `*.typeset.md` 转成带缓存的 Typst 分页。
  大书完成首批页面即可阅读，后续页面继续在后台生成；中日韩内容自动使用合适的
  书籍模板，也可在页面右键菜单中持久指定模板和缩放。

## 写作与编辑

- **源码 / 富文本切换**（`Cmd+/`）—— 纯文本 ↔ 所见即所得，按标签页记忆。
- **斜线菜单**（空行输入 `/`）与**块快捷键**（`Cmd+1–6` 标题、
  `Cmd+Shift+K` 代码块、`Cmd+Shift+M` 公式、`Cmd+Shift+T` 表格、
  `Cmd+Opt+U/O/X` 列表 …）。
- **Live-Preview 风格标记** —— 输入 `**`、`` ` ``、`==` 等保持源码原样，
  不自动折叠；已有标记正常渲染，光标所在行显示源码分隔符。
- **Wikilink 双链** —— `[[笔记]]` 渲染为链接，点击打开（或新建）同目录的
  `笔记.md`；`[[笔记|别名]]` 显示别名。
- **任务复选框**、**裸 URL 自动链接**、**可折叠且可内联编辑的 YAML 元数据
  卡片**、导出/分享全链路**换行保真**。阅读时，卡片可识别 wikilink、Markdown
  链接、裸网址与标量列表，同时不改变源文。
- **随手粘贴** —— 截图落盘到 `{文档名}_files/` 并以相对路径插入；文件粘贴
  为附件链接；图片点击出现尺寸工具栏（25 / 50 / 75 / 100%）。
- **右键菜单** —— 源码与富文本双模式的完整自定义右键菜单。
- **CSV 电子表格** —— `.csv` 以可编辑网格打开，支持公式（`=SUM(A1:A3)`、
  跨单元格引用）、行列操作、深色主题；`/电子表格` 斜线命令可在 markdown
  内嵌入表格。
- **查找与替换**（`Cmd+F` / `Cmd+H`）—— 正则、全字、大小写选项，双模式可用。
- **可读 JSON 源码** —— 合法 `.json` 进入源码模式时会用两空格展开紧凑内容，
  同时保留键顺序、重复键、数字写法和转义；无效 JSON 与 JSONC 保持原文，格式化
  结果是一项普通的未保存修改。
- **来源控制的只读文档** —— 顶层 `readonly: true` 会阻止富文本、源码、元数据、
  保存、覆盖、另存和历史恢复修改 Markdown；外部同步器仍可刷新已经打开的文档。
- **新建文件**（`Cmd+N`）与托盘 Quick Note 会直接在 Vault 配置的 inbox 中创建
  空白临时 Markdown。手动保存时，未命名文档自动成为 `YYYY-MM-DD-标题.md`，没有
  有效标题则用时间兜底；已有文件名绝不重写，重名自动追加序号。

## 文件与 Vault

- **文件夹视图** —— 实时目录树侧栏，递归正则过滤，右键在访达中显示；
  全局排序、按文件夹置顶、视图模式（全部 / 文件 / 有笔记 / markdown[H1名] /
  笔记）。
- **可切换侧栏** —— 左右侧栏注册表 + 标题栏下拉切换器。
- **JSON Canvas 无限画布** —— 创建和编辑兼容 Obsidian 的标准 `.canvas` 文件，
  支持文本、文件/图片、链接、分组卡片，带标签的连线，平移缩放，套索与框选，
  智能吸附、对齐与分布，多选缩放，上下文工具，复制粘贴及撤销重做。往返时保留
  未知 JSON Canvas 字段，并以受保护的原子保存、自动保存和外部变更处理保障文件。
  新画布先保存为 `Vault/canvas/untitled.canvas`，手动保存时按日期加标题（或时间）
  自动命名。
- **外部修改检测** —— 干净标签页静默重载；脏标签页出现冲突提示条
  （重载 / 覆盖 / 删除后可恢复）。绝不静默丢数据。
- **Sync to Vault** —— 把任意文件复制进 git 同步的 vault，日期前缀
  命名、来源映射、冲突感知刷新。批注 vault 之外的文件会自动把它镜像进来，
  于是批注永远有一个稳定的、git 版本化的宿主。
- **大文件门禁** —— 超过可配置阈值的文件留在工作区、不进 vault commit，
  托盘显示状态。
- **多标签页**（脏标记、拖拽排序）；右键可关闭当前、左侧或全部标签，并保留原有
  保存确认；**自动保存**（可选）；**最近文件**；Finder 双击 / 拖拽打开。

## 为 agent 而建

- **块引用** —— `((file#b-xxxxxx))` 给 agent 一种跨 vault 稳定引用与跳转
  段落的方式。
- **`AGENTS.md` 约定** —— vault 的规矩以纯文本放在根目录，任何 CLI agent
  本来就会读。
- **`notemd search`** —— 给 agent 的检索，形状照着 grep 来：默认输出
  `path:line:text`，一行一条命中，`rg`/`grep` 的习惯照用。`--json` 额外给出
  `source_ref`（`path#Lline`）、`origin`、来源信息（`agent_by`、
  `human_verified`）与 `attention_minutes`（用户自己在这份文档上花过的
  注意力分钟数，已按 30 天半衰期衰减到今天，0 = 没有数据，排序已经计入
  它；这份数据由桌面端摄取，CLI 只读不摄取，所以在从没用 GUI 打开过这个
  vault 的机器上它恒为 0）—— 模型写的命中会自报家门，agent 可以顺着它回到原始
  文档，而不是直接采信。退出码把「无命中」（1）与「没有 vault」（2）分开；
  检索也从不硬失败：索引不可用或新鲜度检查超预算时，降级为直接扫文件，
  stderr 留一行说明。默认上限 20 条，`--limit N` 可调，`--all` 返回全部。
- **`notemd doctor`** —— 自检本地环境、Vault、搜索索引、插件与网络连通性
  （`--offline` 跳过联网，`--json` 机器可读）。
- **`notemd` CLI** —— 不开 GUI 驱动插件功能：`notemd share draft.md` 发布
  分享链接；`--json` 结构化输出；`notemd reading-insights report` 生成投入度摘要；
  已启用插件还可增加 `meetings-sync`、`apple-notes-sync`，以及 Memory、邮件与转写
  勘误的只读/提案式命令。操作型命令会让 note.md 在后台保持可用，不会额外打开或
  聚焦窗口。从 **Help → Install 'notemd' Command in PATH…** 安装。
- **两个不同的 MCP 表面** —— 本地 `notemd mcp` 只读检索 Vault 并返回信息；可选的
  分享 Worker 另有一个 MCP 端点，可代你发布文档。
- **插件系统（v2）** —— 跨进程插件（stdin/stdout JSON）*外加*隔离 webview 的
  UI 插件；manifest 声明式注册菜单、上下文菜单、设置面板、侧栏、托盘项、CLI
  子命令，宿主能力按声明授权，未触发时不运行。插件还可按扩展名、文件名、路径或
  frontmatter 声明文件视图；入口与 Rich、Source 并列，失败时回退到内置编辑器。
  安装、更新、启用、停用或移除插件后，运行时、菜单、快捷键与已打开视图无需重启
  即可刷新。可在应用内市场（[plugins.notemd.net](https://plugins.notemd.net)）
  浏览安装。自己写插件见 [`plugin-v2-development.md`](plugin-v2-development.md)。

## 官方插件与文件视图

- **Memory 2.5.2**（需要 note.md 6.906.1+）—— 上述受控个人 Memory 与受控共写
  工作区。
- **会议 1.0.3**（macOS；需要 note.md 6.906.2+）—— 安全迁移 Hemory 对话，或用
  `notemd meetings-sync` 增量归档新增和变化的带说话人、时间码逐字稿；dry run、
  checkpoint、journal 与冲突报告保护本地修改，且永不复制音频。
- **时间轴 1.0.4**（需要 note.md 6.909.4+）—— 将 `type: timeline` 的 Markdown
  显示为竖向每日时间表，支持交叠活动、可配置分类、日期导航和打开定位时间。
- **索引查看器 1.0.2**（需要 note.md 6.910.1+）—— 将 `*.index.md` 显示为封面
  画廊、多列表格、分组列表或泳道看板。标题层级提供分类，单行列表属性、标签、
  wikilink 与相对文件链接仍是可移植的 Markdown。
- **电子书导入 1.5.0**（macOS；需要 note.md 6.910.1+）—— 从 Open Library 获取
  书目与封面、用 Apple Books 补查，维护动态封面索引、AI 阅读笔记与主题整理；
  新书正文写为 `book.typeset.md`，同时兼容既有 `book.md`。
- **助理邮箱 0.1.6**（macOS；需要 note.md 6.912.1+）—— 从专用 Worker 拉取获准
  邮件，在 Vault 中保存配对的 `.eml` 与完整性 JSON 归档。可信界面提供净化后、
  sandbox 隔离的 HTML 预览；Agent CLI 只披露有界元数据，删除必须先审阅计划。
- **Apple Notes 同步 1.0.4**（macOS；需要 note.md 6.915.1+）—— 将 Apple Notes
  的账户与多层文件夹镜像为 `applenotes/` 下可读、受来源控制的 Markdown，支持
  附件、手动或每五分钟自动同步、journal 恢复、删除保护，并把稳定身份集中保存到
  `applenotes/id-sync.json`。
- **提取知识浏览器 3.2.0**（需要 note.md 6.916.1+）—— 在主编辑器中把支持的提取
  知识 JSON 打开为交互式图谱、关系组、时间线、阅读视图或诊断；保留多方关系角色
  与原文证据，并且不修改数据集。
- **沟通转写勘误 0.1.9**（macOS；需要 note.md 6.916.1+）—— 审阅用户本人参与的
  沟通中的正式名、别名与 ASR 误识别，跨公共场景合并词条，并按场景应用已批准的
  替换或保留规则。Agent 只能查询或提交草稿，不能批准；可选的
  `build-conversation-dictionary` Skill 用来准备待审数据集。
- **排版阅读器 0.1.1**（macOS；需要 note.md 6.921.2+）—— 上述渐进 Typst 视图，
  与电子书导入 1.5.0 联动。
- 市场还提供 **Roam Research 同步**、**Base**（Obsidian `.base` 表格）、
  **周检视**、**决策**、Claude / Codex / DeepSeek Agent、**OpenClaw Chat**、
  md→PDF 等。

## 分享与导出

- **分享** —— `Cmd+Shift+L` 把当前文件发布为自包含网页，托管在你
  自己的 Cloudflare Worker：KaTeX、Mermaid SVG、语法高亮、浅/深主题、移动端
  适配。可原址更新、随时撤销；图片多的文档溢出到 R2。部署见
  `worker/README.md`。
- **PDF 导出**（`Cmd+Shift+E`）—— 排版干净的 A4 PDF，公式、图表、代码高亮
  全部内联（离屏 WKWebView 渲染，无 headless Chromium）。
- **图片上传** —— 图片标签页 `Cmd+Shift+L` 上传 R2 并复制公开 URL。

## 应用本体

- **四语界面** —— English、Deutsch、简体中文、日本語——覆盖对话框、原生桌面
  菜单、托盘及插件文案；Preferences 即时切换，无需重启。
- **Typora 主题兼容** —— 导入任意 Typora 主题 `.zip`；浅色/深色可分别选主题，
  跟随 macOS Appearance。内置 **default**（GitHub 风格）与 **effie**（薄荷纸
  配色，霞鹜文楷）。
- **菜单栏托盘**、Typora 风格通知条、全界面缩放（`Cmd+=` / `Cmd+-` / `Cmd+0`）。
- **macOS 13+ 与 Windows 10/11 x64** 桌面版本。macOS 提供签名、公证的 Apple
  Silicon 与 Intel 双 `.dmg`，按架构自动更新；Windows 使用独立安装包，生成时间
  可能晚于同一轮 macOS 发布。
