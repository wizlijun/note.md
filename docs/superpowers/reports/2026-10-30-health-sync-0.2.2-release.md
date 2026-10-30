# Health Sync 0.2.2 发布证据

2026-10-30，Health Sync **0.2.2 已发布到插件市场**。两架构包与签名已通过匿名普通及绕缓存 URL 回读验证，KV 与两类公网索引一致。

## 问题与范围

新 Oura 开发者门户拒绝 HTTP `127.0.0.1` 回调，只接受 `localhost`。本版将界面、后端省略参数时的默认回调与文档统一为 `http://localhost:8765/callback`。

用户随后报告 `daily_resilience` 同步 HTTP 401。核对用户提供的官方门户授权示例后，补齐原请求遗漏的 `stress`、`ring_configuration` 权限；401 增加固定的重新授权/检查权限提示。保留一次 token 刷新重试、失败窗口不完成及游标不推进。401 不是缺少某个特定权限的充分证据，没有把它当作无数据或自动跳过集合。已有账号须重新授权，普通刷新不会扩大原授权。

使用独立 sparse worktree，从 `plugin-health-sync-v0.2.1` 仅移植原修复 `04052b391bb8dc554c7788cbaa29736195151ef5`，对应发布分支补丁等价提交 `63dccd01`；版本提交 `3cae7941`；新增权限修复 `caa7089ae285ba3f5f0dcf40dea38a200e7b69a9`。最终 tag `plugin-health-sync-v0.2.2` 冻结在 `caa7089ae285ba3f5f0dcf40dea38a200e7b69a9`。旧的未发布回调限定包已标记作废，未上传。

审计所有 worktree、本地分支未合入提交、stash 及补丁等价。Quick Launch、Agent/NEXT 未提交内容、三个 stash 均排除，构建依赖来自 0.2.1 基线；离线导入、解析及 SQLite 存储源码保持不变。最小宿主仍为 `>=6.915.1`。

## 验收

- 51 项构建输入与冻结 tag 逐一 SHA-256 一致，实际包 manifest、UI、二进制与构建产物逐字一致。
- 后端 162 项通过、2 项既有人工测试忽略；源码 UI 102 项通过；TS/fmt/diff 检查通过。两个新增权限/401回归在修复前失败、修复后通过。
- 两架构包分别通过 Developer ID、严格 codesign、minisign 和架构检查；包内实际 UI 各 102 项通过。
- 实际 ARM 包使用合成客户端、独立状态和 Vault，在禁止外网及浏览器启动的沙箱内，省略 redirect 参数调用真实 CLI；验证生成默认 localhost、完整10项 scope、code+PKCE，并通过 localhost 收到合成拒绝回调，按预期退出1、pending清除、未创建账号、Vault0文件。
- 未访问真实账号、未读取真实凭据、未安装更新；真实用户重新授权及同步结果须在更新后确认。Intel 二进制未实机执行。
- 此次未重复大规模 Oura 离线导入；相关解析/存储源码未变，沿用0.2.1真实导出验收，未冒称本包已重跑真实导入。

| 架构 | 包 SHA-256 |
| --- | --- |
| aarch64-apple-darwin | `da087f18008bc4f346aae29ee466bba20379f11db6285024ace8fc7bd09a045f` |
| x86_64-apple-darwin | `6ab817ed467ff7c3697b9275c5d5ed72020ddf2d2a03546f240ca3ab97f1a473` |

沿用仓库 `scripts/release-plugins.sh`、Rust1.99.0、已有 pnpm/依赖和签名密钥；本次进程设 `pnpm_config_verify_deps_before_run=warn` 避免隐式安装。沿用 Wrangler3.114.17 和 Account API Token，不升级工具。用官方 npm dist-tags 刷新其临时更新通知缓存，避免此前启动检查阻塞。

普通包验收器初次从源码移植后有两处 manifest 相对路径错误；仅修本地验收器为包内路径再跑，两个架构102项全通过，产品源码未因此变化。

本地证据在 `tasks/health-release-022-20261030/`：`source-freeze.json`、`scope-audit.json`、`scopes-change-review.json`、`package-proof.json`、`package-ui-proof.json`、`package-oauth-proof.json`，以及对应测试与构建日志。

## 发布完成证据

既有流程顺序完成：R2 四个对象上传、匿名回读字节与 minisign、普通下载 URL 复核、读取最新 KV 并只追加本版本、写前再读检查并发变更、KV/普通/绕缓存公网索引复核。

索引 297 → 298，唯一新增 `notemd.health-sync@0.2.2`；全部既有条目不变。最终索引 SHA-256：`5844b4b09cca28b3d05efda8d47080d506185579a557829ccaa78691271c0715`。

- [市场索引](https://plugins.notemd.net/api/index.json)
- [Apple Silicon 包](https://plugins.notemd.net/api/download/notemd.health-sync/0.2.2/aarch64-apple-darwin)
- [Intel 包](https://plugins.notemd.net/api/download/notemd.health-sync/0.2.2/x86_64-apple-darwin)
- [冻结源码](https://github.com/wizlijun/note.md/tree/plugin-health-sync-v0.2.2/plugins-src/health-sync)

发布 tag 已推送，发布证据单独提交至 `release/health-sync-0.2.2`；没有更新原工作区分支、main、其他任务文件或 stash。原工作区 HEAD/分支/所有26项dirty文件SHA及三个stash提交均与发布前一致。本轮未安装插件，不声称已完成用户真实账号同步。

公网投递证据为 `public-packages.json`、`public-normal-proof.json`、`index-verification.json`、`tag-remote.txt`；原工作区保留证据为 `workspace-before.json` / `workspace-after.json`。临时工作区删除后保留本地签名包和验收记录，源码由发布 tag 与发布分支保存。
