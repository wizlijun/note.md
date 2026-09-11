# Assistant Mail 接管插件技术设计

日期：2026-09-11

状态：设计冻结；工程 MVP 实施中

需求基线：[助理邮箱接管插件需求规格](../../2026-09-11-assistant-mail-intake-plugin-requirements.md)

## 1. 结论

Assistant Mail 与现有 Share 放在同一个代码仓库，但部署为两个独立 Cloudflare Worker：

- `mdeditor-share` 继续承载公开分享；
- `notemd-assistant-mail` 独立接收邮件并提供私有读取、清理和删除 API；
- 两者不共享路由、访问 key、Cloudflare bindings、数据、发布或回滚单元；
- note.md 的 `notemd.assistant-mail` 原生插件像 CLI 同步器一样拉取邮件，在插件私有目录保存原件与结构化归档；
- 受支持的 Agent 只通过插件的脱敏查询面读取事件，该接口不返回原始 MIME 或 access key；同用户直接文件访问属于后述已知降级边界；
- `assistant-mail-daily` Skill 可以由用户另行配置的每日任务调用，向 `diary/` 写独立 sidecar，但本项目不擅自注册任务；
- 删除使用 `plan → 用户确认 → execute`，Agent 可以发起精确计划，不能直接执行删除。

## 2. 已纳入需求基线的范围修订

以下两点是用户在技术设计讨论中作出的产品范围修订，现已写入需求基线；实现和验收不得再按旧范围解释：

### 2.1 来源范围修订

本版保留不可关闭的收件地址门禁，并由用户控制 sender filter：

```text
envelope.to   == ASSISTANT_MAIL_ADDRESS
AND (
  policy.sender_filter_enabled == false
  OR envelope.from == policy.allowed_sender
)
```

首次配置转发时，用户可在可信插件窗口打开最长一小时的 setup window，使 Gmail 等供应商的系统验证邮件能够进入；界面必须显著标识此时所有 envelope sender 都可投递，服务端到期自动恢复严格过滤。验证完成后，用户设置唯一 sender 并主动开启严格过滤。严格模式比较规范化后的 SMTP envelope sender，不使用可伪造的 `From` 显示名或内层转发正文；此比较只是收件范围过滤，不单独构成发送方身份的密码学证明。

### 2.2 Agent 删除权限修订

Agent 默认只读，可以创建精确删除计划；只有用户在可信插件设置窗口查看完整影响、输入 `DELETE` 并确认相同 `plan_hash` 后，插件才可执行。Agent 仍不得直接调用 execute、扩大计划目标、缩短恢复期或删除审计记录。

## 3. 范围与边界

### 3.1 本系统负责

- Cloudflare Email Routing 收信、envelope 准入、原始 MIME 持久化及变更游标；
- 插件增量同步、安全解析、脱敏、事件化、本地私有归档和查询；
- 唯一 Worker access key 的设置、验证、轮换和撤销；
- 可预演、可审计、失败时保持不可读的删除流程；
- 每天 0–3 条决定或行程要点的 sidecar 生成契约。

### 3.2 明确不负责

- 发信、回复、付款、登录、签署、改签、取消、打开邮件链接或写入日历/任务；
- 搜索私人或工作主邮箱；
- 用转发渠道认证替代内层发送方认证；
- 提供普通收件箱 UI；
- 把 Worker Queue 当作本地客户端可拉取队列；
- 自动注册系统定时任务。

## 4. 总体架构

```text
业务通知
   │ 用户在 Gmail 人工/白名单规则转发
   ▼
Cloudflare Email Routing
   │ envelope.from/to 精确准入
   ▼
notemd-assistant-mail Worker
   ├── private R2 MAIL_RAW：原始 MIME
   ├── D1 MAIL_DB：状态、元数据、游标、计划、审计
   └── Queue MAIL_QUEUE：异步晋级/重试（仅 Worker 内部）
            │ HTTPS + 唯一 Bearer key
            ▼
notemd.assistant-mail 原生插件
   ├── Vault `.notemd/assistant-mail/.local/`：access key
   ├── 私有 raw/source/cursor/tombstone 归档
   ├── 安全解析、事件化、脱敏
   └── mail-query：Agent 最小披露面
            │ 脱敏 JSON
            ▼
assistant-mail-daily Skill
   └── vault/diary/YYYY-MM-DD-assistant-mail.md
```

