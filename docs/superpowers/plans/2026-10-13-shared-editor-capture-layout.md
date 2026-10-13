# 共享编辑器空段来源与末硬换行实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Tech Stack:** TypeScript、markdown-it、ProseMirror、Vitest、tsup、现有Vite/Kit；不安装升级依赖。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.4/I7 与最新用户批准的共享保真前置、网页和桌面协作。此独立计划仅完成空段与末硬换行前置；结构/history/Source/两端/发布继续必做。

root已完整自审计划及实际前置；下文修正已接入，不预填执行通过。自审表见 `docs/superpowers/reports/2026-10-13-capture-layout-plan-preflight.md`。

**Goal:** capture-only 文档显式表达有来源的顶层空段与末 hardbreak；自然 root 完整 map、原始源码和 legacy parser/serializer 保持各自合同；为后续结构事务提供有限 blank 子权限，不开启结构事务。

**Architecture:** 在现有同 parser token 流与实际 PM handler 上增加 `SourceLayout`。reference consumed spans 直接消费前置 finalfix 的 `protectedSources`，不再次包装 reference rule。真实 blank units 可来自 gap 或完整 list root 的 tail。末 hardbreak 由同 paragraph/getLines 的 trim 前事实恢复给原 inline parser；仅 source-root 局部 serializer 对连续尾 hardbreak 使用标准反斜杠换行。本切片没有 terminal raw 删除授权类型。

**已选定产品规则：** reference 空白采用 runs：每段连接两个语法实体或紧邻 definition 的连续真实 blank run 扣首行作为 separator，其余每完整物理行一个空 paragraph。纯空文件 k 个 LF/CRLF/loneCR 为一个 rawless baseline paragraph 加 k 个真实 blank paragraph。BOM 不贡献 blank unit。普通 `A\n` 仍只有 A，`A\n\n` 为 A+一空段。

## Global Constraints 与前置

沿用 `docs/superpowers/plans/2026-10-13-shared-editor-natural-block-source.md` 的 Global Constraints、I7、两仓独立提交和产物门槛，以下是本计划每个任务必须一起提取的完整执行约束：

- 直接 mdeditor/main 与 moraya-core/main，单一产品 writer；不建分支/worktree，保留未知未跟踪项、stash、force-pull backup。不读取 `.env`。本计划不授权发布或更改生产入口。
- root已受理 N1/N2 + R1 finalfix：core `b5602875ad4805b844d476cb9df8d98d5d3b3a22`、host `a7136c292024f95c22256ff6a2ee60a5c302b66b`；本计划已用git-show核对新collector字段。此前研究核对 core `1af55743c62e7793f5818a4c28ad33fb7bf890e6` 的 capture 与 `0566f16e0eb44e2070797aa2681b9f09c5d5cbcd` 的 stable renderer，legacy `4a67ebbff738d00f4761da2ab2acb106b48c8e2c`。实际实施前仍记录当时core/host HEAD、status、已安装入口realpath/SHA；必须以受理提交或经root明确纳入的后续提交为基线，不能消费并行未提交代码。本计划没有重跑root报告的finalfix验收。
- 前置在 `source-ownership.ts` 定义、由 markdown/source-fidelity import type、由 index 转导出 `ProtectedSource={kind:'reference-definition';sourceFrom:number;sourceTo:number;scope:'top-level'|'nested'}`、capture/session `protectedSources`。原实际 reference rule 成功且非 silent 后，最终 state.line→缓存物理 lineStarts→同 trace→raw；精确与 root edits 均拒绝覆盖 protected spans。本计划保留该实现和测试，绝不再次实现规则或以 env.references 差异替代。
- raw/source/PM offset 为 UTF-16；原字节用 UTF-8 Buffer 比较。保留 CRLF/loneCR/混合换行/BOM/末换行/unused definitions/未改字符。不做全篇 canonical 后过滤 diff，不改变原 root map 来掩盖 tail，不忽略任何 attrs。
- legacy `parseMarkdown` / async / `serializeMarkdown` 签名和默认语义不变；schema 不变；内部新增 helper 只服务真实生产 source API，不增加测试专用生产入口。不改 history、CDR、Source DOM、Kit main、annotation 授权。
- 只用已安装 `./node_modules/.bin/vitest` / `tsc` / `tsup` / `vite`；不运行 pnpm/npx 安装，不升级依赖，不改 node_modules 源码。host 只同步已提交 core dist；显式审计 exports 和所有 tracked dist（含 DTS closure）。
- core `dist/index.js` gzip ≤81920 bytes。源码/新增内部类型与 tracked dist 同次 core 提交；host 测试/实际依赖锁变化单独提交。禁止 `git add .`。新生成被声明入口引用的 DTS 必须精确 stage，消失的旧 hash DTS 必须精确删除，不留悬空声明。
- 两任务各自 RED→focused GREEN→typecheck/full/build→产物审计→提交→独立spec与quality审查。测试失败按具体原因修，不能把 layout 冲突误称旧测试过时而删除 guard。
- 本计划独立 workspace 固定为 `/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/`；日志、命令/退出码、SHA、browser screenshots 和 Vite cache 全部显式归该目录。执行阶段以sdd-workspace解析并创建，禁止访问旧或兄弟工作区。没有最终 HEAD、通过计数或截图时不得写“通过”。

## 共享合同与依赖审清

自然 roots/gaps 的 raw 分区完全不变。`gaps[].synthetic` 仍是兼容关联数组，但只收 `container.kind==='gap'` 的真实空段；root-tail 空段和 rawless baseline 不伪挂空 gap。所有新 layout 来源由独立 `session.layout` 提供。

stable N2 `indexSourceRoots` 仅按实际 natural root `childFrom..childTo` 建 ownerByChild；synthetic 与 baseline 没有自然 owner。普通 body mark/inline replacement 仍可输出；触碰 synthetic/baseline、删除或 split/join root 继续明确拒绝。不得为了让它们“可编辑”把 owner 扩到 synthetic 或删除 guard。

坐标测试使用当前真实 schema 的固定 fixture：`- A\n\n\nB` 应为 list PM `[0,7)`、empty `[7,9)`、B `[9,12)`；自然 child 分别 `[0,1)` 与 `[2,3)`。实施时必须核对实际 parser 节点并维持这些固定 expected，不能改成从待测结果推 expected。

新增源码类型放 `src/source-layout.ts`；只从 index 导出 readonly 数据类型，不公开 parser private helper：

```ts
import type {SyntheticEmission} from './source-ownership'
export type LayoutContainer = Readonly<
  {kind:'gap';gapIndex:number}|{kind:'root-tail';rootId:number}>
export type BlankLineUnit = Readonly<{
  id:number;sourceFrom:number;sourceTo:number;container:LayoutContainer
}> & (Readonly<{role:'separator'}> |
  Readonly<{role:'empty-paragraph';emission:SyntheticEmission}>)
export type FallbackEmpty = Readonly<{
  kind:'empty-document-baseline';sourceAnchor:number;emission:SyntheticEmission
}>
export type SourceLayout = Readonly<{
  blankLines:readonly BlankLineUnit[];fallback?:FallbackEmpty
}>
```

`sourceAnchor` 只有插入定位意义，不是删除 BOM/opaque prefix 的权限。unit 是恰好一物理空行的 space/tab+完整 EOL；不跨 CRLF，不含 BOM，不含 root 内容行末 LF、不含 quote `>` marker。separator 无 emission。root-tail unit 允许与所属完整 root 区间重叠，禁止与 protected spans 重叠；它不增加 root body 的权限。session 重解析后重新建立所有 ID，不跨 revision 猜对应。

