# 项目分享 P1：Git 合入目标验收

本记录保留 Task 1–4 的历史证据，并补充最终 whole-branch review 后的统一修复与验证。验证范围为本机 Git 对象、项目 Store、唯一 TypeScript 合并内核及前端；不代表 P2、访客富文本编辑器、离线客户端或正式发布已完成。发行与完整裁定记录由 root 后续补充。

## 最终统一修复（2026-10-13）

冻结审查 `0ca59cf9..4a2ca1c9` 判定 4 Important / 2 Minor；以下一次统一修复处理 I1–I4、M1–M2 与 Task 4 author oracle。早期 Task 4 的 `result.is_ok()` 未覆盖 `stateError`、前端门禁和重开恢复；其历史通过记录不构成这些路径已正确的证据。本节取代相应历史结论，原始失败/通过日志均保留。最终唯一 scoped 复审已全部批准；发行由 root 继续，尚不宣称已发布。

| 项目 | 最终行为与实际回归 |
| --- | --- |
| I1 | 实际 controller 允许整份 edit 的无 Decision / 明确 `not_applied`，其他安全门禁保留。Store 两文件用例混合 `not_applied` 与无 Decision：B 无 `stateError`、全部 `branched`、重复 `git-branched` 相同；C 不修改任一 Decision。其他 accepted/rejected/unknown/recovery 状态继续 fail-closed。 |
| I2 | 本机 `branch-state` 只读查询复用 `git-branched` 的完整 authored commit 验证，返回真实自有分支供新 session 仅补记。真实 ref 成功但记录失败、第一文件补记成功/第二写回失败、重开及 HEAD 前进均无新分支。查询对源/index/config/hooks、镜像、inbox/review、Decision、refs 不写入；9 类迟到范围/绑定/intent/终态/快照/信封/ref变化拒绝。真实查询 Git child 运行中能取得全局锁与 RecordsLock；非幂等 clean 配置后改为必失败 filter，查询仍成功，证明不重跑 clean。 |
| I2 边界 | 无 intent 或 intent 对应 ref 缺失返回 `null`，不清 intent、不造 ref；同 OID 用户分支无 intent 不恢复，已变化 ref 拒绝。普通 B 的 expectedHead/混合终态守卫不变。P0 冻结后才初始化 Git 的 `snapshot.git=None` 仍能补记自有 B；始终验证冻结字节/identity/绑定/范围，只有存在 Git snapshot 对象时才验其 ref/非祖先关系，不能声称对不存在的对象做了 I9 祖先检查。查询失败阻止 B/C，但 UI 可明确切 A 恢复未完成 worktree intent。 |
| I3 | 分享模块的所有 Git child 都经共享 `vault_sync::git_ops` 加 `--no-lazy-fetch`，包括 probe/read/tree/ref/format/cleanup；vault-sync 正常联网能力不改。真实 `file://` partial clone 缺失 promisor blob 与 tree 时失败、缺失对象集合不变、trace 零 fetch/upload-pack/transport。拒绝该 option 的独立线程限定旧 Git shim 在读取对象/建 ref 前失败，Store 降为 P0；缺失 tree 与旧能力两类仍实际完成 P0 freeze/import/apply。不改全局 PATH、线程数或跳过回归。 |
| I4 | controller 拒绝文件显式携 target；B/C raw inbox + 全投稿 A intent 守卫。实际先只读打开，再向另一个 annotation-only path 注入 pending/mirror_pending 后拒绝 edit，源/镜像/inbox/review 原字节不变并提示切 A；default/worktree 保留既有恢复语义。 |
| M1 | snapshot 的完整消息逐字匹配 `notemd: share snapshot <id>` 与两个归属 trailers；旧预览消息 ref 不覆写，返回 Git error，P0 冻结仍保留。40/41 ASCII、39 ASCII + 中、去 @、普通名、空名的 author 有独立字面 oracle；实际 `git am` 结果也逐字匹配，未仅调用 production helper 生成预期。 |
| M2 | TS 同一 kernel 的 both-same/result==H 在确认前提示已包含，无确认/picker/export/save。Rust 以实际 tree 对比拒绝无变更新 B/C；包括 clean 规范化后 tree 相同，零新增 ref/Decision/inbox变化。自有已建分支只读查询/补记不受此新建规则阻碍。 |

