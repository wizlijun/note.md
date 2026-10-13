# Nested source producers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目仅一个产品 writer；当前 root 已指定自己自审计划，不再派 plan reviewer。

**Goal:** 真实 quote/list/footnote/table/heading 及已有可编辑 literal 正文单字修改只改对应 raw 字符，必要同容器 mark 不重渲染自然根，为 file bindings/history/UI 提供实际满足 I7 的 producer。

**Architecture:** 将真实规则已经消费的正文投影为现有 `TextSourceSpan`，让真实 PM emission 与 cache clone/replay 重绑这些事实；旁挂最小单行 inline fragment 权限。新 exact/fragment 输出沿现有 verified factory、原始 Step 链和内部 preserving candidate 提交，严格验证完整 doc 与 protected 集合；既有结构 candidate 权限不变。最后在 F1 的真实 top checkpoint runner 中扩展有限完整容器闭包，绝不把 full fallback 计作 nested 局部解析。

**Tech Stack:** TypeScript、markdown-it 14.1.1、prosemirror-markdown、ProseMirror、Vitest；不新增依赖。

**Spec:** HOST `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.4 / I7；本 OWN `selected-input/next-file-ui-producer-dependencies.md`、`selected-input/root-verification-report.md`；配套 `nested-source-plan-design-notes.md`。历史研究只作参考，冻结源码优先。

## Global Constraints

- 所有 pnpm 调用前置 `env pnpm_config_verify_deps_before_run=false`，禁止隐式 depsStatusCheck 安装；环境失败不算行为 RED。

- HOST `/Users/bruce/git/mdeditor` main 基线 `dbb79b5ba24a32f2e0ccca033d0d3e1707d277e3`；CORE `/Users/bruce/git/moraya-core` main 基线 `6585a2470f885984819f5418aa17d4400a7b9ea5`。两个现有 main，不建 worktree，不切分支、不修改 stash；逐提交精确记录。
- OWN `/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-shared-editor-nested-source`；本计划已由 root 自审受理，见 reports/2026-10-14-nested-source-plan-preflight.md；尚无本批产品通过结论。
- package.json 与 lockfile 完整 bytes 不变；main gzip ≤81920，当前 76263；不能预先增加预算。
- 不建通用 CST、definition transport、第二 raw 账本、authority setter；不新增依赖、生产 parse oracle、格式 diff 过滤或整根/全文 serialize 再 diff。
- 全部原始 Step 范围、真实 prototype、`tr.docs` 链、全部 attrs/marks 严格 eq。原 pre-render protected guard 与 edits overlap guard 均保留。
- 新 fragment edits 不碰 protected；候选 actual protected 集合必须与旧集合精确平移后完全相等，不能仅验证子集或字符串仍存在。
- 两仓 14 原 fixture 与 manifest SHA 不变；保留全部旧回归。新功能必须有实现前真实行为 RED；已有不变量首次 GREEN 如实记录，不伪造 RED。
- 不实施 bindings、history、Kit UI 或发行；不把本批 producer 测试写成真实 UI 已完成。

## 文件与责任、允许修改的测试

CORE 产品只改 `src/markdown.ts`（真实 capture、emission、私有片段 authority、窗口 admission）、`src/source-fidelity.ts`（exact/fragment消费）、`src/source-file-cache.ts`（Rich protected提交校验）。新增 `src/source-content-trace.ts` 只做实际消费的 trace 投影，不决定 Markdown 语法。公开 `SourceSession` 不加 provenance 字段；`SourceBlockResult.mode` 增加 `'fragment-render'`。

CORE 新测试精确 allowlist：`src/__tests__/source-nested-producer.spec.ts`、`src/__tests__/source-body-producer.spec.ts`、`src/__tests__/source-nested-window.spec.ts`、`src/__tests__/source-nested-cache.spec.ts`、`src/__tests__/source-nested-test-utils.ts`。

CORE 旧测试允许修改仅 `src/__tests__/source-reference.spec.ts` 开头两个 “reference-covered owner mark 原子拒绝”用例：迁移为已授权整正文 mark 成功，原字节/原子性断言保留并加入真正越界负例。其余旧例原样，包括 multi-root 两次 mark 的拒绝（本批 mark 只签发单 Step、单正文权限）。如其余旧断言确与新能力冲突，先给 root 精确断言和原因，禁止静默删除。

Task1 另精准允许迁移 `src/__tests__/source-fidelity.spec.ts` 中 list opaque/拒绝嵌套正文两项旧能力断言，以及 `src/__tests__/source-terminal-hardbreak.spec.ts` 两条 list/quote spans为空断言；改为真实文字span/字节保持成功，hardbreak无span和其它安全负例仍保留。参见自审报告追加裁定。

Task1 追加精准旧测试迁移清单：`src/__tests__/source-list.spec.ts`, `src/__tests__/source-document-capture.spec.ts`, `src/__tests__/source-block-fidelity.spec.ts`, `src/__tests__/source-list-boundary.spec.ts`, `src/__tests__/source-file-window.spec.ts`，仅自审报告追加裁定中的净能力/真实计数断言；两条unclosed根拒绝保留。

HOST 新测试只增 `src/lib/share-merge/source-nested-producer.test.ts`；旧 `source-fidelity.test.ts` 和全部 corpus 不改。两仓 `CHANGELOG.md` 各加未发布条目；经验证的 core dist 按现有闭包工具提交。root 的控制工具与任务记录不混入产品提交。

### Task 1: nested/heading 正文 exact 与最小同容器 mark（capture 与消费同交付）

**Files:** 修改 CORE 三个产品文件；新增 `source-content-trace.ts`、nested producer/utils/cache 测试；精确迁移上述两个旧 reference 用例。

**Interfaces:**

```ts
// source-content-trace.ts，Task 1 实现；不导出包入口。
export type LineRead = Readonly<{
  begin:number; end:number; indent:number; keepLastLF:boolean;
  rows:readonly { b:number; e:number; t:number; bs:number }[];
}>;
export function traceConsumedLines(trace:SourceTrace, read:LineRead,
  actual:string):SourceTrace | undefined;
