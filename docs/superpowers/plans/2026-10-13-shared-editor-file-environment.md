# Shared editor file environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 让共享源码会话复用真实整文件解析环境，在普通局部编辑时只重解析受影响语法块，并提供可验证的 Source 原文修改入口。

**Architecture:** 沿同一个 markdown-it 与 Moraya parser 建立不可变token模板、定义事件和真实checkpoint；在一个私有factory中原子登记来源与缓存。Rich事务授权和显式Source写权限分别验证，共用同代candidate管线。

**Tech Stack:** TypeScript、现有markdown-it与ProseMirror、Vitest；不新增依赖。

**Spec:** docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md，I7、§12.4、§12.9、§20决定7。

2026-10-14 正式采纳（延续10-13设计）。列表阶段已受理并归档：core8453283cfdc180b015a14414e12bca39fee56fe0，host产品ffb96012892f4f1bc3478ff86797e4dc72877e18；收尾文档c869ee6f。此计划提交后再将实际执行BASE冻结到OWN，不以历史研究SHA冒充。

## Global Constraints

- 用户要求原地两个现有main，不建branch/worktree；单一产品writer，不派子代理。每numeric Task独立spec+quality，root唯一final前Svelte/含Memory前后指纹，再唯一strongest whole-range；ONE统一finalfix+ONEscoped。
- 未触碰原字节保持；全部attrs/marks严格eq。禁止全篇serializer+diff、格式差异过滤、第二parser/raw ledger/history栈或任意公共authority setter。Source明确raw权限不代替Rich R1前后两道guard。
- 已受理表格、列表、checked、0、fence、blank/terminal合同保留。M是普通真实html_block，本轮不自动补节点、不改grammar。完整UI/IME/nativehistory/E1–E4未在本轮交付。
- 不读.env、不装升级依赖、不reset/clean/add-all/amend、不改node_modules源码；committed dist只经审定原子rename安装。原untracked/stash/backup/branches/tags/worktrees保留，tasks目录不stage。
- 每次verification/stage/install/commit/audit保存真实argv/cwd/time/exit、完整stdout/stderr及toolinitial/session/final；唯一label。非预期非零caller throw停止所有依赖步骤。缺导出/无效fixture不是行为RED，同输入已过检查无变更不重跑。
- package完整bytes不变；全部declared targets存在/JS实际import/DTS依赖/maps embeddedsource/两仓14原语料BASE-HEAD-working SHA必须核对；gzip硬cap81920不预涨。dist build前核unknown，obsolete只对实际冻结BASE到已提交HEAD的no-renames单层hash DTS逐bytes安全清理。
- 预处理/行表/PM发射允许O(N)但如实计量；局部成功必须证明真实block/inline工作范围，生产不跑fulloracle。无法局部须显式fallback，不把fallback算局部成功。

## 自含工具与执行顺序

执行OWN为 `/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-file-environment`。从列表canonical逐SHA选取next-file-tool-candidate的九件工具及本计划/selected研究，自含到新OWN。baseline校既有出口，installed额外实际import prepareFileSourceEdits。所有脚本用sh调用，所有命令经过run.py --cwd core|host；ARTIFACT_MANIFEST使用独立S1-artifacts.json并由stage读取同一快照。

冻结core-task-base、host-task-base与精确stage-allowlist；empty-env保持空。core focused→tsc→full→prebuild未知清单→tsup→artifacts→precise源码及dist提交→host-sync committed安装→hostfocused/full/purity/空envDir Vite/Kit/旧browser→host精确提交→installed闭包→task review/fix；root尾部检查与唯一final。未来新测试正式创建后才运行，不跑不存在文件凑RED。writer不改changelog/version，root收尾补双语未发布及全部Rulings正式报告，完整归档回读后仅own清理。

实际基础命令：core `./node_modules/.bin/vitest run`、`./node_modules/.bin/tsc --noEmit`、`./node_modules/.bin/tsup`；host `./node_modules/.bin/vitest run`、`node scripts/check-share-merge-purity.mjs`、`node --input-type=module -e 'import {build} from "vite"; await build({envDir:"/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-file-environment/empty-env"})'`、`node scripts/check-editor-kit-build.mjs`。browser沿现有check-source-fidelity-browser.mjs与本OWN独立输出/cache、已装Playwright实际路径；只能声称单块回归。

## 目标、授权与执行条件

仅一个生产 Task F1，内部按 A–F 阶段 TDD。交付：
- 同一次实际 parser 的 file cache、definition events、跨 root 文件 env；
- 普通稳定块真实局部 block/inline，结构按语法闭包扩窗，定义变化按全 inline 闭包更新；
- 新公开 raw Source patch API、同次实际 root correspondence、诚实 work 统计；
- 既有 createSourceSession/applySourceTextTransaction/applySourceBlockTransaction 实际消费同一个 cache/pipeline；
- source-only serializer 不再通过 relaxEscapes 隐式调用 legacy parse；
- core committed dist → host installed 公开入口消费 → 两仓提交与完整证据。

不实现 Kit 文件模式、Source UI、bindings/业务 IDs、native history、SourceHistoryStep、恢复、CDR/server/wire、新 layout 功能、表格新 schema/colwidth、native/IME 或发布。保留并重用已受理 layout/blank/terminal 行为，不新增 layout 设计。不以任何尚不存在的 history controller 为依赖，也不使将来的 history 依赖本轮未实现的 Kit adapter。输出 correspondence 只是下一会话自然 roots 的关系，不是 ID 继承裁决。

root 采纳必须在 ledger 明记：
1. 新 HOST_BASE/CORE_BASE 的完整 SHA；前置已受理且无产品 dirty 被消费。未来实际 tests 数以输出为准，不能将研究时“531”或任何旧计数当硬编码成功数。
2. **§12.4 闭包裁决**：“只重新解析发生变化的块”按 raw 写集、block 语法影响闭包、inline 文件环境影响闭包区分；稳定普通编辑实际局部；定义变化允许全 cached inline 重算；full fallback 单列且不算局部成功。未获此正式裁决，不能将候选解释当原 spec 已满足。I7 原字节与一字一 hunk 不降低。
3. 单一 core+host writer；不与结构 writer 并行改产品。main 原地、不新 branch/worktree、不安装或升级依赖、不读取 .env、不 clean/reset/add-all/amend。前置 stash/untracked/backup 按实际 baseline 清单保存，不复述可能过时的数量。
4. 本 Task 完成后仍不能宣称完整 ShareEditor/E1/E4/§12.9 已交付；后续 file bindings/raw-history/Kit 是独立计划。

