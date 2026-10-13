# Shared editor list producers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 捕获真实嵌套列表词法来源，并让受授权的局部输出保留 marker/tight 和任务复选框语义。

**Architecture:** 在现有 parser 的真实 token/PM emission 上采集来源；在现有 source transaction 与 serializer 中传递经过验证的 list 风格。相邻列表的边界是普通 HTML comment 的真实 PM node，生产 controller 接线属于后续任务。

**Tech Stack:** TypeScript、ProseMirror、markdown-it、Vitest；不新增依赖。

**Spec:** docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md，I7、§12.4、§12.9、§20决定7。

2026-10-13 正式采纳。表格阶段已受理，产品 core042a473a8befb22230988ba2eef6685affca77a1 / host8e3c0e6365746a32aa985b72c766fb089df8af7b；收尾 docs host13f2b34e6cbedf7e29a0d68c5c52632e2eee222e。执行 BASE 在本计划精确提交后记录于 OWN，Task2 以 Task1 实际受理 HEAD 另冻。

## Global Constraints

- 直接两个现有 main；不新建 branch/worktree。单一产品 writer，每个 numeric Task fresh implementer + 唯一 fresh spec/quality reviewer，不让子代理再派 helper/reviewer。root 自审规划，禁止额外 plan-review seat。
- 不 reset/clean/add-all/amend、不读 `.env`、不升级或安装依赖、不修改 node_modules 源码。committed core dist 安装是唯一获准的安装目录写入，只用已验证 atomic rename。保留 baseline 原 untracked/stash/backup/其他 branch/tag；`tasks/todo.md`、`tasks/lessons.md` ignored/nottracked，不 stage。
- I7/§12.4 不降低：未触碰原 bytes 保持，UTF-16 offsets / UTF-8 bytes，BOM/CRLF/loneCR/末 EOL/blank/protected/完整 source map 保持；全部 attrs/marks（含 colwidth/language/业务ID）严格 eq。禁止全篇 serializer+diff、过滤格式差异、清除 attrs、第二 raw/history 栈。
- 前置 header-only、empty language/explicit text、quote table delim、EOF table无EOL来源、Rich逐字fence/inline规则保留。默认 serializer 除明确 ordered0 缺省修复外不改；列表 marker/tight 仅 source-only。原 14 fixtures bytes 和 manifest 不变。
- 同一次真实 token handler 捕获 nested list 并在最终 doc 一次定位；公开可选 lists 只观察，私有实际 capture authority 才驱动风格。foreign/missing 在任何 render/fence guard前实际 recapture 与全部来源验证，不默认[]/tight，不永久拒绝合法 clone。R1 两道 guard、真实 fence facts、标准步骤/slots/来源账本继续；不新增第二 parser/ledger/public normalize/setter。
- M 是精确普通 HTML comment 的真实 PM node；目标 tr.doc 含它才渲染。只允许精确 M 的必要结构例外，普通 HTML 权限不扩大。测试 augmentation 明示，不冒充 controller 已自动补 M；隐藏节点导航、marker-only输入、跨 M join、Source/remote/undo不自动补、onehistory 是后续硬合同。
- 每 Task baseline→有效 RED→GREEN→core tsc/full/build/artifact→精确 source+全部 dist commit→committed blobs 安装→host focused/full/purity/Vite/Kit/旧browser回归→host精确commit→installed全闭包→fresh独立spec+quality→必要fix及scoped→root受理。依赖按顺序，非预期非零由 caller throw，立即停止下游。无新代码/未解问题不重复同输入 suite。
- 所有 verification/stage/install/commit/audit 保存实际 argv/cwd/time/真实 exit、完整 stdout/stderr、工具 initial/session/final；唯一 label，不覆盖 RED/失败。run.py `--cwd core|host`，预定义 RED `--expect-exit 1` 仍核真实 assertion，missing import/无效 fixture 不是行为 RED。
- package BASE→HEAD **完整 bytes 不变**；本计划不继承 B-style 删除权限/known missing出口豁免。所有 declared export targets 必须存在，所有 JS exports 实际 import；全部 committed dist、DTS/JS依赖、maps/embedded source 与两仓14语料BASE/HEAD/working逐 SHA。58dist/18JS是旧观测，不是未来固定数。
- index gzip hardcap **81920 bytes**，不预涨。dist build clean:true 前先核未知 working 文件，未归属不得让构建泛删。新 ignored hashed DTS仅可达目标精确stage；obsolete仅 frozen BASE→committed HEAD --no-renames 单层 hash .d.ts，先核 installed旧bytes，不泛清。未知安装文件保留报告，可达未知导致失败。
- 每 Task/fix关闭后，root尾部一次 host Svelte + 两仓 tracked src/scripts/dist/buildconfigs/package/locks（含Memory）前后指纹，再唯一 strongest whole-range final；最多 ONE统一 finalfix + ONEscoped。实际 finalfix改变检查输入则新label必要复验，旧失败与 fingerprint组保留。全部 Minor/⚠/Ruling 逐项处置，不以 exit0称无警告。
- 本片没有新 Rich/Kit UI 行为；installed公开API/真实Kit命令测试只证明所测consumer。旧 single-block browser是回归，不冒称完整 Source/file/UI/native/IME/E1–E4。完整任务与统一发行继续 pending。