// 每次 original getLines 调用旁记录其当时可变行表；actual 是原函数返回值。
// trim、terminal hardbreak 均在原段落规则的相同位置投影，不重新解析容器。

// markdown.ts 私有类型，capture token facts 不写入公开 Session。
type InlineBody = Readonly<{
  pmFrom:number; pmTo:number; sourceFrom:number; sourceTo:number;
  kind:'paragraph'|'heading'|'table-cell'; singlePhysicalLine:boolean;
}>;
export function capturedInlineBodies(source:string, doc:PmNode,
  roots:readonly SourceRoot[], layout:SourceLayout):readonly InlineBody[] | undefined;
export function serializeSourceInlineBody(node:PmNode):string;
// source-file-cache.ts内部候选入口，不加入index.ts公开exports；Task1实现。
export function preparePreservingSourceCandidate(base:VerifiedFileBase,
  patches:readonly SourcePatch[],work:FileWorkAccumulator,
  expectedDoc:PmNode):FileSourceResult;
// 读取同 capturedListLayouts 一代的私有登记；identity 不符返回 undefined。
// serializer 共享既有保守 inline callbacks，调用 renderInline，不加 block prefix/tail，
// 不 relaxEscapes、不删除 ZWSP、不调用 parseMarkdown。
```

- [ ] **1.1 写行为 RED 与完整测试 helper。** 以下 helper 放新 utils 文件；PM 路径由 schema 结构指定，重复正文也不靠 indexOf 定位。

```ts
import {expect} from 'vitest';
import {EditorState, TextSelection, type Transaction} from 'prosemirror-state';
import {toggleMark} from 'prosemirror-commands';
import type {Node as PmNode} from 'prosemirror-model';
import {createSourceSession, applySourceBlockTransaction} from '../source-fidelity';
export function open(raw:string) {
  const r=createSourceSession(raw); expect(r.ok).toBe(true);
  if(!r.ok)throw new Error(r.reason); return r.session;
}
export function at(doc:PmNode,path:readonly number[],offset=0):number {
  let n=doc, contentStart=0;
  for(const index of path){
    let skip=0; for(let i=0;i<index;i++)skip+=n.child(i).nodeSize;
    contentStart+=skip+1; n=n.child(index);
  }
  if(offset<0||offset>n.content.size)throw new Error('invalid test offset');
  return contentStart+offset;
}
export function change(raw:string,path:readonly number[],offset:number,expected:string) {
  const b=open(raw),p=at(b.doc,path,offset);
  expect(b.doc.textBetween(p,p+1)).toBe('甲');
  const tr=EditorState.create({doc:b.doc}).tr.insertText('乙',p,p+1);
  const r=applySourceBlockTransaction(b,tr); expect(r.ok).toBe(true);
  if(!r.ok)throw new Error(r.reason);
  expect(Buffer.from(r.session.source)).toEqual(Buffer.from(expected));
  expect(r.mode).toBe('exact-text'); expect(r.edits).toHaveLength(1);
  expect(r.edits[0]!.to-r.edits[0]!.from).toBe(1); expect(r.edits[0]!.text).toBe('乙');
  expect(r.session.doc.eq(tr.doc)).toBe(true); expect(b.source).toBe(raw);
  return {b,r,tr};
}
export function bold(raw:string,path:readonly number[]) {
  const b=open(raw),p=at(b.doc,path),n=b.doc.resolve(p).parent;
  const s=EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,p,p+n.content.size)});
  let tr:Transaction|undefined;
  expect(toggleMark(s.schema.marks.strong!)(s,t=>{tr=t})).toBe(true);
  if(!tr)throw new Error('command did not dispatch');
  return {b,tr,r:applySourceBlockTransaction(b,tr)};
}
```

```ts
import {expect,it} from 'vitest'; import {change,bold} from './source-nested-test-utils';
it.each([
 ['>  甲。\n> 第二句。\n',[0,0],0,'>  乙。\n> 第二句。\n'],
 ['*   甲。\n*   甲。\n',[0,1,0],0,'*   甲。\n*   乙。\n'],
 ['[^n]: 甲。\n\n正文[^n]。',[0,0],0,'[^n]: 乙。\n\n正文[^n]。'],
 ['###   甲。   ###\n',[0],0,'###   乙。   ###\n'],
 ['甲。\n====\n',[0],0,'乙。\n====\n'],
 ['\uFEFF>  甲。\r\n> 甲。\r\n',[0,0],0,'\uFEFF>  乙。\r\n> 甲。\r\n'],
 ['> 甲。\nlazy甲。\n',[0,0],7,'> 甲。\nlazy乙。\n'],
] as const)('real nested body %j',(a,path,o,b)=>change(a,path,o,b));
it('preserves actual nested definition while real toggleMark edits Alpha',()=>{
 const a='> [ref]: /url\n>\n> Alpha\n\nTail';
 const {r,tr}=bold(a,[0,0]); expect(r.ok).toBe(true); if(!r.ok)throw Error(r.reason);
 expect(r.mode).toBe('fragment-render');
 expect(r.session.source).toBe('> [ref]: /url\n>\n> **Alpha**\n\nTail');
 expect(r.session.doc.eq(tr.doc)).toBe(true); expect(r.edits).toHaveLength(1);
 const back=bold(r.session.source,[0,0]); expect(back.r.ok).toBe(true);
 if(back.r.ok)expect(back.r.session.source).toBe(a);
});
```

lazy例正文PM为 `甲。`、一个hardbreak、`lazy甲。`，目标甲offset为7。所有测试在发事务前核对实际目标字符。

- [ ] **1.2 在 CORE 运行 RED。** `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-nested-producer.spec.ts`；新 exact 应失败于 mode/raw 或 unsupported，新 mark 应失败于原 protected拒绝。先确认输入 parse 与真实命令正确，不能将错误 PM fixture 当 RED。
- [ ] **1.3 实现实际 trace 投影及 occurrence emission。** 算法如下（不再改变块 grammar）：

```ts
// traceConsumedLines：按实际 getLines 的切片消费复制 provenance。
// 对每行 first=b, width=0；while first<last && width<indent：
// U+0020 => width++; TAB => width += 4-(width+bs)%4;
// 非空白但 first-b<t => width++；否则 break；first++。
// last=e+1（内部行或 keepLastLF）否则 e，sliceTrace 保持原 trace pieces。
// width>indent 时前置 generated spaces，禁止为这些字符签发 raw span。
// 把所有 pieces 的 logical from/to 加上已累计长度；actual 全等才返回。
// 这是 getLines 已执行结果的消费投影，不试探是否 paragraph/list/quote 成立。
```

在 paragraph wrapper **调用 original 时**存 getLines 的 begin/end/indent/keepLastLF 与该次 b/e/tShift/bsCount；保留现 terminal hardbreak 的实际行为，trimStart/trim 的 logical 区间经 `sliceTrace`。移除 `top` 对 trace 的限制，但不删除 terminal、token.level、content 严格核验。对 lheading 同样包 actual getLines；ATX heading 只在 original success 后利用当次起始 b+t、实际 heading markup.length、`skipSpacesBack/skipCharsBack` 观察到的尾界投影并验证 inline.content；不以全文搜索确定位置。

所有 actual inline token 在原 handler 调用前后读 `captureCursor` 与同一 PM stack frame；按 emitted PM occurrence 建正文记录。table 的额外 paragraph 由原 th/td handler创建，不能假设 token 数等于 PM node数。finalizer 一次 `doc.descendants` 索引真实 text parents；逐 run 核验同 parent、长度、linear字节、marks 与实际 emitted occurrence。不要逐 run 重扫整 doc，不以 Node.eq/相同文本认身份。保留 atom 位置洞和 generated 字符不可写性。

`cloneTokenBatch` 复制正文 trace/kind 等 WeakMap事实，`rawDelta` 平移 source 坐标，`lineDelta` 仅平移 token.map；每次 emission 重新建立 PM位置，绝不平移旧PM坐标。只在 finalizer全部验证通过后随 layout 登记 bodies；foreign base只能由现有 prepareVerifiedFileBase真实重捕获取得同代私有 facts。

- [ ] **1.4 接通 exact、single-body fragment 与 protected最终验证。**

```ts
// source-fidelity.ts exact：稳定 root 的真实 Step权限先验证，随后才找 textSpans。
// 旧 depth===1 改为 sameParent + 已捕获span覆盖 + 支持正文parent；不是只删guard。
const textParents = new Set(['paragraph','heading']);
// 单纯 text Replace 必须恰为 ReplaceStep.prototype，structure=false，closed text slice；
// 原 surrogate/atomic/contiguous-source/ambiguous insertion 检查仍在。
// 对有映射的普通单字 Replace，candidate mismatch 应返回失败，不能再整根漂移。
```

最小 mark recipe：只接一个实际 AddMarkStep 或 RemoveMarkStep，mark为 strong/em；实际范围恰等于一个有 authority 的 **单物理行整个正文**；旧/新内容仅 text、无atoms/hardbreak，旧/新所有 mark都属于 strong/em且 markup可表达；祖先类型/全部attrs/marks与正文结构未改变。这个范围足以完成 quote/list含definition的 Alpha 加/去粗，亦供 cell使用；局部选区、跨行和混合 link/code/highlight 暂不声称已支持。生成仅 body raw区间，原 prefix/EOL/raw sibling不入 renderer。`serializeSourceInlineBody` 直接使用既有 inline serializer callbacks，最终 strict candidate eq负责语法正确；新增模式 `fragment-render`，不能伪装 exact-text。

`applySourceTextTransaction` 公开入口也必须审真实 ReplaceStep prototype 和 apply(before).doc；不能只审 toJSON。Block stable路径先保留 changedNaturalRoots原审计；fragment不绕开它。对本批声明的 same-parent text/plain单正文 mark命令，缺映射应明确失败，不回 root-render把句子之外的字节归一。现有结构命令与未声明操作的旧根路径保持原权限，但不得纳入本批成功统计。

新增内部 `preparePreservingSourceCandidate` 供本批exact/fragment调用，与原 `prepareCandidate` 共用私有候选实现；旧结构/root-render以及显式raw入口仍走原合同。新入口在 `registerSession/commitRecovery` **之前**核对 protected：每个原区间必须完整落入一个 `spliceSource` kept piece；按 piece偏移构造 `{kind,scope,sourceFrom,sourceTo}`，确认 kept raw bytes；新 actual数组与预期逐项全等，含数量、重复、unused、顺序。缺失、新增、scope变更或位置漂移都拒绝。不公开 protected授权选项或setter，不给raw API施加Rich权限，也不改旧结构命令的protected合同。私有实现以内部布尔参数切换这项提交校验，两个调用入口自身明确其权限，不能由公开SourceSession事实切换。

- [ ] **1.5 缓存和负例与 GREEN。** 新 `source-nested-cache.spec.ts` 至少包括：三次 `replayFilePipeline` 的 doc/runs/roots/protected/layout全等；clone后同nested实际文字仍 exact；按数组字段分别篡改 textSpans的 sourceFrom/sourceTo/pmFrom/pmTo/kind，foreign请求均在 renderer前拒绝；合法 `{...base}` foreign首次真实capture后成功；失败后合法重试成功。这些安全不变量若首跑GREEN记录GREEN，不制造缺陷。

实际新增负例：`> [ref]: /u\n>\n> Alpha\n\nTail` 的 mark原范围跨Alpha及Tail、伪 ReplaceStep subclass、tr.docs链篡改、只改 checked/language/heading level的假text payload、atomic entity内部、surrogate内部、跨quote prefix的一次Replace。spy现有 `serializeSourceRootMarkdown` 证明成功protected正文从未交整根renderer。旧两项“mark应拒绝”迁移为上面positive，并在相同文件保留真正范围越界拒绝与base不变断言。

运行：`env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-nested-producer.spec.ts src/__tests__/source-nested-cache.spec.ts src/__tests__/source-reference.spec.ts src/__tests__/source-fidelity.spec.ts src/__tests__/source-terminal-hardbreak.spec.ts`。另运行 `env pnpm_config_verify_deps_before_run=false pnpm run typecheck` 及root生成的新增测试严格类型检查；全通过后仅提交Task1已验证的精确源文件并记录SHA。此时dist仍为上阶段，不得安装或声称installed通过；此时 nested工作量可full-fallback，不能声称§12.4已完成，Task3是本批完成前硬依赖。

### Task 2: table 与现有 literal 正文 producer（真实 body，不改旁边目标甲）

**Files:** 改 CORE `markdown.ts`、`source-content-trace.ts`、`source-fidelity.ts`；新增 `source-body-producer.spec.ts`。

**Consumes:** Task1 `traceConsumedLines`、actual inline emission、现有TextSourceSpan、strict protected candidate、single-line body fragment。

**Produces:**

```ts
// source-content-trace.ts；Task2实现。只投影成功table实际行，不判断table语法成立。
export function traceTableRow(trace:SourceTrace, from:number, to:number,
  actual:readonly string[]):readonly (SourceTrace|undefined)[] | undefined;