## Task 1：capture-only blank/layout/fallback，legacy 不变

**Files:** core 新 `src/source-layout.ts`、`src/__tests__/source-layout.spec.ts`；修改 `src/markdown.ts`、`src/source-fidelity.ts`、`src/index.ts`、`src/__tests__/source-ownership.spec.ts`、`src/__tests__/source-block-fidelity.spec.ts`，tracked dist；host 新 `src/lib/share-merge/source-layout.test.ts`。本任务不包含 hardbreak 修复。

- [ ] **L1.1 先写以下完整 RED**

```ts
import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import {createSourceSession,applySourceBlockTransaction} from '../source-fidelity'
import {parseMarkdown,parseMarkdownAsync,serializeMarkdown} from '../markdown'

function open(source:string) {
 const r=createSourceSession(source);expect(r.ok).toBe(true)
 if(!r.ok)throw new Error(r.reason)
 r.session.doc.check();return r.session
}
function childNames(source:string) {
 const s=open(source),names:string[]=[]
 s.doc.forEach(n=>names.push(n.type.name==='paragraph'&&!n.content.size?'empty':n.type.name))
 return names
}
function verify(source:string) {
 const s=open(source);expect(Buffer.from(s.source)).toEqual(Buffer.from(source))
 expect(s.gaps).toHaveLength(s.roots.length+1)
 let raw='',at=0
 for(const [i,r]of s.roots.entries()){
  expect(s.gaps[i]!.sourceFrom).toBe(at);expect(s.gaps[i]!.sourceTo).toBe(r.sourceFrom)
  raw+=source.slice(at,r.sourceFrom)+source.slice(r.sourceFrom,r.sourceTo);at=r.sourceTo
 }
 raw+=source.slice(at);expect(Buffer.from(raw)).toEqual(Buffer.from(source))
 let last=0
 for(const [i,u]of s.layout.blankLines.entries()){
  expect(u.id).toBe(i);expect(u.sourceFrom).toBeGreaterThanOrEqual(last)
  expect(source.slice(u.sourceFrom,u.sourceTo)).toMatch(/^[ \t]*(?:\r\n|\r|\n)$/)
  expect(s.protectedSources.every(p=>u.sourceTo<=p.sourceFrom||u.sourceFrom>=p.sourceTo)).toBe(true)
  const c=u.container,owner=c.kind==='gap'?s.gaps[c.gapIndex]!:s.roots[c.rootId]!
  expect(u.sourceFrom).toBeGreaterThanOrEqual(c.kind==='gap'?owner.sourceFrom:s.roots[c.rootId]!.tailFrom)
  expect(u.sourceTo).toBeLessThanOrEqual(owner.sourceTo)
  if(u.role==='empty-paragraph'){
   expect(u.emission.childTo).toBe(u.emission.childFrom+1)
   const n=s.doc.child(u.emission.childFrom)
   expect(n.type.name).toBe('paragraph');expect(n.content.size).toBe(0)
   expect(u.emission.pmTo-u.emission.pmFrom).toBe(n.nodeSize)
   expect(s.roots.every(r=>u.emission.childTo<=r.childFrom||u.emission.childFrom>=r.childTo)).toBe(true)
  }
  last=u.sourceTo
 }
 return s
}
it.each([
 ['',1,0],['\n',2,1],['\n\n\n',4,3],[' \t\n\t\n',3,2],
 ['\uFEFF\r\n\r\n',3,2],['\r\n\r',3,2],['A\n',1,0],
 ['A\n\n',2,1],['A\n\n\n',3,2],['\nA',2,1],['\n\nA',3,2],
 ['A\n\n\nB',3,2],
] as const)('captures selected blank count %j',(source,count,units)=>{
 const s=verify(source);expect(s.doc.childCount).toBe(count);expect(s.layout.blankLines).toHaveLength(units)
 const round=open(serializeMarkdown(s.doc));expect(round.doc.eq(s.doc)).toBe(true)
 if(!source.replace(/[\uFEFF \t\r\n]/g,''))expect(s.layout.fallback?.emission.childFrom).toBe(0)
})
it.each([
 'A\n\n[ref]: /url\n\nB',
 'A\n\n[ref]:\n /url\n "title"\n\nB',
 'A\n\n[ref]: /first\n[ref]: /second\n\nB',
])('definition lines never emit synthetic paragraphs %j',source=>{
 const s=verify(source);expect(s.doc.childCount).toBe(2)
 expect(s.layout.blankLines.every(u=>u.role==='separator')).toBe(true)
 expect(s.gaps[1]!.kind).toBe('opaque');expect(s.gaps[1]!.synthetic).toHaveLength(0)
})
it('captures a long complete blank run without unbounded argument spreading',()=>{
 const count=140000,source='\n'.repeat(count),s=open(source)
 expect(s.source).toBe(source);expect(s.doc.childCount).toBe(count+1)
 expect(s.layout.blankLines).toHaveLength(count)
 expect(s.layout.blankLines[0]!.sourceFrom).toBe(0)
 expect(s.layout.blankLines[count-1]!.sourceTo).toBe(count)
},15000)
it('applies runs to prefix/reference-only and excess blank lines',()=>{
 expect(childNames('[ref]: /url\n\nB')).toEqual(['paragraph'])
 const only=verify('[ref]: /url\n\n');expect(only.doc.childCount).toBe(1)
 expect(only.layout.fallback).toBeDefined();expect(only.layout.blankLines[0]!.role).toBe('separator')
 const extra=verify('A\n\n\n[ref]: /url\n\n\nB')
 expect(extra.doc.childCount).toBe(4)
 expect(extra.layout.blankLines.map(u=>u.role)).toEqual(['separator','empty-paragraph','separator','empty-paragraph'])
})
it('keeps complete list map, actual handler coordinates and independent tail origins',()=>{
 const source='- A\n\n\nB',s=verify(source)
 expect(s.roots.map(r=>[r.sourceFrom,r.sourceTo,r.tailFrom,r.childFrom,r.childTo,r.pmFrom,r.pmTo]))
  .toEqual([[0,6,3,0,1,0,7],[6,7,7,2,3,9,12]])
 expect(s.layout.blankLines.map(u=>[u.sourceFrom,u.sourceTo,u.container,u.role]))
  .toEqual([[4,5,{kind:'root-tail',rootId:0},'separator'],[5,6,{kind:'root-tail',rootId:0},'empty-paragraph']])
 expect(s.gaps.flatMap(g=>g.synthetic)).toEqual([])
 const empty=s.layout.blankLines[1]!
 if(empty.role!=='empty-paragraph')throw new Error('fixture empty missing')
 expect(empty.emission).toEqual({childFrom:1,childTo:2,pmFrom:7,pmTo:9})
 const state=EditorState.create({doc:s.doc})
 const marked=applySourceBlockTransaction(s,state.tr.addMark(3,4,s.doc.type.schema.marks.strong!.create()))
 expect(marked.ok).toBe(true);if(!marked.ok)throw new Error(marked.reason)
 expect(marked.session.source).toBe('- **A**\n\n\nB')
 expect(marked.session.doc.childCount).toBe(3)
 expect(marked.session.doc.eq(state.tr.addMark(3,4,s.doc.type.schema.marks.strong!.create()).doc)).toBe(true)
 const rejected=applySourceBlockTransaction(s,state.tr.insertText('X',8))
 expect(rejected.ok).toBe(false);expect('session'in rejected).toBe(false)
 const deletion=applySourceBlockTransaction(s,state.tr.delete(0,7))
 expect(deletion.ok).toBe(false);expect(s.source).toBe(source)
})
it('distinguishes suffix and marker-only quote lines',()=>{
 expect(childNames('- A\n\n\n')).toEqual(['bullet_list','empty','empty'])
 const q=verify('> A\n\n\n');expect(q.doc.childCount).toBe(3)
 expect(q.layout.blankLines.every(u=>u.container.kind==='gap')).toBe(true)
 const marker=verify('> A\n>\n>\n');expect(marker.doc.childCount).toBe(1)
 expect(marker.layout.blankLines).toEqual([])
})
it('does not grant generated math separators or opaque reference spans blank authority',()=>{
 const math=verify('A\n$$\nx\n$$\nB');expect(math.layout.blankLines).toEqual([])
 for(const source of ['> [ref]: /url\n>\n> A\n','- [ref]: /url\n\n  A\n']){
  const s=verify(source);expect(s.protectedSources.some(p=>p.scope==='nested')).toBe(true)
  expect(s.layout.blankLines).toEqual([])
 }
})
it('keeps fallback rawless, default sync/async parsing and serializer unchanged',async()=>{
 const source='\uFEFF\r\n\r\n',s=verify(source)
 expect(s.layout.fallback).toEqual({kind:'empty-document-baseline',sourceAnchor:1,
  emission:{childFrom:0,childTo:1,pmFrom:0,pmTo:2}})
 expect(s.layout.blankLines.map(u=>[u.sourceFrom,u.sourceTo])).toEqual([[1,3],[3,5]])
 for(const raw of ['', '\n','\n\n\n','A\n\n\n','A\n\n[ref]: /url\n\nB']){
  const legacy=parseMarkdown(raw);expect((await parseMarkdownAsync(raw)).eq(legacy)).toBe(true)
  expect(legacy.childCount).toBe(raw.includes('[ref]')?4:1)
 }
 expect(serializeMarkdown(parseMarkdown('A  \n'))).toBe('A')
})
```

