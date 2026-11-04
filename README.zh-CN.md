# note.md

[English](README.md) · [简体中文](README.zh-CN.md) · [notemd.net](https://notemd.net)

> **读 AI 写的，留下你想的，留住只有你才写得出的字。**

为人与 AI Agent 在同一批文件中协作而设计的 markdown 阅读器、编辑器、双链笔记工具。
桌面版支持 macOS 13+（Apple Silicon 与 Intel）、Windows 10/11 x64 和 Linux beta。
你的笔记是磁盘上一个纯 `.md` 文件夹——永远属于你。

[下载](https://notemd.net/download) · [插件市场](https://plugins.notemd.net) · [完整功能清单](docs/FEATURES.zh-CN.md)

---

**Linux beta 包**优先提供 Omarchy / Arch 的 `.pkg.tar.zst`，并提供 Debian / Ubuntu 的 `.deb`，两种格式均支持 x86_64、aarch64；aarch64 未经实机验证。使用包管理器更新；缺少 Linux 构建的原生插件及应用内 Agent 面板不在 beta 范围，Wayland 快捷键由合成器绑定。见 [Linux 安装、限制与验收](docs/linux-omarchy.md)。

## 下载安装包

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| macOS 13+ | Apple Silicon | [`.dmg`](https://notemd.net/download?os=mac&arch=aarch64) |
| macOS 13+ | Intel | [`.dmg`](https://notemd.net/download?os=mac&arch=x86_64) |
| Windows 10/11 | x64 | [`.exe`](https://notemd.net/download?os=windows&arch=x86_64) |
| Linux beta · Omarchy / Arch | x86_64 | [`.pkg.tar.zst`](https://notemd.net/download?os=linux&format=arch&arch=x86_64) |
| Linux beta · Omarchy / Arch | aarch64 | [`.pkg.tar.zst`](https://notemd.net/download?os=linux&format=arch&arch=aarch64) |
| Linux beta · Debian / Ubuntu | x86_64（amd64） | [`.deb`](https://notemd.net/download?os=linux&format=deb&arch=x86_64) |
| Linux beta · Debian / Ubuntu | aarch64（arm64） | [`.deb`](https://notemd.net/download?os=linux&format=deb&arch=aarch64) |

宿主与插件独立发布。安装前请查看[更新日志](CHANGELOG.zh-CN.md)及插件的最低宿主版本；Apple Silicon 发布新版不代表 Intel、Windows 或 Linux 同时更新。暂不发布移动端版本。

Windows 和 Linux 链接选择实际带有所选平台与架构安装包的最新已发布版本，可能与全平台最新版本不同。Linux 下载未指定包格式时会先让你选择。ARM 不会回退到 x86_64，Arch 包不会回退到 Debian 包；如果没有对应包，则打开[全部发布版本](https://github.com/wizlijun/note.md/releases)。Linux 使用包管理器更新，不进入桌面自动更新清单。Omarchy 仓库条目尚未提交，Wayland/fcitx5/托盘仍待实机验收。

## 1. 读 agent 写的东西，这里体验最好

富文本与源码双模，一个快捷键之隔。可导入 Typora 兼容主题。Mermaid 代码块默认由
Pele 渲染，也支持 Graphviz 与 KaTeX，按需加载。见[图表兼容说明](docs/pele-build.md)。
应用使用系统 WebView，不捆绑 Chromium。

高亮一句断言，在旁边留下你的疑问，就地把写错的句子改对。

Claude、Codex、OpenClaw 各有各的对话窗口，但没有一个是**读**的地方。这里是。

## 2. 上一代笔记工具做对的事，全都内置

local-first、git sync、大纲、`[[双链]]`与反向链接、wiki 页面、每日笔记、  
全库检索、JSON Canvas、插件机制。

这些是 Roam Research 和 Obsidian 想明白的事，note.md 把它们落在文件上：
Roam Research 同步可从整图导出完成初始化，之后持续同步变化页面；Obsidian 的
vault 则可直接打开。

## 3. 为 AI Agent 原生设计。用你已经在用的 AI。

内置 Agent 工作流复用你已有的 Agent、AI 订阅、API 账户或本地运行环境。note.md
不另售 Token，不对 Token 加价，也不另收一份按 Token 计费的使用费。

实际模型用量与限制仍按你所选服务的订阅额度、API 计费执行；本地模型使用你自己的
算力。

你的 vault 被设计成多 agent、多 harness 共用的、受版本控制的上下文环境——  
Claude Cowork、Claude Code、Codex、DeepSeek、ChatGPT Work、OpenClaw、Hermes——它们通过
公共约定（`AGENTS.md`、块引用、手记 `.note.md`）读写同一批文件。Memory 也遵循
同一份契约：agent 可以发现并建议，只有你能决定什么成为长期上下文。留得越多，
agent 越懂你。

vault 不只存 agent 写下的东西，也存它们该怎么干活：`AGENTS.md`、skills、定时任务、
MCP 连接、记忆。这套规程是你一次次纠正后留下的判断，放在 vault 里，就不会困在
任何一家 harness 的私有目录中。

你随时可以换 AI 工具。资产始终在你手里，也不会再叠加一层 note.md Token 账单。

用 Claude Code 做产品这条路径——写文档、读文档、审批 AI 生成的文档——是专门  
调优过的。

## 4. Agent 发现，你逐条确认

真正影响 agent 能不能帮好你的，恰恰是任何模型都猜不出的个体事实：你怎么做事、
偏好什么、做过哪些决定、哪些边界不能越。再让你维护一张个人画像，只是把整理工作
重新推回给你。

Memory 把分工倒过来：agent 从你带进 vault 的工作与沟通中发现少量候选记忆，
再交给你逐条确认、否认、标为重要或忽略。模型推断出一句话，不代表它就能自动成为
可信记忆。

搜索与 Memory 各司其职：搜索帮 agent 找回你写过的全部资料；Memory 只交付那一
小部分由你亲自确认的主张。它们仍是纯文本、由 Git 跟踪，换 agent、换模型都能继续
使用。[为什么我们这样设计个人 AI 记忆](https://notemd.net/zh/blog/personal-ai-memory/)。

## 5. 剩下的，你自己长出来

写个插件。配一条 OpenClaw 定时任务。挂上 skills。

在批注里打一个 `?`，已配置的 Agent 可以异步在手记中回答。是否采纳进正文，由你决定。

更多等你发掘。

---

## 阅读与插件工作流

从[插件市场](https://plugins.notemd.net)安装并启用所需插件。可用性取决于平台与宿主
版本；安装应用本身不会自动启用下面的全部工作流。

- **同一批文件，更多阅读方式。** 只读目录会跟随长文的当前阅读位置；插件文件视图与
  Rich、Source 并列，失败时安全回退编辑器。时间轴把每日记录排成日程，索引查看器把
  `*.index.md` 显示成表格、看板、分组列表或封面画廊，知识浏览器把受支持的 JSON
  数据集显示成交互图谱，排版阅读器则用 Typst 渐进分页 `*.typeset.md` 书籍。
- **带进更多来源，控制权仍在你手里。** Apple Notes 同步在 macOS 上把系统备忘录镜像为
  可读、只读的 Markdown；Roam Research 同步持续收取页面与每日笔记；会议插件增量归档
  Hemory 逐字稿；助理邮箱把准入邮件的原始 `.eml` 与完整性元数据归档到可配置的 Vault
  目录。每条流程都有自己的冲突、恢复和删除边界。
- **Mac 上的健康档案。** [健康数据同步](plugins-src/health-sync/README.md)导入 Apple
  Health 导出文件，并用 Garmin、Oura 的文件/API 数据补充细节。原始记录与附件保存
  在指定的 Vault 外资料库，使用 SQLite，支持增量导入与查询 CLI。Mac 登录 iCloud
  并不能直接读取 Apple Health 数据。
- **任务与本机快捷入口。** NEXT 管理 Task 状态、截止日期与提醒偏好。提醒投递需要
  另行配置脚本或服务；修改偏好本身不会安排投递。[快捷启动](plugins-src/quick-launch/README.md)
  配合兼容宿主，可在 macOS 托盘菜单中配置应用与 shell 命令。
- **检索更聪明，批准仍由人做。** 智能查找会先解析保守时间窗口，再检索并把结果交给
  已启用的 Agent。Memory 新增角色/场景治理与受控共写，由隔离 Agent 提交可审查改动。
  沟通转写勘误把你亲自参与的沟通证据整理成分场景的人名与 ASR 修正规则；Agent 可以
  提案，只有你能批准。
- **插件原地更新。** 安装、更新、启用、停用或移除插件后，命令、菜单和已打开视图会
  自动刷新，无需重启应用。逐版本细节见[更新日志](CHANGELOG.zh-CN.md)。

---

## 六个信念

1. **AI 的文字无限，你的注意力有限——你的判断才是残余。**  
   你留在字里行间的东西，是任何模型都生成不出来的。
2. **文件高于应用（files over app）。** 笔记是纯 `.md`：对 git 友好、可 grep，
   不依赖 note.md 阅读。搜索索引是派生数据；部分插件另有持久数据，例如健康同步
   的外置 SQLite 资料库，需要连同附件一起备份。
3. **agent 是一等公民——它建议，你确认。**  
   [关系只在人确认处生长](docs/product-principle-relationships-only-grow-where-confirmed.md)；  
   note.md 绝不自动串联你的笔记，也绝不把 agent 的猜测直接变成可信记忆。
   [个人 AI 记忆也遵守同一道人工检查点](https://notemd.net/zh/blog/personal-ai-memory/)。
4. **[你的批注属于 vault，不属于路径。](docs/product-principle-mirror-hosted-marks.md)**  
   在哪儿批注都行，源文件会被镜像进 vault，批注由此获得稳定的、git 版本化的宿主。
5. **[一个 vault，多个 agent——你是编排者。](docs/product-principle-one-vault-many-agents-you-orchestrate.md)**  
   工人可替换，握笔的是你。
6. **[让 agent 干活的规程，也是你的资产。](docs/product-principle-agent-playbook-belongs-to-the-vault.md)**  
   `AGENTS.md`、skills、定时任务、MCP 连接、记忆住在 vault 里、由 git 记录；agent 可以提议修改，  
   经你确认才生效。换哪家 agent，都按你的方式干活。

## 知识文档与 OKF v0.2

信念 2 需要的是一套格式，不只是一个后缀。note.md 生成的知识文档采用
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)
（OKF）v0.2——人与 agent 交换知识用的开放规范：
纯 Markdown、YAML frontmatter、可 diff、可移植。

- **生成的知识文档带有类型。** 新笔记、`.note.md` 手记、每日笔记、wiki 页、Roam
  与电子书导入、生成的报告使用带 `type` 的 YAML frontmatter。存量大纲笔记在下次
  保存时补上 `type`；从别处带进来的纯 `.md` 保持原样。源文件镜像、原始附件和插件
  数据库有各自格式，不改写为知识文档。
- **来源与信任用规范自己的词汇。** `sources`、`generated`、`verified`、`status`、  
  `stale_after` 全部沿用 OKF 的字段名；actor 用 OKF 的三种形式——工具  
  `<producer>/<version>`、人 `human:<id>`、自动流程 `process:<id>`。于是"这句是人  
  确认过的"成了机器可读的事实，而不是靠猜。
- **读进来的一份都不拒绝。** 缺可选字段、不认识的 `type`、多出来的未知键、断掉的  
  链接——任何一条都不会让文档被拒绝，note.md 读不懂的键在往返后原样保留。这是  
  OKF 的宽容一致性，规范把它定为 MUST。
- **可自行检查。** `pnpm okf:lint <目录>` 检查仓库校验器覆盖的三条硬约束。
  适用范围与剩余工作见下方一致性审计。

vault 的 `AGENTS.md` 写明了 OKF 要求，供在此工作的 Agent 遵循；应用无法强制约束
外部工具的写入。应用会在证据充分时填写人类作者身份的 `generated` /
`verified`；bundle 导出也会写出 `index.md`、`log.md` 和可移植链接。剩余的读侧展示与
attestation 工作见[一致性审计](docs/okf-v0.2-conformance-audit.md)。格式细节见
[`docs/okf-v0.2-format-constraints.md`](docs/okf-v0.2-format-constraints.md)。

## AI 写的，人负责

note.md 完全由 AI Coding 开发和维护，所以更新很快。维护者是专业的软件工程玩家，
每一次改动都经过审阅、测试和发布前实机验证。

## 引擎盖下

基于 [Tauri](https://tauri.app) 与  
[`@moraya/core`](https://www.npmjs.com/package/@moraya/core) 构建：原生 Rust 桌面
二进制，菜单、窗口与托盘使用系统能力，编辑器 UI 渲染在操作系统 WebView 中，而不是
捆绑一份浏览器。macOS `.app` 经过签名与公证；Windows 使用系统 WebView2 运行时。

产品名为 **note.md**（全小写——一篇笔记就是一个 markdown 文件）；CLI 二进制与  
bundle identifier 为 `notemd` / `net.notemd.app`，旧的 `mdedit` 软链仍可用。  
源码中仍会看到 `mdeditor`（Rust crate 名为 `mdeditor_lib`）。v4.8.0 之前以  
**M↓** 为名发布。

## 开发与构建

```bash
corepack enable             # 使用 package.json 固定的 pnpm 版本
git clone https://github.com/wizlijun/moraya-core.git ../moraya-core
pnpm install
pnpm tauri dev            # 开发
pnpm tauri build          # 构建，当前架构
```

两个架构分别构建（各自独立 `.app`，Universal 模式已废弃）：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
```

输出：`src-tauri/target/<arch>-apple-darwin/release/bundle/macos/note.md.app`  
（当前架构则在 `src-tauri/target/release/…`）。

本仓库依赖同级目录中的 `../moraya-core` checkout。拉取 note.md 不会更新这个仓库，
也不会更新已安装的 `dist/` 副本；请保持核心源码与构建产物一致，再在这里运行
`npm run sync:core`。复选框与选区回归依赖的核心提交见[复选框验收](docs/superpowers/reports/2026-10-22-rich-checkbox-verification.md)
和[选区验收](docs/superpowers/reports/2026-11-02-rich-select-all-delete.md)；`file:` 依赖不会锁定 Git 提交。

Windows 需安装带 Corepack 的 Node.js、Rust MSVC 工具链与 WebView2，然后执行同一组
`pnpm install` / `pnpm tauri dev` / `pnpm tauri build`。NSIS 安装包位于
`src-tauri/target/<arch>-pc-windows-msvc/release/bundle/nsis/`。

## CLI

```bash
notemd search "关键词" --vault ~/Vault      # 全文检索，输出 path:line:text
notemd search "关键词" --json               # 带 source_ref、origin、来源信息、attention_minutes（由桌面端记录）
notemd search "关键词" --all                # 返回全部命中（默认上限 20 条，--limit N 可调）
notemd share draft.md                      # 发布分享链接，输出 URL
notemd share draft.md --json               # 结构化输出
notemd share draft.md --unshare            # 取消分享
notemd plugin list                         # 列出插件及启用状态
notemd meetings-sync --dry-run             # 预览 Hemory 增量归档
notemd apple-notes-sync --dry-run           # 预览 Apple Notes 同步（仅 macOS）
notemd mail-sync                            # 拉取助理邮箱准入邮件
notemd reading-insights report --vault ~/Vault --date 7d
notemd doctor                              # 自检环境、Vault、索引、插件与网络（--offline、--json）
notemd help                                # 完整帮助
```

内置核心命令，外加**已启用**插件贡献的子命令。从  
**Help → Install 'notemd' Command in PATH…** 安装。

agent 最常用的是 `notemd search`。它有意长成 grep 的样子，`rg` 的习惯照用；
`--json` 每条命中给出 `source_ref`（`path#Lline`）与来源信息 —— 模型写的命中
会自报家门，可以顺着它回到原始文档，而不是直接采信。过滤语法与应用内搜索
面板一致（`tag:` `type:` `path:` `ext:` `after:` `before:` `page:[[X]]`
`origin:`）。详见 `notemd help search`。

## MCP：给不方便调 shell 的 agent

note.md 也能以 [MCP](https://modelcontextprotocol.io) 的方式说话（走 stdio），
于是 agent 可以把 `search` / `vault_info` 当工具调用，而不必去 shell 里执行
`notemd search`。两个工具都是只读的，查的是 CLI 与应用本来就共用的那份热索引。

在 Mac 上接入 Claude Code、Claude Desktop 与 Cowork：打开 设置 →「复制给 Claude
的设置说明」（或执行 `notemd mcp setup`），把这段文本粘贴到 Claude Code。它会逐项
展示改动，经你确认后才执行 —— note.md 自己从不修改其他应用的配置。其他客户端
按绝对路径并带 `--cli` 注册（GUI 应用不继承 shell 的 `PATH`）：

```json
{"command": "/Applications/note.md.app/Contents/MacOS/notemd", "args": ["--cli", "mcp"]}
```

不开 TCP 端口：外壳与正在运行的 note.md 进程之间走本机套接字（macOS/Linux 是
Unix domain socket，Windows 是命名管道），不碰网络。默认开启，不想跑可以在
设置里关掉。

## 发布（仓库维护者）

```bash
scripts/release.sh
# Windows: scripts/release-windows.ps1 <tag>
scripts/release-linux.sh <tag>
scripts/release-publish.sh <tag>
```

先构建 macOS draft，再在 Windows 上补包并构建两种架构 Linux 包，最后验证
同一 tag 的产物后发布。Linux 由包管理器更新，不写入 `latest.json`。
见 [发布顺序与待验边界](docs/linux-omarchy.md)。
需要 `.env.release` 中的 `APPLE_ID`、`APPLE_PASSWORD`、
`APPLE_TEAM_ID`，以及 `~/.tauri/mdeditor.key` 的 updater 签名私钥。

## 文档

- 完整功能清单：[docs/FEATURES.zh-CN.md](docs/FEATURES.zh-CN.md)
- 知识文档格式（OKF v0.2）：[`docs/okf-v0.2-format-constraints.md`](docs/okf-v0.2-format-constraints.md)
  · [一致性审计](docs/okf-v0.2-conformance-audit.md)
- 写插件：[docs/plugin-v2-development.md](docs/plugin-v2-development.md)
- 设计与计划：`docs/superpowers/specs/`、`docs/superpowers/plans/`

## 致谢

感谢 **[Effie](https://www.effie.co/)** 与  
**[葫芦笔记（Hulunote）](https://github.com/hulunote/hulunote)** 一路的支持与  
鼓励，也感谢它们让人看见一款无干扰写作工具、一款开源双链大纲笔记可以是什么  
样子。内置的 **effie** 主题，是向前者的致意。

也感谢 **[Huabu](https://github.com/microsoft/Huabu)**——一个让人与 agent 共同思考的
无限画布工作空间。note.md 的画布视觉设计与编辑交互借鉴了 Huabu，包括套索选择、
智能吸附、对齐与分布、多选缩放和上下文工具栏。

## 许可证

本仓库采用 [Apache-2.0](LICENSE)。依赖保留各自许可证：当前 `@moraya/core` checkout
声明为 `PolyForm-Internal-Use-1.0.0`，不能据此认为构建产物的所有组件都与本仓库同一许可。