Spec 原文：host `440e7302a545fd24b0a7173cc2d9c092a8434dbc` 的 docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md:1005–1034。§12.4:1011 的字面 raw-only 解读无法正确处理只新增末尾 [new]: /url 却改变此前 [new] 视图的情况；以上裁决是必要前提，不是性能豁免。

## 文件范围与模块职责

core：
- src/markdown.ts：保留唯一 md 实例和完整实际规则；将现有预处理/capture finalization 抽成可重用真实 helper；actual reference/footnote hooks、token template/clone/source WeakMap rebinding、完整/窗口 block runner、inline phase、真实 Moraya tokenHandlers emission；source-only conservative escaping。
- 新 src/source-file-cache.ts：私有 FileParseCache、WeakMap<SourceSession,FileParseCache>（cache 可持已验证 canonical authority view）、validated patches、窗口选择/稳定性、定义折叠/inline invalidation、candidate atomic preparation、correspondence/work 汇总。不得自己 new MarkdownIt，不 root-export parser hooks。
- src/source-fidelity.ts：公开类型/API、调用私有模块唯一 session factory/注册；既有 raw 权限和实际 transaction/R1 guard 保留，三个成功来源路径改用同一候选 parse。允许调用既有 src/source-structure.ts 返回的 source/edits；不重做结构 ledger，除非为生产 parse callback 传递做最小必要接线。
- src/index.ts：只增加本节公开 API/types；保持 package exports/tsup entries 现状，不为测试新增 subentry。
- 新 src/__tests__/source-file-environment.spec.ts、source-file-window.spec.ts、source-file-replay.spec.ts；在实际既有 source-*.spec.ts 最小增加跨入口/权限回归。
- 本次 build 的全部 tracked dist、可达新 hashed DTS 与精确 obsolete DTS。

host：
- 新 src/lib/share-merge/source-file-environment.test.ts，只从 '@moraya/core' 公开入口消费 installed committed build，使用本仓真实 propose。
- 必要最小扩展已存在 src/lib/share-merge/source-block-fidelity.test.ts、source-layout.test.ts；不改 Kit 产品。既有 source-fidelity.test.ts 与 src/editor-kit-v2/source-fidelity.test.ts/commands.test.ts 是回归。
- 新 BASE 冻结时逐项核实实际结构回归路径，尤其 host source-structure.test.ts 与 core src/__tests__/source-structure-commands.spec.ts；已存在则纳入 focused。不能沿用旧报告的“未提交”结论，不能凭当前 dirty 产品推断前置。table/default-language 若已受理，header-only 应按其新合法合同做真实正例，不能保留已失效的旧拒绝，也不能删除负例却不补正例。

运行时依赖方向：source-fidelity → source-file-cache → markdown；source-fidelity 也调用 markdown serializer。markdown 若需要 cache 定义只 type-import；source-file-cache 对 SourceSession 只 type-import；禁止新增 runtime 环依赖。现有 source-structure 对 SourceSession 继续 type-only。

## 公开合同（采纳时一次冻结，以下是可编译 TypeScript 目标）

放在 source-fidelity.ts；引用现有 SourceSession/FidelityFailure/SourceEdit，不再创建另一套 source revision。新增内部生产 import {prepareRawFileSourceEdits} from './source-file-cache'；下方公开 wrapper 调用本 Task 必须实现的 helper 17，不是已存在方法。新增 root export prepareFileSourceEdits 及这些类型。所有 offsets 是原始 JS UTF-16；fixture byte 断言用 UTF-8 Buffer。

~~~ts
export type SourcePatch = Readonly<{
  from: number; to: number; removed: string; text: string
}>
export type FileRootCorrespondence = Readonly<{
  beforeRoots: readonly number[]
  afterRoots: readonly number[]
  kind: 'untouched' | 'retained' | 'split' | 'join' | 'repartition' | 'birth' | 'deleted'
}>
export type FileParseWork = Readonly<{
  mode: 'unchanged' | 'local' | 'expanded' | 'full-fallback'
  fallbackReason?: 'cache-miss' | 'checkpoint-unproven' |
    'preprocess-unproven' | 'private-hook-unavailable'
  blockWindows: readonly Readonly<{sourceFrom:number;sourceTo:number}>[]
  blockParseCalls: number
  topLevelRunnerCalls: number
  blockRuleCalls: number
  nestedTokenizeCalls: number
  blockLinesVisited: number
  inlineParseCalls: number
  inlineInputUnits: number
  inlineRoots: readonly number[]
  rawTouchedBeforeRoots: readonly number[]
  environmentChanged: boolean
  legacyParseCalls: number
  fullCaptureCalls: number
  pmEmissionTokenCount: number
  preprocessedCodeUnits: number
  lineTableCodeUnits: number
  rawSplicedCodeUnits: number
  inlineEffectReplayCount: number
}>
export type SourceFileUpdate = Readonly<{
  environmentVersion: number
  correspondence: readonly FileRootCorrespondence[]
  work: FileParseWork
}>
export type FileSourceResult =
  | {ok:true; session:SourceSession; edits:readonly SourcePatch[]; file:SourceFileUpdate}
  | (FidelityFailure & {work:FileParseWork})
export function prepareFileSourceEdits(
  base:SourceSession,
  input:Readonly<{expectedRevision:number;edits:readonly SourcePatch[]}>
):FileSourceResult {
  return prepareRawFileSourceEdits(base,input)
}
~~~

