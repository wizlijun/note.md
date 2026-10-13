# 共享编辑器现有动作的源码保存闭包

2026-10-14；正式执行计划。依据主 spec docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md §12.4/I7、§12.9。root已自审并确认，按用户持续实施授权直接执行；不用新worktree。

前置inline两Task及唯一final fix已受理，验证报告 docs/superpowers/reports/2026-10-14-shared-editor-inline-annotations-verification.md。
阶段BASE CORE f67e8d227492e943b9ee2d3cf46003c376200aea / HOST 22d3359e0a644e9ad92ecabe1fff9a3c2811bf7b，两仓已有main；installed精确CORE f67e8d227492e943b9ee2d3cf46003c376200aea，58dist/18JS/36exports/15DTS/19maps/97sources，core gzip100503。包锁/两仓各14语料不变。阶段局部gzip上限102400，最终网页900KiB不变，不预涨。

两Task顺序、每Task fresh唯一产品writer和独立combined审查。Task1修已知空定义段缺口，Task2完成已有数学消费者；Task2 BASE在Task1受理后重冻结，whole BASE不改。所有工具与后继候选只在 OWN .superpowers/sdd/2026-10-14-shared-editor-source-consumer-closure；前置6750份证据canonical归档已全部SHA验证，39项后继输入经SHA选择提取，前置own已仅定点清理。

## 全局约束
实际完整原Step/docs/prototype/apply/attrs/marks、同代capture、protected精确平移、失败原子与最终strict doc.eq不降。无第二parser/生产试parse/serialize后diff/公开authority/第二raw账本。普通inline窄写未触raw，真实结构动作沿已批准ledger可规范已触root、根外raw不变。三旧empty guards保留。未知混合整体拒绝。
无新UI、schema、依赖或服务；不读.env/装依赖/开worktree/动stash及无关文件。每pnpm带pnpm_config_verify_deps_before_run=false，每gate完整记录且意外失败停止依赖。command细节遵OWN/common-execution.md。
测试独立字面expected先核实际PM，不调用serializer生成；原断言不迁移，除Task1已明确临时negative→承诺positive。Task1仅必要覆盖，Task2聚合全量；精确commit→committed-only原子安装→真实HOST消费者→installed闭包。root最终Svelte/fingerprint一次，唯一whole-range；前置不宣称UI/IME/发行完成。

## Task 1：definition-only 容器的真实空段 materialization

成功标准：打开仅空引用段与 protected definition 的文档，在现有空段输入首字成功；删除唯一批注后继续输入同样成功，未改定义 bytes 和语义不变。

独立 root 诊断（当前 CORE f67e8d227492e943b9ee2d3cf46003c376200aea）：
- raw `>\n> [r]: /u\n`，PM doc=blockquote(paragraph())，首字 Z@2。
- capturedEmptyBodies 有实际 inline fact，range[1,1]、before/after空串，并非 missing fact。
- prepareEmptyBodyTransaction 生成仅 insert Z@raw1，最终 semantic-mismatch。
- 独立 expected `>Z\n>\n> [r]: /u\n` 已先证明 strict doc.eq；定义原[2,12)应整体右移3 bytes（插入 Z + LF + >）。
- 原因：close===index+1 的 baseline emptyInline 注册早于 protected 相邻边界 materialization；touchesDefinition 的 skip 未把实际分隔要求带回 baseline fact。

最小实现：在 markdown.ts 现有 actual container observer 中，给实际 baseline empty place补充已由真实 definition/blank/prefix/EOL证明的必要分隔信息；优先复用现有 EmptyPlace（nested-blank 或 inline before/after）及 source-empty-body 配方，不引入 raw扫描推断、第二 parser、公开authority/空段重复发射。若无事实足以证明，继续拒绝，不能候选枚举或 root serialize/diff。严格保持 protected 定义全部 bytes、原Step链/doc.eq及失败原子性。

