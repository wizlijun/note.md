# Health Sync changelog

## 0.2.1 — 2026-10-30

- 修复 Oura 实际 DSR 导出使用分号 CSV 时导入失败的问题；支持 BOM、引号内分隔符和跨行字段，保留原始字段文本及嵌套 JSON。
- CSV 改为流式读取，超过 64 MiB 的成员不再阻断整包导入；保留 ZIP 总量、路径、大小和 CRC 校验，JSON 仍限制 64 MiB。
- 补齐温度、步数、动作、日间压力、外部导入心率/步数、心血管细节及平滑年龄、VO₂ 估计、运动会话、时区等 15 类内容识别，离线集合正确归类。
- 返回逐文件解析、未知和空文件情况；未知内容及位置、账单文件完整保留在原 ZIP 附件中。真实 Oura ZIP 验证覆盖预览、导入、重复和逐字段原始值核验，见 2026-10-30 验收记录。

## 0.2.0 — 2026-10-24

- 首次选择 Vault 外的独立原始资料库，禁止重叠路径；磁盘离线或身份改变时停止，不回退到 Vault。
- 原始记录、账号、覆盖及索引改为持久 SQLite，附件保留文件；停止生成巨型 manifest、JSONL 分片及每日摘要。统一使用新数据设计，移除旧目录、旧账号格式及旧同步游标的兼容与迁移逻辑。
- Apple 仅显式文件增量导入，重叠按最大重复重数合并并保留历史；API 同步仅 Garmin/Oura，游标按资料库隔离。
- Oura 增加 CSV/JSON/ZIP 离线导入与显式账号或稳定离线身份，多账号记录与 API 集合分离；真实导出包验收待用户提供。
- 窗口按 Apple、Garmin、Oura 分组，Garmin/Oura 的账号、文件导入、API 增量及历史导入各自集中。
- 增加 health-init、health-storage、health-oura-import CLI；现有 Agent 查询使用 SQLite 筛选分页。默认仅显示数据现状，分析报告由后续 skills 生成。

## 0.1.4 — 2026-10-24

- 新健康归档默认写入 `ssot/health/YYYY/YYYY-MM-DD/`，移除 `data/` 层；摘要和附件按日期组织，已有旧归档继续沿原路径读写。
- Store new archives under `ssot/health/YYYY/YYYY-MM-DD/` without a `data/` layer; organize summaries and attachments by date and preserve existing legacy archive paths.
- 所有导入、预览和同步持续超过 3 秒时显示不定进度条及当前批次提示；跨批次持续显示，结束或失败后自动收起。
- Show an indeterminate progress bar for all imports, previews and syncs lasting over 3 seconds; keep it visible across batches and clear it on completion or failure.

## 0.1.3 — 2026-10-24

- 修复真实 Garmin JSON 中部分长小数在解析/再序列化时产生 1 ULP 偏差的问题，启用精确浮点往返解析，并对归档查询值与原始导出逐字段比对。

- 新增 Garmin 官方导出 ZIP 离线预览和导入，通过区域/profile 身份隔离历史账号；按内容识别活动、睡眠/午睡、日统计、饮水和训练/身体数据，兼容字符串/毫秒日期、嵌套 UUID 和包装数组。
- ZIP 支持分卷追加、稳定 ID 更新与重复幂等，不覆盖 API 数据或推进同步游标；原始文件及未知格式完整保留，嵌套 FIT 暂不解析逐点数据。覆盖区单独显示“导出中有记录”。
- 增加独立 `health-garmin-import ZIP --region china|global` 命令和窗口入口，保留现有 Apple/API 参数含义。

- 对照 Garmin 官方 Python SDK / OpenAPI 补齐对象形式的本地日期及活动 UUID；HRV 缺少日汇总时按请求日归档，保留夜间原始时间。
- Garmin 活动分页遇同一 ID 的冲突内容时停止该窗口，避免静默漏掉修订；一致的重复记录仍只导入一次。
- 按 Oura 官方 V2 OpenAPI 接受心率、戒指电量末页省略 `next_token`，其他集合继续严格校验分页完整性。
- 增加两家生产采集器到归档的集成回归，覆盖账号隔离、附件原字节、重复导入与失败保留。

## 0.1.2 — 2026-10-24

- Garmin / Oura 记住多个账号，可显式切换当前增量账号；新增账号不覆盖当前设置，断开保留历史。
- 增加独立 API 历史导入入口：选择已保存账号与日期范围，按账号续传；当前刷新默认最近 14 天，并兼容续接旧版未完成进度。
- 记录、附件、覆盖和游标按账号隔离，保留各历史账号数据；兼容旧单账号迁移，查询可筛选账号。
- Oura 界面与独立 CLI 的新增授权均按本次授权 ID 确认，切换账号或取消后拒绝过期回调；CLI 标准输入正确保留 Garmin 区域和账号名称。
- 包含 0.1.1 的 Apple 国际化 ZIP / 大型 CDA、中国区 Garmin 及简短 Key 提示；0.1.1 未进入市场索引。
- Garmin 导出 ZIP 本地导入待真实样本适配，本版尚未包含。

## 0.1.1 — 2026-10-24

- Garmin 可选择中国区或国际区；认证、身份核验、令牌刷新和同步固定使用所选数据中心。旧配置默认国际区，归档保存区域以避免跨区账号混用。
- Garmin 设置增加简短 Personal Key 获取说明及中国区/国际区入口。
- Apple Health ZIP 按 XML 根识别主文档，支持国际化及乱码文件名；大型 CDA 流式保存。
- 首次选择 Apple 导出后即可预览，无需先保存导入路径。
