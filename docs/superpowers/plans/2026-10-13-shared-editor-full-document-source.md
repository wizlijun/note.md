# 完整文件原文保留与顶层段落来源映射 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让共享 core 保留完整 Markdown 原文字节，在复杂文档中对有真实映射的顶层普通段落执行单步文字替换，并提供保留 BOM 的纯 EOL 投影。

**Architecture:** 原始 `SourceSession.source` 是唯一输出权威；Markdown 的 math、smartquote、EOL、NUL 工作文本变换在发生时留下来源 trace。仅顶层普通段落的真实 text handler 输出得到可编辑映射；其他内容可解析、可保留但不可借本 API 编辑。候选输出由原文局部 splice 形成，严格重解析相等只作拒绝门槛。

**Tech Stack:** TypeScript、现有 markdown-it 14.1.x、prosemirror-markdown 1.13.x、ProseMirror Transaction、Vitest、既有 share-merge propose。不得安装或升级依赖。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.4、I6/I7；批准的共享源码保真前置。本计划接续已独立验收的单段来源映射切片；由 root 自审后按 SDD 连续实施。

## Global Constraints

- 直接在 mdeditor/main 与 moraya-core/main 实施，不创建分支/worktree；只允许一个产品写入者。保留原七个未跟踪项、三份 stash 和 force-pull backup。
- I7：「访客没有触碰的块必须与快照逐字节相同」。不得用 canonical 整篇序列化后过滤格式 diff。
- §12.4 最终要求：「富文本与源码来回切换 3 次」零 diff；一字段落编辑的 `propose(base, base, after)`「恰好产生 1 个 hunk，且只覆盖该句」。本计划仅完成 core 与 merge 输入这一层，文末列出其余必做项目。
- 保留 CRLF、loneCR、混合换行、BOM、末尾换行状态、不可见语法及未编辑原字符；raw/source/PM 位置全部是 UTF-16 offset，字节验收使用 UTF-8 Buffer。
- 旧默认 `parseMarkdown` / `parseMarkdownAsync` / `serializeMarkdown` 的签名和语义不变；不改 schema，不忽略任意 attrs，不增加测试专用生产入口。
- 不接 Kit 多块、不改 CDR、history/mark/Source DOM，不实现引用/列表/表格/代码/frontmatter/数学属性内部编辑。段落内 atom 前后普通文本必须可编辑。
- 本 slice 继续只接受一个 text ReplaceStep；多步事务、mark intent、stored marks、结构编辑仍拒绝。保留既有 semantic-guard 拒绝语法改变的行为，不加入自动 escape serializer。
- 使用已安装直接 CLI：`./node_modules/.bin/vitest`、`tsc`、`tsup`；禁止 pnpm/npx 自动安装。不改 node_modules 源码。
- core `dist/index.js` gzip 必须 `≤ 81920` bytes。core/src 与 tracked dist 同一次 core 提交；mdeditor 同步依赖、测试与文档单独提交。禁止把未提交或错误路径的 dist 当验收产物。
- 三项任务分别独立 RED→GREEN→review；不得把后两项未完成内容混进第一项验收。root 持有自审和正式计划发布职责。

## 文件与范围

| 仓库/文件 | 责任 |
| --- | --- |
| core `src/source-projection.ts` 新 | raw→LF 纯投影及双向边界映射；保留 BOM |
| core `src/source-trace.ts` 新，内部模块 | 仅 parser trace 的 copy/atomic/generated 分段、按已知编辑组合来源；不导出到 root |
| core `src/markdown.ts` 修改 | 原 preprocess 留 trace；按实际顶层 paragraph/getLines/inline owner 捕获；复用实际 PM text handler |
| core `src/source-fidelity.ts` 修改 | 整文档 session 与单顶层段落文字事务；保留失败原子性 |
| core `src/index.ts` 修改 | 导出 Task 1 EOL API；现有 fidelity API 不另起一套 |
| core `src/__tests__/source-projection.spec.ts` 新 | EOL 类型、边界、UTF-16 |
| core `src/__tests__/source-trace.spec.ts` 新 | trace 的源区间、合成字符与组合 |
| core `src/__tests__/source-document-capture.spec.ts` 新 | 真实 parser、多段/atom、preprocess 来源 |
| core `src/__tests__/source-fidelity.spec.ts` 修改 | 已扩能力的旧负例改成新边界，保留原 RED 的意义 |
| core `src/__tests__/source-fidelity-corpus.spec.ts` 新 | 14 文件 raw/一字输出、事务边界 |
| core `src/__tests__/fixtures/source-fidelity/` 新 | 完整固定raw文件与manifest；core fresh clone/独立CI无跨repo前置 |
| mdeditor `src/share-editor/__fixtures__/corpus/source-fidelity/` 新 | 按spec提交同一语料的打包边界镜像；显式同步并逐SHA核对 |
| mdeditor `src/lib/share-merge/source-fidelity.test.ts` 新 | 从安装版 root API 读取 core 输出，调用真实 propose |

不新增 `SourceSession.blocks` 或 table/literal encoding：本 slice 没有生产消费者，也没有证明复杂块归属。未来 Kit 自然块计划必须单独建立 envelope/gap/依赖合同。

## Task 1：共享 EOL 纯投影

**Files:** 新建 core `src/source-projection.ts`、`src/__tests__/source-projection.spec.ts`；修改 `src/index.ts`。

**Interfaces — Produces:**

```ts
export type EolChange = Readonly<{
  sourceFrom: number; sourceTo: number; viewFrom: number; viewTo: number
}>
export type EolProjection = Readonly<{
  text: string; sourceLength: number; changes: readonly EolChange[]
}>
export function projectLineEndings(source: string): EolProjection
export function sourceOffsetAt(p: EolProjection, viewOffset: number): number
export function viewOffsetAt(p: EolProjection, sourceOffset: number, bias: -1 | 1): number
```

**Consumes:** 无 parser/DOM 依赖。Task 2 只在 Markdown 原 normalize 阶段消费；未来 Source textarea 消费同一纯 API，但不消费 Markdown math/smartquote/NUL trace。

- [ ] **1.1 写完整 RED**（下列 import/functions 为最终公开签名）。

