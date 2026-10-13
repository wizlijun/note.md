# File bindings 与原生 PM history：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 让普通文件编辑与分享协作共用保真 raw、稳定块身份和一份跨 Source/Rich 的原生撤销历史。

**Architecture:** 唯一 file controller 准入真实 PM 事务，CORE 负责源码能力与可逆载荷，HOST 负责业务身份、会话生命周期与保存。所有来源、引用保护和最终 raw/doc 一致性校验在成功安装前完成；网页/桌面仅装配同一 owner。

**Tech Stack:** TypeScript、ProseMirror、Svelte、Tauri/Rust；既有 @moraya/core；不增加服务或依赖。

状态：2026-10-14 root 已完成候选逐接口核对，source-consumer closure 已最终受理，按本计划连续实施。产品前置 CORE d0807fa278bd4cdf1724435c4262a6295b64d61e / HOST a955cb1c1de811e6a604f3f5179b8cd5e5e2270f；实际执行 BASE 在文档提交后写入本计划 OWN 的 core-task-base / host-task-base，不覆盖。新 API/文件均为本计划拟新增，不能声称已经存在。历史候选来自已验 SHA 的证据归档；正式 BASE 不采用候选撰写时的旧 SHA。

Spec: `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.4 / §12.9。用户已授权现有 main 直接实施、不创建 worktree，并持续至后继网页/桌面协作和统一发布；本四 Task 只完成共享文件 owner/history 前置，阶段提交不是发行。

## Global Constraints

- CORE=/Users/bruce/git/moraya-core；HOST=/Users/bruce/git/mdeditor；只用既有 main，不 reset/clean/amend/add-all 或覆盖无关文件。
- 同时只有一个产品 writer；每 Task fresh implementer + combined spec/quality reviewer，最后唯一 whole-range review。root 所有裁定记当前 OWN/progress.md。
- 所有 pnpm 关闭隐式依赖安装；不读 .env、不升级依赖，不将旧 synthetic IME 测试写成平台实测。
- raw authority / 原始 Step/docs 链 / strict doc.eq / protected 检查保持；业务 ID、JSON、metadata 和 policy 不能授予源码写权限。
- 新 API/未来 Task 类型不等于已存在实现；Task1 只依赖已安装前置，Task2 完成 Source/controller/resize，Task3 只装配，Task4 持久化/native。
- Gate 执行经当前 OWN 记录实际 argv/cwd/exit/stdout/stderr/tool lifecycle；失败停止依赖动作。只安装已验证且已提交的 CORE blobs，重装明确提供实际前驱 SHA。
- CORE 主入口预算沿当前已执行门槛 gzip≤102400；新 history 子入口和 HOST bundle 单独记录；不得自动提高。两仓各14原fixture/manifest保持。

## 0. 目标、已裁定选择与交付范围

- 完整 raw 文件是一份 authority；自然 roots 绑定业务 ID；synthetic/gaps/空文件不假造业务块。
- file 模式保存原生 PM 标准 Step、已知 SourceHistoryStep/TableLayoutStep 的实际有序链；不套 legacy BlockEditStep/BlockBookmark，不包每个标准 Step。
- 同一 PM owner 跨 Source/Rich 存活；Source 有真实语义 ReplaceStep，不能只改外部 raw 或另建 textarea 撤销栈。
- 原子性指完整 raw/doc/bindings/layout 结果一致；原生 PM 内部冗余 inverse 被跳过但结果完全相等，不另加 monkeypatch 观察。
- 逻辑 lineage 可在 undo/redo 前后切换；core source revision、host generation 单调；保存/送达不改 authority、不清 history。
- 显式 rebase/撤销 rebase 由 Draft.previous 提供可恢复边界，成功切换会话基线才重建 history；普通 CAS 失败不能清栈。
- ID 策略：untouched 保持；有真实来源对应的一对一 retained 保持；split 第一后继、join 第一输入继承；repartition/birth 新 ID。
- root 已裁定 SourceHistoryStep 可携严格的 generic `{rootOrdinal,id}` binding transition；core只验证数据形状，host掌握身份策略/权限。raw-only bindings 未变时省略该载荷；不为 identity metadata 伪造 raw delta。
- 保留 file block.move-up/down：用真实 PM slice 的 delete→insert 与 controller 私有 witness，不逐块 parse、不按同文推断、不扩大 protected transport。
- 同一会话布局保留 resize undo；必须同时做 read/preview/commit，Markdown 不加 width grammar。
- 本计划交付 file owner、最小真实 Rich/Source/保存恢复/native 接线；完整 E1 的批注/媒体/分享 UI 剩余能力仍沿主 spec，不靠本批声称全部 E1/E4 完成。
- Memory/CDR 继续现有 mount/OperationBatch/remote semantic history；不强迁移，也不引入新网络 ACK/raw OT 协议。

## 1. 文件分工和新增公开入口

CORE 新增 `src/source-history.ts`、`src/plugins/session-table-view.ts`、`src/__tests__/source-history.spec.ts`。
CORE 修改 `src/source-fidelity.ts`（Task 1 精确 M producer）、`src/index.ts`（只导出 M helper/type）、`src/setup.ts`（三个可选工厂 seam）、`src/table-commands.ts`（已知表结构提示）、`package.json`、`tsup.config.ts`；对应 focused tests 见各 Task。
HOST 新增 `src/editor-kit-v2/file-{contract,bindings,projection,controller,history,layout,resize,commands,source-input,main,recovery}.ts`。Task 2同时新增纯 `src/lib/slash-menu/slash-command.ts` / `slash-command.test.ts`，精准修改 `src/lib/context-menu/block-helpers.ts` 与 `src/lib/slash-menu/slash-items.ts` 的同步producer委托；不把含Tauri的菜单目录整体引入controller。
这不是十二套服务：每文件只承接下文一项边界；`file-controller`是唯一状态安装者，`file-main`是唯一DOM装配者。
HOST 修改 `src/editor-kit-v2/main.ts`（新增具名导出，不改 legacy mount）、`commands.ts`（可注入 history命令）、`src/editor-kit/rich.ts`（可选 file装配参数）。
HOST 修改 `src/lib/editor-bridge.ts`、`src/components/{EditorPane,RichEditor,SourceView}.svelte`、`src/lib/tabs.svelte.ts`（仅文件owner边界）、`src/App.svelte`、`src-tauri/src/lib.rs`。
HOST 新增 `src/lib/file-editor-sessions.ts`、`src/lib/file-history-focus.ts`、`src/share-editor/file-session.ts`；改 `src/lib/project-share/{types,browser}.ts` 本地恢复接缝。
HOST 精确修改 `src/lib/insights/{observer.ts,tracker.svelte.ts}`：file统计延后到真正安装，legacy observer保持原行为；`src/styles/app.css`仅补共享resize handle/cursor/touch-action规则，不复制表格外观。
所有新增测试不改两仓14原 fixture/manifest bytes，不删除旧 source/Memory 回归；正式 Task allowlist 逐项冻结后才编辑。

### 1.1 core 包改动只限以下项目

```json
"./source-history": {
  "import": "./dist/source-history.js",
  "types": "./dist/source-history.d.ts"
}
```

`tsup.config.ts.entry` 增 `'src/source-history.ts'`；保持 `splitting:false` 和既有 externals/targets，其它 package 字段、dependencies/lockfile 不变。
`source-history.ts` 是唯一 `Step.jsonID` 注册入口，注册 `morayaSourceHistoryV1`、`morayaTableLayoutV1`；core root/setup/plugins 不能 runtime import 或重导出它。
HOST统一从 `@moraya/core/source-history` 导入类；不得 `/dist/...`、source alias或从第二入口复制注册代码。
CORE `index.ts`新增的 M helper不 import history；session-table-view只依赖既有prosemirror-tables/模型/视图类型，不 import history。
`./plugins/session-table-view`沿已有plugins/* export与tsup glob生成JS/DTS，不另增package key；HOST不声明prosemirror-tables，须用此core入口，不能偷读传递依赖。
产物需实际验证 root+subentry 同一 transform registry/prototype；package“完全不变”旧门槛改为上述精确差异，不能继续假称无变化。

## 2. 候选类型与状态边界（正式启动再冻结）

```ts
// CORE source-history.ts；全部 readonly，constructor/fromJSON 都复制并冻结。
export type RawEdit = Readonly<{from:number;to:number;removed:string;text:string}>
export type RootIdRow = Readonly<{rootOrdinal:number;id:string}>
export type BindingImage = Readonly<{sourceHash:string;roots:readonly RootIdRow[]}>
export type RawDelta = Readonly<{
  beforeLineage:string; afterLineage:string; beforeHash:string; afterHash:string
  edits:readonly RawEdit[]
  bindings?:Readonly<{before:BindingImage;after:BindingImage}>
}>
export type TableImage = Readonly<{
  position:number; columns:number; widths:readonly (number|null)[]
}>
export type TableDelta = Readonly<{id:string;before:TableImage|null;after:TableImage|null}>
// Step类与 attempt scope由 Task1定义；不含cdrBlockId/schema业务知识。
```

```ts
// HOST file-contract.ts；Task 1 建立，后续全部 import 此唯一类型来源。
import type {CreateEditorOptions} from '@moraya/core'
import type {DecorationHost} from './contract'
export type FileAdapters = Pick<CreateEditorOptions,
 'mediaResolver'|'rendererRegistry'|'linkOpener'|'platform'|
 'spreadsheetViewFactory'|'frontmatterViewFactory'>
export type FileRender = Pick<CreateEditorOptions,
 'enableMath'|'enableMermaid'|'enableImageSelection'>
export type FilePolicy = Readonly<{
 acceptRawChange(before:string,after:string):boolean
}>
export type FileSlashCommand = 'h1'|'h2'|'h3'|'quote'|'code'|'mermaid'|
 'math'|'table'|'spreadsheet'|'bullet'|'ordered'|'task'|'hr'|'highlight'|'wikilink'
