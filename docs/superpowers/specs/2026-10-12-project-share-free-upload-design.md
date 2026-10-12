# 项目分享：免费 Worker 下的分段发布设计

日期：2026-10-12。状态：已完成自审和两份独立评审，待用户审阅；尚未实施本协议。

## 1. 已确认目标

用户选择保持 Cloudflare Workers 免费套餐，重新设计分段处理。沿用宿主基础功能、本地 Sync 镜像、现有 Worker/R2 和轻量反馈收件接口，不新增服务、数据库、云端正文权威或计费套餐。

保留以下行为：

- 当前文档作为项目入口，所在目录仅是引用基准；只分享用户确认的文档及附件。
- 首次发布先让入口文档可读，再补齐完整项目；更新时，已有完整分享持续可用，直到新版本全部完成。
- 当前主题/默认主题选项、完整图表渲染、文件夹导航、浏览器本地编辑和自动回传保持现有约定。
- 原 URL、下载全部、单文件下载、停止分享、到期、删除项目继续有效。
- 显示真实上传进度；失败可继续原次发布，不要求重建项目。

约束：Worker 每个请求只做有界的小元数据处理与存储调用，不读入、压缩、解压、解析或扫描整个发布产物。网络分片之后的最后一个请求也必须满足此约束。

## 2. 根因与范围

实测项目有 63 个源文件、5,179,701 bytes（4.94 MiB）；原 ZIP 为 9,973,157 bytes（9.51 MiB）。其中源文件压缩后 4,495,482 bytes，额外自包含阅读页压缩后 5,461,491 bytes。`Sync/<project_id>/.notemd` 未进入原包。

旧 Worker 同规模合成包首次上传耗 CPU 1118 ms；已 ready 原包重试出现 HTTP 503 / `exceededCpu`。替换原生解压及 CRC 后首次与重试分别 148 / 134 ms，仍高于免费 CPU 额度。平台生成的超限响应没有 CORS，浏览器显示为 ZIP 连接失败。

因此，分片上传后再在 Worker 完整解压或全量 hash，仍会保留根因。入口页当前也通过大 JSON、编码及全量 hash 发布，必须一起改为二进制流式传输。

本设计调整上传与提交协议，不重做阅读页、不增加动态文件加载、协作会话、通用任务队列或定时清理服务。

## 3. 方案选择

| 方案 | 优点 | 代价与结论 |
| --- | --- | --- |
| 分开上传 ZIP/HTML，分别原生流式 PUT 到 R2 | 协议最小，Worker 无正文处理 | 失败仍需重传整个对象；不满足本次分片续传方向 |
| **宿主冻结产物，R2 原生 multipart 分片，最后切换指针** | Worker 无全量正文运算；可单片续传；继续保存完整 ZIP 和单 HTML | 增加少量上传会话字段和操作；推荐 |
| 分片 ZIP 后服务端逐步解包/验证，或源文件逐一上云 | 可保留服务端 ZIP 内容审计，或按文件增量传输 | 需要可暂停压缩状态/验证游标，或改阅读协议和对象管理；超过当前需求 |

选择第二种。宿主本来就负责批准范围、源 hash、渲染和冻结；将云端恢复为静态镜像，存储传输完整性交给 R2。线上没有发布凭证的访客仍只能使用原有反馈接口。

## 4. 发布产物

每次新协议发布仍分两个阶段：

1. 入口阶段：冻结并上传 `entry.html`，提交后入口立即可读。此前不生成整个项目 ZIP，以免延迟入口生效。
2. 完整阶段：重新核对本次已批准的 path/hash，冻结完整快照、`full.html` 和 `archive.zip`，全部就绪后切换到完整版本。

新的 `archive.zip` **只含批准的源文档与附件，保持原相对目录**。不加入阅读页、内部 manifest、`.notemd` 或其他管理文件。ZIP 的确定性顺序、压缩参数、固定时间戳及源字节校验沿用现有机制。

阅读页独立为原始 UTF-8 HTML，继续自包含源快照、主题、图表和批准附件。首版不增加 gzip 存储协议、外置资源或浏览器按需解包，避免改变公开阅读与现有 MCP HTML 读取语义。