既有成功形状只增加 optional file?:SourceFileUpdate（FidelityResult/SourceBlockResult 均可加），既有 mode/edits/changedRoots/reason 不变；所有本实现成功 mutation 实际填 file，cache-hit unchanged 填 zero-work 与原 environmentVersion；foreign cache-miss 即便结果 unchanged 也保留恢复实际 work（见下节）。旧调用者继续可用。createSourceSession 初次成功可填打开诊断；初次 mode='full-fallback' 不合适，故其既有结果 file 可不填，初始完整 capture 由生产 cache 记录、内部 tests 用真实入口 spy；mutation 的 work 专指本次准备，不含历史打开工作；foreign session 本次恢复旧 source 的工作属于本次，必须累计。

revision 规则：source 完全不变返回原 session（对象相同、revision 不变）；只要 raw 变了，即使 PM doc.eq，也生成 revision+1 与新 cache。environmentVersion 是派生语义环境版本，只有折叠后的 reference winners/footnote label membership 变化才增，不把脚注编号/PM重发射当新语义环境；runtime effects 变化也可扩大 inline 闭包但不虚增该版本。根 ordinal 仅 session 内有效。

failure work 保留已做的真实工作（包括尝试后失败），不做 stats reset。所有 retries 累加，同一事务 exact→root-render 最多既有两候选；禁止邻居盲 retry。旧 failure shape保持现有字段，内部失败统计仍写本次 collector 并由 raw API返回；不存在“失败了所以计数为零”。

### Source patch 权限及旧入口隔离

prepareFileSourceEdits 是显式 raw Source 编辑权限。按 expectedRevision、整数有限 offsets、from<=to、原范围、removed === base.source.slice(from,to) 校验；输入必须 raw 顺序、不重叠、同锚点多插入拒绝（调用者应先合并），边界不能切 surrogate 或 CRLF。校验后移除 text===removed 的 no-op；空集 unchanged。此权限允许显式编辑 reference/footnote/blank/gap/BOM 原文，不套用 Rich protected 拒绝；它不承诺任意字符串都能被现有 capture 支持。NUL、BOM-only 等仅按 actual capture 的成功或明确 unsupported-source/parse-error 合同验收；不为成功扩大 grammar。成功时 raw 原字节（含 CRLF/BOM）保留，预处理只建 trace。

Rich 不能调用这个公共 API 来取代 transaction 授权。existing applySourceTextTransaction/applySourceBlockTransaction 先完成 actual step kinds/ranges/ownership/tr.docs/stale/schema 与 R1 pre-serializer 检查，再把已授权 recipe 交私有 prepareCandidate。edit 应用时第二道 protected guard仍在；nested protected root-render仍拒绝。source raw 权限绝不变成 Rich 删除 definition 的理由。真实 docs all attrs/marks eq 保留，不能忽略 cdrBlockId、colwidth、language；本 Task 不接受带业务 IDs 的 view transaction适配。

cache 登记只通过 source-file-cache.ts 的私有生产 session factory：该模块只 type-import SourceSession，构造既有结构并登记最终返回对象；source-fidelity 不以 `{...session}` 再包一层丢失 WeakMap 登记。所有 mutation 成功返回 revision+1；unchanged 原对象/原 revision/原 environmentVersion 不变。

### 外来 session 的验证与 pre-render authority 顺序

固定 core 当前事实：`markdown.ts:438–445` 的 `capturedFenceClosed` / `capturedRootFencesClosed` 是私有 WeakMap；`sourceRootHasClosedFences(root)` 只在最终 root 对象有 true 时准许。`source-fidelity.ts:233` 的 stable root-render 以及 `source-structure.ts:284–285` 的 makeRecipe 都在 serializer 之前读取此 authority。不能把 ensureFileCache 放到最终 prepareCandidate 才执行，否则 valid foreign session 的正常 Rich 编辑在此前已被拒绝。

F1 增加**私有** verified-base preparation，时序必须是：
1. 做不需 source authority 的 cheap stale/CAS、schema 与输入形状检查；不能触发 serializer。
2. 命中已登记 base 时复用 cache 与 facts，不新增 full capture。未登记时对原 `base.source`、`base.doc.type.schema` 做一次真实完整 capture；把原 doc 与新 doc 严格 all attrs/marks eq，逐项校验 roots（id/tokenType/raw range/tail/child/PM range）、textSpans、gaps、protectedSources（含 scope）、layout/blank/fallback/terminal 来源及 schema identity。不能仅 doc.eq 或 raw hash。
3. 全部相等才得到私有、尚未发布的 `{ callerBase, verifiedBase, cache }`：verifiedBase 持有新 actual captured roots 和 fence authority。所有 classification/ownership/R1/render/structural recipe 使用 verifiedBase；transaction 仍按原 callerBase 的 tr.before/tr.docs/steps 验证，不能借替换 base 放宽授权。未来 accepted helper 签名核实后选择最小内部接线，不引 public 任意 facts setter。无需将未知 root 默认为 closed，也无需向未经验证的 foreign root 转移 authority。
4. unchanged 返回 `callerBase` 本身；允许私有 WeakMap 把 callerBase 登记到经验证的 canonical authority view，后续入口仍先取该 view。mutation 用唯一 factory 返回实际新 session。所有恢复成本记本次 `mode='full-fallback', fallbackReason='cache-miss'`，包括 no-op 首次恢复的成本；不能明明做了 capture 却写 zero-work。已命中且真 no-op 才是 unchanged zero-work。`file.work.mode` 描述实际工作，不替换既有 block result 的 `mode='unchanged'`。
5. capture/任一来源维度/schema 不一致就明确失败，原 session/doc/raw/cache 不变；base recovery 的缓存登记延后到整个操作成功或 unchanged；先前 cache miss 验证成功也不允许后续失败 candidate 污染模板或给 callerBase 发布新缓存。应保存诊断而不把 foreign 正常 case 全拒绝或默默序列化 doc 重建 raw。

最少生产 RED/GREEN：同 bundle clone session+clone roots 的 valid foreign stable mark/root-render 与 structural 正例；closed nested fence 可通过、实际 unclosed 与 unknown 不放行；tamper 各来源字段/不同 schema 失败；foreign no-op 返回原对象；失败 candidate 后第二次合法操作仍成功。跨 bundle 只有实际可验证的相同 schema/runtime 合同才支持；不能声明任意序列化 PM 对象都是合法 SourceSession。