允许 CORE 产品 markdown.ts；只有 actual fact形状/既有配方无法表达时才精确修改 source-empty-body.ts，先给原因。现有 source-structure/source-file-cache/source-ownership不动。测试 source-empty-cache.spec.ts、source-annotation-producer.spec.ts；HOST source-inline-producer.test.ts、source-annotation-producer.test.ts。两仓 CHANGELOG，与验证后 CORE dist。

步骤：
- [ ] 加原始文档首字和 marked/unmarked point 删除→同session首字→下一字的真实 RED；独立字面 expected 与 protected 精确平移。
- [ ] 实际observer最小修复；覆盖 LF/CRLF/BOM、quote/list/quote-list 中实际可表达相同shape，重复定义/非相邻定义、额外真实空段、不触定义。无效fixture先核 parse目标，不能猜前缀。
- [ ] capture/replay/new-session/三代 cache后首字与第二字；无变化 root/定义 bytes不变、foreign facts/伪Step/跨prefix仍拒绝。旧正反例不迁移。将 inline阶段该具名临时负例改回所承诺positive（唯一允许迁移）。
- [ ] CORE empty-cache/annotation/inline-cache/inline-recipe/empty-input/source-block-fidelity等实际受影响 suites及production+纳入测试strict。CORE build/artifacts≤102400，精确commit，受控committed安装。
- [ ] HOST两相关+source-block-fidelity suites与严格types，精确commit/installed闭包。新变化前旧full不外推。fresh combined Task review。
- [ ] 最终 report真实运行与限制；后继 Task 2接续新的精确 BASE。

先不做原生 UI，本 Task证明 source producer与installed消费者；bindings真实mount与统一发布仍整体必做。


## Task 2：既有数学 consumer 保存闭包

### 文件责任与接口

**CORE产品允许修改：**

| 文件 | 最小责任 |
|---|---|
| `src/commands.ts` | 仅 insertMathBlock 取 `state.schema.nodes.math_block`；既有fallback分支保留，其它命令不动。 |
| `src/markdown.ts` | 复用inline已交付的actual math_inline/math_inline_double完整atom occurrence capture、clone/replay/finalizer；仅必要的新math生成消费接缝；source-only canonical空 math_block输出`$$ $$`；默认serializer与parser规则不改。 |
| `src/source-inline-recipe.ts`（前置交付） | 消费actual body、retained/inserted、联合recipe；复用既有 math_inline 完整atom保留，补真实新atom的有限生成；拒绝其内部正文/attrs编辑。 |
| `src/source-structure.ts` | 复用完整ledger/claims；对canonical新空math输出和真实删除/替换旧独立math根增加受限math witness；不得将math token/type直接加入一般无条件白名单。 |
| `src/source-fidelity.ts` | 保持完整链审计后的分派；数学结构仍走结构入口；stable数学消费只走已受理inline recipe/preserving candidate，失败不落旧root renderer。 |

不改 schema/setup/InputRules/UI/nodeview/source-file-cache/source-content-trace，不新建第二producer模块。source-empty-body无需新增math_inline首字许可：真实数学输入规则的 before 已有`$x`，新math_block是结构slice；不能借本任务扩空inline atom范围。

**测试：** CORE新增 `src/__tests__/source-math-producer.spec.ts`、`src/__tests__/source-math-input.spec.ts`、`src/__tests__/source-math-cache.spec.ts`；HOST新增 `src/lib/share-merge/source-math-producer.test.ts`。复用前置 test utils/strict tsconfig，不复制旧suite。两仓CHANGELOG未发布条目；CORE已验证dist在最后单独精确提交。

**Consumes（inline已受理事实，Task2派发前按Task1新HEAD核对）：**