Worker 是互联网边界和权威原件库；插件是单用户本地处理与查询边界；Skill 只负责决定上下文，不参与收信、认证、删除或外部行动。

## 5. 同仓库、独立部署

目标目录：

```text
worker/                       # 现有 mdeditor-share
assistant-mail-worker/        # 新 notemd-assistant-mail
plugins-src/assistant-mail/    # 新 notemd.assistant-mail 原生插件
skills/assistant-mail-daily/   # 每日分析 Skill
```

强制隔离：

- 独立 `wrangler.toml`、Worker 名称、route/custom domain、环境、日志和部署命令；
- Assistant Mail 独享 `MAIL_DB`、`MAIL_RAW`、`MAIL_QUEUE` 和 `ASSISTANT_MAIL_ACCESS_KEY`；
- Share Worker 不绑定 Mail 的 D1/R2/Queue；Mail Worker 不读取 Share KV/R2；
- 不复用 `SHARE_API_KEY`，任一 Worker 的发布和回滚不触发另一方；
- 可以共享无状态、无业务 secret 的类型、错误码和测试工具；MVP 不为共享而提前抽包。

Cloudflare Worker 可以同时导出 `email`、`fetch`、`queue` 和 `scheduled` handler；这些 handler 属于同一个 Mail 安全域，因此保留在一个 Mail Worker 内。Share 的公开 fetch 安全域与之分开。

## 6. 收信与准入

### 6.1 Email Routing

Email Routing 只把一个专用地址路由给 Mail Worker。Worker 配置：

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `ASSISTANT_MAIL_ADDRESS` | var | 唯一助理收件地址 |
| `ALLOWED_FORWARDER` | var | 尚未持久化 policy 时显示的 sender 建议值 |
| `ASSISTANT_MAIL_ACCESS_KEY` | secret | HTTPS API 的唯一长期 key |
| `MAIL_RAW` | private R2 | 原始 MIME |
| `MAIL_DB` | D1 | 元数据与权威状态 |
| `MAIL_QUEUE` | Queue | 晋级与可重试后台工作 |

`intake_policy` 以 D1 singleton 保存 `sender_filter_enabled`、`allowed_sender`、`setup_expires_at` 与更新时间；插件通过鉴权 API 读写。迁移默认保持严格过滤，并从 Worker 配置取得初始 sender；用户显式关闭时仅开放一小时，收件地址门禁不受该开关影响。开启严格模式时必须同时提交合法的唯一 sender。

### 6.2 拒绝必须先于持久化

`email(message)` 的顺序固定：

1. 规范化并精确比较不可关闭的 `message.to`，再读取 D1 intake policy；
2. recipient 不匹配，或严格模式下 `message.from` 不匹配时立即 `setReject`，不得读取 `message.raw`、写 R2、写可搜索 D1、发 Queue 或生成事件；
3. 只允许记录不含地址、主题、正文和 Message-ID 的聚合拒绝计数；
4. 匹配后才在 `MAX_RAW_BYTES` 上限内有界读取并保存原始 MIME，禁止加载远程资源或执行附件；
5. 写入 D1 `received_pending` 记录并投递内部 Queue。

Header `From`、`Reply-To`、内层转发发件人及 DKIM/SPF/DMARC 结果只用于后续来源可信度判断，不能替代 envelope 门禁。

## 7. 云端存储与状态机

### 7.1 R2 与 D1

R2 key 使用内部随机 `source_id`，不使用邮箱、主题或 Message-ID 作为路径：

```text
staging/<source_id>.eml
raw/<source_id>.eml
```

D1 至少包含：

- `deliveries`：每次 SMTP 投递和处理尝试；
- `sources`：去重后的逻辑来源、R2 key、hash、大小和处理状态；
- `changes`：单调递增 `change_seq` 与 tombstone；
- `deletion_plans` / `deletion_jobs`：冻结目标、hash、状态和错误；
- `access_audit`：调用方、范围、时间、结果，不含秘密正文；
- `rejection_counters`：不含来源身份的聚合计数。

