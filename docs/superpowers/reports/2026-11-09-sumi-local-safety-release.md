# Sumi 本机写作可靠性发布验证

宿主 **6.1109.1** 与插件 **Sumi 0.1.6** 已发布，必要的完整回读与签名门禁通过。公开宿主目前为 macOS Apple Silicon；插件最低宿主为 `>=6.1109.1`。

## 冻结来源与实际产物

- 宿主 tag `v6.1109.1`：`4b3de21a0afef6c689cecadc9a2dadf0d4d57121`；[正式发布页](https://github.com/wizlijun/note.md/releases/tag/v6.1109.1)。
- 插件准备及原生构建：`3fd7b1da9fd32aeeab66267fb341ac1d175c7ea1`。原生 receipt 的完整源码哈希集合与最终宿主 tag 实际源码相同。
- 独立修复提交 `85d2b490` 集成为 `a173dbcf`；既有远端 `e388aef0` 的 Cmd/Win/Super+Enter 全屏一并包含。未带入尚未提交的聚焦视觉、状态隐藏或本地 Rich YAML 工作。
- 宿主 DMG：**14,286,835 bytes**；updater tar：**14,361,439 bytes**。Sumi 包：**2,463,938 bytes**。完整 SHA 与公开 asset ID 记录在[精简机器可读证据](2026-11-09-sumi-local-safety-release.json)。

## 已验证

最终源码、host journal/durability 清单、native receipt、实际隔离签名原生进程探针、Apple 签名/公证、arm64 架构、宿主 UI 嵌入、无插件字体大载荷、DMG/app/updater 一致性以及冻结公钥验签均通过。GitHub draft 四资产完整下载，与本地产物及 GitHub digest 全部一致，下载的 updater 独立 Minisign 验证通过。

宿主公开 REST 通道四资产均完整匿名下载，大包全部范围组装并校验完整 SHA；公开下载的完整 updater 验签通过。最终配置中的实际 updater 端点完整 manifest 与 6.1109.1 一致，使用最终 tag 公钥对公开完整 tar 复验通过。普通 browser URL 的完整门禁**未通过**：首轮已完整取得 manifest、DMG、tar，但签名请求失败，后续请求出现 HTTP 504。此限制保留，不以 REST 成功冒称普通 URL 全部成功。

插件沿原 Wrangler 3 / Account API Token 流程上传 R2 包与签名；原 publisher 在更新索引前完整回读 normal/fresh 两套包与签名并验签。发布后独立审计重新检查这四份保存对象的精确字节、长度、SHA、Minisign 与完整 ZIP inventory，并只读回查权威 KV、普通及 fresh 公网索引。三者与候选索引精确一致，条目由 **303 → 304**，只新增 Sumi 0.1.6，历史条目不变。独立审计没有再次联网下载插件包，也不声称存在未执行的发布前独立回读步骤。

## 数据与验收边界

后台 SQLite CRDT 主库原本已经存在；本次新增的是输入确认前的独立 `host_input_journal`，并修复原子文件观察、投影异常不阻断本机正文、精确回执重放与未持久草稿保护。它不等于新增完整历史撤销，也不承诺任何环境下绝对零丢失。

[功能及隔离测试报告](2026-11-09-sumi-local-safety.md)保留代码验证范围。没有物理断电实验；复现的正常投影竞态不能证明用户现场旧文件对的实际来源。本次产物验证不冒称物理输入法验收或其他平台发布；没有安装应用、覆盖用户 Vault，报告不含正文、恢复数据库、凭据或巨大原始日志。
