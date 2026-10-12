# P1整轮审查历史及最终限定复审

第一部分记录修复前冻结发现，第二部分为提交2c9f1659的最终唯一限定复审；后者结论覆盖前者未通过状态。仅源码通过，发行验证独立。

# P1 whole-branch final review — 冻结报告

- 审查范围：`0ca59cf9` → `4a2ca1c9`，15 commits、24 files；完整读取提供的 `review-0ca59cf9..4a2ca1c9.diff` 全部 6455 行，没有重新获取整分支 diff。
- 依据：绑定设计 §4、§9、§17 WP1.1/WP1.2、§18，完整实施计划、constraints、progress 全部 Rulings、final-review-context、正式验收报告，以及 requesting-code-review 的 code-reviewer 模板和 SDD Final Review 要求。
- 本报告为一次性完整发现列表。未派子代理，未修改产品、index、HEAD、branch、用户项目；仅写本报告。所有实验位于独立 tempfile 或内存，Vite cache 在 `/tmp`；没有重跑已有六 gate 或现有定向 suite。
- **结论：Spec ❌，Code quality: Needs fixes；Ready to publish? No。** 0 Critical、4 Important、2 Minor。I1–I4 应进入唯一统一修复波次及一次 scoped 复审。Minor 与下面的 deferred 分开说明，不以既有逐任务批准替代本结论。

## Strengths

1. **Git 操作与元数据锁的边界扎实。** `project_share.rs:4923` 起的 async/spawn_blocking 编排、短全局锁和按项目 operation lock 避免在全局锁/RecordsLock 内运行 Git；delete 等待项目锁时不占全局锁。真实 clean 子进程测试能在 Git 运行中取得两锁，并证明迟到删除不重建目录。
2. **身份和写入范围有多层保护。** binding generation、snapshot identity、完整 envelope、current scope、expectedHead，以及 ref 前后重验，覆盖 stop/rebind/delete 与 HEAD 变化；GitRequest deny_unknown_fields、results 必须等于全部 edit 路径，不接受前端任意路径。最新 annotation-only worktree intent 的修复已贯穿公共 verify。
3. **对象与分支隔离有实质证据。** 临时 index、字面路径、regular mode 检查、create-only ref CAS、no-deref、九候选和用户同 OID 碰撞保护均读到真实实现与测试；B parent 是 H，snapshot 非 B 祖先。私有 branch intent 能区分自有恢复与用户碰撞，单个会话内的 stateError 重试不重跑 branch。
4. **前后端职责清楚。** 前端使用同一 merge kernel / retain / compose 对整个 submission 重算，显示逐文件确认；Rust 不复制 diff。目标以 Config 为权威，草稿只存目标快照。B/C 打开、保存草稿、忽略批注走显式只读路径；C 在 picker 确认前不占 exports ref，普通取消/失败保留草稿。
5. **验收材料诚实且可核验。** G1 的存在/不存在真实 index、源树/config/hooks 字节，G6 Store 层同 OID 碰撞，G10 真实 git am，G11 clean/eol，以及 v1/public projection 都有具体测试。正式报告明确 Chrome 内存 bridge、native/iOS 未验、旧 search 失败、warning 与 Worker 残留。

## Issues

### Critical

无。未发现可据本轮证据认定的直接数据毁损、任意路径写入或公开包泄漏。

### Important

#### I1 — `not_applied` 例外只改了入口门禁，UI 和最终落盘仍拒绝，恢复后无法完成 B/C

