# 分支、发布副本与 Rust 构建空间清理（2026-10-21）

用户授权清理不必要分支、worktree 和 Rust 编译空间。实际释放 **2.68 GiB**，可用空间由 **6.97 GiB** 增至 **9.64 GiB**（清理验证时测量，APFS 共享块以磁盘实际增量为准）。

## 分支与工作区

- mdeditor 删除 **21** 条远端分支：20 条完整历史已合入 origin/main；`fix/plugin-log-unify` 的唯一提交与 main 祖先补丁等价，并核对当前运行时日志功能及旧入口的明确退休记录。moraya-core 删除 **1** 条已合入分支。删除前重新查远端 SHA 和活动 PR，使用 atomic push 和逐分支 SHA lease，避免删除并发更新。
- 保留两仓 `main`，以及 mdeditor 的 `cursor/setup-cloud-agent-env-35fe`（独有提交、活动 PR #19）。本地两仓均只有 main，注册 worktree 各只有主目录；无多余注册 worktree 元数据。
- 移除 3 个已结束的独立发布 clone：`mdeditor-release-6.831.2`、`mdeditor-release-610082-20261008`、`mdeditor-release-6.1021.1`。它们不是额外注册的 Git worktree。删除前均无工作区修改或 stash；不递归跟随 tasks / .env.release 软链。

| 仓库 | 删除的远端分支 | 原 SHA |
| --- | --- | --- |
| mdeditor | `codex/idea-spark-1.3.2` | `f76651e8283e2832c345d760ebdc2c662075f524` |
| mdeditor | `docs/co-authored-surface-spec` | `26c5c20a6f7929db8636122fdc55e4ed86c3adcf` |
| mdeditor | `feat/assistant-mail-html-preview` | `3732b7e0dfbabf1c34f3e334df761e4b6d366dd6` |
| mdeditor | `feat/decision-log` | `fd3bb41d588aa97f2b2e34cdf16f9655cb7e72b9` |
| mdeditor | `feat/file-view-toggle-navigation` | `29b4844b658851b6be7dd4126a09300ef37d798f` |
| mdeditor | `feat/next-project-article-1.3.0` | `6c46e0b2ed023687e3eda3cb0dbffc799f30c5e3` |
| mdeditor | `feat/next-project-filter-1.3.1` | `eb02d2c48bbdb0df09ffb80c93a74fe37cebbd51` |
| mdeditor | `feat/next-project-tags-1.4.0` | `999820ae349f008631532c25d60c74d92992f497` |
| mdeditor | `feat/note-timeline-unified-release` | `d2f36039ed6cad1d9e76b36a9561b254f0d4701b` |
| mdeditor | `feat/tab-close-menu` | `f953adc0caa979106709f3347c8b3a0e2e248741` |
| mdeditor | `feat/timeline-viewer` | `91ee7f10b1d80178018c642546f3f754201f3416` |
| mdeditor | `feat/typeset-reader` | `5e817075b94bb6860e8965aee91e0e941cce48de` |
| mdeditor | `fix/assistant-mail-vault-key` | `14a507702aa58e905c8ed52b6d7282947fb5b03f` |
| mdeditor | `fix/note-file-view-icon-color` | `da7190894b75b05025d28b95e4decdb6b85d2b0d` |
| mdeditor | `fix/plugin-log-unify` | `d210b943fed6386e7c5806b95f2c4f40a3876a68` |
| mdeditor | `fix/timeline-top-time-offset` | `d533ca2ea3dabcff8d500407b02a30dbaee374e4` |
| mdeditor | `fix/timeline-view-entry` | `6f7de267f3206bfa4e80d391be87b37a034a454d` |
| mdeditor | `release/index-viewer-1.0.2` | `1ce528f3b1775db009f945e742ea8de00ce21a35` |
| mdeditor | `release/timeline-1.0.4` | `bb7bdb217ef1157668f1443abcdd571643f0c7b9` |
| mdeditor | `website/responsive-css` | `e4b52e78cd13171d00e8953fa4a85979bc8a69d1` |
| mdeditor | `windows-x64-port` | `9fce5259820c96ce919090f3ad97e84564b2e9ef` |
| moraya-core | `feature/highlight-mark` | `a1371cd8a4fa71f4327a712afcf10a93f91481e5` |

