# 自然顶层块来源与局部输出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在完整文件来源会话中，优先保留已支持的精确段落 text splice，并为边界稳定的现有自然顶层块增加 mark / inline replacement / 多步事务的局部序列化，未改自然块与原文间隙逐字节不变。

**Architecture:** 根块归属来自同一实际 markdown-it token 的 map 和同一 MorayaMarkdownParser handler 的实际顶层 PM emission；preprocess SourceTrace 将工作坐标投回原始文件。事务按真实每一步的文档、范围和最终 intended doc 确定实际变更的自然 root；只为这些 root 生成分离的 raw edits，随后严格全文重解析验证。Source raw 永远是输出权威，不以 canonical equality 回填整文。

**Tech Stack:** TypeScript、现有 markdown-it 14.1.x / prosemirror-markdown 1.13.x、ProseMirror Transaction、Vitest、tsup、已安装 `@moraya/core` 和现有 share-merge kernel；不引入新包或升级依赖；N2 仅把已安装的 prosemirror-transform 1.12.0 声明为直接 peer/dev 依赖。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.4 / §12.9 / I7；正式前置 `docs/superpowers/plans/2026-10-13-shared-editor-full-document-source.md`；[完整文件验证与已校验研究归档](../reports/2026-10-13-shared-editor-full-document-source-verification.md)。

## 决策、状态与边界

本计划由root完成自审后采纳，接续已验收的完整文件来源计划。产品基线core `4a67ebbff738d00f4761da2ab2acb106b48c8e2c`、host `fbbece090986be1982453eded442d47230d74432`；执行前记录包含文档收口后的实际HEAD。三项前置与唯一finalfix/scoped复审已经通过，不重做。旧按语法精细textspan草稿仅归档参考，本计划优先自然块局部输出。

root 已选择 KISS：I7 保护实际未改自然块；用户已经改动的顶层 list/table 可以局部 canonical serialize 整个自然块。保留已有 paragraph exact splice 才能继续达到普通段落一字一小 hunk；不必先搭建所有 nested/table/literal 的精细 textspan 引擎。

**冻结的 BOM 合同：** 仅 `parseDocumentWithSourceCapture` 工作 trace 删除恰好一个文件首 U+FEFF，原 `session.source` 保留；中间或第二个 BOM 不删除。captured doc 的语义基准为 `parseMarkdown(raw.startsWith('\uFEFF')?raw.slice(1):raw, sameSchema)`。legacy `parseMarkdown` / async / serializer 和纯 `projectLineEndings` 不变；BOM+heading/fence/frontmatter 故意不等于 legacy parse(raw)。未来 preserveSource opt-in 必须 materialize session.doc，当前生产入口不因本稿打开。

**本稿支持集合：** 已存在并保持顶层 child 数量、顺序、类型、attrs 的自然 root；AddMarkStep / RemoveMarkStep，以及两端在同一个实际 inline-content parent、closed inline slice 的 ReplaceStep。一笔事务可有多步，可改多个不相邻 root。root 内 text length 可变，PM 坐标随每步变化。既有 root 内 inline atom 增删可尝试，但仍须来源边界和严格重解析证明。根块插入/删除/split/join、ReplaceAroundStep、node attrs/type 步骤明确拒绝；不借格式化 fallback 宣称任意结构命令可用。

## Global Constraints

- 直接在 mdeditor/main 与 moraya-core/main 实施，不创建分支/worktree；只允许一个产品写入者。保留原七个未跟踪项、三份 stash 和 force-pull backup。
- I7：「访客没有触碰的块必须与快照逐字节相同」。不得用 canonical 整篇序列化后过滤格式 diff。
- §12.4 最终要求：「富文本与源码来回切换 3 次」零 diff；一字段落编辑的 `propose(base, base, after)`「恰好产生 1 个 hunk，且只覆盖该句」。core reopen 和 parser tests 不冒充 UI 切换。
- 保留 CRLF、loneCR、混合换行、BOM、末尾换行状态、不可见语法及未编辑原字符；raw/source/PM 位置全部是 UTF-16 offset，字节验收使用 UTF-8 Buffer。
- 旧默认 `parseMarkdown` / `parseMarkdownAsync` / `serializeMarkdown` 的签名和语义不变；不改 schema，不忽略任意 attrs，不增加测试专用生产入口。
- 使用已安装直接 CLI：`./node_modules/.bin/vitest`、`tsc`、`tsup`；禁止 pnpm/npx 自动安装。不改 node_modules 源码。
- core `dist/index.js` gzip 必须 `≤ 81920` bytes。core/src 与 tracked dist 同一次 core 提交；mdeditor 同步依赖、测试与文档单独提交。禁止把未提交或错误路径的 dist 当验收产物。
- 不改 history、CDR、Source DOM、Kit 生产入口、annotation owner 授权；这些仍是必做后续。不得调用全篇 serializer 后挑选 diff，不重写同一个 governed span 内未变化的别的自然 root。
- 两项任务各自独立 RED→GREEN→提交→review。root已完成自审并采纳；本计划不预填产品验证通过。

## 实证与待保留反例

原研究的 `probe.mjs` / `feature-probe.mjs` / `boundary-probe.mjs` 已给出实际 parser/serializer 结果。历史只读研究在归档内 `format-block-splice-scratch/` 包含 `natural-owner-baseline.mjs`、`natural-owner-probe.mjs`、`natural-owner-results.json`：从同目录已固定 baseline 模块复制后添加 scratch 导出，包装真实 parser handler 前后记录顶层 content，而非 zip token.map 与 PM children。8 类输入中，多空行、reference gap、loose list、table、HTML、相邻 footnotes、definition list 的 7 个局部候选 strict eq 成功；未闭 fence 且正文保留一个末 LF 的候选失败。这不是本计划产品 GREEN。研究位于上述报告所列归档SHA `6463e6e650e698f4c829337e3ced5bf0933e04846578ec8ce18d35ca0c44f42b`、prefix `2026-10-13-shared-editor-full-document-source/`，明确文件 `format-block-splice-research.md` 和 scratch三个probe/results；执行者只按需从已校验归档选取，不重建或读取已删除workspace，不把scratch当产品验收。

- `A\n\n\nB` 的虚拟空 paragraph 必须与 A/B 的 owner 区分。
- `[x][ref]\n\n[ref]: /url\n\nTail` 中 reference definition 没有 root token；原文间隙是 opaque，synthetic paragraph 不获得它的写权限。
- list / deflist token.map 可含尾空行；ownership 仍用完整 parser map，renderer 终止合同另行处理，不用尾空白 regex 建 root 所有权。
- table serializer 新生成输出带一个终止 LF；只能按明确 table 合同去掉这个新 LF，再加原 map 内 renderer tail。不能 trimEnd 原 source。
- AddMarkStep / RemoveMarkStep 的 StepMap 为空；不能靠 maps 或 selection 找 touched roots。
- 末尾 hardbreak、未闭 fence 正文末 LF、末尾空 paragraph、leading-space split、code language `''` 与 `'text'`、table colwidth 丢失仍保留明确失败。未知 attrs 不忽略；结构/命令契约另做。

## 文件地图与公开合同

| 文件 | 责任 |
| --- | --- |
| core `src/source-trace.ts` 修改 | 仅将现有二分 `firstPiece` 改为模块 export，复用原实现；不从 index 公开 |
| core `package.json` / `pnpm-lock.yaml` / `tsup.config.ts` 修改（N2） | 将已存在的 prosemirror-transform 1.12.0 声明为直接peer/dev、明确external，保持真实Step类身份，不下载或升级 |
| core `src/source-ownership.ts` 新，内部模块 | ownership 类型、工作 trace→raw range、行边界和 renderer tail 坐标；没有新 parser |
| core `src/markdown.ts` | 标记 preserveBlankLines 的 synthetic token，注册 root token 事件，实际 handler emission，BOM 工作视图 |
| core `src/source-fidelity.ts` | SourceSession 增加 roots/gaps；保留旧 exact API；新增 audited block transaction 与局部 renderer |
| core `src/index.ts` | 导出新 block transaction 及其结果/source ownership 类型；不导出 parser private adapters |
| core `src/__tests__/source-ownership.spec.ts` 新 | parser-owned raw/PM metadata、BOM、synthetic/reference gap、preprocess |
| core `src/__tests__/source-block-fidelity.spec.ts` 新 | 完整事务、精确优先、多 root、原子失败、renderer 合同 |
| core `src/__tests__/source-document-capture.spec.ts` 修改 | BOM capture 语义基准，保留旧 text spans 稀疏边界 |
| core `src/__tests__/source-fidelity.spec.ts` 修改 | 只为 exact 内部提取增加合同回归，不把旧 API 限制改成新 API 行为 |
| host `src/lib/share-merge/source-block-fidelity.test.ts` 新 | installed core→bytes→真实 kernel；精确段落仍 1 句 hunk |
| host `src/editor-kit-v2/source-fidelity.test.ts` 修改 | BOM legacy materialize 不一致继续 fail closed，普通已有 gate 不扩 |
| core tracked `dist/*` | 每任务构建、同提交、host 安装 SHA 对齐 |

类型在 `source-ownership.ts` 定义，由 source-fidelity 引用并从 index 转导出：

```ts
export type SourceRoot = Readonly<{
 id:number;tokenType:string
 sourceFrom:number;sourceTo:number;tailFrom:number
 pmFrom:number;pmTo:number;childFrom:number;childTo:number
}>
export type SyntheticEmission = Readonly<{
 pmFrom:number;pmTo:number;childFrom:number;childTo:number
}>
export type SourceGap = Readonly<{
 sourceFrom:number;sourceTo:number
 kind:'trivia'|'opaque'
 synthetic:readonly SyntheticEmission[]
}>
export type SourceEdit = Readonly<{from:number;to:number;text:string}>
// Session retains revision/source/doc/textSpans and gains these consumed fields:
// roots: readonly SourceRoot[]; gaps: readonly SourceGap[]
export type SourceBlockResult =
 | {ok:true;session:SourceSession;mode:'unchanged'|'exact-text'|'root-render';
    edits:readonly SourceEdit[];changedRoots:readonly number[]}
 | FidelityFailure
export function applySourceBlockTransaction(base:SourceSession,tr:Transaction):SourceBlockResult
```

`SourceRoot.id` 是本次 source revision 内的顺序编号，不是跨 revision 的业务身份；`roots` 只包含真实 parser root；`gaps.length===roots.length+1`，依 raw 顺序为 prefix / inter-root / suffix，全部以 source 原区间表示。synthetic emission 归关联 gap 且不可编辑。由 parser createAndFill 补出的空文档 paragraph 可以无 root；稀疏 metadata 不能猜 owner。`tailFrom` 在所属完整 raw owner 内，是 renderer 合同使用的原终止段，不是缩小 raw 权限的正则 ownership。