## 正式自含工具与冻结输入

从 canonical archive 的已核 selected manifest 提取 `next-list-tool-candidate/`九个文件到正式 OWN 根，根自审后实际运行新的 baseline，不能调用旧/兄弟 workspace。`run.py`、`audit.mjs`、五个 shell wrapper、`root-tracked-fingerprint.py`、`assemble-core-review.py` 是一套实际工具，完整算法不在计划重复另造。

每 Task 保存 `core-task-base`、`host-task-base`、`stage-allowlist-core`、`stage-allowlist-host`，另存 S1/S2冻结副本。artifact snapshot `S1-artifacts.json` / `S2-artifacts.json` exclusive生成，stage读取同一 snapshot 核 SHA，不重复 import审计。使用 `empty-env/`（保持空）和 task 独立 browser/cache，不读根 `.env`。

Task1 初始精确源码 allowlist：core `src/markdown.ts`、`src/source-layout.ts`、`src/source-fidelity.ts`、`src/__tests__/source-list.spec.ts`、`src/__tests__/source-structure-commands.spec.ts`；host `src/lib/share-merge/source-list-producer.test.ts`、`src/editor-kit-v2/source-structure-commands.test.ts`。两个旧 checked 拒绝只在真实正例实现后迁移，不提前假成功。若实际新增字段使既有 capture/layout 测试需迁移，先给 root 精确失败/路径/所需最小变更，不自行扩 allowlist。

Task2 冻结时核 T1实际受理 HEAD；core 追加精确 `src/source-structure.ts`、`src/__tests__/source-list-boundary.spec.ts`，同 markdown/layout/fidelity/list测试；host 仍上述两个installed消费者测试。不授权 broad changelog/version、Kit controller产品或宽度/历史改动。

## 实际命令（正式执行时所有 label 新建）

core cwd：

```sh
./node_modules/.bin/vitest run src/__tests__/source-list.spec.ts src/__tests__/source-structure-commands.spec.ts
# Task2在新spec实际存在后追加source-list-boundary.spec.ts。
./node_modules/.bin/vitest run src/__tests__/source-trace.spec.ts src/__tests__/source-document-capture.spec.ts src/__tests__/source-layout.spec.ts src/__tests__/source-reference.spec.ts src/__tests__/source-block-fidelity.spec.ts src/__tests__/source-structure.spec.ts src/__tests__/source-structure-commands.spec.ts src/__tests__/source-terminal-hardbreak.spec.ts src/__tests__/roundtrip.spec.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsup
# artifacts/stage用各Task实际snapshot；core commit之后才host-sync。
```

host cwd：

```sh
./node_modules/.bin/vitest run src/lib/share-merge/source-list-producer.test.ts src/editor-kit-v2/source-structure-commands.test.ts src/lib/share-merge/source-fidelity.test.ts src/lib/share-merge/source-structure.test.ts
./node_modules/.bin/vitest run
node scripts/check-share-merge-purity.mjs
node --input-type=module -e 'import {build} from "vite"; await build({envDir:"/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-list-producers/empty-env"})'
node scripts/check-editor-kit-build.mjs
# 旧单块browser脚本使用未来OWN独立S1/S2输出与cache和已装Playwright实际路径。
# host提交后installed-corpus-audit.sh默认检查gfmTableCommand两个出口。
```

任何 focused 路径正式冻结前实际核存在，未来新 spec 是本Task创建目标，不先跑不存在文件冒充 RED。两个 Task 的 `task-N-report.md` 是完整实施/修复证据主报告，精确 `list-task-N-release-report.md` 交付摘要与主报告保持一致，不独立假称发布。review/fix之后 root 在正式报告逐字收录全部 Rulings/成本、warnings/失败、平台与主任务边界，归档全部 raw+manifest逐 SHA回读后只清 own。

## 已采纳的接口和设计

目标：先交付可独立验证的 core 解析事实与局部 renderer 能力。边界使用现有 `html_block`，文本为 `<!-- notemd:list-boundary -->`（下文 M）；它始终是**真实 PM 节点**。最终 transaction.doc 必须包含它，core 不在 source handler 中偷偷生成不同目标。file controller、UI与history在后续独立计划接线，本候选不宣称现有 Kit 完整相邻列表命令已可用。

主 spec：`docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md`，I7、§12.4、§12.9。未改动块字节保持、无修改三次切换零diff、一字一hunk、全attrs/marks、R1及fence guard均保留。

## 0. 冻结的范围决定（已采纳）

