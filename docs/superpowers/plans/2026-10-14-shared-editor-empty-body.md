# Empty body input closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. root 自审、单一产品 writer；不自行加 reviewer。

**Goal:** 真实常见空正文能输入首字；Enter/工具栏创建的空容器在成功保存后仍可输入，file UI 不因来源缺口退化。

**Architecture:** 在真实规则消费和实际 PM emission 之间增加最少 private empty-body authority；普通输入直接产生受限 raw recipe。顶层 synthetic 复用既有 layout ledger，nested blank 沿同一 source-aware 空段约定补 private facts及source-only输出；每个 Task 都同时交付捕获和真实文本 consumer。

**Tech Stack:** TypeScript、markdown-it、ProseMirror、Vitest；无新增依赖。

**Spec:** HOST `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.4/I7、§12.9；本 OWN `empty-body-input-design.md`。后继为 `remaining-inline-plan-draft.md` 的 marks/code/Critic能力。

## Global Constraints

- CORE `/Users/bruce/git/moraya-core`、HOST `/Users/bruce/git/mdeditor`，现有两个 main，不建 worktree，不读 `.env`；单一产品 writer。
- 执行冻结 CORE `75abb5bd168fd33935a8cd692d1d63543fb1a7eb`、HOST 产品 `a373bd707ffba1df347827225966af80958a3fdd`，宿主收尾文档 `c3cd5e57`。全部交叉接口已对照实际已提交源码，不得以工作区 dirty 源码替代冻结。
- 不改变 package/lock完整bytes；main gzip ≤81920；两仓14 fixture与manifest SHA不变；默认legacy parse/serialize语义不改。
- 不CST、不第二parser、production parse oracle、候选试parse、whole-root serialize再diff、第二raw账本、authority setter或definition搬运。
- 原Step完整range、exact prototype、tr.docs/apply链先审；attrs/marks及最终doc.eq严格一致。新路径保留两道protected guard及actual protected集合精确平移检查。
- 不增加未闭fence权限、新math正文UI；closed fence delimiter碰撞增长由已记录的remaining-inline Task1交付，不把本稿普通空body输入冒充围栏增长。
- 普通无mark输入先做；本稿不修改 toolbar/bindings/history/批注UI。后继marks/Critic消费同一authority，不能各自猜empty sourceAt。
- 以下均为待执行计划；本稿未运行测试、build、install、gate。Task1只提交源/tests/types，旧dist不可安装；Task2统一build/install/host闭包。

## 交叉接口与文件责任（root 冻结时逐项核）

| 既有接口 | 固定源码事实 | 本稿接法 |
|---|---|---|
| `capturedSourceLists(source,doc,roots,layout)` | 私有绑定同代source/doc/roots/layout | empty facts放同一binding，不信public layout复制 |
| `capturedInlineBodies(...)` / InlineBody | 仅非空contiguous trace能建正文 | 不伪造零长TextSourceSpan，单独private EmptyBody |
| `captureInlineEmission/captureLiteralEmission` | 捕获真实PM frame/返回node | 同处记录空body，再以finaldoc occurrence校正pmAt |
| `cloneTokenBatch(...,rawDelta,lineDelta)` | clone block/inline facts与closed fence位 | 同步empty/row/container事实，PM坐标重新emission |
| `preparePreservingSourceCandidate(verified,edits,work,tr.doc)` | 新exact/fragment精确protected集合 | 所有新empty/materialization均用它；旧结构不改权限 |
| `source-structure.ts` ledger | blank/fallback origins、slot claim、separator/terminal | 受限空段入口只准blank/fallback origins；不授权natural root重渲染 |
| `source-fidelity.ts` stable分派 | changedNaturalRoots拒绝synthetic | 完整原Step审计后、该检查前分派已证empty；失败不落入root fallback |
| `serializeSourceRootMarkdown` | 既有结构commands的source-only renderer | Task2仅对empty-container布局输出补闭包；输入首字不调用它 |
| `traceTableRow/traceConsumedLines` | 实际rule消费投影，非第二grammar | 空字段边界在trim/slice丢失前保留；普通trace返回行为兼容 |

修改既有 CORE：`src/markdown.ts`、`src/source-content-trace.ts`、`src/source-fidelity.ts`、`src/source-structure.ts`；新增 `src/source-empty-body.ts`。不改公共schema、SourceLayout类型、公开SourceSession或package exports。

新增CORE测试：`src/__tests__/source-empty-test-utils.ts`、`source-empty-body.spec.ts`、`source-empty-cache.spec.ts`、`source-empty-enter.spec.ts`（均在同目录）。新增HOST测试：`src/lib/share-merge/source-empty-producer.test.ts`。两仓CHANGELOG；Task2最后提交已验证CORE dist。临时控制工具/strict测试tsconfig/证据仅本批OWN。

旧断言迁移allowlist：

1. CORE `source-body-producer.spec.ts` 具名 `empty cell insert fails without table formatting %j` 的**两条**输入改成功，分开独立expected及最窄edits；禁止删除整个suite或弱化unmapped负例。
2. CORE `source-layout.spec.ts` 具名 `keeps complete list map, actual handler coordinates and independent tail origins`，仅把 `insertText('X',8)` 拒绝段改为 `- A\n\nX\n\nB` 成功；同测试map/删除等原断言不动。
3. `source-structure-commands.spec.ts` 的 `quote-first list recreates its schema-filled paragraph around a closed literal`、`heading-first list recreates the same schema-filled paragraph without literal-specific rules` 和两项非default attrs/marks拒绝均**保留原断言**；只在新suite增加真正前置空P键入。
4. Task2如发现既有source-only测试明确断言容器中多条semantic blank被丢弃，由root按最终SHA记录具体具名测试和独立expected后才纳入；不授权按失败列表批量改旧测试。当前已核`source-layout.spec.ts` marker-only quote只断言顶层childCount，不需迁移。

### Task 1: 实际空正文捕获与普通首字 materialization

**Files:** 修改上述4个CORE文件，新增source-empty-body.ts及utils/body/cache tests；新增HOST suite的首字/NodeView consumer部分（待Task2安装）；两仓CHANGELOG。

**Consumes:** 同代capture binding、真实table/fence/front_matter/heading/list/blockquote/footnote规则、实际PM emission、verified base、preserving candidate。

**Produces:** 以下内部types/API，均不从包根export；本Task同时实现并消费它们。

```ts
// src/source-empty-body.ts；所有raw range仅引用session.source，不存raw副本。
import type {Node as PmNode} from 'prosemirror-model';
import type {Transaction} from 'prosemirror-state';
import type {SourceSession} from './source-fidelity';
import type {SourceEdit} from './source-ownership';
export type RawRange=Readonly<{from:number;to:number}>;
export type SourcePrefix=readonly (RawRange|Readonly<{spaces:number}>)[];
export type EmptyPlace=
 | Readonly<{kind:'inline';range:RawRange;before:string;after:string}>
 | Readonly<{kind:'missing-cell';at:number;row:number;slot:number;present:number;closingPipe:boolean}>
 | Readonly<{kind:'literal';at:number;terminal?:RawRange;eol:RawRange;prefix:SourcePrefix;closed:true}>
 | Readonly<{kind:'prepend';at:number;eol:RawRange|undefined;continuation:SourcePrefix}>
 | Readonly<{kind:'layout';origin:{kind:'blank';id:number}|{kind:'fallback'}}>
 | Readonly<{kind:'nested-blank';range:RawRange;eol?:RawRange;prefix:SourcePrefix;
     leftBody:boolean;rightBody:boolean}>;