原始 MIME 写入 R2 staging 成功后才建立 D1 pending；异步处理验证大小和 SHA-256 后将对象晋级为 `raw/` 并把来源置为 `ready`。R2 与 D1 没有跨产品事务，因此 `scheduled()` 必须回收超时 staging、补投 Queue、完成卡住的删除，并报告覆盖缺口。

### 7.2 状态

```text
received_pending → ready
received_pending → processing_failed
ready → deleting → deleted
deleting → deletion_failed → deleting（重试）
```

`quarantined`、`rejected`、`parsed_no_event`、`partially_parsed` 和 `needs_review` 是内容处理结果，不能与存储可用状态混为一列。任何 `deleting`、`deletion_failed` 或 `deleted` 来源的读取立即返回 `410 Gone`；后台失败不得自动恢复可读。

### 7.3 游标与幂等

- `GET /v1/changes` 返回 opaque cursor、当前 high-watermark 和按 `change_seq` 排序的变更；
- 插件只有在一页内所有对象校验、解析、落盘成功后才原子推进本地 cursor；
- 重放同一变更不得重复生成来源或事件；
- 邮件去重使用 Message-ID、稳定 header 子集和 MIME hash 的组合，不只使用主题或转发时间；
- tombstone 与内容变更使用同一有序日志，删除不会被断线客户端漏掉。

## 8. 唯一 access key

### 8.1 Worker 侧

- 每个部署环境只有一个活跃的 256-bit 随机 key；通过 `wrangler secret` 配置，不写代码、配置文件、D1 或日志；
- API 只接受 TLS 下的 `Authorization: Bearer <key>`，不得接受 URL query、Cookie 或请求 body 中的 key；
- 使用常量时间比较；认证失败返回统一错误，不暴露 key 指纹、来源是否存在或策略细节；
- 轮换时新 key 生效即撤销旧 key。需要无中断轮换时只能使用短暂、明确截止时间的双 key 部署步骤，完成后恢复唯一 key；
- access audit 记录插件实例 ID 的不可逆摘要、route、scope、时间和结果，不记录 Bearer 值。

### 8.2 插件侧

设置窗口提供 Worker URL、设置/替换 key、测试连接、撤销本地 key、删除计划与状态。用户明确选择不使用 macOS Keychain，保存位置改为：

```text
<vault>/.notemd/assistant-mail/
├── .gitignore                 # 精确忽略 `.local/`
└── .local/access-key          # 明文；目录 0700，文件 0600
```

`config.json` 只保存 URL 和非秘密偏好；界面只显示“已配置”、Vault 相对路径和不可逆指纹。key 不得出现在普通 settings、CLI 参数、环境变量、stdout/stderr、崩溃报告或 Agent 对话。插件每次操作都从 note.md 的共享配置解析当前 Vault，因此切换 Vault 后不会沿用前一个 Vault 的 key；无 Vault 时 fail-closed。

写 key 前必须先创建同目录 `.gitignore`，然后在 `.local/` 内用同目录临时文件、fsync 和原子 rename 保存；拒绝内部目录或 key leaf 的符号链接。`.gitignore` 只能避免 Git 误提交，不阻止同用户 Agent、本机搜索、备份或非 Git 同步工具读取；隐藏目录与 0600 也不是同用户进程隔离边界。若 key 曾经被 Git 跟踪，新增 ignore 不会清除历史，必须停止使用并轮换 Worker key。

正式插件只接受 `https://mail.5000g.com` 和同一部署的命名 Worker fallback，禁止把已保留的 key 随设置变更发送到任意 origin。Worker 回包进入 CLI、UI 或本地归档前必须扫描并遮蔽或拒绝与当前 key 完全相同的凭证材料。

Agent 调用宿主 CLI 时由插件后端代为请求 Worker。唯一 key 认证的是插件实例，不代表 Agent 获得任意删除权；本地命令面再实施读取/计划/执行能力分离。

