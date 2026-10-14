# 项目分享：外部编辑/评审的回流与合并 —— 实现规格

> 2026-10-14 正式实施合同。前置已受理：CORE `6a6d0f940383c1e2cd19dc3c9c3df8f63e69baff` / HOST产品 `8a0b555ca6a0e8df226700fc74f67ffa64f3925e`；唯一全阶段审查及一次 finalfix/scoped复审完成，准确证据见 [docs/superpowers/reports/2026-10-14-file-bindings-history-verification.md](/Users/bruce/git/mdeditor/docs/superpowers/reports/2026-10-14-file-bindings-history-verification.md)。本合同的 E1–E4 尚待实施与发行。用户暂无移动设备，移动端真实中日 IME 保持待验，继续独立实现。

日期：2026-10-12，事实对齐：2026-10-14。状态：**实现规格 v1 的正式交付修订；§20 产品决定已确认，前置共享编辑器已受理，E1–E4实施/验收与发行继续按§21分别记录。** 本文交给实现 agent 使用。
上游：`2026-10-10-project-document-sharing-design.md`（收件与人工审阅合同）、`2026-10-10-current-document-project-sharing-design.md`（项目身份与生命周期）、`2026-10-12-project-share-free-upload-design.md`（分段发布）。本文只覆盖一段流程：分享出去 → 外部修改/评审 → 回到分享者 → 合入主项目。

---

## 阅读指南（实现 agent 必读）

- **规范性用语**：「必须 / 不得」= MUST / MUST NOT；「应当 / 不应」= SHOULD / SHOULD NOT；「可以」= MAY。没有这些词的段落是背景说明，不构成验收条件。
- **规范性章节**：§4 不变量、§5 架构、§6 数据契约、§7 合并内核、§8 主人侧、§9 git 模式、§10 Worker、§11 浏览器访客端、§12 编辑器、§13 note.md 访客客户端、§15 安全、§16 兼容、§17 工作包、§18 禁令、§19 CHANGELOG。§1–§3 和 §14 是动机与背景。
- **按工作包实现**（§17）。每个包都列出了文件、契约、测试和完成判据，依赖顺序不得颠倒。
- 遇到本文没有写到的情况，按以下优先级判断：§4 不变量 → §18 禁令 → `CLAUDE.md` 的产品信念 → 最保守的做法（不写源文件、不外发、不自动接受）。然后在 PR 描述里写明你做了什么判断。
- 代码事实已于 2026-10-12 核对，引用格式为 `文件:行`。行号可能漂移，以符号名为准。

---

## 0. 结论

note.md 的项目分享采用业界成熟的**投影 + 回流导入**模式（Copybara/ShipIt 的轻量版）：

- **分享者的角色**：分享者是 integration manager（集成管理者），也是私有 git 库的权限代理。
- **外部成员看到什么**：只能看到一份不可变快照，并在快照上写建议。
- **建议怎么合回来**：建议回到分享者本机后，以快照为共同祖先做三方合并，按 hunk 逐处审阅，再由分享者以自己的身份写回。
- **原件在 git 库里时**：额外落成带署名、带基线的 commit 或分支，交给团队已有的 PR 流程。

全程没有实时协作服务，访客不碰 git，任何改动都不会被自动合入。

---

## 1. 问题与现状

### 1.1 场景

- 主项目放在私有 git 库，权限按仓库授予。临时参与者（外部评审、客户、顾问）不能也不应该拿到整个仓库。
- 分享者从一篇入口文档出发，选出一组相关的 `.md` 和资源，镜像到 `Vault/<syncDir>/<project_id>/`，再发布成静态页面。
- 外部成员在页面上阅读、标注、修改并提交。这些修改必须能并入主项目的工作流：能审、能追溯、能回滚，不污染主库。

### 1.2 现状（代码已核对）

| 环节 | 现状 | 代码 |
| --- | --- | --- |
| 快照 | `snapshot()` 冻结 `.notemd/snapshots/<id>/{manifest.json, files/}`，`ProjectSnapshot.schema_version = 1`，没有父子关系 | `src-tauri/src/project_share.rs` `ProjectStore::snapshot`、`struct ProjectSnapshot` |
| 访客编辑 | 页面脚本是单个函数 `projectShareBrowser`，由 `.toString()` 内联进 HTML。编辑器是 `<textarea>`。草稿存在 IndexedDB `notemd-project-sharing` 的 store `data` 中 | `src/lib/project-share/bundle.ts`、`browser.ts` |
| 提交 | v1：`{schemaVersion:1, project_id, snapshotId, submissionId, edits[{path, baseHash, afterMarkdown}], annotations[{path, quote, comment, start?, end?}], name?}`。`submissionId = crypto.randomUUID()`，冻结后幂等投递 | `browser.ts` 中的 `submit`、`worker/src/feedback.ts` |
| Worker 收件 | `POST /feedback/<slug>`，校验 `X-Feedback-Token` 的 sha256。只接受 `schemaVersion === 1`，上限 5 MiB。用 R2 的 `onlyIf etagDoesNotMatch:*` 做幂等，相同 `requestHash` 视为重放 | `worker/src/feedback.ts` 中的 `submitFeedback`、`validPayload` |
| 取件 | 主人凭 `SHARE_API_KEY` 调 `GET /feedback?project_id=`（分页）和 `GET /feedback/<project_id>/<submissionId>` | `feedback.ts` 中的 `handleFeedback`；`host.ts` 中的 `pullProjectFeedback` |
| 本机核验 | `validate_feedback` 要求 `schema_version == 1`、`project_id` 一致、路径属于已分享的 Markdown、`baseHash` 等于快照 hash，并且快照字节未损坏 | `project_share.rs` 中的 `validate_feedback` |
| 审阅 | `review(id, submissionId, path)` 返回 `{path, sourcePath, base, current, after, currentHash, status}`。界面是三栏原文，主人在 textarea 里手工拼出最终文本 | `review`；`ProjectShareDialog.svelte` |
| 回写 | `apply(id, submissionId, path, expectedHash, content)` 的步骤：CAS 校验、写入 `Decision{status:"pending", beforeHash, resultHash, mirrors, content}` 意图、`write_atomic`、`recover`（刷新镜像）。前置条件是 `edits` 中包含该 path | `apply`、`recover` |
| 其他 op | `reject(path?)`；`resolve` 只用于只含批注的提交。Decision 状态集合为 `pending`、`source_changed`、`accepted`、`mirror_pending`、`rejected`、`recovery_conflict`、`quarantined` | `project_share.rs` 中的 `project_share` 分发函数 |
| 并发 | 进程内全局 `Mutex`，另加 `store::lock_records` 跨进程文件锁 | 同上 |
| git | **桌面端没有 git2 依赖。** git2 只在 iOS 和 dev-deps 中；桌面一律通过外部 `git` CLI（`vault_sync::git_ops::run_git`） | `src-tauri/Cargo.toml` 的 `[target.'cfg(target_os = "ios")'.dependencies]` 注释 |
| 深链 | 已集成 `tauri-plugin-deep-link`，权限是 `deep-link:default`；`onOpenUrl` 只处理 `file://`。**没有注册任何自定义 scheme** | `src/App.svelte` 中的 `onOpenUrl` |
| 公开路由 | `GET /<slug>` 返回已发布阅读页；`GET/HEAD /project/<slug>/download` 返回 source-only ZIP，只含批准的源文档和附件，不加入 reader、内部 manifest 或管理文件。E4 从阅读页的公开 snapshot 投影校验清单，版本双读与旧包兼容见 §13.2 | `worker/src/project.ts` 中的 `publicProject`、`handleProject`；`src/lib/project-share/archive.ts` |
| 编辑器 Kit | v1（`src/editor-kit/`）API 冻结，依赖图中不得出现 Tauri IPC；v2（`src/editor-kit-v2/`）提供块身份、`DecorationHost`、`mergeAcknowledgedDraft`（块级、只合不相交的修改）。两者都是 vite entry，并由 `scripts/check-editor-kit-build.mjs` 守护 | `vite.config.ts`、`src/editor-kit-v2/contract.ts` |
| 批注 | 批注写成 CriticMarkup：`{==选文==}{>>批注<<}`，以及点批注 `{>>批注<<}`；由 moraya-core 解析和序列化，`sanitizeNote` 会把换行和 `<<}` 转义 | `../moraya-core/src/markdown.ts`；`src/lib/note-anno/note-commands.ts` |

### 1.3 缺口

1. 没有 diff，也没有合并；`source_changed` 之后只能人工拼接。
2. 粒度是整个文件，无法逐处接受。
3. 版本线是隐式的：快照之间没有父子关系，重复提交会让同一改动重复出现，访客也没有办法 rebase。
4. 没有接入 git：回写在工作区里只留下一个没有署名的脏改动。
5. 标注只记 `quote + start/end`，原件一改就漂移。
6. 所有访客共用一个 token，昵称是自报的。**本期不解决**（§20-4）。

---

## 2. 业界做法对照（背景）

| 做法 | 借鉴点 | 不照搬的原因 |
| --- | --- | --- |
| Pro Git：Integration-Manager Workflow | 角色模型：分享者 = 集成者 | 要求贡献者会用 git |
| Google Copybara / Meta ShipIt | 子集投影出去；外部变更以「导入」形式进入内部评审，并保留作者署名 | 重量级，面向代码和 CI |
| Josh | 子集投影与往返路径映射 | 需要常驻代理 |
| Linux 补丁流（`format-patch`、`base-commit`） | 补丁必须声明基线 | 门槛高 |
| diff3、`git merge-file`、`git merge-tree` | 以快照作为共同祖先做三方合并 | 行级粒度对散文太粗，需要细化 |
| GitHub suggested changes、Google Docs 建议模式 | 逐处接受，接受即署名 | 依赖托管平台 |
| W3C Web Annotation、Hypothesis fuzzy anchoring | 标注跨版本重锚 | — |
| Ink & Switch Upwelling / Patchwork | 草稿层加显式合并，用 AI 解释差异 | 基于 CRDT，倾向自动合并 |
| CRDT（Automerge、Yjs） | — | **不采用**：需要状态服务，自动收敛会绕过「你确认」 |
| DCO、`Co-authored-by` | 署名进历史 | — |
| AI 辅助冲突解决与 PR 摘要 | 解释和提案 | AI 不得写入 |

主流共识可以归纳为四条：

1. 共享不可变的基线。
2. 变更以「相对基线的建议」流转。
3. 由有写权的人做三方合并，按 hunk 审阅。
4. 署名进历史；AI 只做解释和提案。

---

## 3. 总览

```
           私有 git 库 / 原项目（唯一事实源）
                 │  ▲
        冻结快照  │  │  ⑤ 写回工作区(A) / 生成分支(B) / 导出补丁(C)
                 ▼  │
   Vault/<sync>/<project_id>/.notemd/
     snapshots/S1 → S2 → S3     （parentSnapshotId；git 模式另有隐藏 ref）
     inbox/<submissionId>.json  （信封 + 审阅草稿 + 回写意图 + 回执状态）
                 │  ▲
     ① 发布投影  │  │  ④ 取件 → 核验 → 合并内核出提案 → 逐 hunk 审阅 → apply
                 ▼  │
        Worker + R2（静态托管、收件、版本号、回执；不读不合正文）
                 │  ▲
     ② 阅读/编辑 │  │  ③ 提交 v2 建议包（声明基线、supersedes、rebasedFrom）
                 ▼  │
   外部成员：浏览器分享页（在线编辑器）或 note.md 桌面（离线协作客户端）
```

---

## 4. 不变量（任何实现都必须满足，测试必须覆盖）

| # | 不变量 |
| --- | --- |
| **I1** | **快照即祖先。** 合并的 base 永远取访客提交时声明的 `snapshotId` 对应的快照字节，不得用当前原件或其他快照冒充。 |
| **I2** | **源文件只经 `apply` 写入。** 写原件的唯一路径是 `ProjectStore::apply`（CAS、意图、恢复），不得新增写源文件的路径。git 模式的 B/C 不写工作区。 |
| **I3** | **不自动接受。** 访客 hunk 默认未决。任何写源文件、写 git ref、发回执之外的外发动作，都必须由主人的明确操作触发。「接受全部无冲突」本身就是一个明确操作，但它不得包含带风险标记的 hunk（§7.6）。 |
| **I4** | **单一内核。** 合并、rebase、批注抽取、重锚只能由 `src/lib/share-merge/` 一份 TypeScript 实现完成。主人侧、浏览器访客端和桌面访客端调用的都是它。不得在 Rust 或其他地方另写一份 diff3。 |
| **I5** | **内核确定性。** 同一输入加同一 `MERGE_KERNEL_VERSION`，必须产出逐字节相同的提案和相同的 hunk ID。改动分词、diff 或 ID 算法时，必须递增 `MERGE_KERNEL_VERSION`。 |
| **I6** | **拼接保真。** 内核的分词结果拼接后必须严格等于原文；全部拒绝时 `compose` 的结果必须严格等于 ours。不得对原件做任何格式化、换行归一或重排。 |
| **I7** | **未改动块字节不变。** 访客端产出的 `afterMarkdown` 中，访客没有触碰的块必须与快照逐字节相同（§12.4）。 |
| **I8** | **Worker 不理解正文。** Worker 只做形状校验、存取和鉴权，不 diff、不合并、不渲染访客正文。 |
| **I9** | **快照 commit 不外流。** git 模式的 snapshot commit 和 submission commit 只存在于 `refs/notemd/share/**` 下，不得成为任何 `refs/heads/*` 的祖先，note.md 也不得推送它们。 |
| **I10** | **不碰用户 git 状态。** 冻结、导入、建分支的过程中，用户的工作区、index、`HEAD`、当前分支、`.git/config`、hooks 必须逐字节不变（只新增对象和 ref）。 |
| **I11** | **note.md 永不 `git push`。** 推送由主人在自己的工具里完成。 |
| **I12** | **回执不含正文。** 回执里只有计数、结果枚举和主人自愿填写的一句回复，不含访客正文、被拒内容或原件内容。 |
| **I13** | **外部内容不可信。** 访客正文、评论、`message`、`contributor.name` 在主人端一律视为不可信输入，按 §15 渲染和处理；AI 处理时不得挂写工具。 |
| **I14** | **署名不混。** 访客永远不以 `●` 或主人身份出现；OKF actor 用 `human:guest-<slug>`，并标注为自报；note.md 不得因合并而自动写 `verified`。 |

---

## 5. 架构与模块边界

### 5.1 为什么内核放在 TS，而不是 Rust 或 libgit2

- 桌面端没有 git2（§1.2）。外部 `git` 可能没装，也不能作为 P0 的前提。
- 浏览器 rebase 和桌面访客客户端都需要同一个内核。只有一份实现，三端的 hunk ID 才能一致（I4、I5）。
- Rust 端 `apply` 已经提供了写入安全（CAS 加恢复），不需要理解合并语义，只需要校验 `expectedHash`。
- **原提案 §5.1「用 libgit2 `merge_file`」作废。**

### 5.2 新增与修改的模块

| 模块 | 路径 | 职责 | 约束 |
| --- | --- | --- | --- |
| 合并内核 | `src/lib/share-merge/`（新） | 分词、diff3、提案、compose、frontmatter 键级处理、CriticMarkup 批注抽取、锚定、rebase | **纯 TS**：不得 import `@tauri-apps/*`、`svelte`、DOM API 或 moraya-core；只允许依赖标准库，以及可选的 `diff-match-patch`（§7.9）。会被三个宿主打包 |
| Rust 收件与审阅 | `src-tauri/src/project_share.rs`（改） | v2 校验、快照父子关系、审阅草稿持久化、`apply` 扩展、回执状态、git 元数据 | 不实现 diff；hunk 决定以不透明 JSON 存储 |
| Rust git 代理 | `src-tauri/src/project_share_git.rs`（新） | snapshot/submission commit、B 分支、C 补丁、清理 ref | 只能通过 `vault_sync::git_ops` 调用外部 `git`；不得加 git2 依赖 |
| Rust 访客客户端 | `src-tauri/src/share_guest.rs`（新） | 下载并校验 ZIP、`received/` 落盘、`guest.json`、发件箱 | 复用 `validate_relative`、`write_atomic`、`zip` crate（已有，2.2） |
| 主人审阅 UI | `src/components/project-review/`（新）；`src/lib/project-share/review.svelte.ts`（新） | 提交列表、统一 diff、hunk 操作、冲突编辑、批注面板、git 目标 | 替换 `ProjectShareDialog.svelte` 中的三栏审阅区；对话框的其余部分不动 |
| 页面内联脚本 | `src/lib/project-share/browser.ts`（改） | 版本检查、回执展示、IndexedDB v2 草稿、加载编辑器资源、textarea 兜底 | 仍然是单个可 `.toString()` 的函数，**不得 import 内核**（它不能有模块依赖） |
| 分享页编辑器 | `src/share-editor/main.ts`（新 vite entry） | Kit v2 加批注交互、内核（rebase、抽取、锚定）、「我的修改」视图 | IIFE 单文件，无 Tauri IPC，内容寻址（§12.2） |
| Worker | `worker/src/feedback.ts`（改）、`worker/src/receipt.ts`（新）、`worker/src/project.ts`（改）、`worker/src/kit.ts`（新）、`worker/src/index.ts`（路由） | v2 校验、回执、版本号、编辑器资源 | 不读正文（I8） |
| 共享校验夹具 | `src-tauri/tests/fixtures/project-feedback/{valid,invalid}/*.json`（新） | v2 形状规则的唯一样本集 | Worker 的 vitest 与 Rust 测试都必须遍历它 |

