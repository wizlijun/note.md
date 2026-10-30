# 健康数据同步 / Health Sync

Mac 原生插件 `notemd.health-sync`。一个窗口收集 Apple Health 完整导出，并用 Garmin Personal API、Oura V2 API 补充厂商详情；原始记录统一保存在用户选择的 Vault 外 SQLite 资料库。提供分类浏览、增量同步和 CLI。

面向 Apple Silicon 与 Intel Mac。本文描述 0.2.2 的外置 SQLite 资料库设计。Apple 使用本地文件入口；Mac 登录 iCloud 不等于可直接读取 iCloud 健康数据库。

## 开始使用

1. 在 note.md 配置目标 Vault，从插件菜单打开「导入健康数据」。首次使用通过原生文件夹选择器指定健康原始资料库，必须是 Vault 外的空目录或已有 Health Sync 资料库。Vault 本身、其子目录和父目录（包括符号链接别名）都禁止；取消选择不会开始采集。资料库应属于同一个人，不同历史账号分别归档。
2. 选择 iPhone 健康 App 导出的完整 `export.zip`。iCloud Drive 文件需先下载到 Mac。ZIP 在 `.xml` 文件（扩展名不区分大小写）中按 `HealthData` 根节点识别唯一主文档，不依赖文件名语言或所在目录，也兼容 ZIP 编码标记不正确而显示为乱码的文件名。CDA 按 HL7 `ClinicalDocument` 根节点识别并作为附件保留；多个主文档会明确报错。也支持单独 XML，但只有 ZIP 能带入其中的 ECG、路线和其他附件。
3. 可先预览，确认后导入。Apple 仅使用独立文件导入按钮；预览不要求先正式导入，也不会记忆路径。窗口显示已收集的分类、指标、来源、日期范围和记录数量，可按分类查看原始记录。
4. 窗口按 Apple、Garmin、Oura 分组；Garmin/Oura 各自集中账号、文件导入、API 增量和历史导入。在对应来源区域添加账号，可填写容易辨认的账号名称。每个来源记住多个账号，只有一个“当前账号”用于增量刷新；新增其他账号不会自动切换，可选中后点击“设为当前”。
5. 使用“导入历史”选择 Garmin / Oura、已保存账号和起止日期。历史导入不会改变当前账号；窗口自动接续批次，“停止”在本批结束后生效，进度保留。当前账号首次默认回查最近 14 天，已有同步任务继续接续；完成后回查近期。

Apple **仅文件导入**。相同文件重复导入不增加记录；重叠导出按完整记录的最大重复重数合并，保留新文件未包含的旧历史。单份导出中的重复样本不会丢失。更新导出后再次选择并导入；普通同步只访问 Garmin/Oura API，不自动重读 Apple 文件。

## 连接补充来源

### Garmin

