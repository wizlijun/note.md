# 表格与空语言真实 Producer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。按两个 numeric Task 执行；每 Task fresh implementer，root 派一名 fresh task reviewer 同时给出 spec compliance 与 quality 两项结论，单一产品 writer。用户已授权持续实现至统一发版，root 自审后直接推进。

**Goal:** 修复合法 header-only GFM 表和未指定代码语言的真实生产/回读，并让 core、Kit、Rich 菜单与键盘共享一份表格命令。

**Architecture:** Task 1 明确修订 table 与 code language 的 grammar 默认合同。Task 2 提取 schema-local GFM 命令并接现有 consumers；既有 Source 严格保真检查继续消费真实 Transaction。列宽迁移、共享 file/native history 和完整两端交付仍有独立后续闭包。

**Tech Stack:** 现有 TypeScript、ProseMirror、markdown-it、Vitest、tsup、Svelte、Vite/Kit；不安装或升级依赖。

**Spec:** `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.1、§12.4/I7、§12.9、§13.3；本文件将本次局部交付合同完整展开。正式 dispatch 携带 root 核验过的 spec 与本文件。

2026-10-13。**状态：root 正式采纳，执行前脚本自审。** 前置结构来源完整计划已受理，产品 core `7ec5d621f195f7a389774dd355aa240420972c8c`，host `440e7302a545fd24b0a7173cc2d9c092a8434dbc`；host 证据闭包文档提交 `fc541441`。正式 Task BASE 以 own 中冻结文件为准，包含本计划文档提交，不能复用研究旧 SHA。

候选来自已逐项回读校验的 structural-source canonical archive `d897e5eafbc3b02c98a1c8bf6953dd8a01643ffefb3f4b9933b0aa1b22f762c5`；11 份选取资料的路径/bytes/SHA 在 own `research-reference/extraction.json`。旧 workspace 已归档清理，不再访问。真实 Rich fixture已证明可挂载，须在本 own 重写路径/结果目录后用于新操作验收。

## Global Constraints

- 直接两仓 main；不新建 branch/worktree，单一产品 writer。root 在每 Task 起点冻结实际 BASE。保留原 7 git-status untracked 项、3 stash 与 force-pull backup；不用 reset/clean/add-all/amend，不读 .env、不安装升级依赖，不改 node_modules 源码。未知产物不得泛删。本计划不启动发布，完整两端与统一发版仍随后必做。
- UTF-16 为 source/PM offset，UTF-8 Buffer 比较原字节。未触碰 root、blank（仅前置明确 baseline-conversion 例外）、protected、envelope 与 BOM/CRLF/loneCR/尾换行保持原字节；不全篇 serializer+diff、不放宽 doc.eq 全 attrs/marks、不改变根完整 map。
- 前置“legacy parser/async/serializer 与 schema 默认不变”约束继续约束其他行为；**root 采纳 R1/R2，授权 header-only grammar 与 language 默认/显式 text 序列化两个窄例外**。Source-only whitespace/fence 属前置 structural Task2，不重新设计或回退。不将 language/colwidth 归一化，不改原 14 语料 bytes。
- 前置结构模块 type-only import SourceSession、内部 UnsupportedSourceStructure/生产 helper、source-fidelity 已知错误映射与生产 callback 边界保持；不 root-export 私有 serializer/测试 API。R1 pre-serializer/最终 edit 两处 protected guard 独立保留；不覆盖定义后凭 eq 放行。
- N2 快路无需新全 ledger；exact prototype+tr.docs 局部归纳/最终一次全 root 核查保留。仅前置结构慢路可 O(S×N) replay，性能成本如实报告。不为表格 commands 改 ledger/稳定 mark 路径分类或引入逐 step whole-doc eq。
- 每 Task RED→GREEN→tsc/full/build→precise dist stage/core commit→host committed dist 同步→host focused/full/purity/Vite/Kit/browser→host commit→installed committed corpus/DTS 审计→fresh 独立 reviewer 的 spec+quality 双结论。失败停止依赖下游；fix 用新 commit，runtime 未变的 format/type-only 修订按证据决定重测，不重复已通过同输入 suite。
- 原始 stdout/stderr、subprocess command/argv/cwd/time/exit 与工具 initial/session/final 完整 tool.json 都在 own workspace。每命令唯一 label，不覆盖 RED/失败；短回 output 不能替代完整 tool metadata；caller 对非预期 nonzero 必须 throw。
- 源码与所有 tracked dist（包含新引用的 ignored hashed DTS）同次 core commit，**index gzip≤81920 bytes**；“83KB”不是批准新 cap。stage 精确路径；obsolete 仅 --no-renames frozen BASE→committed HEAD 的单层 hashed .d.ts 删除，旧 hash 必须核 baseline committed blob；未知文件保留报告。host 只能从 git show CORE_HEAD:dist/... 安装 committed bytes，审计 actual realpath/exports/imports/DTS closure/58-or-actual tracked dist/14 corpus 两仓 committed+working SHA。
- 正式 own workspace 唯一 `/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers`，执行前 root 用 sdd-workspace 解析；必要资料从已核 canonical archive 挑选+SHA provenance。不读/运行旧或兄弟 workspace。下文六脚本执行时在 own 生成，不能 source 本轮 structural 文件。browser/cache 使用 S1/S2 子目录；原脚本结果名保留，不覆盖。
- 两 Task 每次 fresh implementer、fresh 独立 spec+quality reviewer；writer 不 spawn helper/reviewer。root 不派额外 plan-review。每 Task 独立审查/fix 关闭后，root 才在整计划尾运行**一次 svelte-check+前后 fingerprints**（若最终真实fix改变检查输入，必须另名必要复验并保留旧证据），再做**唯一 Astra/xhigh whole-range final**；至多一次统一 final fix+一次 scoped re-review。所有 Minors/⚠️/Rulings 保存，归档 raw evidence 后仅清 own workspace。
- 旧 single-block browser 只是 regression gate；新 UI gate 仅可声称已真正接线并操作的 consumer。浏览器不冒称 macOS WKWebView/native/IME；master 全语料三次 Rich/Source 切换零 diff、一字一 hunk、局部 reparse、history/native/IME、E1–E4 最终统一发版仍必做。
- 菜单容器 `.menu-panel`、可点击行 `.menu-row`，hover 来自全局 `.menu-panel .menu-row:hover`；不新增局部 hover 背景。新增对齐菜单实机 hover，HMR 未生效重启任务自己的 dev 再验；持久 toolbar/侧栏不改 accent hover。
- 已知 stage incident 的教训：检查失败后继续 commit、隐瞒原始错误、随后 amend 均禁止。root 准备精确 stage allowlist；pre-stage/index 范围核对、diff --check、commit 任何失败立即停止下游，保留完整原失败与新修复 commit。

## 已采纳 Rulings（逐字记 own ledger）

| Ruling | What | Why | Wrong cost / rollback boundary |
| --- | --- | --- | --- |
| R1 header-only | table `table_header_row table_row+`→`table_header_row table_row*`，不改 row/cell cardinality | GFM separator 后可以没有 body；当前 createAndFill 会补零 cell body，非 parser 显式补行 | 旧“无 body 非法”断言失效，TableMap/selection/删除末 body 都须新 positive。只回退本提交会使已产生 header-only 再次不合法，故先关闭真实 parser/producer 回归再受理 |
| R2 missing language | schema default、DOM缺省、无 info/缩进 parser语言统一为缺省 `''`；显式 text 输出 `text` | 真实 InputRule/Enter/Kit/Rich 本来产 `''`，旧 parser 写 text、serializer又抹 text，无法 strict eq | legacy/async/default doc JSON 与 explicit-text raw 会变；旧已挂载 state 不批改，旧 text 节点仍为 text。不是 language 全清空/小写/alias 归一；所有调用者回归前不受理 |
| R3 public commands | root与既有 `/commands` 导出窄 `gfmTableCommand`，Kit/Rich入口委托 | 消除各自造表与不同 alignment，保留 schema-local/state probe/filter | 行列 selection 或一事件双dispatch回归会影响实际输入；未通过真实 consumer gate 不受理，不以测试 duplicate algorithm冒充 |
| R4 width边界 | cells保留 colwidth，full equality；layout/native后续必做 | Markdown不表达width；本次 grammar/commands可独立修复 | 有width的 Source结构操作仍可能具体拒绝，不能宣称完整体验；未来真实resize/history闭包须完成，不能把拒绝永久产品化 |

Ruling: SDK采用B撤回从未有产物的样式子路径；仅删exports[./style]并从sideEffects过滤./dist/style.css，README说明宿主CSS来源，host安装同一committed manifest且原子替换不改硬链接 — BASE到最终产品均无CSS源/产物且实际宿主自供样式，提炼926行宿主CSS会扩大API及视觉范围，空CSS不能兑现契约 — 潜在外部消费者未知，升级后该错误路径将明确ERR_PACKAGE_PATH_NOT_EXPORTED；主入口和全部真实出口必须actualimport及双UI回归，发行说明记录撤回错误出口，未来独立SDK样式需另定义真实所有权。

## Root preflight 配对表（正式自审）

| 计划要求 | 固定提交证据 / 正式受理前 root 行动 |
| --- | --- |
| schema/table grammar | core schema.ts:503–504；markdown.ts tr/th/td token handlers；确认没有待删除的补 body helper |
| language真实 producers | core setup.ts:178–183、enter-handler.ts:210–226 已产 `''`；host Kit commands.ts:108、RichEditor.svelte:617、rich-actions.ts:128、slash-items.ts:163 已产 `''` |
| language消费者 | core code-block-view.ts:104 picker `text`，157空值仅显示text，575/802严格mermaid，580/814 registry exact id，733按显式选择写newLang；host adapters/renderer-registry.ts 的PLUGINS仅dot/graphviz，diagram-render.ts按三种language class选择 |
| source接口 | 固定 core公开 `createSourceSession(source:string,schema?:Schema)`、`applySourceBlockTransaction(base,tr)`；内部 `serializeSourceRootMarkdown(doc:PmNode)`。structural Task2及finalfix已受理，公开接口不变；fence事实内部WeakMap绑定实际SourceRoot，不引用未验新接口 |
| host身份/gate | Kit withBlockIdentitySchema/cdrBlockId与opt-in createSourceFidelity仍只接较窄文本编辑；本任务不把canonical source doc transaction直接套入带ID view当完整file适配，不放宽eq |
| full门槛 | root冻结实际BASE、测试路径/数量、gzip、dist数量、14manifest SHA、依赖resolve路径/实际版本；script静态检查不等于运行通过，81920 cap不预升 |
| 安装/保留 | root记录两仓status/stashes/backup、installed realpath、stage owner、未知文件，核scripts不会覆盖dirty产品/source；正式冻结 own 中 core-task-base/host-task-base |
| reviews顺序 | Task1独立spec+quality/fix→Task2独立spec+quality/fix→root唯一Svelte/fingerprint→唯一Astra/xhigh wholefinal；无额外plan-review |

## 冻结目标与最小依赖

依据 master `docs/superpowers/specs/2026-10-12-project-share-review-merge-design.md` §12.1、§12.4/I7、§12.9、§13.3：共享编辑器需完整表格/快捷键/撤销体验，13 类语料 Rich/Source 三轮零 diff，一字段落变更恰一 hunk，桌面保留全部编辑功能。本两任务只是修复真实 producer 产生的不可回读文档，不能冒称两端 Source/history/IME/native 或 master 已完成。

前置结构慢路、source-only容器/fence/mark和closed-facts合同均已提交并受理。此计划只用公开 createSourceSession/applySourceBlockTransaction，不引用内部 Ledger/Claim，不改稳定N2权限分类。

结论：**header-only 不需要先迁移 colwidth schema**。`table.content` 改为 `table_header_row table_row*` 即可取消 createAndFill 的强制 body；原 parser 没有一段可删除的显式“补 body”代码。真实 `tr_open/th_open/td_open` handler 保持，禁止另造空 row、尾 paragraph 或关掉 TableMap 校验来凑合法。cell attrs 中 `alignment/colspan/rowspan/colwidth` 全部保留，full `.eq()` 不加忽略项。

两任务的成功标准：

1. header-only 解析恰一 header，TableMap 高度 1、无 missing cell；空语言 `''` 被真实生产/解析/序列化保留，显式 `text` 也保持自身含义。
2. 同一共享命令驱动 core 与 Kit 的加行、末格 Tab、Mod+Enter、整列对齐、加删行列和表格插入；所有 GFM 新行每列 alignment 继承 header。真实菜单/快捷键安装入口消费 committed core dist，而非测试自产节点。

列宽迁移是**后续共享 file/history 接线的必要交付**，不是这两个任务假装解决的内容。当前非 null colwidth 仍完整留在 PM attrs，Source 无表达时严格拒绝；该拒绝不能成为最终产品完成的借口。不能为本计划引入第二历史栈、sidecar、CDR server wire、宽度忽略列表或一个无法接入 shared file 的孤立 LayoutStep。

## 固定源码中的实际问题与消费者

| 位置（固定提交） | 事实 | 本计划处理 |
| --- | --- | --- |
| core `src/schema.ts` table / cells | table 需要至少一个 body，body 允许零 cell；cells 有 4 个真实 attrs | 仅放宽 body 数量；保留 cells attrs |
| core `src/markdown.ts` `MorayaMarkdownParser` | thead/tr 已正确映射 header；createAndFill 受 schema 强补零 cell body | 不新造 parser fallback，测试真实 token→PM |
| core `src/markdown.ts` parserTokens | 无 info fence、indented code 都给 `language:'text'` | 将“未指定语言”解析成 `''` |
| core `src/schema.ts` code_block | default / DOM 缺省是 text | default / DOM 缺省改 `''`；显式 data-language=text 不改 |
| core serializer code_block | `text` 输出为空 fence info | 输出实际 language，显式 text 必须输出 text；source-only 回调也使用实际值 |
| core `src/plugins/enter-handler.ts:124` | Mod+Enter 调 upstream addRowAfter，随后另发 selection transaction | 换共享加行 command，一笔事务包含结构与落点 |
| core `src/setup.ts:420` | Tab 目前只处理 list，否则插 4 空格 | table 内先共享导航；table 外保持 list/空格行为 |
| core `src/commands.ts` | exported insertTable 在 schema 已有 table 时返回 false；toggleCodeBlock 用 defaultSchema | 表格入口委托共享 schema-local command；代码块改用 state.schema 并保留空语言 |
| host `src/editor-kit-v2/commands.ts` | 私有 tableCommand 复制造表/加删逻辑，新格全 left | 移到 core 后委托，保留 execute/canExecute 的准入语义 |
| host `src/editor-kit-v2/main.ts:244` | Tab 已路由 table.next/previous-cell | 委托后继续；一个事件不能被 core 再执行一遍 |
| host `src/components/RichEditor.svelte:646` | Cmd+Shift+T 独立造 3×3 表 | 调共享 insert command |
| host `src/lib/context-menu/block-helpers.ts` | insertTable 独立造表，slash/menu 共用此 helper | 同一 shared insert，测试真实 action / slash execute |
| host `src/lib/slash-menu/slash-items.ts` | 禁用 core commands 的注释因旧 defaultSchema 问题而写 | 精确更新为“本次 schema-local 表格命令可用”，不顺手迁移其他命令 |
| host `plugins-src/memory/src/lib/CollaborativeDocumentSpike.svelte` | 有真实行列按钮，调用 Kit EditorCommand | 按钮仍委托 Kit；若增加 alignment 按钮只传本地命令，不改协议 |
| core setup / host Rich bridge / Kit rich | 都启用真实 columnResizing；未装 tableEditing | 维持安装/原生跨格文本选择，记录后续宽度依赖 |
| host governed-history | 每个 docChanged tr 的 steps 被 shadow 成 BlockEditStep(before,after) | 本片不造 layout step；后续必须修改此消费者，不能假设 empty-map 自动工作 |

### Task 1: 合法 schema、真实空语言与可兑现 SDK 契约

**生产改动：** core `package.json` / `README.md` 的悬空样式契约修正，以及 `src/schema.ts`、`src/markdown.ts`、`src/commands.ts` 的 code-block 分支，必要的注释/DTS；新增 `src/__tests__/table-schema-producer.spec.ts`、`src/__tests__/code-language-producer.spec.ts`。host 新增 `src/editor-kit-v2/code-language-producer.test.ts`，使用 installed core 与真实 `executeEditorCommand`，不改成一份测试 schema。

- [ ] T1.1 先写 RED：真实 parser 解析 `| A | B |\n| --- | ---: |` 得到 table.childCount=1（当前失败）；`TableMap.get(table).height===1`、width=2、problems=null，递归 `doc.check()`。表头 2 cells attrs 必须分别为 `{alignment:'left',colspan:1,rowspan:1,colwidth:null}`、`{alignment:'right',colspan:1,rowspan:1,colwidth:null}`。
- [ ] T1.2 改 `table_row+` 为 `table_row*`。不要同步将 row/cell 改成 `+`，这是无关 tightening；不得借 tableEditing/fixTables 自动修补。测试普通两行、header-only、一列表、非表 pipe paragraph、嵌套 quote 中合法 table；serializer 再 parse full eq，两个真实 parser 入口 `parseMarkdown` 与 `createSourceSession` 都覆盖（二者自己的 blank layout 分别对照）。
- [ ] T1.3 空语言 RED 使用真实 commands、InputRule、Enter handler，不能先 `schema.nodes.code_block.create({language:'text'})` 伪造成功输入。实际新建 code 的语言为 `''`：Kit `{kind:'code-block'}`、Rich slash/code action、core toggleCodeBlock、裸 ``` 后 Enter、setup 的 fence input rule。`parseMarkdown('```\nx\n```')`、source capture、DOM `<pre>` 都必须还原 `''`；` ```text ` 必须还原 `'text'`；`TypeScript` 大小写照常保留。空 code、content 末 LF 交给受理 structural source 的 fence content 合同，不能在这次 trim content。
- [ ] T1.4 最小一致修复：code schema default 与 DOM 缺省 `''`；parserTokens `code_block` 给 `''`，`fence` 用 `token.info.trim()`；普通 serializer 去掉 `lang==='text' ? '' : lang`；source-only code renderer 用实际 attrs.language，不做 `''↔text` 归一化。core toggleCodeBlock 只在本命令取 `state.schema.nodes.code_block/paragraph`，设置 `{language:''}`。显式选“Plain Text”的 language picker 仍写 text，因而 fence 输出 `text`；显示标签可复用现有 `findLanguageLabel`，不要光标进入/挂载就写 language。
- [ ] T1.5 全 attrs/marks 比较保持原样。旧 parse 使用 text 表示缺省的断言要逐项更新，记录这是实际 grammar 语义修复；不是在 `.eq()`、Source gate 或 identity stripping 中偷偷抹 attrs。旧已挂载 EditorState 不强行批量改写；重新创建 session 时用新 parser，尚存显式 text 的旧节点序列化为 text，含义不丢。
- [ ] T1.6 跑 source、legacy roundtrip、CodeBlock DOM/高亮/renderer、footnote/quote/list 相关回归。build、提交源码+全部相应 committed dist 后，host 安装该 commit，运行实际 Kit 空语言命令和菜单 action；核心导出、DTS、installed hash 全闭合才记 Task1 GREEN。

**精确 raw 期望：** `serializeMarkdown(parseMarkdown('```\nx\n```')) === '```\nx\n```'`；text 对照为 `'```text\nx\n```'`。缩进 code 可经 legacy serializer 转成无 info fenced code，但 `language===''`；Source 未触碰缩进代码保留原始四空格字节。`serializeMarkdown(parseMarkdown(headerOnly))` 为 `'| A | B |\n| --- | ---: |\n'`；source-session 无修改应保持输入原样（没有末 LF），不能混淆两个 API 的 raw 合同。

**真正 Source producer 验证：**在受理 structural-source commit 后，以 `createSourceSession('x')` 的 doc 建 EditorState，实际 command 转 code，再把 captured Transaction 传公开 `applySourceBlockTransaction`；期望 ok、`session.source==='```\nx\n```'`、`session.doc.eq(tr.doc)`、language 严格 `''`。把同一个 case 通过 Kit actual execute 捕获 transaction 重跑。未接线 Kit UI 的完整 Source gate 不以该 unit test 冒充；并保留 metadata/storedMarks/unknown-step 既有拒绝门槛。


#### Task 1 接口、最小 RED 与独立闭包

**Consumes:** committed `createSchema`、`parseMarkdown(markdown,schema?)`、`parseMarkdownAsync(markdown,schema?)`、`serializeMarkdown(doc)`、上述两个公开 Source API，以及真实 `toggleCodeBlock:Command`。沿用受理后的 source-only fence content 合同，不能调用拟议的私有新 helper。

**Produces:** 同名 API 下 header-only合法、无语言为 `''`、显式text保留。没有新公开API；Task2消费受理后的schema/serializer。core测试文件创建于 `src/__tests__/table-schema-producer.spec.ts` / `code-language-producer.spec.ts`，host创建 `src/editor-kit-v2/code-language-producer.test.ts`；已有 source-structure spec 中 header-only 旧非法负例必须改新positive，同时保留其他真正非法doc负例。

以下最小行为 RED 放入两个新 spec（table一段放table spec，code一段放code spec），不是测试重写 parser；首轮仅跑它们记录实际 assertion failure，不能把 import error当 RED：

```ts
import { expect, it } from 'vitest'
import { TableMap } from 'prosemirror-tables'
import { parseMarkdown, parseMarkdownAsync, serializeMarkdown } from '../markdown'
import { createSourceSession } from '../source-fidelity'