- **位置：** `src/lib/project-share/review.svelte.ts:362`；`src-tauri/src/project_share.rs:5510`、`:5572`；漏检断言 `src-tauri/src/project_share.rs:1986`。
- **问题：** Rust `review_status` 已允许明确 `not_applied`，但 UI 的 `canGit()` 仍只允许不存在 Decision（或 C 的全 branched），因此这个状态的 B/C 按钮始终禁用。即使直接执行 Rust branch，ref 创建之后 `record_branch` 对任何已有非相同 branched Decision 一律报错，故 `not_applied` 永远进入 stateError；后续 `git-branched` 又调用同一函数，无法补记。
- **证据：** 本轮通过 Vite SSR 加载实际生产 controller 和实际 kernel，输入已恢复 `not_applied`，结果 `phase=ready,target=branch,status=not_applied,canGit=false,error=""`。后端是确定的控制流：`:5572` 通过 → create ref → `:5517` 返回错误 → `:5859` 转成 stateError。现有真实恢复测试只断言 `result.is_ok()`，而部分成功的 stateError 同样是 Ok，未断言无 stateError 或所有 edit 已 branched。
- **影响：** Task4 本次承诺的最小恢复例外实际上未完成；正常 UI 用不了，直接 IPC 会留下无法通过现有补记入口完成的分支。
- **建议：** 前端门禁与 Rust 终态记录共同允许“无 Decision / 明确 not_applied”，继续拒绝未知、pending/mirror_pending、recovery_conflict、accepted/rejected 等状态；保留同 branch+commit 的幂等记录。补恢复后的实际 controller B/C 可执行测试，以及真实 Store B **无 stateError、所有 edit branched、补记幂等**与 C 状态不变测试。不能只扩大 review_status 或保留 is_ok 断言。

#### I2 — 持久 branch intent 没有重新打开后的补记入口，部分状态落盘或 HEAD 前进会使已有分支无法恢复

- **位置：** `src/lib/project-share/review.svelte.ts:69`、`:187`、`:362`、`:398`、`:429`；后端常规混合终态门禁 `src-tauri/src/project_share.rs:5572`。
- **问题：** `branches` 只存在 session 内存中，并且只在当前 `executeGit()` 收到结果后填充。open 不从持久 intent/Decision 重建待补记结果，`retryBranchState()` 又要求该内存项有 stateError。两文件的补记循环每次单独持久化：第一文件成功、第二文件失败后关闭/重启，磁盘成为 branched + undecided 的混合状态，新 session 既无结果/补记按钮，又因 canGit/后端门禁不能再 B/C。另一个同源场景是 ref 成功后 crash/IPC 丢结果，随后 HEAD 前进；重建 B 受 intent.head/expectedHead 限制失败，现有 git-branched 本来可以补记，却没有可达 UI。
- **证据：** 用实际生产 controller/kernel 新建 session，输入两文件 mixed branched 状态和完整私有 branch_intent，得到 `canGit=false,branchResult=null`；直接调用 retryBranchState 也无任何 RPC。该实验不模拟 Git 正确性；ref/commit 的可信验证由已有 Rust git-branched 实现承担。
- **影响：** 设计持久 intent 要解决的崩溃/IPC 恢复在 UI 层断开。用户已经得到真实分支，但不能完成审阅账本，甚至看不到应恢复的分支名。不能通过放宽普通 mixed submission 的 B 门禁解决，否则会破坏明确的终态保护。
- **建议：** 增加或复用一个只读、由 Rust 验证 intent + 实际 ref + authored commit 的本机恢复接缝；重新打开时呈现真实已创建结果和仅补记操作。允许恢复不依赖当前 HEAD，但继续验证原固定 H、完整提交、绑定、范围及冲突状态。加入“第一文件补记成功/第二失败 → 销毁 session → 重开 → 仅 git-branched 补完”及“ref 成功后 HEAD 前进 → 不创建第二分支”的回归。原有用户同 OID 碰撞不得因此视为自有。

#### I3 — “只调用本地 Git 命令”没有阻止 partial clone 的隐式 fetch，违反 I11/§18.3

