# 完整文件解析环境验证报告

本轮实现共享编辑器的文件解析缓存、引用/脚注环境及显式源码补丁入口。文件身份绑定、统一历史、富文本/源码界面、网页E1–E3、桌面E4和统一发行尚未完成。本阶段已受理，尚未发版。

## 范围与提交

core BASE `8453283cfdc180b015a14414e12bca39fee56fe0` → 首实现 `af07f410aad82d487b66689df75194460a365a74` → 最终 `6585a2470f885984819f5418aa17d4400a7b9ea5`。
host BASE `fe0c2335319cc83ef1ca1d9c34986874515be582` → `cf798dcb3598af5c8a667827acc3fe127fefd04c`。

共享真实markdown-it规则与Moraya发射器；完整capture和局部窗口复用同一finalizer、verified factory与不可变token模板。新增prepareFileSourceEdits显式校验revision/removed/范围，不将其权限用于Rich绕过来源保护。缓存恢复先真实capture并核对调用者声明的来源字段，再允许guard/renderer；失败不登记。

普通局部编辑重跑真实块窗口和inline，定义环境变化可重算远处inline而不改其raw；脚注运行时effects与语义环境版本分开。严格验证完整目标doc及所有attrs/marks。source-only输出保留必要转义，不再调用legacy relaxEscapes parse；旧默认serializer保持。

## 已有验证及准确边界

- 首实现core全量41files/905tests、host338files/4265tests；初次focused625中5失败的原日志保留，修复相关121及其后全量通过。
- 最终core补丁仅foreign no-op诊断inlineRoots一行和assertion：实际RED后相关41、类型/新tests类型/构建/安装通过；host最终installed consumer实际6。未重跑且不冒称最终HEAD重跑905/4265。
- 最终purity、空envDir Vite、Kit和旧单块browser通过。browser93bytes/一条0..5 hunk/0pageErrors，只代表已有单块回归，不代表完整UI三次切换、native或IME。
- 100/1000普通段一字改动均为实际48块规则调用、221行表读取、3次inline、1runner，fullCapture/legacyParse均0；PM发射400/4000。预处理、行表建立、原文拼接、模板复制及PM发射等仍有O(N)工作，未声称整次编辑O(1)。特殊语法无法证明边界时明确fallback，不计为局部成功。
- installed审计绑定最终双HEAD：58dist、18实际JS入口、全部声明目标/DTS/maps embeddedsource、两仓各14语料BASE/HEAD/working SHA相同，package完整bytes不变；gzip76263≤81920。
- root Svelte0errors/33warnings/16files；stdout SHA `d2ce704dda2a63df98deca0abc828bdc3b0f5bca1b865aad099a5990e8d9005e`，与已受理前阶段逐bytes一致。前后控制输入指纹 `73450eabdb47704e91ba28a373fc7f21bd43986bb9b933e584470309c2db2686`，覆盖core205/host984文件含Memory，检查期间无变更。
- 两个现有main/worktree、原untracked路径、stash/backup/非main refs/tags保持。原untracked内容没有初始逐bytes捕获，故不声称其内容逐字节已核验。

## 未隐藏的偏差与警告

有效RED覆盖新raw API、旧全文性能、定义环境和最终foreign诊断。部分replay12及扩展13首次GREEN，缺实现前独立RED；root正式接受历史流程偏差，不补造证据。编译声明、wrapper漏alt、sentinel按key顺序比较、测试fixture/URL、旧返回keys、非必要公开freeze等失败均保留原记录并修复。

安装曾误用core cwd，被入口断言拒绝且未改安装；另一次running工具返回误被caller判为错误，随后只轮询同session至exit0，没有重复安装或隐去真实失败。完整61项实施门槛的argv/cwd/time/actual与expectedexit/stdout/stderr/toolinitial-session-final均索引保存。

Task审查C0I0M5、spec✅/qualityApproved。M1历史RED偏差；M2KaTeX测试doctype；M3既有Svelte组件警告；M4混合import/chunk提示；M5localhost/CSS/AsyncTaskManager异步资源与teardown噪声。M5未有同条件baseline逐日志对照，不能笼统称故意stderr或已证全同旧因。所有Minor交唯一whole-range审查，不静默删除。