## 私有数据、完整 helpers 与真实管线

ActualToken 使用 ReturnType<MarkdownIt['parse']>[number] 类型。下面数据是本次实施目标，均有本节明确生产调用者；不是 SDK 已存在 API，不允许 unknown 后强转当实现。实际私有 State/rule shape 用启动 guard检查，版本不符合则捕获路径明确 unsupported-source／可验证 full fallback；不能转为空文档成功。

FileParseCache：
- raw/preprocessed SourceTrace、lineStarts、schema identity；
- block 前后 stage 分明的 TokenTemplate[]、InlineSlot[]；
- definition events（reference: normalized label/href/title/raw范围/scope/顺序；footnote:真实 label/raw范围/顺序、已有 token span，**没有臆造 pluginDefinition body object**）；
- 完整顶层 checkpoints；folded semantic env 与 environmentVersion；
- 每个 inline slot 的输入、trace、template ordinal/root、core post-inline 后输出模板、实际 footnote runtime labels。
TokenTemplate 保留实际 Token 原型及 attrs/map/meta/children 的合法 shape，不 JSON 简化 token。缓存模板不能交给 PM emission 修改；模板来源分 block 前/后、inline 后、PM emission 前，不混入已改的 checkbox/skipClose/mediaSkip/children。实际 plugins 及 custom schema 的 meta 合法类型须逐项处理；不支持安全 clone 时明示 full fallback 或 unsupported-source，不能 JSON 降格、任意 unknown 强转或建通用 CST。WeakMap provenance 单独保存，clone 时逐节点/children 数组重绑；包含 actual fence facts。

所有实际 parser helpers放 markdown.ts，source-file-cache只编排：
1. preprocessFileSource(source)：抽取现有 BOM→normalizeMathBlocks→normalizeSmartQuotes→真实 normalize trace，和现有顺序一致；不能窗口独立归一化。首版允许 O(N)并填 preprocessedCodeUnits；无法证明变更前后 trace片段一致时 full-fallback。
2. captureFilePipeline(source,schema,work)：完整真实 core pipeline 一次（只用同一 md，完整保留实际 rule 顺序和配置），block后保存templates/checkpoints/events，再 inline与真实post rules、pairedHTML/fixFootnoteMaps、prepareRootEvents与PM emission；抽出现有 parseDocumentWithSourceCapture末尾的 capture validation/buildSourceGaps/finishSourceLayout，避免两套finalizer。createSourceSession实际调用它。
3. cloneTokenBatch(templates,provenance,collector,offsetMapping)：复制实际 Token 实例/attrs/map/meta/recursive children；owners、tokenArrays、tokenSources 重绑新 collector/SourceTrace/runs。inlineStateOwners 与 pendingSources 绑定本次实际 inline state，不移用旧 state；rootStarts/rootEnds 由本次 prepareRootEvents 重建，frameSizes 为本次 PM state 独有；terminalStarts 是 serializer PM-node memo，不拿它冒充 capture provenance。新增 WeakMap 必须在未来 BASE 清单审计归属。actual `capturedFenceClosed` Token facts 明确存入模板 provenance 并绑到 clone；prepareRootEvents 对每个真实 fence 要求已知事实，再由 captureRootEmission 绑定最终 `capturedRootFencesClosed` SourceRoot。无 fence 的 root 可由本次完整 token 遍历证明 true，有 fence 但缺事实必须失败，unknown 不能 default closed。不二次 parse fence、不得重新扫描原文猜闭合；所有 blank/terminal/protected/fallback 来源保持同次管线。
4. observeReferenceCandidate(original,state,start,end,silent)：非capture和silent直接original。capture自有普通env下暂存普通空references {}，actual rule一次，finally恢复自有属性/absent/原对象；成功取唯一候选，再按原typeof undefined first-wins合并。不影响真实continuation/title rollback；不复制grammar。异常恢复后fail。
5. observeFootnoteDefinition 与 observeFootnoteRuntime：真实footnote_def记录真实open token label及消费范围，定义写入refs[':'+label]=-1；嵌套按source顺序且验证实际写入顺序。runtime包真实footnote_ref成功非silent，读取该次实际发出的末footnote_ref（push可能先flush text），记录label序列，递归image/custom inline归属外层slot且不双记；orphan无env效果。
6. newCheckedBlockState(fullPreprocessed,env,tokens)：用实际 md.block.State，不创造第二parser；校验真实行表及状态shape。state构建扫描完整字符串，填lineTableCodeUnits，不能记为局部工作零成本。
7. runTopLevelWindow(state,cursor,stopAfterEpilogue,work)：版本绑定复刻 installed tokenizer **外层控制循环**，每一步直接ruler.getRules('')实际rules、嵌套仍actual md.block.tokenize。cursor={line,hasEmptyLines}；rule成功后完成tight/空行epilogue才checkpoint。不得调用不存在的restartAt/stopAt，不靠throw暂停、不改lineMax造假EOF、不复制Markdown grammar。
8. parseInlineSlots(slots,env,collector,work)：按文件顺序真实md.inline.parse（含ruler2）、实际core post-inline规则；source_capture join wrappers继续真实执行。新增children数组必须clone/rebind，其余模板复用但emission仍独立副本。所有递归inline计数累加；不得仅数outer slots。
9. emitCapturedTokens(batch,collector,schema,work)：为现有 MorayaMarkdownParser 构造器新增默认原 md 的 tokenizer 参数，这是本 Task 待实现内部接线；per-call facade parse 仅返回本次可变 prepared emission batch，且 parse 调用一次，走真实 MarkdownParser.parse 与 Moraya 全部 tokenHandlers；无需第二次block/inline。token-to-PM可以O(N)，pmEmissionTokenCount如实计数。
10. finalizeCapturedDocument(collector,doc)：从现有parseDocumentWithSourceCapture抽唯一共享校验，无删减all attrs/marks/textRuns/root/gap/layout/protected判断。完整管线与局部管线都调用；异常映射保留unsupported-source/parse-error。

