# 嵌套正文来源：验证记录

状态：Task1/2/3全部独立受理，root最终Svelte与指纹通过；唯一whole-range已通过 C0/I0/M3，Ready to merge Yes。不是完整file UI或发布验收。

## 精确版本
- whole-plan CORE BASE 6585a2470f885984819f5418aa17d4400a7b9ea5 → 75abb5bd168fd33935a8cd692d1d63543fb1a7eb。
- whole-plan HOST BASE 905300228103198a14b1075ded7d02835004a07b → a373bd707ffba1df347827225966af80958a3fdd。
- Task1 d93a332f；Task2 ecb0ef9b；Task3 f68b3b4a +诊断75abb5bd；host产品a373bd70。root正式计划裁定docs独立提交，不混产品writer stage。
- 两现有main，不建worktree；所有原7未跟踪项保留。后续正式发布须重新全面盘点，不把当前提交当发布。

## 已实现
实际parser消费行表/inline/literal事实→实际PM occurrence→精确正文raw补丁；整单行正文strong/em fragment保持外层前缀/definition。table沿成功规则实际escapedSplit投影，literal整正文Replace先审完整原Step再缩未改前后缀；新candidate严格doc.eq与actualprotected集合完整平移校验。
缓存clone/replay重绑私有来源，LF有限完整容器按真实checkpoint/sentinel局部解析；无第二parser、生产oracle或整根serialize再diff。table空inline的诊断用实际包围token map计入真实root。

## 验证快照
| 阶段 | 实际范围 |
|---|---|
| Task1 | related435、早期focused122、追加35/79与严格类型，源提交，无安装 |
| Task2 | focused133；初次相关538中2失败后结构83通过；最终body/cache71和严格类型，不冒称最终全量538 |
| Task3首core | full1006通过于f68源码；初次1004/2旧fallback断言失败已保留 |
| 最终core | 诊断修复79相关、生产与新增测试严格类型、build/artifacts；未冒称75abb全量1006 |
| 最终host | full4300、related94、新测试严格类型、purity、empty-env Vite、check:editor-kit通过；rootSvelte0errors/33warnings/16files |
| 产物 | 58 committed dist/18真实JS入口，DTS/maps源码闭包与installed逐bytes，两仓14 corpus/manifest及package/lock完整bytes保持 |
| gzip | 80838 <=81920，初次80786，最后诊断增加52bytes |

100/1000局部parse的规则/line读数分别相等：quote66/320，list59/289，footnote58/275，table46/251，ATX45/207，setext46/222；1真实top runner/0fullCapture/0legacyParse。table6实际inline调用/3root，其它3inline；PM emission/preprocess/line table/splice仍O(N)，不宣称全流程常量。

## 失败、警告与能力限制
- Task1首pnpm调用触发自动depsStatusCheck并安装检查退出，未跑测试，不能算RED；package/lock未变，实际依赖已核，但无完整node_modules不变证明。后续全部命令显式禁自动install。
- Task3真实窗口RED仅count100先失败，count1000实现后首次GREEN；原不变量首次GREEN如实记录。
- frontmatter legacy raw-BOM初始化差异仍在；真实callback测试仅给legacy view初值去首BOM，session/expected保留原raw。后继file mount必须final schema下直接用capture.doc，零初始化事件。
- 保留core KaTeX、host Svelte、happy-dom销毁/AbortError/NetworkError、bundler chunk/import噪声；ECONNREFUSED见较早运行，不混报为最终该次日志；不称输出pristine。wrapper126、HTML测试offset20→21与quoteoffset19→18等失败均保留原记录。
- 还未实现partial/multi-Step/cross-body格式、inline code与Critic说明/点属性、常用空正文/Enter闭包、file bindings/history/Source owner、网页E1–E3/桌面E4与真实native/IME和统一发行。未闭fence仍拒绝；闭合fence自动加长需后继专用producer恢复。
- 本机移动设备预检无iOS模拟器与连接Android；已异步询问设备，未把库存或合成事件当IME通过。

## 所有裁定（按ledger原序，含后继候选裁定与误判成本）

Ruling: 表格保留原 markdown-it table grammar，仅在其成功后投影实际 row/slot 的 trim、escapedSplit 消费 — 避免复制整段 grammar；实际 token 内容必须严格相等 — 若错，来源映射会拒绝或错误授权，需实际 escaped pipe、重复列、补空列和嵌套表格测试发现并返工。

Ruling: 新 exact/fragment 的 protected 精确集合验证放在内部 preserving candidate 入口，登记前执行；旧结构 candidate 合同不变 — 增强新权限而不无意重定义既有结构操作 — 若边界选错，可能漏保护或拒绝合法命令，需新负例与原结构回归证明。

Ruling: 本批仅承担真实 nested/table/literal 改字及单行全正文 strong/em；inline code/math、point 属性和任意选区格式不冒称完成 — 范围依据已核实际 producer，后续 UI 启用这些操作前必须补明确能力和消费者验收 — 若下游确依赖这些操作，会增加前置任务，不得通过降级或静默禁用声称符合能力矩阵。