1. 两个生产 Task：T1 actual list lexemes（含nested实际PM位置/来源）、checked provenance、ordered0；T2 source-only marker/tight renderer与精确M节点的结构准入。
2. 不新增zero-PM layout、reserved解析规则、legacy/source语法分叉、DP/配色、第二parser/trace、public normalize API或通用producer planner。M仍按普通HTML grammar进入自然root或容器内容；既有source roots/slots承担所有权。
3. 存活且可证明来源的list保原marker/tight；新list或改变family用既有默认bullet `-`、ordered `.`，新list默认tight。split继承实际来源；join有多个实际同family来源时marker取最左存活来源，tight仅在所有来源tight且实际未保留loose seam时为true。**不为少一个M改原marker、改start、偷偷join或试多套source。**
4. T2不负责向用户transaction自动补M。未补M且无法严格表达的相邻list目标继续原子失败；测试中的显式标准insert步骤证明core能力，不能称生产normalizer已完成。
5. 普通HTML既有能力不扩大：当前被拒的top-level普通HTML结构birth/delete继续拒绝；仅精确`html_block(M)`窄准入。既有可工作的nested普通HTML/稳定路径不借此重构或误称全局禁止HTML。
6. 发布/完整体验仍依赖后续filebindings/history/UI计划；source-only raw/EOL变化仍需原生history。PM节点本身可被普通serializer保存，不等于全文generic serializer满足I7。

## 1. 固定读证与真实接口

本次新固定读证core：`042a473a8befb22230988ba2eef6685affca77a1`；host：`fd5b1ef3feffc6b8b9d2bdbbeff2c933143c923b`。原候选基于`7ec5d621f195f7a389774dd355aa240420972c8c` / `440e7302a545fd24b0a7173cc2d9c092a8434dbc`；差异已按固定blob只读核对。前置schema已允许header-only table、empty language为`''`且显式`text`保留；新HEAD还含共享GFM command、table嵌套delimiter恢复和EOF无EOL保持，表格Task2与整计划已受理。未来执行BASE必须等root记录受理后另冻，不以当前HEAD自动替代；source-layout/source-fidelity及host实验source adapter在所核新旧blob中相同，filecache/controller仍非本候选已存在API。

当前公开接口保持：

```ts
createSourceSession(source: string, schema?: Schema): FidelityResult
applySourceBlockTransaction(base: SourceSession, tr: Transaction): SourceBlockResult
// session.revision/source/doc/textSpans/roots/gaps/protectedSources/layout
// 成功结果 mode/edits/changedRoots 形状不变；没有新 public normalize 入口。
```

实际相关内部接口：

- `markdown.ts` 的 `Capture`、`tokenSources`、`captureCursor`、`prepareRootEvents`、`captureRootEmission` 和 `parseDocumentWithSourceCapture`。目前只有顶层自然root事件，没有nested list emission metadata；`captureCursor`支持实际parser stack，但不能单凭临时cursor假定最终PM位置。
- `MorayaMarkdownParser` 实际token handlers最终统一包`captureRootEmission`。可在这里增加list open/close事实采集，不复制block grammar、不重新parse。
- `source-layout.ts` 当前只有blankLines/fallback；增加普通list词法metadata，不增加ListBoundary artifact。
- `source-fidelity.ts` 的 `rootRenderNode` 递归copy后可能重排render-only marks；styles必须随递归copy绑定到实际render对象，不能绑旧node后失效。
- `serializeSourceRootMarkdown(doc)`当前内部source renderer，使用`state.renderList`、通用list_item/HTML回调；拟增加只读options，默认`serializeMarkdown`除T1的0修复外不变。
- `applyStructuralTransaction(base,tr,render,rootHasClosedFences)`已有真实标准steps/ledger，render当前接`PMNode[]`。本候选沿用其root/slot权限；不创建第二结构ledger。其旧root白名单和closed-literal分支目前拒绝top-level html_block，T2必须窄改两处。
- host当前`materializeBlocks → createSourceFidelity`仍是实验paragraph-text适配器，command入口在fidelity模式禁用；host本候选只新增installed consumer测试，不改这些生产行为。

## 2. 全部代码边界与拟新增类型

| 文件 | T1 | T2 |
|---|---|---|
| core `src/markdown.ts` | actual token pairing、list handler emission、nested最终绑定；checkbox runs与0 | source-only marker/tight回调、递归options消费；普通HTML解析完全不变 |
| core `src/source-layout.ts` | `lists`只读类型与finishSourceLayout传递 | 不增加zero-PM边界字段 |
| core `src/source-fidelity.ts` | session传递 | 稳定/结构路径的实际list-style来源映射与render clone接线、精确M family判定、最终strict回读 |
| core `src/source-structure.ts` | 无新增结构权限 | 精确M旧root准入及closed-literal输出准入；沿用实际standard-step/root/slot/recipe guard |
| core `src/__tests__/source-list.spec.ts`（新） | lexeme/checked/0/实际位置矩阵 | nested marker/tight、来源继承与attrs负例 |
| core `src/__tests__/source-list-boundary.spec.ts`（新） | — | 普通HTML M的真实birth/delete/nested/生命周期/权限矩阵 |
| core既有capture/layout/reference/fidelity/structure/commands与parser/serializer suites | 必要正例迁移与回归 | 防越权、普通HTML、fence、R1、allattrs回归 |
| host `src/lib/share-merge/source-list-producer.test.ts`（新） | installed committed core捕获/0与propose | 本仓真实命令+显式场景M步骤+公开core API；不改Kit/controller产品 |
| core全部tracked dist及可达新hashed DTS | 同生产源提交 | 同生产源提交 |
| 未来冻结执行OWN内 `list-task-1-release-report.md` / `list-task-2-release-report.md` | 精确记录T1交付、验证与未完成边界 | 精确记录T2交付、验证与未完成边界；由root收尾精确补宿主双语Unreleased，不修改版本 |