运行 core `./node_modules/.bin/vitest run src/__tests__/source-layout.spec.ts` 留真实 RED。安装版同名 host RED 必须在同步新 dist 前执行，代码见共享 host 门槛。

- [ ] **L1.2 完整内部 layout 计算代码**

在 `src/source-layout.ts` 上述类型之后加入以下代码。结构类型只消费 protected span 已存在字段，因此不再定义/包装 reference 规则。blank 候选只扫描实际 collector.trace 行视图；rawRange 是 N1 原函数。

```ts
import {sliceTrace,type SourceTrace} from './source-trace'
import {rawRange,UnsupportedOwnership,type ProtectedSource,type SourceRoot} from './source-ownership'
export type BlankDraft = {
 id:number;sourceFrom:number;sourceTo:number;container:LayoutContainer
 role:'separator'|'empty-paragraph';insertBefore:number;emission?:SyntheticEmission
}
export type LayoutRegion = {
 from:number;to:number;insertBefore:number;gapIndex:number
 left:boolean;right:boolean;previousRoot?:Pick<SourceRoot,'id'|'tailFrom'|'sourceTo'>
}
export function collectBlankDrafts(source:string,trace:SourceTrace,starts:readonly number[],
 regions:readonly LayoutRegion[],protectedSources:readonly ProtectedSource[]):BlankDraft[] {
 const result:BlankDraft[]=[]
 const protectedOrder=protectedSources // 前置collector已按source顺序验证不重叠
 const referenceStarts=new Set(protectedOrder.filter(p=>p.scope==='top-level').map(p=>p.sourceFrom))
 const referenceEnds=new Set(protectedOrder.filter(p=>p.scope==='top-level').map(p=>p.sourceTo))
 let line=0,protectedIndex=0
 for(const region of regions){
  let run:BlankDraft[]=[]
  const flush=()=>{
   if(!run.length)return
   const first=run[0]!,last=run[run.length-1]!
   const touches=referenceEnds.has(first.sourceFrom)||referenceStarts.has(last.sourceTo)
   if((region.left&&region.right)||touches)first.role='separator'
   for(const unit of run)result.push(unit);run=[]
  }
  while(line+1<starts.length&&starts[line]!<region.from)line++
  while(line+1<starts.length&&starts[line+1]!<=region.to){
   const from=starts[line]!,to=starts[line+1]!;line++
   if(to<=from||!/^[ \t]*\n$/.test(trace.text.slice(from,to))){flush();continue}
   const piece=sliceTrace(trace,from,to)
   if(piece.pieces.some(p=>p.kind==='generated')){flush();continue}
   const raw=rawRange(trace,from,to)
   if(!raw||!/^[ \t]*(?:\r\n|\r|\n)$/.test(source.slice(raw.from,raw.to))){flush();continue}
   while(protectedIndex<protectedOrder.length&&protectedOrder[protectedIndex]!.sourceTo<=raw.from)protectedIndex++
   const occupied=protectedOrder[protectedIndex]
   if(occupied&&occupied.sourceFrom<raw.to){flush();continue}
   const prev=region.previousRoot
   let container:LayoutContainer={kind:'gap',gapIndex:region.gapIndex}
   if(prev&&raw.from<prev.sourceTo){
    if(raw.from<prev.tailFrom||raw.to>prev.sourceTo)throw new UnsupportedOwnership()
    container={kind:'root-tail',rootId:prev.id}
   }
   run.push({id:0,sourceFrom:raw.from,sourceTo:raw.to,container,
    role:'empty-paragraph',insertBefore:region.insertBefore})
  }
  flush()
 }
 result.forEach((u,i)=>{u.id=i});return result
}
export function finishSourceLayout(blankLines:readonly BlankDraft[],fallback?:FallbackEmpty):SourceLayout {
 const units:BlankLineUnit[]=blankLines.map(u=>{
  const base={id:u.id,sourceFrom:u.sourceFrom,sourceTo:u.sourceTo,container:u.container}
  if(u.role==='separator')return {...base,role:'separator'}
  if(!u.emission)throw new UnsupportedOwnership()
  return {...base,role:'empty-paragraph',emission:u.emission}
 })
 return fallback?{blankLines:units,fallback}:{blankLines:units}
}
```

物理行只遍历一次，消费已受理collector的有序protected span、双指针检查区间、端点Set判断相接；不按每run重扫定义，不按每root重扫全文。

- [ ] **L1.3 同 token 流注册 natural 与 layout emission**

`markdown.ts` 新增 import `collectBlankDrafts,finishSourceLayout,type BlankDraft,type FallbackEmpty,type SourceLayout,type LayoutRegion`（均来自 `./source-layout`）。在 `CapturedDocument` 新增 `layout:SourceLayout`，保留 finalfix `protectedSources`。在 `Capture` 新增 `source:string;blankLines:BlankDraft[];fallback?:FallbackEmpty`，保留既有 trace/runs/roots/synthetic/protectedSources 与 finalfix 缓存字段；collector 初始化完整替换为 `const collector:Capture={source,trace,lineStarts:[],protectedSources:[],runs:[],roots:[],synthetic:[],blankLines:[]}`；normalize wrapper现有更新 `collector.lineStarts` 的语句保留。

`RootDraft` 新增 `layout?:BlankDraft|'fallback'`。保留原 natural 字段与 `rootStarts/rootEnds`，删除旧 `syntheticTokens` WeakSet。legacy `preserveBlankLines(tokens,capture=false)` 改回 `preserveBlankLines(tokens)`：只删除 `capture` 参数和 `if(capture)syntheticTokens.add(open)`，其原计数实现完全不变。