## Task 1：真实自然 root 与 gap metadata、capture-only BOM

**Files:** core `src/source-trace.ts`、新 `src/source-ownership.ts`、`src/markdown.ts`、`src/source-fidelity.ts`、新 `src/__tests__/source-ownership.spec.ts`、`src/__tests__/source-document-capture.spec.ts`，以及本次生成tracked dist。

**Consumes:** 既有 `SourceTrace / sliceTrace / editTrace / identityTrace`；不可变 finalfix `4a67ebb` 中实际 `firstPiece` 二分查找和同 markdown.ts 的 `captureCursor(state)`（唯一 scoped review 已通过）；`Capture={trace,runs}`、collectorFor、现有 md.parse wrapper 顺序、MorayaMarkdownParser 实际 h handlers。

**Produces:** `createSourceSession` 的 natural roots / raw gaps；精确 text spans 原范围不扩；BOM 合同。此任务 metadata 可独立验证，还不接受新 mark/block transaction。内部source-ownership.ts完整数据合同如下（N1提取brief必须包含，不依赖文档上方片段）：

```ts
export type SourceRoot = Readonly<{
 id:number;tokenType:string
 sourceFrom:number;sourceTo:number;tailFrom:number
 pmFrom:number;pmTo:number;childFrom:number;childTo:number
}>
export type SyntheticEmission = Readonly<{
 pmFrom:number;pmTo:number;childFrom:number;childTo:number
}>
export type SourceGap = Readonly<{
 sourceFrom:number;sourceTo:number
 kind:'trivia'|'opaque'
 synthetic:readonly SyntheticEmission[]
}>
export type SourceEdit = Readonly<{from:number;to:number;text:string}>
```

- [x] **N1.1 写完整 RED `src/__tests__/source-ownership.spec.ts`。**

```ts
import {expect,it,vi} from 'vitest'
import {Node as PmNode} from 'prosemirror-model'
import {createSourceSession} from '../source-fidelity'
import {parseMarkdown,parseMarkdownAsync} from '../markdown'
import {projectLineEndings} from '../source-projection'
function open(source:string) {
 const r=createSourceSession(source);expect(r.ok).toBe(true)
 if(!r.ok)throw new Error(r.reason)
 const s=r.session
 expect(s.source).toBe(source)
 expect(s.doc.eq(parseMarkdown(source.startsWith('\uFEFF')?source.slice(1):source,s.doc.type.schema))).toBe(true)
 return s
}
function partition(source:string) {
 const s=open(source);expect(s.gaps).toHaveLength(s.roots.length+1)
 let cursor=0,joined=''
 s.roots.forEach((root,i)=>{
  const gap=s.gaps[i]!
  expect(gap.sourceFrom).toBe(cursor);expect(gap.sourceTo).toBe(root.sourceFrom)
  expect(root.sourceTo).toBeGreaterThan(root.sourceFrom)
  expect(root.tailFrom).toBeGreaterThanOrEqual(root.sourceFrom)
  expect(root.tailFrom).toBeLessThanOrEqual(root.sourceTo)
  expect(root.childTo).toBeGreaterThan(root.childFrom)
  let from=0,to=0
  s.doc.forEach((n,p,index)=>{if(index===root.childFrom)from=p;if(index+1===root.childTo)to=p+n.nodeSize})
  expect([root.pmFrom,root.pmTo]).toEqual([from,to])
  joined+=source.slice(gap.sourceFrom,gap.sourceTo)+source.slice(root.sourceFrom,root.sourceTo)
  cursor=root.sourceTo
 })
 const tail=s.gaps[s.gaps.length-1]!
 expect([tail.sourceFrom,tail.sourceTo]).toEqual([cursor,source.length])
 joined+=source.slice(tail.sourceFrom,tail.sourceTo)
 expect(Buffer.from(joined)).toEqual(Buffer.from(source))
 return s
}
it('keeps root emission nodeSize reads bounded as natural root count doubles',()=>{
 const original=Object.getOwnPropertyDescriptor(PmNode.prototype,'nodeSize')!.get!
 const counts:number[]=[]
 for(const size of [80,160]) {
  let reads=0
  const spy=vi.spyOn(PmNode.prototype,'nodeSize','get').mockImplementation(function(this:PmNode){
   reads++;return original.call(this)
  })
  try {
   const result=createSourceSession(Array(size).fill('甲 &amp; \\* _乙_ 末句').join('\n\n'))
   expect(result.ok).toBe(true)
   if(!result.ok)throw new Error(result.reason)
   expect(result.session.roots).toHaveLength(size)
   expect(result.session.roots.map(r=>[r.childFrom,r.childTo]))
    .toEqual(Array.from({length:size},(_,i)=>[i,i+1]))
  }finally{spy.mockRestore()}
  counts.push(reads)
 }
 expect(counts[1]).toBeLessThan(counts[0]!*2.6)
})
it('pairs mapped roots with actual emission across synthetic blank paragraphs',()=>{
 const s=partition('A\n\n\nB\n')
 expect(s.roots.map(r=>[r.childFrom,r.childTo,r.sourceFrom,r.sourceTo])).toEqual([[0,1,0,2],[2,3,4,6]])
 expect(s.gaps[1]!.synthetic.map(e=>[e.childFrom,e.childTo])).toEqual([[1,2]])
 expect(s.gaps[1]!.kind).toBe('trivia')
})
it('preserves reference definitions as opaque gap, not synthetic ownership',()=>{
 const raw='[x][ref]\n\n[ref]: /url\n\nTail',s=partition(raw)
 expect(s.roots).toHaveLength(2)
 expect(s.roots.map(r=>r.childFrom)).toEqual([0,3])
 const gap=s.gaps[1]!
 expect(gap.kind).toBe('opaque')
 expect(raw.slice(gap.sourceFrom,gap.sourceTo)).toContain('[ref]: /url')
 expect(gap.synthetic).toHaveLength(2)
})
it.each([
 '* A\n  + B\n\nTail',
 '- A\n\n  B\n\nTail',
 '| A | B |\n| :- | -: |\n| x | y |\n\nTail',
 '[^a]: A\n[^b]: B\n\nTail',
 '[^unused]: A\n\nBefore[^used]\n\n[^used]: B\n\nAfter[^used]',
 'Term\n: A\n\nTail',
 '---\r\na: 1\r\n---\r\n\r\nTail',
 '<div>\nA\n</div>\n\nTail',
 '```text\nA\n```\n\nTail',
 'A\n$$\nx\n$$\nB',
 '[x](url “title”)\r\n\rB\0',
 '\n\nA\n\n','',
])('partitions actual roots after preprocess: %j',partition)
it('projects generated math separator and CRLF to real raw boundaries',()=>{
 const raw='A\n$$\nx\n$$\nB',s=partition(raw)
 expect(s.roots.map(r=>raw.slice(r.sourceFrom,r.sourceTo))).toEqual(['A\n','$$\nx\n$$\n','B'])
 const crlf=partition('A\r\n\r\nB\r\n')
 expect(crlf.roots.map(r=>[r.sourceFrom,r.sourceTo])).toEqual([[0,3],[5,8]])
})
it.each([['# H\r\n','heading'],['---\na: 1\n---\n','frontmatter'],['```text\nA\n```\n','code_block']] as const)(
 'BOM prefix remains raw while capture sees syntax: %s',(plain,type)=>{
 const raw='\uFEFF'+plain,s=partition(raw)
 expect(s.doc.firstChild!.type.name).toBe(type)
 expect(s.roots[0]!.sourceFrom).toBe(1)
 expect(s.gaps[0]!.sourceTo).toBe(1)
 expect(parseMarkdown(raw,s.doc.type.schema).eq(s.doc)).toBe(false)
 expect(projectLineEndings(raw).text.charCodeAt(0)).toBe(0xFEFF)
})
it('preserves second and interior BOM, and legacy APIs',async()=>{
 const doubled='\uFEFF\uFEFF# H\n',s=open(doubled)
 expect(s.doc.eq(parseMarkdown(doubled.slice(1),s.doc.type.schema))).toBe(true)
 expect(s.doc.firstChild!.type.name).toBe('paragraph')
 const inner='A\uFEFFB';expect(open(inner).doc.textContent).toBe(inner)
 const raw='\uFEFF# H\n',legacy=parseMarkdown(raw)
 expect(legacy.firstChild!.type.name).toBe('paragraph')
 expect((await parseMarkdownAsync(raw)).eq(legacy)).toBe(true)
})
```

- [x] **N1.2 运行 RED。** core：

```sh
./node_modules/.bin/vitest run src/__tests__/source-ownership.spec.ts
```

前置 API 尚无 roots/gaps，且 BOM capture 不去首标记；记录真实失败。类型错误若仅因未实现的正式新增字段符合 RED；fixture 自身 PM 位置错误不作为能力失败。

- [x] **N1.3 复用实际 trace 二分入口，创建 ownership 投影 helper。** 在 `src/source-trace.ts` 只将 `function firstPiece(t:SourceTrace,from:number):number` 声明改成 `export function firstPiece(t:SourceTrace,from:number):number`，保留 `4a67ebb` 的二分函数体，不另建查找算法，不在 src/index.ts 转导出。在 `src/source-ownership.ts` 声明上方四个数据类型并加入以下完整计算逻辑；sliceTrace 已从 firstPiece 开始只访问重叠 pieces，不建立 Markdown 语法 parser。

```ts
import {sliceTrace,firstPiece,type SourceTrace} from './source-trace'
export class UnsupportedOwnership extends Error {}
export function rawRange(trace:SourceTrace,from:number,to:number):{from:number;to:number}|undefined {
 const view=sliceTrace(trace,from,to)
 // sliceTrace turns a partial atomic into generated; natural root boundaries
 // must never cut a non-generated atomic interior.
 for(const offset of [from,to]) {
  const piece=trace.pieces[firstPiece(trace,offset)]
  if(piece?.kind==='atomic'&&offset>piece.from&&offset<piece.to)
   throw new UnsupportedOwnership()
 }
 const real=view.pieces.filter(p=>p.kind!=='generated')
 if(!real.length)return undefined
 if(real.some((p,i)=>i>0&&real[i-1]!.sourceTo!==p.sourceFrom))throw new UnsupportedOwnership()
 return {from:real[0]!.sourceFrom,to:real[real.length-1]!.sourceTo}
}
export function lineStarts(text:string):number[] {
 const result=[0]
 for(let i=0;i<text.length;i++)if(text[i]==='\n')result.push(i+1)
 // markdown-it's map can end on EOF even without final LF.
 if(result[result.length-1]!==text.length)result.push(text.length)
 return result
}
export function rendererTailStart(text:string,from:number,to:number,tokenType:string):number {
 if(to<=from||text[to-1]!=='\n')return to
 // Literal content may contain meaningful trailing blank lines: only the
 // final parser line terminator participates in this renderer contract.
 if(['fence','code_block','front_matter','html_block','math_block','math_block_eqno'].includes(tokenType))return to-1
 const flow=new Set(['paragraph_open','heading_open','bullet_list_open','ordered_list_open',
  'blockquote_open','table_open','footnote_reference_open','dl_open','hr'])
 if(!flow.has(tokenType))throw new UnsupportedOwnership()
 let end=to
 while(end>from) {
  const start=Math.max(from,text.lastIndexOf('\n',end-2)+1)
  const content=text.slice(start,end-1)
  if(/^[ \t]*$/.test(content)){end=start;continue}
  return end-1
 }
 return from
}
```