- **位置：** `src-tauri/src/project_share_git.rs:167`（cat-file 的 env 为空），以及统一 runner `src-tauri/src/vault_sync/git_ops.rs:110`。其他读取/造树命令也未建立禁止 lazy fetch 的边界。
- **问题：** 在 promisor/partial clone 缺失对象时，`git cat-file blob H:path` 会自动启动 `git fetch <promisor remote>`；当前 runner 只追加代理和调用方 env。源码中没有显式 fetch argv，并不能证明产品不联网。
- **独立实验：** 只在 tempfile 内建立支持 filter 的本地 origin，经 `file://` clone `--filter=blob:none --no-checkout`；`rev-list --objects --missing=print HEAD` 确认 blob 缺失，然后执行生产 read_blobs 同样的 cat-file argv。Apple Git 2.50.1 trace 实际出现：

  ```text
  git -c fetch.negotiationAlgorithm=noop fetch origin --no-tags --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin
  git upload-pack <isolated local origin>
  ```

  相同缺失对象、设置 `GIT_NO_LAZY_FETCH=1` 后 exit 128，trace 不再有 fetch。实验没有接触真实 remote 或公网；远端为 HTTPS/SSH 时会走对应传输，是由实际 promisor fetch 路径推得的结果。
- **影响：** 打开/准备/冻结等操作可在用户未授权分享产品联网 Git 的情况下访问远端、触发凭据/网络等待；这是显式硬约束，不是 clean filter 的已披露用户程序副作用。
- **建议：** 在**所有分享 Git 调用**建立可证明的禁止自动下载边界；不改变既有 vault-sync 的合法网络功能。支持的 Git 可使用有效的禁 lazy-fetch 机制；旧 macOS Git 如不能可靠执行该机制，应检测并对相关仓库降级或拒绝，不可假设未知 env/flag 会生效。本实验只证明本机 2.50.1，**没有证明旧系统 Git 的兼容性**。补真实缺失 promisor blob/树的测试，断言无 transport/fetch，且 P0 可继续；测试可以沿用本地 file remote，不需公网。

#### I4 — B/C 下“拒绝此文件”绕回 P0 recovery，迟到 A intent 可改写镜像并清除草稿

- **位置：** 新目标界面入口 `src/lib/project-share/review.svelte.ts:324`；消费路径 `src-tauri/src/project_share.rs:1633`（reject 的 load_feedback）、`:1347`（recover 的 refresh_source_mirrors_locked）。后两处为该具名风险定点补读的既有函数上下文。
- **问题：** review-save 和 annotation-decide 已传 target 并使用 raw inbox + worktree intent 守卫，但 rejectFile 在 B/C 仍发无 target 的普通 `reject`。`ProjectStore::reject` 先调用 load_feedback/recover，再决定拒绝哪个 edit。假设 B/C 打开时没有 intent、没有脏草稿待 flush；此后另一个 A 操作在 annotation-only 路径产生 pending/mirror_pending，点击拒绝另一个 edit 会先恢复整份反馈的 A intent。若源已写入 result_hash，recover 会刷新镜像、移除那个路径的 review，再把它记录 accepted。
- **证据：** 实际 controller 在 target=branch 时发出的请求为 `reject {project_id,submissionId,path}`，没有 target；后端 recover 对整份 decisions 枚举 pending/mirror_pending 并执行上述写入，且 reject 没有已用于其他 Git 操作的 guard。这里的风险由代码路径直接证明；本轮没有假称已跑 native 竞态 E2E。
- **影响：** B/C 用户进行仅拒绝建议的操作，却进入已特意排除的 A 恢复/镜像写入路径。现有只读回归覆盖 open/save/dismiss/prepare/branch/export，但漏掉了这个仍在 Git 目标界面可用的入口。
- **建议：** 像 annotation-decide 一样让 reject 显式携带当前 target；B/C 使用 raw inbox + 同一 pending intent 守卫，缺省/worktree 保持 P0 恢复语义。补“B/C 打开后、拒绝前注入另一路径 A intent”的真实 Store/controller 回归，断言源、镜像、intent/草稿不变并提示切 A 恢复。此问题并非要求改动所有既有 inbox/P0 恢复行为。

### Minor

#### M1 — snapshot commit message 漏了 §9.3 明确要求的标题和可信 trailers

