# Remaining inline and annotation producers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 仅一位产品 writer；root负责计划自审与执行编排。

**Goal:** 现有格式工具栏、输入规则与批注泡泡的真实事务能通过窄raw producer保存；partial、多Step、跨段/跨cell选择不依赖全根重渲染。

**Architecture:** 复用已提交nested阶段的TextSourceSpan、正文authority及preserving candidate，以及已受理empty批的EmptyBody/EmptyAttempt，补实际inline delimiter/payload occurrence。按真实Step链把每个参与正文分解为保留raw和必要生成语法；所有正文共同原子提交。批注说明直接更新实际payload，不重渲染被批注文字。

**Tech Stack:** TypeScript、ProseMirror、markdown-it、Vitest；无新依赖。

**Spec:** HOST `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.4/I7、§12.9；已提交nested产品基线CORE `75abb5bd168fd33935a8cd692d1d63543fb1a7eb`、HOST `a373bd707ffba1df347827225966af80958a3fdd`；正式前置计划 `docs/superpowers/plans/2026-10-14-shared-editor-empty-body.md`；本批selected-input/remaining-edit-producers-design.md及remaining-inline-plan-notes.md（历史候选状态由本文受理状态取代）。

## Global Constraints

- CORE `/Users/bruce/git/moraya-core`、HOST `/Users/bruce/git/mdeditor`，两个现有main；不建worktree，不动stash/其他工作，不读.env；单一产品writer。
- 前置empty已整体受理：CORE9ccee70ff8338e22c8b8c9f02654cffa6491354d、HOST产品574fee6ce9d7e8302bc02e7b2f2062e18a5fe1a9，收尾docs4bfb6bcb077d2209de787a62e328448e0078d4da；正式报告docs/superpowers/reports/2026-10-14-shared-editor-empty-body-verification.md。whole-range C0/I0/M3，最终installed58dist闭包与root Svelte/前后指纹已受理；本批BASE另精确冻结。
- 包/lock完整bytes保持；main gzip≤102400（Task2实测100204后root有限修订为100 KiB；原98304超限证据保留，前置最终实测88537 bytes）；两仓原14fixture与manifest SHA不变。
- 不CST、不第二parser、不根/全文serialize后diff、不生产parse oracle、不枚举parse候选试探、不raw第二账本、不authority setter、不definition搬运。
- 原Step完整range、真实prototype、tr.docs链先审，不能先收缩范围再绕权限；祖先/兄弟/全部attrs/marks严格校验，最终doc.eq保持。
- root裁定：允许语义必需且局限于新delimiter边界的space/tab entity补偿；仅改变被此格式命令迫使调整的边界raw编码，不归一其它正文或mark。
- 跨paragraph、nested paragraph、多cell选择按多个既有body authority分解；某个body不支持则整事务拒绝。不得宣称完整工具栏却默默只做单段。
- 新producer走内部preserving candidate的actual protected精确集合检查；既有结构权限不扩不降，两处原protected guard保持。
- 不新增公式body UI；既有math插入/InputRules保回归，既有公式raw不变。本批不声称数学正文编辑能力。
- 本计划正式执行后每Task必须各有RED/GREEN与审查；当前本文不宣称新能力已实现。Task1源码/类型提交后dist仍旧不可安装，Task2统一构建、committed安装与HOST验收。

## 已受理接缝与文件责任

前置最终nested-blank在range/eol?/prefix/leftBody/rightBody外另有leftSeparator:boolean：definition真实边界与首条reserved separator参与分类，仅leftBody&&!rightBody&&!leftSeparator时前补，rightBody时后补。后继复用placement，不扫描raw重推定义。最终88537 gzip，门槛98304。前置377 CORE/100 HOST是最终covering，1107/4324全量属较早HEAD；不混算。


root已按已受理CORE9ccee70复核原Step分派、实际fence getLines/closed事实、source-only delimiter函数与cloneTokenBatch接缝；8d7ac8基础接口映射见selected-input/inline-interface-alignment-report.md，其后fix1唯一相关增量为上述leftSeparator。前置最终installed与216/986 tracked前后指纹已受理；HOST现有legacy exact消费者仍不是完整file编辑器。不得另建并行authority。

CORE修改 `src/markdown.ts`（capture/clone/emission）、`src/source-fidelity.ts`（原范围授权后的新producer分派）、前置新增的 `src/source-empty-body.ts`（复用placement，只扩已认证空inline内容consumer）、`src/source-structure.ts`（仅prepareEmptyParagraphEdits窄链ledger扩展，见root裁定）；新增 `src/source-inline-recipe.ts`（有限inline recipe，含批注payload witness）。复用现有source trace与nested正文表，不修改schema、UI或公开Session字段；source-file-cache的已验preserving入口无需新增权限选项。

CORE新测试allowlist：`src/__tests__/source-inline-test-utils.ts`、`src/__tests__/source-inline-recipe.spec.ts`、`src/__tests__/source-inline-input.spec.ts`、`src/__tests__/source-inline-cache.spec.ts`、`src/__tests__/source-annotation-producer.spec.ts`。HOST新测试：`src/lib/share-merge/source-inline-producer.test.ts`、`src/lib/note-anno/source-annotation-producer.test.ts`。

旧测试精确预期迁移：CORE `src/__tests__/source-reference.spec.ts` 两个具名 `rejects multi-root transaction atomically` 用例原动作是Tail与Alpha各加strong；新多body能力使该动作合法，改为成功、独立expected、两个窄片段并保留base不变断言。真正“支持+不支持混合事务原子失败”加入新inline测试。另恢复CORE `src/__tests__/source-structure-commands.spec.ts` 具名 `literal body replacement cannot lengthen the original fence through root rendering` 为成功：已提交nested基线对该真实操作strict拒绝，正式empty批明确不恢复围栏增长；本Task以独立fence envelope恢复并加完整expected。不得改同文件其他测试。其余旧断言不得静默删除；source-empty-cache精确允许下列两个marked分支迁移，混合测试其它负例保留。

source-empty-cache旧marked精确迁移：`rejects marks, fake Step prototypes, wider ranges and missing authority without root rendering`仅marked分支改成功，独立expected为`| H | J |\n| --- | --- |\n| A |**X** |\n`，fake/widened/缺fact/伪facts继续拒绝且serializer零调用；`pending nested facts replay once and never transfer across equal parses`仅末尾首步空text+AddMark链改成功，expected为`> A\n>\n>\n>**X**`，跨parse/copy layout/replay权限断言全保留。root已按9ccee70的实际测试核名，source-empty-cache列入Task1精确修改allowlist；不得整例删掉。

仅修改四既有产品文件 `src/markdown.ts`、`src/source-fidelity.ts`、`src/source-empty-body.ts`、`src/source-structure.ts`，新增一产品文件 `src/source-inline-recipe.ts`；source-structure只按root已裁定范围扩prepareEmptyParagraphEdits首步空Replace+新内容mark链，保持签名/ledger/claims；不重复修改source-content-trace或empty捕获框架，不扩其它产品模块。两仓CHANGELOG加未发布条目，最后提交已验证core dist；控制脚本、临时tsconfig和证据只在root指定本批OWN，不混产品commit。

### Task 1: 实际 inline code、partial/multi-Step mark、跨body与closed-fence envelope

**Files:** CORE上述四既有文件（source-structure仅具名helper）+新source-inline-recipe.ts；新utils/recipe/input/cache测试；HOST新source-inline-producer.test.ts；精确迁移旧reference两例、closed-fence具名一例及source-empty-cache两个marked分支；两仓CHANGELOG。

**Consumes（执行前须已受理）:** empty Task1普通首字与Task2 nested-blank/Enter闭包；`capturedEmptyBodies(source,doc,roots,layout)` 的认证facts、`prepareEmptyBodyTransaction`三态、既有EmptyPlace placement/受限layout ledger；已提交nested正文表、TextSourceSpan、闭合fence事实与preserving candidate。

**Produces:** partial/multi-Step/跨body mark、真实InputRule/code-body、空inline storedMarks首字与link插入，以及closed-fence碰撞窄recipe；所有新能力都有本Task独立CORE RED→GREEN，不依赖Task2 Critic通过才验收。

**Interfaces:** 以下类型/函数由本Task实现，均为内部模块合同，不导出包根。

```ts
// source-inline-recipe.ts
import type {Node as PmNode, Mark} from 'prosemirror-model';
import type {Transaction} from 'prosemirror-state';
import type {SourceSession} from './source-fidelity';
import type {SourceEdit} from './source-ownership';
import type {EmptyBody} from './source-empty-body';
export type InlineRawRange=Readonly<{from:number;to:number}>;
export type InlineEdge=Readonly<{
  id:number; body:number; family:string; pmFrom:number;pmTo:number;
  open:InlineRawRange;close:InlineRawRange;marks:readonly Mark[];
}>;
export type InlineOccurrence=Readonly<{
  body:number; pmFrom:number;pmTo:number;sourceFrom:number;sourceTo:number;
  kind:'paragraph'|'heading'|'table-cell';
}>;
export type InlineRecipeFacts=Readonly<{
  bodies:readonly InlineOccurrence[];edges:readonly InlineEdge[];
}>;
export type InlineRecipeResult=
  | {ok:true;edits:readonly SourceEdit[];changedBodies:readonly number[]}
  | {ok:false;reason:'unsupported-step'|'unmapped-range'};