export type EmptyBody=Readonly<{
 pmAt:number; parent:PmNode; rootId?:number; place:EmptyPlace;
}>;
export type EmptyRecipe=Readonly<{edits:readonly SourceEdit[];changedRoots:readonly number[]}>;
export type EmptyAttempt =
 | Readonly<{kind:'not-empty'}>
 | Readonly<{kind:'unsupported';reason:string}>
 | Readonly<{kind:'ready';recipe:EmptyRecipe}>;
export function prepareEmptyBodyTransaction(base:SourceSession,tr:Transaction,
 facts:readonly EmptyBody[]):EmptyAttempt;
// markdown.ts：与capturedInlineBodies相同同代校验，失配返回undefined。
export function capturedEmptyBodies(source:string,doc:PmNode,
 roots:SourceSession['roots'],layout:SourceSession['layout']):readonly EmptyBody[]|undefined;
// source-structure.ts：仅prepareEmptyBodyTransaction调用，实施受限layout ledger。
export function prepareEmptyParagraphEdits(base:SourceSession,tr:Transaction,
 origin:{kind:'blank';id:number}|{kind:'fallback'},body:string):readonly SourceEdit[];
```

`before/after`只能是该规则必需的已定义语法常量（例如缺失的space），不能成为缓存raw字符串；prefix中的spaces是实际indent数导出的生成权限。literal.eol引用opening行实际EOL；source空fallback无EOL时固定LF。Task2填nested-blank分支，不在Task1提前发假fact。

- [ ] **1.1 写独立RED数据与真实PM helper。** 新utils如下；expected不得调用生产serializer计算。

```ts
import {expect} from 'vitest';
import {EditorState,TextSelection} from 'prosemirror-state';
import type {Node as PmNode} from 'prosemirror-model';
import {ReplaceStep} from 'prosemirror-transform';
import {createSourceSession,applySourceBlockTransaction} from '../source-fidelity';
export function open(raw:string){const r=createSourceSession(raw);if(!r.ok)throw Error(r.reason);return r.session}
export function at(doc:PmNode,path:readonly number[]){
 let n=doc,pos=0;
 for(let d=0;d<path.length;d++){
  for(let i=0;i<path[d]!;i++)pos+=n.child(i).nodeSize;
  n=n.child(path[d]!);pos++;
 }
 return pos;
}
export function typeEmpty(raw:string,path:readonly number[],text:string,expected:string){
 const b=open(raw),p=at(b.doc,path),s=EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,p)});
 expect(s.selection.$from.parent.content.size).toBe(0);
 const tr=s.tr.insertText(text),snapshot=JSON.stringify(b);
 expect(tr.steps).toHaveLength(1);expect(Object.getPrototypeOf(tr.steps[0])).toBe(ReplaceStep.prototype);
 expect((tr.steps[0] as ReplaceStep).from).toBe(p);expect((tr.steps[0] as ReplaceStep).to).toBe(p);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(r.session.source).toBe(expected);
 expect(JSON.stringify(b)).toBe(snapshot);expect(r.edits.length).toBeGreaterThan(0);
 return {b,r,tr};
}
```

新source-empty-body.spec.ts中的表和code均为本Task必做；normal首字数据用X或乙避开格式命令。

```ts
import {it,expect} from 'vitest';
import {typeEmpty} from './source-empty-test-utils';
const cases=[
 ['', [0], 'X'], ['\uFEFF',[0],'\uFEFFX'],
 ['A\n\n\nB',[1],'A\n\nX\n\nB'],
 ['- A\n\n\nB',[1],'- A\n\nX\n\nB'],
 ['\uFEFF\r\n\r\n',[0],'\uFEFFX\r\n\r\n\r\n'],
 ['[ref]: /u\n\n',[0],'X\n\n[ref]: /u\n\n'],
 ['#',[0],'# X'], ['##  \r\n',[0],'##  X\r\n'],
 ['#   ###\n',[0],'# X  ###\n'],
 ['- \n',[0,0,0],'- X\n'], ['7)\r\n',[0,0,0],'7) X\r\n'],
 ['>\n',[0,0],'>X\n'], ['>   \n',[0,0],'> X\n'],
 ['> - \r\n',[0,0,0,0],'> - X\r\n'],
 ['- [ ] \n',[0,0,0],'- [ ] X\n'],
 ['- # H\n',[0,0,0],'- X\n  # H\n'],
 ['- > A\n',[0,0,0],'- X\n  > A\n'],
 ['- ```js\n  A\n  ```\n',[0,0,0],'- X\n  ```js\n  A\n  ```\n'],
 ['```js\n```\n',[0],'```js\nX\n```\n'],
 ['```js\n\n```\n',[0],'```js\nX\n```\n'],
 ['> ```js\r\n> ```\r\n',[0,0],'> ```js\r\n> X\r\n> ```\r\n'],
 ['- ```js\n  ```\n',[0,0,1],'- ```js\n  X\n  ```\n'],
 ['---\n---\n',[0],'---\nX\n---\n'],
 ['---\r\n\r\n---\r\n',[0],'---\r\nX\r\n---\r\n'],
 ['[^e]:\n',[0,0],'[^e]:X\n'],
] as const;
it.each(cases)('first real body text %j',(raw,path,expected)=>typeEmpty(raw,path,'X',expected));
it.each([
 ['| H | J |\n| --- | --- |\n| 甲 |   |\n','| H | J |\n| --- | --- |\n| 甲 |乙   |\n'],
 ['| H | J |\n| --- | --- |\n| 甲 |\n','| H | J |\n| --- | --- |\n| 甲 |乙|\n'],
] as const)('real vs filled empty cell %j',(raw,expected)=>typeEmpty(raw,[0,1,1,0],'乙',expected));
it('three columns: materializes only required missing slots',()=>{
 typeEmpty('| H | J | K |\n| --- | --- | --- |\n| 甲 |\n',[0,1,2,0],'乙',
 '| H | J | K |\n| --- | --- | --- |\n| 甲 ||乙|\n');
});
```

额外明确数据：header空cell `| | J |\n| --- | --- |\n` 的 `[0,0,0,0]` 键X得 `|X | J |\n| --- | --- |\n`；duplicate rows只改第二行；quoted table CRLF只改目标slot；`> >\n` 的 `[0,0,0]` 键X得 `> >X\n`。task checkbox attrs仍false，ordered list order仍7，不接受只比textContent。

- [ ] **1.2 记录RED。** 运行 `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-empty-body.spec.ts`；应定位当前 unmapped/owner缺口或空footnote捕获失败。若某条已GREEN记为既有回归，不人为造RED。PM路径错误先修测试，不改expected迎合错误节点。

- [ ] **1.3 捕获table/ATX/task实际空inline入口。** 在source-content-trace.ts给traceTableRow增加可选内部collector回调 `onEmpty({slot,from,to,missing,present,closingPipe,rowEnd})`，由本Task实现；既有return不变。回调坐标为规范化trace索引，所有actual内容校验完成后一次签发。

回调不是新table判定：当前split投影在trim前保存字段起止；真实空slot的左边界发insertion；missing slot发actual row尾birth。outer假slot、ignored extra列不签发。table wrapper仍在实际容器bMarks/tShift/eMarks活跃时调用；raw mapping只用copy边界或唯一完整atomic端点，不接受generated/partial-tab内部。

ATX使用现有heading wrapper实际skipSpacesBack/skipCharsBack的bodyFrom、tail界；`#`缺分隔空格只生成一space；`##  `保留现有body前spaces。closing hash存在时在第一项body separator后插入，保证hash前原space仍在，例如独立expected `# X  ###\n`；不得把closing hash当正文或重建整heading。

