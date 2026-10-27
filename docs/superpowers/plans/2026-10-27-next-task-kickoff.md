# NEXT「帮我开个头」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 NEXT 的 Task 卡片上实现「帮我开个头」：选择 agent，只读运行 `next-task-kickoff` 模板，按钮计时，NEXT 校验载荷后写入 `*-task.kickoff.md`，结果面板里回答问题，再预填安放面板。

**Architecture:** 委托链复用 idea-spark 的 `idea-proof` 模式：播种 vault 任务模板 → `host.agent.run` → 每 2 秒轮询 `host.agent.status` → 由 agent 插件发托盘提醒。与 idea-proof 不同，agent **不写文件**：载荷通过 `terminal_result.content` 返回，由 NEXT 内的纯函数校验，再经 OKF 生产入口写盘。逻辑按「纯函数 + 注入 IO」拆分，Svelte 组件只负责编排。

**Tech Stack:** Svelte 5、TypeScript、Vitest（`plugins-src/next`）；Rust（只在 Task 0 判定需要时改 `agent-run-core` / `claude-agent`；`searchidx` origin 映射）。

**Spec:** `docs/superpowers/specs/2026-10-27-next-task-kickoff.md`（下文用「spec §n」引用）。spec 与本计划冲突时以 spec 为准；spec 有歧义时停下来问，不要自行决定。

## Global Constraints

- 开工前阅读 `AGENTS.md`、`CLAUDE.md`、`tasks/lessons.md`。被纠正后按 `AGENTS.md` 的要求更新 lessons。
- 写 `.md` 的硬规矩：新的写入点必须经过 `src/lib/okf/concept.ts`；新 `type` 必须先登记，并同步 `searchidx` 的 origin 映射（见 `concept.ts` 文件头注释）；用 `pnpm okf:lint <目录>` 自检。
- 安全边界不能放松（spec §10）：agent 只读、不联网、不执行命令、不用 MCP；NEXT 不因本功能修改 Task 文件、账本或提醒；commit 只来自用户在安放面板的提交。
- 播种语义：文件存在就跳过，**从不覆盖**（包括用户改过的模板和 skill）。
- 行为变更先写测试、看到 RED，再实现到 GREEN。stub host 时按真实形态构造响应（`run-status` 的 `running` 带 `started_at` / `steps` / `last`，`done` 带 `record` 和 `terminal_result`），参照 `plugins-src/claude-agent/backend/src/plugin.rs` 的 `run_status`。
- 每个 Task 只提交自己验证过的改动，用明确的路径 `git add <paths>`，**禁止 `git add .`**。不要 push，不要发版，不要改 NEXT 插件版本号（发版另行安排）。
- 保留工作区里与本任务无关的未提交、未跟踪文件，不要动。
- 报告里要分清「代码已实现」「单测通过」「真实 harness 已验证」三件事。没有真实运行证据的项目，写「待验证」，不能写「通过」。

## File map and shared interfaces

新增（全部位于 `plugins-src/next/src/lib/kickoff/`，除非另有说明）：

| 文件 | 职责 | 主要导出 |
|---|---|---|
| `payload.ts` | 解析、校验、修正 `next-kickoff/v1`（spec §6） | `parsePayload(raw: string, expect: { taskId: string; basedOn: string }, exists: (rel: string) => Promise<boolean>): Promise<PayloadResult>`；类型 `KickoffPayload`、`PayloadResult = { ok: true; payload: KickoffPayload; repairs: string[] } \| { ok: false; error: string }` |
| `document.ts` | 结果文件的路径、渲染、读取、写入（spec §7） | `kickoffPathFor(taskRel: string): string`；`renderBody(payload, answers): string`（纯函数，输出稳定）；`buildKickoffDocument(input): string`；`parseKickoffDocument(content): KickoffDoc \| null`；`withAnswers(doc, answers, now): { content: string; rerendered: boolean }`；`carryPriorAnswers(oldDoc \| null, runId): PriorAnswer[]` |
| `registry.ts` | `.notemd/next-kickoff.json` 的全函数解析、序列化（spec §8） | `REGISTRY_PATH`；`parseRegistry(raw: string \| null): Registry`；`serializeRegistry(r): string`；`markRunning` / `markFailed` / `clearRun` / `markUnread` / `markRead`（纯函数，返回新对象） |
| `status.ts` | `run-status` 响应 → 视图（spec §9.2） | `interpretKickoffStatus(raw: unknown): KickoffRunView`；`formatElapsed(ms: number): string`（`m:ss`，≥1 小时为 `h:mm:ss`） |
| `button-state.ts` | 卡片按钮状态判定（spec §4.1、§4.2） | `kickoffEligible(item: WorkspaceItem): boolean`；`kickoffButtonState(input): ButtonState` |
| `prefill.ts` | 答案 → 安放面板预填（spec §4.5） | `commitPrefill(payload, answers): { initialCommit; extraOptions }` |
| `template.ts` | 模板与 skill 的文件内容和播种（spec §5） | `TASK_ID = 'next-task-kickoff'`；`TEMPLATE_FILES`、`SKILL_FILES: Record<string, string>`；`seedFiles(io, files)`；`needsConsent(io): Promise<boolean>`；`parseDataSources(skillMd: string): DataSource[]` |
| `client.ts` | bridge 调用与编排（发起前检查、run、轮询、对账） | `preflight(...)`；`startKickoff(...)`；`reconcile(...)`。IO 全部注入，便于单测 |