- **位置：** `src-tauri/src/project_share.rs:5178`。
- **问题：** 实际为 `notemd: snapshot <id>\n`，没有 `share`，也没有 `Notemd-Project` / `Notemd-Snapshot` trailers；没有对应 Ruling 修改此契约。现有 G2 只验 parent/tree，漏掉完整消息。
- **影响：** 隐藏 ref 当前仍能定位对象，所以不是数据安全阻断；但对象脱离 ref 后缺少承诺的项目/快照归属信息，规范不完全符合。
- **建议：** 使用 §9.3 的完整固定消息，增加完整字面 body 断言。不要覆写已存在的 create-only ref；如需处理旧本机 P1 产物，明确语义兼容策略。

#### M2 — 全部建议已存在于 HEAD 时，C 会保存无法直接 git am 的空变更补丁

- **位置：** `src/lib/project-share/git.ts:32`；`src-tauri/src/project_share_git.rs:506`；成功提示 `src/lib/project-share/review.svelte.ts:393`。
- **问题/证据：** 实际 kernel 输入 `base=base, ours=changed, theirs=changed` 时 total=0，prepareGitReview 放行并产生 result=current。真实 Git 以相同 tree、parent H 建提交后 format-patch 输出只有邮件头/署名的补丁；本机 2.50.1 默认 `git am` exit 128，stdout 为 `Patch is empty.`，需额外 allow-empty 或 abort 操作。不是前一历史提交泄漏，也不是零字节文件。
- **影响：** 这是安全的边界 UX/可用性缺口，但“补丁已保存”容易被理解为可按常规 git am 应用，G10 现有用例没有覆盖无需合入的投稿。
- **建议：** 当确认结果对 H 没有实际变更时，明确告知已经包含/无可导出变更，避免生成和占用无用 exports ref；或明确支持空提交流程并向用户解释所需操作。独立于 I1–I4，可由本次修复波次顺带最小处理或明示延后。

## Deferred / parked / 跨任务事项的最终 triage

| 事项 | 独立判断 | 发布含义 |
| --- | --- | --- |
| Task1 M1：存在的非法 UTF-8 sourceRoot 未真实构造 | 保留非阻塞环境限制。probe 在 canonicalize 后 to_str fail closed；本机 os92 的缺失路径测试不能冒充存在非法 UTF-8 目录验证。 | 不必为此卡住 macOS 宿主；未来能创建该目录的平台补验。 |
| Task2 M2：search attention 一次 expected10 got0 | 根因仍未知。与本轮分享改动缺少因果证据，focused/后续完整套件通过；不能宣称“已修复”。 | 非 P1 当前阻断，保留具名跟踪，后续再复现应独立定位。 |
| Task2/Task3/Task4：ParsedHeader、happy-dom、33 Svelte warnings/16 files、chunk noise | 既有噪声如实保留；报告和 root 的逐诊断比较与当前证据一致。 | 不把已有噪声变成新产品 defect，也不能写 pristine。 |
| Task3 I1：父组件必改清单修订 | 接受正式修订的工程理由：既有 isBusy/关闭/切项目消费已存在且新父组件测试覆盖；无需制造无功能 hunk。 | 已关闭，不阻塞。真实 native 仍未被该测试证明。 |
| Task4 M1：author 边界期望部分由 helper 生成 | 保留低优先级测试改进。普通名/空名有字面断言，真实 git am 证明 suffix/email 保留，但 40/41、Unicode/@ 精确输出仍可加强独立 oracle。 | 非阻塞；建议统一修复波次用几条字面期望补足。 |
| Task4 not_applied 最小例外 | **不能按已关闭处理，提升为 I1。** exact 状态入口安全方向正确，但前端可达性与最终记录均缺失。 | 修复前阻塞。 |
| Task4 mailinfo 40 bytes + @ 清洗 | 接受其必要性与范围：共享 helper 处理 Git 身份，v1.name 原载荷未改；长 Unicode、@、普通/空名真实 am 覆盖有价值。 | 除上述 oracle 加强外无新的阻断发现。 |
| G6 全 Store / public branch_intent / G1 全字节 / same Vault | 所提供实现与测试确实补上跨任务验收，不再只靠原语或承诺。same-Vault P0 镜像/私有元数据变化与 Git 阶段边界说明合理。 | 对一般路径通过；不抵消 I1/I2/I4 的未覆盖路径。 |
| P1 native UI、OS picker、iOS | 确实未验证；Chrome 生产组件+真实 Worker 使用内存 bridge，父 Dialog 是 happy-dom。没有 native 证据。既有 picker/fs 接缝及 patch filter 已定点检查，不等于实机验收。 | 不可宣称 P1 原生或 iOS/TestFlight 已验；建议发行前补 P1 原生 B/C smoke。iOS 发布不能由 macOS/Chrome 推定。 |
| Worker 免费 CPU 残留 | P1 没有 Worker/plugin 源码变化；旧 archive seal/status-cleanup 各10ms 未满足严格 <10ms，10+10/KV 最终验收未完。未把旧 force-pull 候选恢复为当前发行属于明确范围决定，不能抹去未完成事实。 | **宿主发版不等于免费上传方案全完成**。该独立残留不应伪装为 P1 已通过项，也不要求本 P1 review 恢复旧 Worker 候选。 |
| 已授权统一发行、Memory/Rich、插件及旧 stash/分支 | 已读正式发行前盘点及 root 最新审计摘要；Memory/Rich actual patches 保留，未更改插件/Worker 不需要假造新版本。排除旧开发环境、旧 stash/设计稿的裁定有具名依据。 | 最终线上核验和双架构七资产仍待实际执行；本审查不声明发布已完成。 |