Ruling: Task 1/2 提交经过相关回归和类型检查的源码，Task 3 统一构建 dist 与安装验证 — 避免每个中间任务重复完整宿主发布级验证，且禁止安装陈旧 dist 宣称新能力 — 若中间源码改变构建约束，Task 3 会暴露并须修复；本批未完成前不发布。

Ruling: 后续 pnpm 命令均显式前置 env pnpm_config_verify_deps_before_run=false，禁止 approve-builds/install — 当前 pnpm 11 自动 depsStatusCheck 曾触发 install 后因 ignored builds 退出，测试未运行；保留环境失败并核对 package/lock 与实际依赖解析 — 若配置无效仍可能改变依赖，必须观察真实命令输出并停止，不能把环境失败计作 RED。

Ruling: 后继 bindings/history 设计采纳 SourceHistoryStep 可选严格数据 binding transition（rootOrdinal/id），不新增第三类无 doc Step；core 只验证形状/唯一性，host 负责实际来源、覆盖、可信 origin 与因果，JSON 不能授予权限 — undo/redo 必须精确恢复业务身份，避免随机重新分配 — 成本是 core history 类型承载少量通用绑定数据；不允许纯 metadata 伪造 raw change，本裁定尚非该后继产品已实施。

Ruling: Task1精准允许迁移 source-fidelity.spec.ts 的 list opaque/拒绝嵌套正文两项旧断言，以及 source-terminal-hardbreak.spec.ts 的两条 list/quote textSpans为空断言 — 新能力直接改变这些既有能力边界；替换为实际范围/原字节/doc等价与hardbreak无span，不删除安全负例 — 若迁移过宽会掩盖回归，独立review核对精确diff；其余literal opaque和protected hardbreak mark断言本Task保持。

Ruling: 后继 file 模式保留 block.move 命令，以可信 root 的完整 PM slice 构造真实 delete→映射后的相邻 root 边界 insert，controller 私有 witness 绑定 generation/原位置-ID/真实 steps/最终覆盖并核实际 candidate 后继承身份 — 旧 syncBlocks 逐块 parse 不适合整文件；protected 与不支持来源继续原子拒绝，无 definition transport — 成本为一个窄命令 adapter 与私有 witness，若覆盖证明不严会误继承 ID，必须以重复正文、多 emission、同 Node 重用、no-op 与 synthetic 边界验收；尚非已实施。

Ruling: 授权 task-1-conflicts.md 经固定BASE核对的净能力断言迁移：source-list checked正文映射与exact；source-document-capture同parent而非depth1及quote/list；source-block-fidelity四种whole-body fragment与list exact；source-list-boundary单字保留blank/CRLF/9)以及定义旁正文exact（必须核完整protected和不进renderer）；source-file-window实际221→227读取 — 新来源快照确增加每段2次行表读，保留48规则/1runner/3inline与100对1000有界证明，不隐瞒计数 — 若扩大迁移会掩盖回归，独立review须逐项对照，本批未覆盖literal/结构/安全断言不改。

Ruling: 继续拒绝含未闭fence自然根内的新exact/fragment操作，不迁移两条unclosed拒绝用例 — 本批保持既有未闭根权限边界，不因可映射字符而隐式扩权 — 成本是这类正文仍不能Rich局部修改，可由显式Source处理；后续若要开放须独立证明完整权限。

Ruling: 后继 inline producer 允许严格语义所需的有限 delimiter 边界空格 entity 补偿，仍保持全部未授权正文/marks和完整doc等价；同recipe按实际多body authority原子组合，不把既有跨段工具栏默默禁用 — 部分去粗时未选空格仍带原mark，纯移动delimiter未必可表达 — 成本是必要边界raw编码变化，需独立expected和真实多Step命令证明；不允许整根序列化后diff或多候选parse试探，尚未产品实施。

Ruling: Task2真实frontmatter callback测试的legacy createEditor视图初值仅去开头一个BOM，source session与expected保留完整原raw/BOM/CRLF；仍先核doc相等并触发真实callback，不修改legacy全局parseMarkdown — 当前legacy raw含BOM初值与capture语义不同，file-mode初始化尚未交付且必须直接使用final schema同次capture.doc — 成本是此测试不证明原createEditor(raw含BOM)已修，后继计划必须验真实file mount首帧；初始doc.eq失败不能计consumer RED，callback路径的RED如实注明已做capture但尚未做literal权限/Step收缩，不恢复工作源码制造历史。

Ruling: Task2精准迁移3个旧测试文件中的literal能力断言：source-fidelity的fence span和Mermaid公开exact；source-document-capture仅新增code_block/frontmatter/html_block parent与实际literal span、strike_through/html_mark（inlinecode仍不映射）；source-block-fidelity仅table wholebody fragment与table/fence/frontmatter单字exact，均核完整独立raw/base不变 — 这些旧opaque/root-render预期与新增正文映射直接冲突 — 成本是旧测试期望变更，必须独立review精确diff，所有其它未知mark/atom/跨范围/未闭fence拒绝不迁移。

