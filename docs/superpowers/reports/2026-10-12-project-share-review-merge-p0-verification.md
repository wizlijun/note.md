# 项目分享评审合并 P0 验证记录

日期：2026-10-12。起点：`ce070741`。工作位置：当前 `main`，未创建 worktree。

状态：**P0 已完成**。十个实现任务均通过独立规格与质量审查；整轮审查发现的 4 项 Important、2 项 Minor 已统一修复于 `c0a63477d979cfd1123498baaf72478ad031f0c8`，唯一一次定向复审全部 ADDRESSED，无新增问题，Ready: Yes / spec + quality: Approved。最终产品代码全量检查通过。

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

## 原生验收与最终全量检查

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
| pnpm test | 0 | 321 suites / 3832 passed |
| cargo test --manifest-path src-tauri/Cargo.toml | 0 | 1383 passed，1194 lib，22 targets，0 failed/ignored |
| pnpm --dir worker test | 0 | 8 suites / 255 passed |
| pnpm check | 0 | 0 errors / 33 warnings in 16 files |
| pnpm build | 0 | 14 production TS purity gate、版本核对、Vite、Editor Kit build OK |
| git diff --check | 0 | 无空白错误 |

上表是修复终态 `c0a63477` 的全量结果，由 root 逐项读取日志和退出码，严格顺序执行；Rust 22 targets 合计 1383，0 failed/ignored。此次全量没有失败。早先任务 10 的真实原生验收在 `3e98554f`，最终 JavaScript 修复另由下节实际 Chrome 父子组件/Worker 验证，不将先前原生运行冒称本次修复的原生复验。

任务 10 前端首轮全量有一次 release-plugins 既有重试用例 5000ms 超时（实际 7773ms，3808 passed/1 failed）；与原生编译/启动重叠，资源竞争仅推测。保留该失败后，在原生退出、未改代码/阈值/测试的条件下完整复跑一次通过，没有不断抽样到绿。

隔离 fixture/.app/data/config/cache/进程均回收，专有 harness target 产物按精确 crate 名删除，共享 target/依赖与用户已有文件保留。临时日志及截图在整轮复审与记录完成后按 Superpowers 只清理本计划 workspace；关键结果与全部裁定保存于本记录。

## 基线告警及性能边界

svelte-check 基线为 0 errors / 33 warnings in 16 files；已有 happy-dom CSS/AsyncTaskManager、Rust unused import、构建 chunk、workerd 运行时噪声按实际全量结果记录，不表述为无警告。

root 逐条比较基线与修复终态 svelte-check 的文件名/诊断文本多重集合：33→33 完全相同，无新增或删除。快捷键测试范围和风险状态文案在本次统一修复，见下节。高重合模糊 anchor 仍有单条约 1743ms 的既有计算边界；内核搜索阈值不变，在现有 Worker 异步批次中计算，loading 期间可安全关闭并取消、迟到结果隔离。此处不宣称模糊搜索算法已提速。

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

整轮独立审查：`ce070741..1957385a`，完整 482039-byte 差异包，结论 With fixes：0 Critical、4 Important、2 Minor。统一修复：`1957385a..c0a63477`，11 文件，254 增加/59 删除；唯一一次定向复审使用 49223-byte 完整修复差异包。独立复审结论：六条全部 ADDRESSED，无新 Critical/Important/Minor，无范围外 finding，无 parked finding；Ready: Yes / spec + quality: Approved。root 已完整读取报告并核对证据，之前逐任务 Approved 未代替本 gate。