## 验证依据与范围

- 对 root 的原始最终证据做独立只读复核：五个冻结源码 SHA 全部与实际文件一致；六日志 SHA 与正式报告一致；JSON 六个 exit 均为 0。Cargo 原始日志的 22 段 summary 合计 1427 passed / 0 failed，与报告一致。前端 323 files/3859、Worker 8/255、check 0/33、Vite/EditorKit build、diff 均按既有材料记录，未重复执行。
- 额外实验仅针对本次新发现的具名风险：实际生产 controller/kernel 的 not_applied、重开 mixed intent、Git reject 请求；本地 partial clone 的 lazy fetch/no-lazy-fetch；实际 kernel 的无差异结果与真实 git am 空变更。前端使用内存命令返回，不冒称 Rust/native E2E；后端结论对应已完整阅读的真实分支。首个 Vite harness 在关闭时产生依赖扫描取消噪声，随后禁自动发现的同风险 harness 干净完成；没有把工具噪声算作产品失败。
- 额外定点周边读取仅有：`project_share.rs` 中被 diff 截断的 recover/reject（I4）；`platform.rs` command 环境（I3）；既有 `dialogs.ts` 和 capabilities 的保存权限/patch filter（native bridge 边界）。未重新展开其他 changed files 或进行无关源码普查。
- Git fixture 全是独立 tempfile；partial-clone 的 clone/fetch trace 只针对本地 file origin，无公网 Git、无当前仓库 ref/工作区/index 操作。没有运行 release/tag/push/部署。

## Spec / 质量 / 发布判断

- **Spec：不通过。** I1 与本轮最小 not_applied Ruling 的最终行为不符，I2 的持久恢复契约未贯穿 UI，I3 违反明确的产品无网络 Git，I4 漏掉了新目标 UI 下的恢复副作用边界。M1 是较小但明确的 §9.3 格式遗漏。
- **质量：Needs fixes。** 核心锁、对象隔离、唯一合并内核及常规 UI 验证做得好；主要问题集中在状态枚举跨层同步、持久状态与内存状态衔接，以及 Git 隐式行为。修复应维持既有 fail-closed/owned ref/两锁外 CLI 设计，避免扩大普通混合终态放行。
- **Ready to publish? No，当前不建议发布。** 将 I1–I4 统一修复并通过一次 scoped 复审后，可重新判断宿主发行；M1/M2 及 deferred 要逐项修复或具名裁定，不应被静默删除。签名/公证、双架构七资产、匿名 SHA/updater/latest 与最终 Worker/插件状态尚待实际发行验证。即使宿主发行完成，P2/E1–E4/P3、P1 iOS/native 未验项目及 Worker 免费 CPU 未完成项仍需独立如实陈述。