已知边界：同一用户下的原生进程不是强多租户沙箱。MVP 防止凭证和正文进入受支持的 Agent CLI，但 Vault 内 `.local/access-key` 对已经取得同一用户文件访问权的 Agent 或进程可读；这类调用方能够绕过插件窗口，直接持 key 调用 Worker，包括删除执行 API。本版因此只适用于合作型 Agent 的行为约束，不再声称 key 与同用户 Agent 强隔离。本机 raw 归档同样不能对这类进程构成机密性边界。更强边界需后续使用宿主持有的 secret/decryption broker、不可伪造的窗口授权和硬件绑定签名。

## 9. Worker HTTP API

M0 成功响应统一为 `{ "data": ... }`，失败响应为 `{ "error": { "code", "message" } }`。增量变化列表使用有上限的 opaque cursor；来源列表有固定上限但尚无分页 cursor。客户端忽略未知字段，协议发生不兼容变更时必须提升 API 路径版本。

| 方法与路径 | 用途 | 备注 |
| --- | --- | --- |
| `GET /v1/whoami` | 验证部署和 key | 不返回 key |
| `GET /v1/status` | high-watermark、最新收信、积压、失败数 | 不包含正文 |
| `GET /v1/intake-policy` | 读取验证期/严格 sender 状态 | 不返回 key |
| `PUT /v1/intake-policy` | 保存唯一 sender 并切换过滤 | 开启时 sender 必填且合法 |
| `GET /v1/changes?after=&limit=` | 增量拉取 metadata/tombstone | opaque cursor |
| `GET /v1/sources` | 按 ID/时间查询来源元数据 | 分页、最小字段 |
| `GET /v1/sources/:id/raw` | 插件同步原始 MIME | Agent 面不得暴露；兼容 `/v1/messages/:id/raw` |
| `POST /v1/deletion-plans` | 按精确 `source_ids` 冻结计划 | 禁止模糊 query 删除 |
| `GET /v1/deletion-plans/:id` | 查看影响、hash、过期时间 | 不返回已删除秘密 |
| `POST /v1/deletion-plans/:id/execute` | 执行已确认计划 | body 必须含相同 hash 与 `confirmation: "DELETE"` |
| `GET /v1/deletion-jobs/:id` | 查询进度和失败 | 可重试、不恢复可读 |

API 不提供发送、回复、链接打开、附件执行、付款、签署、改签或取消端点。

## 10. 本地插件与 CLI

### 10.1 插件身份与归档

插件 ID 为 `notemd.assistant-mail`。私有数据根由宿主 `InitializeParams.data_dir` 提供，典型布局：

```text
<app_data>/plugin_data/notemd.assistant-mail/
├── config.json                 # 仅 URL/非秘密设置
├── state/cursor.json           # 游标、high-watermark、最后成功时间
├── archive/changes/<sha256(seq)>.json
├── archive/sources/<sha256(source_id)>.json
├── archive/raw/<sha256(source_id)>.eml
└── archive/tombstones/<sha256(source_id)>.json
```

文件名只使用内部 ID；写入采用同目录临时文件、fsync 和原子 rename。原件、结构化归档和 cursor 不进入 Vault、Git、全文索引或系统搜索。插件不得自动显示远程图片、打开链接或执行附件。

可信插件窗口提供本地归档的完整邮件列表和按需预览 RPC。列表可显示主题、完整发件人和时间；预览优先读取有大小上限的 `text/html`，由后端净化脚本、事件属性、表单、嵌套页面和全部 URL 属性，再放入空权限 `sandbox` iframe。iframe 自身使用 deny-by-default CSP，禁止脚本、联网、表单提交、嵌套页面、对象、媒体与自动导航；纯文本邮件使用 Svelte 转义的 `<pre>` 回退。主文档不使用 `{@html}`，邮件链接只在隔离预览外以显式清单显示。此用户可见契约与 Agent CLI 的 metadata-only 投影严格分离。

### 10.2 CLI

宿主贡献以下命令：

