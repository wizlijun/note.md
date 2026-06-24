# M↓ (mdeditor)

[English](README.md) · [简体中文](README.zh-CN.md)

一款 macOS 上的极简文本编辑器 —— 支持 Markdown、HTML 和源码，
**源码**与**富文本**（所见即所得）双模式、多标签页、常驻菜单栏托盘。

产品名为 **M↓**（一个 *M* 加一个向下的箭头，暗示 *markdown*）；
仓库名、crate 名、bundle identifier 仍是 `mdeditor` / `com.laobu.mdeditor`。

基于 [Tauri](https://tauri.app) 与
[`@moraya/core`](https://www.npmjs.com/package/@moraya/core) 构建：一个签名并公证的
原生 `.app` —— 原生 Rust 二进制，菜单、窗口、菜单栏托盘均为系统原生控件 —— 而编辑器
UI 是 Web 技术（HTML/CSS/JS），渲染在 macOS 系统自带的 WebView（WebKit / WKWebView）里，
不像 Electron 那样捆绑浏览器。因此它是**基于系统 WebView 的原生 macOS 应用**，而非
原生 UI（AppKit/SwiftUI）应用。

## 功能

- **新建文件** (`Cmd+N`) —— 创建一个 untitled.md，随机填入有趣的写作引导模板；
  继承当前标签页的编辑模式（源码/富文本）；正文默认选中，可直接开始输入。
  空白页双击也可新建文件。
- **查找与替换** (`Cmd+F` / `Cmd+H`) —— tab 栏下方的内联搜索条，支持区分大小写、
  全字匹配、正则表达式；源码和富文本模式均支持高亮匹配和跳转定位；在替换输入框
  按回车执行替换并跳转到下一个。Edit 菜单也可进入。
- **缩放** (`Cmd+=` / `Cmd+-` / `Cmd+0`) —— 放大/缩小整个界面；Cmd+0 还原默认
  尺寸。位于 Window 菜单。
- **消息提示条** —— 所有提示消息（错误、成功、信息）改为 Typora 风格的通知条，
  显示在 tab 栏下方，不再弹出原生系统对话框；可勾选"自动关闭"倒计时消失。
- **多标签页** —— 脏标记、拖拽排序、关闭确认
- **源码 / 富文本切换** (`Cmd+/`) —— textarea ↔ 所见即所得
- **Markdown 渲染** —— KaTeX 数学公式、Mermaid 图表、highlight.js 代码高亮
- **主题系统** —— 富文本模式（Preferences → Core → Themes）兼容 Typora
  主题：把 `.zip` 拖进窗口或在 Preferences 里选择导入，即可装入 Typora
  生态里的任意主题。每个位于
  `~/Library/Application Support/com.laobu.mdeditor/themes/` 下的 `.css`
  都是一个独立主题；为浅色和深色模式分别选一个主题，M↓ 跟随 macOS Appearance
  自动切换。内置 **default**（GitHub 风格）与 **effie**（Effie 配色：薄荷
  纸 + 青绿标题 + 紫粗体 + 暖橙斜体，浅/深双配色经
  `prefers-color-scheme` 切换，LXGW 霞鹜文楷 webfont 由 jsDelivr 按需流式
  加载）随应用一并写入同一目录，可像其它主题一样删除或编辑。
- **HTML 文件** —— 默认在沙箱化 iframe 里预览
- **代码文件** —— ~36 种纯文本扩展名 + `Dockerfile` 等精确文件名匹配；
  富文本模式下渲染为带语法高亮的代码块
- **图片文件**（jpg / jpeg / png / gif / webp / svg / bmp / heic / heif / avif）
  作为预览专用标签打开（富文本模式显示图片；无源码视图）。
  `Cmd+Shift+L` 把图片上传到 Cloudflare R2 并复制公开 URL 到剪贴板。
- **Finder 集成** —— 双击 `.md` / `.html` 即可打开；将文件拖入窗口或 Dock 图标
- **菜单栏托盘** —— 常驻 M↓ 图标；点击让窗口前置
- **自动保存**（Preferences 中开启）和**最近文件**记录到
  `~/Library/Application Support/com.laobu.mdeditor/settings.json`
- **PDF 导出** (`Cmd+Shift+E`) —— 把当前 Markdown / HTML 标签导出成排版精致的
  A4 PDF，KaTeX 公式、Mermaid 图表、代码语法高亮全部内联渲染
  （macOS 原生 WKWebView 离屏渲染，不带 headless Chromium）
- **插件系统** —— 跨进程插件，通过 stdin/stdout JSON 通信，manifest 声明式
  注册菜单项、上下文菜单、设置面板，宿主能力按声明授权（toast / 剪贴板 /
  settings.merge / 对话框）。插件未触发时不运行；启动成本只到读一份小 manifest
- **Share 插件（内置）** —— `Cmd+Shift+L` 一键把当前文件以自包含网页发布到
  你自己的 Cloudflare Worker。接收方打开链接看到的文档跟 M↓ 显示的完全一致
  （KaTeX、Mermaid / Graphviz SVG、语法高亮、浅/深双主题跟随系统、移动端优化）。
  图片多的文档溢出到 Cloudflare R2；Worker 还开放了 MCP 端点，方便 LLM agent
  代你发布
- **Sync to Vault 插件（内置）** —— 在 **Preferences → Plugins** 启用后，文件菜单
  新增 **Sync to Vault…**：把当前文件复制进 git 同步的 Vault（`~/Documents/Vault/Sync/`，
  重名自动加后缀），并在专用 JSON 里记录"副本 ↔ 来源"映射。文件名没带 `yyyy-MM-dd-`
  前缀的 Markdown，会自动补上源文件的创建日期（如 `notes.md` → `2024-03-12-notes.md`）。
  再次打开 vault 副本时若来源已变更，会弹冲突感知的同步提示（用源覆盖 / 保留 Vault /
  取消，绝不静默；两边都改则标记为冲突）。vault 副本上有蓝色提示条显示来源路径并可在访达
  打开；Vault 之外的文件上有绿色提示条可一键同步并说明好处，已同步后自动隐藏
- **块 ID（mdblock）** —— Preferences → Block 勾选启用后，给每个顶层
  Markdown 单元（段落、标题、代码块、列表、表格 …）分配一个稳定的
  `b-xxxxxx` id；任何位置都可以用 `((path/to/file.md#b-xxxxxx))`
  引用某一具体块，方便 LLM agent 与人协作时按子页面粒度精准引用。
  打开 `.md` 时块边界自动加载，源码或富文本编辑过程中实时（约 250 ms
  防抖）跟随结构变化重算，`Cmd+S` 保存时一并持久化。yaml 不放在源文件
  旁边，统一写入按路径哈希定位的缓存目录
  `~/Library/Application Support/com.laobu.mdeditor/blocks/<hash>.yaml`，
  开发/工作目录保持干净。身份稳定算法基于内容 MinHash + 五轮合并：轻微
  编辑保留旧 id，大幅改写优雅退役（带完整 history 链）。点击侧栏标记
  即把 `((file#blockid))` 复制到剪贴板；源码模式下把光标放到 `((..))`
  里按 `Cmd+Enter` 直接跳转到目标文档对应位置
- **粘贴图片与附件** —— 截图（剪贴板 image blob）自动保存到文档旁的
  `{文档名}_files/` 目录，以相对路径 `![](相对路径.png)` 插入；未保存的新文档
  先写入临时目录，首次保存时路径自动迁移更新。拖拽图片文件插入绝对路径引用，
  不复制文件。粘贴非图片二进制文件插入附件链接 `[文件名](路径)`。
  源码模式与富文本模式均支持以上所有粘贴路径。
- **附件链接卡片** —— 指向文档（`.pdf`、`.docx`、`.zip` …）、音频、视频的链接
  在富文本模式下渲染为带表情图标的样式：行内显示为芯片，独占一行时升级为全宽卡片。
  纯 CSS 实现，无 schema 变更。
- **视频链接卡片** —— 粘贴 YouTube 或 Bilibili URL，标题从 YouTube oEmbed API
  或 Bilibili Web API 自动获取，链接以 `[视频标题](url)` 格式存入 markdown。
  富文本模式下渲染为带品牌色 ▶ 图标的卡片（YouTube 红色，Bilibili 蓝色），
  单击即在默认浏览器中打开。
- **图片尺寸工具栏** —— 在富文本模式下单击图片，图片上方显示浮动工具栏，
  提供 25% / 50% / 75% / 100% / 原始五个快速尺寸按钮；所选宽度存入
  title 属性（`"width=50%"`），编辑器实时应用。点击工具栏背景或其他区域
  关闭工具栏。
- **CSV 电子表格编辑器** —— `.csv` 文件以可编辑的表格网格（RevoGrid）打开，支持
  公式（`=SUM(A1:A3)`、`=AVG(...)`、`=COUNT(...)` 及 A1 跨单元格引用）、行号显示
  和深色模式适配。首行加粗作为视觉表头，主题跟随系统在 Material / Material-Dark
  间自动切换。右键单元格唤起菜单：在选中位置上下/左右插入或删除行列、清空选中区域；
  `Delete` 键也可快速清空选中区域。仍可通过 `Cmd+/` 切回源码模式。在 Markdown
  中键入 `/电子表格` 可插入行内电子表格块（rich 模式下嵌入也能正常输入，不会被外层
  ProseMirror 抢焦点）。
- **富文本块快捷键** —— 无需输入 Markdown 语法即可插入或转换块：
  `Cmd+1–6` 标题；`Cmd+0` 转段落；`Cmd+Shift+K` 代码块；`Cmd+Shift+M` 数学公式；
  `Cmd+Shift+T` 表格；`Cmd+Shift+Q` 引用；`Cmd+Opt+U/O/X` 无序/有序/任务列表。
- **斜线菜单**（富文本模式行首输入 `/`）—— 弹出可过滤的块插入菜单，包含 H1–H3、
  引用、代码块、Mermaid 图表、数学公式、表格、无序/有序/任务列表、分割线，以及
  图片和文档的文件选择入口。方向键导航，Enter 或 Tab 插入。
- **高亮标记**（`^^文字^^` 或 `==文字==`）—— 在源码和富文本模式下均显示黄色高亮。
  源码模式 `Cmd+H` 快速包裹选区；富文本模式透明渲染并序列化。
- **任务列表复选框** —— 富文本模式下单击 `- [ ]` / `- [x]` 复选框即可切换勾选状态，
  改动会同步回 Markdown 源码（`[ ]` ↔ `[x]`）；鼠标悬停复选框显示手型光标。
- **Apple Silicon 与 Intel 构建** —— 发布为两个独立的按架构 `.dmg`（`aarch64`
  与 `x86_64`）；自动更新会自动匹配对应架构

## 开发

```bash
pnpm install
pnpm tauri dev
```

## 构建

仅构建当前 Mac 架构：

```bash
pnpm tauri build
```

分别构建两个架构（各自产出独立 `.app`，Universal 模式已废弃）：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
```

输出位置：
- 当前架构：`src-tauri/target/release/bundle/macos/M↓.app`
- 按架构：`src-tauri/target/<arch>-apple-darwin/release/bundle/macos/M↓.app`

## CLI

M↓ 内置一个 `mdedit` 命令行工具，方便其他应用在不打开 GUI 的情况下调用插件功能。
通过 **Help → Install 'mdedit' Command in PATH...** 安装（安装到 `/usr/local/bin`
会要求管理员授权），也可以在 **Preferences → CLI** 里安装/卸载。

```bash
mdedit -s draft.md                         # 通过 Share 插件发布，stdout 输出 URL
mdedit share draft.md --json               # 结构化输出（JSON）
mdedit share draft.md --copy-link          # 复用已有分享链接
mdedit share draft.md --unshare            # 取消该文件的分享
mdedit help                                # 完整帮助
mdedit plugin list                         # 列出所有插件及启用状态
```

CLI 只暴露**已启用**插件贡献的子命令。在 **Preferences → Plugins** 中禁用某个插件
会同步从 `mdedit` 移除其子命令。

## 发布（仓库维护者）

```bash
scripts/release.sh <x.y.z>
```

会按顺序执行：跑测试 → bump 版本号 → 按架构签名构建（`aarch64` + `x86_64`）→ 公证
→ 打 tag → push → 创建 GitHub Release。每次发布产出两个 `.dmg`、两个 updater 压缩包
及签名，以及驱动自动更新的 `latest.json`（按架构分别记录）。需要在 `.env.release` 里配
`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`，以及位于 `~/.tauri/mdeditor.key` 的
Tauri updater 签名私钥。

## 分享插件部署（可选）

如果想用「分享当前文件」功能，需要先在自己的 Cloudflare 账号里部署配套 Worker：

```bash
cd worker
pnpm install
wrangler login
wrangler kv:namespace create SHARES   # 把 id 写入 wrangler.toml
openssl rand -hex 32 | wrangler secret put SHARE_API_KEY
wrangler deploy                       # 输出 Worker URL
```

把 Worker URL 和 API key 填进 M↓ Preferences → Share，重启 M↓。
详见 [`worker/README.md`](worker/README.md)。

## 设计文档与实施计划

- 设计：`docs/superpowers/specs/`
- 计划：`docs/superpowers/plans/`

## 测试清单

完整的手工冒烟测试清单见英文版 [`README.md`](README.md) 的 *Manual Smoke Test*
小节（覆盖 macOS 与 iOS 全场景），包含文件操作、外部修改检测、PDF 导出、插件平台、
Share 插件、主题导入、块 ID、Vault 同步等所有发布前必须跑一遍的场景。

## 许可证

Apache-2.0（与 `@moraya/core` 一致）。