修改：

- `plugins-src/next/src/lib/bridge.ts`：新增 `agentRun`、`agentStatus`、`agentProviders`、`agentLimits`（签名照抄 `plugins-src/idea-spark/src/lib/bridge.ts`）。
- `plugins-src/next/manifest.v2.json`：`capabilities` 增加 `"agent"`。
- `plugins-src/next/src/lib/agent-picker/`：通过 `node scripts/sync-agent-picker.mjs` 生成副本；`scripts/sync-agent-picker.mjs` 的目标列表增加这个目录。
- `plugins-src/next/src/components/IdeaCard.svelte`：新增属性 `kickoff?: KickoffCardView`、`onKickoff?(item, anchor)`。
- 新组件：`KickoffButton.svelte`、`KickoffProgress.svelte`、`KickoffSheet.svelte`、`KickoffConsent.svelte`。
- `plugins-src/next/src/components/PlaceSheet.svelte`：新增可选属性 `initialCommit`、`extraOptions`（spec §4.5）。属性缺省时行为与现在完全一致。
- `plugins-src/next/src/App.svelte`：接线（登记加载、对账、轮询、面板开关）。
- `plugins-src/next/src/lib/strings.ts`：en / zh / ja / de 四套文案。
- `src/lib/okf/concept.ts`：`taskKickoff: 'Task Kickoff'`（如果仓库还没有 skill 的类型，再加 `skill: 'Skill'`）。
- `searchidx/src/origin.rs` 与 `searchidx/tests/fixtures/origin/concept-types.json`。
- `CHANGELOG.md`、`CHANGELOG.zh-CN.md` 的「未发布」区；`plugins-src/next/CHANGELOG.md`。

依赖关系：

```text
Task 0（核实关卡）──┬─> Task 5（模板内容依赖核实结论）
                   └─> Task 6（notify / 容量行为）
Task 1、2、3、4 可在 Task 0 进行时并行（不依赖核实结论）
Task 7 依赖 2、3、4、5、6
Task 8 依赖 7
```

---

### Task 0: 核实关卡（只出报告，不改产品代码）

**产出：** `docs/superpowers/reports/2026-10-27-next-task-kickoff-task0.md`，逐项写结论和证据（命令、输出摘录、文件:行号）。

