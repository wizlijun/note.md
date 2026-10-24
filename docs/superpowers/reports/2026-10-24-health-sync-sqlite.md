# Health Sync 外置 SQLite 资料库验收

本次实现首次选择 Vault 外原始资料库、三来源统一 SQLite 存储、Agent 检索 CLI，以及按来源集中组织的 UI。仅开发验证并提交，未发布；市场安装包仍为 0.1.4。新的数据模型说明见 `plugins-src/health-sync/DATA_MODEL.md`。

## 最终行为

- 首次使用原生文件夹选择器，禁止 Vault 本身、内部及重叠父目录；路径别名不能绕过。取消不导入，离线、身份变化或数据库缺失时停止，不静默重建或回退 Vault。
- `health.sqlite` 保存记录、账号、来源、覆盖、附件索引和分组统计，附件保存原字节。没有巨型 manifest、JSONL 分片或自动日报写入 Vault。
- Apple 仅显式文件增量导入，保留缺席历史，相同完整记录使用最大重复重数。Garmin/Oura 支持多账号文件导入和 API 增量，文件集合与 API 集合独立。
- CLI 提供 `health-init`、`health-storage`、`health-import`、`health-garmin-import`、`health-oura-import`、`health-status`、`health-catalog` 和分页 `health-query`。API `health-sync` 仅接收 Garmin/Oura 来源，不再自动读取 Apple 文件。
- Apple、Garmin、Oura 固定分区。Garmin/Oura 各自集中账号、文件导入、当前账号同步和历史导入；独立来源、日期和预览状态，共用运行互斥与超过 3 秒的进度提示。
- 原始记录采用公共检索字段加完整来源内容，保留未知字段、嵌套结构和数值精度。数据库应用标识及结构版本明确，不预建尚无需求的派生时序表。
- 按用户最后要求删除旧目录探测、旧格式读取、旧单账号推断和旧游标迁移。新鉴权状态使用 `auth-v2` 与独立 Keychain slot，允许重新连接账号而不读取、改写或删除旧状态。只支持当前资料库结构。
- 默认仅展示当前数据情况。后续 skills 的日/月/年报告路径为 `health/YYYY/YYYYMM/YYYYMMDD-health.md`、同目录 `YYYYMM-health.md`、年份目录 `YYYY-health.md`；本次未实现 Agent 分析报告。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| Rust 全测试 | 154 通过，2 项原有人工测试忽略 |
| UI DOM/行为测试 | 102 通过 |
| 发布脚本与市场索引契约 | 94 通过 |
| TypeScript / Vite | 通过 |
| Rust fmt / Clippy 所有 targets，warnings 视为错误 | 通过 |
| diff 空白检查 | 通过 |

两项忽略测试是显式提供凭据才能运行的 Garmin 在线测试、额外百万条合成基准；本轮未调用真实账号 API 或修改真实 Keychain。实际 Apple 数据规模超过该合成基准。

回归包含真实 stdio/UI 协议、首次配置及拒绝非法路径、SQLite 查询分页、多账号隔离、Apple 重叠增量、API 完整空窗口与失败保留、附件完整性、重复输入不改写、数据库缺失不重建、多个 Vault 共用同库写锁、切库后记录和游标同库绑定。独立审查发现的 SQLite hot journal 恢复问题已修复，并以子进程中止事务后逐字节恢复旧数据库的测试验证。

## 最终 release 构建的真实文件验证

使用隔离临时 Vault、外部资料库及本机运行状态；未改用户正式 Vault、输入导出包或原有归档。

| 数据 | Apple | Garmin |
| --- | ---: | ---: |
| 记录数 | 3,699,445 | 19,274 |
| 数据库字节数 | 4,237,803,520 | 63,148,032 |
| 资料库文件数（含数据库、身份标记和锁） | 129 | 182 |
| Vault 新增文件数 | 0 | 0 |
| 首次导入秒数 | 110.065 | 5.603 |
| 重复导入秒数 | 33.985 | 5.971 |

均返回成功、重复不增加记录，SQLite `integrity_check` 通过。时间为本机单次测量，不是性能保证。

Apple 对独立原始导出审计核对 3,699,319 条主记录、40,789 个日期/指标分组以及 126 个附件，附件共 1,783,129,238 字节，SHA-256 全部一致。

Garmin 对此前经过原始导出独立核验的归档逐条比较 19,274 条完整记录、249,913 个浮点值的精确 IEEE-754 表示、1,230 天、11,900 个分组及覆盖项，账号和区域一致；179 个去重附件共 98,956,156 字节逐字节及 SHA-256 一致。记录唯一允许差异是附件相对路径布局变化；元数据改用新 schema 1/raw-library。

本机隔离证据目录：`tasks/health-sqlite-20261024/`，包括 `accepted-real-summary.json`、`accepted-apple-integrity.json`、`accepted-garmin-integrity.json`、`source-freeze.json`、后端和 UI 检查日志。最终测试二进制 SHA-256：`6bc0666dd00cb9f309066a6b126ba4fff0f08c320b5eec50d0756ba9fdcf2914`。

## 验收边界

Oura 文件导入通过官方模型字段的 CSV/JSON/ZIP 合成样本；用户尚在下载真实导出包，真包验收待补。Garmin FIT、Apple ECG/路线/CDA 等保留原文件，尚未展开其中采样点；Garmin JSON 中已有的时序数组完整保留在原始对象中。

原生 WebView、文件选择器视觉和 Intel 实机未验收。本轮 UI 通过 DOM/行为及构建检查；合成 Chrome 预览因用户操作而中断后已停止，未操作真实插件设置。
