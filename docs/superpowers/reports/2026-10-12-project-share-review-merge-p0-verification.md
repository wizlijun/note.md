# 项目分享评审合并 P0 验证记录

日期：2026-10-12。起点：`ce070741`。工作位置：当前 `main`，未创建 worktree。

状态：十个 P0 实现任务均通过独立规格与质量审查；全量及原生功能验收通过，整轮最终审查待完成。

范围：[P0 实施计划](../plans/2026-10-12-project-share-review-merge-p0.md)。基于已批准 spec，实现现有 v1 外部反馈的三方逐处审阅、批注提升和安全写回。P1 Git、P2 协议/回执、E1–E4 访客富编辑与离线协作、P3 未在本轮实施。Worker 与访客协议保持既有版本。

## 已完成任务与审查

| 任务 | 提交终点 | 独立审查与证据 |
| --- | --- | --- |
| 1 无损分词/hash/EOL | bc8d62f2 | Approved；21 定向测试；修复三轮扫描边界 |
| 2 三方提案 | de0cc445 | Approved；累计 56 内核测试 |
| 3 风险/compose | 1c94bfa7 | Approved；累计 100 内核测试 |
| 4 批注/anchor/rebase | c51463e0 | Approved；累计 125 内核测试；anchor 性能边界保留复核 |
| 5 纯净边界 | 1912da44 | Approved；53 定向 gate 测试；WP0.1 四项全量通过 |
| 6 Rust 持久化/IPC | 19360e35 | Approved；14 新增真实磁盘测试；与任务 7 统一提交 |
| 7 公开投影/host | 19360e35 | Approved；WP0.2 前端 3753、Rust 1381、Worker 255 全量通过，构建通过 |
| 8 状态机/Worker | ea3e02d5 | Approved；26 controller+7 client 测试；flush 等待批注期间新增决定丢失回归已修复 |
| 9 审阅 UI/安全渲染 | 74eeb354 | Approved；182 定向测试，随后 15 项渲染修复验证；Chrome 实际组件操作通过 |
| 10 集成/原生/最终验收 | 3e98554f / 05a4bc8e | Approved；真实 Wry→IPC→磁盘通过；范围移出后仍可写回缺口已修复；手工方法限定修订透明记录 |

任务测试数量是各次运行的覆盖范围，不相加充当独立测试总量。全量最终数字以末尾完成记录为准。

## 浏览器验证

Chrome 154.0.8037.99，真实生产 Svelte 组件、session、merge Worker、DOMPurify；文件和 IPC bridge 为内存 fixture，因此此层不声称真实 Tauri 文件端到端。

- 390/600/800/1000px 无横向溢出；深色、滚动、焦点限定及 Escape 通过。
- j/k/a/r/e/⌘↩ 与输入区抑制通过；鼠标聚焦 hunk 后快捷键作用目标已修复。
- 全局菜单 hover 为 accent 蓝底白字。
- 默认自动外网资源请求 0；主动加载图片一仅该 URL 请求一次。
- 文本、批注合成一次 apply；完整确认含未决数量；源和镜像刷新通过。
- 渲染隐藏字符与实体解码字符显示 code point，原文不变，自动资源请求仍为 0。
- root 实际查看 800px 深色审阅和全文确认截图。

## 原生与全量最终验收

真实隔离 Tauri 2.11.1/Wry/WKWebView 挂载生产 Dialog/ProjectReview/session/merge Worker，真实 fs/store/os/dialog plugins 和 Rust dispatch。测试驱动未替换 Tauri bridge。随机 `net.notemd.task10.*` identifier、incognito WebView、managed 临时 Vault，未启动用户正式宿主。root 已独立核对 main/edges result.json、有效 expectedHash 的 scope 拒绝、nativeDialogCancel trace、各命令退出码及 cleanup。

