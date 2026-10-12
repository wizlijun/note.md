# finalfix 后源码增量发行审计（只读，尚未发布）

审计时间 UTC `2026-10-12T17:51:58.228505+00:00` / 台北 `2026-10-13T01:51:58.228626+08:00`。实际 HEAD `2c9f165918297e4b089e3c56c4e876401edfc53d`，main，开始/完成一致；tracked clean；唯一 main worktree=true；原 7 个 untracked 保留。唯一 scoped review 进行中，root 尚未批准发行。本审计确认发行内容收纳与输入边界，不替代 scoped review 或正式发行验收。

只读完成，未构建/推送/tag/部署、未改源码/refs/index/HEAD/凭据/环境，未派子代理。安全 JSON：`release-post-fix-source-audit-evidence.json`；九文件完整实际 diff：`release-post-fix-delta.patch`。本轮没有重跑测试，gate 的执行证据归 finalfix writer/report 与 scoped reviewer。

## 全量发行清单与本次增量

完整基线见 `release-final-source-audit.md` 与其 JSON：正式 tag v6.1012.2 到 `4a2ca1c9` 的 **78 路径 / 41 commits** 已逐项盘点。本次以实际对象重查 `4a2ca1c9d5ff27dc2e6f9809adcbf48fec39ae91..2c9f165918297e4b089e3c56c4e876401edfc53d`，只新增一个 commit：

`2c9f165918297e4b089e3c56c4e876401edfc53d fix(project-share): complete Git review recovery and local-only guards`

实际 **9 文件 +635/−65**，均已经包含在前述 78 路径中，没有新增路径遗漏。因此实际 main→当前正式 tag 汇总为 **78 路径 / 42 commits**，其中 69 产品/测试/构建路径、9 文档/changelog 路径；完整最新 78 路径与 42 个全 ID commits 均重新保存于本次 JSON，旧的全清单加下表即为最终补丁范围。

| 本次实际文件 | 行数 | 行为映射 |
|---|---:|---|
| `docs/superpowers/reports/2026-10-12-project-share-review-merge-p1-verification.md` | +35 / −3 | 追加最终 I1–I4/M1–M2 行为、六项 gate 与兼容性限制；保留历史失败证据，声明 scoped review/发行未完成。 |
| `src-tauri/src/project_share.rs` | +387 / −54 | 加入只读 branch-state 与自有 branch 补记校验；所有 edit Decision 守卫、ref/snapshot/author identity 复核；reject 显式 target 守卫；规范 snapshot 消息；构建候选后拒绝同 tree；真实 Git/Store 回归与独立 author 字面 oracle。 |
| `src-tauri/src/project_share_git.rs` | +89 / −4 | 分享专用统一 Git IO 加 --no-lazy-fetch；新 ensure_changed_tree；partial clone 缺 blob/tree 无 fetch、旧 Git fail-closed、author 字面边界测试。 |
| `src-tauri/src/vault_sync/git_ops.rs` | +21 / −0 | 仅 cfg(test) 线程限定 Git 子进程 shim/环境注入，production run_git_io 行为与 vault-sync 联网语义未改变；原 Memory reconcile 内容保留。 |
| `src/components/ProjectShareDialog.test.ts` | +1 / −0 | mock 支持 branch-state 返回 null，配合新增本机查询。 |
| `src/components/project-review/ProjectReview.test.ts` | +1 / −0 | mock 支持 branch-state 返回 null，配合新增本机查询。 |
| `src/lib/project-share/git.ts` | +1 / −0 | 同 kernel 输出全部 result==current 时，在确认/导出前拒绝空差异。 |
| `src/lib/project-share/review.svelte.ts` | +9 / −3 | B/C 打开时查询恢复自有分支；reject 携 target；canGit 要求 ready/file/proposal，允许无 Decision/not_applied，其他终态继续限制。 |
| `src/lib/project-share/review.test.ts` | +91 / −1 | 补 controller I1 mixed-status、I2 重开仅补记/查询失败切 A、I4 reject target、M2 无确认/picker/ref/save 回归。 |

已逐 hunk 查看生产变化、回归映射与报告修订；各文件 base/HEAD blob、diff SHA256、所有 hunk 头均在 JSON，完整 patch SHA256 `385acdc630f0ab7bc207b9150ca7f2c6bc34bf0fd41389d42501735f4345aebb`。I1–I4/M1–M2 是宿主 P1 修复；没有新增 Worker/plugin/service 代码。Task4 原八文件仍属于前次全清单，本次是其后最小统一修复，不是另一个未收纳分支。

