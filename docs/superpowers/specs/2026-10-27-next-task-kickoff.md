# NEXT「帮我开个头」设计

- 日期：2026-10-27
- 状态：1.11.0 基础实现已发布；1.12.0 完整可用执行、进行中入口和复合按钮已实现，发布验收见 reports。
- 影响范围：`notemd.next`（卡片、新面板、安放面板、运行登记）、`.notemd/agent-tasks/next-task-kickoff/`（新任务模板）、Vault `skills/task-kickoff/`（新规程）、`src/lib/okf/concept.ts` 与 `searchidx/src/origin.rs`（新 OKF 类型）、`scripts/sync-agent-picker.mjs`（新增副本）
- 执行计划：`docs/superpowers/plans/2026-10-27-next-task-kickoff.md`
- 来源：用户 2026-10-27 的需求；启发来自「肖弘用智能体预研把待办变成可交接的方案」阅读笔记（能做就先启动，缺背景或负责人才问，交接时需求和调研一起给）

## 2026-10-27 可用执行补充（用户最新要求）

用户要求真实可用、进行中Task支持及一体复合按钮，覆盖之前真实验收延期。实际安装的是Codex Agent和DeepSeek Agent；未安装Claude Agent不参与本机验收。

跨harness只读执行统一为**NEXT读取声明范围内的背景并冻结context packet，模型只消费packet**。Codex/DeepSeek 的 `timeout_seconds` 为从执行开始计算的硬性总时限；`max_turns` 是协议收束目标，这两家无工具执行接口不提供通用硬性轮数上限。此处覆盖下文原先让agent自行检索Vault的执行方式：没有Read/命令/写文件/网络/MCP工具，没有用户hooks或扩展；运行在空临时cwd。包内保留文件相对路径、完整当前Task及相关证据，有限预算或读取失败写入gaps；来源内容不是新的指令，agent不得声称检索未包含的文件。背景范围仍由用户规程data_sources声明，未知/不可解析规程只带当前Task。

已真实验证并部署的provider发布`capabilities.readonly_context=true`及完整terminal_result能力，NEXT据此和harness健康状态判断能否执行；移除生产空白名单永久禁用。旧Agent版本显示更新要求，认证问题显示真实harness原因，不以“验证未完成”掩盖所有情况。仅有旧strict_readonly标志不能获得新执行能力。

## 0. 结论

Task 卡片上新增「帮我开个头」按钮。用户点击并选择一个 agent 后，NEXT 委托它**只读**运行专门的任务模板 `next-task-kickoff`。agent 按 Vault skill `skills/task-kickoff/SKILL.md` 声明的数据源整理背景，最终消息输出一份结构化 JSON（`next-kickoff/v1`），核心是 **1–3 个驱动下一步的提问**，每个问题标明它决定哪个安放字段。NEXT 先校验 JSON，再写成 Task 旁边的 `*-task.kickoff.md`。

运行期间，按钮显示已运行时长；完成后点击打开结果面板。用户在面板里回答问题，然后「用这些答案安放到现在推进」：打开预填好的安放面板，**由人提交 commit**。

```text
卡片「帮我开个头」→ 选 agent（显示数据源）→ host.agent.run(next-task-kickoff，只读)
   → 按钮计时 ⏱ m:ss（host.agent.status 轮询）
   → 完成：terminal_result(JSON) → NEXT 校验 → 写 <task>.kickoff.md → 托盘提醒
   → 点击「查看开头」→ 面板：提问 / 背景 / 建议 / 缺口
   → 回答 → 答案以 human: 署名写入 kickoff 文件 → 预填安放面板 → 人提交 commit
```

## 1. 目标与非目标

### 1.1 目标

1. 用户不知道如何开始一个 Task 时，一次点击就能得到「从哪里开始」所需的背景和**少量必须由人回答的问题**。
2. 回答问题能直接变成安放字段：`commitment` / `next_action` / `close_condition`。
3. 不同 harness（Claude / Codex / DeepSeek）可以互换，安全边界不依赖某家的权限语法。
4. 人的回答是判断，必须留存、署名为 `human:`，不能被重跑覆盖。

### 1.2 非目标（第一期不做）

- 不自动 commit、不占 WIP、不改 Task 文件、不写 NEXT 账本：agent 没有这些写权限，NEXT 也不替人写。
- 不读 Vault 之外的数据源（邮件、Slack、Notion、网页）。这类来源留到第二期，需要人确认扩权（§11）。
- 不支持中途取消：host 目前只有 `run / status / providers / limits` 四个接口，没有 cancel（§9.4）。
- Idea 卡片不显示这个按钮：Idea 已有奇思妙想插件的「论证」。
- 不做批量开头、晨间主动提议、「带着答案再跑一轮」（§11）。