完整 token.map 区间先经 rawRange 得 owner，terminal classifier 只能确定 owner **内部的渲染尾段**。未知 token 类型仍可保留 owner，但 renderer tail 不可证明时令 `tailFrom=sourceTo` 并由后续 renderer 拒绝；实现方式在下段 `prepareRootEvents` 中用 `renderable` 条件定义，不吞异常。已有 root 的 source/body 字节不做 trim 或 EOL normalize。

- [x] **N1.4 在 markdown.ts 标记实际 synthetic tokens，并建立 root token 事件。** 导入上节 types/helpers；扩展 Capture 为 `{trace:SourceTrace;runs:CapturedTextRun[];roots:SourceRoot[];synthetic:{gapIndex:number;emission:SyntheticEmission}[]}`。新增下列内部类型/maps/helper，不导出到 root：

```ts
type RootDraft={collector:Capture;kind:'natural'|'synthetic';gapIndex:number;
 id:number;tokenType:string;sourceFrom:number;sourceTo:number;tailFrom:number;
 childFrom?:number;pmFrom?:number}
const syntheticTokens=new WeakSet<object>()
const rootStarts=new WeakMap<object,RootDraft>()
const rootEnds=new WeakMap<object,RootDraft>()
function prepareRootEvents(tokens:InlineToken[],collector:Capture):void {
 const starts=lineStarts(collector.trace.text);let natural=0
 const renderable=new Set(['paragraph_open','heading_open','bullet_list_open','ordered_list_open',
  'blockquote_open','table_open','footnote_reference_open','dl_open','hr',
  'fence','code_block','front_matter','html_block','math_block','math_block_eqno'])
 for(let i=0;i<tokens.length;i++) {
  const token=tokens[i]!
  const synthetic=syntheticTokens.has(token)
  if(token.level!==0||token.nesting===-1||(!token.map&&!synthetic))continue
  let last=i
  if(token.nesting===1) {
   last=i+1
   while(last<tokens.length&&!(tokens[last]!.level===0&&tokens[last]!.nesting===-1))last++
   if(last===tokens.length)throw new UnsupportedSourceCapture()
  }else if(token.nesting!==0)throw new UnsupportedSourceCapture()
  let sourceFrom=0,sourceTo=0,tailFrom=0
  if(!synthetic) {
   const from=starts[token.map![0]],to=starts[token.map![1]]
   if(from===undefined||to===undefined||to<=from)throw new UnsupportedSourceCapture()
   const raw=rawRange(collector.trace,from,to)
   if(!raw)throw new UnsupportedSourceCapture()
   sourceFrom=raw.from;sourceTo=raw.to;tailFrom=sourceTo
   if(renderable.has(token.type)) {
    const tail=rawRange(collector.trace,rendererTailStart(collector.trace.text,from,to,token.type),to)
    if(tail) {
     if(tail.to!==sourceTo)throw new UnsupportedSourceCapture()
     tailFrom=tail.from
    }
   }
  }
  const draft:RootDraft={collector,kind:synthetic?'synthetic':'natural',gapIndex:natural,
   id:natural,tokenType:token.type,sourceFrom,sourceTo,tailFrom}
  if(!synthetic)natural++
  rootStarts.set(token,draft);rootEnds.set(tokens[last]!,draft)
  i=last
 }
}
function rootCursor(state:any):{count:number;pos:number} {
 if(!Array.isArray(state.stack)||state.stack.length!==1||!Array.isArray(state.stack[0].content))
  throw new UnsupportedSourceCapture()
 return {count:state.stack[0].content.length,pos:captureCursor(state)}
}
function captureRootEmission(state:any,token:any,delegate:()=>void):void {
 const start=rootStarts.get(token),end=rootEnds.get(token)
 if(start) {
  const cursor=rootCursor(state)
  start.childFrom=cursor.count;start.pmFrom=cursor.pos
 }
 delegate()
 if(end) {
  const cursor=rootCursor(state)
  if(end.childFrom===undefined||end.pmFrom===undefined||cursor.count<=end.childFrom)
   throw new UnsupportedSourceCapture()
  const emission={childFrom:end.childFrom,childTo:cursor.count,pmFrom:end.pmFrom,pmTo:cursor.pos}
  if(end.kind==='synthetic')end.collector.synthetic.push({gapIndex:end.gapIndex,emission})
  else end.collector.roots.push({id:end.id,tokenType:end.tokenType,
   sourceFrom:end.sourceFrom,sourceTo:end.sourceTo,tailFrom:end.tailFrom,...emission})
 }
}
function buildSourceGaps(source:string,roots:readonly SourceRoot[],synthetic:Capture['synthetic']):SourceGap[] {
 const grouped:SyntheticEmission[][]=Array.from({length:roots.length+1},()=>[])
 for(const entry of synthetic) {
  if(!Number.isInteger(entry.gapIndex)||entry.gapIndex<0||entry.gapIndex>roots.length)
   throw new UnsupportedSourceCapture()
  grouped[entry.gapIndex]!.push(entry.emission)
 }
 const result:SourceGap[]=[];let at=0,lastChild=0
 for(let i=0;i<=roots.length;i++) {
  const root=roots[i],to=root?.sourceFrom??source.length
  if(to<at)throw new UnsupportedSourceCapture()
  result.push({sourceFrom:at,sourceTo:to,
   kind:/^[\s\uFEFF]*$/u.test(source.slice(at,to))?'trivia':'opaque',
   synthetic:grouped[i]!})
  if(root) {
   if(root.id!==i||root.sourceTo<=to||root.sourceTo>source.length||root.childFrom<lastChild)
    throw new UnsupportedSourceCapture()
   at=root.sourceTo;lastChild=root.childTo
  }
 }
 return result
}
```

接线按以下三个明确位置进行：

1. `preserveBlankLines(tokens)` 改成 `preserveBlankLines(tokens,capture=false)`。原 `extra` 循环把 `paragraph_open` 先赋给局部 `open`，capture 时 `syntheticTokens.add(open)`，再 push 原三 token；原 map=null、内容、次数不变。

```ts
const open=mkToken('paragraph_open','p',1)
if(capture)syntheticTokens.add(open)
result.push(open,mkToken('inline','',0,{level:1,block:false,children:[]}),
 mkToken('paragraph_close','p',-1))
```

2. md.parse wrapper 保持 `tagPairedHtmlInline` → `fixFootnoteDefMaps` → `preserveBlankLines` 原顺序，从 env 取 collector，并在返回 tokens 前准备事件：

```ts
const collector=(env as {[captureKey]?:Capture}|undefined)?.[captureKey]
tokens=preserveBlankLines(tokens,!!collector)
if(collector)prepareRootEvents(tokens,collector)
```

3. `MorayaMarkdownParser` constructor **所有** h overrides 结束后、constructor 关闭前，一次性包装最终 handlers，确保 table/CSV/html 的实际路径也计入；不在 default handler 生成前包装：

```ts
for(const key of Object.keys(h)) {
 const delegate=h[key]!
 h[key]=(state,tok,tokens,i)=>captureRootEmission(state,tok,()=>delegate(state,tok,tokens,i))
}
```

rootCursor 复用 `4a67ebb` 的 captureCursor：该 helper 已用每 frame WeakMap 缓存 content identity/length/size/tailSize，只重读尾节点和新 append，并保留 marks/content shape 与长度不倒退保护。rawRange 两个原子边界用现有 firstPiece 二分，root/tail 的 sliceTrace 仅访问重叠 pieces。N1 的多 root/nodeSize getter 增长回归用于防止事件接线重新引入前缀累计。root events 用 token 身份携带 collector，无全局 active doc；synthetic 与 natural 可以一前一后，不能 zip 过滤后的 token.map 和 PM node 数组。root group 以真实 level/nesting 配对，一个 group 可以实际输出多个 PM children，记录其全部 childFrom/childTo。真实无 token 的 reference definition 留在 gap；当前禁用 footnote_tail / footnote_inline 的 parser 配置保留。

- [x] **N1.5 BOM trace、session 返回与 private failure。** `parseDocumentWithSourceCapture` 中替换 math 初始化为：

```ts
let trace=identityTrace(source)
if(source.charCodeAt(0)===0xFEFF)trace=editTrace(trace,[{from:0,to:1,text:''}])
const mathEdits:TraceEdit[]=[]
const math=normalizeMathBlocks(trace.text,mathEdits)
trace=editTrace(trace,mathEdits)
if(trace.text!==math)throw new UnsupportedSourceCapture()
```

原 smartquote observer、normalize EOL/NUL trace 组合不变。collector 构造变为 `{trace,runs:[],roots:[],synthetic:[]}`。原 textRun 校验继续，不放宽顶层 paragraph 语义。返回 value 增加 `roots:collector.roots,gaps:buildSourceGaps(source,collector.roots,collector.synthetic)`；capture catch 将 `UnsupportedOwnership` 和 `UnsupportedSourceCapture` 一同映射为 unsupported-source，真正 parser 异常仍 parse-error。

保留 `CapturedParagraph={doc,textRuns}` 兼容类型，新增精确 `CapturedDocument=CapturedParagraph & {roots:SourceRoot[];gaps:SourceGap[]}` 供新 hook 返回；旧 parseParagraph wrapper 仍可返回额外 value 字段，但声明合同不变。`createSourceSession` 把新增 roots/gaps 原样存入 session，`SourceSession` 增加两个 readonly 字段。无调用方提供/篡改 owner 的可编辑入口。

旧 `source-document-capture.spec.ts` 的通用 `doc.eq(parseMarkdown(raw))` BOM 基准按本稿冻结合同改为去恰好一个首 BOM；canonical API 单独断言不变。旧容器/literal textRuns=[] 的测试全部保留，因为本稿不扩大精细 text mapping。

