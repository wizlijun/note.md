# File bindings/history 裁定记录（2026-10-14 已受理）

按 progress.md 出现次序保留；取代/更正保留原条目，不删历史。各条含适用范围、理由及代价，不能脱离后续更正独立执行。

## 1

Ruling: correspondence 真实性在私有 controller 的实际 F1 调用点建立，pure nextBindings 只验证数据与实际 roots — 当前 SourceFileUpdate 是普通 readonly 数据，没有可供纯 helper 验证的 provenance token；只靠类型或 JSON 不能认证来源 — 成本是必须在 Task2 严格保持无外部 correspondence 参数的私有调用边界并验证伪造 metadata/JSON 不生效，不增加一套权限注册表。

## 2

Ruling: 候选稿 98304 字节旧预算更新为当前已正式执行的102400，保持上限而非预增 — 当前已验证产物101857，旧数字来自前置迭代前，不能把过时阈值当新承诺 — 成本是下一阶段新增能力仅余543字节主入口空间，若真实超限需减少重复或具名裁定，不能静默提高。

## 3

Ruling: 严格测试配置保留 ambient shim，安装清理前驱用真实上一已装 SHA — 前置已证明旧 BASE 在多轮新增 hashed DTS 后不再代表已安装来源 — 成本是工具需精确核包新增入口白名单、真实前驱与新HEAD，同时保护原包锁和语料闭包。

## 4

Ruling: Task1 constructor允许相邻且可严格反演的原edits；逆向同锚点的相邻组、组整体no-op必须先canonicalEdits，否则constructor拒绝，不内部静默改载荷；canonicalEdits仍单次合并所有相邻且不跨gap — 正式Task1既允许保留相邻又要求规范形式，两者以可逆性和真实非空变化统一，避免无必要改变F1写集 — 成本是规范形式并不要求所有相邻已合并，需正反向严格有序/整组no-op回归，且不同事务ABA不抵消；其余offset/removed/lineage/hash/bindings校验不变。

## 5

Ruling: Task1 multi-emission只在纯validate/project helper用显式构造的合法公开数据形状测试，同一真实PM doc的root/child/PM范围完整一致；不把该shape传CORE以获取来源权限 — 当前实际parser探针和既有ownership语料未找到一自然root发多个top child的真实raw例，合同类型允许此形状但不能伪报parser能力 — 成本是此项仅证明纯helper结构合同，不证明F1或UI真实多发射；其余capture/F1正例保持真实，后继若首次产生此形状需追加端到端验收。

## 6

Ruling: Task1原wide AddMark/RemoveMark可跨实际verified base已知synthetic/layout empty emission或fallback覆盖的无自然owner child，且每一实际Step该child before/after与baseline完整eq、top-child数量/位置保持；ReplaceStep与未知/改变synthetic仍拒绝 — 真实HOST A LF LF LF B一笔wide AddMark保持三个child且projection正确，CORE authorizeStepRoots却仅因中间已知未变化空段无natural root而拒绝，阻断本计划原始幅度跨body合同 — 成本是mark范围准入新增“跨越不变的已知空段”，不增加其正文/attrs/marks写权限；完整原range/Step/docs、protected/strict与mixed原子性保留，需真实CORE/HOST、CRLF/definition与负例验证，未授权修改source-inline或其它前置。

## 7

Ruling: 只迁移 source-block-fidelity.spec.ts 中“wide mark claims synthetic gap”的单个旧负例为正例，保留 production addMark 两个 steps 正例，单个真实宽 AddMarkStep 的独立 expected 为 **A**\n\n\n**B**，保留原幅度、四个自然 root delimiter inserts、gap/base/protected 不变；相邻 subclass/unknown/变化 synthetic 负例不改 — root 用已安装 CORE 的实际 capture 与 AddMarkStep 独立验证目标 doc.eq 且空段不变，此旧策略与已批准的跨已知不变空段合同冲突 — 成本是一次具名旧测试语义迁移，保留先前 1368/1369 失败证据，修改后重新执行 focused/strict/完整 CORE/typecheck/build/artifact，不将旧失败计为通过。

## 8

Ruling: Task1 HOST 只验当前绝对构建大小与真实 registry 闭包，baseline 同配置应用增量比较延至 Task3 首次产品 mount 接线验收，并在统一发行前完成 — 本 Task helper 尚未进入产品入口，现有证据确无 baseline，不能用 consumer chunk 假称应用增量；CORE 的固定主入口 cap 与真实增量已单独严格通过 — 成本是当前 HOST 体积增量仍未验证，Task3 必须用冻结 whole HOST/CORE BASE 与最终相同配置产物补证，未补不能宣称全阶段体积验收完成。

## 9

Ruling: Task2 起 CORE 主入口 Node gzipSync 默认 cap 由102400调整为103424（101KiB），仍逐次审计；不改变分享主IIFE的900KiB预算 — 实测仅table-commands真实操作hint使清晰去重后gzip102485（+85，raw+263），独立TableView gzip553未进入root；必要合同已最小实现，继续为85字节引入压缩式代码或拆分旁路会增加维护复杂度 — 成本是允许CORE主入口预算增加1024字节（1%），当前实际仅增85字节，后继仍不能自动提限；两次旧cap拒绝和全部原始数据保留。

## 10