---

# 唯一限定复审（最终）

**I1 — `not_applied` 的 UI 入口与最终落盘不一致 — ADDRESSED。** `src/lib/project-share/review.svelte.ts:364` 要求已成功加载 file/proposal，仅额外放行无 Decision / 明确 `not_applied`；已有全部 branched 可 C 例外保留。`src-tauri/src/project_share.rs:5761` 对整份 edit 校验最新决定，允许 `not_applied` 和同 branch+commit 的幂等 branched，`src-tauri/src/project_share.rs:5791` 再写回全部或指定 edit。`src/lib/project-share/review.test.ts:641` 实际 controller/内核覆盖 B/C 可达与八类其他状态阻止；`src-tauri/src/project_share.rs:1976` 的两 edit Store 回归实际从 pending 恢复为 not_applied，断言 B 无 stateError、全部 branched、逐文件重复补记相同，C 保持 not_applied 与另一文件无 Decision。原来仅 `is_ok()` 的漏检已移除。

**I2 — 持久 branch intent 重开后无可信补记入口 — ADDRESSED。** `src/lib/project-share/review.svelte.ts:200` 在 B/C 打开时查询 `branch-state`，重建真实结果；现有 `src/lib/project-share/review.svelte.ts:404` 仅发 `git-branched` 补记。`src-tauri/src/project_share.rs:5645` 新增本机请求，`src-tauri/src/project_share.rs:5942` 捕获可信冻结输入，`src-tauri/src/project_share.rs:5989` 验证自有 intent 对应 ref，`src-tauri/src/project_share.rs:6013` 共用 authored commit 校验，以 intent 原 H 验 parent/message/author，持久 immutable commit OID 固定完整 tree；不要求当前 HEAD 等于原 H，不重跑 clean。`src-tauri/src/project_share.rs:6028` 在验证后再次读取实际 ref，随后 `src-tauri/src/project_share.rs:6039` 重验最新绑定、范围、snapshot identity、完整 envelope、A intent 与全部 edit 决定。查询路径没有源、镜像、inbox、Decision 或 ref 写入；Git CLI 在 operation lock 内、PROJECT_LOCK/RecordsLock 外。

**I2 安全与恢复证据 — PASS。** `src-tauri/src/project_share.rs:2080` 覆盖实际 ref 创建后记录失败、all-none 丢结果、首文件补记成功/第二文件真实写入失败、新建独立 Store 实例重开及 HEAD 前进；查询前后比较源/index/HEAD/config/hooks、完整镜像私有文件及 refs，之后只补记且没有第二分支。`src/lib/project-share/review.test.ts:688` 用新 session 验证只执行两个 `git-branched` RPC。`src-tauri/src/project_share.rs:2136` 覆盖九类迟到变更与同 OID 无 owned intent 的用户分支；`:2179` 覆盖 parent/author/message/snapshot ref 不匹配；`:2208` 在真实 Git child 阻塞时取得两锁；`:2975` 把非幂等 clean 配置改为 exit 99 后仍能查询。以上具名 Rust 测试均见最终 cargo raw log 的 `ok`。

**I2 Ruling 31/32 与 A 恢复兼容 — PASS。** `src-tauri/src/project_share.rs:5947` 无 intent 返回 null；`:5990` 缺失 ref 在最新元数据验证后返回 null，不清理 intent 或复建分支；存在但已变化的 ref 拒绝。普通 B 的 expectedHead 与混合终态门禁仍在 `:6073`。`:5997` 仅当 snapshot.git 为 Some 才验证 snapshot ref/非祖先关系；`:2121` 实际覆盖先 P0 冻结、后初始化 Git 的合法 B 恢复，未伪称验证不存在的 Git 快照对象。`src/lib/project-share/review.test.ts:715` 覆盖 query 失败使 B/C 不可执行，而显式切 A 仍能进入原恢复流程。

