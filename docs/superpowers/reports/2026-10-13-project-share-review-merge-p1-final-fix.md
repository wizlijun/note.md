# P1 最终统一修复报告

状态：DONE_WITH_CONCERNS。BASE/current input HEAD：`4a2ca1c9d5ff27dc2e6f9809adcbf48fec39ae91`；当前 main，唯一产品 writer，无 branch/worktree/子代理/push/tag/release/deploy。冻结 findings I1–I4/M1–M2 与 Task4 deferred author oracle 均已处理。root 的唯一 scoped 复审与发行尚未执行，本文不替代其批准。

产品提交：`2c9f165918297e4b089e3c56c4e876401edfc53d`

## 范围与实施映射

| finding | 产品位置 | 真实测试与结果 |
| --- | --- | --- |
| I1 | `src/lib/project-share/review.svelte.ts:364`；`src-tauri/src/project_share.rs:5761`、`:5791` | `review.test.ts:641` B/C 明确 not_applied 可达、8种其他混合状态阻止；Rust `project_share_git_p1_recovered_not_applied_allows_branch_and_patch` 改为两 edit、实际 pending→not_applied 恢复；B 必须无 stateError、全部 branched、per-file 补记幂等，C 原 not_applied 与无 Decision 均保持。原 `is_ok()` 被替换，未宽放其他状态。 |
| I2 | `review.svelte.ts:187` 重开 query；`:364` 失败不能启用 B/C；原 retryBranchState 只 git-branched。`project_share.rs:5645` 私有 op、`:5761` 最新 intent/决定验证、`:5914` 两锁外编排/owned authored commit 验证 | Store `project_share_git_final_i2_reopen_owned_branch_pure_query_and_only_record` (`:2080`)：ref成功且状态写失败、lost result/all-none，以及首文件成功第二文件实际失败，销毁 Store/重开、HEAD前进，只查询+补记、不造第二分支；query 前后源/index/HEAD/config/hooks/镜像/inbox/review/ref全部相同。`review.test.ts:688` 真实 controller/内核重建 session，仅 git-branched RPC。 |
| I2 安全 | `project_share.rs:5991` 缺失 ref null；`:6028` 验证后再次查 ref；所有 CLI 通过 operation lock 但不持 PROJECT_LOCK/RecordsLock | `:2136` 9类晚到 scope/binding/intent/decision/A-intent/snapshot/envelope/stop/ref 变化 fail-closed；`:2179` parent/author/message/快照ref伪造拒绝；`:2208` 真 Git child 阻塞期间两个锁均可获取；`:2975` 非幂等 clean 配置改为 exit99，恢复查询仍成功。不存在 intent 的同OID用户分支返回null、不认领。无intent/无ref query 不创建或清理任何持久状态。 |
| I2 兼容 | `project_share.rs:5997` snapshot metadata 可选分支；`:2121` P0快照无Git metadata实际fixture | 始终核对原冻结字节/identity/绑定/范围、原H/owned intent/实际ref/完整commit。snapshot.git=Some才核对快照ref/非祖先；None保留既有“先P0冻结后初始化Git”合法B恢复，无不存在Git对象的I9祖先证明。A pending query错误后仍能显式切A；`review.test.ts:715`验证。普通B expectedHead/混合终态保护保持。 |
| I3 | `src-tauri/src/project_share_git.rs:25` 唯一分享 run_io 为每条Git命令加有效全局 `--no-lazy-fetch`；所有分享调用含 text/binary/tree/ref/format/cleanup 均汇入此接缝 | `final_i3_missing_promisor_blobs_and_trees_never_fetch` (`:845`) 实际本地file partial clone blob:none/tree:0 缺对象；RED trace确实fetch/upload-pack，GREEN必须出错、零fetch/transport且缺失集合不变。`:866` 旧Git shim拒绝option，probe降级且read/ref不能执行；Store `project_share_git_final_i3_unavailable_capability_and_missing_tree_keep_p0` (`project_share.rs:2228`) 两类均实际P0 freeze/import/apply成功。 |
| I3 测试接缝 | `src-tauri/src/vault_sync/git_ops.rs:99` cfg(test)线程限定程序/env override，RAII清理 | 不改全局PATH/env/测试线程数，正常 vault-sync runner 没有生产行为改变；旧Git是拒绝能力shim，不能冒称实际安装多版Git验收。真实安装Apple Git2.50.1。临时local file remote仅测试setup/RED复现使用，无公网Git、无用户仓库操作。 |
| I4 | `review.svelte.ts:323` 显式target；`project_share.rs:1629` reject_target raw inbox+A guard；dispatch解析可选枚举 | `project_share_git_final_i4_reject_late_annotation_intent_is_readonly` (`:2061`) 在B/C只读open之后另annotation-only路径加入pending/mirror_pending，再reject不同edit，源/mirror/inbox/review原字节不变；default reject仍recover并保持P0语义。`review.test.ts:660` 验target与切A可达。 |
| M1 | `project_share.rs:5448` 完整标题+Notemd-Project+Notemd-Snapshot | `project_share_git_final_m1_snapshot_message_and_legacy_ref_never_overwritten` (`:2018`) 完整字面body；旧message ref仍原OID、Git error保存而P0 snapshot.files仍完好。不迁移旧预览对象。 |
| M2 | `src/lib/project-share/git.ts:33` same-H在确认前拒绝；`project_share_git.rs:266` actual tree比较；`project_share.rs:6099` 在新ref/Decision前拒绝 | `review.test.ts:674` 两目标both-same：明确已包含/无需合入、零confirm/picker/export/save；`project_share_git_final_m2_same_tree_ref_and_decision_free` (`:2040`) 字节相同与clean规范化同tree两种，B/C零新增ref/Decision/inbox变动。已建分支补记独立于此新建规则。 |
| deferred author oracle | `project_share_git.rs:882` 与 `project_share.rs` 中 p1_patch_am_for_name | 独立字面输出：40a→40a；41a→40a；39a+中→39a；Visitor@example.test→Visitorexample.test；Visitor普通名；@<>控制空名→guest，均固定后缀。真实git am对应边界也用字面完整name+email，原v1.name不改。 |