Ruling: controller 首filter记录本次实际applyTransaction frame的expected root，state.apply只允许PM内部在filters之后设置 appendedTransaction 从undefined变为该真实root引用；其余引用或受保护metadata改变仍拒绝 — 已核当前prosemirror-state真实源码在filterTransaction成功后才setMeta，因此逐值不变会错误拒绝所有合法append — 成本是fingerprint新增一个精确框架时序例外，必须以真实frame而非caller metadata建立，补合法append、caller伪造与后filter篡改回归，原Step/docs和整链policy一次不变。

## 11

Ruling: 补充限定上一append时序裁定的“后filter篡改”：只验证实际进入state.apply的最终受保护值；PM无条件覆写掉的瞬时假appendedTransaction无需侦测，不封装每个filter或patch PM — 实际PM在全部filter后覆盖为真实root，首state.apply无法观测被抹掉的中间值，该值不能提供私有intent/source权限 — 成本是不承诺拒绝这种已被框架消除且无行为影响的瞬时赋值；测试须证明最终真实root生效、caller metadata不能授权，仍拒绝影响实际steps/addToHistory/history或最终引用的篡改。

## 12

Ruling: Task2追加窄修source-empty-body applicability，并新增source-empty-chain.spec.ts；可证明base已有非空自然body且完整原链仅在该body内清空后再插的暂时空parent，交回既有inline recipe审核，不合并/缩range/丢步骤 — 实际slash delete→highlight/wikilink literal两步被empty入口接管后强制首步空插入而拒绝，单步同目标与普通delete→insert探针证明是接管边界缺口 — 成本是新增暂时空body来源识别，需原parent区间/map证明、真实CORE/HOST与LF/CRLF/BOM/protected回归；baseline空body/新生synthetic/未知或跨body/mixed unsupported保持旧边界，全部旧negative先保留，source-inline不在此次授权。

## 13

Ruling: 仅迁移source-empty-cache.spec.ts参数emptied-earlier为正例，later-empty/created-earlier负例、spy和base不可变断言保留；新增核原两Step/docs及仅A→X写集 — 旧例在一个原非空自然table cell内真实delete(16,17)→insertText(X,16)，与批准的暂时空body合同完全同形；root以installed真实capture独立证明完整expected表格仅A变X、目标doc.eq且邻空cell/base不变（root-empty-table-expected） — 成本是一条具名旧策略断言迁移，不加table特判，保留原244/245失败证据并重新覆盖/strict/完整CORE/type/build/artifact后才提交安装。

## 14

Ruling: 内容observe/onDelta改为每个已接受chain的microtask通知，同步state/view安装及boolean/FileResult结果不变；每事件捕获当次snapshot/delta且按提交顺序发送，unsubscribe抑制未执行回调，拒绝/probe零通知；内部view/resize paint仍同步 — generic dispatch只有已构造tr和同步结果，无法在回调重入时既延迟重建意图又真实同步返回；延后通知让回调从最新state建立新tr而不重放旧tr — 成本是新file API业务通知异步，Task3保存/生命周期须用await owner.flush的最新snapshot而非依赖同步tab回写，需同turn A/B、回调C、取消订阅/异常/拒绝回归；legacy observer不变。

## 15

Ruling: 相同正文完整root移动仍交换business ID，不能以neutral PM/raw相同视为no-op；仅私有真实move witness依原delete→insert及完整mapping恢复全部rows，保持raw/hash/lineage，不伪造空SourceHistoryStep。真实native history捕获的candidate无raw载荷时，仅neutralized doc等于当前session.doc、ID集合完整唯一且bindings/layout全校验通过，允许从candidate doc恢复身份排列；其余标准语义变更无payload仍拒绝 — 实际相同A段移动F1判untouched，单改目标ID造成重复，原载荷必须nonempty edits — 成本是新增identity-only history受理窄分支，须验证move双向/undo/redo/probe/外来ID或metadata拒绝及与文字编辑分组和分隔组合，不放宽raw权限、不新增Step类。

## 16

Ruling: spreadsheet同步slash保留真实旧producer和枚举，但file能力查询返回false且执行拒绝时保留slash；以真实unsupported producer负例覆盖，不在Task2额外开放CORE语法 — 计划正例列h1/task/code/mermaid/table/literal，spreadsheet真实producer尚不在冻结保真能力矩阵 — 成本是file模式此slash能力暂不可用，报告必须明确，不能宣称任意slash可用或借Source权限绕过。

## 17

Ruling: Task3采用当前OWN annotation-admission-seam-design.md第2–6节的共享批注接缝，列入正式Files与首次真实UI验收：commands可选isCurrent/dispatch(boolean)、返回本次edit对象；Popup仅strict false保留草稿、先save/remove后身份匹配关闭；本次对象flushDraft在300ms前同步读最新text，owner成功flush后才保存/切换/销毁。每弹窗controller/view/generation闭包只认领自身成功且目标未被append移动的版本；stale保留草稿，并提供明确重试/放弃未保存修改出口，discard不写文档或撤回已接受版本。新开全局Popup先通过旧对象自身flush，失败不插入不替换；其它owner普通flush不触及它。composition不强制提交或丢弃，完成后才可继续 — 当前void回调与提前关闭会吞掉policy拒绝，旧保存事件漏掉300ms草稿，stale无显式出口会永久阻塞tab — 成本是扩大Task3必要UI接线范围和三条四语言文案，不增加权限注册表/草稿数据库/第二套批注或Tauri测试stub；delivery仍独立负责纯i18n依赖拆分。

