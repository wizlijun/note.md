# Health Sync 0.1.3 发布验证

冻结 tag：`plugin-health-sync-v0.1.3`，源码提交 `c0b8f0b53aea80482dbca131554e42da8e2f39e1`。版本准备提交对应源码与实际安装包核对通过，tag 已推送；本轮仅发布 Health Sync 插件。

## 本版范围

- Garmin 官方 ZIP 离线预览/导入、账号隔离、分卷累积、原件保存和浮点精度修复，包含 `5f05d682`。
- 包含此前未发布的 `f0794797` Garmin 对象日期/UUID/HRV/分页修复及 Oura 可省略末页游标修复。
- 0.1.2 多账号/API 历史和 Apple 导入功能保持；FIT 原文件保留，尚未解析逐点数据。

## 源码与实际包验收

- 全部 46 个冻结输入与 tag、构建目录一致，ZIP 成员/CRC/路径/权限检查通过；manifest/UI/binary 与构建产物逐字节一致。
- 版本更新后 Rust 137 项、UI 54 项、发布契约 94 项通过；2 项真实凭据/百万基准测试按条件忽略，TypeScript 与正式双架构构建通过。既有真实数据严格 oracle 和 Clippy/fmt 证据复用，生产源码仅版本元数据变化。
- 双架构 minisign、Developer ID 代码签名严格验证、Mach-O 架构检查通过。
- 实际 ARM 安装包执行真实 Garmin ZIP 预览、重复导入和 CLI 查询，共 14.66 秒，rc=0；原隔离 Vault 全部文件内容/mtime 不变。活动466、午睡160、生物指标240查询数量通过，测试禁止网络。
- 开发验收的 22 集合完整 payload/日期与180原始文件逐字节核对均通过，见 [真实数据验收](2026-10-24-health-sync-garmin-export-verification.md)。不把保留的 FIT 原件计为已解析记录。

## 发布包

| 架构 | 字节 | SHA-256 |
| --- | ---: | --- |
| aarch64-apple-darwin | 2,185,601 | `86018402a37fb643f511e56182daa6c8cf2e31b6a7900c64c74617f79ec0d1e5` |
| x86_64-apple-darwin | 2,318,564 | `d4e535d539aa2269a777900cba1eea23379663cd650db0c6e3441da51103c981` |

## 公网发布验证

沿用仓库 Wrangler 3.114.17 与 Account API Token，依次执行 R2 上传、匿名公网回读/minisign、KV索引写入和公网复核。四个安装包/签名对象与本地签名产物逐字节一致，普通下载URL与绕缓存URL都通过。首次上传工具已完成但进程滞留，先确认目标公网字节一致后仅回收该次自有进程组，随后步骤正常退出；未更换工具版本或发布渠道。

市场索引仅追加 `notemd.health-sync@0.1.3`，270 → 271 条，所有历史条目保持。KV、普通公开索引与绕缓存索引一致；兼容最新版本为0.1.3，最低宿主 `>=6.915.1`。索引 SHA-256：`289dd48042dd9b86c47bf2cea226dc097f8a56143de74aa8c97b6d0691ea6553`。

[Apple Silicon 下载](https://plugins.notemd.net/api/download/notemd.health-sync/0.1.3/aarch64-apple-darwin) · [Intel 下载](https://plugins.notemd.net/api/download/notemd.health-sync/0.1.3/x86_64-apple-darwin)


## 范围审计与限制

发布前逐项核对唯一 main worktree/branch、8 个未推送提交、7 个原有未跟踪路径及3个stash；相对0.1.2插件差异来自上述两个已验证功能提交。宿主/网站等祖先提交不进入插件包，未跟踪文件和stash未改动或打包。源码 tag 推送不等于推送 main。

未连接或安装到其他设备、未执行用户正式 Vault 导入、未触碰真实账号凭据；原生 WebView/钥匙串弹窗和Intel真机未验。0.1.3的observed覆盖不能由旧0.1.2读取，README已说明兼容边界。

私有证据：`tasks/health-release-013-20261024/`；真实数据调试证据：`tasks/health-garmin-export-20261024/`。报告不包含签名下载链接、个人身份或健康原文。

冻结后主工作区出现另一任务的 FolderView、i18n 和宿主 changelog 改动；46 个冻结输入最终仍逐 SHA 一致。这些并行改动保留且未纳入插件包或本次报告提交。
