# 共享编辑器结构来源事务实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 每任务先 RED 后实现与独立审查；单一产品 writer。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.4/I7 及用户已批准共享保真前置、网页与桌面协作。

**Tech Stack:** 现有 TypeScript、ProseMirror、markdown-it、Vitest、tsup、Vite/Kit；不升级依赖。

2026-10-13；root 已完整阅读 428 行候选及实际 core 稳定路径后修订采纳。本计划未执行，不预填通过。当前已提交依赖 core `f62d4dcfa32e21d019f0f3fe9703c3d4aa6d8c39`、host `f11ad5db7c846fd3831275c322022abdb344b293`；capture-layout 唯一最终审查与证据闭包完成后才 dispatch 本计划。若前置最终修复改变 SHA，root 在 ledger/brief 记录实际已受理基线，不消费 dirty。自审表见 `docs/superpowers/reports/2026-10-13-structural-source-plan-preflight.md`。

**目标：**在现有 `applySourceBlockTransaction` 内交付真实结构事务的有限来源账本和局部源码配方，使普通插删/Enter/合并、列表/引用结构和可持久化表格命令产生严格可回读的局部 edits。结果继续是现有 `SourceBlockResult`、`SourceRoot`、`SourceEdit` 形状，不新增业务节点永久 ID、全文 serializer/diff、通用 tree/history 框架或测试专用生产 API。

**范围诚实：**这两个任务完成结构来源能力的已证明子集。header-only/alignment/colwidth、相邻同类列表的词法隔离、未闭 fence 后边界插入、nested definition 片段 producer，以及 Source/history/Kit/native/IME 两端接线仍为必做前置/后续交付，不能用本次 fail-closed 边界宣布完整结构或 master §12.4/12.9 完成。见末节逐项验收。

## 开始前冻结与消费接口

- 受理依赖 core 已有 `session.layout.blankLines`、`fallback`、完整 roots/gaps、`protectedSources`。空白规则是 runs；纯空 source k 个完整 EOL→baseline+k；reference 占用行不产生空段。`SourceRoot` 完整 token.map 不裁短，root-tail units 不放回 gap。
- 当前正式 capture-layout Task 2 的 `serializeSourceRootMarkdown(doc)`、末 hardbreak capture、`endsInTerminalHardbreak` 与 R1 pre-serializer protected guard 已经 Task2 独立审查通过，仍须前置唯一 whole-range 最终审查受理。实施前必须记录 root 受理后的具体 core/host SHA；不可直接消费 writer dirty，不可把拟议 helper 当现成已验能力。若最终接口有差异，先修订本候选而非猜测。
- R1 protected source 检查仍在 serializer 调用之前及 edit 应用时独立执行。root 内存在 nested definition 时，本计划仍拒绝整个 root render；不把整个 raw root render 当作保留定义的片段 producer。不得重包 reference rule、重做 capture layout、增加 terminal raw 删除权限。
- core source-only serializer 可以扩展生产回调；legacy `serializeMarkdown/parseMarkdown` 默认语义不变。本计划不改 schema，不忽略 attrs/marks，不 canonicalize `language/colwidth` 以通过 guard。
- Task 1/2 都先 RED、生产实现、focused GREEN、完整门槛、core 源码+committed dist 提交、host 安装该提交 dist 后消费者测试+独立提交，最后独立审查。不能用单独探针任务替代产品增量。
- 消费本计划独立生成的共享执行门槛（完整脚本见下文，不运行旧 workspace 文件）： `run.py`、`core-artifacts.sh`、`core-stage-dist.sh`、`host-sync.sh`、`installed-corpus-audit.sh`。参数/输出接口：任务起点保存 core/host BASE；每命令唯一 S1/S2 label、argv/cwd/stdout/stderr/子进程 exit/tool session 与最终 exit；core-artifacts 证明所有 tracked dist、exports/DTS 可达闭包及 index gzip≤81920；host-sync 只复制 `git show CORE_HEAD:dist/...` 的已提交内容；obsolete DTS 只从 `git diff --no-renames --diff-filter=D BASE..HEAD -- dist` 且精确单层 hash `.d.ts` 白名单得出；installed audit 核验 actual realpath/SHA、无悬空声明、两仓 committed 原字节语料 SHA。不得清空安装目录、`git add .`、读取 `.env`、改依赖版本或安装。
- 所有临时文件唯一目录 `/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-structural-source/`；由 sdd-workspace 在前置闭包后解析新建。日志 S1/S2，各任务 browser/cache 分目录，不写旧/兄弟 workspace。必要研究只从已验 SHA 的前置 canonical archive 显式挑选提取，并保存来源 manifest/逐项 SHA；禁止直接访问旧工作区。

## 精确选择：N2 快路与结构慢路

先按 exact prototype 做一次事务种类分类。全是 N2 已支持的 mark / same-inline-parent closed-inline Replace，且 top-level markup 稳定者，继续原 `changedNaturalRoots` 一次 final 检查、原 sparse exact 和 root-render。不逐 mark step 初始化/重建全 ledger，不为既有长 mark 事务引入 S×N 深比较。

分类只检查 actual step 字段与 `tr.docs[i]` 对应局部结构，不能 try N2 renderer 失败后无限扩权。稳定路径被证明不适用才进入结构路径；unknown prototype 直接原子失败。结构路径标准步逐个 `step.apply(before)`，结果与 next `tr.docs[i+1]`/最终 `tr.doc` strict eq，schema一致、实际 before chain起点等于base。稳定快路严格保留既有 actual exact-prototype/range/tr.docs 局部 ownership 归纳与一次 final roots 检查；新增分类只能局部检查，不逐 step 重新 apply 或 whole-doc.eq，不建立/扫描全文 ledger。结构慢路才允许每步 replay/eq，诚实记录 O(S×N) 成本；不得借“PM 成本单列”把稳定 mark 路径性能回退隐藏掉。事务 docs 长度/schema 等局部完整性可检查；伪造中间 chain 的 replay 拒绝用结构路径负例证明，不通过对稳定路径逐步全文比较来凑测试。文档递归合法与 final attrs/marks equality 不减。

structure step 后不再要求 top child 数/markup 每步稳定。只有 final `tr.doc.eq(base.doc)` 且所有结构出生/删除/布局净效应消失，才返回原 session `unchanged`。纯插入即使 `changedRoots=[]` 也须提交 edits 和 revision+1。结果模式沿用 `root-render`。

## 有限内部类型与 helper 合同

只新增 core `src/source-structure.ts`，内部 import 用，不从 root index 导出。PM/raw offset 均 UTF-16；byte 检查用 UTF-8。下面类型是实施目标，不是当前已存在 API。