**I3 — partial clone 隐式 fetch 越过无网络 Git 边界 — ADDRESSED。** `src-tauri/src/project_share_git.rs:25` 的唯一分享 `run_io` 为每个 child 添加受 Git 识别的全局 `--no-lazy-fetch`；本次 text、ls-tree、cat-file、format-patch 改为汇入该入口，定点搜索确认其余生产 tree/ref/cleanup 调用也经 text/run_io，直接共享 runner 调用仅剩该入口，其他命中位于测试模块。`src-tauri/src/vault_sync/git_ops.rs:99` 的程序/env override 全部 cfg(test)、线程限定并以 Drop 清理，正常 vault-sync 生产联网行为未改。`src-tauri/src/project_share_git.rs:845` 用真实本地 file partial clone 分别缺失 promisor blob/tree，断言失败、零 fetch/upload-pack/transport 与缺失集合不变；`:866` 旧能力 shim 验证在对象读取/建 ref 前失败。`src-tauri/src/project_share.rs:2228` 对旧能力与缺失 tree 均实际完成 P0 freeze/import/apply。旧 Git 实机兼容未被 shim 证明；不支持此 option 的旧 Git 全部 P1 Git 目标降级 P0 是已接受的限制。

**I4 — B/C 拒绝文件误入 P0 recovery — ADDRESSED。** `src/lib/project-share/review.svelte.ts:330` 明确发送当前 target；`src-tauri/src/project_share.rs:1629` 经 `feedback_for_review_target` 选择 B/C raw inbox + 全投稿 A intent 守卫，`:6317` 解析可选 GitTarget；缺省/worktree 保留原 load_feedback/recover。`src-tauri/src/project_share.rs:2061` 对 B/C × pending/mirror_pending，先实际只读打开，再向不同的 annotation-only path 注入 intent，拒绝 edit 必须失败且源/镜像/含 inbox、intent、review 的私有文件逐字节不变；同 fixture 随后无 target 的 reject 实际完成原 P0 恢复。`src/lib/project-share/review.test.ts:660` 另验显式 target、错误保留及切 A 可达。

**M1 — snapshot 消息缺固定标题及归属 trailers — ADDRESSED。** `src-tauri/src/project_share.rs:5448` 使用完整 `notemd: share snapshot <id>`、空行、`Notemd-Project`、`Notemd-Snapshot` 与结尾换行。`:2018` 用字面完整 body 验证，随后放入旧消息 ref，实际重试必须报告不同 content/identity、保留旧 OID，Git 错误落盘而 P0 snapshot.files 仍保留。没有覆写或迁移 create-only 旧预览对象。

**M2 — 无实际变更仍导出空补丁 — ADDRESSED。** `src/lib/project-share/git.ts:33` 对所有 result 与固定 H 文本相同的结果在确认前明确提示已包含/无需合入；`src-tauri/src/project_share_git.rs:266` 比较实际 tree，`src-tauri/src/project_share.rs:6099` 在新 ref/Decision 前拒绝同 tree，涵盖 clean 规范化。只读 branch-state/git-branched 恢复在该新建路径之前处理，已有自有分支补记不受影响。`src/lib/project-share/review.test.ts:674` 对 B/C both-same 断言零确认/picker/branch/export/save；`src-tauri/src/project_share.rs:2040` 对字节相同与 clean 后同 tree 的 B/C 验证零新 ref、零 Decision/inbox 变化。后者由 Rust 在新建前拒绝，没有把文本比较声称为 clean 后 tree 的前端预判。

**Task 4 deferred author literal oracle — ADDRESSED。** `src-tauri/src/project_share_git.rs:882` 独立字面断言 40a→40a、41a→40a、39a+中→39a、去 @、普通名、空名回退及固定后缀。`src-tauri/src/project_share.rs:1882` 实际 `git am` 边界输入与 `:1914` 的固定完整 name/email 预期对应；含 @ 用例也调用同一路径。指定六种边界预期均不依赖 production `guest_author` 生成；原 v1.name 保留断言仍在。

