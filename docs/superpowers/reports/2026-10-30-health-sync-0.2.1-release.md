# Health Sync 0.2.1 发布证据

2026-10-30，Health Sync **0.2.1 已发布到插件市场**。Apple Silicon、Intel 包及签名经匿名普通 URL 和绕缓存 URL 回读验签通过；KV 与两类公网索引一致，市场最新版本为 0.2.1。

## 源码与范围

功能提交 `3f80aeac1c3040faba0c3959e616ec0a8be765ee`；冻结发布 tag `plugin-health-sync-v0.2.1`，对应提交 `7695c8e85022a82b42c1b986492caec3fcc70e66`。51 项构建输入逐一与 tag 核对，两个包的 manifest、二进制、UI 与构建产物逐字一致。只发布 Health Sync；一个 worktree、一个本地分支及三个 stash 已审计；17 项其他任务修改、9 项未跟踪项排除，stash 未应用。

修复真实 Oura DSR 分号 CSV、大 CSV 流式读取和缺失集合识别；保留全部原始字符串、原 ZIP 附件、文件解析报告与账号隔离。最小宿主版本仍为 `>=6.915.1`。具体覆盖与未解析类型见同目录 `2026-10-30-health-sync-oura-export-verification.md`。

## 实际安装包验收

- 后端 161 项通过，2 项既有人工测试忽略；类型检查通过。
- 两架构安装包内实际 UI 各 102 项通过；Developer ID、严格 codesign、minisign 与架构检查通过。
- Apple Silicon 实际包在禁网络的隔离状态、资料库和 Vault 上运行用户提供的真实 ZIP：预览、导入、重复、状态、目录和查询均退出 0。
- 解析 32 类集合、2,073,710 条记录；SQLite 共 2,073,711 条，含一条原件元数据；日期为 2025-11-12 至 2026-10-30。
- 预览未写库；重复导入记录数及状态完全一致；SQLite 完整性通过，原件 SHA 未变，测试 Vault 0 文件。
- 独立静态 schema 对照逐条核验 2,073,710 条记录，全部原始字段、嵌套 JSON 字符串、日期、身份、集合覆盖及 90 个文件报告一致；耗时 58.532 秒。
- 双账号独立 CLI 合成增量通过：账号 A 3 条、账号 B 保持 2 条。
- Intel 包验证架构、签名与实际 UI，未执行 Intel 二进制或原生 WebView 实机验收。

真实包预览 48.586 秒，首次导入 69.517 秒，重复导入 91.237 秒。

| 架构 | 包 SHA-256 |
| --- | --- |
| aarch64-apple-darwin | `292dd52934fd78b4d22a8d7481657964ad4e698c66dbacee5c995297bab6349a` |
| x86_64-apple-darwin | `f12299d676c28ebd91a64c789da7c4695226e2ab2037cccd49e41df183561b80` |

构建使用仓库现有 `scripts/release-plugins.sh`、Rust 1.99.0 和原有签名密钥。pnpm 11.7.0 默认的运行前自动安装遇到网络失败，仅终止本次安装进程；重试以 `pnpm_config_verify_deps_before_run=warn` 复用现有依赖并保留状态告警。未修改依赖锁、发布脚本或工具版本，重新检查冻结输入并验证实际包 UI。

本地证据：`tasks/health-release-021-20261030/`。用户原始记录和隔离库不进入版本控制。未安装插件、未修改正式资料库或 Vault。

上传时 Wrangler 的 npm 更新通知查询挂起；经匿名回读确认目标仍未发布，用 curl 获取官方 npm dist-tags 刷新临时通知缓存，停止该次阻塞进程组后由 helper 回读确认对象已落盘，未重复覆盖该对象；后续继续沿用原命令及对象键。始终使用 Wrangler 3.114.17，未升级。普通 URL 下载较慢，将验收器等待时间由 180 秒改为 600 秒、两架构并行；全部普通 URL 最终字节与签名核验通过。

## 发布完成证据

使用仓库既有 Wrangler 3.114.17 和 Account API Token，依次完成 R2 包/签名上传、匿名下载逐字核验及 minisign、KV 索引追加、普通和绕缓存公网索引复核。索引由 295 增至 296，唯一新增 `notemd.health-sync@0.2.1`，全部历史条目逐项保持。

- [市场索引](https://plugins.notemd.net/api/index.json)
- [Apple Silicon 包](https://plugins.notemd.net/api/download/notemd.health-sync/0.2.1/aarch64-apple-darwin)
- [Intel 包](https://plugins.notemd.net/api/download/notemd.health-sync/0.2.1/x86_64-apple-darwin)
- [冻结发布源码](https://github.com/wizlijun/note.md/tree/plugin-health-sync-v0.2.1/plugins-src/health-sync)

发布 tag 已推送并经 `git ls-remote` 确认 peeled commit 为 `7695c8e85022a82b42c1b986492caec3fcc70e66`；没有推送 main 或纳入其他任务未提交内容。

最终索引 SHA-256：`a7c7bd234ef0a73b6a88ee3f9c973c0b995f2c5baeb7b6a78710d34cc5b599c7`。

关键本地证据：`source-freeze.json`、`scope-audit.json`、`package-proof.json`、`package-ui-proof.json`、`run-summary.json`、`real-verification.json`、`cli-accounts/verification.json`、`public-packages.json`、`public-normal-proof.json`、`index-verification.json`、`tag-remote.txt`、`final-scope-proof.json`。
