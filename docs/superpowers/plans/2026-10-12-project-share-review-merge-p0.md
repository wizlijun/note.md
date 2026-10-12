# 项目分享评审合并 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已有项目分享的整文件手工拼接升级为以发布快照为基线的逐处审阅，安全保留原件的新修改、访客建议及批注决定。

**Architecture:** 新增一份纯 TypeScript 合并内核，生成确定性的三方提案；Svelte 主人界面负责逐处决定、确认与批注提升。Rust 只保存审阅状态，并复用已有 CAS、持久化意图、原子写入与镜像恢复。P0 可独立交付，保留现有 v1 反馈协议与 Worker。

**Tech Stack:** TypeScript、Svelte 5、Rust/Tauri 2、Vitest、Web Worker、marked；新增 DOMPurify（主人侧渲染清洗）及 @testing-library/svelte（devDependency）。

**Spec:** [2026-10-12-project-share-review-merge-design.md](../specs/2026-10-12-project-share-review-merge-design.md)，重点 §4–8、§15–19；§20 已确认，不重新征询。

## Global Constraints

- 用户要求在 `/Users/bruce/git/mdeditor` 当前 `main` 工作；不创建分支或 worktree。实现时先核对工作区并保护已有修改，只精确暂存本任务文件，不执行 `git add .`。
- **快照即祖先。** base 永远取提交声明的 `snapshotId`，不以当前原件代替。
- **源文件只经 `apply` 写入。** 不新建源文件写入路径，不改变既有 CAS、意图与恢复顺序。
- **不自动接受。** 访客改动默认未决；「接受全部无冲突」排除 `trust-field`、`owner-annotation`、`hidden-chars`、`degraded`。
- **单一内核。** `src/lib/share-merge/` 不 import `@tauri-apps/*`、`svelte`、DOM API、moraya-core；不在 Rust 另写 diff3。P0 不引入 diff-match-patch。
- **内核确定性。** `MERGE_KERNEL_VERSION = 1`；改变分词、diff、ID 算法必须递增版本。
- **拼接保真。** `tokens.join('') === text`；全部拒绝后的 compose 严格等于 ours；ours 的 CRLF、BOM、末尾换行均不改写。
- 坐标使用 **UTF-16 code unit**；hash 对 UTF-8 字节计算 SHA-256，输出 64 位小写十六进制。
- 单文件 token 数超过 **200 000** 或 Myers 编辑距离 D 超过 **20 000** 时整文件降级；三份输入合计超过 **256 KiB** 时在 Web Worker 计算。
- `review-save` 的每文件审阅草稿 JSON 上限 **1 MiB**；反馈协议上限维持 **5 MiB**；源文件写入沿用 **25 MiB** 上限。
- 公开包不得含 `parentSnapshotId`、`git`、`gitError` 或本机绝对路径。公开快照与本机 manifest 分离。
- 访客正文、名字、评论均不可信；不得把未清洗内容交给 `{@html}`，远程图片默认不请求。
- 访客身份始终标记自报；批注提升不自动改变 OKF 信任字段。
- v1 manifest、inbox、反馈与现有分享链接继续可用。P0 不更改 Worker、浏览器草稿协议或线上部署。
- 每个工作包完成前更新 `CHANGELOG.md` 与 `CHANGELOG.zh-CN.md` 的未发布区；运行 §17 四项全量检查。发布另按用户已经确认的全部未发布更新范围执行。

## 阶段划分与全规格覆盖

本计划细化 **P0**。其余阶段保持原 spec 的依赖顺序，后续各写独立实施计划；本计划完成不等于整份 spec 实施完成。

| 阶段 | 覆盖 | 前置 | 独立交付 |
| --- | --- | --- | --- |
| P0（本计划） | §6.2/6.4、§7、§8.1–8.4/8.6、§15、§16、WP0.1–0.3 | 无 | 已有 v1 提交的逐处审阅、安全写回与批注提升 |
| P1 | §9、WP1.1/1.2 | WP0.2/0.3 | Git A 工作区、B 分支、C 补丁；有 remote 默认 B；不自动 push |
| P2 | §6.3/6.5–6.7、§8.5、§10/11、WP2.1–2.4 | WP0.2；回执 UI 依赖 WP0.3 | v2 建议包、版本检查、默认开启的回执、旧草稿迁移 |
| E1 | §12.1–12.6/12.9 | WP0.1、WP2.4 | 同源 Editor Kit v2、SRI、零 diff、textarea 兜底 |
| E2 | §12.8 | E1 | 我的修改、逐处撤销、批注保护、提交面板 |
| E3 | §12.7、Mermaid | E2 | 草稿 rebase 与懒加载 Mermaid |
| E4 | §6.8、§13 | WP0.1、WP2.2 | note.md 打开分享链接、离线编辑及发件箱 |
| P3 | §14、§17 P3 | 本轮排除 | AI 与新增文件建议须另行规划 |

E1 必须先证明 Kit v2 的字节保持和 **900 KiB gzip** 预算；失败时停止 E1 并报告，不过滤格式差异、不自行提高预算。E4 执行前核对真实 ZIP 格式：当前 `archive.ts` 默认 `source` ZIP 不带 legacy 内部 manifest，§13 所述 manifest 不能直接假定存在；在 E4 计划明确校验数据的交付方式后才能实现该阶段。

## 已核对的代码接缝与执行解释

基线：`ce070741`，日期 2026-10-12。执行前重读实际文件，按符号定位，不依赖行号。