it('parses a header-only table without synthesizing an invalid body', () => {
  const raw = '| A | B |\n| --- | ---: |'
  const doc = parseMarkdown(raw)
  const table = doc.firstChild!
  expect(table.type.name).toBe('table')
  expect(table.childCount).toBe(1)
  expect(TableMap.get(table).height).toBe(1)
  expect(TableMap.get(table).width).toBe(2)
  expect(TableMap.get(table).problems).toBeNull()
  expect(() => doc.check()).not.toThrow()
  expect(table.firstChild!.child(1).attrs).toEqual({
    alignment: 'right', colspan: 1, rowspan: 1, colwidth: null,
  })
  expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true)
  const capture = createSourceSession(raw, doc.type.schema)
  expect(capture.ok).toBe(true)
  if (!capture.ok) throw new Error(capture.reason)
  expect(capture.session.source).toBe(raw)
  expect(capture.session.doc.firstChild!.childCount).toBe(1)
})
it.each(['', 'text', 'TypeScript', 'mermaid', 'dot', 'graphviz'])(
  'retains exact fence language %j in sync/async/source', async language => {
    const raw = '```' + language + '\nx\n```'
    const doc = parseMarkdown(raw)
    expect(doc.firstChild!.attrs.language).toBe(language)
    expect(serializeMarkdown(doc)).toBe(raw)
    expect((await parseMarkdownAsync(raw)).eq(doc)).toBe(true)
    const capture = createSourceSession(raw, doc.type.schema)
    expect(capture.ok).toBe(true)
    if (!capture.ok) throw new Error(capture.reason)
    expect(capture.session.doc.firstChild!.attrs.language).toBe(language)
    expect(capture.session.source).toBe(raw)
  },
)
```

异步测试另用 `const large = "p\n\n".repeat(20_000) + "```text\nx\n```"`（超过已核 `ASYNC_PARSE_THRESHOLD=50_000`）断言最后节点language=text、async/sync full eq，使真实异步分支也覆盖；root冻结时复核常量，不把小输入 Promise fallback当异步分支证明。DOM测试通过 `DOMParser.fromSchema(schema).parse(container)`，container依次 `<pre><code>x</code></pre>` 与 `<pre data-language="text"><code>x</code></pre>`，精确期待 `''` 与text，NodeView挂载/更新不dispatch改language；用户点击Plain Text才写text。

- [ ] T1.7 在 schema默认/DOM、parserTokens、legacy/source serializer和toggleCodeBlock分支作 T1.4 所述最少编辑。`toggleCodeBlock` 采用 `const {code_block:cb,paragraph}=state.schema.nodes; if(!cb||!paragraph)return false; return setBlockType(state.selection.$from.parent.type===cb?paragraph:cb, state.selection.$from.parent.type===cb?undefined:{language:''})(state,dispatch)`。先理解原格式后展开写清，不顺改其他defaultSchema命令。
- [ ] T1.8 实际 `createEnterHandlerPlugin():Plugin`、`buildInputRules(schema,tier1,enableInlineMarks=true):Plugin`（tier1取真实setup配套，不用伪InputRule）、code picker、Kit execute、Rich code action和slash action各记录before/tr/after；bare fence、explicittext、大小写与Mermaid/Graphviz exact routing按前表锁定：Mermaid使用 `graph TD; A-->B`，dot/graphviz使用 `digraph G { A -> B }`；render/edit来回不写language，显式picker选择才写。对现有回归明确更新默认变化，不批量snapshot覆盖。header-only原非法case改正例，`doc.check/TableMap/full source eq` 三项同时证明。
- [ ] T1.9 运行下文共同 G1–G10（S1前缀），core精确源码+dist新commit→committed blob安装→host真实 consumer focused/full/purity/Vite/Kit/browser→host新commit→installed全审计→fresh spec与quality/fix。Task1实际UI仅code创建/切换/显示+header-only渲染已接消费者，表格新命令仍属Task2。
- [ ] T1.11 SDK出口修正：实际全部exports检查在当前BASE因`./style -> dist/style.css`缺失为RED（原失败已归档，本Task用own标签验证）；删除`exports['./style']`，保留sideEffects字段并仅过滤`'./dist/style.css'`，其余manifest字段不变。README删除错误style导入，明确core仅供逻辑，宿主须提供`.moraya-editor`/ProseMirror节点视觉样式，桌面/Kit现有来源是host `src/styles/editor-base.css` / Kit CSS，不复制926行或造空CSS。正式committed manifest作为唯一安装元数据来源；host-sync前核差异仅此授权，以同目录临时文件rename原子替换实际独立installed manifest，不能原地写pnpm硬链接或core源路径。最终所有声明目标存在、所有JS出口actualimport；style实际返回ERR_PACKAGE_PATH_NOT_EXPORTED。此项共享本Task已有全量/bundle/UI门槛，不另重复套件。

- [ ] T1.10 root保存Task1独立受理记录、实际core/host SHA、全部warnings/minors与fix证据，之后才freeze Task2 BASE；不在此重复svelte-check或派whole-range。

### Task 2: 一份 GFM 表格 commands，两个实际消费面

**生产改动：**core 新建 `src/table-commands.ts`（内部模块），从现有 `src/commands.ts`/`src/index.ts` 导出下面窄 API；`src/plugins/enter-handler.ts`、`src/setup.ts` 接线。host 改 `src/editor-kit-v2/commands.ts`、`contract.ts`、`RichEditor.svelte` 的表格分支、`context-menu/block-helpers.ts`；alignment 在现有 popup action/菜单与 Kit 表格 controls 增加三项，不另起 toolbar。新增 core `table-commands-producer.spec.ts`、host `table-producer.test.ts` / `table-menu-producer.test.ts`。

Task2要新增的代码接口（Task1不依赖未来API）：

```ts
import type { Command } from 'prosemirror-state'
export type GfmTableAction =
  | { kind: 'insert' }
  | { kind: 'add-row' | 'delete-row' | 'add-column' | 'delete-column'
      | 'next-cell' | 'previous-cell' }
  | { kind: 'align-column'; alignment: 'left' | 'center' | 'right' }