原始证据集中于 `.superpowers/sdd/2026-10-12-project-share-review-merge-p1/final-fix-*`。完整逐项文件行号、RED/GREEN 命令、失败原因、源码 SHA、自审与提交记录见 `final-fix-report.md`。所有新接口都是本机接口，公开 v1 payload、merge kernel/diff/version、Worker 与插件源码不变。

最终源码冻结后顺序六完整 gates 如下。`final-fix-gate2-results.json` 保存每条命令的 UTC 起止时间、exit、原始日志 SHA 与八个源码/测试输入 SHA；六项 `source_unchanged=true`。原始输入 HEAD 为 `4a2ca1c9d5ff27dc2e6f9809adcbf48fec39ae91`。

| 顺序 | 命令 | exit | 实际结果 | 原始日志 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm test` | 0 | 323 files / 3876 tests passed；既有 happy-dom 异步关闭噪声 | `final-fix-gate2-frontend.log` |
| 2 | `cargo test --manifest-path src-tauri/Cargo.toml` | 0 | 22 summaries / 1439 passed / 0 failed / 0 ignored；lib 1250；既有 ParsedHeader warning | `final-fix-gate2-cargo.log` |
| 3 | `pnpm --dir worker test` | 0 | 8 files / 255 tests passed | `final-fix-gate2-worker.log` |
| 4 | `pnpm check` | 0 | 0 errors / 33 warnings in 16 files；逐位置+首行文本与 baseline 完全一致 | `final-fix-gate2-check.log` |
| 5 | `pnpm build` | 0 | Vite 与 Editor Kit OK；既有 Svelte/chunk 提示 | `final-fix-gate2-build.log` |
| 6 | `git diff --check` | 0 | 无 whitespace error | `final-fix-gate2-diff.log` |

第一次完整 gate 前端/Rust/Worker 成功，`pnpm check` 发现新测试两处 generic mock 推断错误（2 errors + 原 33 warnings），在该处停止，原 `final-fix-gate-*` 全部保留。只为修正两处测试的显式返回泛型重新冻结，再按完整六项顺序运行；没有混用第一组输入，也未改阈值、线程数或跳过测试。旧 search attention 两次均通过，根因仍未被本任务修复。

新增兼容性限制：不支持 `--no-lazy-fetch` 的旧 Git 即使对象齐全也禁用 P1 Git 目标；继续使用 P0。旧未发布 P1 snapshot 消息 ref 不迁移/不覆写。不能用本入口创建仅用于署名的空提交。本轮仍非 P1 native UI/OS picker/iOS 验收；旧非法 UTF-8 目录环境限制、search attention 未定位历史失败、既有 warning、Worker 免费 CPU 与发行残留均保留。

## Task 4 历史结果与修复


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


## 独立审查与源码沿革（root归档）

P1起点0ca59cf9；同一main顺序写入，不建worktree。P0独立证据见2026-10-12-project-share-review-merge-p0-verification.md，本轮不借用其native证据。

| 任务 | 提交及独立规格/质量结论 | 发现与闭环 |
| --- | --- | --- |
| Task1 Git原语 | e29fffa5、71819361，最终Spec✅/Approved | Unix字面反斜杠prefix跨项目映射I1，RED1/GREEN11后scoped ADDRESSED；存在非法UTF8目录的环境M1保留。 |
| Task2 Store/IPC | 4e97d11e、9f74d259，最终Spec✅/Approved | latest重验遗漏annotation-only A intent的I1，经真实RED6/GREEN88修复；可选字段null形状M1同时修正；scoped两项ADDRESSED。一次历史search失败根因未知保留。 |
| Task3 Git UI | 32fcd45e；计划修订0e1d44b5，最终Spec✅/Approved | 父文件清单I1经控制器正式修订为现有isBusy+真实父组件测试，scoped ADDRESSED；产品未造无功能改动。六文件176/176，Chrome生产组件+真实Worker隔离bridge；原生边界保留。 |
| Task4 集成验收 | ef78b8a9，Spec✅/Approved | 0 Critical/Important；Minor为署名截断可增加独立字面期望及既有噪声，交最终review triage。 |

最终 whole-branch review 已冻结于 `4a2ca1c9`，发现与统一修复见本文首节；本次唯一 scoped 复审已完成：I1–I4/M1–M2及字面oracle全部ADDRESSED，无新Critical/Important/Minor；Spec PASS、Quality Approved、P1源码可发布。发行产物仍单独验证。

## 统一发布盘点（root，发行前）

初次与2026-10-13跨日刷新审计一致：最新正式v6.1012.2/e440b38c721450f92abf5947eb1d32912e851d48，真实origin/main ce070741f2aec8235dfa62b9812c558c3579160f。发布执行前再次确认。Memory9a14dd7c及Richc49b8e66 actual blobs/原新增hunks已在正式版且当前main完整保留（14项检查缺失0）；本次整体main发行，不按分享范围cherry-pick排除它们。

26正式插件源码版本与匿名市场最高版本一致；tag后plugins/SDK/protocol/registry/website/其他服务无新产品源码差异。本轮不凭空增加插件版本或重新发布相同包。兄弟moraya-core main/remote1cb70441f440f50ac4b023857f6d48d5b70eda5a干净，安装dist与HEAD57文件/2206579bytes逐字节一致，树SHA256 1b656cb331446f6110816b828fb61dae9b25227622836f734922918ac674ec16；不宣称证明此前正式二进制的依赖输入。

当前Worker主干=remote实际源码，生产deployment6a2131e6-b32c-465e-aebd-cf4a32f8e141、100% version4b59fa31-c9b1-4619-aeae-c186bed33374，对应CI38210844417/b2de9a9666affed37c41d525d1a72fdaa95f3aba。**已知未完成：archive seal/status-cleanup各10ms，严格<10ms失败；代表性10次/limits10次和KV legacy迁移最终验收未完成。** 旧combined候选只在force-pull备份与保留ref，不恢复为当前发行源码；宿主发版不代表免费上传方案全部完成。P1没有Worker改动。

所有23远端heads/5本地heads及保留refs已盘点。旧90b97559只含Cloud Agent开发环境，非产品运行产物，不合入。三stash共20文件逐hunk比较：website五文件与正式tag/HEAD exact blob一致，Next/Roam行为已覆盖且扩展，旧v1插件日志执行器已退役由v2替代；无独立未发布产品行为。旧Rust空dash独立测试未逐字保留，现有TS syntax.test.ts:40具名更广等价覆盖；少量评论差异不当产品遗漏。三stash原refs保留，未apply/drop。

原7项untracked保留：.pnpm-store/及六份旧设计稿/HTML（路径见本报告发行前清单）；发布preflight仅精确本机exclude，结束恢复原exclude使它们重新可见，不提交/删除/清理用户数据。旧force-pull备份.git/force-pull-backups/20261012T081941Z及refs/backup/before-force-pull/20261012T081941Z保留。

正式版本、source tag、双架构七资产SHA/签名公证、匿名回读/latest、插件Worker最终状态待实际执行后补充，当前不宣称发布成功。

## Rulings I made

以下32项为本P1 ledger裁定的逐字、完整、时间顺序归档，均含理由及代价；P0独立裁定见P0报告。

Ruling: 继续当前main，不新建分支/worktree — 用户明确持续授权 — 误判代价：共享checkout，所有写任务顺序执行并精确提交。

Ruling: 本轮按依赖顺序交付 P1；沿用已选择的 SDD，不重复询问执行方式。误判代价：P2 与编辑器仍需后续计划。

Ruling: `prepare` 返回固定 H 的全部 edit HEAD blob、可信 base/after 和最新反馈；branch/export-patch 增加必填 `expectedHead`，执行前及写 ref 前核对 H。原因：原 §9.7 无法绑定前端 compose 与 Rust parent；代价：多一个本机 op/参数。

Ruling: §6.2/6.4 要求的 `.notemd` 私有 manifest/inbox 为 §18.8 的本机元数据例外；源 Markdown、公开包/回执/普通日志仍不得包含本机路径或 oid。代价：Sync 私有元数据包含本机诊断，不能作为公开文件打包。

Ruling: P1 沿用 v1，message 使用缺省 suggestion 标题，AI 为 unknown，name 来自 v1.name；formatter 内部留可选 message/AI 输入接缝，公开 payload 不扩展。代价：丰富署名信息须等 P2。

Ruling: B/C 只合入 edit 正文；不包含新提升批注，不改 annotation_decisions。批注可复制/忽略或先切 A 提升，B/C 中隐藏提升选择并解释；annotation-only 只能 A。代价：Git 批注提升需另行明确持久化/状态契约。

Ruling: 项目 Config.gitTarget 是目标权威；ReviewDraft.target 只是保存时目标快照，不反向覆盖项目选择。非 Git 始终 A；有 remote 默认 B，无 remote 默认 A，保存值优先。代价：跨项目恢复时不沿用某文件旧 target。

Ruling: B 只接收全部 edits 尚未终结的提交，拒绝部分 accepted/rejected/branched 的混合提交；完成后保留 ReviewDraft 供重复 C，全部 branched 可 C 不可再 B/A。代价：部分处理后须使用 A 继续，不能重新打包为 B。

Ruling: C 重复导出相同 H/结果复用既有 exports ref；不同结果不覆盖 create-only ref，明确提示已有导出不同。快照/投稿重试先校验现存 ref 对象的 parent/tree/message/author 再复用，不依赖当前时间生成同 oid。代价：修改后再次导出需新的提交身份；可见失败优于覆写历史。

Ruling: Git 模式打开审阅及 B/C handler 均不调用 prepareSource/saveTab/refreshSource；切回 A 再执行 P0 准备/重算。代价：B/C 展示磁盘工作区，未保存 buffer 不参与；最终合入以 H 为准。

Ruling: snapshot 在锁外预采 HEAD，冻结成功后锁外复验；不一致则只记录 gitError，P0 冻结仍成功。命令异步 spawn_blocking 编排并等待元数据结果，失败不使 P0 返回失败。代价：Git 请求增加等待，但不占全局锁/主线程；无法稳定采样时没有 Git snapshot。

Ruling: I10 对 Git 阶段完整验证。source 与 Vault 同库时，P0 冻结本来会写受管 Sync 镜像/私有元数据；保留这些既有副作用，单独记录并验证 Git 阶段没有额外改动，不能宣称整个 P0 freeze 的全仓 status 不变。代价：该拓扑无法满足字面上的全流程全仓 status 不变，验证报告必须披露。

Ruling: Git fetch/push 禁令适用于项目分享产品运行能力，不禁止既有隔离tempfile/local bare测试中的调用 — spec同时强制完整cargo回归且这些既有tests必须执行，不触及真实用户库/公网 — 误判代价：测试日志含本地网络命令，应明确隔离边界；P1产品不得新增网络Git命令。Task1报告保留23/23已有gate回归与原措辞冲突，不删证据、不跳测试。

Ruling: 用户“继续直到发版”覆盖此前本轮不发布限制；完成P1后按AGENTS统一整合全部未发布更新并验证宿主/插件/Worker正式产物 — 最新明确授权 — 误判代价：发布范围扩大，必须盘点本地/远端/分支/dirty对最新tag逐patch核实，不能只发分享或仅祖先判断。应用Git禁令不限制已授权的发行仓库操作。

Ruling: 不恢复 force-pull 前 combined 候选，保留旧备份且明确 Worker 免费CPU验收残留 — 用户已强制拉取替换旧工作区，候选未进入当前main且未完成生产门槛，不能用“全部未发布”覆盖当前已接受源码 — 误判代价：archive seal/status-cleanup各10ms的严格<10ms问题仍在，10+10及KV最终验收未完成；宿主发版不等于免费上传方案全部完成。

Ruling: 本轮不合入旧90b97559 Cloud Agent开发环境分支，发行清单显式记录 — 实际差异仅.cursor/environment.json及scripts/cloud-agent-install.sh，均不改变宿主/插件/Worker运行产物；旧脚本会自动刷新私人兄弟仓库，不应顺带引入本次产品发行 — 误判代价：该开发环境分支继续未合并，不能宣称所有开发配置均已整合。

Ruling: 原7项untracked继续原地保留，发布preflight仅以精确本机exclude隐藏缓存/六个旧设计稿，不提交或删除 — 它们不是本次产品更新且来源已要求保留；release.sh须干净工作区，局部exclude不改变发行代码 — 误判代价：这些本机路径从常规status隐藏，验证记录须列出；设计稿仍不在发行源码中，可撤销exclude恢复可见。

Ruling: B返回增加可选stateError，分支创建成功但Decision写回失败仍返回branch/commit/最新可读feedback；UI保留结果并仅重试git-branched，不再次branch — brief要求部分成功可重试但接口缺错误载体，复用feedback.error会混淆持久业务状态 — 误判代价：本机返回类型增加一字段，Task3必须显示并提供状态重试；不能把这类结果显示成完整成功。

Ruling: 允许SubmissionGit最小私有branch intent，建ref前短锁保存固定H/results hash/commit/候选分支，重试仅在intent与真实ref及提交完整匹配时复用 — 仅stateError不能覆盖ref成功后进程崩溃或IPC重试，不能静默再建-2分支，也不能侵占用户同OID分支 — 误判代价：私有inbox新增可选字段及恢复路径，须验证两层锁外Git/最新状态patch/删除竞态；禁止进入公开包。

Ruling: 新增project_share review-readonly读取磁盘ReviewFile，B/C打开不进入load_feedback/recover；Git模式有P0未完成写回intent时拒绝并提示切A恢复 — 既有review会刷新镜像并删除草稿，仅跳过prepareSource不足以兑现B/C不写source/mirror — 误判代价：增加本机只读op和恢复守卫，带未完成A意图的投稿须先A恢复；原P0普通review行为保持。

Ruling: Task1 branch_ref不再作为生产接口；Task2恢复intent要求先选候选再保存意图再CAS，允许将旧branch_ref收为调用真实生产原语的cfg(test)薄组合器，不能保留仅测试走的重复分支算法 — 消除本轮新产生的dead_code且避免假G6覆盖，不用allow掩盖 — 误判代价：内部API调整，生产G6需以真实store路径补验，原语计数不能替代业务测试。

Ruling: Task4对已恢复not_applied的Git重试只放行无Decision或明确not_applied，保持其他未知/恢复冲突/隔离状态fail-closed及accepted/rejected/branched既有终态保护 — spec保留现有状态语义，修复contains_key过宽不能顺带将所有非终态错误当作可合入 — 误判代价：source_changed等其他非终态仍需A处理，尚未扩展到Git重试；须真实B/C回归而非仅枚举单测。

Ruling: Task3的ProjectShareDialog.svelte由必改文件改为核验既有isBusy锁并补真实父组件测试，产品无必要变更则保留原实现 — 规格要求关闭/切项目锁，现有locked与close/选择入口已消费isBusy；review I1只指出文件清单无hunk且176测试证明锁/noSave，添加无功能改动违反精准改动 — 误判代价：不新增父组件源码接缝，今后isBusy契约变化仍须父组件回归；当前原生OS锁未实测边界保留。

Ruling: guest_author在既有control/<>清洗外剔除@，访客名按UTF-8字符边界截至40bytes后再加固定20bytes的 (guest, unverified)，空名回退guest；submission/branch/复制Coauthor共用，原v1.name与format-patch正文不改 — Task4真实git am发现Git2.50.1 mailinfo get_sane_name对>60bytes或含@的display name回退email，破坏G3/G10未验证访客署名；官方git/git v2.50.1 mailinfo.c已核实 — 误判代价：长名及@自报名在Git身份中被缩短/清洗，原载荷仍完整；必须Unicode/边界/@真实git am回归且普通名行为不变。

Ruling: 不恢复三份旧stash，保留全部refs并将20文件逐hunk审计归档 — website五文件与正式tag/HEAD exact blob相同，Next多项目/推荐及Roam空bullet已等价覆盖并扩展，旧v1插件日志执行器已明确退役由v2替代，未发现独立未发布产品行为 — 误判代价：旧Rust空dash独立测试与少量注释未逐字重引（现有TS具名等价覆盖），不是所有stash字节进入发行；原stash可继续审查恢复。

Ruling: 分享Git所有调用使用受支持的--no-lazy-fetch全局机制，Git不认识该能力时fail-closed并降级P0，不改vault-sync合法联网能力 — final I3真实partial clone证明cat-file会隐式fetch，未知环境变量在旧Git可能静默无效，禁止联网比Git目标可用性优先 — 误判代价：不支持此能力的旧Git无法用P1 Git目标，即使普通仓库对象齐全；须真实缺失promisor blob/tree零fetch/transport及旧能力失败回归。

Ruling: 新增本机只读branch-state接缝返回经原固定H/owned intent/实际ref/完整提交验证的既有分支结果，重开后UI只补记git-branched，不依赖当前HEAD、不放宽普通混合终态B/C — final I2持久intent与内存结果断开，真实分支不能因关闭或HEAD前进丢失补记入口 — 误判代价：增加本机op与只读验证路径，必须保持两锁外CLI/绑定范围重验/未知ref拒绝/P0意图守卫，不能泄漏私有intent到公开协议。

Ruling: reject增加可选本机target枚举，B/C显式target走raw inbox及既有A intent守卫，缺省/worktree保持原P0恢复语义 — final I4拒绝建议仍绕回recover可刷新镜像/删除其他路径草稿，违背Git模式只读边界 — 误判代价：Git模式存在未恢复A intent时不能直接拒绝，须明确切A恢复；本机调用方需传target，公开协议不变。

Ruling: snapshot使用spec§9.3完整固定标题与两个trailers；已有create-only旧P1 ref不覆写，不加未发布对象迁移，语义不符记录Git错误且P0冻结仍有效 — final M1发现原消息遗漏share与归属trailers，当前尚无正式P1版本需迁移 — 误判代价：本地未发布预览留下的旧消息ref重试可能只保留P0而Git报错；新消息必须完整字面测试并证明旧ref不覆写。

Ruling: B/C新建结果对固定H无实际变更时明确提示已包含/无需合入，不确认或保存空补丁；Rust实际tree相同也拒绝新ref，已创建自有分支仅补记不受此规则阻碍 — final M2真实git am拒绝空变更补丁，避免占用无意义exports和产生误导成功 — 误判代价：不能通过此入口创建仅用于署名的空提交；须both-same及clean规范化同tree零新ref/零Decision回归，不复制合并算法。

Ruling: branch-state无intent或intent对应ref缺失返回null且不写任何状态，存在但与自有intent/完整提交不匹配的ref明确拒绝；普通B保留原expectedHead与混合终态门禁 — intent持久化先于CAS，崩在两者之间不能伪造已创建结果，也不应阻断原本安全的正常重试 — 误判代价：缺失ref且HEAD已前进时不会自动迁移parent，普通B仍可能拒绝；用户需明确处理原状态，查询不能复建已删除分支。

Ruling: branch-state保留B对snapshot.git=None的既有兼容，始终校验冻结字节/identity/绑定/范围/原H及自有ref完整提交；仅有Git快照元数据时校验snapshot ref及祖先隔离 — spec§9.4无snapshotCommit仅跳过submission对象，§9.5以可信冻结base及H合成，恢复接口不能额外拒绝既有合法分支 — 误判代价：无Git快照对象时没有该对象的祖先关系可验，必须具名报告并测试，不能伪称I9该对象已验。

## Task4历史检查输入与日志摘要（root复核）

冻结源码五项SHA与当前文件逐项一致，六命令顺序且均exit0，Rust22段合计1427（lib1238）、前端323files/3859、Worker8/255、check0/33且逐诊断与baseline一致；EditorKit/build/diff通过。search attention本轮ok，历史根因仍未知。

| 原始日志 | SHA256 |
| --- | --- |
| task-4-final-frontend.log | 6587595a96e09ba4dd39a0b6b3a4c064cb5662b1fcd3c736455dbb228978ea94 |
| task-4-final-cargo.log | f4b2ea745071d8122926a4b9b4a5edfa03fb5e6281a49548b4b06116bc07d8a9 |
| task-4-final-worker.log | 92647e6f5df8e734fdb982b8bdf6fa03af0ff90724bda77ac20882ca5767e826 |
| task-4-final-check.log | b4a530f02a8a893259898a4d4a2a60f939ea18d9072af1f366c5e188907f4a4c |
| task-4-final-build.log | 86ea41ddd228f09b84355ceaf5d5fea1f9abdedb75255d2d0f70bbe48d1a26e4 |
| task-4-final-diff.log | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |

冻结源文件SHA：

```json
{
  "src-tauri/src/project_share.rs": "89d2838394262db9099f3565c3dbfd0950ee8239fd37b070f5fdd5fb89c90f71",
  "src-tauri/src/project_share_git.rs": "10401190ddd565e988eea3359299909ce95a63371a657900ef8f122dff831a2f",
  "src/lib/project-share/archive.test.ts": "9df6c54f4e6be75c2222c0877bc4ef540681402b620e25221b4bf342b8db9a5a",
  "src/lib/project-share/browser.test.ts": "61b78b6fc87e36ec06a715201dbc2176bedd65f6f03e3f4c35bb4cd48ddbbc8c",
  "src/lib/project-share/bundle.test.ts": "046f49c3da6f764b003839dbc63240e1c7e276d8c60610a938fd3c8319badc99"
}
```


## Root最终复核与归档（2026-10-13，发行前）

最终产品提交`2c9f165918297e4b089e3c56c4e876401edfc53d`。唯一整轮修复及唯一scoped复审完成，全部七项ADDRESSED、0新增问题、无open finding。root完整读取实施/审查报告，直接验证八源SHA及六原始logSHA均相符；完整六gate exit0：前端323files/3876、Rust22summaries/1439（lib1250）/0failed0ignored、Worker8/255、check0errors/33warnings16files、build/EditorKit与diff通过。root比较33个完整warning block的位置及文本与baseline逐字相同。第一次check新增两处测试泛型错误的失败记录保留，第二次源冻结后六gate完整重跑，未混用输入。

最终源码发行审计：对v6.1012.2共78路径/42commits，Memory/Rich14actual检查缺失0；远端main仍ce070741、所有remote heads及保留stash/backup未变。新增finalfix仅宿主8产品/测试文件及验收报告，插件/Worker/core输入不变。core57文件/2206579bytes/tree SHA1b656cb331446f6110816b828fb61dae9b25227622836f734922918ac674ec16一致。当前审计不等于正式产物发布。

永久报告：

- [完整最终修复与原始SHA表](2026-10-13-project-share-review-merge-p1-final-fix.md)
- [整轮审查及唯一限定复审](2026-10-13-project-share-review-merge-p1-final-review.md)
- [完整发行源码增量审计](2026-10-13-project-share-review-merge-p1-release-audit.md)

本计划workspace在正式发布与线上验证后清理，原始测试证据届时压缩保留于本机ignored正式发行产物目录，正文的workspace路径为执行期来源，不承诺永久原路径。正式版本/tag/七资产/最终生产状态另行补录。P2/E1–E4/P3、P1 native/iOS/OS picker与Worker免费CPU残留仍明确未完成。