本次值得明确的兼容性变化：分享专用 `--no-lazy-fetch` 让不支持该 option 的旧 Git 禁用 P1 Git 目标并回到 P0；vault sync 正常网络能力保持。旧预览 snapshot 消息 ref 不迁移/覆写；同 tree 的空变更不创建仅署名提交。branch-state 是本机只读接口；payload/merge-kernel/diff/version 的公开协议没有本次变化。

## Memory / Rich 实际内容复核

对 Memory `9a14dd7c` 的 3 文件、Rich `c49b8e66` 的 4 文件分别在实际 post-fix HEAD 与最新正式 tag 检查，合计 **14 项**。使用原 patch 新增非空行在目标源码中的实际保留及原 post-patch blob 对比，所有原新增行缺失数为 **0**。Memory mod.rs/projector.rs 和全部 Rich 文件保持原 blob；git_ops.rs 因后来功能/本次 cfg(test) 有新增而整 blob 不同，但原 Memory reconcile 调用及回归增量全部保留，不能仅按整 blob 不同判缺失。

| 原补丁 | 文件 | 目标 | 实际 blob | 等于原 post blob | 缺失原新增行 |
|---|---|---|---|---|---:|
| 9a14dd7c | `src-tauri/src/memory_control/v2/mod.rs` | post_fix_HEAD | `092e2b342d14f52adafb810b48705a593d8c0281` | true | 0 |
| 9a14dd7c | `src-tauri/src/memory_control/v2/mod.rs` | latest_formal_tag | `092e2b342d14f52adafb810b48705a593d8c0281` | true | 0 |
| 9a14dd7c | `src-tauri/src/memory_control/v2/projector.rs` | post_fix_HEAD | `e016ebf341a656d5785140f107767e0df49e60f6` | true | 0 |
| 9a14dd7c | `src-tauri/src/memory_control/v2/projector.rs` | latest_formal_tag | `e016ebf341a656d5785140f107767e0df49e60f6` | true | 0 |
| 9a14dd7c | `src-tauri/src/vault_sync/git_ops.rs` | post_fix_HEAD | `aca277c238c432da88cf057139c1876b6b2ae125` | false | 0 |
| 9a14dd7c | `src-tauri/src/vault_sync/git_ops.rs` | latest_formal_tag | `a08d90787538cd641f79545e302ce76ac37a769c` | false | 0 |
| c49b8e66 | `src/components/RichEditor.svelte` | post_fix_HEAD | `7f3520adcaaa9c2afa1ddfc4fad1816453ea46fb` | true | 0 |
| c49b8e66 | `src/components/RichEditor.svelte` | latest_formal_tag | `7f3520adcaaa9c2afa1ddfc4fad1816453ea46fb` | true | 0 |
| c49b8e66 | `src/components/rich-editor-anchors.test.ts` | post_fix_HEAD | `29db904ac7e23daba19571c4b20c77de0f232ddc` | true | 0 |
| c49b8e66 | `src/components/rich-editor-anchors.test.ts` | latest_formal_tag | `29db904ac7e23daba19571c4b20c77de0f232ddc` | true | 0 |
| c49b8e66 | `src/lib/rich-anchor.test.ts` | post_fix_HEAD | `7767f36b6be81186d3d42ffb8a23eb4df27f8585` | true | 0 |
| c49b8e66 | `src/lib/rich-anchor.test.ts` | latest_formal_tag | `7767f36b6be81186d3d42ffb8a23eb4df27f8585` | true | 0 |
| c49b8e66 | `src/lib/rich-anchor.ts` | post_fix_HEAD | `dfd11960d280921c3fd4fe9b7342e8e6f8a46600` | true | 0 |
| c49b8e66 | `src/lib/rich-anchor.ts` | latest_formal_tag | `dfd11960d280921c3fd4fe9b7342e8e6f8a46600` | true | 0 |

因此 Memory/Rich 已在 v6.1012.2 正式源码中，本次候选仍保留；这不是仅靠祖先关系判断。

## 远端 refs、旧分支和 stash

fresh `git ls-remote --heads --tags origin`：origin/main `ce070741f2aec8235dfa62b9812c558c3579160f`，相对前次全部 remote heads/tags **无变化**。fresh GitHub latest 元数据仍为 `v6.1012.2`，ID `410168516`，draft=false、prerelease=false，tag 解引用 `e440b38c721450f92abf5947eb1d32912e851d48`。本地 ref 只有 main 从 4a2ca1c9 前进至上述 finalfix；其他 local/remote tracking/tag/backup/stash refs 均未变化。实际远端 main 与候选计数（左远端/右候选）：`0	35`。