```ts
import { expect, it } from 'vitest'
import { projectLineEndings, sourceOffsetAt, viewOffsetAt } from '../source-projection'
it('keeps BOM and UTF16 while projecting only CRLF/loneCR', () => {
  const p = projectLineEndings('\uFEFFA\r\n😀B\rC\n')
  expect(p.text).toBe('\uFEFFA\n😀B\nC\n')
  expect(p.sourceLength).toBe(10)
  expect(p.changes).toEqual([
    {sourceFrom:2,sourceTo:4,viewFrom:2,viewTo:3},
    {sourceFrom:7,sourceTo:8,viewFrom:6,viewTo:7},
  ])
  expect([sourceOffsetAt(p,2),sourceOffsetAt(p,3)]).toEqual([2,4])
  expect([viewOffsetAt(p,3,-1),viewOffsetAt(p,3,1)]).toEqual([2,3])
})
it.each(['', '\uFEFF', '\r\n', '\r\r\n', 'a\rb\nc\r\nd', '😀'.repeat(5000)])(
  'roundtrips every view boundary: %j', source => {
    const p = projectLineEndings(source)
    expect(p.text).toBe(source.replace(/\r\n?/g,'\n'))
    for(let i=0;i<=p.text.length;i++) {
      const raw=sourceOffsetAt(p,i)
      expect(viewOffsetAt(p,raw,-1)).toBe(i)
      expect(viewOffsetAt(p,raw,1)).toBe(i)
    }
    expect(() => sourceOffsetAt(p,-1)).toThrow(RangeError)
    expect(() => viewOffsetAt(p,source.length+1,1)).toThrow(RangeError)
  })
```

- [ ] **1.2 RED 命令**：core 工作目录运行 `./node_modules/.bin/vitest run src/__tests__/source-projection.spec.ts`；预期模块缺失失败，记录原始输出。
- [ ] **1.3 实现纯模块**。以下是可直接使用的最小代码；普通文本保存 slice，不生成每字符对象。

```ts
function check(n: number, max: number) {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new RangeError('offset')
}
export function projectLineEndings(source: string): EolProjection {
  const chunks: string[] = [], changes: EolChange[] = []
  let start=0, view=0
  for(let i=0;i<source.length;i++) {
    if(source.charCodeAt(i)!==13) continue
    chunks.push(source.slice(start,i)); view+=i-start
    const end=i+(source.charCodeAt(i+1)===10?2:1)
    changes.push({sourceFrom:i,sourceTo:end,viewFrom:view,viewTo:view+1})
    chunks.push('\n'); view++; i=end-1; start=end
  }
  chunks.push(source.slice(start))
  return {text:chunks.join(''),sourceLength:source.length,changes}
}
function completed(p: EolProjection, n: number, key: 'viewTo'|'sourceTo') {
  let lo=0,hi=p.changes.length
  while(lo<hi) { const mid=(lo+hi)>>>1
    if(p.changes[mid]![key]<=n) lo=mid+1; else hi=mid
  }
  return lo
}
export function sourceOffsetAt(p: EolProjection,n: number) {
  check(n,p.text.length)
  const k=completed(p,n,'viewTo'), c=p.changes[k-1]
  return n+(c?c.sourceTo-c.viewTo:0)
}
export function viewOffsetAt(p: EolProjection,n: number,bias:-1|1) {
  check(n,p.sourceLength)
  const k=completed(p,n,'sourceTo'), next=p.changes[k], prev=p.changes[k-1]
  if(next && n>next.sourceFrom) return bias<0?next.viewFrom:next.viewTo
  return n-(prev?prev.sourceTo-prev.viewTo:0)
}
```

`src/index.ts` 导出上述三函数及两个类型。BOM 不删除、NUL 不替换、smart quotes 不转换。

- [ ] **1.4 GREEN**：同一 focused 命令；再运行 `./node_modules/.bin/tsc --noEmit`。不在此步运行浏览器或创建 DOM adapter。
- [ ] **1.5 构建及任务提交**：core `./node_modules/.bin/tsup`；`git diff --check`；显式 stage 本任务三个 src 文件和 `git diff --name-only -- dist` 列出的生成文件，core 独立提交。不得以通配 stage 吸收同事产品改动。

## Task 2：工作文本 trace 与完整文件来源捕获

**Files:** core 新增 `source-trace.ts`、两个 Task 2 测试；修改 `markdown.ts`、`source-fidelity.ts`。

**Interfaces — Consumes:** Task 1 `projectLineEndings(source):EolProjection`，在 normalize 时把 `changes` 变为下述已知 edits；不提前统一 raw 换行。

**Interfaces — Produces:**

```ts
// src/source-trace.ts，内部 parser utility；不是新的 root 公共接口。
export type TracePiece = Readonly<{
  from:number; to:number; sourceFrom:number; sourceTo:number
  kind:'copy'|'atomic'|'generated'
}>
export type SourceTrace = Readonly<{text:string; pieces:readonly TracePiece[]}>
export type TraceEdit = Readonly<{from:number;to:number;text:string}>
export function identityTrace(source:string):SourceTrace
export function sliceTrace(t:SourceTrace,from:number,to:number):SourceTrace
export function editTrace(t:SourceTrace,edits:readonly TraceEdit[]):SourceTrace
// markdown.ts，内部 hook；保留 CapturedTextRun 原字段及 kind。
export function parseDocumentWithSourceCapture(source:string,schema?:Schema):
  {ok:true;value:{doc:PmNode;textRuns:CapturedTextRun[]}} |
  {ok:false;reason:'unsupported-source'|'parse-error'}
// source-fidelity.ts root API 签名保持不变，SourceSession 不新增无人消费字段。
export function createSourceSession(source:string,schema?:Schema):FidelityResult
```

`createSourceSession` producer 向 Task 3 提供完整 doc/raw 与可能稀疏的 textSpans。稀疏不等于错误；每一条已声明 span 必须真实可写。parse 异常返回 parse-error，禁止调用 canonical parse 的空 doc fallback。private rule/State shape 改变仍返回 unsupported-source。

- [ ] **2.1 先写 trace 与真实 hook RED**。下列 helper 在本文件内定义，不导出测试专用 API。

```ts
import {expect,it} from 'vitest'
import {identityTrace,sliceTrace,editTrace} from '../source-trace'
it('records only declared changes, including generated math separator',()=>{
 const t=editTrace(identityTrace('甲\n$$\n'),[{from:2,to:2,text:'\n'}])
 expect(t.text).toBe('甲\n\n$$\n')
 expect(sliceTrace(t,3,5).pieces).toEqual([
  {from:0,to:2,sourceFrom:2,sourceTo:4,kind:'copy'},
 ])
 expect(sliceTrace(t,2,3).pieces[0]?.kind).toBe('generated')
 const n=editTrace(identityTrace('A\r\nB\0'),[
  {from:1,to:3,text:'\n'},{from:4,to:5,text:'\uFFFD'},
 ])
 expect(n.text).toBe('A\nB\uFFFD')
 expect(n.pieces.filter(p=>p.kind==='atomic').map(p=>[p.sourceFrom,p.sourceTo]))
  .toEqual([[1,3],[4,5]])
})
```