## 18

Ruling: Task3采用当前OWN source-pending-seam-design.md第2–6节：attachFileSourceInput返回同一adapter的pending/retry/discard与内部flush/detach/rebind，owner闭包保存单份buffer，两端Source UI直接持同句柄，不扩FileEditorOwner/Mounted公共契约。失败草稿保持固定session/authority/generation，普通输入只更新草稿；显式retry仍过原准入，stale不可刷新generation重放全文。显式discard只恢复最新snapshot，不改raw/history；composition中禁止重试/放弃，强制detach保存可读buffer为interrupted pending并拒绝等待者，不伪称IME结束。SourceView和source-actions全部实际文本写入汇入唯一commitBuffer，异步结果复核原owner/DOM/buffer/selection；保留Rich DOM时写事件仅当前模式消费 — 现有普通input之外的auto-pair、格式/批注、Find、paste、右键直接setContent会绕过准入，value绑定会覆盖失败草稿 — 成本是新增必要可达pending UI和精确旁路接线，不新增全局草稿库、不迁移旧Kit Source consumer，不授Source强制覆盖权限；工厂必须明确给Desktop/Kit同句柄的实际入口，不能只有不可达内部方法。

## 19

Ruling: Task2非空block.insert-after允许末尾无换行自然root因新增分隔符而从untouched变为一对一retained；仅原root结束于原EOF、完整原raw在插入点前逐字节未改、该旧root新raw切片恰为旧切片加一个本次选用EOL、对应原PM children完全相同，其余原roots仍untouched且raw相同、恰一新自然root包含全部新content时受理。继续完整文件F1、实际Source Step/payload与bindings，不开一般retained/语义影响权限 — 独立installed探针root-insert-eof-correspondence证明A→A\n\nB\n\n仅EOF插入，旧A语义相同却合法retained；计划原untouched-only会使普通无末尾换行文件无法在最后追加块，与spec无末尾换行语料及块编辑目标不符 — 成本是一个严格EOF separator边界例外，必须LF/CRLF/BOM/无EOF换行、undo/redo/probe与多root/reference影响拒绝测试；CORE守卫/serializer和其它旧negative不改。

## 20

Ruling: Task2 Prepared.stepsJSON示例只是内容校验，不能替代原执行链身份；私有intent注册时与首filter准备后都封存并在消费前核原Step引用、exact prototype、执行方法及docs/真实StepMap/Mapping结构，保留实际链而非JSON等价替身 — 独立review I1已证明同JSON不同invert的Step subclass进入native history令undo卡住，私有insert在首filter前被改mapping仍受理 — 成本是额外完整性指纹/比较，拒绝被改链不得安装或改变history；不复制成第二历史、不给metadata授权、不patch PM全局。具体方法保持简洁，除两条已复现用例也覆盖原对象方法原地篡改，不能仅加JSON字段或prototype比较留下同类执行替换。

## 21

Ruling: Task2 I1修复中，仅对真实native history捕获candidate与installed history共享的原Step执行对象、其直接可变数组及候选StepMap/ranges值做局部冻结，再交后filters；Mapping容器及candidate事务仍正常可变并继续完整指纹。普通source/insert producer与Rich路径按封存比较拒绝，不因此普遍冻结调用者事务 — writer真实undo探针证明PM无remap的popEvent复用installed inverse，晚期原地改invert即使本次拒绝也会污染旧history，随后redo失败 — 成本是在首次消费历史candidate时将本应不可变的共享执行值变成只读；须验证拒绝后undo/redo仍完整、正常merge/map/分组不回归，不复制成另一Step、不改PM prototype或全局流程。

## 22

Ruling: Task3 Source textarea仅作为LF显示投影，原始raw保持权威。固定本次generation的raw/display，按display最小前后缀差异映射回raw边界（CRLF及单CR均计入映射），只替换变化区；新输入区的LF使用原文件首个EOL或缺省LF，未改区域混合EOL逐字节不变。初次挂载/重绘/no-op不写；所有Source UI坐标来自display，controller收到重建raw。pending retry仍使用原session/generation，不刷新基线，discard取最新raw投影 — ROOT实际Chromium140的textarea探针证实CRLF与单CR自动转LF，BOM和emoji保留（evidence/root-textarea-newline-projection） — 成本是现有file-source-input内局部投影helper，须覆盖真实浏览器CRLF/mixed/BOM、三次模式切换/no-op、一字单hunk、新行插删/emoji，不做全文件换行归一。

## 23

Ruling: Task3 desktop现有额外plugins须在首次controller创建前由RichEditor组装，经editor-bridge传入file-main内部factory参数一次安装；公开mountFileEditor两参数默认保持兼容，不扩FileAdapters/FileEditorOwner合同 — mount后直接view.state.reconfigure会让controller与view持有不同state，破坏唯一事务入口 — 成本是内部装配接缝，不引desktop依赖到纯file-main，不保留挂载后重配旁路，需验证实际desktop extras与owner持有同一state。

## 24