- [x] **N1.6 GREEN 和独立提交。**

```sh
./node_modules/.bin/vitest run src/__tests__/source-ownership.spec.ts src/__tests__/source-document-capture.spec.ts src/__tests__/source-fidelity.spec.ts src/__tests__/source-fidelity-corpus.spec.ts src/__tests__/source-trace.spec.ts src/__tests__/source-projection.spec.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsup
git diff --check
```

按文末产物门槛核验 gzip / tracked dist，精确 stage N1 文件与 dist，提交 `feat(core): capture natural source block ownership`。metadata 全部通过再交 root 任务审查，不提前启动 N2 产品写入。

## Task 2：精确优先的稳定 root 事务、局部 renderer 与安装版集成

**Files:** core `package.json`、`pnpm-lock.yaml`、`tsup.config.ts`、`src/source-fidelity.ts`、`src/index.ts`、新 `src/__tests__/source-block-fidelity.spec.ts`、`src/__tests__/source-fidelity.spec.ts`、本次tracked dist；host新 `src/lib/share-merge/source-block-fidelity.test.ts`、`src/editor-kit-v2/source-fidelity.test.ts`。

**Consumes:** N1 的 source/raw/PM ownership、前置 Task 3 exact text transaction；现有 serializeMarkdown，只对已证明被改的 root fragment 调用。

**Produces:** `applySourceBlockTransaction`、来源 edits 审计结果、installed core→merge 的门槛。旧 applySourceTextTransaction 继续只支持原单 text step / stored marks 拒绝合同，不悄悄改变旧调用方行为。