```ts
import {expect,it} from 'vitest'
import {parseMarkdown,parseDocumentWithSourceCapture} from '../markdown'
function captured(source:string) {
 const r=parseDocumentWithSourceCapture(source)
 if(!r.ok) throw new Error(r.reason)
 expect(r.value.doc.eq(parseMarkdown(source))).toBe(true)
 for(const s of r.value.textRuns) {
  expect(s.pmTo).toBeGreaterThan(s.pmFrom)
  expect(s.sourceFrom).toBeGreaterThanOrEqual(0)
  expect(s.sourceTo).toBeLessThanOrEqual(source.length)
  if(s.kind==='linear') expect(source.slice(s.sourceFrom,s.sourceTo))
   .toBe(r.value.doc.textBetween(s.pmFrom,s.pmTo))
 }
 return r.value
}
it.each([
 '\uFEFF甲。\r\n\r\n乙 &amp; \\* 😀甲。\r末句。',
 '首段。\n$$\nx^2\n$$\n目标甲。',
 '[链接](url “标题”)\n\n目标甲。\0末句。',
 '目标甲。$x$ 后面目标乙。[^n]\n\n[^n]: 原注。',
 '{>>原注<<}目标甲。{==保留==}{>>注释<<}目标乙。',
 '| A | B |\n| --- | --- |\n| x | y |\n\n目标甲。',
])('captures real text around opaque regions: %j',source=>{
 const r=captured(source)
 for(const needle of ['目标甲','目标乙'].filter(x=>source.includes(x))) {
  const raw=source.indexOf(needle)+2
  expect(r.textRuns.some(s=>s.sourceFrom<=raw && s.sourceTo>raw)).toBe(true)
 }
})
it('does not claim container/literal text as editable',()=>{
 for(const source of ['> 甲。','* 甲。','```js\n甲\n```','---\nx: 甲\n---']) {
  expect(captured(source).textRuns).toEqual([])
 }
})
```

- [ ] **2.2 RED 命令**：`./node_modules/.bin/vitest run src/__tests__/source-trace.spec.ts src/__tests__/source-document-capture.spec.ts`；预期缺少新 hook/modules。

- [ ] **2.3 实现分段 trace（不以格式 diff 反推）**。以下完整 helper 定义给出 split/组合规则；输出 segments 不要求每字符一项。`generated` 的 raw 锚点不可用作可写范围。

```ts
export function identityTrace(text:string):SourceTrace {
 return {text,pieces:text.length?[{from:0,to:text.length,sourceFrom:0,sourceTo:text.length,kind:'copy'}]:[]}
}
export function sliceTrace(t:SourceTrace,from:number,to:number):SourceTrace {
 const pieces:TracePiece[]=[]
 for(const p of t.pieces) {
  const a=Math.max(from,p.from), b=Math.min(to,p.to)
  if(a>=b) continue
  const whole=a===p.from && b===p.to
  pieces.push({from:a-from,to:b-from,
   sourceFrom:p.kind==='copy'?p.sourceFrom+a-p.from:p.sourceFrom,
   sourceTo:p.kind==='copy'?p.sourceFrom+b-p.from:p.sourceTo,
   kind:p.kind==='atomic'&&!whole?'generated':p.kind})
 }
 return {text:t.text.slice(from,to),pieces}
}
export function editTrace(t:SourceTrace,edits:readonly TraceEdit[]):SourceTrace {
 let at=0,text=''; const pieces:TracePiece[]=[]
 const append=(part:SourceTrace)=>{
  const shift=text.length; text+=part.text
  pieces.push(...part.pieces.map(p=>({...p,from:p.from+shift,to:p.to+shift})))
 }
 for(const e of edits) {
  if(e.from<at || e.to<e.from || e.to>t.text.length) throw new RangeError('trace edit')
  append(sliceTrace(t,at,e.from))
  if(e.text) {
   const old=sliceTrace(t,e.from,e.to).pieces
   const anchor=t.pieces.find(p=>p.from<=e.from&&p.to>=e.from)
   const raw=anchor?(anchor.kind==='copy'?anchor.sourceFrom+e.from-anchor.from:anchor.sourceFrom):0
   const contiguous=old.length>0 && old.every((p,i)=>p.kind!=='generated' && (!i||old[i-1]!.sourceTo===p.sourceFrom))
   append({text:e.text,pieces:[{from:0,to:e.text.length,
    sourceFrom:contiguous?old[0]!.sourceFrom:raw,
    sourceTo:contiguous?old[old.length-1]!.sourceTo:raw,
    kind:contiguous?'atomic':'generated'}]})
  }
  at=e.to
 }
 append(sliceTrace(t,at,t.text.length))
 return {text,pieces}
}
```

仅完整 atomic span 可映射到原区间；切半的 atomic 不可写。本 slice 对生成/未知输出采用局部 opaque，不让一个不支持的 token 毒化全文件。

- [ ] **2.4 math 的原循环在作出 result.push('') 决策时收集 edits**。给 `normalizeMathBlocks(text, edits?:TraceEdit[])` 增加可选参数，默认调用不产生额外对象；现有判断顺序和结果数组不变。预计算每行原 offset，插入点都是当前输入坐标。

```ts
// 在 const lines = text.split('\n') 后：
const starts:number[]=[]
if(edits) { let offset=0; for(const line of lines) { starts.push(offset); offset+=line.length+1 } }
// 开 $$ 前原有 result.push('') 的同一 if 内追加：
if(edits) edits.push({from:starts[i]!,to:starts[i]!,text:'\n'})
// 关 $$ 后原有 result.push('') 的同一 if 内追加：
if(edits) edits.push({from:starts[i+1]!,to:starts[i+1]!,text:'\n'})
```

原输入按 `\n` split，即 CRLF 的 `\r` 仍留在 line 中；loneCR 不提前分行。连续 edit 同一边界顺序稳定。计算 `editTrace(identityTrace(source),mathEdits)` 后断言 `.text === normalizeMathBlocks` 的真实返回值；不相等抛 UnsupportedSourceCapture。这一断言是 parser 私有契约保护，不是拿最终格式 diff 定位来源。

- [ ] **2.5 smart quotes 与 markdown-it normalize 留 trace**。smartquote 三次原 replace（含重复 double-quote pass）保留原调用顺序；给函数增加可选 observer `(before:string,after:string,edits:TraceEdit[])=>void`。每个 callback 使用 JS replace 的 offset 参数记录两处 delimiter，禁止把整个链接标成 atomic。