- [ ] **0.1 MCP 是否能禁用（Claude）。** 在临时 vault 播种一个只读测试任务，在用户级配置了至少一个 MCP 服务器的环境下，通过 claude-agent 运行，要求 agent 列出并尝试调用 MCP 工具。分别验证两种做法：(a) 在 `.claude/settings.json` 的 `deny` 中加 MCP 规则，查 Claude Code 文档确认规则写法；(b) 不加规则。结论必须是以下之一：「settings deny 能覆盖全部 MCP 工具（写出确切规则）」，或「不能，需要 `strict_mcp`」。如果是后者，在报告里附上 `TaskDef` 新增 `strict_mcp: bool` 的改动方案：claude-agent 追加 `--strict-mcp-config` 并传入空 MCP 配置，参照 `plugins-src/claude-agent/backend/src/prompt.rs` 的 `build_input_only_argv`。
- [ ] **0.2 Codex / DeepSeek 的只读与 MCP。** 确认两家对 vault 播种任务读取的是哪个指令文件（预期是 `AGENTS.md`；查 `plugins-src/codex-agent/backend/src/`、`plugins-src/deepseek-agent/backend/src/` 的任务加载代码），以及 `policy.json` 的 `permission_mode: read-only` 是否同时拦截文件写入、命令执行和 MCP。各跑一次真实或 stub 运行留证据。
- [ ] **0.3 `terminal_result`。** 确认 vault 播种的（非内置）任务在三家都会写入 `terminal_result`，并通过 `run-status` 返回（`agent-run-core/src/scaffold.rs:221`、`claude-agent/backend/src/engine.rs:441` 是入口线索）。
- [ ] **0.4 notify 不带 `open_path`。** 查 `host.agent.run` 的 `notify` 处理代码，确认 `open_path` 和 `expect_file` 都可以省略。如果必须提供，就记录替代方案：`open_path` 指向 Task 文件；并说明省略 `expect_file` 后托盘提醒的行为。
- [ ] **0.5 容量超限。** 正在运行数 ≥ `max_concurrency` 时再调用 `host.agent.run`：确认是排队还是报错，报错的话记录错误消息的形态。
- [ ] **0.6 owner id。** 查 Vault `/USER.md` 的 owner 字段约定（线索：`plugins-src/next/scripts/task-api.ts:120` 要求的 `notemd memory owner --json`，以及 memory 插件的 owner 解析代码），确定 NEXT 插件里读取 owner id 的方式。读不到时，按 spec §7.3 使用 `human:owner`。
- [ ] **0.7 Skill 类型。** grep `src/lib/okf/concept.ts` 和 Vault skills 的现有 frontmatter，确认仓库是否已经约定了 skill 文件的 OKF `type`。

**判定：** 0.1 或 0.2 不通过的 harness，在 Task 6 中从本功能的可用列表里排除，并在报告里写明。0.1 需要改 Rust 时，把改动作为 Task 0b 单独实现：先写测试，提交范围只限 `agent-run-core` / `claude-agent`。

### Task 1: OKF 类型登记

**Files:** `src/lib/okf/concept.ts`、`searchidx/src/origin.rs`、`searchidx/tests/fixtures/origin/concept-types.json`。

- [ ] 加入 `taskKickoff: 'Task Kickoff'`，注释写明：`NEXT「帮我开个头」的结果 inbox/tasks/*-task.kickoff.md（agent 载荷经 NEXT 校验后写入）`。
- [ ] `origin.rs`：把 `Task Kickoff` 加入与 `Idea Proof` 相同的派生档（`origin.rs:93` 一带）。
- [ ] 如果 Task 0.7 的结论是需要新增 `Skill` 类型：一并登记，origin 档位为 human。
- [ ] 运行 `pnpm gen:origin-types`、`concept-origin-sync` 测试和 searchidx 的 origin 测试，确认全部通过。

### Task 2: 载荷校验 `payload.ts`

**Files:** `plugins-src/next/src/lib/kickoff/payload.ts`、`payload.test.ts`。

- [ ] 先写测试，覆盖 spec §6.2 的**每一条**拒收规则（一条规则至少一个用例）和每一种修正，再加上：代码围栏剥离（只剥唯一包住整体的那一个）、前后带说明文字时拒收、64 KiB 上限、按 code point 计数（用 emoji 和中文构造边界用例）、未知键被删除、`fact` 来源全部删除后降级为 `inference` 并加 `unverified`。
- [ ] 实现：纯函数，`exists` 通过参数注入。错误消息用稳定的英文代码加字段路径，例如 `questions[1].options: expected 2-4, got 5`，UI 层再翻译。
- [ ] `pnpm --dir plugins-src/next test payload` 通过。

### Task 3: 结果文件 `document.ts`

**Files:** `plugins-src/next/src/lib/kickoff/document.ts`、`document.test.ts`；`__fixtures__/` 下放一份合法载荷。