// actual由真正tr_open.map+th/td/inline slot顺序取得。
// 返回undefined整体表示投影不符；单slot undefined表示真实自动补空cell、无原文权限。
// literal tokenFacts沿Task1相同WeakMap clone规则复制，kind取实际token family。
```

- [ ] **2.1 写真实 table/literal RED。** 测试使用Task1的change函数（唯一helper来源）。

```ts
import {it,expect} from 'vitest'; import {change,bold,open,at} from './source-nested-test-utils';
it('body cell preserves alignment separator and uneven padding',()=>{
 change('| H | J |\n| :--- | ---: |\n|   甲 | 甲  |\n',[0,1,1,0],0,
        '| H | J |\n| :--- | ---: |\n|   甲 | 乙  |\n');
});
it('escaped pipe is atomic; later body text remains writable',()=>{
 change('| H |\n| :--- |\n| a\\|甲 |\n',[0,1,0,0],2,
        '| H |\n| :--- |\n| a\\|乙 |\n');
});
it.each([
 ['~~~~mermaid\ngraph TD; 甲-->B\n~~~~\n',[0],10,'~~~~mermaid\ngraph TD; 乙-->B\n~~~~\n'],
 ['\uFEFF---\r\ntitle: 甲\r\n---\r\n',[0],7,'\uFEFF---\r\ntitle: 乙\r\n---\r\n'],
 ['<div class="note">\n  甲。\n</div>\n',[0],21,'<div class="note">\n  乙。\n</div>\n'],
 ['    甲。\n    同句。\n',[0],0,'    乙。\n    同句。\n'],
 ['{==甲。==}{>>原注<<}',[0],0,'{==乙。==}{>>原注<<}'],
] as const)('literal/critic actual body %j',(a,p,o,b)=>change(a,p,o,b));
it('same actual table cell supports full-body strong fragment',()=>{
 const {r}=bold('| H |\n| :--- |\n|  Alpha  |\n',[0,1,0,0]);
 expect(r.ok).toBe(true); if(r.ok)expect(r.session.source).toBe('| H |\n| :--- |\n|  **Alpha**  |\n');
});
```

上面HTML正文offset需依据字面长度固定为 **21**（`<div class="note">` 18 + LF 1 + two spaces 2）；每个case必须先断言 `doc.resolve(at(...)).nodeAfter` 的首字是甲，避免把位置错误当能力RED。Mermaid首字offset为10（`graph TD; `）。

同文件增加表头正文、header-only、重复cell、extra列、auto-fill空slot、单/双/三反斜杠紧邻pipe、cell内entity、CRLF+BOM与nested quote table。各expected完整字面量写入；自动补空slot不签发fake span，empty cell插字留明确失败且不得格式化整表。

- [ ] **2.2 运行 RED。** `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-body-producer.spec.ts`；明确记录表格当前 root-render/spacing变化、literal未mapped或mode错误，不预先声称具体hunk数量。
- [ ] **2.3 在真实 table 成功规则接缝绑定行trace。** 在现有wrapCaptureRule包table：original原样执行；返回true后仍在外层quote/list已改写的活动state内，读取真实tr_open.map行号及当次 `bMarks[row]+tShift[row]` 到 `eMarks[row]`；按实际th/td/inline顺序采集cell内容。

`traceTableRow` 对这些已选择物理行执行唯一消费投影：原getLine→整行trim→实际escapedSplit词法消费→移除首尾empty边格→逐cell trim；普通字符copy，`\|`删除slash并把pipe对应raw两字符标成atomic。**isEscaped是上一字符是否反斜杠，不是自己发明奇偶计数规则。** 逐slot验证content和实际cell数；真实规则忽略的多余列不分配PM/span，自动补齐的empty slot无source权限。完整行无法对齐则不给这条producer权限；不得退回重复正文indexOf。该函数完全不决定header separator、alignment、起止、终止或table是否成立，只有真实原规则决定这些。

inline token没有map属已知事实；不要伪造map。将其children关联投影trace后走Task1 owners/tokenArrays及真实PM cell内paragraph emission。tbody/header/empty token克隆不能漏绑定。保留对齐attrs原解析与table结构producer不变。

- [ ] **2.4 接通literal正文的最小映射。** fence沿现有getLines wrapper同时保存实际body trace；code_block包actual getLines；front_matter在已有contentStart/contentEnd原切片处存trace；html_block包真实getLines并只接受default html_block emission，img/video/audio promotion仍无literal权限。prosemirror-markdown `withoutTrailingNewline`会去一个末尾LF：将trace同步slice至实际PM文本长度；不能把最后EOF/EOL算正文权限。

这些token由noCloseToken handler直接addText，不经过h['text']：在该handler前后观察实际PM frame/cursor，把实际body文本与trace核验后生成runs。CSV fence变spreadsheet属性，不签发code text span。新增exact parent白名单 `code_block/frontmatter/html_block`；所有完整attrs/marks不变，原fence长度、info、indent、BOM与EOL均由未碰raw保留；改字迫使闭合delimiter或块类型变化则candidate strict eq拒绝，不扩大成结构授权。

Critic range正文沿已存在actual recursive inline tokenize消费，放宽captureText/finalizer对 **已经实际emitted的** `annotation`（实际token名critic_anno）、`html_mark`、`highlight`、`strike_through`普通文本的准入；仍不把markup/metadata本身当text。每个span继续核对实际text和所有marks，producer不得编辑批注note属性。这样原fixture的`保留 _强调_`内部可精确改字并保留原注。

内联code与math_inline的token不经text规则：本批先不伪造span。需要在后续UI确实启用其正文编辑之前加对应actual规则body事实；不要用邻段成功替代。块math attrs.value的既有修改consumer本次未找到；Critic point确有HOST `src/lib/note-anno/note-commands.ts:94–110` 的openEditForAnchor→setNodeMarkup({note:clean})，本批仍按root范围裁定明确不交付此属性producer，不能据此启用该file编辑入口。见设计notes逐类型矩阵；这些是明确仍未交付的区域，不声称完整§12.4 UI可启用。

- [ ] **2.4b 验真实 frontmatter NodeView 的整正文 Replace，不能仅手写 insertText。** 在同一新body测试文件加入：

```ts
import {createEditor} from '../setup';
import {BrowserMediaResolver} from '../adapters/browser-media-resolver';
import {createSourceSession,applySourceBlockTransaction,type SourceBlockResult} from '../source-fidelity';
import type {FrontmatterViewFactory} from '../types';
it('actual frontmatter onChange retains CRLF and emits one character patch',async()=>{
 const raw='\uFEFF---\r\ntitle: 甲\r\nother: keep\r\n---\r\n';
 const expected='\uFEFF---\r\ntitle: 乙\r\nother: keep\r\n---\r\n';
 let input:((raw:string)=>void)|undefined;
 const factory:FrontmatterViewFactory={render(_container,_raw,onChange){
   input=onChange;return {destroy(){}};
 }};
 const container=document.createElement('div');document.body.append(container);
 const editor=await createEditor({container,initialContent:raw,
   mediaResolver:new BrowserMediaResolver(),frontmatterViewFactory:factory});
 try {
   const opened=createSourceSession(raw,editor.view.state.schema);
   if(!opened.ok)throw Error(opened.reason);
   expect(opened.session.doc.eq(editor.view.state.doc)).toBe(true);
   const seen:SourceBlockResult[]=[];const ranges:number[]=[];
   editor.view.setProps({dispatchTransaction(tr){
     let count=0;tr.steps[0]!.getMap().forEach(()=>count++);ranges.push(count);
     seen.push(applySourceBlockTransaction(opened.session,tr));
     editor.view.updateState(editor.view.state.apply(tr));
   }});
   expect(typeof input).toBe('function');input!('title: 乙\nother: keep');
   expect(seen).toHaveLength(1);const result=seen[0]!;
   expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);
   expect(Buffer.from(result.session.source)).toEqual(Buffer.from(expected));
   expect(result.edits).toHaveLength(1);
   expect(result.edits[0]!.to-result.edits[0]!.from).toBe(1);
   expect(result.edits[0]!.text).toBe('乙');expect(ranges).toHaveLength(1);
 } finally {editor.destroy();container.remove()}
});
```

这个consumer实际用 `setup.ts:977` 的 `replaceWith(from,to,schema.text(newRaw))`，不是单字Step。因此仅对code_block/frontmatter/html_block无mark正文，在 **原Step完整范围权限审计之后**，比较原Step覆盖的纯正文与该Step插入文本，求最大相同UTF-16前后缀（不能切surrogate）；用剩余PM区间走既有span边界映射，验证整个original tr.doc。没有serialize动作，没有根级diff，没有缩小原权限范围。原始闭合/类型/attrs/兄弟/祖先审计均不变；若插入文本有不同marks或多节点结构，不做收缩。这样保留真实NodeView未修改的CRLF；changed raw仍只有一个字符。禁止把这一缩范围规则用于任意结构或protected根权限。

- [ ] **2.5 GREEN 与缓存覆盖。** `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-body-producer.spec.ts src/__tests__/source-nested-producer.spec.ts src/__tests__/source-nested-cache.spec.ts src/__tests__/source-file-replay.spec.ts src/__tests__/source-fidelity-corpus.spec.ts`。把table/literal/critic case加入新cache测试的replay/foreign调用矩阵；仅改新测试，不扩旧fixture。另运行 `env pnpm_config_verify_deps_before_run=false pnpm run typecheck` 及新增测试严格类型检查；通过后精确提交并记录SHA。Task1/2不重复build，dist保持旧版且禁止安装，统一在Task3构建并验证；Task2具备实用raw producer，nested局部解析仍交Task3。

### Task 3: 有限真实 nested 窗口闭包、完整回归及 installed-host propose

**Files:** CORE `markdown.ts` 的captureFileWindow admission；新增 `source-nested-window.spec.ts`；补新cache测试；HOST新增 `src/lib/share-merge/source-nested-producer.test.ts`；两仓CHANGELOG；经工具验证的CORE dist。

**Consumes:** Task1/2所有实际token facts及F1原checkpoint、runTopLevelWindow、sentinel、environment/replay管线。

**Produces:** 已支持LF nested普通改字真实local/expanded成功；相同输入100/1000段与不变远端定义的parse工作受限；installed实际包的一字raw/单hunk证据。无新增公共API。

- [ ] **3.1 写能力RED（前两个Task成功raw后此RED检查工作量）。**

```ts
import {expect,it} from 'vitest'; import {EditorState} from 'prosemirror-state';
import {applySourceBlockTransaction} from '../source-fidelity';
import {open,at} from './source-nested-test-utils';
it.each([100,1000])('bounded actual nested parsing with %i roots',count=>{
 const prefix=Array.from({length:count},(_,i)=>`P${i}。\n\n`).join('');
 const raw=prefix+'> [r]: /u\n>\n> 甲。\n\nTail。\n\n[r2]: /far\n';
 const b=open(raw),p=at(b.doc,[count,0]);
 const tr=EditorState.create({doc:b.doc}).tr.insertText('乙',p,p+1);
 const r=applySourceBlockTransaction(b,tr); expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe(prefix+'> [r]: /u\n>\n> 乙。\n\nTail。\n\n[r2]: /far\n');
 const w=r.file!.work;expect(['local','expanded']).toContain(w.mode);
 expect(w.fullCaptureCalls).toBe(0);expect(w.legacyParseCalls).toBe(0);
 expect(w.blockParseCalls).toBe(1);expect(w.topLevelRunnerCalls).toBe(1);
 expect(w.rawTouchedBeforeRoots).toEqual([count]);expect(w.inlineRoots.length).toBeLessThanOrEqual(3);
 expect(w.nestedTokenizeCalls).toBeGreaterThan(0);
 expect(w.blockRuleCalls).toBeLessThanOrEqual(250);expect(w.blockLinesVisited).toBeLessThanOrEqual(1500);
});
```

同样参数化 list、footnote、table、ATX/setext，用明确PM路径、完整独立expected；记录两种长度实际counter并断言blockRuleCalls/blockLinesVisited相等（PM emission/preprocess/line table/splice仍O(N)，不限制假O(1)）。literal、CRLF/BOM、无法证闭包的复杂混合用例允许明确full-fallback，单字raw门槛仍必须过。

- [ ] **3.2 运行 RED。** `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-nested-window.spec.ts`；应失败于F1旧paragraph-only admission导致full-fallback，不能把full pass当local pass。
- [ ] **3.3 扩真实完整容器闭包，不新增窗口parser。** admission从三个token名字改为验证实际top checkpoint分段：每段从level0开始，open/close匹配、无越界map、结束level0、token全部属明确的paragraph/heading/blockquote/list/list_item/footnote_reference/table/thead/tbody/tr/th/td/inline集合。允许paragraph map多行，但窗口左右必须是现有真实top规则完成epilogue的checkpoint；不能从list中间或某cell启动parse。所有规则继续看到完整source与真实EOF。

保留sentinel的scalar/hasEmptyLines、实际tokens、definitions事件、后缀raw相等校验；sentinel比较还需包括新token trace的canonical可序列化视图（rawDelta/lineDelta后），防止semantic token相同却来源fact不同。对比仅属于被比较tokens的事实，不能把collector/PM/frame引用放入JSON。满足闭包才重用右后缀，未证则null→原full fallback并记录reason。

nested定义事件仍由真实reference wrapper捕获；环境变化继续原foldDefinitionEvents与远处inline replay，不把字节未改等同于inline不用重算。缓存后缀事实shift/inline重放补测试：先在前一普通paragraph插入一行造成rawDelta与lineDelta，再改远处table/list实际正文；再通过显式raw API修改远端reference URL引发inline重算，再改有link的nested普通文字。每次独立expected raw、actual doc等价与protected集合都核验，失败candidate不登记cache。

- [ ] **3.4 installed host测试正文，保留原14fixture SHA。** 从真实`@moraya/core`导入，不能alias源码。新host文件将Task1/2的小字面例逐个复制为独立expected，并对原mixed-list/quote/table/footnote/mermaid/html/frontmatter/critic-range实际内部文字另列具名case。每个原fixture先验manifest SHA，再按PM结构位置选语料内部字符；不找目标甲。明确保留其余字符的expected采用固定目标raw offset加独立字面前后片段，并核对被替换raw原字等于预期；禁止source.replace(/同文/)决定目标。

```ts
import {expect,it} from 'vitest'; import {EditorState} from 'prosemirror-state';
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core';
import {propose} from './proposal';
it('installed table body produces one real row hunk and one raw character',()=>{
 const source='| H | J |\n| :--- | ---: |\n|   甲 | 甲  |\n';
 const expected='| H | J |\n| :--- | ---: |\n|   甲 | 乙  |\n';
 const opened=createSourceSession(source);if(!opened.ok)throw Error(opened.reason);
 const b=opened.session;let p=0;
 b.doc.descendants((n,pos)=>{if(n.type.name==='table_cell'&&n.textContent==='甲')p=pos+2});
 // 两个同文cell；遍历实际occurrence选择最后cell，不能搜索raw同文。
 expect(b.doc.resolve(p).parent.type.name).toBe('paragraph');
 const tr=EditorState.create({doc:b.doc}).tr.insertText('乙',p,p+1);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(Buffer.from(r.session.source)).toEqual(Buffer.from(expected));
 expect(r.edits).toHaveLength(1);expect(r.edits[0]!.to-r.edits[0]!.from).toBe(1);
 const proposal=propose({path:'table.md',base:source,ours:source,theirs:r.session.source});
 expect(proposal.hunks).toHaveLength(1);expect(proposal.theirsEolAligned).toBe(false);
 const h=proposal.hunks[0]!;expect(h.kind).toBe('theirs-only');
 expect(h.base).toBe('|   甲 | 甲  |\n');expect(h.theirs).toBe('|   甲 | 乙  |\n');
});
```

hunk边界诚实区分：普通nested prose按真实句子token；table按实际行、fence/math/HTML按实际块。所有类型都独立断言只一个raw字符改变；不为达到一hunk修改tokenizer、proposal或diff过滤。

- [ ] **3.5 顺序运行验收并保存原始结果。** root先把selected-input九个工具及其依赖复制/适配到本OWN；这些脚本当前硬编码旧OWN，**不可直接运行selected-input副本写旧证据**。实际根路径替换、固定双BASE、允许产品文件及本计划test allowlist均经root核对后才运行。

```sh
# 在CORE cwd，先targeted，再全部；每条由适配后OWN/run.py记录argv/cwd/stdout/stderr/exit。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-nested-window.spec.ts src/__tests__/source-nested-cache.spec.ts src/__tests__/source-nested-producer.spec.ts src/__tests__/source-body-producer.spec.ts
env pnpm_config_verify_deps_before_run=false pnpm test
env pnpm_config_verify_deps_before_run=false pnpm run typecheck
env pnpm_config_verify_deps_before_run=false pnpm run build
# 构建产物验证顺序：OWN/core-artifacts.sh → OWN/core-stage-dist.sh → 精确core commit。
# 在HOST cwd，只从已提交core dist同步：OWN/host-sync.sh → OWN/installed-corpus-audit.sh。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/lib/share-merge/source-nested-producer.test.ts src/lib/share-merge/source-fidelity.test.ts src/editor-kit-v2/source-fidelity.test.ts
env pnpm_config_verify_deps_before_run=false pnpm test
env pnpm_config_verify_deps_before_run=false pnpm run check:share-merge
env pnpm_config_verify_deps_before_run=false pnpm run check:editor-kit
env pnpm_config_verify_deps_before_run=false pnpm run check
```

source typecheck外，root工具须对新增测试生成临时严格tsconfig并编译，不用Vitest转译成功冒充types通过。host Vite构建用既有空envDir控制路径，禁止source .env；构建、installed检查均绑定最终提交dist及DTS/maps embedded sources，保留18实际JS入口、全部dist文件逐bytes验证、两仓fixture SHA和package完整bytes比较、main gzip≤81920。不得先安装dirty dist再在报告中写成committed验证。

- [ ] **3.6 最终产物顺序及提交。** 保存每任务RED/GREEN→聚合full tests/types→build与gzip→core dist闭包→core精确commit与SHA→host同步及installed逐bytes→host propose/full/purity/check/build→host精确commit与SHA→双HEAD final fingerprint→root整批自审。每个失败原日志保留；修改后只重跑受影响门槛，最终哪些HEAD跑过全套必须准确注明。未提交明确写“未提交”。

本批完成声明只能是上述已验producer及局部闭包；不包含完整file UI、history、math/point属性编辑或native/IME。后续file UI若要启用未覆盖可编辑面，必须增加真实body/attr producer与实际consumer验收，不能将本计划明确fallback/unsupported项目算作§12.4完成。