export function prepareInlineRecipe(base:SourceSession,tr:Transaction,
  facts:InlineRecipeFacts):InlineRecipeResult;
// markdown.ts：只从已验证同代source/doc/roots/layout读取；不能caller设facts。
export function capturedInlineRecipeFacts(base:SourceSession):InlineRecipeFacts|undefined;
// 仅prepareEmptyBodyTransaction在认证fact和完整原Step审计后调用；不runtime import empty模块。
export type EmptyInlineContent =
 | Readonly<{kind:'ready';body:string}>
 | Readonly<{kind:'unsupported';reason:string}>;
export function prepareEmptyInlineContent(base:SourceSession,tr:Transaction,
 fact:EmptyBody):EmptyInlineContent;
// body数字是本代实际发射正文ordinal，不是持久ID或基于文本的授权。
```

`family`生成端只认本批em/strong/strike_through/highlight/code/link；capture还保留annotation/html_mark等已出现outer edge作为不变上下文。未知mark无生成权限。attrs读actual Mark对象并以eq严格比较，不复制丢属性的缩减版。

### 前置empty接缝与分派合同（两个Task共用）

已整体受理的前置API保持原签名：`prepareEmptyBodyTransaction(base,tr,facts):EmptyAttempt`，其中只有`not-empty`能回既有分派（完整链无适用空inline Replace；结构block slice另属原结构路径）；`unsupported`是终态；`ready`携`EmptyRecipe {edits,changedRoots}`进入同一preserving candidate。`capturedEmptyBodies(source,doc,roots,layout)`失配返回undefined；EmptyBody仍是`{pmAt,parent,rootId?,place}`，不能给caller增加sourceAt/authority setter。新empty内容支持写进该入口内部，不能在`unsupported`后另走inline/root producer翻案。

前置empty fix1（CORE `4c2aa6f2`）已证并封住“首步非空、后步空输入”root-render绕过：applicability逐步读取真实tr.docs[i]，不是只看tr.steps[0]。本Task仅对下面明确的“首步认证空inline插入→随后仅新内容mark链”增加窄positive；非空编辑后再空输入、先删空再输入、先结构建空段再输入三种旧guard继续原样拒绝，不通过宽松取消step数限制。各步实际docs、原Step与最终doc完整审计保持；如支持边界需变化，先按具体真实consumer给root裁定。

Task1只扩consumer：一条原始closed ReplaceStep从已认证空parent的pmAt插入允许的text/marks，随后可有只作用本次生成内容的真实Add/RemoveMark链（例如空cursor link）。每条step以tr.docs[i]/真实StepMap审计；所有其它节点/attrs/marks不变。复用本Task有限family输出刚生成的inline内容，`prepareEmptyInlineContent`不产生raw位置、不签发EmptyBody；source-empty-body继续用原EmptyPlace placement输出edits。普通无mark/literal仍用前置分支，code_block/frontmatter不因helper而接受inline marks/leaf。无doc Step的storedMarks事务沿unchanged返回，后续真实输入带marks才materialize。

`EmptyPlace`六分支以已提交精确字段为准：inline含range/before/after；missing-cell含at/row/slot/present/closingPipe；literal含at/terminal?/eol/prefix/closed:true；prepend含at/eol:RawRange|undefined/continuation；layout含blank(id)/fallback origin；nested-blank含range/eol?/prefix/leftBody/rightBody。SourcePrefix为raw range或{spaces:number}数组，不是字符串；不复制table/fence/container capture或新建空paragraph正文表。Task1 inline生成不消费literal；Task2仅为同helper增加note_anchor leaf，不增加placement种类。空body没有旧正文可保留，生成本次真实插入内容允许有限inline renderer；这不授权serialize既有body或whole-root后diff。新增body中的pipe/转义按已证cell上下文生成，不能先对整个字符串做通用replace破坏code/annotation内容。

empty分派仍在完整原Step/prototype/tr.docs审计后、`changedNaturalRoots`拒绝synthetic前；缺fact、错误parent、TAB-generated/ignored cell、unclosed literal等返回unsupported，不得误报not-empty。非空recipe继续原root审计；新old-empty选择不能跳过protected/owner检查。批注空体/marked空体只有前置实际验收后才可执行本计划；不得把“正式计划已冻结”等同已安装能力。

**root已裁定的后继T1窄扩展（当前empty Task2不改）：** 已提交`source-structure.ts:509 prepareEmptyParagraphEdits(base,tr,origin,body):readonly SourceEdit[]`只收单原生Replace，因此允许后继T1仅在这个函数接真实“首步认证空Replace + 仅本次新内容AddMark/RemoveMark”链。签名与single-origin/no-birth/one-run/claims算法保持；source-empty-body先完整校验窄链，直接调用helper也必须独立拒绝其它形状。每step对原tr.docs[i]与下一doc/tr.doc验证prototype、真实step.apply结果，再按原顺序advanceLedger，全部后finishLedger；不得只审最终doc、截短tr或造合成单Replace。后续marks范围必须完全位于首步新插入内容，不碰旧正文/兄弟；不扩一般Replace链或结构权限。仅新增这一具名source-structure allowlist，不重设计capture或另建authority。

§12.9的Kit同源承诺包括已有mark工具栏、跨段操作、code编辑及批注consumer；本批按上述真实事务交付，不能靠移除按钮/缩选区减少范围。code mark DOM正文可编辑、默认inline InputRules已存在；math已有插入/InputRules和渲染选区，但没有已证既有公式正文编辑UI。保留这些默认行为和相邻raw，新的inline code/math UI均不在本批添加。数学源事务未覆盖时明确记录为§12.9后续接入门槛，不能以默认回归冒充source保存支持。


- [ ] **1.1 写真实行为RED。** 新utils的完整公共helper如下；测试定位使用PM路径，禁止生产或测试用重复正文indexOf选目标。

```ts
import {expect} from 'vitest';
import {EditorState,TextSelection,type Transaction,type Command} from 'prosemirror-state';
import type {Node as PmNode} from 'prosemirror-model';
import {createSourceSession,applySourceBlockTransaction} from '../source-fidelity';
export function open(raw:string){
 const x=createSourceSession(raw);expect(x.ok).toBe(true);
 if(!x.ok)throw Error(x.reason);return x.session;
}
export function pos(doc:PmNode,path:readonly number[],offset=0){
 let n=doc,p=0;
 for(const index of path){for(let i=0;i<index;i++)p+=n.child(i).nodeSize;
  p++;n=n.child(index)}
 if(offset<0||offset>n.content.size)throw Error('test offset outside parent');
 return p+offset;
}
export function command(raw:string,fromPath:readonly number[],fromOffset:number,
 toPath:readonly number[],toOffset:number,make:(s:EditorState)=>Command,expected:string){
 const base=open(raw),from=pos(base.doc,fromPath,fromOffset),to=pos(base.doc,toPath,toOffset);
 const state=EditorState.create({doc:base.doc,selection:TextSelection.create(base.doc,from,to)});
 let tr:Transaction|undefined;
 expect(make(state)(state,t=>{tr=t})).toBe(true);
 if(!tr)throw Error('command did not dispatch');
 const r=applySourceBlockTransaction(base,tr);expect(r.ok).toBe(true);
 if(!r.ok)throw Error(r.reason);
 expect(Buffer.from(r.session.source)).toEqual(Buffer.from(expected));
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(base.source).toBe(raw);
 return {base,state,tr,r};
}
```

新recipe.spec.ts中的核心RED：

```ts
import {it,expect} from 'vitest';
import {toggleMark} from 'prosemirror-commands';
import {EditorState} from 'prosemirror-state';
import {applySourceBlockTransaction} from '../source-fidelity';
import {open,pos,command} from './source-inline-test-utils';
it('partial strong preserves nested shell and unrelated syntax',()=>{
 command('>  Alpha Beta _Keep_。\n',[0,0],6,[0,0],10,
  s=>toggleMark(s.schema.marks.strong!),'>  Alpha **Beta** _Keep_。\n');
});
it('only Beta removal preserves the unselected strong space',()=>{
 const {r,tr}=command('> __Alpha Beta__。\n',[0,0],6,[0,0],10,
  s=>toggleMark(s.schema.marks.strong!),'> __Alpha&#32;__&#66;eta。\n');
 expect(r.session.doc.eq(tr.doc)).toBe(true);
 expect(r.session.source).not.toBe('> __Alpha__ Beta。\n');
});
it('one real toggle reaches both paragraphs atomically',()=>{
 command('Alpha。\n\nBeta。\n',[0],0,[1],4,
  s=>toggleMark(s.schema.marks.strong!),'**Alpha。**\n\n**Beta**。\n');
});
it('crosses two nested bodies while retaining definition and prefixes',()=>{
 command('> [r]: /u\n>\n> Alpha。\n>\n>  Beta。\n',[0,0],0,[0,1],4,
  s=>toggleMark(s.schema.marks.strong!),
  '> [r]: /u\n>\n> **Alpha。**\n>\n>  **Beta**。\n');
});
it('two actual cells preserve their separators and spacing',()=>{
 command('| H | J |\n| :--- | ---: |\n|  Alpha | Beta  |\n',[0,1,0,0],0,[0,1,1,0],4,
  s=>toggleMark(s.schema.marks.strong!),
  '| H | J |\n| :--- | ---: |\n|  **Alpha** | **Beta**  |\n');
});
it('actual addMark replacing two hrefs produces a supported multi-Step chain',()=>{
 const {tr}=command('[A](/one)[B](/two) Keep。\n',[0],0,[0],2,
  s=>(state,dispatch)=>{dispatch?.(state.tr.addMark(1,3,s.schema.marks.link!.create({href:'/new'})));return true},
  '[AB](/new) Keep。\n');
 expect(tr.steps.length).toBeGreaterThan(1);
});
it('edits a real successful code token body without reselecting delimiters',()=>{
 const raw='> ``甲`乙``。\n',b=open(raw),p=pos(b.doc,[0,0],0);
 const tr=EditorState.create({doc:b.doc}).tr.insertText('丙',p,p+1);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe('> ``丙`乙``。\n');expect(r.edits).toHaveLength(1);
 expect(r.edits[0]!.to-r.edits[0]!.from).toBe(1);expect(r.session.doc.eq(tr.doc)).toBe(true);
});
```

多link expected本批明确为一个新连续link；未参与变化的相邻link、label实体原raw仍需保留。若实际serializer或parser不接受该expected，不能偷换弱断言；先核实际命令是否生成同一连续href，再修实现。

- [ ] **1.2 跑RED。** CORE `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-inline-recipe.spec.ts`。受理empty后基线预计仍失败于partial/multi-body拒绝或额外raw格式化，code为未映射；必须排除PM路径/fixture错误，不能用错误选区当RED。

- [ ] **1.3 建立actual edges与code body事实。** 修改markdown.ts的既有capture，不引入新tokenizer。

emphasis：在actual inline ruler2 postProcess前保留state.delimiters的token出处及已捕获marker trace；原规则成功后按其真实end配对登记open/close。strong合并相邻两marker时必须合并两条真实来源；在fragments_join删除空token之前完成。strike/equals highlight使用实际插件对应delimiter配对；caret_highlight直接在现有成功规则的start/contentStart/closeIdx处登记。不得扫描raw寻找重复markup、推测配对或复制emphasis grammar。

link：观察实际成功link rule调用内的递归inline.tokenize边界（state.pos/posMax即label）与original返回state.pos；记录完整actualsyntax及label正文边界，不自己parse链接。当href/title不变则原外壳按raw保留；改变href可仅重新生成该link壳，label raw保留。reference link不更改definition；将该selection改为显式inline link属于这次link命令的必要语法变化，最终reference环境照常核验。

code：现有backticks wrapper补成功code_inline分支，利用原start/返回state.pos/token.markup长度取得body；按原规则newline→space、去一对边space的实际变换投影SourceTrace，并核对token.content。padding不签发text span，newline归atomic；noCloseToken handler自己的emission生成TextSourceSpan。未闭合backticks原有fallback保持。

PM binding：open/close handler实际调用前后captureCursor记录边界，绑定actual body occurrence；最终frame/parent/type/完整marks对照doc，不能以Node.eq或相同文字认occurrence。cloneTokenBatch复制新WeakMap事实且rawDelta平移；inline replay重算和PM emission重建位置；在finalizer成功后同代layout私有登记。foreign使用既有verified factory重新捕获并比对公开来源维度，无setter。

- [ ] **1.4 实现原范围授权后的逐body recipe。** source-fidelity保持真实standard chain及changedNaturalRoots原审计；已认证empty先遵循上述三态接缝；仅not-empty在原natural-root审计之后调用capturedInlineRecipeFacts和prepareInlineRecipe。该函数不接受“只给最终doc”的授权模式。

```ts
// source-inline-recipe.ts内的具体工作数据（Task1实现，不持久化，不存raw副本）。
type InlinePiece=Readonly<
 | {kind:'retained';beforeFrom:number;beforeTo:number;afterFrom:number;afterTo:number}
 | {kind:'inserted';afterFrom:number;afterTo:number;step:number}