### 5.3 依赖方向

```
share-merge (纯 TS)
   ▲            ▲                 ▲
   │            │                 │
project-review  share-editor      share-guest UI (src/lib/share-guest/)
 (Svelte, 桌面)  (IIFE, 浏览器)      (Svelte, 桌面)
   │                                 │
   ▼                                 ▼
project_share.rs ◄── project_share_git.rs        share_guest.rs
```

`scripts/check-share-merge-purity.mjs`（新）必须在 `pnpm build` 前运行。它扫描 `src/lib/share-merge/**` 的 import，发现禁止项就失败。

---

## 6. 数据契约

### 6.1 通用规则

- **ID**：`^[a-zA-Z0-9_-]{1,128}$`。`snapshotId`、`submissionId` 和 `project_id` 沿用现有正则。新生成的 ID 用 `crypto.randomUUID()` 或 `uuid::Uuid::new_v4()`。
- **hash**：对 UTF-8 字节取 SHA-256，输出 64 位小写十六进制。
- **偏移量**：所有 `start`、`end`、`oursStart`、`oursEnd` 都是 **UTF-16 code unit 偏移**（JS 字符串下标）。Rust 不解释偏移量，只做形状校验。
- **换行与 BOM**：内核不得改写原文中的 `\r\n` 和 BOM（I6）。访客端提交前按 §7.1 做 EOL 对齐。
- **时间**：ISO 8601 UTC 字符串。
- **公开数据边界**：公开阅读页 snapshot 及 E4 从它投影的校验清单只含公开白名单字段，不含 `parentSnapshotId`、`git`、`gitError`、本机路径或凭据。source-only ZIP 不加入内部 manifest、reader 或 `.notemd` 管理文件；协作 token 不进入 ZIP、`received/`、日志或错误。旧包仅按 §13.2 验证既定两个内部元数据条目，绝不执行或写入收到的项目。

### 6.2 本机快照 manifest v2

`ProjectSnapshot`（`project_share.rs`）新增字段。读取时必须同时接受 schemaVersion 1 和 2；新快照一律写 2。

```jsonc
{
  "schemaVersion": 2,
  "project_id": "...",
  "snapshotId": "S3",
  "entry": "docs/index.md",
  "files": [ /* 不变：ProjectFile[] */ ],
  "parentSnapshotId": "S2",      // 冻结那一刻 Config.published_snapshot_id 的值；可为 null
  "createdAt": "2026-10-12T08:00:00Z",
  "git": null                     // 或下方对象；P1 填写，失败时为 null 并在 gitError 记原因
  // "gitError": "git not found" // 可选，仅供诊断，不外发
}
```

```jsonc
"git": {
  "snapshotCommit": "<oid>",
  "headAtFreeze": "<oid>",
  "prefix": "docs/proposal/",     // sourceRoot 相对仓库根，以 / 结尾；位于根目录时为 ""
  "repoRoot": "/abs/path"         // 本机路径，不得进入公开包
}
```

- Rust 字段一律加 `#[serde(default)]`，保证 v1 manifest 可读。
- `parentSnapshotId` 取 `Config.published_snapshot_id`，即上一次**成功发布**的快照。发布失败留下的孤儿快照不会成为父节点。
- 公开包（`bundle.ts` 的 payload，以及 §13.2 从公开阅读页投影的校验清单）**不得**包含 `parentSnapshotId`、`git`、`gitError`。当前 source-only ZIP 不带内部 manifest；旧包元数据的兼容校验不得将本机敏感字段重新公开。

### 6.3 建议包（submission）v2

v1 永久兼容（§16）。v2 的完整形状如下，规则在后面的表里，Worker 与 Rust 都必须执行。

```jsonc
{
  "schemaVersion": 2,
  "project_id": "p_x",
  "snapshotId": "S2",
  "submissionId": "uuid",
  "supersedes": "uuid-prev",          // 可选
  "rebasedFrom": "S1",                // 可选
  "message": "统一术语；补充第3节风险", // 可选
  "contributor": { "name": "Alice", "aiAssisted": false },   // 可选，整体可省
  "client": { "kind": "browser", "version": "6.1015.0" },     // 可选
  "edits": [{ "path": "docs/a.md", "baseHash": "<64hex>", "afterMarkdown": "..." }],
  "annotations": [{
    "path": "docs/a.md",
    "selector": { "exact": "风险", "prefix": "…", "suffix": "…", "start": 120, "end": 122 },
    "comment": "这里缺少量化",
    "kind": "comment"
  }]
}
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `schemaVersion` | 是 | 等于 `2` |
| `project_id`、`snapshotId`、`submissionId` | 是 | ID 正则 |
| `supersedes` | 否 | ID 正则，且 `≠ submissionId` |
| `rebasedFrom` | 否 | ID 正则，且 `≠ snapshotId` |
| `message` | 否 | string，≤ 2000 个 UTF-16 单位，不得含 `\0` |
| `contributor.name` | 否 | string，≤ 80，不得含控制字符（`\p{Cc}`） |
| `contributor.aiAssisted` | 否 | boolean |
| `client.kind` | 否 | `"browser"` 或 `"browser-fallback"` 或 `"notemd"` |
| `client.version` | 否 | string，≤ 32 |
| `edits` | 是 | 数组，≤ 2000 项；`path` 走现有 `relativePath` 规则，且不得重复 |
| `edits[].baseHash` | 是 | 64 位十六进制 |
| `edits[].afterMarkdown` | 是 | string |
| `annotations` | 是 | 数组，≤ 2000 项 |
| `annotations[].path` | 是 | `relativePath` 规则 |
| `annotations[].selector.exact` | 是 | string，≤ 2000；为空串时 `prefix` 和 `suffix` 至少一个非空（点批注） |
| `annotations[].selector.prefix`、`suffix` | 否 | string，≤ 64 |
| `annotations[].selector.start`、`end` | 否 | 非负安全整数；两者都存在时 `end ≥ start`，且 `end - start === exact.length` |
| `annotations[].comment` | 是 | string，1–10000 |
| `annotations[].kind` | 否 | `"comment"`、`"question"` 或 `"blocker"`，缺省按 `"comment"` 处理 |
| 未知顶层键或嵌套键 | — | **Worker 拒收**（400），用于防止协议被悄悄扩展；Rust 用 `deny_unknown_fields` 达到同样效果 |
| 总大小 | — | 不变：≤ 5 MiB（Worker 按字节计数） |

**语义规则**（只由 Rust 和主人端执行，Worker 不检查）：

- `selector` 的坐标系是**访客提交时看到的文本**：如果该 path 在 `edits` 中，坐标基于该 `afterMarkdown`，否则基于快照原文。由于访客自己的批注已被抽出，这段文本里不含访客批注，但含分享者批注（§12.5）。
- `edits` 中 `afterMarkdown` 与快照完全相同的项，客户端不应提交；主人端遇到时按「无改动」处理，不报错。
- `supersedes` 只是一个提示，不验证提交者是否同一人（没有身份体系）。主人端用它折叠展示，**不得**据此自动拒绝旧提交。

### 6.4 本机收件记录（inbox）扩展

`LocalFeedback`（Rust）新增字段，全部加 `#[serde(default)]`：

```rust
pub struct LocalFeedback {
    pub envelope: FeedbackEnvelope,           // payload 改为 enum { V1, V2 }，见 §16
    pub status: String,
    pub error: Option<String>,
    pub decisions: BTreeMap<String, Decision>,
    #[serde(default)] pub review: BTreeMap<String, ReviewDraft>,          // 新
    #[serde(default)] pub annotation_decisions: BTreeMap<String, String>, // 新：key = annotations 下标的十进制串；value = "promoted" | "dismissed"
    #[serde(default)] pub receipt: Option<ReceiptState>,                  // 新
    #[serde(default)] pub git: Option<SubmissionGit>,                     // 新（P1）
    #[serde(default)] pub superseded_by: Option<String>,                  // 新：本机根据其他包的 supersedes 计算并缓存
}
pub struct ReviewDraft {          // 审阅草稿：未写回之前的逐 hunk 决定
    pub kernel_version: u32,      // 等于 MERGE_KERNEL_VERSION，不一致时整份作废
    pub ours_hash: String,        // 生成提案时当前原件的 hash（仅供展示「原件已变」）
    pub hunks: BTreeMap<String, serde_json::Value>, // hunkId -> HunkDecision（§7.7），Rust 只存不解
    pub target: Option<String>,   // "worktree" | "branch" | "patch"（P1）
    pub updated_at: String,
}
pub struct Decision {             // 现有字段不变，新增：
    // ...
    #[serde(default)] pub hunk_summary: Option<HunkSummary>, // { accepted: u32, total: u32 }
    #[serde(default)] pub reason: Option<String>,            // reject 时可为 "superseded"
    #[serde(default)] pub git_branch: Option<String>,        // status == "branched"
    #[serde(default)] pub git_commit: Option<String>,
}
pub struct ReceiptState { pub state: String /* "auto" | "suppressed" | "sent" | "failed" */,
                          pub reply: Option<String>, pub sent_at: Option<String>, pub last_error: Option<String> }
pub struct SubmissionGit { pub commit: Option<String>, pub error: Option<String> }
```

- **新增 Decision 状态 `branched`**（P1，目标 B）：表示该文件已落成分支 commit，源文件未修改，视为「已决定」。现有状态的语义不变。
- `ReviewDraft.hunks` 的大小上限是每个文件 1 MiB（JSON 序列化后），超出时 `review-save` 报错。

### 6.5 回执（receipt）v1

```jsonc
{
  "schemaVersion": 1,
  "project_id": "p_x",
  "submissionId": "uuid",
  "decidedAt": "2026-10-12T09:00:00Z",
  "outcome": "accepted",                 // accepted | partial | rejected | superseded | forwarded
  "files": [{ "path": "docs/a.md", "outcome": "partial", "accepted": 3, "total": 5 }],
  "annotations": { "promoted": 1, "total": 4 },
  "reply": "谢谢，第3节已采纳",            // 可选，≤ 2000
  "includedInSnapshotId": "S4"           // 可选；采纳内容首次随某次发布出现时补写
}
```

- `files[].outcome` 取 `accepted`、`partial`、`rejected` 或 `forwarded`（`branched` 对外显示为 forwarded，即「已转入团队评审」）。
- 顶层 `outcome` 的推导规则：
  1. 所有文件都 rejected：`rejected`；如果 `reason` 都是 superseded，则为 `superseded`。
  2. 所有文件都 accepted 且 `accepted == total`：`accepted`。
  3. 存在 forwarded 且没有 accepted 或 partial：`forwarded`。
  4. 其余情况：`partial`。
- 只含批注的提交：`files` 为空，`outcome` 为 `accepted`（含义是「已阅」）。
- **不得**包含任何正文或路径以外的文件内容（I12）。

### 6.6 版本号（公开）

`GET /project/<slug>/version` 的响应：

```jsonc
{ "schemaVersion": 1, "project_id": "p_x", "snapshotId": "S3", "archiveReady": true, "expires_at": null }
```

### 6.7 浏览器草稿（IndexedDB）v2

数据库仍是 `notemd-project-sharing` 下的 store `data`，键值结构保持不变（不升级 DB 版本），只新增键：

| 键 | 值 | 说明 |
| --- | --- | --- |
| `<pid>:draft2:<lineageId>` | `DraftV2` | 新草稿；`lineageId` 是首次编辑时生成的 UUID，跨 rebase 保持不变 |
| `<pid>:token` | 不变 | — |
| `<pid>:submitted` | `string[]` | 本机提交过的 submissionId，用于拉取回执；最多保留 200 个，先进先出 |
| 旧的 `<pid>:<snapshotId>` | v1 草稿 | 只读迁移：首次加载时转换成 DraftV2，转换成功后删除 |

```ts
interface DraftV2 {
  v: 2
  lineageId: string
  snapshotId: string                         // 当前基线
  base: Record<string, { hash: string; markdown: string }> // 被编辑文件的基线原文（rebase 必需：新页面里不再有旧快照）
  after: Record<string, string>              // 唯一正文；含访客 CriticMarkup，提交时再抽取
  editorFiles?: Record<string, FileRecovery> // 按 path 保存既有 file owner 的恢复缓存，不保存第二份正文
  annotationKinds: Record<string, 'comment' | 'question' | 'blocker'> // key = sha256(exact + '\0' + comment) 的前 16 位
  message?: string
  lastSubmissionId?: string                  // 用作下一次的 supersedes
  rebasedFrom?: string
  previous?: {
    snapshotId: string
    base: DraftV2['base']
    after: DraftV2['after']
    annotationKinds?: DraftV2['annotationKinds'] // E3 保存旧值；可选以兼容旧草稿
    rebasedFrom?: string                        // E3 保存旧值，撤销时恢复
    annotations?: ProjectAnnotationV2[]          // 旧 fallback sidecar；同事务迁入 Critic，撤销时恢复
  } // 完整 rebase 撤销点；成功提交的本机确认完成后清除
  rebaseRecovery?: { snapshot: ShareSnapshotInput; candidate: Omit<DraftV2, 'rebaseRecovery' | 'pending'> } // 单层本机候选，无 token
  pending?: { submissionId: string; body: string } // 已冻结、待投递的请求体（逐字节重放保证幂等）
}
```

`FileRecovery` 复用 `src/editor-kit-v2/file-contract.ts` 的既有类型，不另抄恢复协议。`after` 是唯一正文；恢复缓存的 raw hash、完整 bindings 或形状失配时只丢该缓存，保留原文并生成新身份，不以缓存授予源码写权限。旧草稿没有 `editorFiles` 或 `previous` 的新增可选字段仍可读，不升级 DB 或建议包协议。撤销 rebase 必须从 `previous` 恢复旧 snapshot/base/after/annotationKinds/rebasedFrom 及旧旁存 annotations；缺省元数据按旧 v2 默认值恢复，不从当前快照猜造旧基线。

### 6.8 桌面访客客户端 `guest.json`

文件位置：`Vault/received/<host>/<project_id>/.notemd/guest.json`。

```jsonc
{
  "schemaVersion": 1,
  "shareUrl": "https://share.example/2026-10-12-xxx",   // 不含 fragment，不含 token
  "origin": "https://share.example",
  "slug": "2026-10-12-xxx",
  "project_id": "p_x",
  "snapshotId": "S3",                       // 当前基线，对应 .notemd/base/S3/
  "files": [{ "path": "docs/a.md", "hash": "..." }],
  "contributorName": "Alice",
  "lastSubmissionId": "uuid",
  "submitted": ["uuid", "..."],
  "outbox": [{ "submissionId": "uuid", "body": "<exact JSON string>", "queuedAt": "..." }],
  "pendingUpdate": null                      // 或 { "snapshotId": "S4", "unresolved": ["docs/a.md"] }
}
```

协作 token **不得**写入 vault。它存放在 app data 的 `share_db.json`（与 `projectIdentities` 同一个 `Store`），键为 `guest:<origin>:<project_id>`。

---

## 7. 合并内核规格（`src/lib/share-merge/`）

### 7.1 公共 API