拟新增metadata（不是当前已存在API；SourceLayout经session可达，非授权capability）：

```ts
type ListMarker = '-' | '+' | '*' | '.' | ')'
type SourceListLexeme = Readonly<{
  id: number
  rootId: number
  pmFrom: number
  pmTo: number
  sourceFrom: number
  sourceTo: number
  kind: 'bullet' | 'ordered'
  marker: ListMarker
  tight: boolean
}>
// SourceLayout增加 lists?: readonly SourceListLexeme[]（公开输入兼容旧版本）。
// 每个新成功capture输出都实际填lists（无list才为[]）；缺失表示来源未知，不等于[]。
// sourceFrom/sourceTo是实际token.map的原始物理行包络：可能含quote/indent前缀，
// nested范围可互相包含，不能当成可改写的精确marker span。
// pmFrom/pmTo是最终真实list节点边界；id/rootId仅在本session有效。

type SourceListStyle = Readonly<{marker: ListMarker; tight: boolean}>
type SourceRootRenderOptions = Readonly<{
  lists?: readonly Readonly<{node: PmNode; style: SourceListStyle}>[]
}>
// 拟扩展既有内部方法，不新增root export：
serializeSourceRootMarkdown(doc: PmNode, options?: SourceRootRenderOptions): string
```

offsets为UTF-16；原字节比较为UTF-8。checked取真实PM attrs，不重复存一套task状态。不得加入PM词法attrs、持久node ID、raw boundary artifact或public任意setter。**公开readonly lists仅供观察，不是可信style来源**；实际authority绑定与foreign恢复合同见§2A。

## 2A. metadata兼容、可信来源与foreign恢复（T1/T2必须实现）

**公开兼容选择：** SourceLayout.lists为可选只读字段，避免旧手造/持久化SourceSession因新required字段立即类型失配；内部新capture成功结果必有完整数组。undefined只表示未提供新词法来源，不能当[]或tight=true。sourceFrom/sourceTo是物理包络；pmFrom/pmTo/id/rootId必须来自本次最终doc，均不能恢复业务identity或赋予写权限。公开数组和每条fact冻结，但冻结/readonly本身不构成可信证据。

T1在markdown.ts新增私有`WeakMap<SourceLayout,{source:string;doc:PmNode;roots:readonly SourceRoot[];lists:readonly SourceListLexeme[]}>`，仅实际capture finalization登记；内部只读查询`capturedSourceLists(source,doc,roots,layout)`必须同时核对原source与对象绑定，返回可信facts或undefined。此为拟新增内部生产hook，不root-export，不提供setter。checked provenance仍取实际tokenSources与发射attrs，不从公开fact倒推。新成功session的revision-only spread保留doc/roots/layout引用，因此不需要额外session factory或逐次重登记。

T2的私有`prepareListAuthority(base)`在任何renderer或sourceRootHasClosedFences guard之前执行，行为固定：

1. 同capture绑定存在则读私有facts；公开字段应与绑定一致，发现被替换/篡改则失败。不得按JSON中的marker选择风格。
2. foreign、layout/doc/root clone、旧session缺字段或同bundle绑定缺失，使用现有`createSourceSession(base.source,base.doc.type.schema)`做**一次真实完整capture**。不得只校验lists形状、空数组占位、第二shadow parse或默认closed。新capture恢复真实list及既有fence/protected来源，使用它整套doc/roots/layout进入后续guard。
3. 要求新capture与输入base的doc严格eq（全部attrs/marks）、schema相同，已有roots/gaps/protected/textSpans/blank/fallback完整对应；若输入lists存在，也须与重采facts完整一致。raw来源、已有metadata或已提供的lists矛盾则明确失败，不能忽略差异。新字段缺失本身不拒绝正确旧session。
4. 使用重采得出的内部base继续真实tr校验/来源映射，保留传入revision；不修改原session、原数组或旧cache。重采doc与tr.before对象可能不同，style映射初始化必须在严格doc.eq成立后按可信pmFrom/pmTo核对tr.before的实际list节点与nodeSize，再绑定到本次tr实际node；不能仍只找重采node对象而把正确clone误判为无来源。有效clone应与原session产生相同source/edits/style，不能永久当unsupported算完成。操作净无效时公共结果仍返回**原输入base对象**与原revision；mutation成功的最终candidate再按既有实际capture产生新session。任何失败不安装恢复结果。

这不是filecache：同capture路径只做绑定检查；foreign恢复允许明确一次O(N)capture并记录其成本，不宣称局部。该helper不能递归调用自身或强迫legacy parser带collector。以后F1接管cache恢复时沿用同一实际capture authority要求，不能把JSON反序列化或拷贝fact等同实际token发射。

