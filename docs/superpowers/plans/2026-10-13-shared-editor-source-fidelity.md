# Shared Editor Source Fidelity — Source Mapping Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付共享编辑器保真的第一个可验收切片：从真实解析过程获得普通段落的源码来源映射，以真实文本事务局部改写原文，并证明决定性单字反例不再漂移。

**Architecture:** 在共享 Moraya 内核建立显式源码会话，复用既有 Markdown 语法，从 tokenizer 与 PM 构造过程捕获来源。文本事务将 PM 范围映射回原文并局部 splice，以重解析验证语义；不比较 canonical 输出过滤格式差异。本计划不接入正式保存出口，先证明来源映射可行；通过后连续规划并实施完整语法、格式与历史、Source、Kit 和桌面消费接入，再交付网页 E1–E3 与桌面 E4。

**Tech Stack:** TypeScript、ProseMirror、markdown-it、@moraya/core、Vitest、Playwright、Svelte。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.4、§13、§21；用户 2026-10-13 已授权增加共享编辑器保真前置，再完成两端协作。

## Global Constraints

- 硬约束 I7：未改的 Markdown 原文保持字节不变；不得事后过滤格式差异绕过。
- 富文本与源码切换三次，未编辑输出零 diff；段落内只改一个字，propose 恰好一个 hunk 且只覆盖该句。
- 测试覆盖 §12.4 全部语料；保留 CRLF、BOM、无末尾换行。
- 继续当前 main，不开 worktree；只允许一个产品写入者。
- 不默认降级源码编辑，不增加在线协作数据库，不改变已发布 P2 协议。
- 新能力目前只通过显式 preserveSource 选项启用；现有默认消费者保持原有 canonical 行为，完整前置通过前不切换正式保存出口。
- Core main entry gzip 不得超过 81,920 bytes；不得引入 Node、CommonJS、Tauri 或其他宿主依赖。
- 使用已安装的 Vitest、TypeScript、tsup 直接执行；不为验证升级包、运行 approve-builds 或创建 core 发布 tag。

## 基线与交付边界

- mdeditor：`15aa11a2a807a833e6b9a3056e4dbb3b6f35869f`；moraya-core main：`1cb70441f440f50ac4b023857f6d48d5b70eda5a`，开始时干净。
- 当前真实 Chromium 140.0.7339.16 再次复现单自然段一字修改得到两个 hunk；18 语料、0 pageErrors。共享内核现有 21 文件 / 261 项测试全部通过，但不覆盖 I7。
- 原始输入：`这是甲句。中间句保持。末句保持 _斜体_ 与 [链接](<https://example.com>)。`；目标只将第一处甲改乙，PM 仍为同一个自然 paragraph。
- 此切片只解锁后续实现，不等于完整 §12.4 通过；正式保存、Kit/CDR、E1/E4 不得依赖尚未完成的能力。
- 现有 `parseMarkdown`、`serializeMarkdown` 的 canonical 契约保持；新增显式 API 不以全局隐式缓存改变旧调用含义。

## 后续连续交付与已知缺口

此切片完成后，依据实际映射结果制定下一个独立计划，不重新请求已经给出的实施授权。后续必须逐项闭环：13 类语法及结构/引用依赖；主动格式操作与来源历史；Source 的 CRLF/BOM/原生 undo；桌面 BOM 读取边界；Kit 的 source-only 修订、governed history、ack/remote/recovery；桌面全部输出出口；两端真实 UI 字节验收；E1–E3 与 E4 的产品功能；统一发布审计与线上核验。完整任务仍在 `tasks/todo.md` 跟踪，任何切片验收不能将这些项目标为完成。


---

### Task 1: 普通段落来源映射与真实 Kit 局部文字替换垂直切片

**范围冻结**：新增试验能力，不切换生产默认行为，不改旧 parseMarkdown/serializeMarkdown 的输出契约。仅支持一个自然 paragraph，其行内为 plain text、em/strong、inline link、entity、escape；源码外围 BOM/空白可原样保留。无内部换行；CRLF 工作文本转换、列表、表格、数学、footnote、HTML、CriticMarkup、reference link、code、结构/mark操作、history 均明确留后续任务。本任务不能宣称完整 I7。