>;
type BodyWork=Readonly<{
 body:number;beforeFrom:number;beforeTo:number;afterFrom:number;afterTo:number;
 pieces:readonly InlinePiece[];dirtyEdges:readonly number[];
}>;
```

算法按以下固定顺序实现，不调用whole-body serializer后diff：

1. 对每条真实Step用它的`tr.docs[i]`审range和parent；marks可跨body，但每个实际受影响text/inline occurrence都必须有同代body authority。Mark链不变位置；闭合same-parent inline Replace按真实StepMap推进retained区间、删去覆盖部分、记入本Step生成片段。禁止借最终共同前后缀跳过原Step检查。
2. 跨段/多cell：原range覆盖的容器边界本身不当作可删raw；只对真实发生mark变化的各body建BodyWork。正文外祖先、siblings、结构、attrs必须保持；各body通过Mapping确认原occurrence保留。未知body或不可表达inline atom使整个事务返回failure；不得先安装已成功的body。
3. 每个body计算最终marks与原actual edges的差异；把partial切分碰到的完整edge纳入dirtyEdges闭包。只改变实际受命令影响的mark及表达该变化必需的边界，不把其它marks的raw delimiter变成随意归一权限。
4. 沿最终inline顺序作一次事件扫描：保留仍表示相同mark/attrs/边界的原open/close raw；删除被撤销的edge；在已证PM→raw边界生成新edge。retained正文由原TextSourceSpan及其原source区间输出，未参与变化的entity/escape/其它mark/atom完整raw直接保留；inserted片段只能来自实际Step授权的新text/inline值。
5. 当两个old link被真实命令改成相同连续href时，本计划允许合并其参与变化的envelope，label raw顺序保留。没有这类命令证据的相邻同文/同attrs source occurrence不能擅自合并。
6. 必要边界空白补偿：对em/strong/strike_through/highlight新open/close所邻的连续U+0020/TAB，在实际目标mark仍需覆盖该空白而该run成为该delimiter内侧首尾时，将**仅该边界run**编码为&#32;/&#9;；原PM字符与所有marks不变。code使用其自身padding规则，link/annotation不得为此无谓编码边界space；不能清理body其它空白、改变未选空格的mark或补偿整个段落。
7. delimiter选择复用已有sourceEmDelimiter/sourceCodeDelimiter的source-only逻辑（可抽为同模块内部helper供recipe调用，不改legacy serializer）；能保留旧字形时保留`__`/`^^`/backtick长度。code碰撞才按实际正文最长run调整本occurrence marker，padding按已安装规则逆变换校验。不得尝试多组字符串反复parse，只有一个确定candidate。
8. 对source顺序的kept/removed/generated边界直接构造最窄edits，保留区域不包入改写。两个同offset插入（嵌套marks）按既定schema/source serializer nesting顺序合成一edit；重叠dirty edge闭包先合并同body计划，不做字符串diff。
9. 联合所有body edits后走原ownership/overlap验证和preparePreservingSourceCandidate一次；严格target tr.doc，actual protected集合完全平移等同。只有全部通过才返回新session。unsupported不回整根renderer假装格式命令成功。

code文字仅普通字符变化优先现有exact路径；遇新增backtick冲突则由其有权限的code envelope承担必要delimiter修改。为避免混淆权限，TextSourceSpan只映射实际PM文本；href/note等属性仍不伪造PM字符位置。

- [ ] **1.5 写实际InputRule RED并通过，覆盖混合Replace+Mark。** 新source-inline-input.spec.ts使用真实createEditor插件，不手造其最终Step。

```ts
import {it,expect} from 'vitest';
import {createEditor} from '../setup';
import {BrowserMediaResolver} from '../adapters/browser-media-resolver';
import {TextSelection,type Transaction} from 'prosemirror-state';
import {createSourceSession,applySourceBlockTransaction} from '../source-fidelity';
it('actual closing-backtick input rule preserves unrelated raw',async()=>{
 const raw='> `Alpha\n',expected='> `Alpha`\n';
 const container=document.createElement('div');document.body.append(container);
 const editor=await createEditor({container,initialContent:raw,mediaResolver:new BrowserMediaResolver()});
 try {
  const opened=createSourceSession(raw,editor.view.state.schema);if(!opened.ok)throw Error(opened.reason);
  const b=opened.session;expect(editor.view.state.doc.eq(b.doc)).toBe(true);
  const end=2+6;editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(b.doc,end)));
  const seen:Transaction[]=[];
  editor.view.setProps({dispatchTransaction(tr){seen.push(tr);editor.view.updateState(editor.view.state.apply(tr))}});
  const handled=editor.view.someProp('handleTextInput',f=>f(editor.view,end,end,'`',()=>editor.view.state.tr.insertText('`',end)));
  expect(handled).toBe(true);expect(seen).toHaveLength(1);
  const tr=seen[0]!;expect(tr.steps.length).toBeGreaterThan(1);
  const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
  expect(r.session.source).toBe(expected);expect(r.session.doc.eq(tr.doc)).toBe(true);
 }finally{editor.destroy();container.remove()}
});
```

root本轮已核实际prosemirror-view/src/index.ts:641的handleTextInput签名为五参，第五参是`deflt:()=>Transaction`；上述代码据此编写。最终依赖版本保持不变，执行前须用受理empty的依赖/type证据复核；若签名相异，由root记录签名映射后冻结，不造包装假规则。同文件为strong/em/strike/highlight真实结束marker补字面输入、预期output与多Step断言，沿相同createEditor路径运行；不得只调用规则handler函数。

- [ ] **1.5b 恢复真实closed code-block正文插入导致的fence碰撞。** 这是已有用户操作的专用producer，不是允许literal重新走whole-root renderer。新source-inline-recipe.spec.ts加入下列独立RED，并将旧source-structure-commands.spec.ts中上述一个具名用例恢复positive且断言相同完整expected。

```ts
it('closed fence grows only its two markers and the actual inserted body',()=>{
 const raw='```js\nA\n```\n\nTail __raw__';
 const expected='````js\nA\n```\n\n\n````\n\nTail __raw__';
 const b=open(raw),tr=EditorState.create({doc:b.doc}).tr.insertText('\n```\n\n',2);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe(expected);expect(r.session.doc.eq(tr.doc)).toBe(true);
 expect(r.session.doc.firstChild!.textContent).toBe('A\n```\n\n');
 expect(r.edits).toHaveLength(3);
 expect(r.edits).toEqual([
  {from:0,to:3,text:'````'},
  {from:7,to:7,text:'\n```\n\n'},
  {from:8,to:11,text:'````'},
 ]);
 expect(b.source).toBe(raw);
});
it('fence growth retains info, close whitespace, BOM and original CRLF',()=>{
 const raw='\uFEFF```  js \r\nA\r\n``` \t\r\n\r\nTail __raw__';
 const expected='\uFEFF````  js \r\nA\r\n```\r\n\r\n\r\n```` \t\r\n\r\nTail __raw__';
 const b=open(raw),tr=EditorState.create({doc:b.doc}).tr.insertText('\n```\n\n',2);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(Buffer.from(r.session.source)).toEqual(Buffer.from(expected));
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(r.edits).toHaveLength(3);
});
it.each([
 ['```js\nA\n```','```','```js\nA```\n```',1],
 ['~~~js\nA\n~~~~~','\n~~~\n\n','~~~~js\nA\n~~~\n\n\n~~~~~',2],
] as const)('only necessary fence markers change: %j',(raw,text,expected,count)=>{
 const b=open(raw),tr=EditorState.create({doc:b.doc}).tr.insertText(text,2);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe(expected);expect(r.edits).toHaveLength(count);
 expect(r.session.doc.eq(tr.doc)).toBe(true);
});
it('unclosed and stripped-prefix fence growth receives no delimiter authority',()=>{
 for(const raw of ['```js\nA','> ```js\n> A\n> ```\n']){
  const b=open(raw),p=raw.startsWith('>')?pos(b.doc,[0,0],1):pos(b.doc,[0],1);
  const tr=EditorState.create({doc:b.doc}).tr.insertText('\n```\n\n',p);
  const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(false);
  expect(r).not.toHaveProperty('session');expect(b.source).toBe(raw);
 }
});
```

先在受理empty最终BASE跑该新RED，预期strict路径拒绝；不能仅把旧测试改回success而无实现。第一例body插入后的两个terminal LF属于PM正文，原先A后的LF仍是closing syntax所需分隔：expected在正文三反引号之后有三个LF，不能吞掉一个让可见显示看似正确。

**Task1新增内部接口（同source-inline-recipe.ts实现；不改公开API）：**

```ts
export type ClosedFenceBody=Readonly<{
 pmFrom:number;pmTo:number;sourceFrom:number;sourceTo:number; // 整code node/source fence范围
 open:InlineRawRange;close:InlineRawRange;character:'`'|'~';
 openLength:number;closeLength:number;contentFrom:number;contentTo:number;
 eol:'\n'|'\r\n'|'\r';contiguousTopLevel:boolean;
}>;
// InlineRecipeFacts增加fences:readonly ClosedFenceBody[]。
export function prepareClosedFenceRecipe(base:SourceSession,tr:Transaction,
 facts:InlineRecipeFacts):
 | {ok:true;edits:readonly SourceEdit[]}
 | {ok:false;reason:'unsupported-step'|'unmapped-range'};
