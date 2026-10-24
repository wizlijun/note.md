# Health Sync 0.2.0 发布与本机启动验收

Health Sync 0.2.0 已发布到 note.md 插件市场，本机安装状态为 enabled，原生“健康数据同步”窗口已打开。最低宿主版本为 6.915.1。

## 冻结范围

- 功能提交：`35a035035a9c9a7281d954f969d92bc5b6444445`。
- 版本提交：`dbee0000ce692e7639af912aec6a29564b02eb2f`。
- 已推送 tag：`plugin-health-sync-v0.2.0`，指向上述版本提交；未推送 main。
- 全部 worktree、分支和 stash 已审计。原有七个未跟踪路径及三个 stash 不属于本次发布，保持原样。51 个构建输入与冻结源码逐项校验。
- 包含独立 SQLite 原始资料库、Vault 外初始化、三来源分区、多账号文件/API 增量、Agent 查询 CLI；按要求删除旧版格式兼容及迁移。具体结构见 [设计与验证](2026-10-24-health-sync-sqlite.md)。

## 测试与实际安装包

后端 154 项通过、2 项人工测试忽略；源码 UI 102 项、契约 94 项通过，TypeScript 检查通过。双架构实际包的 UI 各 102 项通过；两包的架构、内容、Developer ID codesign strict 和 minisign 均验证通过。

| 安装包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| aarch64-apple-darwin | 2195519 | `deb1f46e348bf989953ee0c85c3dbc21da5435fa97eebebcff70427a90d582b4` |
| x86_64-apple-darwin | 2331492 | `de245f3e9c94b61a2473b317d64a0982ffd5632c3ad3f57e3fe14981355f6c87` |

实际 ARM 包在隔离目录、禁止网络的环境中读取用户提供的真实导出文件：

- Apple：首次导入 127.148 秒，重复导入 35.017 秒，3,699,445 条记录，129 个文件。重复导入无数据变化；126 个附件逐字节摘要一致。
- Garmin：首次导入 5.232 秒，重复导入 5.921 秒，19,274 条记录，182 个文件。全量记录、249,913 个浮点数精度及 179 个附件校验通过。
- 两个隔离 Vault 均为零文件，导入、状态和查询命令均成功。原始导出文件未修改。
- Oura 仍只验证 fixtures，等待用户真实导出；Intel 包未做 Intel 实机执行验收。

## 发布通道与公网复核

沿用仓库 Wrangler 3.114.17 和 Account API Token，依次上传 R2 双架构包及签名、匿名下载验签、追加 KV 索引，再复核普通 URL 与绕缓存 URL。四个上传命令均退出 0。

[公网索引](https://plugins.notemd.net/api/index.json) 仅新增 `notemd.health-sync@0.2.0`，条目数 272 → 273，历史条目未改变。KV、普通公网和绕缓存公网内容一致，索引 SHA-256 为 `42afc6cb1196b474e683de46d5f1f89fe29afadc5cf1329c32e4a35f59a3be93`。

## 本机运行

通过本机插件市场安装；`notemd --json plugin info notemd.health-sync` 确认为 0.2.0、enabled，并注册十项 CLI 命令。CUA 实际观察到 `plugin://notemd.health-sync/index.html` 的“健康数据同步”原生窗口，Apple、Garmin、Oura 分区及资料库已就绪状态。观察时界面正在处理数据，操作进度条已显示；该观察不作为本机当前导入已完成的证据。启动验收未额外触发导入或 API 同步。

本地完整证据位于忽略目录 `tasks/health-release-020-20261024/`：scope-audit、source-freeze、package-proof、package-ui-proof、public-packages、public-normal-proof、index-verification、accepted-real-summary、accepted-apple-integrity、accepted-garmin-integrity、local-installed 及测试日志。真实数据与凭据未加入版本控制。
