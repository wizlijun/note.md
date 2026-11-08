# Sumi 平缓呼吸修复发布记录

宿主 **note.md 6.1108.2** 已于 **2026-11-08 10:11:18 UTC** 公开，提供 Apple Silicon macOS 安装包，Sumi 原生编辑器要求 macOS 13+。[正式 Release](https://github.com/wizlijun/note.md/releases/tag/v6.1108.2)为非草稿、非预发布。**Sumi 插件 0.1.1 已发布到插件市场**，其最低宿主要求为 `>=6.1108.2`；这是宿主 tag 之后的独立插件发布，不宣称宿主 tag 已包含 0.1.1。

## 问题与修复

用户选择「平缓呼吸」后看到常亮。本机公开 `NSWorkspace` API 确认系统 Reduce Motion 为 true；旧代码优先检查该系统选项，静默移除用户选择的呼吸动画。修复提交 `6cf70ac2ca388fbe87c1531421f43082cf0cd15f` 改为由 Sumi 的呼吸/常亮选项直接控制，不修改系统辅助功能偏好。

呼吸仍是 **6 秒一轮、最低 opacity 0.25** 的平滑明暗变化；连续输入和刷新不重启周期。常亮立即停止动画并保持完全不透明，原有竖线尺寸、IME 系统细线抑制和输入期间持续可见行为保留。

## 源码、验证与正式产物

发布 tag `v6.1108.2` 指向 `f427d73aa78e54c9af54d9470804e268a4d30e9a`。[冻结输入](2026-11-08-sumi-breathing-hotfix/frozen-inputs.json)和[来源核对](2026-11-08-sumi-breathing-hotfix/evidence-summary.json)证明三份原生实现/测试文件与已验修复提交摘要一致。宿主 tag 中的插件 manifest 仍为 **0.1.0**。

- [原生回归](2026-11-08-sumi-breathing-hotfix/native-regression.json)：真实系统 Reduce Motion=true，旧 editor 配同一新版 probe 固定失败，新源码通过。13 个 Core Animation presentationLayer 样本覆盖 6.57 秒，opacity 从 0.9551 降至 0.2502，再升至 0.9993；重复刷新保持相位，切回常亮后呈现层不透明。
- 连续输入、程序化 markedText 更新/提交及朝华 32pt raster 回归没有光标缺口或可见系统细线；严格 Clang 检查通过。窗口未显示或激活，属于真实 AppKit/CA 离屏呈现树和像素检查，**不等于物理屏幕测量、真实系统输入法操作或正式 DMG 的完整 UI 复验**。
- 既有正式发布流程完整前端 **422 套件 / 5498 测试通过**，并完成脚本中的其余发布门禁。完整日志留在本机 `tasks/sumi-caret-breathing-20261108/host-release-retry1.log`，不复制含临时上传详情的原始日志到仓库。
- [正式产物验证](2026-11-08-sumi-breathing-hotfix/artifact-verification.json)为 `ok:true`：App/DMG Developer ID 签名、公证、stapler/Gatekeeper、updater 签名、arm64 架构、包内字体/许可/原生桥及完整前端模块核验通过；DMG 和 updater 内部程序与构建候选一致。
- [正式二进制核对](2026-11-08-sumi-breathing-hotfix/native-binary-check.json)确认 `SumiTextView` 与 `updateCaretMotion` 存在，旧 `reduceCaretMotion` selector 已移除。该证明不替代可见动画的运行测试。
- 正式产物验证沿用既有 `scripts/sumi/verify-release.py`，本轮只在任务目录包装器中把硬编码宿主期望版本从6.1108.1参数化为6.1108.2；保留原有全部签名、公证、资源及产物一致性断言，未跳过门禁。

| 产物 | 字节数 | SHA-256 |
|---|---:|---|
| App arm64 可执行程序 | 22067936 | `8771a7c2d236f5bbaffcea29402337f7f6d1857c5f7a5b2392efaf0c7291443a` |
| note.md-6.1108.2-aarch64.dmg | 70215286 | `fe8f4d90dffed1e2a08f21508ad851be399e2f394bf1e0e81cc454d0e67014b8` |
| note.md-aarch64.app.tar.gz | 69979878 | `eb34c8687162f0a53601083672ebf9f694cda5904c4cf5335a1f4da7c5ec75ce` |
| note.md-aarch64.app.tar.gz.sig | 416 | `77f04c64ccc80938b175e1fa188911d572f7bb7c0885ce65ccfd74c961eb221d` |
| latest.json | 740 | `1d121a6e03c0ae9084a80d1f7d16fcb78bd4435d562382a9072531e7dfdf4691` |

公证经历本机 notarytool SIGBUS 和后续上传超时，记录在[去敏崩溃摘要](2026-11-08-sumi-breathing-hotfix/notary-crash-summary.json)。沿既有发布流程重试后，App 公证 `39f68d54-034b-491a-91e6-b2b0ea5a022c`、DMG 公证 `cd3ee40d-b1ca-419f-8f73-2631132ea374` 最终 Accepted。失败或 In Progress 提交没有被当作成功；签名、公证和验签门禁未跳过。

## 公开状态与下载边界

[发布记录](2026-11-08-sumi-breathing-hotfix/host-publication.json)确认既有 `scripts/release-publish.sh v6.1108.2 --mac-arm64-only` 退出码 0。公开前，[四个草稿文件完整回读](2026-11-08-sumi-breathing-hotfix/draft-assets-verification.json)的实际大小和 SHA-256 均匹配本地及 GitHub 摘要。

公开后，[匿名官方 REST 资源核验](2026-11-08-sumi-breathing-hotfix/public-host-api-verification.json)确认同一 tag、四个 asset ID/大小/digest 未变；latest.json 与签名完整下载，DMG/updater 首尾各 64 KiB 返回 HTTP 206，范围和字节与已验完整文件相同。公开签名对完整 updater 的 minisign 验签通过。

**常规 `github.com/releases/download` 入口在最终受限 GET/HEAD 检查中返回 504，未证明通过。** [最终失败记录](2026-11-08-sumi-breathing-hotfix/public-host-canonical-failure.json)保留各入口状态。 官方 REST asset 入口的匿名成功不等同于普通浏览器下载链路或应用自动更新链路端到端成功；大文件的匿名首尾抽样也不称为匿名全量下载。发布本身已公开，但该入口限制应继续如实报告，不能写成所有下载路径均已通过。

## 插件 0.1.1 市场发布与交付范围

- Sumi `0.1.1` 已完成[市场发布](2026-11-08-sumi-breathing-hotfix/plugin-011-publication.json)，最低宿主 `>=6.1108.2`，源提交 `f1bd9bc5f45c7d0ba218675c52655bd5d591008f` 已推送。8080字节包 SHA-256 为 `0db4eb3494facca5a11df18a3ac00b910fc43220cf94483bd91ac4e56a37ed54`。
- 沿用既有 Wrangler 3.114.17 + Account API Token：R2包/签名上传后，[普通与fresh匿名全量回读验签](2026-11-08-sumi-breathing-hotfix/plugin-011-plugin-public-packages.json)通过，再写KV；[最终KV与两组公网索引](2026-11-08-sumi-breathing-hotfix/plugin-011-plugin-index-verification.json)完全相同，只新增 `notemd.sumi@0.1.1`，原299条完整保留，总300条，包括旧版0.1.0。Wrangler写入完成后进程滞留时，先独立回读确认远端字节/索引相等，再只停止本轮对应写进程；未盲目重复上传。
- [插件验证](2026-11-08-sumi-breathing-hotfix/plugin-011-validation.json)：tsc、33项插件测试、97项发布/索引测试、既有打包脚本和固定公钥验签通过。[独立审查](2026-11-08-sumi-breathing-hotfix/plugin-011-independent-audit.json)核对冻结manifest与包、保留历史版本、9项宿主公开门禁隔离模拟。[最终独立公网审查](2026-11-08-sumi-breathing-hotfix/plugin-011-final-independent-public-audit.json)再次验证两组索引与匿名完整包/签名及冻结源码一致。原生修复仍在宿主，须升级并重新启动6.1108.2或更新版本。
- 后续插件发布门禁读取宿主 `latest.json` 普通URL成功，摘要与公开asset一致，[记录](2026-11-08-sumi-breathing-hotfix/plugin-011-plugin-host-gate-endpoint.json)只证明该清单入口恢复；不据此把此前失败的大文件入口或自动更新全链路标为通过。
- 本报告的宿主 artifact verifier 核的是当时已发布的 **Sumi 0.1.0** 包。不能用该结果为 0.1.1 包背书，也不移动 `v6.1108.2` tag 来补入后续插件改动。
- 日志恢复提交 `cda46297` 已将两语各 **19 条**原有 Unreleased 精确恢复；本次版本各 **1 条**呼吸修复和全部旧历史不变。[恢复结果](2026-11-08-sumi-breathing-hotfix/deferred-restore-applied.json)及[幂等复查](2026-11-08-sumi-breathing-hotfix/deferred-restore-idempotent.json)通过，changelog gate 与 diff 检查通过。[保全档案](2026-11-08-caret-deferred-changelog.json)独立于首版档案。
- [发布范围审计](2026-11-08-sumi-breathing-hotfix/scope-audit.json)保留两项既有无关 LF 改动，未纳入发布。本轮原生 probe 不访问用户 Vault，不修改正文、系统辅助功能设置或正式安装的应用。
- 其他平台、VoiceOver、完整物理输入呈现性能和首版报告列出的未验矩阵仍未完成；本热修复没有扩大平台支持或替代这些验收。

本轮构建后已再次清理可再生成缓存，实际可用空间增加约4.78 GiB；1343个受保护产物摘要与Git状态保持不变，[清理结果](2026-11-08-sumi-breathing-hotfix/cache-cleanup-result.json)留证，未重启或覆盖运行中的验收应用。