## 实际 RED / GREEN 与中间失败

所有下表文件均在本文同目录，完整 `.log`、`.exit`、安全 `.json` 保存原始命令/UTC时间/逐源SHA/日志SHA。没有拿编译失败冒充行为RED。

| 证据 | 命令 | exit | 实际结果/解释 |
| --- | --- | --- | --- |
| `final-fix-red-frontend.log` | `pnpm exec vitest run src/lib/project-share/review.test.ts` | 1 | 修复前 74 tests：8 failed/66 passed；I1按钮false、I4缺target、M2仍确认、I2无branchResult。 |
| `final-fix-red-rust.log` | `cargo test --manifest-path src-tauri/Cargo.toml final_ --lib` | 101 | 修复前 8 selected：6 failed/2 passed；I2未知branch-state、I4副作用、M1标题缺失、M2空ref、I3真实fetch与旧能力未降级。 |
| `final-fix-red-i1.log` | `cargo test --manifest-path src-tauri/Cargo.toml project_share_git_p1_recovered_not_applied --lib` | 101 | 修复前1 failed；真实B返回stateError且not_applied未转branched，原始payload保留。 |
| `final-fix-green-target-rust.log` | `cargo test --manifest-path src-tauri/Cargo.toml project_share --lib` | 0 | 首轮project_share全106 passed。 |
| `final-fix-green-target-frontend.log` | `pnpm exec vitest run src/lib/project-share/review.test.ts src/lib/project-share/git.test.ts src/components/project-review/ProjectReview.test.ts src/components/ProjectShareDialog.test.ts` | 1 | 134 tests中3 failed/131 passed；三个既有mock未认识新增branch-state，补其null响应；不是产品成功。 |
| `final-fix-red-query-guard.log` | `pnpm exec vitest run src/lib/project-share/review.test.ts -t 'failed owned branch query'` | 1 | 实际controller补边界1 failed：query失败但canGit仍true；随后要求file/proposal已加载。74 filtered/skipped是定向 -t，不是改测试skip。 |
| `final-fix-red-query-race.log` | `cargo test --manifest-path src-tauri/Cargo.toml project_share_git_final_i2_latest --lib` | 101 | 测试编译失败：写了不存在的save_bindings；用既有write_json修测试，不算行为RED。 |
| `final-fix-red-query-race-2.log` | `cargo test --manifest-path src-tauri/Cargo.toml project_share_git_final_i2_latest --lib` | 101 | 1 failed：late ref修改仍返回成功；随后在锁外补实际ref复核。 |
| `final-fix-green-target-rust-2.log` | `cargo test --manifest-path src-tauri/Cargo.toml project_share --lib` | 0 | 扩大project_share全110 passed，含I2真实子进程/两锁与I3 P0降级。 |
| `final-fix-green-target-frontend-2.log` | `pnpm exec vitest run src/lib/project-share/review.test.ts src/lib/project-share/git.test.ts src/components/project-review/ProjectReview.test.ts src/components/ProjectShareDialog.test.ts` | 0 | 4 files/135 tests全部通过。 |
| `final-fix-red-no-snapshot-meta.log` | `cargo test --manifest-path src-tauri/Cargo.toml project_share_git_final_i2_p0_snapshot --lib` | 101 | 1 failed：已有P0无Git快照的合法B恢复被新接缝多余snapshot-commit条件阻断。 |
| `final-fix-green-no-snapshot-meta.log` | `cargo test --manifest-path src-tauri/Cargo.toml project_share_git_final_i2_p0_snapshot --lib` | 0 | 移除新增强制条件、按Some验证快照Git，1 passed。完整最终Cargo再覆盖全部111项project_share。 |