- `types.ts` 的 `ProjectSnapshot.schemaVersion` 当前只允许 1；Rust `snapshot()` 当前写 1。
- `bundle.ts` 直接序列化整个 snapshot。新增本机字段后会泄露，Task 7 必须在 manifest v2 可发布前完成；`archive.ts` legacy manifest 已用字段白名单。
- Rust `LocalFeedback`、`ReviewDraft` 按 snake_case 序列化；`Decision` 已使用 camelCase。前端必须逐字段匹配，不能统一套 camelCase。
- §8.1 概述包含 v2 收件，但 §17 明确 P0 不改协议。P0 保留 `ProjectFeedback` v1，payload enum/v2 校验到 WP2.1；回执、Git 与 supersedes 的可选存储类型可以预留，相关行为到对应阶段。
- 草稿上限按**完整 ReviewDraft 的 UTF-8 JSON 字节数 ≤ 1 MiB**执行，因而 hunks 部分也不会超过 §6.4 上限。测试完整草稿精确边界，不按 JS 字符数。
- `apply()` 对 accepted/mirror_pending 文件立即幂等返回。P0 将正文决定与本文件选中的批注提升**先合成为一个最终文本，确认后一次 apply**；不把批注提升变成第二条源写入路径，不放开终态 apply。
- 对终态文件，不再提供重复提升写入；仍可查看批注、复制内容、忽略。第一次写回前明确列出尚未处理批注。已成功写回但批注状态保存失败时，只重试 `annotation-decide`，不得重放新的正文写入。恢复时按已保存的最终文本与源 hash 检查，不推测新的内容。
- `review-save` 只允许 edits 路径。纯批注文件的提升选择由本次审阅会话暂存，持久化终态由 `apply` 与 `annotation-decide` 完成，不偷偷扩大 `review-save` 合同。
- 原 dialog 通过 `prepareBuffers(sourcePath?)` 保存原件/镜像脏 tab，并在 apply 后重新载入 tab。该保护必须保留，不能直接把新组件的按钮接到 IPC 绕过它。现有 `reloadTabFromDisk` 无 dirty 保护，Task 9 的可选保护参数必须在异步读取完成、赋值前再次核验，不能仅在调用前检查。
- `@testing-library/svelte` 尚未安装；按 spec §21 增加 devDependency。现有 happy-dom + mount 测试继续保留。DOMPurify 只在主人侧 UI 使用，不进入纯内核或 Worker。

## 文件与接口地图

| 文件 | 职责 |
| --- | --- |
| `src/lib/share-merge/types.ts` | §7 公共类型、token/变更的内部类型 |
| `src/lib/share-merge/hash.ts` | 无外部依赖的同步 SHA-256 内部函数及公开异步包装 |
| `src/lib/share-merge/{tokenize,frontmatter,eol}.ts` | 无损分词、frontmatter 键级处理、访客 EOL 对齐 |
| `src/lib/share-merge/{diff,diff3,proposal,flags,compose}.ts` | Myers、区域合并、稳定提案、风险与决定组合 |
| `src/lib/share-merge/{critic,anchor,rebase,index}.ts` | 批注抽取、重锚、rebase、统一导出 |
| `src/lib/share-merge/*.test.ts` | K1–K19、精确边界、确定性与 500 例随机保真 |
| `scripts/check-share-merge-purity.mjs`、同名 `.test.ts` | 递归检查内核 import/全局 API，构建前执行 |
| `src-tauri/src/project_share.rs` | manifest v2、可选审阅字段、新 op、apply/reject 扩展、旧数据兼容 |
| `src/lib/project-share/types.ts` | Rust IPC 类型与公开快照类型 |
| `src/lib/project-share/{bundle.ts,bundle.test.ts}` | 显式公开快照投影，不泄露本机元数据 |
| `src/lib/project-share/{host.ts,host.test.ts}` | 新审阅 op 的有类型封装 |
| `src/lib/project-share/{review.svelte.ts,review.test.ts,merge-worker.ts,merge-client.ts,merge-client.test.ts}` | 审阅生命周期、保存、并发刷新及 Worker 调度 |
| `src/components/project-review/{SubmissionList,HunkView,ConflictEditor,AnnotationPanel,ProjectReview}.svelte` | 仅替换现有 dialog 的审阅区 |
| `src/components/project-review/{render.ts,render.test.ts,ProjectReview.test.ts}` | 清洗后的 Markdown diff 与组件行为测试 |
| `src/components/ProjectShareDialog.svelte`、`.test.ts` | 接入原件保存/刷新及分享项目选择生命周期 |
| `src/lib/tabs.svelte.ts`、`src/lib/tabs.test.ts` | 给重载增加可选的内容未变保护；旧调用行为不变，保护分享写回期间的新编辑 |
| `package.json`、`pnpm-lock.yaml`、两份 CHANGELOG | 检查脚本、依赖锁定、分包用户说明 |

跨任务公共 API 遵循 spec §7.1/7.7。补充内部接口如下，统一从 `index.ts` 导出需要被宿主使用的类型：

```ts
export interface MergeInput { path: string; base: string; ours: string; theirs: string }
export interface Token { text: string; start: number; end: number; fmKey?: string }
export interface Change { b0: number; b1: number; s0: number; s1: number }
export interface ExtractResult {
  clean: string
  annotations: { selector: TextSelector; comment: string; kind: 'comment' }[]
  ownerAnnotationsTouched: string[]
}
export interface RebaseResult {
  proposal: MergeProposal
  text: string
  conflicts: string[]
  ownerAnnotationTouched: boolean
}
```

`extractGuestAnnotations` 无 path 参数，返回中不加 path；调用者组包时补 path。kind 默认 comment，E1/E4 调用者再按 DraftV2 映射覆盖。这是 §7.1 签名与 §12.5 路径描述之间的适配，不扩展反馈协议。

## Task 1：无损分词、换行与 hash（WP0.1）

**Files:** Create `src/lib/share-merge/{types,hash,eol,frontmatter,tokenize}.ts` 及对应 `.test.ts`。

**Interfaces:** 生产 `tokenize(text: string): Token[]`、`alignEol(base, theirs): {theirs, aligned}`、`sha256Sync(text): string`、`sha256Hex(text): Promise<string>`。`propose` 使用同步 hash，维持 spec 的同步签名，不调用 Node crypto。

- [x] **Step 1：先写保真与已知 hash 的红测试。**

```ts
import { expect, it } from 'vitest'
import { tokenize } from './tokenize'
import { alignEol } from './eol'
import { sha256Sync } from './hash'

it('preserves BOM, CRLF, inline syntax and the missing final newline', () => {
  const text = '\uFEFF---\r\ntitle: A\r\n---\r\n甲。乙 `x.y`。\r\n末行'
  expect(tokenize(text).map(t => t.text).join('')).toBe(text)
  expect(tokenize('甲。乙！\n').map(t => t.text)).toEqual(['甲。', '乙！\n'])
  expect(alignEol('\uFEFFa\r\n', 'b\n')).toEqual({ theirs: '\uFEFFb\r\n', aligned: true })
  expect(sha256Sync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
```

- [x] **Step 2：运行红测试。** `pnpm exec vitest run src/lib/share-merge/tokenize.test.ts src/lib/share-merge/eol.test.ts src/lib/share-merge/hash.test.ts`。缺模块/函数时应失败；记录输出。
- [x] **Step 3：实现 §7.2 的扫描器。** 行尾随行保留；识别 BOM/frontmatter；顶层键 token 记录 fmKey；围栏/数学/HTML 原子块；表格逐行；空行段；散文句子，跳过全部受保护行内语法。按原始 slice 构造 token，不 join 后重新格式化。