```ts
type QuoteTraceObserver=(before:string,after:string,edits:readonly TraceEdit[])=>void
function normalizeSmartQuotes(text:string,observe?:QuoteTraceObserver):string {
 if(!/[“”„‟‘’‚‛]/.test(text))return text
 const passes:[RegExp,string][]=[
  [/(\]\([^\n)]*\s)“([^”\n]*)”(\s*\))/g,'"'],
  [/(\]\([^\n)]*\s)“([^”\n]*)”(\s*\))/g,'"'],
  [/(\]\([^\n)]*\s)‘([^’\n]*)’(\s*\))/g,"'"],
 ]
 for(const [pattern,quote] of passes) {
  const before=text,edits:TraceEdit[]=[]
  text=text.replace(pattern,(_m,pre:string,title:string,post:string,offset:number)=>{
   if(observe) {
    const left=offset+pre.length,right=left+1+title.length
    edits.push({from:left,to:left+1,text:quote},{from:right,to:right+1,text:quote})
   }
   return pre+quote+title+quote+post
  })
  observe?.(before,text,edits)
 }
 return text
}
// parseDocumentWithSourceCapture 内的 observer，trace 为本次 parse 局部变量：
const observe:QuoteTraceObserver=(before,after,edits)=>{
 if(trace.text!==before)throw new UnsupportedSourceCapture()
 trace=editTrace(trace,edits)
 if(trace.text!==after)throw new UnsupportedSourceCapture()
}
```

normalize wrapper 调用原规则前保留 `before=state.src`；`projectLineEndings(before)` 给出已知 EOL edits，先 `trace=editTrace(trace, p.changes.map(c=>({from:c.sourceFrom,to:c.sourceTo,text:'\n'})))`。再扫描 `trace.text` 的 NUL 索引形成 `\uFFFD` edits，组合一次。最后调用原 normalize 并断言 `state.src===trace.text`。不替换原 normalize 语义；BOM 仍保留，稍后的 paragraph.trim 可以把它排除于 text mapping，raw 永不丢。

新增定向 RED 输入包括 `首段\r$$\rx\r$$\r目标甲`、`首段\r\n$$\r\nx\r\n$$\r\n目标甲` 与混合 quotes+NUL，逐个要求 capture doc.eq canonical parse，精确匹配目标原 offset。不存在「先统一 EOL 再做 math」的等价假设。

- [ ] **2.6 用原 paragraph rule 调用捕获 owner，局部投影只支持顶层**。`wrapCaptureRule(md.block.ruler,'paragraph',...)` 在委托前判断 `state.level===0 && state.blkIndent===0`；没有通过则直接原调用。保存/临时包裹该 state 的 getLines，finally 恢复。只记录本次 `indent===0` 调用，按实际 bMarks/eMarks 拼出 slice；nested list/quote 不经过此分支。

```ts
// markdown.ts 内：
const owners=new WeakMap<object,SourceTrace>() // key=实际 inline token.children 数组
const tokenArrays=new WeakMap<object,object>() // private API身份契约检查
// paragraph wrapper 内执行原 rule 时临时使用：
state.getLines=function(begin:number,end:number,indent:number,keepLastLF:boolean) {
 const value=originalGetLines.call(this,begin,end,indent,keepLastLF)
 if(indent!==0) return value
 const from=this.bMarks[begin]
 const to=keepLastLF?Math.min(this.src.length,this.eMarks[end-1]+1):this.eMarks[end-1]
 const part=sliceTrace(collector.trace,from,to)
 if(part.text!==value) throw new UnsupportedSourceCapture()
 const left=value.length-value.trimStart().length
 capturedLines=sliceTrace(part,left,left+value.trim().length)
 return value
}
```

paragraph 原规则成功后仅取本次新 tokens 中 `type==='inline'` 且 `token.level===1` 的 token；要求 `capturedLines.text===token.content`，再执行下面的身份绑定。当前安装版paragraph会分配children数组，原core inline直接复用；本slice只支持这一已实测私有合同。

```ts
if(!Array.isArray(token.children))throw new UnsupportedSourceCapture()
owners.set(token.children,capturedLines)
tokenArrays.set(token,token.children)
```

core inline委托前后各作一次整批身份检查，不引入全局frames/activecollector、不逐段扫描整份tokens：

```ts
wrapCaptureRule(md.core.ruler,'inline',(original,state)=>{
 if(!collectorFor(state))return original(state)
 const mapped=state.tokens.filter((token:object)=>tokenArrays.has(token))
 const check=()=>{
  for(const token of mapped) {
   if(!Array.isArray(token.children)||token.children!==tokenArrays.get(token))
    throw new UnsupportedSourceCapture()
  }
 }
 check()
 const result=original(state)
 check()
 return result
})
// 现有 InlineState constructor wrapper 中；state 是实际 new OriginalInlineState(...args)：
const owner=owners.get(args[3] as object)
if(owner) {
 inlineStateOwners.set(state,owner) // 新增 WeakMap<object,SourceTrace>()
 // 安装现有 pushPending/text/escape/entity provenance；没有 owner 则不安装。
}
```

所有inline rule wrappers仅凭 `inlineStateOwners.has(state)` 进入capture，core normalize/text_join仍凭env collector。所有WeakMap由实际对象身份索引、无当前文档全局可变指针；原同文段落具有不同数组，嵌套parse具有自己的数组。无capture普通parse直接委托原函数。private shape或数组身份变化返回unsupported-source，不为未来未发生的late-allocation实现兼容框架。

历史已运行的最小实测（脚本 `full-document-inline-array-probe.mjs` 已归档于前一切片验证记录，不是本计划执行命令）：结果 `full-document-inline-array-results.json` 证明安装版ESM markdown-it14.1.1：block完成时已分配数组，core inline前后与InlineState收到的是同一个数组；重复“甲 _甲_。”两段分别定位line0/line2；第一次InlineState中调用嵌套真实md.parse后outer owner保持不变。入口及规则源码SHA已记录。先前 `full-document-inline-owner-probe.mjs` 中晚分配形状模拟仍保留为研究记录，但最终方案不采用其frames/wrapper兼容机制。

生产RED额外要求 `甲 _甲_。\n\n甲 _甲_。` 中第二个甲的raw范围与PM位置属于第二段，及一次capture后紧接不同文本capture没有上次owner。重入脚本是私有API门槛，不将测试钩子加进生产公共接口。

- [ ] **2.7 source runs 改成 owner-local provenance，PM text cursor 仍是实际 handler cursor**。现有 SourceRun 增加 `trace?:SourceTrace`；真实 text/entity/escape/emphasis rule 成功时通过 `sliceTrace(owner,from,to)` 附来源。未被捕获但确实输出文字的 token 用 `{text:token.content}` opaque chunk，避免 join 后把后面的文字左移。`captureJoin` 对每个 text/text_special token 都保留实际 chunk 文本序列；两个既有 join wrapper 继续委托原规则。