Ruling补充并取代Task3 EOL裁定中的“单前后缀包围范围整体替换”：Source多处修改（如Replace All）也必须保留中间未改换行的原始字节。raw `A\r\nkeep\nA\rTail` 两处A→Z时，单包围范围的LF→首EOL会误改keep后的LF；ROOT先前算法要求不足。允许复用已有纯share-merge/diff.ts对display UTF16单元求离散变化，逐范围映射raw，仅插入片段选原首EOL；不新建diff算法、不修改已有内核、不过滤格式差异。预算/计算失败保留可见pending，不退回全文件归一 — 成本是必要的多范围显示映射与Replace-All/混合EOL回归，先真实adapter RED再实现；普通一字/no-op语义与原session/generation约束不变。

## 25

Ruling: Task4按当前OWN/task-4-seams-discovery.md实际入口修正边界：首产纯单文件createShareFileSession（显式policy、既有adapters/render、真实owner/save/close），旧inline browser只兼容optional editorFiles，禁止runtime import破坏projectShareBrowser.toString闭包。在线mount/导入/rebase/undo-rebase编排分别由delivery E1/E3首次交付，Task4只验证保存不重建history、显式baseline/policy和恢复底层边界 — 实际browser没有公共saveDraft或既有rebase链，原计划把拟建API误写成已有链 — 成本是明确首次消费者任务，不删除最终功能/平台门槛，不新增第二factory。

## 26

Ruling: Task4保存callback采用固定同lineage live对象→Promise<实际durable detached DraftV2>；共享FIFO在实际写入前clone最新同对象并await原atomic，送达操作直到内存markDelivered完成才释放槽位。file-session冻结请求snapshot，只有returned该路径raw及本次已生成recovery逐字段/有序bindings相同且authority未变，才ack该代；失败/旧authority/被更新输入取代不伪确认。close先解决pending/IME，再临时只读锁定最新snapshot，精确保存成功后close，失败恢复原只读并保留owner — 冻结整draft即便FIFO也会在送达飞行中复活pending；B回执不能清C或跨baseline — 成本是最小实际写入回执和局部close锁，复用现有队列/restoreRecovery，不新增持久化服务。完整时间线见seam报告§6。

## 27

Ruling: Task4 native route采用本机Tauri2.11.1已有Builder.on_page_load：仅main Started推进Rust epoch、清published route/version并恢复default；同一set_file_history_route的init分支只读epoch，set要求main调用者/同epoch/递增safe integer version。mainFocused独立控制effective active，旧页迟到高version和非main请求无效；不以DOM菜单blur解除owner — 单读version再+1无法抵挡reload旧页迟到更新，实际API本机源码已核 — 成本是一个内存page epoch，不引时间戳/服务/第二菜单模板；实际native菜单平台仍必须另验，纯状态测试不代替。

## 28

Ruling: Task3 cumulative纯tsc允许OWN精确EditorContextMenu.svelte module ambient，仅复制实际已存在EditorActions的run(id:string):void|Promise<void>与canRun(id:string):boolean，并核实际源声明一致；不改产品/不使用any/不放宽strict。真实组件仍由最终Svelte check检查，ambient不算实现证明 — tsc只见既有*.svelte默认声明而无法读module-script named interface，首次TS2614归工具类型边界失败非功能RED — 成本是临时验证桥，保留失败及类型来源核对。

## 29

Ruling: Task3共享insertNoteRich末尾增加可选replaceRange:{from,to}，在同一真实state.tr删除触发范围后按该tr映射selection执行原note_anchor/annotation mark逻辑，仅一次admission.dispatch；legacy省略参数保持。FileMountSession内部提供insertSlashNote，公开MountedFileEditor.annotations/FileEditorOwner不扩。旧Popup先flush失败零写，flush后仍核捕获view/generation/selection；成功才打开原Popup — 旧desktop slash先删串再异步执行会在取消/拒绝时丢原文，并拆成多个history事件 — 成本是已有共享命令的最小prepare范围参数，须真实拒绝保留trigger/一次undo恢复/旧Popup拒绝与legacy回归，无fake state/view或第二批注serializer。

## 30

Ruling补充并取代上一批注slash裁定的具体“先delete再insert”步骤要求：collapsed slash点批注直接以原真实tr.replaceWith(trigger.from,trigger.to,note_anchor)一笔ReplaceStep原子替换，仍复用原insertNoteRich/admission/Popup；legacy默认路径不变 — writer真实controller探针t3-empty-annotation-probe证明既有CORE非文本inline note_anchor只接单Step，双Step被unsupported-step拒绝；单Replace天然表达本次替换 — 成本是既有helper的最小分支，不扩CORE、serializer或权限；须实际raw/PM、policy拒绝保留slash、一次undo恢复与旧Popup拒绝回归，保留旧失败，不把拒绝计成功。

## 31

Ruling: Task3实际批注slash复验表明单ReplaceStep仍被preparePointRecipe中from===to限制拒绝；上条“免CORE”推断撤回，暂停依赖的slash交付。批准CORE source-inline-recipe.ts最小能力补齐：仅单标准ReplaceStep、同一个已捕获body的可映射纯文本范围替换为canonical无marks note_anchor，证明删除范围全text且不含atoms/Critic/未知映射/结构边界；复用rawRange、captured facts、真实Step replay、最终strict doc.eq与protected，不按slash字符串硬编码或授一般非文本替换权。新增source-annotation-producer.spec.ts精确正/负回归，原negative不自行迁移 — 实际desktop入口需要一次原子替换，拆成两次会丢trigger/污染history — 成本是追加CORE前置修补，需RED→GREEN、strict/full/type/build/artifact、精确commit并按真实已装cb15e71b6cbbf5d4365d914169e6a20fa5f3b5ee受控安装，再HOST真实slash/undo/policy测试；cap103424与原fixtures/锁不变，旧双Step及单Step失败证据保留。

