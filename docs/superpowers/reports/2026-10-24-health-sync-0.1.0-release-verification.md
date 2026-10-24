# Health Sync 0.1.0 发布验收

日期：2026-10-24。状态：**插件市场已发布**。用户在完成多轮细节打磨后，明确恢复签发与发布授权。

## 冻结源码与范围

- 实现提交：`1d2d6a36d83400e947970f2252f27c79b323e23b`。
- 发布准备提交：`dfc64b6f3ca6a269d2009bcdf70f41f9c8299dcc`，补中英文未发布日志、恢复发布状态及 Garmin JWT 仅驻留内存的准确说明。
- 冻结 tag：[`plugin-health-sync-v0.1.0`](https://github.com/wizlijun/note.md/tree/plugin-health-sync-v0.1.0)，指向 `dfc64b6f`，已推送并核对远端引用。
- 发布前已 fetch origin：只有 main 一个 worktree/本地分支，无 stash，无远端领先提交；全部未合入本地提交属于本任务。没有 cherry-pick/重写分支需要按补丁等价核对。
- 用户原有未提交 `CLAUDE.md`、根 README 两份、网站 llms 两份及产品原则文档不属于本次发布，均未提交或打包。主分支提交不作为此刻自动部署入口；冻结 tag 提供远端源码追溯，本次线上变更全部由既有 Wrangler 3 执行。

## 用户点名功能与包内证据

冻结 tag 包含一个 native v2 插件：Apple 完整 ZIP/XML 主体、Garmin Personal/Oura V2 详情补充、每日日清单 SSOT、可读 slug 文件名、完整字段与附件、分类/覆盖浏览及 GUI/CLI 增量续采。两份包内 manifest 与 tag 逐字节一致；二进制与对应 target 构建输出一致，UI 与 Vite 输出一致。

源码最终验证为 80 项 Rust、26 项 UI、77 项打包契约通过，Clippy/fmt/TypeScript/Vite 通过，详见[源码验收记录](2026-10-24-health-sync-implementation-verification.md)。源码验收报告中的“未发布”描述是此前阶段状态，正式发布以本记录为准。

最终安装包单独核对 ZIP CRC、重复条目、路径穿越、符号链接、可执行位、架构、manifest、全部文件集合与 UI 内容。直接解压并运行 arm64 包中的二进制，验证合成 Apple ZIP + GPX 附件、分类查询、XML mixed content、重复导入不改写、每日唯一摘要，以及真实原生 stdio 的 CLI/UI 请求。

## 构建与签名

使用 `scripts/release-plugins.sh health-sync` 构建双架构包。使用用户提供的市场私钥，经签名探针确认匹配客户端内置公钥 `2BAFE555935FE0A9`；没有替换客户端信任公钥或生成其他密钥。

| 架构 | 包字节数 | SHA-256 |
| --- | ---: | --- |
| aarch64-apple-darwin | 2090134 | `7639a2b0c0b52d0dd7a23743fdacf46d28a648258f0e56dd17837e43df133442` |
| x86_64-apple-darwin | 2176032 | `1af1b1e749bcd21b0cbf3f02b39ad628684bc8ddcf8ec197be85cbb6e829472b` |

两包 minisign 验签通过。构建机没有 Developer ID Application 身份，既有脚本记录警告并未添加 Apple Developer ID 签名；市场包 minisign 签名不能称为 Apple 公证。arm64 最终包已实际运行，Intel 包已验证架构与内容但未在 Intel Mac 实跑。

## 线上发布顺序与验证

沿用现有 **Wrangler 3.114.17 + Account API Token**，没有升级 Wrangler、浏览器 OAuth 或其他上传通道。

1. 四个 R2 对象（两包及各自 `.minisig`）上传均 exit 0。
2. 在发布索引前，匿名回读普通地址及带查询参数绕缓存地址：共四次包下载、四次签名下载，全部与本地逐字节一致，并使用宿主公钥验签成功。
3. 既有索引生成器会刷新其他来源 manifest 文案，范围检查发现后排除该副作用；只取健康插件新条目，用同一生成器的 `mergeIndexes` 与刚读取的公网索引合并。268 条现有记录原样保留，仅新增 `notemd.health-sync@0.1.0`，总计 269 条。
4. 使用 Wrangler KV 写入正式 INDEX。等待传播后，绕缓存与普通索引均核对通过：版本、最低宿主 `>=6.915.1`、双架构、包大小/哈希、下载地址、本地化与原有条目全部一致。
5. 既有 Wrangler dry-run 通过后发布市场 Worker，新版本 `1a7a7a10-70ac-4fbc-91a9-0a80d4d313fc`。匿名公网页面与部署源码完整一致，入口“导入健康数据…”及 `import-export` 分类已生效。

公开入口：[插件市场](https://plugins.notemd.net)、[市场索引](https://plugins.notemd.net/api/index.json)。包下载：[Apple Silicon](https://plugins.notemd.net/api/download/notemd.health-sync/0.1.0/aarch64-apple-darwin)、[Intel](https://plugins.notemd.net/api/download/notemd.health-sync/0.1.0/x86_64-apple-darwin)。

## 验证边界与证据位置

没有用户真实 Apple 导出、Garmin Key 或 Oura OAuth 会话，本次没有宣称在线私人账号采集已通过；应用内 WebView 视觉、真实钥匙串授权弹窗及 Intel 实机仍待用户验收。此前完整 Workers 测试因已有 workerd 启动错误不能运行，未升级运行时；本次实际 Wrangler dry-run、部署及公网源码一致性检查通过。

证据保存在忽略目录 `tasks/health-release-20261024/`：`release-scope.json`、`source-freeze.json`、`package-build.log`、`package-proof.json`、`artifact-e2e/protocol.jsonl`、四份上传日志、`public-packages.json`、`live-immediate-before.json`、`publish-kv.log`、`index-verification.json`、`deploy-worker.log`、`page-verification.json`、`remote-tag.txt`。凭据值不进入这些日志或仓库；临时凭据文件在发布完成后清理。