```ts
export const MERGE_KERNEL_VERSION = 1

export type HunkKind = 'theirs-only' | 'ours-only' | 'both-same' | 'conflict'
export type HunkFlag =
  | 'trust-field'       // 触及 OKF 信任字段（§7.5）
  | 'frontmatter'       // 位于 frontmatter
  | 'owner-annotation'  // 改动或删除了 base 中已有的 CriticMarkup 批注（§12.5）
  | 'hidden-chars'      // theirs 新增了 bidi 控制符或零宽字符（§15）
  | 'eol-only'          // 两侧只差在换行符
  | 'degraded'          // 内核降级为整文件 hunk（§7.8）

export interface Hunk {
  id: string                 // 'h_' + 16 位十六进制（§7.4）
  kind: HunkKind
  base: string; ours: string; theirs: string
  oursStart: number; oursEnd: number   // 在 ours 中的 UTF-16 区间；全部 hunk 区间升序且互不重叠
  flags: HunkFlag[]          // 有序：按上面声明的顺序排列，去重
  frontmatterKeys?: string[] // flags 含 frontmatter 时列出涉及的键
}
export type Segment = { type: 'stable'; text: string } | { type: 'hunk'; id: string }
export interface MergeProposal {
  kernelVersion: 1
  path: string
  baseHash: string; oursHash: string; theirsHash: string   // 对内核实际收到的输入（EOL 对齐之后）取 hash
  theirsEolAligned: boolean
  segments: Segment[]        // 依次拼接（stable 用 text，hunk 用其 ours）后必须严格等于 ours
  hunks: Hunk[]              // 与 segments 中 hunk 的出现顺序一致
  stats: Record<HunkKind, number>
}

export function propose(input: { path: string; base: string; ours: string; theirs: string }): MergeProposal
export function compose(p: MergeProposal, decisions: Record<string, HunkDecision>): ComposeResult
export function rebaseDraft(input: { path: string; oldBase: string; newBase: string; draft: string }): RebaseResult
export function extractGuestAnnotations(input: { base: string; draft: string }): ExtractResult      // §12.5
export function anchor(text: string, selector: TextSelector): AnchorResult                          // §7.9
export function makeSelector(text: string, start: number, end: number): TextSelector               // prefix 和 suffix 各取 32
export function alignEol(base: string, theirs: string): { theirs: string; aligned: boolean }
export function sha256Hex(text: string): Promise<string>  // 为保持 propose 同步，可改为调用方传入预先算好的 hash；实现时二选一，在代码注释中写明
```

`propose` 第一步必须调用 `alignEol`：

- base 含 `\r\n` 而 theirs 不含 `\r` 时（textarea 和 contenteditable 都会把 CRLF 归一成 LF），把 theirs 的 `\n` 转成 `\r\n`。
- base 以 BOM 开头而 theirs 没有时，补上 BOM。

其余情况不改动。ours 永远不改。

### 7.2 分词（tokenize）

把文本切成 token 序列，**`tokens.join('') === text` 必须恒成立**（I6）。切分以行为基础，每行包含它自己的行尾符。

1. **frontmatter**：文本（跳过 BOM 后）以 `---` 加行尾开头，并且之后某一行恰好是 `---` 或 `...` 时，从开头到该行（含）构成 frontmatter 区。区内切分如下：
   - 开头和结尾的分隔行各自是一个 token。
   - 区内每个**顶层键**是一个 token。键行匹配 `^[^\s#\-][^:\r\n]*:`，token 一直延伸到下一个键行或结尾分隔行之前；中间的续行、缩进行、`- ` 列表项、空行和注释都归属于前一个键。
   - 键名取冒号前的部分，去空白，去掉一层成对的引号。
   - 第一个键行之前如果出现非空、非注释行，整个 frontmatter 区退化为一个原子 token。
   - 每个 token 记录 `fmKey`。
2. **原子块**（整块一个 token）：
   - 围栏代码：行首最多 3 个空格，后跟 ≥3 个 `` ` `` 或 `~`；到相同字符、长度不小于开头的闭合行为止；没有闭合时一直到文末。
   - 数学块：行首去空白后恰好为 `$$`，到下一个这样的行为止。
   - HTML 块：行首 `<` 后跟字母、`/` 或 `!--`，到下一个空行（不含）为止。
3. **表格**：某行含 `|`，下一行匹配 `^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$` 时，表头行、分隔行以及后续所有含 `|` 的非空行**各自是一个 token**。
4. **空行段**：连续的空行（只含空白）合成一个 token。
5. **散文行**：其余每一行切成**句子 token**。
   - 切点在句末标点 `。！？；!?;…` 或者「`.` 后跟空白」之后，并吞入紧跟的闭合符号 `」』”’"')]）】` 和水平空白。
   - 行尾符永远并入该行最后一个 token，所以「一句一行」（semantic line breaks）的写法天然就是逐行粒度。
   - **受保护的行内片段内不切**：反引号代码（同长度的反引号配对）、`$…$`、`[…](…)` 和 `![…](…)`、`[[…]]`、`{==…==}{>>…<<}`、`{>>…<<}`、`<…>` 标签。
   - 列表、引用、标题的标记（`- `、`1. `、`> `、`# `）留在该行第一个 token 中。

token 比较按精确字符串进行。实现时可以先把 token 映射成整数 ID 再 diff。

### 7.3 三方 diff 与 hunk 划分

1. 分别对 base↔ours 和 base↔theirs 的 token 序列做 Myers O(ND) diff，得到两组**变更**。每个变更是一对区间：base 中的 `[b0,b1)` 加上该侧中的 `[s0,s1)`；`b0 == b1` 表示纯插入。实现前先剥离公共前后缀；平局规则固定为「先删后插」，并写进代码注释（I5）。
2. 把两组变更按 base 坐标合并成**区域**。下面任一条件成立，A 侧变更与 B 侧变更就并入同一区域：
   - 两者都是非空区间，且相交：`max(a0,b0) < min(a1,b1)`；
   - 一方是插入点 `p`，另一方是非空区间且 `b0 ≤ p ≤ b1`（端点也算）；
   - 两者都是插入点，且 `a0 == b0`。

   并入关系做传递闭包。**两个首尾相接的非空变更（`a1 == b0`）不合并**，所以两人改了相邻的两句不会冲突；这一点有别于 git 的行为，是有意的设计。
3. 每个区域产生一个 hunk，其 base、ours、theirs 为对应区间 token 的拼接。分类规则：
   - ours == base：`theirs-only`
   - theirs == base：`ours-only`
   - ours == theirs：`both-same`
   - 其他：`conflict`
4. 区域之间未变动的 token 组成 `stable` segment（相邻的 stable 合并成一段）。
5. `oursStart` 和 `oursEnd` 由各 segment 的长度累加得到。

### 7.4 hunk ID

```
id = 'h_' + hex(sha256( "nmk1\0" + path + "\0" + base + "\0" + theirs + "\0" + ordinal ))[0:16]
```

- `ordinal` 是同一提案内 `(base, theirs)` 完全相同的 hunk 的出现序号，从 0 开始，按 ours 中的位置排列。
- 计算 ID 时**不使用 ours**。这样原件在其他位置的变化不会让 ID 失效；同一位置被主人改过之后，ID 不变，但 kind 会变（见 §7.7 的 kind 校验）。
- `ours-only` 和 `both-same` 也按同一公式生成 ID（它们不需要决定）。

### 7.5 frontmatter 与信任字段

- 一个 hunk 只要涉及带 `fmKey` 的 token，就打上 `frontmatter` 标记，并在 `frontmatterKeys` 中列出涉及的键（按字典序）。
- 涉及以下任一键时，再加 `trust-field`：`type`、`generated`、`verified`、`sources`、`status`、`stale_after`。这个集合与 `docs/okf-v0.2-format-constraints.md` §5 对齐，变更时两处必须同步，并递增 `MERGE_KERNEL_VERSION`。
- 整个 frontmatter 退化为原子 token 时，只要被改动就同时打上 `frontmatter` 和 `trust-field`（保守处理）。

### 7.6 风险标记与「接受全部无冲突」

「接受全部无冲突改动」只选中满足以下全部条件的 hunk：`kind == 'theirs-only'`，且 `flags` 中不含 `trust-field`、`owner-annotation`、`hidden-chars`、`degraded`。被排除的 hunk 必须在界面上显示为「需单独确认」，并注明原因。

### 7.7 决定与 compose

```ts
export type HunkDecision =
  | { kind: 'theirs-only'; choice: 'accept' | 'reject' }
  | { kind: 'conflict'; choice: 'ours' | 'theirs' | 'ours+theirs' | 'theirs+ours' | 'edited'; text?: string; source?: 'human' | 'ai-suggestion' }

export interface ComposeResult {
  text: string
  pendingConflicts: string[]   // 未决的冲突 hunk ID
  pendingTheirs: string[]      // 未决的 theirs-only hunk ID
  accepted: number             // theirs-only 中被接受的数量，加上 conflict 中 choice ≠ 'ours' 的数量
  total: number                // theirs-only 与 conflict 的总数
  staleDecisions: string[]     // 决定中 kind 与当前提案不符、或 ID 已不存在的
}
```

**compose 规则**：按 segments 顺序拼接。

| segment 或决定 | 输出 |
| --- | --- |
| stable | 原样输出 |
| `ours-only`、`both-same` | 输出 ours |
| `theirs-only`，accept | 输出 theirs |
| `theirs-only`，reject 或未决 | 输出 ours |
| `conflict`，`ours` | 输出 ours |
| `conflict`，`theirs` | 输出 theirs |
| `conflict`，`ours+theirs` | 输出 ours + theirs |
| `conflict`，`theirs+ours` | 输出 theirs + ours |
| `conflict`，`edited` | 输出 `text`（必填） |
| `conflict`，未决 | 输出 ours |

**决定沿用**：重新生成提案后，旧决定按 ID 对应过去。决定中的 `kind` 与新 hunk 的 kind 不一致时，作废该决定，并在 `staleDecisions` 中列出。`ReviewDraft.kernel_version` 不等于当前版本时，作废全部决定。

**写回前置条件**（主人端 UI 执行）：

- `pendingConflicts` 必须为空。
- `pendingTheirs` 非空时，确认框必须写明「N 处未决将视为不采纳」。
- 确认框必须展示 `text` 相对**当前原件**的完整 diff。

### 7.8 性能与降级

- 单个文件的 token 数超过 200 000，或 Myers 的编辑距离 D 超过 20 000 时，`propose` 降级：整份文件作为唯一一个 hunk（base、ours、theirs 都是全文），kind 按 §7.3 规则判定，打上 `degraded` 标记。
- 主人端三份输入合计超过 256 KiB 时，必须在 Web Worker 中运行内核（vite `?worker`），不得阻塞 UI。

### 7.9 锚定（`anchor`）

```ts
export interface TextSelector { exact: string; prefix?: string; suffix?: string; start?: number; end?: number }
export type AnchorResult =
  | { status: 'exact' | 'fuzzy'; start: number; end: number }
  | { status: 'orphan' }
```

按以下顺序尝试，命中即返回：

1. **位置命中**：`start` 和 `end` 都存在，且 `text.slice(start, end) === exact`，返回 `exact`。
2. **唯一精确匹配**：`exact` 非空时枚举所有出现位置（最多 1000 个）。只有一个时返回 `exact`。有多个时按两项打分：「与 prefix 的后向公共长度 + 与 suffix 的前向公共长度」，分高者胜；平局时选离 `start` 最近的；仍然平局取第一个。
3. **点批注**（`exact` 为空串）：在文本中找 `prefix + suffix` 的拼接；找不到时，再找只用 prefix 或只用 suffix 能唯一定位的位置；仍然找不到则返回 `orphan`。
4. **模糊匹配**：只在 8 ≤ `exact.length` ≤ 512 时进行。
   - 以 `start`（缺失时为 0）为中心，在 ±(2000 + exact.length) 的范围内找一个窗口，使 `1 − Levenshtein(window, exact) / exact.length ≥ 0.8`。窗口长度在 `exact.length` 的 ±20% 之间。
   - prefix 或 suffix 存在时，至少一个要与窗口相邻的文本相似度 ≥ 0.6。
   - 可以引入 `diff-match-patch`（Apache-2.0，固定版本）的 `match_main` 来定位候选，但最终判定必须用上面的阈值。
5. 以上都失败时返回 `orphan`。**不得**把批注挂到低于阈值的位置。

v1 批注的转换方式：`{quote, start, end}` 转成 `{exact: quote, start, end}`。

### 7.10 rebase

`rebaseDraft({oldBase, newBase, draft})` 等于 `propose({base: oldBase, ours: newBase, theirs: draft})`，再用「接受全部 `theirs-only`（包括带标记的，因为这是访客自己的改动）」进行 compose。返回结果包含：

- 无冲突时的新草稿；
- 冲突时的提案，交给界面逐个解决；
- `ownerAnnotationTouched: boolean`。

访客端的冲突选项只有三种：「分享者版本」（= ours）、「我的版本」（= theirs）、「手改」（= edited）。

### 7.11 内核测试向量（必须作为 vitest 用例实现，文件 `src/lib/share-merge/*.test.ts`）

| # | 场景 | 期望 |
| --- | --- | --- |
| K1 | base == ours == theirs | 0 个 hunk；compose == ours |
| K2 | 只有 theirs 改了一句 | 1 个 `theirs-only`；接受后结果 == theirs |
| K3 | 同一段落，ours 改第 1 句，theirs 改第 3 句 | 1 个 `ours-only` 加 1 个 `theirs-only`，没有 conflict |
| K4 | 同一段落，相邻两句分别被改（ours 改第 1 句，theirs 改第 2 句） | 不冲突（§7.3 第 2 步） |
| K5 | 同一句被两侧改成不同内容 | 1 个 `conflict` |
| K6 | 两侧做了相同修改 | `both-same` |
| K7 | ours 在某句前插入，theirs 改了该句 | `conflict`（插入点落在区间端点上） |
| K8 | 代码块内两侧改了不同行 | `conflict`（原子块） |
| K9 | 表格两侧改了不同行 | 两个独立 hunk，无冲突 |
| K10 | frontmatter：theirs 改了 `title`，ours 改了 `tags` | 不冲突；theirs 的 hunk 带 `frontmatter`，不带 `trust-field` |
| K11 | theirs 改了 `verified` | hunk 带 `trust-field`，被「接受全部」排除 |
| K12 | base 是 CRLF，theirs 是 LF 且只改一句 | `theirsEolAligned == true`，只有 1 个 hunk；compose 结果保持 CRLF |
| K13 | theirs 引入 U+202E | hunk 带 `hidden-chars` |
| K14 | 拼接保真 | 用 fuzz（随机 Markdown，≥ 500 例）检查：`tokens.join('') == text`；全部拒绝时 compose == ours |
| K15 | 确定性 | 同一输入运行两次，提案 JSON 逐字节相等；hunk ID 不受 ours 中无关改动影响 |
| K16 | V5 去重 | 先接受包 A 的部分 hunk 并写回；再对内容相同的包 A′ 生成提案，已接受的 hunk 变成 `both-same` |
| K17 | 降级 | 超过阈值时只有 1 个 hunk，带 `degraded` |
| K18 | 锚定 | 精确命中；多处出现时靠 prefix/suffix 消歧；文本小改后模糊命中；大改后返回 `orphan`；点批注 |
| K19 | 抽取 | 见 §12.5 的测试 |

---

## 8. 主人侧：取件、审阅与写回

### 8.1 Rust op 变更（`project_share` 分发函数）

