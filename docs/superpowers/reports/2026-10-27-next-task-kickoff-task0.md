# NEXT Task Kickoff — Task 0 安全与接口核实

日期：2026-10-27。状态：实现前的研究快照；本研究步骤未修改产品代码，未安装、发布、修改正式 Vault 或发送消息。后续已提交实现见文末及验收报告。隔离测试根：`/tmp/notemd-task0-probe`；Rust stub 使用 `tempfile::tempdir()`。本报告区分源码、stub、真实 CLI 启动及模型工具执行，不能互相替代。

## 结论与 harness 准入

| Harness | 已实测证据 | 当前 kickoff 准入 |
|---|---|---|
| Claude Code 2.1.280 | 真实 CLI + user-scope 本地 MCP：deny `mcp__*` 移除 MCP 工具；无 deny 时可见 `mcp__probe__ping`。21 个 engine stub 测试通过，3 个 run-status 测试通过 | **禁用，等待 Task 0b 与真实认证验收**。原用户认证已过期，不能宣称真实模型执行拒绝通过；普通 deny 黑名单仍留下新增有副作用工具 |
| Codex CLI 0.162.1 | 11 个 engine stub 测试通过，2 个 run-status 测试通过；普通 argv 只有 sandbox read-only，没有禁 shell、用户 MCP 配置隔离 | **禁用**。read-only 不等于禁命令、禁 MCP，未满足 §10 / §13.10 |
| DeepSeek dsh 0.1.0-rc.7 | 33 个 engine ACP stub 测试通过，2 个 run-status 测试通过；只读模式到达子进程，默认权限请求被拒绝 | **禁用**。stub 未执行真实工具；ACP 空 mcpServers 不证明用户 profile 不含扩展工具；只读沙箱并非禁止所有命令 |

当前不能把任一家显示为安全可用。Claude 是最小可落地路线。MCP deny 本身有效，**不需要以“deny失效”为理由新增 strict_mcp**；但为避免用户 MCP 服务器启动/发现及新增内建工具绕过黑名单，Task 0b 建议一个 opt-in `strict_readonly` 模式统一限制内建工具并隔离 MCP。修复后的真实 CLI 与真实 claude-agent 验收仍是准入条件。

## 0.1 Claude MCP：实际启动对照