按账号数据中心打开 [中国区 Key 页面](https://connect.garmin.cn/app/settings/personalApiToken) 或 [国际区 Key 页面](https://connect.garmin.com/app/settings/personalApiToken)，选择 Create Key、接受条款、选择有效期并创建。Key 只显示一次；在插件窗口选择相同账号区域，输入 Key 后连接。中国区 API 为 `https://personal.connectapi.garmin.cn`，国际区为 `https://personal.connectapi.garmin.com`，接口见 [官方 Swagger 文档](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)。插件使用官方令牌交换及 Personal API，不接收 Garmin 密码，也不模拟网页登录。

采集协议提供的日统计、详细心率、睡眠、HRV、压力、Body Battery、呼吸、血氧、体重、训练状态、活动列表/详情/训练内容及原始活动 ZIP 等。活动分页读完；原始 ZIP 作为附件保存。账号权限、设备能力和服务保留范围决定实际可获取内容。实现核对了 [官方 Python 客户端](https://github.com/garmin/connect-personal-api-python)及官方 OpenAPI。

### Oura

本项目按用户已确认的额外授权接入 API。使用自己的 OAuth 应用，填写 Client ID、Client Secret；在应用中注册与窗口一致的回调地址，默认 `http://localhost:8765/callback`。新开发者门户的 HTTP 回调只接受 `localhost`，不要填写 `127.0.0.1`；两处地址必须完全一致。点击连接后浏览器完成授权，再回到插件查看结果；无需在命令行传递 token。端口占用或回调不匹配时，修正设置后重新连接。授权申请包含新门户的 `stress` 和 `ring_configuration`；更新前已连接的账号须在“添加 / 重新授权账号”中重新授权并允许所需数据权限，普通 token 刷新不会扩大已有授权范围。同步仍返回 401 时保留失败窗口，不推进游标，并提示重新检查授权。

采集 [Oura V2 API](https://cloud.ouraring.com/v2/docs) 的 19 类集合：活动、心血管年龄、准备度、韧性、睡眠日汇总、血氧、压力、增强标签、心率、个人信息、休息模式、戒指电量、戒指配置、session、睡眠详情、睡眠时间、标签、VO₂ max、运动。逐页保留完整 JSON，包括未知字段和 null；未开放集合显示覆盖缺口，不冒充零数据。

Oura 适配以官方 OpenAPI 和 OAuth 示例为依据；未将第三方客户端当作官方 SDK。心率和戒指电量允许末页省略 `next_token`，其余分页集合仍校验该字段。本地导入支持按内容识别的 V2/DSR CSV、JSON 及包含这些文件的 ZIP。CSV 自动识别逗号或分号，流式读取大文件；全部字段保留原始字符串，包括嵌套 JSON 单元格。导入时显式选择已保存账号，或填写稳定的离线账号名称；同一名称用于以后增量合并。离线身份与 API 身份不自动合并，以免错误归属。未知内容保留原件并注明，完全无法识别健康记录时拒绝导入。真实 DSR 包已用于隔离验收：32 类健康/传感器集合，另保留未知内容与位置、订阅账单原件。新增温度、步数、动作、日间压力、外部心率/步数、心血管细节、平滑心血管年龄、VO₂ 估计、运动心率会话、时区及餐食等识别；不会按 ZIP 文件名截断数据日期。返回 `file_reports` 显示各成员的解析数、未知数和状态。原 ZIP 附件可回查未解析内容。

两家凭据按账号保存在 **macOS 钥匙串**，不进入 Vault。Oura 自动刷新并保存轮换后的 token。每个账号的授权、历史进度、覆盖和记录独立保存；重新连接同一账号会重新核对指定范围。断开仅移除所选账号凭据，保留账号名称和已归档数据；其他账号不受影响。新增账号授权失败不会破坏当前账号；Oura 按本次授权结果判断完成。

Garmin API 历史回填范围取决于服务器返回。0.1.3 新增官方导出 ZIP 本地导入。中国区导出从 [账户中心](https://www.garmin.cn/zh-CN/account/) 的数据管理进入，国际区从 [数据管理](https://www.garmin.com/en-US/account/datamanagement/) 进入；每个历史账号分别申请。

### Garmin ZIP 本地导入

在“Garmin 导出 ZIP”中选择已下载的包和账号区域，然后预览或导入。无需 Personal Key；通过包内 profile ID 区分账号，同一身份和区域与 API 账号归档一致，不改变当前增量账号。只导入离线文件的账号会出现在数据查询筛选中；需要 API 同步时再连接该账号。

按 JSON 内容识别活动、每日汇总、睡眠、午睡、饮水、训练指标和身体数据，不依赖导出包名称或目录语言。保留原始字段与日期语义；数值日期按 Garmin 毫秒时间戳处理，不套用本机时区。无可靠日期的个人纪录等进入 `_undated`。每个原始文件都保存并校验 SHA-256；未知 JSON、图片、嵌套 ZIP/FIT/备份文件按原字节保留，**本版不解析 FIT 的逐点读数**。

ZIP 数据使用独立的 `garmin.export_*` 集合，支持分卷累积，不覆盖 API 集合。相同账号和稳定 ID 的记录更新，缺失成员保留；没有稳定 ID 的记录按完整内容去重，修订内容会保留为不同记录。覆盖中的“导出中有记录”只表示包中实际观察到记录，不表示完整日或 API 已采集，不推进 API 游标。重复同包不改写已有文件。预览实际解析文件但不写 Vault、凭据或账号设置。

```sh
notemd health-garmin-import "/path/to/garmin-export.zip" --region china --vault "/path/to/vault" --dry-run --json
notemd health-garmin-import "/path/to/garmin-export.zip" --region china --vault "/path/to/vault" --json
```

国际区选 `--region global`，区域必须明确指定。此入口与 Apple `health-import` 分开，API 同步入口不接受文件参数。ZIP 归档以 `observed` 标注文件中实际观察到的数据。限制：最多 100,000 个 ZIP 成员、单文件 1 GiB、总解压 64 GiB；超过 64 MiB 的 JSON 仅保留原件并在结果注明。路径穿越、重复成员、符号链接、身份冲突、损坏 ZIP/JSON 均在提交前拒绝。

## 分类与每日档案

分类包括睡眠、心脏、活动、生命体征、身体测量、营养、正念与压力、行动能力、听力、生殖健康、用药、临床、环境、元数据和其他。分类由原始类型推导，未知类型仍保留并可查询；分类不表示跨来源指标在医学上等价。

```text
用户选择的外部资料库/
  .notemd-health-library
  health.sqlite
  attachments/<日期>/<内容摘要附件>
  write.lock
```

SQLite 持久保存三源原始记录、账号、日期、指标、分类、覆盖和附件索引。不会再创建巨型 manifest 或每日 JSONL 分片。原始附件保留为文件；Apple 主 XML 的属性、嵌套内容、设备与时间偏移保存在数据库记录中，建议保留原始导出包作独立备份。无日期记录使用 `_undated`，不虚构时间。

默认窗口和 CLI 只展示数据现状、范围、数量及覆盖缺口，不生成健康结论。Vault 的报告留给后续 Agent skills：

```text
health/YYYY/YYYYMM/YYYYMMDD-health.md
health/YYYY/YYYYMM/YYYYMM-health.md
health/YYYY/YYYY-health.md
```

本插件本次不生成这些分析报告。不同来源的步数、睡眠等不直接相加，也不声明医学等价。

## CLI 与定时同步

安装启用后使用宿主命令；`--vault` 可省略，默认使用 note.md 配置。宿主 `--json` 提供结构化结果。

```sh
notemd health-init --path "/path/to/health-library" --vault "/path/to/vault" --json
notemd health-storage --json
notemd health-import "/path/to/export.zip" --vault "/path/to/vault" --dry-run --json
notemd health-import "/path/to/export.zip" --vault "/path/to/vault" --json
notemd health-oura-import "/path/to/oura.zip" --profile "historical-account" --dry-run --json
notemd health-sync --source all --since 2015-01-01 --until 2026-10-24 --max-days 31 --json
notemd health-status --json
# 从 connections.garmin.accounts 获取 ACCOUNT_ID
notemd health-sync --source garmin --account ACCOUNT_ID --history --since 2015-01-01 --until 2020-12-31 --json
notemd health-catalog --json
notemd health-query --category sleep --source oura --since 2026-10-01 --until 2026-10-24 --limit 100 --offset 0 --json
notemd health-disconnect --source oura --account ACCOUNT_ID --json
```

日期为包含两端的 `YYYY-MM-DD`。`--source` 同步支持 `all`（默认）、`garmin`、`oura`；查询只接受实际来源。`--metric` 可使用目录返回的原始指标名，例如 `HKQuantityTypeIdentifierHeartRate` 或 `oura.sleep`。查询上限 1000 条，用 `next_offset` / `has_more` 翻页。

一次 CLI 同步最多处理 `--max-days` 天（默认 31），结果 `pending=true` 时重复调用以续跑。GUI 自动接续；cron 每次调用沿用已保存的进度。未指定起点时沿用该账号的普通同步进度，首次默认最近 14 天。这个默认范围不能证明涵盖设备账号全部历史。

普通同步完成请求范围后，后续调用重查最近 14 天。使用 `--history` 时必须同时指定单个来源、`--account`、`--since` 和 `--until`；历史任务按账号和日期范围独立续传，完成后不回绕，不改变当前增量账号。查询和断开也可用 `--account` 精确选择账号，省略时查询所有账号、断开当前账号。更早的晚到数据或修订需用 `--restart --since … --until …` 发起回查；**只在第一批传 `--restart`**，后续移除该选项继续。普通同步指定不同起点会开始该范围的回填。Apple 只能通过 `health-import FILE` 显式增量导入。

失败不推进当前窗口，重试会从已持久化位置继续；权限不足的集合保留旧数据并记录缺口，其他集合继续。成功完成的空集合会替换该窗口旧成员，表示 API 本次返回为空，不证明设备从未测量。`complete` 说明当前批次质量，`pending` 说明是否还有日期待采；两者需一起判断。CLI 完成返回 0，执行失败返回 1，独立后端参数错误返回 2，数据覆盖不完整或部分失败返回 4。

预览 Apple 会实际解析临时副本，显示变化而不改写 Vault 或来源记忆；厂商预览仅显示拟采集日期，不发送 API 请求。上游 Apple 文件仍需更新，本插件不触发手机导出。

独立后端也提供相同命令：

```sh
cargo run --manifest-path plugins-src/health-sync/backend/Cargo.toml -- health-status --vault "/path/to/vault"
```

独立后端的 `connect --source garmin|oura --credentials-stdin` 从 stdin JSON 读取 `api_key` 和 Garmin `region`（`china` / `global`，省略为国际区），或 `client_id` / `client_secret` / `redirect_uri`。通过安全的凭据工具送入 stdin，避免写入 shell 历史；日常推荐窗口连接。宿主不暴露这个需要 stdin 的命令。

## 存储与恢复

输入先复制到临时文件并校验，流式解析到临时 SQLite，验证完成后在持久 SQLite 事务中更新。失败回滚已提交记录；附件以内容摘要命名。API 仅完整成功的集合替换指定日期窗口，缺页、HTTP 失败、非法数据不激活半份结果。厂商按账号/来源/集合/记录 ID 去重，无 ID 时按完整内容去重。资料库共用写锁，同一台机器上多个 Vault 绑定同一资料库也不会并发写入。

全部入口只使用当前外置 SQLite 资料库，不读取旧 Vault 归档、不推测旧账号归属、不转换旧文件、凭据结构或同步游标。旧格式明确不支持；需要数据时重新选择原始导出文件导入、重新连接账号。升级代码不会删除已有磁盘文件。

验证时可用绝对路径环境变量 `NOTEMD_HEALTH_STATE_DIR` 隔离运行状态，无需修改 `HOME`；它不改变钥匙串凭据的保存位置。

本机 `~/Library/Application Support/net.notemd.app/health-sync/<vault-hash>/` 保存资料库绑定及操作状态，凭据仍在钥匙串。API 游标按资料库身份隔离，更换库不会沿用上一库的进度。磁盘离线或身份不符会停止，不回退到 Vault、不重建空库。切换路径不自动移动数据；恢复或备份需要保留完整资料库及附件。只让归档机器写入原始库，其他设备通过 Vault 同步最终报告。

XML/input 上限 64 GiB，单条记录/token 16 MiB；按内容识别的 CDA 文档上限为 64 GiB，其他单个 ZIP 附件 256 MiB，附件总量 64 GiB。XML 根节点探测限于前 1 MiB，支持 Apple 导出中的 DTD 和注释前导；读取大文档时不将整份文件加载到内存。超限明确失败，不静默跳过。解析和预览都需要临时磁盘空间。中断后重新执行；数据库是持久事实源，不是可清缓存；损坏应恢复完整备份，不能随意删除。

## 开发与验证

```sh
npm --prefix plugins-src/health-sync test
npm --prefix plugins-src/health-sync run check
npm --prefix plugins-src/health-sync run build
cargo test --locked --manifest-path plugins-src/health-sync/backend/Cargo.toml
cargo clippy --locked --manifest-path plugins-src/health-sync/backend/Cargo.toml --all-targets -- -D warnings
```

使用合成导出、协议 fixture、宿主 stdio 契约和 DOM 交互测试验证。SQLite 改造的真实 Apple/Garmin 验证结果见本次任务验收记录；Oura 真实导出包的开发验证见 [验收记录](../../docs/superpowers/reports/2026-10-30-health-sync-oura-export-verification.md)；本次不覆盖钥匙串授权弹窗、应用内 WebView 或 Intel 实机。发布状态见仓库 `docs/superpowers/reports/`，工作区通过测试不代表已进入市场安装包。

数据结构及扩展约束见 [DATA_MODEL.md](DATA_MODEL.md)。