空task来自实际list_item getAttrs对 `[ ]`/`[x]` 的消费。截空trace前保存被消费前缀的raw末端与实际paragraph trim右界，existing suffix whitespace存在就用它作separator，否则生成一space。保留checked及markup，不把schema-filled普通item推成task。

- [ ] **1.4 捕获empty list/quote/schema前置P/footnote。** 只增加env-local状态观察；不修改全局String或复制list/quote grammar。

在实际list/blockquote规则wrapper内临时包 `state.push`（finally恢复）；list_item_open时保存当前state.line的bMarks/tShift/eMarks，规则完成后验证该token.map[0]等于所存line，并用**实际token.info/markup**验证marker消费前缀。规则内层wrapper以active frame栈区分occurrence，不能把nested item重复归给outer。quote_open在原规则已剥quote前缀后push，保存当次活动bMarks/tShift；成功后matching close与map验证。

实际空item的可写bodypadding是已消费marker之后的空白；保持必要第一separator，过多空白可由被选空body权限消费，防止首字落到4列缩进code中。`-`缺space补一space；`>`允许无space，直接`>X`；`>   `保留首个已消费space并消费后续空bodypadding成为`> X`。该padding属于所选空body，不扩其它raw权限。

PM close handler封装：delegate前记录parent frame与append slot，delegate后取实际appended list_item/blockquote/footnote_definition；只匹配其实际补出的default empty paragraph occurrence。已有子token发过paragraph的不得双发；非default attrs/marks不符合原node默认markup则无权限。finalizer用出现位置校正，复用现有list emission模式。