示例项目的新下载 ZIP 预计约 4.3 MiB；完整 HTML 约 8.5 MiB。完整阶段合计上传约 12.8 MiB，比原 9.5 MiB 增加约 35%。这是保持当前自包含阅读页、源文件下载与免费 Worker 的明确取舍；不能声称减少了总传输量。入口阶段的体积另算。

仍保留现有边界：源文件最多 512 个、总计 25 MiB；单个 HTML 最多 25 MiB；ZIP 最多 32 MiB。不改用 STORE ZIP，不扩大文件上限。

## 5. 分片与传输校验

固定分片大小 5 MiB，末片可更小。小对象也使用一个末片，保持一套上传状态机。每项目顺序上传，首版不增加并行上传调度。

宿主为每个冻结产物计算：总字节数、SHA-256 身份、每片字节数与 MD5、预期 multipart ETag。控制请求只携带这份小计划，不发送源文件清单或正文；请求 JSON 上限 16 KiB。现有大小限制下，入口/完整 HTML 各最多 5 片，ZIP 最多 7 片。

Worker 对分片请求执行：

- 检查既有 API Key、owner token、publication/session 身份、允许的产物与片号、当前撤回/期限。
- 只从已登记计划确定 object key、uploadId、预期片号/长度和校验值；客户端不能指定任意 R2 key。
- 检查原生请求已知长度与计划相符；缺少可验证的已知长度则返回明确错误，不退回 `arrayBuffer()`。由原生 HTTP/R2 流处理保证实际字节长度。
- 将 `request.body` 直接传入 R2 `uploadPart`，不经过 JS 逐块累计、全量 hash 或编码。
- 将 R2 返回的该片 ETag 与冻结 MD5 比较，通过后返回真实回执。不把仅写入 customMetadata 的 hash 称作已验证内容。

完成一个产物时，Worker 按冻结片号与 ETag 调用原生 `complete`，再核对对象总长度、会话身份和 multipart ETag。不 GET 正文、不重新计算全量 hash、不在 Worker 拼接分片。MD5 在此仅用于传输一致性，授权仍由凭证与发布状态决定；源内容身份仍由宿主 SHA-256 确认。

Cloudflare 官方定义了 5 MiB 非末片下限、part ETag 的 MD5 语义和 native multipart 合并方式，已有 R2 binding 可直接使用；无需新增 S3 凭据或公开 bucket。

## 6. 最小协议与原子发布

新增版本化上传操作，旧接口保留兼容。逻辑操作如下，实施计划再对应到具体路由：

| 操作 | 作用 |
| --- | --- |
| `begin` | 登记入口或完整阶段的不可变小计划，持久化会话身份及精确对象 key，返回或恢复原生 uploadId |
| `part` | 直接上传一个固定片号，返回 R2 回执；相同片号仅接受冻结原字节 |
| `seal` | 原生完成单个对象；已完成时 HEAD 核对并返回同一结果 |
| `commit` | 确认本阶段对象全部封存，再用项目 state ETag 条件写切换 active |
| `status` | 返回当前 active、pending/session 和已封存对象元数据，用于未知结果恢复 |

项目 R2 `state.json` 继续作为唯一可见性和撤回栅栏，不另建上传数据库。新状态采用 `schemaVersion: 2`，允许 `active: null` 的 registered 状态，并增加小型 upload/session 字段；读路径同时兼容现有 v1。分片成功回执存在本机已有 `share_db.json`，不为每片改写主 state。

`begin` 沿用现有代际合同：新 publication 必须用 `previousPublicationId` 精确匹配远端当前代并 CAS，首次无状态时才允许 null。相同 publicationId 仅可按原冻结计划幂等恢复；撤回、超过入口截止或已发布期限的同代不能复活。新的主动发布可以建立后继代，迟到旧请求不能以 owner 相同为由覆盖。

每个产物的会话使用独占随机 R2 key，Worker 只接受已登记的 uploadId。原生 multipart complete 没有条件覆盖语义，因此不同会话绝不能复用同一个最终 key。封存后不允许重新建立另一个 uploadId 覆盖该 key。

