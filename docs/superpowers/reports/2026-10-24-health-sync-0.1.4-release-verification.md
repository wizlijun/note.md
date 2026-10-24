# Health Sync 0.1.4 发布验收

源码冻结：`plugin-health-sync-v0.1.4` → `d66c7e13f40c13a8b3d1b2cbf983bc7759c3b65e`，tag 已推送。主分支未推送，宿主 FolderView 未进入插件包。

## 本版包含

- `9dd7be14`：所有 Health Sync 导入、预览、当前同步和历史导入超过 3 秒显示不定进度条；跨批次不中断，操作结束清理。
- `ea5e14a2`：新归档默认 `ssot/health/YYYY/YYYY-MM-DD/`，不含 `data/` 层；摘要和附件按日期组织，旧归档保持原布局兼容。
- 0.1.3 的 Garmin ZIP、Apple 国际化导出、多账号和 API 历史导入继续保留。

## 源码及实际包验证

全 worktree、分支、stash 范围审计无遗漏；7 项既有未跟踪路径及3个stash保持原样。46 个冻结输入与 tag/构建目录逐 SHA 一致。双架构包严格仅含 manifest、后端二进制和 UI，5个运行文件；架构、Developer ID 签名、minisign、包内字节一致性均通过。

140 项 Rust 测试通过（2项既有人工测试忽略）；81 项源码 UI 测试、81 项实际包 UI 测试、94 项发布契约测试及 TypeScript check 通过。构建使用既有 Rust 1.99.0 和仓库发布脚本。

实际 ARM 包用用户 Garmin ZIP 在隔离新 Vault 执行完整导入、查询和重复导入：19,274条记录，1,230天，11,900分片；其中19,094健康记录逐分片与旧验收归档一致，180份原始文件内容去重后179条原件路径全部校验一致。所有摘要链接有效，新路径无data层，重导入文件内容/mtime不变，耗时132.856秒。旧格式真实验收归档预览/重复/查询14.056秒通过，内容/mtime不变。两次验收均禁止网络，不修改正式Vault、Keychain、远端健康数据，输入ZIP不变。

UI 的 3 秒和生命周期以实际包 DOM 自动测试验证，尚未完成原生窗口视觉验收；不能将自动测试描述为真机交互确认。

## 发布结果

已发布 `notemd.health-sync@0.1.4`。现有 Wrangler 3.114.17 + Account API Token 上传四个 R2 包/签名对象，全部命令首轮退出0；匿名字节回读及 minisign 均通过。KV只追加一条，271→272；传播后普通及绕缓存公开索引与KV/candidate逐字节一致，既有条目不变。普通四个下载URL再次逐字节及签名核验通过。

| 架构 | 包字节数 | SHA-256 |
| --- | ---: | --- |
| aarch64-apple-darwin | 2185648 | `2a1a1f29a6f9b150939728afa2ed1e5e9c6fd07cd8acd1f4fda458d1cb1af11b` |
| x86_64-apple-darwin | 2319196 | `26d594df9d18170b17774aee0cdc0ccb54d31f895c2aa45c24b33c891c9996eb` |

下载：[Apple Silicon](https://plugins.notemd.net/api/download/notemd.health-sync/0.1.4/aarch64-apple-darwin) · [Intel](https://plugins.notemd.net/api/download/notemd.health-sync/0.1.4/x86_64-apple-darwin)。最低宿主版本 `>=6.915.1`。用户可刷新插件市场更新。

本报告以独立本地提交保存，未push主分支；发布源码tag已push。

本地完整证据：`tasks/health-release-014-20261024/`（私有测试数据与日志不入Git）。