## 32

Ruling: Task3不修改无file调用者的旧src/editor-kit/rich.ts；公开mountFileEditor与desktop editor-bridge file分支都直接进入唯一file-main工厂，内部wiring一次组装plugins/adapters，CORE callbacks完成首帧schema/capture/controller。旧Kit mountRich二次customizeSchema仅保持legacy原状 — 实际接线已无需旧Kit承载file参数，增加未消费入口会形成冗余 — 成本是取消原Files中不必要一项修改，不取消首帧/legacy回归或公共接口，不新增第二factory。

## 33

Ruling: 新增独立Task5（Task4后、唯一whole-range final前）补齐普通desktop既有image操作的保真producer/消费者；Task3先完成其余owner/source/实际接线并独立审查，报告image未闭合，不得称全阶段可发行。新Task设计为当前OWN/desktop-image-fidelity-design.md，待实际证据与接口自审后冻结，不派第二产品writer。Task4原“最终”Svelte/完整能力聚合与phase受理相应延到Task5后，只保留其实际native/recovery必要检查 — Task3真实helper证明insertImageAtCursor/insertImageAtPos被新controller拒绝，原binary paste/native drop/image slash/ctx都会退化；网页spec§12.9禁新增附件不授权删掉宿主原功能 — 成本是必要兼容性修补任务，继续单一来源/Step链/protected/doc.eq与现有cap，不能用Source fallback或静默legacy切换绕过；本阶段最终受理/发行前必须完成。

## 34

Ruling: Task3真实Chromium从空Rich逐键输入**bold**!失败：首*被escape，第二*经exact原样写入，第一关闭*候选误成italic后doc.eq拒绝，用户键入丢失（t3-browser-mount-first与mount-input-diagnostic）。授权source-fidelity.ts现有needsInline语法标点选择分支将纯插入与已有replacement同样预选既有inline recipe，保留原Step/docs与全部captured/protected/strict校验；不先失败parse再fallback、不全篇重写、不扩body权限 — 根因是现行step.from<step.to条件漏掉纯插入而exact语义失败又必须终止 — 成本是必要消费者分流修补，先同session真实逐步RED→GREEN、原inline/empty/markup能力回归及真实浏览器完整InputRules序列；旧expected变化须具名核准。CORE新增完整gate/commit/install以7f1946793310887b999a62dde33aa6670a5a59e5为实际前驱，cap103424不变，HOST消费者随后复验。

## 35

Ruling: Task3 literal标点分流后只迁移两处具名旧expected：source-nested-producer.spec.ts的quote正文起点insertText('>')由semantic-mismatch负例改为精确局部escape正例，独立expected为`> \\>Alpha\n`，保留serializer spy零调用、原base/单edit和严格doc.eq。source-nested-cache.spec.ts最后用于失败后重试的插入'>'改为正文内真实文本LF插入，并明确semantic-mismatch，保留全部原cache/base/retry及/new引用断言；不得换成提前拒绝的unknown Step/atom而削弱failed-candidate覆盖 — ROOT实际installed独立root-literal-expected-proof证明escaped raw严格等于原目标PM，完整缓存测试raw下LF真实候选失败且base逐项不变、随后甲→乙仍正确 — 成本是两条旧能力边界预期调整，原1397通过/2失败全量证据保留，新focused/strict/full必须全绿后才build/install，不改其他旧negative。

## 36

Ruling: Task3真实InputRules连续输入 **bold**! 保留strong storedMark，正确raw为 **bold!**；浏览器预期按实际PM语义修正，并追加Mod+B退出后x与undo/source断言，不能改InputRule来迎合旧测试 — 当前实际Chromium已证无丢字 — 成本是修正一条新验收预期，旧失败完整保留。

## 37

Ruling: Task3纳入已有Rich异步输入生命周期安全。file分支在clipboard/resource/video/context paste准备前捕获owner/view/generation/tab/mode/selection，await后复核；video仅替换本次成功插入的exact range及expected text/mark，不扫描文档第一同href；旧legacy不扩大重写 — 同一真实owner不代表异步返回时仍是原用户目标 — 成本是局部stale guards及实际消费者延迟回归，图片producer本身仍留Task5。

## 38

Ruling: Task3公开file factory复用已有KitCSS资源，允许将main现有纯injectKitCss最小提取到file-kit-styles.ts由两个入口共享；非externalSource file挂载注入并加kit-host，desktop沿原宿主CSS，不引host theme RPC或第二factory。实际browser fixture撤除手工CSS掩盖并检查资源加载/Source布局。check-editor-kit-build允许可选outDir（默认dist）及真实mountFileEditor导出检查 — 当前factory未注入CSS而测试手工import掩盖部署缺口 — 成本是小型共享样式接缝与产物断言，后续share builder仍需独立CSS/IIFE闭包。

## 39