- [x] **N2.0 声明实际标准 Step 直接依赖并保持 external 身份。** 已验证 core 根 `import.meta.resolve('prosemirror-transform')` 为 ERR_MODULE_NOT_FOUND，而通过现有 prosemirror-state 能解析已安装的 1.12.0。host已直接声明 ^1.12.0。新增core peer/dev声明与lock importer（版本对象已存在），tsup external加同一包，不能偷偷bundled第二份Step类。以下在core根执行，不下载/升级/安装：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const manifest=JSON.parse(fs.readFileSync('package.json','utf8'));
manifest.peerDependencies['prosemirror-transform']='^1.12.0';
manifest.devDependencies['prosemirror-transform']='^1.12.0';
fs.writeFileSync('package.json',JSON.stringify(manifest,null,2)+'\n');
let lock=fs.readFileSync('pnpm-lock.yaml','utf8');
const anchor='      prosemirror-view:\n';assert.equal(lock.split(anchor).length,2);
lock=lock.replace(anchor,'      prosemirror-transform:\n        specifier: ^1.12.0\n        version: 1.12.0\n'+anchor);
fs.writeFileSync('pnpm-lock.yaml',lock);
const config=fs.readFileSync('tsup.config.ts','utf8');
assert.equal(config.split("    'prosemirror-state',").length,2);
fs.writeFileSync('tsup.config.ts',config.replace("    'prosemirror-state',","    'prosemirror-state',\n    'prosemirror-transform',"));
const require=createRequire(import.meta.resolve('prosemirror-state'));
const target=path.dirname(path.dirname(require.resolve('prosemirror-transform')));
assert.equal(JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8')).version,'1.12.0');
const link=path.resolve('node_modules/prosemirror-transform');
if(!fs.existsSync(link))fs.symlinkSync(target,link,'dir');
assert.equal(fs.realpathSync(link),fs.realpathSync(target));
console.log(JSON.stringify({existingPeer:target,link}));
JS
```

此环境link是既有installed包的解析入口，不作为产品提交；clean clone由manifest/lock正常安装重建。只提交三个必要配置文件；production dist中prosemirror-transform保持external，installedhost与PM Transaction使用同一包，记录实际resolved路径/版本。配置后的新API不存在才是本任务RED，不能把缺少未声明依赖当能力失败。

- [x] **N2.1 写完整 RED `src/__tests__/source-block-fidelity.spec.ts`。**

```ts
import {expect,it,vi} from 'vitest'
import {EditorState,type Transaction} from 'prosemirror-state'
import {Node as PmNode,Slice,Fragment} from 'prosemirror-model'
import {AddMarkStep,RemoveMarkStep,ReplaceStep} from 'prosemirror-transform'
import {applySourceBlockTransaction,createSourceSession,type SourceSession,type SourceBlockResult} from '../source-fidelity'
function open(source:string):SourceSession {
 const r=createSourceSession(source);expect(r.ok).toBe(true)
 if(!r.ok)throw new Error(r.reason)
 return r.session
}
function pos(doc:PmNode,needle:string,n=0):number {
 const found:number[]=[]
 doc.descendants((node,p)=>{
  if(!node.isText)return
  let i=-1;while((i=node.text!.indexOf(needle,i+1))>=0)found.push(p+i)
 })
 if(found[n]===undefined)throw new Error('fixture text missing: '+needle)
 return found[n]!
}
function transaction(base:SourceSession) {return EditorState.create({doc:base.doc}).tr}
function fingerprint(base:SourceSession) {
 return JSON.stringify({source:base.source,revision:base.revision,doc:base.doc.toJSON(),
  spans:base.textSpans,roots:base.roots,gaps:base.gaps})
}
function accept(base:SourceSession,tr:Transaction) {
 const before=fingerprint(base),r=applySourceBlockTransaction(base,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(fingerprint(base)).toBe(before)
 expect(r.session.doc.eq(tr.doc)).toBe(true)
 let raw=0,out=0
 for(const edit of r.edits) {
  const untouched=base.source.slice(raw,edit.from)
  expect(Buffer.from(r.session.source.slice(out,out+untouched.length))).toEqual(Buffer.from(untouched))
  out+=untouched.length
  expect(r.session.source.slice(out,out+edit.text.length)).toBe(edit.text)
  out+=edit.text.length;raw=edit.to
  expect(r.changedRoots.some(id=>{
   const root=base.roots.find(x=>x.id===id)!
   return root.sourceFrom<=edit.from&&root.sourceTo>=edit.to
  })).toBe(true)
 }
 expect(Buffer.from(r.session.source.slice(out))).toEqual(Buffer.from(base.source.slice(raw)))
 expect(r.session.revision).toBe(base.revision+(r.mode==='unchanged'?0:1))
 return r
}
function reject(base:SourceSession,tr:Transaction):SourceBlockResult {
 const before=fingerprint(base),r=applySourceBlockTransaction(base,tr)
 expect(r.ok).toBe(false);expect('session' in r).toBe(false)
 expect(fingerprint(base)).toBe(before)
 return r
}
it('keeps ordinary single-character exact splice before root rendering',()=>{
 const b=open('首段保持。\r\n\r\n目标甲。第二句  __保持__。\r\n'),p=pos(b.doc,'甲')
 const r=accept(b,transaction(b).insertText('乙',p,p+1))
 expect(r.mode).toBe('exact-text')
 expect(r.session.source).toBe(b.source.replace('甲','乙'))
 expect(r.edits).toEqual([{from:b.source.indexOf('甲'),to:b.source.indexOf('甲')+1,text:'乙'}])
})
it.each([
 'Alpha beta','## Alpha beta','* Alpha\n  + nested\n* Beta',
 '> Alpha\n>\n> Beta','| A | B |\n| :- | -: |\n| Alpha | Beta |',
 '[^a]: Alpha','Term\n: Alpha','{==Alpha beta==}{>>owner note<<}',
 '<em>Alpha beta</em>','==Alpha beta==','Alpha $x$ beta',
 'Alpha  \nBeta','[Alpha](/u "title")','  Alpha beta',
])('renders only the changed natural root: %s',head=>{
 const raw=head+'\n\nUntouched *raw* tail\r\n',b=open(raw),p=pos(b.doc,'Alpha')
 const tr=transaction(b).addMark(p,p+5,b.doc.type.schema.marks.strong!.create())
 expect(tr.steps[0]!.getMap().ranges).toEqual([])
 const r=accept(b,tr)
 expect(r.mode).toBe('root-render')
 expect(r.changedRoots).toEqual([b.roots[0]!.id])
 expect(r.edits).toHaveLength(1)
 expect(r.session.source.endsWith(raw.slice(b.roots[0]!.sourceTo))).toBe(true)
})
it.each([12,24,48])('production addMark across %i roots produces per-root steps without per-step document scans',count=>{
 const source=Array.from({length:count},(_,i)=>'P'+i).join('\n\n')
 const base=open(source)
 const tr=transaction(base).addMark(1,base.doc.content.size-1,base.doc.type.schema.marks.strong!.create())
 expect(tr.steps).toHaveLength(count)
 expect(tr.steps.every(step=>Object.getPrototypeOf(step)===AddMarkStep.prototype)).toBe(true)
 expect(tr.steps.every(step=>step.getMap().ranges.length===0)).toBe(true)
 const priorDocs=new Set(tr.docs)
 const originalForEach=PmNode.prototype.forEach,originalChild=PmNode.prototype.child
 let inspectedTopChildren=0
 const eachSpy=vi.spyOn(PmNode.prototype,'forEach').mockImplementation(function(this:PmNode,callback){
  if(priorDocs.has(this))inspectedTopChildren+=this.childCount
  return originalForEach.call(this,callback)
 })
 const childSpy=vi.spyOn(PmNode.prototype,'child').mockImplementation(function(this:PmNode,index){
  if(priorDocs.has(this))inspectedTopChildren++
  return originalChild.call(this,index)
 })
 let result:SourceBlockResult
 try{result=applySourceBlockTransaction(base,tr)}finally{eachSpy.mockRestore();childSpy.mockRestore()}
 expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.reason)
 expect(result.changedRoots).toEqual(Array.from({length:count},(_,i)=>i))
 expect(result.edits).toHaveLength(count)
 expect(result.session.source).toBe(Array.from({length:count},(_,i)=>'**P'+i+'**').join('\n\n'))
 // Count this adapter's old-doc child accesses, not wall time or PM's native findIndex loop.
 expect(inspectedTopChildren).toBeLessThanOrEqual(count*12+32)
})
it('allows production multi-step marks around a synthetic gap but rejects a step that claims it',()=>{
 const base=open('A\n\n\nB'),strong=base.doc.type.schema.marks.strong!.create()
 const actual=transaction(base).addMark(1,base.doc.content.size-1,strong)
 expect(actual.steps).toHaveLength(2)
 const accepted=accept(base,actual)
 expect(accepted.session.source).toBe('**A**\n\n\n**B**')
 reject(base,transaction(base).step(new AddMarkStep(1,base.doc.content.size-1,strong)))
})
it('rejects a custom step subclass even if its JSON says addMark',()=>{
 class DisguisedMarkStep extends AddMarkStep {
  override apply(doc:PmNode) {
   const at=pos(doc,'B')
   return new ReplaceStep(at,at+1,new Slice(Fragment.from(doc.type.schema.text('X')),0,0)).apply(doc)
  }
 }
 const base=open('A\n\nB'),from=pos(base.doc,'A')
 const tr=transaction(base).step(new DisguisedMarkStep(from,from+1,base.doc.type.schema.marks.strong!.create()))
 expect(tr.steps[0]!.toJSON().stepType).toBe('addMark')
 expect(tr.doc.textContent).toBe('AX')
 expect(reject(base,tr)).toEqual({ok:false,reason:'unsupported-step'})
})
it('handles removeMark with an empty StepMap',()=>{
 const b=open('__Alpha__\n\nTail'),p=pos(b.doc,'Alpha')
 const tr=transaction(b).removeMark(p,p+5,b.doc.type.schema.marks.strong!)
 expect(tr.steps[0]!.getMap().ranges).toEqual([])
 const r=accept(b,tr)
 expect(r.session.source).toBe('Alpha\n\nTail')
})
it('falls back for real nested, table and literal text without exact spans',()=>{
 for(const raw of ['* 甲\n  + 子项\n\nTail','| A |\n| --- |\n| 甲 |\n\nTail',
  '~~~text\n甲\n~~~\n\nTail','---\ntitle: 甲\n---\n\nTail']) {
  const b=open(raw),p=pos(b.doc,'甲'),r=accept(b,transaction(b).insertText('乙',p,p+1))
  expect(r.mode).toBe('root-render');expect(r.changedRoots).toEqual([0])
  expect(r.session.source.endsWith('\n\nTail')).toBe(true)
 }
})
it('does not gain syntax intent from exact semantic-mismatch',()=>{
 const b=open('甲\n\nTail'),p=pos(b.doc,'甲')
 const r=accept(b,transaction(b).insertText('*乙*',p,p+1))
 // Intended PM contains literal stars; local serializer must preserve that intent.
 expect(r.mode).toBe('root-render')
 expect(r.session.doc.firstChild!.textContent).toBe('*乙*')
 expect(r.session.doc.firstChild!.firstChild!.marks).toEqual([])
})
it('maps each step in its actual doc and keeps nonadjacent edits separate',()=>{
 const raw='A\r\n\r\n  Middle __raw__\r\n\r\nC\n',b=open(raw)
 const tr=transaction(b).insertText('Long',pos(b.doc,'A'),pos(b.doc,'A')+1)
 const c=pos(tr.doc,'C');tr.addMark(c,c+1,b.doc.type.schema.marks.strong!.create())
 const r=accept(b,tr)
 expect(r.changedRoots).toEqual([0,2]);expect(r.edits).toHaveLength(2)
 expect(r.session.source).toBe('Long\r\n\r\n  Middle __raw__\r\n\r\n**C**\n')
 const middle=b.roots[1]!
 expect(r.edits.every(e=>e.to<=middle.sourceFrom||e.from>=middle.sourceTo)).toBe(true)
})
it('preserves opaque references and their synthetic paragraphs',()=>{
 const raw='[Alpha][ref]\n\n[ref]: /url "T"\n\nTail',b=open(raw),p=pos(b.doc,'Alpha')
 const r=accept(b,transaction(b).addMark(p,p+5,b.doc.type.schema.marks.strong!.create()))
 expect(r.session.source).toContain('[ref]: /url "T"')
 const synthetic=b.gaps[1]!.synthetic[0]!
 reject(b,transaction(b).insertText('X',synthetic.pmFrom+1))
})
it('uses original-position footnote owners, including unused and consecutive definitions',()=>{
 const raw='[^a]: Alpha\n[^unused]: Keep\n\nBefore[^a]\n\n[^z]: Z\n\nAfter[^z]',b=open(raw)
 const p=pos(b.doc,'Alpha'),r=accept(b,transaction(b).addMark(p,p+5,b.doc.type.schema.marks.strong!.create()))
 expect(r.changedRoots).toEqual([0])
 expect(r.session.source.endsWith(raw.slice(b.roots[0]!.sourceTo))).toBe(true)
})
it('removes exactly the generated table terminal LF before preserving original separation',()=>{
 const raw='| A | B |\n| :- | -: |\n| Alpha | Beta |\n\nTail',b=open(raw),p=pos(b.doc,'Alpha')
 const r=accept(b,transaction(b).addMark(p,p+5,b.doc.type.schema.marks.strong!.create()))
 expect(r.session.source.endsWith('| **Alpha** | Beta |\n\nTail')).toBe(true)
 expect(r.session.doc.childCount).toBe(b.doc.childCount)
})
it('preserves BOM and untouched CRLF on a changed heading',()=>{
 const raw='\uFEFF# Alpha\r\n\r\nTail\r\n',b=open(raw),p=pos(b.doc,'Alpha')
 const r=accept(b,transaction(b).addMark(p,p+5,b.doc.type.schema.marks.strong!.create()))
 expect(r.session.source).toBe('\uFEFF# **Alpha**\r\n\r\nTail\r\n')
})
it('stored marks and selection alone do not create a source revision',()=>{
 const b=open('A'),tr=transaction(b).setStoredMarks([b.doc.type.schema.marks.strong!.create()])
 const r=accept(b,tr)
 expect(r.mode).toBe('unchanged');expect(r.session).toBe(b)
 expect(r.edits).toEqual([]);expect(r.changedRoots).toEqual([])
 // This source preparation does not install an EditorState or change the old Kit adapter.
 expect(EditorState.create({doc:b.doc}).apply(tr).storedMarks!.map(x=>x.type.name)).toEqual(['strong'])
})
it('net-zero supported steps keep raw source and revision',()=>{
 const b=open('__A__'),tr=transaction(b).removeMark(1,2,b.doc.type.schema.marks.strong!)
 tr.addMark(1,2,b.doc.type.schema.marks.strong!.create())
 const r=accept(b,tr);expect(r.mode).toBe('unchanged');expect(r.session).toBe(b)
})
it('rejects stale docs, root structure and attrs without source output',()=>{
 const b=open('A\n\nB')
 reject(b,EditorState.create({doc:open('X\n\nB').doc}).tr.insertText('Y',1,2))
 reject(b,transaction(b).split(2))
 reject(b,transaction(b).join(3))
 reject(b,transaction(b).delete(0,3))
 reject(b,transaction(b).setNodeMarkup(0,b.doc.type.schema.nodes.heading,{level:2}))
 const table=open('| A |\n| --- |\n| B |')
 reject(table,transaction(table).setNodeMarkup(2,undefined,
  {...table.doc.firstChild!.firstChild!.firstChild!.attrs,colwidth:[100]}))
 const code=open('```text\nA\n```')
 reject(code,transaction(code).setNodeMarkup(0,undefined,{language:''}))
})
it('keeps serializer limitations and partial surrogate edits fail closed',()=>{
 const b=open('A'),hardbreak=b.doc.type.schema.nodes.hardbreak!.create({isInline:false})
 reject(b,transaction(b).insert(2,hardbreak))
 const unclosed=open('~~~text\nA\n\n'),p=pos(unclosed.doc,'A')
 reject(unclosed,transaction(unclosed).insertText('Z',p,p+1))
 const empty=open('')
 reject(empty,transaction(empty).insertText('A',1))
 const emoji=open('😀'),e=pos(emoji.doc,'😀')
 reject(emoji,transaction(emoji).insertText('X',e+1,e+2))
})
```

无条件 table colwidth/语言 attrs 拒绝之外，未知自定义 schema attrs 的无条件测试见 N2.4。所有 mark/step 测试使用生产 API，无伪造 source owner 权限。

- [x] **N2.2 RED 命令。**

```sh
./node_modules/.bin/vitest run src/__tests__/source-block-fidelity.spec.ts
```

预期新 API 不存在；加入入口后 mark/multi-step/root fallback 尚未实现仍失败。不要通过开 exact API 全局 mark/多步权限来使此测试通过。

- [x] **N2.3 提取旧 exact 返回的真实 edit，保持公开合同。** 在 source-fidelity.ts 将已有 `applySourceTextTransaction` 原实现改名为私有 `applySourceTextTransactionWithEdit`；保留全部现有步骤验证/失败理由/strict reparse。仅最终成功返回加上已由原算法算出的 sourceFrom/sourceTo/insert：

```ts
type ExactTextResult={ok:true;session:SourceSession;edit:SourceEdit}|FidelityFailure
// Original implementation body is retained under this private signature:
// function applySourceTextTransactionWithEdit(base:SourceSession,tr:Transaction):ExactTextResult
// Its original final return becomes:
return {ok:true,session:{...result.session,revision:base.revision+1},
 edit:{from:sourceFrom,to:sourceTo,text:insert}}
```

原公开函数变为无信息丢失的 wrapper：

```ts
export function applySourceTextTransaction(base:SourceSession,tr:Transaction):FidelityResult {
 const result=applySourceTextTransactionWithEdit(base,tr)
 return result.ok?{ok:true,session:result.session}:result
}
```

这只是 DRY 提取，不从前后 source diff 反推 edit，不重复维护 text-span boundary 算法。旧 API 的 storedMarksSet、单 ReplaceStep、semantic-mismatch 断言原样运行。

- [x] **N2.4 实现每步稳定边界证明和局部输出。** source-fidelity.ts 新增 runtime `EditorState` import；`Fragment` 和 type `ResolvedPos` / `PmNode` 来自已有 prosemirror-model；`AddMarkStep` / `RemoveMarkStep` / `ReplaceStep` runtime imports 来自已安装 prosemirror-transform；`serializeMarkdown` 来自 markdown.ts；SourceRoot/SourceEdit types 从 ownership 导入。以下 helper 和新公开入口完整落在该文件，复用已有 `splitsSurrogate` / createSourceSession / FidelityFailure。

```ts
export type SourceBlockResult =
 | {ok:true;session:SourceSession;mode:'unchanged'|'exact-text'|'root-render';
    edits:readonly SourceEdit[];changedRoots:readonly number[]}
 | FidelityFailure
class UnsupportedBlockTransaction extends Error {}
type RootIndex={rootById:readonly SourceRoot[];ownerByChild:readonly (SourceRoot|undefined)[]}
function indexSourceRoots(base:SourceSession):RootIndex {
 const rootById=base.roots
 const ownerByChild:(SourceRoot|undefined)[]=new Array(base.doc.childCount)
 let previousChildTo=0
 for(let id=0;id<rootById.length;id++) {
  const root=rootById[id]!
  if(root.id!==id||!Number.isInteger(root.childFrom)||!Number.isInteger(root.childTo)
   ||root.childFrom<previousChildTo||root.childTo<=root.childFrom||root.childTo>base.doc.childCount)
   throw new UnsupportedBlockTransaction()
  for(let child=root.childFrom;child<root.childTo;child++)ownerByChild[child]=root
  previousChildTo=root.childTo
 }
 return {rootById,ownerByChild}
}
function splitsInlineText(position:ResolvedPos):boolean {
 if(!position.textOffset)return false
 const node=position.parent.child(position.index())
 return node.isText&&splitsSurrogate(node.text!,position.textOffset)
}
function authorizeStepRoots(before:PmNode,step:AddMarkStep|RemoveMarkStep|ReplaceStep,
 ownership:RootIndex,authorized:Set<number>):void {
 const {from,to}=step
 if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>before.content.size)
  throw new UnsupportedBlockTransaction()
 const a=before.resolve(from),b=before.resolve(to)
 if(splitsInlineText(a)||splitsInlineText(b))throw new UnsupportedBlockTransaction()
 if(step instanceof ReplaceStep) {
  if((step as ReplaceStep & {readonly structure:boolean}).structure||!a.sameParent(b)||!a.parent.inlineContent||step.slice.openStart||step.slice.openEnd)
   throw new UnsupportedBlockTransaction()
  let inline=true;step.slice.content.forEach(node=>{if(!node.isInline)inline=false})
  if(!inline)throw new UnsupportedBlockTransaction()
 }else if(from===to)return
 // index(0) is resolved by PM in this step's actual before doc. A nonempty
 // half-open range ending at a doc-level boundary excludes the next child.
 const first=a.index(0)
 const last=from===to?first:b.index(0)-(b.depth===0?1:0)
 if(first<0||last<first||last>=before.childCount)throw new UnsupportedBlockTransaction()
 for(let child=first;child<=last;child++) {
  const root=ownership.ownerByChild[child]
  if(!root)throw new UnsupportedBlockTransaction()
  authorized.add(root.id)
 }
}
function changedNaturalRoots(base:SourceSession,tr:Transaction,ownership:RootIndex):number[] {
 const authorized=new Set<number>()
 for(let i=0;i<tr.steps.length;i++) {
  const step=tr.steps[i]!,prototype=Object.getPrototypeOf(step)
  // Exact prototypes exclude custom Step subclasses whose apply() need not
  // obey the range or structure guarantees of their inherited JSON format.
  if(prototype!==ReplaceStep.prototype&&prototype!==AddMarkStep.prototype&&prototype!==RemoveMarkStep.prototype)
   throw new UnsupportedBlockTransaction()
  const before=tr.docs[i]!
  if(before.childCount!==base.doc.childCount)throw new UnsupportedBlockTransaction()
  authorizeStepRoots(before,step as ReplaceStep|AddMarkStep|RemoveMarkStep,ownership,authorized)
 }
 // Standard mark steps preserve structure. A same-inline-parent ReplaceStep
 // with a closed inline slice preserves all top-child boundaries by induction.
 // Final document markup and actual changed ownership are checked once.
 if(!base.doc.sameMarkup(tr.doc)||base.doc.childCount!==tr.doc.childCount)
  throw new UnsupportedBlockTransaction()
 const changed=new Set<number>()
 base.doc.forEach((node,_offset,child)=>{
  const next=tr.doc.child(child)
  if(!node.sameMarkup(next))throw new UnsupportedBlockTransaction()
  if(node.eq(next))return
  const root=ownership.ownerByChild[child]
  if(!root||!authorized.has(root.id))throw new UnsupportedBlockTransaction()
  changed.add(root.id)
 })
 return ownership.rootById.filter(root=>changed.has(root.id)).map(root=>root.id)
}
const renderableRoots=new Set(['paragraph_open','heading_open','bullet_list_open','ordered_list_open',
 'blockquote_open','table_open','footnote_reference_open','dl_open','hr',
 'fence','code_block','front_matter','html_block','math_block','math_block_eqno'])