**必须迁移/验证的构造点：** markdown.ts的Capture初始化/list drafts与parseDocumentWithSourceCapture finalization；source-layout.ts的finishSourceLayout（新capture调用必须传实际完整facts）；source-fidelity.ts的createSourceSession与成功revision spreads（保留已登记layout/roots/doc）；既有直接构造layout/session的测试fixture只按真实语料更新，缺metadata的foreign正例走恢复，禁止批量塞lists:[]。最终doc遍历后才冻结lists，不能在临时cursor阶段发布它。

额外必须实际通过：同session成功；按值clone doc/roots/layout和缺lists的正确旧session成功且输出一致；JSON伪marker/tight/pmFrom或删一条fact原子拒绝、renderer spy未调用；同源码重复正文不能错绑；schema填paragraph导致位移的nested最终pos正确；foreign缺fence WeakMap但raw合法闭fence时在guard前恢复，真正未闭fence/R1仍拒绝；失败/unchanged不改输入对象；不得为了这些用例新建public setter。

## 2B. 已核serializer接口与窄适配代码

两份真实依赖都为1.13.4，`src/to_markdown.ts` SHA256均为`27e425c6f70a2add5297340c7079542b6fdf398c5167009ea555f23d41989fd4`：

- core：`/Users/bruce/git/moraya-core/node_modules/.pnpm/prosemirror-markdown@1.13.4/node_modules/prosemirror-markdown/`。
- host实际@moraya/core的peer解析：`/Users/bruce/git/mdeditor/node_modules/.pnpm/prosemirror-markdown@1.13.4/node_modules/prosemirror-markdown/`；host根没有直接prosemirror-markdown链接，不能据此声称host缺依赖。

源码`src/to_markdown.ts:59–67`证明每次serialize复制options并新建state；`:193–198`公开options及默认tightLists；`:415–428`三参数renderList，先取node.attrs.tight否则options.tightLists，内部保存/恢复inTightList。运行ESM `dist/index.js:404–408,800–813`一致；声明`dist/index.d.ts:259–264,309`暴露options和三参数方法，没有公开inTightList。当前core `src/markdown.ts:1454–1460`是Moraya默认list回调，`:1725`是sourceRootSerializer，`:1758`是source入口；没有需要猜测的第四个renderList参数。

拟在source-only回调使用的私有适配（目标代码，尚未执行）：

```ts
function renderSourceList(
  state: MarkdownSerializerState, node: PmNode, style: SourceListStyle,
  indent: string, firstDelim: (index: number) => string,
): void {
  // 依赖优先读node.attrs.tight；不得删/覆盖目标attrs来强行套词法风格。
  if (node.attrs.tight !== undefined && node.attrs.tight !== style.tight)
    throw new UnsupportedSourceCapture()
  const previous = state.options.tightLists
  state.options.tightLists = style.tight
  try { state.renderList(node, indent, firstDelim) }
  finally { state.options.tightLists = previous }
}
```

renderList自行管理inTightList，helper不读写私有state。子list进入时取自己的可信style，退出后options恢复父值；若render抛错，整次source候选失败并丢弃state，不捕获后继续使用半成品。每次source serialize创建仅当前调用可见的style map/回调闭包，例如以现有sourceRootSerializer.nodes/marks/options创建当次MarkdownSerializer并覆盖两个list回调；共享node/mark处理器仍复用，不设全局currentStyle、不改node attrs、不复制renderList算法。未找到被确认存活list的可信style须失败，只有已经由实际steps证成new的list才获默认style，不把metadata缺失当new。

T2 RED必须区分外tight/内loose与反向、同一父级两个不同tight子list、后续兄弟list风格、异常路径与下一次独立调用不串状态；单独验证options字段存在不算此helper行为GREEN。既有source relaxEscapes的legacy parse行为未因这次接口核定而消失，不新增marker候选试parse；F1未来若已修则沿用实际新BASE。

## 3. 下一 filebindings/history/UI 计划的强制接线合同

以下是**尚未实现、必须在后续独立计划完成的下游合同**，没有新命名函数可供本Task调用：

1. 统一入口在首次source guard前完成真实M步骤，最终tr.doc含M；覆盖菜单/快捷键/输入规则/粘贴/拖放及获准appender。普通appendTransaction位于首次filter/apply之后，不能用于修复先被source guard拒绝的原tr；不允许暂存source无合法raw的中间doc。
2. 因果权限来自原用户动作造成的birth/split/type-change/delete-between/join-seam，不能凭producer自己刚加的合法ReplaceStep倒推授权；不全篇修复旧文档、不改未触碰两邻。Source输入、remote、undo/redo不自动补M；Source主动删除/改写comment的结果必须生效。
3. view只隐藏精确html_block(M)，普通HTML显示原行为；同文用户comment也必须遵守同一view约定，不伪造generated身份。M是非atom文本块，必须完成Arrow/Backspace/Delete、选择/剪切/IME/可访问性、marker-only空视图输入及显式跨M join。不能load时添加真实空paragraph破坏零diff。
4. 使用同一whole-file canonical session建立view与获准业务ID bindings；无需新增M的legacy grammar差异，但文件环境/引用/env仍不能按业务block单独parse。投影仅处理中和获准业务ID，所有其他attrs/marks完整保留。
5. doc/raw/layout/cache/bindings同一次attempt/CAS提交；latefilter拒绝或mutation不得漏提交。沿用当前prepare指纹保护；PM节点增删与用户命令同一history事件，没有另dispatch的修补栈。现有governed BlockEditStep与source标准step准入的冲突必须在该计划具体解决。
6. Source只改EOL/blank且doc.eq也要产生可撤销raw事件；所有change/getMarkdown/flush/save/draft/afterMarkdown/export/Markdown复制/reopen/rebase出口读同代raw。generic serializer能携带M，不自动满足I7或原字节undo。
7. 真正Rich→Source→Rich三次、modified raw保存重开、原生undo/redo、网页/桌面/IME、§12.4全部语料与一字一hunk在该计划验收。本两Task的包测试不代替这些验收。