若list_item第一个真实child是heading/quote/code/list，createAndFill会前置空P：其sourceAt是actual第一个child规则入口的内容起点。observer在nested rule进入时记录当前活动row/body起点、blkIndent及quote prefix，绑定first actual child token；插入`X+EOL+continuationPrefix`，不触动child raw。continuationPrefix逐层由已消费quote前缀raw片段与实际list indentation整数构成；不重复list bullet，也不从PM深度猜两个空格。

empty footnote使用既有actual footnote_def wrapper，捕获其成功startLine/state.line并在source-capture token上补真实map；`fixFootnoteDefMaps`对没有子map的token保留该map，仅有子map时沿现有规则收窄。其body起点来自原规则进入子tokenize时活动bMarks/tShift（见下一段observer）；`[^e]:`既有grammar允许colon后无space，直接X。不新增插入footnote UI。

原footnote用`new Token`/tokens.push，不能假设都经过state.push。在capture专用block State实例上使用**实例局部 md/block facade**观察原 `block.tokenize`，delegate仍是同一个installed tokenizer，`this`为原block；记录当前active container frame和入参/活动行表后调用原方法，finally恢复state.md。不调用第二次tokenize、不替换全局md；list空item跳过tokenize的special branch仍由上述list_item_open+实际marker验证覆盖。

- [ ] **1.5 捕获closed empty literals及line prefix。** fence wrapper现有实际getLines调用给出begin/end/indent/keepLastLF，已证closed位仍必须true。front_matter在其成功规则已有contentStart/contentEnd；两者同处记录空body insertion与opening EOL，不从文本另找closing。

actual token.content===''表示零physical body line；token.content==='\n'且PMbody空表示已有一个空body行，其LF是PM handler剥去的terminal。前者在closing物理行前插入新body行，后者复用该行及terminal。其它token.content/PM不一致不签权。

`SourcePrefix`由当次container continuation事实+实际getLines.indent产生：quote部分复制真实消费前缀；list/footnote部分使用当次已证indent列宽；fence自身相对indent按实际read.indent补足。需验证新line解缩进后恰为插入text；不得把closing marker前最多3个可选空格照抄成body额外内容。TAB溢出的generated部分不能当raw provenance；可生成已证所需数量spaces，原closing prefix完全保留。top-level无indent即空prefix。

literal payload用目标text逐行生成prefix和原opening EOL；body terminal始终只供noCloseToken handler剥一次，空原body没有terminal时才新增。原info/开闭marker/indent/EOL及远处raw不改。CSV实际发spreadsheet而非code_block、unclosed、math、html promotion均不假发literal fact。

- [ ] **1.6 原Step完整审计后直接消费。** `prepareEmptyBodyTransaction`只接受本Task一条真实ReplaceStep、structure=false、closed slice、from===to===fact.pmAt、before parent空、slice全text且无marks；paragraph/heading/code_block/frontmatter原type和全部attrs/marks不变。text可多字；literal允许真实NodeView多行newRaw，普通inline无hardbreak/newline本Task不接。

先核tr.before==base.doc、tr.docs[0]、actual step.apply==tr.doc、doc.check、其余doc结构严格不变；生成edits之前审原range与owner/protected。自然root仍须closed-fences guard；sourceAt不在protected内部。synthetic只能以认证layout origin代替natural owner，不能放宽changedNaturalRoots给任意无主PM节点。

```ts
// 以下为本Task实现的recipe决策，不调用parser/根renderer。
switch (fact.place.kind) {
 case 'inline': // edit(place.range, place.before + escapedText + place.after)
  break;
 case 'missing-cell': // j=slot-present; closingPipe ? '|'.repeat(j)+escapedText+'|' : '|'.repeat(j+1)+escapedText
  break;
 case 'prepend': // insert(at, escapedText + eol + renderPrefix(continuation))
  break;
 case 'literal': // 已有terminal：插入目标body；无terminal：生成prefix+body+eol后保留原closing整行
  break;
 case 'layout': // prepareEmptyParagraphEdits(base,tr,origin,escapedText)
  break;
}
```