export function gfmTableCommand(action: GfmTableAction): Command
```

`@moraya/core/commands` 和 root export 暴露同一函数/type；不新增 package export 路径，不使 host import core src。已存在 `insertTable:Command` 委托 `gfmTableCommand({kind:'insert'})`，不要破坏旧 subpath 名称。Kit 增加 `{kind:'table.align-column';alignment:'left'|'center'|'right'}` 为本地 EditorCommand union，`commandFor` 用明确 case 映射，不用宽字符串 cast。这是 UI 命令，不是 OperationBatch/CDR wire 扩展。

对齐入口的精确接线：`src/lib/context-menu/rich-actions.ts:createRichActions` 的 `canRun`/`run` 增加 `table-align-left/center/right`，调用同一 shared command probe/dispatch；`src/lib/context-menu/menu-model.ts:MenuContext` 增加可选 `table`，仅为 true 时显示“列对齐”及三项；`EditorContextMenu.svelte` 用 `actions.canRun('table-align-center')` 填该位。`source-actions.ts:canRun` 对这三个 ID明确 false，避免当前其默认 true 导致源码菜单显示不可执行项。`menu-model` 标签沿现有 i18n Messages 增加相应 key，复用现有全局 submenu 样式。Kit实际消费者 `plugins-src/memory/src/lib/CollaborativeDocumentSpike.svelte:tableCommands` 加三项 typed EditorCommand，不在插件复制编辑算法。Task2文件清单相应包括这些菜单/类型/i18n窄接线；菜单测试真实 `createRichActions(view).run('table-align-center')`，slash测试取得现有 table item后调用其 execute，不能单独调 shared helper冒充 action。

算法在现有 Kit tableCommand 基础上最小移动：

1. 总是从 `state.schema` 取类型。从 `$from` 找当前 table/row/cell，context 返回位置、行列索引；原表和所有 untouched row/cell attrs/marks/content 原样保留。面向矩形 GFM，检查各行列数一致、colspan/rowspan=1 后操作。异形或 merged 表明确返回 false，无 dispatch；不把 merged attrs 重置 1。
2. 私有 fresh-cell helper 接受 `(header:boolean, alignment)`，新格的 colspan/rowspan=1、colwidth=null；new row 对 header cells 逐列取 alignment，而非拿当前行长度/默认 left。新列全列 left，既有列保持原 attrs。alignment 值仅 left/center/right，非法值不悄悄变 left。
3. `add-row` 在当前行后加一个 body，光标进入新行同列；末格 `next-cell` 用同一个 fresh-row helper，只追加一个 body，并进入第一格。普通 next/previous 只 selection transaction，doc 对象保持；第一格 previous 返回 false。删除 header 用 surviving first body 升格，保留对应 cell attrs/content/marks；最后一行/最后一列仍 false，不偷删整表。
4. `align-column` 遍历 header+body 的同列，每格 `tr.setNodeMarkup(cellPos,undefined,{...cell.attrs,alignment},cell.marks)`；一笔 dispatch，不能只改选中 body 导致保存后恢复旧值。未更改属性无需 doc step。非 null colwidth 必须仍为原值；此时 source prepare 是否能表达由原 full-eq gate 判定，不能额外清空宽度使成功。
5. 造表仍为 3×3（header+2 body）；pipe-header Enter 原有“header+1 body，进入首 body 格”体验保持，其新格 attrs 满足同合同即可，不扩成任意 shape builder API。当前 core `insertTable` 的不可用行为修复为真正插表，不能保留另一份 no-op。
6. Mod+Enter 调 `add-row` 并使用该事务内 selection；去掉旧 addRowAfter 和第二次 selection dispatch。core keymap 在 table 内先 `next-cell/previous-cell`，否则沿旧 list/4 spaces。Kit main 先处理成功后返回 true，测试 event 只执行一次。表内原 Plain Enter/Shift+Enter 路径不改变；末行退出依赖受理 capture-layout 的 terminal empty 合同。
7. 结构操作可暂沿当前 Kit 整表 replacement（最少改动且 structural-source 可真实见到该事务）；不在此凭相同位置引入 stable tableId。后续 width identity 接线要显式消费这些已知动作与确切 column index，并替换必要 seam。这里无新 shadow source/history，不在不明确身份的整表 replace 后猜目标。

#### Task2 的 RED→GREEN 验证矩阵

| 实际 producer（必须执行） | 输入与期望 attrs / raw / selection |
| --- | --- |
| shared `add-row` / Kit execute `table.add-row` | header-only `| A | B | C |\n| --- | :---: | ---: |`；新 body alignments=[left,center,right]，每格 spans=1、colwidth=null；selected row=1 且列不变 |
| actual Kit Tab handler / actual core setup Tab | header-only 最后一格按 Tab：仅一个 body，alignment 同上，落首格；一次事件一笔 doc transaction；中间格 Tab 不改 doc |
| `createEnterHandlerPlugin` 的真实 handleKeyDown | header 或任意 body 按 ctrl/meta+Enter：新行同上；拦截 dispatch 收到一笔结构+selection tr；isComposing 不执行 |
| shared align-column / Kit align | header+两 body，中列 right→center：三格都 center，其他列完整 toJSON 不变；raw separator 对应列 `:---:`；保存再 parse full eq |
| shared/Kit delete-row | 两行表删 body→header-only；删 header→body promote；单 header 再删 false 且对象/selection/history 不动 |
| shared/Kit add/delete-column | header-only 和普通表加列/删列，TableMap 无 holes；新增全列 left；最后一列 false |
| actual desktop context action / slash / Cmd+Shift+T；Kit table action | 3×3、完整 attrs、光标可输入；宿主真实 schema 不是 defaultSchema；命令后在 header/right column 输入，保存回读仍正确 |
| core Plain Enter / Shift+Enter | header-only 有 Tail 时 Enter 跳 Tail不改 doc；EOF Enter 创建可表达空段；Shift+Enter 保留既有 hardbreak 语义，不能伪造 body |
| 现有 PM history 与 governed history | addRow→alignment→undo/redo；精确恢复 PM attrs、selection、raw（raw 原字节恢复属于后续 history 接线，当前只可测已接入者） |
| attrs 负例 | 现有 cells colwidth=[180] 的整列对齐不得变 null；rowspan/colspan异形操作 false；任何实际 colwidth source transaction 仍不能绕 full equality |

source raw 正例固定用 EOF 无末 LF fixture：

```text
before = "| A | B | C |\n| --- | :---: | ---: |"
addRow after = "| A | B | C |\n| --- | :---: | ---: |\n|  |  |  |"
align rightmost center after = "| A | B | C |\n| --- | :---: | :---: |\n|  |  |  |"
```

通过 actual source API 断言上面完整字符串；Table serializer 自身仍有末 LF（其 API 另测）。夹持 fixture 使用 `BOM + CRLF paragraph + 原 gap + table + 原 gap + 未动 HTML/footnote`，只 dirty table body允许生成 LF，kept EOL/gap/protected raw 保留每字节，不做全文 EOL normalization。比较最终 source capture doc 与 actual tr.doc 的全部 attrs/marks，不先删 colwidth/language。受理结构 API 对已列正常 producer 失败时必须修根因并重新规划，不能把“拒绝成功”写成 Task2 通过。

可直接落实到 Vitest 的 actual command helper（测试导入的 new API 在实现前应先有 RED；parse/table shape 测试先行，避免把 import error 当行为 RED）：

```ts
import { expect } from 'vitest'
import type { Node as PmNode } from 'prosemirror-model'
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { parseMarkdown } from '../markdown'
import { createSourceSession, applySourceBlockTransaction } from '../source-fidelity'
import { gfmTableCommand } from '../table-commands'