```ts
// 所有 token 均来自原文 slice，start/end 是 UTF-16 下标。
const makeToken = (text: string, start: number, end: number, fmKey?: string): Token =>
  ({ text: text.slice(start, end), start, end, ...(fmKey === undefined ? {} : { fmKey }) })

export function alignEol(base: string, theirs: string) {
  let result = theirs
  if (base.includes('\r\n') && !result.includes('\r')) result = result.replace(/\n/g, '\r\n')
  if (base.startsWith('\uFEFF') && !result.startsWith('\uFEFF')) result = '\uFEFF' + result
  return { theirs: result, aligned: result !== theirs }
}
```

同步 SHA-256 用 UTF-8 编码、标准 padding、64 轮压缩实现；公开异步包装 `return sha256Sync(text)`。用 Web Crypto 对空串、中文、emoji、64 字节边界及长输入交叉校验。只有自己的纯 TS hash 在内核内，不从带宿主依赖的文件导入。

- [x] **Step 4：补表格/围栏未闭合/脚注/重复句/受保护行内语法用例，固定种子生成至少 500 个 Markdown 输入验证重组等于原文；运行整个目录测试。**
- [x] **Step 5：审查后精确提交本任务文件。** `git add src/lib/share-merge/types.ts src/lib/share-merge/hash.ts src/lib/share-merge/hash.test.ts src/lib/share-merge/eol.ts src/lib/share-merge/eol.test.ts src/lib/share-merge/frontmatter.ts src/lib/share-merge/frontmatter.test.ts src/lib/share-merge/tokenize.ts src/lib/share-merge/tokenize.test.ts`；`git commit -m "feat(share): add lossless markdown merge tokenization"`。

## Task 2：确定性三方提案（WP0.1）

**Files:** Create `src/lib/share-merge/{diff,diff3,proposal,index}.ts` 及测试；Modify `types.ts`。

**Interfaces:** `diff(base: string[], side: string[]): Change[]`；`propose(input: MergeInput): MergeProposal`。输出与 spec §7.1 一致，`segments` 按 ours 重组，`stats` 含四种 kind，hash 为 EOL 对齐后的实际输入 hash。

- [x] **Step 1：写 K1–K9、K15、K17 红测试，先证明相邻句不会合成冲突。**

```ts
import { expect, it } from 'vitest'
import { propose } from './proposal'

it('separates adjacent sentence edits deterministically', () => {
  const input = { path: 'a.md', base: '甲。乙。丙。', ours: '甲改。乙。丙。', theirs: '甲。乙改。丙。' }
  const p = propose(input)
  expect(p.hunks.map(h => h.kind)).toEqual(['ours-only', 'theirs-only'])
  expect(p.stats.conflict).toBe(0)
  expect(JSON.stringify(propose(input))).toBe(JSON.stringify(p))
  expect(p.segments.map(s => s.type === 'stable' ? s.text : p.hunks.find(h => h.id === s.id)!.ours).join('')).toBe(input.ours)
})
```

- [x] **Step 2：运行 `pnpm exec vitest run src/lib/share-merge/proposal.test.ts`，保存失败证据。**
- [x] **Step 3：实现 Myers 与区域合并。** 剥公共前后缀，token 映射整数；固定「先删后插」平局；以 §7.3 三条相交规则做传递闭包，两个非空相邻区间不合并。使用线性空间的中间 snake 分治回溯，不能保存每个 D 的完整 frontier 或分配 N×M 矩阵；检查最短编辑距离是否超过 20 000，超限返回降级信号，不先分配二次方轨迹再判断。

```ts
export function overlaps(a: Change, b: Change): boolean {
  if (a.b0 === a.b1 && b.b0 === b.b1) return a.b0 === b.b0
  if (a.b0 === a.b1) return b.b0 <= a.b0 && a.b0 <= b.b1
  if (b.b0 === b.b1) return a.b0 <= b.b0 && b.b0 <= a.b1
  return Math.max(a.b0, b.b0) < Math.min(a.b1, b.b1)
}
const classify = (base: string, ours: string, theirs: string): HunkKind =>
  ours === base ? 'theirs-only' : theirs === base ? 'ours-only' : ours === theirs ? 'both-same' : 'conflict'
const hunkId = (path: string, base: string, theirs: string, ordinal: number) =>
  'h_' + sha256Sync(`nmk1\0${path}\0${base}\0${theirs}\0${ordinal}`).slice(0, 16)
```

三份完全相同文本直接返回 0 hunk；上述分类只用于实际变更区域。降级唯一 hunk 也按同一规则与 ID 算法生成，并带 degraded。公开导出 `MERGE_KERNEL_VERSION = 1`。

- [x] **Step 4：运行所有内核测试；覆盖同位置插入、删除、空文、重复 token、两侧相同修改、代码块原子冲突、表格不同行、ID 不受 ours 无关改动影响。**
- [x] **Step 5：精确提交 diff、diff3、proposal、index、types 与对应测试。** `git commit -m "feat(share): generate deterministic three-way merge proposals"`。

## Task 3：风险标记与决定组合（WP0.1）

**Files:** Create `src/lib/share-merge/{flags,compose}.ts` 及测试；Modify `proposal.ts`、`index.ts`、`types.ts`。

**Interfaces:** `compose(p, decisions): ComposeResult`、`acceptUnconflicted(p): Record<string,HunkDecision>`。`HunkDecision`、结果计数与未决字段严格按 §7.7。

- [x] **Step 1：写 K10–K14/K16 红测试及 kind 改变后的决定作废。**

```ts
it('keeps unreviewed changes out and refuses bulk acceptance of trust fields', () => {
  const p = propose({ path: 'a.md', base: '---\nverified: false\n---\n甲。', ours: '---\nverified: false\n---\n甲。', theirs: '---\nverified: true\n---\n乙。' })
  expect(compose(p, {}).text).toBe('---\nverified: false\n---\n甲。')
  const bulk = acceptUnconflicted(p)
  expect(compose(p, bulk).text).toBe('---\nverified: false\n---\n乙。')
  expect(p.hunks.find(h => h.flags.includes('trust-field'))!.id in bulk).toBe(false)
})
```

- [x] **Step 2：运行 `pnpm exec vitest run src/lib/share-merge/compose.test.ts src/lib/share-merge/flags.test.ts`，先确认失败。**
- [x] **Step 3：实现 §7.5–7.7。** 信任键集合准确为 `type/generated/verified/sources/status/stale_after`；退化 frontmatter 保守标记 trust-field；与 base 批注原文片段相交打 owner-annotation；新增 bidi 控制符/零宽字符打 hidden-chars，记录明确的 code point 集合和测试。flags 排序按 spec 声明顺序，去重。