## 最终六完整 gates

源代码冻结后顺序执行，不重叠 suite/build。第一次 `final-fix-gate-results.json` 的前三项全过，check两处新增测试泛型错误而exit1，立即停止；build/diff未执行、不冒称通过。修复仅 `review.test.ts` 两处 `original<any>`，保存第一组原始日志/exit/SHA；重新冻结后再次完整顺序运行下表，未改产品、阈值、线程数或跳测试。

| 顺序 | 命令 | exit | 实际结果 | 原始日志 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm test` | 0 | 323 files / 3876 tests passed；既有 happy-dom 异步关闭噪声 | `final-fix-gate2-frontend.log` |
| 2 | `cargo test --manifest-path src-tauri/Cargo.toml` | 0 | 22 summaries / 1439 passed / 0 failed / 0 ignored；lib 1250；既有 ParsedHeader warning | `final-fix-gate2-cargo.log` |
| 3 | `pnpm --dir worker test` | 0 | 8 files / 255 tests passed | `final-fix-gate2-worker.log` |
| 4 | `pnpm check` | 0 | 0 errors / 33 warnings in 16 files；逐位置+首行文本与 baseline 完全一致 | `final-fix-gate2-check.log` |
| 5 | `pnpm build` | 0 | Vite 与 Editor Kit OK；既有 Svelte/chunk 提示 | `final-fix-gate2-build.log` |
| 6 | `git diff --check` | 0 | 无 whitespace error | `final-fix-gate2-diff.log` |

八源冻结时间：`2026-10-12T17:44:21.552452+00:00`；八个 SHA 在所有六 gate 前后完全一致（`source_unchanged=true`）。最终 check33条 warning 的文件位置和首行文本逐条等于 baseline，比较结果见 `final-fix-warning-comparison.json`。Cargo22段1439总数包含lib1250，不能仅以lib代替全套。原search attention两次完整均通过，根因未定位、不声称修复。既有ParsedHeader、happy-dom和build chunk噪声如实保留。

| 冻结源码/测试 | SHA-256 |
| --- | --- |
| `src-tauri/src/project_share.rs` | `a6043e538d2ce8a4e8f752b09a4591871ba92798b3f5047683b55d2c67e6dbc5` |
| `src-tauri/src/project_share_git.rs` | `fbd536adb5293d1f7d828265126fee8f18399914ec6947c8b7d143958eeca5e0` |
| `src-tauri/src/vault_sync/git_ops.rs` | `719d594cf4ab9808db0a7a2f69eb54b205f5a00302f96422d005b13a47749f84` |
| `src/components/ProjectShareDialog.test.ts` | `627ce295c24d3974629caaa7e66acbc12f8ae83bb8528a7b0f343988abe69a70` |
| `src/components/project-review/ProjectReview.test.ts` | `b09b257d6eb9fee7cb14dd8c0bb27b6a6cb73cf37cc199c23be052682802f07c` |
| `src/lib/project-share/git.ts` | `1d045c6599150c688b993ade3b45d9445d0857357e327c96e15e08e95fd17cab` |
| `src/lib/project-share/review.svelte.ts` | `a73a5adff9e350300c9ad4ca7314534b4ff054600c9f3c0e0886b462139019ae` |
| `src/lib/project-share/review.test.ts` | `7baccf089759884f397af717277013fa16a9932b66811c0cb96439817763f92e` |

| gate raw log | SHA-256 |
| --- | --- |
| `final-fix-gate2-frontend.log` | `718b7427e3a02622c68b7c71c7067b11b60f57f48da40bf4bf21ec3be970131c` |
| `final-fix-gate2-cargo.log` | `9de9a0daa1d557e0ca25bbeae52866281e9a6168b5126761ce6e7e86ac1fe326` |
| `final-fix-gate2-worker.log` | `6a9d50c7eb04ad05a99d194d79ee81b6931425fe48f5e25c51aa4b0added8f27` |
| `final-fix-gate2-check.log` | `b4a530f02a8a893259898a4d4a2a60f939ea18d9072af1f366c5e188907f4a4c` |
| `final-fix-gate2-build.log` | `144e066ab424f2f3ada857f53cca9d43cb7526aebef0ca5f59dba077490e6d92` |
| `final-fix-gate2-diff.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## 精确变更、自审与边界