// markdown.ts内部导出给recipe；Task1从sourceCodeNode抽出，保持原算法行为。
export function sourceFenceLength(text:string,character:'`'|'~',minimum:number):number;
```

**authority与算法：** 沿实际fence wrapper已观察的getLines begin/end以及capturedFenceClosed，只有`state.line===contentEnd+1`才能签发closing权限。原成功规则返回时记录当次活动state中opening `bMarks[start]+tShift[start]`、token.markup长度；closing行就是actual contentEnd，其`bMarks+ tShift`与实际连续marker run界定close。只核验这两条已经由actual成功规则选定的marker字节、character、长度与token.info，不重新寻找closing、不扫描全文fence grammar。opening/closing的indent、info、尾空白、EOL都不在marker range内。

body复用已提交nested实际getLines trace/noCloseToken PM映射，`pmFrom/pmTo`为整code node边界，正文为`[pmFrom+1,pmTo-1)`；contentFrom/contentTo为实际PM正文对应source端点，保留原terminal source EOL在正文权限之外。facts走既有clone/rawDelta/lineDelta、replay、actual PM emission与finalizer/foreign闭包。root执行前必须核受理empty最终fence事实API；不可另设caller可造closed标志。

第一版精确scope：原PM正文非空、已证closed、top-level code_block（非CSV spreadsheet、非language变更）；原body整段在SourceTrace上除CR/LF normalization外连续，getLines未剥任何body行prefix/indent且无generated piece，所有PM文本边界映射可证。opening/closing原indent可以保留，但任何body行被剥缩进、quote/list/footnote prefix或不连续source span都不签发growth authority。它们的普通单字exact及前置EmptyBody普通首字保持原能力；**仅碰撞需要增长时明确拒绝**。空literal的首字碰撞也不由非空contentFrom/contentTo假授权，先由empty三态受理普通首字形成非空session后再碰撞的真实链必须positive；本恢复合同不声称首次空literal直接碰撞或nested fence任意增行已支持。

原Step先经既有全range/prototype/tr.docs/parent/type/全部attrs/marks权限审计；只接受一个closed纯text ReplaceStep作用于这一code_block正文，原语言与其余树不变。普通不碰撞正文继续原exact，不更改围栏。确定碰撞仅检查真实本次改变后code文本中可成为closing的物理行：按当前实际fence rule的关闭词法条件（top-level最多3个leading U+0020、同字符连续run长度≥opening、后缀仅U+0020/TAB）计算新增/改动行；leading TAB在此scope已达到至少4列，不是closing候选；这是输出安全判定，不决定输入fence成立，不另跑parse。若无此类冲突不要因为行中普通backtick run就增大marker。

碰撞时复用固定源码sourceCodeNode的source-only算法：在原character下取`max(3,全目标body同字符最长run+1,原opening长度)`，不改原info也不换character；opening增长至该长度，closing取`max(原closing长度,新opening长度)`，原closing已够长则不写它。不得缩短更长的原marker。复用算法可抽内部函数，但default legacy serializer行为不变。

body patch来自真实ReplaceStep映射，不render完整body：保留实际removed区间外raw，新增LF按captured opening EOL编码（mixed原EOL保留，只新插入行采用该eol），禁止拆CRLF/surrogate/atomic内部。新行只在上述无body-prefixscope成立时直接生成；不自行给nested新增行猜quote/list prefix。opening、actualbody、closing最多三条edit，不改info/indent/空白/tail；整个candidate只验证一次。分派放在原Step完整验权之后、exact调用candidate之前：先用上述无parse的关闭行词法判定检查碰撞；无碰撞直接走原exact，有碰撞且actualclosed/body权限完备才走fence recipe，否则strict拒绝。与inline recipe共用preserving candidate，每个操作只产一个确定candidate，不先试exact parse失败再试增长，不回whole-root serialize/diff。

closed-fence正例额外加入从已认证空top-level code先键A成功，再对新session执行上述碰撞插入的链；第一步只消费前置EmptyBody，第二步才走本Task envelope。closed-fence正例加入新cache suite：前段插入引起rawDelta/lineDelta后再插冲突正文；foreign合法clone正例、伪closed metadata负例；远处definition在正文变长后actualprotected集合精确平移；失败后合法单字请求仍可用。完整原Step覆盖protected或cross-node不受此例外授权。新增unsupported组合仍全事务拒绝，不在本批扩为多code块结构编辑。

- [ ] **1.5c 空inline已有UI独立RED→GREEN。** 同source-inline-recipe.spec.ts先写、再实现以下冻结expected；真实command后以新EditorState/新session继续，不手工删掉marks使其通过。

| 前置raw与实际动作 | 独立expected / 断言 |
|---|---|
| 空文件先toggleMark(strong)，再`insertText('X')` | toggle仅storedMarks：source/revision不变；后一步`**X**`，目标X实际带strong |
| `>\n` 空P先toggleMark(em)，再键X | `>*X*\n`；同一EmptyBody inline权限，原quote/EOL保持 |
| 真实空cell `\| H \| J \|\n\| --- \| --- \|\n\| A \|   \|\n`，空cell stored strong后键X | `\| H \| J \|\n\| --- \| --- \|\n\| A \|**X**   \|\n` |
| 同table行只有`\| A \|\n`，在补齐第二cell执行真实link `{href:'/u',text:'X'}` | 行成为`\| A \|[X](/u)\|\n`；断言真实Replace+AddMark；只需缺失slot及link语法 |
| 空文件真实link插入 | `[X](/u)`；认证fallback origin，实际Replace+AddMark；无中间裸X session安装 |
| `A\n\n\nB`第2个顶层节点（空P）执行真实link插入 | `A\n\n[X](/u)\n\nB`；认证blank origin，保持两侧旧正文与原EOL；真实mark链逐step过ledger |
| 前置Task2真实`> A` Enter得`> A\n>`，切strong后键X | `> A\n>\n>**X**`；separator来自已有nested-blank recipe |
| `- # H\n`的schema空首P切strong后键X | `- **X**\n  # H\n`；prepend保持原heading bytes |