本Task实现内部 `renderPrefix(source,prefix):string`（按序raw切片或repeat spaces）及 `escapeEmptyText(node):string`（复用serializeSourceInlineBody，只序列化**新插入**的空parent后内容，不序列化旧正文；开头敏感字符/边界空格依既有writeSourceText生成entity/escape）。原range→edit形成后统一核edits排序、不相交、closed/protected及preserving candidate；唯一parse用于验证候选，失败不试另一种encoding。

EmptyAttempt 的 not-empty 仅代表原事务不以一个原本空的 textblock 为正文输入目标；仅此结果可回旧分派。原目标为空但无认证 fact、事实歧义或 recipe 不可表达都返回 unsupported，不能借 root-render 获权。ready 才携 recipe 进入 preserving candidate。目标判定基于完整原 Step 及其原 doc 的真实 parent；不从最终文本或缺少 facts 反推非空。新marks/leaf本Task拒绝，后继通过相同EmptyBody authority增加内容生成，不修改原权限定义。

- [ ] **1.7 受限复用top-level layout ledger。** prepareEmptyParagraphEdits复用createLedger/advanceLedger/finishLedger和partitionSlots；验证唯一变动component仅一个blank或fallback origin、无birth/其它origin，真实witness仍原ReplaceStep。只渲染新插入的inline body，不调用natural root serializer。

selected blank unit的padding可消费，原EOL作为body terminal保留；现有相邻separator/其它empty unit/protected/envelope全raw保留。必要新separator由现有slot相邻entity规则导出，EOL取selected unit或就近已证EOL（fallback无任何EOL取LF）。只为该新body补terminal/separator，不删除已有unit来凑数。

fallback是rawless baseline，输入后仍保留原所有blank units；definitions-only原protected slot前需新增正文terminal+separator。不得仅把stable改判structural后放任旧makeRecipe归一selected单位EOL；本helper给窄策略执行同一claims/kept verifier。原applyStructuralTransaction权限与默认策略不变。

- [ ] **1.8 缓存与权限RED/回归。** empty/row/container事实在cloneTokenBatch按rawDelta/lineDelta平移，pmAt/parent仅在finaldoc emission建；capturedEmptyBodies绑定source/doc/roots/layout严格identity。foreign public metadata不获权，prepareVerifiedFileBase真实recapture后再消费；不得把本代fact挂到另一doc。

source-empty-cache.spec.ts精确加入：前方`A\r\n\r\n`改为`Longer\r\n\r\n`后编辑后方空cell/空fence；duplicate空list items只改第二个；重放后同一emptyfact不能消费两次；JSON clone篡改layout sourceFrom后仍须recapture或拒绝，紧接合法请求成功；nested definition在同quote的另一个body完全不变，protected集合按总edits平移。

伪造ReplaceStep子类、扩大from/to触碰邻文本、parent attrs变化、slice带mark、假actual slot、ignored列、TAB generated点、unclosed fence、whole-root fallback spy均为明确拒绝；已存在权限不变量首次GREEN如实记，不强造RED。

- [ ] **1.9 Task1 GREEN/type/source提交。** root本批recorded runner记录：

```sh
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-empty-body.spec.ts src/__tests__/source-empty-cache.spec.ts src/__tests__/source-body-producer.spec.ts src/__tests__/source-layout.spec.ts src/__tests__/source-structure.spec.ts src/__tests__/source-structure-commands.spec.ts
env pnpm_config_verify_deps_before_run=false pnpm run typecheck
# root先在本OWN生成严格测试tsconfig（含所有新增CORE测试、extends CORE tsconfig）：
env pnpm_config_verify_deps_before_run=false pnpm exec tsc --noEmit -p /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-shared-editor-empty-body/empty-body-tsconfig-tests.json
```

新测试tsc命令也必须带同一env前缀。通过后只stage本Task allowlist源/tests/CHANGELOG并精确commit，记录SHA；dist仍旧，不安装、不声称host通过。保持Task2可独立审查：Task1首字能力可单独验收，但尚不能宣称Enter全闭包。

### Task 2: 实际nested blank、Enter闭包与installed验收

**Files:** Task1既有产品文件继续修改；新增source-empty-enter.spec.ts；扩source-empty-cache.spec.ts与HOST source-empty-producer.test.ts；两仓CHANGELOG；最终CORE committed dist。

**Consumes:** Task1所有EmptyBody/recipe、实际container入参/line表observer、source-only结构renderer和preserving candidate。

**Produces:** 私有nested blank事实、同一source capture可重建的空P输出、真实Enter→首字连贯session；无公开SourceLayout新增字段。

- [ ] **2.1 写真实Enter链RED。** 新suite用实际commands，不手工造看似相似的node；以下helper在该suite定义。