- [ ] 测试覆盖：
  - `kickoffPathFor` 的路径映射；
  - `buildKickoffDocument` 生成的 frontmatter 字段齐全（spec §7.2）：`generated.by` 由 `notemd.claude-agent` 变为 `process:claude-agent`，harness 缺失时用回退值；
  - `renderBody` 对同一输入输出逐字节相同；已答问题标 `●`，agent 内容标 `✦`；
  - `withAnswers` 的两条分支：正文哈希等于 `rendered` 时重新渲染，不等于时只改 frontmatter，并返回 `rerendered: false`；
  - 每题只保留一条答案，再次回答会覆盖；`by` 必须以 `human:` 开头（否则抛错）；
  - `carryPriorAnswers` 把旧 `answers` 和旧 `prior_answers` 合并，并加上 `run_id`；
  - 往返测试：`parseKickoffDocument(buildKickoffDocument(x))` 得到等价对象；frontmatter 里的未知键被保留。
- [ ] 实现：frontmatter 的生成和编辑复用 NEXT 已有的 `frontmatter-document.ts` 和 OKF 生产入口，不手拼 YAML 字符串。日期字符串加引号。
- [ ] 用测试生成一个样例文件，放进临时目录，运行 `pnpm okf:lint <临时目录>` 并通过。

### Task 4: 运行登记、状态解释、按钮状态

**Files:** `registry.ts`、`status.ts`、`button-state.ts`、`prefill.ts`，以及各自的 `*.test.ts`。

- [ ] `registry`：损坏的 JSON、缺字段、类型错误都回退到空登记，不抛错；所有修改函数都是纯函数（测试断言输入对象没被改动）。
- [ ] `status`：spec §9.2 表格的每一行都有用例；`formatElapsed` 测 `0:00`、`9:59`、`59:59`、`1:00:00`，负数按 0 处理。
- [ ] `button-state`：spec §4.1 的显示条件和 §4.2 的七种状态都有用例，`stale` 用哈希不一致构造。
- [ ] `prefill`：spec §4.5 的三级取值顺序、多个问题决定同一字段时取靠前的、自由输入优先于选项、`extraOptions` 去重且最多 4 个。

### Task 5: 模板与 skill（依赖 Task 0）

**Files:** `plugins-src/next/src/lib/kickoff/template.ts`、`template.test.ts`。

- [ ] 按 spec §5.1 写出 `task.json`、`policy.json`、`.claude/settings.json`、`.claude/settings.scoped.json`。MCP 的 deny 规则使用 Task 0.1 的结论。
- [ ] 按 spec §5.3 的九条规则撰写指令正文，第一行是版本标记。`CLAUDE.md` 与 `AGENTS.md` 使用同一个常量，测试断言两者逐字节相等。沿用 idea-spark 的「行数组 join」写法，避免反引号和 `${VAULT}` 被 JS 当成模板插值（原因见 `plugins-src/idea-spark/src/lib/task-template.ts` 的文件头注释）。
- [ ] 按 spec §5.4 写出 `skills/task-kickoff/SKILL.md`，判断方法部分要写完整，不能留占位符。`parseDataSources`：解析失败时返回 `[{ id: 'task', kind: 'vault', ... }]`；非 `vault` 类型保留，但标记为 `enabled: false`。
- [ ] `seedFiles`：存在就跳过（测试：先写一份改过的内容，再播种，内容不变）。`needsConsent`：skill 不存在时返回 true。
- [ ] 测试断言：指令文本包含 `next-kickoff/v1`、「只读」、「不写」等关键约束；`settings.json` 的 `deny` 包含 `Write`、`Edit`、`Bash`、`WebFetch`、`WebSearch`。

### Task 6: bridge、客户端编排、权限声明（依赖 Task 0）

**Files:** `bridge.ts`、`kickoff/client.ts`、`client.test.ts`、`manifest.v2.json`、`scripts/sync-agent-picker.mjs`、`agent-picker/` 副本。

- [ ] `manifest.v2.json` 的 `capabilities` 加入 `"agent"`。同时检查 host 对已安装插件新增 capability 时的处理（是否需要用户重新授权），结论写进报告。
- [ ] 运行 `node scripts/sync-agent-picker.mjs`，确认 byte-identical 测试通过。
- [ ] `preflight`：spec §5.2 的四项检查，每项都有失败用例。`based_on` 用 `crypto.subtle.digest('SHA-256', 原始字节)` 计算，输出小写 hex。
- [ ] `startKickoff`：调用参数严格按 spec §5.2，测试断言 `prompt` 的每一行和 `notify` 字段（是否带 `open_path` 按 Task 0.4 的结论）；`run_id` 为空时视为失败；消息里带 `agent_unavailable` 时归为 `agent-missing`（照搬 idea-spark 的 `delegateIdea`）。
- [ ] `reconcile`：输入是登记、状态查询函数和 vault IO，输出是新登记和要写的文件。用例覆盖：成功（含 `prior_answers` 继承）、`invalid-output`、`missing-result`、运行期间 Task 被删除（`task-changed`）、`lost`、重复对账幂等（同一个 `run_id` 不会写两次）。
- [ ] Task 0 判定不通过的 harness：在 provider 列表里标为不可用，并显示原因。