**实证**：本 workspace `source-map-rule-probe.mjs` 已实际执行，通过 5 例；使用安装的 markdown-it 与 prosemirror-markdown 的原始 rules，不改 node_modules、不 vendor parser。包装成功消费规则、pending flush、fragments_join/text_join；在真实 ParseState stack 读 PM cursor，并逐例与 Moraya 原 parser `.eq`。涵盖三句、重复甲、entity/escape/emoji、单句、嵌套 emphasis/link。产物 `source-map-rule-probe.json`。它证明捕获策略可行，未证明挂入 Moraya 现有私有 parser 后所有插件兼容。

#### Files and Interfaces

- 新增 `/Users/bruce/git/moraya-core/src/source-fidelity.ts`：纯会话/局部替换，明确试验范围；不涉及 DOM、CDR、history。
- 修改 `moraya-core/src/markdown.ts`：内部捕获 hook；现有 md 配置、parser handlers 与原公共 API 保留；捕获关闭时走原逻辑。
- 修改 `moraya-core/src/index.ts`：仅导出新增明确试验 API/类型。
- 新增 `moraya-core/src/__tests__/source-fidelity.spec.ts`：下面定向测试。
- 修改 `mdeditor/src/editor-kit-v2/contract.ts`、`main.ts`，新增 `source-fidelity.ts`：真实 opt-in 保真能力入口，默认关闭；现有消费者暂不启用。
- 当前 workspace 增真实 Kit 定向 harness（从 check-current-baseline.mjs 缩到决定性三句一例），保留原 fresh baseline 不覆盖。

固定最小 API（不预造通用 shell/history 框架）：

```ts
// source-fidelity.ts
import type { Node as PmNode, Schema } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
export type TextSourceSpan = Readonly<{
  sourceFrom: number; sourceTo: number
  pmFrom: number; pmTo: number
  kind: 'linear' | 'atomic'
}>
export type SourceSession = Readonly<{
  revision: number; source: string; doc: PmNode
  textSpans: readonly TextSourceSpan[]
}>
export type FidelityFailure = Readonly<{
  ok: false
  reason: 'unsupported-source' | 'parse-error' | 'stale-document'
    | 'unsupported-step' | 'unmapped-range' | 'semantic-mismatch'
}>
export type FidelityResult = { ok: true; session: SourceSession } | FidelityFailure
export function createSourceSession(source: string, schema?: Schema): FidelityResult
export function applySourceTextTransaction(base: SourceSession, tr: Transaction): FidelityResult
```

调用者原文仍由输入/旧 session 持有；失败结果不提供新输出，不修改 base。Task1 一个事务仅一个普通文本 ReplaceStep；多步事务明确返回 unsupported-step，后续独立任务扩展。不接受 stale PM doc，即使语义相等之外的位置偶然同样有效。

`markdown.ts` 的内部 hook（不从 index 导出）：

```ts
export type CapturedTextRun = {
  sourceFrom: number; sourceTo: number; pmFrom: number; pmTo: number
  kind: 'linear' | 'atomic'
}
export type CapturedParagraph = {
  doc: PmNode; textRuns: CapturedTextRun[]
}
export function parseParagraphWithSourceCapture(
  source: string, schema?: Schema,
): { ok: true; value: CapturedParagraph }
 | { ok: false; reason: 'unsupported-source' | 'parse-error' }
```

此 hook 复用 getParserFor/schema；显式拒绝 unsupported，不调用旧 parseMarkdown 的空文档 fallback。禁止通过全篇 serialize 差异找 ranges。

#### 2. 先建立已有真实 RED

现成可运行命令（根已 fresh 运行浏览器，第一条重跑时会覆写 baseline；实施者复制为 task1 gate harness 再用）：

```sh
node .superpowers/sdd/2026-10-13-shared-editor-source-fidelity/check-current-baseline.mjs
node .superpowers/sdd/2026-10-13-shared-editor-source-fidelity/source-mapping-gate-red.mjs
```