## 4. 未来 cache 与执行门槛

本次actual list facts绑定的是本次token、实际发射PM node与最终root。当前T1/T2实现§2A的实际authority与foreign一次真实recapture；**不实现filecache**。未来F1若复用TokenTemplate，必须携带actual token markup/tight/配对与raw map依据，clone时重绑新collector/open-close事件；实际emission后按最终PM节点身份重新定位pmFrom/pmTo/rootId（包括schema fill位移）。不能直接复用旧session的node、layout、pmFrom、rootId或WeakMap绑定。新layout登记的是本次真正source/doc/roots/facts，fence事实也同代重绑。cache miss或foreign恢复必须在任何render/fence guard之前完成，不能等最终parse才恢复authority；不设公共恢复setter。如果F1先受理，root依真实新BASE改为调用它唯一已实现的恢复路径，不能保留两套capture/cache factory。

每Task按既定顺序：baseline → focused有效RED → 实现/GREEN → core typecheck/full/build/dist/DTS/exports/gzip → 精确core commit → 只安装该committed blob → host focused/full/purity/Vite/Kit → 精确host commit/installed SHA核验 → 单fresh reviewer同时spec+quality → fix关闭。root最后执行约定的唯一final Svelte/fingerprint及whole-range。新测试统一`src/__tests__/`，focused只列本Task已存在文件；不编造通过数量。

六份既定记录器/baseline/artifact/stage/installed/host-sync脚本由root在正式brief移植并自含，参数/完整raw stdout stderr与工具metadata沿既有已验证格式。本文不复制另一套审计算法，不读取/执行旧兄弟workspace脚本。本次BASE已核，后续TaskBASE仍须核table旧负例迁移、language契约、实际测试文件及已有fence闭合事实，不能为了本Task覆盖那些新受理改动。

禁止安装/升级依赖、读取.env、改node_modules源码（仅允许工具原子同步committed dist）、reset/clean/add-all/amend；生产单writer。两个Task均须独立受理，但两Task完成只表示core可表达**目标中已有真实M节点**的列表文档，不表示adjacent-list命令/UI/完整共享编辑器已经交付。


### 精确release-report交付

未来root冻结执行OWN后，两份固定文件为`OWN/list-task-1-release-report.md`与`OWN/list-task-2-release-report.md`。writer不得用泛“两仓changelog”扩大产品改动；root须按新AGENTS在收尾补已验功能的宿主双语Unreleased，不做版本号/发布/市场更新。每份报告必须逐项给出：冻结core/host BASE、最终两仓commit、精确源文件/dist/DTS变更、实际依赖realpath/版本、有效RED与GREEN命令及完整证据路径、全量检查的实际exit/已知warning、installed committed包核验、review/fix关闭记录和剩余下游依赖。

T1报告必须列nested实际位置/来源、checked与0真实行为、metadata字段兼容；foreign真实恢复由T2实现并在T2报告给出结果；T2报告必须明确区分（A）未augmentation真实命令及仍拒绝的不可表示目标，（B）测试场景在同一真实tr加标准M步骤后core成功，（C）尚未实现的生产controller/导航/marker-only/跨M join/raw history。禁止写“Kit自动边界已交付”“完整adjacent-list已经可用”。测试名称/源码注释和报告保持同样边界，不借手动augmentation掩盖产品缺口。


## Task 1：actual nested list lexemes、checked provenance、ordered0