```ts
// join 时当前 token 无 provenance 不得当成空串：
const own=tokenSources.get(token)?.runs ?? [{text:token.content}]
runs=runs.concat(own)
// captureText 中，在真实 text delegate 前取得 cursor，按 chunk.text.length 前进。
for(const run of runs) {
 const a=pos; pos+=run.text.length
 if(!run.trace) continue // opaque chunk 仍占 PM 长度
 const ps=run.trace.pieces
 if(run.kind==='linear' && run.trace.text===run.text) {
  // 必须按 trace piece 分开；否则一个 NUL/CRLF 会把整段误判为一个原子。
  for(const p of ps) if(p.kind!=='generated') collector.runs.push({
   sourceFrom:p.sourceFrom,sourceTo:p.sourceTo,
   pmFrom:a+p.from,pmTo:a+p.to,kind:p.kind==='copy'?'linear':'atomic',
  })
  continue
 }
 const contiguous=ps.length>0 && ps.every((p,i)=>p.kind!=='generated' && (!i||ps[i-1]!.sourceTo===p.sourceFrom))
 if(!contiguous) continue
 collector.runs.push({sourceFrom:ps[0]!.sourceFrom,sourceTo:ps[ps.length-1]!.sourceTo,
  pmFrom:a,pmTo:pos,kind:'atomic'})
}
delegate()
if(cursor()!==pos) throw new UnsupportedSourceCapture()
```

实际 TS 类型固定为：

```ts
type SourceRun = {text:string;kind?:undefined;trace?:undefined}
 | {text:string;kind:'linear'|'atomic';trace:SourceTrace}
```

上面循环按 `trace` existence narrowing。不支持的 marks（annotation/code/HTML mark 等）的 text 不发可写 span；仍前进 cursor，`em/strong/link` 沿用既有支持。math/footnote_ref/note_anchor/html_inline 的独立 handler 自行产生 PM 节点；下一 text handler 重新读取实际 stack cursor，自然计入 nodeSize，不能用 textContent 字符数代替。mediaSkip 不调用 text handler，故不生成 span。

移除全局 Critic 字符串拒绝；不用实现其内部改写。移除 link wrapper 对 reference-style link 的全文件 invalid：reference label 若 owner/run 精确则可映射，目的地址与 definition opaque；如该 rule 的输出无法关联，只有该 token 文字 opaque。最终 candidate parse guard 会保留引用依赖语义，raw definition 永不 serialize。

- [ ] **2.8 hook 收束与失败边界**。删除 md.parse 尾部单段 whitelist/全局 offset 赋值；原 tagPairedHtmlInline/fixFootnoteDefMaps/preserveBlankLines 顺序不变。新增 parseDocument hook：按实际 math→quotes→normalize 组合 trace，使用 `getParserFor(schema).parse(work,{[captureKey]:collector})`。验证每条 span 的边界、PM 对应文字、排序不重叠与所在 `$from.depth===1` 的 paragraph；不要求所有 PM text 都有映射。`createSourceSession` 改用新 hook，仍返回 `{revision:0,source,doc,textSpans}`。

保留导出的旧内部 `parseParagraphWithSourceCapture` 作为兼容 wrapper：调用新 hook，若 doc 非单段或存在无映射文字/不支持 mark/node 则 unsupported-source；原 canonical API 完全不动。新消费者只使用新 hook，不能重复维护两套 parser。

- [ ] **2.9 本任务直接更新旧 createSession 负例**，替换 `source-fidelity.spec.ts` 中原「does not pretend unsupported source has writable exact mapping」测试；其余事务负例原样保留。这里不依赖 Task 3 的说明：

```ts
it('opens opaque source without claiming writable literal/container text',()=>{
 for(const source of ['* item\n* item2','```js\n甲\n```','$x$','{>>note<<}']) {
  const opened=createSourceSession(source)
  expect(opened.ok).toBe(true)
  if(!opened.ok)throw new Error(opened.reason)
  expect(opened.session.source).toBe(source)
  expect(opened.session.doc.eq(parseMarkdown(source))).toBe(true)
  expect(opened.session.textSpans).toEqual([])
 }
})
it('captures text after CRLF without normalizing raw source',()=>{
 const source='甲\r\n乙',opened=createSourceSession(source)
 expect(opened.ok).toBe(true)
 if(!opened.ok)throw new Error(opened.reason)
 expect(opened.session.source).toBe(source)
 expect(opened.session.textSpans.some(s=>s.sourceFrom<=3&&s.sourceTo>3)).toBe(true)
})
```

- [ ] **2.10 GREEN 与任务提交**：先 focused Task 2 测试，再 `./node_modules/.bin/tsc --noEmit`、core 全测试 `./node_modules/.bin/vitest run`。此checkpoint包括上面旧测试边界更新，不能留预期失败。运行 `./node_modules/.bin/tsup`；仅 stage 本任务 src/tests 与 tracked dist，同一次 core commit。

## Task 3：单步局部事务、14 fixture、propose 与实际产物门禁

**Files:** core `source-fidelity.ts`、两个 fidelity 测试、固定 corpus；mdeditor 同字节 corpus 镜像 与 `src/lib/share-merge/source-fidelity.test.ts`。不修改 Kit/main/controller。

**Interfaces — Consumes:** Task 2 `createSourceSession(source,schema?)` 和现有 `SourceSession{revision,source,doc,textSpans}`；真实 `Transaction.before/doc/steps`；host `propose({path,base,ours,theirs})`。

**Produces:** 原 `applySourceTextTransaction(base:SourceSession,tr:Transaction):FidelityResult` 支持完整 doc 内、单个顶层普通 paragraph 的 text ReplaceStep；失败不返回 session，成功 revision+1。不增加编码类型、mode flag 或历史事件接口。

- [ ] **3.1 固定 fixtures 为真实字节文件**。下面脚本在 core 根运行一次，生成14个 raw文件及 manifest，提交生成文件。不得在测试每次运行时生成输入；测试只读文件。原已有 corpus 不覆盖，新增子目录。