- S1 成功发布、未发布中间快照、S2 成功发布；S2 parent 仍指向 S1。
- 基于 S1 的反馈叠加主人后续修改；决定关闭重开恢复。
- 确认取消不写回；正文与批注一次 apply，源与镜像一致，未分享文件/图片字节不变。
- 第二份相同建议得到 both-same。提升批注与建议处于同一原子块时可形成 conflict，已有单独回归，不将其隐藏为自动合入。
- 确认期间原件变化时 CAS 拒绝，刷新横幅、提案，不自动重试覆盖。
- 当前分享范围移除后，review 与有效 hash 的 apply 都拒绝，源/镜像字节不变，仍可拒绝反馈；修复经过真实磁盘 RED→GREEN。
- 源目录缺失只能复制/拒绝；切项目重新读取提案。
- 真实 RichEditor flush 保存原件和镜像；自身原生 attachedSheet 按钮执行 No，双方内容分别保留，无关脏标签不变。

OS 级手工鼠标、焦点、AX 与原生截图未验证：CUA 按精确独立 bundle ID 与临时 .app 路径均返回 cgWindowNotFound。真实 WKWebView DOM 操作与自身原生 NSButton 动作证明功能链路；不把 Chrome 截图标为原生截图。计划方法修订经过独立复审，未更改产品测试阈值。

| 最终命令 | exit | 实际结果 |
| --- | --- | --- |
| pnpm test | 0 | 321 suites / 3809 passed |
| cargo test --manifest-path src-tauri/Cargo.toml | 0 | 1383 passed，1194 lib，22 targets，0 failed/ignored |
| pnpm --dir worker test | 0 | 8 suites / 255 passed |
| pnpm check | 0 | 0 errors / 33 warnings in 16 files |
| pnpm build | 0 | 14 production TS purity gate、版本核对、Vite、Editor Kit build OK |
| git diff --check | 0 | 无空白错误 |

前端首轮全量有一次 release-plugins 既有重试用例 5000ms 超时（实际 7773ms，3808 passed/1 failed）；与原生编译/启动重叠，资源竞争仅推测。保留该失败后，在原生退出、未改代码/阈值/测试的条件下完整复跑一次通过，没有不断抽样到绿。

隔离 fixture/.app/data/config/cache/进程均回收，专有 harness target 产物按精确 crate 名删除，共享 target/依赖与用户已有文件保留。临时日志待整轮审查后清理，关键结果与裁定保存于本记录。

## 基线告警及待最终审查项目

svelte-check 基线为 0 errors / 33 warnings in 16 files；已有 happy-dom CSS/AsyncTaskManager、Rust unused import、构建 chunk、workerd 运行时噪声按实际全量结果记录，不表述为无警告。

最终审查需处理：高重合模糊 anchor 的 Worker 响应性；组件快捷键测试的事件监听范围；风险未决状态文案；既有告警范围。此处未预先判定这些项目可忽略。

## P0 覆盖矩阵

以下 A 为真实原生 IPC/磁盘，B 为 Chrome 真实组件加内存 bridge，C 为自动化内核/组件/磁盘 fixture。各证据边界按上文区分。

## K1–K19覆盖矩阵

以下C测试均由本轮全量执行，未重复另跑既有case；A/B evidence边界如上。

| ID | P0验收与实际证据 |
| --- | --- |
| K1 | proposal.test identical/empty/large，0hunks；C通过。 |
| K2 | proposal.test visitor-only + compose，C通过；A正文乙改明确接受后写入。 |
| K3 | proposal.test同段第一/第三句独立，C通过。 |
| K4 | proposal.test相邻句独立，C通过；本轮TS fixture亦保留指定简例。 |
| K5 | proposal.test同句冲突，C通过；ProjectReview conflict控件/未决禁写，B/C通过。 |
| K6 | proposal.test both-same，C通过；A第二份相同提交both-same=1。 |
| K7 | proposal.test两端点插入冲突 + diff3 overlap，C通过。 |
| K8 | proposal.test fenced code atomic，C通过。 |
| K9 | proposal.test不同table rows，C通过。 |
| K10 | flags.test title/tags sortedkeys，C通过。 |
| K11 | flags.test六trustkeys插删改 + compose bulk excludes，C通过。 |
| K12 | eol/proposal/compose CRLF+BOM，C通过。 |
| K13 | flags hiddenchars multiplicity，C通过；Task9隐藏codepoint源码/渲染browser修复证据B通过。 |
| K14 | tokenize 600 seeded + compose 500 seeded + proposal 500 seeded，C通过；A未分享文件/image/b字节断言。 |
| K15 | proposal determinism/ID stability/ordinals，C通过。 |
| K16 | compose partial writeback V5 + review alreadyincluded终态，C通过；本轮A旧S1第二建议both-same。inline promoted atomic段实际conflict另有回归，未掩盖。 |
| K17 | proposal token>200000、D>20000与边界，C通过。 |
| K18 | anchor exact/prefix/suffix/fuzzy/orphan/point/threshold，C通过。Task4 anchor性能minor由root triage，本轮未改内核。 |
| K19 | critic extraction/rawmultiset/ownerdeleted/UTF16 selector，C通过。 |