| 子命令 | 能力 |
| --- | --- |
| `mail-status` | 无 flags；返回覆盖、积压、失败和 key 配置状态 |
| `mail-sync` | 无 flags；增量拉取、hash/size 校验、私有归档、原子推进 cursor；M0 不做事件解析 |
| `mail-query [--text <text>] [--status <status>] [--date <YYYY-MM-DD> --timezone <IANA>] [--limit <n>]` | 只查询本地安全投影；日期与时区必须同时提供；不返回 raw/body/headers/HTML/附件 |
| `mail-delete-plan --source-ids <id,id,...>` | 只接受逗号分隔的精确 source ID，返回影响和 `plan_hash` |
| `mail-delete-status --plan <id>` | 查询计划；与 `--job` 二选一，不执行 |
| `mail-delete-status --job <id>` | 查询 job；与 `--plan` 二选一，不执行 |

**不提供 execute CLI 或 `--yes`。** 删除执行只在设置窗口的可信用户手势之后调用 `plugin.delete.plan.execute { plan_id, plan_hash, confirmation: "DELETE" }`。后端要求同一进程此前已在可信窗口 create/get 过该 exact ID/hash，并在提交前回源复核。所有命令默认 JSON 输出到 stdout，诊断到 stderr；错误结构不得包含正文、key、完整地址或本地 raw 路径。

M0 source 归档采用 envelope `{ schema, source_id, archived_at, source, raw: { sha256, bytes } | null }`；`mail-query` 必须从中重新构造 allowlist 投影，不得把 envelope 或 change payload 原样输出。M1 在兼容 schema 版本中补齐下述事件投影。

`mail-query` 必须执行字段级 allowlist，不能因为本地 source JSON 中存在额外字段就透传。M0 扣留所有主题和正文，只允许搜索掩码字段；M1 搜索片段在生成时先做禁密扫描与末四位掩码，隔离来源只能返回状态和安全原因枚举。

### 10.3 结构化投影

安全投影至少有：

```text
SourceProjection
  schema_version, source_id, processing_result
  sender_masked, subject_redacted, sent_at, received_at
  delivery_method, source_trust, auth_summary
  safety_labels[], parse_gaps[], snippet_refs[]
  events[]

EventProjection
  event_id, primary_category, context_tags[], event_type, title
  lifecycle_status, change, evidence_status, deadline_status
  starts_at, ends_at, local_date, deadline, timezone_status
  parties[], place, requires_principal
  amount_masked, reference_last4
  source_ids[], confidence, supersedes[], conflicts[]
  assessments[]  # 每项标 rule/plugin_inference/agent_advice/user_confirmation
```

所有来自邮件的字符串保留 `untrusted_input` 标记。日期型期限不补虚构时刻；精确时刻没有时区时为 unknown。人工修正以独立 revision 保存，后续自动处理不得覆盖。

## 11. 内容处理安全

解析器按以下顺序工作：MIME 结构限制 → 解码上限 → 禁止内容检测 → 安全文本提取 → 语言/地区解析 → 分类和事件抽取 → 去重/版本/冲突 → 脱敏投影。

- HTML 只从已校验的本机 MIME 原件读取；净化后可在可信插件窗口的空权限 iframe 中离线渲染，移除脚本、事件属性、表单、嵌套页面和 URL 属性，并用 CSP 再次禁止网络与 active content；Agent 投影仍不包含 HTML；
- 附件默认只列 metadata。受支持的无主动内容格式可离线提取；损坏、加密或未知格式标 `partially_parsed`；
- OTP、密码重置、Magic Link、恢复码、完整身份材料、高敏人事/病历/机密通信进入隔离或拒绝；
- 禁止秘密在错误、日志、审计、索引、摘要或 sidecar 中出现；
- 邮件中的指令文本不进入系统提示或工具参数；模型输出仍须经过结构校验和禁密扫描；
- 事件事实、插件推断、Agent 建议、用户确认分别存储，禁止模型把建议写回事实。

## 12. 授权删除

### 12.1 计划

Agent 或用户只能用稳定 `source_ids` 创建计划。计划冻结：

- 原始 R2 对象、附件对象；
- D1 来源、投递、事件、搜索片段；
- 本地 raw/source/tombstone；
- 受影响的 daily sidecar 引用；
- 各类数量、字节数、保留例外、审计最小留存期限；
- `target_version`、`expires_at` 和基于规范 JSON 的 `plan_hash`。

