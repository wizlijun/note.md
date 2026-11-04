# notemd MCP:按 Claude app 的 macOS 约束重定接入方式

日期:2026-11-04  
状态:已与用户逐节对齐(§1–§3 明确确认;§4 采用默认做法);已实施(2026-11-04),§6 人工验收待做  
上游:`docs/superpowers/specs/2026-08-19-notemd-mcp-server-design.md`(协议核心不变,本文只改「怎么接进 Claude」与外壳的运行时细节)

## 0. 总则(产品边界,用户拍板)

**note.md 只提供用法说明,不读、不写、不干预任何其他产品的配置。**

- 不写 `claude_desktop_config.json`,不调 `claude mcp add`,不发 `.mcpb`,不加 HTTP/TCP 传输。
- 注册动作由用户把 note.md 生成的「设置说明」交给 Claude,由 agent 在**用户逐项确认后**执行;
  这与信念 3(agent 建议,你确认)和信念 6(规程改动经人确认、扩权门槛最高)同源。

## 1. 约束来源(2026-11-04 调研)

官方:

1. Claude Desktop 是 GUI 启动,**不继承 shell PATH**,工作目录不确定 → `command` 必须是绝对路径。
2. 本地 MCP 在 Chat 中由 Desktop 侧注册的服务提供;Cowork「会话在本机运行时」加载本地 MCP;
   Claude Code 正常加载(platform-support 表)。
3. Cowork 只读 claude.ai 账号 Customize 中的配置,不读 `~/.claude`。
4. Desktop 依据工具标注决定审批卡片(更新日志 v3.6556.1)→ 只读工具应声明 `readOnlyHint`。

社区证据(与 2026-08-19 探针一致):

5. `claude_desktop_config.json` 注册的服务跑在 Mac 宿主上,经 Desktop 桥接给 Cowork(clientInfo `local-agent-mode-*`)。
6. 插件内的 stdio 服务在 Cowork 的 Linux VM 里启动,Mac 二进制跑不了,也连不到宿主 socket。
7. Cowork VM 的 bash 里没有 `notemd`;agent 在 VM 里敲 `notemd search` 必然失败。

由此得出现状缺陷:

- 设置页给的是裸命令 `{"command":"notemd","args":["mcp"]}`,违反约束 1。
- 绝对路径直指 `.app/Contents/MacOS/notemd` 时,`cli::is_cli_mode` 会判为 GUI,必须带 `--cli`。
- 外壳已在后台拉起 GUI(`c527f5b2`,取代上游 §十.3 的「不拉起」),但 IPC 连接被拒时不重试,
  冷启动第一次 `tools/call` 会误报「未运行」。
- AGENTS.md 检索段只教 CLI,在 Cowork VM 里撞墙。

## 2. 设置说明文本(生成器)

### 2.1 入口

两个入口,**同一个纯函数** `mcp::setup::render`:

| 入口 | 行为 |
| --- | --- |
| 设置页 MCP 区块 | 原复制行替换为「复制给 Claude 的设置说明」按钮 + 可展开预览;复制即写剪贴板 |
| `notemd mcp setup [--lang en\|zh]` | 打印到 stdout,退出码 0;不拉起 GUI、不碰 IPC |

仅 macOS 生成。Windows / Linux 设置页保留一行注册配置,改为该平台可跑的写法:
当前可执行文件的规范绝对路径 + `["--cli", "mcp"]`(Tauri 命令 `mcp_register_line`);
`mcp setup` 在非 macOS 上报「仅支持 macOS」,退出码 2。

### 2.2 前置条件(不满足则不生成)

| 条件 | 不满足时 |
| --- | --- |
| `mcpServer.enabled` 为开(键缺失 = 开,与 `gate::enabled_from_value` 同一判定) | UI 按钮置灰;CLI stderr 说明,退出码 2 |
| 二进制路径 = `current_exe()` 再 `canonicalize()`;不以 `/Volumes/` 开头,且不含 `/AppTranslocation/` | 提示「先把 note.md 拖进『应用程序』再生成」;CLI 退出码 2 |

### 2.3 确定性

- 输入只有:二进制绝对路径、note.md 版本、语言(`en` / `zh`)。**不含时间戳**。
- 同输入逐字节同输出(快照测试锁定)。
- 语言:界面为中文时 `zh`,其余界面语言一律 `en`(说明主要给 agent 读,代码块各语言一致)。
- 注册参数固定 `["--cli", "mcp"]`;server 名固定 `notemd`。
- 路径进 shell 用单引号转义(`'` → `'\''`),进 JSON 用 JSON 字符串转义。

### 2.4 文本结构(固定模板)

0. 前言:由 note.md `<版本>` 为这台 Mac 生成;路径只在本机有效;移动 note.md 后需重新生成。
1. 给 agent 的总则:
   - 先判定能否在这台 Mac 上执行:`uname -s` 为 `Darwin` 且 `test -x '<路径>'` 成功。
   - 不能(例如在 Cowork 的 Linux VM 或普通对话中):**不尝试任何操作**,把第 5 部分原样交给用户。
   - 能:每一步改动前先展示具体改动,等用户确认;只改下面列出的那一项,不碰其他配置。