```sh
node --input-type=module <<'JS'
import fs from 'node:fs'; import crypto from 'node:crypto';
const dir='src/__tests__/fixtures/source-fidelity'; fs.mkdirSync(dir,{recursive:true});
const cases=[
 ['table','| A | B |\n| :--- | ---: |\n| x | y |\n\n目标甲。'],
 ['footnote','目标甲[^n]。保留 _斜体_。\n\n[^n]: 原注。\n'],
 ['frontmatter','---\ntitle: "原样"\n---\n\n目标甲。\n'],
 ['html','<div class="note">\n  保留 HTML。\n</div>\n\n目标甲。'],
 ['critic-range','目标甲。{==保留 _强调_==}{>>原注<<}'],
 ['critic-point','{>>点批注<<}目标甲。末句保留。'],
 ['math','首句目标甲，公式 $x + y$。\n$$\nx^2\n$$\n末句保持。'],
 ['mermaid','```mermaid\ngraph TD; A-->B\n```\n\n目标甲。'],
 ['mixed-list','* 第一项\n  + 子项\n    - 孙项\n+ 第二项\n\n目标甲。'],
 ['quote','>  原始引用。\n>\n> 第二句。\n\n目标甲。'],
 ['long-chinese','保留的长中文。'.repeat(200)+'\n\n目标甲。'],
 ['crlf','首段保持。\r\n\r\n目标甲。\r\n末句 _保留_。\r\n'],
 ['bom','\uFEFF目标甲。\n\n保留末段。\n'],
 ['no-final-newline','保留首段。\n\n目标甲。'],
];
const manifest=cases.map(([name,text])=>{
 const b=Buffer.from(text); fs.writeFileSync(`${dir}/${name}.md`,b);
 const target=text.indexOf('目标甲')+2;
 return {name,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),target};
});
fs.writeFileSync(`${dir}/manifest.json`,JSON.stringify(manifest,null,2)+'\n');
JS
```

core测试直接读取 `new URL('./fixtures/source-fidelity/',import.meta.url)`；独立clone与CI只需core仓库本身。禁止缺fixture时skip，也不依赖环境变量提供另一个仓库。host按spec另提交原字节镜像；这是仓库打包边界的数据镜像，不另维护生成规则或expected。生成后在host根执行一次：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
fs.cpSync('../moraya-core/src/__tests__/fixtures/source-fidelity',
 'src/share-editor/__fixtures__/corpus/source-fidelity',{recursive:true});
JS
```

两个仓库各自只读自己已提交fixture运行测试；跨repo SHA对照是本次集成交付门禁，不是core测试运行前置。

- [ ] **3.2 写 core corpus RED**。真实 raw hash、连续3次 core会话、单字精确输出三个独立断言；3次不是 UI 切换。

```ts
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import type {Node as PmNode} from 'prosemirror-model'
import {createSourceSession,applySourceTextTransaction} from '../source-fidelity'
const dir=fileURLToPath(new URL('./fixtures/source-fidelity/',import.meta.url))
const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8')) as {name:string;sha256:string;bytes:number;target:number}[]
function open(source:string) { const r=createSourceSession(source); if(!r.ok)throw new Error(r.reason);return r.session }
function target(doc:PmNode) {
 const found:number[]=[]
 doc.descendants((n,p)=>{if(n.isText){const at=n.text!.indexOf('目标甲');if(at>=0)found.push(p+at+2)}})
 expect(found).toHaveLength(1);return found[0]!
}
for(const f of manifest) it(`${f.name}: core reopen bytes and exact one-char splice`,()=>{
 const raw=readFileSync(join(dir,f.name+'.md')), source=raw.toString('utf8')
 expect(raw.length).toBe(f.bytes)
 expect(createHash('sha256').update(raw).digest('hex')).toBe(f.sha256)
 let current=source
 for(let n=0;n<3;n++){current=open(current).source;expect(Buffer.from(current)).toEqual(raw)}
 const base=open(source),p=target(base.doc)
 const tr=EditorState.create({doc:base.doc}).tr.insertText('乙',p,p+1)
 const next=applySourceTextTransaction(base,tr)
 expect(next.ok).toBe(true);if(!next.ok)throw new Error(next.reason)
 const expected=source.slice(0,f.target)+'乙'+source.slice(f.target+1)
 expect(Buffer.from(next.session.source)).toEqual(Buffer.from(expected))
 expect(next.session.doc.eq(tr.doc)).toBe(true)
 expect(next.session.revision).toBe(1)
 expect(base.source).toBe(source)
})
```

- [ ] **3.3 RED 命令**：core `./node_modules/.bin/vitest run src/__tests__/source-fidelity-corpus.spec.ts`；预期 Task 2 已能 open，但事务仍受 firstChild/single-doc 旧限制而失败。若打开仍失败，退回 Task 2，不能 skip fixture。

- [ ] **3.4 最小事务实现**。保留 source-fidelity.ts `boundary`、`splitsSurrogate`、source 区间连续检查、candidate splice 和严格 reparse；只替换「firstChild 单段」前置约束与 surrogate 检测。首先在读取步骤之前拒绝 `tr.storedMarksSet`，然后将下列段落边界代码放在读取 from/to 后。

```ts
if(tr.storedMarksSet)return {ok:false,reason:'unsupported-step'}
const $from=base.doc.resolve(from), $to=base.doc.resolve(to)
if($from.depth!==1 || !$from.sameParent($to) || $from.parent.type.name!=='paragraph'
 || to<from || step.slice?.openStart || step.slice?.openEnd
 || step.slice?.content?.some((n:{type:string})=>n.type!=='text')) {
 return {ok:false,reason:'unsupported-step'}
}
// textContent 不能计入 atom 的 nodeSize；用真实 text child 的 PM offset 验证。
function splitsTextAt(doc:PmNode,pos:number):boolean {
 const r=doc.resolve(pos);let split=false
 r.parent.forEach((node,offset)=>{
  if(node.isText && r.parentOffset>offset && r.parentOffset<offset+node.nodeSize)
   split=split||splitsSurrogate(node.text!,r.parentOffset-offset)
 })
 return split
}
if(splitsTextAt(base.doc,from)||splitsTextAt(base.doc,to))return {ok:false,reason:'unmapped-range'}
```

增加 spans **PM 连续性**，不能只检查 raw连续：对于 `from<to`，首 span 必须覆盖from、末span覆盖to，相邻 `prev.pmTo===next.pmFrom` 且 `prev.sourceTo===next.sourceFrom`。插入点有多个候选 raw offset 继续拒绝。opaque atom 上/跨atom的替换不能借首尾文字 span 漏过。不对未映射位置猜插入锚点。

```ts
if(from<to && (spans[0]!.pmFrom>from || spans[spans.length-1]!.pmTo<to
 || spans.some((s,i)=>i>0&&spans[i-1]!.pmTo!==s.pmFrom)))
 return {ok:false,reason:'unmapped-range'}