本子任务只执行了第二条：预期 RED，真实 Kit 输出 UTF-8 91 bytes，expected 93 bytes；`_→*`、`< >` 消失。assertion 文件不仅看一个 block.replace，还要求 exact output、恰好一个 hunk、base/theirs/oursStart/oursEnd 只覆盖目标句。后续 GREEN 必须使用启用 preserveSource 的新运行结果，禁止直接修改 JSON。

#### 3. 新 API 精确 RED 测试代码

- [ ] **Step 1: 写定向测试并记录 RED。**

在 `source-fidelity.spec.ts` 写下列测试；先确认因新增能力缺失失败，然后逐项实现。第一次编译缺 API 不是最终行为 RED 的替代，已有 Kit RED 是行为基线。

```ts
import { describe, it, expect } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { parseMarkdown } from '../markdown'
import { createSourceSession, applySourceTextTransaction, type SourceSession } from '../source-fidelity'

function session(source: string): SourceSession {
  const result = createSourceSession(source)
  if (!result.ok) throw new Error(result.reason)
  return result.session
}
function replace(base: SourceSession, from: number, to: number, text: string) {
  const tr = EditorState.create({doc: base.doc}).tr.insertText(text, from, to)
  return applySourceTextTransaction(base, tr)
}
function output(result: ReturnType<typeof replace>) {
  if (!result.ok) throw new Error(result.reason)
  return result.session
}
const THREE = '这是甲句。中间句保持。末句保持 _斜体_ 与 [链接](<https://example.com>)。'

describe('source fidelity ordinary text session', () => {
  it('three sentences: one character splice preserves later syntax bytes', () => {
    const base = session(THREE)
    const next = output(replace(base, 3, 4, '乙'))
    expect(next.source).toBe(THREE.replace('甲', '乙'))
    expect(next.doc.eq(parseMarkdown(next.source, base.doc.type.schema))).toBe(true)
    expect(base.source).toBe(THREE)
    expect(next.revision).toBe(base.revision + 1)
  })
  it('repeated text uses positions, not text search', () => {
    const source = '甲保持。甲修改。末句 _甲_ 与 [甲](<https://example.com>)。'
    const next = output(replace(session(source), 5, 6, '乙'))
    expect(next.source).toBe('甲保持。乙修改。末句 _甲_ 与 [甲](<https://example.com>)。')
  })
  it('entity, escape and emoji before target do not shift its source offset', () => {
    const source = '开头 &amp; \\* 😀甲。末句 _斜体_。'
    const base = session(source)
    // Visible text has decoded '&', escaped literal '*' and a two-code-unit emoji.
    const pmFrom = 1 + '开头 & * 😀'.length
    const next = output(replace(base, pmFrom, pmFrom + 1, '乙'))
    expect(next.source).toBe(source.replace('甲', '乙'))
    expect(next.textSpans.some(s => s.kind === 'atomic')).toBe(true)
  })
  it('replaces a fully selected entity as a single source atom', () => {
    const next = output(replace(session('甲 &amp; 乙'), 3, 4, '和'))
    expect(next.source).toBe('甲 和 乙')
  })
  it('one ordinary word replacement rebuilds mapping for the next edit', () => {
    const base = session('这是甲句。')
    const next = output(replace(base, 3, 4, '丙丁'))
    expect(next.source).toBe('这是丙丁句。')
    expect(output(replace(next, 4, 5, '乙')).source).toBe('这是丙乙句。')
  })
  it('semantic guard rejects unescaped text becoming Markdown syntax', () => {
    const base = session('甲')
    expect(replace(base, 1, 2, '*乙*')).toEqual({ok:false, reason:'semantic-mismatch'})
    expect(base.source).toBe('甲')
    expect(base.doc.textContent).toBe('甲')
  })
  it('rejects mark intent rather than silently returning original bytes', () => {
    const base = session('甲')
    const tr = EditorState.create({doc:base.doc}).tr.addMark(1,2,base.doc.type.schema.marks.em.create())
    expect(applySourceTextTransaction(base,tr)).toEqual({ok:false,reason:'unsupported-step'})
  })
  it('rejects multi-step and stale document without mutating source', () => {
    const base = session('甲乙')
    const tr = EditorState.create({doc:base.doc}).tr.insertText('丙',1,2).insertText('丁',2,3)
    expect(applySourceTextTransaction(base,tr)).toEqual({ok:false,reason:'unsupported-step'})
    const next = output(replace(base,1,2,'丙'))
    const stale = EditorState.create({doc:base.doc}).tr.insertText('丁',2,3)
    expect(applySourceTextTransaction(next,stale)).toEqual({ok:false,reason:'stale-document'})
  })
  it('does not pretend unsupported source has writable exact mapping', () => {
    for (const source of ['* item\n* item2', '```js\n甲\n```', '甲\r\n乙', '$x$', '{>>note<<}']) {
      expect(createSourceSession(source)).toEqual({ok:false,reason:'unsupported-source'})
    }
  })
  it('preserves BOM and outer whitespace when unchanged by parser work normalization', () => {
    const source = '\uFEFF甲 _斜体_  '
    const next = output(replace(session(source),1,2,'乙'))
    expect(next.source).toBe('\uFEFF乙 _斜体_  ')
  })
})
```