```ts
import type {Node as PMNode} from 'prosemirror-model'
import type {Transaction} from 'prosemirror-state'
import type {SourceSession} from './source-fidelity'
import type {SourceEdit} from './source-ownership'
type RawSpan = Readonly<{from:number;to:number}> // 原 source UTF-16
type PmSpan = Readonly<{from:number;to:number}> // 当前 step 前/后 PM位置
type ChildRange = Readonly<{from:number;to:number}> // top-child 半开索引
type Origin = {kind:'root';id:number}|{kind:'blank';id:number}|{kind:'fallback'}
type Ref = {kind:'base';origin:Origin}|{kind:'component';id:number}
type Lane = {ref:Ref;node:PMNode;from:number;to:number}
type Boundary =
 | {kind:'base';anchor:number;left?:Origin;right?:Origin;slotIds:number[]}
 | {kind:'inside-root';rootId:number}
 | {kind:'generated';component:number}
 | {kind:'tombstone';component:number;prior:Boundary}
type Birth = {step:number;ordinal:number;anchor:Boundary}
type StepWitness = {step:number;kind:'replace'|'around'|'mark'|'attr'|'node-mark';
 before:PmSpan;after:PmSpan;crossed:Boundary[]}
type Claim = RawSpan & (
 | {kind:'body';rootId:number;step:number}
 | {kind:'terminator';rootId:number;step:number} // 非终端 hardbreak atom 权限
 | {kind:'blank';unitId:number;step:number}
 | {kind:'separator';unitId:number;step:number}
 | {kind:'baseline-conversion';unitId:number;step:number;survivorChild:number}
 | {kind:'anchor';birth:Birth})
type Kept = RawSpan & {kind:'root'|'blank'|'protected'|'envelope';id:number}
type Piece = {kind:'raw';span:RawSpan;identity:Kept}|{kind:'generated';text:string}
type Component = {id:number;parent:number;origins:Origin[];births:Birth[];
 witnesses:StepWitness[];claims:Claim[];finalRuns:ChildRange[]}
type Ledger = {children:Lane[];boundaries:Boundary[];components:Component[]}
type Recipe = {claims:Claim[];kept:Kept[];pieces:Piece[];edits:SourceEdit[];
 changedRoots:number[]}
type Rendered = {text:string;terminal:'none'|'content-eol';
 family:'flow'|'table'|'closed-literal';eol:'\n'|'\r\n'|'\r'}
```

`baseline-conversion` 是本计划**root 明确采纳**的窄新合同：真实结构删除使某个 surviving empty 成为全文件 rawless baseline，需要消费该 empty 对应恰一完整 blank unit；不是删除此 surviving PM 节点，也不是任意 tail trimming。其 witness 必须指定真实删除 step、最终 surviving child 和实际 unit ID；只获该 unit 权限，所有 space/tab+完整 EOL一并消费，不切CRLF、不碰BOM/definition。没有这项合同，`A\n\n` 删除A后想保留一个空段无法在保留原 blank LF的同时成立：`\n` 会生成两个空段。root 采用唯一 typed baseline-conversion 例外；它属于真实结构删除造成的身份角色变化，不能推广到普通未触碰空段、separator 或任意 trim。风险/成本见本计划裁决。

核心 helpers 全部有单一生产调用者；实现按下列精确职责分开，不另加框架：

1. `classifyTransaction(base,tr):'stable'|'structural'`：exact prototype、字段整数/范围、same schema；DocAttr/custom subclass拒绝。ReplaceAround、结构 Replace、Attr/NodeMark进入structural。全N2兼容事务返回stable。
2. `createLedger(base)`：一次按真实 emission填children，`root`覆盖自己 child run，empty单位覆盖自己的真实 emission，fallback覆盖实际fallback；不允许重复/缺失owner。boundary按raw排序的根/blank槽定位；同一root多发射child之间为inside-root。无 raw blank 权限的 fallback只有anchor。
3. `stepWindow(before,step)`：Replace/ReplaceAround用外半开[from,to)，边界起点不含左child、边界终点不含右child；零宽root boundary→空window，零宽inside child→整个child。读取该step自己的map将完整window L/R以assoc -1/+1映到after；after边界必须精确落在top child边界。ReplaceAround的gapFrom/gapTo验证包含关系，但不从window减去gap owners。不得逆映射猜owner。
4. `advanceLedger(ledger,before,after,step,index)`：窗口前后child数量/次序/eq须符合标准step局部不变性（只验局部边界与搬运的引用，最终一次全ledger核对）；窗口内按实际origins及跨越boundary union components。同root多child共component；marks/attrs不因跨range把各owner合并。插入inside-root/generated加入已有component，base boundary纯插入另建birth component；删除保留tombstone，下步同点insert继承之。后续新节点编辑直接读lane.ref。
5. `finishLedger(base,tr,ledger)`：一次遍历finalchildren收集runs、untouchedroot eq；origins集合按实际触碰，不用min/max roots。两个不相邻step保持两个component。出生又消失且无base claim者消去。共享raw anchor的birth最终按真实doc顺序合成一个insert；不可依赖step编号排序替代实际最终顺序。
6. `partitionSlots(base)`：从layout记录和root tail分区，body/terminator/blank/protected/envelope互斥；见下一节。只建立有限数组，不重parse、不改capture。
7. `makeRecipe(base,ledger,slots,render)`：按下一节固定规则产生明确claims、kept identities、generated pieces，再导出edits。只serialize最终dirtycomponent，未触碰root/blank/protected直接raw引用。
8. `verifyRecipe(base,recipe)`：claims必须有step witness；kept身份恰一次且顺序不变、原bytes相同；edit每个非零raw字节均被claim覆盖或作为同位置raw kept piece显式复写（本版对protected严格不允许edit覆盖，故分离edits）；不允许锚点严格落protected内部；不切CRLF/surrogate/trace atomic。原root大范围并不覆盖其tail unit权限。
9. `applyRecipe(base,recipe)`：一次按source slices和sorted nonoverlapping edits拼接。最后同capture最多一次、doc.check+whole-all-attrs eq，成功重建session/layout且revision+1。exact失败候选最多一次额外capture，总≤2。unknown失败不生成邻居retry，无全文serializer。

`boundaryAt(doc,pos)`与`childWindow`的完整实现形状如下，防止zero-width或半开边界歧义：

```ts
function boundaryAt(doc:PMNode,pos:number):number|undefined {
 if(!Number.isInteger(pos)||pos<0||pos>doc.content.size)return undefined
 const p=doc.resolve(pos)
 return p.depth===0?p.index(0):undefined
}
function childWindow(doc:PMNode,from:number,to:number):ChildRange {
 if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>doc.content.size)
  throw new Error('unsupported-step')
 const a=doc.resolve(from),b=doc.resolve(to)
 if(from===to&&a.depth===0)return {from:a.index(0),to:a.index(0)}
 return {from:a.index(0),to:b.index(0)+(b.depth===0?0:1)}
}
function childOffsets(doc:PMNode):number[] {
 const offsets=[0];let pos=0
 doc.forEach(n=>{pos+=n.nodeSize;offsets.push(pos)})
 return offsets
}
// offsets在ledger初始化与实际splice更新；不得每个mark重建全文数组。
function assertChain(before:PMNode,after:PMNode,expected:PMNode):void {
 if(before.type.schema!==after.type.schema||!after.eq(expected))throw new Error('unsupported-step')
}
```