## 2. 术语

| 术语 | 含义 |
|---|---|
| 开头（kickoff） | 一次「帮我开个头」运行及其产物 |
| 模板 | `.notemd/agent-tasks/next-task-kickoff/`，host 上 agent 任务的定义目录 |
| 规程 skill | Vault 的 `skills/task-kickoff/SKILL.md`：告诉 agent 去哪找背景、怎么判断；属于信念 6 所说的 Playbook |
| 载荷（payload） | agent 最终消息里的 `next-kickoff/v1` JSON |
| 结果文件 | `inbox/tasks/<Task 文件名去掉 .md>.kickoff.md` |
| 运行登记 | `.notemd/next-kickoff.json`，记录进行中的运行和未读状态 |
| `based_on` | 发起运行时 Task 文件原始字节的 SHA-256，格式 `sha256:<64 位小写 hex>` |

## 3. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **agent 全程只读，不写任何文件**；结果通过 `terminal_result` 返回，由 NEXT 校验后写盘 | 三个 harness 的权限机制不同（Claude 用 `.claude/settings.json`，Codex/DeepSeek 用 `policy.json` 的 `permission_mode`），「只许写某一类文件」很难在三家都做准，「只读」三家都支持（`read-only`）。另外，载荷先校验再写盘，坏输出不会落进 `inbox/tasks/`。已核实：三家的 `run-status` 在 `done` 时都返回 `terminal_result.content`（完整内容，上限 1 MiB，`agent-run-core/src/record.rs:12`）；`record.result` 会被截到 8 KiB，不能用 |
| D2 | 结果放在 Task 旁边的独立文件，不写入 Task 正文 | Task 的 YAML 和正文由人或创建者拥有；现有 CLI 的 `update` 也不支持写正文（`plugins-src/next/scripts/task-api.ts:178`）。NEXT 只扫描以 `-task.md` 结尾的文件，`.kickoff.md` 不会被当成任务 |
| D3 | 产物以**提问**为核心：1–3 个问题，每个问题有 `decides` 字段 | 用户要的是驱动下一步的提问；`decides` 让答案能直接变成安放字段，而不是答完还要再转述一遍 |
| D4 | 人的回答写进结果文件的 `kickoff.answers`，署名 `human:`；commit 只能由人在安放面板提交 | 信念 1（判断是最有价值的数据）；信念 3（agent 建议，人确认）；OKF §7（人工内容必须用 `human:` 前缀） |
| D5 | 不用 `precheck.sh`；发起前的检查由 NEXT 在插件内完成 | `host.vault.write` 不能设置可执行位（`plugins-src/idea-spark/src/lib/task-template.ts` 的注释），播种出来的脚本可能跑不了 |
| D6 | 首次使用要人确认，才把规程 skill 写进 Vault | 往 Vault 里加 skill 属于规程变更（信念 6）。确认弹窗写明要添加的文件和它的只读边界 |
| D7 | 第一期没有取消按钮，用更紧的预算兜底：`timeout_seconds: 600`、`max_turns: 40` | 没有 cancel 接口时，把最坏情况限制在 10 分钟以内 |

## 4. 用户流程

### 4.1 按钮在哪些卡片上显示

满足以下**全部**条件时显示：

- `item.kind === 'task'`；
- Task 来源有效（不在只读修复区，`task.id` 合法）；
- 泳道是 **收件箱 / 进行中 / 等待 / 稍后**，不在已完成；（2026-10-27 用户明确修订：进行中的 Task 同样可以开个头。）
- 当前 NEXT 窗口所在的 host 支持 `host.agent.providers`（老 host 不显示按钮，不报错）。

位置：卡片操作区，排在「安放」旁边，属于次要按钮。主操作区与右侧下拉箭头共用一个外边框，内部用分隔线区分，无间距、无两个独立圆角按钮；主区执行或查看结果，箭头选择 agent。主区 ArrowDown 也打开选择器。可访问名：「帮我开个头：<Task 标题>」。

### 4.2 按钮状态