实体的多 code-unit decoded token 只允许完整原子或不碰它；跨一半 entity/代理对的 edit 返回 unmapped-range。补一个具名多字符 entity 和 emoji 中间 code-unit range 的拒绝测试。原始 `*`、`&amp;` 位于未改位置的字节应保留。

#### 4. 最小实现算法：以已跑通 probe 为起点

- [ ] **Step 2: 实现 capture 与事务局部输出，逐项验证 GREEN。**

##### 4.1 不包装整套 parser；只安装有开关的 capture wrappers

在 module 初始化、现有插件注册完成后包装已有 rule；`md.core/inline.ruler.at(name, wrapper)` 委托原规则。probe 为快速验证用 `ruler.__rules__.find(...).fn` 取得原函数；正式实现把这种私有访问集中在一个 `wrapRule` helper，找不到规定名称则 capture 不可用/测试失败，普通 parser 保持可运行。禁止到处访问私有字段。

用 `env[privateCaptureSymbol]` 持有每次同步 parse collector，不设全局 active collector。`parseParagraphWithSourceCapture` 调 `p.parse(work,{[symbol]:collector})`；现有 `md.parse` wrapper 已转发 env。每个 token 的来源放 WeakMap `{ collector, runs }`，handler 能从当前 token 定位 collector，普通 parse token 不在 WeakMap 时原样 delegate。不要把来源塞入 PM attrs。

1. 捕获 Moraya preprocess 的结果与 Markdown-it normalize 后的 `state.src`。Task1 要求最终工作文本与 source 严格相同；否则返回 unsupported-source。原文仍在调用者手中。这明确不伪称解决 CRLF/math/smart quote 转换。
2. 在 md.parse 返回 token 流进入 PM 之前，要求恰好 paragraph_open / inline / paragraph_close；inline.content 不含 LF。检查 `source.trim() === inline.content`，来源起点是 `source.length - source.trimStart().length`，终点起点加 content.length。这里只用于一个已识别普通 paragraph 的前后 trivia，不用 trim 后的文本作输出。列表/引用/表格等不能走这个公式。
3. 自定义 InlineState constructor delegate 到原 constructor，仅捕获会话 state 安装 pushPending wrapper。维护 `WeakMap<InlineState, Run[]> pendingRuns`。pushPending 把 pendingRuns 关联到真实返回 text token，再清空。
4. 包装 text rule：记成功消费前 `state.pos`；委托规则；成功且非 silent 时把原 `[from,state.pos)` 原样段追加 pendingRuns。entity/escape rule 成功时把最后 text_special token 关联到整段原子来源（原 source 与 decoded content 的长度可不同）。
5. 包装 emphasis tokenizer：它每个 marker 发一个 token，把最后 `consumedCount` 个 marker token 各挂长度1来源。后续变成 mark open/close 的 token 不再发 text；强标记消耗的空 text token 不进入 text provenance。
6. 增最后 capture fallback rule：仅 capture 会话、非 silent 时，执行与上游 tokenize 默认分支相同的单字符 `pending += src[pos++]` 并记录来源；返回 true。未启用 capture 时返回 false。到 maxNesting 仍可能走原 fallback，映射 completeness 校验将拒绝，不能编造来源。
7. 包装 fragments_join：执行原函数前，按其真实“相邻 text 合并到末 token”的规则把非空各 token 的 runs 拼到存活末 token；再委托原函数。包装 core text_join 做同样操作，但把 text_special 也视为 text。不要根据最终 token.content 在源码中找子串。
8. link rule 自己递归 tokenize(label)：复用同一 state/src，文字范围天然仍是当前 inline.content 的坐标；未改 wrapper/destination 的原文只留在原 source，Task1 不需建立通用 shell AST。只接受显式 inline links，reference/autolink 暂 unsupported；token trace 可由 link rule wrapper识别成功消费的原写法。