实现使用已有 `UnsupportedBlockTransaction` 同类内部错误映射，不将普通throw错误变成任意吞异常重试；上面helper中的Error须统一该类后接入。stepWindow还必须检查text surrogate边界、actual `step.apply` failed、标准ReplaceAround字段及合法after边界；不能只有这三个函数就声称权限实现完成。

## Source slot 配方：冻结到可逐字断言

### 1. 互斥分区

完整natural root仍为原 `[sourceFrom,sourceTo)`。对普通flow root（paragraph/heading/list/quote/table/hr）的结构recipe，`[sourceFrom,tailFrom)`是body；tail从原tailFrom起读**最多一个已知完整行终止符**（LF/CRLF/loneCR），其余完整blank units只按 `layout.blankLines` 定位。tail中无法被该单terminal或units/kept pieces精确覆盖的片段保留为envelope，不从whitespace regex授予删除权限。protected覆盖的root在renderer前拒绝。literal不能用flow尾算法；只在Task 2已证closed-literal生产合同内渲染，unclosed边界另列前置。

root-tail units先从root结构body声明里扣出；同一byte不能既body claim又blank claim。删除list只删除body+已证明terminal，不自动删除完整sourceTo；稳定N2仍用其既有完整tail复制逻辑，不加入blank renderer。这两条路径不能混用。

末hardbreak的terminal EOL若已由source-root serializer用作语义原子，不从本计划拿到独立“删末hardbreak raw”能力；整段被真正结构修改时仅使用受理的完整root renderer合同处理该root，无rawterminal deletion API。

### 2. 普通 run 配方

`run` 是按实际raw顺序连接两个词法实体（visible root或受保护reference）的有限空白段；每个run拥有有序blank units。只处理真实结构window触碰的root及其**紧邻外边界runs**，不按全文空白匹配寻找可删片段。所有未触碰语义空段保留原unit身份和bytes；新增empty各生成一完整EOL；删掉empty只claim其原unit。

所需separator数量直接复用capture runs规则：两侧都有visible root，或run紧邻reference→恰一separator；普通prefix/suffix→零separator。保留semantic empty units以后，从已获边界事件授权的原separator中取**incoming优先，其次raw最左**的一份作为新separator，其他已被真实join/delete跨越的separator可消费；缺少则生成一个。不能把存活empty单位抢作separator以省字节。任何unit角色转换必须另有typed witness（baseline例外见下）。

原root内容行终止符不算blank unit。存活且未改root的terminal原bytes保持；新增/重写root需要与后续内容分隔时由renderer声明是否已自带terminal，否则生成一个EOL。因此两个普通非空paragraph相邻需要“left内容terminal + run separator”，不是向任意字符串尾盲加两个LF。

- split一个root→最终多个节点：只claim原body；外侧tail与unit保留；内部新terminal/separator/empty units由finalchildren生成。
- join/wrap实际跨root边界：原body与实际跨越的separator可合入component；没进入PMwindow的empty单位保留，不因其位于raw包围区间而删除。
- 删除中间B，左右A/C存活：保留incoming A/B separator；消费B body/terminal和outgoing B/C separator。若中间有surviving empty，按final顺序把其原unit保留在新run，仍只保留一个separator。
- 删除首root：无surviving left时消费删除root body/terminal和不再需要的outgoing separator；BOM/envelope/protected以及empty units原样。
- 删除末root：新边界是suffix，不再需要incoming separator，因此消费它；保留末root后存活empty单位。不能无条件“永远留incoming”。
- 纯插入B于A/C：旧incoming run及其empty身份留在B之前，anchor取被插入右child对应body/blank slot起点；插入B与其新outgoing terminal+separator，A/C body不授权。连续同点birth最终合成唯一edit；零宽edit与该点删除claim合成一个replacement，不能输出两个有歧义的同点edit。
- EOF插入：不删除旧EOF bytes；若旧末root没有terminal，生成所需terminal；原suffix empty的左右位置由PM插入边界决定。prefix插入在BOM之后、实际第一个被插位置之前，不挪BOM。

**固定字节例**（`P('')`是empty，删除操作必须来自真实PM transaction）：

| base / 操作 | expected source | 精确权限 |
|---|---|---|
| `A\n\nB\n\nC` 删除B | `A\n\nC` | edit `[3,6)`→`''` |
| `A\n\nB` 删除A | `B` | `[0,3)`→`''` |
| `A\n\nB` 删除B | `A\n` | `[2,4)`→`''`；保留A原terminal |
| `A\n\nB\n\n` 删除B，保留末empty | `A\n\n` | `[2,5)`→`''`；末unit `[5,6)`原样 |
| `A\n\nB` 在两root间插P('') | `A\n\n\nB` | `[3,3)`→`'\n'` |
| `A\n\n\nB` 删除empty | `A\n\nB` | `[3,4)`→`''` |
| `A` EOF插empty | `A\n\n` | `[1,1)`→`'\n\n'` |
| `A\n` EOF插empty | `A\n\n` | `[2,2)`→`'\n'` |
| `A` prefix插empty | `\nA` | `[0,0)`→`'\n'` |
| `- A\n\n\nB` 删除empty | `- A\n\nB` | 只`[5,6)`；list owner仍原完整map |
| `- A\n\n\nB` 删除list保留empty和B | `\nB` | body+terminal `[0,4)`和separator `[4,5)`；保留empty`[5,6)` |
| `A\n\nC` 边界插B后同一tr改B为Bee | `A\n\nBee\n\nC` | 唯一`[3,3)`→`'Bee\n\n'`，changedRoots=[] |

### 3. 无natural root、baseline与reference-only

不能用“roots.length===0→所有unit都empty”计算。现有capture即使reference-only也产生一个fallback，然而其相邻blank仍按runs扣separator：`[ref]: /u\n\n`为fallback+一个separator，不是fallback+empty。必须消费实际layout.role，保留protected为词法实体。

- 全空初始source：已有fallback不持raw；Enter从一个fallback生成两个empty时插入一EOL。删除某真实empty仅消费其unit；删除fallback而保留其后的empty时，把第一个surviving empty转为fallback并恰消费其unit，其他units不变。若输入仅一个fallback且final等于base，返回unchanged。
- 最后一个真实root被删：先根据final doc的实际empty children选择唯一baseline身份，优先原fallback（若仍存活），否则final第一个surviving empty；有该empty unit则创建baseline-conversion claim消费它。final只有schema补的一个新empty时无需消费原unit。**不是随便消费raw第一行，separator永远不能借这条规则删。**
- `A\n\n` 删除A：存活empty原unit转fallback，root+terminal+该unit消去→`''`。`- A\n\n\n` 删除list：两个存活empty，第一个转fallback只消费 `[4,5)`，第二个 `[5,6)`保留→`'\n'`。带BOM/space/tab/CRLF同理，BOM逐字保留，conversion整行消费。
- reference-only具体正例：`A\n\n[ref]: /u\n\n` 删除A→`'\n[ref]: /u\n\n'`，两个原separator与definition均保留，新的fallback无raw；不能因为只有fallback就把definition清空。`A\n\n\n[ref]: /u\n\n` 删除A且保留一个empty→同样结果；消费的是原role=empty的第二份prefixblank，不是definition前第一separator。
- 删除文字root可能使两个原run在definition两侧/原root位置合并，重新分配separator时必须使用实体边界与原unit身份。非reference opaque剩余片段、generated-only layout、quote marker空行缺少此局部来源模型，保留具体拒绝和前置，不用最终eq来反授权。Task 1至少实现上面纯空与实际reference-only两组，不把所有“无root”一刀切。