- 实際 `InlineRecipeFacts` 的 body/edge/critic事实、actual PM emission ordinal，同代captured getter；`InlinePiece {retained|inserted}` / BodyWork逐原Step映射与有限inline生成机制。
- `prepareInlineRecipe(base,tr,facts)` 的原范围审计后联合edits；原 ownership 与 `preparePreservingSourceCandidate` 严格actualprotected集合等价；前置 empty三态与placement（含nested-blank.leftSeparator）。
- 现有 `applyStructuralTransaction(base,tr,render,rootHasClosedFences)`、create/advance/finishLedger、makeRecipe/verifyRecipe；不导出内部ledger供调用者伪造。

**既有内部合同（已按inline Task2工作源码定点核对，最终SHA仍待整体受理）：**

前置已实现 `InlineAtomOccurrence {body,pmFrom,pmTo,sourceFrom,sourceTo,node:PmNode}`，由 `InlineRecipeFacts.atoms` 持有；真实 math_inline/math_inline_double 规则捕获完整raw，clone/replay/PM emission/finalizer绑定，同代 getter 严格验证。它同时承载readonly hardbreak/footnote/point事实。不得新增第二个 MathInlineOccurrence/math 数组、重复token捕获或重复payload账本。

本Task只为实际闭合Replace slice中新math_inline提供有限生成，并在Unit/原Step链映射中保留整个nodeSize的发生位置；继续由实际node及全部attrs/marks/content核验。旧single/double dollar occurrence原raw保留；其子text无可编辑TextSourceSpan。新增完整math来源是原始slice，不由旧atom事实赋权限；空inline atom、内部math text mark/Replace、任意math attrs变化继续拒绝。删除旧完整inline数学必须另有整个实际occurrence覆盖证明；不得删除partial内部payload。

结构math witness留在source-structure内部，在真实全链上建立并验证，不用Transaction meta。建议最小判定：

1. new math_block只认当前schema节点、attrs严格为默认且value===''、无children/marks；来自实际ReplaceStep block slice，或原链 delete字面`$$`后真实ReplaceAroundStep将同一空paragraph变为空math的gap=0转换。完整原Step/docs仍原样审计；不能提交合成单Step。
2. 对嵌套新math也审计上述条件，不能只检查rendered顶层last.type；旧其它节点/attrs/marks变化继续走原结构范围guard。
3. `closed-literal`输出新允许项仅上述已证canonical空math。旧code/list-boundary特例原样保持。
4. 如新插入的原选区完全删除/替换既有顶层math：旧root须同代实际捕获tokenType==='math_block'、单child、实际math_block，原Step完整覆盖整个occurrence且不保留其payload gap；该witness才允许该origin参与删除/替换。拒绝旧math的AttrStep、部分内部Replace、保留payload的setNodeMarkup；不新增math_block_eqno通行证。原独立protected与closed guard不删。
5. 新旧root资格与new output许可均须先于相应serializer执行；最后依旧verifyRecipe与严格candidate。仅已有unsupported旧公式操作不通过，不能由“math出现过”广泛授权。

旧数学根完全未触时不进入renderer，保留raw；普通source文本LaTeX修改不经过上述structural witness。结构触根含复杂原数学若renderer无法strict恢复，按原规则全拒绝并明确限制，不新增没有consumer的payload编辑。

### 2.1 先固定真实 RED 与完整 expected

- [ ] 重核正式BASE与installed基线；把设计笔记五个探针结果作为历史事实，不直接计为新Task测试。先写以下CORE测试再跑targeted RED；HOST真实消费者测试同步写但待committed安装验证。

`source-math-producer.spec.ts`核心RED（前置utils真实名称正式冻结时映射）：