Task5设计正式纳入计划：成功image capture/局部units/attrs-marks路由/desktop消费者，接口与验证逐项明确；BASE和最终条件UI允许文件待Task4受理。唯一mixed math+image negative具名迁移裁定见正式Task5；其余negative不变。当前仅规划通过，未实现。
Ruling: Task5允许仅迁移source-math-producer.spec.ts具名旧negative中的canonical math+image混合新生单ReplaceStep为正例，独立expected `__Keep__ $x$![](/x)`；同组empty math与birth后partial payload仍负例，原所有其它guard不变。真实installed独立image-design-mark-mixed已证原ReplaceStep(6,8,[math(x),image(/x)])的目标doc与该raw完整parser严格doc.eq，现拒绝源于未实现image能力 — 标准剪贴板混合内容不应凭旧缺能力负例继续退化 — 成本是一个边界用例迁移，Task5仍须实际producer GREEN/F1及审核，独立probe不当实现证据。

## 40

Ruling: Task3真实Mod+B退出粗体后紧接字母仍丢键，属于必修输入边界，不能换成先空格的验收规避。批准在source-inline-recipe既有adjacentEntities中，仅已保留em/strong wrapper内侧完整Unicode scalar为标点/符号、外侧本链新生scalar（before未定义）非空白/非标点符号时，对新生scalar使用现有数字entity emission；保留旧scalar/wrapper字节，完整左右surrogate分类，不改旧字范围、不做parse失败fallback、不扩其它mark权限。ROOT独立root-kept-mark-flanking-proof真实installed证明strong/em左右+x/中/𐐀共12例原单ReplaceStep当前semantic-mismatch，而独立entity expected完整parser严格doc.eq；writer普通无标点strong/em边界现状成功不变 — 成本是局部delimiter flanking兼容修补及source-inline-input/source-inline-recipe原真实输入/边界回归，前驱2eb07明确，须完整CORE gates后再commit/install与实际浏览器复验，原失败保留。

## 41

Ruling: Task3链接连续输入补实际正向断言后确认真实产品拒绝：single Replace在noninclusive link末端插入plain text，from.marks为空导致误走exact映射到label内。批准source-fidelity在single exact Replace纯插入命中真实captured link edge pmFrom/pmTo时预选既有inline recipe，仅link family，不在候选parse失败后回退。ROOT独立root-link-boundary-proof证文件末端/中段目标raw完整parser严格doc.eq，而旧路径分别semantic-mismatch/unmapped；writer实际recipe对左x/右!/中段/不同href间x/ref右!均strict eq并只插边界。另新生无marks !紧邻实际输出的保留 '[' link opener前，复用局部literal转义为\!防止变图片；仅新生scalar，不改旧wrapper/definitions/标签内。Files source-fidelity/source-inline-recipe及现有source-inline-input/source-inline-recipe测试 — 成本是必要的局部source选路和标点生成修补，全部正向输入/原Step及ref/邻link回归后完整CORE门槛；当前103221距cap103424仅203，超限须先具名报告，旧浏览器仅负条件PASS保留为范围不足而非功能证明。

## 42

Ruling: Task3新增empty stored-link逐键fixture按实际noninclusive PM事务修正expected为`[l](/url)ink!xyz`：首l有link mark、后续ink退出，原Step全部接受且未丢字；不改既有storedMarks/noninclusive语义以迎合测试。另保留真实公开link command一次完整label并继续键入的browser正向验证 — 原新fixture误假设每笔insertText自动延续非inclusive mark — 成本是一条新fixture预期更正，失败归验收假设错误不是产品RED，逐Step/strict/noU+200B仍必核。

## 43

Ruling: Task3 fix1 I3真实adapter异常RED证mount已获得frontmatter destroy句柄后spreadsheet.create抛错，file-main仅移除root而未清已有资源。批准只在file-main挂载期间为这两个显式factory已获得的destroy句柄做一次性登记，正常NodeView destroy取消登记，创建成功释放临时登记，失败catch逆序清剩余；调用原handle.destroy保留this，cleanup单个抛错继续清理并诊断且保留原创建异常。CORE实际类型仅destroy方法（frontmatter可void），无需CORE/API/第二NodeView/全局资源框架 — 成本是必要挂载失败回收接缝，新增真实失败/正常close只一次/cleanup异常仍清完与原异常回归；不扩未被证明的长期资源管理。

## 44

Ruling: 仅内部 FileMountSession 增只读 baselineIdentity: object getter，返回既有 controller 引用，只作引用比较，不扩公开 Owner/Snapshot/Recovery、不持久化、不加 registry。保存同步捕获 identity 和当前 snapshot；回执先核同 identity，再核 durable raw/recovery。saved 标记本身按 identity 隔离，换基线后旧 generation max 不阻碍新基线。普通编辑/undo/模式切换 identity 不变，允许 B 保存期间继续 C 后只 ack B。失败 installBaseline 保留 identity/旧 durable。observer 只作保存信号，重新同步读当前 identity+snapshot，不能旧通知配新 identity；await flush 后同理重新读取 — authority 字符串允许复用，generation 归零，sourceLineage 普通编辑也变化，均不能区分基线实例 — 成本是一个内部只读 getter 与本地 saved tuple；须真实 mount 覆盖同authority重装、A→B→A、高generation到0、失败baseline、B/C、模式切换及旧microtask通知跨baseline。