```

候选新源码使用现有原样插入规则；如果 `*乙*` 会变成em，仍 semantic-mismatch，不补 canonical fallback。成功后重新建立全文件映射，revision只增加1。`tr.before` 必须 `.eq(base.doc)`；一切 marks/attrs 都参与 eq（core不会忽略cdrBlockId；host已有 adapter单独处理）。

- [ ] **3.5 检查原 Task1 边界并补新事务回归**。createSession 的负例替换已由 Task2完成，本任务只增加实际事务验收，不重复移动测试。

| 原测试 | 新断言 |
| --- | --- |
| createSession 拒绝 list/fence/math/note | 改为 create 成功且 source 相等；list/fence 内文本替换仍 unsupported-step 或 unmapped-range，无 session 输出 |
| createSession 拒绝 `甲\r\n乙` | 改为成功，替换 `乙`→`丙` 后仍 `甲\r\n丙` |
| mark/multi-step/stale/partial entity/surrogate/delimiter crossing | 原断言不改 |
| semanticguard `*乙*` | 原 semantic-mismatch 不改 |
| BOM/three-sentence/nested emphasis/link | 原字节期望不改 |

新增可直接落码的定向事务测试；helper `open` 同上，`replaceAt` 如下：

```ts
it('rejects stored-mark intent even with an otherwise mapped text step',()=>{
 const base=open('甲乙'),tr=EditorState.create({doc:base.doc}).tr.insertText('丙',1,2)
 tr.setStoredMarks([base.doc.type.schema.marks.strong!.create()])
 const r=applySourceTextTransaction(base,tr)
 expect(r).toEqual({ok:false,reason:'unsupported-step'})
 expect(base.source).toBe('甲乙')
})
function replaceAt(source:string,needle:string,text:string,occurrence=0) {
 const base=open(source);const positions:number[]=[]
 base.doc.descendants((n,p)=>{if(n.isText){let at=-1;while((at=n.text!.indexOf(needle,at+1))>=0)positions.push(p+at)}})
 const from=positions[occurrence]!;expect(from).toBeDefined()
 const tr=EditorState.create({doc:base.doc}).tr.insertText(text,from,from+needle.length)
 return {base,result:applySourceTextTransaction(base,tr)}
}
it('second repeated paragraph maps by PM provenance',()=>{
 const s='甲 &amp; \\* 😀。\r\n\r\n甲 &amp; \\* 😀。'
 const {result}=replaceAt(s,'甲','乙',1)
 expect(result.ok).toBe(true);if(result.ok)expect(result.session.source)
  .toBe('甲 &amp; \\* 😀。\r\n\r\n乙 &amp; \\* 😀。')
})
it.each(['首甲。$x$ 后乙。','首甲。[^n]后乙。\n\n[^n]: 注。',
 '首甲。{>>注<<}后乙。','首甲。<img src="x">后乙。'])('edits before/after inline atom: %s',s=>{
 for(const [needle,text] of [['甲','丙'],['乙','丁']]) {
  const {result}=replaceAt(s,needle!,text!);expect(result.ok).toBe(true)
  if(result.ok)expect(result.session.source).toBe(s.replace(needle!,text!))
 }
})
it('keeps unknown and zero-width bytes around mapped text',()=>{
 const s='保留\u200B。\n\n目标甲。\n\n[ref]: <https://example.com> "原题"\n'
 const {result}=replaceAt(s,'甲','乙');expect(result.ok).toBe(true)
 if(result.ok)expect(result.session.source).toBe(s.replace('甲','乙'))
})
it('opaque literal edit fails without a writable result',()=>{
 const {base,result}=replaceAt('```mermaid\n甲\n```\n\n保持。','甲','乙')
 expect(result.ok).toBe(false);expect('session' in result).toBe(false)
 expect(base.source).toBe('```mermaid\n甲\n```\n\n保持。')
})
```

另以实际 PM `tr.replaceWith` 覆盖包含 atom 的范围，要求失败；先选择 `node.isAtom&&node.isInline` 得真实 atom位置，范围向两侧各扩一个 PM位置，不使用 textContent。原来三句 fixture 的甲→乙仍必须通过真实 Kit 单块 browser gate。

- [ ] **3.6 core GREEN**：`./node_modules/.bin/vitest run src/__tests__/source-fidelity.spec.ts src/__tests__/source-fidelity-corpus.spec.ts src/__tests__/source-document-capture.spec.ts src/__tests__/source-trace.spec.ts src/__tests__/source-projection.spec.ts`；再 `./node_modules/.bin/tsc --noEmit` 与 `./node_modules/.bin/vitest run`。记录实际数量，不复述旧275作新结果。

- [ ] **3.7 build/sync 后 host RED→GREEN：必须 import installed root API**。

core：`./node_modules/.bin/tsup`。host运行已有 sync:core 的相同 Node 代码（无需 pnpm）：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';
const dst=path.join(fs.realpathSync('node_modules/@moraya/core'),'dist');
fs.cpSync('../moraya-core/dist',dst,{recursive:true});
fs.rmSync('node_modules/.vite/deps',{recursive:true,force:true});
console.log(dst);
JS
```

host 测试的 producer import 必须是安装版 root API，不能 import sibling src、mock serializer、别名重定向源码。完整测试文件内容如下：

```ts
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import {createSourceSession,applySourceTextTransaction} from '@moraya/core'
import {propose} from './proposal'
const dir=fileURLToPath(new URL('../../share-editor/__fixtures__/corpus/source-fidelity/',import.meta.url))
const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8')) as {name:string;sha256:string;target:number}[]
for(const f of manifest) it(`installed core -> propose: ${f.name}`,()=>{
 const raw=readFileSync(join(dir,f.name+'.md')),source=raw.toString('utf8')
 expect(createHash('sha256').update(raw).digest('hex')).toBe(f.sha256)
 const opened=createSourceSession(source)
 expect(opened.ok).toBe(true);if(!opened.ok)throw new Error(opened.reason)
 const base=opened.session,positions:number[]=[]
 base.doc.descendants((n,p)=>{if(n.isText){const at=n.text!.indexOf('目标甲');if(at>=0)positions.push(p+at+2)}})
 expect(positions).toHaveLength(1)
 const from=positions[0]!
 const tr=EditorState.create({doc:base.doc}).tr.insertText('乙',from,from+1)
 const next=applySourceTextTransaction(base,tr)
 expect(next.ok).toBe(true);if(!next.ok)throw new Error(next.reason)
 const after=next.session.source
 // 原始 core 输出必须先精确相等，不能依赖 alignEol 补救。
 expect(Buffer.from(after)).toEqual(Buffer.from(source.slice(0,f.target)+'乙'+source.slice(f.target+1)))
 const p=propose({path:f.name+'.md',base:source,ours:source,theirs:after})
 expect(p.hunks).toHaveLength(1)
 expect(p.theirsEolAligned).toBe(false)
 const h=p.hunks[0]!
 expect(h.kind).toBe('theirs-only')
 expect(h.base).toContain('目标甲')
 expect(h.theirs).toBe(h.base.replace('目标甲','目标乙'))
 expect(source.slice(h.oursStart,h.oursEnd)).toBe(h.base)
 // 独立句边界：只允许目标所在句和紧随的原始 EOL，不能包含下一句。
 let start=f.target,end=f.target+1
 while(start>0&&!/[。！？\r\n]/.test(source[start-1]!))start--
 while(end<source.length&&!/[。！？\r\n]/.test(source[end]!))end++
 if(/[。！？]/.test(source[end]??''))end++
 if(source[end]==='\r'&&source[end+1]==='\n')end+=2
 else if(source[end]==='\r'||source[end]==='\n')end++
 expect(h.oursStart).toBeGreaterThanOrEqual(start)
 expect(h.oursEnd).toBeLessThanOrEqual(end)
})
```