```ts
import {it,expect} from 'vitest';
import {EditorState,TextSelection,NodeSelection,type Transaction} from 'prosemirror-state';
import {ReplaceStep} from 'prosemirror-transform';
import {parseMarkdown} from '../markdown';
import {insertMathBlock} from '../commands';
import {applySourceBlockTransaction} from '../source-fidelity';
import {open,pos} from './source-inline-test-utils';

function inserted(raw:string,from:number,to=from){
 const b=open(raw),state=EditorState.create({doc:b.doc,
  selection:TextSelection.create(b.doc,from,to)});let tr:Transaction|undefined;
 expect(insertMathBlock(state,t=>{tr=t})).toBe(true);
 if(!tr)throw Error('missing dispatch');
 expect(tr.doc.eq(b.doc)).toBe(false);
 let count=0;tr.doc.descendants(n=>{if(n.type.name==='math_block')count++});
 expect(count).toBeGreaterThan(0);
 return {b,tr};
}
function saved(raw:string,from:number,to:number,expected:string){
 const {b,tr}=inserted(raw,from,to);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);
 if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe(expected);expect(r.session.doc.eq(tr.doc)).toBe(true);
 expect(b.source).toBe(raw);return {b,tr,r};
}
it('empty block command produces a real serializable math node',()=>{
 const {tr}=saved('',1,1,'$$ $$');
 expect(tr.steps).toHaveLength(1);
 expect(Object.getPrototypeOf(tr.steps[0]!)).toBe(ReplaceStep.prototype);
 expect(tr.doc.firstChild!.type.name).toBe('math_block');
 expect(tr.doc.firstChild!.attrs.value).toBe('');
 expect(parseMarkdown('$$ $$').eq(tr.doc)).toBe(true);
});
it('mid-paragraph block insertion consumes the actual open slice',()=>{
 const {tr}=saved('A __Keep__ B\n',2,2,'A\n\n$$ $$\n\n&#32;**Keep** B\n');
 const step=tr.steps[0] as ReplaceStep;
 expect([step.from,step.to,step.slice.openStart,step.slice.openEnd]).toEqual([2,2,1,1]);
 expect(tr.doc.child(2).textContent).toBe(' Keep B');
});
it('selected text is replaced without losing remaining leading space',()=>{
 saved('A __Keep__ B\n',1,2,'$$ $$\n\n&#32;**Keep** B\n');
});
it('block insertion preserves every outside root byte',()=>{
 const raw='\uFEFFBefore __raw__\r\n\r\nAB\r\n\r\nTail _raw_',doc=open(raw).doc;
 const at=pos(doc,[1],1);expect(doc.resolve(at).parent.textContent).toBe('AB');
 saved(raw,at,at,'\uFEFFBefore __raw__\r\n\r\nA\n\n$$ $$\n\nB\r\n\r\nTail _raw_');
});
it('nested empty block does not manufacture greater-than payload',()=>{
 saved('> __Keep__ AB\n',8,8,'> **Keep** A\n>\n> $$ $$\n>\n> B\n');
});
it('replacing an existing complete math occurrence is a structural replacement',()=>{
 const b=open('$$\nx\n$$\n\nTail __raw__\n');
 const state=EditorState.create({doc:b.doc,selection:NodeSelection.create(b.doc,0)});
 let tr:Transaction|undefined;insertMathBlock(state,t=>{tr=t});if(!tr)throw Error('dispatch');
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe('$$ $$\n\nTail __raw__\n');
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(b.source).toBe('$$\nx\n$$\n\nTail __raw__\n');
});
```

BOM案例以实际PM path计算位置并先断言parent；其 expected 故意区分新生成结构LF与原terminal CRLF，遵循原结构约定；如既有renderer的已批准EOL合同不同，root先按真实ledger冻结expected，不弱化根外字节/目标doc.eq。其它源码expected是本候选指定目标，尚未跑RED/GREEN。

`source-math-input.spec.ts`使用真实createEditor，而非直接InputRule.handler：