## 45

Ruling: Task4真实native Source undo用例t4-focus-first证明textarea已选(1,3)，内部Source adapter仍持旧selection(0,0)，follow重画覆盖用户选区。批准file-source-input.ts仅增加select同步读取与其自身history入口先read，保留pending/composition阻断、原value/原raw准入与唯一history；file-source-input.test.ts纳入精确允许范围。不得借此重新序列化正文或把未知旧选区resolve到新doc — 成本是补齐同owner Source选区状态同步；真实browser recovery需覆盖选择→菜单式undo及键盘undo，不能仅手工dispatch select后函数测试代替浏览器行为。

## 46

Ruling: Task4桌面closeTab实际await saveTab/saveAs期间可继续输入C；保存B成功不能授权销毁C。采用内部FileMountSession.closeIfSaved({identity:object,raw:string}):Promise<void>，与公开owner.close共用一个private close(expected?)；最终await owner.flush后、同步destroy前核当前controller identity与snapshot.raw，失配throw且保留owner/DOM/history。file-editor-sessions关闭函数可接捕获的session引用/identity/raw并核registry一致；tabs.closeTab开始捕获session+identity，所有询问/保存完成后非显式discard传实际tab.initialContent字节（包含开始clean和untitled成功saveAs路径），显式discard沿原无guard关闭。无需桌面readonly getter/锁整段保存，不改变公开Owner — 成本是一个内部关闭guard接缝；须真实B保存/C续写、最终flush接受新输入、同authority baseline交换、untitled/显式discard回归；拒绝关闭不再remove tab或destroyowner。

## 47

Ruling: Task4实际svelte-check发现rich-actions.ts:97的async run返回Promise<boolean|void|NoteEditState>违反既有EditorActions.run void|Promise<void>；当前1 error不能当既有通过。批准该文件仅selectAll/note/question三分支执行原调用后显式return void，保持原副作用/权限与既有接口，不放宽返回类型 — Task3批注新增返回句柄被无意泄漏到菜单执行合同 — 成本是三个必要调用方类型修复；重跑实际Svelte与相关已有菜单/批注覆盖，不为机械void修复新增镜像测试，原失败完整保留；若full在修复前已运行，准确记录其代码范围并补所需covering。

## 48

Ruling补充：首轮void修复后t4-svelte-fix1仍1error，剩余boolean来自Task2同步producer helper的菜单分支。将同一最小void-return修复扩到rich-actions.run现有h1/h2/h3/quote/codeblock/bullet/ordered/task/hr/table/math/mermaid分支：调用setBlock/wrapBlock/wrapList/insertAtom/insertTable/insertTaskList后return void；不改helper布尔返回或EditorActions合同。此前三处分支不足以闭合实际推断，旧失败保留 — 成本仍仅同一菜单调用方机械修复，Svelte必须真实零error后才通过。

## 49

Ruling: Task5真实空行图片probe与普通文字control均证明raw LF的第二空段pos3首次输入被prepareEmptyParagraphEdits放到raw0，strict语义失败；独立expected LF+image或LF+X与目标doc.eq成立。此必要空文入口在Task5修复，不把失败改negative或静默延后。沿已有markdown/source-structure获准文件定位并用certified fallback/blank的实际emission/source span修正物化边界，保持未改空段顺序、raw/BOM/EOL及protected；不重排parser目标doc、不宽松strict、不新推测anchor、source-empty-body无默认扩权。先给实际最小recipe与各origin变更依据再实施涉及旧边界的修补，新增文字+image、首/末/中空段、LF/CRLF/BOM及失败后重试回归 — 成本是一个已存在空段首次输入兼容性修补；前置原negative若变化须具名证据裁定，不允许为图片任意放宽空body权限。

## 50

Ruling更正并细化上条根因：LF的pos3是certified owned blank，实际fallback在其前；不是fallback.sourceAnchor本身错误。批准source-structure.prepareEmptyParagraphEdits既有prefix判定使用真实layout.fallback.emission与chosen blank.emission的顺序，前置fallback需要物化为一个新增EOL；与原previousbody/protected separator条件合并而不双重添加。旧chosen终端EOL仍原样保留，独立expected为LF+image+LF和LF+X+LF；不移动原source spans、不改parser/facts/目标doc。需实际strictdoc.eq/原bytes边界和首中末多空段、mixedEOL/BOM/definition保护证明。先前“fallback anchor错误”描述撤回，旧诊断保留。

## 51

Ruling: Task5只追加迁移source-inline-recipe.spec.ts具名旧negative“fix1 failed unrecognized atom keeps the whole mixed transaction atomic”：raw Alpha ![x](/u) LF +真实单AddMarkStep(1,3,strong)，新独立expected **Al**pha ![x](/u) LF。ROOT root-t5-image-neighbor-proof用未变实际installed CORE48f25完整parser证明expected严格doc.eq原目标，image完整node unchanged；writer独立47-case neighborproof亦绿。将此用例改为保留原chain、image原occurrence bytes、base/revision/protected不变的正例，其他未知atoms/math payload/protected拒绝不改 — 已支持canonicalimage不再是unrecognized，继续拒绝会阻断邻文格式化 — 成本是一条具名旧边界预期迁移；t5-core-full1唯一1471/1472失败原样保留，修后重新完整CORE/strict/type/build/artifact，不能用旧failedfull进入安装。