```ts
export const acceptUnconflicted = (p: MergeProposal): Record<string, HunkDecision> =>
  Object.fromEntries(p.hunks
    .filter(h => h.kind === 'theirs-only' && !h.flags.some(f =>
      ['trust-field', 'owner-annotation', 'hidden-chars', 'degraded'].includes(f)))
    .map(h => [h.id, { kind: 'theirs-only', choice: 'accept' }]))
```

compose 按 §7.7 的整张输出表实现。未决输出 ours，edited 缺 text 拒绝；未知 ID/kind 不符进入 staleDecisions，不能按旧决定写回。只统计 theirs-only/conflict，ours-only/both-same 不增加 total。

- [x] **Step 4：补全冲突五种 choice、pending、风险接受、全部拒绝、二次提交 both-same，运行整个内核测试。**
- [x] **Step 5：精确提交本任务文件。** `git commit -m "feat(share): compose reviewed hunks with risk gates"`。

## Task 4：批注抽取、重锚与 rebase（WP0.1）

**Files:** Create `src/lib/share-merge/{critic,anchor,rebase}.ts` 及测试；Modify `index.ts`、`types.ts`、`flags.ts`。

**Interfaces:** `extractGuestAnnotations({base,draft}): ExtractResult`、`makeSelector(text,start,end): TextSelector`、`anchor(text,selector): AnchorResult`、`rebaseDraft({path,oldBase,newBase,draft}): RebaseResult`。

- [x] **Step 1：写 K18/K19 与点批注、多重集差、损坏语法测试。**

```ts
it('extracts only guest notes while preserving the owner markup', () => {
  const base = '{==甲==}{>>主人注<<}乙'
  const draft = '{==甲==}{>>主人注<<}{==乙==}{>>建议<<}'
  const result = extractGuestAnnotations({ base, draft })
  expect(result.clean).toBe(base)
  expect(result.annotations).toHaveLength(1)
  expect(result.annotations[0].comment).toBe('建议')
  expect(anchor(result.clean, result.annotations[0].selector)).toEqual({ status: 'exact', start: base.length - 1, end: base.length })
  expect(result.ownerAnnotationsTouched).toEqual([])
})
```

- [x] **Step 2：运行本任务测试，确认缺实现失败。** `pnpm exec vitest run src/lib/share-merge/critic.test.ts src/lib/share-merge/anchor.test.ts src/lib/share-merge/rebase.test.ts`。
- [x] **Step 3：实现 §12.5 原文多重集差与 clean 坐标映射。** 仅识别两种 CriticMarkup；嵌套/残缺保留为文本。重复同文消耗一次 owner 条目，剩余视为 guest；删除/修改 owner 片段返回 ownerAnnotationsTouched。prefix/suffix 默认各 32 UTF-16 单位。

```ts
export function rebaseDraft(input: { path: string; oldBase: string; newBase: string; draft: string }): RebaseResult {
  const proposal = propose({ path: input.path, base: input.oldBase, ours: input.newBase, theirs: input.draft })
  const decisions = Object.fromEntries(proposal.hunks.filter(h => h.kind === 'theirs-only')
    .map(h => [h.id, { kind: 'theirs-only', choice: 'accept' } as HunkDecision]))
  const result = compose(proposal, decisions)
  return { proposal, text: result.text, conflicts: result.pendingConflicts,
    ownerAnnotationTouched: proposal.hunks.some(h => h.flags.includes('owner-annotation')) }
}
```

anchor 严格按 §7.9 位置→唯一/多处精确→点批注→模糊→orphan 顺序；模糊窗口长度 ±20%、范围 ±(2000+length)、相似度 0.8、上下文至少一侧 0.6，使用带阈值和两行缓冲的 Levenshtein，避免完整矩阵。多候选固定先相似度、再离 start 距离、再位置排序，禁止浮动结果。

- [x] **Step 4：补中文/emoji 坐标、重复引文消歧、上下文不足 orphan、clean 后点批注位置、rebase 冲突不自动选 ours/theirs，运行整个目录。**
- [x] **Step 5：精确提交本任务文件。** `git commit -m "feat(share): share annotation anchoring and draft rebase kernel"`。

## Task 5：纯净性守护与内核包验收（WP0.1）

**Files:** Create `scripts/check-share-merge-purity.mjs`、`scripts/check-share-merge-purity.test.ts`；Modify `package.json`、两份 CHANGELOG。

**Interfaces:** 脚本默认扫描 `src/lib/share-merge/`；接受一个测试用目录参数；违规退出码 1，正常 0。使用现有 TypeScript compiler API 解析，不用正则假装完整检查。

- [x] **Step 1：临时目录内写故意违规样本，测试脚本拒绝直接、动态、require 和目录外依赖，并拒绝 DOM、Svelte 与宿主 API。**

```ts
// test 使用 mkdtempSync/writeFileSync/spawnSync，并在 afterEach 中 rmSync 自己的临时目录。
writeFileSync(join(dir, 'bad.ts'), "import { invoke } from '@tauri-apps/api/core'\n")
expect(spawnSync(process.execPath, ['scripts/check-share-merge-purity.mjs', dir]).status).toBe(1)
writeFileSync(join(dir, 'bad.ts'), 'export const value = 1\n')
expect(spawnSync(process.execPath, ['scripts/check-share-merge-purity.mjs', dir]).status).toBe(0)
```

- [x] **Step 2：运行 `pnpm exec vitest run scripts/check-share-merge-purity.test.ts` 确认红测试。**
- [x] **Step 3：实现扫描与构建接入。** 递归本目录 TS 文件；处理 import/export-from、import()、require；允许目录内相对路径和 type import；拒绝逃出内核及未允许包。按标识符 AST 检查 `window/document/HTMLElement/Node/DOMParser/navigator/localStorage/indexedDB` 等 DOM/宿主全局，type-only 声明也不能依赖 DOM 类型。

```json
{
  "build": "node scripts/check-share-merge-purity.mjs && vite build && node scripts/check-editor-kit-build.mjs",
  "check:share-merge": "node scripts/check-share-merge-purity.mjs"
}
```