该组同时直接调用`prepareEmptyParagraphEdits`检验空文件fallback与`A\n\n\nB`中blank的真实Replace+AddMark链，expected分别`[X](/u)`与`A\n\n[X](/u)\n\nB`；origin取同代认证fact，body由真实有限helper生成，调用返回edits仍由生产preserving流程验证，不能把“直接helper有edits”当最终通过。直接helper负例加入首步非空、后续Replace/结构Step、mark跨到旧A/B、错tr.docs/原Step prototype、其它origin与birth/多run；均拒绝。Source主入口原子负例保留`later-empty`、`emptied-earlier`、`created-earlier`三旧case，以及首步空插入后mark跨旧内容；全链失败无root-render/base变化。

表内Markdown竖线在测试使用普通`|`字节，expected不得调用serializer生成。同helper在空文件以真实toggleMark后键X，独立expected分别为em `*X*`、strong `**X**`、strike_through `~~X~~`、默认highlight `^^X^^`、code `` `X` ``；link使用真实空cursor插入命令得`[X](/u)`，不伪造并不存在的link toggle UI。空选择toggle不写raw。负例为缺认证fact、错parent/attrs、原Step范围跨兄弟、非法TAB/ignored cell，以及一事务同时含允许新text与未支持atom：必须整体失败。使用前置空正文/cache/Enter suites作回归，不把它们复制进新suite。前置marked-empty只迁移本计划已点名两个分支，其余负例保持。

- [ ] **1.6 缓存、边界与跨body原子回归。** 新cache.spec.ts覆盖全capture→三次replay edges/正文doc/runs全等；普通前段插行导致rawDelta/lineDelta，再在远处nested code改字与partial mark；reference环境改变导致inline重放后更改已有link；合法foreign正例、各公开span维度篡改负例、失败后合法请求不被污染。

新recipe.spec.ts增加：BOM+CRLF的跨quote两段；重复正文只选第二occurrence；含远处重复/unused definition；code normalized spaces/escaped entity原始区间；跨两个nested list项；storedMarks-only原raw与revision不变；标准Step subclass/toJSON伪装拒绝；一处partial mark+一处无法表达的math_inline子内容mark组合整体失败。partial选区碰到未映射atom必须报失败，无半次save。

把旧reference两个multi-root动作迁移为新成功，独立expected同时包Tail与Alpha的strong且definition原位原bytes。真正mixed-supported/unsupported负例留在新文件；不能仅删除旧拒绝测试。

- [ ] **1.7 host实际工具栏事务测试先写，聚合安装后验。** HOST新source-inline-producer.test.ts使用下列完整helper，直接@moraya/core installed入口与实际executeEditorCommand。