## 52

Ruling: Task5 CORE主入口Node gzipSync默认cap由103424调整为104448（102KiB）。t5-core-budget1实际baseline raw450727/gzip103317，working raw454361/gzip104108，增3634 raw/791 gzip；ROOT已逐一核markdown/source-inline-recipe/source-fidelity/source-structure全部production diff，复用真实atom capture、现有局部image callback、统一imageStepRange与emptyBodyEdits，无新公开exports/deps或第二parser。剩余684字节超旧cap不能通过压缩式改写或移出口规避；保真image兼容所需能力合理增加1KiB预算。新删除边界修补后仍须最终重新测量并通过104448，share IIFE900KiB独立不变，旧cap失败完整保留 — 成本是CORE预算上调1024字节，并由实际artifact audit持续限制。

## 53

Ruling: Task5终端图片删除真实RED（t5-core-terminal-delete-red2）证明原末空白必须保持PM语义，独立expected __Keep__&#32; CRLF严格doc.eq。批准既有edgeSpace实体路径仅处理final已成为body首/尾空白、原同侧有本链实际删除captured image occurrence的旧scalar；旧已边界的escaped/entity whitespace原bytes保持，不以本body任意删图普遍授权。本链合法image birth后删除仅沿真实删除单位驱动既有emptyBodyEdits，替代仅baseline image事实的限制，不据birth授权旧scalar改写。新增左右、多space/tab、替换后仍有文本不改、旧实体保留、CRLF/protected及重试验证，原Step/docs/strict/F1不变；不parse失败fallback、不改目标doc — 成本是两个实际既有图片入口兼容边界，全部CORE门槛重新验证。

## 54

Ruling: Task5 t5-host-focused-red2真实RichEditor context image选择窗口未返回时，更换同raw/same-generation baseline后旧dialog结果写入新正文。批准仅RichEditor.svelte file ctxActions的image分支复用captureFileInput，await dialog后再次核且helper前不再await，取消/拒绝/stale零写；legacy其它入口不另造架构。新增真实组件交互回归 — 成本是必要异步旧目标隔离修补，不扩大公开API。

## 55

Ruling: Task5 t5-core-image-mark-flanking-red证明新strong/em图片wrapper紧邻旧AB时，独立expected imagewrapper+&#65;B严格doc.eq原storedMarks插图Step，原literal邻接不成立。批准沿既有adjacentEntities仅本链新建/改变em/strong wrapper的实际canonical image边界，左右紧邻无marks的完整非空白/非标点Unicode scalar做必要数字entity emission；允许旧scalar但已有满足flanking的entity/escape原raw spelling保持。kept wrapper与其他marks不开放，不parse失败fallback、不剥marks、不改目标doc。须左右ASCII/中文/astral、已有entity、标点/space、protected/nativehistory独立回归；完整CORE gates与104448预算，实际installed812049d为新安装前驱 — 成本是既有storedMarks图片操作必需的局部表示性兼容。

## 56

Ruling: Task5真实cursor与file-main slash native space路径RED批准attachment-insert.ts新增HOST内部imageSourceForNativePath供两个既有图片helper与file-main image分支共用。参数明确native filesystem path：仅必要ASCII URI转义复用原生encodeURIComponent，保留实际parser支持的Unicode、路径分隔及真实drive colon，literal%20/%25必须%2520/%2525，#/?必须编码，使localResourceCandidates一次decode恢复原文件名。HTML/Markdown已编码src不经过native-path函数，不猜测通用URL、不复制完整Markdown serializer、不改resolver或公开Owner/Adapters；actualPM attrs/strict raw/resolver同路径、slash取消拒绝/history需验 — 成本是已有native入口的canonical初始节点修补，不在CORE擅改事务目标doc。

## 57

Ruling: Task5 t5-core-kept-image-flanking-red 追加：既有 kept strong/em 分支内侧标点识别可含实际 captured canonical image 边界；仅原 Step 本链新生 outer scalar（before undefined）做已有数字 entity emission，kept wrapper、旧 image occurrence、旧 scalar 原 bytes 不改。此项明确细化前条 kept wrapper 不开放的内侧识别，不授权重写 wrapper/旧相邻文本，不扩其他 marks。沿现有 scalar/flanking 工具，无 parse 失败 fallback；须左右、reference/inline、完整 Unicode 与无 storedMarks 实际输入/undo 证明。ROOT 已授权 writer 仅同步此一条计划，完整原链 guards 与 strict doc.eq/protected 保持。

## 58

Ruling: Task5 t5-host-full 仅 file-owner.test.ts 两个 Task3 明确记录 image gap 的旧 negative 失败（4658 pass/2 fail）。批准仅具名迁移 prepared image slash 为一次原子成功，精确 ![](/vault/a.png)+LF，单次 undo 回 /insert+LF，file 分支不变；actual desktop image helpers 改 cursor 与 pos 的精确成功 raw、邻文和独立 history，保留 attachment link 断言。拒绝保 trigger 继续由 file-image policy/readonly 回归验证，其他边界不动。ROOT 授权 writer 同步本 ruling 与将该测试加入 Task5 精确 allowlist；保留旧失败，重新完整 HOST full green 后提交。