计划创建不删除任何数据。目标变化或计划过期时 execute 返回 `409 stale_plan`，必须重新计划和确认。

### 12.2 确认与执行

1. 设置窗口重新从 Worker 读取计划并展示完整影响；
2. 用户输入大写 `DELETE`；
3. UI RPC 提交 plan ID、相同 `plan_hash` 和确认词；
4. Worker 在 D1 事务内把目标置 `deleting` 并追加 tombstone/change；从此所有读取为 410；
5. 删除 R2 raw/附件并验证对象不可读；
6. 删除或匿名化 D1 敏感字段，保留不含秘密的必要审计/tombstone；
7. job 置 `deleted`；插件同步 tombstone 后清理本地原件、投影和受管 sidecar 引用；
8. 任一步失败则保持不可读的 `deletion_failed`，由 `scheduled()` 重试并在设置页显示。

逻辑删除不等于云备份立即物理消失。界面必须区分 `read_denied_at`、`raw_deleted_at` 和可计算时的 `backup_expiry_at`；从 D1 Time Travel 恢复后，必须先重放 tombstone，不能让已删除来源复活。

“例行清理”在 MVP 仍生成同样的精确计划并逐次确认；长期预授权的保留策略属于后续能力。

## 13. 每日 Skill 与调度

Skill 位于 `skills/assistant-mail-daily/SKILL.md`，它只接收 `mail-query` 的脱敏 JSON，输出：

```text
<vault>/diary/YYYY-MM-DD-assistant-mail.md
```

文件不使用 `YYYY-MM-DD-diary-*.md`，避免 weekly-review 把机器 sidecar 当作用户日记。每次按目标日期整体幂等重建，最多 0–3 条，每条分开陈述邮件事实、插件推断、Agent 建议和用户确认，并附覆盖截止时间与缺口。

工程 M0 的 `mail-query` 只返回 allowlist 后的来源元数据，尚不包含事件事实、期限和证据分层；Skill 在该 schema 下只能写 0 条及“结构化事件尚不可用”的覆盖说明，禁止从主题或发件人猜测。产生实际要点属于 M1 事件投影的发布门槛。

调度器契约：

```json
{
  "contract_version": 1,
  "skill": "assistant-mail-daily",
  "date": "YYYY-MM-DD",
  "timezone": "IANA timezone",
  "sync_before_query": true,
  "status_after_sync": true,
  "query_limit": 100,
  "output": "diary/YYYY-MM-DD-assistant-mail.md",
  "permissions": {
    "read_redacted_mail": true,
    "write_daily_sidecar": true,
    "read_raw_mail": false,
    "external_actions": false,
    "delete": false
  }
}
```

本仓库只定义契约，不创建 cron、launchd、系统提醒或 Codex Scheduled Task。实际注册必须由用户明确发起，并选择执行时间和时区。同步或查询失败时允许产出只有覆盖警告的 sidecar，不允许复用旧内容并声称最新。

## 14. 覆盖、撤销与审计

- M0 的 `mail-status` 和 `mail-query` 返回 Worker 收信覆盖、本地同步 cursor 更新时间及本地 gap；解析覆盖与 high-watermark 在 M1 事件管线落地后加入，任何阶段落后都必须显示真实截止时间；
- M0 只把插件对 Worker 的同步/读取记为可信 `plugin-instance`，`X-Agent-Id` 等自报字段只能作为 `unverified` 提示；本地 `mail-query` 尚无可验证的逐 Agent 审计。M1 由宿主传递可验证的 Agent/session scope 后，审计其标识摘要、时间、过滤条件和返回 event/source ID，仍不记录片段正文；
- 删除或轮换本地 key 后，CLI 立即失去 Worker 访问；撤销 Agent 权限后，宿主拒绝新的 `mail-query`；
- 插件清理自己管理的查询缓存和 daily sidecar。外部复制、用户手工复制或已经导出的第三方内容不声称可被技术上远程抹除，产品必须在授权界面披露这一边界；
- sidecar 是可撤销派生物，不是长期事实库；下一次重建必须应用 tombstone 和当前授权范围。