| 本地 heads / backup / stash | 实际对象 |
|---|---|
| `refs/backup/before-force-pull/20261012T081941Z` | `b4d139e05fd0ba67ea3efea83171c408ce1bdd8e` |
| `refs/heads/feat/apple-notes-readable-paths` | `2464c1747f1c165a1a4e0e73db638a90393a1303` |
| `refs/heads/feat/roam-research-sync-name` | `43416f9c2da5b0235d7eebf1a0f3129b1bc29908` |
| `refs/heads/fix/habitat-legacy-sync-compat-20261008` | `878656e8c91694484643aeabe88083aa2d263c02` |
| `refs/heads/fix/rich-vault-resource-paths` | `367f4fb3690189e9563b8beb2fdab38f17fafdd1` |
| `refs/heads/main` | `2c9f165918297e4b089e3c56c4e876401edfc53d` |
| `refs/stash` | `7168eb9ab49d429f8e91ebcf2ac1ba9580582402` |

| 远端所有 heads | 实际对象 |
|---|---|
| `refs/heads/codex/idea-spark-1.3.2` | `f76651e8283e2832c345d760ebdc2c662075f524` |
| `refs/heads/cursor/setup-cloud-agent-env-35fe` | `90b97559bc4a009ee94d68534e83966eec5b1c87` |
| `refs/heads/docs/co-authored-surface-spec` | `26c5c20a6f7929db8636122fdc55e4ed86c3adcf` |
| `refs/heads/feat/assistant-mail-html-preview` | `3732b7e0dfbabf1c34f3e334df761e4b6d366dd6` |
| `refs/heads/feat/decision-log` | `fd3bb41d588aa97f2b2e34cdf16f9655cb7e72b9` |
| `refs/heads/feat/file-view-toggle-navigation` | `29b4844b658851b6be7dd4126a09300ef37d798f` |
| `refs/heads/feat/next-project-article-1.3.0` | `6c46e0b2ed023687e3eda3cb0dbffc799f30c5e3` |
| `refs/heads/feat/next-project-filter-1.3.1` | `eb02d2c48bbdb0df09ffb80c93a74fe37cebbd51` |
| `refs/heads/feat/next-project-tags-1.4.0` | `999820ae349f008631532c25d60c74d92992f497` |
| `refs/heads/feat/note-timeline-unified-release` | `d2f36039ed6cad1d9e76b36a9561b254f0d4701b` |
| `refs/heads/feat/tab-close-menu` | `f953adc0caa979106709f3347c8b3a0e2e248741` |
| `refs/heads/feat/timeline-viewer` | `91ee7f10b1d80178018c642546f3f754201f3416` |
| `refs/heads/feat/typeset-reader` | `5e817075b94bb6860e8965aee91e0e941cce48de` |
| `refs/heads/fix/assistant-mail-vault-key` | `14a507702aa58e905c8ed52b6d7282947fb5b03f` |
| `refs/heads/fix/note-file-view-icon-color` | `da7190894b75b05025d28b95e4decdb6b85d2b0d` |
| `refs/heads/fix/plugin-log-unify` | `d210b943fed6386e7c5806b95f2c4f40a3876a68` |
| `refs/heads/fix/timeline-top-time-offset` | `d533ca2ea3dabcff8d500407b02a30dbaee374e4` |
| `refs/heads/fix/timeline-view-entry` | `6f7de267f3206bfa4e80d391be87b37a034a454d` |
| `refs/heads/main` | `ce070741f2aec8235dfa62b9812c558c3579160f` |
| `refs/heads/release/index-viewer-1.0.2` | `1ce528f3b1775db009f945e742ea8de00ce21a35` |
| `refs/heads/release/timeline-1.0.4` | `bb7bdb217ef1157668f1443abcdd571643f0c7b9` |
| `refs/heads/website/responsive-css` | `e4b52e78cd13171d00e8953fa4a85979bc8a69d1` |
| `refs/heads/windows-x64-port` | `9fce5259820c96ce919090f3ad97e84564b2e9ef` |

全部 tags（含 annotated dereference）保存在 JSON，未 fetch 修改 refs。三个 stash 实际 commit 保留：

- stash@{0} `7168eb9ab49d429f8e91ebcf2ac1ba9580582402`
- stash@{1} `240fdc4c69e1b4789ca1166a95c65b1c7c3999b7`
- stash@{2} `a904adce51b40b26ac46409b232a5ac61ab3216c`