```ts
import {it,expect} from 'vitest';import {EditorView} from 'prosemirror-view';
import {EditorState,TextSelection} from 'prosemirror-state';
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core';
import {executeEditorCommand} from '../../editor-kit-v2/commands';
import type {EditorCommand} from '../../editor-kit-v2/contract';
import {propose} from './proposal';
function toolbar(raw:string,from:number,to:number,action:EditorCommand,expected:string){
 const b=createSourceSession(raw);if(!b.ok)throw Error(b.reason);
 const container=document.createElement('div');document.body.append(container);
 let source=raw;const seen:number[]=[];
 const view=new EditorView(container,{state:EditorState.create({doc:b.session.doc,
  selection:TextSelection.create(b.session.doc,from,to)}),dispatchTransaction(tr){
   const r=applySourceBlockTransaction(b.session,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
   source=r.session.source;seen.push(tr.steps.length);view.updateState(view.state.apply(tr));
 }});
 try{expect(executeEditorCommand(view,action)).toBe(true);expect(seen).toHaveLength(1);
  expect(Buffer.from(source)).toEqual(Buffer.from(expected));
  const p=propose({path:'inline.md',base:raw,ours:raw,theirs:source});
  expect(p.theirsEolAligned).toBe(false);expect(p.hunks.length).toBeGreaterThan(0);
 }finally{view.destroy();container.remove()}
}
it('installed toolbar partial bold',()=>toolbar('> Alpha Beta。\n',8,12,{kind:'bold'},'> Alpha **Beta**。\n'));
it('installed toolbar cross paragraphs',()=>toolbar('Alpha。\n\nBeta。\n',1,13,{kind:'bold'},'**Alpha。**\n\n**Beta**。\n'));
it('installed toolbar inserts text plus link',()=>toolbar('Keep。\n',1,1,{kind:'link',href:'/u',text:'A'},'[A](/u)Keep。\n'));
```

跨段第二终点应按PM nodeSize计算：`Alpha。`长度6，第一paragraph nodeSize8，第二text从9开始，选到Beta末为13；先断言目标doc.textBetween片段以排除位置错误。新增真实多cell toolbar选区用已知PM路径计算，不写raw索引猜位置。另建沿成功session更新的多事务helper，通过实际executeEditorCommand切storedMarks后键X及空link插入，覆盖1.5c认证空体正例；默认createEditor保留原plugins，以source capture doc为file基线。保留hunk真实粒度；raw一字code编辑必须单字符patch+一hunk，format跨两段允许其真实两处变化，不做diff过滤。

- [ ] **1.8 Task1 GREEN、types与精确source提交。** 经root本批run.py记录以下CORE命令：

```sh
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-inline-recipe.spec.ts src/__tests__/source-inline-input.spec.ts src/__tests__/source-inline-cache.spec.ts src/__tests__/source-reference.spec.ts src/__tests__/source-nested-producer.spec.ts src/__tests__/source-body-producer.spec.ts src/__tests__/source-structure-commands.spec.ts src/__tests__/source-empty-body.spec.ts src/__tests__/source-empty-cache.spec.ts src/__tests__/source-empty-enter.spec.ts
env pnpm_config_verify_deps_before_run=false pnpm run typecheck
# 新测试还须root生成严格tsconfig执行tsc --noEmit，不以Vitest转译代替。
```

每个新能力保留真实实现前RED→GREEN日志；原不变量首次GREEN如实记。通过后精确提交Task1 source/tests及未发布记录，记录SHA；不提交或安装旧dist冒充新能力。HOST新增真实consumer测试此时尚未用新installed包验收，明确标“待Task2聚合安装”。

### Task 2: Critic payload、增删 consumer 与 installed 全闭包

**Files:** CORE `markdown.ts`、`source-inline-recipe.ts`、`source-fidelity.ts`，必要时在 `source-empty-body.ts` 的既有consumer准入分支接note_anchor（不改捕获/placement）；新source-annotation-producer.spec.ts，扩source-inline-cache.spec.ts；HOST新src/lib/note-anno/source-annotation-producer.test.ts；两仓CHANGELOG；最后已验证CORE dist。

**Consumes:** 本批Task1的actual body/edge事实、多body原始Step审计、联合recipe、`prepareEmptyInlineContent`与preserving candidate；前置empty Task1/2同代EmptyBody、placement和三态分派。

**Produces:** 实际批注说明修改、添加、删除保持被批注正文raw；点批注leaf Replace严格识别；已认证空P/真实与补齐cell的point插入→save→remove；多source occurrence与真实UI事务验收。其payload/空体point均在本Task独立RED→GREEN后才聚合安装。

```ts
// source-inline-recipe.ts内部补充类型，Task2实现；仍不对外发布权限setter。
export type CriticPayload=Readonly<{
 id:number;body:number;kind:'annotation'|'note_anchor';
 pmFrom:number;pmTo:number;syntaxFrom:number;syntaxTo:number;
 noteFrom:number;noteTo:number;note:string;
 open?:InlineRawRange;middle?:InlineRawRange;close:InlineRawRange;
}>;
// InlineRecipeFacts追加只读critic:readonly CriticPayload[]；由实际capture登记。
// prepareInlineRecipe签名保持；增加两类已有真实consumer分支，不重做候选提交。
// prepareEmptyInlineContent签名保持，扩唯一note_anchor leaf生成；仍由EmptyAttempt统一分派。
```

- [ ] **2.1 写CORE真实形状RED。** helper沿Task1新utils复用，新测试完整输入/expected如下。

```ts
import {it,expect} from 'vitest';import {EditorState} from 'prosemirror-state';
import {ReplaceStep,RemoveMarkStep,AddMarkStep} from 'prosemirror-transform';
import {applySourceBlockTransaction} from '../source-fidelity';
import {open,pos} from './source-inline-test-utils';
it('annotation note chain changes only actual payload',()=>{
 const raw='> {==Alpha _Beta_==}{>>原注<<}\n',b=open(raw),from=pos(b.doc,[0,0]),to=from+10;
 const type=b.doc.type.schema.marks.annotation!;
 const tr=EditorState.create({doc:b.doc}).tr.removeMark(from,to,type).addMark(from,to,type.create({note:'新注'}));
 expect(tr.steps.some(s=>Object.getPrototypeOf(s)===RemoveMarkStep.prototype)).toBe(true);
 expect(tr.steps.some(s=>Object.getPrototypeOf(s)===AddMarkStep.prototype)).toBe(true);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe('> {==Alpha _Beta_==}{>>新注<<}\n');
 expect(r.edits).toHaveLength(1);expect(r.edits[0]!.to-r.edits[0]!.from).toBe(1);
 expect(r.session.doc.eq(tr.doc)).toBe(true);
});
it('same-note adjacent occurrences retain their separate wrappers',()=>{
 const raw='{==A==}{>>同<<}{==B==}{>>同<<}\n',b=open(raw),type=b.doc.type.schema.marks.annotation!;
 const tr=EditorState.create({doc:b.doc}).tr.removeMark(1,3,type).addMark(1,3,type.create({note:'新'}));
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe('{==A==}{>>新<<}{==B==}{>>新<<}\n');expect(r.edits).toHaveLength(2);
});
it('actual setNodeMarkup is a leaf Replace and changes only point-note text',()=>{
 const raw='{>>原注<<}目标甲。\n',b=open(raw);
 const tr=EditorState.create({doc:b.doc}).tr.setNodeMarkup(1,undefined,{note:'新注'});
 expect(Object.getPrototypeOf(tr.steps[0]!)).toBe(ReplaceStep.prototype);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe('{>>新注<<}目标甲。\n');expect(r.edits).toHaveLength(1);
 expect(r.edits[0]!.text).toBe('新');expect(r.edits[0]!.to-r.edits[0]!.from).toBe(1);
});
```

- [ ] **2.2 跑RED。** CORE `env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-annotation-producer.spec.ts`；应失败于payload未获权或整inline重写；不能把已支持被批注正文改字当payload能力。

- [ ] **2.3 真实Critic capture。** 自有critic_annotation成功分支直接登记start/hlClose/noteStart/noteClose：range为`{==`、实际内容、`==}{>>`、note、`<<}`；point为`{>>`、note、`<<}`。无第二regex，无source.indexOf同文定位；这些边界来自唯一实际规则本次已完成的消费。

每个成功source occurrence保留独立id，即使PM把同note的相邻annotation合并为一个text node。通过actual token/PM emission绑定range或leaf；clone rawDelta/inline replay/foreign finalizer闭包与Task1一致。point-only paragraph虽无text span，actual note_anchor emission仍须绑定真实parent/body occurrence，供随后payload更新/删除；不得因没有TextSourceSpan就丢掉该atom authority，更不靠空body旧fact猜位置。note是actual attrs验证值，raw只存offset，不建第二payload字符串账本；CriticPayload.note取actual Mark.attrs.note或node.attrs.note，不接受caller字段签发authority。

- [ ] **2.4 annotation说明更新与移除/新增recipe。**

