# Health Sync：Garmin / Oura 官方契约与数据归档验证

2026-10-24。本轮范围为 API 采集与本地归档，不包含厂商官网导出 ZIP/CSV 文件解析、发布或真实 Vault 写入。

## 官方依据

- Garmin 官方 Python SDK 固定提交 `ac111a0ff8e37dfbc24c616fcc27691520c7278b`：[client.py](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/src/garmin_personal_api/client.py)、[auth.py](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/src/garmin_personal_api/auth.py)。现有 Personal API 路径及 ApiKey → Bearer 交换与之核对。
- [Garmin 官方 Swagger](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)：26 个 GET 路径。核对 `ConnectDate` / `ConnectTimestamp`、`GarminUUID`、`HrvChartDTO` 和活动分页；解析后的 JSON SHA256 为 `b9b11dbf68871519e9b98853cbabf82a8a28bcd086dd6f8d1448f80f8f0f81ce`。
- [Oura V2 文档](https://cloud.ouraring.com/v2/docs) 当前引用 [OpenAPI 修订 1.42](https://cloud.ouraring.com/v2/static/json/openapi-1.42.json)，API info.version 为 2.0。下载 SHA256 为 `ea1a896ab0a3163888b29d497b16be7b9a9b37f807bb871843e6794977a32c8d`。
- [Oura OAuth 文档](https://cloud.ouraring.com/docs/authentication)：PKCE、表单 token 请求、单次 refresh token 轮换与现有实现一致。未找到独立官方 Oura SDK，因此本轮依据官方 OpenAPI 和官方示例，不把第三方库称为官方 SDK。

## 修复和复现

1. Oura 心率及戒指电量的 TimeSeriesResponse 仅要求 `data`，末页可省略 `next_token`。旧实现因此中止合法导入；新增回归先失败，修复后通过。其他集合仍严格要求游标字段，非法游标、缺数据和分页循环继续失败。
2. Garmin 的对象日期优先读取 `localDate`，不把 UTC `date` 当成本地日；对象活动 UUID 提取 `baseUUID`。旧实现忽略对象形式的 `localDate` 与 `baseUUID`；回归验证本地日期优先级及稳定 ID 贯通归档。
3. Garmin HRV 缺少可选 `hrvSummary.calendarDate` 时归请求日，完整保留前夜开始时间。旧实现会错误选择前夜日期；回归先失败，修复后通过。
4. Garmin 活动分页重复 ID 若内容不同，整窗口失败；一致重叠仍只导入一次，偏移按收到的原始行数推进。旧实现静默丢弃冲突项；回归先失败，修复后通过。只保存内容摘要，不累计保存完整活动响应。

## 验证

- Rust：122 项通过、2 项按条件忽略（真实 Garmin 凭据 smoke 与百万 Apple 记录 benchmark）。全量测试包括认证、CLI/协议、归档和新增集成验证。
- 新增 `provider_pipeline.rs` 的 4 个测试直接运行生产 collect → NDJSON → Store → query/实际文件链路。覆盖两家分页、原始 JSON/null、日期归属、双账号隔离、Garmin 实际 ZIP 附件字节、重复导入内容与 mtime 不变；缺页/500 不激活半份数据，403/404/422 保留旧集合。
- Garmin 单元回归 9 项及 Oura 单元回归 9 项通过。集成 fixture 的 legacy summary 路由、对象形式 wellness 日期和字符串 HRV 时间均已按各自官方 schema 校正。
- 前端 44 项测试、TypeScript 检查和 Vite production build 通过。没有修改 UI，不宣称本轮新增 GUI 实测。
- `cargo +1.99.0 fmt --check`、`clippy --all-targets -- -D warnings`、`git diff --check` 通过。默认 stable 工具链缺少 cargo，使用本机已有 1.99.0；未安装或升级工具链。
- 本机 ARM64 release 后端构建通过（17.17 秒）；未构建或验收新的 Intel 安装包。
- 独立审查未发现本轮源码阻断问题；发现的 fixture 形状问题已修正并重跑。

## 边界

所有新增测试使用合成数据及隔离临时目录，不读取现有钥匙串凭据，不触碰真实 Vault。此前中国区 Garmin 真实认证/GET 的证据仍在独立报告，本轮没有新的真实 Garmin/Oura 账号全量同步，不能以 fixture 通过替代真实服务验收。厂商官网导出文件的本地导入尚未提供，需要明确样本格式后另行适配。

改动记入插件“未发布”日志；没有发布、安装或推送。本机详细日志位于 `tasks/health-api-contract-20261024/`。