```ts
// @vitest-environment happy-dom
import {it,expect} from 'vitest';
import {EditorState,TextSelection,type Transaction} from 'prosemirror-state';
import {ReplaceStep,ReplaceAroundStep} from 'prosemirror-transform';
import {createEditor} from '../setup';
import {BrowserMediaResolver} from '../adapters/browser-media-resolver';
import {createSourceSession,applySourceBlockTransaction} from '../source-fidelity';
import {pos} from './source-inline-test-utils';
async function input(raw:string,path:readonly number[],offset:number,text:string){
 const container=document.createElement('div');document.body.append(container);
 const editor=await createEditor({container,initialContent:raw,mediaResolver:new BrowserMediaResolver()});
 try{
  const o=createSourceSession(raw,editor.view.state.schema);if(!o.ok)throw Error(o.reason);
  const b=o.session,at=pos(b.doc,path,offset);
  editor.view.updateState(EditorState.create({doc:b.doc,plugins:editor.view.state.plugins,
   selection:TextSelection.create(b.doc,at)}));
  const seen:Transaction[]=[];
  editor.view.setProps({dispatchTransaction(tr){seen.push(tr);editor.view.updateState(editor.view.state.apply(tr))}});
  const handled=editor.view.someProp('handleTextInput',f=>f(editor.view,at,at,text,
   ()=>editor.view.state.tr.insertText(text,at)));
  expect(handled).toBe(true);expect(seen).toHaveLength(1);
  return {b,tr:seen[0]!};
 }finally{editor.destroy();container.remove()}
}
it('real dollar-dollar-space retains both original steps',async()=>{
 const {b,tr}=await input('$$',[0],2,' ');
 expect(tr.steps.map(s=>Object.getPrototypeOf(s))).toEqual([ReplaceStep.prototype,ReplaceAroundStep.prototype]);
 const first=tr.steps[0] as ReplaceStep,last=tr.steps[1] as ReplaceAroundStep;
 expect([first.from,first.to,last.from,last.to,last.gapFrom,last.gapTo,last.insert]).toEqual([1,3,0,2,1,1,1]);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe('$$ $$');expect(r.session.doc.eq(tr.doc)).toBe(true);
});
it.each([
 ['__Keep__ $x',[0],7,'__Keep__ $x$'],
 ['> __Keep__ $x\n',[0,0],7,'> __Keep__ $x$\n'],
 ['- __Keep__ $x\n',[0,0,0],7,'- __Keep__ $x$\n'],
 ['| H |\n| --- |\n| __Keep__ $x |\n',[0,1,0,0],7,'| H |\n| --- |\n| __Keep__ $x$ |\n'],
 ['> [r]: /u\n>\n> __Keep__ $x\n',[0,0],7,'> [r]: /u\n>\n> __Keep__ $x$\n'],
] as const)('actual inline math preserves raw %j',async(raw,path,offset,expected)=>{
 const {b,tr}=await input(raw,path,offset,'$');
 expect(tr.steps).toHaveLength(1);expect(Object.getPrototypeOf(tr.steps[0]!)).toBe(ReplaceStep.prototype);
 const step=tr.steps[0] as ReplaceStep;
 expect(step.slice.content.firstChild!.type.name).toBe('math_inline');
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.mode).not.toBe('root-render');expect(r.session.source).toBe(expected);
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(b.source).toBe(raw);
 // 本次唯一syntax替换不包含旧__Keep__；可以替换原$x为$x$，不要求伪造只插最后$的Step。
 expect(r.edits.every(e=>!b.source.slice(e.from,e.to).includes('__Keep__'))).toBe(true);
});
```

再补同 helper 的 heading、BOM/CRLF、含两个旧公式的重复occurrence、table `$a|b$` 新内容编码和quote-list实际路径；InputRule并非所有schema位置都允许block，用真实canReplaceWith结果区分没有dispatch与producer拒绝，不能把table不允许math_block藏成source成功。新inline数学与后续相邻文本修改分两次session，前一次保留原 __Keep__，后一次保留新/旧全部数学字节。

- [ ] RED命令（root的新recorded runner，所有pnpm禁verify-deps副作用）：

```sh
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-math-producer.spec.ts src/__tests__/source-math-input.spec.ts
```