1. 对实际RemoveMark/AddMark完整链验证同range/同family的最终note变化；所有文本、其它marks、ancestor attrs必须严格不变。旧note→newnote不是自由生成一个新annotation的权限。
2. findAnnotationRange按连续相同note合并的操作，必须完整覆盖其中每个actual source occurrence；逐payload替换，原wrapper及内容全部kept。PM合并不允许source合并；可在审完整原range后对note old/new作共同前后缀收缩，单字只一raw补丁。
3. remove annotation：删除actual open/middle/note/close语法，仅保留实际body raw；不能调用whole-body serializer重写`_Beta_`。新增annotation：由实际mark选区边界生成`{==`与`==}{>>note<<}`，复用Task1分body recipe；跨段选择各body独立合法annotation、共同提交，不能生成跨物理换行的Critic body。
4. 部分annotation mark移除/添加若要求拆分，保留未被操作侧原note及正文，按实际目标mark边界生成必要wrapper；每个输出occurrence必须能从原range witness或实际新增mark解释。不能把description更新的whole-range证据用作任意拆分权限。
5. HOST sanitizeNote已把LF/CRLF与`<<}`清洗；producer只认实际tr的note值，不能再次清洗后改变attrs。最终candidate必须与原tr.doc完全相等，不支持的输入明确失败。

- [ ] **2.5 点批注exact leaf witness与增删。** note_anchor的setNodeMarkup实际为closed ReplaceStep覆盖一个leaf。要求原type===新type===note_anchor、nodeSize=1、marks全等、所有attrs只有note可变、slice恰一个leaf、原range恰其actual occurrence；同时原Step链/根ownership/其余树严格审计。禁止按Step.toJSON猜类型或用一般same-text-diff授权所有atom属性。

更新只改actual note payload。删除leaf只删除其actual完整syntax；插入leaf仅在实际caret source边界无歧义且closed inline Replace授权时生成syntax。已认证空paragraph、真实空cell与schema补齐cell须复用前置EmptyBody及Task1的prepareEmptyInlineContent生成本次note_anchor，交原placement消费必要slot/分隔语法；这是本Task必做positive，不再以“空cell没有anchor”总拒绝。原始Step必须from===to===fact.pmAt、closed单leaf note_anchor，节点marks逐一核验；未支持组合整体失败。缺fact/ignored列/generated点仍unsupported，不凭PM空节点制造位置。插入后新的actual批注token生成payload事实；save/remove各消费上一成功session，不能复用插入前空fact。

math_block虽atom但不是leaf，其setNodeMarkup可能ReplaceAroundStep；绝不借note_anchor例外受理。新公式body UI不在本计划。

- [ ] **2.6 HOST真实泡泡事务RED/GREEN。** 新source-annotation-producer.test.ts用真实openEditForMark/openEditForAnchor及noteUi.edit callbacks。以下代码为完整测试，无自造note保存命令。

```ts
import {it,expect} from 'vitest';import {EditorView} from 'prosemirror-view';
import {EditorState} from 'prosemirror-state';
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core';
import {openEditForMark,openEditForAnchor,insertNoteRich} from './note-commands';
import {noteUi} from './note-ui.svelte';
function bubble(raw:string,at:number,kind:'mark'|'point',value:string,expected:string){
 const b=createSourceSession(raw);if(!b.ok)throw Error(b.reason);
 const container=document.createElement('div');document.body.append(container);
 let source=raw;const seen:number[]=[];
 const view=new EditorView(container,{state:EditorState.create({doc:b.session.doc}),dispatchTransaction(tr){
  const r=applySourceBlockTransaction(b.session,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
  source=r.session.source;seen.push(tr.steps.length);view.updateState(view.state.apply(tr));
 }});
 try{(kind==='mark'?openEditForMark:openEditForAnchor)(view,at,new DOMRect(0,0,1,1));
  expect(noteUi.edit).not.toBeNull();noteUi.edit!.save(value);
  expect(seen).toHaveLength(1);expect(Buffer.from(source)).toEqual(Buffer.from(expected));
  if(kind==='mark')expect(seen[0]).toBeGreaterThan(1);
 }finally{noteUi.edit=null;noteUi.hover=null;view.destroy();container.remove()}
}
it('real range-note popup',()=>bubble('> {==Alpha _Beta_==}{>>原注<<}\n',3,'mark','新注',
 '> {==Alpha _Beta_==}{>>新注<<}\n'));
it('real point-note popup',()=>bubble('{>>原注<<}目标甲。\n',1,'point','新注','{>>新注<<}目标甲。\n'));
```

同文件还必须调用实际noteUi.edit.remove与insertNoteRich验证增删，见下一步明确序列。不要用手写tr代替这两种consumer。HOST事件notemd:flush-doc可以以spy记录发生，不拦截成假保存成功；此测试仅校验core候选与真实PM命令，不声称bindings/history已接入。

- [ ] **2.7 增删实际序列与原子边界。** 在同文件追加一个可复用mount（独立于上面只发一次的bubble）并完整执行：

```ts
import {TextSelection} from 'prosemirror-state';
it('real insert-note then edit/remove consumes each new authoritative session',()=>{
 const opened=createSourceSession('Alpha。\n');if(!opened.ok)throw Error(opened.reason);
 let base=opened.session;const values:string[]=[];
 const container=document.createElement('div');document.body.append(container);
 const view=new EditorView(container,{state:EditorState.create({doc:base.doc,
  selection:TextSelection.create(base.doc,1,6)}),dispatchTransaction(tr){
   const r=applySourceBlockTransaction(base,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
   base=r.session;values.push(base.source);view.updateState(view.state.apply(tr));
 }});
 // jsdom/happy-dom没有排版；只固定弹窗位置，不替换任何命令或事务。
 const realCoords=view.coordsAtPos.bind(view);view.coordsAtPos=()=>({left:0,right:1,top:0,bottom:1});
 try{
  insertNoteRich(view,'?');expect(base.source).toBe('{==Alpha==}{>>?<<}。\n');
  noteUi.edit!.save('新注');expect(base.source).toBe('{==Alpha==}{>>新注<<}。\n');
  noteUi.edit!.remove();expect(base.source).toBe('Alpha。\n');expect(values).toHaveLength(3);
 }finally{view.coordsAtPos=realCoords;noteUi.edit=null;noteUi.hover=null;view.destroy();container.remove()}
});
```

另用empty TextSelection at1执行insertNoteRich('?')，独立expected `{>>?<<}Alpha。\n`→保存`{>>新注<<}Alpha。\n`→删除`Alpha。\n`；实际point三次consumer都走新session。加cross-paragraph insertNoteRich范围正例，每个body包各自Critic syntax且一事务安装；已认证空cell插入列positive；真正无fact/ignored/generated位置列负例，整事务不安装任何另一body结果。

同suite另加空体point真实链（CORE同形状RED先行，HOST在installed包运行）。输入空文件`''`，`insertNoteRich('?')`→`{>>?<<}`，save→`{>>新注<<}`，remove→`''`；输入`>\n`对应`>{>>?<<}\n`→`>{>>新注<<}\n`→`>\n`。table真实空字段`| A |   |\n`分别成为`| A |{>>?<<}   |\n`、`| A |{>>新注<<}   |\n`、`| A |   |\n`；补齐字段`| A |\n`插入后变`| A |{>>?<<}|\n`，save保持slot，删除后为`| A ||\n`，不自动撤销已成功materialize的必要pipe。完整表头固定`| H | J |\n| --- | --- |\n`且每步原样保留。三列表选第三个缺失cell仅补到该slot；重复空行只消费实际选中occurrence。Enter后nested-blank point插入/save/remove回归按前置source-only空段约定冻结独立expected，不要求删除时恢复历史raw布局。

- [ ] **2.8 回归与完整权限测试。** CORE新增annotation suite包括：BOM/CRLF+duplicate note occurrence；含nested reference的quote中改说明；同note的相邻source wrapper不合并；partial annotation拆分且其它marks不变；fake note Replace更改type/marks/其它attrs/邻字符拒绝；note更新后远处definitions集合严格平移；foreign tamper在renderer前拒绝、失败后合法请求成功。已有annotation/schema/math/inputrules/结构 suites原样跑，不改其旧语义。