source-file-cache生产helpers：
11. validateSourcePatches(base,input) / spliceSource(base,patches)：上述CAS/边界校验和一次raw slices拼接，rawSplicedCodeUnits 记录实际输出 UTF-16 units（重试累计）；同时生成有限来源pieces（kept old span / generated edit span）；这只是本次patch坐标账本，不建通用CST。
12. selectBlockWindow(cache,patches,trace)：选择已证未改左checkpoint、包含上一个可能吞并的root与右sentinel；gap definitions也有checkpoint；无法证明family时扩窗/fallback。恢复实际parentType、tight、blkIndent、level、ddIndent、listIndent与cursor.hasEmptyLines，lineMax使用新文件实际EOF；不默认parentType=root。
13. foldDefinitionEvents(events)：按raw source顺序保留全量duplicates/unused/nested；reference first-wins，footnote membership refs=-1。事件替换/平移来自真实block窗口，不regex提取。semantic env比较忽略raw格式但不丢winner href/title/label或footnote存在性。
14. replayInlineEffects(prefix,env)：对actual labels重建refs/list/count；当前tail/inline-footnote禁用时，list唯一shape为{label,count}。只重放已记录runtime效果，不parse语法；prefix折叠O(引用数)可接受，inlineEffectReplayCount 逐次累计实际重放引用数。新slot effects不同或semanticEnv不同，全部inline重新按序执行；普通无关段相同effects可复用suffix。
15. deriveRootCorrespondence(base,next,pieces,patches)：按下节实际来源关系构建有限有序组件，不猜业务继承。
16. prepareCandidate(base,validated,authorization,work)：只接收已完成上节 authority 恢复的 verified base；一次候选全流程，base immutable；验证completecapture覆盖，Rich再与actual tr.doc strict eq；成功才factory注册新session/cache并返回。失败不修改base template/collector/doc/raw/旧cache，不发外部事件。
17. prepareRawFileSourceEdits(base:SourceSession,input:Readonly<{expectedRevision:number;edits:readonly SourcePatch[]}>):FileSourceResult：source-fidelity公开wrapper唯一调用者；本模块type-import这四个公开类型，创建本次work accumulator，先 validateSourcePatches，再调用本 Task 私有 prepareVerifiedFileBase（下列 helper 18），成功后以私有 Source 授权交 prepareCandidate；空 edits 也按 verified-base 的 cache hit/miss 与 unchanged 原对象合同处理，将knownfailure带完整work返回。Rich调用不同的内部authorized候选路径，不经过这个raw授权wrapper。首个可编译RED stub必须返回此union内的明确unsupported-source+零work对象；不能以缺函数/缺字段造成编译失败冒充RED。

18. prepareVerifiedFileBase(callerBase,work)：实现上节完整 cache lookup/recovery/authority view，返回待提交 recovery（或 failure），由公开 raw wrapper 与两个既有 Rich 入口在任何 source authority guard/serializer 前调用；不在 prepareCandidate 末尾补做。另由唯一私有 session factory 及成功提交点原子登记 cache/authority view。helper 名称是本 Task 新实现目标，不是 fixed BASE 已导出的 API。事务 cheap stale/shape 检查能确定失败时先返回；valid foreign 的获权正常路径必须抵达 recovery，不能先用未知 root facts 一刀切。


legacyParseCalls 专指 source operation 内实际调用 legacy parseMarkdown/parseMarkdownAsync 的次数，完整实际 md pipeline 另计 fullCaptureCalls/blockParseCalls。计数器是生产work accumulator，测试可在内部模块校验，但没有可重置全局public test hook。blockLinesVisited 的首版定义为 runner 活跃期间实际读取行表的次数（重复、lookahead、nested、retry都累计）：对实际State五个行表加仅计数的Proxy，保持Array.isArray/prototype及读写语义，构造行表阶段另计lineTableCodeUnits；numeric index读取含实际EOF sentinel。整串regex扫描不能装成零成本，在family admission说明与预处理成本单列；若Proxy私有shape不等价先修订，而非只从输出map推算访问数。

### checkpoint admission 与停止证明

版本/shape guard 必须绑定 actual rules/configuration，核对 normalize/block/inline/post-inline 顺序、reference/fence/footnote/custom capture wrappers 与 footnote_tail/footnote_inline 禁用状态。只记录 require.resolve 路径不满足 guard；没有可靠完整 fallback 时缺 hook 应 unsupported-source，不能用同一坏 hook 重试后报告 full-fallback 成功。定义事件还须对该配置实际 env writes 做清单：references 与 footnotes 是已知写集，不得静默丢弃未来新增插件环境效果。

checkpoint在实际顶层rule结束且loop epilogue完成处，记录line/原raw offset、line表shape/trace依据、实际state标量、cursor.hasEmptyLines、token/definition/inline边界。即便失败的lheading也会留下parentType='paragraph'，必须保留实际状态，不“修正”依赖行为。

完整candidate行表和EOF始终可见；reference内用state.lineMax而非传入endLine，texmath对整个state.src跑regex。work.blockLinesVisited统计真实触及的行（含lookahead/重试/嵌套），无法准确按行归属的全string扫描另在报告标明，不将其包装成恒定访问。所有全文件预处理/行表/PM emission可O(N)，性能声明只限admitted grammar block/inline工作。

局部成功需同时：
- 左边界之前raw/trace和状态可证明不变；可能被左根吸收时从左根开始；
- 新输出到达映射后的旧checkpoint；状态逐项相等，未变后缀raw相同；
- 至少一个未改右sentinel实际block重跑，完整模板（map扣平移）、events、终止state一致；并对admitted family有实际lookahead/写状态证据，不能把“一个sentinel相同”当任意插件普遍证明；
- cached suffix templates/source offsets全部正确平移，definitions全量一致；
- 生产不运行全文oracle；tests单独比较doc(allattrs)、roots/gaps/protected/layout/textSpans/raw。full fallback不能算局部成功。