| 状态 | 判定 | 显示 | 点击 |
|---|---|---|---|
| `idle` | 没有登记中的运行，也没有结果文件 | 「帮我开个头」 | 打开 agent 选择（§4.3） |
| `starting` | 已点击，`host.agent.run` 还没返回 | 「正在启动…」，禁用 | — |
| `running` | 登记中有 `run_id`，`status.state === 'running'` | `⏱ m:ss`（≥1 小时显示 `h:mm:ss`）；悬浮提示「第 N 步 · <last>」 | 打开进度弹层：agent 名、已运行时长、步数、最后动作、「运行期间关闭窗口不影响结果」 |
| `ready-unread` | 结果文件存在，未读集合里有这个 Task | 「查看开头」+ 圆点；悬浮提示「用时 m:ss」 | 打开结果面板（§4.4），并标记已读 |
| `ready` | 结果文件存在，已读 | 「查看开头」 | 打开结果面板 |
| `stale` | 结果文件存在，但当前 Task 的哈希 ≠ `kickoff.based_on` | 「查看开头」+「已过期」小标签 | 打开结果面板，顶部提示「结果基于任务的旧版本」 |
| `failed` | 最近一次运行失败（§9.3），登记里留有失败记录 | 「开头失败 · 重试」 | 打开失败详情：原因、harness `warning`、「重试」「换个 agent」 |

计时规则：

- 运行中：显示 `now − started_at`，`started_at` 取自 `run-status` 的 `running` 响应（三家都会返回）。拿到第一次状态之前，用登记里的 `requested_at`。
- **不能用窗口本地计时器**：关掉再打开 NEXT，时长必须接着算。
- 每秒刷新显示，每 2 秒轮询状态（沿用 idea-spark 的 `POLL_MS = 2000`）。
- 完成后的「用时」：`record.ended_at − record.started_at`，写入 `kickoff.duration_seconds`。

### 4.3 选择 agent

- 复用 `AgentPicker`（新增副本 `plugins-src/next/src/lib/agent-picker/`，并登记进 `scripts/sync-agent-picker.mjs`）。surface 键为 `next.kickoff`，用 `rememberedProvider` 记住选择。
- 第一次点击时弹出列表。之后直接使用记住的 agent，按钮旁边的 `▾` 可以重新选择。
- 列表项：harness 名称、版本、默认模型；`ok === false` 时灰掉并显示 `hint`；有 `warning` 时用警示色显示。
- 列表底部固定显示**本次会读取的数据源**，来自规程 skill 的 `data_sources`（§5.4）。例如「将读取：任务文件、批注笔记、日记、已完成任务（仅本 vault，只读）」。第一期不支持的数据源显示为「未启用」。
- 如果规程 skill 还没在 Vault 里，先弹首次确认（D6）：「将在 vault 添加 `skills/task-kickoff/SKILL.md` 与 `.notemd/agent-tasks/next-task-kickoff/`。agent 只能读取本 vault，不能写入任何文件。」选项为「添加并开始」/「取消」。

### 4.4 结果面板（`KickoffSheet`）

面板从上到下：

1. **标题区**：Task 标题、`✦ <harness> · <模型（如有）> · 用时 m:ss · 生成于 <本地时间>`；过期时显示横幅和「重新生成」按钮。
2. **一句话**：`summary`。
3. **需要你回答**（核心）：每个问题显示
   - 问题文本，以及它决定什么（「决定：下一步」）；
   - 2–4 个单选项，推荐项带「推荐」标签，下方灰字显示 `why`；
   - 「其他」自由输入（`allow_free_text` 为 true 时）；
   - 选项引用了来源时显示来源角标，点击用 `host.editor.open` 打开。
4. **已知背景**：每条 `claim` 带来源角标；`kind: inference` 标注「推断」，`unverified` 标注「来源缺失」。
5. **建议**：下一步、关闭条件、承担表述（如有）、可能的卡点、要等的人。
6. **没查到的**：`gaps`。
7. **操作**：
   - 主按钮「用这些答案安放到现在推进」：先保存答案（§7.3），再打开安放面板（§4.5）。至少答了 1 题才可点。
   - 「只保存答案」；
   - 「重新生成」：重跑，旧答案保留（§7.4）；
   - 「打开文件」：`host.editor.open` 打开结果文件；
   - 「关闭」。

所有 agent 产出的内容都带 `✦` 标识；用户的回答带 `●` 标识（信念 3）。

### 4.5 用答案安放

打开 `PlaceSheet`，`initialRoute = 'commit'`。新增可选属性 `initialCommit?: { commitment?: string; next_action?: string; close_condition?: string }` 和 `extraOptions?: { commitment?: string[]; next_action?: string[]; close_condition?: string[] }`。

字段 F ∈ {`commitment`, `next_action`, `close_condition`} 的预填值，按顺序取第一个非空值：

1. 回答过的、`decides === F` 的问题：自由输入文本，否则取所选选项的 `label`。多个问题决定同一字段时，取问题顺序靠前的那个；
2. `payload.suggestions[F]`；
3. `PlaceSheet` 现有的默认值（Task 标题、`task.done_when`）。