##### 4.2 在实际 PM handler 中建立位置

无需构造第二个 PM parser。包装 Moraya text handler；原 handler 会调用 ParseState.addText。对已追踪 token，在调用前后读真实 stack cursor：

```ts
const cursor = (state: any) => state.stack.reduce(
  (n: number, frame: any) => n + frame.content.reduce((sum: number, node: PmNode) => sum + node.nodeSize, 0),
  state.stack.length - 1,
)
```

对于 Task1 单 paragraph，起点为1；文字合并不会改变累计 nodeSize。断言 runs.decodedText 拼接恰等于 token.content；按每个 run.text.length 分配 PM 半开范围，source 坐标加 paragraphSourceFrom。委托原 text handler 后 cursor 应恰前进 text.length。若异常返回 unsupported，不输出貌似正确 map。空 text 跳过；每个实际文本 code unit 必须有来源。PM 最终仅 paragraph 的 text children，marks 仅允许 em/strong/link；其它 token/node/marks 明确拒绝。

新 hook 结果 doc 必须与旧 `parseMarkdown(source,schema)` `.eq`（可作为测试，生产每次二次 parse 不必固定）；当前 parser 自定义 text handler会忽略 mediaSkip，这类输入不在 Task1范围。

##### 4.3 单步 ordinary text patch

1. 校验 `tr.before.eq(base.doc)`；仅一个 `step.toJSON().stepType === 'replace'`。读取该 step 的 from/to 与 slice；要求 slice.openStart/openEnd=0、slice 只有 text、同一个 paragraph 内替换且 marks 没有意外改变。tr.doc 仍是单 paragraph。Task1 无需新增直接 prosemirror-transform 依赖。
2. 将 PM `[from,to)` 投影到 textSpans。linear 边界平移；atomic 边界只接受整个 span。拒绝 UTF-16 surrogate 内边界。跨越 delimiter/source gaps 的范围返回 unmapped-range，避免把 `_`/链接目的地误删。
3. Task1 只 splice 此 source 区间，insert 是 slice 的实际 textContent；不调用 serializeMarkdown。插入特殊文字允许先尝试，后面语义 guard 不通过则明确拒绝。通用上下文转义是后续扩展，不在 Task1 假装实现。
4. 用 createSourceSession(candidate,schema) 重建映射；要求 candidate.doc.eq(tr.doc)。否则 semantic-mismatch，旧 session 完全不变。成功 revision+1。原文整段重解析在这个切片内可接受，输出仍只是一处源码拼接。
5. 原文 `_`/link destination 是没有失效的 source 字节，不是“serializer 和 base 相等时恢复”的结果。

#### 5. 真实 Kit gate：试验接入而非生产默认切换

- [ ] **Step 3: 接入实际 Kit 的显式能力并运行真实输入门槛。**

增加 `MountDocumentEditorOptions.preserveSource?: boolean`，默认 false；它是后续 E1/E4 将使用的真实产品能力选项，不是 test-only seam。本阶段 true 先验证仅一个 snapshot block 且 createSourceSession 支持，其他输入抛明确保真能力未覆盖错误，旧默认 mount 不受影响。后续扩展计划逐步解除限制；不因选项存在便宣称两端可交付。