首个admission为普通非空段落、无跨行特殊预处理：100/1000自然段改中间一字，block roots≤3、runner=1、outer inline slots≤3，真实calls/lines同一常数预算（从固定installed rules测得并在RED fixture冻结，不能套探针45为未来产品绝对数）。split/join/insert/delete普通段有稳定≤5根正例。footnote存在但编辑无关普通段也须有局部正例；不能所有带脚注文件永久全inline fallback就算完成。list/quote/table等family暂未证局部可explicit full-fallback，但原Rich支持的来源能力不能退化；环境正确性覆盖所有已支持语料。

### actual root correspondence，不决定 bindings

每个before root与after root恰好属于一个组件；无自然root的文件允许空关系，不制造placeholder root。
- kept原source片段相交，将对应before/after root连边；
- generated edit片段与after root相交，连接该edit真实消费的before roots；零宽插入严格在root内部时归该root，root边界不默认归邻居；gap-only无before自然root；
- 剩余before为deleted，剩余after为birth；1→1 retained、1→多split、多→1join、多→多repartition；
- untouched只用于raw完整未触及且映射后自然root原文/语法边界仍相同的1→1；环境导致其PM link attrs改变仍可untouched，因为这里描述raw来源。相同正文不按hash配对，不从ordinal继承identity。
- split/join是来源关系，**不输出inheritor或业务blockId**。不能可靠区分1→1替换语义身份时retained仅表示来源对应，不承诺同一业务块；未来bindings controller需结合actual transaction/用户策略自行裁定。
- whole-file Source replacement可得到repartition组件，不能伪造逐根same-text匹配。纯gap定义变更可能仅untouched根+无root写集。

## capture Source grammar 的边界及前置并入点

固定 core 的 md.parse 在 capture 分支运行 prepareRootEvents，legacy 分支运行 preserveBlankLines；Source capture 和 legacy 的空白/布局 emission 已有不同入口。F1 以 accepted SourceSession canonical doc 与实际 source capture 规则为权威，不能用 legacy parse 作正确性 oracle，也不能在复用同一 md 时让 capture-only 状态/规则泄漏到 legacy。默认 parseMarkdown/parseMarkdownAsync/serializeMarkdown 保持其受理合同；source-only serializer 停用 relaxEscapes 只影响 Source 授权路径。若未来正式采纳 reserved source grammar，应在单独规范明示 capture-only/legacy/generic 消费者差异和 file-mode 入口权威；本 F1 不自行引入该语法。

- 列表前置采用精确 HTML comment `<!-- notemd:list-boundary -->`，它是普通真实 html_block PM 节点；无 zero-PM/reserved grammar。F1消费最终受理的实际 token facts、occurrence位置及同代 authority，既不自动生成 M，也不改变 legacy HTML 或忽略 strict eq。生产controller自动边界及隐藏导航仍是后续合同。
- table/default-language 前置已受理：header-only table合法、空语言为真实空串、显式 text保留。F1使用最终受理的真实 parser/serializer/tokenHandlers 与这些正例回归，不再次修改 schema/producer/默认语言；Graphviz/Mermaid等原有语义保持。只读取固定committed接口，不能消费当前writer dirty。
- 独立后续才实现 file bindings → raw/native history → Kit/file mode → Source UI/生命周期；canonical doc 与带业务 IDs 的 view doc 的投影、只授权 cdrBlockId 中和、同代原子安装及恢复不在 F1。F1 严格比较 attrs，不为了接 view 放宽。后续业务 source raw 始终权威，PM doc.eq 的 raw-only 变化仍须原生可撤销；这些是后续需求，不是本轮交付。
- 不新增 layout/native/IME/桌面接线/持久化/发布。现有 layout 验证全部保留。完整 E1/E4/§12.9 与 UI 三次切换仍未交付。

## 精确fixture与成功门槛

| 输入/操作 | 强制结果 |
|---|---|
| BOM + CRLF + paragraph/list/table + 14 frozen corpus | fullcapture/cache replay全部capture维度相同；三轮未改raw逐UTF-8字节不变；不把只执行core API冒充UI切换 |
| 100/1000普通段中间甲→乙 | admitted≤3根block与outerinline；真实规则/行数常数；raw仅此处变；propose一条句子hunk |
| 中间普通段split/join/insert/delete | ≤5根local/expanded正例；actualcorrespondence正确；不靠全文fallback过关 |
| 只增末尾[new] definition | 旧纯文本变link；环境全inline；old root raw未改 |
| /one + duplicate /two + unused + nested | 删除首定义晋升；loser原文保留；unused不丢；嵌套Rich保护仍拒绝 |
| 有脚注文件改无关普通段 | prefixeffects恢复编号；真实局部inline正例；无未授权raw |
| 改首引顺序/增删定义/imagealt refs | actualeffects变化触发全inline；id/subId/label/corePM/capture等值 |
| 改未闭fence/setext/HTML/listcontinuation | 完整candidate EOF；扩窗正确；无法局部则显式fullfallback，不计局部成功 |
| 支持的空文件/onlydefinition、raw同PM；BOM-only/NUL 另核 actual 支持 | 支持时零自然roots合法、raw变revision+1、无pseudo business root；不支持明确失败不扩大grammar |
| no-op/CAS失败/producer失败 | 原对象或失败按合同；base raw/doc/cache所有模板不变；failed work诚实 |
| source-only root/render结构+字面转义 | strict all attrs/marks eq；legacy parse零调用；无独立root语义oracle |
| host installed '@moraya/core' new API | 可导入/声明可达；sharedreference/footnote/rawCAS/correspondence/work/local性能与onehunk真实消费 |

本Task完成需A–F全部GREEN、committedinstalled审计与审查通过；只有facade探针、函数出现、capture≤2、fulloracle eq 或fallback正确都不够。通用CST/业务ID/history/UI不在本完成定义内，也不作为补做这些门槛的替代。

## 执行补充约束