function run(state: EditorState, command: Command) {
  let tr: Transaction | undefined
  const before = state
  expect(command(state)).toBe(true)
  expect(state).toBe(before) // probe 不 dispatch、不更 selection
  expect(command(state, next => { tr = next })).toBe(true)
  expect(tr).toBeDefined()
  tr!.doc.check()
  return { tr: tr!, state: state.apply(tr!) }
}
function selectCell(doc: PmNode, row: number, col: number): TextSelection {
  let target: number | undefined
  doc.descendants((node, pos) => {
    if (target !== undefined || node.type.name !== 'table') return false
    let at = pos + 1
    for (let i = 0; i < row; i++) at += node.child(i).nodeSize
    at += 1
    for (let i = 0; i < col; i++) at += node.child(row).child(i).nodeSize
    target = at + 1
    return false
  })
  if (target === undefined) throw new Error('fixture table missing')
  return TextSelection.near(doc.resolve(target)) as TextSelection
}
const before = "| A | B | C |\n| --- | :---: | ---: |"
const after = before + "\n|  |  |  |"
const schema = parseMarkdown("x").type.schema
const baseResult = createSourceSession(before, schema)
if (!baseResult.ok) throw new Error(baseResult.reason)
let state = EditorState.create({doc: baseResult.session.doc})
state = state.apply(state.tr.setSelection(selectCell(state.doc, 0, 2)))
const {tr} = run(state, gfmTableCommand({kind:'add-row'}))
const prepared = applySourceBlockTransaction(baseResult.session, tr)
expect(prepared.ok).toBe(true)
if (!prepared.ok) throw new Error(prepared.reason)
expect(prepared.session.source).toBe(after)
expect(prepared.session.doc.eq(tr.doc)).toBe(true)
```

另一个 host helper必须真实 `EditorView` + `executeEditorCommand(view,command)`，在 `dispatchTransaction` 中记录实际 Transaction 并走真实 apply/filter 插件；不要用 fake view.dispatch 窃取然后不更新 view 状态。`canExecute` false、过滤器拒绝后的 execute=false、无 selection/history 副作用都保留。actual key event 用 `view.someProp('handleKeyDown', handler => handler(view,event))`，让真实 plugin 优先级生效，不能单测底层 PM addRowAfter 冒充快捷键。



#### Task 2 精确文件责任与消费者测试

**Create core:** `src/table-commands.ts`、`src/__tests__/table-commands-producer.spec.ts`。**Modify core:** `src/commands.ts`、`src/index.ts`、`src/setup.ts`、`src/plugins/enter-handler.ts`。**Modify host:** `src/editor-kit-v2/commands.ts`（替换私有tableCommand，保留仍被lists使用的children）、`src/editor-kit-v2/contract.ts`、`src/components/RichEditor.svelte`、`src/lib/context-menu/block-helpers.ts`、`rich-actions.ts`、`source-actions.ts`、`menu-model.ts`、`EditorContextMenu.svelte`、`src/lib/slash-menu/slash-items.ts`（仅过时注释）、`src/lib/i18n/en.ts`、`zh.ts`、`ja.ts`、`de.ts`、`plugins-src/memory/src/lib/CollaborativeDocumentSpike.svelte`。**Create host:** `src/editor-kit-v2/table-producer.test.ts`、`src/lib/context-menu/table-menu-producer.test.ts`。既有 `main.ts` 的Tab先处理可沿用；只有真实事件测试失败证明需要改优先级时才窄改。

**Consumes:** Task1受理schema与公开Source API、ProseMirror Command、host `executeEditorCommand(view,command):boolean` / `canExecuteEditorCommand(view,command):boolean`、`createRichActions(view).run(id):void|Promise<void>` / `.canRun(id):boolean`、`getMenuModel(ctx):MenuGroup[]`。**Produces:** 上文 `GfmTableAction`、`gfmTableCommand(action):Command`，既有 `insertTable:Command` 委托；Kit union增加typed alignment分支；MenuContext新增 `table?:boolean` 是本任务改动，不能误称现有字段。

i18n新增四个key，所有Messages语言文件齐全：`ctxmenu.tableColumnAlignment`（列对齐 / Column alignment / 列の配置 / Spaltenausrichtung）、`ctxmenu.tableAlignLeft`（左对齐 / Align left / 左揃え / Linksbündig）、`ctxmenu.tableAlignCenter`（居中 / Align center / 中央揃え / Zentriert）、`ctxmenu.tableAlignRight`（右对齐 / Align right / 右揃え / Rechtsbündig）。Kit现有中文按钮追加左/中/右三项typed命令，不新造国际化系统。rich-actions用三个显式ID映射三种alignment，source-actions三种ID明确false；menu-model仅ctx.table时显示submenu。EditorContextMenu的getMenuModel参数增加 `table: actions.canRun('table-align-center')`。保持readOnly/image早返回。

下面 host helper直接驱动EditorView及filter；new API缺失阶段先针对现有Kit错误alignment写行为RED，勿让new import error成为唯一RED。new core command开发后的core RED可用已存在真实Kit失败证据配对，但最终core自身每个分支必须有断言。

```ts
import { expect } from 'vitest'
import type { Node as PmNode } from 'prosemirror-model'
import { EditorView } from 'prosemirror-view'
import { TextSelection, EditorState, Plugin, type Transaction } from 'prosemirror-state'
import { createSchema, parseMarkdown } from '@moraya/core'
import { executeEditorCommand, canExecuteEditorCommand } from './commands'
const schema = createSchema({mediaResolver: {
  loadLocalImage: async p => p, loadLocalMedia: async p => p,
  loadRemoteMedia: async p => p,
}})
function makeView(raw: string, plugins: Plugin[] = []) {
  const transactions: Transaction[] = []
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const view = new EditorView(mount, {
    state: EditorState.create({doc: parseMarkdown(raw, schema), plugins}),
    dispatchTransaction(tr) {
      transactions.push(tr)
      view.updateState(view.state.applyTransaction(tr).state)
    },
  })
  return {view, transactions, destroy() {view.destroy(); mount.remove()}}
}
// 用前文完整selectCell helper定位，不复制生产table builder/algorithm。
const fixture = makeView('| A | B | C |\n| --- | :---: | ---: |')
try {
  const {view, transactions} = fixture
  view.dispatch(view.state.tr.setSelection(selectCell(view.state.doc, 0, 2)))
  const before = view.state
  expect(canExecuteEditorCommand(view, {kind:'table.add-row'})).toBe(true)
  expect(view.state).toBe(before)
  transactions.length = 0
  expect(executeEditorCommand(view, {kind:'table.add-row'})).toBe(true)
  expect(transactions.filter(tr=>tr.docChanged)).toHaveLength(1)
  const body = view.state.doc.firstChild!.child(1)
  expect(Array.from({length:body.childCount},(_,i)=>body.child(i).attrs.alignment))
    .toEqual(['left','center','right'])
  expect(view.state.selection.$from.index(1)).toBe(1)
  expect(view.state.selection.$from.index(2)).toBe(2)
} finally {fixture.destroy()}
```

host菜单测试真实 `await createRichActions(view).run('table-align-center')` 后核header+body整列attrs；slash从 `src/lib/slash-menu/slash-items.ts` 导入已核真实 `getSlashItems():SlashItem[]`，找id为table项并`.execute(view)`，不可测试helper冒充slash。RichEditor真正Cmd+Shift+T必须以已挂载组件键盘事件验证；Kit真实Tab须走 `view.someProp('handleKeyDown',fn=>fn(view,event))` 或UI，不能仅调用shared命令。测试不会触发剪贴板/外发。

- [ ] T2.1 对Kit add-row/末格Tab/Mod+Enter错误alignment、core insertTable no-op以及Rich插入独立路径写RED，记录精确失败输出。Source输入用Task1已受理header-only，而非手工造非法doc。
- [ ] T2.2 按七条算法把真实Kit逻辑搬到core；矩形/span校验、preserve attrs/marks、header alignment继承与一笔selection一起落地。加shared对齐命令后core/Kit tests GREEN。
- [ ] T2.3 窄接core/setup/Enter、Kit union/commandFor、Rich shortcut/helper/menu/i18n与Kit按钮；只有不再消费的tableContext私有逻辑删除，lists仍用children则保留。
- [ ] T2.4 跑上文全producer矩阵；with filterTransaction拒绝时execute=false/state/selection/history不变；未改对齐可无doc step但probe/execute合同明确，避免Kit返回true而无tr的不一致。用明确schema缺节点/非表/merged表拒绝断言，last-row/last-column拒绝，不丢内容。
- [ ] T2.5 Source actual command端按严格raw/full eq验证，已有cdrBlockId opt-in窄gate保留边界。桌面Rich与Kit消费者仅承诺实际安装表格动作；不擅自接未受理file/history适配来使测试过。
- [ ] T2.6 跑共同G1–G10（S2前缀），完成core与host精确提交、installed14fixtures/全部dist/DTS/import/exports审计及fresh spec+quality/fix。实际UI检插表→输入→加删行列→三种对齐→Tab/Mod+Enter→现有undo/redo→自然跨格选择，截图/动作日志标浏览器或native实际平台。
- [ ] T2.7 root记录独立受理。两个Task fix都闭合后才执行尾部唯一final流程，任何尚未接线native/Source raw history单列pending，不勾master完成。

## 列宽后续交付的硬合同（本两任务不伪造实现）

header-only 的 schema/producer 改动在 colwidth仍存在时可以独立落地。删除 colwidth attrs、忽略 full-eq、把值清为 null都不属于最小依赖。若后续实际 consumer证明 header-only 必须先移宽度，暂停并返回依赖升级：**候选 A（推荐）**在共享 file/history计划中先完成下面 layout seam，再受理该 consumer；**候选 B**保留 attrs与现有 resize并明确该 Source gate未完成，继续当前 producer切片。没有把 session展示承诺偷偷改成 Markdown宽度持久化的候选。

后续共享 file/session 作为唯一 source authority，schema/table doc对比仍完整；width state放共享 layout plugin，同一 PM/native/governed历史承载一个已知、可逆 empty-map LayoutStep，source-only resize严格返回 unchanged/revision不变、raw字节不变。不另造栈，不发 CDR width operation，不造 sidecar，不把位置/同文内容当 table identity。

必须在未来正式计划同一提交闭包解决：

- **真实 resize seam**：mouseup提交一次，mousemove仅preview；TableView/colgroup和第二次拖其他列读同一 layout。仅替换渲染不够，upstream updateColumnWidth仍会 setNodeMarkup。选小范围共享 adapter或公开 read/commit-width seam，不能伪造 EditorState/拦截任意 setNodeMarkup。
- **稳定会话 table identity**：两张同文表不同 ID；前插文字用 mapping跟踪；真实删除/未知 replace失效；已知 row/column动作显式保留/更新 ID和列 index。Kit 一个 cdrBlockId 内可含多个自然 table，不能混用业务 span ID。删除与撤销恢复表格布局需要同一事件里的 before/after registry delta。
- **单历史栈**：resize用closeHistory手势边界；layout step apply返回原doc、map空、invert交换before/after、首版merge=null。withGovernedHistory须保留已知 layout step，不能吞成空 BlockEditStep。source历史/native菜单/快捷键/beforeinput共用同一入口。
- **混合 CAS原子性**：source revision/bytes、PM doc、layout before widths、table identity与history event共同prepare，全部成功才安装；任何一个stale/失效整笔拒绝，不消费部分undo、不把布局先写plugin。混合结构+layout逆序需按真实步骤恢复目标后验证，不能在目标尚未恢复时错误拒绝或错用邻表。
- **Source narrow gate**：只对已知layout step且before/after doc严格全等允许no-source-change；unknown empty-map step仍拒绝。混合 tr只剔除这些已证明no-doc steps，其余原步按受理 Source API原样验证。不能给 ledger添一个任意 bypass。
- **真实必过序列**：resize→undo→redo；resizeA→typing→resizeB交错撤销；header-only拖宽；再拖另一列；add/delete column、删表undo；same-text两表；表前插字；remote/whole replace失效；mixed content/layout任一CAS冲突整组不动；保存/重开宽度自适应且 Source从未因resize变化。源文件写盘、恢复、Share afterMarkdown/outbox继续既有合同。

原研究已证旧 upstream resize通过doc attrs进入原生 history，单纯 metadata-only会丢现有 undo；新的 LayoutStep与 mixed CAS尚未实施/验收。上述后续全部完成并且 sharedfile/native两端接线通过后，才可声称“保留桌面优秀表格体验且 Source保真”，不能仅凭本两任务 parser/commands GREEN下结论。

## 共同执行门槛（每 Task 独立）

root 在 own 生成下节六脚本并新建保持为空的 `empty-env/`（Vite build使用现有vite.config但envDir指此处，不读根.env），保存实际 `core-task-base` / `host-task-base`（40位受理SHA）、`stage-allowlist-core` / `stage-allowlist-host`（每行一个授权源码/测试精确路径；core dist由artifact manifest补充），并把每次冻结文件另存 S1/S2 证据。不得用本研究 SHA 把还在执行的structural Task2当已完成。stage allowlist是root根据该Task明确文件清单冻结的输入，不是writer任意放宽的“允许所有diff”。

- [ ] G1 冻结：确认core现有tsup.config的 `clean:true` 不会清除未登记文件：build前列出dist所有working文件与tracked差，遇未知文件先停下核归属并保留，不直接让build泛删；通过recorder运行baseline，核实际两仓HEAD/status、schema/Source导出与路径存在；保存原7 untracked/3stash/backup名称与SHA。记录node/实际依赖versions/Playwright已安装路径、gzip当前值、现存warning基线，不预填通过数或预升cap。两仓无别的product writer；已有ignored/nottracked `tasks/todo.md` 与 `tasks/lessons.md`不stage。
- [ ] G2 RED：Task1 core两个新spec；Task2先真实Kit现有入口失败，然后core shared行为RED。RED label以`-RED`结尾，caller仅在预期退出1且保存输出证明是对应assertion时允许继续；import/missing-tool异常不能作为RED。
- [ ] G3 GREEN：实现后对应focused、Source/roundtrip回归、core tsc/full/build。每命令单独run、记录tool结果；任一非预期nonzero停止后续。没有新变化不重跑已通过suite。
- [ ] G4 core artifact/stage：运行core-artifacts（ARTIFACT_MANIFEST指向own `S1-artifacts.json`或S2）；精确stage授权源码/tests，再core-stage-dist；`git diff --cached --check`、name-status与allowlist全部通过后`git commit -m 'fix: preserve header-only tables and explicit code language'`（Task2用`feat: share GFM table commands across editor consumers`）。每个fix新commit，不能amend。保存commit及源码+全部dist归属。
- [ ] G5 committed install：host-sync先读全committed blobs、核built匹配、核精确旧hashed DTS与被删target内容仍是baseline bytes，再写；失败前不得半装。只安装已commit dist；不用package sync:core的working copy/清缓存脚本、不安装依赖。
- [ ] G6 host验证：对应focused、完整Vitest、purity、Vite、Kit build check、旧single-block browser regression，再实际已接线consumer UI gate。own browser/cache S1或S2；用installed core实际resolve/hash，浏览器console错误与screenshots保存。Task1不声称Task2菜单完成，Task2不声称native/raw history未接能力完成。
- [ ] G7 host commit：同样allowlist核精确stage与diff --check后新commit，只提交真实consumer/test/i18n改变；安装目录不stage。Task1若host只有新增验证，也提交该真实消费者测试，不伪造产品改动。
- [ ] G8 审计：两仓都已commit后运行installed-corpus-audit（S2必须 `env EXPECT_TABLE_API=1 bash .../installed-corpus-audit.sh`），核58-or-actual全部dist、JS相对import与map、DTSclosure、exports含wildcards、14 corpus manifest与每个bytes/SHA在两仓HEAD和working、actualinstalled realpath与包入口。所有未知安装文件保留报告，若被运行时exports/import指向且不属于committed集合则失败。
- [ ] G9 fresh task review（spec + quality）：root派一名独立reviewer只读实际提交范围与完整raw evidence。每个find记录严重度/证据/修复或明确Ruling；需要fix则原Task writer新commit、按实际变化运行相关及必要下游gate，再独立复核直到关闭；不能让writer自评代审。
- [ ] G10 root记录受理/限制与两仓SHA。Task1受理后freeze Task2；Task2受理后才整计划唯一final。任一Task状态未闭合不推进下一任务/最终受理。

共同实际命令（均由下面recorder调用；core/host cwd分开，不把这个列表复制成遇错仍执行的长shell）：

```sh
# core Task1 focused
./node_modules/.bin/vitest run src/__tests__/table-schema-producer.spec.ts src/__tests__/code-language-producer.spec.ts
# core Task2 focused
./node_modules/.bin/vitest run src/__tests__/table-commands-producer.spec.ts src/__tests__/table-schema-producer.spec.ts src/__tests__/code-language-producer.spec.ts
# 每 Task core source/legacy重点回归：这些路径在研究SHA均实际存在
./node_modules/.bin/vitest run src/__tests__/source-structure.spec.ts src/__tests__/source-structure-commands.spec.ts src/__tests__/source-layout.spec.ts src/__tests__/source-terminal-hardbreak.spec.ts src/__tests__/source-block-fidelity.spec.ts src/__tests__/roundtrip.spec.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsup
# core cwd；S2改manifest名称
# env ARTIFACT_MANIFEST=OWN/S1-artifacts.json bash OWN/core-artifacts.sh
# env ARTIFACT_MANIFEST=OWN/S1-artifacts.json bash OWN/core-stage-dist.sh
# host cwd（core commit已完成）：bash OWN/host-sync.sh
# host Task1 focused
./node_modules/.bin/vitest run src/editor-kit-v2/code-language-producer.test.ts src/editor-kit-v2/commands.test.ts
# host Task2 focused
./node_modules/.bin/vitest run src/editor-kit-v2/table-producer.test.ts src/lib/context-menu/table-menu-producer.test.ts src/editor-kit-v2/commands.test.ts src/editor-kit-v2/governed-history.test.ts
./node_modules/.bin/vitest run
node scripts/check-share-merge-purity.mjs
node --input-type=module -e 'import { build } from "vite"; await build({envDir:"/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers/empty-env"})'
node scripts/check-editor-kit-build.mjs
# host cwd browser regression；S2用S2
 env PLAYWRIGHT_MODULE=/Users/bruce/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs SOURCE_FIDELITY_OUTPUT_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers/browser/S1 SOURCE_FIDELITY_CACHE_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers/vite-cache/S1 node scripts/check-source-fidelity-browser.mjs