新增 `source-fidelity.ts` 封装会话与事务适配，main.ts 仅：初始化、在 identity filterTransaction 已追加步骤后预检、Plugin.state.apply 接受同一个 prepared result、draftBlocks 用 保真会话.source。不能在 filterTransaction 就提交 source，因为后续 filter 可能拒绝事务；用 WeakMap<Transaction, PreparedUpdate> 保存候选，只有实际 apply 提交，并校验 base revision。未通过候选直接拒绝该试验事务，不产生写出。

Kit 必须在 mountRich 的 customSchema 已生效、materializeBlocks 完成后，以 rich.view.state.schema 建立 session，不能绑定早先 Moraya 默认 schema或旧 plugins/state。Kit cdrBlockId 是 host attr，核心 session doc 不应比较它。Task1 单块、单文本 ReplaceStep 的 adapter 把实际 tr.steps **按原顺序**应用到 session.doc 新建的 Transaction，然后核对目标 PM（仅清除 cdrBlockId）相等。只清 cdrBlockId，不忽略其他 attrs/marks；slice 含 block/identity step/结构更新一律 保真模式 unsupported。正常单字编辑不需 identity 新增步骤，因 paragraph 身份未变。禁止 `.eq` 整块 canonical fallback。

真实 harness 要求：mount 带 preserveSource:true，使用 DOM 选区 `甲` + `keyboard.insertText('乙')`，从真实 `observeLocalOperations` 和 `surface.getDraftMarkdown()` 读输出，再独立 propose。输出保存 `task1-kit-results.json`，断言代码沿用 source-mapping-gate-red.mjs 但读取新文件。另在保真模式真实输入 '*乙*'（纯文字插入）触发 semantic guard 时，验证 PM doc、source、operation count 都未越过失败边界。不把先丢编辑再返回旧 source 当成功。

`source-mapping-gate-red.mjs` 当前读取 fresh baseline；实施者不应把它改成读取手写 expected。运行新产物前执行 core build 并沿仓库既有同步路径同步 @moraya/core；mdeditor 必须从实际安装的根 API import 新能力，核对 node_modules/@moraya/core 指向及 dist hash，避免验证旧 dist；禁止仅手改 node_modules。core 与 mdeditor 两个仓库独立提交，core 的 tracked dist 与对应源码同一提交。

#### 6. 验证与退出

顺序：定向新测试 RED → parser probe/内部 capture tests → source-fidelity tests GREEN → core 原有 tests/typecheck/build →真实 Kit preserveSource gate →默认未启用 preserveSource 的 Kit 既有回归。core 使用已安装工具直接执行（下方命令），不要安装新包/下载浏览器。

退出需记录：实际加载核心 dist hash、固定三句实际 after bytes、完整 proposal（1 hunk且范围0..5）、真实 Kit操作、0 pageErrors、unsupported拒绝时session/doc一致。默认 API 无行为变化；preserveSource 当前仅在验收 harness 启用，正式消费者在后续覆盖完成后接入。

**后续接口设计承诺，不在本任务实现**：Source 等价格式编辑要形成独立 source revision，不能由 PM.eq 判断；mark steps 即使 map 不移动也必须失效语法壳；undo/redo 必须把来源 payload 与现有 governed history 事件绑定；多 step 坐标按 docs[i]顺序处理；CRLF/BOM工作变换、自然块envelope、全语法/结构/CDR/两端输出由后续独立计划继续。Task1 若无法在真实 Moraya handler 中维持 probe completeness，唯一需要重规划的具体问题是“插件重写 token 后 provenance 如何继承”，以同样5 fixture直接测实际 hook确定，不转向全量 serializer diff过滤。

附证据：`source-map-rule-probe.mjs` / `source-map-rule-probe.json`（本子任务5例实际PASS）；`source-mapping-gate-red.mjs`（本子任务对根fresh baseline实际RED）；`raw-results.json` / `current-gate-baseline.log` / `baseline-source.json`（根fresh真实Kit及仓库指纹）。私有API限制：ruler.__rules__、parser.tokenHandlers、ParseState.stack均非稳定公共契约；以当前安装版本做契约测试，任何形状变化须明确失败，不可静默产生空映射。后续依赖升级需重跑捕获契约与真实 gate。


#### 7. 执行命令、失败边界与精确提交

