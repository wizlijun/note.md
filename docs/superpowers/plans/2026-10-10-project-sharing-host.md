# 宿主项目分享 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在宿主提供项目引用一起分享、浏览器标注编辑、自动回传及本机人工审阅合入。

**Architecture:** 复用 source→Vault Sync，以 project_id 隔离镜像；冻结批准文件，打成一个 HTML 用现有 /publish 发布。一个项目 token 鉴权，现有 Worker/R2 收不可变反馈；本机可信基线验证并回写原件。

**Tech Stack:** Rust/Tauri 2、Svelte 5、TypeScript、marked、Cloudflare Worker/KV/R2、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-10-project-document-sharing-design.md`

## Global Constraints

- 作为宿主基础功能，不新增插件或依赖插件开关。
- 使用现有 main 工作目录，不新建 worktree、不推送、不部署；保留用户未提交代码。
- HTML 总大小上限 25 MiB，反馈上限 5 MiB；owner 凭据与项目 token 不进入公开 HTML。
- Markdown 原字节镜像、相对路径定位；根外/绝对本地引用须明确处理，不自动扩大分享范围。
- 一个项目一个协作 token，全部分享文档相同编辑/标注权限；不新增账号/角色/DO/数据库/队列。
- 原件权威，镜像冲突阻断；有变化用人工对照，不自动三方合并。
- 上传前保存 slug/edit_token/协作 token/snapshotId；反馈 ID 与冻结包绑定，重试不重建。
- 各任务不提交含用户改动的整文件，最终由主代理精确暂存本轮差异。

## 跨层接口

在 `src/lib/project-share/types.ts` 定义：

```ts
export interface ProjectInfo {
  project_id: string; sourceRoot: string; mirrorRoot: string; entry: string;
  files: string[]; publishedSnapshotId?: string; url?: string;
}
export interface ProjectFile {
  path: string; hash: string; bytes: number; markdown?: string; dataUrl?: string;
}
export interface ProjectSnapshot {
  schemaVersion: 1; project_id: string; snapshotId: string;
  entry: string; files: ProjectFile[];
}
export interface ProjectFeedback {
  schemaVersion: 1; project_id: string; snapshotId: string; submissionId: string;
  edits: {path: string; baseHash: string; afterMarkdown: string}[];
  annotations: {path: string; quote: string; comment: string; start?: number; end?: number}[];
  name?: string;
}
export interface FeedbackEnvelope {
  payload: ProjectFeedback; requestHash: string; receivedAt: string;
}
export interface LocalFeedback {
  envelope: FeedbackEnvelope; status: string; error?: string;
  decisions: Record<string, {status: string; beforeHash?: string; resultHash?: string}>;
}
export interface ReviewFile {
  path: string; sourcePath: string; base: string; current: string; after: string;
  currentHash: string; status: string;
}
```

唯一宿主命令 `invoke('project_share', {request})`，请求使用 `op` 判别，JSON 字段与上述类型一致：

| op | 输入 | 输出 |
| --- | --- | --- |
| open | sourceRoot, entry（根内相对路径） | ProjectInfo，复用该根已有 project_id |
| rebind | project_id, sourceRoot | ProjectInfo，核验并绑定当前 Vault/syncDir/id 已有目录，不搬文件；源和镜像须保持已记录 hash |
| mirror | project_id, path | {source: ProjectFile, mirror: ProjectFile} |
| resolve-mirror | project_id, path, expectedSourceHash, expectedMirrorHash | ProjectInfo，双 hash 核验后明确用原件刷新镜像 |
| snapshot-get | project_id, snapshotId | ProjectSnapshot，读已有可信基线 |
| bundle-get | project_id, snapshotId | string，读唯一冻结 HTML |
| list | project_id | string[]，可解析的根内 Markdown 候选 |
| read | project_id, path | ProjectFile，安全根约束，MD 原文或资源 data URL |
| snapshot | project_id, paths, hashes（path→hash） | ProjectSnapshot，核验源/镜像，保存基线及 Sync 映射 |
| bundle | project_id, snapshotId, html | null，保存对应 bundle.html |
| published | project_id, snapshotId, url | ProjectInfo，更新最后确认配置 |
| feedback | project_id, envelope | LocalFeedback，先保存且不覆盖已有处理决定，验证可信基线，异常隔离 |
| inbox | project_id | LocalFeedback[] |
| review | project_id, submissionId, path | ReviewFile，校验范围/基线，读当前原件 |
| apply | project_id, submissionId, path, expectedHash, content | LocalFeedback，文件级持久化意图/恢复，写原件，再刷新镜像 |
| reject | project_id, submissionId, path（可选） | LocalFeedback，拒绝文件或整包 |
| resolve | project_id, submissionId | LocalFeedback，标注-only 反馈已阅 |

`buildProjectBundle(snapshot, feedbackUrl): string` 是无 Tauri 的静态包入口，读取 token 仅在浏览器 URL fragment，反馈请求 JSON 为 ProjectFeedback。

Worker 扩展 `/publish` metadata 的 `project_id`、`feedback_token_hash`（SHA-256 hex）；新增 `POST /feedback/{slug}`（`X-Feedback-Token`）、`GET /feedback?project_id=...&cursor=...`、`GET /feedback/{project_id}/{submissionId}`（既有 owner Authorization）。列表返回 `{items: {submissionId: string}[], cursor?: string}`；下载返回 FeedbackEnvelope。R2 键为 `feedback/{project_id}/{submissionId}.json`。

---

### Task 1: 宿主项目镜像、可信基线和反馈审阅

**Files:** Create `src-tauri/src/project_share.rs`; Modify `src-tauri/src/lib.rs`, `src-tauri/src/sotvault/{mod,store,mirror_meta}.rs`, `src/lib/{sotvault.svelte,sotvault-logic}.ts`, `src/lib/outline/note-home.ts`; Rust unit tests + existing Sync regressions.

**Interfaces:** 生产上述唯一 project_share 命令；现有 Sync Record 增可选 project_id，旧记录默认 legacy。

- [x] 测试先写：用临时源/Vault 验证根内目录保留、循环更新不增副本、镜像独有变更阻断、路径/软链越界拒绝、源 hash 漂移拒绝。

```rust
assert!(validate_relative("../outside.md").is_err());
assert!(validate_relative("docs/a.md").is_ok());
```

- [x] 运行新测试，确认缺实现失败；实现命令与纯文件系统核心，配置使用已解析 syncDir，绝对源绑定只放应用本机状态。
- [x] 反馈测试覆盖伪造路径/旧基线隔离、重复拉取不重设决定、写后崩溃恢复、源已改拒绝 stale expectedHash；实现 review/apply/reject/resolve。

```rust
assert_eq!(recovered_result.status, "accepted");
assert!(apply_with_stale_hash.is_err());
```

- [x] 补多目标保存、legacy 范围查询、项目 raw copy、完整相对路径 metadata key 和个人 note home 兼容；项目原生菜单项 `project-share` 不依赖插件。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib project_share` 与 Sync 相关测试；记录实测结果供审查。