进行中 Task 仍使用同一 UUID 提交 commit 更新，不新增卡片、不增加 WIP 占位。未回答的字段保留当前 commitment / next_action / close_condition，AI 建议只保留为候选；仅明确回答过的字段参与替换。项目与提醒策略保持既有流程。

`extraOptions` 放入 `ChoiceField` 的候选，内容是对应字段问题里没被选中的选项和 `suggestions` 的值，去重后最多 4 个。

WIP 上限、项目标签、提交写账本等逻辑，全部沿用 `PlaceSheet` 现有实现，本设计不改。用户在安放面板点「取消」，答案已经保存，不回滚。

## 5. 任务模板 `next-task-kickoff`

### 5.1 文件清单

NEXT 按「不存在才写」播种（沿用 idea-spark 的 `seedTaskTemplate` 语义：已存在的文件，包括用户改过的，一律不动）：

```text
.notemd/agent-tasks/next-task-kickoff/
├── task.json
├── CLAUDE.md                     # Claude 读取的指令
├── AGENTS.md                     # Codex / DeepSeek 读取的指令；与 CLAUDE.md 逐字节一致
├── policy.json                   # Codex / DeepSeek：只读沙箱
└── .claude/
    ├── settings.json             # Claude：只读权限
    └── settings.scoped.json      # Claude：带 ${NOTE} 的作用域变体
```

`task.json`：

```json
{
  "name": "NEXT kickoff",
  "description": "为一个不知从何开始的 NEXT 任务整理背景，并提出驱动下一步的问题。只读，不写文件。",
  "prompt": "按 CLAUDE.md / AGENTS.md 的协议，为给定 Task 产出 next-kickoff/v1 JSON 作为最终消息。只读 vault，不写任何文件。",
  "max_turns": 40,
  "timeout_seconds": 600
}
```

`policy.json`：

```json
{ "permission_mode": "read-only", "on_permission_request": "reject", "rationale": "开个头只读 vault；结果由 NEXT 校验后落盘" }
```

`.claude/settings.json`（`settings.scoped.json` 在 `allow` 里多一条 `"Read(${NOTE})"`，其余相同）：

```json
{
  "permissions": {
    "allow": [ "Read(${VAULT}/**)", "Glob", "Grep" ],
    "deny": [ "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "WebSearch", "WebFetch" ]
  }
}
```

**MCP 关卡**（必须在实现前核实，见计划 Task 0）：普通 Claude 任务会以 `--setting-sources user,project` 启动（`plugins-src/claude-agent/backend/src/prompt.rs:65`），用户级 MCP 服务器（例如邮件）可能可用。第一期要求运行中**没有任何 MCP 工具可用**。实现时先验证 `settings.json` 的 deny 规则能否覆盖全部 MCP 工具。不能的话，就给 `TaskDef` 增加可选字段 `strict_mcp: true`，由 claude-agent 追加 `--strict-mcp-config` 和空的 MCP 配置。Codex / DeepSeek 也要做同样的核实。**关卡不通过的 harness，不能在本功能的 agent 列表里显示为可用。**

### 5.2 调用参数

```ts
host.agent.run({
  task: 'next-task-kickoff',
  harness,                              // 选中的 provider id；省略则用 host 默认
  note_path: '<vault 绝对路径>/inbox/tasks/<file>-task.md',
  prompt: [
    'schema: next-kickoff/v1',
    'task_path: inbox/tasks/<file>-task.md',   // vault 相对路径
    'task_id: <uuid>',
    'based_on: sha256:<hex>',
    'lane: inbox | wip | waiting | dormant',
    'today: YYYY-MM-DD',                        // 用户本地日期
    'skill: skills/task-kickoff/SKILL.md',
  ].join('\n'),
  notify: {
    title_ok: '开头已就绪 · <Task 标题>',
    title_fail: '开头失败 · <Task 标题>',
    // 不传 open_path / expect_file：结果文件由 NEXT 在对账时写入，运行结束时还不存在（见 Task 0 核实项）
  },
})
```

发起前检查（D5），任一条失败就不调用 `run`，直接提示原因：

1. Task 文件存在，并能解析为合法 Task，`task.id` 与卡片一致；
2. 泳道仍符合 §4.1；
3. 登记里这个 Task 没有进行中的运行（一个 Task 同一时间只能有一次运行）；
4. 选中 provider 正在运行的开头数 < `host.agent.limits` 给出的 `max_concurrency`。只能统计本插件登记的运行，作为近似值；host 仍是最终裁决，`run` 报容量错误时如实显示。

### 5.3 agent 协议（`CLAUDE.md` / `AGENTS.md` 内容要求）

指令文件必须包含以下规则，措辞由实现者撰写，语义不能变：