- [x] **Step 4：WP0.1 验收。** 运行 `pnpm test`、`cargo test --manifest-path src-tauri/Cargo.toml`、`pnpm --dir worker test`、`pnpm build`，记录全量输出/退出码；确认 K1–K19 均有用例，500 例保真运行完成。已有失败要定位并单独报告，不能把本包标记完成。Task 6 引入 Rust 版本常量后，在本脚本增加 TS/Rust 内核版本一致性检查及故意错版本自测。
- [x] **Step 5：更新双语未发布条目，精确提交脚本、package.json 与 CHANGELOG；完成规格审查与质量审查后进入下一包。** 提交信息：`build(share): enforce pure merge kernel boundaries`。

## Task 6：本机元数据与安全审阅 op（WP0.2）

**Files:** Modify `src-tauri/src/project_share.rs`、`src/lib/project-share/types.ts`；Rust 测试留在既有 `tests` 模块。

**Interfaces:**

```rust
// ReviewDraft 不加 rename_all，IPC 字段按 snake_case。
pub struct ReviewDraft {
    pub kernel_version: u32,
    pub ours_hash: String,
    pub hunks: BTreeMap<String, serde_json::Value>,
    pub target: Option<String>,
    pub updated_at: String,
}
pub struct HunkSummary { pub accepted: u32, pub total: u32 }
// 新方法与分发字段：
// review_save(id, submission, path, draft) -> Result<LocalFeedback>
// annotation_decide(id, submission, index: usize, value: &str) -> Result<LocalFeedback>
// apply(..., content, summary: Option<HunkSummary>) -> Result<LocalFeedback>
// reject(..., path, reason: Option<&str>) -> Result<LocalFeedback>
```

调用旧 apply/reject 的 Rust 测试显式补 `None`；现有 IPC 未传 summary/reason 时默认 None。LocalFeedback 增字段采用 spec §6.4，所有新增可选/集合字段加 serde(default)。保留 v1 ProjectFeedback，不在本包引入 payload enum。

- [x] **Step 1：先写真实 fixture 红测试。** 复用现有 `fixture()`、`freeze()`、`envelope()`，不伪造 Rust API。

```rust
#[test]
fn project_share_review_parent_is_last_successfully_published_snapshot() {
    let (_t, s, p) = fixture();
    let first = freeze(&s, &p);
    assert_eq!(first.schema_version, 2);
    assert!(first.parent_snapshot_id.is_none());
    s.bundle(&p.project_id, &first.snapshot_id, "first bundle").unwrap();
    s.published(&p.project_id, &first.snapshot_id, "https://share.example/project").unwrap();
    let abandoned = freeze(&s, &p);
    let next = freeze(&s, &p);
    assert_eq!(next.parent_snapshot_id.as_deref(), Some(first.snapshot_id.as_str()));
    assert_ne!(next.parent_snapshot_id.as_deref(), Some(abandoned.snapshot_id.as_str()));
}

#[test]
fn project_share_review_draft_roundtrips_without_writing_source() {
    let (_t, s, p) = fixture();
    let snapshot = freeze(&s, &p);
    s.feedback(&p.project_id, envelope(&p, &snapshot, "review1")).unwrap();
    let source = Path::new(&p.source_root).join("README.md");
    let before = std::fs::read(&source).unwrap();
    let draft = ReviewDraft { kernel_version: 1, ours_hash: sha256_hex(&before),
        hunks: BTreeMap::new(), target: None, updated_at: "2026-10-12T08:00:00Z".into() };
    s.review_save(&p.project_id, "review1", "README.md", draft).unwrap();
    let inbox = s.inbox(&p.project_id).unwrap();
    assert_eq!(inbox[0].review["README.md"].kernel_version, 1);
    assert_eq!(std::fs::read(source).unwrap(), before);
}
```

- [x] **Step 2：运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib project_share_review_`，确认字段/方法缺失失败。**
- [x] **Step 3：实现结构与方法。** snapshot 新写 schemaVersion 2；parent 取冻结时已成功发布的 config，createdAt 使用已有 chrono 的 `Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)`；baseline 只读 1/2，拒绝未知 schema。ReviewDraft 大小用 serde_json::to_vec 完整字节；核验 kernel_version、path 属于 edits、target∈None/worktree/branch/patch；hunks 只存为不透明 JSON。Rust 定义 `const MERGE_KERNEL_VERSION: u32 = 1;`，检查脚本读取并与 TS 常量比较，防止升级后两端错配。

```rust
if serde_json::to_vec(&draft).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
    return Err("review draft too large".into());
}
if draft.kernel_version != MERGE_KERNEL_VERSION {
    return Err("kernel version mismatch".into());
}
// apply 扩展只放宽范围，不改变终态幂等保护。
let in_feedback = f.envelope.payload.edits.iter().any(|e| e.path == path)
    || f.envelope.payload.annotations.iter().any(|a| a.path == path);
if !in_feedback { return Err("no edit or annotation for this file".into()); }
```

所有新方法按既有锁顺序执行 `self.lock()`、binding、`self.active(&b)?`、可信反馈验证、读写 inbox；禁止方法之间重复加锁。`self.lock()` 是 records 文件锁，分发层 Mutex 同样保留。新增 op 参数必须反序列化验证；不能用 and_then 把非法参数静默当成 None。annotation-decide 只接受 promoted/dismissed，越界返回规定前缀；它本身不写源。summary 必须 accepted≤total，进入持久化 Decision 后再写源；成功/恢复为 accepted 或 mirror_pending 后清掉 review[path]，pending/source_changed/recovery_conflict 保留审阅草稿。reject reason 只允许 None/superseded。

- [x] **Step 4：覆盖全部 WP0.2 用例与安全边界。** v1 JSON 去掉所有新增键后仍可读；1 MiB 精确边界、中文 UTF-8 超限、非法版本/path/target/annotation index/value、删除中的项目；annotation-only apply；原件 CAS 失败不写；重复 apply 保留幂等；write 后恢复保留 summary；reject reason 落盘。使用 `serde_json::to_value` 断言 review 的 snake_case 与 Decision 的 hunkSummary，防止 IPC 错配。
- [x] **Step 5：定向测试通过后，连同 Task 7 一起完成 WP0.2 的全量检查和提交。** manifest v2 与公开字段剔除必须同一工作包交付，避免可发布的中间状态泄露元数据。

## Task 7：公开快照投影与宿主接口（WP0.2）

**Files:** Modify `src/lib/project-share/{types,host,bundle}.ts` 及既有 `.test.ts`、`scripts/check-share-merge-purity.mjs` 及自测、两份 CHANGELOG；检查 `archive.test.ts`。

**Interfaces:** 本机 ProjectSnapshot schemaVersion `1 | 2`，新增可选本机字段；公开 `PublicProjectSnapshot` 固定 schemaVersion 1，只带既有公开字段。新增封装函数如下：

```ts
export const saveProjectReview = (project_id: string, submissionId: string, path: string, draft: ReviewDraft) =>
  projectCommand<LocalFeedback>('review-save', { project_id, submissionId, path, draft })