### Task 2: Worker 最小收件接口

**Files:** Create `worker/src/feedback.ts`, `worker/tests/feedback.test.ts`; Modify `worker/src/index.ts`.

**Interfaces:** 生产跨层接口定义的 publish metadata 和三个反馈路由；不改旧单篇默认合同。

- [x] 先写真实 Worker binding 测试：发布有 token hash 的项目，错误 token POST 403，正确 POST 成功，owner GET 列表可见，访客 GET 拒绝。

```ts
expect((await SELF.fetch(url, {method: 'POST', body: JSON.stringify(payload), headers: {'X-Feedback-Token': 'wrong'}})).status).toBe(403)
```

- [x] 运行 `pnpm --dir worker test -- tests/feedback.test.ts` 确认缺接口失败；实现项目 metadata 检验、过期检查、相对路径 schema/5MiB 限制。
- [x] 条件创建不可变 R2 原包；测试重复同内容首次 receivedAt 不变、异内容 409、并发重试只生成一包、分页 cursor、owner 隔离。

```ts
expect(retryReceipt.receivedAt).toBe(firstReceipt.receivedAt)
expect(conflictingRetry.status).toBe(409)
```

- [x] CORS 允许 X-Feedback-Token；worker 只鉴权暂存，未知基线留给本机隔离，不信任客户端路径作文件操作。
- [x] 运行全部 Worker 测试与 `tsc --noEmit`，保留现有 publish/media/MCP 行为。

### Task 3: 引用扫描和静态浏览器包

**Files:** Create `src/lib/project-share/{types,references,bundle,browser}.ts` and corresponding tests.

**Interfaces:** 消费 ProjectFile/ProjectSnapshot；生产 `scanProject(entry, candidates, read)` 返回 files/issues、`buildProjectBundle(snapshot, feedbackUrl)`。

- [x] 先写真实解析用例：普通/引用式链接、Wikilink、标题、代码伪链接、循环、同名歧义、越界/绝对路径、被排除链接；无读取副作用。

