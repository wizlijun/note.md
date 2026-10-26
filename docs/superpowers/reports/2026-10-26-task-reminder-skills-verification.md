# 任务与提醒 skills 的操作与验收

2026-10-26：已实现统一任务 CLI、任务提醒偏好操作、一次性定时规则与回执，并更新 sotvault 的 3 个核心 skills、关联入口及两仓库 AGENTS。未操作正式任务，未发送真实消息，未发布插件或部署远程运行器。

## Agent 执行逻辑

1. 识别任务操作或提醒操作，读取对应 skill 与规则。
2. 按 UUID、来源和义务定位原卡；跨 skill、跨日期查重。
3. 后台提取只能新增。用户明确指令允许经统一入口更新内容或 NEXT 状态。
4. 内容更新保留 UUID、created 与正文；状态更新使用 NEXT 事件。完成、停止、转移分别保存，不要求额外详情。
5. 静音与暂停只改提醒偏好；完成会过滤后续推送；重开不解除静音或旧关闭记录。
6. 一次性规则绑定 Task 与当前 generation。到期前不发送、过期不补发，重开不复活旧规则。
7. 每次发送前重读状态；外部成功回读后才记录 sent；状态竞争时生成撤回补偿。

详细执行规范在 sotvault `agent-rules/task-reminder-operations.md`；根 `AGENTS.md` 已加入路由和硬性边界。企业微信待办 skills 限定明确企业微信上下文，避免拦截普通 NEXT 请求。日报、周复盘和统计入口已同步调整。

## 验收证据

| 检查 | 结果 |
|---|---|
| NEXT 源码回归 | 24 文件、426 项通过 |
| 分发 CLI 真实子进程 E2E | 1 项完整链路通过 |
| 推送与一次性提醒 Python | 49 + 20 项通过 |
| 统一协议正反例 | 69 项通过 |
| 独立按 skills 操作 | 20 项通过 |
| svelte-check / 前端构建 | 0 错误、0 警告 / 成功 |
| 文档 | YAML、JSON 示例、来源引用、空行检查通过 |

独立操作首轮发现“无 due 的任务首次添加 due”因 YAML 新字段未加引号而失败。修复 CLI 和共享 UI 编辑路径，增加无期限起始的源码回归及真实 bundle E2E，再使用 Vault 内分发路径完整重跑通过。保留 UUID、创建时间、正文、来源及陈旧 revision 拒绝覆盖均已验证。

通用 skill validator 不支持 Vault 强制使用的 OKF 扩展键，3 个核心技能因 type/title/tags/generated/sources 被其拒绝；未删除这些元数据来规避检查。另用 YAML、必填字段、来源引用和示例检查验证；企业微信 3 个局部更新的技能通过通用 validator。

## 分发证据

Vault 自动同步提交 `62f77b998f2f24c2facc29b584560941d0d15c10` 中，25 个本次文件已逐字节核对。CLI 源码及产物使用构建 manifest 校验，4 个分发文件与 mdeditor `dist-cli/` 完全一致。

`next-task-cli.mjs` SHA256：`3f4b0a5cc3ae5ed3eb0c40e61c0da0485c630c668e4616c2dd5bce19579c23ed`。

构建与重跑：`pnpm --dir plugins-src/next test:cli`。Node 最低版本为 20；yaml 依赖已打包，随附项目与第三方许可证。构建 manifest 记录源文件哈希，不能手改分发 bundle。

本地完整证据位于忽略目录 `tasks/task-reminder-skills-20261026/`：`forward-test.json` 保留首轮失败及最终复验，`source-evidence.json` 记录 Vault 文件、构建源码与产物哈希。

## 未部署与实现边界

当前仅有规则、候选、预检和回执入口，没有驻留计时器或新增网络发送器。既有远程 cron 仍为每日 09:00、14:00；仓库 Prompt 已更新，但远程部署未核验。规则保存不等于准点投递已启用。

NEXT 铃铛的任务级设置会影响新规则；逐条定时规则通过 reminder skill 查看或取消，尚未在 NEXT 详情列出。未实现重复规则、完整 Delivery 状态机、Google/Apple 双向同步。

本地锁只协调对应 CLI，宿主没有跨 UI/设备原子 CAS。冲突检测与写后回读不等于跨设备事务。所有行为验收使用临时 Vault 和明确标注的合成 owner/provider，不能据此声称真实渠道已送达或已撤屏。
