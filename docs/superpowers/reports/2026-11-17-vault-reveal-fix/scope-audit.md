# Vault 显示修复：6.1117.1 发布范围审计

审计日期：2026-11-17。基线：`main` / `5954dbbd25ea81297330bec518d55ab518ca856a`。目标：用户反馈 v6.1116.1 欢迎页和设置中的 Vault 显示操作权限错误后，修复并重新发布 Apple Silicon macOS 版本，沿用固定批准的 Fcitx5 companion。本报告不证明 6.1117.1 已构建、公证、公开或安装。

审计计划：重新枚举全部登记 worktree、本地分支未合入提交和 stash 三父树；对照 [11 月 16 日范围审计](../2026-11-16-vault-release/scope-audit.md) 核变化；比较上一冻结发布 tag 与当前主线源码；确认批准 companion。本次仅新增本文，不修改产品、分支、stash 或发布状态，不提交。

## 上一发布与本轮提交范围

重新回读远端 `v6.1116.1`：annotated tag object `901f66cd94842bbc028c028ce3f892eb2f996c07`，peeled commit `5d57fc6f73464334043bbab8001204c84c226d4f`，与本地一致。GitHub REST 回读为 draft=false、prerelease=false，公开时间 `2026-11-16T16:15:56Z`。[正式发布页](https://github.com/wizlijun/note.md/releases/tag/v6.1116.1) 的六附件身份仍与受控 [发布验收](../2026-11-16-vault-release/README.md) 一致。本次仅回读元数据，不重复声称已经对所有旧附件完整下载。

`git log v6.1116.1..main` 精确包含三条提交：

| 提交 | 内容 | 本轮判断 |
| --- | --- | --- |
| `7304c8e1` | 记录 6.1116.1 实际发布、公证、冻结源码、附件及公开回读证据 | 发布历史文档，无新增产品行为。 |
| `7cb77116` | 删除上述发布报告末尾空行 | 文档修正。 |
| `5954dbbd25ea81297330bec518d55ab518ca856a` | 修复两个 Vault 显示入口并补充测试、规格、双语日志、修复说明 | 本次唯一产品修复。 |

远端 `refs/heads/main` 本次回读也是 `5954dbbd25ea81297330bec518d55ab518ca856a`，已推送。主线与旧冻结 tag 的实际产品差异仅为 `DesktopVaultSettings.svelte` 和 `VaultOverview.svelte` 的 import 与按钮调用从 `openPath` 改为 `revealItemInDir`。使用完整绝对路径定位并选中目录，`~` 仍仅用于展示。

修复提交共八文件：两组件、对应两测试、双语 CHANGELOG、Vault 设计规格、修复 README。未改 Rust、权限 capability、依赖锁文件、插件实现或 companion 批准清单。已对 `src-tauri/capabilities/default.json`、`scripts/release-companions/fcitx5.json` 及根/Rust/pnpm 锁文件运行旧 tag 对当前 main 的差异检查，结果无变化。没有为方便显示目录扩大 open_path 路径授权。

双语 Unreleased 区均已有明确修复条目。冻结 6.1117.1 时须由主线程迁入对应版本，并核对两个新调用存在于冻结源码与实际嵌入资源。

## Worktree 与未提交文件

`git worktree list --porcelain` 只有 `/Users/bruce/git/mdeditor`，main / `5954dbbd…`。写本文前 `git status --short --untracked-files=all` 仅有下面两项，没有未跟踪文件：

| 文件 | 实际差异 | 决定 |
| --- | --- | --- |
| `searchidx/src/store.rs` | 既有末尾换行移除 | 保留，不纳入本次构建源码或提交。 |
| `src-tauri/src/smart_lookup.rs` | 既有末尾换行移除 | 保留，不纳入本次构建源码或提交。 |

本文本身是新增未提交证据；不能因此称主工作区完全 clean。其他并行发布证据和后续版本冻结由主线程收口时再核。

同时重新核对已知独立 clone（不是主仓库新 worktree）：

| 位置 | 引用与状态 | 范围判断 |
| --- | --- | --- |
| `../mdeditor-sumi-ime-host` | 单 worktree；`release/sumi-ime-macos-6.1110.8` / `7437e6feddb0218c8bf42cc5b6cb17903d5954e5`，另 main / `5908e8b1d0d05c58fa2cc1a195161f240d8d2134`；clean，无未跟踪文件，无 stash | 两引用重新确认均为当前 main 祖先，无额外漏发功能。 |
| `tasks/vault-release-20261114/source` | 单 worktree；main / `5954dbbd25ea81297330bec518d55ab518ca856a`；clean，无未跟踪文件，无 stash | 已同步本次修复，仍使用原独立发布 clone。 |
| `tasks/vault-release-20261116/source`、`tasks/vault-release-20261117/source` | 审计时无这两个 Git clone | 不能将这些任务目录误认作额外发布分支。 |

## 全部本地分支的未合入提交

主仓库共五条分支：main 与下列四个历史 release 分支。重新运行 `git cherry -v main <branch>`，结果与上次一致；没有新增未合入产品分支。

| 分支与 HEAD | 非祖先提交：等价 / 非等价 | 实际功能核对与决定 |
| --- | --- | --- |
| `release/capture-plugins-20261111` / `93a8253490c7e649cceb4108c11c22d747192e32` | 0 / 1 | 原三捕捉插件冻结。前轮已核 Apple Notes/Roam manifest 语义相同，Health Sync 主线说明较新；版本已在主线。相关文件本轮未改，历史 `plugins-capture-20261111` 及受控发布报告仍提供发布证据。保留，不重发插件。 |
| `release/plugins-20261111-create` / `b88edb93c5c09611ad9d888177b3814ce2ab3d64` | 0 / 1 | Idea Spark 1.3.9 已在主线，旧 Sumi 0.1.15 已被主线 0.1.16 替代。前轮逐字核对结论仍适用，相关文件未变。保留，不回退或合入旧准备快照。 |
| `release/sumi-20261111` / `a56e861dd71708feb98a623a50dc45bd73b8300d` | 12 / 4 | 聚焦、全屏、候选区、字体、云回声持久身份等功能已等价纳入。四条非等价仍为 `5e197ce4`、`6d9233a0`、`23e4ad11`、`a56e861d`，属冻结版本、说明及品牌上下文差异；历史 v6.1111.1 已发布。保留，不重放。 |
| `release/writing-groups-20261111` / `c4d39ddff04296f66ec80ae72459bb9c8ce2d15f` | 16 / 7 | 除上述四条，另 `ad535d04`、`444c24f3` 分类整合上下文及 `c4d39ddf` 版本冻结。再次逐字比较分类生成器和分类模块及其两测试，四文件与 main 相同。历史 v6.1111.2 已发布。保留，不回退。 |

四分支 HEAD 与非等价提交集合都未变。判断继续使用前轮补丁等价、实际源码和受控历史发布证据，未把“不是 main 祖先”直接当作漏发。市场插件本轮不重新发布。

## 唯一 stash 的全部三父树

`stash@{0}` / `03d8a9ff3cc5c25552040fda41a2531ee3c1ac5c`，说明 `On main: codex-before-git-pull-2026-11-10`。三父提交仍为：基线 `2a1b2a120b5d17230ee2d5f0e15955a04df7f1e1`、index `ebea208d352bf5ada631762ea4ea5d5e61b76b7a`、未跟踪树 `9d1bdc31289fc678e73a42c984b8d48cb297962e`。

重新枚举的受跟踪文件共 17 个：

- `CHANGELOG.md`、`CHANGELOG.zh-CN.md`、`docs/superpowers/specs/2026-11-07-immersive-write-design.md`
- `plugins-src/write/src/contract.ts`、`plugins-src/write/src/main.test.ts`、`plugins-src/write/src/main.ts`、`plugins-src/write/src/style.css`
- `scripts/sumi/build.mjs`、`scripts/sumi/native/build.rs`、`scripts/sumi/run-native.mjs`、`scripts/sumi/verify-release.py`
- `searchidx/src/store.rs`、`src-tauri/src/smart_lookup.rs`、`src-tauri/src/sumi/mod.rs`
- `tauri-plugin-native-editor/build.rs`、`tauri-plugin-native-editor/native/editor.m`、`tauri-plugin-native-editor/src/lib.rs`

第三父树两文件：`tauri-plugin-native-editor/native/focus-probe.m`、`tauri-plugin-native-editor/native/focus.h`。哈希和全部文件集合均与前轮一致。

stash 属早期 Sumi 聚焦、安静通知与构建输入草稿，加原 EOF 修改；核心功能提交 `710c148c` 本次再次确认是 main 祖先，相关实现已有后续修正。整份 stash 不能声称逐字已合入，也不属于本轮 Vault 显示修复。保留，不应用、不删除。

## 批准 companion 与排除范围

本轮沿用 `scripts/release-companions/fcitx5.json`：Fcitx5 for Sumi `0.5.0.15`，darwin-aarch64，文件 `Fcitx5-for-Sumi-0.5.0.15-arm64.pkg`，61,312,645 bytes，SHA-256 `f75d72fa51efa50d09412b956453a0f36f59ced8a47f501bab148867f10c4299`，源提交 `2f561d84463a225f89acd1cf6f9e561c575642da`，App 已公证、pkg 自身未签名。

本次实际重读 `~/Downloads/Fcitx5-for-Sumi-0.5.0.15-arm64.pkg` 的大小和整文件 SHA 与批准清单完全一致；v6.1116.1 远端附件元数据也返回相同大小和 digest。批准 JSON 与上一发布 tag 无差异。

继续排除同名但不同哈希的 `fcitx5-v0.5.0.15-build.20261115` 测试预发布：前轮已核其 61,310,388 bytes / SHA `53b1b9d89ed3440c031f458083fba90e759ff8f8637a412ddd401b9a6cbe372c`，manifest 标明未公证。它没有变成本轮批准 companion。最终新发布附件仍需经现有暂存和发布门禁完整回读；本次不变更批准元数据，不重发市场插件，不更新 Intel/Windows/Linux。

## 修复证据与验收边界

已读取最终提交和本地原始测试摘要：`tasks/vault-reveal-fix-20261117/red.log` 为旧产品实现配最终测试，6 failed / 16 passed；`green.log` 为修复后的四文件，35 passed。测试使用真实 opener/core JS SDK 与官方 mockIPC，断言命令 `plugin:opener|reveal_item_in_dir` 和完整绝对路径数组；覆盖空格/中文目录及失败后错误提示/状态恢复。capability 保持既有 `opener:default`，产品修复没有新增授权。

这些结果证明回归测试区分旧错误调用和新调用，不能替代实际发布 App 的原生 WebView/Finder 端到端验收。本范围审计没有重跑测试或启动用户 App；生产 build、Svelte 检查和实际插件权限源码核对见本目录 [修复说明](README.md)。最终新 tag / 包内调用、签名公证、实际附件以及公开更新入口必须在新发布验收中另行证明。

## 范围决定

发布基于 `5954dbbd…` 加必要的 6.1117.1 版本冻结；唯一新增产品行为是两个 Vault 入口正确定位并选中目录。原两处 EOF、四历史分支和 stash 保留，均不纳入；固定批准 Fcitx5 companion 保持。本审计未发现需追加合并的相关功能。

本文未提交，由主线程整合。审计结论对应上述读取时点，不能代替发布前对冻结提交和最终工作区状态的最后复核。