以如下完整函数替换 `prepareRootEvents`，返回插入了空段的新 token 数组；新函数先完整注册自然 block 的 start/end，synthetic 总是在它们之外注册，所以实际 handler child 边界不会包含相邻 synthetic：

```ts
function prepareRootEvents(tokens:InlineToken[],collector:Capture):InlineToken[] {
 const starts=collector.lineStarts
 const renderable=new Set(['paragraph_open','heading_open','bullet_list_open','ordered_list_open',
  'blockquote_open','table_open','footnote_reference_open','dl_open','hr',
  'fence','code_block','front_matter','html_block','math_block','math_block_eqno'])
 const flowTail=new Set(['bullet_list_open','ordered_list_open','blockquote_open'])
 const natural:{draft:RootDraft;first:number;last:number;from:number;to:number;boundaryTo:number}[]=[]
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i]!
  if(token.level!==0||token.nesting===-1||!token.map)continue
  let last=i
  if(token.nesting===1){
   last=i+1
   while(last<tokens.length&&!(tokens[last]!.level===0&&tokens[last]!.nesting===-1))last++
   if(last===tokens.length)throw new UnsupportedSourceCapture()
  }else if(token.nesting!==0)throw new UnsupportedSourceCapture()
  const from=starts[token.map[0]],to=starts[token.map[1]]
  if(from===undefined||to===undefined||to<=from)throw new UnsupportedSourceCapture()
  const raw=rawRange(collector.trace,from,to)
  if(!raw)throw new UnsupportedSourceCapture()
  let tailFrom=raw.to,boundaryTo=to
  if(renderable.has(token.type)){
   const tailWork=rendererTailStart(collector.trace.text,from,to,token.type)
   const tail=rawRange(collector.trace,tailWork,to)
   if(tail){if(tail.to!==raw.to)throw new UnsupportedSourceCapture();tailFrom=tail.from}
   if(flowTail.has(token.type)&&collector.trace.text[tailWork]==='\n'
    &&/^[ \t\n]*$/.test(collector.trace.text.slice(tailWork+1,to)))boundaryTo=tailWork+1
  }
  const id=natural.length
  const draft:RootDraft={collector,kind:'natural',gapIndex:id,id,tokenType:token.type,
   sourceFrom:raw.from,sourceTo:raw.to,tailFrom}
  rootStarts.set(token,draft);rootEnds.set(tokens[last]!,draft)
  natural.push({draft,first:i,last,from,to,boundaryTo});i=last
 }
 const regions:LayoutRegion[]=[]
 for(let i=0;i<=natural.length;i++){
  const previous=natural[i-1],next=natural[i]
  regions.push({from:previous?.boundaryTo??0,to:next?.from??collector.trace.text.length,
   insertBefore:next?.first??tokens.length,gapIndex:i,left:!!previous,right:!!next,
   previousRoot:previous?.draft})
 }
 collector.blankLines=collectBlankDrafts(collector.source,collector.trace,starts,regions,collector.protectedSources)
 const inserts=new Map<number,InlineToken[]>()
 function emit(at:number,layout:BlankDraft|'fallback'){
  const mk=(type:string,tag:string,nesting:number,extra:Partial<InlineToken>={}):InlineToken=>({
   type,tag,nesting,content:'',children:null,attrs:null,info:'',meta:null,map:null,
   block:true,hidden:false,level:0,markup:'',...extra})
  const open=mk('paragraph_open','p',1),close=mk('paragraph_close','p',-1)
  const draft:RootDraft={collector,kind:'synthetic',gapIndex:0,id:-1,tokenType:'paragraph_open',
   sourceFrom:0,sourceTo:0,tailFrom:0,layout}
  rootStarts.set(open,draft);rootEnds.set(close,draft)
  const items=inserts.get(at)??[]
  items.push(open,mk('inline','',0,{level:1,block:false,children:[]}),close);inserts.set(at,items)
 }
 if(!natural.length)emit(0,'fallback')
 for(const unit of collector.blankLines)if(unit.role==='empty-paragraph')emit(unit.insertBefore,unit)
 const result:InlineToken[]=[]
 for(let i=0;i<=tokens.length;i++){
  const before=inserts.get(i);if(before)for(const token of before)result.push(token)
  if(i<tokens.length)result.push(tokens[i]!)
 }
 return result
}
```

将 `captureRootEmission` 的 synthetic 分支替换为完整下列分支；natural 分支原样保留，不把 layout emission 放入 `roots`：

```ts
if(end.kind==='synthetic'){
 if(end.layout==='fallback'){
  end.collector.fallback={kind:'empty-document-baseline',
   sourceAnchor:end.collector.source.charCodeAt(0)===0xFEFF?1:0,emission}
 }else{
  const unit=end.layout
  if(!unit||unit.role!=='empty-paragraph'||unit.emission)throw new UnsupportedSourceCapture()
  unit.emission=emission
  if(unit.container.kind==='gap')end.collector.synthetic.push({gapIndex:unit.container.gapIndex,emission})
 }
}else end.collector.roots.push({id:end.id,tokenType:end.tokenType,
 sourceFrom:end.sourceFrom,sourceTo:end.sourceTo,tailFrom:end.tailFrom,...emission})
```

`md.parse` 中在原 `tagPairedHtmlInline` / `fixFootnoteDefMaps` 后，完整选择语句为：

```ts
const collector=(env as {[captureKey]?:Capture}|undefined)?.[captureKey]
tokens=collector?prepareRootEvents(tokens,collector):preserveBlankLines(tokens)
return tokens as unknown as ReturnType<typeof _origMdParse>
```

`parseDocumentWithSourceCapture` 成功返回值增加 `layout:finishSourceLayout(collector.blankLines,collector.fallback)`，保留 roots/gaps/textRuns/protectedSources。`source-fidelity.ts` 新增 `import type {SourceLayout} from './source-layout'`；`SourceSession` 增加 `layout:SourceLayout` 并由 `createSourceSession` 原样携带 `parsed.value.layout`；不改 N2 的 `indexSourceRoots` / authorize / changedNaturalRoots / exact 拒绝路径。`index.ts` 只新增 `export type {LayoutContainer,BlankLineUnit,FallbackEmpty,SourceLayout} from './source-layout'`。

旧 `source-ownership.spec.ts` 的 open helper 不再以所有 capture===legacy 作为合同：将该一条 eq 断言替换成 `s.doc.check()`；新增本任务明确的 legacy 不变测试并保留该文件 BOM-specific legacy差异测试。reference fixture 的 root childFrom 从 `[0,3]` 改成 `[0,1]`，gap synthetic 长度从2改成0，增加 `s.layout.blankLines.every(u=>u.role==='separator')`。不要改其他实际完整 raw 分区/handler 坐标测试。`source-document-capture.spec.ts` 的既有 fixtures 未依赖 prefix/suffix新计数，其同 schema legacy eq 继续保留；若后来前置 finalfix新增了布局反例，逐输入改为明确选定期望，不全局删除 legacy checks。

旧 `source-block-fidelity.spec.ts` 的 `preserves opaque references and their synthetic paragraphs` 测试仍应证明真实 synthetic 不可编辑：将该测试的 raw 字面量完整替换为 `'[Alpha][ref]\n\n\n[ref]: /url "T"\n\nTail'`（第一段增加一个实际 blank），保留原 `.synthetic[0]` 插字拒绝与 reference字节保留断言。原fixture只有定义排版空白，按新规则已无synthetic，不应继续索引undefined。

- [ ] **L1.4 验证/提交**