export const decideProjectAnnotation = (project_id: string, submissionId: string, index: number, value: 'promoted' | 'dismissed') =>
  projectCommand<LocalFeedback>('annotation-decide', { project_id, submissionId, index, value })
```

- [x] **Step 1：先写公开页面不泄露测试。**

```ts
it('projects local snapshot metadata out of the public payload', () => {
  const snapshot: ProjectSnapshot = { schemaVersion: 2, project_id: 'p', snapshotId: 's', entry: 'a.md',
    files: [{ path: 'a.md', hash: 'h', bytes: 1, markdown: 'A' }],
    parentSnapshotId: 'private-parent', createdAt: '2026-10-12T08:00:00Z',
    git: { snapshotCommit: 'private-oid', headAtFreeze: 'private-head', prefix: '', repoRoot: '/private/repo' },
    gitError: 'private-error' }
  const html = buildProjectBundle(snapshot, 'https://share.example/feedback/p')
  const encoded = html.match(/<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/)![1]
  const payload = JSON.parse(encoded)
  expect(Object.keys(payload.snapshot).sort()).toEqual(['entry', 'files', 'project_id', 'schemaVersion', 'snapshotId'])
  expect(payload.snapshot.schemaVersion).toBe(1)
  for (const secret of ['private-parent', 'private-oid', 'private-head', '/private/repo', 'private-error']) expect(html).not.toContain(secret)
})
```

- [x] **Step 2：运行 `pnpm exec vitest run src/lib/project-share/bundle.test.ts src/lib/project-share/host.test.ts`，确认泄露回归先红。**
- [x] **Step 3：显式构造公开投影，序列化它而非原 snapshot。** files 也按白名单构造 `path/hash/bytes/modifiedAt/markdown/dataUrl`；不能 spread 整个对象。不更改冻结源字节或既有正文主题渲染。

```ts
const publicSnapshot: PublicProjectSnapshot = {
  schemaVersion: 1, project_id: snapshot.project_id, snapshotId: snapshot.snapshotId,
  entry: snapshot.entry,
  files: snapshot.files.map(({ path, hash, bytes, modifiedAt, markdown, dataUrl }) =>
    ({ path, hash, bytes, modifiedAt, markdown, dataUrl })),
}
// 原 payload 的 snapshot 值改为 publicSnapshot，其余字段保持原行为。
```

- [x] **Step 4：host 封装红绿测试核对实际 IPC request 字段；对 source 与 legacy archive 都运行现有 ZIP 测试，确认没有本机字段；旧分享页面与发布冻结/续传测试保留。**
- [x] **Step 5：更新双语未发布条目。** 中文为「项目分享开始保存逐处审阅进度，重开后可继续处理；历史分享与反馈保持兼容。」英文为对应用户描述。
- [x] **Step 6：WP0.2 运行 §17 四项全量检查、`pnpm check`、`git diff --check`。** 对照 Task 6 的旧数据与写回恢复证据审查后，精确提交 Task 6/7 文件；提交信息 `feat(share): persist local review drafts with private snapshot lineage`。

## Task 8：审阅状态机与大文件调度（WP0.3）

**Files:** Create `src/lib/project-share/{review.svelte.ts,review.test.ts,merge-worker.ts,merge-client.ts,merge-client.test.ts}`；Modify `host.ts` 必要类型封装。

**Interfaces:** 状态机通过依赖注入调用真实 IPC、tab 保护和确认框，UI 不持有第二份算法。

```ts
interface ReviewDependencies {
  command<T>(op: string, args: Record<string, unknown>): Promise<T>
  prepareSource(sourcePath: string): Promise<void>
  refreshSource(sourcePath: string): Promise<void>
  confirmWrite(input: { path: string; current: string; result: string; pendingTheirs: number; pendingAnnotations: number }): Promise<boolean>
  compute(input: MergeInput): Promise<MergeProposal>
}
// createProjectReview(projectId, deps) 返回响应式 session，提供：
// open(feedback,path), decide(hunkId,decision), acceptAll(), stageAnnotation(index),
// dismissAnnotation(index), writeFile(), flush(), destroy()。
```

- [x] **Step 1：写 R1/R3/R4/R5 与取消确认、项目切换、销毁保存测试。** mock IPC 返回真实 ReviewFile/LocalFeedback；fake timer 验证 500ms 保存；两提交写同文件后第二份重新取 current；apply 返回 source changed 后仅刷新，不自动再次 apply。

```ts
// 在 review.test.ts 的依赖夹具中记录 command 调用：
expect(calls.filter(c => c.op === 'apply')).toHaveLength(1)
expect(calls.at(-1)?.op).toBe('review')
expect(session.notice).toContain('原件已变化')
// 新提案与旧决定 kind 不符时，该决定进入失效计数，不能继续自动接受。
```

- [x] **Step 2：运行 `pnpm exec vitest run src/lib/project-share/review.test.ts src/lib/project-share/merge-client.test.ts`，保存红证据。**
- [x] **Step 3：实现顺序与防抖保存。** open 时先保存对应源/镜像脏 tab，再调用 review，计算提案，按 kernel_version/hunk ID/kind 恢复决定。每次操作 500ms 后保存；离开文件/项目或销毁前 flush。用递增 generation 丢弃旧计算结果；写入中锁住导航与决定，保存失败明确提示，不宣称已保存。

```ts
const bytes = (input: MergeInput) => new TextEncoder().encode(input.base + input.ours + input.theirs).byteLength
// merge-client.ts：≤256KiB 直接调用同一个 propose；更大则通过 './merge-worker?worker' 的 Vite worker 构造器执行。
// worker message = { id, input }，reply = { id, proposal } 或 { id, error }。
// 失败保留决定并显示错误；不退回主线程执行大型输入。
```

执行补充（2026-10-12，基于 Task 4 实测）：512 单位模糊引文在高字符重合输入上可耗时约 1.7 秒。所有批注定位由同一 merge Worker 异步批处理，保留原批注 index、按版本缓存、丢弃/取消过期批次；不改变内核阈值，不在失败后退回主线程。正文 compose 后再次异步重锚，提升文本构造归本状态机，Task 9 只负责展示和集成验证。

writeFile 顺序：prepareSource → 重新 review/compute → 沿用合法决定 → compose → 拦截 pendingConflicts → 重锚已选批注并构造一次最终文本 → 展示当前原件到最终文本完整 diff → 确认未决数量 → apply(expectedHash=currentHash, content, summary) → 持久化 promoted 状态 → 安全刷新源/镜像 tab → 刷新同 path 其他待审提案。纯拒绝且无提升时调用 reject，不用 apply 写相同内容伪装接受。首次 open 先 review 获取可信 sourcePath，再 prepareSource，再次 review 取得保存后的原件；不能从访客 path 猜绝对源路径。

- [x] **Step 4：测试 Worker 的 256KiB 两侧精确边界、request ID/乱序/错误/销毁；测试 CAS 失败不重试写入、原件已变导致决定失效、纯批注文件可审阅、accepted/mirror_pending 不重复 apply、状态保存失败仅重试 annotation-decide。**
- [x] **Step 5：精确提交本任务文件。** `git commit -m "feat(share): coordinate review decisions and safe apply"`。

## Task 9：逐处 UI、批注提升与安全渲染（WP0.3）

**Files:** Create `src/components/project-review/*`（文件地图所列组件/渲染器/测试）；Modify `package.json`、`pnpm-lock.yaml`、`ProjectShareDialog.svelte` 及既有测试、`src/lib/tabs.svelte.ts` 与 `src/lib/tabs.test.ts`。

**Interfaces:** `ProjectReview` 接受 `{projectId, feedback, prepareSource, refreshSource, onUpdated}`；列表只展示 LocalFeedback；HunkView 不写 IPC；AnnotationPanel 把选择回交 session；ConflictEditor 输出 §7.7 HunkDecision。P1 前不渲染 GitTargetBar。

- [x] **Step 1：按 spec 增加依赖并锁定，不升级既有包。** 执行 `pnpm add dompurify`、`pnpm add -D @testing-library/svelte`。检查 diff 只含两个依赖及其必要锁条目。组件测试使用 `// @vitest-environment happy-dom`。
- [x] **Step 2：写 R2/R6–R10 红测试。** 实际点击接受全部、单独确认风险、冲突手改、未决冲突阻断、提升/忽略；输入框内快捷键无效；被删除或移出范围的文件禁止写回，允许复制/拒绝。

SubmissionList 按待审/部分/已处理/隔离分组；P0 没有 supersedes 行为，不伪造已取代分组。AnnotationPanel 按重锚后的当前位置排序，orphan 单独分组。按文件视图聚合同 path 的待审提交并依次处理。快捷键为 j/k 切换、a 接受、r 拒绝、e 编辑、⌘↩ 写回；输入框、textarea、contenteditable 内全部禁用。

```ts
import { render, fireEvent } from '@testing-library/svelte'
import { expect, it, vi } from 'vitest'
import HunkView from './HunkView.svelte'

it('requires an explicit action for a visitor hunk', async () => {
  const onDecide = vi.fn()
  const p = propose({ path:'a.md', base:'甲。', ours:'甲。', theirs:'乙。' })
  const view = render(HunkView, { hunk: p.hunks[0], decision: undefined, onDecide })
  expect(onDecide).not.toHaveBeenCalled()
  await fireEvent.click(view.getByRole('button', { name:'接受' }))
  expect(onDecide).toHaveBeenCalledWith(p.hunks[0].id, { kind:'theirs-only', choice:'accept' })
})
```

- [x] **Step 3：运行组件与 render 红测试。** `pnpm exec vitest run src/components/project-review src/components/ProjectShareDialog.test.ts`。
- [x] **Step 4：实现统一 diff 与安全预览。** 源码 diff 用 Svelte 文本插值；词级高亮只影响展示，不进入 compose；hidden chars 显示 code point。渲染 diff 复用 `src/lib/plugins/host-render-html.ts` 的 `renderTabBody`，关闭图表脚本执行；raw HTML 使用 sanitizeHtml 预清洗，完整结果再经 DOMPurify；处理资源后才输出受控 HTML。不调用会保留远程 img 的 renderProjectPresentation，也不调用涉及 live staging 的 renderDiagramsToString。

```ts
// render.ts：浏览器宿主专用，不可被 share-merge import。
const markdownHtml = await renderTabBody(
  { kind: 'markdown', currentContent: text, language: '' },
  { sanitizeHtml: html => DOMPurify.sanitize(html) },
)
const fragment = DOMPurify.sanitize(markdownHtml, {
  RETURN_DOM_FRAGMENT: true,
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'link', 'base', 'form', 'video', 'audio', 'source'],
  FORBID_ATTR: ['style', 'srcset', 'ping', 'autofocus'],
})
// 对 fragment 内 img 一律移除 src，换成带 URL 的占位；仅用户点击后才验证 http(s) 并加载。
// a.href 只保留批准的 http(s)/文内链接，统一 noopener noreferrer；通过宿主 opener 在外部浏览器打开。
```

不要先把未处理 HTML 放入活 DOM 再移除图片。测试脚本、onerror、javascript/data 链接、SVG/MathML、srcset、CSS URL、跟踪像素；清洗输出不含活动远程资源，默认没有 fetch。主人可逐个加载远程图片，文案显示目的 URL。

- [x] **Step 5：接入并验证状态机的批注提升。** 文本构造由 Task 8 单一状态机实现，界面只派发选择，按以下完整要求做 UI/集成验证：对访客评论和自报名字分别调用已有 `sanitizeNote`，避免名字中的 CriticMarkup 终结符破坏结果；精确/fuzzy 才可提升，orphan 仅复制/忽略。锚定到当前原件，重叠 owner CriticMarkup 时在区间末尾插入点批注；多条提升从大 offset 向小 offset 应用，顺序固定；先合入正文，再对最终文本重新锚定所选批注，不拿旧坐标直接插入。

```ts
const safeName = sanitizeNote(name || '访客')
const safeComment = sanitizeNote(comment)
const markup = overlappingOwnerNote
  ? `{>>${safeName}：${safeComment}<<}`
  : `{==${selectedText}==}{>>${safeName}：${safeComment}<<}`
```

批注属于 OKF 信任字段的选文时不在 YAML 内插 CriticMarkup，显示「需手工处理」并允许复制，不产生未经确认的信任字段改变。确认 diff 包含所有提升插入。新 Markdown 写入点按 CLAUDE/OKF 约束核查，此处只经现有 apply 修改既有原件，不另建知识文件。

- [x] **Step 6：接入 dialog 与安全重载。** 保留分享标题、主题、创建/删除、上传进度与发布按钮全部既有行为，仅替换审阅区。父层传入 prepareBuffers/安全刷新回调；保持 modal-focus；弹层使用全局 menu-panel/menu-row，普通持久列表保持既有浅灰 hover。

给既有 `reloadTabFromDisk(path)` 增加可选 `options?: { expectedContent: string }`，旧调用行为不变。分享回调先 flush 目标 tab；dirty 则不 reload，提示磁盘已变；否则捕获 currentContent 并带 options 调用。**异步读取后、给 tab 赋值前**再次检查；避免检查后用户输入被覆盖。

```ts
// reloadTabFromDisk 内，完成 readMd/stat/hash 后、设置 initialContent/currentContent 前：
if (options && (t.currentContent !== options.expectedContent || isDirty(t.id))) {
  t.externalState = 'changed'
  t.externalBannerDismissed = false
  return
}
```

在 tabs.test.ts 用 deferred readMd：启动带保护的 reload，读取尚未完成时修改 currentContent，释放读取后断言新输入/initialContent 未被覆盖且 externalState 为 changed。再测试正常 clean 重载与原有无 options 行为。组件测试验证 dirty 镜像与原件均不被强制重载；浏览器验收验证远程图默认零请求、明确点击后只加载所选图片。
- [x] **Step 7：运行定向测试、`pnpm check`；人工验收键盘/焦点/滚动/深色/菜单 hover；只在相关差异上修复。**
- [x] **Step 8：精确提交组件、dialog、依赖与测试。** `git commit -m "feat(share): review suggestions and annotations hunk by hunk"`。

## Task 10：P0 全流程验收、双阶段审查与交付

**Files:** Modify 两份 CHANGELOG、本计划、`tasks/todo.md`；仅修复验收发现的本轮问题。

**Interfaces:** 无新增产品接口。输出实际运行日志、P0 覆盖矩阵与尚未实施阶段列表。

- [ ] **Step 1：补真实本地集成 fixture。** 两篇互引 Markdown、一张图片；分别冻结 S1、发布成功、冻结未发布快照、发布 S2；导入一份基于 S1 的 v1 反馈，包含正文和批注；原件同时修改另一句。实际审阅接受指定 hunk/批注，一次 apply 后断言原件保留主人修改、镜像一致、未分享文件字节不变，重开决定保留。再导入第二份相同改动，已接受部分为 both-same。

```ts
// review.test.ts 对真实 kernel + mock IPC 的最终内容验收；Rust 单测独立证明实际文件 CAS/恢复。
const p = propose({ path:'a.md', base:'甲。乙。丙。', ours:'甲改。乙。丙。', theirs:'甲。乙改。丙。' })
const result = compose(p, acceptUnconflicted(p))
expect(result.text).toBe('甲改。乙改。丙。')
expect(result.pendingConflicts).toEqual([])
```

- [ ] **Step 2：以真实宿主或本地开发构建跑完整审阅 UI→真实 IPC→磁盘功能验收。** 验证未保存原件/镜像 tab 的保存顺序、取消确认、CAS 横幅、重新打开、批注提升、原项目删除/范围变化、对话框项目切换。记录真实操作与结果；DOM mock 不能代替 Tauri 文件/IPC 验收。 可使用隔离 Wry/WKWebView 内的真实 UI 自动化驱动，且不得 mock Tauri bridge、文件或 Rust dispatch。OS 级人工鼠标、焦点和原生截图另列验收项；环境不可用时明确标未验证，不用浏览器 mock 或截图补盖。

执行裁定（Task 10 I1）：原计划限定“手动”，比 spec §17 WP0.3 的 R1–R10 功能测试更强；spec 明确人工输入法要求位于本轮排除的 E1。CUA 对独立验收应用的精确 ID 与 .app 路径均 cgWindowNotFound 后，本轮采用已跑通的真实 Wry UI/IPC/磁盘验收，并保留 OS 人工交互与原生截图未验证边界，不宣称人工通过。
- [ ] **Step 3：完成规格审查，再完成代码质量审查。** 子代理只读审查，以 spec 与该任务文字为输入；发现问题回交原实现者，修复重测。root 本计划自审不委派。禁止在共享 main 上让两个实现者同时修改 `project_share.rs`/`types.ts`/dialog。
- [ ] **Step 4：更新双语用户条目。** 中文：「项目分享支持逐处接受、拒绝与编辑外部修改；原件后续修改可与建议对照合并。批注可审阅后提升为原文批注，审阅进度会自动保存。」英文说明对应行为，不写“自动采纳”。
- [ ] **Step 5：执行完整验收命令，逐个检查退出码。**

```bash
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm --dir worker test
pnpm check
pnpm build
git diff --check
```

四项 spec 全量命令不以定向测试代替。环境失败先定位；在证据中明确未执行/失败/通过，不能修改测试阈值或跳过用例让工作包看似完成。测试前确认磁盘空间，不创建多个临时 target；共享现有依赖与构建目录。

- [ ] **Step 6：逐项核对完成矩阵。** K1–K19、R1–R10；I1–I8/I12–I14 的 P0 部分；旧 v1 反馈/manifest/inbox/分享页面兼容；公开投影；CAS/recovery；远程资源无自动请求；两个 CHANGELOG；真实 Wry UI/IPC 功能验收与 OS 人工检查边界。I9–I11 在 P0 无 Git 新行为，P1 再增加真实 Git 集成证明。
- [ ] **Step 7：精确提交本轮文档与验收修复，交付 main 提交与证据。** 不把 P1/P2/E1–E4 标记完成，不部署或发布；用户请求发布时再执行完整发布盘点与线上核验。

## 计划自审记录

- 覆盖：P0 每个 WP 均有任务；K19 虽未列入 WP0.1 的简写 K1–K18，也在 Task 4 实施；后续规范章节在阶段表全部有归属。
- 一致性：propose 保持同步；hash 内部纯 TS；坐标 UTF-16；ReviewDraft snake_case 与 Decision camelCase 分开；v1 payload 到 P2 前不改。
- 安全接缝：manifest v2 与公开白名单同包；一次 apply 合成正文/批注；保留原件/镜像脏 tab 保护、CAS、恢复与终态幂等。
- 未执行声明：这是实施计划；代码片段为待实现的测试/接口契约，未运行这些未来测试，不表示产品功能已完成。

## 执行交接

选择其一后实施 P0，每个任务先红后绿并审查：

1. **Subagent-Driven（推荐）**：新子代理逐任务实现，规格审查通过后再进行质量审查；共享 main 中的写任务顺序执行。
2. **Inline Execution**：本会话使用 executing-plans，分批执行并在规定检查点汇报。

用户的「不要开 worktree」持续有效，两种方式都在当前 main 执行。
