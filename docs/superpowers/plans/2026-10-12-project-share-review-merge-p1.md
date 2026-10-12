# 项目分享 Git 合入目标 P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已完成 P0 审阅上，交付安全的 Git 快照/投稿对象、整份建议生成分支、导出补丁和按项目记忆的 A/B/C 目标。

**Architecture:** 保持唯一纯 TS 内核；前端用同一 ReviewDraft 对固定 HEAD 内容重算。Rust 只经现有 git_ops CLI 造树/提交/ref，所有 Git 子进程在 ProjectStore 的全局 Mutex 和 RecordsLock 外运行；短锁仅捕获输入和重新校验后的元数据写回。

**Tech Stack:** Rust/Tauri、Git CLI、已有 tempfile、TypeScript/Svelte 5、Vitest、真实 Git 临时仓库、Chrome/Playwright。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md`，§6.2/6.4、§9、§17 WP1.1–WP1.2；起点 `0ca59cf9`。

## Global Constraints

- 所有 git 调用都通过 `vault_sync::git_ops`。不得给桌面端加入 `git2` 依赖；不得在 Rust 中另写一份 diff3 或分词（I4）。
- 源文件只经 `ProjectStore::apply`（CAS、意图、恢复）写入。git 模式的 B/C 不写工作区。
- 不自动接受。访客 hunk 默认未决；带风险标记的 hunk 不在「接受全部无冲突」中。
- 快照 commit 和 submission commit 只存在于 `refs/notemd/share/**` 下，不得成为任何 `refs/heads/*` 的祖先。
- 造树统一使用 app 临时目录中的临时 index，不得触碰真实 index；所有涉及临时 index 的 Git 命令带 `GIT_INDEX_FILE`。
- 不得执行 `git push`、`git fetch`，也不得执行任何联网的 git 命令。不得改工作区、index、HEAD、当前分支、`.git/config`、hooks。
- author 为访客自报身份，committer 保持仓库配置身份；不得默认写入 OKF 信任字段。
- B 以 submission 为单位，不能逐文件选择；staleDecisions 或 pendingConflicts 阻止整个 B/C。
- 公开包不得包含 `parentSnapshotId`、`git`、`gitError`；Git 元数据不得进入公开正文/日志。旧 v1 manifest/inbox/feedback 保持兼容。
- 不改分词、diff、ID、kernel version、Worker 或浏览器协议。P2/E1–E4/P3 不属于本计划。
- 当前 main 顺序写入，不建分支/worktree；保留已有 7 项 untracked 和旧备份。不 push/deploy/release。
- 新 popup 复用全局 `.menu-panel/.menu-row`；持久工具条沿用现有灰色 hover，不另造菜单系统。

## 核实结果及执行裁定

这些补充用于填补 spec 未给出的本机接口，不改变公开协议。

1. 本轮按依赖顺序交付 P1；沿用已选择的 SDD，不重复询问执行方式。误判代价：P2 与编辑器仍需后续计划。
2. `prepare` 返回固定 H 的全部 edit HEAD blob、可信 base/after 和最新反馈；branch/export-patch 增加必填 `expectedHead`，执行前及写 ref 前核对 H。原因：原 §9.7 无法绑定前端 compose 与 Rust parent；代价：多一个本机 op/参数。
3. §6.2/6.4 要求的 `.notemd` 私有 manifest/inbox 为 §18.8 的本机元数据例外；源 Markdown、公开包/回执/普通日志仍不得包含本机路径或 oid。代价：Sync 私有元数据包含本机诊断，不能作为公开文件打包。
4. P1 沿用 v1，message 使用缺省 suggestion 标题，AI 为 unknown，name 来自 v1.name；formatter 内部留可选 message/AI 输入接缝，公开 payload 不扩展。代价：丰富署名信息须等 P2。
5. B/C 只合入 edit 正文；不包含新提升批注，不改 annotation_decisions。批注可复制/忽略或先切 A 提升，B/C 中隐藏提升选择并解释；annotation-only 只能 A。代价：Git 批注提升需另行明确持久化/状态契约。
6. 项目 Config.gitTarget 是目标权威；ReviewDraft.target 只是保存时目标快照，不反向覆盖项目选择。非 Git 始终 A；有 remote 默认 B，无 remote 默认 A，保存值优先。代价：跨项目恢复时不沿用某文件旧 target。
7. B 只接收全部 edits 尚未终结的提交，拒绝部分 accepted/rejected/branched 的混合提交；完成后保留 ReviewDraft 供重复 C，全部 branched 可 C 不可再 B/A。代价：部分处理后须使用 A 继续，不能重新打包为 B。
8. C 重复导出相同 H/结果复用既有 exports ref；不同结果不覆盖 create-only ref，明确提示已有导出不同。快照/投稿重试先校验现存 ref 对象的 parent/tree/message/author 再复用，不依赖当前时间生成同 oid。代价：修改后再次导出需新的提交身份；可见失败优于覆写历史。
9. Git 模式打开审阅及 B/C handler 均不调用 prepareSource/saveTab/refreshSource；切回 A 再执行 P0 准备/重算。代价：B/C 展示磁盘工作区，未保存 buffer 不参与；最终合入以 H 为准。
10. snapshot 在锁外预采 HEAD，冻结成功后锁外复验；不一致则只记录 gitError，P0 冻结仍成功。命令异步 spawn_blocking 编排并等待元数据结果，失败不使 P0 返回失败。代价：Git 请求增加等待，但不占全局锁/主线程；无法稳定采样时没有 Git snapshot。
11. I10 对 Git 阶段完整验证。source 与 Vault 同库时，P0 冻结本来会写受管 Sync 镜像/私有元数据；保留这些既有副作用，单独记录并验证 Git 阶段没有额外改动，不能宣称整个 P0 freeze 的全仓 status 不变。代价：该拓扑无法满足字面上的全流程全仓 status 不变，验证报告必须披露。

## 文件与责任

| 文件 | 责任 |
| --- | --- |
| `src-tauri/src/vault_sync/git_ops.rs` | 新 binary/stdin/env runner，不改变已有 runner |
| `src-tauri/src/project_share_git.rs` | Git 原语、格式化、可信 prepare/branch/export 编排及 Tauri 命令 |
| `src-tauri/src/project_share.rs` | 短锁 job 输入/元数据写回、Config target、branched 状态、P0 锁外钩子 |
| `src-tauri/src/lib.rs` | 桌面模块/命令注册 |
| `src/lib/project-share/git.ts` | submission 级 HEAD 重算/确认/执行，复用内核 |
| `src/lib/project-share/{types,host,review.svelte}.ts` | 本机 IPC 类型、目标快照、共用决定恢复 |
| `src/components/project-review/GitTargetBar.svelte` | 目标/操作/结果；现有 ProjectReview 集成 |
| 两份 CHANGELOG、计划、验证记录 | 用户条目、完成矩阵和证据边界 |

## Task 1: Git binary runner 与无工作区副作用的原语

**Files:** Modify `src-tauri/src/vault_sync/git_ops.rs`、`src-tauri/src/lib.rs`；Create `src-tauri/src/project_share_git.rs`（模块内真实 Git tests）。

**Interfaces:** 提供下列 crate 内 API；业务 hook 由 Task 2 消费。结构字段/serde 后续 op 保持此计划约定，不暴露任意 Git 命令 IPC。

```rust
pub fn run_git_io(repo: &Path, args: &[&str], env: &[(&str, &str)], stdin: Option<&[u8]>) -> GitResult<Vec<u8>>;
pub(crate) struct GitRepo { pub root: PathBuf, pub prefix: String, pub head: String, pub branch: Option<String>, pub remote: Option<String> }
pub(crate) struct GitAuthor { pub name: String, pub email: String, pub date: String }
pub(crate) fn probe(source: &Path) -> Result<Option<GitRepo>, String>;
pub(crate) fn read_blobs(repo: &GitRepo, commit: &str, paths: &[String]) -> Result<BTreeMap<String, Vec<u8>>, String>;
pub(crate) fn build_commit(repo: &GitRepo, parent: &str, files: &BTreeMap<String, Vec<u8>>, message: &str, author: Option<&GitAuthor>) -> Result<String, String>;
pub(crate) fn create_ref(repo: &GitRepo, name: &str, oid: &str) -> Result<(), String>;
pub(crate) fn branch_ref(repo: &GitRepo, entry: &str, submission: &str, oid: &str) -> Result<String, String>;
pub(crate) fn format_patch(repo: &GitRepo, oid: &str) -> Result<String, String>;
pub(crate) fn delete_project_refs(repo: &GitRepo, project_id: &str) -> Result<(), String>;
pub(crate) fn guest_author(name: Option<&str>, submission: &str, received_at: &str) -> GitAuthor;
pub(crate) fn submission_message(project_id: &str, snapshot: &str, submission: &str, name: Option<&str>, message: Option<&str>, ai: Option<bool>, head: Option<&str>, coauthor: bool) -> String;
```

- [ ] **Step 1: 写真实 Git RED。** tempfile 仓库 init/config user/初始 commit 仅改 fixture；使用 `git_ops::version()` 检查工具存在，缺失明确打印并 return。覆盖原始 NUL stdout、>pipe 容量 stdin/stdout、不覆盖仓库身份。每个操作前后采样 status(`GIT_OPTIONAL_LOCKS=0`)、真实 index 路径字节、HEAD/symbolic-ref、local config、hooks和源文件 bytes/mode。不要只比较 status。

```rust
let before = state(&repo); // fixture helper: whole source bytes + git status/index/HEAD/config/hooks
let oid = build_commit(&context, &head, &files, "review\n", None).unwrap();
assert_eq!(state(&repo), before);
assert_eq!(git(&repo, &["rev-parse", &format!("{oid}^" )]).trim(), head);
```

- [ ] **Step 2: 运行 RED。** `cargo test --manifest-path src-tauri/Cargo.toml --lib project_share_git -- --nocapture`；确认新用例失败，不允许筛成零测试。
- [ ] **Step 3: runner 最小实现。** 沿用 platform::command 和 configured_proxy，仅新函数支持显式 env、piped stdin、原始 output。stdin 用 writer thread 与 wait_with_output 并行，避免大型输入/过滤器输出死锁；stdin None 关闭输入。spawn/write/nonzero 均 Err，子进程被回收；不改全局环境。Git proxy 不产生联网命令。
- [ ] **Step 4: 原语实现 §9.1–9.6。** probe 不缓存，非 Git/bare/unborn/非 UTF-8 路径返回 None；root canonical，prefix 以 `/` 结尾。临时目录在仓库外，index 初始不存在；read-tree→hash-object `--path=... --stdin`→ls-tree 原 mode→update-index→write-tree→commit-tree；成功失败均清临时 index/lock。路径按 validate_relative 校验，禁止非普通 tree 项（symlink/gitlink）被正文覆盖；保留 executable mode。`check-ref-format`、create-only CAS（zero-oid 随 oid 长度），现 ref同oid成功、不同oid失败。branch stem ASCII slug/空用 project，冲突最多 base、-2…-9。不得运行 status 时刷新真实 index。
- [ ] **Step 5: formatter 和 G 原语 GREEN。** 名称剔除 `<`/`>`/换行/控制；author email/date 按 spec。消息剔除非法控制，危险 trailer 行不分大小写加 `> `，首行 72 Unicode 字符，最后一段只能可信 trailers。A coauthor 用访客，B/C author 为访客；owner coauthor 可省略。G6 collision、G7 nested prefix（含空格）、G8降级、G10真实 `git am` 到复制的 HEAD 仓库、G11 autocrlf/attributes/clean filter 与 git add blob一致；linked worktree `.git` 文件路径和失败清理有覆盖。
- [ ] **Step 6: 定向通过及精确提交。** 上述命令、git_ops 新 runner tests、`git diff --check`；记录实际 G 用例列表/退出码。提交 `feat(share): add isolated Git object and ref primitives`。

## Task 2: ProjectStore Git 二阶段、可信 IPC 和生命周期

**Files:** Modify `project_share.rs`、`project_share_git.rs`、`lib.rs`；模块内真实 store+Git tests。无前端/Worker改动。

**Interfaces:** 新 Tauri command `project_share_git(app, request)`，请求仍以 `request:{op,...}`；全部 Git 子进程在两个锁外。小范围 pub(crate) DTO/目的明确方法，不公开 Binding/management 任意路径。现有 `project_share` 可改 async + spawn_blocking wrapper，纯 dispatch 保留给 P0 测试。

```ts
type GitTarget = 'worktree' | 'branch' | 'patch'
// project_share: get 返回可选 gitTarget；git-target({project_id,target}) -> ProjectInfo
// git-branched({project_id,submissionId,path,branch,commit,summary?}) -> LocalFeedback
interface GitProbe { git:boolean; team:boolean; prefix:string; head?:string; branch?:string; remote?:string; reason?:string; target?:GitTarget }
interface GitPrepared { head:string; entry:string; feedback:LocalFeedback; files:{path:string;base:string;current:string;after:string}[]; commitMessage:string; remote?:string }
// project_share_git probe({project_id}) -> GitProbe
// prepare({project_id,submissionId}) -> GitPrepared
// commit-message({project_id,submissionId}) -> {message:string} // A可信formatter，与建提交同源
// branch({project_id,submissionId,expectedHead,results:Record<string,string>}) -> {branch:string;commit:string;feedback:LocalFeedback;remote?:string}
// export-patch(same input) -> {patch:string}；不改变 Decision/review/annotation状态
```

- [ ] **Step 1: 写 RED store+真实 Git。** G1 冻结/收件 Git 阶段不变真实状态、G2 parent=预采HEAD且包含未提交快照 bytes、G3 guest author/owner committer和可信trailer、G4 B parent=H且snapshot不是ancestor、G9 delete只删隐藏ref。用 v1反馈名字构造伪trailer，断言隔离包不建submission ref，成功包写Git metadata；旧v1/无Git仍通过。模拟二阶段间 review-save、delete、rebind和HEAD前进，不得覆写新草稿或重建目录。
- [ ] **Step 2: 执行 RED。** `cargo test --manifest-path src-tauri/Cargo.toml --lib project_share -- --nocapture`；新功能失败与既有P0分开记录。
- [ ] **Step 3: Config/短锁 jobs。** git_target 加serde(default)，只校验三枚举，旧config可读；info投影。全局Mutex提升为可复用模块级锁，jobs捕获不可变输入，绝不携带guard。P0 freeze/feedback先落盘，锁外生成对象/ref，短锁重读最新manifest/inbox仅patch git/gitError；用binding身份、snapshot hash/requestHash/deleting复验。snapshot parent采样按裁定10，失败P0仍成功。无snapshot commit时SubmissionGit.error为 `snapshot has no commit`。重复导入保持review/decisions。

```rust
// execute_request 的结构约束，所有 run_git_io 必须发生在 scope 外：
let prepared = { let _guard = PROJECT_LOCK.lock()?; capture_and_dispatch(&store, request)? };
let outcome = run_git_job(prepared.job); // 不持 Mutex/RecordsLock
{ let _guard = PROJECT_LOCK.lock()?; finish_git_job(&store, prepared, outcome) }
```

- [ ] **Step 4: prepare/branch/export。** prepare只读、不调用recover写镜像，校验当前binding、active、可信反馈、当前Config.files完整范围；从快照文件取base、envelope取after，用一次H读所有ours blob，任一缺失/非UTF8失败。branch/export严格接受全部edit路径、无额外path，<=既有反馈总量限额；expectedHead匹配再造树，写ref前再次核对HEAD/绑定/范围。无法获取owner身份返回明确失败但不更改配置。B parent只允许H，merge-base检测snapshot不得为祖先。B存所有文件branched保留review，A/reject不得覆写branched；recompute把branched视为终态。C无Decision改变。
- [ ] **Step 5: ref重试及delete协调。** 既存对象复用前验证parent/tree/message/author；不改create-only规则。按项目操作协调锁只协调Git后台与删除（不是全局dispatch Mutex/RecordsLock），delete先在全局锁内标记/capture再锁外等在途任务和清ref，失败记录不阻塞删除；不要持全局锁等待项目Git锁，避免锁顺序死锁。在途迟到写回失败时清本次新建隐藏ref，不重建管理目录。用户分支永不作为项目delete清理对象；分支生成后状态写回失败需返回分支结果和可重试状态错误，不能静默重复建分支。
- [ ] **Step 6: GREEN/注册/提交。** desktop cfg注册module/command，iOS不引用CLI。strict malformed requests/type/path/status/ref归属回归；G1–G4/G7–G9/G11，以及linked worktree/同Vault库的裁定11边界。运行定向Rust与`cargo check --manifest-path src-tauri/Cargo.toml`，记录实际exit。提交 `feat(share): persist Git review objects and safe branch operations`。

## Task 3: 同一 ReviewDraft 的整份 Git 审阅与目标 UI

**Files:** Create `src/lib/project-share/git.ts`、`git.test.ts`、`src/components/project-review/GitTargetBar.svelte`（及test）；Modify host/types/review.svelte.ts/ProjectReview.svelte/AnnotationPanel.svelte/ProjectShareDialog.svelte及对应tests。只动接缝，不改P0 renderer/kernel。

**Interfaces:** `projectGitCommand<T>(op,input)`包装专用command。`GitTarget`/`GitProbe`/`GitPrepared`/`GitBranchResult`对齐Task2。controller的strict `retain` 导出为共用helper `retainReviewDecisions`，A/B/C同规则，不另写决定恢复。review增加目标getter/setter，保存target快照；UI按项目配置恢复，Git准备时获取最新反馈（先flush当前session）。

```ts
export async function prepareGitReview(project_id:string, submissionId:string,
  deps:{command:<T>(op:string,args:Record<string,unknown>)=>Promise<T>;compute:(input:MergeInput)=>Promise<MergeProposal>}) {
  const prepared = await deps.command<GitPrepared>('prepare', {project_id,submissionId})
  const results:Record<string,string> = {}
  const files:{path:string;current:string;result:string;pendingTheirs:number}[] = []
  for (const file of prepared.files) {
    const proposal = await deps.compute({path:file.path,base:file.base,ours:file.current,theirs:file.after})
    const draft = prepared.feedback.review?.[file.path]
    if (draft && draft.kernel_version !== MERGE_KERNEL_VERSION) throw new Error('审阅规则已更新，请重新确认决定')
    const retained = retainReviewDecisions(proposal,draft?.hunks ?? {})
    const result = compose(proposal,retained.decisions)
    if (retained.stale || result.staleDecisions.length || result.pendingConflicts.length)
      throw new Error('相对 HEAD 有冲突或决定失效，请先提交本地改动，或改用 A')
    results[file.path] = result.text
    files.push({path:file.path,current:file.current,result:result.text,pendingTheirs:result.pendingTheirs.length})
  }
  return {prepared,results,files}
}
```

- [ ] **Step 1: RED状态/组件/host。** remote有无默认B/A、项目target优先且跨项目不串、draft.target快照。两个edit不同文件，在A看工作区、B按同H重算，接受决定准确复用；H改变/缺blob/stale/kind变/version变/任一未决conflict均零branch/export；unresolved theirs在确认显示但不采纳。断言两文件一起一command、0 apply/prepareSource/saveTab/refreshSource。C取消picker无写文件、无Decision；保存成功字节原样、写失败保留草稿。Ctrl/CmdEnter不暗中调用A。

```ts
expect(gitCommand).toHaveBeenCalledWith('branch', {
  project_id:'p',submissionId:'s',expectedHead:head,
  results:{'a.md':'甲改。乙改。','b.md':'B改。'},
})
expect(apply).not.toHaveBeenCalled()
expect(prepareSource).not.toHaveBeenCalled()
```

- [ ] **Step 2: 运行 RED。** `pnpm exec vitest run src/lib/project-share/git.test.ts src/components/project-review/GitTargetBar.test.ts src/components/project-review/ProjectReview.test.ts src/lib/project-share/review.test.ts src/lib/project-share/host.test.ts src/components/ProjectShareDialog.test.ts`。
- [ ] **Step 3: 目标与batch最小实现。** GitTargetBar沿用review-actions三个aria-pressed按钮；probe每次进入/执行重新探测、非Git退A；错误只禁用Git操作，保留P0复制/拒绝。切目标先flush再保存config，成功后才切换session目标；进入B/C不保存buffer，切回A重新open走P0准备。前端重算只调用merge-client.compute/内核compose/共用retain；没有草稿视为未决，不默认accept；全无已接受且有可操作hunks则提示先审阅。B/C整份确认逐文件显示SourceDiff，披露未决数量，不省略文件；确认后固定expectedHead执行，不自动重试。期间父isBusy/关闭/切项目锁同writing；迟到结果代际隔离。
- [ ] **Step 4: 结果/复制/补丁。** A复制Rust可信message；B显示branch和可复制push命令，remote取probe返回，正确shellquote且加`--`，不执行。C复用pickSaveFile(default .patch)和plugin-fs.writeTextFile，不另造picker/权限。B/C批注按裁定5禁提升并给说明；全部branched界面为已处理，C可重复且不改决定。已有分享发布/删除/主题/上传不变。
- [ ] **Step 5: GREEN及Chrome。** 定向命令、`pnpm check`。真实Chrome生产组件/Worker加隔离bridge验证目标切换、两文件确认、B结果、C取消/成功、键盘/深色/390–1000px/关闭锁；明确bridge不是native IPC，截图检查。popup若新增必须实测hover；优先无需popup的按钮条。
- [ ] **Step 6: 精确提交。** `feat(share): review submissions into Git branches or patches`。

## Task 4: P1 集成验收、用户条目与交付证据

**Files:** 两份CHANGELOG、P1验证记录、真实Git集成tests；仅修本轮验收发现的问题。root维护本计划/todo，agent不改ledger。

**Interfaces:** 无新业务接口；消费Tasks1–3。输出report含G1–G11逐项证据、P0兼容、全部运行命令/exit、未知边界。

- [ ] **Step 1: 核对G1–G11完整覆盖。** G5必须TS真实内核相对HEAD冲突→0branch，再Rust固定H/范围拒绝→0ref，不能伪称Rust做了diff。G1比较包括真实index不存在/存在、config/hooks原字节；G4真实merge-base false；G10真实git am，G11真实clean/eol。所有临时repo在独立tempfile，当前mdeditor仓库不执行fixture git init/checkout/update-index。
- [ ] **Step 2: v1/公开投影/P0回归。** 有效v1收件署名/AI默认，v2仍不提前接受；snapshot父与所有Git本机字段不进public包；source/mirror dirty不被B/C保存；失败/取消不写原件；branched/reject/apply终态保护；project delete竞态无孤儿隐藏ref；用户branch保留。source==Vault同库按裁定11单独披露原有P0副作用与Git阶段不变证据。
- [ ] **Step 3: 更新双语Unreleased。** 中文“Git 项目的外部建议可生成带访客署名的分支或导出补丁；按项目记住合入目标，不切换分支、不推送，也不更改工作区。”英文对应。若遗留本轮失败明确记录，不静默omit。
- [ ] **Step 4: 按顺序完整检查。** 前端时序suite不与Cargo/build重叠，复用已有target，不调高阈值或跳过测试。

```sh
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm --dir worker test
pnpm check
pnpm build
git diff --check
```

- [ ] **Step 5: 写报告并精确提交。** `docs(share): record Git review targets and P1 acceptance`。root逐项读日志/退出码，任务spec+quality审查、全分支final review（base0ca59cf9）及唯一必要修复波次后，归档全部裁定/证据再仅清本计划workspace。P1完成不代表P2/编辑器/离线客户端已实现，不部署。

## 计划自审

- §9全部契约分配Tasks1–3；G1–G11在Tasks1/2/3建立、Task4交叉验证；WP1.1/1.2与双语changelog均覆盖。
- 增补本机prepare/expectedHead、meta例外、重复导出、B/C批注和同库拓扑已有明示裁定，不将其隐含为原spec文字。
- 保持唯一TS内核/版本、v1兼容、公开白名单、锁外CLI、临时index、不联网/不改用户Git状态。
- root已按当前源码/API接缝自审；执行按任务独立review，不以本计划文字代替通过证据。