## 15. 失败处理与可观测性

- 非法 envelope：SMTP 拒绝；无内容存储；
- R2 成功、D1 失败：staging 清理器回收；
- D1 pending、Queue 失败：scheduled 补投；
- hash/size 不符：不推进 cursor，标 `processing_failed`；
- 解析不支持：`partially_parsed` 或 `needs_review`，不得降为 `parsed_no_event`；
- 来源或版本冲突：保留双方和冲突字段，不按接收顺序武断覆盖；
- key 无效：停止同步并提示设置页修复，不反复重试锁死；
- 删除失败：数据继续 410，后台幂等重试；
- 日报失败：保持旧 sidecar 或写仅含缺口的新 sidecar，不写半文件。

监控至少覆盖 accepted/rejected、pending age、Queue retry、staging orphan、sync lag、parse failures、quarantine、delete failures；指标和日志均不得含邮件正文、完整地址、Message-ID 或 key。

## 16. §19 验收映射

下表覆盖需求基线的全部 40 项。“验收证据”必须是自动化测试、批准样本或人工安全复核，不能只凭代码存在。

| # | 设计落点 | 验收证据 |
| ---: | --- | --- |
| 1 | §4–§10 端到端 | Email Routing → ready/隔离 → sync → query → revoke 集成测试 |
| 2 | §2.1、§6（已修订） | 指定 Gmail 人工/规则转发通过；业务方直投及其他 envelope 被拒绝且零内容持久化 |
| 3 | §10.3、§11 | 14 类中英繁混合批准语料，覆盖确认/变更/取消/失败/闭环；未知进 review |
| 4 | §7.2、§11 | 八种处理结果状态机与失败注入测试 |
| 5 | §11 | OTP/恢复/凭证样本零事件、零可搜片段 |
| 6 | §10.2–§11 | 合法通知夹敏感字段的字段 allowlist 与泄漏测试 |
| 7 | §10.1、§11 | 恶意 HTML 净化回归、空权限 iframe 与 CSP 检查、网络封锁下预览/附件解析；active content 永不执行 |
| 8 | §7.3 | 重复 SMTP、重复 change、崩溃重放的 source/event 幂等与 delivery 审计 |
| 9 | §6.2、§10.3 | 四级来源可信度样本，验证转发认证不继承 |
| 10 | §10.3 | 单事件唯一 primary category；跨领域邮件多事件 |
| 11 | §11 | 不可分类但有动作线索进入 `needs_review` |
| 12 | §10.3 | 生命周期/变化/证据/期限四字段可同时组合 |
| 13 | §7.3、§10.3 | 确认→变更→取消→退款连续 revision 链 |
| 14 | §10.3 | 多时间节点样本生成多个有关联事件 |
| 15 | §7.3、§10.3 | current view 更新且旧 revision/source 可回源 |
| 16 | §10.3、§15 | 不可判权威的冲突保留字段、来源与核验标记 |
| 17 | §10.3 | 精确时刻必须有 zone；日期期限不合成时间 |
| 18 | §10.3 | 跨时区交通分别保存出发/到达当地时间 |
| 19 | §10.3 | tentative 与 confirmed/出票映射测试 |
| 20 | §10.3 | scheduled、paid、posted 独立状态迁移 |
| 21 | §10.3 | refunding 不闭环，权威完成后才 refunded |
| 22 | §10.3、§13 | cancelled 不入原计划提醒，未完成退款仍入候选 |
| 23 | §10.3、§13 | 金额异常必须带权威/重复/阈值/基线证据枚举 |
| 24 | §9–§10 | `mail-query` 查询当天、范围、变化、未闭环和来源定位 |
| 25 | §9、§14 | status/query 返回覆盖、review、partial 和 failure |
| 26 | §13 与 Skill | 0、1、3、>3 候选排序测试；未入前三仍可 query |
| 27 | §10.3、§13 | sidecar 四层字段、决定/期限/理由/建议/来源状态齐全 |
| 28 | §13 | 已闭环、低价值、营销、非本人责任反例不挤占前三 |
| 29 | §10.2、§11、Skill | 账号/卡号/证件/票号/订单号仅末四位泄漏扫描 |
| 30 | §11、Skill | 凭证值不进入事件、搜索、日志、审计和 sidecar |
| 31 | §11、Skill | 提示词注入语料不能改变工具、权限或输出边界 |
| 32 | §3.2、§9、Skill | manifest/API/CLI 均无发送、付款、登录、签署、改签、取消能力 |
| 33 | §8、§14 | Agent/session scope 审计可查且正文泄漏扫描为零 |
| 34 | §10.3 | 人工 revision 前后 diff；自动重跑不覆盖确认字段 |
| 35 | §12 | raw/附件/事件/审计分别计划，execute 前展示完整影响 |
| 36 | §8、§12、§14 | key/Agent 撤销后查询拒绝，本地缓存与受管 sidecar 清理；披露外部副本边界 |
| 37 | §13–§15 | 断网、旧 cursor、Queue 积压、解析失败均显式降级 |
| 38 | §2.1、§6、Skill | 转发只提高相关性，不确认真实性、责任或行动授权 |
| 39 | §10.3、§11 | 英/简中/繁中/混合地区格式语料，歧义降级而非猜测 |
| 40 | §10.2、§12 | Agent 只能 plan/status；设置页确认精确对象、影响和 hash；重复/过期/撤销/stale 计划均不扩大删除 |