function renderChangedRoot(base:SourceSession,doc:PmNode,root:SourceRoot):string {
 if(!renderableRoots.has(root.tokenType))throw new UnsupportedBlockTransaction()
 const nodes:PmNode[]=[]
 for(let i=root.childFrom;i<root.childTo;i++)nodes.push(doc.child(i))
 let generated=serializeMarkdown(doc.type.create(doc.attrs,Fragment.fromArray(nodes)))
 const last=nodes[nodes.length-1]!
 if(last.type.name==='table') {
  // Contract of the existing renderTableRow/table serializer, generated text only.
  if(!generated.endsWith('\n')||generated.endsWith('\n\n'))throw new UnsupportedBlockTransaction()
  generated=generated.slice(0,-1)
 }
 return generated+base.source.slice(root.tailFrom,root.sourceTo)
}
function applySourceEdits(base:SourceSession,edits:readonly SourceEdit[],ids:readonly number[],ownership:RootIndex):string {
 const authorized=ids.map(id=>ownership.rootById[id]!)
 let at=0,ownerIndex=0
 const chunks:string[]=[]
 for(const edit of edits) {
  // ids and edits are in raw source order; each authorized root is visited at most once.
  while(ownerIndex<authorized.length&&authorized[ownerIndex]!.sourceTo<edit.to)ownerIndex++
  const owner=authorized[ownerIndex]
  if(!owner||owner.sourceFrom>edit.from||owner.sourceTo<edit.to
   ||edit.from<at||edit.to<edit.from||edit.to>base.source.length
   ||splitsSurrogate(base.source,edit.from)||splitsSurrogate(base.source,edit.to))
   throw new UnsupportedBlockTransaction()
  chunks.push(base.source.slice(at,edit.from),edit.text);at=edit.to
 }
 chunks.push(base.source.slice(at))
 return chunks.join('')
}
export function applySourceBlockTransaction(base:SourceSession,tr:Transaction):SourceBlockResult {
 if(!tr.before.eq(base.doc))return {ok:false,reason:'stale-document'}
 try {
  const ownership=indexSourceRoots(base)
  const changedRoots=changedNaturalRoots(base,tr,ownership)
  if(!changedRoots.length) {
   if(!tr.doc.eq(base.doc))return {ok:false,reason:'unsupported-step'}
   return {ok:true,session:base,mode:'unchanged',edits:[],changedRoots:[]}
  }
  // Only a single ReplaceStep can satisfy the old exact API. Replay this one
  // document step to remove stored-mark bookkeeping without touching the caller.
  if(tr.steps.length===1&&tr.steps[0] instanceof ReplaceStep) {
   const replay=EditorState.create({doc:base.doc}).tr.step(tr.steps[0]!)
   if(!replay.doc.eq(tr.doc))return {ok:false,reason:'unsupported-step'}
   const exact=applySourceTextTransactionWithEdit(base,replay)
   if(exact.ok) {
    const edits=[exact.edit]
    if(applySourceEdits(base,edits,changedRoots,ownership)!==exact.session.source)
     return {ok:false,reason:'semantic-mismatch'}
    return {ok:true,session:exact.session,mode:'exact-text',edits,changedRoots}
   }
  }
  // Exact rejection is not authorization: changedNaturalRoots has already
  // proved step kinds, real ranges, stable root identity and ownership.
  const edits=changedRoots.map(id=>{
   const root=ownership.rootById[id]!
   return {from:root.sourceFrom,to:root.sourceTo,text:renderChangedRoot(base,tr.doc,root)}
  })
  const source=applySourceEdits(base,edits,changedRoots,ownership)
  const parsed=createSourceSession(source,base.doc.type.schema)
  if(!parsed.ok||!parsed.session.doc.eq(tr.doc))return {ok:false,reason:'semantic-mismatch'}
  return {ok:true,session:{...parsed.session,revision:base.revision+1},
   mode:'root-render',edits,changedRoots}
 }catch(error) {
  if(error instanceof UnsupportedBlockTransaction)return {ok:false,reason:'unsupported-step'}
  return {ok:false,reason:'parse-error'}
 }
}
```

这里的 PM `.eq` 比较只识别**实际 tr 是否改动该 root**，没有先 canonical parse/serialize 再比较来决定原文回填。所有 steps 的原始 ranges 在各自 `tr.docs[i]` 坐标解释，不把当前 from/to 套到 base 偏移；root 边界稳定以 child index 保持对应，节点长度变化不会把后续 root offset 算错。rootById / ownerByChild 每事务只建立一次；每步使用实际 `tr.docs[i].resolve(from/to).index(0)` 定位涉及的顶层 child，只检查该真实范围的 owner，不建立 childOffsets、不扫描所有顶层节点。只接受实际标准 Step prototype：Add/RemoveMark 保持结构，closed inline slice 的同 inline-parent Replace 保持顶层 child 对应关系；由该支持集合归纳证明中间状态边界稳定。最后一次全顶层 sameMarkup / eq 检查同时验证结构、完整 attrs 和实际变化是否属于授权 root，并滤掉 net-zero root。多步事务直接走 renderer，不为必然失败的单-step exact API 重放整串步骤。

设 N 为顶层 child 数、S 为步骤数、K 为所有步骤真实范围涉及的顶层 child 数之和；本 adapter 的授权及最终结构检查是 O(N+S+K)，另加每步插入 slice 遍历和最终必要的语义比较。这里不把 ProseMirror 原生 resolve/findIndex 或事务构建已有的成本冒称为 O(1)，也不新造 Fenwick / 通用映射框架。真实 `tr.addMark` 跨普通段落常产生 S=N 个空 StepMap 的 AddMarkStep，测试用 12/24/48 根块记录 old-doc child 访问，证明不再额外增加 S*N 全文检查；不是耗时阈值 benchmark。changedRoots 按 source 顺序排列，raw edits 仍用单向授权 owner 游标，未改根块/间隙字节和 strict final intended doc equality 门槛不变。

语义 guard 比较全部 attrs/marks；例外不是“忽略不持久化 attrs”，而是拒绝。补下面无条件自定义 schema attr 测试到同一 core 测试文件，在 import 加 `Schema` 和 `defaultSchema`：

```ts
it('rejects unknown node attrs rather than erasing them',()=>{
 const paragraph=defaultSchema.spec.nodes.get('paragraph')!
 const schema=new Schema({
  nodes:defaultSchema.spec.nodes.update('paragraph',{
   ...paragraph,attrs:{...paragraph.attrs,privateLayout:{default:null}},
  }),marks:defaultSchema.spec.marks,
 })
 const opened=createSourceSession('A',schema)
 expect(opened.ok).toBe(true);if(!opened.ok)throw new Error(opened.reason)
 const b=opened.session
 // A node attrs operation is rejected explicitly, never by dropping attrs.
 reject(b,transaction(b).setNodeMarkup(0,undefined,{...b.doc.firstChild!.attrs,privateLayout:42}))
})
```

最后在 source-fidelity.ts 定义本稿开头的 `SourceBlockResult` union，并在 src/index.ts 现有 fidelity exports 旁增加：

```ts
export {applySourceBlockTransaction} from './source-fidelity'
export type {SourceBlockResult} from './source-fidelity'
export type {SourceRoot,SourceGap,SyntheticEmission,SourceEdit} from './source-ownership'
```

`defaultSchema` 是 core `../schema` 的真实导出；`Schema` 从 prosemirror-model runtime 导入。无需新 helper、不改默认 schema。保留这里无条件 unknown attr 和既有 table colwidth gate。

- [x] **N2.5 精确 API 回归、root metadata 重建和 core GREEN。** 每个成功 fallback 都已走 createSourceSession 重建 roots/gaps，revision 恰好加 1；失败无 session。旧 applySourceTextTransaction 的 mark/multi-step/storedMarks negative 全部保留；新的支持只通过新 API。对未知 token、synthetic paragraph、无 owner 空文档继续 fail closed，不扩大邻居范围尝试凑 equality。

```sh
./node_modules/.bin/vitest run src/__tests__/source-block-fidelity.spec.ts src/__tests__/source-ownership.spec.ts src/__tests__/source-fidelity.spec.ts src/__tests__/source-fidelity-corpus.spec.ts src/__tests__/source-document-capture.spec.ts src/__tests__/source-trace.spec.ts src/__tests__/source-projection.spec.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsup
```

- [x] **N2.6 添加 installed core host RED→GREEN。** 在 core N2 实现前或同步 N2 dist 前，创建以下完整 host 文件；producer 必须 import 安装版 root，不 alias 到 sibling src。

```ts
import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import {Slice} from 'prosemirror-model'
import {createSchema,createSourceSession,applySourceBlockTransaction} from '@moraya/core'
import {materializeBlocks} from '../../editor-kit-v2/block-layout'
import {withBlockIdentitySchema,withoutBlockIdentity} from '../../editor-kit-v2/identity'
import {propose} from './proposal'
function position(doc:any,needle:string) {
 let result:number|undefined
 doc.descendants((n:any,p:number)=>{if(n.isText&&result===undefined){const i=n.text.indexOf(needle);if(i>=0)result=p+i}})
 if(result===undefined)throw new Error('fixture text missing')
 return result
}
it('installed exact text output remains one sentence hunk',()=>{
 const source='首段不动。\r\n\r\n目标甲。第二句保持 __原样__。\r\n'
 const opened=createSourceSession(source);expect(opened.ok).toBe(true)
 if(!opened.ok)throw new Error(opened.reason)
 const b=opened.session,p=position(b.doc,'甲')
 const r=applySourceBlockTransaction(b,EditorState.create({doc:b.doc}).tr.insertText('乙',p,p+1))
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.mode).toBe('exact-text')
 expect(Buffer.from(r.session.source)).toEqual(Buffer.from(source.replace('甲','乙')))
 const proposal=propose({path:'a.md',base:source,ours:source,theirs:r.session.source})
 expect(proposal.theirsEolAligned).toBe(false);expect(proposal.hunks).toHaveLength(1)
 const h=proposal.hunks[0]!
 expect(h.kind).toBe('theirs-only');expect(h.base).toBe('目标甲。');expect(h.theirs).toBe('目标乙。')
 expect(h.oursStart).toBe(source.indexOf('目标甲。'));expect(h.oursEnd).toBe(h.oursStart+'目标甲。'.length)
})
it('one governed span with multiple PM roots only rewrites its changed natural root',()=>{
 const raw='First __raw__\r\n\r\nTarget\r\n\r\nLast *raw*\r\n'
 const schema=withBlockIdentitySchema(createSchema({mediaResolver:{
  loadLocalImage:async p=>p,loadLocalMedia:async p=>p,loadRemoteMedia:async p=>p,
 }}))
 const initial=materializeBlocks([{blockId:'one-governed-span',markdown:raw}],schema)
 expect(initial.layout.spans).toEqual([{blockId:'one-governed-span',startIndex:0,endIndex:3}])
 const opened=createSourceSession(raw,schema);expect(opened.ok).toBe(true)
 if(!opened.ok)throw new Error(opened.reason)
 const b=opened.session
 // Existing identity adapter neutralizes only cdrBlockId, not formatting attrs.
 const content=initial.doc.copy(withoutBlockIdentity(new Slice(initial.doc.content,0,0)).content)
 expect(content.eq(b.doc)).toBe(true)
 const p=position(b.doc,'Target')
 const tr=EditorState.create({doc:b.doc}).tr.addMark(p,p+6,schema.marks.strong!.create())
 const r=applySourceBlockTransaction(b,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.changedRoots).toEqual([1]);expect(r.edits).toHaveLength(1)
 expect(r.session.source).toBe('First __raw__\r\n\r\n**Target**\r\n\r\nLast *raw*\r\n')
 const kernel=propose({path:'governed.md',base:raw,ours:raw,theirs:r.session.source})
 expect(kernel.theirsEolAligned).toBe(false)
 expect(kernel.hunks).toHaveLength(1)
 expect(kernel.hunks[0]!.base).toBe('Target\r\n')
 expect(kernel.hunks[0]!.theirs).toBe('**Target**\r\n')
})
it('installed fallback keeps table-adjacent root and separator bytes',()=>{
 const raw='| A |\n| --- |\n| Target |\n\nTail __raw__\r\n'
 const opened=createSourceSession(raw);expect(opened.ok).toBe(true)
 if(!opened.ok)throw new Error(opened.reason)
 const b=opened.session,p=position(b.doc,'Target')
 const r=applySourceBlockTransaction(b,EditorState.create({doc:b.doc}).tr.addMark(p,p+6,b.doc.type.schema.marks.strong!.create()))
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.changedRoots).toEqual([0]);expect(r.edits).toHaveLength(1)
 expect(r.session.source.endsWith('\n\nTail __raw__\r\n')).toBe(true)
 const proposal=propose({path:'table.md',base:raw,ours:raw,theirs:r.session.source})
 expect(proposal.theirsEolAligned).toBe(false)
 for(const h of proposal.hunks){expect(h.oursEnd).toBeLessThanOrEqual(raw.indexOf('\n\nTail')+1)}
 // Canonical formatting inside the actually changed table can create several hunks.
 expect(proposal.hunks.length).toBeGreaterThan(0)
})
```

table 已触碰自然块的 canonical 内部变化允许多个 hunk，但所有 hunk 必须停在 table owner 内，不能影响邻接 raw root/gap；这与普通段落 exact 一句一 hunk 是两个不同断言，不互相替代。

host 既有 `src/editor-kit-v2/source-fidelity.test.ts` 添加：

```ts
it('keeps BOM legacy materialization fail closed before the future opt-in adapter',()=>{
 const raw='\uFEFF# H\n'
 const legacy=materializeBlocks([{blockId:'bom',markdown:raw}],schema).doc
 expect(legacy.firstChild!.type.name).toBe('paragraph')
 expect(()=>createSourceFidelity(raw,legacy)).toThrow(/SOURCE_FIDELITY/)
})
```

该文件原本就已定义 schema / materializeBlocks / createSourceFidelity / it / expect，无缺失 helper。旧 storedMarks 拒绝测试继续保留，因为当前 adapter 尚未接新 block API；未来 adapter 才允许普通 EditorState 的 stored marks 状态变更。

执行 RED，记录安装 root SHA；若 installed 与 build realpath 相同，必须在产品实现前留下 RED，不能为测试改坏产物：

```sh
./node_modules/.bin/vitest run src/lib/share-merge/source-block-fidelity.test.ts src/editor-kit-v2/source-fidelity.test.ts
```

core N2 所有 gate 通过且提交后，host 同步已提交 dist：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';
const src=fs.realpathSync('../moraya-core/dist');
const dst=path.join(fs.realpathSync('node_modules/@moraya/core'),'dist');
if(fs.realpathSync(dst)!==src)fs.cpSync(src,dst,{recursive:true});
fs.rmSync('node_modules/.vite/deps',{recursive:true,force:true});
console.log(JSON.stringify({src,dst}));
JS
./node_modules/.bin/vitest run src/lib/share-merge/source-block-fidelity.test.ts src/lib/share-merge/source-fidelity.test.ts src/editor-kit-v2/source-fidelity.test.ts
./node_modules/.bin/vitest run
node scripts/check-share-merge-purity.mjs
./node_modules/.bin/vite build
node scripts/check-editor-kit-build.mjs
env PLAYWRIGHT_MODULE=/Users/bruce/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs \
  SOURCE_FIDELITY_OUTPUT_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-natural-block-source/browser \
  SOURCE_FIDELITY_CACHE_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-natural-block-source/vite-cache \
  node scripts/check-source-fidelity-browser.mjs
```