# host commit之后：bash OWN/installed-corpus-audit.sh
```

`OWN`仅为上面注释中的可读缩写；实际runner完整argv使用下一节绝对路径。前置已新增并提交`source-structure-commands.spec.ts`，正式重点回归必须包括此文件；host旧header-only删除负例位于`src/editor-kit-v2/source-structure-commands.test.ts`，改为新positive并保留真正非法负例。所有路径缺失都停下来修冻结记录，不写空spec。

真实UI gate由root选择当前已能挂载的Rich/Kit实际consumer并记录平台与开法：Task1 code slash/shortcut/Enter、语言picker和header-only显示；Task2 Rich popup/slash/shortcut与Kit控件/Tab/Mod+Enter。若当前surface只能browser fixture承载，则挂载真实组件/真实command adapter并记录该边界；旧single-block browser脚本不新增这些证明。无法挂载真实Rich时该项明确阻塞本任务UI受理，不能用shared unit test替代，亦不擅自发布或启动native发版。

## 自含执行脚本（root自审后的实际正文）

以下是own实际脚本；run.py的`--cwd`精确用`core|host`，raw在`evidence/<label>/`。所有工具initial/session/final另外exclusive保存`evidence/<label>.tool.json`。`--expect-exit 1`仅允许预定义RED：子进程真实1保存到result.json，runner接受预期后返回0；caller仍必须检查工具exit0、读取RED stdout确认实际assertion，然后才继续。任一非预期退出即停止依赖，不隐藏失败。

`ARTIFACT_MANIFEST=own/S1-artifacts.json`等唯一文件由artifacts写入，stage读取同一冻结snapshot并核HEAD/BASE/package/dist SHA和source allowlist，不重复importaudit。Task2设置EXPECT_TABLE_API=1，Task1只要求当前实际三个Source API，不能复制未来prepareFileSourceEdits断言。baseline唯一style knownGap明确alltargets=false；最终artifacts/installed不允许该缺项。

调用者使用POSIX单引号escape（内部单引号替换为`'\''`），不可JSON.stringify作为shellquote。每命令通过tools.exec_command运行run.py，所有session用write_stdin收齐，保存完整返回对象；save失败或工具非零throw。RED仍从result.json核真实退出与stdout错误种类，不把missing import/工具错误冒充RED。唯一label不可覆盖。

### run.py

```python
#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time