### Task 7: UI 接线

**Files:** `IdeaCard.svelte`、`KickoffButton.svelte`、`KickoffProgress.svelte`、`KickoffSheet.svelte`、`KickoffConsent.svelte`、`PlaceSheet.svelte`、`App.svelte`、`strings.ts`，以及对应的 `*.render.test.ts`。

- [ ] `PlaceSheet` 新增 `initialCommit` 和 `extraOptions`。先写渲染测试：缺省时现有测试全部通过；传入时三个字段按预填值显示，候选项出现在 `ChoiceField` 里。
- [ ] `KickoffButton`：七种状态的渲染测试。计时用注入的 `now()`，测试里推进时间断言文本变化；计时区设 `aria-live="off"`。
- [ ] `KickoffConsent`：确认后才调用播种；取消时不写任何文件。
- [ ] `KickoffSheet`：按 spec §4.4 的区块顺序渲染；单选 + 「其他」输入；至少答一题主按钮才可用；来源角标调用 `editorOpen`；`stale` 时显示横幅；`unverified` 和 `inference` 显示对应标签。
- [ ] `App.svelte`：窗口打开时加载登记并对账一次；为每个 `running` 运行启动 2 秒轮询，窗口卸载时清除；结果写入后刷新卡片；「用这些答案安放」的顺序是保存答案 → 回读成功 → 用 `prefill` 打开 `PlaceSheet`。
- [ ] `strings.ts`：所有新文案的四种语言齐全，`strings.test.ts` 通过。
- [ ] `pnpm --dir plugins-src/next test`、`check`、`build` 全部通过。

### Task 8: 真实运行验收与收尾

- [ ] 在临时 vault 里，用每个可用的 harness 各做一次端到端运行（真实模型）：按钮计时 → 完成 → 结果文件 → 回答 → 预填安放 → 提交。截图或录屏，连同结果文件一起作为证据。
- [ ] 只读验收（spec §13 第 10 条）：在模板里临时加一句诱导 agent 写文件、执行命令、调用 MCP 的指令，每个 harness 跑一次，证明全部被拒；然后恢复模板。证据写入 Task 0 报告的附录。
- [ ] 窗口关闭验收：运行中关闭 NEXT → 收到托盘提醒 → 重新打开 → 对账写入结果，时长连续。
- [ ] `pnpm okf:lint inbox/tasks`（临时 vault）通过；NEXT 的 Task 数量、task CLI 的 `list` 都不受结果文件影响。
- [ ] CHANGELOG：根目录中英两份「未发布」区各加一条面向用户的条目，例如英文：**NEXT: "Help me start" on task cards.** Pick an agent to read your vault and come back with up to three questions that decide your next step; answers prefill the commit sheet. Read-only — nothing is committed for you.；同时更新 `plugins-src/next/CHANGELOG.md`。运行 `node scripts/changelog.mjs check`。
- [ ] 最终报告：逐条对照 spec §13 的验收标准，每条写「通过（证据）」或「待验证（原因）」。


## 评审修复补丁 1.12.1

1. 独立worktree保留其他会话改动；记录五项评审与旧低优先项。
2. 背景分源/分锚点公平预算、中文匹配、已完成任务预过滤 → 大Vault回归。
3. 每次发送预览并冻结整个输入，v2能力门禁/引擎拒绝降级 → UI/生产client与真实传输回归。
4. 保存来源集合、旧run兼容、capacity与整数duration → 重启对账和锁并发回归。
5. 全NEXT/Agent测试与独立复审；正式包大Vault真实默认模型验收；审计全部worktree/分支/stash；冻结tag后按Wrangler3 R2→公网验签→KV→公网复核发布并记录commit/hash。

最终发布和验证结果见对应 `docs/reports` 报告，任务勾选不替代提交或包内证据。