三 stash 的 index/untracked 与 20 文件实际 hunks 继续引用 `release-audit-refresh.md`、`release-refresh-stash-*-evidence.json`；本轮 refs 没变化，所以未重复全文 diff。已等价覆盖或明确退役实现不恢复；旧 Rust bare-dash 单独测试没有逐字保留，不代表产品缺失，现有 `plugins-src/roam-import/src/lib/roam-import/syntax.test.ts:40` 的具名 EMPTY child bullet 更广 TS 用例及第45/46/50/52行断言映射沿用旧报告。force-pull backup/旧 combined 与90b97559开发配置保留 root 的不恢复/不合入裁定。

## Worker、插件、其他 service 与发行配置输入

相对 4a2ca1c9，本次 plugins-src / plugins-registry / dist-plugins、Worker及其deploy workflow、website/其他workflow、release.sh/release-windows.ps1/package.json/pnpm-lock/tauri.conf/Cargo.toml/Cargo.lock 均没有路径差异。当前候选 Worker 与 origin/main 仍无差异。此前 tag→main 的 3 Worker 文件/6优化 commits 已上线，属于完整主分支清单但无需因本次宿主补丁重新部署。26 插件正式版本按 01:30 的匿名索引审计一致，本次源码未改变插件输入。

**本轮没有 fresh Cloudflare/插件 live 接口查询。** 复用实际 API 时刻 UTC `2026-10-12T17:30:20.265849+00:00` / 台北 `2026-10-13T01:30:20.265849+08:00`：Worker deployment `6a2131e6-b32c-465e-aebd-cf4a32f8e141`，version `4b59fa31-c9b1-4619-aeae-c186bed33374`，权重100%；来源 deploy-worker run `38210844417` 成功、head `b2de9a9666affed37c41d525d1a72fdaa95f3aba`，日志 version 与直接 API 一致。仅为当时生产证据，不能宣称为 01:51 新查。正式发行后仍须 fresh 生产复核。

此次范围沿既有应用 release.sh：macOS aarch64/x86_64 的 DMG、updater tar/.sig 与 latest.json 共七资产；没有扩大至 TestFlight/Windows/Worker/plugin 额外发布。最终版本按执行时远端 tags 与当地日期选择；只有实际构建/匿名回读/验签/版本架构公证检查后才能称正式应用发行完成。

## core 精确输入与工作区

兄弟 core HEAD/实际远端 main 均为 `1cb70441f440f50ac4b023857f6d48d5b70eda5a`，tracked/untracked clean。installed package 与兄弟 dist **57 文件 / 2206579 字节**逐文件 SHA256 相等；兄弟 57 个 tracked dist 文件与其 Git HEAD 字节相等，package.json 相等；全部逐文件 hash 在安全 JSON。

统一 dist tree SHA256 `1b656cb331446f6110816b828fb61dae9b25227622836f734922918ac674ec16`，与前次完全一致。当前宿主与 EditorKit 的 @moraya/core 输入没有未提交/未发布变动；file dependency 无法反推旧正式二进制当时实际输入的历史边界保留。本轮未重装依赖、改链接或同步 dist。

唯一主工作区为 `/Users/bruce/git/mdeditor`，main `2c9f165918297e4b089e3c56c4e876401edfc53d`。原 7 个 untracked 精确保留，未读取这些私有业务文档内容、未删除或纳入发行：

- `.pnpm-store/`
- `docs/superpowers/specs/2026-09-23-agency-batch-cli.md`
- `docs/superpowers/specs/2026-09-23-agency-plugin-design.md`
- `docs/superpowers/specs/2026-09-23-agency-practical-review.md`
- `docs/superpowers/specs/2026-09-30-habitat-knowledge-city-design.md`
- `docs/superpowers/specs/2026-09-30-vault-knowledge-structure-extraction-design.md`
- `docs/superpowers/specs/habitat-city.html`

当前 status 的这些 untracked 仍会影响 release.sh clean gate；由 root 沿既有精确 localexclude 裁定处理，不可删文件或大范围忽略以掩盖未知改动。

## 持续保留的验收边界

Worker CPU 既有 small-k archive reseal/status-cleanup 10ms，未满足 strict `<10ms`；representative10/limits10/KV legacy-copy 最终验收不完整。本轮没有重测 CPU、没有线上 fixture；CI 成功不是免费方案验收。finalfix 的 gate 也不能把 native UI/OS picker/iOS 尚未实机验收、P2、访客 rich editor、offline client 宣称完成。既有非法 UTF-8 目录环境限制、search attention 历史偶发失败未定位、warning 继续沿用验证报告边界。