browser OUTPUT / CACHE 显式归本下一计划独立 workspace，禁止回落 harness 的旧默认目录。最后一项只复跑现有批准的 Kit 单块 browser gate；它不证明 new block API 已接 Kit、Source、撤销或协作出口。Playwright 安装路径缺失则报告环境缺项，不自动安装。无 source-history 之前不能把 Rich mark undo/redo 的语义恢复称为原块字节恢复。

- [x] **N2.7 交付两个仓库的可重建产物。** core 精确 stage source-fidelity/index/本任务测试和 tracked dist，提交 `feat(core): splice changed natural source blocks`；host 精确 stage 两个测试和确实变化的依赖 manifest/lock，提交 `test(editor): gate installed natural block source output`。source ownership 如需修正只能在 N1 门槛仍绿且明确记录后包含，不顺手改其他代码。ledger 记录 focused/full 数量、bundle bytes、SHA、普通 exact 与 root-render 能力、已拒绝的具体结构反例。

## 每任务产物和提交门槛

N1 / N2 core 各在 full tests、typecheck、tsup 后执行：

```sh
git diff --check
node --input-type=module <<'JS'
import fs from 'node:fs';import {gzipSync} from 'node:zlib';import assert from 'node:assert/strict';
const gzip=gzipSync(fs.readFileSync('dist/index.js')).length;
assert.ok(gzip<=81920,`core gzip ${gzip} > 81920`);console.log(JSON.stringify({gzip}));
JS
git diff --name-only -- dist
```

精确 stage（每任务只运行自己的行）：

```sh
# N1
git add src/source-trace.ts src/source-ownership.ts src/markdown.ts src/source-fidelity.ts src/__tests__/source-ownership.spec.ts src/__tests__/source-document-capture.spec.ts
# N2
git add package.json pnpm-lock.yaml tsup.config.ts src/source-fidelity.ts src/index.ts src/__tests__/source-block-fidelity.spec.ts src/__tests__/source-fidelity.spec.ts
```