预期旧baseline block返回unsupported、inline实际ok却raw不等/old root-render；这是两种RED。先排除PM路径、module-schema、fixture语义错误，再实现。以上代码未执行，不报通过数量。

### 2.2 实现窄生产路径

- [ ] commands.ts只改insertMathBlock的schema来源；在CORE用createSchema新instance和默认state各验实际node type identity；HOST两package入口另验。
- [ ] markdown.ts source-only math_block renderer对canonical空node写`$$ $$`并closeBlock。默认serializer保持；不改用户既有 raw。非canonical block（内容children、附加attrs/marks）不因该函数获得新权限。已有writeSourceText负责拆段边界空格，不新建文本补偿器。
- [ ] source-structure内部按上述witness加入窄origin/output准入，保留原全部Step推进与claims/protected。`$$ ` delete+ReplaceAround是合法结构链，不给empty inline unsupported翻案。不接任意math AttrStep。
- [ ] 复用已有actual math规则的readonly atom capture；先核其真实SourceTrace、whole PM occurrence与同代绑定满足本Task消费，原则上不改这一已验链。不新增math子text span或在missing fact后fallback。
- [ ] 直接消费前置cloneTokenBatch/rawDelta/replay/PM emission/finalizer的既有atoms闭包；新math成功后由正常candidate capture建立下一代事实。foreign仍走verified factory，不接受caller追加fact；新增测试验证而不重复实现。
- [ ] 复用前置retained/inserted event recipe：retained math whole raw复制；被原Step完整删除则删该occurrence；新math从实际slice输出`$...$`，仅该片段执行table转义。只允许完整atom，child内部mark/Replace终态拒绝；不调用serializeSourceInlineBody整body，更不整root后diff。
- [ ] 保留跨body的联合atomic commit：所有参与body都获同代authority且可表达才形成一个candidate；未支持mixed不能先保存部分body或退回root-render。最终strict doc.eq与actualprotected精确平移仍只有一个确定candidate，无生产probe。

### 2.3 权限、缓存与失败恢复（不复制原suite）

- [ ] 新math-cache suite：full capture→三次replay后whole atom raw/PM occurrence一致；前方edit导致rawDelta/lineDelta后再执行真实InputRule；同文公式只改选中body，旧single/double-dollar写法保持；reference环境重放与nested definition仍完整平移；合法foreign正例、copied layout/mismatched generation/tampered public facts负例；失败后合法请求成功。
- [ ] 原范围负例：同代InlineAtomOccurrence不存在、错body、错parent、超范围/raw crossing、surrogate/CRLF拆分、fake Step prototype/标准Step subclass/toJSON伪装、缺/错tr.docs；在生成前拒绝，无renderer授权泄漏。
- [ ] mixed原子负例：沿前置真实多body构造，一body合法partial strong，另一body对已存在math_inline子text加mark；或者合法新math与不支持atom同时进入same transaction。结果失败，base source/doc/revision不变；不缩小原Step范围再授权。前置对应math内部负例不改positive。
- [ ] block负例：新math非默认attrs/带children/非空value的手工slice、旧math setNodeMarkup/AttrStep、原范围覆盖protected definition、公式中途删除/跨不支持root混合，全部保留严格拒绝。已完整选中旧math的替换positive与内部attrs编辑negative必须分开。
- [ ] 原三旧empty guards保持原断言，block InputRule不可借修改empty applicability而通过；测试原empty-marked/note_anchor能力不退化。两处既有结构protected guard原样跑；ordinary inline在含nested definition的body内可以preserving保存，不能混淆成允许结构重渲染definition根。
- [ ] selection-only与相邻raw：无doc Step的旧公式selection dispatch返回unchanged、零edits/revision；实际createEditor点击行为不含payload写。公式邻接普通字符改动独立expected，保持旧公式raw、__Keep__和根外bytes。此处DOM单元检查并不等于真实WebKit点击验收。