### 4. EOL方向（root已冻结）

本计划冻结**所有新生成的语法EOL使用LF；所有kept raw EOL完全保留**。这符合现source-only serializer明确输出LF，避免未证明把literal text内部LF全局替换为CRLF/loneCR。混合换行合法，仍严格capture eq；不声称编辑后整owner保留原EOL风格。这不是对原件做换行归一；若以后要求生成语法继承风格，需要另写逐 generated-piece EOL 合同，不可 replace 整 renderer 字符串。本任务测试固定LF生成，CRLF原blank与tail不动。

## Task 1：普通结构事务、空段与baseline的真实局部编辑

**Files:** core 新 `src/source-structure.ts`、`src/__tests__/source-structure.spec.ts`；改 `src/source-fidelity.ts`；tracked dist。host 新 `src/lib/share-merge/source-structure.test.ts`。消费已受理capture Task2/R1接口；不改parser/schema/生产命令。

- [x] **S1.1 完整公共API测试helper和核心RED。** 下列 helpers 直接调用真实 PM，不导出生产内部账本；Task2 专用 imports 放在 Task2 文件；tests可另存fixture，但不能将expected计算自待测结果。

```ts
import {expect,it} from 'vitest'
import {EditorState,TextSelection,type Transaction,type Command} from 'prosemirror-state'
import {splitBlock,joinBackward} from 'prosemirror-commands'
import {createSourceSession,applySourceBlockTransaction} from '../source-fidelity'
function open(raw:string){const r=createSourceSession(raw);if(!r.ok)throw Error(r.reason);return r.session}
function state(b:ReturnType<typeof open>,from:number,to=from){
 return EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,from,to)})
}
function command(s:EditorState,cmd:Command):Transaction {
 let out:Transaction|undefined
 expect(cmd(s,tr=>{out=tr})).toBe(true)
 if(!out)throw Error('command did not dispatch')
 return out
}
function text(doc:EditorState['doc'],needle:string){
 let at=-1;doc.descendants((n,p)=>{if(at<0&&n.isText){const i=n.text!.indexOf(needle);if(i>=0)at=p+i}})
 if(at<0)throw Error('missing fixture text');return at
}
function accept(b:ReturnType<typeof open>,tr:Transaction,expected?:string){
 tr.doc.check();const before=JSON.stringify(b),r=applySourceBlockTransaction(b,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(JSON.stringify(b)).toBe(before);expect(r.session.doc.eq(tr.doc)).toBe(true)
 expect(open(r.session.source).doc.eq(tr.doc)).toBe(true)
 expect(r.session.revision).toBe(b.revision+1)
 if(expected!==undefined)expect(Buffer.from(r.session.source)).toEqual(Buffer.from(expected))
 let at=0;const parts:string[]=[]
 for(const e of r.edits){expect(e.from).toBeGreaterThanOrEqual(at);parts.push(b.source.slice(at,e.from),e.text);at=e.to}
 parts.push(b.source.slice(at));expect(parts.join('')).toBe(r.session.source)
 return r
}
function reject(b:ReturnType<typeof open>,tr:Transaction){
 const before=JSON.stringify(b),r=applySourceBlockTransaction(b,tr)
 expect(r.ok).toBe(false);expect(r).not.toHaveProperty('session');expect(JSON.stringify(b)).toBe(before)
}
function childPos(doc:EditorState['doc'],index:number){
 let pos=0;for(let i=0;i<index;i++)pos+=doc.child(i).nodeSize;return pos
}
function deleteChild(b:ReturnType<typeof open>,index:number){
 const p=childPos(b.doc,index);return EditorState.create({doc:b.doc}).tr.delete(p,p+b.doc.child(index).nodeSize)
}
it('splitBlock produces two children inside one raw owner',()=>{
 const b=open('HelloWorld\n\nTail __raw__\r\n')
 const tr=command(state(b,6),splitBlock),r=accept(b,tr,'Hello\n\nWorld\n\nTail __raw__\r\n')
 expect(r.changedRoots).toEqual([0]);expect(r.edits).toHaveLength(1)
 expect(r.edits[0]!.from).toBe(0);expect(r.edits[0]!.to).toBeLessThanOrEqual(b.roots[0]!.sourceTo)
})
it('real joinBackward consumes only crossed seam',()=>{
 const b=open('A\n\nB\n\nC __raw__'),tr=command(state(b,text(b.doc,'B')),joinBackward)
 const r=accept(b,tr,'AB\n\nC __raw__');expect(r.changedRoots).toEqual([0,1])
 expect(r.edits.every(e=>e.to<=b.roots[1]!.sourceTo)).toBe(true)
})
it.each([
 ['A\n\nB\n\nC',1,'A\n\nC'],['A\n\nB',0,'B'],['A\n\nB',1,'A\n'],
 ['A\n\nB\n\n',1,'A\n\n'],['A\n\n\nB',1,'A\n\nB'],
 ['- A\n\n\nB',1,'- A\n\nB'],['- A\n\n\nB',0,'\nB'],
 ['A\n\n',0,''],['- A\n\n\n',0,'\n'],
 ['\uFEFFA\r\n \t\r\n\t\r\n',0,'\uFEFF\t\r\n'],
 ['A\n\n[ref]: /u\n\n',0,'\n[ref]: /u\n\n'],
 ['A\n\n\n[ref]: /u\n\n',0,'\n[ref]: /u\n\n'],
] as const)('finite deletion %j',(raw,index,expected)=>{
 const b=open(raw);accept(b,deleteChild(b,index),expected)
})
it('boundary birth keeps changedRoots empty through later edit',()=>{
 const b=open('A\n\nC'),p=childPos(b.doc,1),tr=EditorState.create({doc:b.doc}).tr
 tr.insert(p,b.doc.type.schema.nodes.paragraph!.create(null,b.doc.type.schema.text('B')))
 tr.insertText('ee',p+2)
 const r=accept(b,tr,'A\n\nBee\n\nC')
 expect(r.changedRoots).toEqual([]);expect(r.edits).toEqual([{from:3,to:3,text:'Bee\n\n'}])
})
it('same-point births follow final order and produce one edit',()=>{
 const b=open('A\n\nC'),p=childPos(b.doc,1),tr=EditorState.create({doc:b.doc}).tr
 const paragraph=b.doc.type.schema.nodes.paragraph!,word=(s:string)=>paragraph.create(null,b.doc.type.schema.text(s))
 tr.insert(p,word('B'));tr.insert(p,word('X'))
 const r=accept(b,tr,'A\n\nX\n\nB\n\nC')
 expect(r.edits).toEqual([{from:3,to:3,text:'X\n\nB\n\n'}])
})
it('delete tombstone then insert stays at deleted owner',()=>{
 const b=open('A\n\nB\n\nC'),p=childPos(b.doc,1),tr=deleteChild(b,1)
 tr.insert(p,b.doc.type.schema.nodes.paragraph!.create(null,b.doc.type.schema.text('X')))
 const r=accept(b,tr,'A\n\nX\n\nC');expect(r.changedRoots).toEqual([1])
 expect(r.edits.every(e=>e.from>=3&&e.to<=6)).toBe(true)
})
it('empty document Enter has one generated blank unit',()=>{
 const b=open(''),tr=command(state(b,1),splitBlock),r=accept(b,tr,'\n')
 expect(r.changedRoots).toEqual([]);expect(r.session.layout.fallback).toBeDefined()
})
```