- [ ] **T1.1 写实际RED。** 顶层与nested的list facts必须来自`createSourceSession`，不得在测试手填metadata。task fixture含checkbox之后真正文字；0同时断言实际attrs和默认serialize回读。
- [ ] **T1.2 实际token事实。** 在既有capture分支对同次实际token序列做一次配对遍历，记录bullet/ordered open-close、`.markup`与完整`.map`。tight只看该list直接item的paragraph.hidden，不从nested paragraph、spread、外层level=0假定。无直接paragraph的空item不能因缺paragraph就伪判loose；按实际list token中的直接可见paragraph事实定义tight，并为纯空item写回读fixture。
- [ ] **T1.3 新增内部list emission wrapper。** 在实际list opening handler前保存parent frame/实际append槽；opening delegate仍正常执行。close handler正常delegate后，验证回到同一parent frame且该槽实际新增恰一对应family的PM list，记录这个**实际发射的节点对象**及token draft。wrapper仅在本次collector已绑定的token生效；不改变legacy handler。
- [ ] **T1.4 最终位置与来源绑定。** `parseDocumentWithSourceCapture` finalization对最终doc做一次实际遍历，将捕获的发射node按对象身份定位，要求恰一次出现，计算最终pmFrom/pmTo并找到包含它的真实自然root。尤其list_item在close/createAndFill时可能补首paragraph，故不得把close之前临时cursor直接当最终地址。找不到/重复/类型或start不一致则capture失败，不按正文/JSON相似匹配。quote、多层list、同一物理行nested list允许包络包含，不能套textRuns的全局不重叠判据。未知token/源码包络无法证明时不编造默认fact。
- [ ] **T1.5 唯一checkbox消费同步provenance。** 保持既有`list_item.getAttrs`识别规则，同步裁剪其真实首text token的tokenSources runs；完整run消费可移除、linear trace合法切片、atomic不得从内部切。新runs必须拼接等于新token.content；保留captureText guard与entity/escape来源，没有trace不伪造。nested任务支持不意味着扩大顶层paragraph exact-text权限。
- [ ] **T1.6 ordered0。** 默认serializer数值`order || 1`改`order ?? 1`；parser `attrGet('start') ?? 1`明确同一缺省合同。注意固定parser拿到字符串`'0'`，原`||`本身不吞它；真正RED在数值serializer，不能报告虚假的parser根因。0/缺省1/3/8/999999999实际attrs逐项检查。
- [ ] **T1.7 metadata authority。** 实际capture finalization生成并冻结facts及数组，并登记私有layout→source/doc/roots/facts绑定；对外readonly字段不直接驱动renderer。新成功capture总填真实lists，旧输入允许缺字段但绝不补空数组冒充已采集。构造迁移与foreign/缓存合同见§2A。
- [ ] **T1.8 GREEN、回归、committed消费者、独立审查。** 旧checked拒绝只有在新成功正例交付后迁移；保留非法来源和异常provenance负例。metadata只读不授予任何新raw权限。

T1最低实际成功矩阵：三种bullet、两种ordered；顶层/quote/list_item内以及多层嵌套；相同marker的不同PM节点、重复相同正文、外tight内loose与相反组合；list_item首paragraph填充后的nested list实际位置；`- [x] A`/`+ [ ] B`/`* [X] C`和nested任务；entity/escaped/strong/link/空item/无空格checkbox/tab；CRLF/loneCR/BOM/EOF。每条fact验证`doc.nodeAt(pmFrom)`的实际list、nodeSize、root包含、原raw包络和markup，不能仅比较自制expected JSON形状。


## Task 2：source-only list styles与真实html_block(M)结构准入

- [ ] **T2.1 先写能力RED。** 真实wrap/list命令产出tr后，测试场景在已知目标seam用`schema.nodes.html_block.create(null,schema.text(M))`及标准`tr.insert`加入M，再原样调用`applySourceBlockTransaction`。先断言最终tr.doc确实有该HTML节点，回读必须strict eq。测试函数命名为场景augmentation，不能伪装已有file normalizer。
- [ ] **T2.2 list-style来源传递。** 在任何render/fence guard之前，先按§2A取得同session实际authority或完成foreign真实recapture；新内部纯helper仅消费该可信facts与真实tr.docs/steps/mapping，产出最终实际list node→style；不授予root编辑权。未变子node可用实际对象身份保留；被编辑list须以标准step映射和实际before/after节点边界证明保留。split的两个存活片段继承被拆list；join按实际存活来源取最左marker；family改变/真正新list取默认。不从最终text、同序号、单个dirty root或PM attrs猜marker。
- [ ] **T2.3 明确nested映射实现边界。** 对直接保留的list shell，以逐step映射后的实际node边界/family验证；对split/join/wrap造成的新shell，以真实步骤保留下来的direct list_item片段/容器 ancestry关联原list facts。只追踪本次需要render的list及其item来源，不复制全CST或第二套raw ledger。边界被整段替换且无保留shell/item witness时视作新list，不能按相似正文继承。多层父子来源分别绑定，不能将祖先style误发给nested新list。标准steps实际chain必须先经过原有验证，metadata映射不能绕过R1/pre-render授权。
- [ ] **T2.4 所有层级renderer真实消费style。** source-only bullet/ordered callback使用该node的marker与tight，递归`rootRenderNode`同步把style从实际目标node绑定到render copy；不能仅传顶层style、所有nested一律tight或丢`+/*/)`。继续调用既有list/item/marks/HTML/escape/hardbreak serializer流程，选项每次调用独立，无全局可变表。stable root改字/mark与结构路径都使用同一style来源helper；结构callback仍可接现有nodes，不必新造外部planner API。
- [ ] **T2.5 per-list tight的已核接口。** 两仓实际`prosemirror-markdown@1.13.4`声明`state.options: {tightLists?:boolean,...}`，options引用readonly而子字段可写；`renderList(node,delim,firstDelim)`恰三参数。source-only回调保存options.tightLists，设置当前可信style.tight，调用现有renderList，并在finally恢复；嵌套按同样方式栈式恢复。renderList内部自行处理inTightList，不访问其私有字段。具体代码与位置见§2B。不得加第四参数、写PM tight attrs或改默认serializer。
- [ ] **T2.6 ordered/checked与全部attrs。** 首号必须真实0..999999999整数；后续marker不得十位溢出，可重复合法首号，缩进按实际marker宽度保证nested continuation。checked true/false/null来自目标node；label/listType/spread及其余attrs/marks仍完整比较，不清除或忽略。负数/小数/十位首号明确拒绝，不改为1。
- [ ] **T2.7 精确M的最小结构准入。** 共用一个内部判定：真实html_block、textContent恰为M、合法默认markup（只允许既有正式schema与获准业务ID投影后的attrs，不忽略任意attrs）。旧root白名单只为真实单一M根增加例外；closed-literal输出只为这个predicate增加例外。输出仍走既有HTML serializer；不用zero-PM、隐藏解析token或M专属slot。普通HTML结构负例原样保留。
- [ ] **T2.8 birth/delete/nested与原子验证。** birth来自目标tr的实际M标准insert步骤，delete来自真实删除该node的步骤；R1、实际fence facts、root完整map、blank/terminal/slot/claim/recipe guard不变。nested M由包含它的获权自然list/quote root渲染，不获得单独nested raw改写权。最终一次source candidate回读包括真实M，doc.check与strict eq(tr.doc)、未触碰root/protected/blank原字节、失败session不变全部验证。
- [ ] **T2.9 installed consumer与审查。** host仅使用本仓PM依赖universe、installed committed core、真实Kit command，再明确的测试augmentation；PM history测试最多证明含M标准step与doc一起undo，不能冒称现有file/native raw history已接好。

