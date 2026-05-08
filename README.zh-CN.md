# M↓ (mdeditor)

[English](README.md) · [简体中文](README.zh-CN.md)

一款 macOS 原生的极简文本编辑器 —— 支持 Markdown、HTML 和源码，
**源码**与**富文本**（所见即所得）双模式、多标签页、常驻菜单栏托盘。

产品名为 **M↓**（一个 *M* 加一个向下的箭头，暗示 *markdown*）；
仓库名、crate 名、bundle identifier 仍是 `mdeditor` / `com.bruce.mdeditor`。

基于 [`@moraya/core`](https://www.npmjs.com/package/@moraya/core) 构建。

## 功能

- **多标签页** —— 脏标记、拖拽排序、关闭确认
- **源码 / 富文本切换** (`Cmd+/`) —— textarea ↔ 所见即所得
- **Markdown 渲染** —— KaTeX 数学公式、Mermaid 图表、highlight.js 代码高亮
- **HTML 文件** —— 默认在沙箱化 iframe 里预览
- **代码文件** —— ~36 种纯文本扩展名 + `Dockerfile` 等精确文件名匹配；
  富文本模式下渲染为带语法高亮的代码块
- **图片文件**（jpg / jpeg / png / gif / webp / svg / bmp / heic / heif / avif）
  作为预览专用标签打开（富文本模式显示图片；无源码视图）。
  `Cmd+Shift+L` 把图片上传到 Cloudflare R2 并复制公开 URL 到剪贴板。
- **Finder 集成** —— 双击 `.md` / `.html` 即可打开；将文件拖入窗口或 Dock 图标
- **菜单栏托盘** —— 常驻 M↓ 图标；点击让窗口前置
- **自动保存**（Preferences 中开启）和**最近文件**记录到
  `~/Library/Application Support/com.bruce.mdeditor/settings.json`
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
- **Universal binary**（Intel + Apple Silicon 通用）

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

构建 Universal（Intel + Apple Silicon 通用）`.app`：

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

输出位置：
- 单架构：`src-tauri/target/release/bundle/macos/M↓.app`
- Universal：`src-tauri/target/universal-apple-darwin/release/bundle/macos/M↓.app`

## 发布（仓库维护者）

```bash
scripts/release.sh 0.x.y --universal
```

会按顺序执行：跑测试 → bump 版本号 → 签名构建 → 公证 → 打 tag → push → 创建 GitHub Release。
需要在 `.env.release` 里配 `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`。

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
小节（共 56 项），覆盖文件操作、外部修改检测、PDF 导出、插件平台、Share 插件
等所有发布前必须跑一遍的场景。

## 许可证

Apache-2.0（与 `@moraya/core` 一致）。