补充到同一RED文件、精确断言上述slot表所有插入行；surviving blank/unit bytes按原unit身份映射检查（conversion指定那一份是唯一例外）。真实baseline删除fixture `open('\n\n')` 删child0后应 `'\n'`。新节点insert→delete净零返回同session，revision不变。两个同文段落中只删其中一个，不按内容匹配身份；两处非相邻split的中间raw/gaps逐字保留、至少两条分离edits。

- [x] **S1.2 实现ledger与slot recipe。** 按上文类型和helper顺序写生产代码；source-fidelity引入结构分支但完整保留N2快路。结构第一版准入标准ReplaceStep（含split/join/open slice）、Add/RemoveMark；ReplaceAround/Attr暂由Task2补充。真实window外的stable origins在最终一次检查，不在每个mark对全文children做深eq。所有blank编辑来自layout unit，rawless fallback不伪造owner。
- [x] **S1.3 原子失败/性能回归。** 自定义Step伪造replace JSON、ReplaceStep subclass、结构慢路非法 tr.docs 链、局部 surrogate/CRLF切断、可复现的来源 record 冲突、protected 内 anchor 均拒绝且base不变。R1 guard用现有测试spy证serializer未被调用；不公开测试hook。沿用既有 actual addMark 12/24/48 访问计数断言，并补 80/160 的同类确定性计数；监控稳定路径不得逐步调用 PM whole-doc eq（可 spy Fragment.eq，区分单次 final 子节点比较），不只数 Node.child。另将一个固定 10k-root/100-mark 输入生成脚本/输入 SHA/BASE 模块 SHA 保存；对本任务冻结实际 BASE 与最终代码各一次相同输入，不反复追毫秒数字。结构 100 步另记 array splice/replay 的实际复杂度，不虚报 O(logN)。mock同模块实际capture/serializer调用边界记录预算（或测试framework模块spy），不加生产计数API。capture≤2、serializer输入仅dirtycomponent，无整doc输入。
- [x] **S1.4 core及installed host验证/提交。** host将本节helper import路径改为 `@moraya/core`，至少执行middle/prefix/suffix/delete-last-baseline、list-tail、purebirth+edit、两处非相邻split及已有中文一字1hunk；host不import sibling src。完整门槛通过后提交 `feat(core): preserve source slots across structural edits`；同步core已提交dist，host独立提交 `test(editor): verify installed structural source edits`。更新本任务report的真实SHA/退出码/覆盖边界，不先写通过。

## Task 2：真实容器/表格结构与局部片段表达

**Files:** core `src/source-structure.ts`、`src/source-fidelity.ts`、`src/markdown.ts` source-only renderer；新 `src/__tests__/source-structure-commands.spec.ts`、修改 `src/__tests__/source-structure.spec.ts`；tracked dist。host `src/lib/share-merge/source-structure.test.ts`、新 `src/editor-kit-v2/source-structure-commands.test.ts`。Task1已验收提交为输入。

- [x] **S2.1 actual commands RED，禁止手造“命令stepType”。** 复用完整 helper；Task2 文件另 import wrapIn/lift from prosemirror-commands、wrapInList/splitListItem/sinkListItem/liftListItem from prosemirror-schema-list、addRowAfter/addColumnAfter/deleteColumn from prosemirror-tables。以下是起始可执行 cases。

```ts
it('actual wrapIn uses ReplaceAround ownership',()=>{
 const b=open('A\n\nB\n\nTail __raw__'),tr=command(state(b,1,4),wrapIn(b.doc.type.schema.nodes.blockquote!))
 const r=accept(b,tr);expect(r.changedRoots).toEqual([0,1])
 expect(r.session.source.endsWith('\n\nTail __raw__')).toBe(true)
})
it('actual list wrap includes all steps in one preparation',()=>{
 const b=open('A\n\nB\n\nTail __raw__'),tr=command(state(b,1,4),wrapInList(b.doc.type.schema.nodes.bullet_list!))
 expect(tr.steps.length).toBeGreaterThan(1)
 const r=accept(b,tr);expect(r.changedRoots).toEqual([0,1]);expect(r.session.source.endsWith('\n\nTail __raw__')).toBe(true)
})
it('actual splitListItem leaves external blank units alone',()=>{
 const b=open('- AlphaBeta\n\n\nTail __raw__'),at=text(b.doc,'AlphaBeta')+5
 const tr=command(state(b,at),splitListItem(b.doc.type.schema.nodes.list_item!)),r=accept(b,tr)
 expect(r.changedRoots).toEqual([0]);expect(r.session.source.endsWith('\n\n\nTail __raw__')).toBe(true)
})
it('actual quote lift splits one owner into multiple roots',()=>{
 const b=open('> A\n>\n> B\n>\n> C\n\nTail __raw__'),p=text(b.doc,'B')
 const r=accept(b,command(state(b,p),lift));expect(r.changedRoots).toEqual([0])
 expect(r.session.source.endsWith('\n\nTail __raw__')).toBe(true)
})
it('actual table add row only renders its table',()=>{
 const b=open('| A | B |\n| --- | --- |\n| X | Y |\n\nTail __raw__')
 const r=accept(b,command(state(b,text(b.doc,'X')),addRowAfter))
 expect(r.changedRoots).toEqual([0]);expect(r.session.source.endsWith('\n\nTail __raw__')).toBe(true)
})
it('leading whitespace from real split remains actual text',()=>{
 const b=open('Hello world\n\nTail'),tr=command(state(b,6),splitBlock)
 const r=accept(b,tr);expect(r.session.source).toContain('&#32;world')
})
it('literal content LF and closing syntax LF are distinct',()=>{
 const b=open('```js\nA\n\n```\n\nTail __raw__'),tr=EditorState.create({doc:b.doc}).tr
 tr.insertText('B',text(b.doc,'A')+1)
 const r=accept(b,tr);expect(r.session.doc.child(0).textContent).toBe('AB\n')
 expect(r.session.source.endsWith('\n\nTail __raw__')).toBe(true)
})
```

