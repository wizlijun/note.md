# Vault 6.1116.1 正式发布验收

本轮于 2026-11-16 开始，跨午夜继续。版本沿用开始时冻结的 `6.1116.1`，更新日志日期保持 2026-11-16。**发布状态：已正式公开，六附件匿名完整回读及自动更新入口验证通过。用户明确确认发布范围为 `v6.1116.1 mac-arm64-only`。**

## 范围与冻结源码

- 发布 tag：`v6.1116.1`；源码 `5d57fc6f73464334043bbab8001204c84c226d4f`。发布版本提交已推送 main 与 tag，主工作区已快进。
- 包含 Vault 实现 `d56a538f97afe2870085581a5d75eac2624d37f7`：首次可跳过引导、主菜单/托盘单入口、桌面设置与 Git 初始化/同步、受保护的位置更改、欢迎页路径/文档数/总尺寸及 `~` 显示。双语更新日志有对应条目。
- 仅 Apple Silicon macOS；配套采用仓库已批准的 Fcitx5 for Sumi 0.5.0.15，SHA `f75d72fa51efa50d09412b956453a0f36f59ced8a47f501bab148867f10c4299`。其 App 已公证，pkg 本身未签名；没有混入 11 月 15 日未公证测试包。
- [范围审计](scope-audit.md)重新枚举唯一 worktree、四个历史分支、stash 三父树及已知独立 clone。原两处 EOF 改动与 stash 保留，不纳入发布。

## 门禁与 Apple 公证

沿用 `scripts/release.sh 6.1116.1 --arm64-only`，干净独立 clone 为 `tasks/vault-release-20261114/source`，基线 `83638b30`。依赖沿用上轮冻结 73 文件哈希核对的 @moraya/core 安装副本；未重新安装依赖。

- 全量 436 个测试文件 / 5,923 tests 通过；Svelte 0 errors / 31 既有 warnings；protocol artifacts 一致。
- 依赖审计 1 low / 4 moderate，无 high/critical，达到既有发布门槛。Rust canvas 27 项及 mobile_project_config 3 项通过。
- 初始协议检查仍 403；开发者页面随后显示新版协议签发于 2026-10-30、接受于 2026-11-16。同一发布凭证随后恢复服务访问，见 [恢复记录](notary-access-restored.json)。未改凭证或代签协议。
- 使用历史已验证 CLT notarytool 1.1.4 的透传 shim，其余 xcrun 子命令原样转发。首次签名遇 Apple 时间戳暂时缺失，原脚本自动重试后成功，没有降低时间戳或公证要求。
- App Accepted：`32e8cc26-1268-4c7c-abd4-ed9c5da1daba`，见 [Apple 原始结果](app-apple-notary-log.json)与[实际 App CDHash 绑定](app-notary-binding.json)。
- DMG Accepted：`e4e38dcc-9c6e-4e76-b2fd-9894efae4bc9`，见 [Apple 原始结果](dmg-apple-notary-log.json)与[下载 DMG CDHash 绑定](dmg-notary-binding.json)。

## 实际上传附件验证

[完整验证报告](artifact-verification.json)、[六附件哈希清单](host-assets.json)、[冻结源码记录](frozen-source.json)。六附件已从 GitHub 草稿下载回读。

- 44 个相关源码文件与冻结 tag 逐字一致；207 个构建资源在签名 Mach-O 中完成嵌入证明；Vault 43 个前端 token、11 个 native command 及四语文案均存在。
- App 与 DMG 的 codesign、spctl、stapler 全部通过。App Mach-O SHA256：`9a9d7b15b394a034363e9fcef83aa20835c1e4638b5436d4d4397e261a59220a`。
- DMG 中 App 二进制/CodeResources 与候选一致；更新 tar 中全部 7 个 App 文件、权限与链接逐项一致，Minisign 验证通过。
- 公证装订后的 DMG SHA256：`5c708ccd1a071ccb154f8bb705638c3614f55b2eab2a3d66767eed1afeeba847`。
- Fcitx5 实际附件与冻结批准 manifest 的大小、哈希一致。

## 验证边界

没有启动或安装本轮 App，也没有操作正式 Vault。源码功能/组件验收沿用 [Vault 实现验证](../2026-11-14-vault-management/verification.md)；本轮证据证明实际包包含这些实现与资源，并通过签名、公证和文件一致性验证。当前正式包无运行时配置隔离开关，相同哈希原包的原生首次引导端到端验收需独立 macOS 登录账号或 VM，见[隔离审计](native-isolation-audit.md)。不把静态包核验称为原生 GUI E2E。

## 公开与匿名回读

用户在候选核验通过后明确确认 `v6.1116.1 mac-arm64-only`。原 `scripts/release-publish.sh` 在交互终端重新下载批准附件并校验后，输入精确确认字符串，退出 0，返回 Published。

[正式发布页](https://github.com/wizlijun/note.md/releases/tag/v6.1116.1)；GitHub `isDraft=false`、`isPrerelease=false`，公开时间 `2026-11-16T16:15:56Z`。平台为 darwin-aarch64，Intel、Windows、Linux 本次不更新。

[匿名完整回读报告](public-host-full-browser-verification.json)与[更新入口证据](updater-endpoint-verification.json)均通过：

- 六附件共 93,176,757 字节，从公开下载地址匿名完整读取；大文件全部 Range 分片合并后的整文件 SHA-256 与冻结本地资产及 GitHub digest 一致。
- 对完整匿名下载的更新 tar 执行 Minisign 验签通过，Fcitx5 配套包大小/哈希/批准记录一致。
- 冻结 App 配置中的真实更新入口 `https://github.com/wizlijun/note.md/releases/latest/download/latest.json` 匿名 HTTP 200，740 字节逐字等于本次清单，版本 6.1116.1、平台仅 darwin-aarch64。
- 验证前后 tag object、release 和资产身份未变；没有通道 fallback、没有修改远端。验证脚本 fixture tests 10 项通过。

验收脚本一并保存为 [verify-host.py](verify-host.py) 和 [verify-public-host-full.py](verify-public-host-full.py)，本次原始构建日志及完整下载保留在 `tasks/vault-release-20261116/`。已再次核对主工作区原两处 EOF 与 stash 哈希不变。