产品/测试八文件即上表，加 canonical 验收报告 `docs/superpowers/reports/2026-10-12-project-share-review-merge-p1-verification.md`，共九个提交文件。root plan/todo/ledger 未修改；原七项untracked与所有旧备份原地保留，不stage/delete；无gitadd-A。

自审：所有产品 hunk对应冻结I/M；恢复查询与补记共用owned commit及最新intent验证，无第二套diff/clean算法。新建树比较仅放review新建路径，不影响snapshot合法同tree commit。reject可选target缺省沿用P0。shareGit只在自身wrapper加flag，runner生产原逻辑/合法同步联网保持。公开v1字段/kernel/diff/version/Worker/plugin不变；原公开投影测试在完整前端再次跑过。没有假造UI渲染或native证据。

限制/concerns：
- 不支持Git全局--no-lazy-fetch的旧Git全部P1 Git目标fail-closed到P0，即使对象完整；实际旧版本是线程限定shim验证，当前实机2.50.1。
- private intent无ref返回null，不写/不清；普通B仍受当前H限制。已变化/未知所有权ref拒绝。私有本机intent仍不能公开。
- snapshot.git=None没有可验的快照Git对象，保持既有B恢复；Some验ref/isolation。旧本机预览snapshot消息ref不覆写不迁移。
- 不支持通过本入口创建署名空提交；同tree明确无需合入/导出。Git clean filter是仓库用户配置的程序，其任意外部副作用不由分享模块保证。
- P1原生UI/OS picker/iOS/TestFlight仍未验，非法UTF8目录macOS环境未构造；本轮controller是实际生产代码+真实kernel但command bridge内存，Rust真实Store/Git另行证明。
- 旧search attention根因未知；既有warnings未清理。Worker免费CPU旧seal/status-cleanup各10ms、严格<10ms及10+10/KV验收未完成；宿主发行尚未由本agent执行。P2/E1–E4/P3未做。

最终源码八SHA已在提交前/后复核一致；`git diff --cached --check`通过。精确提交九文件为 `2c9f165918297e4b089e3c56c4e876401edfc53d`，父提交 `4a2ca1c9d5ff27dc2e6f9809adcbf48fec39ae91`；提交后tracked工作区干净，仅原七项untracked，未push/tag。root后续只需一次scoped复审。