同文件必须再写：actual sinkListItem / liftListItem、中间list lift→list/paragraph/list、ordered start attrs、task checked真实producer、多步split→编辑新右child→wrap、两处不相邻table add-row、add/delete-column、两个相同table仅改第二个、AttrStep代码language与Add/RemoveNodeMarkStep（有可表示marks则接受，不可表示attrs保持strict失败）。table已知不可持久化cases作为明确负例：right/center列addRowAfter未修producer前不得成功；header-only非法doc拒绝；colwidth写PM attrs不得忽略；selection-only next-cell无source revision。

host必须直接调用固定仓真实 `src/editor-kit-v2/commands.ts` 的 `executeEditorCommand(view,command)`，不复制命令实现、不从scratch“导出commandFor”。完整实际EditorView producer helper如下；它只证明实际producer和安装source API，不冒充尚未接线的UI source原子提交。当前table.command自身whole-table Replace仍只授权一个自然root。schemaidentity adapter只去已授权cdrBlockId，不能一起删table attrs。

```ts
import {EditorView} from 'prosemirror-view'
import {executeEditorCommand} from '../../editor-kit-v2/commands'
import type {EditorCommand} from '../../editor-kit-v2/contract'
function kitTransaction(s:EditorState,action:EditorCommand):Transaction {
 const mount=document.createElement('div');document.body.appendChild(mount)
 let captured:Transaction|undefined
 const view:EditorView=new EditorView(mount,{state:s,dispatchTransaction(tr:Transaction){captured=tr;view.updateState(view.state.apply(tr))}})
 try {
  expect(executeEditorCommand(view,action)).toBe(true)
  if(!captured)throw Error('Kit command did not dispatch')
  return captured
 }finally{view.destroy();mount.remove()}
}
it('installed source accepts actual Kit table row producer',()=>{
 const b=open('| A | B |\n| --- | --- |\n| X | Y |\n\nTail __raw__')
 const tr=kitTransaction(state(b,text(b.doc,'X')),{kind:'table.add-row'})
 const r=accept(b,tr);expect(r.changedRoots).toEqual([0])
 expect(r.session.source.endsWith('\n\nTail __raw__')).toBe(true)
})
```

新文件位于 `src/editor-kit-v2/` 时上面相对import改为 `./commands` / `./contract`；不要为测试移动生产文件。

- [x] **S2.2 ReplaceAround / Attr / NodeMark小步扩展。** exact prototypes只加已安装transform标准类；ReplaceAround验证外范围、gap合法性、actual apply chain；保留内容gap仍归窗口origins，不当SourceGap；Attr/NodeMark取`nodeAt(pos)`及真实祖先owner，不给相邻root。DocAttr仍拒绝。mark从每个实际变化owner独立dirty，不把跨长range未变化code并入component。
- [x] **S2.3 source-only renderer片段合同。** 改动只限受理SourceRootSerializer；保留rootRenderNode既有mark重排。普通paragraph/heading文本的block/line边缘ASCII space写numeric entity，不改PM文本；必须在node/text callback处理，不能对序列化Markdown regex替换（list marker/mark delimiter/link destination不能动）。实现时用实际parent inline children的可见line-start/end位置决定text leaf的边缘字符；text中内部softbreak切成logical lines；ASCII tab用`&#9;`，连续space逐个`&#32;`，其余文字交原escape。对marks覆盖的首尾空白，先测试源serializer的mark delimiter规则；未证可表达组合明确失败，不能去掉marks。literal source-only fence写opening+LF+完整textContent+独立结构LF+closing；delimiter长度大于内容中会闭合的同字符run，info含不合法delimiter时选择另一字符或具体拒绝。不得trim内容尾LF，不对原tail/BOM/protected做trim。table仅处理生成文本的一个已声明terminal LF。受理hardbreak serializer的末串反斜杠表达复用，不能重复实现或导出末raw授权。
source-only回调候选完整形状（与受理Task2 hardbreak callback合并于同一serializer对象，不新建第三个serializer）：