1. **身份与边界**：以 headless 模式运行，只读 `${VAULT}`；不写、不改、不删任何文件；不调用网络；不执行命令。
2. **先读规程**：读取 `${VAULT}/skills/task-kickoff/SKILL.md`，按它声明的数据源和判断方法工作。只使用 `kind: vault` 的数据源，其他类型一律忽略。SKILL.md 不存在时，只读 Task 文件和它 `sources` 里的文件。
3. **读 Task**：读取 `task_path`，复述其中的 `task_id` 和 `based_on`。
4. **分流**（来自阅读笔记的三个动作）：
   - 背景足以确定下一步时：仍然输出 1 个问题，内容是在 2–3 个**足够小的第一步**里选一个，`decides: next_action`；
   - 缺目标、范围、交付对象时：针对缺的部分提问；
   - 涉及他人时：问用户的意向，不替用户指派。
5. **问题质量**：每个问题必须能被选项回答；最多一个推荐项，并给出 `why`；不问 Vault 里已有答案的事；不问对决定下一步没有影响的事。
6. **下一步**：`suggestions.next_action` 必须是 30 分钟内能开始的具体动作，以动词开头，不能是「研究一下」「想想」这类空泛动作。
7. **证据**：区分 `fact`（有来源）和 `inference`（推断）；不编造来源；找不到就写进 `gaps`。
8. **语言**：跟随 Task 标题和正文的语言。
9. **输出**：最终消息**只有**一个 JSON 对象，符合 §6。不加前后说明文字（允许整体包在一个 ```json 代码块里）。

指令文件第一行固定写版本标记：`<!-- next-task-kickoff template v1 -->`。

### 5.4 规程 skill `skills/task-kickoff/SKILL.md`

NEXT 在首次确认（D6）后播种。播种规则与模板相同：存在就不写，用户改过的内容永远保留。

```markdown
---
name: task-kickoff
description: 为不知从何开始的 NEXT 任务整理背景并提出驱动下一步的问题。只读。
type: Skill
data_sources:
  - id: task
    kind: vault
    label: 任务文件及其 sources
    paths: ["inbox/tasks/*-task.md"]
  - id: marks
    kind: vault
    label: 批注笔记（你的判断）
    paths: ["**/*.note.md"]
  - id: done-tasks
    kind: vault
    label: 同项目的已完成任务与完成笔记
    paths: ["inbox/tasks/*-task.md", "thinking/next.note.md"]
  - id: diary
    kind: vault
    label: 日记与决策记录
    paths: ["diary/**", "dailynote/**"]
---

# 帮我开个头