// 仅已证实同步state/dispatch/focus helpers；不包含异步dialog/popup。
export type FileBinding = RootIdRow // import type from @moraya/core/source-history
export type FileSnapshot = Readonly<{
  raw:string; sourceRevision:number; generation:number; authority:string
  sourceLineage:string; sourceHash:string; bindings:readonly FileBinding[]
}>
export type FileRecovery = Readonly<{
  v:1; sourceHash:string; sourceRevision:number; bindings:readonly FileBinding[]
}>
export type FileInput = Readonly<{
  documentId:string; authority:string; raw:string; recovery?:FileRecovery
}>
export type FileFailure = {ok:false;reason:string}
export type FileResult = {ok:true;changed:boolean;snapshot:FileSnapshot}|FileFailure
export interface FileEditorOwner {
  snapshot():FileSnapshot
  replaceSource(input:{expectedGeneration:number;value:string}):FileResult
  execute(command:EditorCommand|StructuralCommand):boolean
  canExecute(command:EditorCommand|StructuralCommand):boolean
  executeSlash(command:FileSlashCommand):boolean
  canExecuteSlash(command:FileSlashCommand):boolean
  undo():boolean; redo():boolean; canUndo():boolean; canRedo():boolean
  restoreContent(raw:string):FileResult
  installBaseline(input:FileInput, options?:{policy:FilePolicy|null}):FileResult
  setReadOnly(value:boolean):void
  flush():Promise<FileSnapshot>
  observe(listener:(value:FileSnapshot)=>void):()=>void
  close():Promise<void>
}
export interface MountFileEditorOptions {
  file:FileInput; readOnly?:boolean; placeholder?:string
  ids?:{blockId():string;lineage():string;tableId():string}
  onChange?:(value:FileSnapshot)=>void
  adapters?:FileAdapters; render?:FileRender; policy?:FilePolicy
}
export type MountedFileEditor = {
  owner:FileEditorOwner
  setMode(mode:'rich'|'source'):Promise<boolean>
  focus():void; destroyView():void
  decorations:DecorationHost
  annotations:{insert(seed?:string):boolean;editAt(position:number):boolean}
}
```

Task 1 的 `file-contract.ts` 只含完整类型，不导入尚未创建的 controller / owner / recovery 实现。`EditorCommand` / `StructuralCommand` 复用仓库既有声明；PM 类型与 core source / payload 类型用 type-only import。`FileBinding` 直接复用 core `RootIdRow` 的形状，不在其它文件另抄类型；`FileState` / `FileIds` / `ObserverDelta` 的内部共享声明也集中在此，既有统计类型优先 type-only 复用。Task 1 不导出尚不存在的 mount 函数，也不创建 fake owner。

`mountFileEditor(container,options):Promise<MountedFileEditor>` 在 Task 3 实现后从现有 `editor-kit-v2/main.ts`具名导出；旧 documentEditorApiVersion=2与MountDocumentEditorOptions签名不变。
Desktop用同一owner实现；由桌面RichEditor调用处组装原media/renderer/link/platform/frontmatter等adapters并显式传入，file-main不装配桌面默认依赖；这些不是分享文件wire字段。CreateEditorOptions真实来源为core src/setup.ts:722、由src/index.ts公开；DecorationHost复用HOST contract.ts:73，不另造层协议。Task1仅type-only import；controller Task2只消费FilePolicy/FileSlashCommand，不runtime import Task3 UI。
FileAdapters不开放configureSchema/createState/dispatch/history/source回调，FileRender不开放enableHistory/enableTableResize；这些仍由file装配统一决定。policy是只读同步纯veto，不存raw、不发事件、不改state、不授予source权限；callback抛异常视为拒绝并保留诊断。annotations仅把现有note-commands调用收束到当前私有真实view，不允许外部传session或自造raw授权。
内部 `FileState={session,bindings,sourceHash,sourceLineage,layout,authority,generation}` 只在 Plugin.state保存；layout是id→TableImage不可变Map，不能挂可变width数组到PM节点。
`snapshot()`只导出raw与恢复必要元数据；layout是会话态不持久；sourceHash复用HOST `sha256Sync`，不增加hash依赖。
每次真正 raw改变调用F1候选得到revision+1；layout-only/source metadata不增加core revision。generation只在真正已安装状态变化后增加。
lineage每次本地raw编辑生成新值，history按载荷恢复前/后值；不复用raw hash当lineage，A→B→A仍是两个因果事件。
同一原生历史事件可含多笔RawDelta；中间session/revision在preflight纯候选链递进，不发布中间代。

## Task 1：可逆载荷、bindings、完整canonical投影与M helper

**Files。** CORE 新增 `src/source-history.ts`、`src/__tests__/source-history.spec.ts`、`src/__tests__/source-list-controller.spec.ts`；修改 `src/source-fidelity.ts`、`src/index.ts`、`package.json`、`tsup.config.ts`。HOST 新增 `src/editor-kit-v2/file-contract.ts`、`file-bindings.ts`、`file-projection.ts` 及 `file-bindings.test.ts`、`file-projection.test.ts`。本 Task 不创建/导出 controller、file-commands、NodeView 或 UI。

**Consumes。** 已正式冻结且已安装的前置 core 完整 SourceSession / F1 edits / correspondence / nested-inline-annotation-empty-body 合同，以及既有 PM 标准 Step 和 HOST identity schema。前置缺能力或接口不吻合时先更新计划，不用 Task 2/3 的未来文件补齐本 Task。

**Produces / API。** 可单独 import、严格类型检查的 source-history 子入口；完整 `file-contract` 类型；`validateBindings` / `projectBindings` / `nextBindings` / `restoreBindings` / `restoreRecovery`；`neutralize` / `assertProjection` / canonical projection 私有 helper；core `prepareSourceListBoundarySteps`。公开 mount/owner 类型在此定义，运行时实现后移不形成 import 依赖。

**具体测试 / 提交边界。** 下列 1.6 只测真实 Step、真实完整 session、真实 PM 事务与纯 helper。所有 helper 实现在本 Task 补齐；不调用未有实现的 `open` / `replaceSource` / move controller。先 core 编译/测试/build/精确提交并安装 committed 产物，再 HOST 纯 helper 编译/测试/build/精确提交；验证累计到 Task 1 的文件即可，不要求未来 UI 脚本存在。

- [x] **1.1 先建可编译最小目标接口并写真实行为 RED。** 缺导出、错误fixture、依赖安装失败不算RED；下面算法全部在本Task补完。

### 1.2 raw/layout Step 的完整算法

`assertDelta`：只接受精确字段、version=1外围JSON、非空lineage且before≠after、64位小写hex hash；edits非空。
offset为有限安全整数，0≤from≤to，removed.length===to-from；输入按from严格递增、不重叠，同锚点多插入拒绝；真实no-op edit拒绝而非默默遗失因果。
原始Rich范围/owner审计在构造delta之前完成。允许相邻edits保留原顺序；本版不强求合并它们，不改变F1返回的raw写集。
`invertEdits`：从左到右令shift=0；每项输出 `{from:e.from+shift,to:e.from+shift+e.text.length,removed:e.text,text:e.removed}`，再 `shift+=text.length-removed.length`。
若原删除/相邻变化使逆向产生同锚点多个操作，按同一原向相邻组先合并其连续source区间后构造**这一delta**；禁止跨未触碰gap合并。保留原权限审计与规范化前原输入在准备记录中。
`canonicalEdits`实现为单次有序遍历，只把 `prev.to===next.from` 合成一项；removed/text按序拼接，若组整体字节相等则该组无需raw delta但不抵消**不同事务/lineage**的ABA。
以上两个纯函数作为SourceHistoryStep的具名static方法公开供host规范化与真实单元测试；constructor再次校验规范形式，不信任调用者先运行过helper。
delta整体无raw变化返回无Step，由controller处理真正no-op；不得造空SourceHistoryStep。
`SourceHistoryStep.apply(doc)`只校验自身形状并返回原doc；失败调用 `failActiveHistoryAttempts()` 后StepResult.fail，不读写session/plugin。
`invert()`把delta列表倒序，每项逆转edits、hash/lineage/bindings before/after；`getMap()` empty；`map()`返回同内容新Step，不根据PM Mapping移动raw offsets。
raw不经PM map重定位是有意范围：一个authority内所有source变更都进此栈；显式baseline边界重开history；不支持偷偷插入非历史raw变更。
`merge()`返回null；`toJSON/fromJSON`严格校验、拒未知字段/版本及非JSON值，循环复制大数组，不无界参数spread。
JSON精确外层为 `{stepType:'morayaSourceHistoryV1',v:1,deltas:RawDelta[]}` 或 `{stepType:'morayaTableLayoutV1',v:1,deltas:TableDelta[]}`；两构造函数均接非空deltas数组。
binding images只验数据：rootOrdinal安全非负且严格递增、id非空且唯一、hash形状；core不决定是否完整覆盖真实roots。
`TableLayoutStep`同样只做形状校验/apply原doc/empty map/merge null；deltas非空、id唯一、before/after不同时null且确有改变。
TableImage要求position安全非负、columns正整数、widths.length===columns、width为null或有限正数；source不写colwidth。
`invert()`逆转delta顺序并交换images；`map()`保留images不丢Step，最终table registry与actual candidate doc验证位置；file完整历史不允许不受控跨authority remap。
`withSourceHistoryAttempt(fn)`维护同步栈 `{failed:false}`，try/finally弹栈；已知Step失败标记所有当前嵌套attempt，返回 `{value,failed}`；不是撤销栈、不保存事件。

- [x] **1.3 bindings 初始、变化与恢复。** 新 `file-bindings.ts`实现以下函数，public package不额外导出它们。

`validateBindings(session,rows)`：rows恰好覆盖所有自然roots的ordinal一次，ID唯一；每root child/PM区间对实际doc一致；空roots只接受[]。
同时验证每个PM top child归自然root或既有gap synthetic/layout fallback之一；无ID节点不能丢，多个发射child共用同一root ID。
`projectBindings(session,rows)`：只对自然root发射的顶层节点设置cdrBlockId，其余顶层null；nested已知属性保持canonical默认null；其它attrs/content/marks完全保留。
`neutralize(node)`：WeakMap memo递归仅把**schema实际有此属性**的cdrBlockId置null；不替未声明该属性的doc/text创造属性，不改其它keys。
`assertProjection`：neutralize(businessDoc).eq(session.doc)，相同schema对象、doc attrs/marks一致；不以readBlockLayout重建doc。
`nextBindings(base,next,file.correspondence,idFactory)`先核before/after每ordinal恰属一个component，再按root裁定逐组件分配。
untouched/retained的1→1继承；split按after原文顺序首root继承原ID，其余fresh；join按before原文顺序首ID继承；birth/repartition fresh；deleted消失。
retained是业务策略而非“原文同文”证明。实际 CORE SourceFileUpdate.correspondence 是普通 readonly 数据，现有接口没有其 unforgeable token；nextBindings 作为 HOST 内部纯 helper 负责形状/完整覆盖/组件与实际 roots 一致性，不能声称从 plain JSON 识别真实 F1 来源。
真实性由 Task2 controller 私有调用边界保证：只将同一次受控 F1 调用成功返回的 session 与 file.correspondence 成对传入，绑定当前实际 base/session/generation；外部 dispatch metadata、recovery、JSON Steps 和公开 owner API 均无传入或覆盖 correspondence 的参数。Task1 不新增 CORE provenance registry/token；Task2 必须测试伪造 metadata/JSON 对应表不能改变真实 F1 结果或继承策略。helper 的测试可构造非法形状验证拒绝，合法继承正例使用真实 F1。
本 helper 返回完整默认分配；move witness 不进入 Task 1 的签名或测试。Task 2 controller 验证 witness 后在其私有候选准备阶段覆盖已证明的单根继承，再调用同一 `validateBindings`，若同一旧ID还被另一个after继承则拒绝整候选；不得扩成 caller 可传任意身份对应表。
`restoreBindings`仅消费history可信载荷，分别校验beforeHash/current完整rows、afterHash/candidate完整roots；undo不得重新随机分配ID。
`restoreRecovery`校验v/hash和完整覆盖；失败只丢bindings缓存并fresh，raw仍由输入权威恢复。core sourceRevision无需按缓存强设回旧值。

- [x] **1.4 canonical Step projection。** `file-projection.ts`禁止每块session，建立一次EditorState({doc:base.session.doc})的tr并重放标准Step。

`projectStandardStep`使用确切prototype分派：ReplaceStep/ReplaceAroundStep复制所有原range、structure、gap/insert/openDepth，只neutralize slice节点；Add/RemoveMark及Add/RemoveNodeMark保留原mark/range；AttrStep仅neutralize已知身份字段。
身份AttrStep只有producer私有授权且实际before/after仅该属性不同才省略；其它AttrStep按原pos/attr/value重建；unknown/subclass拒绝。
每个实际tr.docs[i]先校验真实step.apply(before)等于实际after，再校验neutralize(before/after)等于canonical replay逐步doc，保留原始幅度，不拆wide mark。
用户插入slice中非空ID只能来自base现有ID或本次私有producer；陌生非空ID拒绝；不得凭ID相同授来源权限。
局部稳定步骤比较使用memo后的受影响subtrees；全projection一致性首尾各一次，不在每一步重新扫描全部业务块。
canonical事务交 `applySourceBlockTransaction`，成功消费其真实file.correspondence；未返回file字段视为依赖合同缺失，不能猜对应。
新的binding投影通过追加真实AttrStep把**最终真实tr.doc**调成projectBindings结果（包括清除失效/重复/嵌套ID）；这些步骤经私有身份授权，不交core当来源编辑。
生成任何身份步骤后再次严格核完整business目标及canonical相等；source/raw相同且只有未经授权身份变化不能进入用户history。
私有 API 以 `createFileProjection()` 创建每 controller 独有实例，Task 1 helper 测试也直接创建此实例；内部 WeakMap 记录它实际追加的身份 Step（绑定该 tr / step 引用 / before / after），只提供 `project(base,tr)` 与 `appendBindings(tr,session,rows)`。`project` 返回 canonical transaction 或 FileFailure；`appendBindings` 自行 validate/project/追加并登记实际 AttrStep，返回成功或 FileFailure，失败候选不得 dispatch。调用者不能传布尔 permission 或自己构造 grant；合法插入先带当前已有 ID 或 null，再由 helper 追加新身份。Task 2 持有实例并控制调用时机，Task 1 本身不 import controller，也不把实例方法暴露为编辑器公开 API。

- [x] **1.5 M自动producer：本地Rich才调用。** CORE新增 `prepareSourceListBoundarySteps(base,tr)`返回成功的标准ReplaceStep数组或FidelityFailure；Source producer（包括其 undo/redo）不调用。

它复用source-fidelity内部transactionListStyles与actual list facts，不将private lexical authority导出。先核标准step原型/tr.docs/schema，分析最终所有有变化的list祖先/相邻seam。
逐实际parent子节点检测相邻bullet/bullet或ordered/ordered；按实际继承lexeme或真实birth默认marker判断会被相同marker合并的seam。
不同marker无需M；已有普通M隔开的不重复；单一list splitListItem没有两个相邻list，不插M。ordered start不同但同marker仍需M。
对需要的seam按PM pos降序创建 `html_block.create(null,schema.text('<!-- notemd:list-boundary -->'))` 并验证parent能容纳，生成闭合Slice ReplaceStep；attrs/marks均默认。
返回步骤加入canonical与business真实事务，两者仅cdr身份不同；随后才跑首次完整source guard。不能先失败parse再盲试M，不能自动删除既有/orphan M。
同样检查覆盖doc、quote、list_item内的seam；无法真实证明lexeme则失败，不把所有HTML或任意注释当M。
该helper只生成明确本地结构补充，不代替applySourceBlockTransaction权限。新增core公开export只此helper/type，不导出内部style setter。

### 1.6 最小实际测试代码与命令

```ts
// CORE src/__tests__/source-history.spec.ts；API实现后可编译，不靠mock class。
import {expect,it} from 'vitest'
import {Step} from 'prosemirror-transform'
import {defaultSchema} from '../schema'
import {SourceHistoryStep} from '../source-history'
it('raw-only是真实可逆Step，JSON不改文档',()=>{
 const d={beforeLineage:'a',afterLineage:'b',beforeHash:'a'.repeat(64),afterHash:'b'.repeat(64),
  edits:[{from:0,to:3,removed:'_甲_',text:'*甲*'}]}
 const s=new SourceHistoryStep([d]),doc=defaultSchema.topNodeType.createAndFill()!
 expect(s.apply(doc).doc).toBe(doc)
 const r=Step.fromJSON(defaultSchema,s.toJSON()) as SourceHistoryStep
 expect(Object.getPrototypeOf(r)).toBe(SourceHistoryStep.prototype)
 expect(r.invert().invert().toJSON()).toEqual(s.toJSON())
 expect(r.getMap().map(7)).toBe(7)
})
it('相邻删除逆向同锚点已规范化',()=>{
 const e=SourceHistoryStep.canonicalEdits([
  {from:1,to:2,removed:'甲',text:''},{from:2,to:3,removed:'乙',text:''}])
 expect(e).toEqual([{from:1,to:3,removed:'甲乙',text:''}])
 expect(SourceHistoryStep.invertEdits(e)).toEqual([{from:1,to:1,removed:'',text:'甲乙'}])
})
```

另测严格JSON/large数组/identity transition/inverse顺序、非法atomic形状；HOST `file-bindings.test.ts`覆盖零roots、synthetic、multi-emission、重复同文、split/join/source retained/history恢复；`file-projection.test.ts`覆盖unknown subclass、其它attrs不忽略、wide mark和nested producer真实消费。
`source-list-controller.spec.ts`用真实wrapInList/lift后delete+M producer，非手工直接插M冒充自动能力。

```sh
# CORE cwd；所有命令实际执行时经root适配的新OWN run.py保存完整记录。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/source-history.spec.ts src/__tests__/source-list-controller.spec.ts
# HOST cwd；安装本Task已提交core产物后。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/editor-kit-v2/file-bindings.test.ts src/editor-kit-v2/file-projection.test.ts
```

## Task 2：唯一准入controller、Source producer、块命令、原生history与真实会话resize

**Files。** CORE 新增 `src/plugins/session-table-view.ts`、`src/__tests__/session-table-view.spec.ts`、`src/__tests__/table-layout-hint.spec.ts`，修改 `src/table-commands.ts`；NodeView read/paint adapter 和 gfm table hint 都在本 Task 实现、测试并提交，不留给 Task 3。HOST 新增 `src/editor-kit-v2/file-controller.ts`、`file-history.ts`、`file-layout.ts`、`file-resize.ts`、`file-commands.ts`、`file-test-utils.ts`、`file-controller.test.ts`、`file-history.test.ts`、`file-layout.test.ts`、`file-commands.test.ts`、`file-resize.test.ts`，新增 `scripts/check-file-editor-browser.mjs` 及独立受控的 browser fixture（脚本在当前 OWN 输出目录生成，不写产品源）；新增纯 `src/lib/slash-menu/slash-command.ts` / `slash-command.test.ts`，修改 `src/lib/context-menu/block-helpers.ts` 与 `src/lib/slash-menu/slash-items.ts` 复用同步producer；精确修改 `src/lib/insights/{observer.ts,tracker.svelte.ts}`、`src/styles/app.css`。若真实 ObserverDelta 已有唯一声明，复用该声明，不新造平行结构。

**Consumes。** Task 1 已提交并安装的 Step、bindings、projection、M helper 和 `file-contract`；既有 EditorState/EditorView、history、core TableView 与表命令。没有 Task 3 owner/textarea/mount/import 依赖。resize 浏览器 fixture 直接以生产 controller + 实际 EditorView + Task 2 NodeView/resize 插件装配，不调用未来 mountFileEditor。

**Produces / API。** 可在无 DOM 的真实 EditorState 上执行 Rich / Source / history / move / layout / 窄同步slash组合的 controller；同一 controller 可 bindView 到真实 EditorView。`sourceDifference` / `middleReplace` 是 `file-controller.ts` 私有生产函数，`replaceSource` / `restoreContent` 在本 Task 完整实现。`file-commands.ts` 的 `executeFileStructural(controller,command,execute)` 只通过 controller 内部窄入口准备/验证/提交；`execute=false` 走相同 pure prepare，不 dispatch。controller 的私有 intent/witness 不对外序列化、不由 UI 构造。

**具体测试 / 提交边界。** 2.8 的 raw-only undo/redo、Source 语义 Replace、命令 witness、拒绝原子性、layout 与 pointer 测试全部使用本 Task 真实实现。Task 2 创建唯一 `file-test-utils.ts` 的 `open` / 确定性 ID helper，Task 3/4 直接 import，不后补或复制。CORE 两个新增 focused tests 及完整门槛先行，再精确提交/安装；HOST 累计严格编译、focused/full/build、真实 EditorView resize 浏览器验收后精确提交。本 Task 不以 mode-switch/textarea/native-menu 未实现路径作为通过条件；这些各在首次实现 Task 验证。

- [x] **2.1 Source raw→PM具体producer（本 Task 的生产实现）。** `sourceDifference(before,after)`取UTF-16最长公共前后缀且不交叉，边界若切surrogate/CRLF，向外扩到完整单元；输出一个最小合法patch或[]。

producer 使用 controller 当前安装态 raw；准备捕获的 before 不等于当前raw或 expectedGeneration 不等则返回stale-source，不把用户buffer强写最新状态。F1按current revision校验removed；不在每块parse。
`middleReplace(beforeDoc,targetDoc,tr)`跳过完整eq的top children前缀/后缀，计算两侧nodeSize和，用一个闭合Slice ReplaceStep替换中间；空中间表示纯插/删，target完整doc若全等不加语义Step。
必须实际tr.step成功，tr.doc.eq(target)；再附raw delta/binding transition/layout delta。不能通过updateState直接换目标doc，也不能从PM差异重构raw。
raw patches合法可改变远处reference link attrs，PM中间替换较宽不意味着扩大raw授权；Rich永远不能走此Source入口。
`replaceSource({expectedGeneration,value})` 使用上述差分→F1完整候选→bindings→middleReplace→layout→有序payload→同一dispatch；完整raw/PM/layout不变返回 `{ok:true,changed:false,snapshot}`，不新建lineage/generation/history。失败返回 FileFailure，不覆盖raw。F1/hash/权限判断不转交 Task 3。
`restoreContent(raw)` 在 controller 本 Task 实现，为同authority内本地可撤销操作：closeHistory前后边界、使用同Source producer，不自动补M；版本恢复不是rebase。

- [x] **2.2 独立首filter/state plugin，不做append producer。** `file-controller.ts`同时用于headless真实EditorState和实际EditorView。

工厂 `createFileController({raw,authority,schema,ids,plugins,recovery?,onDelta?,policy?})`以调用者传入的最终身份schema创建完整session与初始bindings，不二次包装schema；提供 `state` / `view` getter、`dispatch(tr):boolean`、`probe(tr):boolean`、`executeSlashCommand(command:FileSlashCommand,execute:boolean):boolean`、`snapshot():FileSnapshot`、`runHistory(direction:'undo'|'redo',execute:boolean):boolean`、`replaceSource(input):FileResult`、`restoreContent(raw):FileResult`、`bindView(view|null):void`、`setReadOnly(value):void`、`setComposing(value):void`、`observe(listener):()=>void`。`prepareHistory(tr)` 是 file-history 私有消费接口；readonly/composing 检查已经在生产入口执行，不能等 Task 3 才补。controller 只持有一个既定 authority；Task 3 owner 的 baseline 切换会先构造新 controller 成功再替换旧实例。
`onDelta?: (delta:ObserverDelta)=>void`只由成功publish调用，生产接tracker的recordEditorDelta；无DOM测试接同一回调接缝，不另造observer模拟。
它不是另一history：plugins含且仅含一个原生history()；legacy withGovernedHistory不调用；firstFilePlugin永远排列在history/所有filter之前。
controller闭包只有当前已安装EditorState、view引用、readonly/composition flags、同步attempt和transaction-local WeakMaps；source/layout值在Plugin.state，不存在外部可提前改写的第二副本。
WeakMap `intents`区分 source/history/restore/insert/move/gfm-table；无法伪造的entry由本模块入口创建；未标记标准tr只按local-rich审核。
`Prepared={baseFileState,beforeDoc,stepsJSON,finalDoc,metaFingerprint,nextFileState}`，fingerprint含addToHistory、appendedTransaction引用、trusted intent及其generation、history plugin meta引用。
`prepareActual(tr,state)`读取state中的当前fileState；不要误读controller的旧root state，因为append的base已是暂存新代。
source/history走已冻结候选/有序载荷；local-rich投影→M→core block result→bindings→身份步骤→raw Step→必要layout Step。
append默认只有在root origin=local-rich且实际标准source producer获准时视为其后续Rich操作；Source/history/authority/recovery append不补M。
无step selection/storedMarks事务原样允许且无raw变化；storedMarks与新doc同时发生时不得修改source权限，按实际source能力判断，不强行取消输入法stored marks。
任何user文档/source/layout变化标addToHistory:false拒绝为不支持的非历史来源变更；init/rebase/recovery另走显式owner边界。现有被移除的两个展示append不受此“改flag”替换。
准备时把新payload附到原tr，除已知no-docStep外所有真实steps/docs/mapping完整保留；不能给history看伪造shadow。
source/layout prepare失败将attempt.failed=true且filter返回false；不得只忽略失败append然后仍发布root。
后filters修改steps/doc/被保护metadata：firstFilePlugin.state.apply再比fingerprint，抛私有FileAdmissionFailure；临时state丢弃，不能返回旧source而继续新PM。
state.apply只返回Prepared.next，不触发save/notify/analytics、不写全局registry；无Prepared的真实内容变化是失败。
`dispatch`只调用一次 `base.applyTransaction(tr)`；catch自身AdmissionFailure返回false，未知异常保留诊断并返回失败，不更新view。
最终要求attempt无失败、所有经首filter准备的内容事务都实际出现在result.transactions、result.state完整fileProjection一致；否则discard全部暂存state/history。
随后仅调用一次policy.acceptRawChange(installedRaw,finalCandidateRaw)，包括root及完整append链；准入框架不在prepareActual/state.apply/history各delta或slash中间dispatch运行policy。true只代表通过额外veto，不能替代此前每个原始Step的source/protected/身份/layout许可；false/throw丢弃整个临时state/history。纯selection/layout/no-raw变化也只在这一最终边界调用，默认无policy等价允许。基线安装属于Task3明确authority边界，不伪装为Rich/restore逃过veto。
通过才设置current=result.state、view.updateState(current)，之后按**整个chain**发一次raw变化通知/统计/保存排程；layout-only发视图状态，不正文dirty。
普通后filter拒绝root→transactions=[]返回false；selection-only append按PM正常机制；真实内容append被其它filter拒绝也整链失败，避免来源半提交。

```ts
// controller核心时序；prepareActual/assertPrepared/validateFinal均按上文实现。
function admit(tr:Transaction,execute:boolean):boolean {
 if (inDispatch || tr.before!==current.doc) return false
 const base=current,frame={failed:false,prepared:new Set<Transaction>()}
 inDispatch=true;active=frame
 try {
  const result=base.applyTransaction(tr)
  if(frame.failed || result.transactions.length===0) return false
  const applied=new Set(result.transactions)
  for(const t of frame.prepared) if(t.steps.length && !applied.has(t)) return false
  validateFinal(result.state)
  const beforeRaw=readFileState(base).session.source
  const afterRaw=readFileState(result.state).session.source
  if(policy && !policy.acceptRawChange(beforeRaw,afterRaw)) return false
  if(!execute) return true
  current=result.state
  attachedView?.updateState(current)
  publishAccepted(base,current,result.transactions)
  return true
 } catch(error) {
  recordAdmissionError(error)
  return false
 } finally {active=null;inDispatch=false}
}
function dispatch(tr:Transaction):boolean { return admit(tr,true) }
function probe(tr:Transaction):boolean { return admit(tr,false) }
```

`readFileState(state)`是Task2私有getter，只读取首file plugin key的FileState，缺状态即AdmissionFailure；不读第二份source。probe同样完整applyTransaction+append+最终policy一次但不安装/通知，不能用仅PM canExecute替代。

`publishAccepted`比较sourceHash与raw，raw变化调用onChange/observe；generation变更但raw不变只更新history菜单/布局；监听抛错单独捕获，不把已安装成功回报失败。
`recordAdmissionError`只更新失败状态/诊断回调，不改source/history；未知内部异常在dev测试必须可见而非吞成通过。
重入onChange产生的新编辑排到microtask，从最新generation重新建立tr；不能复用旧tr硬重放。

- [x] **2.2a 窄同步slash多dispatch组合，Task2首次完整实现。** 实测RichEditor.svelte:521–543先删除slash再执行item；block-helpers.ts的insertTaskList还会wrap与checked两次dispatch。不能先发布删除，再让失败command丢用户输入。本合同只组合上述已证实的同步state/dispatch/focus调用，不构造通用事务脚本框架。

```ts
// Task2新src/lib/slash-menu/slash-command.ts，纯模块，无Svelte/Tauri。
import type {EditorState,Transaction} from 'prosemirror-state'
import type {FileSlashCommand} from '../../editor-kit-v2/file-contract'
export interface SlashCommandTarget {
 readonly state:EditorState
 dispatch(tr:Transaction):void
 focus():void
}
export function runSlashCommand(target:SlashCommandTarget,id:FileSlashCommand):boolean
// block-helpers既有setBlock/wrapBlock/wrapList/insertAtom/insertTable/
// insertTaskList的参数改为结构兼容的上述窄type并返回boolean；真实EditorView可直接传。
// 原无UI的literal/spreadsheet producer从slash-items移到本模块，同一份实现。
```

controller入口 `executeSlashCommand(id,execute)`先验证非readonly/noncomposing、当前empty selection在paragraph、从段首到caret实际匹配既有 `/^\/([a-zA-Z0-9一-龥]*)$/`；旧selection/generation不得由caller指定。只接FileSlashCommand已定义枚举，不能传任意callback/JSON Steps。
构造临时**真实EditorState**，使用当前schema/doc/selection/storedMarks、无plugins（所以没有history/filter/append/save/observer），它只是命令计算所需PM草稿，不建第二SourceSession。窄target的state getter返回此临时state；focus只记最终成功后需要focus，不操作真实view。不给dom/someProp/coordsAtPos/dispatchTransaction等成员，也不cast成EditorView；helper若实际要求这些成员，停止报告精确consumer，不能补假view逃类型。
第一笔真实tr删除段首slash/filter；第二及后续由runSlashCommand复用真实helpers实际发出。collector每笔验证tr.before===临时state.doc、schema一致；逐个验证tr.docs[i]与本次真实step.apply(before)产物一致，step必须原生已支持exact prototype。按原顺序将**同一原始Step对象**追加到以最初controller.state.tr构建的combined；不能从最终doc生成单一Replace，不能缩小原range、改slice或去除失败中间Step。
每笔末尾selection以真实Selection.map/JSON对应当前同doc安装到combined，storedMarks按tr.storedMarksSet/selectionSet的实际PM结果保持；collector用临时state.apply(tr)得到下一state（无plugins不触发append）。最终combined.doc、selection、storedMarks必须与临时state相等。scrollIntoView若任一笔设置则在combined置一次；time用整次命令开始时的真实time。addToHistory:false、history/source authority metadata及未知影响内容的meta拒绝；GFM实际提示按每笔的before/doc/step序号放controller私有记录逐项经既有verifyTableIntent验证，不能last-wins覆盖前一笔hint，也不能把hint提升为source许可。
runSlashCommand返回false、未发必要变化、任何collector步骤错误/异常→combined丢弃，真实state/view/raw/bindings/layout/selection/history/slash字节/observer完全不变。不能在调用item后才发现返回Promise：注册表只包含同步producer，异步image/doc/dialog/import/annotation popup根本不在此入口中。
命令成功后把combined交同一controller.admit；**只在这里**运行完整root+append/filter、source权限、bindings/layout/history载荷与最终policy。保留原steps链，core M/identity/payload照既有准入追加；临时命令阶段不跑append、不作raw提前安装。安装只一次、一个原生history event；`closeHistory`分组只对已受理事件生效，拒绝不能改变真实history metadata。probe走同样真实collector与admit(false)，不focus。
异步UI准备必须先完成，之后重核当前owner authority/generation、完整selection JSON和slash字节范围，任一变化则取消而不是套旧selection写入。准备结果只可转成现有受支持的同步producer；未具同等producer的入口保留原slash并明确不可执行，不在file模式退回先删文本的旧路径。独立Desktop附件/批注功能保持原有路径，不能以窄capture为由删除原scope；它们需要组合slash时在首次真实UI Task补明确consumer验收，不借此开放一般callback权限。

同步producer首次定义在Task2，同Task修改旧slash-items委托它、维持桌面菜单id/顺序/文案，controller只import纯slash-command；Task3 owner.executeSlash/canExecuteSlash仅委托，delivery Task1再提纯UI metadata/翻译与菜单壳，不倒置运行时依赖。

- [x] **2.3 history命令闭包。** `file-history.ts`使用唯一PM undo/redo，原state传入，不走BlockBookmark。

```ts
function historyCommand(command:Command,execute:boolean):boolean {
 const result=withSourceHistoryAttempt(()=>{
  let candidate:Transaction|undefined
  const available=command(controller.state,tr=>{candidate=tr},controller.view??undefined)
  if(!available || !candidate || !candidate.steps.length) return false
  const prepared=controller.prepareHistory(candidate)
  if(!prepared.ok) return false
  return execute ? controller.dispatch(candidate) : controller.probe(candidate)
 })
 return !result.failed && result.value
}
```

`prepareHistory`在当前attempt内扫描candidate实际steps：普通标准steps只保留；已知SourceHistoryStep按出现顺序、其中deltas顺序replay current raw，核beforeLineage/hash与removed字节，再用F1 expectedRevision=current.session.revision。
逆向raw在candidate通常先于其语义inverse，不能每遇rawStep就强求当时tr.docs等于最终来源；先计算有序来源链，最终完整candidate.doc必须等于最终projectBindings。
bindings omitted时按相同完整rows验证candidate roots兼容；若该次F1使root布局变化，缺transition拒绝；有transition按完整before/after映像恢复。
layout同样按delta顺序比before值，构造最终registry；最后验证registry每个目标是最终doc中对应table的实际位置/列数。中间删表→恢复的正向逆序不能被过早doc查找否决。
sourceHash/lineage/authority/generation都由intent绑定；candidate来源JSON解码不自动获得history权限，只允许当前PM命令捕获的事务。
没有source载荷的语义内容变化在file history preflight中拒绝；已知layout-only允许doc全等、source不动。没有raw变化的初始化身份不造用户event。
canUndo/canRedo也运行一次native candidate+pure preflight+controller.probe的完整暂存append/policy，不安装、不消费真实history，不二次调用undo检查结果。
Task 2 交付 file 首 keymap；Task 3 接入 beforeinput 与 executeCommand，Task 4 接入 native 菜单，全部调用该入口。快捷键事件只preventDefault一次，原生textarea history不能再执行。

- [x] **2.4 layout registry与表结构提示。** `file-layout.ts`不依赖DOM，`file-resize.ts`唯一共享pointer/commit producer，DOM复用core窄TableView适配。

`scanTables(doc)`单次descendants生成实际table pos/columns；仅普通GFM矩形、colspan/rowspan=1、colwidth=null纳入session layout，unknown真实attrs仍按source guard拒绝，不清attrs伪装支持。
初始每张表分配session-local tableId、widths全null；nested多个同文表不同ID，不能以business ID alone区分。
一般Rich文字步骤按真实mapping的table外边界存续+node type核验保留ID；明确删除变null；不能从被删除映射后同位置新表复活旧ID。
已知gfmTableCommand当前整表Replace，故CORE在实际构造tr处加入 `'moraya:gfm-table-operation'` 提示 `{v:1,kind,tablePos,column}`；只对实际table命令dispatch设置。
HOST `verifyTableIntent`从tr.before该table与action/column重建预期行列变化，核全部未触碰cells/attrs、精确replacement Step及最终table；提示篡改不能授权限。
add-column在column+1插null；delete-column删column；行操作、alignment、next-cell追加行保留widths；整表新增new ID。
Source粗middleReplace：只有F1 untouched根在新绑定下的同一结构path/table shape证明可延续，或一对一retained**独占顶层table root**且shape不变，才保留widths。
其它无法证明的nested/替换目标显式生成before→null与新ID→nullWidths；该失效可undo恢复，不偷偷套同位置宽度。
move witness已证明的完整root携其table registry按实际slice内偏移平移；跨root重新排列不靠普通map猜。
`layoutDeltas(before,after)`按id确定顺序，只包含变化条目，冻结before/after；每项进入同一tr的TableLayoutStep，不放SourceDelta。
纯width gesture在closeHistory前后分组：gesture提交tr closeHistory，随后不含steps的closeHistory metadata tr关闭尾边界；一个拖动一个event，下一文字不并入。

- [x] **2.5 真正resize/read/preview。** file assembly `enableTableResize:false`，关闭upstream写colwidth的producer；legacy继续原columnResizing。

固定CORE setup只有columnResizing()，未提供自有table NodeView/render helper；上游producer写node colwidth，不能用其提交路径承载session-only宽度。
复用方案：CORE `plugins/session-table-view.ts`导出 `createSessionTableView({readWidths,register})`，返回标准NodeView factory；内部创建既有公开TableView，直接复用dom/table/colgroup/contentDOM、update与ignoreMutation。
`readWidths(getPos(),node)`返回安装态widths或null；`register({getPos,paint}):()=>void`向HOST索引登记，destroy注销。HOST纯layout安装后遍历paint，不依赖docChanged触发NodeView.update。
adapter的update先调用原TableView.update，再paint已安装widths；不改node、不构造带colwidth的代理doc，不复制table库。不兼容node返回false，让PM正常替换。
`paint(widths)`仅调整已有colgroup对应col.style.width和table的width/minWidth：null列清width并计默认25px，全部已定宽则固定总和，否则清width并设总minWidth；其余DOM/class保持原TableView。
HOST `file-resize.ts`只增加 `{read(tableId),commit({generation,tableId,beforeWidths,afterWidths})}` controller hook与pointer producer；commit生成真实TableLayoutStep，readonly/composing返回false。
固定两仓src未命中专用resize handle/cursor规则，不能声称已复用不存在的规则；继续既有table外观，只在共享app.css补.column-resize-handle/.resize-cursor及触屏handle的touch-action:none，Kit载入同一共享规则。
每个普通GFM cell右侧挂已有命名的非内容editable handle widget，宽5px、跨本cell高度；NodeView无需重建单元格。handle外不阻止事件，维持core刻意保留的原生跨cell文字选择，不引入tableEditing。
pointerdown仅primary pointer且button=0、owner可写/非composition时响应；通过view.posAtDOM与实际table/row解析column，保存generation/tableId/columns/beforeWidths/实际列rect.width/clientX和当前selection bookmark。
在handle捕获pointer并preventDefault，事件按pointerId独占；正文pointerdown、右键、多指非primary原样放行。readonly不显示可操作handle，也不得开始preview或commit。
pointermove只改本NodeView preview，width=Math.max(25,startWidth+dx)，非有限数不paint；其它列从beforeWidths读取，不改plugin state、不发doc/source步骤。
pointerup先移除本gesture/capture再核generation/tableId/shape，提交一次before→after layout delta；无真实宽度变化不造event。随后mouseup/click不能再次commit；原selection按同doc书签恢复。
pointercancel/lostpointercapture/Escape/blur/readonly切换/owner关闭均只取消并重画安装值，不能把cancel当up；释放capture触发lost事件因gesture已清而幂等退出。
用户拖动中任何source/布局/表结构安装均令旧generation失效并取消preview；pointerup提交失败也恢复安装态，不将旧width写到同位置新表。
触屏靠实际handle上预置touch-action:none与pointer capture；其它区域仍正常滚动/选择。iOS/Android pointercancel、多指/滚动与桌面鼠标均需真实设备验收，不以mousedown模拟或数字单测代替。
网页与Desktop使用同一hook/producer；新增最小read适配相对重写NodeView的成本是一个core现有wildcard入口，换取DOM/样式与库行为复用。

- [x] **2.6 暂存阶段外部副作用闭包。** 固定host `insights/observer.ts`在appendTransaction直接onDelta，必须改file接线。

在tracker抽出既有记录函数 `recordEditorDelta(delta)`；legacy analyticsPluginForEditor继续传同一个callback。Task 2 的真实 controller/EditorView 装配不挂该 observer，Task 3 file bridge沿用此规则；controller成功publishAccepted后按chain的真实mark ops/净size调用一次；拒绝链统计为0。
file移除core link-text/inline-code-convert与lazy markdown serialize通知（只在file opts不传onChange）；decorations/selection插件仍保留。
额外配置插件只允许其state/appends无外部提交；测试加入真实后filter/append拒绝，证明未发布raw/save/analytics。不是静默丢弃append链。

- [x] **2.7 file块命令保留，禁止重用legacy逐块parse。** `file-commands.ts`直接消费完整bindings与当前doc。

`executeFileStructural(controller,command,execute)` 将 move/delete/insert 参数交 controller 的私有 `prepareStructural(command)`；该入口调用同一 `file-commands.ts` 内部 `prepareFileStructural(state,fileState,command)` 构造实际步骤/候选事实，controller 根据当前安装态核验并登记 intent，返回 `{ok:true,tr,changed}` 或 FileFailure；`execute=true` 仅 dispatch 这笔已准备且generation仍匹配的tr，`execute=false` 在prepare后调用controller.probe完整准入但不安装。controller 的 WeakMap 只登记本入口实际构造的 move witness，JSON/meta/调用者自造步骤都不能注册。nonempty insert 使用本 Task 的 Source producer 私有入口，显式 `insert` intent 限定写集，不开放 Rich 绕过入口。file-commands 仅 type-only 引用 controller 的内部端口类型，controller 可以 runtime import 其 producer，不形成循环初始化；端口类型在 Task 2 本模块定义并由返回值推导，既有 file-contract 不复制状态字段。该合同与 commands/controller 在同一 Task 完整实现，没有 Task 1 stub 或 Task 3 算法依赖。

move-up/down：取指定root的完整business child slice；邻目标按自然root顺序选，保留中间synthetic节点原位；头/尾越界返回false。
上移插入点为前一个root.pmFrom；下移点为后一个root.pmTo；先delete旧 `[pmFrom,pmTo)`，再用该delete map映射目标边界后insert原slice。
私有WeakMap witness保存generation/原rootOrdinal/id/两step索引/原slice引用与完整eq/最终映射区间；不写公开metadata。
prepare阶段重新验证真实两步骤完全一致、实际slice、未重复插入、目标scope与当前base；candidate实际root须精确覆盖最终插入PM区间才继承ID。
后续M/身份步骤用其真实map更新witness区间；multi-emission root整体移动，不能只搬第一个child。
core guard可以把来源判为deleted+birth；host witness只补业务继承，不免除protected/结构能力拒绝。
block.delete直接删除完整root slice；最后自然root删除由core既有fallback规则给真实placeholder，file允许零natural roots；不沿legacy“至少一块”改空字符串块。
block.insert-after的content是explicit新块内容，但不独立parse：在目标raw seam构造整个文件候选，经prepareFileSourceEdits一次解析并限制写集为该插入，再用Source真实middleReplace接入，标记专用insert origin/明确新ID。
`insertPatch(raw,root,content)`取root.sourceTo为唯一插入锚点；换行采用该seam相邻实际CRLF/LF，空文件默认LF；前后各补到两个换行的最少数量，content原字节不规范化。
候选须恰有一个新增自然root，其raw范围包含全部非空content；原roots逐一经untouched对应保留且raw切片完全相同，插入不得吞并外root；不满足报告unsupported-block-insert。
content为空时改走真实空paragraph插入Step→Rich source guard→blank layout，选区进入该段；不分配业务ID，首次文字使其成为自然root时再分配。非空内容禁止删改protected/gap与尝试多个separator后挑可过结果。
真正raw无变化且PM完整相同的move no-op返回changed=false，但先核witness因果；不能只因PM eq跳过来源判断。

### 2.8 可执行状态测试（HOST file-controller.test.ts）

先在本 Task 创建共享 helper，仅包装真实生产 controller；不提供假 Source owner 或预置 history：

```ts
// HOST src/editor-kit-v2/file-test-utils.ts；首次需要在 Task 2，不等 Task 4。
import type {Plugin} from 'prosemirror-state'
import {history} from 'prosemirror-history'
import {defaultSchema} from '@moraya/core/schema'
import {withBlockIdentitySchema} from './identity'
import type {ObserverDelta,FilePolicy} from './file-contract'
import {createFileController} from './file-controller'
export function testIds() {
 let n=0
 return {blockId:()=>`b${++n}`,lineage:()=>`s${++n}`,tableId:()=>`t${++n}`}
}
export function open(raw:string,plugins:Plugin[]=[],onDelta?:(d:ObserverDelta)=>void,policy?:FilePolicy) {
 return createFileController({raw,authority:'snapshot-1',schema:withBlockIdentitySchema(defaultSchema),
  ids:testIds(),plugins:[...plugins,history()],onDelta,policy})
}
```

下列 controller 测试直接 import 上述 helper：

```ts
import {expect,it} from 'vitest'
import {Plugin} from 'prosemirror-state'
import {undoDepth,redoDepth} from 'prosemirror-history'
import {open} from './file-test-utils'
it('同doc的raw编辑、连续undo/redo保留字节与lineage',()=>{
 const c=open('_甲_'),before=c.snapshot(),doc=c.state.doc
 expect(c.replaceSource({expectedGeneration:before.generation,value:'*甲*'}).ok).toBe(true)
 expect(c.state.doc.eq(doc)).toBe(true)
 expect(undoDepth(c.state)).toBe(1)
 expect(c.runHistory('undo',true)).toBe(true)
 expect(c.snapshot().raw).toBe('_甲_')
 expect(c.snapshot().sourceRevision).toBeGreaterThan(before.sourceRevision)
 expect(c.runHistory('redo',true)).toBe(true)
 expect(c.snapshot().raw).toBe('*甲*')
})
it('后filter拒绝不安装source或history',()=>{
 const c=open('甲。',[new Plugin({filterTransaction:tr=>!tr.docChanged})])
 const before=c.state,raw=c.snapshot().raw
 expect(c.dispatch(c.state.tr.insertText('乙',1,2))).toBe(false)
 expect(c.state).toBe(before);expect(c.snapshot().raw).toBe(raw)
 expect(undoDepth(c.state)).toBe(0);expect(redoDepth(c.state)).toBe(0)
})
it('append第二笔非法来源使整链回滚，首笔也不发布',()=>{
 const plugin=new Plugin({appendTransaction(ts,_old,next){
  if(ts.some(t=>t.getMeta('test-append'))) return null
  if(!ts.some(t=>t.docChanged)) return null
  return next.tr.setDocAttribute('unapproved','x').setMeta('test-append',true)
 }})
 let onDeltaCalls=0
 const c=open('甲。',[plugin],()=>{onDeltaCalls++}),before=c.state
 expect(c.dispatch(c.state.tr.insertText('乙',1,2))).toBe(false)
 expect(c.state).toBe(before);expect(c.snapshot().raw).toBe('甲。')
 expect(onDeltaCalls).toBe(0)
})
it('definition-only可增段落并恢复零自然root',()=>{
 const c=open('[id]: /u\n')
 expect(c.snapshot().bindings).toEqual([])
 expect(c.replaceSource({expectedGeneration:c.snapshot().generation,value:'[id]: /u\n\n甲。'}).ok).toBe(true)
 expect(c.snapshot().bindings.length).toBe(1)
 expect(c.runHistory('undo',true)).toBe(true)
 expect(c.snapshot().raw).toBe('[id]: /u\n');expect(c.snapshot().bindings).toEqual([])
})
```

`file-controller.test.ts`新增最终veto测试：root改字+合法append恢复原文只调用policy一次，before/after取整笔首尾；history多delta中间删除owner再恢复最终floor允许；policy=false/throw、late append使floor失败、后filter篡改都断言state对象/完整snapshot/selection/undoDepth/redoDepth相同，observer/save/analytics为0。probe与真实dispatch相同允许/拒绝而probe不消耗event；Rich、raw-only Source、restoreContent、undo/redo均走同边界。
`file-commands.test.ts`新增真实 `executeSlashCommand('h1',true)`、`('task',true)`（含helper内部多dispatch）、code/mermaid/table、literal正例：原始step顺序保留、最终raw/schema独立expected、仅一次通知/一个history event，undo恢复slash原字节。负例注入真实后filter/append/policy拒绝、producer实际第二笔不受source许可、stale selection/generation、readonly/composing，均保留slash。Task2直接调用实际生产注册表/collector，不用未来file-menus或手写final Replace代替；为每笔tr.before/tr.docs错配与未知metadata添加独立拒绝测试。

`file-commands.test.ts` 使用生产 adapter/controller 检验上下移、no-op、同 Node 复用、重复正文、multi-emission、跨 synthetic、原 protected 失败、非空 insert 的唯一 birth/原roots untouched、空 insert 的真实 paragraph/blank layout 及最后 root 删除。`file-controller.test.ts` 补 Source 改变 PM 语义的真实 ReplaceStep/undo/redo、surrogate/CRLF 边界、远处 reference attrs、generation stale/no-op，确保 raw-only 正例不掩盖缺失 middleReplace。
CORE `session-table-view.spec.ts` 用真实 TableView 验证 read/paint/update/destroy/col DOM，不复制第三方 NodeView；`table-layout-hint.spec.ts` 调真实 gfm 命令校验提示只随实际 dispatch 产生且可重建。HOST `file-layout.test.ts` 包含伪造 hint 拒绝、nested 同文表/列删增/source 粗替换失效/undo 恢复；`file-resize.test.ts` 覆盖 cancel/readonly/composing/generation 的状态分支，浏览器路径另外验证。
追加真实测试：A→B→A以closeHistory分两个event；多delta逆序；漏semantic inverse的candidate拒绝；late filter篡改metadata；源/布局CAS任一错整事件拒；table resize+typing+delete→undo全恢复；不按最终raw相同消掉source lineage。
Task 2 的 browser `resize` case 用实际鼠标在两列连续拖动、undo/redo、add/delete列/表，断言真实col DOM、selection、source bytes与每次up仅增加一个history event；readonly/cancel/lostcapture/Escape/拖动中输入均零commit，handle外跨cell选择与触屏滚动保留。不能以直接调用commitWidth代替鼠标路径。切Source/回Rich后宽度与同一history的验证在 Task 3 的 `mount` case 增加，避免 Task 2 import 未创建的 owner。

```sh
# CORE Task 2 新增生产接口的 focused tests，随后执行共同 core 门槛。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/session-table-view.spec.ts src/__tests__/table-layout-hint.spec.ts
# HOST Task 2；基于此 Task 已提交并安装的 core 产物。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/editor-kit-v2/file-controller.test.ts src/editor-kit-v2/file-history.test.ts src/editor-kit-v2/file-layout.test.ts src/editor-kit-v2/file-commands.test.ts src/editor-kit-v2/file-resize.test.ts src/lib/slash-menu/slash-command.test.ts src/lib/slash-menu/slash-items.test.ts src/editor-kit-v2/governed-history.test.ts
FILE_EDITOR_OUTPUT_DIR="$FILE_PLAN_OWN/browser" FILE_EDITOR_CACHE_DIR="$FILE_PLAN_OWN/vite-cache" node scripts/check-file-editor-browser.mjs --case resize
```

## Task 3：工厂、Source owner/textarea生命周期与可选file公开入口

**Files。** CORE 修改 `src/setup.ts`，新增 `src/__tests__/file-create-state.spec.ts`；不在此 Task 才补 NodeView/hint/source 算法。HOST 新增 `src/editor-kit-v2/file-source-input.ts`、`file-main.ts`、`file-source-input.test.ts`、`file-owner.test.ts`、`file-mount.test.ts`、`src/lib/file-editor-sessions.ts`，修改 `src/editor-kit-v2/main.ts`、`commands.ts`、`src/editor-kit/rich.ts`、`src/lib/editor-bridge.ts`、`src/components/{EditorPane,RichEditor,SourceView}.svelte`、`src/lib/tabs.svelte.ts`；扩展 Task 2 的 `scripts/check-file-editor-browser.mjs` 加 `mount` case。复用 Task 1 file-contract 和 Task 2 file-test-utils，不新建同名/另一版类型或 helper。

**Consumes。** Task 2 真实可运行的 controller/replaceSource/restoreContent/history/commands/layout/resize、已安装 core NodeView/table hints；正式前置已受理的 inline/annotation/empty-body 能力矩阵。Task 3 只做工厂、DOM/owner/textarea/真实 UI 接线，不能在此才实现 Task 2 测试依赖的 raw producer。

**Produces / API。** CORE 三个可选工厂 callbacks；HOST `mountFileEditor` / 完整 `FileEditorOwner` / `attachFileSourceInput`，以及真实DecorationHost/annotations/adapters/render透传；policy与slash原子性只委托Task2。`file-main.ts` 持有 owner 的当前 controller 引用和输入适配器，公开方法委托 Task 2 实现；`installBaseline(input,options?)` 先解决 composition/pending，再以目标policy完整构造目标 controller，成功才原子交换 policy/authority/state/view/订阅并关闭旧资源，失败旧policy/authority/history全部保留。省略options沿用当前policy以兼容普通host；`{policy:null}`仅trusted宿主明确去掉附加veto，不能从URL、received内容、草稿或公开ShareEditor API传入，也不能关闭core来源/protected守卫。不增可变policy setter。`flush` / `close` 等待输入适配器，不能只返回旧 snapshot 冒充 buffer 已安装。restoreContent 和普通模式切换均不重建 controller/history。

**具体测试 / 提交边界。** core factory 首帧同 schema/capture 与默认 legacy 路径在本 Task 验证后提交/安装；HOST owner/source-input/mount strict tests 与真实 `mount` 浏览器 case 后精确提交。Task 2 所有测试原样保留通过；本 Task 首次验证切模式/textarea IME/pending/桌面 tab 生命期，不依赖 Task 4 persistence/native 菜单实现。

- [ ] **3.1 core最小工厂seam。** CreateEditorOptions新增三个optional callbacks；默认调用路径保持原样。

```ts
configureSchema?: (base:Schema)=>Schema
createState?: (schema:Schema,plugins:readonly Plugin[])=>EditorState
dispatchTransaction?: (view:EditorView,tr:Transaction)=>void
```

createEditor在createSchema之后立即configureSchema，随后用最终schema构建plugins与NodeViews；到state初始化时调用createState或既有parse默认。
createState存在时连默认initialDoc parse表达式也不求值：file初值唯一来源是最终schema下同一次createSourceSession/capture.doc再projectBindings，直接建立首个EditorState与EditorView。不能先装legacy parse doc后无通知替换。
root当前实证BOM+frontmatter时legacy parseMarkdown与capture初值不同；本批不改legacy去BOM规则，file传给capture的raw保留BOM，后续所有snapshot/保存bytes原样。
EditorView props使用普通function的this view转交dispatchTransaction，缺callback时保留PM默认dispatch，不先模拟apply。
callback返回state须schema===最终schema；否则挂载失败，销毁已建立资源。core不import SourceHistoryStep、不认识file业务。
file-main构造controller并以createState返回其真实state；过滤两展示插件，首插件与自定义resize/keyboard先排好，只有一个history。
file facade的getMarkdown/flush使用owner raw，setContent不暴露给任意外部调用者；explicit restore/baseline必须走owner不同入口。
Kit legacy mountRich的customizeSchema二次初始化保持旧分支；file参数走新configureSchema/createState一次最终schema，不重复parse初值。

- [ ] **3.1a 首次mount透传真实依赖/装饰/批注，不等delivery另建factory。** Task1的FileAdapters/FileRender/FilePolicy由file-main透传：共享file-main/file-contract/file-controller保持browser-safe，只接调用者显式adapters；未传字段仅可沿core已存在的browser-safe默认，无默认的必需项仍须调用者提供。桌面在本Task原范围内的src/components/RichEditor.svelte调用处（沿既有editor-kit/rich.ts、editor-bridge接线）组装现有mediaResolver/rendererRegistry/linkOpener/platform/spreadsheetViewFactory/frontmatterViewFactory并传入；browser显式传bundle resolver等网页依赖。共享路径不得静态或动态导入desktop工厂、Tauri总模块或默认bridge，不靠传参后的tree-shake、dynamic alias掩盖依赖；不增第二factory。render只覆盖已列三项；file固定enableTableResize:false、自有history/initialState/dispatch，caller不能覆盖。实际frontmatter NodeView必须在首个view就用这些依赖和同次capture.doc，空frontmatter/BOM/CRLF零初始化写入。
policy在创建Task2 controller时一次传入，不到DOM层另筛tr；readonly/composition仍用原controller开关。setMode/flush/close不创建另一policy或另一source session；rejected root/append全链不发布。
`decorations`实际实现复用contract.DecorationHost的setLayer/removeLayer，以FileSnapshot.bindings真实自然root ID映射DecorationSet；proposal/activity/assessment-outdated层只影响UI，无fake全文件block，无raw/history/save/observer改动。层多次设置/移除、绑定根消失/重排、Source隐藏再Rich、destroy清理有真实PM decoration/DOM测试；旧Memory/CDR DecorationHost不改签名。
`annotations.insert(seed?)`对当前真实view调用 `src/lib/note-anno/note-commands.ts::insertNoteRich`；`editAt(position)`按实际annotation mark/note_anchor调用openEditForMark/openEditForAnchor，用真实view.coordsAtPos构造anchor，不造字符串写入。回调save/remove仍走同controller.dispatch/源保真；readonly/policy拒绝后不报保存成功或关闭成已完成。现有noteBadgePlugin、NotePopover/NoteEditPopup在相同noteUi上展示；纯UI的i18n依赖拆分属于delivery Task1，本Task desktop可沿现有真实组件，不能为browser测试stub Tauri。
annotations仅在mounted Rich view可用且position对应当前generation有效时执行；Source显式通过已有Source批注consumer或返回不可执行并保留buffer，不给Source raw授Rich权限。owner.executeSlash/canExecuteSlash委托Task2真实collector；本Task只接实际菜单/快捷键/IME入口与合法async-prepare后的stale复核，不重写collector。
policy在initial mount与每次成功baseline构造时冻结；新controller候选通过全套校验才交换。ShareEditor实际rebase/undo-rebase必须用目标snapshot+目标draft显式构造新floor并传`installBaseline(input,{policy:newPolicy})`，不能依赖省略参数沿用旧floor。普通restoreContent仍走当前policy与同一history。测试用旧base含O、新base不含O及反向例证明沿用旧floor失败/保护不足；显式新policy成功，故障注入保持旧policy/authority/history，URL/draft无法选择null。

新增mount测试注入具体media resolver返回fixture data、renderer spy、platform、frontmatter factory，在真实NodeView证明首次消费，并断言没有默认bridge读取；DecorationHost层raw/history不动；调用真实annotations handle→noteUi.edit.save/remove，raw独立expected且source/PM一致、保存拒绝保留draft。适配器异常在挂载候选完成前退出并清理，不关闭原owner。

- [ ] **3.2 Source input适配与IME。** `file-source-input.ts`提供 `attachFileSourceInput(textarea,owner,{paint,onPendingError})`，Desktop SourceView与Kit Source pane共用。

adapter保存mounted generation、installed raw、composition buffer和selection；所有普通input/自动配对/粘贴/Find replace最后都经过同一commitBuffer，不直接setContent(tab)。
非composition input：以installed generation提交整个ta.value差分；成功更新installed并paint；失败保留ta.value作为pending buffer，标识未提交，不覆盖owner/raw、不允许flush误称保存成功。
compositionstart固定base raw/generation；composition input只paint buffer不提交；compositionend在requestAnimationFrame读取最终value，幂等只提交一次；尾随同value input不重复。
composition中undo/redo与模式切换不执行，flush等待compositionend；外部baseline安装延后/明确返回composing，不中途覆盖IME。
beforeinput historyUndo/Redo在非composing时preventDefault并owner undo/redo；keydown Mod-z/Shift-z/y同入口，处理过的事件不再由beforeinput重复触发；浏览器实际无可取消history事件必须平台gate失败而非假通过。
owner订阅更新textarea.value时，若当前无pending buffer用新raw并恢复可界定selection；pending buffer不静默丢，用户明确重试/放弃前阻止切换、关闭成功和基线替换。
detach移除listeners，destroyView不关闭owner；未提交buffer先交上层保留或flush失败，不能随组件unmount丢失。

- [ ] **3.3 Desktop owner存活。** `file-editor-sessions.ts`以tab.id存owner，ordinary Markdown且非managed Memory才启用；code/csv/base/第三方视图不强迁移。

EditorPane首次显示file Rich/Source都先获取owner；Source初开也建立同一PM state/history。tab.currentContent由已安装snapshot通知更新；同owner回写不触发external baseline循环。
Rich模式隐藏/切Source时可以保留Rich DOM，也可detach view但保留owner EditorState；重挂使用owner.schema/state，不能重parse或新history。只有真正关闭tab且flush完成才owner.close。
最小首版保留Rich DOM以CSS hidden切换，Source同一parent条件装配；改变tab.mode不进入旧Rich销毁分支。tab切换detach与真正关闭通过tabs事件区分。
Rich readonly分支改为owner.setReadOnly，禁止覆盖dispatchTransaction；selection仍可，Source/raw-only用户Step同样受readonly限制。
file bridge新增可选owner参数并合成真实renderer/media/frontmatter/IME；legacy bridge保留现有setContent/observer路径。
外部文件reload是明确baseline事件：先flush/处理pending buffer，变更authority并重开history；桌面restoreVersion若用户选择“恢复内容”，应调用restoreContent形成可撤销本地操作，再保存，不能先写盘reload绕开owner。
SaveAs仅改documentId/path宿主定位，不因路径变化清同一编辑会话history；真正换文件内容才baseline。

- [ ] **3.4 可用能力与测试。** file execute普通命令复用commands.ts；给其history命令注入ownerundo/redo，其它command仍真实PM命令。canExecute须捕获真实候选并纯source准备，不只用PM结构可用性误报。

nested 本身只覆盖 plain exact 和限定单正文 strong/em fragment 等已声明能力；因此本计划正式 BASE 还必须包含后续 inline / annotation / empty-body 的受理产物。Task 3 对实际 toolbar/InputRules/批注 anchor/空 paragraph 与空 cell 输入逐项执行已冻结能力矩阵；预定能力被 guard 拒绝是未完成，须修相应 producer 或重新裁定范围，不能把安全拒绝算成功。超出该矩阵的能力明确保留边界，不以 Source 权限偷偷放行；完整 §12.9 仍需全部相应验收。
file-mode用户块insert/delete/move API全部实际连接，不保留旧preserveSource直接return false的总开关。
新增 `file-source-input.test.ts`、`file-owner.test.ts`、`file-mount.test.ts`：三次模式切换同state/history、raw-only通知、readonly/IME、同schema最终capture、unknown pending保留、last-root删除。
file-mount真实挂载含BOM+frontmatter原文：首个NodeView收到capture中真实frontmatter节点，首个view.state中neutralize(doc)即等于同次capture.doc；初始化零dispatch/零onChange/undoDepth=0，snapshot.raw完整含BOM，切Source/Rich三次不变。禁止测试先去BOM掩盖file初值错误。 同组再验空frontmatter原文 `---\r\n---\r\n`：legacy初值与capture可能不同，必须首帧直接使用final schema下capture.doc，实际NodeView空body可触发onChange且raw保留CRLF；不能先旧parse再静默updateState来通过首帧验收。
扩展 Task 2 已建立的浏览器脚本 `scripts/check-file-editor-browser.mjs`，新增 `mount` case 使用独立临时fixture挂载真实mountFileEditor，包含拖列后切 Source/回 Rich 与跨模式 undo/redo；复用已安装Playwright位置和空envDir，输出到调用方 `FILE_EDITOR_OUTPUT_DIR`，缺变量即失败，禁止旧OWN默认。

```sh
# CORE 工厂实现与默认路径同时覆盖；先提交/安装再运行 HOST。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/__tests__/file-create-state.spec.ts
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/editor-kit-v2/file-source-input.test.ts src/editor-kit-v2/file-owner.test.ts src/editor-kit-v2/file-mount.test.ts
FILE_EDITOR_OUTPUT_DIR="$FILE_PLAN_OWN/browser" FILE_EDITOR_CACHE_DIR="$FILE_PLAN_OWN/vite-cache" node scripts/check-file-editor-browser.mjs --case mount
```

脚本case必须输入真实键盘/点击Source切换/拖列/快捷键，保存raw与PM JSON、实际hunks、console/page errors、installed core/hash、浏览器版本和截图。合成composition仅状态回归，不能标真实中日IME通过。

## Task 4：保存恢复、分享适配、native菜单与最终验收

**Files。** CORE 无预定改动，消费 Task 3 committed installed 产物。HOST 新增 `src/editor-kit-v2/file-recovery.ts`、`file-recovery.test.ts`、`src/share-editor/file-session.ts`、`file-session.test.ts`、`src/lib/file-history-focus.ts`、`file-history-focus.test.ts`；修改 `src/lib/project-share/{types,browser}.ts`、`src/App.svelte`、`src-tauri/src/lib.rs`（route state 单元测试放同文件测试模块），并在已建立的 `src/lib/file-editor-sessions.ts` / `src/lib/editor-bridge.ts` / `src/components/{RichEditor,SourceView}.svelte` 连接保存回执与真实 focus/selection；扩展同一 browser 脚本为 `recovery` case。不得创建第二 source cache 校验器或 history router 栈。

**Consumes。** Task 1 唯一 FileRecovery 类型及 `restoreRecovery` 校验，Task 2 controller/native PM history，Task 3 已实现 owner 的 flush/close/baseline/Source input 能力，既有 Draft.previous/pending/IndexedDB 与桌面菜单 rebuild 流程。

**Produces / API。** `file-recovery.ts` 只提供 `recoveryFromSnapshot(snapshot):FileRecovery` 与 `acknowledgeSaved(previous,snapshot):{generation:number;hash:string}`，验证调用 Task 1 helper；`createShareFileSession` 对接已实现 mountFileEditor；file-history-focus 持有当前真实 owner 引用和选区，提供 `focusFile` / `leaveFile` / `routeHistory` 私有接线，Rust `set_file_history_route` 与 App 菜单事件消费同一 owner。菜单 state 无撤销内容副本。

**具体测试 / 提交边界。** 本 Task 的 recovery/share/focus 单元测试 + 严格 test TS、完整 host checks、实际 Tauri 编译/Rust route 测试、真实菜单与键盘/fallback/移动 IME 验收。保留 Task 1–3 回归，精确提交本 Task host 文件与 root 最终核定的双语未发布日志。设备/SDK缺失逐项未验证，不能用单元测试代替真机或宣告完整交付；本稿不生成 commit 或评审通过声明。

- [ ] **4.1 local恢复与pending闭包。** `file-recovery.ts`仅生成FileRecovery并调用 Task 1 `restoreRecovery` 验证，不复制 hash/完整覆盖算法；DraftV2新增optional `editorFiles:Record<string,FileRecovery>`。

Draft.after[path]唯一正文；saveDraft既有IndexedDB transaction同时保存after+editorFiles；源hash不符就丢缓存，旧draft缺字段正常打开，不升DB或wire版本。
`src/share-editor/file-session.ts`提供 `createShareFileSession({path,snapshotId,raw,draft,saveDraft,mountTarget})`：使用draft.after[path]或snapshotraw+缓存mountFileEditor；onChange更新after/cache，排程既有saveDraft。
保存序号 `{generation,sourceHash}`冻结在发起时；旧save完成只确认那代持久化，不清后续dirty；失败保留raw并允许原retry，不能把save回执当新authority。
browser现有导入/导出/校验链保留optional editorFiles或按hash规则丢弃缓存，不丢after；pending.body保持原冻结字符串，后续输入不能修改它。
建议送达仍只清pending/设置lastSubmissionId/按既有合同清Draft.previous；不调owner.installBaseline、不清native PM历史。
rebase先写Draft.previous并await durable save；再构造全新FileInput authority/snapshot并调用installBaseline；ShareEditor调用者必须同时以目标snapshot+目标draft显式传新policy，undo-rebase同样重建，不能省略参数沿用旧floor。失败保留旧owner/policy/history与previous，不半装。
撤销rebase从previous恢复base/after并重新建立明确authority历史边界；bindings缓存失配可重建。普通same-authorityrestoreContent继续可撤销。
E4保持工作.md/base/outbox权威；可选hash-bound恢复缓存不与文件争夺正文，不谎称多文件原子写；工作raw先写成功，旧缓存缺失/不匹配就重建。
本模块不接CDR ack-local/OperationBatch，不改Worker/ProjectEdit.afterMarkdown或签名协议。

- [ ] **4.2 native菜单最小真实路由。** `file-history-focus.ts`记录最后真实file编辑owner、view kind、generation、selection bookmark/textarea selection；仅真正focusin普通input/其它编辑器或owner关闭时解除。

菜单导致document短暂blur/activeElement=body不解除owner；点击普通搜索框切回native default。切Source/Rich仍同owner，避免focus roundtrip把选区恢复到旧doc。
JS发布 `{active,canUndo,canRedo,routeVersion}` 到新增Tauri命令 `set_file_history_route`；Rust在现有menu state中存最新routeVersion，过期调用忽略，主窗失焦到别的原生窗口恢复default。
沿现有build_menu/rebuild_menu：active时Edit前两项用具名 `file-undo/file-redo` MenuItem并设置enabled；不设accelerator（快捷键由webview处理）；inactive仍原PredefinedMenuItem undo/redo。
App现有menu-event switch新增两case发送给focus router；router核owner存活/authority/generation与composition/pending buffer，再调用同owner history，无document.execCommand替代file操作。
只有active/inactive或enabled改变才重建菜单，使用已有main-thread rebuild路径；locale/recent/plugin菜单继续同build_menu，不另维护第二菜单模板。
原生菜单和键盘重复触发是验收失败；普通input/legacy Rich的Predefined fallback必须真实验证，不能因为file路径成功就替换所有编辑器历史。
Rust相关测试新建route state顺序/旧generation无效的单元例；菜单focus/selection恢复必须桌面实机，不能只检查case字符串。

- [ ] **4.3 最终整合测试与实际数据。** `src/share-editor/file-session.test.ts`用生产适配与可控save Promise检查B保存飞行中继续C、pending.body不变、重开hash错回退、rebase/撤销rebase边界。

```ts
// file-recovery.test.ts；同一真实owner，save回执只影响宿主持久标记。
import {expect,it} from 'vitest'
import {undoDepth} from 'prosemirror-history'
import {open} from './file-test-utils'
import {acknowledgeSaved} from './file-recovery'
it('保存B完成不覆盖继续输入C且不清history',async()=>{
 const c=open('A'),b=c.replaceSource({expectedGeneration:c.snapshot().generation,value:'B'})
 expect(b.ok).toBe(true)
 const saved=c.snapshot(),depth=undoDepth(c.state)
 expect(c.replaceSource({expectedGeneration:saved.generation,value:'C'}).ok).toBe(true)
 const current=c.snapshot()
 // acknowledgeSaved仅更新持久generation；生产recovery helper明确不dispatch。
 const durable=acknowledgeSaved({generation:0,hash:''},saved)
 expect(durable.generation).toBe(saved.generation)
 expect(c.snapshot()).toEqual(current);expect(undoDepth(c.state)).toBeGreaterThanOrEqual(depth)
 expect(c.snapshot().raw).toBe('C')
})
```

`acknowledgeSaved(previous,snapshot)`只返回generation较大的 `{generation,hash:sourceHash}`，过期回执返回previous；dirty以当前sourceHash/未提交buffer与durable值判定，不以last completed布尔清零。
测试直接 import Task 2 已提交的 `file-test-utils.ts` 唯一 `open`；不得等到 Task 4 才抽 helper，也不得复制一个假的controller供各测试自己通过。
真实I7语料：保留14原文、加nested前置已核的内嵌位置，一字改动expected直接由预定raw index替换而非serializer计算；actual propose恰一hunk。
普通prose按句，table按行，fence/math/HTML按实际块token；另断言仅一个raw字符改变，不为凑句子hunk修改tokenizer/diff。
三次Rich/Source无修改切换必须零bytes diff；Source format-only→Rich undo/redo、Rich字符→Source→redo、definition-only/空/BOM/CRLF/gaps全部覆盖。
平台：macOS Safari、Chrome、iOS Safari、Android Chrome实际中文/日文IME；Desktop macOS菜单+快捷键+普通input fallback。其它已支持桌面平台有native history事件差异时逐项列未验证，不虚报全平台PASS。
本批scope内失败修对应producer/controller，不能以全篇serializer或Source fallback完成验收；前置未涵盖能力形成明确后续项，E1完整验收仍不得勾完。

```sh
# HOST Task 4 focused tests；然后共同 host 门槛、现有 Rust 测试/编译与真实菜单验收。
env pnpm_config_verify_deps_before_run=false pnpm exec vitest run src/editor-kit-v2/file-recovery.test.ts src/share-editor/file-session.test.ts src/lib/file-history-focus.test.ts
FILE_EDITOR_OUTPUT_DIR="$FILE_PLAN_OWN/browser" FILE_EDITOR_CACHE_DIR="$FILE_PLAN_OWN/vite-cache" node scripts/check-file-editor-browser.mjs --case recovery
```

## 5. 共同验证、提交与产物闭包（执行时适配，当前不运行）

每个Task形成core/host精确提交（若只host则不伪造core提交）；只stage本Task verified allowlist，tasks目录和其它writer文件不进提交。
正式启动先等 nested + inline / annotation / empty-body 各前置受理，再冻结实际两仓 BASE、能力矩阵、allowlist、工具SHA；从本OWN已恢复工具适配新执行OWN，不读或复活旧/兄弟SDD路径。
所有pnpm加 `pnpm_config_verify_deps_before_run=false`；不新增依赖、不开隐式install、不读.env，不执行source .env。
严格测试配置由执行root在当前OWN生成 `tests-core.tsconfig.json`、`tests-host.tsconfig.json`：extends分别用两仓绝对tsconfig路径，compilerOptions覆盖noEmit:true/strict:true，include同时保留各仓实际 ambient shims.d.ts（若存在），再列截至当前 Task 已创建的累计测试，Task 2 起加入唯一 file-test-utils 绝对路径，exclude:[]；Task 1 不引用未来 test/helper/browser 文件，不以Vitest仅转译当类型通过。
每个 Task 的顺序：focused RED→实现→focused GREEN→严格test tsconfig编译→core full/typecheck/build→artifact audit→core精确commit→committed blob安装→host消费者focused/full/build及本 Task 已有 browser case→host精确commit→installed闭包。Task 4 无 core 变更则核对已安装 committed 产物，不捏造 core 提交；Task 1 无浏览器脚本，不运行未来命令。新增测试与生产 API 同 Task 可编译，不能以 TS import 失败计 RED。
若host暴露core错误，新增core修复commit，重新相关门槛并安装新committed产物；未变输入不重复suite凑通过次数。
保留全部declared exports target、DTS可达引用/ignored新hash DTS、source maps embedded sources、精确obsolete DTS清理；清理只针对显式实际上一安装 committed SHA→新HEAD 的 obsolete hashed DTS，原 BASE 不覆盖。
source-history 新入口必须与 core root 在同一消费者进程/host Vite 共享 chunk 实际导入并做 JSON roundtrip，确认单一 Step registry/prototype；历史类只能从 subentry 导入，root 不重导出它们；旧18入口仍全部可导入，新入口单独计入清单。
root index gzip≤102400；新subentry与host bundle增量独立记录，不隐性提高预算。增加M helper/工厂seam如超cap须削减重复代码或报告，不转为升级依赖。
两仓原fixture BASE/HEAD/working SHA一致；新增fixture单独登记；Memory legacy mount/local/remote/history/recovery回归和前后tracked指纹必须保留。

```sh
# CORE cwd；Task 1–3 代码稳定后各执行完整门槛，Task 4 消费原已验证产物。
env pnpm_config_verify_deps_before_run=false pnpm exec tsc --project "$FILE_PLAN_OWN/tests-core.tsconfig.json"
env pnpm_config_verify_deps_before_run=false pnpm test
env pnpm_config_verify_deps_before_run=false pnpm run typecheck
env pnpm_config_verify_deps_before_run=false pnpm run build
# HOST cwd，在committed core同步后；Vite由既有工具指定空envDir。
env pnpm_config_verify_deps_before_run=false pnpm exec tsc --project "$FILE_PLAN_OWN/tests-host.tsconfig.json"
env pnpm_config_verify_deps_before_run=false pnpm test
env pnpm_config_verify_deps_before_run=false pnpm run check:share-merge
node --input-type=module -e 'import {build} from "vite"; await build({envDir:process.env.FILE_PLAN_OWN+"/empty-env"})'
env pnpm_config_verify_deps_before_run=false pnpm run check:editor-kit
# Task 2 起才有脚本：分别指定 resize（T2）、mount（T3）、recovery（T4），并保留已有case回归。
FILE_EDITOR_OUTPUT_DIR="$FILE_PLAN_OWN/browser" FILE_EDITOR_CACHE_DIR="$FILE_PLAN_OWN/vite-cache" node scripts/check-file-editor-browser.mjs --case "$FILE_EDITOR_CASE"
# root唯一最终Svelte检查与真实Tauri编译；不靠Vitest转译代替。
env pnpm_config_verify_deps_before_run=false pnpm run check
```

`FILE_EDITOR_CASE` 由执行root按当前已实现 case 设置，脚本拒绝未知或未来case；fixture与脚本均依赖该 Task 已安装生产导出，不能拼接 fake controller。`FILE_PLAN_OWN`由执行root设置为当前实际OWN的绝对路径，run.py先检查其非空且位于当前OWN；browser脚本同样fail closed，不能落回旧目录。
Tauri编译沿仓库既有target/工具链执行并记录真实argv；平台SDK缺失是未验证，不是测试通过，不擅装SDK。
每Task独立spec/quality按root正式流程，最终唯一whole-range；本文不安排额外review席位、不填审查通过数。
root最后补双语未发布日志、真实commit/产物/平台未验清单；工作区测试或本计划checkbox不能证明进入安装包。本批受理后立即继续 E1–E4 delivery 与已授权的全量未发布更新统一发行，不停在前置提交。


## 前置inline实测追加接缝（待正式自审并纳入Task3）
既有createInlineCodeConvertPlugin在格式末尾插入真实U+200B，createLinkTextPlugin在光标进入链接时把mark变为无mark字面源码；它们是legacy展示编辑技巧。source producer严格保真消费会保存零宽字符或escaped link，故不能直接当file模式交付。
Task3工厂必须使用明确file模式配置隔离这两种展示性doc变形（不得运行后滤diff/静默丢append）；保留真实InputRules、正确storedMarks/光标移动、原链接编辑入口和legacy默认行为。沿本候选Task3原已写明的createState插件列表过滤这两个展示插件，不为此新增可选模式或第二工厂；真实mount测试须覆盖空strong/em/link→继续输入→移动光标→Source切换/save/undo，证明无多余U+200B、链接仍为链接、只有真实编辑改raw。其它语义append完整一次原子处理不变。该接缝是具名待完成项，不由当前producer测试passed关闭。

## 正式化裁定（root）

Ruling: correspondence 真实性在私有 controller 的实际 F1 调用点建立，pure nextBindings 只验证数据与实际 roots — 当前 SourceFileUpdate 是普通 readonly 数据，没有可供纯 helper 验证的 provenance token；只靠类型或 JSON 不能认证来源 — 成本是必须在 Task2 严格保持无外部 correspondence 参数的私有调用边界并验证伪造 metadata/JSON 不生效，不增加一套权限注册表。

Ruling: 候选稿 98304 字节旧预算更新为当前已正式执行的102400，保持上限而非预增 — 当前已验证产物101857，旧数字来自前置迭代前，不能把过时阈值当新承诺 — 成本是下一阶段新增能力仅余543字节主入口空间，若真实超限需减少重复或具名裁定，不能静默提高。

Ruling: 严格测试配置保留 ambient shim，安装清理前驱用真实上一已装 SHA — 前置已证明旧 BASE 在多轮新增 hashed DTS 后不再代表已安装来源 — 成本是工具需精确核包新增入口白名单、真实前驱与新HEAD，同时保护原包锁和语料闭包。


Ruling: Task1 constructor允许相邻且可严格反演的原edits；逆向同锚点的相邻组、组整体no-op必须先canonicalEdits，否则constructor拒绝，不内部静默改载荷；canonicalEdits仍单次合并所有相邻且不跨gap — 正式Task1既允许保留相邻又要求规范形式，两者以可逆性和真实非空变化统一，避免无必要改变F1写集 — 成本是规范形式并不要求所有相邻已合并，需正反向严格有序/整组no-op回归，且不同事务ABA不抵消；其余offset/removed/lineage/hash/bindings校验不变。


Ruling: Task1 multi-emission只在纯validate/project helper用显式构造的合法公开数据形状测试，同一真实PM doc的root/child/PM范围完整一致；不把该shape传CORE以获取来源权限 — 当前实际parser探针和既有ownership语料未找到一自然root发多个top child的真实raw例，合同类型允许此形状但不能伪报parser能力 — 成本是此项仅证明纯helper结构合同，不证明F1或UI真实多发射；其余capture/F1正例保持真实，后继若首次产生此形状需追加端到端验收。


Ruling: Task1原wide AddMark/RemoveMark可跨实际verified base已知synthetic/layout empty emission或fallback覆盖的无自然owner child，且每一实际Step该child before/after与baseline完整eq、top-child数量/位置保持；ReplaceStep与未知/改变synthetic仍拒绝 — 真实HOST A LF LF LF B一笔wide AddMark保持三个child且projection正确，CORE authorizeStepRoots却仅因中间已知未变化空段无natural root而拒绝，阻断本计划原始幅度跨body合同 — 成本是mark范围准入新增“跨越不变的已知空段”，不增加其正文/attrs/marks写权限；完整原range/Step/docs、protected/strict与mixed原子性保留，需真实CORE/HOST、CRLF/definition与负例验证，未授权修改source-inline或其它前置。


Ruling: 只迁移 source-block-fidelity.spec.ts 中“wide mark claims synthetic gap”的单个旧负例为正例，保留 production addMark 两个 steps 正例，单个真实宽 AddMarkStep 的独立 expected 为 **A**\n\n\n**B**，保留原幅度、四个自然 root delimiter inserts、gap/base/protected 不变；相邻 subclass/unknown/变化 synthetic 负例不改 — root 用已安装 CORE 的实际 capture 与 AddMarkStep 独立验证目标 doc.eq 且空段不变，此旧策略与已批准的跨已知不变空段合同冲突 — 成本是一次具名旧测试语义迁移，保留先前 1368/1369 失败证据，修改后重新执行 focused/strict/完整 CORE/typecheck/build/artifact，不将旧失败计为通过。


Ruling: Task1 HOST 只验当前绝对构建大小与真实 registry 闭包，baseline 同配置应用增量比较延至 Task3 首次产品 mount 接线验收，并在统一发行前完成 — 本 Task helper 尚未进入产品入口，现有证据确无 baseline，不能用 consumer chunk 假称应用增量；CORE 的固定主入口 cap 与真实增量已单独严格通过 — 成本是当前 HOST 体积增量仍未验证，Task3 必须用冻结 whole HOST/CORE BASE 与最终相同配置产物补证，未补不能宣称全阶段体积验收完成。


Ruling: Task2 起 CORE 主入口 Node gzipSync 默认 cap 由102400调整为103424（101KiB），仍逐次审计；不改变分享主IIFE的900KiB预算 — 实测仅table-commands真实操作hint使清晰去重后gzip102485（+85，raw+263），独立TableView gzip553未进入root；必要合同已最小实现，继续为85字节引入压缩式代码或拆分旁路会增加维护复杂度 — 成本是允许CORE主入口预算增加1024字节（1%），当前实际仅增85字节，后继仍不能自动提限；两次旧cap拒绝和全部原始数据保留。


Ruling: controller 首filter记录本次实际applyTransaction frame的expected root，state.apply只允许PM内部在filters之后设置 appendedTransaction 从undefined变为该真实root引用；其余引用或受保护metadata改变仍拒绝 — 已核当前prosemirror-state真实源码在filterTransaction成功后才setMeta，因此逐值不变会错误拒绝所有合法append — 成本是fingerprint新增一个精确框架时序例外，必须以真实frame而非caller metadata建立，补合法append、caller伪造与后filter篡改回归，原Step/docs和整链policy一次不变。


Ruling: 补充限定上一append时序裁定的“后filter篡改”：只验证实际进入state.apply的最终受保护值；PM无条件覆写掉的瞬时假appendedTransaction无需侦测，不封装每个filter或patch PM — 实际PM在全部filter后覆盖为真实root，首state.apply无法观测被抹掉的中间值，该值不能提供私有intent/source权限 — 成本是不承诺拒绝这种已被框架消除且无行为影响的瞬时赋值；测试须证明最终真实root生效、caller metadata不能授权，仍拒绝影响实际steps/addToHistory/history或最终引用的篡改。


Ruling: Task2追加窄修source-empty-body applicability，并新增source-empty-chain.spec.ts；可证明base已有非空自然body且完整原链仅在该body内清空后再插的暂时空parent，交回既有inline recipe审核，不合并/缩range/丢步骤 — 实际slash delete→highlight/wikilink literal两步被empty入口接管后强制首步空插入而拒绝，单步同目标与普通delete→insert探针证明是接管边界缺口 — 成本是新增暂时空body来源识别，需原parent区间/map证明、真实CORE/HOST与LF/CRLF/BOM/protected回归；baseline空body/新生synthetic/未知或跨body/mixed unsupported保持旧边界，全部旧negative先保留，source-inline不在此次授权。


Ruling: 仅迁移source-empty-cache.spec.ts参数emptied-earlier为正例，later-empty/created-earlier负例、spy和base不可变断言保留；新增核原两Step/docs及仅A→X写集 — 旧例在一个原非空自然table cell内真实delete(16,17)→insertText(X,16)，与批准的暂时空body合同完全同形；root以installed真实capture独立证明完整expected表格仅A变X、目标doc.eq且邻空cell/base不变（root-empty-table-expected） — 成本是一条具名旧策略断言迁移，不加table特判，保留原244/245失败证据并重新覆盖/strict/完整CORE/type/build/artifact后才提交安装。


Ruling: 内容observe/onDelta改为每个已接受chain的microtask通知，同步state/view安装及boolean/FileResult结果不变；每事件捕获当次snapshot/delta且按提交顺序发送，unsubscribe抑制未执行回调，拒绝/probe零通知；内部view/resize paint仍同步 — generic dispatch只有已构造tr和同步结果，无法在回调重入时既延迟重建意图又真实同步返回；延后通知让回调从最新state建立新tr而不重放旧tr — 成本是新file API业务通知异步，Task3保存/生命周期须用await owner.flush的最新snapshot而非依赖同步tab回写，需同turn A/B、回调C、取消订阅/异常/拒绝回归；legacy observer不变。


Ruling: 相同正文完整root移动仍交换business ID，不能以neutral PM/raw相同视为no-op；仅私有真实move witness依原delete→insert及完整mapping恢复全部rows，保持raw/hash/lineage，不伪造空SourceHistoryStep。真实native history捕获的candidate无raw载荷时，仅neutralized doc等于当前session.doc、ID集合完整唯一且bindings/layout全校验通过，允许从candidate doc恢复身份排列；其余标准语义变更无payload仍拒绝 — 实际相同A段移动F1判untouched，单改目标ID造成重复，原载荷必须nonempty edits — 成本是新增identity-only history受理窄分支，须验证move双向/undo/redo/probe/外来ID或metadata拒绝及与文字编辑分组和分隔组合，不放宽raw权限、不新增Step类。

Ruling: spreadsheet同步slash保留真实旧producer和枚举，但file能力查询返回false且执行拒绝时保留slash；以真实unsupported producer负例覆盖，不在Task2额外开放CORE语法 — 计划正例列h1/task/code/mermaid/table/literal，spreadsheet真实producer尚不在冻结保真能力矩阵 — 成本是file模式此slash能力暂不可用，报告必须明确，不能宣称任意slash可用或借Source权限绕过。

Ruling: Task3采用当前OWN annotation-admission-seam-design.md第2–6节的共享批注接缝，列入正式Files与首次真实UI验收：commands可选isCurrent/dispatch(boolean)、返回本次edit对象；Popup仅strict false保留草稿、先save/remove后身份匹配关闭；本次对象flushDraft在300ms前同步读最新text，owner成功flush后才保存/切换/销毁。每弹窗controller/view/generation闭包只认领自身成功且目标未被append移动的版本；stale保留草稿，并提供明确重试/放弃未保存修改出口，discard不写文档或撤回已接受版本。新开全局Popup先通过旧对象自身flush，失败不插入不替换；其它owner普通flush不触及它。composition不强制提交或丢弃，完成后才可继续 — 当前void回调与提前关闭会吞掉policy拒绝，旧保存事件漏掉300ms草稿，stale无显式出口会永久阻塞tab — 成本是扩大Task3必要UI接线范围和三条四语言文案，不增加权限注册表/草稿数据库/第二套批注或Tauri测试stub；delivery仍独立负责纯i18n依赖拆分。


Task3 补充 Files：修改 `src/lib/note-anno/note-ui.svelte.ts`、`src/lib/note-anno/note-commands.ts`、`src/lib/note-anno/NoteEditPopup.svelte`，新增 `src/lib/note-anno/NoteEditPopup.test.ts`，精确修改 `src/lib/i18n/{en,zh,ja,de}.ts` 增加 `noteedit.unsaved` / `noteedit.retrySave` / `noteedit.discardChanges`；沿用已列file-main/RichEditor/tabs。真实组件测试和既有note-commands/source-annotation-producer回归不能以函数仿写替代。


Ruling: Task3采用当前OWN source-pending-seam-design.md第2–6节：attachFileSourceInput返回同一adapter的pending/retry/discard与内部flush/detach/rebind，owner闭包保存单份buffer，两端Source UI直接持同句柄，不扩FileEditorOwner/Mounted公共契约。失败草稿保持固定session/authority/generation，普通输入只更新草稿；显式retry仍过原准入，stale不可刷新generation重放全文。显式discard只恢复最新snapshot，不改raw/history；composition中禁止重试/放弃，强制detach保存可读buffer为interrupted pending并拒绝等待者，不伪称IME结束。SourceView和source-actions全部实际文本写入汇入唯一commitBuffer，异步结果复核原owner/DOM/buffer/selection；保留Rich DOM时写事件仅当前模式消费 — 现有普通input之外的auto-pair、格式/批注、Find、paste、右键直接setContent会绕过准入，value绑定会覆盖失败草稿 — 成本是新增必要可达pending UI和精确旁路接线，不新增全局草稿库、不迁移旧Kit Source consumer，不授Source强制覆盖权限；工厂必须明确给Desktop/Kit同句柄的实际入口，不能只有不可达内部方法。

Task3补充Files：src/lib/context-menu/source-actions.ts、src/components/source-view-find.test.ts，新增src/components/source-view-pending.test.ts、src/lib/context-menu/source-actions.test.ts；四个已列i18n文件增加source.pending/source.pendingStale/source.retryPending/source.discardPending。首选在file-main建立已规划file Source pane并直接用adapter；src/editor-kit/source.ts/kit.css/source.test.ts仅在writer提出具体复用容器证据后另行明确授权，不默认为可修改。FindReplace事件接口不变。


Ruling: Task2非空block.insert-after允许末尾无换行自然root因新增分隔符而从untouched变为一对一retained；仅原root结束于原EOF、完整原raw在插入点前逐字节未改、该旧root新raw切片恰为旧切片加一个本次选用EOL、对应原PM children完全相同，其余原roots仍untouched且raw相同、恰一新自然root包含全部新content时受理。继续完整文件F1、实际Source Step/payload与bindings，不开一般retained/语义影响权限 — 独立installed探针root-insert-eof-correspondence证明A→A\n\nB\n\n仅EOF插入，旧A语义相同却合法retained；计划原untouched-only会使普通无末尾换行文件无法在最后追加块，与spec无末尾换行语料及块编辑目标不符 — 成本是一个严格EOF separator边界例外，必须LF/CRLF/BOM/无EOF换行、undo/redo/probe与多root/reference影响拒绝测试；CORE守卫/serializer和其它旧negative不改。


Ruling: Task2 Prepared.stepsJSON示例只是内容校验，不能替代原执行链身份；私有intent注册时与首filter准备后都封存并在消费前核原Step引用、exact prototype、执行方法及docs/真实StepMap/Mapping结构，保留实际链而非JSON等价替身 — 独立review I1已证明同JSON不同invert的Step subclass进入native history令undo卡住，私有insert在首filter前被改mapping仍受理 — 成本是额外完整性指纹/比较，拒绝被改链不得安装或改变history；不复制成第二历史、不给metadata授权、不patch PM全局。具体方法保持简洁，除两条已复现用例也覆盖原对象方法原地篡改，不能仅加JSON字段或prototype比较留下同类执行替换。


Ruling: Task2 I1修复中，仅对真实native history捕获candidate与installed history共享的原Step执行对象、其直接可变数组及候选StepMap/ranges值做局部冻结，再交后filters；Mapping容器及candidate事务仍正常可变并继续完整指纹。普通source/insert producer与Rich路径按封存比较拒绝，不因此普遍冻结调用者事务 — writer真实undo探针证明PM无remap的popEvent复用installed inverse，晚期原地改invert即使本次拒绝也会污染旧history，随后redo失败 — 成本是在首次消费历史candidate时将本应不可变的共享执行值变成只读；须验证拒绝后undo/redo仍完整、正常merge/map/分组不回归，不复制成另一Step、不改PM prototype或全局流程。


Task2已受理：CORE4bdbfb9→b323027，HOSTc5b2e3c3→1b1da976→b4a71cc5。初审C0/I1/M2，fix1独立复审I1与EOF全部ADDRESSED、新破坏0；M1 colwidth负例夹具与M2既有告警deferred到whole-range。CORE最终full1383；HOST原full4489、末次focus覆盖99、fix1最终125/8套+原review probes2、strict/build/真实Chromium resize/installed64dist，验证范围严格分列，未称最终HOST重新跑full。Task2独立F1/原链/metadata来源已验证；原生移动/Safari/IME未验留后继平台门槛；HOST应用增量留Task3。不是发行。


Ruling: Task3 Source textarea仅作为LF显示投影，原始raw保持权威。固定本次generation的raw/display，按display最小前后缀差异映射回raw边界（CRLF及单CR均计入映射），只替换变化区；新输入区的LF使用原文件首个EOL或缺省LF，未改区域混合EOL逐字节不变。初次挂载/重绘/no-op不写；所有Source UI坐标来自display，controller收到重建raw。pending retry仍使用原session/generation，不刷新基线，discard取最新raw投影 — ROOT实际Chromium140的textarea探针证实CRLF与单CR自动转LF，BOM和emoji保留（evidence/root-textarea-newline-projection） — 成本是现有file-source-input内局部投影helper，须覆盖真实浏览器CRLF/mixed/BOM、三次模式切换/no-op、一字单hunk、新行插删/emoji，不做全文件换行归一。

Ruling: Task3 desktop现有额外plugins须在首次controller创建前由RichEditor组装，经editor-bridge传入file-main内部factory参数一次安装；公开mountFileEditor两参数默认保持兼容，不扩FileAdapters/FileEditorOwner合同 — mount后直接view.state.reconfigure会让controller与view持有不同state，破坏唯一事务入口 — 成本是内部装配接缝，不引desktop依赖到纯file-main，不保留挂载后重配旁路，需验证实际desktop extras与owner持有同一state。


Ruling补充并取代Task3 EOL裁定中的“单前后缀包围范围整体替换”：Source多处修改（如Replace All）也必须保留中间未改换行的原始字节。raw `A\r\nkeep\nA\rTail` 两处A→Z时，单包围范围的LF→首EOL会误改keep后的LF；ROOT先前算法要求不足。允许复用已有纯share-merge/diff.ts对display UTF16单元求离散变化，逐范围映射raw，仅插入片段选原首EOL；不新建diff算法、不修改已有内核、不过滤格式差异。预算/计算失败保留可见pending，不退回全文件归一 — 成本是必要的多范围显示映射与Replace-All/混合EOL回归，先真实adapter RED再实现；普通一字/no-op语义与原session/generation约束不变。