```ts
import {it,expect} from 'vitest';
import {EditorState,TextSelection,type Command} from 'prosemirror-state';
import {splitBlock,wrapIn,setBlockType} from 'prosemirror-commands';
import {splitListItem,wrapInList} from 'prosemirror-schema-list';
import {applySourceBlockTransaction} from '../source-fidelity';
import {open,at} from './source-empty-test-utils';
function chain(raw:string,path:readonly number[],offset:number,command:(s:EditorState)=>Command,
 intermediate:string,expected:string){
 let b=open(raw),p=at(b.doc,path)+offset;
 let s=EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,p)}),seen=0;
 expect(command(s)(s,tr=>{
  seen++;const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
  expect(r.session.doc.eq(tr.doc)).toBe(true);expect(r.session.source).toBe(intermediate);
  b=r.session;s=s.apply(tr);
 })).toBe(true);expect(seen).toBe(1);
 expect(s.selection.$from.parent.content.size).toBe(0);
 const tr=s.tr.insertText('X'),r=applySourceBlockTransaction(b,tr);
 expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(r.session.source).toBe(expected);
}
it('Enter then type at top end',()=>chain('A',[0],1,()=>splitBlock,'A\n\n','A\n\nX\n'));
it('Enter then type inside quote',()=>chain('> A',[0,0],1,()=>splitBlock,'> A\n>','> A\n>\n>X'));
it('split list item then type',()=>chain('- A',[0,0,0],1,s=>splitListItem(s.schema.nodes.list_item!),'- A\n- ','- A\n- X'));
it('empty document wrap quote then type',()=>chain('',[0],0,s=>wrapIn(s.schema.nodes.blockquote!),'> ','> X'));
it('empty document wrap list then type',()=>chain('',[0],0,s=>wrapInList(s.schema.nodes.bullet_list!),'- ','- X'));
it('empty document set code then type',()=>chain('',[0],0,s=>setBlockType(s.schema.nodes.code_block!,{language:''}),'```\n\n```','```\nX\n```'));
```

具体intermediate输出是本Task要冻结的source-only合同；不得以legacy serializer输出作为expected。若当前结构renderer已符合其中一例，记首次GREEN。最后一例必须actual closed capture，不能把空unclosed source当等价输入。

还需真实nested两个Enter：`> A`→`> A\n>`→首字X（上例）；再在X末尾splitBlock，保存后键Y，最终可见A/X/Y三个paragraph。第二次Enter沿既有结构权限可以重渲染该quote，冻结intermediate为`> A\n>\n> X\n>`；随后键Y得到`> A\n>\n> X\n>\n>Y`。该次普通输入只消费最后空body与必要separator，保留第二次Enter成功session中的A/X raw；不冒称结构Enter本身已有精确正文raw能力。list split后再次空item Enter将退出列表，沿实际command现有结构能力验其后顶层空段可键入。

- [ ] **2.2 跑RED。** `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-empty-enter.spec.ts`。真正缺口应是nested空P在candidate parse丢失或随后unmapped；不放松doc.eq，不把失败事务跳过只测旁边顶层键入。

- [ ] **2.3 捕获actual nested blank。** 在Task1的实例局部tokenize observer中包当前state.skipEmptyLines和isEmpty，记录原函数真实返回及调用区间；调用只观察、不改变返回。记录当前active container、token插入边界、活动b/e/t/sCount/bsCount、原lineMax；原tokenizer末尾通过isEmpty消耗的一行也须记录。只有实际推进state.line/最终container map包含的行才落事实，silent规则探测不签发。

候选行必须属于当次actual quote已消费的`>`前缀行，或list/footnote当前indent足够的continuation行；非prefixed外部空白仍归顶层layout，不重复拥有。参考定义范围、generated分隔、fence内部blank由各自规则消费，不能再算container empty。完整copy/atomic EOL可映射；TAB-generated正文不冒充raw。

以实际direct child token区间为界分类，复用collectBlankDrafts的有限约定：两个可见block之间第一条owned blank是separator，其余才emptyP；leading/trailing owned blank各为emptyP；只有空容器时第一条代表schema baseline，额外行代表额外emptyP。list schema强制前置emptyP若已有Task1 fact不重复造一份。paragraph内容末尾LF不是blank unit。

该约定只用于source capture。在emitCapturedTokens中、prepareRootEvents前，按实际token nesting与记录insertBefore加入所需nested paragraph_open/inline/close tokens；保持真实container token与map，不写默认md parse。插入token带private synthetic fact，actual h['inline']/closeNode记录真实emission，finalizer生成kind:nested-blank EmptyBody。不要把旧PM位置直接塞给新tokens。

private nested事实只含raw区间、prefix/EOL、左右visible body存在性；它不进入public layout.blankLines（该列表现有emission是top-level child区间），避免破坏结构ledger假设。cache blockTokens保留实际grammar token+private pending blank事实，clone平移；每次source emission重新注入一次，禁止把已注入token再注入。

- [ ] **2.4 为既有结构renderer补唯一empty输出合同。** 仅sourceRootSerializer/serializeSourceRootMarkdown的container callbacks改变；legacy serializer保持默认。结构commands继续用原授权root recipe及guard，不把ordinary空输入交回root renderer。

新增内部 `renderSourceContainerChildren(state,parent,skipSchemaPrefix:boolean):void`，由Task2实现：遍历direct children，将default empty paragraph分为schema必需首P与真实semantic emptyP。原list_item在非paragraph首child前可省略schema首P的分支保留；其它emptyP逐个发一条owned continuation blank行。相邻两个非empty block之间只由现有closeBlock产生一条separator；emptyP前后需要的separator在函数内按同一分类计算，不能由flushClose再重复加一行。