Ruling: Task2仅迁移source-structure-commands.spec.ts的旧自动延长围栏一例为原子拒绝/不进renderer/base不变 — 该用例实际是纯正文Replace，旧靠整根fallback扩大围栏，与新literal严格拒绝合同冲突；其它结构与getLines descriptor回归不变 — 成本为source-aware Rich暂不接受该自动延长操作（default legacy不变），已要求后继inline计划在file UI启用前以实际fence边界专用producer恢复，不能静默禁用后宣称完整能力。

Ruling: Task3 uses host Vite build before check:editor-kit, root alone runs final Svelte after task review; explicit empty envDir and own browser output/cache prevent secret loading and old evidence writes — these are dependency/environment corrections, not relaxed checks — cost is final Svelte may expose an issue requiring final fix, all results retained.

Ruling: Task3仅迁移source-file-environment.spec.ts中setext、list continuation两参数例的full-fallback预期为local且fullCaptureCalls=0，保留完整doc/roots/gaps/protected/layout/textSpans oracle等价断言与其余4类fallback — 新真实完整容器窗口明确覆盖这两类，原预期是旧能力上限 — 成本是旧诊断断言改变，独立review逐项核对；不得扩大为允许其它失败或放宽源字节门槛。

Ruling: Task3精准迁移宿主三个旧installed测试的10条能力预期：source-block-fidelity两list/quote reference owner整正文mark由拒绝改fragment成功，核独立完整raw/protected不变/base不变；source-list-producer五checked空spans改实际span/body权限，公开exact一例改单字成功且完整attrs/doc/raw保持；source-file-environment两个规模line reads221改227，保留48规则/3inline/local及oracle — 对齐Task1已验实际捕获能力，非生产回归豁免 — 成本为旧消费者断言变化，review核精确3文件；不改原source-fidelity.test.ts、corpus或安全负例。

Ruling: Task3补齐inlineRoots真实诊断：table inline token无map不能漏报已解析的所属自然root；允许依据actual token trace或实际包围token map/既有checkpoint归属统计，禁止伪造inline.map或改变parse/权限 — 工作量报告必须反映真实所有inline解析，不能以漏计满足上限 — 成本是追加core诊断修复与build/install复验；必须加受改table root包含断言RED，以及全空inline table邻段改动时的统计，避免只支持非空trace。

Ruling: 后继空正文任务覆盖实际常用首字输入及Enter→新空段→键入闭包，包含table显式/补齐cell、synthetic段落、已闭literal、schema填充容器首段和actual nested blank；private来源事实沿同代capture，不改变默认legacy语义/strict doc.eq — 否则启用UI会出现可建空块却不能键入的产品退化 — 成本为两个顺序前置Task，需实际消费RED与installed回归，不在当前Task3冒称已实施。

Ruling: 接受唯一整体终审，保留 M1 KaTeX、M2 未逐因 baseline 对照的异步资源/teardown、M3 Svelte/CSS/bundler 警告至对应 harness/样式维护，不扩展当前 producer 修复范围 — 相关94项无stderr，4300宿主断言和受影响core检查通过，未发现本批产品阻断 — 成本是诊断噪声仍可能掩盖未来问题；不得称 pristine、全部与F1同因或已发布。

## Root最终检查与审查

Task1/2各C0I0M1；Task3 C0I0M3，全部spec✅/Approved。Minor均交终审，未静默丢弃。

Svelte0errors/33warnings/16files，stdout SHA d2ce704dda2a63df98deca0abc828bdc3b0f5bca1b865aad099a5990e8d9005e 与已受理F1输出一致；stderr仅命令回显。前后完整指纹SHA e6461a6caba6c062321a1ddf279b2bc1e857cfc367e1f85621d6486e4d54f202 相同，覆盖core211/host985个tracked源/scripts/dist/package配置与Memory；准确绑定双HEAD75abb5bd/a373bd70。没有修改或重跑已完成的产品套件。

唯一 whole-range 终审已读取全范围源码、类型、测试、生成代码闭包与实际证据，结论 Ready to merge Yes，C0/I0/M3。无需 final fix。三类 Minor 原文在归档 final-review.md；不外推完整 UI/IME/发行验收。

## 证据归档

Canonical: src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-14/nested-source/nested-source-evidence.tar.gz

SHA256: 4acb0a926c224c91f1434b83ceb6ca8ffc2df488b74bdaa754e885b04550c007

Manifest SHA256: b49cf717f7794f009289fbd04ec94c7840ed5cd6c7efc36681ae3b5f93e6c9e1

全部 6074 个原始文件及 manifest 已逐项回读，压缩包 13476238 bytes。归档外 post-archive-closure 保存正式文档提交及清理验证。后继草稿也归档，尚未视为已实施。