本次源码增量收纳完整；尚待唯一 scoped review 批准，随后 root 执行最终发行门禁及正式发行后的匿名七资产复核。不得将本报告称已发布。


---

# 发行 live preflight（只读，尚未发布）

本轮核验开始 UTC `2026-10-12T17:30:09.255659+00:00`，主体完成 UTC `2026-10-12T17:30:20.265849+00:00` / 台北 `2026-10-13T01:30:20.265849+08:00`；小型匿名 updater 补查完成 UTC `2026-10-12T17:33:43.601608+00:00`。安全证据：`release-live-preflight-evidence.json`。

结论：相对 `release-final-source-audit-evidence.json`，远端 main、正式 latest tag、Worker deployment 均未改变；26 个正式插件版本全部一致；core 的 57 个 dist 输入仍逐文件一致且兄弟仓库 clean。本轮没有发布、部署、构建、下载大包、运行 `verify-release.py`、修改产品源码或 Git refs/index/HEAD。

root 已冻结 finalreview I1–I4/M1–M2，唯一 finalfix 正在 BASE `4a2ca1c9` 上工作。本轮观测 HEAD `4a2ca1c9d5ff27dc2e6f9809adcbf48fec39ae91` 只用于标识审计时刻，**不构成最终源码冻结**。finalfix 完成后仍需重新核对实际 HEAD、远端、正式 tag 和最终源码差异；发行后须对最终实际七资产执行匿名字节、签名、架构、版本、公证验证。

## 正式 Release、远端和七资产

- `git ls-remote` 实际 origin/main：`ce070741f2aec8235dfa62b9812c558c3579160f`。未 fetch/pull/reset/merge。
- 正式 latest：`v6.1012.2`，Release ID `410168516`，draft=false、prerelease=false；published `2026-10-12T05:37:49Z`。
- 远端 tag object `3141f7312793735e55d02839633361271bf549e9`，解引用 commit `e440b38c721450f92abf5947eb1d32912e851d48`。
- 七个预期资产各一份、全部 uploaded，GitHub 均提供 SHA256 digest（完整值在安全 JSON）。本轮仅查元数据与小型匿名 latest.json，未重下七资产，所以不能声称本轮重新完成大包 SHA/签名验证。
- 匿名 updater latest.json：version `6.1012.2`，darwin-aarch64、darwin-x86_64，版本与正式 latest 一致。

| 资产 | 状态 | 字节 |
|---|---|---:|
| latest.json | uploaded | 1314 |
| note.md-6.1012.2-aarch64.dmg | uploaded | 13039587 |
| note.md-aarch64.app.tar.gz | uploaded | 13077337 |
| note.md-aarch64.app.tar.gz.sig | uploaded | 416 |
| note.md-6.1012.2-x86_64.dmg | uploaded | 13708837 |
| note.md-x86_64.app.tar.gz | uploaded | 13674097 |
| note.md-x86_64.app.tar.gz.sig | uploaded | 416 |

最近 10 个 Release 元数据无 draft/prerelease；远端未出现当日本地日期 2026-10-13 的正式版本 tag。没有观察到其他并行发行改变正式远端状态，但这不是跨机器发行锁。最终版本必须以实际执行时的远端 tag 与当地日期选择，不能固定旧的 6.1012.3。

## 插件市场

匿名 `https://plugins.notemd.net/api/index.json` 成功回读，26 个正式插件当前 manifest 版本与线上最高版本一致；测试 fixture 不计入正式数量。无新增版本差异；本轮未回读所有插件大包、未重新验签，也未进行 R2/KV 写入。