## New Breakage in the Fix Diff

**None — 0 Critical / 0 Important / 0 Minor。** 完整核对这次修复自身的生产与测试 hunk，未发现新增阻断或需单列的 Minor。未扩展到第二次 whole-branch 发现波次。

## Out-of-Scope Observations

**无新增 Out-of-Scope finding。** 沿用冻结 final-review 的非阻断限制：P1 native UI/OS picker/iOS/TestFlight 未验；存在的非法 UTF-8 sourceRoot 目录在本机未构造；旧 search attention 一次失败根因仍未知；既有 ParsedHeader、happy-dom、33 Svelte warnings/16 files 与 chunk 噪声保留。Worker seal/status-cleanup 各 10ms 的严格 <10ms、10+10/KV 最终验收仍未完成；P2/E1–E4/P3 未实施。宿主发行不等于这些事项完成。

## Checks

- **Scope — PASS。** 依据指定 re-review 模板，读取 final-scoped-review-context、final-fix-brief、冻结 final-review、final-fix-report、constraints 与 progress 全部 32 条 Ruling。完整 fix package `review-4a2ca1c9..2c9f1659.diff` 90468 bytes / 1446 行以五个连续 pass 读完一次；BASE `4a2ca1c9d5ff27dc2e6f9809adcbf48fec39ae91`，HEAD `2c9f165918297e4b089e3c56c4e876401edfc53d`，1 commit / 9 files。其后只定点补读上述控制流、验证 helper、测试 fixture 与 UI 恢复按钮的周边上下文；未重新获取分支 diff。
- **RED/GREEN evidence — PASS。** 核对既有 raw logs 与修复断言：前端初始 8 failed/66 passed；Rust `final_ --lib` 初始 6 failed/2 passed；I1 单测实际返回 stateError 导致失败；query 失败误放行、late ref 变化漏检、无 Git snapshot 多余拒绝均有各自行为 RED。最终定向前端命令 `pnpm exec vitest run src/lib/project-share/review.test.ts src/lib/project-share/git.test.ts src/components/project-review/ProjectReview.test.ts src/components/ProjectShareDialog.test.ts` 为 4 files/135 passed。最终完整 cargo log 对所有上述具名 Rust 回归记为 ok。编译失败记录未被计为行为 RED。
- **Final six-gate evidence — PASS。** 读取 `final-fix-gate2-results.json` 与原始摘要，独立只读计算八源码与六 raw log SHA，全部与 manifest 相符；六 exit 均 0、source_unchanged=true。`pnpm test` 323 files/3876 passed；`cargo test --manifest-path src-tauri/Cargo.toml` 22 summaries，独立累加 1439 passed/0 failed/0 ignored；`pnpm --dir worker test` 8 files/255 passed；`pnpm check` 0 errors/33 warnings/16 files；`pnpm build` Vite 与 Editor Kit OK；`git diff --check` 原始日志为空、exit 0。33 个完整 warning block 与 baseline 的逐字相同结论沿用 root 已完成的直接复核；本 review 未重复该比较。
- **Verification boundary — PASS。** 没有运行测试、六 gate、Git/ref/index 操作或网络/发布命令；读取代码未产生需要既有运行之外 focused 实验才能判定的具名疑点。前端证据为生产 controller/内核配内存 command bridge，Rust 证据为真实 Store/Git；不能合称 native E2E。本 reviewer 唯一写入为本报告，未派子代理、未创建 worktree、未改产品或 ledger。

## Verdict

**Fix round：All findings addressed, no new Critical/Important breakage。** I1–I4、M1–M2 与 Task 4 literal oracle 全部关闭，无 open finding。

**Spec：PASS。Quality：Approved。Ready to publish：Yes，就本次 P1 源码复审可进入既定宿主发行流程。** 本结论不代表发行已经完成；签名/公证、双架构七资产、匿名 SHA/updater/latest 及最终插件/Worker 线上状态仍由 root 按已授权发行流程执行验证，native/iOS 与上述独立未完事项继续如实披露。