### 2.4 GREEN、类型、构建及安装顺序

- [ ] 先仅跑新3 suites取得本Task RED→GREEN、CORE typecheck、新测试严格tsconfig（root生成在本任务OWN）。再一次性跑受影响现有 inline/annotation/inputrules/roundtrip/math/structure/empty/cache回归，列表按冻结BASE实际文件名核；不重复无变化suite。
- [ ] source/tests/CORE CHANGELOG通过精确审查后，一次聚合CORE全量与build，核全部package exports JS/DTS/maps/embedded源码、gzip≤正式冻结预算、包锁与fixture SHA；可一次精确提交已验证source+dist完整快照。若因实施需要先source commit，明确dist尚未更新不能安装，待最终dist commit才安装。如超预算，root先根据实测改实现，不预涨。
- [ ] 只安装已提交CORE dist（沿root已有host-sync机制、新OWN证据，不读.env）；不install mutable dirty CORE。核installed所有exports字节对应committed dist、精确commit，不只看版本号。
- [ ] HOST消费者测试使用真实 `@moraya/core` installed，以下两入口必须都生成实际数学节点且保存正确：

```ts
import {it,expect} from 'vitest';
import {EditorState,TextSelection,type Transaction} from 'prosemirror-state';
import {createSourceSession,createSchema,applySourceBlockTransaction,
 insertMathBlock as rootCommand} from '@moraya/core';
import {insertMathBlock as subpathCommand} from '@moraya/core/commands';
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver';
it.each([rootCommand,subpathCommand])('installed command uses the actual state schema',command=>{
 for(const schema of [undefined,createSchema({mediaResolver:new BrowserMediaResolver()})]){
  const o=createSourceSession('',schema);if(!o.ok)throw Error(o.reason);const b=o.session;
  const state=EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,1)});
  let tr:Transaction|undefined;expect(command(state,t=>{tr=t})).toBe(true);if(!tr)throw Error('dispatch');
  expect(tr.steps.length).toBeGreaterThan(0);
  expect(tr.doc.firstChild!.type).toBe(state.schema.nodes.math_block);
  expect(tr.doc.firstChild!.attrs.value).toBe('');
  expect(tr.doc.eq(b.doc)).toBe(false);
  const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
  expect(r.session.source).toBe('$$ $$');expect(r.session.doc.eq(tr.doc)).toBe(true);
 }
});
```

HOST再用实际 `insertAtom(view,'math_block',{value:''})`、slash math条目.execute与installed createEditor InputRules各产生真实事务，验证上述独立raw/doc结果。slash条目execute不是菜单事件全链；旧UI先删slash再execute的组合原子性留给bindings。CmdShiftM当前handler在RichEditor组件内，不能把手写等价tr称为真实按键验收；本Task核其共享schema动作，bindings/delivery跑真实事件。

- [ ] HOST的实际installed test→相关既有source consumers→完整测试/type检查→空envDir既有host build→check:editor-kit；root最终统一Svelte（不writer重复）。继续沿前置原14fixtures/manifest、两仓包锁完整bytes、前后tracked指纹、main gzip预算与全部export闭包门槛。所有命令新OWN记录完整argv/cwd/stdout/stderr/exit/toolmetadata。
- [ ] HOST新测试/CHANGELOG精确commit，最终报告双HEAD、source/dist/installed对应、哪次全量对应哪个SHA。修订后只有targeted时如实区分，不冒称全量已重跑。一个独立Task完成其审查与结论；root后续正式review，不在本候选阶段增plan reviewer。

### 2.5 交接与验收边界

本Task完成条件：真实两类InputRules与root/subpath命令生成的实际math可经source producer保存；stable inline同body __Keep__/旧公式raw不变；结构命令实际目标eq且原权限/raw根外不降；新Task RED/GREEN、committed artifacts、HOST installed证据完整。不是完整分享编辑器交付。