实现使用现有MarkdownSerializerState的out/closed/delim窄访问（项目renderTableRow已有模式）：写owned blank前flush可见body的terminal一次，将closed清空；写入当前container delimiter的trimEnd形式并保留其physical行边界；EOF最后一条owned blank可以无EOL，capture必须按actual consumed最后行支持。空quote baseline发`> `，其后每个额外空P发`\n>`；可见A后一个emptyP发`> A\n>`。非空后续child需separator时在其前生成一条ownedblank，除此不额外flush。

list continuation空行不能trim到空字符串，否则丢container归属：保留该层实际serializer indent列数spaces；quote marker只trim可选右空白。footnote continuation同理。每条输出的prefix由当前state.delim确定，不自行根据PM深度重算；有list style仍使用原transactionListStyles绑定。没有empty child的输出必须逐字节保持原source renderer结果。

nested空P最终EOL-less行不能依赖原top-level lineStarts只收完整行的逻辑；actual container.map+其endLine拥有最后行是事实，记录eol不存在的terminal blank variant，首次materialization按邻近已证EOL或LF补所需separator。EmptyPlace.nested-blank.eol已为可选；不存在时仅允许该实际EOF事实，不能用undefined掩盖缺失的中间行EOL。

- [ ] **2.5 真实空nested consumer。** 在Task1 recipe增加nested-blank分支：用已选blank行的raw prefix保持container，原selected bodypadding可消费；新text不带marks时用同escapeEmptyText。左右存在body时分别判断是否已有separator；不足的separator仅在selected unit授权seam生成prefix+EOL，不借用其它emptyP的raw行。

例 `> A\n>` 的emptyP键X：原最后`>`仍是新body prefix，在它前新增`>\n` separator，得到`> A\n>\n>X`；没有整quote重渲染。两边都可见时原between规则已经留一个separator，selected excess blank变正文后只补新另一侧需要的一条。quote/list/footnote嵌套按捕获prefix数组输出，不能在整行字符串前一律拼`> `。

literal空体键入与Enter newlineInCode仍用Task1literal body recipe；新增body无内容但实际target为`\n`时必须产两个body LF（一个内容、一个noClose terminal），并保持closing；不得把Enter当无变化。多次事务每次用上一成功session重捕获，本Task不合成隐藏history。

- [ ] **2.6 真实HOST消费者验收。** HOST suite通过installed `@moraya/core` 的createEditor/createSourceSession/applySourceBlockTransaction建真实view；重置为capture doc的EditorState时保留createEditor实际plugins。dispatch成功才安装state/session，失败测试不能先updateState冒充成功。

HOST suite定义完整挂载helper（imports按该测试相对路径），保留真正的keymap/InputRules/plugin链：

```ts
// @vitest-environment happy-dom
import {it,expect} from 'vitest';
import {EditorState,TextSelection} from 'prosemirror-state';
import type {EditorView} from 'prosemirror-view';
import {createEditor,createSourceSession,applySourceBlockTransaction} from '@moraya/core';
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver';
import {executeEditorCommand} from '../../editor-kit-v2/commands';
async function mounted(raw:string,path:readonly number[],offset:number,
 run:(view:EditorView,source:()=>string)=>void){
 const container=document.createElement('div');document.body.append(container);
 const editor=await createEditor({container,initialContent:raw.startsWith('\uFEFF')?raw.slice(1):raw,
  mediaResolver:new BrowserMediaResolver()});
 try{
  const opened=createSourceSession(raw,editor.view.state.schema);if(!opened.ok)throw Error(opened.reason);
  let base=opened.session,n=base.doc,pos=0;
  for(const index of path){for(let i=0;i<index;i++)pos+=n.child(i).nodeSize;n=n.child(index);pos++;}
  editor.view.updateState(EditorState.create({doc:base.doc,plugins:editor.view.state.plugins,
   selection:TextSelection.create(base.doc,pos+offset)}));
  editor.view.setProps({dispatchTransaction(tr){
   const r=applySourceBlockTransaction(base,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
   expect(r.session.doc.eq(tr.doc)).toBe(true);base=r.session;
   editor.view.updateState(editor.view.state.apply(tr));
  }});
  run(editor.view,()=>base.source);
 }finally{editor.destroy();container.remove()}
}
it('installed empty quote toolbar then first text',async()=>{
 await mounted('',[0],0,(view,source)=>{
  expect(executeEditorCommand(view,{kind:'blockquote'})).toBe(true);expect(source()).toBe('> ');
  view.dispatch(view.state.tr.insertText('X'));expect(source()).toBe('> X');
 });
});
```

核心实际Enter调用片段放入该helper的run回调（以source()逐次核上述独立expected）：

```ts
const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true});
let handled=false;
view.someProp('handleKeyDown',fn=>{if(fn(view,event)){handled=true;return true}return false});
expect(handled).toBe(true);
// 然后真实普通输入事务；先断言selection parent为空，再键入。
view.dispatch(view.state.tr.insertText('X'));
```

