# 健康数据同步插件设计

日期：2026-10-24。状态：`notemd.health-sync` v0.1 源码实现与验收中。用户最新指示为**暂不签发和发布，继续打磨交互、质量与代码结构**。本文件说明当前实现；运行方式见 [插件 README](../../../plugins-src/health-sync/README.md)。

## 目标与入口

一个 Mac 插件、一个窗口、一组 CLI、一份每日有效档案。Apple Health 是综合主体，包含 Apple 设备和第三方应用写入的数据；Garmin、Oura 是可选的专有详情补充。优先保留来源实际提供的完整原始内容，再提供清晰分类和摘要，不以汇总代替采集。

用户确认采用从 iPhone 导出到 Mac／iCloud Drive 的 Apple ZIP/XML 文件入口。Mac 登录 iCloud 不提供健康数据库 API；本机 macOS 27.0.1 上 `HKHealthStore.isHealthDataAvailable()` 实测为 false。参见 [Apple 平台说明](https://developer.apple.com/documentation/healthkit/about-the-healthkit-framework)。插件不触发手机导出，iPhone HealthKit 桥接不在当前实现范围。

Garmin 使用官方 [Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)，核对 [官方开源 Python 客户端](https://github.com/garmin/connect-personal-api-python)与 OpenAPI。用户输入自己的 API Key，官方接口交换 JWT；不模拟网页登录。Oura 使用 [V2 API](https://cloud.ouraring.com/v2/docs) 与 [OpenAPI 1.42](https://cloud.ouraring.com/v2/static/json/openapi-1.42.json)；用户已明确确认额外授权，选择 API，采用自己的 OAuth 应用。

成功标准是可靠采集和明确覆盖，而非承诺多年全天佩戴必然有逐秒数据。账户权限、设备、服务历史保留范围和实际导出决定可获取数据；无法获取、空响应与采集失败分开表示。

## 用户流程

窗口先展示 Vault、Apple 导出入口和档案概览，再提供可选的 Garmin/Oura 连接与同步。分类显示数量、指标、来源及日期范围，可直接读取原始记录。导入、同步、查询共用一套后端，不要求打开笔记或 WebView 才能调用 CLI。

Apple 支持预览和正式导入，成功后记住文件路径。厂商同步显式指定历史日期，默认每批 31 天，窗口自动接续；用户停止只阻止后续批次，当前批次完成后保留已提交进度。状态分别说明本批是否完整、是否仍有历史待采、是否需要重试，不能把“一个请求成功”显示为“已获取全部历史”。

每个 Vault 只保存同一个人的数据。断开连接不删除档案；更换同一账号的授权后重新核对历史，以补采新权限开放的集合；另一账号不能混入现有来源档案。

## 数据布局与 SSOT

```text
health/
  manifest.json
  data/<day>/<source>-<metric-slug>-<content-hash>.jsonl
  daily/<day>-health.md
  attachments/<day>/<readable-slug>-<sha256>.<ext>
```

schema 2 的 `manifest.days` 是唯一有效清单：一天包含所有来源的当前分片，不建立三套独立日档案。每个分片说明来源、指标、分类、数量和内容 hash；指标 slug 包含短摘要，避免大小写或前缀规范化导致撞名。无日期资料归 `_undated`。历史不可变分片保留，查询只读当前清单。

Apple 标准记录保留 XML 属性、嵌套内容、原始写入应用/设备和时间偏移，包括未知类型。Garmin/Oura 保留完整 JSON（含未知字段及 null），不给原始内容套易丢字段的固定厂商 schema。Apple ZIP 中的 ECG CSV、路线 GPX、临床资料和其他附件，以及 Garmin 原始活动 ZIP 原字节保存；单独 XML 不扫描附近文件。

分类覆盖睡眠、心脏、活动、生命体征、身体、营养、正念、行动能力、听力、生殖健康、用药、临床、环境、元数据和其他。分类只用于浏览，不证明医学或算法等价。日期采用来源日期，不使用当前电脑时区改写历史；跨日记录完整保留于来源归属日。

每日摘要以 Apple 为主体，提供分设备/应用/指标/单位的样本数与数值范围，另列厂商补充。不同来源不相加、不静默覆盖，不声称重现健康 App 的来源优先级计算。当前不建立推测性跨来源事件关联，不计算统一健康分数。用户修改摘要后保留并报告冲突，`.note.md` sidecar 不动。

## 采集、增量与恢复

### Apple 完整快照

每次输入复制到临时文件并计算摘要，流式解析 ZIP 中唯一 `export.xml` 或独立 XML，临时 SQLite 按天排序。完整解析成功后才激活；截断、实体声明、危险路径、结构错误、超限都不激活半份快照。相同内容样本保留重数，因为 Apple XML 没有普遍可依赖的 UUID。

新完整快照替换 Apple 当前成员，包含新增、修订和移除，同时保留厂商成员。输入 hash 相同则校验现有分片/附件、恢复缺失文件，正常文件不重写；变化输入仍需完整扫描，不宣称 ZIP 字节级续传。禁止把局部导出当完整档案。

### 厂商 API

Garmin 使用官方详细接口覆盖日数据、睡眠/HRV、个人资料、活动分页/详情/训练内容/原始 ZIP；不同时采集可被详细响应替代的重复范围响应。Oura 采集全部 19 类官方集合，读取所有 `next_token` 页。只对完整成功的来源/集合/日期窗口替换有效成员；失败/不可用的旧数据保留，部分页不能标成完整。成功空结果表示本次 API 完整返回为空，可以替换该窗口成员，但不能证明权限之外没有数据。

日窗口先落盘再推进本机游标，中断后幂等重试。Garmin 按日请求，Oura 最大 31 天请求；时间戳集合查询覆盖 UTC 偏移边界，归档按返回记录原始日期筛回目标窗口。厂商重复 ID 在同来源/集合去重，内容冲突则拒绝；无 ID 按完整内容去重。

默认每次 CLI 处理最多 31 天，返回 `pending` 供后续调用续跑。历史完成后回查最近 14 天；更早修订需要显式 `--restart` 回查，当前不实现自动轮转全历史。连接代际变化重置历史游标，防止新权限只采到近期。用户改变起点会开始新范围，不维护多个并行历史任务。

### 提交与并发

写入顺序：不可变分片/附件写入、校验及耐久化 → 原子替换唯一清单 → 可恢复摘要 → 本机进度。清单提交前失败保留旧有效档案；孤立未引用分片不参与查询。摘要失败单独报告，不伪造整体完成。

每 Vault 使用本机写锁，厂商另有采集锁；GUI/CLI 共用。授权提交锁防止其他进程断开/重连后旧请求继续激活。只允许一台选定设备负责采集，本机锁不提供分布式协调。插件不改 Vault `.gitignore`，数据遵循已有备份/同步规则。

本机应用目录保存来源路径、游标、锁和非秘密授权代际；临时 SQLite 不进入 Vault。XML/input 上限各 64 GiB，记录/token 上限 16 MiB，单附件 256 MiB、附件总量 64 GiB。超限明确报错，不跳过。没有字节级续跑或旧分片自动垃圾回收。

## 凭据与协议边界

Garmin Key、JWT、Oura Client Secret/access token/refresh token 存 macOS 钥匙串，不写 Vault、日志或 argv。独立 CLI 连接使用 stdin JSON；窗口字段提交后清空，不进入 localStorage。Oura 采用 state、PKCE 和已注册的固定 loopback 回调，回调有时间/长度限制；轮换 token 必须先成功保存再用于后续请求。

HTTP 仅允许已知官方 host/path，不跟随重定向；有连接/请求/体积限制。401 刷新一次，429 尊重 Retry-After 并限制重试，错误不回显凭据。稳定官方用户 ID 绑定来源账号；不依赖名字或猜测 JWT subject。重新授权未完成时不可继续用旧凭据，断开后旧回调和在途请求不能恢复授权。

## 接口与结构

宿主命令为 `health-import`、`health-sync`、`health-status`、`health-catalog`、`health-query`、`health-disconnect`，均 `requires_tab_context:false`。具体参数和返回含义以 README 与 manifest 为准。原生 SDK 保持处理心跳，阻塞网络工作在独立线程，避免嵌入 Tokio runtime 导致 reqwest blocking panic。

后端按职责分为流式文件解析/附件、厂商协议、授权传输、统一存储/分类、批次调度、CLI/SDK 适配；不新增通用工作流引擎、模型调用或调度系统。前端单窗口使用宿主桥接，与 CLI 共用业务逻辑。cron 只需重复调用同一同步命令。

## 验收与边界

1. 合成 ZIP/XML：重复输入字节不变、修订/删除正确、未知内容无损、恶意/截断数据不激活、附件原字节保留。
2. 三源 SSOT：同日成员互不覆盖，失败集合保留旧数据，分页/去重/范围边界正确，预览不改有效状态，手动摘要被保护。
3. 授权：token 轮换、旧回调、重连代际、账号绑定、敏感字段不泄露；真实账号和钥匙串弹窗另做实机验收。
4. 交互：切换 Vault 清空旧视图，连接/停止/失败状态一致，分类查询翻页，GUI 自动接续与 CLI 手动续跑一致。
5. 构建：Rust 测试/Clippy、TypeScript、DOM 测试、Vite、真实宿主协议测试及两种 Mac 架构编译。发布脚本仅检查契约，不执行签发上传。

百万条合成记录覆盖 3650 天，schema 2 单次导入约 73 秒，RSS 途中采样约 28.2 MiB（不是峰值）。真实 Apple 导出、在线个人账户、应用内 WebView 尚未验收。没有已发布安装包；源码验证不能替代包内功能验收。