| 后继 owner | 必须消费/验收 |
|---|---|
| bindings | 用同一file owner接 /math、context math、CmdShiftM、默认InputRules；组合collector保留全部原Step/docs，slash删除+命令失败时全部恢复，不能先安装删除；unsupported混合无history/observer/save副作用。 |
| bindings | 已有Source文本改inline/block LaTeX→Rich显示→undo/redo→save/reopen；同一revision/history/selection owner；不要新增Rich公式正文UI。selection-only点击零raw。 |
| delivery | native与Web真实菜单/键盘/点击/Source↔Rich端到端，§12.4三次零diff与改一字一个hunk；KaTeX字体、主题、CSP/IIFE离线资源闭包。各平台真实IME按总矩阵，合成事件不替代。 |

前置数学默认回归、DOM createEditor、命令return true或producerok均不能单独把这些行标绿。已触结构root会规范化其源码；普通inline转换绝不借此规范化旧段落。未支持输入的具体形状在报告列出，而不是隐藏菜单或省略能力矩阵。

## 阶段完成后继续
bindings/history四Task→网页E1–E3/桌面E4八Task→真实主题/图表/IME与免费WorkerCPU→所有未发布宿主/插件/Worker统一发行及公网验签。原KaTeX、CSS/teardown、Svelte/Vite诊断保留具名triage，不通过静音完成。

Ruling: Task1无空格空列表marker同样须支持definition邻接首字；在真实list baseline emptyInline、before恰空格、range末端与actual EOL起点相等、protected definition起点恰EOL末端且actual read.prefix存在时，允许仅为既有inline.after生成actual EOL+continuation prefix，保留原before — t1-no-space-actual-evidence已证明两独立expected strict等于目标；read.e/body与真实EOL/definition边界可完整认证，没有owned blank并不等于不能表达 — 成本是新增必要separator bytes与既有列表padding，定义原bytes保持精确平移；不扫描raw猜prefix、不改EmptyPlace公开shape、source-empty-body或结构权限。须两例真实RED→GREEN、LF/CRLF/BOM及replay/连续输入与不邻接反例；不能永久拒绝这两个已有合法shape。

Ruling: Task2示例createSchema调用更正为实际必须的config，注入new BrowserMediaResolver()并从已有browser-media-resolver子入口导入 — t2-core-red-1有一条fixture在产品producer之前即因缺config失败，实际createSchema(config:SchemaConfig)不可零参数 — 成本仅测试fixture和计划示例修正，无产品API/类型放宽；保留首次14个真实功能RED与这一环境/fixture错误分列，另名运行完整合法RED。

Ruling: Task2完成full/build/artifact后可一次精确source+dist提交，取代机械要求先source后dist两commit — 验证与committed-only安装顺序不变，单快照减少未构建中间HEAD误用 — 成本仅提交粒度变化，不减少任何gate；若先source提交仍禁止提前安装。

Ruling: source-inline-recipe.spec.ts 的 fix1 unchanged math grants no edit or selected atom mark permission 仅 replaced 分支改为具名完整occurrence替换正例；internal局部payload Replace、selected atom mark两个负例原样保留 — Task2已准许完整旧occurrence删除和原closed slice canonical新math生成，实际完整替换同时满足两者，不应为保旧能力白名单负例增加“同一步删旧并插新就拒绝”的特殊限制；root-whole-math-replacement-expected独立证明原raw Alpha $x$ Beta LF、原AddMark1..3 + Replace7..10的完整expected **Al**pha $y$ Beta LF严格等于原tr.doc — 成本是旧全atom替换从拒绝变成功，只限actual whole occurrence覆盖/新canonical slice/原链/最终strict同受理范围，无内部公式TextSourceSpan、无attrs编辑、新UI或meta授权。正例须明确完整expected、两个strong窄insert与一个wholemath窄replace、base和protected不变；未选公式raw与mixed unsupported原子失败保持。不允许据此迁移其它旧负例。