- [ ] **Step 4: 运行新能力与原有消费者检查，核对实际依赖。**

在 `/Users/bruce/git/moraya-core` 顺序执行并保存原始日志：

```sh
node node_modules/vitest/vitest.mjs run src/__tests__/source-fidelity.spec.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/tsup/dist/cli-default.js
```

构建后沿 mdeditor 已有 `sync:core` 的实际逻辑复制 sibling `dist` 到 `realpath(node_modules/@moraya/core)/dist`，删除且只删除 `node_modules/.vite/deps` 缓存；不得直接编辑安装副本。逐文件 SHA-256 比较 sibling dist 与实际安装物，记录 actual realpath、core commit 及工具版本。

在 mdeditor 顺序执行：

```sh
node node_modules/vitest/vitest.mjs run src/editor-kit-v2
node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json
node scripts/check-share-merge-purity.mjs
node node_modules/vite/bin/vite.js build
node scripts/check-editor-kit-build.mjs
```

新建永久回归 `scripts/check-source-fidelity-browser.mjs`，复用现有脚手架的 `PLAYWRIGHT_MODULE` 外部入口、`configFile:false`、空 `envDir`、本计划 workspace cache/output 参数；不加载真实设置或 Vault。用实际安装的 core API、真实 Kit 与键盘完成一字修改及严格失败边界，运行：

```sh
PLAYWRIGHT_MODULE=/Users/bruce/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs node scripts/check-source-fidelity-browser.mjs
```

真实浏览器回归及单元测试固定原文和目标输出，禁止用被测 serializer 生成 expected。新增 `src/editor-kit-v2/source-fidelity.test.ts`，验证实际带 identity schema 的适配、没有 docChanged 的选区事务、拒绝 mark/multi-step/结构操作、以及后置 filter 拒绝时 source 不前进。

能力失败处理：会话准备必须纯且不修改旧会话；filter 后的实际 transaction 与 prepared candidate 一致才可采用。不要在 filterTransaction 中变更 closure source。任何后续 plugin 拒绝事务、改动 transaction 或遇到不支持的权威 reconcile，都不得安装 source/PM 不一致的状态。首个切片明确不支持有内容变化的远端安装/重排/源码修订；显式 preserveSource 模式对这些调用在改变 snapshot、pending 或恢复元数据之前报清晰能力错误。与当前保真草稿完全一致的 ack 可以处理，并需定向回归证明。正常默认消费者不受该限制。

这不是通用编辑器验收：本阶段允许严格拒绝未支持输入来证明失败时不损坏数据；后续完整前置必须补齐正常编辑矩阵，不能将拒绝普通操作作为最终产品交付。

- [ ] **Step 5: 自审、报告与两个仓库分别提交。**

仅提交本任务的 core 源码、定向测试及其真实构建 tracked dist；不要提交 node_modules。示例精确路径（新 tracked dist 列表以构建实际 diff 为准，先核对后加入）：

```sh
git -C /Users/bruce/git/moraya-core add src/source-fidelity.ts src/markdown.ts src/index.ts src/__tests__/source-fidelity.spec.ts
git -C /Users/bruce/git/moraya-core add -u dist
git -C /Users/bruce/git/moraya-core commit -m "feat(editor): preserve source for mapped paragraph text edits"
git add src/editor-kit-v2/contract.ts src/editor-kit-v2/main.ts src/editor-kit-v2/source-fidelity.ts src/editor-kit-v2/source-fidelity.test.ts scripts/check-source-fidelity-browser.mjs
git commit -m "feat(editor-kit): gate source-preserving paragraph edits"
```

本任务完成后不推送/发布；root 进行独立任务 gate，生成两个仓库范围的完整 diff。报告 `.superpowers/sdd/2026-10-13-shared-editor-source-fidelity/task-1-report.md` 必须包含状态、两个 BASE/HEAD、源码与 dist 精确清单、RED/GREEN 原始日志路径、命令/退出码/测试计数、浏览器版本/实际加载 hash/after UTF-8 字节与完整 proposal、unsupported 边界、自审及剩余缺口。最终只返回简短状态、commits、测试摘要和 concerns。