- 本计划只保留前文 A–F 的产品合同；旧六脚本全部撤出候选。正式采纳只从列表阶段 canonical archive 逐 SHA 选取已运行的九件工具，移植 OWN，再核定新增 prepareFileSourceEdits 公共导出。不得执行历史工具或读取旧workspace。
- 表格和列表阶段均已受理。正式 F1 BASE 必须包括列表两Task及最终fix真实受理提交，接口只能读取已提交实际代码后确定，不预写虚假的函数调用。
- F1 接管唯一 verified source authority/cache preparation。列表阶段的 prepareListAuthority（若实际名称不同以代码为准）不得与 F1 共存为两套完整recapture；用一个私有恢复路径同时核 list/fence/protected/layout全部来源。T2回归测试原样作为防退化门槛。
- TokenTemplate 必须携实际 list open/close/markup/tight/raw map来源，clone新collector后通过实际PM发射、最终doc身份定位重新建立lists；不复用旧pmFrom/rootId/WeakMap；重新发布的来源只能来自同代capture。精确HTML边界M是普通真实PM节点，不增加grammar。
- package.json BASE→HEAD 完整bytes不变；列表最终gzip67894为执行前观测，正式baseline仍实际测量，硬cap81920不变。声明/export/DTS/map/14corpus仍全部实际校验，不硬编码产物数。
- host Vite 必须 programmatic build({envDir: OWN+'/empty-env'})；不得使用会读取项目.env的CLI默认配置。
- stage allowlist精确冻结。writer不改changelog/version；root阶段收尾按AGENTS补双语Unreleased，明确基础能力与完整产品未完成边界。
- Task fresh writer + 唯一spec/quality；fix闭合才root Svelte前后指纹（含Memory）及唯一strongest whole-range。ONE统一finalfix+ONEscoped，必要新输入复验新label、保原失败。
- 所有commands由run.py记录，caller非预期非零throw，toolinitial/session/final完整保存；独立check失败停止下游。当前候选不代表任何F1产品/性能GREEN。

## §12.4 解释（root采纳时写入正式ledger）

“发生变化的块”包含语法及引用环境产生的实际影响：raw写集决定哪些字节可以变化；block语法闭包决定哪些块须重新分词；inline环境闭包决定哪些引用须重新解析。若只新增末尾引用定义，前面未改原文可以从纯文本变为链接，不能为追求raw-only解析而产生错误视图。正常局部字改必须有≤3根成功证据，普通结构编辑≤5根；定义变更可重算必要inline，未获raw权限的字节保持不变。扩窗/fullfallback实际计数且不能替代局部正例。若此解释错误，风险是性能范围扩大，故正式报告必须分开raw、block、inline工作并保完整I7与一字一hunk，不能称总O(1)。

## Root最终I7验收注意（不是新失败结论）

完整§12.4的一字一hunk必须在各语料实际可编辑的正文位置验证，不能统一加顶层paragraph后只改前缀就代表列表/quote/table保真已过。当前列表T1明确没有扩大top-level exact-text权限；T2的marker/tight也不能自动证明列表内部非规范marker空格、indent、多个blank全部逐字保持。后续file/binding验收应含嵌套段落改字与独立expected原字节，若raw差异超实际触碰句子必须修真实来源/局部输出而非过滤diff。此为验收待核事实，尚无运行证据，不能预报成已发现产品bug或提前扩当前Task2范围。

后续必须沿用列表Task2实际受理的occurrence位置接口：PMNode对象可复用在多个位置，lineage/渲染不能仅node identity；实际capture emitted对象唯一性与任意transaction对象复用是不同合同。F1缓存authority重绑、root correspondence及后续business bindings需保位置来源，不按同文/hash/对象身份给新birth继承旧权限。最终接口以T2fix后代码为准。


## F1 可编译行为 RED 的最小固定样例

下面使用本计划新增的公开 API；先加上文定义的可编译 failure stub，再执行此测试。不是以缺导出/编译失败代替行为 RED。100/1000 fixture 及前后原文固定，完整 oracle 只在测试执行，不能进入生产路径。

```ts
import { expect, it } from 'vitest'
import { createSourceSession, prepareFileSourceEdits } from '../source-fidelity'

it.each([100, 1000])('updates one ordinary paragraph locally in %i roots', count => {
  const paragraphs = Array.from({ length: count }, (_, i) => `Paragraph ${i} alpha beta`)
  const source = paragraphs.join('\n\n')
  const opened = createSourceSession(source)
  expect(opened.ok).toBe(true)
  if (!opened.ok) throw new Error(opened.reason)
  const target = `Paragraph ${Math.floor(count / 2)} alpha beta`
  const from = source.indexOf(target) + target.indexOf('alpha')
  const expected = source.slice(0, from) + 'omega' + source.slice(from + 5)
  const result = prepareFileSourceEdits(opened.session, {
    expectedRevision: 0, edits: [{ from, to: from + 5, removed: 'alpha', text: 'omega' }],
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  expect(Buffer.from(result.session.source)).toEqual(Buffer.from(expected))
  expect(result.session.revision).toBe(1)
  expect(result.file.work.mode).toBe('local')
  expect(result.file.work.fullCaptureCalls).toBe(0)
  expect(result.file.work.legacyParseCalls).toBe(0)
  expect(result.file.work.topLevelRunnerCalls).toBe(1)
  expect(result.file.work.inlineRoots.length).toBeLessThanOrEqual(3)
  const oracle = createSourceSession(expected)
  expect(oracle.ok).toBe(true)
  if (!oracle.ok) throw new Error(oracle.reason)
  expect(result.session.doc.eq(oracle.session.doc)).toBe(true)
  expect(result.session.roots).toEqual(oracle.session.roots)
  expect(result.session.gaps).toEqual(oracle.session.gaps)
  expect(result.session.protectedSources).toEqual(oracle.session.protectedSources)
  expect(result.session.layout).toEqual(oracle.session.layout)
  expect(result.session.textSpans).toEqual(oracle.session.textSpans)
  expect(opened.session.source).toBe(source)
})
```

这两例还要在同一fixture捕获真实rules/lines/inline计数并以安装版本实测常数冻结独立断言，不从旧依赖探针45直接抄成功阈值。多来源维度oracle对应的是本次完整candidate capture，不用legacy parse当source grammar oracle。