首次入口上传前也必须登记 owner 和 publication 栅栏。仅从未发布的项目可进入 `active: null`；公开 GET/HEAD 和下载返回未发布（410），MCP 返回 not_found，反馈不接受写入，owner status/停止/删除仍可用。readProjectState、公开页、MCP、反馈、撤回及旧 entry/archive 路径必须一起适配 v2，不能因 active 缺失抛 500。状态存在即不回退 KV。入口 HTML 封存后才提交可见入口；已有 active 的项目继续展示旧版本，有效旧 KV 分享也必须先保留为受栅栏保护的 R2 active，具体见第 7 节。

首次登记确定本 publication 的入口预上传绝对截止 `entry_deadline`（七天），重试或轮换 uploadId 不重置它；超期终结本轮 pending。首次入口 commit 才按冻结的分享时长确定公开 `expires_at`；若是恢复已发布旧阶段，则继承远端期限。完整阶段、重试及续传都不延长本轮 `expires_at`。R2 multipart 七天生命周期属于传输会话，与这两个业务期限分开。

完整 `commit` 只 HEAD 两个已封存对象并核对小元数据，然后重新检查 owner、当前 publication/session、pending 身份、撤回状态和期限，再执行一次 state CAS，原子切换 HTML 与 ZIP。若 pending 在传输期间到期，拒绝切换，保留尚有效的旧 active。

响应明确区分 `active` 与 `upload`。已有 `stage: ready` 可能只是旧完整版本仍在展示；宿主只有在 **active 的 publicationId 和 snapshotId 都等于本次目标**，且本机 published/remember 成功后，才清除 pending、宣布完整发布成功。

公开 HTML/ZIP 继续经过 Worker 的 active、到期、撤回检查与 `no-store`，返回 R2 原生响应流。不存在可绕过停止分享的公开 bucket URL。反馈仍以已发布 active 为权限依据。

## 7. 冻结、恢复与旧 pending

复用已有不可变 snapshot 与 bundle，不引入新的本机 ZIP 缓存目录。ZIP 可从冻结快照按固定算法重建；首次网络请求前持久化协议/包格式版本、产物 SHA-256、分片清单及请求身份；取得会话和分片回执后立即追加持久化。每次恢复都与冻结描述核对，禁止从当前源目录重采样或重新渲染。

- 单片失败：保留其他已确认回执，只重传失败片。结果未知时可重传同一片的相同字节；不创建新的 publication 或更换内容。
- `seal` 响应丢失：先 HEAD 独占 key。匹配则恢复封存状态；不存在且 uploadId 仍有效时重试原 native complete。
- `commit` 响应丢失：先查 status；目标已 active 就补齐本机记录，不重新上传。
- 原生 multipart 已失效：仅当本 publication 尚未超过入口截止/已发布期限时，终结旧上传会话，登记新随机 key/uploadId，继续使用同一冻结产物。pending 超期则明确终结，不能靠新 session 续命；用户可主动发起后继 publication，复用仍完整的冻结输入，无需重建项目。
- 旧 `phase: full`、无新协议版本的 pending：先查询目标是否已经 active；未完成则重建**旧算法、旧格式的原 ZIP**和原缓存 HTML，通过新分片传输协议上传。旧 ZIP 内部 reader 保留在这个历史包里；新发布才采用纯源 ZIP。原 publicationId、snapshotId、批准范围、主题、标题和期限保持。
- 旧 preparing/entry pending：以精确身份判定后续接，不能重新提交已成功入口来重置期限。已冻结的入口 HTML 原样使用，尚未生成完整包的部分按新协议生成。

| 远端与本机身份关系 | 恢复动作 |
| --- | --- |
| active publicationId + snapshotId 均匹配目标 full | 补齐本机 published/remember，不再上传 |
| 当前 publicationId 匹配本轮，entry/pending 的入口 snapshotId 匹配 | 继承远端 expires_at，继续 preparing/full；本机仍标 entry 也不重发入口 |
| active 只是 previousPublicationId 的旧 ready | 保留旧展示，继续本轮待传阶段，不能误报成功 |
| 代际不同、身份不匹配、已撤回或 pending 超期 | 明确冲突/终结；不静默重新发布或清除冻结输入 |