core 运行 focused：`./node_modules/.bin/vitest run src/__tests__/source-layout.spec.ts src/__tests__/source-ownership.spec.ts src/__tests__/source-document-capture.spec.ts src/__tests__/source-block-fidelity.spec.ts`。随后共享 full/typecheck/build/DTS/gzip/14语料门槛，精确提交 `feat(core): capture finite blank layout origins`。安装版 host 测试、构建/browser按共享门槛执行并独立提交。以上结果尚未产生。

## Task 2：实际 getLines 末 hardbreak 恢复与局部 renderer

**Files:** core `src/markdown.ts`、`src/source-fidelity.ts`、新 `src/__tests__/source-terminal-hardbreak.spec.ts`、修改 `src/__tests__/source-block-fidelity.spec.ts`，tracked dist；host `src/lib/share-merge/source-layout.test.ts` 添加本任务 installed gate。Consumes 已验收提交 L1、ProtectedSource前置。Produces 语义 capture 与 source-root 局部表达，不增加 terminal raw span API。

- [ ] **L2.1 完整 RED**

```ts
import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import {createSourceSession,applySourceBlockTransaction} from '../source-fidelity'
import {parseMarkdown,serializeMarkdown} from '../markdown'
function open(source:string){const r=createSourceSession(source);if(!r.ok)throw new Error(r.reason);return r.session}
function breaks(doc:ReturnType<typeof open>['doc']){
 const all:{isInline:unknown}[]=[];doc.descendants(n=>{if(n.type.name==='hardbreak')all.push({isInline:n.attrs.isInline})});return all
}
function textPos(doc:ReturnType<typeof open>['doc']){
 let found=-1;doc.descendants((n,p)=>{if(n.isText&&found<0)found=p});if(found<0)throw new Error('missing text');return found
}
it.each(['A  \n','A\\\n','\uFEFFA  \r\n','- A  \n','> A  \n','A  \n\nB'])(
 'restores actual terminal syntax through original inline parser %j',source=>{
 const s=open(source);s.doc.check();expect(breaks(s.doc)).toEqual([{isInline:false}])
 expect(s.source).toBe(source);expect(breaks(parseMarkdown(source))).toEqual([])
})
it.each(['A\n','A  ','A\\\\\n'])('does not invent terminal atoms %j',source=>{
 expect(breaks(open(source).doc)).toEqual([])
})
it.each(['A\\\n\\\n','A\\\n\\\n\nB','- A\\\n  \\\n'])(
 'renders consecutive terminal hardbreaks only through local root serializer %j',source=>{
 const s=open(source);expect(breaks(s.doc)).toEqual([{isInline:false},{isInline:false}])
 const p=textPos(s.doc),tr=EditorState.create({doc:s.doc}).tr.addMark(p,p+1,s.doc.type.schema.marks.strong!.create())
 const result=applySourceBlockTransaction(s,tr);expect(result.ok).toBe(true)
 if(!result.ok)throw new Error(result.reason)
 expect(result.mode).toBe('root-render');expect(result.session.doc.eq(tr.doc)).toBe(true)
 expect(open(result.session.source).doc.eq(tr.doc)).toBe(true)
 expect(result.session.source).toContain('\\\n')
 expect(result.session.source.endsWith(source.slice(s.roots[0]!.tailFrom,s.roots[0]!.sourceTo)+(source.includes('\n\nB')?'\nB':''))).toBe(true)
})
it.each(['A  \n\n','\uFEFFA  \r\n\r\n','- A  \n\n\n'])(
 'does not duplicate envelope EOL or source-tail empty paragraphs %j',source=>{
 const s=open(source),p=textPos(s.doc),tr=EditorState.create({doc:s.doc}).tr.addMark(p,p+1,s.doc.type.schema.marks.strong!.create())
 const r=applySourceBlockTransaction(s,tr);expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(r.session.doc.childCount).toBe(s.doc.childCount)
 const tail=source.slice(s.roots[0]!.tailFrom,s.roots[0]!.sourceTo)
 expect(r.edits[0]!.text.endsWith(tail)).toBe(true)
 expect(r.session.layout.blankLines.map(u=>r.session.source.slice(u.sourceFrom,u.sourceTo)))
  .toEqual(s.layout.blankLines.map(u=>source.slice(u.sourceFrom,u.sourceTo)))
})
it('keeps sparse text provenance and terminal semantics separate',()=>{
 const s=open('甲  \r\n\r\n')
 expect(s.textSpans).toEqual([{sourceFrom:0,sourceTo:1,pmFrom:1,pmTo:2,kind:'linear'}])
 const tr=EditorState.create({doc:s.doc}).tr.insertText('乙',1,2),r=applySourceBlockTransaction(s,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.mode).toBe('exact-text');expect(r.session.source).toBe('乙  \r\n\r\n')
 expect(open('- 甲  \n').textSpans).toEqual([])
 expect(open('> 甲  \n').textSpans).toEqual([])
})
it('does not change public serializer or authorize invisible definition deletion',()=>{
 const s=open('A\\\n\\\n')
 expect(serializeMarkdown(s.doc)).toBe('A  \n  \n')
 const nested=open('> [ref]: /url\n>\n> A  \n'),p=textPos(nested.doc)
 const r=applySourceBlockTransaction(nested,EditorState.create({doc:nested.doc}).tr.addMark(p,p+1,nested.doc.type.schema.marks.strong!.create()))
 expect(r.ok).toBe(false);expect(nested.source).toContain('[ref]: /url')
})
```

- [ ] **L2.2 完整 paragraph wrapper 替换**

替换原 top-level-only `wrapCaptureRule(md.block.ruler,'paragraph',...)`。top-level 仍验证完整 text trace；nested 仅恢复实际 getLines 输入，不创建连续 nested textspan。实际 LF 必须是该规则 final getLines 的 eMarks 所指向字符，不扫描全文“找末两个空格”。

```ts
wrapCaptureRule(md.block.ruler,'paragraph',(original,state,...args)=>{
 const collector=collectorFor(state)
 if(!collector)return original(state,...args)
 const top=state.level===0&&state.blkIndent===0,level=state.level
 const originalGetLines=state.getLines
 if(typeof originalGetLines!=='function'||!Array.isArray(state.bMarks)||!Array.isArray(state.eMarks))
  throw new UnsupportedSourceCapture()
 const start=state.tokens.length
 let capturedLines:SourceTrace|undefined
 let terminal:{content:string;from:number;to:number}|undefined
 state.getLines=function(begin:number,end:number,indent:number,keepLastLF:boolean){
  const value:string=originalGetLines.call(this,begin,end,indent,keepLastLF)
  const endOfLine=this.eMarks[end-1]
  let slashes=0
  for(let i=value.length-1;i>=0&&value[i]==='\\';i--)slashes++
  const restore=!keepLastLF&&this.src[endOfLine]==='\n'&&(value.endsWith('  ')||slashes%2===1)
  const left=value.length-value.trimStart().length
  if(restore)terminal={content:value.trimStart()+'\n',from:this.bMarks[begin]+left,to:endOfLine+1}
  if(top){
   if(indent!==0)throw new UnsupportedSourceCapture()
   const from=this.bMarks[begin],to=keepLastLF?Math.min(this.src.length,endOfLine+1):endOfLine
   const part=sliceTrace(collector.trace,from,to)
   if(part.text!==value)throw new UnsupportedSourceCapture()
   capturedLines=restore?sliceTrace(collector.trace,terminal!.from,terminal!.to)
    :sliceTrace(part,left,left+value.trim().length)
  }
  return value
 }
 let result
 try{result=original(state,...args)}finally{state.getLines=originalGetLines}
 if(result)for(const token of state.tokens.slice(start)){
  if(token.type!=='inline'||token.level!==level+1)continue
  if(terminal)token.content=terminal.content
  if(top){
   if(!capturedLines||capturedLines.text!==token.content||!Array.isArray(token.children))throw new UnsupportedSourceCapture()
   owners.set(token.children,capturedLines);tokenArrays.set(token,token.children)
  }
 }
 return result
})
```