explicit Source raw API仍可改definitions，不被本计划Rich payload权限限制。真实math插入/InputRules在全回归保持当前基线行为；另在带`$x+y$`/`$$\nx^2\n$$`的文档编辑相邻格式或批注，独立expected公式raw逐字节不变，且明确这是保留公式回归，不是公式正文能力。

- [ ] **2.9 聚合执行与产物顺序。** root先从受理empty最终报告冻结本批BASE/工具/allowlist，不直接执行上一阶段脚本写旧OWN。所有命令由本批recorded runner保存argv/cwd/时间/stdout/stderr/expected/actual退出及tool session元数据；旧失败日志不覆盖。Task2先独立运行2.2的annotation suite与扩展cache（含空体point链）、CORE typecheck及同一严格新测试tsconfig，记录其自身RED→GREEN与对应源状态，再进入下列聚合命令；不能仅靠全量总数代替本Task独立consumer证据。

```sh
# CORE cwd：先focused，再全量一次。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-annotation-producer.spec.ts src/__tests__/source-inline-recipe.spec.ts src/__tests__/source-inline-input.spec.ts src/__tests__/source-inline-cache.spec.ts src/__tests__/source-reference.spec.ts src/__tests__/source-structure-commands.spec.ts
env pnpm_config_verify_deps_before_run=false pnpm test
env pnpm_config_verify_deps_before_run=false pnpm run typecheck
# root严格新测试tsconfig编译通过后：
env pnpm_config_verify_deps_before_run=false pnpm run build
# root artifacts检查 → exact dist stage → core source+dist精确commit → 记录最终SHA。
# HOST cwd：仅安装已提交core dist，使用已核stage/sync/installed工具。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/lib/share-merge/source-inline-producer.test.ts src/lib/note-anno/source-annotation-producer.test.ts src/lib/share-merge/source-fidelity.test.ts src/lib/share-merge/source-nested-producer.test.ts src/lib/share-merge/source-empty-producer.test.ts
env pnpm_config_verify_deps_before_run=false pnpm test
env pnpm_config_verify_deps_before_run=false pnpm run check:share-merge
# root先执行本批受控空envDir host build gate，成功后：
env pnpm_config_verify_deps_before_run=false pnpm run check:editor-kit
# Svelte只由root在最终指纹冻结后统一运行一次；writer不重复运行：
# env pnpm_config_verify_deps_before_run=false pnpm run check
```

host build沿空envDir的既有受控入口，必须先于check:editor-kit；最终Svelte由root统一执行一次，不在writer阶段重复。完整检查所有实际package exports JS/DTS/maps embedded源码、package/lock bytes、两仓fixture SHA、gzip≤102400与installed bytes对应committed dist。不要为了预算移出入口/改压缩参数；如超限先停并向root提交证据。最终host源码/tests/未发布记录精确commit并记录双HEAD，报告哪次全套对应哪SHA，不把只跑targeted的后修订说成重跑全量。

- [ ] **2.10 完成条件与下游门槛。** 新partial、多Step、跨两段、nested、多cell、空inline marked/link/point、inline code body、已证closed-fence碰撞增长、真实批注泡泡增删改均有真实RED→GREEN及installed证据；原Step权限/protected/全attrs严格eq保持；所有source/test/dist已精确提交且双SHA与artifact对应。已认证empty marked/link/point必须有positive；缺fact/不可表达复杂atom组合具体列出，不能声称全菜单任意文档无条件支持。

本批不实施bindings/history、新公式正文UI、任意结构或definition transport；既有math插入/InputRules的source兼容另列下一最小producer任务，须在协作UI启用前闭合，不以本批默认数学回归冒称完成。后续bindings安装必须一次接收成功session和edits，失败保留原始草稿/原raw；没有半次批注或半个选区保存。实现任一不可表达case时仍需独立新增行为RED，不能以菜单能力口号绕过这里的精确范围。


## Task1 实测边界补充裁定（2026-10-14）

Ruling: 部分取消strong的冻结expected更正为 `> __Alpha&#32;__&#66;eta。\n`，保留原下划线，只在真实delimiter边界必要时编码相邻Unicode scalar；取代此前“只允许space/tab”的限制 — root独立installed探针证明原expected与仅换**均无法strict doc.eq，而补偿B为entity可保持原文及strong范围 — 成本是被选边界字符raw表示发生必要变化；须确定性lexical规则、entity/surrogate原子边界及无必要不编码反例，不得生产parse重试或整body规范化。

Ruling: source-reference中两个参数的“marks the complete reference-covered body atomically”仅outside跨Alpha/Tail分支迁移成功；source-nested-producer中真实toggleMark预期改为Alpha端点两次窄插入，跨Alpha/Tail测试改成功 — 新窄多body能力使这些原动作合法，root已核实际旧测试，outside并非部分reference格式 — 成本是精确新增旧用例迁移；完整raw仅Alpha/Tail加**、definition/protected与base不变，其余假Step/attrs/跨prefix反例保留。

Ruling: source-body-producer两参数组中仅原始 `~~~~text\n甲\n~~~~\n` 分支新增成功，插入体为换行+~~~~+换行时完整expected为 `~~~~~text\n\n~~~~\n\n~~~~~\n`，全体为甲+换行+~~~~+换行时为 `~~~~~text\n甲\n~~~~\n\n~~~~~\n` — root独立installed parser已对实际目标PM验证strict eq，属于本Task已批准closed-fence增长 — 成本为最多三处必要marker/body edit；spy零调用、base不变保留，frontmatter/HTML负例不改。

Ruling: 允许非空同body原生closed Replace生成hardbreak(isInline:true)，维持已有source-only softbreak正例；空leaf插入、对旧无映射atom施mark及跨quote-prefix替换仍拒绝 — 旧“hardbreak leaf仍拒绝”需限定空体权限，不能把认证非空替换误拒绝 — 成本是inline recipe增加精确新softbreak生成，不授一般atom或结构权限；原attrs、全部Step和strict doc.eq照常验证。

Ruling: source-structure-commands原getLines/skipSpaces三个apply参数改为Parameters<typeof get/skip>的精确tuple类型 — 新严格测试配置揭示原any[]签名不符，与运行语义无关 — 成本仅类型擦除，不放宽strict或改断言。新补真实InputRules首次GREEN按GREEN如实记录，不为追补RED复制或回写旧产品源码。

补充修改allowlist：CORE `src/__tests__/source-nested-producer.spec.ts` 和 `src/__tests__/source-body-producer.spec.ts` 仅以上具名迁移；既有source-structure-commands额外允许上述三处纯类型修正。本补充取代正文“不得改同文件其他测试”对应冲突部分，其余约束保持。


## Task2 批注空体接缝补充（实施前自审）

Ruling: Task2允许精确修改source-structure.ts的prepareEmptyParagraphEdits，仅新增已认证空paragraph首步closed单note_anchor leaf插入的原链准入；不开放其它leaf/atom，所有原prototype/docs/apply/ledger/single-origin/no-birth/one-run/claims约束保持 — Task1为拒绝未知leaf加入text-only guard，Task2明定空文件/布局空段点批注positive必经此helper，仅改source-empty-body会被直接拒绝 — 成本是一个具名helper精确扩展并加直接正反例；该分支须仅单步、canonical真实note_anchor且marks/attrs完整验证，无后续mark扩权，hardbreak/math/缺fact/先删空再插入等旧拒绝保持。

Task2文件allowlist相应新增上述source-structure.ts具名helper；直接helper的测试放新source-annotation-producer.spec.ts，旧source-empty-cache/source-inline-recipe的hardbreak leaf负例保持。Task1 fix1新增只读InlineAtomOccurrence由actual math token发射/clone/replay/finalizer绑定；Task2沿该实际接口保留未改公式，不重复捕获或授予数学创建权限。Task1 fix1整体受理后才冻结Task2 BASE并派fresh writer。


## Task2 实测预算裁定

Ruling: 本阶段 core main gzip 局部预算从98304调整为102400 bytes（100 KiB），主spec share-editor最终900 KiB硬门槛不变 — 实际全exports同参数产物100204，1230项全量通过；只读审查三处重复候选均属独立权限/capture闭包且无足够低风险删减，不为1900 bytes差额引入重构或删校验 — 成本为局部预算增加4096 bytes、当前较前置88537增加11667 bytes；原超限证据保留，不代表最终网页bundle已达标。
