# 健康数据同步插件设计

日期：2026-10-24。状态：规划，尚未实现。目标是把用户多年佩戴设备留下的生理与活动数据持续带入 vault，复用 Roam Sync 的「首次导入、增量同步、CLI、cron」体验，让现有 skills 能结合日记、工作与生活记录使用这些数据。

## 产品边界

建议实现一个 `notemd.health-sync` 插件，名称 Health Data Sync／健康数据同步，内部提供 Apple Health、Garmin、Oura 三个来源适配器。用户可以只启用其中一个；各来源独立授权、补历史和重试，共用数据格式、日摘要与 CLI。先支持 macOS 桌面，与当前 Roam 插件的发布范围对齐。

首次连接后先显示能读到的指标、历史范围和数据量，再执行历史回填；日常由同一个同步命令接续。采集过程不调用模型，原始事实和厂商评分保持可追溯。趋势解释、周报及与用户生活记录的关联留给现有 skills，不在采集插件里新增一套 agent 或定时任务系统。

成功标准是「把来源实际提供的数据可靠带回来」，不能把多年全天佩戴解释成所有设备都有每秒连续记录。每类指标明确原始粒度、实际覆盖、最后设备记录时间与最后同步时间；缺测不填成零，空结果不直接代表没有历史。

## 三个来源的接入方式

| 来源 | 首次历史 | 后续增量 | 必须明确的边界 |
| --- | --- | --- | --- |
| Apple Watch／Apple Health | iPhone 健康 App 导出 ZIP/XML；后续也可从 iPhone HealthKit 分批读取授权范围 | 第一阶段重复导出后在本地增量合并；自动持续采集需要第二阶段 iPhone 原生桥接 | Mac 没有可读的 HealthKit 数据库；桌面 cron 不能自行从 iPhone 取出新样本 |
| Garmin | 优先官方 Personal API 按日/时间窗回填；超过可读范围时补账号数据导出档案 | 个人版按日轮询，回看近期日期并按记录身份更新 | Personal 面向本人数据；面向多用户的公开商业插件须另走 Business 接入；多年可读范围须用真实账户验收 |
| Oura | API V2 按集合、日期和分页回填可用历史；导出档案作为补充路径 | API V2 轮询近期日期、分页 upsert，定期重查历史 | 使用 OAuth；公开发布需解决 client secret 的服务端保管和应用审批，不能把公用 secret 放入插件 |

