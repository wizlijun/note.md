# 项目分享 P1：Git 合入目标验收

本记录验证 Task 1–3 的 P1 实现与 Task 4 集成修复。验证范围为本机 Git 对象、项目 Store、唯一 TypeScript 合并内核及前端；不代表 P2、访客富文本编辑器、离线客户端或正式发布已完成。发行与完整裁定记录由 root 后续补充。

## 本轮结果与修复

- Git 项目可按整个投稿创建访客署名分支或导出补丁；项目记住目标，B/C 不保存源或镜像的编辑器 buffer，不 checkout、不 push。
- 已恢复但未写入的 P0 `not_applied` 在同一 H、有效草稿下可重新 B/C。只额外放行此明确状态；`accepted/rejected/branched`、待恢复 intent、`source_changed/recovery_conflict/quarantined` 和未知决定继续拒绝（已有全部 branched 可重复 C 例外保留）。
- 真实 `git am` 暴露长名字被 Git mailinfo 降为 email，含 `@` 的名字甚至替代 synthetic email。按 Ruling 24，在已有 control/`<>` 清洗上增加去 `@`，按 UTF-8 字符边界取最多 40 bytes，再加固定 20 bytes ` (guest, unverified)`；空名回退 guest。submission、branch、复制 Coauthor 共用 helper，原 v1.name 保留，普通名字不变，不修改补丁 header。Git 2.50.1 的 [mailinfo 源码](https://raw.githubusercontent.com/git/git/v2.50.1/mailinfo.c) `get_sane_name` 规定 60 bytes 上限，`handle_from` 按首个 `@` 解析邮箱。
- 原语测试曾比较整个 OS 临时目录中的 index 集合，被并发 Store 正常操作误报。改为仅在 `cfg(test)` 记录当前线程实际创建的 index 目录、调用后逐一断言删除；G11 成功和 clean 失败均额外断言确实创建过目录。未改线程数、阈值、生产临时路径或跳过测试。

## G1–G11 逐项证据

以下 Rust 测试位于 `src-tauri/src/project_share.rs::tests`，表中函数均是实际 `ProjectStore` 加 tempfile 真实 Git。`src-tauri/src/project_share_git.rs::tests` 仅作为补充，不用原语计数替代业务验收。

| 项目 | 业务证据与实际断言 |
| --- | --- |
| G1 | `project_share_git_p1_full_business_preserves_bytes_with_or_without_real_index`：真实 index 存在/删除两种仓库，staged/unstaged/untracked bytes，freeze、import、prepare、C、B 各阶段比较源全树字节、index 可选字节、HEAD OID、当前 branch、config 和 hooks 原字节；B/C 镜像正文不变（私有 `.notemd` 正常更新）。`project_share_git_p1_other_decisions_fail_closed_without_refs_or_writes` 比较失败后所有 refs、源与镜像全部字节。 |
| G2 | `project_share_git_store_freeze_import_metadata_and_isolation`：未提交的源 bytes 写入 snapshot tree，snapshot parent 等于预采 HEAD，其他真实 Git 状态不变。 |
| G3 | 同一 freeze/import 测试：submission parent=snapshot、guest author、owner committer、唯一可信 Notemd-Project trailer、AI 默认 unknown、隔离反馈不建 ref；`project_share_git_p1_*author*real_git_am` 与 G10 共同确认显示名及 synthetic email。伪 message trailer 全面清洗另由 `project_share_git::tests::g3_guest_identity_and_untrusted_message_trailers` 实际 commit 覆盖。 |
| G4 | `project_share_git_store_branch_patch_expected_head_and_terminal_protection`：B parent 为 H，真实 `merge-base --is-ancestor snapshot B` 失败，非 snapshot/submission 衍生分支；B 后拒绝再 A/B、reject 保持 branched，C 重复相同结果复用、不同结果不覆盖；删除保留用户分支。 |
| G5 | `src/lib/project-share/review.test.ts` 的 `rejects a real HEAD conflict across the batch before confirmation or any Git execution` 使用真实 TS kernel，任一文件相对 H 冲突时 confirmation/branch/export 调用为零；`src/lib/project-share/git.test.ts` 的 `blocks the entire result on conflict` 等覆盖 compose/retain。Rust `project_share_git_store_prepare_and_build_revalidate_head_scope_and_status` 通过真实 HEAD、范围和状态竞态拒绝后断言没有用户分支。Rust 不执行 diff/分词，TS 冲突测试使用内存 command bridge，不冒称一个 native 端到端用例。 |
| G6 | `project_share_git_p1_user_same_candidate_oid_still_collides_without_intent`：review-built 时用真实 fsck 找本次 candidate，用户抢先以同一 OID 创建 base branch，Store 必须选择 -2。`project_share_git_p1_store_branch_collisions_same_oid_suffixes_and_exhaustion`：无自身 intent 时用户分支不被复用，依次 -2…-9、耗尽失败且 refs 不变。`project_share_git_store_branch_state_failure_retry_is_owned_and_idempotent`：持有自己 intent 的 ref 成功/状态失败恢复，重试复用同分支同 commit，不新建后缀；伪造 git-branched 拒绝。 |
| G7 | `project_share_git_p1_store_subdirectory_prefix_and_patch_real_git_am`：含空格子目录 prefix 正确，补丁只改子项目，根 README 保持原 bytes。`project_share_git_store_linked_worktree_and_same_vault_repository_boundary` 验证 linked worktree 独立 index。Unix 字面反斜杠由既有真实双目录原语 `g7_unix_literal_backslash_prefix_never_targets_another_project` 补充。 |
| G8 | `project_share_git_p1_store_fallback_non_git_bare_unborn_keeps_p0`：三类真实目录均无 Git snapshot，同时 P0 freeze/import/apply 成功并写入预期源正文。既有 Store probe/target 回归验证 remote 默认与保存目标。 |
| G9 | `project_share_git_store_branch_patch_expected_head_and_terminal_protection` 清本项目隐藏 refs、保留 B 用户分支；`project_share_git_store_two_phase_preserves_latest_draft_and_cleans_late_refs`、`project_share_git_store_head_rebind_stop_scope_races_and_read_only_prepare` 覆盖迟到删除、重绑、停止；`project_share_git_store_child_runs_outside_both_locks_and_delete_waits_per_project` 用真实 Git clean 子进程协调删除，验证锁外与无孤儿 ref/目录。 |
| G10 | Store `project_share_git_p1_store_subdirectory_prefix_and_patch_real_git_am`、`project_share_git_p1_unicode_author_survives_real_git_am`、`project_share_git_p1_at_author_survives_real_git_am`、`project_share_git_p1_boundary_and_normal_author_survive_real_git_am`：C 导出到独立 tempfile 的本地 clone，真实 `git am`，检查父 H、目标正文、根文件未改、guest author 与 synthetic email；覆盖伪 trailer/长中文/@/普通名字/40和41 bytes/UTF-8边界/清洗为空，原 v1.name 原样保留。 |
| G11 | `project_share_git_p1_store_clean_eol_blobs_match_real_git_add`：Store snapshot 与 B，分别在 autocrlf、attributes eol、required clean filter 三类真实仓库和 fixture `git add` 比较实际 blob OID。既有 Store `project_share_git_store_record_retry_does_not_apply_clean_filter_twice` 确认非幂等 filter 的恢复不重复清洗；原语 `g11_clean_eol_matches_git_add_and_temp_index_is_removed_on_failure` 确认成功/失败实际临时目录与 index.lock 清除。 |

## v1、公开边界与 P0

- `project_share_review_legacy_manifest_and_inbox_read_from_disk` 从实际磁盘读取 v1，缺省本机新增字段兼容，拒绝尚未支持版本；`project_share_git_store_freeze_import_metadata_and_isolation` 使用 v1.name、AI unknown。
- `archive.test.ts`、`bundle.test.ts` 将实际 `git.branch_intent={head,results_hash,commit,branch}` 加入本机元数据夹具，断言 source/legacy archive、manifest/reader 均不包含字段名或值，也不包含 parentSnapshotId、git/gitError 等私有值。`browser.test.ts` 的 `keeps private branch intent out of outgoing v1 feedback` 注入同字段后真实浏览器提交 handler 只输出 v1 正文反馈；不修改公开协议。
- `project_share_git_store_readonly_review_and_targeted_saves_never_recover_a_intent` 与 Task 2 fix1 的 late annotation intent 测试验证 B/C 读取、保存草稿/批注均不恢复 A 的 pending/mirror_pending。源、镜像不变；建 ref 后新 intent 返回真实 stateError/清理 export，不伪造成功。
- `project_share_git_p1_recovered_not_applied_allows_branch_and_patch` 从真实 pending 恢复出 not_applied，保存同 H 草稿，分别成功 B/C；`project_share_git_p1_other_decisions_fail_closed_without_refs_or_writes` 保持其他状态拒绝。
- Task 3 的 `review.test.ts`、`ProjectReview.test.ts`、`ProjectShareDialog.test.ts` 验证 source/mirror dirty buffers 不保存，确认/文件选择取消没有 export/save，HEAD 或 fs 失败不写源，全部 branched 保护与状态重试。先 picker 再 C，取消不占 exports ref。
- source==Vault 同库例外：既有 P0 会写受管 Sync 镜像和私有元数据。`project_share_git_store_linked_worktree_and_same_vault_repository_boundary` 先观测此变化，再比较 Git 阶段前后 status/index/HEAD/branch/config 无额外变化。不能把它写成整个 freeze 全仓无改动，也不将正常私有元数据落盘称作违规。

## 执行与原始证据

原始日志、逐命令 exit 文件、安全 JSON 总表位于 `.superpowers/sdd/2026-10-12-project-share-review-merge-p1/`。最终六 gate 按下表顺序运行，suite/build 不重叠、复用现有 Cargo target、没有提高阈值或跳过；总表保存开始/结束时间、exit 与冻结源文件 SHA-256。

| 顺序 | 命令 | exit | 结果 | 原始日志 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm test` | 0 | 323 files / 3859 tests passed; happy-dom async close noise | `task-4-final-frontend.log` |
| 2 | `cargo test --manifest-path src-tauri/Cargo.toml` | 0 | 22 summaries / 1427 passed / 0 failed / 0 ignored; lib 1238; ParsedHeader warning | `task-4-final-cargo.log` |
| 3 | `pnpm --dir worker test` | 0 | 8 files / 255 tests passed | `task-4-final-worker.log` |
| 4 | `pnpm check` | 0 | 0 errors / 33 warnings in 16 files; exact warning identities equal Task 3 | `task-4-final-check.log` |
| 5 | `pnpm build` | 0 | Vite and Editor Kit OK; existing Svelte and >500kB chunk warnings | `task-4-final-build.log` |
| 6 | `git diff --check` | 0 | no whitespace errors | `task-4-final-diff.log` |

本轮 search attention 原测试通过；历史一次失败根因仍未知。冻结源 SHA-256 复核 `source_unchanged=true`。所有 Rust 22 段 summary 合计 1427 passed，不能只报 lib 1238 或原语42。

真实 RED 与中间失败均保留：

| 命令/日志 | 结果 | 解释 |
| --- | --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml project_share_git_p1_recovered_not_applied --lib` / `task-4-red.log` | exit 101，0/1 | branch 被 wholly undecided 拒绝，预期 RED。 |
| 同命令 / `task-4-green-recovery.log` | exit 0，1/1 | 最小 not_applied 放行后 B/C 成功。 |
| `cargo test --manifest-path src-tauri/Cargo.toml project_share_git_p1 --lib` / `task-4-integration-attempt.log` | exit 101，6 passed/1 failed | 新测试误写 prefix 期望，实际契约带尾 `/`；仅修正测试。 |
| `cargo test --manifest-path src-tauri/Cargo.toml project_share_git_ --lib` / `task-4-integration-green.log` | exit 101，25 passed/1 failed | 首次发现真实 git am 丢失恶意长访客名字，不是 GREEN，文件名不代表成功。 |
| `cargo test --manifest-path src-tauri/Cargo.toml project_share_git_p1_store_subdirectory --lib` / `task-4-am-diagnostic.log`、`task-4-am-patch-diagnostic.log` | 各 exit 101，0/1 | 保留 am author 和原补丁 From 形状诊断。 |
| `cargo test --manifest-path src-tauri/Cargo.toml author_survives_real_git_am --lib` / `task-4-author-red.log` | exit 101，0/2 | 长中文与 @ 名字分别触发丢名/错误邮箱，先 RED 再按裁定修复。 |
| `cargo test --manifest-path src-tauri/Cargo.toml project_share_git --lib` / `task-4-integration-final.log` | exit 101，35 passed/7 failed | Store 全通过，7 原语全局临时目录集合误报并发 Store；没有当成产品泄漏或删测试。 |
| 同命令 / `task-4-integration-final-2.log` | exit 0，42/42 | test-only 目录归属修正后合跑通过；随后补 G11 非空记录断言，由最终完整 Cargo gate 覆盖。 |
| `pnpm exec vitest run src/lib/project-share/archive.test.ts src/lib/project-share/bundle.test.ts src/lib/project-share/browser.test.ts` / `task-4-public-green.log` | exit 0，3 files/35 tests | 实际 branch_intent 字段及值不进入公开产物/反馈。 |

## 已知边界

- Task 3 Chrome 使用生产 Svelte、真实 merge Worker、内存 command bridge；不是 native IPC。P1 原生 UI、OS picker/写文件实际交互、iOS 编译与 TestFlight 未验证，P0 的 native 证据不能替代 P1。
- Task 1 的存在但非法 UTF-8 sourceRoot 在当前 macOS 文件系统无法创建（os error 92）；类型级拒绝与其他真实路径覆盖不等于实测该环境分支。
- Git clean filter 是用户仓库配置的程序，会被 Git 执行；测试只证明分享产品自身不修改工作区/config/hooks，不能替用户任意 filter 保证无副作用。
- Task 2 曾有一次完整 Cargo 的 `search_cli_contract` attention expected 10 got 0，单测与后续完整重跑通过，根因未知，本轮不宣称已修复该旧问题。
- 前端 happy-dom 异步任务关闭噪声、Svelte 既有 warnings、Rust ParsedHeader warning、构建 chunk 提示按本轮实际日志记录，不能称输出 pristine。
- 所有测试仓库为独立 tempfile；本地 clone/am 仅用于隔离验收，产品没有联网 Git。未 push/tag/release/部署，没有触碰用户真实项目或原七项 untracked/旧备份。