## 最终审查

唯一whole-range审查Ready/Yes，Critical0/Important0/Minor5、新finding0；M1–M5逐项复核为非阻断，无需finalfix。完整读回测试记录、生成产物及root类型/指纹证据，未重复套件。归档地址及SHA在下节补充；后续完整功能仍待实现。

## Rulings I made

Ruling: §12.4“只重新解析发生变化的块”区分raw写集、block语法闭包和inline环境闭包；稳定普通改字必须真实局部，新增/删除定义导致引用语义变化可重算受影响inline而不重写未触碰raw — 引用环境会改变远处显示，仅按raw touched解析会错误 — 若把此解释扩大成任意全文重算则违反性能意图，故100/1000普通字改≤3根、普通结构≤5根必须成功，fallback如实单列不能代替局部，I7与一字一hunk仍硬门槛。

Ruling: F1由一个私有verified source factory接管列表阶段prepareListAuthority，不并存两套recapture；cache/replay重新绑定同代list/fence/token/PM occurrence事实 — 新管线必须同时保证性能和旧来源权限，不能等最终parse才恢复导致合法foreign提前拒绝 — 若漏验证来源维度会错误授权，要求合法clone正例、全metadata篡改负例、guard前spy及失败cache不登记。

Ruling: 当前计划只交付file parser/cache/raw API，后续bindings→同一raw/nativehistory→Kit/Source/UI→E1/E4按依赖推进，不将尚不存在adapter作为F1前置 — 避免旧候选history/Kit依赖环，当前闭包可以独立用公开core API验证 — 若误称完整编辑体验会遗漏§12.4 UI/IME要求，报告须明确未完成状态并保持总任务持续。

Ruling: 保留已受理旧session缺失layout.lists的兼容正例：缺失必须触发一次真实完整capture并采用本次实际lists，caller已提供lists则逐项严格校验；其他来源/fence/R1维度和时序不放宽 — SourceLayout.lists本来是optional观察字段，T2明确支持missing且本计划要求回归不退化，“全部维度”指校验已声明来源不能猜造权威 — 若把缺失误当空数组或允许已给伪facts，会错误授权；要求missing正常Rich操作与renderer前tamper负例同时通过，并如实计cache-miss工作。

Ruling: 精确扩大core测试allowlist加入src/__tests__/source-fidelity.spec.ts，仅迁移旧成功结果exact keys断言并验证新file/work合同；source-reference.spec.ts内同类迁移保持原行为断言 — 冻结公开合同已新增optional file且实际mutation填充，旧只允许ok/session的keys检查与本轮明确API相冲突 — 若借迁移删除原文/revision/权限校验会遮蔽退化，故只动返回形状并补新字段语义，原625项失败保留，修后相关门槛重新验证。

Ruling: 接受Task1 replay初始12例与扩展13例缺少实现前独立RED的历史流程偏差，明确保留Minor M1；不事后重造或声称已补RED，不降低当前功能断言、I7/§12.4或最终审查门槛 — 新raw API及旧全文性能已有有效行为RED，replay后28例/14语料重复发射和完整回归提供当前正确性证据；缓存隔离不变量在未缓存的旧管线上也可能成立，不能强行制造旧版失败来补顺序 — 代价是这些测试未证明曾捕获实现前缺陷，仍有测试先后偏差及回归敏感度的不确定性，正式报告与唯一whole-range必须列出供复核。

## 证据归档

归档：`src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-13/file-environment/file-environment-evidence.tar.gz`。SHA256 `5e859f8e9dad229a798b7e3df69bfddb2999979dbb543c640f730943ee8d228b`，8109389 bytes；4145 raw文件加manifest共4146 entries，全部逐bytes/SHA回读通过。manifest SHA256 `a17085d236f84f919366649f327e57082036b47e7c9ec1f31711c2c027846d29`。仅排除本计划S1-browser-cache的360项，清单保存在manifest；archive命令/工具metadata及收尾提交/清理证据邻接保存。