更早无 phase 的 `/publish` pending 没有 publicationId：保留原 nonce、快照、HTML、凭证，由宿主一次性生成并持久化迁移 generation；所有重试复用，不临时反复生成。先读取 owner 授权的远端小元数据，流式下载既有 HTML，由**宿主**计算 SHA-256/解析快照以识别旧 `/publish` 是否已成功。若与冻结目标相同，只补本机成功记录并继承 KV expires_at；否则记录远端前代、继承本轮可确认的绝对期限，再通过新协议发布冻结目标。若旧 KV 已不存在且没有既有远端期限/成功回执，无法区分从未成功与成功后到期：保留冻结输入并提示“原发布状态无法确认，本轮不续期”，不偷偷赋予新期限；用户仍可主动发起新一轮分享。

迁移有效 KV active 时，Worker 使用 `getWithMetadata(..., "stream")` 读取正文和身份/期限/size_bytes 元数据，将正文通过原生已知长度流直接复制到独占 R2 legacy key，随后 CAS 登记保留旧 active 的 v2 状态。必要的固定长度流只使用原生流设施，不做 JS 逐块计算；缺少可验证长度或身份时明确拒绝迁移，原 KV 链接保持现状。宿主在请求前持久化迁移 key 身份；复制结果未知时 HEAD 该 key 恢复，不能随机再建。CAS 失败仅回收本次已退休且未被引用的准确 key。此一次性复制也必须通过免费 CPU 门槛，不调用现有整页编码/hash/正则解析路径。

v2 状态 CAS 成功后，以登记的旧 R2 active 持续展示；迟到旧 `/publish` 即使写入 KV 也不能改变可见正文。旧 entry/archive 路由可从 slug/headers 在解析正文前识别 v2 并返回协议冲突；旧 `/publish` 的 slug 位于 JSON 内，保留其现有旧客户端路径，但 v2 状态检查必须阻止其写入，不能承诺这条遗留大 JSON 路径的免费 CPU 稳定性。旧分享读取和反馈仍兼容；新宿主不再走大 JSON 路径。

迁移使用新会话 key；已登记旧 attempt 的准确 archive/html key 保留在引用或 cleanup 队列，直到新会话成功替换或明确撤回，不能覆盖未知结果对象。

## 8. 生命周期与并发

撤回先 CAS 写墓碑，再 abort 已登记 multipart、删除已退休会话的精确对象；墓碑保留，阻止迟到请求和旧 KV 回退恢复分享。每次操作都重新校验栅栏，正文上传前后均检查，任何迟到写入都不能成为 active。

必须先登记 object key，再创建对应 native multipart；取得 uploadId 后立即保存，保存成功前不接受正文。创建成功但 uploadId 回执或状态保存丢失，仅可能留下尚无正文的未登记 multipart，利用 R2 默认七天终止未完成上传兜底；可确认的失败会话立即 abort。

R2 写入已完成但回执丢失，或撤回后迟到 `seal`，可能留下暂时孤儿对象。已登记的 key/uploadId 保留在墓碑 cleanup 队列，迟到请求收尾与后续 owner status/停止/删除/新发布操作重试有界清理。清理前重新确认当前引用，保护并发胜出的 active；不扫描前缀盲删，不将清理失败变成发布失败。

过期立即阻止公开访问；物理回收允许延后。原生未完成 multipart 使用现有默认七天清理；已完成对象按状态记录精确回收。首版不新增全库扫描、cron 或后台清理服务，也不承诺被永久放弃项目的已完成孤儿对象一定在固定时间内物理删除。

不为 staging prefix 设置会误删 active 的统一短期 lifecycle。v2 state 序列化最多 16 KiB，退休会话最多八个（先触达哪个上限即受限）。一次控制请求最多清理一个退休会话；达到容量时，先推进清理，仍满则阻止新增会话并返回可恢复错误，保留当前 active。正常清理失败不影响已完成发布，但不能无限新增记录，也不能丢掉未完成清理记录；撤回写墓碑仍必须可执行。失去 CAS 的请求只清理自己已登记且已退休、当前未被引用的对象，不得删除获胜会话。禁止把历史清理累计成一次 CPU 峰值，不增加分页队列或后台服务。

