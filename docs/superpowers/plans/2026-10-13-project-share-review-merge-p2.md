# Project Share Review/Merge P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让外部协作者的 v2 建议包、跨版本草稿和处理回执贯通浏览器、免费 Worker 与本地主人端，同时永久兼容 v1。

**Architecture:** 延续静态分享页与现有 Worker/R2 收件机制。Worker 只验证协议并存取对象，主人端从本机决定生成不含正文的回执；浏览器保留完整草稿基线并冻结请求体。P0 合并内核与 P1 Git 路径继续共用，v1/v2 仅在统一访问边界归一，不重写原始入库包。

**Tech Stack:** TypeScript、Svelte 5、Rust/serde、Cloudflare Workers/R2、IndexedDB、Vitest、Playwright Chromium。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §6.3–6.7、§8.5、§10–11、§16、§17 WP2.1–2.4。

## Global Constraints

- v1 建议包：Worker 和 Rust **永久接受**。已经落盘的 inbox JSON 必须仍然可读。
- 未知顶层键或嵌套键：**Worker 拒收**（400）；Rust 用 `deny_unknown_fields` 达到同样效果（v2）。
- 所有 `start`、`end`、`oursStart`、`oursEnd` 都是 **UTF-16 code unit 偏移**（JS 字符串下标）。
- 不得对原件做格式化、换行归一或去 BOM；不得以「过滤格式差异」的方式绕过字节保持（I6、I7）。
- 不得让 Worker 解析、diff 或渲染访客正文（I8）。
- 不得把 token、本机路径、commit oid 写进公开包、回执、日志或 vault 文件。
- 不得放宽 CSP（不加 `'strict-dynamic'`、`'unsafe-eval'`、通配路径），不得从第三方 CDN 加载资源。
- IndexedDB：不升级 DB 版本，只新增键（§6.7）。Worker `ProjectState` 不改 schema，版本接口只读 `active`。
- 回执默认开启，可对单份提交关闭；supersedes 只是展示提示，不得自动拒绝旧提交。
- 保持 Cloudflare Workers 免费套餐，不引入服务或数据库；现有上传 CPU 遗留项单独跟踪，不因本阶段声称已解决。
- 用户授权直接在 main 工作，不新建 branch/worktree；不动原有 7 个未跟踪项、stash、备份 refs。禁止凭据进入输出和提交。
- 用户已要求持续实施直到发版；沿用已选择的子代理开发流程，不重复请求执行方式或发布许可。
- 本计划只交付 P2。E1–E3 编辑器和 E4 离线协作随后独立计划；P3 明确不在本轮范围。