同suite具体cases为上面top/quote/list/code链，另实际table last-row Enter退出→空paragraph键X、Mod-Enter add-row→新空cell键X。toolbar executeEditorCommand的blockquote/bullet-list/code-block从空文件创建后键X；既有默认行为测试仍在。

frontmatter使用真实createEditor的FrontmatterViewFactory.render收集onChange，初值`---\r\n---\r\n`，调用`onChange('title: X')`，expected `---\r\ntitle: X\r\n---\r\n`；断言真实单ReplaceStep from===to及属性不变。不要直接调用core helper冒充NodeView。批注和storedMarks仅在本稿记后继依赖，不在此用手工无mark替代真实marked动作宣称支持。

每个installed source结果交给现有propose实际API，用base=ours=原raw、theirs=新raw；一字且不需补syntax的empty cell必须单窄raw插入+一hunk；materialization可有必要delimiter/EOL成本，如实报告，不做diff过滤。

- [ ] **2.7 private/cache/legacy闭包。** 添加source-empty-cache的quote trailing blank、list-leading schemaP、emptyfootnote三种：前方raw长度/行数变化后消费正确；同source被重复parse的facts不互授；foreign伪造nested单位拒绝/recapture；nestedprotected范围及scope集合精确平移；ordinary拒绝后不污染下一次合法session。

默认`parseMarkdown`与`parseMarkdownAsync`对`> A\n>\n>`、`[^e]:\n`的原输出仍按冻结基线，不采用新的source-onlysynthetic semantics；旧fixture bytes/manifest保持。source capture可额外保存semantic blank，因此host测试必须以其doc作为file bindings目标，不强求legacy初始doc字面相等。

- [ ] **2.8 统一回归、types、build、committed安装、预算。** root先建立本批runner/工具参数/严格tsconfig/allowlist；复用已核工具行为但所有日志写本批OWN，不用旧阶段脚本默认路径。逐次保存argv/cwd/start/end/stdout/stderr/status与执行SHA。

```sh
# CORE：targeted→全套→类型；新增测试另由root严格tsconfig编译。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-empty-body.spec.ts src/__tests__/source-empty-enter.spec.ts src/__tests__/source-empty-cache.spec.ts src/__tests__/source-body-producer.spec.ts src/__tests__/source-layout.spec.ts src/__tests__/source-structure-commands.spec.ts
env pnpm_config_verify_deps_before_run=false pnpm test
env pnpm_config_verify_deps_before_run=false pnpm run typecheck
env pnpm_config_verify_deps_before_run=false pnpm exec tsc --noEmit -p /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-14-shared-editor-empty-body/empty-body-tsconfig-tests.json
env pnpm_config_verify_deps_before_run=false pnpm run build
# root artifacts核所有exports JS/DTS/maps embedded源码 → exact stage → core commit。
# root核committed dist后安装，package/lock bytes前后相同；记录实际installed指纹。
# HOST：
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/lib/share-merge/source-empty-producer.test.ts src/lib/share-merge/source-nested-producer.test.ts src/editor-kit-v2/source-structure-commands.test.ts
env pnpm_config_verify_deps_before_run=false pnpm test
env pnpm_config_verify_deps_before_run=false pnpm run check:share-merge
# root先受控空envDir host build，禁止读取.env；成功后：
env pnpm_config_verify_deps_before_run=false pnpm run check:editor-kit
# root最终指纹冻结时统一Svelte一次，writer不重复：
# env pnpm_config_verify_deps_before_run=false pnpm run check
```

必要gate顺序固定为core source/tests/type→core build/artifacts→精确committed dist→实际安装→installed tests→host build→check:editor-kit→最终root Svelte/指纹。gzip上限81920，不改入口范围/压缩参数掩盖增量；超限先停并给root证据，不能预涨。每次产物检查同时比package/lock完整bytes与14fixture SHA。

- [ ] **2.9 精确提交与交付。** Task2源/tests/CHANGELOG与已验证dist精确提交，HOST仅本批suite/未发布记录精确提交；记录双SHA、每套验证对应SHA及installed指纹。不得替当前nested Task3提交任何文件。所有新行为保留真实RED→GREEN，旧不变量首GREEN如实记。

完成矩阵必须逐项列空文件/blank、真实与补齐cell、ATX、task/list/quote/schema首P、closed empty code含nested、emptyfrontmatter、现有emptyfootnote、Enter新段链；有一项未实现则本空正文闭包未完成，不能把安全拒绝写成UI成功。marks/point后继明确复用capturedEmptyBodies；未闭fence与新math正文UI不在本稿权限内。

Ruling: Task1允许仅恢复fence wrapper的原installed alternates（preserveAlternates=true），新增实际parseMarkdown/parseMarkdownAsync与source capture的paragraph后fence、list前置P后fence回归 — c488d235新增capture wrapper意外清空markdown-it原paragraph/reference/blockquote/list alternates，导致本Task批准raw被误读inline code；这是未发布前置引入的grammar回归，不是有意扩legacy语法 — 成本为当前BASE上的legacy行为发生修正，必须明确例外并核定实际grammar/类型与相关回归，不批量调整其它规则、旧tests或strict doc.eq。