```ts
// 普通text leaf首尾/行首尾空格可被block parser或mark delimiter吞掉。
// 编码leaf边缘而非原始Markdown，不碰marker/destination或code mark的原生分支。
function writeSourceText(state:MarkdownSerializerState,value:string):void {
 const lines=value.split('\n')
 for(let line=0;line<lines.length;line++){
  if(line)state.text('\n',false)
  const text=lines[line]!,leading=/^[ \t]*/.exec(text)![0].length
  const trailing=/[ \t]*$/.exec(text)![0].length,end=Math.max(leading,text.length-trailing)
  for(let i=0;i<leading;i++)state.text(text[i]==='\t'?'&#9;':'&#32;',false)
  if(end>leading)state.text(text.slice(leading,end))
  for(let i=end;i<text.length;i++)state.text(text[i]==='\t'?'&#9;':'&#32;',false)
 }
}
const sourceMarks=Object.fromEntries(Object.entries(serializer.marks).map(([name,mark])=>[
 name,mark.expelEnclosingWhitespace?{...mark,expelEnclosingWhitespace:false}:mark,
]))
// sourceRootSerializer的nodes对象覆盖以下两项，保留受理的hardbreak项。
const sourceTextNode=(state:MarkdownSerializerState,node:PmNode)=>writeSourceText(state,node.text||'')
function sourceCodeNode(state:MarkdownSerializerState,node:PmNode):void {
 const language=node.attrs.language as string
 if(typeof language!=='string'||/[\r\n]/.test(language))throw new UnsupportedSourceCapture()
 const info=language==='text'?'':language,character=info.includes('`')?'~':'`'
 const runs=node.textContent.match(character==='`'?/`+/g:/~+/g)||[]
 let length=3;for(const run of runs)length=Math.max(length,run.length+1)
 const fence=character.repeat(length)
 state.write(fence+info+'\n')
 state.text(node.textContent,false)
 // 即使content已经LF结束，仍产生另一个closing前结构LF；不trim原textContent。
 state.write('\n'+fence)
 state.closeBlock(node)
}
// new MarkdownSerializer({...serializer.nodes,text:sourceTextNode,code_block:sourceCodeNode,
//   hardbreak:受理Task2的原回调},sourceMarks,原source-only options)
```

这段只提供实施候选，不是已跑过的证据；实现前RED必须包含 `splitBlock('Hello world')`、多个space/tab、strong/em/highlight边缘空白、相邻mark组合、code mark含space、softbreak之后空白、list/quote中的上述文字与content末LF。marks不被删除；`expelEnclosingWhitespace:false`仅source serializer内生效，避免原serializer先把marked whitespace移到callback外。若某组合失败，定位其具体mark producer，不把final eq改宽、不将被本任务列为必过的普通space例降级；未确认的其他组合如实列后续producer。code-language空字符串的实际producer修复仍在后续合同中，不能此处将 `''` 与 `'text'` 视为相同。

- [x] **S2.4 分离组件与失败边界。** 边界因相邻同类列表自动合并、未闭fence吞新root、definition容器迁移失败时无邻居扩大retry；这些是下节具体producer前置。另有全doc final sameMarkup/attrs变化且无source表达时原子拒绝。只render最终dirtycomponents一次；未改容器原tail/root-tail empty保持byte身份。
- [x] **S2.5 full/typecheck/build、committed dist和host安装验证。** 运行本节commands/core regression及host真实命令producer和installedpublicAPI门槛，core提交 `feat(core): map container commands to local source recipes`；host同步该commit dist并独立提交消费者tests。报告table负例与renderer边界；不得把成功subset标成“完整表格已完成”。

## 两个Task各自的实际执行命令与阶段门槛

由现有recorder执行，cwd分别core/host。每任务先保存受理BASE、status、installed realpath/SHA；一次失败立即停止依赖阶段。RED可预期非零，但必须是新能力断言失败而非测试语法/import错误。

```sh
# core Task1 RED / GREEN（不同label，先RED写测试，再实现后GREEN）
./node_modules/.bin/vitest run src/__tests__/source-structure.spec.ts
# core Task2 RED / GREEN
./node_modules/.bin/vitest run src/__tests__/source-structure-commands.spec.ts src/__tests__/source-structure.spec.ts
# 每Task focused GREEN后；均单独recorder保存且检查exit
./node_modules/.bin/vitest run src/__tests__/source-layout.spec.ts src/__tests__/source-terminal-hardbreak.spec.ts src/__tests__/source-block-fidelity.spec.ts src/__tests__/source-document-capture.spec.ts src/__tests__/source-ownership.spec.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsup
# core-artifacts.sh / core-stage-dist.sh执行后核对精准stage清单和DTS closure
# git diff --cached --no-renames --name-status；git diff --cached --check
# core精确路径git add + commit后，记新HEAD；host-sync.sh必须从此HEAD读取
# host安装完成后
./node_modules/.bin/vitest run src/lib/share-merge/source-structure.test.ts src/lib/share-merge/source-block-fidelity.test.ts src/lib/share-merge/source-layout.test.ts
# Task2再跑
./node_modules/.bin/vitest run src/editor-kit-v2/source-structure-commands.test.ts src/editor-kit-v2/commands.test.ts
# 两任务各自随后按现有共同门槛跑host完整tests/build、实际Kit build/browser与installed-corpus-audit
```

stage清单：Task1仅core source-structure/source-fidelity/new spec与其build全部tracked dist/DTS闭包；Task2在此基础上markdown/source-structure-commands spec；host仅具体新tests和同步造成的实际tracked依赖锁变化。新增hash DTS必须显式stage，旧hash按`--no-renames`精确删除，未知文件保留。`git diff --cached`不能包含其他writer改动。两任务各有独立core与host HEAD、command exit/SHA报告，审查可读fixed commit，不消费dirty。

端到端本次只可报告**安装入口消费能力**；如果Kit/native尚未原子安装结构session，则UI smoke应明确该现状，不能让测试绕过adapter后声称实际UI保存通过。不能为了本Task“通过”改history/identity行为，相关接线进入下节必做任务。

## 具体未完前置；总体仍必须完成

1. **相邻同类list边界**：PM能表示两张bullet_list或同start ordered_list，而相同Markdown marker和两LF可合并为一个。需要source-only list producer拥有可选marker及左右邻原marker词法metadata，证明只改新/实际触碰list的marker就能表达；ordered delimiter/start、task/紧松列表全部须实测。当前没有该metadata/producer，本计划只接受已验证可表达边界，不承诺任意adjacent-list split。禁止以增加一条“unsupported-list”capability成为最终产品完成。
2. **未闭fence后的新root**：capture须提供实际fence delimiter/length/info、是否闭合与内容/结构终止事实；生产者需能在原fence EOF仅追加合法closing syntax，再插新root，并以明确boundary witness授权此append（不是重render未触碰前root）。当前字段不够，不能伪造“普通separator”解决。固定具体反例加入后续RED；无自动扩大owner。
3. **table producer完整合同**：共享schema明确header-only `table_row*`、parser移除强补body；所有加行/末格Tab/Mod+Enter从表头整列继承alignment、alignment修改整列；Kit与core真实入口同合同。colwidth移到共享session layout+已知TableLayoutStep，保留resize/history；不忽略attrs，未知Step仍拒绝。必须实现真实拖动、二次拖另一列、add/delete column、删表undo、same-text tables身份、mixed content/layout原子失败、Source revision纯resize不变。schema/producer与layout/history独立小交付，不在结构ledger里偷偷完成一半。
4. **nested definitions**：专门片段producer需证明容器marker/缩进和protected slices保持或经过明示源保留搬运语义；在此之前R1整个root pre-serializer guard保留。只有top-level kept definitions的局部run例通过，不代表嵌套重定位完成。
5. **Source/历史/两端**：本轮不增加CDR server协议或history库；ShareEditorHost提交完整afterMarkdown，离线端outbox沿既有合同。本地fileSource/共享文件环境与hash-bound恢复的后续计划保持Memory通用governed兼容。现有历史计划接入结构result与source bytes的原子安装、undo/redo原字节、rebase/remote/CDR/stored marks；真实Rich/Source三轮13类语料零diff、一字恰一hunk；网页+桌面块编辑/slash/快捷键/粘贴/drop；macOS Safari/Chrome及iOS Safari/Android Chrome IME。上述master §12.4/12.9、§13桌面能力仍完整必做，最后统一验收/发版，不由本候选宣称完成。

## root自审已落实的合同（实现验证仍未执行）

- [x] baseline-conversion明确批准：保留PM空段语义但恰一原unit失去raw身份；不能与“所有未触碰blank bytes永不改”同时无条件承诺。
- [x] 生成EOL固定LF、kept raw EOL不改；不能实施时自行选择。
- [x] ordinary slot表、reference-only两例、list完整tail无双授权，经新公开API RED锁定；任务实施者不得跳过表中任何行。
- [x] Task1/2各有生产增量、真实commands、core dist/host installed绑定；marked whitespace源serializer完整回调候选与实际Kit executeEditorCommand已写入；回调组合尚未实证，root须按RED门槛决定冻结范围，禁止留下假API。
- [x] 前置 Task2 已独立审查、实际内部 serializeSourceRootMarkdown 签名与两处 R1 guard 已核；最终受理 SHA 在前置 whole-range 完成后冻结。
- [x] 本计划仍有明确未完producer，已登记下一交付顺序；不能将短期拒绝转成减少总目标。


## Global Constraints（每个 task brief 必须完整携带）

- 直接两仓 main；不新建 branch/worktree，单一产品 writer。root 在每 task 起点冻结实际 BASE。保留原 7 git-status untracked 项、3 stash 与 force-pull backup；不用 reset/clean/add-all，不读 .env、不安装升级依赖，不改 node_modules 源码。未知产物不得泛删。本计划不启动发布，完整两端与统一发版仍随后必做。
- UTF-16 为 source/PM offset，UTF-8 Buffer 比较原字节。未触碰 root、blank（仅明确 baseline-conversion 例外）、protected、envelope 与 BOM/CRLF/loneCR/尾换行保持原字节；不全篇 serializer+diff、不放宽 doc.eq 全 attrs/marks、不改变根完整 map。
- legacy parser/async/serializer 与 schema 默认不变；source-only serializer 可按 Task2 扩展。未支持 producer 保持具体拒绝，不能把拒绝转为总体完成。新 helper 必须有实际 source API 消费者，不增测试专用 API。
- 结构模块 type-only import SourceSession，避免 runtime 环依赖；暴露给 source-fidelity 的内部 UnsupportedSourceStructure 错误和生产 apply helper（不从 root index export）。source-fidelity 统一映射该已知错误为 unsupported-step。私有 rootRenderNode/source serializer 通过生产 callback 传入结构模块，不能为 tests root-export 或复制第三套 serializer。R1 pre-serializer/最终 edit 两处 guard 必须独立保留；结构 recipe 对 protected 只分离原样 kept，不得覆盖后又凭 eq 放行。
- N2 快路无需新全 ledger；exact prototype+tr.docs 局部归纳/最终一次全 root 核查保留。只结构慢路可 O(S×N) replay，性能成本如实报告。新的分类/局部权限代码不得引入稳定 mark 逐 step whole-doc eq。
- 每 task RED→GREEN→tsc/full/build→precise dist stage/core commit→host committed dist 同步→host focused/full/purity/Vite/Kit/browser→host commit→installed committed corpus/DTS 审计→独立 spec+quality 审查；失败停止依赖下游。format/type-only 修订是否重测按 runtime 是否改变判断并留证据，不重复相同通过 suite。
- 原始 stdout/stderr、subprocess command/argv/cwd/time/exit 与工具 initial/session/final 完整 tool.json 都在本 workspace。每个命令唯一 label，不覆盖 RED/失败。短回 output 不能替代完整 tool metadata。
- 源码与所有 tracked dist（含新增被引用的 ignored hashed DTS）同次 core commit，index gzip≤81920。stage 精确路径；obsolete 只 --no-renames frozen BASE→committed HEAD 的单层 hashed .d.ts 删除，不清未知文件。host 只能从 git show CORE_HEAD:dist/... 安装 committed bytes，最终实际 realpath/exports/DTS closure/58-or-actual tracked dist/14 corpus 两仓 committed+working 全 SHA 审计。
- 本计划 own workspace 仅 `/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-structural-source`。执行前 sdd-workspace 解析；必要资料从已核 canonical archive 挑选+SHA provenance，不读旧或兄弟 workspace。browser/cache 各任务 S1/S2 子目录，原 browser 脚本结果名保留但不可覆盖跨 task。
- 两 task 每次 fresh implementer、独立 spec+quality reviewer；writer 不 spawn helper/reviewer。root 不派额外 plan-reviewer。最后唯一 strongest whole-range，至多一次统一 final fix+一次 scoped re-review；全部 Minors/⚠️与 Ruling 记录，归档所有 raw evidence 后仅清本 workspace。
- 旧 single-block browser 只是 regression gate，无截图/no new structural UI/native/IME 证明；不能冒称真实两端完整体验。master 全语料三次切换零 diff/一字一 hunk、局部重parse、history/native/IME、E1–E4 最终统一发版仍必须完成。

## 自含执行脚本与共同 host 门槛

以下脚本在本计划 workspace 新建，不能调用前置旧目录。脚本只有执行时才生成，root 先记录冻结 core-task-base；host-sync 写入 committed git blob 并核 built bytes，非 cp working dist。run.py 正确 argv：`python3 OWN/run.py --cwd REPO LABEL -- CMD ...`。工具层另存完整返回数组到 LABEL.tool.json。

### run.py

```python
import argparse, json, pathlib, subprocess, sys, time
parser=argparse.ArgumentParser()
parser.add_argument('label')
parser.add_argument('--cwd',required=True)
parser.add_argument('command',nargs=argparse.REMAINDER)
a=parser.parse_args()
argv=a.command[1:] if a.command[:1]==['--'] else a.command
if not argv: parser.error('command required')
base=pathlib.Path('/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-structural-source')
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