## R1–R10覆盖矩阵

| ID | P0验收与实际证据 |
| --- | --- |
| R1 | session debounce/flush/destroy/reopen Rust草稿 roundtrip；C通过；A关闭重开恢复accept决定。 |
| R2 | compose四风险排除 + ProjectReview bulk测试；C通过。 |
| R3 | session与ProjectReview下一submission读新current；C通过；A先apply后第二份重算both-same。 |
| R4 | session declared oldbaseline/Rust snapshot parent + A明确S1反馈、当前S2与owner edits；通过。 |
| R5 | session refresh once/no retry + RustCAS；C通过；A确认期间磁盘修改后拒绝/横幅/无覆盖。 |
| R6 | 本轮Rust scope RED/GREEN、A范围移出与源目录移走；copy可用/reject真实成功；无写。 |
| R7 | render/ProjectReview XSS DOM/DOMPurify；C通过；Task9 browser活动节点0，B通过。 |
| R8 | Task9真实Chrome context请求监听/路由阻断，自动外网0、显式单图一次；B通过。本轮native不另声称请求监控。 |
| R9 | session sanitize/promotion/point/overlap/reanchor；C通过；A正文+promotion一次apply与持久promoted。 |
| R10 | compose/session/ProjectReview unresolved conflict禁写；C通过；B实际手改冲突再确认。 |

## I1–I8/I12–I14与兼容

| ID | P0部分与边界 |
| --- | --- |
| I1 | Rust snapshot不可变/review读取声明snapshot、TS oldbaseline、A S1/S2；通过。 |
| I2 | 新review/annotation-state不写源，apply沿用CAS/intent/recovery/idempotence；Rust全量通过。本轮仅bound_source gate，无新增写源路径；fixture owner输入与生产saveTab是既有正常编辑路径。 |
| I3 | 明确接受/确认，无bulk风险自动接受；A取消无写、native ask No不覆盖；C/B通过。 |
| I4 | 单一share-merge实现；kernel purity script包含故意违规样例自测，pnpm test通过；harness仅转发productiondispatch。 |
| I5 | version=1/确定性/hunkID，C通过，本轮未改算法版本。 |
| I6 | 500+/CRLF/BOM/UTF16拒绝还原，C通过；实际非分享字节不变A/C。 |
| I7 | P0继续兼容旧v1 afterMarkdown，未改访客编辑器/协议；已有分享页面与Worker全量通过。P2 lossless访客编辑器未实施，不能用P0兼容冒称P2字节编辑证明。 |
| I8 | Worker未修改，255 tests形状/鉴权/存取兼容通过；无diff/merge/render新增。 |
| I12 | P0 receipt保留空/现有字段兼容、无新增回执外发；Rust公开投影白名单通过。P2回执生成/正文排除完整流程未实施。 |
| I13 | C/B安全渲染/无自动remote请求/净化name评论/隐藏字符可视化，A真实文本输入与IPC；无AI写工具行为新增。 |
| I14 | 自报访客标记、sanitize promotion，trust字段不bulk/不自动改verified；C/B通过，A注释署名native-visitor；P1 git actor及P2新身份完整流程未实施。 |