OWN = pathlib.Path('/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers')
REPOS = {'core': '/Users/bruce/git/moraya-core', 'host': '/Users/bruce/git/mdeditor'}
p = argparse.ArgumentParser()
p.add_argument('--cwd', required=True, choices=REPOS)
p.add_argument('--expect-exit', type=int, default=0)
p.add_argument('label')
p.add_argument('command', nargs=argparse.REMAINDER)
a = p.parse_args()
argv = a.command[1:] if a.command[:1] == ['--'] else a.command
if not argv:
    p.error('command required')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', a.label):
    p.error('unsafe label')
log = OWN / 'evidence' / a.label
log.mkdir(parents=True, exist_ok=False)
meta = {'argv': argv, 'cwd': REPOS[a.cwd], 'started': time.time(), 'expected_exit': a.expect_exit}
with (log / 'command.json').open('x') as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
env = dict(os.environ, GATE_LOG_DIR=str(log))
code = 127
with (log / 'stdout').open('xb') as out, (log / 'stderr').open('xb') as err:
    try:
        code = subprocess.run(argv, cwd=REPOS[a.cwd], env=env, stdout=out, stderr=err).returncode
    except OSError as e:
        err.write((repr(e) + '\n').encode())
        meta['launch_error'] = repr(e)
meta.update(ended=time.time(), exit_code=code)
with (log / 'result.json').open('x') as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
    f.write('\n')
print(json.dumps({'label': a.label, 'exit_code': code, 'expected_exit': a.expect_exit, 'evidence': str(log)}))
if code != a.expect_exit:
    raise SystemExit(code if code > 0 else 1)
```

### baseline.sh

```sh
#!/bin/sh
set -eu
exec node /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers/audit.mjs baseline
```

### core-artifacts.sh

```sh
#!/bin/sh
set -eu
exec node /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers/audit.mjs artifacts
```

### core-stage-dist.sh

```sh
#!/bin/sh
set -eu
exec node /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers/audit.mjs stage
```

### host-sync.sh

```sh
#!/bin/sh
set -eu
exec node /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers/audit.mjs sync
```

### installed-corpus-audit.sh

```sh
#!/bin/sh
set -eu
exec node /Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers/audit.mjs installed
```

### audit.mjs

```js
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {gzipSync} from 'node:zlib'