## 文件职责与接口地图

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/project_share/feedback.rs`（新） | v1/v2 wire 类型、严格 v2 形状校验与统一只读访问器；从大文件剥离新增协议职责 |
| `src-tauri/src/project_share.rs` | 可信快照语义校验、原包入库、receipt-set 与 supersedes 缓存；现有 P0/P1 调用适配 |
| `src/lib/project-share/types.ts`、`feedback.ts`（新） | TS 判别联合与 v1/v2 名字/selector 访问边界 |
| `src-tauri/tests/fixtures/project-feedback/{valid,invalid}/*.json`（新） | Worker/Rust 共用真实协议语料 |
| `worker/src/feedback.ts` | v1 回归、v2 边界验证、原字节 requestHash 幂等 |
| `worker/src/receipt.ts`（新）、`project.ts`、`index.ts` | 版本查询、回执校验/鉴权/独立 R2 前缀、CORS 路由 |
| `src/lib/project-share/receipt.ts`（新）、`host.ts` | 纯回执推导、发送/撤回/失败重试/发布后补记 |
| `src/components/project-review/ReceiptPanel.svelte`（新）、`SubmissionList.svelte`、`ProjectReview.svelte` | 开关、回复、发送状态、已取代折叠，复用既有 review 事件 |
| `src/lib/project-share/browser.ts`、`bundle.ts` | 自包含运行时；DraftV2、版本横幅、旧草稿路径、我的提交回执 |
| `scripts/check-project-share-browser.mjs`（新） | 本地真实浏览器验收，不依赖生产凭据 |

## Task 1: 共享夹具、v2 收件与已有 P0/P1 兼容

**Files:**
- Create: `src-tauri/src/project_share/feedback.rs`
- Create: `src/lib/project-share/feedback.ts`, `src/lib/project-share/feedback.test.ts`
- Create: `src-tauri/tests/fixtures/project-feedback/valid/*.json`, `src-tauri/tests/fixtures/project-feedback/invalid/*.json`
- Modify: `src-tauri/src/project_share.rs`, `worker/src/feedback.ts`, `worker/tests/feedback.test.ts`, `worker/vitest.config.ts`（仅夹具在 Node/Vite 转换阶段载入时需要）
- Modify: `src/lib/project-share/types.ts`, `src/lib/project-share/review.svelte.ts`, `src/lib/project-share/review.test.ts`
- Modify: `src/components/project-review/{SubmissionList,ProjectReview,AnnotationPanel}.svelte` and their existing tests where the union needs adapting
- Modify: `CHANGELOG.md`, `CHANGELOG.zh-CN.md`

**Interfaces:**
- Rust wire enum `ProjectFeedbackPayload { V1(ProjectFeedbackV1), V2(ProjectFeedbackV2) }`, custom schemaVersion dispatch. `FeedbackEnvelope.payload` uses this enum. Preserve optional v2 fields when serializing and preserve v1 JSON layout.
- Rust accessors: `schema_version() -> u32`, `project_id() -> &str`, `snapshot_id() -> &str`, `submission_id() -> &str`, `edits() -> &[Edit]`, `annotations_normalized() -> Vec<NormalizedAnnotation>`, `contributor_name() -> Option<&str>`, `supersedes() -> Option<&str>`; `validate_shape() -> Result<(), String>`. Normalized annotations retain selector exact/prefix/suffix/start/end and kind.
- TS `ProjectFeedback = ProjectFeedbackV1 | ProjectFeedbackV2` (keep v1 name exported explicitly for tests that mutate legacy objects); shared `ProjectEdit`, `ProjectAnnotationV1`, `ProjectAnnotationV2`, `ProjectContributor`, `ProjectClient`. Helpers `feedbackName(payload): string`, `feedbackAnnotations(payload): ProjectAnnotationV2[]` normalize at read boundaries only, without mutating persisted payload.
- `feedbackName` returns contributor.name for v2 and name for v1, or empty string. `feedbackAnnotations` maps v1 quote/start/end to selector exact/start/end, default kind comment; preserves all v2 selector context.

- [ ] **Step 1: Write shared fixtures and regression tests (RED).** Use static JSON fixtures, not a validator-dependent generated oracle. A valid v2 boundary example is:

```json
{"schemaVersion":2,"project_id":"p_fixture","snapshotId":"S1","submissionId":"v2_point","edits":[],"annotations":[{"path":"README.md","selector":{"exact":"","prefix":"Before","start":6,"end":6},"comment":"补充来源","kind":"question"}],"contributor":{"name":"Alice","aiAssisted":false},"client":{"kind":"browser-fallback","version":"6.1013.1"}}
```

Add valid v1, minimal v2, all optional v2, astral exact offset, point annotation, each client.kind, omitted annotation.kind. Invalid fixture filenames are meaningful rule names; cover every §6.3 row: missing/unsupported schema; each malformed ID; self-supersedes and self-rebasedFrom; message type/length/NUL; name type/length/C0/C1; aiAssisted type; client kind/version; edits type/count/path/hash/after type/duplicates; annotations type/count/path; selector exact type/length; empty point without context; prefix/suffix type/length; offset negative/fraction/unsafe/reversed/span mismatch; comment empty/type/length; kind enum; unknown keys at top/edit/annotation/selector/contributor/client. Exact limits use UTF-16 counts (include non-BMP tests). Test nullable optional v2 fields are invalid. Keep v1 current leniency, including legacy null Option fields and existing old records.

Worker test enumerates both fixture directories with Vite `import.meta.glob` eager raw imports (or Node-only Vitest config injection), then POSTs each fixture through SELF using authorized project metadata. Do not call node:fs inside workerd: its readdirSync is unavailable. Rust fixture test deserializes then calls `validate_shape`; semantic Store tests separately freeze real README bytes/hash and test valid v2 apply/review and v1 reload. Do not demand a fake fixture base hash satisfy a real snapshot.

```ts
expect(feedbackName(v2)).toBe('Alice')
expect(feedbackAnnotations(v2)[0].selector).toEqual(v2.annotations[0].selector)
expect(feedbackAnnotations(v1)[0].selector).toEqual({exact:'Before',start:0,end:6})
```

- [ ] **Step 2: Verify RED.** Run `pnpm exec vitest run src/lib/project-share/feedback.test.ts`; `pnpm --dir worker exec vitest run tests/feedback.test.ts`; `cargo test --manifest-path src-tauri/Cargo.toml --lib project_share:: -- --test-threads=1` (capture logs to plan workspace). New v2 acceptance tests must fail before implementation; distinguish missing import from protocol rejection. Existing Worker test asserting schema 2 rejection becomes unsupported-schema 3 regression.
- [ ] **Step 3: Implement minimal strict v2 and unified access.** Keep v1 structs/defaults permissive. V2 and every nested wire struct deny unknown keys, no fallback to v1 after v2 validation failure. Validate §6.3 full table before trusted baseline/path/hash semantic checks. Rust lengths use `encode_utf16().count()`, safe offset ≤ 9007199254740991; `end-start == exact UTF-16 length` when both set. Worker uses JS string length and safe integers, counts streamed body ≤ 5 MiB as before. Reject duplicate edits. Worker does not anchor or inspect Markdown. Adapt P0 review, promotion, display, and P1 author/commit generation to accessors; preserve original envelope payload and request hash. Add v2 message and AI badge display where existing list/title gets author adaptation, plain text only. Do not implement supersedes folding or receipts in this task.
- [ ] **Step 4: Verify GREEN and regression.** Repeat focused tests, then `pnpm exec vitest run src/lib/project-share src/components/project-review`, `pnpm check`, Worker full suite, Rust project_share tests once. Prove original v1 persisted serialization/reload and P1 name sanitization remain correct; v2 selector prefix/suffix reaches anchor and v2 name reaches existing P1 sanitization. Record counts, outputs, exit codes.
- [ ] **Step 5: Commit task.** Add only the enumerated product/test/docs files actually changed, then `git commit -m "feat(share): accept versioned collaboration submissions"`. Both changelogs get unreleased v2 compatibility entry.

## Task 2: Worker 公开版本与独立回执对象

**Files:**
- Create: `worker/src/receipt.ts`, `worker/tests/receipt.test.ts`
- Modify: `worker/src/project.ts`, `worker/src/index.ts`, `worker/tests/project.test.ts`, `worker/tests/index.test.ts`
- Modify: `src/lib/project-share/types.ts`, `CHANGELOG.md`, `CHANGELOG.zh-CN.md`

**Interfaces:**
- `ProjectVersion = {schemaVersion:1; project_id:string; snapshotId:string; archiveReady:boolean; expires_at:string|null}`.
- `ProjectReceipt = {schemaVersion:1; project_id:string; submissionId:string; decidedAt:string; outcome:'accepted'|'partial'|'rejected'|'superseded'|'forwarded'; files:{path:string;outcome:'accepted'|'partial'|'rejected'|'forwarded';accepted:number;total:number}[]; annotations:{promoted:number;total:number}; reply?:string; includedInSnapshotId?:string}`.
- `handleReceipt(req: Request, env: Env, url: URL): Promise<Response>` handles exactly `/feedback/<slug>/receipt/<submissionId>` before legacy feedback paths. Store under `receipts/<project_id>/<submissionId>.json`, never feedback prefix.

- [ ] **Step 1: Add route/validation tests (RED).** Set up real project state and feedback envelope in test R2. Assert owner PUT204, token GET200 exact JSON, owner DELETE204 twice, GET404 afterdelete; visitor PUT/DELETE401, owner Bearer-only GET403, wrong/missing token403, expired/revoked GET410; missing feedback PUT404; foreign project/submission, unknown nested/top key, enum/count/ISO/type errors400, >64KiB streamed or declared413. Also test listFeedback contains only feedback IDs after receipt write, and all response paths include CORS. Example shape:

```ts
const receipt = {schemaVersion:1,project_id:'p_fixture',submissionId:'s1',decidedAt:'2026-10-13T00:00:00Z',outcome:'partial',files:[{path:'README.md',outcome:'partial',accepted:1,total:2}],annotations:{promoted:0,total:1},reply:'谢谢'}
expect((await SELF.fetch(url,{method:'PUT',headers:AUTH,body:JSON.stringify(receipt)})).status).toBe(204)
expect(await (await SELF.fetch(url,{headers:{'X-Feedback-Token':TOKEN}})).json()).toEqual(receipt)
```

Version tests: active entry archiveReady false, full archive true, HEAD no body, revoked/expired410, missing/legacy single share404, no credential needed; no-store/noindex and correct active snapshot during pending update.
- [ ] **Step 2: Run RED.** `pnpm --dir worker exec vitest run tests/receipt.test.ts tests/project.test.ts tests/index.test.ts` fails new routes with404.
- [ ] **Step 3: Implement.** Extend handleProject regex to `(entry|archive|download|version)`; version handles GET/HEAD before Bearer; other version methods405. Read state once, use activeProjectMetadata; missing state404, inactive410. Receipt PUT/DELETE requires nonempty SHARE_API_KEY matching Bearer; PUT derives project ID from slug state, checks feedback existence, bounds bytes ≤65536 and validates only allowlisted fields. GET requires active share and token sha256, no-store; return404 if receipt absent. Known PUT/DELETE may service existing owner records even after share expired (visitor access stays410). JSON validation enforces safe nonnegative counts, accepted≤total/promoted≤total, UTF-16 reply≤2000, valid IDs/relative paths, parseable UTC ISO decidedAt; no content fields. Include PUT in CORS allowed methods and preflight Allow. Audit revoke paths and document that current exact project-share cleanup does not delete feedback, so receipts equally persist with access gated. Do not add prefix sweep or schema migration.
- [ ] **Step 4: GREEN.** Focused then full Worker suite, `pnpm check`. Assert ProjectState schema remains unchanged and receipt keys cannot appear in feedback list. Record lifecycle conclusion in task report.
- [ ] **Step 5: Commit.** `git add` exact files; `git commit -m "feat(worker): expose project versions and collaboration receipts"`; both changelogs add user-facing version/receipt delivery entry.

## Task 3: 主人侧回执、回复与 supersedes 展示

**Files:**
- Create: `src/lib/project-share/receipt.ts`, `src/lib/project-share/receipt.test.ts`, `src/components/project-review/ReceiptPanel.svelte`, `src/components/project-review/ReceiptPanel.test.ts`
- Modify: `src-tauri/src/project_share.rs`, `src/lib/project-share/types.ts`, `src/lib/project-share/host.ts`, `src/lib/project-share/host.test.ts`, `src/lib/project-share/review.svelte.ts`, `src/lib/project-share/review.test.ts`
- Modify: `src/components/project-review/{ProjectReview,SubmissionList}.svelte`, their existing tests, `CHANGELOG.md`, `CHANGELOG.zh-CN.md`

**Interfaces:**
- Rust `feedback_readonly(id:&str, submission:&str) -> Result<LocalFeedback>` exposed as `feedback-readonly` reads local metadata without recovering write intents; host receipt orchestration uses it rather than inbox/review. Rust `receipt_set(id:&str, submission:&str, receipt:ReceiptState) -> Result<LocalFeedback>` exposed as `receipt-set` with `{project_id,submissionId,receipt}`. Legal state auto/suppressed/sent/failed; reply≤2000 UTF-16; new operations lock/active; invalid state stable prefix `invalid receipt state`. State stores optional `included_in_snapshot_id` locally to avoid repeated backfill and optional `decided_at` frozen before first send so retry does not change decision time; both default for legacy inbox. No receipt field stores content or credentials.
- Pure `buildProjectReceipt(feedback:LocalFeedback, decidedAt:string, includedInSnapshotId?:string): ProjectReceipt | null` returns null until all edit paths accepted/rejected/branched/mirror_pending; annotation-only requires resolved. recovery_conflict/pending/quarantined stay incomplete. Derived receipt uses only allowlist fields.
- Host `syncProjectReceipt(project_id:string, submissionId:string): Promise<LocalFeedback>`; `setProjectReceipt(project_id:string, submissionId:string, input:{enabled:boolean;reply?:string}):Promise<LocalFeedback>`; `syncProjectReceipts(project_id:string, includedInSnapshotId?:string):Promise<void>`.

- [ ] **Step 1: Add failing tests.** Pure receipt table covers all accepted, partial hunk, all rejected, all superseded, branch-only/mixed rejected→forwarded, branch+accepted→partial, annotation-only resolved→accepted, empty edits still pending→null, mirror_pending terminal. Missing summary on legacy accepted maps1/1, rejected0/1, forwarded0/1; summary zero/zero is allowed. Count promoted from annotation_decisions indexes belonging to payload. Test body serialization excludes afterMarkdown/quote/selector/base/current/content/git/commit/token/source paths; malicious visitor message does not enter receipt.

```ts
expect(buildProjectReceipt(pending,'2026-10-13T00:00:00Z')).toBeNull()
expect(buildProjectReceipt(branchOnly,'2026-10-13T00:00:00Z')?.outcome).toBe('forwarded')
expect(JSON.stringify(buildProjectReceipt(done,'2026-10-13T00:00:00Z'))).not.toContain('SECRET_BODY')
```

Host tests cover completion auto sends once, suppressed neverPUT, failure persists failed and pull retries, disabled-after-sent DELETE and persisted suppressed, DELETE failure visible/retry retained, reply bound, published accepted/partial backfill once, branch/rejected notbackfilled. Rust tests cover receipt-set locking/active/state validation and restart persistence. Supersedes tests cover known predecessor, successor arrived first, quarantine does not supersede trusted record, self rejected, cycles terminate and no automatic decisions, latest pending old remains manually reviewable.
- [ ] **Step 2: Run RED.** `pnpm exec vitest run src/lib/project-share/receipt.test.ts src/lib/project-share/host.test.ts src/components/project-review/ReceiptPanel.test.ts`; Rust focused receipt/supersedes tests.
- [ ] **Step 3: Implement.** receipt_set persists without source recovery/write (use readonly feedback loading for metadata, preserving P1 B/C invariants). During trusted feedback arrival/inbox, recompute superseded_by from valid existing v2 hints, supporting arbitrary arrival order; never overwrite Decision/review/source and never trust quarantined hints. UI adds collapsed「已取代」group, shows predecessor history with safe cycle handling, explicit「全部标为已取代」loops reject(reason superseded), respects selected target. ReceiptPanel shows default-on switch, optional reply, sent/failed state; plain text only. Connect successful terminal review updates (apply, reject, resolve, branch and annotation completion) to serialized host receipt sync outside Rust locks; network failure must not turn a successful source write into failure. Pull finishes by retrying failed and reconciling completed auto records; published success backfills sent accepted/partial only, never before publish success. Use identity baseUrl/slug + current configured API key with same existing service checks. Suppression/reply changes must survive failed network and be visibly retryable; never log token or receipt body. Avoid duplicate sends from simultaneous component and pull events via per-project serialized host queue.
- [ ] **Step 4: GREEN.** Run focused tests then `pnpm exec vitest run src/lib/project-share src/components/project-review`; Rust project_share; `pnpm check`. Assert Git B/C receipt setting neither invokes recover nor touches worktree/index/HEAD. Each HTTP payload is inspected in tests, not just mocked success.
- [ ] **Step 5: Commit.** Exact files only; `git commit -m "feat(share): return owner decisions and group superseded feedback"`; both changelogs include receipts/replies and old submission grouping.

## Task 4: 浏览器 DraftV2、版本提示和我的提交

**Files:**
- Modify: `src/lib/project-share/{browser,browser.test,bundle,bundle.test,types,host,host.test}.ts`
- Create: `scripts/check-project-share-browser.mjs`
- Modify: `package.json`, `pnpm-lock.yaml` (add missing `fake-indexeddb` devDependency only), `CHANGELOG.md`, `CHANGELOG.zh-CN.md`

**Interfaces:**
- Export type `DraftV2` exactly §6.7: v2,lineageId,snapshotId,base,after,annotationKinds,message?,lastSubmissionId?,rebasedFrom?,previous?,pending?:{submissionId,body}. Inline function cannot import runtime helpers; types may be type-only imports.
- Bundle always writes `versionUrl` same origin as feedbackUrl: `/project/<slug>/version`; optional `editorKit` stays absent in P2 and existing CSP is byte-equivalent apart from nonce.
- Keys remain DB `notemd-project-sharing`, version1, store data; `<pid>:draft2:<lineageId>`, `<pid>:token`, `<pid>:submitted` capped200 FIFO. Legacy snapshot keys read/migrate/delete only after durable new save.
- Form-only fallback annotations live in companion key `<pid>:draft2-notes:<lineageId>` as `ProjectAnnotationV2[]`; they are not inserted into afterMarkdown or extra DraftV2 fields. Migration writes draft and companion notes and deletes old key in one transaction. Kit integration later consumes these existing form notes when building a package, without silently losing them.

- [ ] **Step 1: RED tests with fake-indexeddb and real serialized runtime.** Test current v1 draft migrates preserving base/hash/after and annotations, failed migration retains original; unmatched old v1 baseline unavailable offers exact v1 pending replay/export only; if no frozen pending body or old baseHash exists, export only with an explanation (never invent hashes); stale DraftV2 renders choice controls without destructive refresh. Test submission v2 fallback with exact/prefix/suffix/start/end (32 UTF-16 context), client.kind browser-fallback, contributor, message, supersedes/rebasedFrom, no-op detection, 5MiB guard; pending.body survives edits/failed response/reload and is byte-identical retry. After successful send append submitted cap200, lastSubmissionId, delete previous; pending body does not change on version check or name edit. Editing after successful submission creates new ID with supersedes, without accidental duplicate sends.

```ts
expect(JSON.parse(sentBodies[0]).client.kind).toBe('browser-fallback')
expect(sentBodies[1]).toBe(sentBodies[0])
expect(JSON.parse(sentBodies[0]).annotations[0].selector.exact).toBe('风险')
```

Version tests: load/visible throttle≥60s; forced before submit; new snapshot banner「分享者已发布新版本」with refresh; network/404 quiet,410 disables sends but retains edits/export. Receipt tests: recent20 requests only, max4 concurrent,404 delivered-pending, escaped reply text, accepted partial/forwarded/rejected/superseded labels.
- [ ] **Step 2: Run RED.** `pnpm exec vitest run src/lib/project-share/browser.test.ts src/lib/project-share/bundle.test.ts` new v2 tests fail against current runtime.
- [ ] **Step 3: Implement self-contained runtime.** Store edited-file originals on first edit, keep lineage across restarts and use old draft baseline for old submission. Without Kit, stale DraftV2 only「按旧版本提交」「导出草稿」; no fake rebase. Persist form annotations using the companion key above. Use form selection quote plus safe original offset search/context; no guessed coordinates when quote ambiguous. Add optional message input and local nickname persistence; fallback annotation form remains available. Freeze JSON.stringify once into pending before network, no regeneration while unresolved. Do not clear edited state until it is durably saved. Store submitted IDs independently for receipts. Version requests cache no-store, URL from bundle, preserve old link behavior when versionUrl missing. Set explicit same-origin versionUrl in both host buildProjectBundle call sites; retain frozen HTML on retry. Public read-only mode makes no receipt/token calls without token and never loads Kit. Keep folder style/sort/default collapse/adaptivewidth/floatingtoolbar/download behavior. Add accessible version/old-draft/my-submissions panels without a permanent top title bar. Replies rendered with textContent. Preserve draft export when IndexedDB is unavailable. Keep exact frozen v1 retry bodies where migration has a pending v1 payload.
- [ ] **Step 4: GREEN and real browser acceptance.** Focused Vitest then projectshare tests. New script uses existing `PLAYWRIGHT_MODULE` override like check-cdr-browser, temporary Vite mock service and real bundled HTML; seed IndexedDB in browser, then verify S1 draft displayed on S2, submit old snapshot v2 bytes to mockservice, force version update banner, show reply safely, receipt concurrency bound and v1 replay. Capture screenshots+safe request summaries into plan workspace through env output path; no production tokens. Run `PLAYWRIGHT_MODULE=<installed absolute index.mjs> node scripts/check-project-share-browser.mjs`; `pnpm check`; `pnpm build`. Script must exit nonzero on failure and close server/browser in finally. No fabricated browser proof if browser module missing—locate existing installed module or install isolated tool outside product dependency graph, record location.
- [ ] **Step 5: Commit.** Exact files only; `git commit -m "feat(share): retain versioned drafts and show submission receipts"`; both changelogs explain new-version prompt, old-draft continuation, local submission tracking.

## Verification and continuation

- [ ] After all task gates, one broad whole-range review from baseline `205a3ce098b8d0a4f15ad67603e620825dde2e7e`, one unified fix wave and one scoped re-review if findings exist; archive every finding/ruling.
- [ ] Final gates once on reviewed head: full frontend, Rust, Worker tests; check warning baseline comparison; production build; real browser script. Review-source changes require corresponding focused rerun.
- [ ] Write P2 verification report with spec coverage table, immutable test logs/exits, known limitations, and all `Ruling:` entries verbatim in chronological order.
- [ ] Continue E1 byte-preservation feasibility gate and E1–E3/E4 plans; do not claim P2 is the requested rich editor completion. If §12.4 fails, report the mandated E1 block without substituting posthoc format filtering.
- [ ] Publish approved complete updates using existing host/Worker/plugin workflow and unified audit, verify actual deployment, anonymous release bytes and source tag. Preserve existing production CPU residual as a named unfinished item until measured fixed.

## Self-review / scope map

§6.3/§16 → Task1; §6.5/§10 → Task2+3; §6.4 receipt/superseded → Task3; §6.7/§11 → Task4; §8.5 → Task3. New editor §12 and offline §13 are explicit next plans, P3 excluded. Shared files have serialized writers: Task1 types/protocol → Task2 route receipt types → Task3 owner receipt orchestration → Task4 browser. No edits to core merge algorithm or kernel version. Existing source/native/Git confirmations remain intact.
