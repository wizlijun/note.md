# Health Sync：中国区 Garmin 认证与设置提示

本轮使用用户明确授权的中国区 Personal Key 做只读测试。Key 通过关闭回显的终端输入进入内存或子进程 stdin；未写入源码、日志、环境文件、Keychain 或 Vault。没有发送修改 Garmin 数据的请求，也没有执行全量历史同步。

## 真实验证

2026-10-24，HTTPS 证书正常验证，禁止跳转或跨区回退，目标为 `personal.connectapi.garmin.cn`：

| 请求 | 结果 |
| --- | --- |
| POST Personal API Key token | HTTP 200，返回合法 JWT |
| GET profile settings | HTTP 200，合法 JSON |
| GET 当天 daily summary | HTTP 200，存在身份核验需要的 userProfileId 字段 |
| GET 活动列表（最多一条） | HTTP 200，存在 ownerId 字段 |
| GET 当天睡眠 | HTTP 200，合法 JSON；不据此断言当天有完整睡眠数据 |

另以生产 Rust `http_client`、`garmin_token`、`verified_subject` 执行真实 smoke test，通过且 rc=0（约 4.3 秒），确认实际 reqwest 请求栈可用。该测试默认忽略，手动执行时仅从 stdin 读取 Key，不输出 Key、token、账号 ID 或健康内容。

## 修改

- 设置新增“账号区域”，明确选择国际区/global 或中国区/china，不根据界面语言猜测。
- 输入框下只显示：“获取 Key：中国区 / 国际区 → Create Key（仅显示一次）。”中英双语，两区链接指向各自官方 Key 页面。
- 区域随凭据保存；认证、身份核验、数据请求、401 刷新使用同一区域的固定官方域名。
- 旧凭据、旧归档缺少区域时保持国际区语义。区域随清单保存，跨设备恢复可识别中国区身份；不同区域即使数字 ID 相同也不能混入同一 Vault。
- README 和插件独立未发布日志同步更新。版本保持开发中的 0.1.1。

## 验证与范围

- Rust：92 项自动测试通过；默认忽略的两个测试中，本轮单独执行真实 Garmin smoke 并通过，百万记录 benchmark 未重跑。
- 前端：28 项测试、TypeScript 检查、Vite 构建通过。
- Rust clippy（all-targets，warnings as errors）、fmt、diff 检查及 release 构建通过；独立代码审查未发现阻断问题。
- 双语 DOM、链接属性与区域选择/状态恢复/切换 Vault 重置已核对。无可用 GUI 浏览器，未宣称原生窗口点击验收。
- 未发布、未安装、未存入用户实际连接配置；本轮结果不代表全量 Garmin 历史数据均已归档。

本机脱敏证据：`tasks/health-garmin-cn-20261024/`。只保留状态码、结构检查与测试日志，不保留响应正文或凭据。