const own='/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-13-shared-editor-table-producers'
const core='/Users/bruce/git/moraya-core',host='/Users/bruce/git/mdeditor'
const fixed={core:'7ec5d621f195f7a389774dd355aa240420972c8c',host:'440e7302a545fd24b0a7173cc2d9c092a8434dbc'}
const hashed=/^dist\/[^/]+-[A-Za-z0-9_-]+\.d\.ts$/
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
const log=process.env.GATE_LOG_DIR
assert.ok(log && path.resolve(log).startsWith(own+'/evidence/'),'run via own/run.py to retain raw evidence')
let serial=0
function command(cwd,argv){
  const label='subprocess-'+String(++serial).padStart(4,'0'),started=Date.now()
  const result=spawnSync(argv[0],argv.slice(1),{cwd,maxBuffer:64*1024*1024})
  fs.writeFileSync(path.join(log,label+'.stdout'),result.stdout??Buffer.alloc(0),{flag:'wx'})
  fs.writeFileSync(path.join(log,label+'.stderr'),result.stderr??Buffer.alloc(0),{flag:'wx'})
  fs.writeFileSync(path.join(log,label+'.json'),JSON.stringify({argv,cwd,started,ended:Date.now(),exit_code:result.status,signal:result.signal,error:result.error?.message},null,2)+'\n',{flag:'wx'})
  assert.equal(result.error,undefined,'subprocess launch failed '+argv.join(' '))
  assert.equal(result.status,0,'subprocess failed '+argv.join(' '))
  return result.stdout
}
const git=(repo,...argv)=>command(repo,['git',...argv])
const head=repo=>git(repo,'rev-parse','HEAD').toString().trim()
const blob=(repo,sha,file)=>git(repo,'show',sha+':'+file)
const split=b=>b.toString().split('\0').filter(Boolean)
function base(name){
  const sha=fs.readFileSync(path.join(own,name+'-task-base'),'utf8').trim()
  assert.match(sha,/^[a-f0-9]{40}$/)
  return sha
}
function committedFiles(sha){
  return split(git(core,'ls-tree','-r','--name-only','-z',sha,'--','dist'))
}
function regular(root,file){
  assert.ok(file.startsWith('dist/')&&!file.split('/').some(p=>p==='..'),'unsafe artifact path '+file)
  const full=path.join(root,file),st=fs.lstatSync(full)
  assert.ok(st.isFile()&&!st.isSymbolicLink(),'non-regular artifact '+full)
  assert.equal(fs.realpathSync(full),full,'artifact path has symlink '+full)
  return st
}
function diskFiles(root){
  const result=[]
  function walk(dir){
    for(const item of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
      const file=dir+'/'+item.name
      if(item.isDirectory()&&!item.isSymbolicLink())walk(file)
      else result.push(file)
    }
  }
  walk('dist')
  return result.sort()
}
function styleDelta(baseBytes,headBytes){
  const before=JSON.parse(baseBytes),after=JSON.parse(headBytes),expected=structuredClone(before)
  if(Object.hasOwn(before.exports,'./style')){
    assert.equal(before.exports['./style'],'./dist/style.css')
    delete expected.exports['./style']
    assert.ok(Array.isArray(expected.sideEffects))
    assert.equal(expected.sideEffects.filter(x=>x==='./dist/style.css').length,1)
    expected.sideEffects=expected.sideEffects.filter(x=>x!=='./dist/style.css')
  }else{
    assert.ok(!before.sideEffects?.includes('./dist/style.css'),'baseline has dangling sideEffects')
  }
  assert.deepEqual(after,expected,'manifest changed beyond authorized style deletions')
  assert.ok(!Object.hasOwn(after.exports,'./style'))
  assert.ok(!after.sideEffects?.includes('./dist/style.css'))
  return after
}
function exportsOf(pkg,files){
  const result=[]
  function walk(key,value,conditions=[]){
    if(typeof value!=='string'){
      assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'unsupported export value')
      for(const [condition,child] of Object.entries(value))walk(key,child,[...conditions,condition])
      return
    }
    assert.ok(value.startsWith('./dist/'),'non-dist export '+value)
    const parts=value.slice(2).split('*');assert.ok(parts.length<=2,'multiple wildcard')
    const targets=parts.length===1?[parts[0]]:files.filter(f=>f.startsWith(parts[0])&&f.endsWith(parts[1]))
    assert.ok(targets.length,'empty export '+key)
    for(const target of targets){
      assert.ok(files.includes(target),'missing declared export '+target)
      const type=conditions.includes('types')?'types':target.endsWith('.js')?'javascript':'asset'
      assert.ok(type==='types'?target.endsWith('.d.ts'):type==='javascript'?target.endsWith('.js'):true,'export type mismatch '+target)
      const middle=parts.length===1?'':target.slice(parts[0].length,parts[1]?-parts[1].length:undefined)
      const specifier=key==='.'?'@moraya/core':'@moraya/core'+key.slice(1).replace('*',middle)
      result.push({key,conditions,target,type,specifier})
    }
  }
  for(const [key,value]of Object.entries(pkg.exports))walk(key,value)
  for(const [key,value]of [['main',pkg.main],['types',pkg.types]]){
    assert.ok(typeof value==='string'&&files.includes(value.replace(/^\.\//,'')),'missing '+key+' target')
    assert.ok(value.endsWith(key==='types'?'.d.ts':'.js'),'invalid '+key+' type')
  }
  assert.ok(!Object.hasOwn(pkg.exports,'./style'),'style export must be withdrawn before gate')
  assert.ok(!pkg.sideEffects?.includes('./dist/style.css'),'dangling style sideEffects')
  return result
}
function closure(pkg,files,read,readSource){
  const exports=exportsOf(pkg,files),relativeImports=[],declarationReferences=[],maps=[],mapSources=[],reachable=new Set()
  const references=new Map()
  for(const file of files){
    assert.ok(/\.(?:js|d\.ts|js\.map|d\.ts\.map)$/.test(file),'unknown artifact preserved; explicit scope required '+file)
    if(file.endsWith('.map')){
      const map=JSON.parse(read(file).toString())
      assert.equal(map.version,3,'map version '+file)
      assert.ok(Array.isArray(map.sources),'map sources '+file)
      assert.ok(Array.isArray(map.sourcesContent),'map requires embedded source content '+file)
      assert.equal(map.sourcesContent.length,map.sources.length,'map source count '+file)
      assert.ok(!map.sourceRoot||!map.sourceRoot.includes('://'),'unsupported map sourceRoot '+file)
      for(let i=0;i<map.sources.length;i++){
        assert.equal(typeof map.sourcesContent[i],'string','map missing embedded source '+file)
        const source=map.sources[i].startsWith('file:')?fileURLToPath(map.sources[i]):map.sources[i]
        const absolute=path.resolve(core,path.dirname(file),map.sourceRoot??'',source)
        const relative=path.relative(core,absolute)
        assert.ok(relative.startsWith('src/')||relative.startsWith('node_modules/'),'map source escapes known source ownership '+file+' -> '+source)
        const kind=relative.startsWith('src/')?'core-source':'installed-dependency'
        const expected=kind==='core-source'?readSource(relative):fs.readFileSync(absolute)
        const embedded=Buffer.from(map.sourcesContent[i],'utf8')
        assert.ok(embedded.equals(expected),'embedded source mismatch '+file+' -> '+relative)
        mapSources.push({map:file,source:map.sources[i],normalized:relative,kind,sha256:hash(expected),bytes:expected.length})
      }
      if(map.file)assert.equal(path.posix.normalize(path.posix.join(path.posix.dirname(file),map.file)),file.slice(0,-4),'map file target '+file)
      continue
    }
    const text=read(file).toString(),dts=file.endsWith('.d.ts'),edges=[]
    const relative=new Set()
    for(const m of text.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](\.[^'"]+)['"]/g))relative.add(m[1])
    for(const m of text.matchAll(/\/\/\/\s*<reference\s+path=['"](\.[^'"]+)['"]/g))relative.add(m[1])
    for(const spec of relative){
      const targetBase=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec))
      assert.ok(targetBase.startsWith('dist/'),'dependency escapes dist '+file+' -> '+spec)
      const options=dts?[targetBase.replace(/\.js$/,'.d.ts'),targetBase+'.d.ts',targetBase+'/index.d.ts']:[targetBase]
      const target=options.find(p=>files.includes(p))
      assert.ok(target,'missing dependency '+file+' -> '+spec)
      if(dts)assert.ok(target.endsWith('.d.ts'),'declaration points outside DTS '+target)
      edges.push(target)
      ;(dts?declarationReferences:relativeImports).push({from:file,specifier:spec,to:target})
    }
    references.set(file,edges)
    for(const m of text.matchAll(/sourceMappingURL=([^\s*]+)/g)){
      if(m[1].startsWith('data:'))throw new Error('inline map requires explicit audit: '+file)
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1]))
      assert.ok(files.includes(target)&&target.endsWith('.map'),'missing map '+file+' -> '+target)
      maps.push({from:file,to:target})
    }
    if(!dts)assert.ok(maps.some(m=>m.from===file),'JS lacks declared map '+file)
  }
  function visit(file){if(reachable.has(file))return;reachable.add(file);for(const next of references.get(file)??[])visit(next)}
  for(const item of exports)visit(item.target)
  const gzip=gzipSync(read('dist/index.js')).length
  assert.ok(gzip<=81920,'index gzip hard cap '+gzip)
  return {exports,relativeImports,declarationReferences,maps,mapSources,reachable:[...reachable].sort(),gzip}
}
async function actualImports(audit,root,installed){
  const namespaces=new Map(),imports=[]
  for(const item of audit.exports.filter(e=>e.type==='javascript')){
    const specifier=installed?item.specifier:pathToFileURL(path.join(root,item.target)).href
    if(namespaces.has(specifier))continue
    const resolved=fs.realpathSync(installed?fileURLToPath(import.meta.resolve(specifier)):path.join(root,item.target))
    assert.equal(resolved,fs.realpathSync(path.join(root,item.target)),'actual export resolution '+specifier)
    const namespace=await import(specifier)
    namespaces.set(specifier,namespace)
    imports.push({specifier,target:item.target,resolved,exportNames:Object.keys(namespace).sort()})
  }
  if(installed){
    const api=namespaces.get('@moraya/core')
    for(const name of ['createSourceSession','applySourceTextTransaction','applySourceBlockTransaction'])assert.equal(typeof api?.[name],'function',name)
    if(process.env.EXPECT_TABLE_API==='1')for(const spec of ['@moraya/core','@moraya/core/commands'])assert.equal(typeof namespaces.get(spec)?.gfmTableCommand,'function',spec+' gfmTableCommand')
    let styleError
    try{await import('@moraya/core/style')}catch(error){styleError=error}
    assert.equal(styleError?.code,'ERR_PACKAGE_PATH_NOT_EXPORTED','style actual import must reject as withdrawn')
  }
  return imports
}
function corpus(coreCommit,hostCommit){
  const dirs={core:'src/__tests__/fixtures/source-fidelity',host:'src/share-editor/__fixtures__/corpus/source-fidelity'}
  const expected=blob(core,base('core'),dirs.core+'/manifest.json'),fixtures=JSON.parse(expected)
  assert.equal(fixtures.length,14);assert.equal(new Set(fixtures.map(f=>f.name)).size,14)
  const report=[]
  for(const [name,repo,commit]of [['core',core,coreCommit],['host',host,hostCommit]]){
    const baseline=base(name),dir=dirs[name]
    for(const sha of new Set([baseline,commit]))assert.ok(blob(repo,sha,dir+'/manifest.json').equals(expected),'corpus manifest changed '+name+' '+sha)
    assert.ok(fs.readFileSync(path.join(repo,dir,'manifest.json')).equals(expected),'working corpus manifest '+name)
    for(const f of fixtures){
      assert.match(f.name,/^[A-Za-z0-9-]+$/);assert.match(f.sha256,/^[a-f0-9]{64}$/)
      const file=dir+'/'+f.name+'.md',item={repo:name,file,baseline,head:commit,sha256:f.sha256,bytes:f.bytes}
      for(const [version,bytes]of [['BASE',blob(repo,baseline,file)],['HEAD',blob(repo,commit,file)],['working',fs.readFileSync(path.join(repo,file))]]){
        assert.equal(hash(bytes),f.sha256,name+' '+version+' '+file);assert.equal(bytes.length,f.bytes);item[version]=hash(bytes)
      }
      report.push(item)
    }
  }
  return {manifestSha256:hash(expected),fixtures:report}
}
function installedRoot(){
  const root=fs.realpathSync(path.join(host,'node_modules/@moraya/core'))
  assert.ok(root!==fs.realpathSync(core)&&!root.startsWith(fs.realpathSync(core)+'/'),'installed package aliases core source; no writes allowed')
  assert.equal(fs.realpathSync(path.join(root,'dist')),path.join(root,'dist'),'installed dist symlink; preserve and stop')
  return root
}
async function artifacts(){
  assert.equal(process.cwd(),core,'artifacts/stage cwd must be core')
  const tracked=split(git(core,'ls-files','-z','--','dist')),files=diskFiles(core),pkg=JSON.parse(fs.readFileSync(path.join(core,'package.json')))
  const audit=closure(pkg,files,f=>fs.readFileSync(path.join(core,f)),f=>fs.readFileSync(path.join(core,f)))
  const dtsNew=files.filter(f=>!tracked.includes(f))
  for(const file of dtsNew){assert.match(file,hashed,'unknown artifact preserved '+file);assert.ok(audit.reachable.includes(file),'unreachable new DTS '+file)}
  const deleted=tracked.filter(f=>!files.includes(f))
  for(const file of deleted){assert.match(file,hashed);blob(core,base('core'),file)}
  const changed=split(git(core,'diff','--no-renames','--name-only','-z','--','dist'))
  const hashes=Object.fromEntries(files.map(f=>{regular(core,f);return[f,hash(fs.readFileSync(path.join(core,f)))]}))
  const imports=await actualImports(audit,core,false)
  return {...audit,imports,files,hashes,head:head(core),base:base('core'),manifestSha256:hash(fs.readFileSync(path.join(core,'package.json'))),trackedCount:tracked.length,dtsNew,deleted,changed,unknown:[],allDeclaredExportTargetsPresent:true}
}
async function installedAudit(){
  assert.equal(process.cwd(),host,'installed audit cwd must be host')
  const coreCommit=head(core),hostCommit=head(host),root=installedRoot(),files=committedFiles(coreCommit),bytes=new Map(files.map(f=>[f,blob(core,coreCommit,f)]))
  const manifest=blob(core,coreCommit,'package.json')
  const pkg=styleDelta(blob(core,base('core'),'package.json'),manifest)
  assert.ok(fs.readFileSync(path.join(core,'package.json')).equals(manifest),'uncommitted core manifest')
  assert.ok(fs.readFileSync(path.join(root,'package.json')).equals(manifest),'installed manifest full committed bytes mismatch')
  const unknown=diskFiles(root).filter(f=>!files.includes(f))
  for(const file of files){regular(core,file);regular(root,file);assert.ok(fs.readFileSync(path.join(core,file)).equals(bytes.get(file)),'uncommitted dist '+file);assert.ok(fs.readFileSync(path.join(root,file)).equals(bytes.get(file)),'installed bytes '+file)}
  const audit=closure(pkg,files,f=>bytes.get(f),f=>blob(core,coreCommit,f)),imports=await actualImports(audit,root,true)
  assert.equal(fs.realpathSync(fileURLToPath(import.meta.resolve('@moraya/core'))),fs.realpathSync(path.join(root,'dist/index.js')))
  return {...audit,imports,actualJsExportsImported:imports.length,coreCommit,hostCommit,root,distCount:files.length,hashes:Object.fromEntries(files.map(f=>[f,hash(bytes.get(f))])),manifestSha256:hash(manifest),corpus:corpus(coreCommit,hostCommit),unknownPreserved:unknown,allDeclaredExportTargetsPresent:true,closureScope:'all declared exports, committed JS/DTS dependencies and maps; nonreachable unknown installed paths preserved'}
}
function atomicWrite(target,bytes){
  const tmp=target+'.table-gate-'+process.pid+'-'+crypto.randomBytes(8).toString('hex')
  fs.writeFileSync(tmp,bytes,{flag:'wx',mode:0o644})
  fs.renameSync(tmp,target)
}
async function sync(){
  assert.equal(process.cwd(),host,'sync cwd must be host')
  const baseline=base('core'),coreCommit=head(core),hostCommit=head(host),root=installedRoot(),manifest=blob(core,coreCommit,'package.json')
  const baselineManifest=blob(core,baseline,'package.json'),pkg=styleDelta(baselineManifest,manifest)
  const actualManifest=fs.readFileSync(path.join(root,'package.json'))
  assert.ok(actualManifest.equals(baselineManifest)||actualManifest.equals(manifest),'installed manifest differs from TaskBASE and committed HEAD')
  assert.ok(fs.readFileSync(path.join(core,'package.json')).equals(manifest),'uncommitted manifest')
  const files=committedFiles(coreCommit),bytes=new Map(files.map(f=>[f,blob(core,coreCommit,f)])),audit=closure(pkg,files,f=>bytes.get(f),f=>blob(core,coreCommit,f))
  const deleted=split(git(core,'diff','--no-renames','--diff-filter=D','--name-only','-z',baseline,coreCommit,'--','dist'))
  const old=new Map()
  for(const file of deleted){assert.match(file,hashed,'only obsolete hash DTS deletion allowed');old.set(file,blob(core,baseline,file))}
  const unknown=diskFiles(root).filter(f=>!files.includes(f)&&!deleted.includes(f))
  const manifestStat=fs.lstatSync(path.join(root,'package.json')),sourceManifestStat=fs.statSync(path.join(core,'package.json'))
  assert.ok(manifestStat.isFile()&&!manifestStat.isSymbolicLink(),'installed manifest not regular')
  assert.equal(fs.realpathSync(path.join(root,'package.json')),path.join(root,'package.json'))
  const inodeBefore={installed:{dev:manifestStat.dev,ino:manifestStat.ino,nlink:manifestStat.nlink},core:{dev:sourceManifestStat.dev,ino:sourceManifestStat.ino,nlink:sourceManifestStat.nlink}}
  const fileIdentity=[]
  for(const file of files){
    const source=regular(core,file)
    assert.ok(fs.readFileSync(path.join(core,file)).equals(bytes.get(file)),'uncommitted build '+file)
    const target=path.join(root,file)
    if(fs.existsSync(target)){
      const st=regular(root,file)
      fileIdentity.push({file,dev:st.dev,ino:st.ino,nlink:st.nlink,sourceDev:source.dev,sourceIno:source.ino})
    }else{
      let dir=path.dirname(target)
      while(!fs.existsSync(dir))dir=path.dirname(dir)
      assert.equal(fs.realpathSync(dir),dir,'destination ancestor symlink')
    }
  }
  for(const [file,expected]of old)if(fs.existsSync(path.join(root,file))){regular(root,file);assert.ok(fs.readFileSync(path.join(root,file)).equals(expected),'obsolete DTS differs from BASE; preserve '+file)}
  const corpusReport=corpus(coreCommit,hostCommit)
  // Every validation above precedes the first mutation. All replacements break store hard links.
  for(const [file,content]of bytes){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});atomicWrite(target,content)}
  atomicWrite(path.join(root,'package.json'),manifest)
  for(const file of deleted)if(fs.existsSync(path.join(root,file)))fs.unlinkSync(path.join(root,file))
  assert.ok(fs.readFileSync(path.join(core,'package.json')).equals(manifest),'core source manifest changed')
  for(const [file,content]of bytes)assert.ok(fs.readFileSync(path.join(core,file)).equals(content),'core source dist changed '+file)
  const installed=await installedAudit()
  return {coreCommit,baseline,root,files:files.length,deleted,unknownPreserved:unknown,inodeBefore,fileIdentity,manifestInodeAfter:fs.statSync(path.join(root,'package.json')).ino,corpusReport,preflight:audit,installed}
}
async function baseline(){
  const report={fixed,versions:{},repos:{}}
  for(const [name,repo]of [['core',core],['host',host]]){
    assert.equal(head(repo),base(name),'TaskBASE is not current HEAD '+name)
    assert.equal(git(repo,'branch','--show-current').toString().trim(),'main')
    report.repos[name]={base:base(name),status:git(repo,'status','--short').toString(),stashes:git(repo,'stash','list').toString(),refs:git(repo,'for-each-ref','--format=%(refname) %(objectname)','refs/heads','refs/tags').toString()}
  }
  for(const argv of [['node','--version'],['python3','--version'],['git','--version']])report.versions[argv[0]]=command(host,argv).toString().trim()
  const root=installedRoot(),require=createRequire(path.join(core,'package.json'))
  report.installed={root,manifestSha256:hash(fs.readFileSync(path.join(root,'package.json'))),entrySha256:hash(fs.readFileSync(path.join(root,'dist/index.js'))),manifestStat:fs.statSync(path.join(root,'package.json'))}
  report.dependencies=Object.fromEntries(['markdown-it','prosemirror-markdown','markdown-it-footnote','markdown-it-deflist','markdown-it-texmath','markdown-it-mark'].map(name=>[name,require.resolve(name)]))
  report.corpus=corpus(base('core'),base('host'))
  const files=diskFiles(core),tracked=committedFiles(base('core'))
  const unknown=files.filter(f=>!tracked.includes(f))
  assert.deepEqual(unknown,[],'unknown core dist preserved; resolve ownership before clean:true build')
  const pkg=JSON.parse(blob(core,base('core'),'package.json')),check=structuredClone(pkg)
  report.knownMissingTargets=[]
  if(pkg.exports['./style']==='./dist/style.css'&&!files.includes('dist/style.css')){
    report.knownMissingTargets.push({key:'./style',target:'dist/style.css',baseline:base('core'),resolved:false})
    delete check.exports['./style'];check.sideEffects=check.sideEffects.filter(x=>x!=='./dist/style.css')
  }
  report.existingArtifactClosure=closure(check,files,f=>fs.readFileSync(path.join(core,f)),f=>blob(core,base('core'),f))
  report.allDeclaredExportTargetsPresent=report.knownMissingTargets.length===0
  report.boundary='baseline records the pre-existing missing style target; only final artifacts/installed gates require complete export closure'
  return report
}
async function stage(){
  assert.equal(process.cwd(),core,'stage cwd must be core')
  const manifest=process.env.ARTIFACT_MANIFEST
  assert.ok(manifest&&path.dirname(manifest)===own,'own frozen artifact manifest required')
  const audit=JSON.parse(fs.readFileSync(manifest))
  assert.equal(audit.head,head(core));assert.equal(audit.base,base('core'))
  assert.equal(audit.manifestSha256,hash(fs.readFileSync(path.join(core,'package.json'))))
  assert.deepEqual(diskFiles(core),audit.files)
  for(const file of audit.files){regular(core,file);assert.equal(hash(fs.readFileSync(path.join(core,file))),audit.hashes[file],'artifact changed '+file)}
  for(const file of audit.deleted){assert.match(file,hashed);assert.ok(!fs.existsSync(path.join(core,file)))}
  const before=split(git(core,'diff','--cached','--name-only','-z'))
  const allowed=fs.readFileSync(path.join(own,'stage-allowlist-core'),'utf8').split('\n').filter(Boolean)
  for(const file of before)assert.ok(allowed.includes(file),'foreign staged source '+file)
  git(core,'diff','--check')
  if(audit.dtsNew.length)git(core,'add','-f','--',...audit.dtsNew)
  if(audit.changed.length)git(core,'add','-u','--',...audit.changed)
  const expected=[...new Set([...audit.dtsNew,...audit.changed])].sort(),actual=split(git(core,'diff','--cached','--no-renames','--name-only','-z','--','dist')).sort()
  assert.deepEqual(actual,expected,'staged dist scope mismatch')
  git(core,'diff','--cached','--check')
  const stagedStat=git(core,'diff','--cached','--stat').toString()
  return {stagedNew:audit.dtsNew,stagedTracked:audit.changed,gzip:audit.gzip,stagedStat}
}
const modes={baseline,artifacts,stage,sync,installed:installedAudit}
assert.ok(Object.hasOwn(modes,process.argv[2]),'unknown mode')
try{const result=await modes[process.argv[2]]();if(process.argv[2]==='artifacts'&&process.env.ARTIFACT_MANIFEST){const dest=process.env.ARTIFACT_MANIFEST;assert.equal(path.dirname(dest),own);fs.writeFileSync(dest,JSON.stringify(result,null,2)+'\n',{flag:'wx'})}console.log(JSON.stringify(result,null,2))}catch(error){console.error(error);process.exitCode=1}
```

## Root 唯一 final 与交付记录

两 Task独立spec+quality及其fix全部关闭后：root用git tracked清单对两仓源码与buildconfig（含package/lock/tsconfig/vite/tsup配置）逐文件SHA256保存 `final-before-fingerprints.json`，运行一次 `./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json`（host cwd、完整recorder），再保存同集合after fingerprints，必须一致。记录实际errors/warnings与冻结基线证据SHA，不能只以“原来就这样”解释stderr。每 Task的tsc/full/build门槛仍执行，Svelte不重复到每Task。

随后root派唯一Astra/xhigh whole-range final（实际两仓accepted BASE→HEAD、全部Task报告、14fixtures、产物链与Rulings）；至多一次统一final fix+一次scoped re-review。最终报告包含：实际core/host BASE/HEAD，Task1/2与fix commits，原始失败/RED与warnings，无省略的dist/import/DTS/exports/installed/corpus closure，UI实际平台/覆盖/限制，明确后续layout/native/file/history待交付合同。本计划没有替root作采纳决定，也没有将script静态正确性当产品通过。