`terminal.from/to` 是 wrapper 内临时 work 坐标，仅 top=true 时经已验证连续 trace 使用。nested 分支不消费这两个坐标、不导出它们、不把它们命名为 raw，更不声称允许后续结构引擎删除 suffix。正文 sparse capture/newline/escape token wrappers 与 PM hardbreak handler 原样使用。

- [ ] **L2.3 仅 source-root serializer 与明确 EOL 拼接**

在 `markdown.ts` 现有 `serializer` 声明之后创建独立 serializer 实例；不临时改写全局 serializer callback，不调用另一个 parser：

```ts
const terminalStarts=new WeakMap<PmNode,number>()
const sourceRootSerializer=new MarkdownSerializer({
 ...serializer.nodes,
 hardbreak(state,node,parent,index){
  let start=terminalStarts.get(parent)
  if(start===undefined){
   start=parent.childCount
   while(start>0){
    const previous=parent.child(start-1)
    if(previous.type.name!=='hardbreak'||previous.attrs.isInline!==false)break
    start--
   }
   terminalStarts.set(parent,start)
  }
  if(index>=start)state.write('\\\n')
  else serializer.nodes.hardbreak!(state,node,parent,index)
 },
},serializer.marks,({hardBreakNodeName:'hardbreak',strict:false} as any))

/** Internal source-root renderer; default serializeMarkdown stays unchanged. */
export function serializeSourceRootMarkdown(doc:PmNode):string {
 let result=sourceRootSerializer.serialize(doc,({tightLists:true} as any))
 result=relaxEscapes(result,doc)
 return result.replace(/\u200B/g,'')
}
```

该 helper 从 `markdown.ts` export 只供 `source-fidelity.ts` 内部 import；不从 root index 公开。`relaxEscapes` 是既有 helper，且最后完整 source-capture eq 仍决定是否接受，不能因为 legacy relaxEsapes 对 terminal doc 不等就放松 guard。

`source-fidelity.ts` import 由 serializeMarkdown 换成 serializeSourceRootMarkdown。在现有 `rootRenderNode` 后增加：

```ts
function endsInTerminalHardbreak(node:PmNode):boolean {
 if(node.inlineContent){
  const last=node.lastChild
  return last?.type.name==='hardbreak'&&last.attrs.isInline===false
 }
 // Only container endings exercised through actual paragraph block rules.
 if(!['doc','bullet_list','ordered_list','list_item','blockquote'].includes(node.type.name))return false
 const last=node.lastChild;return !!last&&endsInTerminalHardbreak(last)
}
```

以以下完整函数替换 `renderChangedRoot`；现有 rootRenderNode mark重排与 `renderableRoots` 不改，ProtectedSource拒绝在serializer前与外层 edit gate独立保留：

```ts
function renderChangedRoot(base:SourceSession,doc:PmNode,root:SourceRoot):string {
 if(overlapsProtectedSource(base,root.sourceFrom,root.sourceTo)||!renderableRoots.has(root.tokenType))throw new UnsupportedBlockTransaction()
 const nodes:PmNode[]=[]
 for(let i=root.childFrom;i<root.childTo;i++)nodes.push(rootRenderNode(doc.child(i)))
 let generated=serializeSourceRootMarkdown(doc.type.create(doc.attrs,Fragment.fromArray(nodes)))
 const last=nodes[nodes.length-1]!,tail=base.source.slice(root.tailFrom,root.sourceTo)
 if(last.type.name==='table'){
  if(!generated.endsWith('\n')||generated.endsWith('\n\n'))throw new UnsupportedBlockTransaction()
  generated=generated.slice(0,-1)
 }else if(endsInTerminalHardbreak(last)&&/^(?:\r\n|\r|\n)/.test(tail)){
  if(!generated.endsWith('\n'))throw new UnsupportedBlockTransaction()
  // This one generated EOL represents the same final physical content-line
  // terminator already held by the original root tail. Keep original bytes.
  generated=generated.slice(0,-1)
 }
 return generated+tail
}
```

不 trimEnd 原 source、不删任意 trailing blanks；raw tail不存在时保留新 hardbreak所需LF。root最后节点不是已核对的paragraph/list/quote链时不推断其terminal边界，严格全source eq失败时保持具体拒绝。table cell terminal semantics/opaque nested reference relocation不是本任务已支持范围。

在 `source-block-fidelity.spec.ts` 的 `keeps serializer limitations and partial surrogate edits fail closed` 中，把原 `reject(b,transaction(b).insert(2,hardbreak))` 唯一一行改为以下完整正例；该测试其余unclosed fence、rawless empty、surrogate拒绝保持：

```ts
const terminal=accept(b,transaction(b).insert(2,hardbreak))
expect(terminal.session.source).toBe('A\\\n')
```

- [ ] **L2.4 focused 与提交**

执行 `./node_modules/.bin/vitest run src/__tests__/source-terminal-hardbreak.spec.ts src/__tests__/source-layout.spec.ts src/__tests__/source-document-capture.spec.ts src/__tests__/source-block-fidelity.spec.ts`。随后共享门槛。提交 `feat(core): capture terminal hardbreaks for local source rendering`；host installed tests独立提交。记录失败具体输入与reason；不将通过语义probe等同完整Source/undo/desktop体验。

## 两任务共享 installed host 测试代码

新建 host `src/lib/share-merge/source-layout.test.ts`，L1先加入前两个测试，L2加入第三个。均 import 安装 root，不用 sibling src alias：

```ts
import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core'
import {propose} from './proposal'
function open(raw:string){const r=createSourceSession(raw);if(!r.ok)throw new Error(r.reason);return r.session}
it('installed layout keeps root-tail source and rejects edits without natural owner',()=>{
 const raw='- A\n\n\nB',s=open(raw),state=EditorState.create({doc:s.doc})
 expect(s.doc.childCount).toBe(3)
 expect(s.roots.map(r=>[r.childFrom,r.childTo])).toEqual([[0,1],[2,3]])
 expect(s.gaps.flatMap(g=>g.synthetic)).toEqual([])
 expect(s.layout.blankLines.map(u=>u.container.kind)).toEqual(['root-tail','root-tail'])
 const tr=state.tr.addMark(3,4,s.doc.type.schema.marks.strong!.create()),r=applySourceBlockTransaction(s,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(r.session.source).toBe('- **A**\n\n\nB')
 expect(applySourceBlockTransaction(s,state.tr.insertText('X',8)).ok).toBe(false)
})
it('installed exact edit with captured suffix layout remains one sentence hunk',()=>{
 const raw='首段不动。\r\n\r\n目标甲。第二句保持 __原样__。\r\n\r\n',s=open(raw)
 const rawPos=raw.indexOf('甲'),span=s.textSpans.find(x=>x.sourceFrom<=rawPos&&x.sourceTo>rawPos)!
 const p=span.pmFrom+rawPos-span.sourceFrom,tr=EditorState.create({doc:s.doc}).tr.insertText('乙',p,p+1)
 const r=applySourceBlockTransaction(s,tr);expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.mode).toBe('exact-text');expect(Buffer.from(r.session.source)).toEqual(Buffer.from(raw.replace('甲','乙')))
 const proposal=propose({path:'layout.md',base:raw,ours:raw,theirs:r.session.source})
 expect(proposal.theirsEolAligned).toBe(false);expect(proposal.hunks).toHaveLength(1)
 expect(proposal.hunks[0]!.base).toBe('目标甲。');expect(proposal.hunks[0]!.theirs).toBe('目标乙。')
})
it('installed terminal renderer preserves two atoms and unchanged reference suffix bytes',()=>{
 const raw='A\\\n\\\n\n[ref]: /url\n',s=open(raw)
 let count=0;s.doc.descendants(n=>{if(n.type.name==='hardbreak')count++});expect(count).toBe(2)
 const tr=EditorState.create({doc:s.doc}).tr.addMark(1,2,s.doc.type.schema.marks.strong!.create())
 const r=applySourceBlockTransaction(s,tr);expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.session.doc.eq(tr.doc)).toBe(true)
 expect(r.session.source.endsWith('\n\n[ref]: /url\n')).toBe(true)
 expect(r.session.protectedSources).toHaveLength(1)
})
```