```ts
expect(result.files.map(f => f.path)).toEqual(['README.md', 'docs/plan.md', 'assets/a.png'])
expect(result.issues[0].kind).toBe('outside')
```

- [x] 实现 marked token 遍历，根内纯路径解析；不重写原文，缺失/歧义/绝对/排除要显示，批准集合才可发布。
- [x] 浏览器测试先验证包不含 token/绝对路径、恶意 HTML/JSON 无脚本注入、25MiB 拒绝；实现自包含导航/资源和 Markdown 编辑预览。
- [x] 实现 IndexedDB 草稿及冻结提交包保存，输入持久化失败准确报错；旧快照选文评论；X-Feedback-Token 自动 POST、5MiB 拒绝、同 ID 重试；导出草稿备份。
- [x] 在真实 Chromium 以本地测试服务打开生成包：阅读链接跳转、编辑/重开恢复、标注、离线再提交、反馈收到。只使用本地测试凭据。

### Task 4: 宿主内置项目分享界面

**Files:** Create `src/lib/project-share/{host,state.svelte}.ts`, `src/components/ProjectShareDialog.svelte`; Modify `src/lib/{commands,ui-state.svelte}.ts`, `src/App.svelte`, `src/components/DrawerNav.svelte` as needed.

**Interfaces:** 消费 Task 1 命令、Task 2 HTTP 路由及 Task 3 bundle；生成原生 `project-share` 命令和窗口；iOS 沿用现有 Sync 支持边界，不展示无效入口。

- [x] 用现有测试 seam 测试上传前本机分享身份预存、未知结果重试同一身份/包、取件不丢决定、未知基线隔离。

```ts
expect(events.indexOf('persist-identity')).toBeLessThan(events.indexOf('publish'))
expect(secondAttempt.slug).toBe(firstAttempt.slug)
```

- [x] 在现有 share_db.json 的独立 key 保存项目秘密，不使用会被单篇记录 cap 淘汰的映射；复用分享服务设置与 owner fetch。
- [x] 选择项目根/入口、扫描预览与文件选择、发布/复制阅读和协作链接、重新发布/停止分享、检查反馈。
- [x] 人工审阅展示原快照/当前/访客与可编辑结果；接受前处理当前编辑器未保存数据、hash 重验、接受后刷新 tab；标注已阅和拒绝可达。
- [x] UI 所有弹层菜单复用全局 menu-panel/menu-row；宿主入口不要求 share 插件激活；错误具体可读。
- [x] 运行相关 Vitest、svelte-check、生产构建；用本地 Mock Worker 验证宿主调用合同。

### Task 5: 集成审查、完整流程和交付

**Files:** 更新计划勾选、Spec 实现状态及任务回顾；仅修复本轮发现的问题。

- [x] 逐任务只读独立 review 同时验证 Spec 合规与代码质量；发现安全/丢数据问题先修复重验。
- [x] 全流程 fixture：两篇互引 + 图片 → Sync/project_id → 一包发布 → 浏览器编辑批注 → 收件 → 本机审阅合入 → 镜像刷新 → 同 URL 重发 → 停止分享。
- [x] 检查现有单篇 Share/Sync/个人 note home 回归，Worker 全套、前端针对性套、生产构建、Rust 检查；把环境/旧代码失败与本轮问题区分。
- [x] 审查最终差异，不夹带用户现有改动，不推送/部署；逐任务核对后在 main 原子提交本轮代码并报告证据与实际限制。

## 自审与执行规则

Task 1/3/4 的数据类型以本计划和 types.ts 为单一合同；Task 2 的 envelope 和路由与 host 完全一致。所有 Spec 章节对应 Task 1–4，Task 5 做闭环验收。该版本不增加自动合并、逐人权限或云端版本系统。

用户已明确开始实现，无需再次请求执行许可。使用现有 main 的授权优先于 skill 的新 worktree 默认建议；一次仅一个实现子代理，主代理同步处理不重叠文件。任务完后独立审查，不以自审代替。

## 验收记录（2026-10-10）

Task 1–4 经独立审查最终 Approved。修复镜像绑定/软链、文件级恢复、浏览器草稿初始化/超限/导航 token、owner 服务绑定、REST 204、slug 格式及已发布入口缺失管理等实际发现的问题。

最终前端全套 3382、Rust library 全套 1143、Worker 全套 137 均通过；类型检查与生产构建通过，iOS simulator 编译通过。浏览器 + 本地 Worker + Rust 文件操作已作分阶段真实往返验收。当前主目录 main，无新 worktree、无推送、无部署；完整 Tauri 打包的原生交互不冒称已验。iOS 当前不提供此入口。