此 scope 检查可能发现 kernel 当前把批注/脚注或连续行合为大单位；这是真实门槛失败，报告具体fixture/hunk边界，不扩大expected吞掉邻句、不修改 merge 内核逃过审查。若句末CRLF被token归属包含，expected句界须明确包含该完整EOL而不是把CRLF切开；仅边界归属修正，不允许包含下一句。

运行：host `./node_modules/.bin/vitest run src/lib/share-merge/source-fidelity.test.ts src/editor-kit-v2/source-fidelity.test.ts`。首次写测试后、执行本节 build/sync 前针对旧安装 dist应RED；sync后GREEN。若本地安装路径与core dist共享真实路径，先在产品实现前留存这一RED；不得为制造RED改坏当前产物。再运行host全量 `./node_modules/.bin/vitest run` 和既有 build/purity/Kit产物检查，直接CLI命令：

```sh
node scripts/check-share-merge-purity.mjs
./node_modules/.bin/vite build
node scripts/check-editor-kit-build.mjs
```

不扩大真实 browser gate：复跑已批准 Task1 单块甲→乙的现有 harness，记录浏览器版本、installed root SHA；不把 core多段单元测试报告成Kit多块成功。使用已有安装路径，若不存在即报告环境缺项，禁止触发安装：

```sh
env PLAYWRIGHT_MODULE=/Users/bruce/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs node scripts/check-source-fidelity-browser.mjs
```

- [ ] **3.8 actual dependency 与 gzip 门禁（host根执行）**。下面脚本输出可存档JSON，不读取秘密配置。

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';import {gzipSync} from 'node:zlib';import assert from 'node:assert/strict';
const root=fileURLToPath(import.meta.resolve('@moraya/core'));
const installed=fs.realpathSync(root),built=fs.realpathSync('../moraya-core/dist/index.js');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(sha(installed),sha(built));const bytes=gzipSync(fs.readFileSync(built)).length;
assert.ok(bytes<=81920,`core gzip ${bytes} > 81920`);
const entries=fs.readdirSync('../moraya-core/dist',{recursive:true}).filter(x=>fs.statSync(path.join('../moraya-core/dist',x)).isFile());
const installedDist=path.dirname(installed);
const corpusA='../moraya-core/src/__tests__/fixtures/source-fidelity',corpusB='src/share-editor/__fixtures__/corpus/source-fidelity';
assert.equal(sha(path.join(corpusA,'manifest.json')),sha(path.join(corpusB,'manifest.json')));
const corpus=JSON.parse(fs.readFileSync(path.join(corpusA,'manifest.json'),'utf8'));
assert.equal(corpus.length,14);
for(const f of corpus){assert.equal(sha(path.join(corpusA,f.name+'.md')),f.sha256);assert.equal(sha(path.join(corpusB,f.name+'.md')),f.sha256);}
const hashes=Object.fromEntries(entries.map(x=>{const a=path.join('../moraya-core/dist',x),b=path.join(installedDist,x);assert.equal(sha(a),sha(b),x);return [x,sha(a)]}));
console.log(JSON.stringify({installed,built,gzip:bytes,rootSha256:sha(built),corpusSha256:Object.fromEntries(corpus.map(f=>[f.name,f.sha256])),hashes},null,2));
JS
```

记录两repo `git rev-parse HEAD`、`git status --short`、core提交内`git show <hash>:dist/index.js`的SHA与构建/安装SHA完全一致。精确 stage：core本任务src/tests及本次生成 tracked dist；host仅新增14文件、manifest、merge测试及当前依赖方式确实发生的lock/manifest变化（没有变化不制造版本号变动）。分别提交，禁止`git add .`。最终确认安装目录只是build同步产物，所有实现可由两个提交重新构建得到。

## 未完成的 §12.4 / I7 必做范围（不能归档为整体完成）

- Kit自然块身份、全文件envelope/gap、reference/footnote依赖、remote/CDR再基线及所有 draft出口统一使用source；本slice不接Kit多块。
- heading/title、引用/嵌套列表/脚注定义/表格cell/frontmatter/fence内部映射与结构/属性编辑；本slice only opaque preservation，不能最终只支持paragraph。
- 行内mark/annotation真实格式意图、Source-only语义相等修订、native Rich undo/redo与BlockEditStep来源payload；沿用已交付history15case研究，不新造Rich undo栈。
- Source raw buffer/DOM selection、IME/paste/drop/native undo，Source→Rich只更新实际变化块；本slice完整重解析只是局部输出的语义guard。
- 真实网页及桌面所有13类语料Rich↔Source三轮零diff；真实Kit一字结果1hunk且只覆盖目标句；合作者实际生产出口验证。
- 最终CSP/SRI/体积/平台发布门槛与E1/E4产品验收。

## 执行前 root 自审记录

已自审三项任务边界、fixture路径、private API保护、旧负例更新归属及依赖产物命令。补齐Task3的storedMarksSet最终能力拒绝和回归；任务对照表记入本计划独立ledger。历史研究证据 `next-source-projection-probe.mjs` / `next-source-projection-results.json` 已归档于前一切片验证记录（4个paragraph/container输入与escaped-pipe表格）；它证明规则局部捕获策略，绝不替代本计划的真实core测试。仅有当前计划三项全部GREEN也不能标记完整§12.4完成。

历史草稿纯代码校验：已归档的 `full-document-plan-code-check.mjs` 从研究草稿代码块抽取 EOL、trace、quote 函数，经已安装TypeScript转译运行，13项检查通过；输出 `full-document-plan-code-check.json` 固定草稿SHA。此证据只覆盖给出的纯算法代码，不能替代Task2的真实Moraya捕获或Task3产品事务验收。最终array identity/重复段落/实际重入证据见 `full-document-inline-array-results.json`，含实际ESM入口及规则源码SHA。

## 基线与研究证据

宿主产品基线 `ace4ddf238ebc42207174ad8a41b94ea50fa5007`，core基线 `cafc03894cbc68294a01fafda118d59c61265eda`；实施前重新记录实际HEAD（可能包含文档收口提交）。前一切片验证记录：[来源映射切片](../reports/2026-10-13-shared-editor-source-mapping-gate-verification.md)。本计划的所有算法、接口与测试已写在正文；历史scratch只作实证参考，执行者不读取其他计划workspace。当前完整I7、两端协作及统一发版未完成。