## 每任务命令、14语料、产物与 own-workspace 门槛

实施时先创建新 workspace，所有下列命令由现有记录器保存 argv/cwd/stdout/stderr/exit_code；记录器与文件本身位于新 workspace，不写回前一计划目录。下面命令仅是将来步骤，当前未执行：

```sh
mkdir -p /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/browser /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/vite-cache
git -C /Users/bruce/git/moraya-core rev-parse HEAD
git -C /Users/bruce/git/moraya-core status --short
git -C /Users/bruce/git/mdeditor rev-parse HEAD
git -C /Users/bruce/git/mdeditor status --short
```

实施时在新 workspace 创建以下完整 `run.py`；它只记非敏感命令，不读取环境内容或 `.env`。后续命令块由该 recorder执行，不能只保存手写结果：

```python
import argparse, json, pathlib, subprocess, sys, time
parser=argparse.ArgumentParser()
parser.add_argument('label')
parser.add_argument('--cwd',required=True)
parser.add_argument('command',nargs=argparse.REMAINDER)
a=parser.parse_args()
argv=a.command[1:] if a.command[:1]==['--'] else a.command
if not argv: parser.error('command required')
base=pathlib.Path('/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout')
base.mkdir(parents=True,exist_ok=True)
started=time.time()
metadata={'argv':argv,'cwd':a.cwd,'started':started}
(base/(a.label+'.command.json')).write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
with (base/(a.label+'.stdout')).open('wb') as out,(base/(a.label+'.stderr')).open('wb') as err:
 result=subprocess.run(argv,cwd=a.cwd,stdout=out,stderr=err)
metadata.update(ended=time.time(),exit_code=result.returncode)
(base/(a.label+'.command.json')).write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
print(json.dumps({'label':a.label,'exit_code':result.returncode},ensure_ascii=False))
sys.exit(result.returncode)
```

每次工具exec的完整初始返回（含session_id）和所有poll终态另存该label.tool.json；不得覆盖command.json、只保存output或把tool session丢掉。前置阶段失败立即停下依赖后续。

所有代码块中的长heredoc审计完整保存为workspace脚本后用recorder执行；固定文件名：`core-artifacts.sh`（DTS/gzip审计）、`core-stage-dist.sh`（dist stage）、`host-sync.sh`（同步）、`installed-corpus-audit.sh`（两仓/14语料）。脚本内容就是本节对应完整 shell代码块，不添加产品命令。L1执行后保留结果；L2执行相同script以不同label保存新证据，不覆盖L1。短命令的完整recorded调用如下；RED在实现前执行，预期非零同样保存：

```sh
python3 /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/run.py --cwd /Users/bruce/git/moraya-core L1-red -- ./node_modules/.bin/vitest run src/__tests__/source-layout.spec.ts
python3 /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/run.py --cwd /Users/bruce/git/moraya-core L1-green -- ./node_modules/.bin/vitest run src/__tests__/source-layout.spec.ts src/__tests__/source-ownership.spec.ts src/__tests__/source-document-capture.spec.ts src/__tests__/source-block-fidelity.spec.ts
python3 /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/run.py --cwd /Users/bruce/git/moraya-core L2-red -- ./node_modules/.bin/vitest run src/__tests__/source-terminal-hardbreak.spec.ts
python3 /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/run.py --cwd /Users/bruce/git/moraya-core L2-green -- ./node_modules/.bin/vitest run src/__tests__/source-terminal-hardbreak.spec.ts src/__tests__/source-layout.spec.ts src/__tests__/source-document-capture.spec.ts src/__tests__/source-block-fidelity.spec.ts
```

同样规则记录共享 full/typecheck/build/browser与所有审计命令，label使用实际任务名 `L1-` / `L2-` 前缀。stdout/stderr文件不能当执行成功；唯一成功来源为对应command.json的子进程实际退出码与tool.json的工具最终退出码与检查断言。browser脚本内部生成的证据另保留。若任何共享gate失败，当前任务不能提交为已验收。

core每任务focused完成后：

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsup
git diff --check
```

core构建后用完整DTS/gzip审计（在core cwd）：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';import {execFileSync} from 'node:child_process';
const files=fs.readdirSync('dist',{recursive:true}).filter(p=>p.endsWith('.d.ts')).map(p=>'dist/'+p),refs=[];
for(const file of files)for(const m of fs.readFileSync(file,'utf8').matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)){
 const base=path.resolve(path.dirname(file),m[1]);
 const target=[base.replace(/\.js$/,'.d.ts'),base+'.d.ts',path.join(base,'index.d.ts')].find(p=>p.endsWith('.d.ts')&&fs.existsSync(p));
 assert.ok(target,`DTS closure missing ${m[1]} from ${file}`);refs.push({from:file,to:path.relative('.',target)});
}
const tracked=execFileSync('git',['ls-files','-z','dist']).toString().split('\0').filter(Boolean);
const added=files.filter(p=>!tracked.includes(p)),removed=tracked.filter(p=>!fs.existsSync(p));
for(const p of added)assert.ok(refs.some(r=>r.to===p),`unreferenced new declaration ${p}`);
const gzip=gzipSync(fs.readFileSync('dist/index.js')).length;assert.ok(gzip<=81920);
console.log(JSON.stringify({gzip,refs,added,removed},null,2));
JS
```

L1/L2各只运行对应stage行；不吸收前置或并行writer的其他产品内容：

```sh
# L1 core
git add src/source-layout.ts src/markdown.ts src/source-fidelity.ts src/index.ts src/__tests__/source-layout.spec.ts src/__tests__/source-ownership.spec.ts src/__tests__/source-block-fidelity.spec.ts
# L2 core
git add src/markdown.ts src/source-fidelity.ts src/__tests__/source-terminal-hardbreak.spec.ts src/__tests__/source-block-fidelity.spec.ts
```