## 9. 界面

沿用现有项目分享主界面，不增加管理页。

- 显示“入口已可访问，正在同步完整项目”。首次入口提交前显示真实准备/上传阶段。
- 完整阶段依次显示“上传项目文件 ZIP”和“上传阅读页”，显示各自字节/总量及片号；项目总进度由实际确认片字节与当前 XHR upload 字节计算。
- `seal`/`commit` 时显示“正在完成发布”；取消“正在服务端解压”文案，因为新协议不在云端解压。
- 同一片重试不重复计入已完成字节。重连可以回到最后确认进度，不用计时动画冒充上传。
- 所有进度与错误继续绑定 project_id；成功/失败清理瞬时进度，保留可恢复 pending。
- “分享文件”明确表示源文件体积；ZIP 和阅读页上传量分开呈现，避免再误认为包体多出管理目录。

## 10. 验收与发布门槛

实现前先写失败回归；本协议先过以下验收才能替换新宿主发布路径：

1. 63 文件、约 4.9 MiB 源、约 8.5 MiB 阅读页合成项目，及既有 25/32 MiB 上限、最大单附件、空文件、中文层级路径、低压缩内容，完整发布与匿名下载字节一致。
2. 新 ZIP 解开仅含批准源，`.notemd`、目录穿越、未批准源及符号链接逃逸在宿主冻结/构建边界拒绝。Worker 不再宣称对 ZIP 内部做源清单审计；它验证发布凭证、冻结传输计划及 R2 收到的对象。恶意持有发布凭证者上传任意内容不在本轮防护目标内，与现有 owner 可直接发布 HTML 的信任边界一致。
3. 初次入口、更新旧完整版本、各分片、seal、commit、status、停止及清理都进行真实免费 Worker CPU 验证；代表包与上限包各连续至少十轮。每种操作观测 CPU 均低于 10 ms，且无 `exceededCpu`，才称免费方案可用；一次成功或本地测试不能代替此门槛。
4. 断网重连、应用重启、分片/complete/commit 回执丢失、同片不同字节、缺片/乱序片、错误校验值、七天 uploadId 失效均有可恢复或明确拒绝结果，冻结内容不变。
5. 两个客户端、重复请求、上传/完成/提交与撤回交错、pending 在途中到期都不能复活分享、覆盖并发胜者或删除获胜对象。
6. 旧 pending 的 entry/preparing/full/无 phase 四类迁移均不要求重建项目；旧已发布分享继续阅读/反馈/下载，target active 身份确认正确。
7. 主题、图表、公式、导航、单文件下载、可编辑草稿和反馈现有测试保持；真实宿主与浏览器验证进度/错误恢复。

如某个纯流式操作仍超 CPU，停下量化其小元数据/清理开销并调整；不切换付费、不放宽校验、不用全包自动重传掩盖失败，也不把验证工作搬到最终一次请求。

部署先发布向后兼容 Worker，再发布新宿主；沿用仓库现有 Wrangler 3 与双架构应用发布流程，当前 main，不创建 worktree。未经上述证明不宣布故障已彻底解决。

## 11. 自审结论与资料

自审：推荐方案无 Worker 正文读取/全量 hash/ZIP 解压/JS 合并；入口路径、最终 commit 和清理均纳入 CPU 约束。原生 multipart 的最小片大小、校验、未知结果、随机 key、代际 CAS、注册态 schema 与撤回竞态已定义。两份独立评审提出的 KV 可见性迁移、旧无 phase 恢复、业务期限/上传期限区分和清理硬上限已修正。明确记录独立 HTML 的带宽代价、服务端信任边界、旧冻结包例外和物理回收限制。

- [Cloudflare Workers CPU 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 multipart 分片、ETag 与默认生命周期](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [R2 原生 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 multipart Worker 用法](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)
- [KV 原生流式读取与元数据](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)
- 本地前后端及生产证据：`tasks/design/project-share-zip-failure-20261012/size-review.json`、`final-runtime-review.json`。