**tight规则边界：** loose/tight是source词法事实，PM schema不完整表达它。现存shell以及拆分的来源style保留；join多个list时，若实际recipe仍保留内部空白，不能强行宣称tight。未获权旧blank始终保留；已经被原有真实结构witness授权的seam separator可沿既有规则消费。本Task不新增为保旧join seam而分段渲染raw的系统。nested tight不是自由normalize选项，必须用下表混合fixture证明renderer真的消费了不同style。

### T2 必须成功/拒绝的真实矩阵

| 场景 | 必须断言 |
|---|---|
| 顶层`)`/`+`/`*`列表内改字、marks、checked | 受影响list保marker/tight；别的roots raw不动；strict attrs/marks |
| `1. A` / 中间P / `1) C`，真实wrap后场景加M | finaltr.doc包含list/html_block/list/list；source API成功；不将augmentation说成Kit已有自动能力 |
| 两侧同`.`、多个birth与五root以上长链 | 测试显式对每个必要seam加真实M步骤；各list/start保留，不DP配色、不自动join |
| quote：`> 1. A\n>\n> M\n>\n> 1. B` | createSourceSession与legacy均按实际HTML grammar保nested M；改A文字、删除/插入内部精确M节点的真实步骤按完整目标回读；不能在quote外输出M |
| list_item：`- parent\n\n  1. A\n\n  M\n\n  1. B` | M是首paragraph之后block sibling，nested两list位置/facts正确；dirty外root source输出正确indent，strict回读含M |
| quote内list_item及list_item内quote的nested独立list seam | 至少各一成功正例；同样由真实标准步骤在合法block sibling位置插M，无column0限制 |
| `* outer`内`+ inner`、`0) outer`内`3. inner`，内外tight/loose相反 | 改nested文字与真实sink/lift/splitListItem后，实际存活list来源style正确；同一list内splitListItem不凭空造M |
| split一个list成两list并场景加M；显式删除M后真实join | split两个来源style正确；join取实际最左来源marker/start与command目标一致，边界节点确实消失 |
| `M`、`M\n`、BOM/各EOL/连续M、orphan，保存raw后重开 | 正常html_block自然root，不伪造fallback/zero节点；无操作session.source原字节；只证明core重开，不称隐藏视图可输入 |
| Source把M改普通comment/删除/加尾空格/移入代码 | `createSourceSession(newRaw)`按普通grammar得到真实目标；Source删除后的自然list merge不补回M |
| delete一端、插普通块，剩M orphan | 目标PM仍有M，source仍保存它；无自动清理 |
| 普通HTML top-level birth/delete、M变体、额外marks/attrs | 原有结构拒绝仍拒绝；不能trim后套M例外；非法节点不进入获豁免renderer |
| table_cell等不接受HTML的容器 | schema/真实step拒绝；不为fixture改变table schema；list_item首paragraph规则不放宽 |
| protected definition嵌套/相邻、未闭fence、unknown Step/subclass、stale或伪chain | 原子失败，spy证明不越权render；不移动definition/默认closed/删guard |

上述字符串中的独立`M`占位必须在fixture展开为精确comment全文；不得把文字字母M误测为普通paragraph。nested语料须验证真实PM层级，不用手写最终JSON替代parser。所有正例原文与expected raw在RED阶段冻结，不把实现输出再canonicalize当expected。

没有M的原目标若source回读会merge，应继续明确失败；这个负例与“手工场景已加M的目标成功”必须并存，防止测试掩盖缺少生产controller的事实。未修改schema支持的普通HTML维持实际既有行为，不新增全局HTML拒绝。
