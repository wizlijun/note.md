# Task 与 Reminder 的 agent 操作共用 NEXT 数据

## 目标与权限

用户在 2026-10-26 授权统一任务、提醒 skills 与 agent 规则。自然语言指令与 NEXT 操作应产生兼容的数据；不要求用户填写完整表单。

后台摘要/周复盘只可提取 owner 明确承担的新任务。用户明确要求修改既有任务时，agent 可经校验入口更新内容或追加 NEXT 事件。禁止直接拼接 Task YAML、手改 NEXT 账本、删除任务或根据推断自动重开。此次开发不操作正式任务或真实外部消息。

## 操作契约

- Task 是唯一任务身份。创建先读 owner authority、检查 UUID 与逻辑义务去重。修改保持 UUID/created，不因改标题、改期限生成第二张卡。
- 生命周期使用既有 NEXT 事件工厂、校验器和序列化器。快捷状态不编造日期或理由。只有 explicit reopen 可以重开已结束任务。
- 任务内容、任务状态、提醒策略分开更新。完成/停止/转移会阻止提醒；关闭提醒不改变任务状态；重开不自动解除静音或旧关闭记录。
- 提醒偏好继续使用 `stat/task-reminders/<UUID>.json`。暂停到期只恢复候选资格，不构成定时投递。
- 一次性定时提醒使用独立规则与投递记录，绑定 Task UUID。候选计算与发送前复核共用最新 NEXT、提醒偏好和旧关闭账本。主动推荐窗口不得屏蔽用户明确指定的定时提醒。
- 写入必须校验目标身份、预期版本/原内容，保存后回读。重复操作去重；旧快照不得覆盖新内容。当前宿主没有跨设备原子 CAS，不承诺跨设备事务或 exactly-once 投递。

## 交付结构

NEXT 仓库维护可复用的 TS 操作逻辑与可分发 Node CLI。Vault 的 `task-management` 调用该入口，不要求完整 mdeditor checkout。`reminder-management` 负责设置，不调用网络。`proactive-reminder-push` 负责候选、预检及授权渠道的投递/撤回。

Vault 根 AGENTS 保留短路由和硬性边界；`agent-rules/inbox-task.md` 维护创建规范；`agent-rules/task-reminder-operations.md` 维护意图、状态、提醒与失败处理。skills 只记录实际可执行命令。更新周复盘及既有 cron 对这些规则的引用，避免旧 create-only 条款与显式修改冲突。

## 验收

1. 在临时 Vault 创建任务、重复请求、修改期限、切换状态、重开；生产 NEXT reader 能读取，既有正文与身份保持。
2. 已完成任务不再推送；静音不改变任务；暂停到期恢复资格；重开仍尊重静音与旧关闭记录。
3. 定时规则在到期前不投递，到期后通过预检；同一投递重复执行不产生多个消息身份。实际发送与回执不能由“算出候选”冒充。
4. 源码与分发 CLI 字节可核验；技能命令在隔离环境运行；独立 agent 按文档执行典型请求。
5. 相关 TS/Python 回归、类型检查、构建与技能 frontmatter/引用检查通过。记录远程 runner 未部署、真实网络未调用与插件未发布边界。

## 实现入口与边界

`plugins-src/next/scripts/task-api.ts` 提供 JSON 操作，`task-cli.ts` 提供 Node 20+ 入口。`pnpm --dir plugins-src/next build:cli` 产出自包含的 `dist-cli/next-task-cli.mjs`、源码/产物哈希 manifest 和许可证；这四个文件一起分发至 Vault `skills/task-management/scripts/`。read/list 不写账本。update 使用共享 YAML 文档编辑并保留正文；transition 使用共享事件工厂和账本写入；reminder 使用共享提醒偏好实现。

Vault `skills/reminder-management/scripts/scheduled_reminders.py` 提供 schedule/list/cancel/due/preflight/receipt。规则存于 `stat/scheduled-reminders/<Reminder UUID>.json`：version、task_id、occurrence(single+generation)、reminder(absolute trigger+cube)、endpoint_id、expires_at、created_at、updated_at，成功后追加 delivery(sent)。这是一份严格验证的运行时 profile，不是完整协议交换快照。

新规则只允许未来时间，重试沿用 Reminder UUID。到期窗口是 `[trigger, expires)`；任务重开使旧 generation 规则失效。投递身份按协议计算 SHA256，屏幕 ID 固定为 `xiaobu-reminder-<hash>`。预检从规则与当前 Task 回源；回执必须来自外部成功消息回读。已发送规则不重复发送，但消息继续展示直至取消、结束、静音、暂停或过期。发送途中状态变化时返回撤回补偿要求。

没有驻留计时服务或网络发送器。仓库 cron 仍为每日 09:00/14:00，Prompt 已接入上述候选与回执流程，但远程部署未验证。不能将“规则保存成功”表述为准点投递已启用。新规则未在 NEXT 详情里列出；任务级铃铛设置仍能控制这些规则的资格，逐条查看/取消通过 reminder skill 完成。