| Finding | 修复与覆盖证据 |
| --- | --- |
| I1 切文件丢失刚保存的决定 | UI flush 后按 submissionId 获取最新对象；controller 同提交重开不恢复过期引用。覆盖 a→a、a→b→a、保存中追加手改，实际组件和 Chrome 恢复已接受。 |
| I2 未闭合原子语法平方扫描 | HTML 三态引号结束索引、按需构建 link destination 三态括号索引，保留转义/嵌套/label 语义。已实测同类 `[x](` 路径按 Ruling 13 纳入同一波次。 |
| I3 裸 CR frontmatter 绕过信任字段保护 | 删除 host 自有正则，复用内核 sourceLines/frontmatterTokens。LF/CRLF/CR × BOM/无 BOM × `---`/`...` 共 12 组及 compose 后重锚定入 verified 字段均拒绝提升；原文不被插入 CriticMarkup。 |
| I4 批注定位时整个 Dialog 无法退出 | 父层 loading 可完成/Escape/切项目，文件导航仍串行，writing 仍锁；flush、generation/cancel/dispose、并发 destroy 幂等、读取迟到不启动 compute 均有覆盖。 |
| M1 输入快捷键测试范围失真 | 输入节点置于真正监听 region，a/r/e/j/k/⌘Enter 不改决定/焦点、不打开编辑或确认；普通 region 快捷键仍生效。 |
| M2 风险未决状态文案 | 显示「需单独确认」，保留风险徽标和单项二次接受，覆盖单项及接受全部后状态。 |

正式 RED：三份定向运行分别 13 failed/60 passed、1 failed/34 passed、同类 link 1 failed/15 passed，exit 1；修复终态定向 15 suites/221 tests，exit 0。M1 是测试失真修正，不声称原 guard 有缺陷。

等价核验：直接读取 `1957385a` 的旧 tokenizer，对 **6000 组完整 Token[]、600 组完整 MergeProposal（含所有 ID）、240 组 HTML/link/引号/反斜线/括号组合**逐对象 deepEqual，全部一致；保留 kernel version 1。Node 内生产 tokenizer：未闭合 `<` 8k/16k/32k/64k 约 0.93/1.92/3.75/7.68ms；未闭合 link 4k/8k/16k/32k 字节约 0.39/0.72/1.46/2.94ms（修前约 12/47/183/714ms）。这些是测量样本，不冒称原生运行时上界。

最终 Chrome 154.0.8037.99 实际生产父子组件、modalFocus、Worker 配隔离内存 bridge：a→b→a 恢复、loading 完成关闭、Escape、关闭重开后迟到隔离、writing 确认期间完成/切项目禁用全部通过，自动外网请求和 pageErrors 均为空。root 读取 results.json/日志/退出码并目视核对恢复与 loading 截图；此层不冒称真实文件/IPC 或原生 OS 键盘验收。所有临时 context/browser/Vite 已退出，未使用用户 profile。

保留早期失败说明：一次预检新增 TS narrowing 错误后修正；首次 GREEN 的 7 个 UI 用例依赖旧 isBusy 等待条件，改为等待实际文件导航；隔离等价脚本 esbuild 解析与浏览器 fixture 注入 `as any` 的启动错误均只修 fixture。少数早期尝试日志被后续同名运行覆盖，故不声称保存了每一次原始日志；三份正式 RED 和最终六项全量原始日志在清理前均由报告/root 核对。未改测试阈值、跳过用例或修改 anchor 相似度。

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

Ruling: Include the measured unmatched balancedEnd `[x](` failure rescans in I2 during the existing single final-fix wave — the frozen final finding explicitly requires checking the same class of failed rescans, and 4k/8k/16k/32k bytes measured12/47/183/714ms — cost if wrong: additional parser indexing complexity/memory; preserve escape, nesting and label contexts and prove complete token/proposal/ID equivalence before retaining kernel_version1. This does not authorize another fix wave or broader parser optimization.

## 交付与清理

最终产品提交：`c0a63477d979cfd1123498baaf72478ad031f0c8`，当前 main。后续收尾仅更新本验证记录与计划，不改变受测产品/测试代码，因此不重复全量。已按 Superpowers finishing 流程核验现有 main 与普通仓库位置，沿用用户事先明确的 main/no-worktree 授权，无额外分支、合并、push、部署或应用发版。

完成归档后只移除本计划 `.superpowers/sdd/2026-10-12-project-share-review-merge-p0` 临时 workspace；兄弟计划、原有 `.pnpm-store/`、6 份未跟踪设计文件及此前强制同步备份均保留。当前无本轮 QA Chrome/Vite/native harness 进程。P1/P2/E1–E4/P3 与 OS 人工交互边界按上文明确保留。