旧v1 manifest/inbox/feedback/分享链接：Rust legacy disk/strict IPC legacy omissions 与Worker/分享页测试全量通过；公开包白名单/无parentSnapshotId/git/gitError/本机绝对路径由既有Rust bundle/projection测试全量覆盖；A snapshot/bundle实际使用。CAS/recovery/镜像部分失败/idempotence由Rust既有回归全量覆盖，A进一步证明CAS拒绝与一次apply。所有截图仍为Task9 B等级：layout-800-dark.png、confirm-dark-800.png、menu-hover-dark-800.png、hidden-chars-render-dark-800.png，已在Task9视觉核验，本轮未重标native。


## 整轮最终审查

待完成。审查范围固定从 ce070741 到本轮交付，包含全部产品与测试改动；此前任务审查不代替这一 gate。

## Rulings I made

逐条保留执行 ledger 的全部裁定及误判代价，按作出顺序排列。

Ruling: Execute P0 plan only — user continued the delivered P0 plan; other spec stages remain separately tracked — cost if wrong: later stages require additional implementation, never claim full spec done.

Ruling: Work on existing main without worktree — explicit user constraint overrides skill isolation default — cost if wrong: changes share checkout; sequential writers and precise commits mitigate.

Ruling: Define hidden-character risk as newly increased occurrences relative to base of U+061C, U+200B–200F, U+202A–202E, U+2060, U+2066–2069, U+FEFF — spec names bidi/zero-width without an exhaustive set; this explicit conservative policy covers direction controls and joiners — cost if wrong: legitimate new joiners require manual acceptance, and the set may need a versioned expansion.

Ruling: eol-only means ours differs from theirs but both equal after CRLF/CR normalization to LF — spec says only line endings differ — cost if wrong: display classification may need revision; no source normalization is introduced.

Ruling: Purity roots exclude *.test.ts, while any production import resolving to a test file is rejected — kernel tests legitimately use Vitest, Web Crypto and performance APIs as independent oracles; the pure boundary is shipped production code — cost if wrong: test-only dependency hygiene is outside this gate, but cannot enter production through tests.

Ruling: Use Vite ?worker import for merge dispatch rather than Task8 example new URL constructor — spec §7.8 and Global Constraints are binding — cost if wrong: bundler-specific adapter needs revision, pure kernel remains unchanged.

Ruling: Implement annotation promotion construction in Task8 controller, with Task9 UI and integration coverage — Task8 writeFile already requires a complete once-only final text, and UI must not own a second algorithm — cost if wrong: moving the helper later is mechanical; all promotion acceptance requirements remain.

Ruling: Move all annotation anchoring to asynchronous batches in the existing merge Worker adapter during Task8 — measured1743ms fuzzy calls can block the owner UI even on small files; shared kernel thresholds and search remain unchanged — cost if wrong: Worker startup/availability becomes necessary for locating annotations; failure must preserve decisions and allow copy/ignore without unsafe promotion.

Ruling: A zero-actionable-hunk submission (including all both-same) uses confirmed existing apply(current,{accepted:0,total:0}) to record accepted; reject only total>0/accepted0/no promotions — text equality alone cannot distinguish already-included suggestions from rejection — cost if wrong: no-op atomic write may update source mtime; no bytes or protocol are changed.

Ruling: Restrict manual hunk editing and e shortcut to conflict; theirs-only exposes accept/reject — spec §7.7 formal HunkDecision union is binding over §8 general edit wording — cost if wrong: owners must edit nonconflicting suggestions in the source editor after review; supporting direct editing needs an explicit contract/kernel revision.

Ruling: Use the real isolated Wry/WKWebView DOM driver for functional native UI→IPC→disk acceptance after CUA getApp fails cgWindowNotFound with both exact bundle ID and temporary .app path; keep OS-level manual focus/first-mouse and native screenshots explicitly unverified — real command/storage behavior remains testable without touching the user app or system permissions — cost if wrong: OS-level interaction/visual regressions may remain until a working desktop session permits manual verification; never label that gap passed.

Ruling: Amend Task10 Step2 manual-only method to real isolated Wry UI automation with actual IPC/disk, preserving OS manual checks as explicitly unverified — the plan introduced this stronger method; binding spec §17 WP0.3 requires R1–R10 functional tests and reserves explicit manual IME acceptance for excluded E1 — cost if wrong: OS interaction regressions remain possible and need later desktop manual checks; no test threshold, product invariant or native functional assertion is relaxed.