（判断方法：如何按 task.project / 标题关键词检索相关笔记；优先采信 ● 批注；
时间窗口默认 90 天；同一事实以最新为准；冲突时两条都列出并标为待你判断……）
```

- `data_sources[].kind` 第一期只接受 `vault`。NEXT 在 agent 列表里展示时，其他 `kind` 显示为「未启用」。
- `type: Skill` 必须先在 `CONCEPT_TYPE` 登记，origin 档位为 `human`：规程是用户确认过的工作方式。如果仓库里已经有 skill 的类型登记，就复用已有的值，不新增。实现时先用 grep 确认。
- `data_sources` 解析失败时，按「只有 `task`」处理，并在列表底部显示「规程无法解析，仅读取任务文件」。

## 6. 输出协议 `next-kickoff/v1`

### 6.1 结构

```jsonc
{
  "schema": "next-kickoff/v1",
  "task_id": "8afad9c5-…",                 // 必须等于发起时的 task_id
  "based_on": "sha256:…",                  // 必须等于发起时的 based_on
  "summary": "一句话：这件事要什么、给谁",
  "questions": [{
    "id": "q1",
    "text": "这次交付给谁评审？",
    "decides": "close_condition",          // commitment | next_action | close_condition | owner | scope | other
    "options": [
      { "id": "a", "label": "只自己验证", "recommended": false, "why": "", "source_ids": [] },
      { "id": "b", "label": "交给 XX 评审", "recommended": true, "why": "10/12 讨论里 XX 要求过", "source_ids": ["s2"] }
    ],
    "allow_free_text": true
  }],
  "context": [
    { "claim": "上次卡在签名环境变量", "kind": "fact", "source_ids": ["s1"] }
  ],
  "suggestions": {
    "commitment": "提交 TestFlight 构建",   // 可选
    "next_action": "打开 release.sh，确认 APPLE_ID 变量是否已设置",
    "close_condition": "构建出现在 TestFlight 并完成安装验证",
    "blockers": ["…"],
    "waiting_for": ["…"]
  },
  "gaps": ["没找到上次失败的完整日志"],
  "sources": [
    { "id": "s1", "resource": "diary/2026-10-20.note.md", "title": "10/20 日记", "locator": "## 发布" }
  ]
}
```

### 6.2 校验规则（NEXT 侧，`kickoff-payload.ts`，纯函数）

**解析**：取 `terminal_result.content`，去掉首尾空白；如果整体被唯一一个 ```json … ``` 代码块包住，就去掉围栏；然后 `JSON.parse`。原始文本超过 64 KiB 直接拒收。

**拒收**（整份作废，状态记为 `failed: invalid-output`，附第一条错误）：

| 规则 |
|---|
| `schema !== 'next-kickoff/v1'` |
| `task_id` 或 `based_on` 与登记的发起值不一致 |
| `summary` 为空，或超过 200 字符 |
| `questions` 不是 1–3 个；`id` 不唯一，或不符合 `^q[1-3]$` |
| 某个问题的 `text` 为空或超过 200 字符；`decides` 不在枚举里；`options` 不是 2–4 个；选项 `id` 在本题内不唯一，或不符合 `^[a-d]$`；`label` 为空或超过 120 字符；`why` 超过 300 字符；`recommended === true` 的选项超过 1 个 |
| `suggestions.next_action` 或 `suggestions.close_condition` 为空，或超过 200 字符；`commitment` 超过 120 字符 |
| `context` 超过 8 条；`claim` 为空或超过 300 字符；`kind` 不在 `fact` / `inference` 里 |
| `blockers`、`waiting_for`、`gaps` 各超过 5 条，或单条超过 200 字符 |
| `sources` 超过 12 条；`id` 不唯一，或不符合 `^s\d{1,2}$` |

字符数一律按 Unicode code point 计算。

**修正**（不拒收，但会改动载荷并留下标记）：

- `sources[].resource` 必须是 Vault 相对路径：不以 `/` 开头，不含 `..` 段，不含 `\0`，`host.vault.exists` 为真。不满足的来源整条删除，所有 `source_ids` 里对它的引用一并删除。
- 引用了不存在的 `source_id`：删除该引用。
- `kind: fact` 的条目在上述删除后一个来源都不剩：改为 `kind: inference`，并加 `unverified: true`。
- 未知键：删除，不写进文件。
- `why` 缺失按空字符串处理；`allow_free_text` 缺失按 `true` 处理；`recommended` 缺失按 `false` 处理。

校验器返回 `{ ok: true, payload, repairs: string[] } | { ok: false, error: string }`。`repairs` 写入结果文件的 `kickoff.repairs`。

## 7. 结果文件

### 7.1 路径

`inbox/tasks/<Task 文件名去掉 .md 后缀>.kickoff.md`，例如 `inbox/tasks/2026-09-01-1120-submit-testflight-task.md` → `inbox/tasks/2026-09-01-1120-submit-testflight-task.kickoff.md`。

一个 Task 只对应一个结果文件。结果文件与 Task 通过 `kickoff.task_id` 关联，路径只是约定。如果 Task 被重命名，NEXT 按 `task_id` 扫描 `inbox/tasks/*.kickoff.md` 找回结果；找到后**不自动移动**文件。

### 7.2 格式

```markdown
---
type: Task Kickoff
title: 开个头：提交 TestFlight 构建
description: <summary>
generated:
  by: process:claude-agent          # process:<record.harness 去掉 "notemd." 前缀>；record.harness 缺失时用选中的 provider id
  at: 2026-10-27T13:05:00Z          # record.ended_at
sources:
  - resource: inbox/tasks/2026-09-01-1120-submit-testflight-task.md
  - resource: diary/2026-10-20.note.md      # payload.sources 依次追加
kickoff:
  version: 1
  schema: next-kickoff/v1
  task_id: 8afad9c5-…
  based_on: sha256:…
  harness: notemd.claude-agent
  run_id: …
  duration_seconds: 245
  rendered: sha256:…                 # 正文渲染结果的哈希，用于 §7.3 的防覆盖判断
  repairs: []
  payload: { … }                     # 校验后的完整载荷，机器读取的唯一事实源
  answers: []                        # §7.3
  prior_answers: []                  # §7.4
---

# ✦ 开个头：提交 TestFlight 构建

（由 payload 和 answers 确定性渲染的可读正文：一句话 / 需要你回答（已答的标 ●）/
已知背景（来源链接）/ 建议 / 没查到的）
```

- 写入必须经过 `src/lib/okf/concept.ts` 的生产入口，`type` 用新登记的 `CONCEPT_TYPE.taskKickoff = 'Task Kickoff'`。插件侧按 `docs/plugin-v2-development.md` §9.1 的方式落实，参考 NEXT 现有的 Task 写入点。
- `searchidx/src/origin.rs` 的 `mapped_type_origin` 把 `Task Kickoff` 映射到与 `Idea Proof` 相同的派生档（derived），并运行 `pnpm gen:origin-types`。
- 正文渲染是 `(payload, answers) → markdown` 的纯函数，输出必须稳定（同样的输入得到逐字节相同的输出），便于测试和 diff。
- 首次写入使用 no-clobber 语义：先检查文件不存在再写；如果已存在，按 §7.4 的重跑处理。

### 7.3 保存答案

`answers` 每条：

```yaml
- question_id: q1
  question: 这次交付给谁评审？      # 复制问题文本，让答案脱离 payload 也能读懂
  decides: close_condition
  option_id: b                     # 用自由输入时为 null
  answer: 交给 XX 评审              # 选项 label，或自由输入文本
  by: human:<owner id>
  at: 2026-10-27T13:10:00Z
```

- 每个问题最多一条；再次保存会覆盖这一题的旧答案，`at` 更新为新时间。
- `by` 的 owner id 解析顺序：(1) Vault 根目录 `/USER.md` frontmatter 里的 owner 标识（字段名以计划 Task 0 的核实结果为准）；(2) 拿不到时用 `human:owner`。**绝对不能**写成非 `human:` 前缀。
- 写入流程：读取当前文件 → 校验 `kickoff.task_id` 一致 → 计算当前正文的哈希：
  - 等于 `kickoff.rendered`：更新 `answers`，重新渲染正文，更新 `rendered`；
  - 不等于（说明用户手动改过正文）：**只更新 frontmatter 的 `answers`，正文不动**，并提示「正文有手动修改，未重新渲染」。
- 写入后回读校验；失败就提示错误，不打开安放面板。

### 7.4 重新生成

- 新运行成功后，整份重写结果文件。旧文件里的 `answers` 追加到新文件的 `prior_answers`（每条保留原样，再加上 `run_id`），旧文件已有的 `prior_answers` 原样带入。**人的回答永远不会因为重跑而丢失。**
- 新运行失败时，旧结果文件保持不变；按钮显示失败状态，点击失败详情仍可以「查看上次的开头」。
- 第一期不把旧答案作为新运行的输入（那是第二期的「带着答案再跑一轮」）。

## 8. 运行登记 `.notemd/next-kickoff.json`

```jsonc
{
  "version": 1,
  "runs": {                                   // 键：task_id；只保存进行中或失败的运行
    "8afad9c5-…": {
      "run_id": "…",
      "harness": "notemd.claude-agent",
      "requested_at": "2026-10-27T13:01:00Z",
      "task_path": "inbox/tasks/…-task.md",
      "based_on": "sha256:…",
      "state": "running",                     // running | failed
      "failure": null                         // { kind, message, at }，见 §9.3
    }
  },
  "unread": ["8afad9c5-…"]                    // 有新结果、尚未查看的 task_id
}
```

- 解析必须是全函数：文件损坏或缺失时回退到空登记，不让窗口崩溃（参照 idea-spark 的 `state-io.ts`）。
- 每次修改：读取 → 合并 → 写入 → 回读。NEXT 只有一个窗口，同一台设备上没有并发写入方；跨设备同步造成的冲突不在本设计范围内。
- 先拿到 `run_id` 并写入登记，再开始轮询。`run_id` 缺失或为空时视为启动失败（照搬 idea-spark 的规则）。

## 9. 运行生命周期与对账

### 9.1 对账时机

1. NEXT 窗口打开时，对登记里所有 `running` 状态的运行各查询一次状态；
2. 窗口打开期间，对每个 `running` 状态的运行每 2 秒轮询一次；
3. 窗口关闭后停止轮询，运行本身不受影响。完成时由 agent 插件发托盘提醒；下次打开窗口时对账（第 1 条）。

### 9.2 状态解释（扩展 idea-spark 的 `interpretStatus`）

| `run-status` 返回 | 处理 |
|---|---|
| `state: running` | 更新 `started_at`、`steps`、`last`，继续轮询 |
| `state: done`，`record.status === 'success'`，有 `terminal_result.content` | 按 §6.2 校验 → 写结果文件（§7）→ 从 `runs` 删除 → 加入 `unread` → 应用内提示「开头已就绪」 |
| `state: done`，成功但 `terminal_result` 为 null | `failed: missing-result`（结果超过 1 MiB，或持久化失败） |
| `state: done`，`record.status` 为 `skipped` / `error` / `timeout` / `cancelled` | `failed: <status>`，消息取 `record.stderr_tail`，为空时取 `result` |
| 其他形态，或长时间没有响应 | `failed: lost` |

### 9.3 失败类型与文案

| `failure.kind` | 用户看到的原因 | 提供的操作 |
|---|---|---|
| `agent-missing` | 没有可用的 agent 插件 | 打开插件市场的指引 |
| `start-error` | 启动失败：<message> | 重试 / 换个 agent |
| `timeout` | 超过 10 分钟仍未完成 | 重试 |
| `error` / `cancelled` / `skipped` | <stderr_tail 前 300 字> | 重试 / 换个 agent |
| `lost` | 运行中断，没有留下结果 | 重试 |
| `missing-result` | agent 完成了，但结果过大或没有保存 | 重试 |
| `invalid-output` | agent 的输出不符合格式：<第一条错误> | 重试 / 换个 agent / 查看原始输出（前 2 KiB） |
| `task-changed` | 任务在运行期间被删除，或换了身份 | — |

harness 的 `warning`（凭据过期、限流等）如果存在，附在原因下方。

### 9.4 取消

第一期不提供取消。进度弹层写明：「运行最长 10 分钟，暂不支持中途停止」。第二期需要 host 新增 `host.agent.cancel`，映射到各 provider 的取消命令（`RunRecord.status` 已有 `Cancelled`）。

## 10. 安全与信任边界（验收必查）

1. agent 运行在只读环境：不能写文件，不能执行命令，不能联网，不能使用 MCP（§5.1 关卡）。
2. 进入 Vault 的只有 NEXT 校验过的载荷；写入位置固定为 `inbox/tasks/*.kickoff.md`，以及首次确认后播种的模板和 skill。
3. NEXT 不因开头功能修改 Task 文件、不写账本、不改提醒。commit 只来自用户在安放面板的提交。
4. 人的回答以 `human:` 署名，重跑不会丢失。
5. 规程（skill、模板）只在不存在时播种，从不覆盖用户的修改；第一次播种需要人确认。
6. agent 列表显示数据源，让用户知道哪些内容会发给模型提供方。

## 11. 第二期（本期不实现，只记录接口预留）

- `host.agent.cancel` 和取消按钮；
- 「带着答案再跑一轮」：把 `answers` 和 `prior_answers` 作为输入；
- 非 Vault 数据源（邮件、Slack、Notion、网页）：skill 声明后，需要人确认扩权才启用，按连接分别授权；
- 晨间批量提议：为卡住超过 N 天的 Task 提议开头，只提议，不自动运行；
- 结果过期后自动提示重跑。

## 12. 国际化与可访问性

- 所有新文案加入 `plugins-src/next/src/lib/strings.ts` 的 en / zh / ja / de 四套，`strings.test.ts` 的键一致性检查必须通过。
- 计时文本放在 `aria-live="off"` 的区域，避免读屏器每秒播报；状态切换（开始、完成、失败）用一次 `polite` 播报。
- 按钮、单选项、来源角标都能用键盘操作，焦点顺序与视觉顺序一致。

## 13. 验收标准

1. 收件箱、进行中、等待、稍后泳道的 Task 卡片显示按钮；已完成、Idea、修复区的卡片不显示；老 host 不显示按钮也不报错。
2. 首次使用弹出规程确认；确认后模板和 skill 落盘；再次播种不覆盖用户修改（测试：先修改文件，再触发播种，内容保持不变）。
3. 运行中按钮显示的时长，在窗口关闭再打开后接着计算；悬浮提示显示步数和最后动作。
4. 用 stub 的 `host.agent.status` 返回合法载荷时，生成的结果文件通过 `pnpm okf:lint inbox/tasks`；`type: Task Kickoff`；正文渲染稳定。
5. §6.2 的每条拒收规则和每种修正都有单元测试。
6. 结果文件存在时，NEXT 的 Task 列表数量不变；task CLI 的 `list` 不把它当作任务。
7. 回答 → 保存：`answers` 署名为 `human:`；正文被手动改过时不重新渲染；重跑后旧答案出现在 `prior_answers` 里。
8. 「用这些答案安放」打开的安放面板按 §4.5 规则预填；提交后账本里的 `commit` 事件与面板内容一致；取消提交时答案仍然保留。
9. §9.3 的每种失败类型都能用 stub 复现，并显示对应文案。
10. 只读关卡：每个被允许的 harness 都有一次真实运行的记录，证明写文件、执行命令、MCP 工具都被拒绝。没有证据的 harness 在本功能里标为不可用（见计划 Task 0、Task 8）。
11. `pnpm --dir plugins-src/next test`、`check`、`build`，`concept-origin-sync` 测试，以及 searchidx 的 origin 测试全部通过。
12. CHANGELOG 中英两份的「未发布」区各加一条面向用户的条目。