2. Claude Code:`claude mcp get notemd`;不存在 → 经确认执行
   `claude mcp add --scope user notemd -- '<路径>' --cli mcp`;已存在且不同 → 展示差异,经确认后先移除再添加。
3. Claude Desktop(Chat + Cowork):文件 `~/Library/Application Support/Claude/claude_desktop_config.json`;
   只合并 `mcpServers.notemd`,保留其余所有键;不存在则新建;写前备份为 `.bak-<时间>`;
   写后重新解析确认合法;提示用户 ⌘Q 完全退出 Claude 再打开。
4. 自检:把 `initialize` 与 `tools/list` 两行请求经管道喂给 `'<路径>' --cli mcp`;
   判据:返回两行,第二行同时含 `"search"` 与 `"vault_info"`。不依赖 note.md 是否在运行。
5. 手动兜底(给人看):完整 JSON 片段、配置文件位置、Claude Code 命令、重启说明;
   Cowork 验证法:新开会话,请 Claude 调 notemd 的 `vault_info`,`mount.status` 为 `matched` 即成功。
6. 排错:Desktop 日志 `~/Library/Logs/Claude/mcp-server-notemd.log`;「note.md 未运行」→ 打开 note.md 重试;
   移动过 note.md → 重新生成本说明。

## 3. 运行时调整

### 3.1 冷启动有界重试(外壳)

- 外壳记录启动时刻 `t0`。`tools/call` 连接错误分两类:**端点未就绪**(`NotFound` / `ConnectionRefused`)与其他。
- `now < t0 + 15s` 且为「端点未就绪」→ 每 250ms 重连,直到成功或宽限期结束。
- 宽限期后保持现状:一次尝试,失败即 `isError: true`。
- 连上之后往返超时仍为 5s;单次调用上限 ≤ 15s + 5s。宽限期为常量,不做配置项。
- 已知代价:MCP 被关时,宽限期内调用多等至多 15s 才报错(外壳本就无法区分「没开」与「关了」)。

### 3.2 工具标注

`tools/list` 两个工具加 `annotations`(编译期常量):

```json
{ "title": "Search note.md vault", "readOnlyHint": true, "destructiveHint": false,
  "idempotentHint": true, "openWorldHint": false }
```

`vault_info` 的 `title` 为 `"note.md vault info"`,其余相同。

### 3.3 stdout 纪律

`notemd --cli mcp` 的 stdout 只写 JSON-RPC,一行一条;所有诊断只写 stderr(Desktop 收进
`mcp-server-notemd.log`)。

### 3.4 路由

新增 `Builtin::McpSetup(lang)`:`mcp setup` 与 `mcp setup --lang <en|zh>`;不在 `should_keep_desktop_running`
之列,不触发 `launch_desktop_in_background`。`mcp` 后跟其他参数仍为参数错误。

## 4. AGENTS.md 检索段与文档

- `agents_sync::logic::SEARCH_SECTION`(及其手抄件 `templates/AGENTS.md`)的「If you can't run `notemd` yourself」
  改为按环境分流:有 notemd 的 MCP 工具 → 用 `search` / `vault_info`;bash 里 `command -v notemd` 成功 → 用 CLI;
  否则 `rg` / `grep`,并告诉用户可在 note.md 设置里「复制给 Claude 的设置说明」。删去裸命令 JSON。
- **已有 vault 不迁移**:`append_search_section` 保持只追加,已有该段的 AGENTS.md 不改写(规程改动须人确认)。
  CHANGELOG 提示用户可自行更新该段。
- 同步更新:`docs/FEATURES*.md`、`website/public/llms*.txt`、CHANGELOG(中/英)「未发布」区。

## 5. 测试

1. `setup::render` 快照(en / zh),含路径带空格与单引号的转义用例;两次调用逐字节相等。
2. 前置条件:`/Volumes/…`、`…/AppTranslocation/…` 拒绝;MCP 关闭拒绝。
3. 重试:可注入时钟与连接函数——宽限期内 socket 晚出现时成功;宽限期后一次失败即返回;非「未就绪」错误不重试。
4. `tools/list` 含两个工具的 `annotations`。
5. 集成:`--cli mcp` 的 stdout 每行都能解析为 JSON;`--cli mcp setup` 输出与 `render` 一致、不拉起 GUI。
6. 路由:`mcp setup`、`mcp setup --lang zh` 命中;`mcp setup --lang fr`、`mcp --bogus` 为参数错误。
7. `SEARCH_SECTION` 与模板的既有防漂移测试继续通过。

## 6. 验收(人工)

在 Claude Code 中粘贴设置说明 → 完成两处注册 → 重启 Claude → 在 Cowork 新会话中调用 `vault_info`
得到 `mount.status: matched`,再调用一次 `search` 返回结果。此项同时补上上游 §十.1「Cowork `tools/call` 未实证」。
