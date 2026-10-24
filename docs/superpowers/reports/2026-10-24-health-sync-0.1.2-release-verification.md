# Health Sync 0.1.2 插件市场发布验证

发布源为 `plugin-health-sync-v0.1.2`，提交 `85b06d72b03892545f9b573e702a824c4e2ffa8c`；多账号主实现提交 `ef1bd59f0fbf3c74bd9f848f8d504f4cd5e15dc5`。最终 tag 已推送，44 个构建输入逐一与 tag、独立 detached worktree 核对。

## 功能与验证

- Garmin/Oura 保存多个账号、显式切当前，历史可选择另一账号；记录、附件、覆盖和游标独立。旧单账号凭据、归档和已验证旧进度兼容。
- API 历史导入独立于当前刷新，日期范围完成后不回绕。Oura 本次授权确认/取消和独立 CLI 的 region/label 接线均有回归。
- 包含此前 Apple ZIP 国际化名称/乱码根节点识别、大型 CDA、Garmin 中国区和简短 Key 获取说明。
- 冻结源码测试：113 Rust + 44 UI 通过；2 项真实凭据/基准手动测试默认忽略。94 项发布契约、2 项独立 UI 审查探针、fmt、Clippy、类型检查及构建通过。
- 两架构均通过 minisign 和 Developer ID 代码签名验证、ZIP成员/权限/路径/CRC检查及manifest/UI/binary与冻结构建逐字节核对。
- 实际 ARM 包处理真实 Apple ZIP：dry-run 75.482 秒、3,699,445 条记录、rc=0；Vault 和原文件不变。合成国际化 ZIP 导入/重复零变化/分类查询及真实 NDJSON 接口通过。
- 实际 ARM 包以 synthetic 两账号四条记录验证账号隔离、相同provider ID共存、分页、CLI和NDJSON接口；非法历史/account/region参数在鉴权前拒绝，禁止网络、无真实Keychain调用。

## 发布包

| 架构 | 字节 | SHA-256 |
| --- | ---: | --- |
| Apple Silicon | 2,132,395 | `2477fd9469d6b09d880971cbcad2cb40c7fd1e0b9837a518760f6e3e02ab9a83` |
| Intel | 2,261,777 | `411e779158b1e7cf0080d6818b4bcf309fd46d6cebaf4d36890c592faa594f18` |

发布沿用仓库 Wrangler 3.114.17 与 Account API Token：先上传 R2 两架构安装包及签名，再匿名回读比对字节并验证 minisign，最后发布 KV 索引。四个普通下载地址也已独立回读比对、验签通过。

公开市场索引、绕缓存索引和 KV 内容一致；仅追加 `notemd.health-sync@0.1.2`，条目从 269 增为 270，旧条目全部保持。当前兼容最新版本为 0.1.2，最低宿主版本 `>=6.915.1`。索引 SHA-256：`db8c2804f87b652f4eb7b8e563122a038af884efe6b131efc33f2e662ee7426a`。

下载：[Apple Silicon](https://plugins.notemd.net/api/download/notemd.health-sync/0.1.2/aarch64-apple-darwin)、[Intel](https://plugins.notemd.net/api/download/notemd.health-sync/0.1.2/x86_64-apple-darwin)。发布网络超时均先回读目标再以相同对象键重试；未切换渠道。

## 范围与限制

0.1.1未进入市场索引，其旧tag/已上传R2对象保留。0.1.2首次本地候选发现CLI包装层遗漏，未推送tag或上传对象时弃用，修复后才冻结最终tag并发布。

主工作区发布期间出现并行API适配工作；为保证来源精确，本轮从独立worktree构建。并行提交 `f0794797` 不属于此冻结包，未替该任务发布；以本报告冻结源码及实际安装包验收为准，不能按主目录后续版本日志推断已入包。原无关未跟踪文件和3个stash均未纳入。

Garmin官方导出ZIP的本地导入待用户拿到真实样本后继续适配，本版尚未提供。未安装到用户设备、未跑多账号真实API全历史、未验Intel真机或原生Keychain/WebView交互；上述自动化/实际包检查不代替这些真机项目。

私有证据：`tasks/health-release-012-20261024/` 与 `tasks/health-accounts-20261024/`。没有将个人健康原文、API Key或令牌写入发布包/受控报告。
