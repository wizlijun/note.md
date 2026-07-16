# note.md

[English](README.md) · [简体中文](README.zh-CN.md) · [notemd.net](https://notemd.net)

> **Read what AI writes. Keep what you think.**
> 读 AI 写的，留下你想的。

**note.md** 是为 AI-native 时代打造的 markdown 阅读器与编辑器——当大多数文档
由 agent 写出，人最有价值的动作正从"写"转向**读、判断与批注**。人和 agent
在同一批纯文本文件里协作：agent 写文档，你阅读并做标记，你的批注又成为 agent
可读的数据。没有数据库、没有云端、没有锁定——只有一个永远属于你的 markdown
文件夹。

产品名为 **note.md**（全小写——一篇笔记就是一个 markdown 文件）；CLI 二进制与
bundle identifier 为 `notemd` / `net.notemd.app`，旧的 `mdedit` CLI 软链仍与
`notemd` 并存可用。源码中仍会看到 `mdeditor`（Rust 库 crate 名为 `mdeditor_lib`）。
v4.8.0 之前以 **M↓** 为名发布。

基于 [Tauri](https://tauri.app) 与
[`@moraya/core`](https://www.npmjs.com/package/@moraya/core) 构建：签名并公证的
原生 macOS `.app`——原生 Rust 二进制，菜单、窗口、菜单栏托盘均为系统原生控件——
编辑器 UI 为 Web 技术，渲染在系统 WebView（WKWebView）中，不像 Electron 捆绑
浏览器。

## 产品理念

三个信念贯穿所有设计：

1. **AI 的文字是无限的，你的注意力不是。** 你真正读过、标注过的文档，才是
   赢得了你注意力的那部分——这个信号是你拥有的最有价值的数据。note.md 把它
   留存下来，而不是任它消失在滚动条里。
2. **文件高于应用（files over app）。** 每篇笔记都是磁盘上的纯 `.md`：
   对 git 友好、可 grep、今天能用任何编辑器打开、五十年后依然可读。索引是
   派生数据，文件是唯一事实源。
3. **agent 是一等公民。** vault 的全部约定都是 agent 可读的纯文本。`✦` 代表
   AI 写下的，`●` 代表你想到的。这个循环——agent 写、你批注、agent 从你的
   批注中学习——完全通过磁盘上的文件运转。

## 笔记层

AI-native 笔记系统，逐步落地中：

- [x] **旁车批注（sidecar notes）** —— 阅读 `xxx.md` 时的高亮与评论保存到
      同目录的 `xxx.note.md`。源文档保持干净、可再生成；你的判断成为可检索
      的永久数据。没有同名源文件的 `.note.md` 则是一篇独立笔记。
- [x] **大纲编辑器** —— 所有 `.note.md` 一律以 Roam 风格的大纲视图打开
      （绝不用普通 markdown 编辑器）；大纲持久化为嵌套的 markdown 列表，
      文件在任何编辑器里都可读。
- [ ] **每日笔记** —— `dailynote/yyyy/yyyy-MM-dd.note.md` 一键直达；
      `yyyy-MM.note.md` / `yyyy.note.md` 作为月度/年度总结；
      `[[yyyy-MM-dd]]` 为日期链接的规范形式。
- [ ] **Wiki 页面** —— `wikipage/` 下的独立大纲笔记，全 vault 共用一个
      `[[title]]` 命名空间。
- [ ] **全局索引** —— 全库即时搜索、反向链接、链接自动补全，可随时从
      文件全量重建。
- [ ] **Roam 导入** —— 从 Roam Research JSON 导出一次性转换（含日期页
      改写与断链报告）。
- [ ] **Vault MCP server** —— 暴露 `vault_search` / `vault_read` /
      `vault_annotate`，任何 agent（Claude Code、Codex、OpenClaw、Hermes …）
      都能操作你的 vault，note.md 只是众多客户端之一。

## 功能

### 阅读与批注

- **富文本阅读视图** —— KaTeX 公式、Mermaid 图表、highlight.js 代码高亮；
  HTML 在沙箱 iframe 中预览；约 36 种代码文件渲染为高亮代码块；图片以预览
  标签打开。
- **高亮标记**（`^^文字^^` 或 `==文字==`）—— 双模式黄色高亮；源码模式
  `Cmd+H` 快速包裹选区。
- **块 ID（mdblock）** —— 每个顶层块（段落、标题、代码块、列表、表格 …）
  获得稳定的 `b-xxxxxx` id，任何位置用 `((path/to/file.md#b-xxxxxx))`
  即可按子页面粒度引用——对人和 agent 同样有效。id 抗编辑（内容 MinHash +
  五轮合并）；块元数据存中央缓存，绝不污染你的文件目录。点击侧栏标记复制
  引用；`Cmd+Enter` 跳转。
- **阅读洞察（插件）** —— 逐文档的阅读/编辑投入度存入 vault；任意日期范围
  可从 CLI 或 **View → Reading Insights** 生成 markdown 摘要。
- **附件与视频卡片** —— 文档、音频、视频链接渲染为芯片/卡片；YouTube 与
  Bilibili 链接自动取标题，渲染为品牌色播放卡片。

### 写作与编辑

- **源码 / 富文本切换**（`Cmd+/`）—— 纯文本 ↔ 所见即所得，按标签页记忆。
- **斜线菜单**（空行输入 `/`）与**块快捷键**（`Cmd+1–6` 标题、
  `Cmd+Shift+K` 代码块、`Cmd+Shift+M` 公式、`Cmd+Shift+T` 表格、
  `Cmd+Opt+U/O/X` 列表 …）。
- **Live-Preview 风格标记** —— 输入 `**`、`` ` ``、`==` 等保持源码原样，
  不自动折叠；已有标记正常渲染，光标所在行显示源码分隔符。
- **Wikilink 双链** —— `[[笔记]]` 渲染为链接，点击打开（或新建）同目录的
  `笔记.md`；`[[笔记|别名]]` 显示别名。
- **任务复选框**、**裸 URL 自动链接**、**可折叠且可内联编辑的 YAML
  frontmatter 面板**、导出/分享全链路**换行保真**。
- **随手粘贴** —— 截图落盘到 `{文档名}_files/` 并以相对路径插入；文件粘贴
  为附件链接；图片点击出现尺寸工具栏（25 / 50 / 75 / 100%）。
- **CSV 电子表格** —— `.csv` 以可编辑网格打开，支持公式（`=SUM(A1:A3)`、
  跨单元格引用）、行列操作、深色主题；`/电子表格` 斜线命令可在 markdown
  内嵌入表格。
- **查找与替换**（`Cmd+F` / `Cmd+H`）—— 正则、全字、大小写选项，双模式可用。
- **新建文件**（`Cmd+N`）—— 随机写作引导模板，正文预选中。

### 文件与 Vault

- **文件夹视图** —— 实时目录树侧栏，递归正则过滤，右键在访达中显示。
- **外部修改检测** —— 干净标签页静默重载；脏标签页出现冲突提示条
  （重载 / 覆盖 / 删除后可恢复）。绝不静默丢数据。
- **Sync to Vault（插件）** —— 把任意文件复制进 git 同步的 vault，日期前缀
  命名、来源映射、冲突感知刷新。
- **多标签页**（脏标记、拖拽排序）；**自动保存**（可选）；**最近文件**；
  Finder 双击 / 拖拽打开。

### 为 agent 而建

- **块引用** —— `((file#b-xxxxxx))` 给 agent 一种跨 vault 稳定引用与跳转
  段落的方式。
- **`notemd` CLI** —— 不开 GUI 驱动插件功能：`notemd -s draft.md` 发布分享
  链接；`--json` 结构化输出；`notemd reading-insights report` 生成投入度
  摘要。从 **Help → Install 'notemd' Command in PATH…** 安装。
- **MCP 端点** —— 分享 Worker 暴露 MCP，agent 可代你发布文档。
- **插件系统** —— 跨进程插件（stdin/stdout JSON），manifest 声明式注册菜单、
  上下文菜单、设置面板，宿主能力按声明授权。未触发时不运行。

### 分享与导出

- **分享（插件）** —— `Cmd+Shift+L` 把当前文件发布为自包含网页，托管在你
  自己的 Cloudflare Worker：KaTeX、Mermaid SVG、语法高亮、浅/深主题、移动端
  适配。可原址更新、随时撤销；图片多的文档溢出到 R2。部署见
  `worker/README.md`。
- **PDF 导出**（`Cmd+Shift+E`）—— 排版干净的 A4 PDF，公式、图表、代码高亮
  全部内联（离屏 WKWebView 渲染，无 headless Chromium）。
- **图片上传** —— 图片标签页 `Cmd+Shift+L` 上传 R2 并复制公开 URL。

### 应用本体

- **三语界面** —— English、简体中文、日本語——覆盖每个对话框、原生 macOS
  菜单栏（含系统菜单项）、托盘及插件文案；Preferences 即时切换，无需重启。
- **Typora 主题兼容** —— 导入任意 Typora 主题 `.zip`；浅色/深色可分别选主题，
  跟随 macOS Appearance。内置 **default**（GitHub 风格）与 **effie**（薄荷纸
  配色，霞鹜文楷）。
- **菜单栏托盘**、Typora 风格通知条、全界面缩放（`Cmd+=` / `Cmd+-` / `Cmd+0`）。
- **Apple Silicon 与 Intel** 双 `.dmg`，按架构自动更新。

## 开发

```bash
pnpm install
pnpm tauri dev
```

## 构建

仅当前架构：

```bash
pnpm tauri build
```

两个架构分别构建（各自独立 `.app`，Universal 模式已废弃）：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
```

输出位置：
- 当前架构：`src-tauri/target/release/bundle/macos/note.md.app`
- 按架构：`src-tauri/target/<arch>-apple-darwin/release/bundle/macos/note.md.app`

## 发布（仓库维护者）

```bash
scripts/release.sh <x.y.z>
```

依次执行：测试 → 版本号 → 按架构签名构建 → 公证 → 打 tag → push → GitHub
Release（两个 `.dmg`、两个 updater 包及签名、驱动按架构自动更新的
`latest.json`）。需要 `.env.release` 中的 `APPLE_ID`、`APPLE_PASSWORD`、
`APPLE_TEAM_ID`，以及 `~/.tauri/mdeditor.key` 的 updater 签名私钥。

## CLI

```bash
notemd -s draft.md                         # 通过 Share 插件发布，输出 URL
notemd share draft.md --json               # 结构化输出
notemd share draft.md --copy-link          # 复用已有分享链接
notemd share draft.md --unshare            # 取消分享
notemd plugin list                         # 列出插件及启用状态
notemd reading-insights report --vault ~/Vault --date 7d   # 阅读投入度摘要
notemd help                                # 完整帮助
```

CLI 只暴露**已启用**插件贡献的子命令。

## 测试

发布前必跑的完整手工冒烟清单（macOS + iOS）见
[`docs/SMOKE-TEST.md`](docs/SMOKE-TEST.md)。

## 设计文档与实施计划

- 设计：`docs/superpowers/specs/`
- 计划：`docs/superpowers/plans/`

## 许可证

Apache-2.0（与 `@moraya/core` 一致）。