| 插件 | 当前源码 | 匿名线上 |
|---|---|---|
| notemd.agency | 0.3.0 | 0.3.0 |
| notemd.apple-notes | 1.0.4 | 1.0.4 |
| notemd.assistant-mail | 0.1.6 | 0.1.6 |
| notemd.claude-agent | 1.0.33 | 1.0.33 |
| notemd.codex-agent | 1.0.20 | 1.0.20 |
| notemd.conversation-dictionary | 0.1.13 | 0.1.13 |
| notemd.decision-log | 1.1.7 | 1.1.7 |
| notemd.deepseek-agent | 1.1.19 | 1.1.19 |
| notemd.ebook-import | 1.5.2 | 1.5.2 |
| notemd.habitat | 0.5.3 | 0.5.3 |
| notemd.idea-spark | 1.3.7 | 1.3.7 |
| notemd.index-viewer | 1.0.2 | 1.0.2 |
| notemd.knowledge-browser | 3.2.0 | 3.2.0 |
| notemd.md2pdf | 1.0.5 | 1.0.5 |
| notemd.meetings | 1.0.3 | 1.0.3 |
| notemd.memory | 2.5.2 | 2.5.2 |
| notemd.next | 1.6.6 | 1.6.6 |
| notemd.openclaw-chat | 1.0.4 | 1.0.4 |
| notemd.pos-log | 1.1.5 | 1.1.5 |
| notemd.power-mode | 1.0.3 | 1.0.3 |
| notemd.roam-import | 1.2.6 | 1.2.6 |
| notemd.strata | 0.1.6 | 0.1.6 |
| notemd.timeline | 1.0.4 | 1.0.4 |
| notemd.trace-source | 1.2.5 | 1.2.5 |
| notemd.typst-reader | 0.2.4 | 0.2.4 |
| notemd.weekly-review | 1.0.6 | 1.0.6 |

## Worker 生产部署与 CI 来源

使用既有 Account API Token 在内存中认证，直接 Cloudflare deployments API 只读请求成功；只保存筛选后的非敏感 deployment 字段，未保存或输出 token、原始响应敏感体。现存仓库 Wrangler 版本：`{"worker": "3.114.17", "plugins-registry": "3.114.17"}`；未安装、升级或调用其他上传渠道。

- Deployment：`6a2131e6-b32c-465e-aebd-cf4a32f8e141`，created `2026-10-12T06:05:34.833516Z`，strategy `percentage`，source `wrangler`。
- 当前版本：`4b59fa31-c9b1-4619-aeae-c186bed33374`，权重 **100%**。
- 最近 deploy-worker CI run `38210844417`，`completed` / `success`，head `b2de9a9666affed37c41d525d1a72fdaa95f3aba`，created `2026-10-12T06:05:12Z`。
- 从该 run 日志仅抽取 Current Version ID，与直接 API 当前 100% 版本一致；原始日志未写证据文件。
- 本轮观测 HEAD 的 Worker 与 origin/main 无路径差异。P1/finalfix 的宿主发行不会因此自动新增 Worker 部署；后续最终源码复核仍需确认。

**既有 CPU 残留继续成立**：small-k reseal archive/status-cleanup 都曾为 10ms，未通过 strict `<10ms` 的免费 CPU 门槛；representative10/limits10 与 KV legacy copy 最终验收仍不完整。本轮未跑 CPU 实测，也没有创建任何线上 fixture。CI deploy 成功只能证明部署成功，不能宣称整个免费方案验收完成。被 force-pull 替换的旧 combined 候选不自动恢复，沿用 root 既有裁定及旧审计证据。

## core 构建输入

兄弟 moraya-core HEAD / 实际远端 main 均为 `1cb70441f440f50ac4b023857f6d48d5b70eda5a`，tracked/untracked clean。`@moraya/core` 当前安装物与兄弟 dist：57 文件、2206579 字节，逐文件 SHA256 一致，兄弟 dist 与其 Git HEAD 的 tracked dist 一致，package.json 也一致。

统一 dist tree SHA256：`1b656cb331446f6110816b828fb61dae9b25227622836f734922918ac674ec16`。因此当前宿主与 EditorKit 所读取的 core 输入没有出现额外未提交/未推送编辑器更新。本轮未调整依赖、同步 dist 或重装。旧正式二进制当时实际 core 输入仍属于旧报告列明的历史边界，不能只靠 file dependency lock 反推。

## 机器就绪状态及并行边界

工具 pnpm/node/gh/cargo/rustup/minisign/xcrun/security/codesign/spctl/lipo 均可用；Developer ID Application 签名身份存在=true（仅输出布尔，不输出证书身份/AppleID）。`/Volumes/dmg.*` 遗留挂载存在=false、数量=0，未挂载/卸载任何镜像。

只读检查进程可执行文件名，cargo/rustc/tauri/codesign/notarytool/wrangler 当前均未观察到；没有读取可能携带密码的 argv。bash/Node 包装进程与其他机器发行无法由该布尔检查排除。未变化的远端 tag/Release/Worker deployment 仅是当前可观察外部状态，不是排他锁。

本报告仅是 live preflight，不能替代最终 fix 后源码冻结、正式发行或发行后线上七资产复核。