## Task 1：完整文件解析环境、缓存与局部重解析

- [ ] **A. RED现状与公开合同**
- 冻结BASE/inputs/工具版本，记录实际dependency私有shape；新增可编译raw API/types最小stub后用行为assert RED，缺导出/编译错误不是RED。
- 对existing createSourceSession→applySourceBlockTransaction的100/1000段实际调用spy记录现状全文block/inline；期望局部预算而RED。spy用测试侧实际依赖原型/现有生产内部模块，不root-export计数测试hook。
- repeat parse/replay fixtures：task checkbox、emptylink、audio/video、pairedHTML、textSpecial/join、hardbreak、synthetic、closed/unclosed nested fence；先暴露模板复用/旧collector失效。RED与之后GREEN保留独立labels。
- 不因stub先通过编译就执行下游host/提交；A–F是一个Task。

- [ ] **B. 真实cache/replay GREEN**
- 按helpers 1–3/8–10抽一次完整actual pipeline与唯一finalizer，始终原md规则；registration factory覆盖每个入口。
- per-call facade使用同一Moraya构造器tokenizer参数，禁止全局临时md.parse替换。
- 真实baseline capture vs cached emission严格等值，repeat/candidate失败后base fingerprint不变；Token prototype和WeakMap映射都被验证。
- focused A fixtures GREEN；foreign-session authority 恢复及 unchanged identity 独立断言，cache hit 不重复 full capture。尚未窗口实现的性能RED保留，不能提前标整个Task GREEN。

- [ ] **C. 定义/env TDD**
- 跨root [A][id] + /one,/two,unused；删winner晋升、仅改loser不全inline、增unresolved [new] definition远处转link、nestedquote/list definitions、multiline/title rollback/silent/failed rule恢复。
- footnote unused/duplicate/self-reference、refs顺序变化、定义删除变orphan、脚注正文中的refs、image alt嵌套effects；只改普通段effects不变、真实local positive。
- core actual events与protected范围一致；semantic env重建，不使用上次可变编号。Definition changed→all-inline、block窗口仍局部，未改raw无replace。
- 缺失rule/shape变更fixture通过真实guard模拟，必须明确失败或可验证fallback，不空doc。

- [ ] **D. 窗口与raw API TDD**
- new fullcandidate State从checkpoint恢复；纯段100/1000改字、split/join/insert/delete常数窗口正例，与full oracle多维等值；跨两不相邻edits记录真实窗口/重复计数。
- 未闭fence/setext/HTML/listcontinuation/deflist/math变更扩窗/EOF，真实full-fallback标志；BOM/CRLF/loneCR/NUL预处理、不切CRLF/surrogate、no-final-newline。
- onlydefinition/empty/source-onlysamePM变更，BOM-only/NUL 按 actual capture 成功或明确失败合同；CAS stale/removed错误/overlap/duplicateanchor/整数边界，base atomically unchanged。
- correspondence正例：prepend保持后根对应、重复正文不同roots、split/join、多root替换repartition、gapbirth/delete、distantenvPM改变但raw untouched；no business ID。
- oracle只在tests保存独立计数区。一次实际成功路径调用数、失败重试、fallback和PM emission成本全部断言；不以差异过滤假局部。

- [ ] **E. 所有既有来源入口接入、source-only zero legacy parse**
- exact text、stable root-render、structural recipe的最终parse全部经prepareCandidate；factory注册revision+1实际返回对象，不遗漏{...session}副本。
- 新raw API能显式改definitions；相同编辑由未经授权Rich事务或nested root-render仍在R1第一道serializer前拒绝，第二道editguard独立保留。原unsupportedstep/partialatomic/stalecustomschema/allattrs测试不放宽。
- 仅source-root serializer增加内部保守选项/单独调用模式，返回规范必要escapes，不执行relaxEscapes；默认legacy serializeMarkdown/parseMarkdown/async不改。exact/root-render/structural三路径legacyParseCalls=0。
- **不删除source语义校验**：generated fragments只在本次完整file env候选中strict doc.eq验证。literal a[0]、\\*star\\*、#/-/_、marked whitespace、hardbreak、table、math、footnote、emptylink、HTML/native supported producers全回归。保守escaping导致既有合法producer失败必须在source-only renderer最小修复；不能偷偷重启relax parse或把回归降为新拒绝。
- 保留 140000 blank/CRLF 大输入的 bounded traversal，不引无界 spread/递归展开；沿用实际现有回归，并补与模板复用/窗口有关的必要断言。
- 保留原N2 fastpath复杂度与R1结构权限，不能为了cache对stable mark每step全文扫描。结构现有slowpath成本单列。

- [ ] **F. focused GREEN→共同门槛→两仓提交→审查**
- 先跑core全部新增focused与实际source回归，失败修根因，重跑受影响项。确定代码后只跑一次core tsc/full/build，记录实际通过测试数；suite通过后同代码不重复。
- artifacts→精确stage源码+tracked dist+reachableignoredDTS→core commit（禁止amend）→已提交blob安装→host公开consumerfocused→hostfull/purity/Vite/Kit/browser→host commit→installed audit。
- 若host失败需core修复，新增core commit，重新相关门槛并安装新HEAD，不复用旧统计假通过；未影响部分不重复suite但记录复用的代码fingerprint/原因。
- 单一 fresh Task reviewer 同时做 spec+quality 审查并关闭全部 fix/ruling，之后才 root 唯一 final svelte-check + 前后 tracked fingerprint，最后唯一 strongest whole-range final 审查。没有第二 plan reviewer，不拆成两个 reviewer seat。所有 warning/minor/ruling 写 ledger；若最终审查产生新 fix，用新 commit 按实际新输入做必要复验，另名保存并保留原 final/失败证据，不为排序对相同已通过输入重复 suite/Svelte。
- 归档own全部raw evidence/selectedinput/toolsmetadata/commits与SHA，不删除未知文件；parent既有归档规则执行。这个Task不发布。