官方：[Configure permissions — Tool name wildcards](https://code.claude.com/docs/en/permissions#tool-name-wildcards)，2026-10-27 查阅：deny 支持工具名 glob，`mcp__*` 覆盖所有服务器的 MCP 工具。allow 的 `mcp__*` 语义不同，不能把 allow 文档的限制套到 deny。

隔离 `CLAUDE_CONFIG_DIR=/tmp/notemd-task0-probe/config` 下 `.claude.json` 配置一个 user-scope 本地 Python stdio MCP（唯一工具 ping，返回 pong，不访问网络）。config/settings.json 允许 `mcp__probe__ping`，分别在 deny/control 工作目录 `.claude/settings.json` 放置相同规则，仅 deny 组额外添加 `mcp__*`。

命令（两个 case 分别在对应目录运行）：

```sh
CLAUDE_CONFIG_DIR=/tmp/notemd-task0-probe/config claude -p 'Read Task.md. List visible MCP tools. If mcp__probe__ping exists call it once. Try Bash echo TASK0 and Write marker.md. Report which are unavailable.' --output-format stream-json --verbose --max-turns 4 --setting-sources user,project
```

实际 init 输出：

```text
deny: mcp_servers=[{name:probe,status:connected,source:user}]; tools 不包含 mcp__probe__ping
control: mcp_servers=[{name:probe,status:connected,source:user}]; tools 包含 mcp__probe__ping
```

deny 组工具清单仍含 `CronCreate,CronDelete,CronList,EnterWorktree,ExitWorktree,Glob,Grep,ListAgents,Read,ReportFindings,ScheduleWakeup,SendMessage,Skill,TaskStop,ToolSearch,Workflow`。Bash/Edit/Write/NotebookEdit/WebFetch/WebSearch/Agent 已消失。**因此仅禁已知写工具不足以证明只读**。

随后模型请求 `authentication_failed` / `Not logged in · Please run /login`，未执行 MCP tools/call。尝试继承原用户认证、显式 `--strict-mcp-config --mcp-config <仅本地probe配置> --tools Read,Glob,Grep --setting-sources project`，CLI 在模型调用前返回 `Failed to authenticate: OAuth session expired and could not be refreshed`。未复制或输出凭据，未修改用户配置。此证据证明 MCP 可见性门禁，不证明模型实际尝试工具调用或 claude-agent 完整链路通过。

源码：`claude-agent/backend/src/prompt.rs:49–78` 普通 argv；`:87–101` 现有 input-only argv 含 safe-mode、空 tools、strict-mcp-config。`engine.rs:144–200` 普通任务与编译内置 input-only 分流。自定义 kickoff 不在 `task.rs:22–33` 内置白名单，不能复用“内置任务已安全”的结论。

## 0.2 Codex / DeepSeek 只读与 MCP

Codex：`plugins-src/codex-agent/backend/src/task.rs` 的播种模板为 AGENTS.md；`argv.rs:8–28` 普通任务只设置 `-a never exec --sandbox read-only`，没有禁 shell 或 MCP。`:33–58` 只有内置 input-only 才添加 strict-config、ignore-user-config、ignore-rules、disable shell_tool/unified_exec 等。`runner.rs:92` 把 policy.permission_mode 传为 sandbox。不能把 workspace 不可写误报为无法运行只读命令。

DeepSeek：`engine.rs:127–151` scoped session 将任务目录 AGENTS.md（优先）/CLAUDE.md 内联进 prompt，同目录由 harness 自行发现；`task.rs:5` 明确 harness 中立协议文件是 AGENTS.md。`engine.rs:299` 传 DSH_PERMISSION_MODE；`templates/_dsh/cordis.patch.yml:27–49` 用沙箱 policy.mode 与 approval 承接，只读并没有把工具集合清空。`acp.rs:138` 的 mcpServers 必须为空，是 session 传参限制，不能证明继承 profile 所有 MCP/扩展均禁用。用户可自选 dsh_config，不能假设固定原厂 profile。

实际 stub 命令：

```sh
cargo +1.99.0 test --manifest-path plugins-src/codex-agent/backend/Cargo.toml engine::tests -- --nocapture
cargo +1.99.0 build --manifest-path plugins-src/deepseek-agent/backend/Cargo.toml --bin stub-acp
cargo +1.99.0 test --manifest-path plugins-src/deepseek-agent/backend/Cargo.toml engine::tests -- --nocapture
```

结果分别 11 passed、33 passed。DeepSeek 包括 `the_sandbox_mode_reaches_the_child_as_an_environment_variable`、`the_default_policy_rejects_a_permission_request`、`walks_the_handshake_and_records_a_success`。首次 DeepSeek 缺 stub-acp 的 32 个失败已按测试提示构建 fixture 后全部通过。系统 stable cargo 不可用，固定使用现有 1.99.0 工具链，没有升级工具链。

## 0.3 terminal_result

成立，不限内置任务。`agent-run-core/src/scaffold.rs:221` finalize 无任务 id 判断，保存完整结果；Claude `engine.rs:441` 同样保存。上限/完整性见 `record.rs:133–185`，过大返回错误而非静默截断。三家 plugin run_status 从对应 task run dir 读 sidecar：Claude `plugin.rs:812–818`，Codex `:816–822`，DeepSeek `:776–782`。返回形态 `{state:done,record,terminal_result:{complete:true,content:...}}`。

```sh
cargo +1.99.0 test --manifest-path plugins-src/agent-run-core/Cargo.toml scaffold::tests -- --nocapture
cargo +1.99.0 test --manifest-path plugins-src/claude-agent/backend/Cargo.toml engine::tests -- --nocapture
# 对 claude-agent/codex-agent/deepseek-agent 各执行：
cargo +1.99.0 test --manifest-path plugins-src/claude-agent/backend/Cargo.toml run_status -- --nocapture
```

结果 core 12 passed、Claude engine 21 passed、run_status Claude 3 / Codex 2 / DeepSeek 2 passed。核心 `finalize_keeps_a_small_record_summary_and_an_exact_machine_result` 与三家 `run_status_reports_running_then_done` 确认完整机器结果区别于摘要；测试不是线上模型执行证据。

## 0.4 notify：当前无法省略两个路径

三家 `NotifySpec` 均必填 String：Claude `plugin.rs:48–56`、Codex `:45–53`、DeepSeek `:40–48`。缺字段报 `bad 'notify': missing field ...`（Claude `:578–579`，其他两家同流程）。省略整个 notify 可启动，但没有这条完成托盘提醒。省略 expect_file 当前不会进入所谓“无产物提醒”逻辑，直接解析失败。

`run_delivered` 必须 success 且 expect_file.is_file（Claude `:163–165`）；成功 action 为 open_path（`:169–173`）；失败通知 warning 且打开 provider 日志窗口（`:175–183`）。expect_file 同时成为 RunMeta.deliverable（Claude `:640`、Codex `:647`、DeepSeek `:605`），影响执行范围和产物校验。**不能将已有 Task 文件冒充结果文件验收**。

Task 0b 最小向后兼容方案：三家都改 `open_path: Option<String>`、`expect_file: Option<String>`（serde 默认 None），旧参数保持旧语义；deliverable 用 `notify.as_ref().and_then(|n| n.expect_file.as_ref()).map(PathBuf::from)`；无 expect_file 时 run_delivered 仅检查 record.status；有 expect_file 才检查文件。成功有 open_path 时继续打开文件，无 open_path 时用现有合法 `open_plugin_window` 打开 provider 日志，标题仍 title_ok。NEXT 下次打开后按 terminal_result 对账。为省略单项、两项、旧传参、错误 record、缺失期望文件写三家回归测试。不能仅改 Claude 而让 picker 显示另外两家兼容。

## 0.5 容量与任务锁：与 spec 假设不同

`src-tauri/src/plugin_runtime/ui_rpc.rs:1480–1498` host.agent.run 仅解析 provider 并中转，没有 max_concurrency 检查。`agent_provider.rs:47–58` 值来自 settings（默认1，限1–8），为展示/调用方调度信息，不能声称 host 全局裁决已实施。

`agent-run-core/src/lock.rs:60–65` 只有 ai-read-ebook 采用目标级并行锁。kickoff 为普通 task，三家共用 task run dir，因此**同一 Vault 全体 next-task-kickoff 运行串行**，即使不同 Task UUID/不同 provider/max_concurrency>1。引擎启动是在后台 spawn 后抢锁；调用方先拿到 run_id，再收到 `task.progress` busy（Claude plugin.rs:684–689：`{kind:busy,run_id,holder:...}`）及 toast `That task is already running`，没有立即 run RPC 容量报错、没有排队。busy 路径不必产生标准 done record，应防止 UI 永久 running。

core stub `the_same_task_cannot_preflight_twice_at_once` 及三家 engine `the_same_task_cannot_run_twice_at_once` 均通过。未伪称真实 host UI 容量超限测试。建议一期 NEXT 保守实行本插件同一Vault单运行，busy/lost 对账明确；若需按provider容量并行，应另行设计目标级锁与终态记录，超出单纯前端容量检查。

## 0.6 owner

当前 Memory v2 与 spec 的 USER.md frontmatter 假设不一致。`src-tauri/templates/USER.md` 是裸标题和投影提示；`memory_control/v2/projector.rs:409–411` 渲染同样没有 owner frontmatter。权威身份为结构化 AuthorityOwner（`model.rs:100–103`）；初始化 `service.rs:466–468` 得 `actor_id=human:<human_id>`、`owner_id=owner:<human_id>`。`notemd memory owner --json` 在 `cli/memory.rs:1776–1783` 返回 snapshot.owner，不能把 owner_id 原样再加 human 前缀。

NEXT 无需为答案署名启动 shell/agent，也不要扫描私人画像来猜身份。依 spec §7.3，读不到明确可验证 owner 标识时写 `human:owner`。未来若增 host owner 只读接口，直接取 AuthorityOwner.actor_id 并验证 human: 前缀；若兼容用户自写 USER.md 字段必须先定契约，不能凭本次研究臆造字段名。

## 0.7 Skill 类型

`src/lib/okf/concept.ts:24–73` 当前 CONCEPT_TYPE 没有 Skill；仓库 `rg -n '^type:.*Skill|^type:.*skill' --glob '*SKILL.md' --glob '*.md' plugins-src src-tauri/templates` 没有现成 Skill type 命中。未遍历正式私人 Vault，不能声称已检查其全部 skills frontmatter。

按 spec 新增 `skill:'Skill'`、taskKickoff:'Task Kickoff'，origin 分别 human / derived，运行 gen:origin-types 及跨语言同步测试。未知 type 的消费者宽容规则不能替代生产入口登记。

## 新增 agent capability 的升级授权

NEXT 增加 manifest `agent` capability 后，单个市场升级与首次安装会进入 ConsentModal，展示校验后的新 manifest capabilities，用户确认后再安装（`src/plugin-market-app.svelte` 的 `update` / `beginInstall`，以及 `src/components/market/ConsentModal.svelte`）。但现有“全部更新”在 `updateAll` 只做一次通用批量确认，随后直接调用 `plugin_market_install`，不会逐项展示新增 capability 或重新弹 ConsentModal；因此不能笼统声称所有升级都会单独重新授权。`host.agent.*` 仍受 `agent` capability 检查。规程首次确认与市场权限确认是不同边界。本轮仅改源码，未安装、未发布或触发升级，不产生任何新权限授权；不扩改市场流程。源码、bundle、已安装部署证据须分开。

## Task 0b 必要变更与后续关卡（研究时结论）

1. `agent-run-core/src/task.rs` 新增 serde default opt-in `strict_readonly: bool`（最终字段名由实现者统一）；旧 task.json 行为不变。
2. Claude `prompt.rs` / `engine.rs` 为该模式传 `--tools Read,Glob,Grep --strict-mcp-config --mcp-config {"mcpServers":{}}`，显式 settings deny `mcp__*` 防御性保留；不要复用现有 input-only 的空工具集合，否则不能读 Vault。
3. 明确该模式 settings/hook/skill/agent 发现边界。用户设置可含 hooks：仅 tools allowlist 不能证明 hook 不执行。优先验证 safe-mode 是否可保留只读工具并显式 append 任务协议；否则在安全模式下禁所有自定义 hooks/plugins/skills/rules，再提供可信模板协议。必须检查实际 CLI 版本对 flags 支持，不能只测 argv 字符串。
4. 三家 notify 可选路径兼容修复（上述0.4）；此项触及三家 provider，不应塞进“strict_mcp only”提交；分开精确提交与报告。
5. 完成后的隔离真实测试：user-scope stub MCP 存在；对照可调用，严格组不可见/不可调用；能读 Task 与声明 sources；Write/Bash/WebFetch/MCP 均不可用；只生成最终 JSON；RunRecord+terminal_result 落盘；run-status可回读；任何 hook/skill 未启动。原用户 OAuth 已过期需现有授权凭据恢复，当前不满足此验收。
6. Task 6 picker 对未通过以上证据的 provider 明确禁用；Task 0b测试/实现完成也不能自动替代真实准入。

## 验证记录位置

临时原始日志：`/tmp/notemd-task0-probe/{deny,control,auth-deny}.jsonl`、同名err、`mcp-events`、`core-tests.log`、`claude-tests.log`、`deepseek-tests.log`、`{claude,codex,deepseek}-status-tests.log`。日志只含隔离 Task 与本地 probe，不含凭据。研究步骤没有改源码；后续实现与当前准入状态见下。

## 实现后的状态（2026-10-27）

- `996f871f` 已实现三家可选通知路径，`ec61528b` 已实现 opt-in `strict_readonly`。上文“当前/尚未实现”描述研究时的基线，不代表最终分支源码。
- Claude 严格路径显式只开放 Read/Glob/Grep，隔离用户扩展与 MCP；拒绝 precheck、deliverable、外部协议 symlink，不注入 tab、不扫描 artifact 或补写 OKF。Codex/DeepSeek 对此模式产生明确失败终态，未启动 CLI。
- 全量 Rust 测试：agent-run-core 161、Claude 123、Codex 84、DeepSeek 133，通过。新增字段默认 false，保留旧任务行为；capability 只表示实现支持，不等于真实安全验收。
- 用户明确要求“先完成代码，真实运行留待验证”。NEXT 的生产列表来自 `host.agent.providers` 的**全部已安装插件**，安全验收未通过的条目保留名称与原因但禁用；不固定 Claude，不把三家写成安装清单。当前没有 provider 获得真实准入。
- 真实模型与严格工具拒绝矩阵仍未验，未安装、未发布、未推送。最终代码验收详见 [验收报告](2026-10-27-next-task-kickoff-verification.md)。
