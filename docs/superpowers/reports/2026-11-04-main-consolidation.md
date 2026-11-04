# 2026-11-04 main 全量整合与清理

用户授权将本地全部代码整合 main、推送 GitHub，并清理分支和 worktree。本次不发布新的安装包或插件。

## 整合范围

起始远端 main 为 `0efcc93514017f6040e902531fc03832d53b1ea3`。普通 merge `740e1311`、`dbcd2cf2` 纳入 `main@34368ddc`、`feat/quick-launch@041694d5`、`release/health-sync-0.2.2@0738da45` 的完整历史，所有起始分支头均为整合提交祖先。

- Health Sync 0.2.1/0.2.2 的 Oura 真实导出解析、localhost 回调、stress/ring_configuration scopes、401重新授权提示与发布记录此前仅在独立分支；现完整进入主线。运行时及测试逐字等同0.2.2发布分支，manifest保留主线更新的德/日描述。
- NEXT组合按钮与空泳道、Quick Launch及Rich删除修复此前已精确移植。合并保留更新的main实现、已发布版本和日志，不重复轮转版本。
- 当前10个Agent Rust dirty文件的生产行为已由主线`ecfac4be`覆盖，保留v3/terminal-result实现；追加5个文件的独有容量保护回归和Codex真实detached runner测试。Claude实际run_status生成跨语言fixture：响应status为capacity，磁盘RunRecord仍为error以兼容旧reader。
- 当前7个NEXT dirty文件逐项迁移：保留后台错误去重、失效结果视图关闭、任务隔离与文件归属保护；复用主线statuses契约。显式workspace快照刷新路径映射，当前任务身份优先于旧run路径；损坏文件同时归属路径owner与声明UUID，冲突时间戳保持稳定。原strict_readonly/Claude1.0.34入口已由v3协议能力和多语言更新提示替代，保留主线整数秒floor，不回退旧协议。补充原dirty有价值的客户端/组件测试。
- 六份未跟踪Agency/Habitat设计文档入库；两份的私人邮箱、绝对路径与个人案例做最少匿名化，原件完整留在本机忽略目录。另四份逐字保留；设计不冒称已实现产品。`.pnpm-store`仅为本机缓存，保留并加入忽略。

## 三份历史stash

逐hunk并检查第三父树，确认无独有缺失功能；不原样复活过时实现：

| stash | 当前覆盖 |
|---|---|
| `7168eb9a`（NEXT/Windows） | NEXT多项目标签/推荐由`999820ae`完整集成并增强；Windows分页5个文件与`200d33af`逐字一致，后续泛化为多平台解析。第三父树3个未跟踪文件也已包含。 |
| `240fdc4c`（Roam/outline） | `c35eb834`、`50ecabae`、`7e4a6c93`覆盖空bullet/续行转义/跨语言golden；保留之后CRLF修复。 |
| `a904adce`（v1插件日志） | 文件与`a3f1ff91`逐字一致，已合入；`7da2da81`退役v1。现v2 runtime共享stderr日志实现保留，不复活旧API。 |

清理前保存before.bundle、显式含三份stash的stashes.bundle、工作区patch、全部原文件tar及逐文件SHA。备份均位于本机忽略目录`tasks/main-consolidation-20261104/`，不上传私人原件。

## 验证

- 宿主：412文件5354测试通过；svelte-check 0错误、31项既有警告。
- NEXT：45文件860测试通过；svelte-check 0错误0警告；生产Vite构建通过。包括组件UI交互、冲突恢复、重复错误提示、两任务并发结果隔离、文件变化竞态及真实Rust响应消费。
- Agent后端：core173、Claude140、Codex102+真实runner1、DeepSeek149，共565通过，5项既有需要真实harness的测试忽略。
- Health Sync：UI102、后端162通过，2项既有真实外部服务/百万数据测试忽略；类型检查通过。
- Roam后端261通过，1项真实图测试忽略；宿主大纲+官网6文件197通过（已包含在宿主总数，不重复累加）。
- Task/Reminder协议69/69通过；独立分支、stash、Rust及NEXT审查无阻断；diff whitespace检查通过。

首次宿主测试因工作区外依赖软链被Vite拒绝、默认stable无cargo组件失败；改用本机APFS依赖副本和已安装Rust1.99.0后全量通过。测试存在既有happy-dom本地CSS请求诊断，但没有失败测试。一次从根目录直接调用Vite未执行share前置构建而中止，不作为宿主构建证据；本任务仅声称NEXT生产构建，不声称重新构建/发布宿主。

未使用真实Agent提供商、正式Vault或真实健康账户。此轮UI证据为组件交互测试；前次Rich真实macOS验收及6.1102.1发布证据仍在原报告。

## 清理验收

仅在精确提交推送成功、回读GitHub main SHA一致后，移除已合入的本地/远端非main分支、三份已覆盖stash和临时整合worktree。原主目录切回main，保留原缓存、忽略的本地任务记录和备份。最终结果与SHA记录在本机`completion.json`及后续提交说明中。