tracked dist及已证明被引用的新DTS用以下完整脚本stage：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
const tracked=execFileSync('git',['ls-files','-z','dist']).toString().split('\0').filter(Boolean);
const dts=fs.readdirSync('dist',{recursive:true}).filter(p=>p.endsWith('.d.ts')).map(p=>'dist/'+p),referenced=new Set();
for(const f of dts)for(const m of fs.readFileSync(f,'utf8').matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)){
 const base=path.resolve(path.dirname(f),m[1]);
 const target=[base.replace(/\.js$/,'.d.ts'),base+'.d.ts',path.join(base,'index.d.ts')].find(p=>fs.existsSync(p));
 assert.ok(target);referenced.add(path.relative('.',target));
}
for(const file of dts.filter(p=>!tracked.includes(p))){assert.ok(referenced.has(file));execFileSync('git',['add','-f','--',file]);}
const files=execFileSync('git',['diff','--name-only','-z','--','dist']).toString().split('\0').filter(Boolean);
for(const file of files)execFileSync('git',['ls-files','--error-unmatch','--',file]);
if(files.length)execFileSync('git',['add','-u','--',...files]);
JS
git diff --cached --stat
git diff --cached --check
```

每task开始由root记录实际core HEAD到新workspace的core-task-base（Task1为已受理b5602875；Task2为当时Task1已验收HEAD），不根据HEAD^猜基线。core提交之后host同步，禁止用未提交dist做验收；只删除该冻结基线→提交HEAD明确删除的hash声明，不清理未知安装文件：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
const core=fs.realpathSync('../moraya-core');
const baseline=fs.readFileSync('/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/core-task-base','utf8').trim();
assert.match(baseline,/^[a-f0-9]{40}$/);
const src=fs.realpathSync('../moraya-core/dist'),dst=path.join(fs.realpathSync('node_modules/@moraya/core'),'dist');
const deleted=execFileSync('git',['diff','--diff-filter=D','--name-only',baseline,'HEAD','--','dist'],{cwd:core}).toString().split('\n').filter(Boolean);
for(const file of deleted)assert.match(file,/^dist\/[^/]+-[A-Za-z0-9_-]+\.d\.ts$/);
if(fs.realpathSync(dst)!==src){
 for(const file of deleted)fs.rmSync(path.join(dst,file.slice(5)),{force:true});
 fs.cpSync(src,dst,{recursive:true});
}
fs.rmSync('node_modules/.vite/deps',{recursive:true,force:true});console.log(JSON.stringify({src,dst}));
JS
./node_modules/.bin/vitest run src/lib/share-merge/source-layout.test.ts src/lib/share-merge/source-block-fidelity.test.ts src/lib/share-merge/source-fidelity.test.ts src/editor-kit-v2/source-fidelity.test.ts
./node_modules/.bin/vitest run
node scripts/check-share-merge-purity.mjs
./node_modules/.bin/vite build
node scripts/check-editor-kit-build.mjs
env PLAYWRIGHT_MODULE=/Users/bruce/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs \
 SOURCE_FIDELITY_OUTPUT_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/browser \
 SOURCE_FIDELITY_CACHE_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-capture-layout/vite-cache \
 node scripts/check-source-fidelity-browser.mjs
```

Playwright缺失报告具体路径，不安装。以上browser只是现有批准的Kit单块gate，不证明本计划新capture接入主编辑器/Source/nativeundo/协作。host先精确stage测试：`git add src/lib/share-merge/source-layout.test.ts`。没有新增依赖，本计划不预定manifest/lock变化；若安装方式确实要求更新，只能在记录已提交core版本与实际差异之后逐路径stage。运行 `git diff --cached --check`、`git diff --cached --stat` 后独立提交；不碰生产入口。

两仓提交后完整执行 installed/build/committed + 14语料审计（host cwd）；输出JSON由记录器归本新workspace：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';import {gzipSync} from 'node:zlib';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const installed=fs.realpathSync(fileURLToPath(import.meta.resolve('@moraya/core')));
const host=fs.realpathSync('.'),core=fs.realpathSync('../moraya-core');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),sha=p=>hash(fs.readFileSync(p));
const head=repo=>execFileSync('git',['rev-parse','HEAD'],{cwd:repo}).toString().trim();
const coreCommit=head(core),hostCommit=head(host);
const committed=(repo,commit,file)=>execFileSync('git',['show',`${commit}:${file}`],{cwd:repo,maxBuffer:32*1024*1024});
const tracked=execFileSync('git',['ls-files','-z','dist'],{cwd:core}).toString().split('\0').filter(Boolean),hashes={};
for(const file of tracked){
 const expected=hash(committed(core,coreCommit,file));
 assert.equal(sha(path.join(core,file)),expected,`uncommitted build ${file}`);
 assert.equal(sha(path.join(path.dirname(installed),file.slice(5))),expected,`installed mismatch ${file}`);hashes[file]=expected;
}
const declarations=tracked.filter(p=>p.endsWith('.d.ts')),declarationReferences=[];
for(const file of declarations)for(const match of committed(core,coreCommit,file).toString().matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)){
 const target=path.relative(core,path.resolve(core,path.dirname(file),match[1])).replace(/\.js$/,'.d.ts');
 assert.ok(declarations.includes(target),`committed DTS target missing: ${file} -> ${target}`);
 declarationReferences.push({from:file,to:target});
}
const corePackage=JSON.parse(committed(core,coreCommit,'package.json'));
const installedPackage=JSON.parse(fs.readFileSync(path.join(path.dirname(installed),'../package.json')));
assert.deepEqual(installedPackage.exports,corePackage.exports);
assert.equal(sha(installed),sha(path.join(core,'dist/index.js')));
const installedDist=path.dirname(installed),builtDist=path.join(core,'dist');
const installedFiles=fs.readdirSync(installedDist,{recursive:true}).filter(p=>fs.statSync(path.join(installedDist,p)).isFile());
const unexpectedInstalled=installedFiles.filter(p=>!fs.existsSync(path.join(builtDist,p)));
assert.deepEqual(unexpectedInstalled,[],'installed dist contains stale files: report exact paths before removing task-owned obsolete outputs');
const gzip=gzipSync(fs.readFileSync(installed)).length;assert.ok(gzip<=81920);
const coreCorpus='src/__tests__/fixtures/source-fidelity',hostCorpus='src/share-editor/__fixtures__/corpus/source-fidelity';
const manifest=committed(core,coreCommit,coreCorpus+'/manifest.json'),manifestSha256=hash(manifest);
assert.equal(hash(committed(host,hostCommit,hostCorpus+'/manifest.json')),manifestSha256);
assert.equal(sha(path.join(core,coreCorpus,'manifest.json')),manifestSha256);
assert.equal(sha(path.join(host,hostCorpus,'manifest.json')),manifestSha256);
const corpus=JSON.parse(manifest);assert.equal(corpus.length,14);assert.equal(new Set(corpus.map(f=>f.name)).size,14);
const fixtureSha256={};
for(const f of corpus){
 for(const [repo,commit,dir]of [[core,coreCommit,coreCorpus],[host,hostCommit,hostCorpus]]){
  const file=`${dir}/${f.name}.md`,bytes=committed(repo,commit,file);
  assert.equal(hash(bytes),f.sha256);assert.equal(bytes.length,f.bytes);assert.equal(sha(path.join(repo,file)),f.sha256);
 }
 fixtureSha256[f.name]=f.sha256;
}
console.log(JSON.stringify({coreCommit,hostCommit,installed,gzip,hashes,declarationReferences,manifestSha256,fixtureSha256},null,2));
JS
git status --short
git -C ../moraya-core status --short
```

必须另保存focused/full实际计数、typecheck、purity、hostbuild与browser结果；SHA不替代测试、core重开不替代UI切换。产物记录不得填历史旧提交的成功值。

## 仍需继续完成的后续目标

本计划可独立证明有限layout与terminal语义表达，不能标记§12.4/12.9或两端全体验完成。root插删/split/join/list/quote/table结构必须在下一事务计划显式消费body/tail/blank子权限；rawlessbaseline在最后一个非空root删除时的分隔符转换仍由结构component证明；terminalatom raw删除/嵌套重定位尚无授权API。Sourcehistory、Kitidentity/storedmarks、SourceDOM/IME/remote、ownerannotation准入、13类语料三轮UI零diff及统一发版继续按总目标推进。