| op | 变更 | 请求字段 | 返回 |
| --- | --- | --- | --- |
| `snapshot` | 写入 manifest v2（`parentSnapshotId`、`createdAt`）。P1 起在冻结成功**之后**尝试生成 git 快照 commit，失败不影响快照（记录到 `gitError`） | 不变 | `ProjectSnapshot` |
| `feedback` | `validate_feedback` 接受 schema 1 和 2，并按 §6.3 执行语义校验。v2 的 `supersedes` 指向本机已有提交时，把旧记录的 `superseded_by` 设为本包 ID。P1 起在 git 模式下尝试生成 submission commit（失败不影响收件） | 不变 | 不变 |
| `inbox` | 返回结构中带上新字段 | 不变 | `LocalFeedback[]` |
| `review` | 不变（已经返回 base、current、after） | 不变 | `ReviewFile` |
| **`review-save`**（新） | 持久化 `ReviewDraft`。校验 path 属于 edits，大小 ≤ 1 MiB | `submissionId, path, draft: ReviewDraft` | `LocalFeedback` |
| `apply` | ① 前置条件放宽：path 属于 `edits ∪ annotations[].path` 即可（用于只有批注的文件的「提升」）；② 新增可选字段 `summary: {accepted, total}`，写入 `Decision.hunk_summary`；③ 成功后删除 `review[path]` | 加上 `summary?` | 不变 |
| `reject` | 新增可选字段 `reason`（目前只允许 `"superseded"`） | 加上 `reason?` | 不变 |
| **`annotation-decide`**（新） | 设置 `annotation_decisions[index]`，值为 `promoted` 或 `dismissed`。不写源文件，「提升」时的写入走 `apply` | `submissionId, index, value` | `LocalFeedback` |
| **`receipt-set`**（新） | 设置 `ReceiptState`：`state` 只能是 `auto`、`suppressed` 或 `sent`；可以写 `reply`（≤ 2000）；也可以写 `failed` 并带 `last_error` | `submissionId, receipt` | `LocalFeedback` |

所有新 op 都必须在 `self.lock()` 中执行，并调用 `self.active(&b)?`。错误一律返回 `String`，用法与现有 op 相同。新增的稳定错误前缀如下，前端按前缀识别：

| 错误前缀 | 含义 |
| --- | --- |
| `review draft too large` | `ReviewDraft` 超过 1 MiB |
| `kernel version mismatch` | 前端传入的 `kernel_version` 不等于当前版本 |
| `annotation index out of range` | `annotation-decide` 的下标越界 |
| `invalid receipt state` | `receipt-set` 的状态取值非法 |

### 8.2 审阅流程（前端，`review.svelte.ts`）

1. **打开提交**：对每个 edit 路径调用 `review`，在 Worker 线程中运行 `propose({base, ours: current, theirs: after})`，再加载 `review[path]` 中的决定，沿用规则见 §7.7。
2. **记录决定**：主人每做一次决定，防抖 500 ms 后调用 `review-save` 持久化，保证重启后不丢。
3. **写回本文件**：先执行 `compose`，检查前置条件，展示确认 diff，然后调用 `apply(expectedHash = ReviewFile.currentHash, content = text, summary)`。
   - 返回 `source changed; review again` 时，重新调用 `review` 和 `propose`，沿用已有决定，并显示横幅「原件已变化，提案已刷新，N 个决定失效」。不得重试写入。
4. **整份处理完毕**：所有 edit 路径的 Decision 都进入终态（`accepted`、`rejected`、`branched`；`mirror_pending` 也算已决定），只含批注的提交则以 `resolve` 结束，然后按 §8.5 处理回执。
5. **按文件视图**（V3）：把同一个 path 的所有待审提交聚合到一起，**依次**审阅。每写回一份，就用新的 current 重算其余提案，不做多路合并。

### 8.3 审阅界面（`src/components/project-review/`）

| 组件 | 内容 |
| --- | --- |
| `SubmissionList.svelte` | 分组为待审、部分、已处理、隔离、已取代（折叠）。每项显示 `message`、署名（「自报」徽标）、`aiAssisted` 徽标、文件数、hunk 数。被取代的提交只显示最新一份，展开后可以看到历史；「全部标为已取代」等于对每个 path 执行 `reject(reason: superseded)` |
| `HunkView.svelte` | 以当前原件为底的统一 diff。每个 hunk 有「接受、拒绝、编辑」三个操作；hunk 内用词级高亮（只用于显示，按 Unicode 字词边界即可）。风险标记显示为徽标 |
| `ConflictEditor.svelte` | 三栏（ours、theirs、结果），五个按钮对应 `HunkDecision` 的五种 choice。结果栏是纯文本编辑 |
| `AnnotationPanel.svelte` | 访客批注重锚到当前原件（`anchor`），按位置排序，`orphan` 的放到「孤立评论」组。操作有「提升为我的批注」和「忽略」 |
| `GitTargetBar.svelte`（P1） | 目标 A、B、C 切换，并显示 trailer 文本 |
| 顶栏 | 「接受全部无冲突改动」（遵守 §7.6）、「写回本文件」、视图切换（按提交或按文件）、「源码 diff / 渲染 diff」 |

快捷键：`j`/`k` 切换 hunk，`a` 接受，`r` 拒绝，`e` 编辑，`⌘↩` 写回本文件。焦点在任何输入框中时，快捷键一律失效。

渲染 diff 必须遵守 §15 的不可信内容规则。

### 8.4 批注「提升」

- 文本格式：在当前原件中，用 `{==<锚定的原文>==}{>><name>：<comment><<}` 包住锚定区间。`<name>` 取 `contributor.name`（v1 取 `name`），缺失时为「访客」。`comment` 必须先经过 `sanitizeNote`。
- 锚定区间与已有的 CriticMarkup 重叠时，不包裹原文，改为在区间末尾插入点批注 `{>><name>：<comment><<}`。
- 写入方式：生成新的全文，调用 `apply(expectedHash = currentHash)`。同一文件有多条提升时，合并成一次 apply。成功后对每条调用 `annotation-decide(promoted)`。
- 只有锚定结果为 `exact` 或 `fuzzy` 的批注可以提升。`orphan` 只能「忽略」，或由主人复制内容后手工处理。

### 8.5 回执（主人侧，默认开启）

- 提交整份处理完毕（§8.2 第 4 步），并且 `receipt.state ∈ {None, "auto", "failed"}` 时：
  1. 按 §6.5 组装回执；
  2. 调用 `PUT /feedback/<slug>/receipt/<submissionId>`（§10.3）；
  3. 成功后执行 `receipt-set(sent, sent_at)`，失败则执行 `receipt-set(failed, last_error)`。
- 每次 `pullProjectFeedback` 结束后，重试状态为 `failed` 的回执。
- 单份提交上有一个「不发回执」开关，对应 `suppressed`。发送之后关闭它，会调用 `DELETE` 撤回回执。
- 回复输入框是可选项，≤ 2000 字，在发送之前填写。
- **补写 `includedInSnapshotId`**：每次发布成功（`published` 之后）时，对状态为 `sent`、outcome 属于 `{accepted, partial}` 且尚未补写的回执，再 PUT 一次，带上新的 snapshotId。

### 8.6 版本场景处理表（验收用）

| # | 场景 | 处理 | 覆盖测试 |
| --- | --- | --- | --- |
| V1 | 基于 S2 改，原件未动 | 全部是 theirs-only | K2 |
| V2 | 原件在 S2 之后被改过 | 三方合并 | K3–K7 |
| V3 | 两位访客改同一文件 | 按文件视图依次审阅，每次重算 | R3（§17） |
| V4 | 基于 S1，已发布 S3 | 以 S1 为 base（本机保留了全部快照）；访客端也可以先 rebase | R4 |
| V5 | 同一草稿多次提交 | `supersedes` 折叠；已接受的部分变成 `both-same` | K16 |
| V6 | 文件已移出分享，或原件被删除 | 该文件的 `bound_source` 或 `baseline` 失败，标为「目标不在分享范围」，只能拒绝或复制内容 | R6 |
| V7 | 改了 frontmatter | 按键级处理，信任字段需要单独确认 | K10、K11 |
| V8 | 停止分享时有在途草稿 | 已入库的照常审阅；Worker 返回 410 时，访客端保留草稿并允许导出 | 现有测试 |

---

## 9. git 模式（P1）

### 9.1 前提与探测

- 所有 git 调用都通过 `vault_sync::git_ops`。需要在 `git_ops` 中新增一个辅助函数（不改动现有函数）：

  ```rust
  pub fn run_git_io(repo: &Path, args: &[&str], env: &[(&str, &str)], stdin: Option<&[u8]>) -> GitResult<Vec<u8>>
  ```

  它返回原始 stdout 字节，非 0 退出码转为 Err。
- **探测**：执行 `git -C <sourceRoot> rev-parse --show-toplevel --is-bare-repository`。出现以下任一情况，判定为**非 git 模式**，后续全部跳过，行为与 P0 完全一致：
  - 失败或找不到 git；
  - 是 bare 仓库；
  - `HEAD` 未诞生（`rev-parse --verify HEAD` 失败）。
- 探测结果不缓存。每次需要时都重新探测，开销可以接受。
- `prefix` 等于 `sourceRoot` 相对 toplevel 的路径，用 `/` 连接；位于根目录时为空串。路径中含非 UTF-8 时判定为非 git 模式。
- **团队仓库判定**：`git -C <root> remote` 有输出，即为团队仓库，默认目标 B；否则是个人仓库，默认目标 A（§20-2）。主人选择的目标按项目保存在 `.notemd/project.json` 的新字段 `gitTarget` 中，类型为 `Option<String>`，加 `serde(default)`。

### 9.2 隐藏 ref 与对象写入（不碰 index 和工作区）

ref 名称：

```
refs/notemd/share/<project_id>/snapshots/<snapshotId>
refs/notemd/share/<project_id>/submissions/<submissionId>
refs/notemd/share/<project_id>/exports/<submissionId>
```

写入前必须用 `git check-ref-format` 校验 ref 名。

**造树**统一使用临时 index，不得触碰真实 index（I10）：

1. 在 app 临时目录（不是仓库内）创建临时 index 文件路径 `T`。之后所有命令都带 `GIT_INDEX_FILE=T` 环境变量。
2. `git read-tree <parentCommit>`。
3. 对每个文件执行 `git hash-object -w --path=<prefix+path> --stdin`，以字节作为 stdin。这里用 `--path`，是为了让仓库的 clean filter 和 eol 规则按 `git add` 的方式生效。
4. `git ls-tree <parentCommit> -- <prefix+path>`：取得原有 mode，没有该条目时用 `100644`。然后执行 `git update-index --add --cacheinfo <mode>,<oid>,<prefix+path>`。
5. `git write-tree` 得到 tree，然后删除 `T`（无论成功失败都要删除）。

**commit**：执行 `git commit-tree <tree> -p <parent> -F -`，消息从 stdin 传入。身份规则：

- committer 永远使用仓库配置的身份，不覆盖。
- author 的规则在下面各节分别说明。

**ref 写入**：执行 `git update-ref <ref> <oid> <zero-oid>`，只允许新建。ref 已存在且指向同一个 oid 时视为成功；指向不同 oid 时报错。

### 9.3 snapshot commit

- 时机：`snapshot()` 冻结成功之后。parent 是当时的 `HEAD`（允许 detached）。文件取快照字节。
- author 等于 committer，即主人。
- 消息：

  ```
  notemd: share snapshot <snapshotId>

  Notemd-Project: <project_id>
  Notemd-Snapshot: <snapshotId>
  ```

- 结果写入 manifest 的 `git` 字段和 `snapshots/` 下的 ref。

### 9.4 submission commit

- 时机：`feedback` 收件并校验通过之后，前提是对应快照有 `git.snapshotCommit`。没有的话跳过，记录 `SubmissionGit.error = "snapshot has no commit"`。
- parent 是 snapshot commit；tree 是在 snapshot tree 上换入各 `afterMarkdown` 的结果。
- author 的设置方式是传入环境变量：
  - `GIT_AUTHOR_NAME` 为 `<name> (guest, unverified)`，name 缺失时为 `guest`。name 中的 `<`、`>`、`\n` 要剔除。
  - `GIT_AUTHOR_EMAIL` 为 `<submissionId>@guest.notemd.invalid`。
  - `GIT_AUTHOR_DATE` 为信封的 `receivedAt`。
- 消息格式：

  ```
  <message 首行，截断到 72 个字符；没有 message 时为 "notemd: suggestion <submissionId 前 8 位>">

  <message 其余部分，经过下文的清洗>

  Notemd-Project: <project_id>
  Notemd-Snapshot: <snapshotId>
  Notemd-Submission: <submissionId>
  Notemd-Contributor: human:guest-<slug> (unverified, self-reported)
  Notemd-AI-Assisted: yes|no|unknown
  ```

- **清洗**：
  - 剔除 `\0` 和除 `\n`、`\t` 之外的控制字符；
  - 凡是匹配 `^(Notemd-[A-Za-z-]+|Co-authored-by|Signed-off-by|Reviewed-by|Acked-by):` 的行（不区分大小写），一律在行首加 `> `，防止访客伪造 trailer；
  - trailer 段必须是消息的最后一段。
- `<slug>`：把 name 转小写后，只保留 `[a-z0-9-]`，连续的 `-` 合并为一个，截断到 32 个字符；结果为空（例如纯中文名）时，用 submissionId 的前 8 位。

### 9.5 合入目标

| 目标 | 写什么 | 不写什么 | 完成后 Decision |
| --- | --- | --- | --- |
| **A 写回工作区**（个人仓库默认） | 走 §8.2 的 `apply`。界面提供「复制提交信息」，内容是 `message` 加 `Co-authored-by: <name> (guest, unverified) <<submissionId>@guest.notemd.invalid>` 加上 `Notemd-*` trailers | **不得**写 `commit.template`、hooks 或 `.git/config`（I10） | `accepted` |
| **B 生成分支**（团队仓库默认） | 见下面的算法 | 不写工作区，不切分支，不推送 | `branched` 加上 `git_branch`、`git_commit` |
| **C 导出补丁** | 按 B 的算法生成 commit，但只写 `exports/` 隐藏 ref，不建分支；然后执行 `git format-patch -1 <oid> --stdout`，通过保存对话框写出 `.patch` 文件 | 同 B | 不改变 Decision（导出不算决定），可以重复导出 |

**B 的算法**（以 submission 为单位，不能逐文件选择）：

1. 记录 `H = HEAD` 的 oid。对每个 edit 路径，取 `ours_H = git cat-file blob H:<prefix+path>`；取不到时该文件 B 失败。
2. 用**同一份 `ReviewDraft` 决定**执行 `propose({base: 快照, ours: ours_H, theirs: after})` 和 `compose`。如果出现 `staleDecisions` 或 `pendingConflicts`，B 中止，提示「相对 HEAD 有冲突或决定失效，请先提交本地改动，或改用 A」。
3. 所有文件都通过后，在临时 index 中以 H 为 parent 造树，执行 commit-tree：
   - author 是访客（规则同 §9.4）；
   - 消息同 §9.4，但 `Notemd-Snapshot` 一行之后增加 `Notemd-Base: <H>`；
   - 用 `Co-authored-by` 写上主人自己，可选。
4. 分支名为 `notemd/<entry 去扩展名后的 slug>/<submissionId 前 8 位>`，需要通过 `git check-ref-format --branch` 校验。执行 `git update-ref refs/heads/<branch> <oid> <zero-oid>`；分支已存在时在名字后追加 `-2`、`-3`，最多尝试到 `-9`。
5. 对每个 path 调用 Rust op **`git-branched`**（新增，在 `project_share` 分发函数中），写入 Decision `branched`。
6. 界面显示分支名，以及可以复制的 `git push -u <remote> <branch>`（I11：note.md 不执行这条命令）。

**B 的不变量测试**：

- `git merge-base --is-ancestor <snapshotCommit> <branch>` 必须返回假（I9）。
- 执行前后，`git status --porcelain=v2`、`.git/index` 的字节、`HEAD`、`git config --list --local` 必须完全相同（I10）。

### 9.6 生命周期

- `delete` 项目时：`git for-each-ref --format=%(refname) refs/notemd/share/<project_id>/`，再对每一条执行 `git update-ref -d`。失败时只记日志，不阻塞删除。`refs/heads/notemd/*` 分支属于用户，**不删除**。
- 停止分享时保留 ref。
- 仓库被移动或删除时，所有 git 操作静默降级为非 git 模式。

### 9.7 git 模式的 Rust 接口

所有操作都在 `project_share_git.rs` 中，通过 `project_share` 分发函数暴露。git 子进程较慢，**不得**在持有分发函数里的全局 `Mutex` 时执行。做法是新增一个 Tauri 命令 `project_share_git`，它只读取 binding 和快照，按 §9.2 的 CAS 写 ref，最后通过 `project_share` 的 `git-branched` op 回写 Decision。

