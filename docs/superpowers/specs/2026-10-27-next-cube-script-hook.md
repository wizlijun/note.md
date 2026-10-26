# NEXT 状态保存后直接执行 Cube 同步脚本

用户要求：skills 维护固定脚本，NEXT 设置选择该脚本，完成后直接执行。定时任务、agent 和人工终端共用入口。执行不调用 agent 或模型，不消耗模型 token。

## 执行契约

- 宿主提供 `host.taskHook.get/select/clear/run`，仅允许 `notemd.next` 与 `task.hook` 能力。原生文件选择器选择当前 Vault `skills/` 内的 Python 文件；配置绑定本机 canonical Vault，存于宿主私有配置，普通插件设置不能授予执行权限。
- NEXT 在 Task 生命周期、提醒偏好、规划元数据保存成功后调用。Idea、保存失败和未配置场景不执行。完成礼花和状态保存不等待外部网络；执行失败单独显示待同步与重试，不回滚任务或重新追加完成事件。
- 宿主固定执行 `python3 <选定脚本> --vault <当前Vault> --task-id <UUID> --apply`。使用 argv，不拼 shell 字符串；不接收调用者的任意命令、Vault 或参数。宿主 30 秒超时，脚本网络总预算 25 秒、输出限长、丢弃 stderr，返回白名单结果。
- 成功输出 `{ok:true,status:"synced",created:0,updated:0,deleted:1}`。未完成返回 `pending`；脚本退出、超时或不可用不冒充同步成功。可读统计不等于用户已读回执。
- 配置区独立保存，选择/停用立即生效，不受普通设置页保存或取消按钮控制。旧宿主显示不支持执行，基础任务功能继续可用。

## 技能脚本

入口：`skills/proactive-reminder-push/scripts/sync_task_reminders.py`。NEXT 传 Task UUID；定时任务或人工省略 `--task-id` 扫描全库。无 `--apply` 时仅生成计划，可通过 `--messages-json` 提供渠道快照；实际同步读取本机 `~/.config/desk-display/env` 的 Cube URL 与 token。

每次运行重新读取 Task 文件、NEXT 生命周期、提醒偏好、旧关闭记录及定时规则，确定性生成消息文案并检查资格。新消息必须有有效定时规则；无规则任务不会自动生成提醒。旧 `xiaobu-task-<UUID>` 消息可按当前内容更新或撤下。任务结束、静音、暂停、规则取消/过期或旧 generation 消息撤下。新建最多 3 条、bot 总数不超过 6 条；人工或无法关联的消息保留。

Cube 真实契约来自 `HoloCubic/server/display_server.py`：GET `/v1/messages`，POST 同路径以 ID 覆盖，DELETE `/v1/messages/<id>`；Bearer 认证。Bot 不能 PUT；消息 ID 上限 64 字符。完整 Delivery SHA256 保留，Cube 的新 ID 使用 `xiaobu-reminder-` 加完整摘要的无填充 base64url，兼容识别旧长 ID。回读成功后才记真实发送回执，发送期间状态改变需要撤回补偿。

Cube bot 查询隐藏人工消息，旧 POST 满屏会挤掉旧 bot。为避免隐式删除无关消息，服务增加 GET `capabilities.safe_create:true` 和 POST `safe_create:true`：同锁内新建满容量返回 409，已有 ID 可更新；旧调用未指定时保持原有行为。脚本所有 POST 都要求该能力，否则只执行查询/撤回并返回待同步。必须部署新版 Cube 服务后才能完整创建/更新。

脚本使用本机执行锁、发送前复核、固定身份和有界网络操作。未完成操作可重跑，重跑先读取真实渠道状态；不能因回执失败重新生成消息身份。不得把 shell env 文件当脚本 source，不输出凭据或原始消息正文。

本机锁使用系统 advisory lock，进程退出自动释放；Windows 分支有实现但本轮无 Windows 实机验收。规则内容仍无跨设备 CAS。

## 多设备与交付边界

每台设备先同步 Vault 并配置自身凭据。执行脚本不会自动 git pull，也不能证明远端状态已经到达。Cube 当前没有 CAS、revision 或删除墓碑，客户端锁只约束本机，不能保证旧设备不恢复已撤下消息。严格跨设备一致性需后续服务端版本保护或统一权威执行端，本次不声称已实现。

NEXT 按钮要使用新的宿主 API；单独发布插件不能让旧宿主执行脚本。skills 指令不是常驻监听器，直接手改文件不会自动触发。此轮不部署远程定时任务、不修改真实 Task、不真实推送或撤回。

## 验证

验证配置选择/停用与旧宿主降级、保存成功后调用、保存失败不调用、Idea 不调用、执行失败不回滚、重试不重复完成、并发操作顺序。脚本使用隔离 Vault 和假 Cube 验证创建/更新/删除、暂停/静音/重开、稳定 ID、容量、重复执行、权限与失败回读。宿主验证权限绑定、路径约束、argv、超时和输出白名单。真实渠道部署与安装验收独立记录。