tracked dist 单独根据实际变更列表 stage；不得 `git add .` 或吸收并行产品内容：

```sh
node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
const files=execFileSync('git',['diff','--name-only','-z','--','dist']).toString().split('\0').filter(Boolean);
for(const file of files)execFileSync('git',['ls-files','--error-unmatch','--',file]);
if(files.length)execFileSync('git',['add','-u','--',...files]);
JS
git diff --cached --stat
git diff --cached --check
```

N2 两仓各自提交且 host sync 后执行以下 committed/build/installed 全 tracked dist 核对，以及两个提交内的 14 fixtures / manifest SHA 核对；在本下一计划验证 workspace 存 stdout JSON，记录两仓 HEAD/status，不读取秘密 `.env`：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';import {gzipSync} from 'node:zlib';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const installed=fs.realpathSync(fileURLToPath(import.meta.resolve('@moraya/core')));
const host=fs.realpathSync('.'),core=fs.realpathSync('../moraya-core'),built=path.join(core,'dist/index.js');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sha=p=>hash(fs.readFileSync(p));
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:core}).toString().trim();
const hostCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:host}).toString().trim();
const tracked=execFileSync('git',['ls-files','-z','dist'],{cwd:core}).toString().split('\0').filter(Boolean);
const hashes={};
for(const relative of tracked){
 const local=path.join(core,relative),target=path.join(path.dirname(installed),relative.slice(5));
 const committed=execFileSync('git',['show',`${commit}:${relative}`],{cwd:core,maxBuffer:32*1024*1024});
 assert.equal(sha(local),hash(committed),`build not committed: ${relative}`);
 assert.equal(sha(target),hash(committed),`installed mismatch: ${relative}`);
 hashes[relative]=hash(committed);
}
assert.equal(sha(installed),sha(built));
const gzip=gzipSync(fs.readFileSync(built)).length;assert.ok(gzip<=81920);
const coreCorpus='src/__tests__/fixtures/source-fidelity';
const hostCorpus='src/share-editor/__fixtures__/corpus/source-fidelity';
const committedFile=(repo,head,relative)=>execFileSync('git',['show',`${head}:${relative}`],{cwd:repo,maxBuffer:32*1024*1024});
const coreManifest=committedFile(core,commit,`${coreCorpus}/manifest.json`);
const hostManifest=committedFile(host,hostCommit,`${hostCorpus}/manifest.json`);
const manifestSha256=hash(coreManifest);
assert.equal(hash(hostManifest),manifestSha256,'committed corpus manifests differ');
assert.equal(sha(path.join(core,coreCorpus,'manifest.json')),manifestSha256,'core working manifest not committed');
assert.equal(sha(path.join(host,hostCorpus,'manifest.json')),manifestSha256,'host working manifest not committed');
const corpus=JSON.parse(coreManifest.toString('utf8'));assert.equal(corpus.length,14);
assert.equal(new Set(corpus.map(f=>f.name)).size,14);
const fixtureSha256={};
for(const f of corpus){
 const coreRelative=`${coreCorpus}/${f.name}.md`,hostRelative=`${hostCorpus}/${f.name}.md`;
 const coreBytes=committedFile(core,commit,coreRelative),hostBytes=committedFile(host,hostCommit,hostRelative);
 assert.equal(hash(coreBytes),f.sha256,`core committed fixture ${f.name}`);
 assert.equal(hash(hostBytes),f.sha256,`host committed fixture ${f.name}`);
 assert.equal(coreBytes.length,f.bytes);assert.equal(hostBytes.length,f.bytes);
 assert.equal(sha(path.join(core,coreRelative)),f.sha256,`core working fixture ${f.name}`);
 assert.equal(sha(path.join(host,hostRelative)),f.sha256,`host working fixture ${f.name}`);
 fixtureSha256[f.name]=f.sha256;
}
console.log(JSON.stringify({coreCommit:commit,hostCommit,installed,gzip,hashes,manifestSha256,fixtureSha256},null,2));
JS
git status --short
git -C ../moraya-core status --short
```

不把 SHA 验证替代 tests，也不把 tests 替代实际安装路径核验。若 node_modules 与 built 不同路径，必须比较全部 tracked dist 和 package exports 使用的入口；不删除未知旧安装文件，先报告具体残留与影响。

## REQUIRED FOLLOWUPS：仍须继续完成的产品目标

本计划完成后，完整 §12.4 / §12.9 / I7 仍未完成；以下不是永久功能排除，也不是当前两任务的实现范围。

1. **结构命令及边界权限。** 为真实 Enter/split/join/insert/delete/ReplaceAround/input rules 逐项定义明确触碰的 owner 和 separator；删除 B 不能保留两侧 separator 产生额外段落，也不能删除 opaque reference gap。先跑有限真实 parser/command probe，再冻结实现。候选解决方向是 capture-only 恢复 trailing blank paragraphs 与 terminal hardbreak（Kit parseBlock 已有 latter 先例），使 fidelity doc 能表达 Enter 而不改变 legacy；leading/trailing 文本空格由局部 renderer 输出 numeric entities 保住语义。这些是待验证候选，当前不引入通用兼容框架或放宽 equality。
2. **命令 attrs 可持久化合同。** code-block command 的 language 默认值应与 parser 的 `'text'` 对齐，而不是忽略 language attrs。table colwidth 属于现有 Markdown parser/serializer 均不持久化的展示属性；必须明确其存储/命令范围，不能静默丢掉 attrs guard。行列、alignment、task checked、literal info/fence、CSV/math/media attrs 通过各自真实命令另验。
3. **Source history。** 对 source edits / 原片段 / revision 与真实 native Rich history group、input rules 和 identity normalization 原子对齐；撤销必须恢复原 `__A__` 的字节，不能只反序列化回 `**A**`。保留既有 governed history，不另造无消费者 snapshot 栈，不用 addToHistory:false 整文替换回避。
4. **Kit opt-in 与业务身份。** 相关准确文件为 `src/editor-kit-v2/main.ts`、`block-layout.ts:materializeBlocks/serializeSpan`、`source-fidelity.ts:createSourceFidelity/contentDoc`、`identity.ts:withoutBlockIdentity`。未来 preserveSource 先用实际 custom schema 的 `createSourceSession(raw).doc` materialize，再绑定 cdrBlockId；host 仅中和这个已知纯 PM 身份 attr，证明 identity-only step 无其他变化后才能剥离。保留 filterTransaction 先追加 identity normalization 再 prepare、prepared WeakMap 和 apply 原子提交顺序。一个 governed span 的多个自然 roots 必须按本计划的 root edits 分开，不能整体 serializeSpan。
5. **Stored marks 与 annotation 授权。** 新 core block API 对 storedMarks-only 返回原 source/session，不代表当前旧 adapter 已可接受它。未来 adapter 必须允许普通 EditorState 安装 stored marks，影响下一次输入，同时无 source revision；不能继续一概拒绝 storedMarksSet。owner annotation mark / point node 的授权由宿主真实准入保护；core `.eq(tr.doc)` 只证明忠于意图，不证明意图获准，不能拿 note 文本伪造 owner 身份。
6. **Source 模式及完整网页/桌面验证。** raw buffer、DOM selection、IME/paste/drop/native undo、Source→Rich 真正局部 PM 更新、envelope/gaps/reference/footnote 依赖、remote/CDR 再基线、所有 draft 出口统一 source、13 类语料三轮 Rich↔Source 零 diff、真实普通段落一字 1 句 hunk、指定平台 IME 和发布门槛仍须完成。

本稿的成功口径仅为：parser-owned natural root 元数据、精确文字优先、稳定自然块 mark/inline/multi-step 局部输出、严格 untouched raw bytes 和 intended doc equality、安装版构建门槛。root 自审后记录实际结果；不以本稿或 scratch 提前宣称 I7、E1、E4、撤销、Source 或通用编辑完成。

## Root 自审与连续实施

自审覆盖N1/N2每项及共享接口：真实token ownership/PM emission和synthetic gaps、BOM工作trace语义、exact优先/strict局部renderer、真实多步mark范围与一次最终结构校验、actual captureCursor/firstPiece复用、Step直接peer/external同包身份、14committed原字节语料/产物、当前计划独立browser路径。发现与修正及全部剩余spec范围写入本计划独立ledger；不启动plan-reviewer席位。Task brief须同时包含GlobalConstraints与共用产物门槛，因为既有提取脚本只抽对应Task。用户已授权持续实现到两端完成及统一发版，直接main，不重复询问实施方式。

## 执行中实际 renderer 合同修正

Ruling: N2局部renderer临时fragment为equals highlight与strong/em采用连续highlight外层的渲染顺序 — 真实required正例生成**==Alpha==**== beta==，markdown-it因后半delimiter紧接空格而丢highlight；仅重排临时渲染marks可表达==**Alpha** beta==，保留原意图/默认serializer — 若交叉mark组合仍不可表达会继续fail closed并暴露具体反例，须以strong/em组合及邻接范围回归证明；绝不修改base/tr.doc、attrs/schema、guard或未知raw授权。

临时渲染fragment只对上述已证明的mark嵌套调整，不更新来源会话或意图文档。测试覆盖原正例、strong/em组合、highlight区间外相邻marks和未改raw尾块；全部attrs/marks严格重解析继续作为接受条件。

Ruling: N2对已exact-prototype验证的标准ReplaceStep.structure使用只读交叉类型断言 — 实际transform1.12.0运行时确有own property且false/true与toJSON一致，但DTS不公开该字段，保留原属性读取比toJSON复制slice更小 — 若依赖升级去掉该私有属性会失去structure判别，故记录实际版本/运行时合同并保留structure正反例；本轮不升级，最终strict语义/边界验证仍在。

## 最终实证后的必要源码保护修正

Ruling: 唯一finalfix增加实际reference消费区间的源码保护，并对覆盖该区间的局部root-render拒绝 — root在最终审查后用真实安装包复现list/quote内unused definition被删且doc.eq仍true，语义守卫无法保护不可见原文，不能留给未来默默丢内容 — 部分含nested定义的格式操作暂时明确拒绝，须在后续局部结构/保留片段renderer补齐，不能称完整编辑已完成；无格式过滤/regex猜定义/全篇canonical。

最终统一修复必须在同一实际reference block rule成功非silent调用后，以最终state.line和capture物理lineStarts投回原始raw protected spans（包括nested、duplicate、title rollback、EOF/BOM/CRLF）。stable root-render不能删除这些span；精确source edit也须独立不相交验证。legacy parser/完整token.map不改，fullblank结构语义仍后续。详见当前计划证据的root-final-review-addendum.md及最终正式报告。