## 17. MVP 边界与发布门槛

为避免把“基础设施已经跑通”误报为“需求已验收”，分两层：

### M0：工程 MVP / Developer Preview

本轮实现目标：

- Mail Worker 的 envelope 门禁、R2+D1+Queue、读取/状态/变更 API；
- 单一 key 认证、插件设置和 Vault `.notemd/assistant-mail/.local/access-key` 保存；
- CLI 增量同步、私有 raw/source/tombstone 归档和基础脱敏查询；
- 精确删除计划、设置页确认、410 tombstone 和失败重试；
- 每日 Skill、独立 sidecar 格式和调度调用契约；
- 与 Share 同仓库但完全独立部署。

M0 可用合成邮件做本地/测试环境演示，**不得宣称已满足需求 §19 或可安全接入真实高敏邮件**。尤其不把“保存一封 `.eml`”等同于完成 14 类抽取、冲突合并、人工治理、可验证的 Agent/session 读取审计和撤销副本治理。

### M1：产品 MVP / 需求首版

只有 §16 表中 40 项全部有证据、批准语料完成安全复核、真实 Gmail envelope 行为验证、删除恢复演练通过，才可称为需求规格的首版。M1 仍不包含发信或外部行动、普通收件箱、实时航班/银行核验、主邮箱搜索、长期自动删除授权和自动注册定时任务。

生产启用前还必须完成：独立 preview/prod 资源、secret 轮换演练、备份恢复后 tombstone 重放、日志禁密检查、最大邮件/附件/解压上限、费用与积压告警、数据保留默认值和隐私说明。

## 18. 验证策略

- Worker：Vitest/miniflare 单元测试，加 preview 环境 Email Routing、D1、R2、Queue 集成测试；
- 插件：Rust 单元/集成测试覆盖 Vault key 路径、权限、符号链接拒绝、Git ignore、断点续传、原子落盘、字段 allowlist、CLI 输出、HTML 净化/纯文本回退、iframe sandbox/CSP 和 UI 删除确认；
- 安全：真实/合成 prompt injection、OTP、Magic Link、完整编号、HTML tracking、脚本附件回归集；
- 数据：14 类批准语料及中英繁混合矩阵，golden event 只比较结构语义，不保存真实秘密；
- 删除：stale plan、重复 execute、每个阶段故障、R2 不存在、D1 恢复与离线客户端 tombstone 重放；
- Skill：0/1/3/>3 候选、过期覆盖、冲突、时区未知、删除后重建及 sidecar 泄漏扫描；
- 仓库隔离：部署脚本证明只变更目标 Worker，bindings 和 secrets 无交叉。

## 19. 参考

- [Cloudflare Email Worker handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