## 保留与恢复证据

- `tasks/cleanup-20261021/preserved-clones/<clone>/repository.bundle` 保存每个副本的所有 Git 引用及完整历史，三个 bundle 均在**空仓库中独立验证通过**，不依赖被删 clone 的 alternates。旧 610082 副本中 4 个不在主仓引用中的历史提交（含仅 reflog 可达的 `2f03dadac160ce3b6b224c010435a01c8961488f`）已显式挂到 bundle 的 `refs/cleanup-preserve/reflog/*`，不会因删副本丢失。
- 每个副本的原安装包、签名、插件索引和 bundle 目录归档为 `release-evidence.tar.gz`，逐文件 SHA、大小及软链目标核对通过。恢复清单在相邻的 `release-evidence-manifest.json`；归档保留当时原字节，不将旧预公证签名误称当前公开签名。
- 非祖先等价分支的原提交单独保存在 `tasks/cleanup-20261021/mdeditor-fix-plugin-log-unify.bundle`，其余已删分支提交仍可由保留的 main 历史到达。分支原 SHA 全部记录在上表和 branch-audit.json。
- 原 `src-tauri/target/release-artifacts` 的 **451 文件**历史发布证据整体移到 `tasks/cleanup-20261021/preserved-release-artifacts/`，移动前后逐文件 SHA 一致；最新 clone 的同目录已证明与其完全相同后去重。
- 最新 mac 发行的 36 条实际 Mach-O 内嵌资源证明对应 **16 个唯一压缩资源**已从签名 binary 恢复，保存至 `tasks/timeline-mac-release-20261021/preserved-embedded-assets/`，解压后的 SHA 与原验收结果一致。原公开 updater / DMG、完整签名 Mach-O、源码冻结及日志仍在发布证据目录，可在删缓存后复核。

| 发布副本 | Git bundle SHA256 | 发行证据归档 SHA256 |
| --- | --- | --- |
| mdeditor-release-6.831.2 | `a817b38939e55ad7460cdfead5a2fb42fa3548d585232c7be92089594634db94` | `b5fccff925af17923cea89e89311fdbbc16b4949f755947ec6416d69fb640787` |
| mdeditor-release-610082-20261008 | `fae81577070d41ed57bdf98dee194652bc8adfc5e2a7694db454b7a44a28e00f` | `478c2d50a36cb0838f9ee92b17057e8f0fb467c9372553afb978d9818b39664d` |
| mdeditor-release-6.1021.1 | `747bd55e1e3a33c2b22510efcaaa57539f36df274fa115ffc11216072b4e2de5` | `39764059652af27600a5cd1af33b1b03dbe54d1ae0d31495aedf18502cb6bd2a` |

## Rust 空间与完成验证

- 清除主项目内 **19** 个可重建 target 目录，包括 src-tauri、ebook-import 后端、plugin-protocol、其他插件和历史验证探针；旧发布副本内的缓存随副本移除。未运行 Cargo，以免工具链隐式同步或重新生成缓存；删除前确认无 cargo / rustc / rustup 进程。
- 保留 Rust toolchains、Cargo registry、现有主仓 node_modules、源码、用户未跟踪文件、3 个 stash 和发布证据。
- 验证源代码基线仍为 mdeditor `309fbe26f6fb88487214bee2f6740bef22925e95`、CORE `f3c08082430d4414fc3311b9feb85eee6dbe0e44`；本次提交仅增加此清理报告。所有 tag、stash SHA、原 7 项未跟踪路径均保持；两仓仅保留主 worktree。远端实际 heads 已回读验证，19 个 target 及 3 个副本路径均不存在。
- 完整本机清单：ignored `tasks/cleanup-20261021/` 中 baseline、branch-audit / deletion、clone-audit、preservation、release-artifacts-manifest、space-actions、verification，以及可恢复备份。

本轮无产品代码变更，无需重新运行构建或产品测试；完成验证使用引用、源码差异、原文件哈希、独立 Git bundle 检查及磁盘测量。