### baseline.sh

```sh
set -e
git -C /Users/bruce/git/moraya-core rev-parse HEAD
git -C /Users/bruce/git/moraya-core status --short
git -C /Users/bruce/git/mdeditor rev-parse HEAD
git -C /Users/bruce/git/mdeditor status --short
node --input-type=module -e "import fs from 'node:fs';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';const p=fs.realpathSync(fileURLToPath(import.meta.resolve('@moraya/core')));console.log(JSON.stringify({installed:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}))"
```

### core-artifacts.sh

```sh
set -e
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

### core-stage-dist.sh

```sh
set -e
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

### installed-corpus-audit.sh

```sh
set -e
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

### host-sync.sh

```sh
set -e
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
const core=fs.realpathSync('../moraya-core'),dst=path.join(fs.realpathSync('node_modules/@moraya/core'),'dist');
const git=(...args)=>execFileSync('git',args,{cwd:core,maxBuffer:32*1024*1024});
const baseline=fs.readFileSync('/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-structural-source/core-task-base','utf8').trim();assert.match(baseline,/^[a-f0-9]{40}$/);
const head=git('rev-parse','HEAD').toString().trim();
const files=git('ls-tree','-r','--name-only',head,'--','dist').toString().trim().split('\n');
assert.ok(files.length>0&&files.every(p=>p.startsWith('dist/')&&!p.includes('..')));
const blobs=files.map(file=>({file,bytes:git('show',`${head}:${file}`)}));
for(const {file,bytes}of blobs)assert.ok(fs.readFileSync(path.join(core,file)).equals(bytes),`uncommitted build ${file}`);
const deleted=git('diff','--no-renames','--diff-filter=D','--name-only',baseline,head,'--','dist').toString().split('\n').filter(Boolean);
for(const file of deleted)assert.match(file,/^dist\/[^/]+-[A-Za-z0-9_-]+\.d\.ts$/);
if(fs.realpathSync(dst)!==fs.realpathSync(path.join(core,'dist'))){
 for(const file of deleted)fs.rmSync(path.join(dst,file.slice(5)),{force:true});
 for(const {file,bytes}of blobs){const target=path.join(dst,file.slice(5));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
}
console.log(JSON.stringify({coreHead:head,baseline,dst,files:files.length,deleted}));
JS
```


host 每 task 后续命令分别由 recorder 执行并判 exit，不串联失败阶段：

```sh
./node_modules/.bin/vitest run
node scripts/check-share-merge-purity.mjs
./node_modules/.bin/vite build
node scripts/check-editor-kit-build.mjs
env PLAYWRIGHT_MODULE=/Users/bruce/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs SOURCE_FIDELITY_OUTPUT_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-structural-source/browser/S1 SOURCE_FIDELITY_CACHE_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-structural-source/vite-cache/S1 node scripts/check-source-fidelity-browser.mjs
# Task2使用S2目录；不安装Playwright。脚本实际路径/预先已安装模块在baseline核exists。
```

root 整计划最后单次 svelte-check --tsconfig ./tsconfig.json，前后 tracked source/buildconfig 指纹一致，实际 errors/warnings 与保存基线 SHA 比较。不把 stderr 噪声臆断归因为 baseline；记录全部失败/警告/证明边界。每 task 最终 installed audit 必须在两仓提交后跑，全部 committed corpus SHA 包括 BOM/CRLF 与 manifest。