Apple 官方支持导出全部健康数据为 XML；HealthKit 在 macOS 上没有可读写的 store。[导出说明](https://support.apple.com/guide/iphone/share-your-health-data-iph5ede58c3d/ios)、[平台边界](https://developer.apple.com/documentation/healthkit/about-the-healthkit-framework)。

Garmin 当前已提供 Personal API，使用个人 API key 换取最长 24 小时的 access token，没有 refresh token；到期重新用 key 换取。Business Starter 是 Push、无历史回填，Enterprise 的历史能力按方案另定，不能将其等同于个人 API 的本地 cron 路径。[Personal FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)、[方案说明](https://developer.garmin.com/gc-developer-program/overview/)。

Garmin Personal 官方 Swagger 已列出日心率、HRV、睡眠、Body Battery、日报、活动分页及原始活动下载。按接口规定切分请求窗口；窗口上限不是历史保留年限。账号导出包的目录和字段必须取得脱敏样本后确定，不提前承诺所有固件和年份格式都能解析。[接口文档](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)。

Oura OAuth 支持 PKCE S256，但官方 token exchange 和 refresh 仍要求 client secret；refresh token 为单次使用，必须串行刷新并原子保存。自用验证采用用户自建 OAuth 应用、凭据存本机钥匙串；市场版采用小型 token broker 保管公用 secret，健康数据由客户端直接向 Oura 获取。broker 只承担授权与刷新，仍须将其接触用户令牌的范围纳入上线设计。[认证文档](https://cloud.ouraring.com/docs/authentication)。

Oura 的接入还有产品用途前置条件：2026-06-08 生效的 API/MCP 协议第 2(c)、3(m) 条分别限制 Aggregator 向 AI 提供数据及存储/缓存，其他 API 使用也有保存期限要求。note.md 的具体接入角色、长期归档与用户选择 agent 的用途必须在 P0 向 Oura 核实，必要时取得另行书面授权；不能把 OAuth 成功当成这些用途已获准。以下 Oura API 方案以此前提解决为条件。用户自主导出档案的个人导入单独评估，不把换传输通道当成规避条件。[当前协议](https://cloud.ouraring.com/legal/api-agreement)。

**不能仅依靠 Apple Health 聚合另外两家。** Garmin 首次开启同步只回传最多两周，而且运动心率细节和 GPS 有缺失；Oura 的 Apple Health 导出字段也不是其 API 的完整能力。Apple Health 中已存在的副本可导入，但必须标注实际产生数据的应用和设备。[Garmin 同步范围](https://support.garmin.com/en-AU/?faq=lK5FPB9iPF5PXFkIpFlFPA)、[Oura 同步范围](https://support.ouraring.com/hc/en-us/articles/360025438734-Apple-Health-Integration)。

## 首版采集范围

| 数据族 | 首版内容 | 统一规则 |
| --- | --- | --- |
| 睡眠 | 起止、总时长、阶段、夜间心率、厂商睡眠评分 | 保留主睡眠与小睡；分来源统计，阶段不能跨设备相加 |
| 心血管 | 心率时间序列、静息心率、HRV、来源提供的血氧 | HRV 保留 SDNN／RMSSD 等方法信息；方法未知不强行合并 |
| 活动 | 步数、活动能量、运动类型、时长、距离、运动心率 | 不累加多个设备对同一活动的估计 |
| 恢复相关 | Oura readiness、Garmin Body Battery／stress 等来源可提供的评分 | 保留厂商命名、量纲和算法来源，不制造统一健康分数 |
| 身体指标 | 来源已有的体重、呼吸率、温度及温度偏差 | 绝对温度与相对基线偏差使用不同 metric |

首版不做 ECG 波形解释、临床病历、营养系统、训练建议及设备控制。运动原始 FIT 可保留为附件；路线/GPS 不作为基础同步必需项。API 没有提供的底层传感器信号不能通过导入器恢复。

Oura V2 的真实集合包括 `sleep`、`daily_sleep`、`daily_readiness`、`daily_activity`、`heartrate`、`daily_spo2`、`daily_stress`、`workout`；具体权限与可用性按账户和设备能力返回。使用官方 OpenAPI 生成脱敏契约 fixture，不把文档示例当成用户数据。[V2 文档](https://cloud.ouraring.com/v2/docs)、[当前 OpenAPI](https://cloud.ouraring.com/v2/static/json/openapi-1.42.json)。

## Vault 中的数据形态

机器明细与人读摘要分开，避免把数百万心率样本变成笔记块。目录建议如下，路径由插件配置确定：

```text
health/
  README.md                           数据字典、单位、来源优先规则
  daily/2026/2026-10-24.md             当日摘要，可索引、可批注
  data/<source>/<account>/<type>/2026/10/24/
    <batch-content-hash>.jsonl.zst     不可变样本与修订/删除事件
  attachments/<source>/<content-hash> 原始 FIT 等附件
  manifests/<source>/<account>.json   分片清单、schema 和历史覆盖
```

本机应用数据目录另存可重建的 SQLite 查询索引、job/checkpoint、锁和暂存文件，不将运行中的 SQLite/WAL 放入 Git。原始分片是可移植事实来源，索引丢失可以重建；API cursor 和 HealthKit anchor 属于设备上的运行状态，无法恢复时重新回查而非猜测水位。

摘要默认随 vault 正常同步。首次设置明确大体积明细的备份选择：本地完整保留，Git 默认排除 `health/data/` 与 `health/attachments/`，需要用户选择的完整备份方式覆盖这些目录；不能让界面声称「vault 已同步」就等同于完整健康档案已备份。文件直接可用，插件卸载后摘要和分片仍属于用户。

每条规范化记录至少有：`schema_version`、`source`、本地稳定 `account_id`、`source_record_id`、`metric`、`value/unit`、`start_at/end_at`、原始 UTC offset、来源日历日期、设备/写入应用、采样方法、原始 payload 或其分片定位、修订关系、质量/覆盖标记。没有 IANA 时区时不凭 offset 猜城市。摄取时间存批次元数据，不进入测量内容 hash。

日摘要只使用当下有效记录；注明来源、计算规则及缺失项。例如：睡眠 7h12m（Oura），静息心率 54 bpm（Apple），HRV 42 ms（Apple SDNN）。用户批注使用既有 `.note.md` sidecar；首版不向已有 daily note 大段写入，只提供当日摘要链接。摘要被手动改写时，用上次生成 hash 检测并报告冲突，保留现有文件；不能直接覆盖。相同输入必须字节不变，不以当前时间反复刷新摘要。

## 增量与重复数据规则

1. **分源分集合维护进度。** 状态键为 vault 身份、来源、账户、数据类型；历史回填与近期同步有独立 job，互不跳过。`--since/--until` 启动指定范围回查，不倒退日常进度。
2. **来源变更与测量时间分开。** HealthKit 用 anchor 获取新增和删除；日期型云 API 默认重查最近 14 天。14 天是初始工程参数，不是厂商保证。每周轮转重查更早的月份，支持显式全历史 reconciliation，覆盖晚到和算法重算。
3. **有身份就按身份更新。** HealthKit 用 UUID；云 API 用源记录 ID；无 ID 的日报用账户、集合和来源日期。Apple XML 常无可依赖的 UUID，使用来源、设备、类型、时间区间与规范化 payload 指纹，并保留同内容样本的重数及文件位置，避免误删合法重复。每份完整 XML 有独立 snapshot generation，记录输入 hash、账户、类型和声明范围；重复 generation 幂等。因为数值修订会改变指纹，新快照必须在明确且可比较的范围内整体切换有效成员，而非简单追加；旧分片仍保留。解析未完成的快照不得激活，范围不明时不能推出旧记录已删除。
4. **XML 与 HealthKit 的身份迁移单独处理。** 两种入口可能拿不到共同 ID；默认保存为独立分支，不累加。按类型比较两者覆盖与差异，由用户在来源设置中选择启用 HealthKit 作为有效来源及历史切换范围，XML 分支保留为档案。HealthKit 分页读尽不能证明获得全部读取权限，不能据此自动隐藏 XML 历史；授权改变后也不自行扩大替换范围。
5. **跨源保留原始值，摘要选来源。** `ingest_source=apple-health` 与 `origin_source=oura/garmin/apple` 分开。只在确证共同身份时标成镜像；不能因时间接近和值相同就销毁另一条记录。每项指标固定一个首选来源，缺失时使用已配置后备并标注，初次设置由用户选择；其他来源仍可查询。
6. **更新只改受影响日期。** 同一睡眠被修订、跨日运动、来源时区改变时，重算所有受影响日期。保留来源睡眠归属日和绝对时间；不按当前电脑时区反复改写历史。
7. **明确删除与不可见不同。** 有删除事件才写 tombstone，并使旧记录退出当前汇总；完整权威快照完成后才能比较删除。权限收缩、API 暂时空响应、缺页或未完成回填不触发删除。源删除同步与用户要求彻底清除历史档案是两种不同操作。
8. **先持久化再确认。** 顺序固定为分片临时文件写入/校验/fsync/rename → 发布包含批次身份、分片 hash 和有效版本关系的 commit manifest 并耐久化目录 → 本机 SQLite 事务登记索引与 checkpoint。启动时重放已发布但尚未登记的 manifest；没有 commit manifest 的孤立分片只作待恢复文件，不能直接进入有效集合。完成快照的激活记录也遵循此顺序，使索引重建能区分已提交与尚未完成的快照。摘要失败记为 pending，下一轮恢复。HTTP 分页完整完成后才能标记日期窗已覆盖，覆盖仅指本次查询完整，不证明权限之外没有数据。
9. **并发只有一个写者。** 首版使用每 vault 一个写锁，GUI 和 cron 共用；持锁时另一任务返回可重试的 busy。仅允许一台选定设备主动采集一个来源账户，其他设备读取归档，避免把本地锁误当跨设备锁。

HealthKit 的 anchor 能返回新增和删除；删除记录可能被系统清理，长期离线后仍需范围复核。读取授权不可用空结果判定拒绝，UI 显示「未读到数据，检查权限/设备同步」，不能虚报无历史。[增量查询](https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery)、[删除记录](https://developer.apple.com/documentation/healthkit/hkdeletedobject)、[授权语义](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)。

## CLI 与定时任务

以下是拟新增接口，并非当前可执行命令。沿用扁平子命令；全部声明 `requires_tab_context:false`。`--vault` 作为插件自己的 flag 显式声明，不假设宿主已有全局 vault 参数。

```sh
# 一次连接；密钥通过设置窗口进入系统钥匙串，不写在命令行中
notemd health-connect --source oura --vault /path/to/vault

# 导入全量文件，内部流式解析、分批合并；再次导入幂等
notemd health-import /path/to/export.zip --source apple-health --vault /path/to/vault --json

# 回填指定范围；第一次创建任务，后续调用按 job 接续
notemd health-sync --source garmin --since 2019-01-01 --until 2026-10-24 --vault /path/to/vault --json
notemd health-sync --resume <job-id> --vault /path/to/vault --json

# 日常执行，接收待处理的手机批次并同步已连接云来源
notemd health-sync --vault /path/to/vault --json
notemd health-sync --source oura --dry-run --vault /path/to/vault --json

# 供 cron 和 skills 观察状态及按需读取数据
notemd health-status --vault /path/to/vault --json
notemd health-query --metric sleep.duration --since 2026-10-01 --until 2026-10-24 --vault /path/to/vault --json
```

`health-query` 默认返回每日摘要；明细查询须显式指定来源、日期窗和分页上限，避免把几年数据一次塞给模型。JSON 输出沿用宿主 `{ok,data}`，成功报告包括 job、各来源新增/修订/跳过数、实际覆盖、pending 摘要、`has_more` 和下次可运行时间。不把请求执行成功等同于已经同步完全部历史。

首版每次命令主动限制为约 180 秒工作预算，manifest 请求静默超时设 240 秒；完成一个安全批次后返回。这是控制定时任务时长和恢复成本的产品选择，并非宿主强制总时限。GUI 可反复调用，cron 每次继续未完成任务。长期回填按数据类型轮转，避免心率大集合饿死睡眠；近期同步也保留执行份额。CLI 不在一个宿主请求里无限循环。预算耗尽并安全落盘属于 `ok=true, has_more=true`；429、失联、授权到期、解析失败属于执行失败，保留可恢复进度。

沿用宿主退出码：0 成功、1 宿主错误、2 参数错误、3 插件禁用、4 执行失败、127 未知命令。同步部分失败使用已有 `__notemd_cli_result:{exit_code,data,message}` 结果协议，使 CLI 非零退出同时保留 JSON 的结构化报告；异常走现有 error.code/message。最近运行报告也可经 `health-status --json` 查看。日志输出不含密钥和样本 payload。

`--dry-run` 不写 vault、索引和同步 checkpoint，不刷新远端单次使用 token；已有令牌失效时返回需重新连接，避免“预览”改变授权状态。限流按各 API 响应头退避，避免硬编码跨来源统一配额。cron 只运行现有 CLI，可建议每小时一次；授权过期不在无人值守任务里弹浏览器。

## Apple Health 持续采集

这是独立实施阶段，不能以桌面 ZIP 导入冒充自动增量同步。复用 note.md 已有 iOS 工程，增加原生 Swift HealthKit collector 和最小设置页；不能将桌面 Rust 子进程插件直接装到 iPhone。

授权后按数据类型分批查询，保存 anchor，并使用 `HKObserverQuery` 的后台通知触发 anchored query。先将批次和待提交 anchor 原子写入手机持久 outbox，再推进本地查询位置；桌面确认批次落盘后才回收 outbox。后台唤醒由 iOS 决定，不承诺固定分钟级到达；前台打开时主动追赶。

建议第一种传输实现为已配对手机向同一网络中运行的桌面插件发送加密批次：桌面启用接收后运行受管接收进程，二维码绑定设备密钥与服务身份；只接受已配对设备、限定大小、校验 batch hash、确认后重传幂等。桌面关闭或网络不可达时手机排队，重连后续传；不要默认存在永远在线的电脑。此接收服务的生命周期需单独实现，不是现有 headless CLI 自带能力。手动导出同格式批次保留为故障恢复入口，不新增公有健康数据中转服务。

HealthKit 新增指标、改变授权范围、重装或重置 store 时，重新建立对应查询范围，不混用旧 anchor。首次设置区分「已发起授权」「已读到数据」「当前可读历史」，不将请求授权成功当作每项读取成功。HealthKit 正式上架与数据传输条款在 iOS 阶段按实际用途核对。

## 与现有代码的对应

- 插件骨架参考 `plugins-src/roam-import/manifest.v2.json` 与 `backend/src/plugin.rs`：native v2、Svelte 窗口、Rust 核心，UI 和 CLI 共用命令。
- 可靠性参考 `backend/src/incremental.rs`、`ledger.rs`、`sync.rs`：逐批进度、原子写、无变化不写、并发编辑保护。健康数据另用分片和索引，不复制 Roam 单 graph、单时间水位或源删除后继续算旧内容的行为。
- `src-tauri/src/cli/runner.rs` 已支持无 WebView 的 v2 CLI，watchdog 在此路径只保护启动阶段；`process.rs` 的 300 秒上限是请求静默超时配置上限，不是有进度请求的总耗时限制。分批预算由健康插件自身执行。
- `src-tauri/src/plugin_runtime/process.rs` 会清理子进程环境；凭据不能假设自动从 shell 环境传入。首版使用 macOS Keychain，按来源/账户隔离。
- iOS 工程已有 `src-tauri/gen/apple/Sources/Plugins/IOSBridge/`，本次检查未发现 HealthKit collector；Apple 自动增量明确包含原生宿主工作。
- 新建 `plugins-src/health-sync/`，先不抽象跨插件通用同步框架。界面只做来源连接、导入、范围、进度、错误和打开结果；弹层菜单沿用 `.menu-panel/.menu-row` 全局样式。

## 实施顺序与验收

| 阶段 | 交付 | 完成条件 |
| --- | --- | --- |
| P0 接入验证 | 三源脱敏样本、指标/日期覆盖表；Garmin Personal 和 Oura 接入条件核实 | 每源核对一个旧日期和最近日期，验证记录身份、时区、权限与分页；确认实际最早可读范围；先解决 Oura 长期保存/AI 使用条件，再实测回调与刷新 |
| P1 历史导入与公共核心 | Apple ZIP/XML 流式导入、分片存储、查询索引、日摘要、import/status/query CLI、最小 GUI | 多年规模合成 fixture 有界内存；重复导入零变化；中途终止后恢复；摘要不覆盖批注 |
| P2 桌面自动同步 | Garmin Personal、满足 P0 条件后的 Oura API 适配器；sync/connect CLI、历史回填和 cron | 实际账户连续同步；晚到/修订回查；401/429/离线/并发恢复；与来源 App 逐日抽样对照 |
| P3 Apple 自动增量 | iOS HealthKit collector、outbox、配对接收、补历史与删除传播 | 真机后台、锁屏、断网、电脑关闭、应用重启、权限变更、XML→HealthKit 切换均不漏不重；验证新鲜度显示 |
| P4 市场分发 | Oura 产品授权方案和 Garmin Business 接入、打包与发布验收 | 分别满足厂商分发条件；Business 的 Push/历史差异另做接入验证；按既有插件发布流程执行 |

P1、P2 可先满足个人使用；需要 Apple Watch 自动持续数据时，P3 必须完成。Garmin 官方账号导出和 Oura 导出档案的额外解析器按 P0 的覆盖缺口加入对应阶段，不先泛化所有格式。P4 的商业接入不能包装成个人 API 已经解决。

重点验收矩阵：同输入幂等；分页边界重复；同时间戳多条合法样本；数据提交/游标推进间断电；跨设备副本；HRV 方法不同；单位换算；跨午夜、夏令时和旅行；旧记录修订/删除；权限下降；令牌轮换并发；损坏分片；状态丢失重建；手动编辑冲突；多个来源中一个失败的独立恢复。

性能验收先固定 fixture 大小与机器，再记录吞吐、峰值内存、磁盘放大和索引时间，不凭「多年」估工期。XML 使用流式解析并在完整记录边界提交；ZIP 先流式解包到可校验的本机暂存，完成后按记录偏移接续，不能假定压缩流任意 seek。首次解包中断可以重做，但已提交分片不能重复进入有效集合。输入路径、ZIP entry 路径、解压大小和 XML 外部实体均需约束。

本轮只完成设计与公开资料/源码核对，未连接个人健康账户、未采集真实样本、未修改产品代码、未发布插件。实际接口可用性和多年数据完整性由 P0 验收确认。