| 命令 op | 输入 | 输出 |
| --- | --- | --- |
| `probe` | `project_id` | `{ git: bool, team: bool, prefix, head, branch? , reason? }` |
| `branch` | `project_id, submissionId, results: {path → text}` | `{ branch, commit }` |
| `export-patch` | `project_id, submissionId, results` | `{ patch: string }` |

`results` 由前端在第 2 步算出，Rust 只负责造树和提交。注意：snapshot commit 和 submission commit 由 `project_share` 内部在 `snapshot` 和 `feedback` 中触发，属于非阻塞的尽力而为操作，因此它们的子进程调用必须放在锁外的第二阶段执行：先释放锁，再写 git，最后以一次短暂加锁回写 manifest 或 inbox 的 `git` 字段。

---

## 10. Worker 规格

### 10.1 路由总表（新增或变更）

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /feedback/<slug>` | `X-Feedback-Token` | **变更**：接受 v1 和 v2，v2 按 §6.3 校验 |
| `GET /project/<slug>/version` | 无（与页面同等公开） | **新增**，见 §10.2 |
| `PUT /feedback/<slug>/receipt/<submissionId>` | `Authorization: Bearer SHARE_API_KEY` | **新增**，写回执 |
| `DELETE /feedback/<slug>/receipt/<submissionId>` | Bearer | **新增**，撤回回执 |
| `GET /feedback/<slug>/receipt/<submissionId>` | `X-Feedback-Token` | **新增**，访客读回执 |
| `GET/HEAD /_kit/<name>` | 无 | **新增**，编辑器资源（§12.2） |
| `PUT /_kit/<name>` | Bearer | **新增**，上传编辑器资源 |

路由冲突说明：

- 现有的 `GET /feedback/<project_id>/<submissionId>` 是 3 段路径；回执路径是 4 段，第 3 段固定为 `receipt`，不会冲突。实现时必须先匹配 4 段的回执路由。
- `/_kit/` 必须放在通配的 `handleGet(path)` **之前**。
- 所有新路由都必须经过 `withCors`。

### 10.2 `GET /project/<slug>/version`

- `handleProject` 的正则扩展为 `(entry|archive|download|version)`。`version` 只接受 GET 和 HEAD，判断位置在 Bearer 检查**之前**（与 `download` 相同）。
- 成功时返回 200，内容为 §6.6 的 JSON，带 `Cache-Control: no-store` 和 `X-Robots-Tag: noindex`。
- 返回值中的 `snapshotId` 取 `state.active.snapshotId`，`archiveReady` 等于 `!!state.active.archiveKey`。
- 分享已失效（`activeProjectMetadata` 返回 null）时返回 410。
- 非项目 slug（旧的单文件分享）返回 404。

### 10.3 回执

- 存储键为 `receipts/<project_id>/<submissionId>.json`。**不得**放在 `feedback/` 前缀下，否则会破坏 `listFeedback` 的解析。
- **PUT** 的处理流程：
  1. 读取 slug 对应的 state，得到 `project_id`；
  2. 检查 `feedback/<project_id>/<submissionId>.json` 是否存在，不存在返回 404；
  3. 按 §6.5 校验请求体：≤ 64 KiB，`project_id` 和 `submissionId` 与路径一致，枚举值合法，未知键返回 400；
  4. 覆盖写入，返回 204。
- **DELETE**：删除回执，返回 204；回执本来就不存在时同样返回 204。
- **GET**：
  - 分享未失效且 token 校验通过时返回 200 和回执 JSON，带 `Cache-Control: no-store`；
  - 回执不存在时返回 404，访客端显示「已送达，待分享者处理」；
  - token 错误返回 403；
  - 分享失效返回 410。
- **安全说明**：读取回执需要同时持有 token 和 `submissionId`。`submissionId` 是 122 bit 的随机 UUID，只有提交者本机知道，因此访客之间互相看不到对方的回执。
- **生命周期**：与 `feedback/<project_id>/` 相同。如果现有的 revoke 或删除流程会清理 feedback，就必须同样清理 `receipts/<project_id>/`；不清理 feedback 的，回执也不清理。实现时先核对 `revokeProject` 的 cleanup 列表，然后在 PR 中说明结论。

### 10.4 v2 校验实现

- `validPayload` 拆成 `validV1` 和 `validV2`。v2 按 §6.3 的表格逐项实现，**未知键拒收**。
- `worker/tests/feedback.test.ts` 必须遍历 `src-tauri/tests/fixtures/project-feedback/{valid,invalid}/`：valid 中的样本全部返回 200，invalid 中的全部返回 400。
- Rust 端的 `validate_feedback` 测试遍历同一组夹具，规则保持一致（Rust 额外执行语义校验，因此可能更严格，但不能更宽松）。

---

## 11. 浏览器访客端（内联脚本 `browser.ts`）

> 内联脚本不能 import 内核（它通过 `.toString()` 内联）。凡是需要内核的功能（rebase、批注抽取、「我的修改」），都在加载编辑器资源（§12）之后才可用。资源不可用时，按本节的降级路径处理。

### 11.1 版本检查

- **触发时机**：页面加载后、`visibilitychange → visible` 时、点击提交前。前两种情况节流为 ≥ 60 秒一次，提交前强制检查。
- **请求**：`GET /project/<slug>/version`。payload 新增 `versionUrl` 字段，由 `bundle.ts` 写入，与 `feedbackUrl` 同源。
- **发现新版本**：`snapshotId ≠ 页面中的 snapshot.snapshotId` 时，显示横幅「分享者已发布新版本」，并提供「刷新到新版本」按钮。页面是 `no-store` 的，刷新即可拿到新快照。
- **失败处理**：网络失败或返回 404 时静默；返回 410 时显示已失效。

### 11.2 草稿迁移与 rebase 入口

- **页面加载时**：扫描所有 `<pid>:draft2:*`，找出 `snapshotId ≠ 当前快照` 的草稿，显示「你在旧版本上有未提交的修改」，提供三个选择：
  - 「在新版本上继续」：需要编辑器资源，调用 `rebaseDraft`，详见 §12.7；
  - 「按旧版本提交」：草稿本身就有完整的 base，提交时 `snapshotId` 仍为旧值，主人侧按 V4 处理；
  - 「导出草稿」：现有能力。
- **编辑器资源不可用时**：只提供「按旧版本提交」和「导出」。
- **v1 草稿**（键为 `<pid>:<snapshotId>`）首次加载时转换为 DraftV2：
  - `base` 取当时页面里的快照，前提是 snapshotId 一致；
  - 不一致时，`base` 无法取得，只能「按旧版本提交」（v1 格式）或导出。

### 11.3 提交

- **有编辑器时**：由编辑器资源负责组包（§12.6），生成 v2，`client.kind = "browser"`。
- **textarea 兜底时**：内联脚本自行组包。
  - 生成 v2，`client.kind = "browser-fallback"`；
  - 批注来自现有表单，`selector` 用内联实现的 `exact` 加 `start/end` 加前后各 32 字计算（不需要内核）；
  - `afterMarkdown` 取 textarea 的值，EOL 对齐交给主人侧的 `alignEol`。
- **冻结与幂等**：沿用现有逻辑，即把 `pending.body` 先存入 DraftV2 再投递，重试时逐字节重放。
- **成功后**：把 `submissionId` 记入 `<pid>:submitted` 和 `lastSubmissionId`，清除 `previous`。

### 11.4 回执展示

页面加载时，对 `<pid>:submitted` 中最近的 20 个 ID 逐个执行 `GET receipt`，并发数 ≤ 4。结果显示在「我的提交」面板中，状态包括：

- 「已合入 3/5 处」；
- 「已转入团队评审」；
- 「未采纳」；
- 「已被你的新提交取代」；
- 「已送达，待处理」（对应 404）；
- 以及分享者的回复（**按纯文本渲染**）。

---

## 12. 分享页编辑器（E1–E3）

### 12.1 目标

协作者在分享页上用到的，是与桌面 note.md 同一份代码的编辑器：

- 富文本与源码可切换；
- 斜杠菜单、快捷键、表格、公式、代码块；
- 中文输入法稳定；
- 与桌面相同的「选文 → 批注」手势。

只读链接永远不加载编辑器代码。

本节修订上游的两处取舍：

- `project-document-sharing-design.md` §5「首版用 textarea」；
- `free-upload-design.md` §4「不增加外置资源」。只有编辑器例外，阅读页仍然自包含。

### 12.2 构建与交付

- **构建**：以 `src/share-editor/main.ts` 为独立 Vite IIFE 构建入口，不能直接塞入现有多 entry 应用构建；应用构建读取并打包下面已冻结的同字节资源。
  - 输出格式为 **IIFE 单文件**：禁用代码分割，内联所有动态 import，CSS 单独输出一个文件。
  - 文件名为 `share-editor.<sha256>.js` 和 `share-editor.<sha256>.css`，其中 sha256 是**文件内容**的十六进制摘要。
  - 产出清单 `dist/share-editor-manifest.json`：`{ js: {name, sha256, sri}, css: {name, sha256, sri}, apiVersion: 1 }`，其中 `sri = "sha384-<base64>"`。
  - 宿主通过 `import manifest from '…/share-editor-manifest.json'` 拿到资源名。产物作为 app 静态资源打包，发布时由宿主读取字节上传。
- **构建检查**：扩展 `scripts/check-editor-kit-build.mjs`，或新增 `scripts/check-share-editor-build.mjs` 并挂进 `pnpm build`。检查项：
  1. 产物依赖图中不含 `@tauri-apps`；
  2. 文件名中的 hash 等于实际内容的 hash；
  3. 不含 `import(` 动态加载；
  4. 体积预算为 gzip 后 ≤ 900 KiB，超出时失败，要提高预算必须修改本 spec。
- **Mermaid**：作为第二个可选资源 `share-editor-mermaid.<sha256>.js`，沿用同源、内容 hash、SRI 和资源上限，manifest 可选记录 `mermaid: {name, sha256, sri}`。它属于 E3，仅编辑中的非空 mermaid 块需要预览时才加载，普通文本与只读页面不请求；主 IIFE 不含默认 Mermaid renderer 或库副本，独立资源体积另记，不藏入主包预算。显式 loader 与 SDK 默认行为迁移见 §21。
- **Worker 端 `/_kit/<name>`**：
  - name 必须匹配 `^share-editor(-mermaid)?\.[a-f0-9]{64}\.(js|css)$`；
  - PUT 请求体 ≤ 8 MiB，服务端重新计算 sha256 并与文件名比对，不符返回 400；对象已存在且内容相同返回 200，否则写入后返回 201；
  - GET 和 HEAD 返回对象，带 `Cache-Control: public, max-age=31536000, immutable`、正确的 `Content-Type` 和 `X-Content-Type-Options: nosniff`；
  - R2 键为 `kit/<name>`；
  - 这些对象不会被清理（数量与应用版本数相当）。
- **发布流程**（`host.ts` 中的 `publishProject`）：在上传 entry 之前，对 js 和 css 分别执行 HEAD 检查，返回 404 时 PUT。上传失败**不得**阻塞发布，页面里不写入 `editorKit`，访客端会自动走 textarea 兜底，并且发布结果中带上一条 warning。
- **页面 payload** 新增两个字段：
  - `editorKit?: { js: {url, integrity}, css: {url, integrity}, mermaid?: {url, integrity}, apiVersion: 1 }`；同一次发布尝试冻结同一个 descriptor，包括资源失败时的缺省结果，重试不得换成较新的 kit。
  - `versionUrl`
- **CSP**（修改 `bundle.ts` 中的 meta），只在存在 `editorKit` 时追加内容：
  - `script-src 'nonce-N' <js 的完整 URL>`；存在可选 Mermaid descriptor 时，仅再列出其完整同源 URL。
  - `style-src 'unsafe-inline' <css 的完整 URL>`

  其余指令保持不变。**不得**使用 `'strict-dynamic'`、通配路径、`'unsafe-eval'`。如果编辑器需要 `font-src`、`worker-src` 或 `wasm-unsafe-eval`，必须先修改本 spec。
- **加载方式**：内联脚本在用户点击「编辑」时插入 `<link rel=stylesheet integrity>` 和 `<script src integrity>`（经典脚本，不用 module）。脚本执行后注册 `globalThis.NotemdShareEditor = { apiVersion: 1, mount }`。下面任一情况都**降级到 textarea**，并提示「增强编辑器不可用，已切换到基础编辑」：
  - 加载超时（15 秒）；
  - SRI 校验失败（触发 `error` 事件）；
  - `apiVersion` 不符。

### 12.3 宿主与编辑器的接口契约（`apiVersion = 1`）

```ts
type RebaseUiResult = { status: 'applied'; draft: DraftV2 } | { status: 'cancelled' }
type ShareMermaidAppearance = {
  theme: 'default' | 'dark'
  themeVariables: {
    primaryColor: string; primaryTextColor: string; primaryBorderColor: string
    lineColor: string; secondaryColor: string; tertiaryColor: string
  }
}
interface ShareEditorHost {                // 由内联脚本实现
  apiVersion: 1
  snapshot: { project_id: string; snapshotId: string; entry: string
              files: { path: string; hash: string; markdown?: string; dataUrl?: string }[] }
  theme: { themeId: string; cssVars?: Record<string, string> }
  loadDraft(): Promise<DraftV2 | null>      // 同 realm、固定 lineage 的共享 live aggregate
  saveDraft(live: DraftV2): Promise<Readonly<DraftV2>>
  loadAnnotations?(): Promise<readonly ProjectAnnotationV2[]>
  transitionDraft?(expected: DraftV2, next: DraftV2, notes?: { expectedAnnotations: readonly ProjectAnnotationV2[]; annotations: readonly ProjectAnnotationV2[] }): Promise<Readonly<DraftV2>> // 返回本次实际 atomic 写入的 detached clone
  submit(body: string, submissionId: string): Promise<{ ok: true } | { ok: false; status: number; message: string }>
  openFile(path: string): void              // 文件树导航仍由宿主负责
  notify(text: string): void
  setFileBadges?(rows: readonly { path: string; changed: boolean; annotations: number }[]): void
  loadMermaid?(): Promise<{ render(code: string, appearance: ShareMermaidAppearance): Promise<string> }>
}
interface ShareEditorModule {
  apiVersion: 1
  mount(container: HTMLElement, host: ShareEditorHost, opts: { path: string }): Promise<ShareEditorHandle>
}
interface ShareEditorHandle {
  switchFile(path: string): Promise<void>
  buildSubmission(input: { message?: string; name?: string; aiAssisted?: boolean }):
    Promise<{ body: string; submissionId: string; summary: { files: number; blocks: number; annotations: number } }>
  rebase(newSnapshot: ShareEditorHost['snapshot'], draft: DraftV2): Promise<RebaseUiResult>
  destroy(): Promise<void>
}
```

这是最终 API v1 合同，不表示 E1–E4 已实现。E1 实施阶段使用 `ShareEditorHandleE1 = Omit<ShareEditorHandle, 'rebase'>`，不提供空 rebase 方法；E3 实际完成后才返回完整 Handle 并冻结最终 API。

`loadDraft` 共享固定 lineage 的同一 live aggregate，编辑器只更新 `after`、`editorFiles` 和 `annotationKinds`；`pending`、`previous`、`lastSubmissionId` 和送达确认由宿主唯一编排。`saveDraft` 进入现有同 lineage 的 atomic FIFO，在实际执行槽 clone 捕获的 live 对象及同身份 notes，原子写入成功后返回此次实际 durable detached clone；不得把调用时冻结的旧整 draft 排队覆盖较新的 pending 或正文。送达的 atomic 写与内存 `markDelivered` 完成共同占有队列槽，不能在二者之间插入旧保存。队列捕获固定 lineage 对象，不能执行时改读页面当前草稿。

单文件保存复用已受理 `createShareFileSession`：同步捕获实际内部 baseline identity 与一致 snapshot，返回的 raw/recovery 精确匹配且基线实例未换代时才 ACK；observer 仅作信号并重读当前一致组合。同基线 B 保存/C 续写只 ACK B，换基线后忽略旧 ACK；内部 identity 不导出或持久化到公共 API。切文件与关闭先 flush 并取得实际 durable 回执，关闭期间按既有 owner 合同阻止续写；失败保留 owner、草稿和 history 并恢复先前 readonly，不猜测保存成功。

`setFileBadges` 只传派生 UI 状态，不存第二份草稿。`loadMermaid` 由内联宿主持有冻结的同源 descriptor 并以 SRI 加载；返回模块的 `render` 接 code 与 appearance。六项颜色从实际编辑根取得，明暗由明确页面设置或系统偏好取得，`themeId` 不作为明暗枚举；安全 strict 参数与 SVG 净化不可由 caller 覆盖。

### 12.4 字节保持（硬约束 I7）

做法：消费共享 source fidelity 与唯一 file owner，以及已逐 Task 受理的 bindings/history 实现；最终 committed 源码、dist、installed 与真实 consumer 证据见上方前置冻结身份与阶段报告。E1 实际 IIFE 仍独立验收，不能以本节描述代替验收。

1. 以快照原文创建共享 `FileInput`，完整 raw 是唯一 authority。成功 parser capture 产生源码事实与自然 roots；稳定 bindings 仅承载业务身份，synthetic/gaps 不伪造业务块，业务 ID、JSON 或 metadata 不授予源码写权限。
2. Rich 通过同一 file controller 消费真实原 Step/docs 有序链，沿成功捕获的事实与局部 producer 生成 raw edits；未触碰切片保持原字节。安装前完成 protected 检查及最终完整严格 `doc.eq`，raw/doc/bindings/layout 一致才安装；不全文件重序列化、不重写目标 PM doc 迎合候选，也不在失败后绕过许可。`afterMarkdown` 直接取 owner 的完整 raw。
3. Source 与 Rich 共用同一存活 PM owner 和原生 history。textarea 的 LF display 与原 raw 分离，经 UTF16/CRLF 安全的离散差分恢复实际 raw edits，再由同一 F1/source 准入与语义事务安装；切模式不另建正文 authority 或撤销栈。不能假定浏览器文本输入天然保留 BOM/EOL，也不能只解析所谓“变化块”跳过完整候选一致性验证。

**验收语料**放在 `src/share-editor/__fixtures__/corpus/`，至少覆盖：

- 表格（含对齐）
- 脚注
- frontmatter
- HTML 块
- CriticMarkup（两种形式）
- 行内与块级数学
- mermaid
- 嵌套列表（`*`、`-`、`+` 混用）
- 引用
- 长中文段落
- CRLF 文件
- BOM 文件
- 无末尾换行的文件

**判据**：

- 打开文档，富文本与源码来回切换 3 次，不做任何修改，生成的 `afterMarkdown` 必须与原文**零 diff**；
- 只改一个段落中的一个字，内核 `propose(base, base, after)` 必须恰好产生 1 个 hunk，且只覆盖该句。

**如果 Kit v2 做不到**：E1 阻塞，不得改用「事后过滤格式差异」的方式绕过。这种情况要回报，交由人来决定。

### 12.5 批注的两层存储与抽取（`extractGuestAnnotations`）

**编辑器中的表现**：访客在编辑器里的批注与桌面一致，是 annotation mark，序列化为 CriticMarkup。分享者的批注同样以 CriticMarkup 存在于快照中。

**抽取算法**（内核实现，浏览器与桌面访客客户端共用）：

1. 在 base 和 draft 中，用同一套语法分别找出全部批注片段，记录其原始字符串：
   - 带选文的批注：`{==X==}` 紧跟 `{>>C<<}`；
   - 点批注：单独的 `{>>C<<}`。

   不识别 `{++ ++}`、`{-- --}`、`{~~ ~~}`，它们按普通文本处理。
2. **区分归属**：base 中所有片段的原始字符串构成一个多重集 O（分享者批注）。按 draft 中片段的出现顺序逐个检查：原始字符串能在 O 中消耗掉一份的，归为分享者批注；否则归为访客批注。
3. **生成干净文本**：从 draft 中移除访客批注。带选文的批注替换为 `X`，点批注整个删除。同时维护位置映射，用于下一步计算坐标。
4. **生成 selector**：每条访客批注产出 `{path, selector: makeSelector(clean, s, e), comment: C, kind}`。坐标系是干净文本。点批注的 `exact` 为 `""`，`start == end`。
5. O 中没有被消耗完的条目（分享者批注被删除或改动）记入 `ownerAnnotationsTouched`。
6. 返回 `{ clean, annotations, ownerAnnotationsTouched }`。如果 `clean` 与 base 相同，该文件不进入 `edits`。

**编辑器保护**：浏览器在每个基线挂载时，按同一原始 CriticMarkup 片段分别统计完整 base 与初始 draft 的多重集，并冻结 `floor(raw) = min(baseCount(raw), initialCount(raw))`。共享 controller 先验证完整 root+appendTransaction 及 history 有序 delta 的源码许可，只对安装前 raw 与最终候选 raw 执行一次纯 policy veto；最终任一种片段计数低于 floor 时，raw/doc/bindings/layout/generation 和 observer 全不安装、不发布。不得对 history 中临时移除后恢复的中间 delta 提前检查 floor；policy 通过也不能绕过 capture/protected/严格 `doc.eq`。

允许复制后删除任意一个同文 occurrence，只要最低计数保持；这不是逐节点 `origin: owner` 身份保护。初始旧稿已改删分享者批注时只提示 `ownerAnnotationsTouched`，不强制修复原文；恢复后 undo 仍可回到初始 floor。普通 Source、restore、paste/drop、Rich 和原生 undo/redo 共用该最终边界，不重冻 floor。rebase/撤销 rebase 必须以目标 snapshot+目标 draft 显式准备新 policy，成功切换基线才重冻，不能省略 policy 沿用旧 floor；公开 URL、草稿和 ShareEditor API 不得关闭保护。桌面访客允许编辑分享者批注，但提交前必须明确提醒并由用户继续（§13.3）。主人侧在 `propose` 时仍会再校验一次，触及 base 中批注片段的 hunk 都会打上 `owner-annotation` 标记。

**kind**：从 `DraftV2.annotationKinds` 中查得；查不到时为 `comment`。

**测试**：

- 基本抽取：一条访客批注加一条分享者批注，只抽出访客那条，干净文本保留分享者批注。
- 同文重复：访客复制了一条与分享者批注一模一样的批注，按多重集只消耗一份，多出的那份算访客批注。
- 点批注：坐标正确。
- 删除分享者批注：会被报告。
- 嵌套或残缺语法：当作文本，不崩溃。

### 12.6 组包（`buildSubmission`）与用户提交

浏览器与桌面调用同一纯 TS 组包函数。`ShareEditorHandle.buildSubmission` 只 flush 实际文件 owner、捕获一致 draft 并返回 `{body, submissionId, summary}`；不冻结 pending、不调用 `host.submit`、不 POST、不更新送达记录。flush 可触发普通草稿保存，但预览或调用 build API 本身没有提交副作用；flush 失败不产包。

对每个有草稿的文件，执行以下步骤：

1. 调用 `extractGuestAnnotations({base, draft})`；
2. 当 `clean ≠ base` 时，生成 `edits[{path, baseHash, afterMarkdown: clean}]`；
3. 合并所有批注。

v2 中的 `supersedes = lastSubmissionId`，`rebasedFrom` 取 DraftV2 中的值。`message` 和 `contributor` 来自提交面板。纯 builder 不读取时钟、随机数或网络；handle 为本次新 build 生成 submissionId 后传入，按确定性输入生成一次 JSON body。`ownerAnnotationsTouched` 只留本机提示，不进入建议包。

**唯一浏览器 submit 编排**是内联 `browser.ts` 的显式用户提交 handler，以单一 busy/lineage 锁去重。已有 pending 时直接重试原 id/body，跳过 build、新 id 和再次冻结；无 pending 才调用 build，核对 lineage/snapshot 未切换，在既有 atomic 队列中合并最新 live draft 并耐久写入不可变 pending，不以旧 build 快照覆盖后续 after。durable 成功才调用一次 `host.submit(body,id)`；后者仅验证参数与已耐久 pending 相同、强制版本检查并执行一次原有 POST，不重新组包/冻结/清除状态或另起发送。成功后的 submitted/lastSubmissionId、匹配 pending 与 previous 清除由原 handler 在同一既有送达流程确认；失败或本机确认失败保留 exact pending。飞行中续输入保留，flush/build 期间 lineage 切换则取消该次新包。fallback 也沿同一 handler，不增第二 POST 流程；无法抽取增强 Critic 草稿时保留原文并要求恢复 kit 或导出，不能漏抽取后冒充正确 v2。

桌面同样仅用户明确提交的 host 流程调用纯 builder→Rust queue 耐久一次→deliver 一次；重试直接发送已存 outbox 的原 body/id，不重新 build 或 queue。

### 12.7 rebase 界面（E3）

先抽取访客批注，对每个草稿文件调用唯一内核 `rebaseDraft({oldBase: draft.base[path].markdown, newBase: 新快照[path], draft: clean})`，随后重锚批注，不另写 diff3 或 Critic serializer。

- **结果干净**：准备新候选，尚未完成整次 rebase 前不替换当前 owner/base。
- **有冲突**：在编辑器中，用 `DecorationHost` 的 `proposal` 层标出冲突块，冲突逐个解决（三种选择见 §7.10），决定交给同一 `compose`。
- **文件已被移出新快照**：进入「无法迁移」列表，只能导出；未明确完成处理不静默丢弃旧 raw。
- **批注**：用 `anchor` 重新锚定到新文本上。`orphan` 的批注列出来，由访客手动处理；保留 kind 与对应 annotationKinds，不丢批注。
- **准入**：pending 存在时不得换 base；已有 previous 时先提交完成或撤销上次 rebase，不覆盖旧撤销点。取消返回 `{status:'cancelled'}` 并保留旧状态。
- **撤销点与耐久边界**：host 创建新的 aggregate 对象，previous 完整保存旧 snapshotId/base/after/annotationKinds/rebasedFrom；先完成 previous 与新草稿的耐久写入，再以目标 snapshot+目标 draft 显式 `installBaseline(input,{policy:newPolicy})`。不在前置 bindings Task4 已交付的单文件 `createShareFileSession` 上新增 rebase API。
- **显式宿主事务**：`transitionDraft` 与普通保存共用同一 FIFO，在执行槽核对当前 live 对象、lineage、公开范围和旁存批注 CAS；原子写入 aggregate 与目标旁存批注后才更新宿主引用。普通 `saveDraft` 不放宽身份守卫。`loadAnnotations` 读取的旧 fallback 批注和 Critic 访客批注一起调用同一 anchor、合法 Critic 回读校验与降序插入；无法放置的条目显式导出处理，完整原批注保存在 previous。
- **故障恢复**：首次写失败保留旧状态；安装失败后回写旧草稿及单层 rebaseRecovery 候选，重载后显式恢复。若回滚写也失败，耐久状态仍是 next+previous，重载后可撤销到 old，不能声称 old 已耐久保存。恢复快照只含公开数据，必须匹配当前 project/sid/path/hash 范围，不授予权限、不自动提交；公开版本变化则保留候选供导出。候选禁止嵌套 recovery/pending。
- **基线切换**：成功构造目标 owner/controller 后才交换 aggregate、policy、authority 与 history，失败恢复旧 aggregate/base/owner/history，并保留可恢复候选。不能只依赖 authority 字符串或重置 generation 判断是否换代，沿 §12.3 内部基线实例隔离旧保存回执。
- **完成后**：新 aggregate 的 `snapshotId = 新快照`、`rebasedFrom = 旧快照`、`base = 新快照中对应文件`，返回 `{status:'applied',draft:新草稿}`。
- **撤销 rebase**：从 previous 恢复旧 raw/base/snapshot 及可选元数据，并以该目标 snapshot+draft 显式重建 floor/policy；不得继承新基线 floor。previous 只在成功提交的本机确认后清除，重新加载仍可恢复未完成事务。

这部分由 E3 首次实现和验收，既有单文件保存适配不等于多文件 rebase 已交付。

### 12.8 「我的修改」与提交面板（E2）

- **「我的修改」开关**：打开后执行 `propose({base, ours: base, theirs: 当前干净文本})`，再用 `DecorationHost` 的 `proposal` 层标出每个 hunk。每个 hunk 带「撤销这处」，它的作用是把这个块恢复成 base 中对应的字节。**不做** track changes 那种逐键录制。
- **文件树徽标**：改过的文件显示圆点，带批注的文件显示批注数量，并提供「只看我改过的」筛选。
- **提交面板**：
  - 列出每个文件的改动块数和批注数；
  - 提供一句说明（`message`）、昵称（保存在本机）、「含 AI 生成内容」勾选框（默认不勾选）；
  - 提交后显示回执（§11.4）。

### 12.9 能力矩阵

| 能力 | 分享页 |
| --- | --- |
| 富文本与源码切换、块编辑、斜杠菜单、快捷键、撤销 | ✓（Kit 同源） |
| 中文、日文输入法 | ✓（复用 `createImeGuard`）。必须在 macOS Safari、Chrome、iOS Safari、Android Chrome 上验收 |
| KaTeX、代码高亮、主题 | ✓ |
| 项目内链接、Wikilink | ✓，只在已分享集合内跳转 |
| 图片显示 | ✓。新增 `bundleMediaResolver`，只解析 `snapshot.files[].dataUrl` 中已批准的资源 |
| Mermaid 实时渲染 | E3 |
| Graphviz | ✗，只显示代码 |
| 新增、粘贴图片或附件，新建、改名、删除文件 | ✗，提示「在批注中描述」 |
| 反向链接、全库搜索、AI、插件 | ✗ |

---

## 13. note.md 作为离线协作客户端（E4）

### 13.1 入口

- **注册 scheme**：在 `src-tauri/tauri.conf.json` 中加入 `plugins.deep-link.desktop.schemes: ["notemd"]`。macOS 的 Info.plist 由 Tauri 生成，需要核对产物。
- **深链路由**：`App.svelte` 的 `onOpenUrl` 新增对 `notemd://share/open?u=<encodeURIComponent(分享页完整 URL，含 #feedback=token)>` 的处理。
  - 解析 `u`，要求协议为 `https:`（开发构建仅允许 `http://localhost`、`http://127.0.0.1`、`http://[::1]`（可带端口，拒绝数字缩写地址别名））；
  - **不得**把 URL 或 token 写入日志、错误信息或遥测。
- **分享页按钮**：编辑模式下显示「在 note.md 中打开」，链接到上面的深链。
- **菜单入口**：「文件 → 打开分享链接…」，粘贴链接即可。
- **确认框**：开始任何网络请求或原生下载命令之前，先弹窗显示「从 <host> 下载分享项目「<title>」？」，让用户确认。没有可信标题时用「此分享项目」，不得预取页面补标题。纯链接解析支持原 URL 和 `notemd://share/open?u=...`，拒绝 userinfo 与查询参数；仅从 fragment 的 `feedback` 取 token，交给原生的 shareUrl 一律去 fragment，错误不回显输入。

### 13.2 下载与落盘（`share_guest.rs`）

1. **查询版本 V1**：`GET <origin>/project/<slug>/version`，失败时中止，必须为公开 schemaVersion 1 且 `archiveReady = true`。公开下载不需要协作 token，不把 token 带入 reader 或 ZIP 请求。
2. **取得外部清单并下载候选**：依次读取已发布 reader（`GET <origin>/<slug>`）、source-only ZIP（`GET <origin>/project/<slug>/download`），再查询版本 V2。V1/V2 的 schemaVersion、project_id、snapshotId 必须一致且都 archiveReady，reader 的公开 snapshot 身份也必须一致；变化或任一失败时丢弃候选，不落盘、不切基线，保留已有工作文件并提示重新检查，不无限重试。reader 最多 25 MiB，ZIP 最多 32 MiB，流式逐字节计数，不信任 Content-Length；关闭重定向，不隐式改变确认过的 host。
   - reader 只以小型确定性 HTML 标签扫描器提取真实 script raw-text 边界内唯一 `id=project-data`、`type=application/json`。跳过注释、按引号解析属性，属性名 ASCII 大小写不敏感；重复属性或第二个同 id（不论 type）拒绝。不得用任意 regex 搜索假 payload，不执行 HTML/脚本，不用 WebView/DOM 执行器。
   - JSON 所有对象重复键拒绝；只从顶层 snapshot 读取公开 schemaVersion 1 白名单，忽略 presentation，不接受 sourceRoot/git/本机身份授权。保留 JSON 正常转义解码语义，hash 取解码后原正文 UTF-8 字节，不能隐式去 BOM。投影外部校验清单：files 为 1..512、清单不超过 256 KiB、源文件总和与单项都不超过 25 MiB；严格验证 ID/hash/entry/path、每项 bytes 与正文/资源的一致性。不新增 Worker manifest artifact、接口或路由。
3. **校验 ZIP**：使用上述同快照外部清单完整验证，current source-only ZIP 不含 reader 或内部 manifest：
   - 清单内源文件必须齐全，逐项实际解压 bytes/hash 相符；累计源解压不超过 25 MiB，逐项计数防止解压炸弹。
   - 路径沿现有 `validate_relative` 校验；UTF-8 路径不超过 1024 B，不得有反斜杠、冒号、控制符、空段、点段、绝对路径、`.notemd` 或大小写折叠重名。既有 `.note.md/.notes.md`、隐藏段、node_modules、凭据命名拒绝规则保持；恶意源直接拒绝，不改名规避。
   - 只接受 stored/deflate 的 regular file；拒绝 symlink/hardlink/device、加密、多磁盘、重复路径、目录外记录、重叠或未列本地头、central/local 头冲突与 CRC 错误。不得有清单外源文件。
   - 兼容 legacy 包时只额外允许既定 `.__notemd-<snapshotId>/manifest.json` 与 `.__notemd-<snapshotId>/reader.html` 两个内部元数据条目，并与外部 snapshot 核对；内部 manifest 最多 256 KiB、reader 额外最多 25 MiB。它们只验证，绝不执行或写入 received 项目；其它管理条目拒绝。原 source ZIP 不因缺内部 manifest 被拒绝。
4. **确定落盘位置**：`Vault/received/<host>/<project_id>/`。`<host>` 取小写主机名，端口用 `_` 连接，例如 `share.example_8787`；开发 IPv6 回环目录名以 `_` 代替冒号（`[__1]_8787`），与 URL origin 分别保存。如果该目录已经存在：
   - 只有其中 `.notemd/guest.json` 通过 schema、受管 root、origin 与 project_id 校验时才可信；相同 snapshot 返回既有项目，不覆盖本地编辑，不同 snapshot 返回 `GUEST_UPDATE_REQUIRED` 供 §13.4 更新流程接管。
   - 不一致、空目录或只有用户文件：报错，不覆盖。
5. **写入文件**：
   - 普通文件写到项目目录；
   - 每个文件同时写一份到 `.notemd/base/<snapshotId>/<path>`；
   - 写入 `.notemd/guest.json`；
   - token 存入 `share_db.json`（§6.8）；
   - 所有文件写入都复用 `write_atomic`。全部网络/清单/ZIP/版本验证完成后才建立同目录受管临时目录，写齐源文件、base 和元数据后原子无覆盖 rename；检查每级目录的 symlink、文件类型及 canonical containment。失败保留已有项目。文件 write、sync_all、rename 错误在所有平台传播；目录同步复用共享 helper，Unix open+sync_all 错误传播，非 Unix 不尝试普通目录 File::open，保留原子可见性但不保证目录项掉电耐久性。
6. **保持隔离**：收到的项目是纯 `.md`，不是 `.note.md`，所以**不进入关系系统**（「关系只在人确认处生长」）。收到的项目**不得**被当作 sync 镜像或项目分享的源；`project_share::source_root/source_path/create` 和 Vault-root 引用读取都拒绝 received 及其 symlink 别名。GuestStore 同时拒绝 received 与用户配置 Sync 的父子重叠，不创建 sync mapping。

### 13.3 编辑与提交

- **编辑**：使用桌面编辑器的全部功能。批注就是桌面现有的批注。
- **提交入口**：项目侧栏的「提交修改」。
- **组包**：对每个文件执行 `extractGuestAnnotations({base: .notemd/base/<sid>/path, draft: 工作文件})`，然后按 §12.6 组装 v2 包，`client.kind = "notemd"`。
  - 工作文件里新增的文件（不在 `files` 中）会被忽略，并给出警告；
  - 被删除的文件也忽略并警告（协议不支持删除）。
- **离线与重试**：请求体先写入 `guest.json` 的 `outbox`，再发送。失败时保留在队列里，联网后或应用启动时，用逐字节相同的请求体重试。收到 409（`requestHash` 冲突）时，提示用户，并保留该请求体供导出。
- **分享者批注被改**：`ownerAnnotationsTouched` 非空时，提交前提示「你改动了分享者的批注 N 处，它们会被分享者单独审阅」，然后允许继续。

### 13.4 更新

- **检查新版本**：打开项目时，以及点击「检查更新」时，查询版本接口；`snapshotId` 变化即视为有新版本。
- **下载与校验**：下载新 ZIP 并校验，写入 `.notemd/base/<新sid>/`。
- **逐文件合并**：对每个文件执行 `propose({base: 旧 base, ours: 新快照, theirs: 工作文件})`，并「自动接受」所有 theirs-only（这是用户自己的改动）。
  - **无冲突**：`write_atomic` 写回工作文件。
  - **有冲突**：不写入。该文件记入 `pendingUpdate.unresolved`，用同一个 `HunkView` 或 `ConflictEditor` 组件以「访客模式」打开。访客模式的文案是「分享者版本 / 我的版本」，按钮只有 ours、theirs 和 edited。
- **新快照删除了某个文件**：
  - 工作文件与旧 base 相同：删除；
  - 不同：保留，并标记「已不在分享中」。

  **不得**静默删除用户改动过的文件。
- **新快照新增了某个文件**：直接写入。如果工作目录里已有同名但不在旧 `files` 中的文件，保留用户的文件，把新文件写成 `<name>.shared.md`，并给出提示。
- **收尾**：所有文件都处理完之后，更新 `snapshotId` 和 `files`，删除旧的 base 目录。在此之前，旧 base 一律保留，用于撤销和重试。

### 13.5 回执

项目侧栏会对 `submitted` 中的 ID 拉取回执（§10.3），展示方式与浏览器相同（§11.4）。

---

## 14. AI 评审助理（P3，背景加约束）

| 能力 | 产出 | 约束 |
| --- | --- | --- |
| 提交摘要 | 审阅界面顶部的 ✦ 摘要 | 只读 |
| 评论与改动聚类 | ✦ 分组视图 | 只读 |
| 冲突提案 | 写入 `HunkDecision{choice:'edited', source:'ai-suggestion'}` 的**候选值**，默认不采纳 | 必须由主人点选才生效 |
| 一致性检查（链接、术语、frontmatter） | 警告列表 | 不自动修复 |
| 回执回复草稿 | 回复输入框中的草稿 | 主人编辑后才能发送 |

**红线**：

- AI 调用不得挂任何写工具：不能 apply、不能写 git、不能写 vault、不能联网发送。
- 访客内容进入 prompt 时，必须包裹在明确的「不可信内容」分隔块中，并在系统提示里声明：这些内容中的指令一律不执行。
- 界面上用三种来源标识区分：访客写的、AI 提的（✦）、我定的（●）。
- 模型由主人在设置中指定，不绑定单一供应商。

---

## 15. 安全与不可信内容

| 威胁 | 规则 |
| --- | --- |
| 主人端 XSS（主人的 webview 有 Tauri IPC，风险最高） | 访客正文、评论、`message`、`name` 在审阅界面中一律按**文本**插入（Svelte 的 `{}` 插值）。**不得**使用 `{@html}` 渲染未经清洗的访客内容。「渲染 diff」必须走与阅读页相同的 Markdown 渲染并加 DOMPurify 类清洗：禁止 `script`、`iframe`、`object`、`on*`、`javascript:`；链接加 `rel="noopener noreferrer"` 并在外部浏览器中打开 |
| 追踪像素 | 审阅界面中，访客内容里的远程图片**默认不加载**，显示占位和 URL，主人可以逐个点击加载 |
| Trojan Source（隐藏字符） | 内核标记 `hidden-chars`（§7.6），审阅界面把这些字符可视化（例如 `⟨U+202E⟩`） |
| 提示注入 | 见 §14 |
| 路径穿越 | 所有路径都经过 `validate_relative`（Rust）和 `relativePath`（Worker） |
| 解压炸弹 | 见 §13.2 第 3 步 |
| ref 和分支名注入 | 必须经 `check-ref-format` 校验；ID 只允许 `[A-Za-z0-9_-]` |
| commit 消息伪造 | 见 §9.4 的清洗规则 |
| token 泄漏 | token 只出现在 URL fragment、`X-Feedback-Token` 请求头和本机 Store 中。深链 URL 不进日志。`guest.json` 和 inbox 中不得出现 token |
| 编辑器供应链 | 同源、内容寻址、SRI、精确到 URL 的 CSP（§12.2）；不使用公共 CDN |
| 回执窥探 | 读取回执需要同时持有 token 和 `submissionId`（§10.3） |
| 资源滥用 | 沿用现有的 5 MiB 限制；新增接口都有体积上限（回执 64 KiB，kit 8 MiB） |

---

## 16. 兼容性

| 对象 | 规则 |
| --- | --- |
| v1 建议包 | Worker 和 Rust **永久接受**。主人端把 `name` 映射为 `contributor.name`，`annotations[].{quote,start,end}` 转为 `selector{exact,start,end}` |
| Rust 中 payload 的表示 | 改为 `enum ProjectFeedbackPayload { V1(ProjectFeedbackV1), V2(ProjectFeedbackV2) }`，用 `#[serde(untagged)]` 或按 `schemaVersion` 手动分派（推荐后者，错误信息更清楚），再提供统一的访问方法：`edits()`、`annotations_normalized()`、`contributor_name()` 等。已经落盘的 inbox JSON 必须仍然可读 |
| 快照 manifest | v1 和 v2 都可读；新快照写 v2 |
| inbox `LocalFeedback` | 新字段都有 `serde(default)`；旧记录可读，状态语义不变 |
| 已发出的旧分享页 | 没有 `editorKit` 和 `versionUrl`，行为与现在完全相同（textarea 加 v1）。Worker 保持兼容 |
| 已发出的新分享页 | 页面钉死了自己的 kit hash；以后的应用版本不会删除旧的 `/_kit/` 对象，所以旧链接永远可用 |
| Worker `ProjectState` | 不改 schema（版本号接口只读 `active`） |
| IndexedDB | 不升级 DB 版本，只新增键（§6.7） |
| 合并内核版本 | `ReviewDraft.kernel_version` 不一致时，作废审阅草稿，界面提示「审阅规则已更新，请重新确认 N 处决定」 |

---

## 17. 工作包（按顺序；每包一个或多个 PR）

> 每个包的完成判据：列出的测试全部通过；`pnpm test`、`cargo test`（在 `src-tauri/` 下）、`cd worker && pnpm test`、`pnpm build`（含构建检查）全部通过；两份 CHANGELOG 的「未发布」区已写好条目（§19）。

### P0 本机合并审阅（不改协议、不改 Worker）

**WP0.1 合并内核**

- **依赖**：无。
- **文件**：`src/lib/share-merge/{index,tokenize,diff,diff3,proposal,compose,frontmatter,anchor,critic,eol,flags}.ts`，以及各自的 `*.test.ts`；`scripts/check-share-merge-purity.mjs`，并挂进 `package.json` 的 build 前置步骤。
- **契约**：§7。
- **测试**：K1–K18（§7.11）；纯净性脚本对一个故意违规的样例必须失败（脚本自测）。

**WP0.2 Rust 审阅持久化**

- **依赖**：无，可与 WP0.1 并行。
- **文件**：`src-tauri/src/project_share.rs`。
- **内容**：§6.2 的 manifest v2（`parentSnapshotId`、`createdAt`）；§6.4 的结构扩展；§8.1 中的 `review-save`、`annotation-decide`，`apply` 的放宽与 `summary`，`reject` 的 `reason`。
- **测试**（`#[cfg(test)]`，命名前缀为 `project_share_review_`）：
  1. manifest v2 写入 parent，v1 manifest 仍然可读；
  2. `review-save` 往返一致，超过 1 MiB 报错；
  3. 只含批注的文件可以执行 `apply`（提升）；
  4. `apply` 成功后清掉 `review[path]`；
  5. 已有 inbox 夹具（旧格式）可读；
  6. `reject(reason)` 落盘。

**WP0.3 审阅界面**

- **依赖**：WP0.1、WP0.2。
- **文件**：`src/components/project-review/*`、`src/lib/project-share/review.svelte.ts`、`src/lib/project-share/host.ts`（新增 op 封装）、`ProjectShareDialog.svelte`（替换审阅区）。
- **内容**：§8.2–§8.4、§15 中的 XSS、追踪像素和隐藏字符规则。
- **测试**（vitest 加 @testing-library/svelte，按仓库现有方式）：
  - **R1**：决定能持久化，重开后恢复；
  - **R2**：「接受全部」排除带风险标记的 hunk；
  - **R3**：两份提交改同一文件，写回第一份后，第二份提案被重算；
  - **R4**：V4（基于更旧的快照）；
  - **R5**：`apply` 返回 source changed 时刷新提案而不重试写入；
  - **R6**：V6 文件不在分享中；
  - **R7**：访客内容里的 `<img src=x onerror>` 和 `<script>` 不执行（DOM 断言）；
  - **R8**：远程图片不发请求；
  - **R9**：提升后的批注文本格式正确，并经过 `sanitizeNote`；
  - **R10**：存在未决冲突时，写回按钮不可用。

### P1 git 模式

**WP1.1 git 代理**

- **依赖**：WP0.2、WP0.3。
- **文件**：`src-tauri/src/vault_sync/git_ops.rs`（新增 `run_git_io`）、`src-tauri/src/project_share_git.rs`、`project_share.rs`（`snapshot`、`feedback` 的二阶段钩子，`git-branched` op，`delete` 清理 ref，`Config.git_target`）、`src-tauri/src/lib.rs`（注册 `project_share_git` 命令）。
- **契约**：§9。
- **测试**（用 `tempfile` 加真实 `git` 的集成测试；当 `git_ops::version()` 为 None 时跳过并打印说明）：
  - **G1**：冻结和导入前后，工作区、`.git/index` 字节、`HEAD`、本地配置都不变（I10）；
  - **G2**：snapshot commit 的 parent 是 HEAD，包含未提交的改动；
  - **G3**：submission commit 的 author 是访客、committer 是主人，trailer 完整，伪造的 trailer 被加上 `> ` 前缀；
  - **G4**：B 分支以 HEAD 为 parent，且 snapshot commit 不是它的祖先（I9）；
  - **G5**：B 在 HEAD 有冲突时中止，不建分支；
  - **G6**：分支重名时依次追加 `-2`；
  - **G7**：子目录项目的 `prefix` 映射正确；
  - **G8**：非 git、bare、unborn 仓库降级为 P0，行为完全一致；
  - **G9**：删除项目时清理 `refs/notemd/share/<pid>/**`，不碰 `refs/heads/notemd/*`；
  - **G10**：C 导出的补丁可以用 `git am` 应用到 HEAD 上；
  - **G11**：带 `autocrlf` 或 `.gitattributes eol` 的仓库中，blob 与 `git add` 产生的结果一致。

**WP1.2 git 界面**

- **依赖**：WP1.1。
- **内容**：`GitTargetBar.svelte`；默认目标规则（§9.1）；A 的「复制提交信息」；B 的结果展示和可复制的 push 命令；C 的保存对话框。
- **测试**：默认值随 remote 的有无而变化；切换目标后按项目记住。

### P2 协议 v2、Worker 与浏览器访客端（不含新编辑器）

**WP2.1 共享夹具与 v2 校验**

- **依赖**：WP0.2。
- **文件**：`src-tauri/tests/fixtures/project-feedback/{valid,invalid}/*.json`（每条规则至少 1 个 invalid 样例，命名为 `<规则>.json`）；`worker/src/feedback.ts`；`project_share.rs` 中的 `validate_feedback` 和 payload enum。
- **测试**：Worker 与 Rust 遍历同一组夹具；v1 回归测试全部通过；Rust 的语义规则（selector 长度与 exact 一致、`supersedes ≠ submissionId` 等）各有专门测试。

**WP2.2 版本号与回执（Worker）**

- **依赖**：WP2.1。
- **文件**：`worker/src/project.ts`（version）、`worker/src/receipt.ts`、`worker/src/index.ts`（路由）、`worker/tests/{project,receipt}.test.ts`。
- **测试**：
  - version 在 active、失效、非项目三种情况下的返回；
  - 回执 PUT、GET、DELETE 的鉴权矩阵（Bearer 与 token 互不通用）；
  - 回执存储前缀不影响 `listFeedback`；
  - 未知键返回 400；
  - 超过 64 KiB 返回 413；
  - 对应 feedback 不存在时返回 404。

**WP2.3 主人侧回执与 supersedes**

- **依赖**：WP2.2、WP0.3。
- **内容**：§8.5；`superseded_by` 的计算与折叠显示；在 `published` 之后补写 `includedInSnapshotId`。
- **测试**：
  - 整份决定完成后自动发送；
  - 状态为 suppressed 时不发送；
  - 发送失败后在下一次拉取时重试；
  - outcome 推导覆盖全部分支（§6.5）；
  - 回执 JSON 中不含任何正文字段（对序列化结果做断言）。

**WP2.4 浏览器内联脚本**

- **依赖**：WP2.2。
- **文件**：`browser.ts`、`bundle.ts`（`versionUrl`，以及 `editorKit` 为空时的 CSP 不变）。
- **内容**：§11（版本检查、DraftV2 与 v1 迁移、按旧版本提交、textarea 兜底生成 v2、回执展示）。
- **测试**：
  - 用 vitest 加 fake-indexeddb 测草稿迁移和幂等重放；
  - 新增 `scripts/check-project-share-browser.mjs`（Playwright Chromium，参照 `check-cdr-browser.mjs` 的写法），用本地 wrangler dev 或 mock 服务覆盖：新版本横幅出现；旧草稿可以按旧版本提交；回执能显示。

### E1 同一编辑器

**WP-E1**

- **依赖**：WP0.1、WP2.4。
- **文件**：`src/share-editor/*`、`vite.config.ts`（新 entry，IIFE 输出）、`scripts/check-share-editor-build.mjs`、`worker/src/kit.ts` 及路由、`host.ts`（kit 上传）、`bundle.ts`（payload 与 CSP）、`browser.ts`（加载与降级）。
- **内容**：§12.2–§12.6、§12.9。
- **测试**：
  - 语料零 diff（§12.4，vitest 加 jsdom；如果 Kit 依赖真实布局，就放到 Playwright 中跑）；
  - Playwright 场景：
    - 只读链接的网络日志中没有 `/_kit/` 请求；
    - 篡改 kit 内容后 SRI 校验失败，降级到 textarea，页面仍可提交；
    - 断网点击编辑，同样降级；
    - 页面中注入的内联 `<script>` 被 CSP 拦截（通过 `securitypolicyviolation` 事件断言）；
    - 分享者批注无法删除；
    - 提交出的包中 `afterMarkdown` 不含访客批注，`annotations` 的 selector 能被 `anchor` 精确命中。
  - Worker 的 `/_kit` 测试：hash 不符返回 400；GET 带 immutable 头；name 正则。
  - 输入法验收需要人工完成，以清单形式附在 PR 中：macOS Safari、Chrome，iOS Safari，Android Chrome；中文拼音、日文假名；在表格单元格和列表项中各测一次。

### E2 可见与可控

**WP-E2**

- **依赖**：WP-E1。
- **内容**：§12.8（「我的修改」、逐处撤销、文件树徽标、提交面板、回执）；分享者批注只读保护的端到端测试。
- **测试**：撤销某一处之后，提交内容与「只改其余几处」逐字节相同；伪造的分享者批注改动在主人侧带 `owner-annotation` 标记（联调 WP0.3）。

### E3 增强

**WP-E3**

- **依赖**：WP-E2。
- **内容**：§12.7 的 rebase 界面；Mermaid 懒加载资源。
- **测试**：rebase 干净、冲突、文件被删除、批注 orphan 四种情况；撤销 rebase；Mermaid 资源只在存在 mermaid 块时请求。

### E4 note.md 访客客户端

**WP-E4**

- **依赖**：WP0.1、WP2.2（版本号与回执）。
- **文件**：`src-tauri/src/share_guest.rs`、`tauri.conf.json`（scheme）、`App.svelte`（深链路由）、`src/lib/share-guest/*`、侧栏组件、菜单项，以及 `project_share.rs` 中 `create` 拒绝 `received/` 下的源。
- **内容**：§13。
- **测试**：
  - Rust：ZIP 校验（清单外文件、路径穿越、大小写重名、hash 不符、解压炸弹）；目录冲突；token 不出现在任何 vault 文件中（对写出的全部文件 grep）；发件箱用逐字节相同的请求体重放；
  - 内核联调：断网编辑和批注，联网后提交，得到的包与浏览器端在同一输入下**结构一致**（除 `client` 和 `submissionId` 之外逐字段相等）；
  - 更新：无冲突时自动合并，有冲突时不写文件；被删除的文件如果改过就保留；新增文件同名时另存为 `.shared.md`。

### P3 AI 与扩展（不在本轮实现范围内，列出以免误做）

- §14 的 AI 能力。
- `proposedFiles`（新增文件建议，放入隔离区）：需要另写一份 spec。
- 在 `website/public/llms.txt` 和 `llms-full.txt` 中公开 v2 建议包格式（信念 5）：等 P2 稳定之后再做。

### 依赖图

```
WP0.1 ─┬─► WP0.3 ─► WP1.1 ─► WP1.2
WP0.2 ─┤      │
       └─► WP2.1 ─► WP2.2 ─┬─► WP2.3 (也依赖 WP0.3)
                           ├─► WP2.4 ─► WP-E1 ─► WP-E2 ─► WP-E3
                           └─► WP-E4 (也依赖 WP0.1)
```

可以并行：WP0.1 与 WP0.2；P1 与 P2（WP0.3 完成之后）；WP-E4 与 WP-E1。

---

## 18. 实现者禁令（违反任意一条即为不合格）

1. 不得给桌面端加入 `git2` 依赖；不得在 Rust 中另写一份 diff3 或分词（I4）。
2. 不得在 `apply` 之外写源文件；不得在 B、C 目标中修改工作区、index、HEAD、配置或 hooks（I2、I10）。
3. 不得执行 `git push`、`git fetch`，也不得执行任何联网的 git 命令（I11）。
4. 不得默认勾选访客 hunk；「接受全部」不得包含带风险标记的 hunk（I3、§7.6）。
5. 不得对原件做格式化、换行归一或去 BOM；不得以「过滤格式差异」的方式绕过字节保持（I6、I7）。
6. 不得让 Worker 解析、diff 或渲染访客正文（I8）。
7. 不得在审阅界面中以 `{@html}` 输出未清洗的访客内容；不得自动加载访客内容中的远程资源（§15）。
8. 不得把 token、本机路径、commit oid 写进公开包、回执、日志或 vault 文件。
9. 不得放宽 CSP（不加 `'strict-dynamic'`、`'unsafe-eval'`、通配路径），不得从第三方 CDN 加载资源。
10. 不得因合并或提升而自动写入或修改 OKF 的 `verified`、`generated`、`type` 等信任字段（I14）。
11. 不得在改变分词、diff 或 ID 算法时不递增 `MERGE_KERNEL_VERSION`（I5）。
12. 不得删除 textarea 兜底；不得删除 `/_kit/` 下的旧资源。
13. 不得让 AI 拥有任何写工具或联网发送能力（§14）。
14. 不得在 v1 兼容路径上做破坏性改动；已落盘的 inbox、manifest 和 IndexedDB 草稿必须仍然可读。

---

## 19. CHANGELOG 义务

每个工作包合入时，都要在 `CHANGELOG.md` 和 `CHANGELOG.zh-CN.md` 的「未发布」区写面向用户的条目，一条对应一个用户能感知的变化。建议措辞：

| 包 | 中文条目示例 |
| --- | --- |
| WP0.3 | 项目分享的审阅改为逐处 diff：可逐处接受、拒绝、编辑外部修改；原件改过也能自动合并不冲突的部分。 |
| WP1.x | 原项目在 git 仓库中时，外部建议可生成带作者署名的分支（团队仓库默认）或补丁；note.md 不会推送，也不会改动你的工作区。 |
| WP2.3 | 外部协作者提交后会收到处理回执（采纳了几处、你的回复）；可对单份提交关闭。 |
| WP2.4 | 分享页会提示有新版本；旧版本上的草稿可以继续提交。 |
| WP-E1/E2 | 分享页的编辑改用与 note.md 相同的编辑器：所见即所得、同样的批注手势，并可查看「我的修改」。 |
| WP-E4 | 可在 note.md 中打开别人分享的项目，离线编辑、批注后再提交，并能合并分享者的新版本。 |

**版本节最前面需要提示的事项**：WP0.2 首次写入 manifest v2 时，旧快照无需迁移，不必提示。如果实现中出现了数据迁移，必须在版本节最前面写明。

---

## 20. 已确认的产品决定（2026-10-12，用户确认）

| # | 问题 | 决定 | 落点 |
| --- | --- | --- | --- |
| 1 | 无冲突的访客 hunk 是否默认勾选 | **默认不勾选**；提供显式的「接受全部无冲突改动」，带风险标记的 hunk 不在其中 | §7.6、§8.3 |
| 2 | git 模式的默认目标 | **有 remote 默认 B，没有 remote 默认 A**；可按项目切换 | §9.1、§9.5 |
| 3 | 回执 | **默认开启**，可对单份提交关闭 | §8.5、§10.3 |
| 4 | 逐人邀请 | **暂不做**，以轻便易用为先 | §1.3-6 |
| 5 | 分享是否包含主人批注 | **包含**，不加开关，访客只读 | §12.5 |
| 6 | 编辑器的交付方式 | **只放线上**（同源、内容寻址、SRI）；source-only 离线归档中的原 Markdown/附件由本地阅读器打开，不承诺 ZIP 内离线 HTML reader；旧包内 reader 只做兼容校验、不执行或落盘；需要富文本离线协作的人用 note.md 打开 | §12.2、§13 |
| 7 | 现有 Kit 与桌面 Rich 未通过源码保真门槛（2026-10-13 后续确认） | **增加共享编辑器保真前置，再完成网页与桌面协作**：保留原始源码、仅局部序列化；保留 I7 与 §12.4 判据，不以格式差异过滤绕过 | §12.4、§13、§21；[前置计划](../plans/2026-10-13-shared-editor-source-fidelity.md) |

本规格新增的工程决定：

| # | 决定 | 原因 |
| --- | --- | --- |
| D1 | 合并内核用纯 TS 写一份，三端共用；撤销原提案中的「libgit2 merge_file」 | 桌面端没有 git2；三端需要一致的 hunk ID |
| D2 | 散文以「句子 token」为合并单位；首尾相接的修改不算冲突 | 让「两人改同段不同句」能够自动拆开，并且结果确定、ID 稳定 |
| D3 | git 只通过 CLI 访问，用临时 index 造树 | 与仓库现有做法一致，不碰用户状态 |
| D4 | 版本号单独提供公开接口；source-only ZIP 不带内部 manifest。E4 按 V1→已发布 reader→ZIP→V2，从唯一 project-data 的公开 snapshot 投影外部清单，不另设 manifest 接口或 Worker 路由 | 保持既有源包及分段上传协议；接受一次有界 reader 读取和版本竞态校验成本 |
| D5 | 回执单独使用 `receipts/` 前缀 | 不破坏 `listFeedback` |
| D6 | 编辑器资源打包成 IIFE 单文件，以经典脚本加 SRI 加载 | 动态 `import()` 无法附带 SRI |
| D7 | 访客批注统一用「与 base 的 CriticMarkup 多重集差」来识别 | 浏览器与桌面共用同一算法，不引入新语法 |

---

## 21. 留给实现者核实的事项（核实后在 PR 中写明结论）

| 事项 | 默认做法 | 核实不通过时 |
| --- | --- | --- |
| 共享 file owner 能否满足 §12.4 的字节保持 | 复用已受理 source fidelity/bindings/history，实际 committed+installed SHA 与最终 IIFE 各自验证原 corpus、三次零 diff、一字 raw index expected 及真实 propose 一 hunk | 前置冻结身份见上方阶段报告；E1 实际产物门槛未过仍阻塞，不得绕过 |
| 分享者批注保护替代方案 | 按 §12.5 冻结同 raw 多重集 floor，最终候选一次 veto；同文复制后删除任意 occurrence 可通过，不等于逐节点 origin 保护 | 在实施报告与用户可见限制中记录；旧已改批注不强制修复，仍报告 ownerAnnotationsTouched |
| `revokeProject` 或删除流程是否清理 `feedback/` | 回执随之处理（§10.3） | — |
| Tauri deep-link 在 Windows 和 Linux 上注册 scheme 的方式 | 按 Tauri v2 文档实现 | 如果只能在 macOS 上做到，界面隐藏按钮，只保留菜单入口 |
| `@testing-library/svelte` 和 `fake-indexeddb` 是否已在 devDependencies 中 | 缺失时新增，限 devDependency | — |
| share-editor 的体积预算（900 KiB gzip） | 实测最终主 IIFE 与必要可执行闭包，可选 Mermaid 独立记录；CORE 的预算不能代替此预算 | 超出时回报，不得擅自提高 |
| Mermaid seam M0 与 SDK 默认迁移 | 后继交付 Task1 先实现显式 MermaidLoader；共享 setup/NodeView 无默认 renderer 加载边，flag false 抑制注入，true 不创造默认 loader。无 loader 显示可编辑源码；桌面显式注入原 CORE 可选 renderer，旧 Kit false 保持源码。pending/completed cache 同时按 schema/registry/loader 身份隔离，防异步迟到写回并保留失败源码 | 未实现或真实 installed 图/产物 AST/预算/桌面回归未过时阻塞 E1；在 CORE/HOST 未发布日志、API 文档和迁移用例明确无参数 SDK 自动 preview 行为改变，不加隐式 fallback 或第二 factory |
| 真平台与设备证据 | macOS Safari/Chrome、iOS Safari、Android Chrome × 中文/日文 IME × tablecell/list，以及 Desktop macOS 菜单/键盘/普通 input fallback，按实际 OS/browser/app/IME 版本与 raw 结果记录 | 用户已明确暂时没有移动设备，iOS Safari/Android Chrome 中文、日文真实 IME 保持待验；不重复询问或停下独立实现。前置三次原生 UI 库存因 Sky native pipe 失败未能实测，macOS/原生 UI 相应项仍待验；headless Chromium 或合成 composition 不能替代真实系统 IME、Safari 或设备实测，不宣称全平台完成 |

前置 bindings Task1–5 已逐 Task 受理，其报告只证明列明 SHA 与验证范围；前置最终 phase/收尾身份已在阶段报告确认，真实 IIFE/原生交付仍由后继证据确认，不将本地 commit、前置单元测试或旧 Kit 的失败直接冒称 E1–E4 已完成或已进入安装包。免费 Worker CPU 的既定严格门槛及未通过的 10ms 遗留保持，后继必须绑定实际部署版本重新验证，不以本候选或新路径通过清除旧缺证。

---

## 参考

- Pro Git，*Distributed Workflows*：https://git-scm.com/book/en/v2/Distributed-Git-Distributed-Workflows
- Google Copybara：https://github.com/google/copybara ；Meta FBShipIt：https://github.com/facebook/fbshipit ；Josh：https://github.com/josh-project/josh
- `git merge-file`、`merge-tree`、`commit-tree`、`hash-object`、`update-ref`、`check-ref-format`：https://git-scm.com/docs
- W3C Web Annotation Data Model（Selectors）：https://www.w3.org/TR/annotation-model/ ；Hypothesis，*Fuzzy Anchoring*：https://web.hypothes.is/blog/fuzzy-anchoring/
- Myers，*An O(ND) Difference Algorithm and Its Variations*（1986）
- Ink & Switch，*Upwelling*：https://www.inkandswitch.com/upwelling/
- GitHub，*Creating a commit with multiple authors*：https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors
- Subresource Integrity：https://www.w3.org/TR/SRI/ ；CSP Level 3：https://www.w3.org/TR/CSP3/
- Trojan Source：https://trojansource.codes/
- Semantic Line Breaks：https://sembr.org/
- 本仓库：`docs/okf-v0.2-format-constraints.md` §5/§7；`docs/product-principle-relationships-only-grow-where-confirmed.md`；`docs/product-principle-mirror-hosted-marks.md`；`docs/product-principle-one-vault-many-agents-you-orchestrate.md`
