# 行内格式与批注源码保真：验证记录

Task1/Task2独立审查已完成；唯一whole-range提出 I1/I2，唯一修复波已提交并完成最终类型/指纹。唯一fresh scoped复审 I1/I2 均 ADDRESSED、无新 C/I/M，阶段受理。本记录只证明producer前置，不是发行证明。

## 冻结范围
whole-plan CORE BASE9ccee70ff8338e22c8b8c9f02654cffa6491354d，HOST BASE4bfb6bcb077d2209de787a62e328448e0078d4da。
Task1 COREcd8d15ecbeef8c4850ea9c28d09836927e5b7946，fix1为205a37031d79a807ed3f478a2f4fba686444b958；HOST1cbfe3fd9db17c66d960292d51c99713256a9e13。
Task2 CORE27cfdcc1ddcbb6fef811dd571961e87d3196324c，HOSTd3129102068eef9a412ba4ca9678498e5f33a586。两个现有main，无worktree，未push/发布。
Task1的源码提交没有安装旧dist，Task2才统一构建及安装已提交产物。

## 行为与证据
- partial/跨段/跨cell/multi-Step mark、inline code、closed top-level非空fence碰撞增长；未触raw以实际occurrence保留。
- Critic选文说明和point说明增改删，空文件/空容器/缺失cell连续session链，actual source payload、definition和必要分隔符事实保留。
- 未改旧math、hardbreak、footnote仅readonly occurrence，不授内部payload/attrs写权限。精确原Step、tr.docs/apply、attrs、单代facts、protected集合及strict doc.eq保持。
- Task1初次366/10相关套，fix1最终149/5；独立审查初报cross-envelope与readonly math两Important，修复后fresh scoped均addressed。两次测试范围不混加。
- Task2最终CORE52 suites/1230 tests，HOST342 suites/4358 tests通过；严格生产/新改测试、purity、受控空envDir完整Vite、editor-kit检查通过。
- 安装58个committed dist逐bytes，18JS真实import、36exports目标、15DTS引用、19maps/97sources；两仓14fixture及manifest BASE/HEAD/working SHA、package/lock不变。
- core gzip100204 bytes，前置88537增加11667；初98304失败，root有限改为102400。最终网页share-editor900KiB仍是后继硬验收，不由core结果替代。
- 多root性能先真实失败，后将最终body校验移到整链后一次；原各step权限与两性能阈值保持并通过。

## 保留的失败与边界
CORE初全量1195/1229（34失败）包括旧patch断言和真实hardbreak/footnote/literal/性能回归；修复后1230项全通过。HOST初全量4354/4358包括四旧whole-body断言；focused再露两处已批准multi-body旧拒绝，具名迁移后4358全过。缺happy-dom首次环境失败不计产品RED，所有失败与原日志保留。
HOST真实createEditor追加步骤会插U+200B或把link展开为字面源码；测试此前只消费root，现逐真实append消费并strict对齐。此结果不是最终file UI保真体验；bindings Task3原计划过滤两个展示插件，真实mount/切模式/继续输入/undo必须另验，无事后过滤diff。
CORE KaTeX quirks、HOST Svelte状态/a11y/CSS、localhost3000 CSS ECONNREFUSED/销毁噪声、Vite PURE/mixed-import/chunk警告仍存在，不能声称日志干净或全部历史同因。
公式新建与真实InputRules保存、file bindings/history/Source、网页E1–E3、桌面E4、真实native/中日IME、主题/font/Mermaid和统一发行仍待继续。结构动作允许规范其有权触根；普通文本/行内格式没有全文或整body归一权限。首次空literal碰撞和nested fence增长不由此阶段冒称支持。


## 唯一 final fix 与最终冻结
CORE f67e8d227492e943b9ee2d3cf46003c376200aea / HOST 97880d18351180b65e7bcc07ed7b397e9a85ac62。
I1 切换 code 上下文时，仅将获权内容按实际 PM 字符确定性编码，未改变 code 上下文原 raw保持；I2 删除唯一带旧 mark 的 point时只删失去全部存活内容的 actual wrapper，终止符沿actual完整body判断。
两原 probe共4失败/1通过→5通过，额外 code块/数学词法4失败→通过；所有失败、非法测试fixture更正、runner cwd/ARTIFACT_MANIFEST工具失误完整保留，不冒充产品RED。
最终 CORE239 tests/7 suites、HOST47 tests/3 suites；production/改动test strict、build、committed安装审计通过。旧1230/4358全量只属于27cfdcc/d312910，不外推此次SHA。
最终 core gzip100503≤102400 bytes（本修复+299）；58dist、18实际JS imports、36exports、15DTS references、19maps/97sources，14项语料每仓保持，package/lock不变。
root最终Svelte0errors33warnings16files，stdout SHA d2ce704dda2a63df98deca0abc828bdc3b0f5bca1b865aad099a5990e8d9005e与修前完全相同；222CORE/988HOST前后tracked fingerprint b2d18fbdb7a84d0288dc97cdedc749efb1dc3053c18e971acc175f4d74dcab69完全相等。

已知窄缺口：仅空quote+protected definition的raw >\n> [r]: /u\n首字输入失败，独立原始打开也复现。root probe确认capturedEmptyBodies有inline fact但recipe少必要separator；独立expected >Z\n>\n> [r]: /u\n严格等于真实tr.doc。它不是I2回归，但必须在bindings前修复；已列 source-consumer-closure Task1，数学闭包为Task2。该阶段不冒称全编辑体验完成，临时negative不作为永久产品定义。

证据索引：canonical归档内 task-1-report.md / task-1-fix1-review.md、task-2-report.md / task-2-review.md、final-review.md、final-fix-report.md、final-fix-review.md、root-final-fix-verification.json，所有 gate的argv/cwd/stdout/stderr/result/tool metadata位于evidence；最终压缩归档SHA与逐member校验见下文收尾记录。

## 全部裁定（ledger时间顺序，含成本）

Ruling: Task1精确扩prepareEmptyParagraphEdits原helper以消费首步认证空Replace加仅新内容原生mark链；逐原docs/apply→advanceLedger→finish，直接helper也拒其它形状，single-origin/no-birth/one-run/claims保持 — 当前单Step断言与真实空link的Replace+AddMark冲突 — 成本为source-structure一个具名函数修改及直接helper正反验收，不截短事务或授新authority。

Ruling: Task1仅迁移两个reference多body strong旧拒绝、现名literal body replacement cannot lengthen the original fence through root rendering的closed-fence旧拒绝，以及source-empty-cache两个已点名marked分支；旧草稿fence标题已按9ccee70纠正 — 新能力使这些特定动作合法，其它fake/跨range/missing/foreign/replay/未闭fence负例仍有意义 — 成本为五个精确能力分支expected变化，需独立raw/edits/protected和serializer零调用断言，不能整例删或批量迁移。

Ruling: 当前empty最终接口按9ccee70的leftSeparator事实、六EmptyPlace、EmptyAttempt及完整chain认证复用；SourceEdit补removed后进入既有SourcePatch preserving入口 — 候选8d7ac8映射早于definition fix1，不能漏新字段或另造位置authority — 成本是使用已有placement而非复制实现，三种旧非空→空/删空/建空多步拒绝必须继续保留。

Ruling: 必要delimiter边界space/tab entity编码仅对实际选区格式迫使调整的边界run开放，正文与所有marks严格doc.eq；多body按实际source occurrence联合原子提交 — 部分取消strong仍须保留未选空格的strong语义 — 成本是必要边界raw编码变化，不能扩大到其它字或serializer全文diff。

Ruling: Task1 source/types提交后dist不安装；Task2 Critic独立RED后统一full/build/committed安装/真实HOST验证，root最终Svelte与指纹一次 — 每Task独立可审交付，同时避免重复发布级构建 — 成本是Task1新增HOST用例暂不能用旧installed证明通过，报告明确待Task2。

Ruling: math已有插入/InputRules的source兼容在本批后单独冻结最小producer任务，进入file协作UI前必须闭合；不新增当前无consumer的公式正文UI — §12.4/12.9实际要求现有功能，而默认KaTeX渲染/roundtrip不能证明source保存 — 成本为明确后续任务，不把本批相邻math raw保留冒称全公式支持。

Ruling: 继承前置final M1 KaTeX、M2 CSS网络/async teardown、M3 Svelte/Vite各类别到最终triage；不为让本批日志安静扩大修改或压制stderr — 它们仍为真实未解决维护项，与本批source实现有不同验证范围 — 成本是保留诊断噪声，后继UI/相关组件验收仍须实际证明，不统称无害历史。

Ruling: 后继数学兼容区分ordinary行内转换与真实结构插入：$x$转换须走窄inline recipe保同根__Keep__等未触字节；math_block造成段拆分可沿已批准结构ledger/已触根renderer，允许该根内必要规范化，但严格doc.eq（含前导空格）、原Step/protected/根外raw保持 — §12.4允许触碰块序列化，既定Enter/结构合同也如此；不应为数学块另建精确结构slice系统或暗中收紧全部已验证结构能力 — 成本是结构动作根内格式可能规范，报告需诚实分列；不能据此给普通行内输入整根权限。本条为后继候选澄清，不改当前inline Task1实现范围。

Ruling: 部分取消strong的冻结expected更正为 `> __Alpha&#32;__&#66;eta。\n`，保留原下划线，只在真实delimiter边界必要时编码相邻Unicode scalar；取代此前“只允许space/tab”的限制 — root独立installed探针证明原expected与仅换**均无法strict doc.eq，而补偿B为entity可保持原文及strong范围 — 成本是被选边界字符raw表示发生必要变化；须确定性lexical规则、entity/surrogate原子边界及无必要不编码反例，不得生产parse重试或整body规范化。

Ruling: source-reference中两个参数的“marks the complete reference-covered body atomically”仅outside跨Alpha/Tail分支迁移成功；source-nested-producer中真实toggleMark预期改为Alpha端点两次窄插入，跨Alpha/Tail测试改成功 — 新窄多body能力使这些原动作合法，root已核实际旧测试，outside并非部分reference格式 — 成本是精确新增旧用例迁移；完整raw仅Alpha/Tail加**、definition/protected与base不变，其余假Step/attrs/跨prefix反例保留。

Ruling: source-body-producer两参数组中仅原始 `~~~~text\n甲\n~~~~\n` 分支新增成功，插入体为换行+~~~~+换行时完整expected为 `~~~~~text\n\n~~~~\n\n~~~~~\n`，全体为甲+换行+~~~~+换行时为 `~~~~~text\n甲\n~~~~\n\n~~~~~\n` — root独立installed parser已对实际目标PM验证strict eq，属于本Task已批准closed-fence增长 — 成本为最多三处必要marker/body edit；spy零调用、base不变保留，frontmatter/HTML负例不改。

Ruling: 允许非空同body原生closed Replace生成hardbreak(isInline:true)，维持已有source-only softbreak正例；空leaf插入、对旧无映射atom施mark及跨quote-prefix替换仍拒绝 — 旧“hardbreak leaf仍拒绝”需限定空体权限，不能把认证非空替换误拒绝 — 成本是inline recipe增加精确新softbreak生成，不授一般atom或结构权限；原attrs、全部Step和strict doc.eq照常验证。

Ruling: source-structure-commands原getLines/skipSpaces三个apply参数改为Parameters<typeof get/skip>的精确tuple类型 — 新严格测试配置揭示原any[]签名不符，与运行语义无关 — 成本仅类型擦除，不放宽strict或改断言。新补真实InputRules首次GREEN按GREEN如实记录，不为追补RED复制或回写旧产品源码。

Ruling: Task1 fix1补实际token→PM的未改inline atom完整occurrence保留事实，首先闭合审查复现的math_inline；仍只允许原Step未触、节点及marks/attrs严格不变的raw保留，不给math新建/内部编辑权限 — 冻结计划已承诺未参与变化atom raw保留，不能用未来数学Task免除当前缺口 — 成本是将后继math的只读旧occurrence capture前移，clone/replay/同代认证必须一起覆盖，后继复用而非重复实现；未认证atom/实际碰触atom继续整体拒绝。

Ruling: Task1 fix1 I1包含code与strong真实交叉的必要envelope处理，先单一focused实际命令RED，保留code词法不透明性，将其它mark放外层并仅拆必要code occurrence — code为本Task已允许family，I1是跨mark闭包而非仅em/strong；不处理会留下同一缺陷 — 成本为必要旧code边界变化，正文原bytes及strict doc.eq保持；不得扩大到code payload编辑权限或完整serializer。root-code-crossing-expected已证原backtick包Alpha Beta、对Beta Gamma加strong的固定输出为backtick包Alpha空格后紧接strong包backtick Beta和空格Gamma（完整字面见probe），后继covering只按改动范围。

Ruling: Task2允许精确修改source-structure.ts的prepareEmptyParagraphEdits，仅新增已认证空paragraph首步closed单note_anchor leaf插入的原链准入；不开放其它leaf/atom，所有原prototype/docs/apply/ledger/single-origin/no-birth/one-run/claims约束保持 — Task1为拒绝未知leaf加入text-only guard，Task2明定空文件/布局空段点批注positive必经此helper，仅改source-empty-body会被直接拒绝 — 成本是一个具名helper精确扩展并加直接正反例；该分支须仅单步、canonical真实note_anchor且marks/attrs完整验证，无后续mark扩权，hardbreak/math/缺fact/先删空再插入等旧拒绝保持。

Ruling: Task2删除唯一point造成其既有nested paragraph变空时，允许除actual point syntax外额外移除一个由actual container blank observer已判为“between-body separator”的必要raw区间；仅限真实closed单leaf删除、原body仅该point、其它body/attrs/marks不变，复用私有同代事实/clone/replay/finalizer — 插入曾为非空body建立separator，删除仅syntax会令该separator成为额外source-only空段，root独立installed已证目标raw应为 > A\n>\n>，原候选 > A\n>\n>\n> strict不等 — 成本为必要separator raw删除；只能来自真实已消费且无PM正文的reserved blank，不能扫描raw猜前缀或删已有empty paragraph/definition/body字节，不整root重渲染、无history第二账本或生产parse重试。此条精确取代nested point-only删除“仅syntax”的冲突句；table补齐pipe仍保留，其它删除语义不变。

Ruling: HOST source-inline-producer.test.ts允许仅新增首行Vitest happy-dom环境声明，Task2新annotation suite同样使用实际DOM环境 — HOST默认node，原消费者测试缺directive导致document未定义，类型通过不能发现此环境缺口 — 成本为精确已有测试文件首行变更，原断言不改；首次环境失败保留且不算行为RED，必须新label以正确环境重跑。

Ruling: Task2 point-only paragraph单leaf删除同样必须覆盖带末尾EOL的普通文档，不以去掉fixture EOL或改为负例规避。允许消费已认证top-level paragraph Root的terminal：tokenType paragraph_open、PM范围恰该paragraph、actual body/point syntax终点与root.tailFrom对齐、tailFrom..sourceTo恰一个完整真实EOL时，仅随唯一point被删除而删除该terminal — root独立探针证明保留该LF会多造empty paragraph，删除terminal保持strict目标 — 成本是body原拥有的终止换行被必要移除，BOM/邻接roots/原有blank bytes保持；不删除根外换行，不拆CRLF，非唯一point或普通内容编辑不获此权限。根首/中/末尾三个位置与BOM+CRLF独立expected见root-point-only-root-layout-expected。

Ruling: definition邻接仅在actual touchesDefinition reserved skip分支证明无PM正文的separator可登记body/真实protected definition关系，允许本次point-only删除按已证空段规则消费必要separator；定义区间本身不可删除、改变或搬运，只接受原protected精确平移 — root-point-only-terminal-expected证明 >{>>原注<<}\n>\n> [r]: /u\n 的实际删除目标可由 >\n> [r]: /u\n 表达，无需改definition — 成本为前一条“无法证明则拒绝”中的事实支持扩展；不是一律允许删除definition周边空白，definition在前已成功的只删syntax行为不得退化，不得枚举parse候选；每个新增关系需同代/clone/replay认证及相反边界反例。

Ruling: Task2当前唯一writer修复全量暴露的Task1接缝退化，保留所有旧positive：未选hardbreak（含source-only terminal与连续terminal）/footnote_reference沿actual token及已有terminal capture认证完整只读occurrence，实际触碰未授权atom仍拒绝；新增canonical hardbreak(isInline:false)仅恢复旧真实closed Replace插入；literal *乙*等真实新文本在候选解析前由确定性词法选有限escaped inline recipe — 全量t2-aggregate-core-full实证34失败，不能用only专项GREEN或把旧positive改拒绝交付 — 成本是本Task聚合范围承接原Task1未覆盖兼容，在既有markdown/source-inline-recipe/source-fidelity内最小修复；不新建parser/公开authority，不exact失败后parse另一候选，不整body/root normalize，不广开atom属性编辑。

Ruling: source-block-fidelity仅迁移具名模式/patch粒度断言：14个renders only the changed natural root全部fragment-render，独立完整expected为原raw的Alpha换成**Alpha**，精确两端insert、原changedRoots/根外bytes保留；12/24/48/80/160 multi-root的edits从count改2*count并核每root两端insert；maps each step非相邻案例从2改精确3条（Long替换、C两端**），完整原raw expected不变；3个continuous equals highlight案例fragment-render、两端窄insert，完整expected分别保留raw其余字节且Alpha变**Alpha**、*Alpha*、***Alpha***，替代原whole-root edit边界断言 — 新局部producer比旧root-render更窄，旧算法形状断言已失效 — 成本仅具名更强raw/edits断言，不削弱ok/doc.eq、base不变或保护；multi-root原inspectedTopChildren<=count*12+32和wholeDocumentComparisons<=1保持，先实际运行再判断性能，不按猜测重构。

Ruling: source-block-fidelity的does not gain syntax intent案例必须保持literal星号文本、无marks，允许模式从root-render迁移fragment-render并加完整raw \*乙\*加原双LF Tail；keeps serializer limitations的terminal hardbreak插入positive保持原A反斜线LF字面，不改其其它unclosed/empty/surrogate负例 — 原能力不能因新分派退化 — 成本是确定性新片段转义/terminal hardbreak生成，不能改变目标PM。

Ruling: source-document-capture仅maps actual text marks while keeping inline code opaque用例迁移：真实code正文具有TextSourceSpan，明确核覆盖code四字符而不含backtick；该用例allowed mark追加code，旧标题相应更正，其它legacy hook/opaque/fake断言不动 — Task1已正式提供actual code正文capture — 成本为旧opaque能力断言更新，不让delimiter或未映射正文获权。

Ruling: source-terminal-hardbreak原6个邻文字格式positive保持并改为窄raw保留：consecutive三例mode fragment-render，完整expected只A换**A**、两端insert；EOL/blank三例仍完整raw仅A换**A**，核旧tail及blank bytes保留，替代“单edit.text含root tail”的旧形状断言。末例原nested definition+A硬换行只因root-render保护而拒绝，现若actual atom只读+preserving path完备则迁移唯一positive，独立expected > [ref]: /url\n>\n> **A**  \n，并核protected精确平移/定义原bytes；同例public serializer原输出不改 — 新窄能力不触定义，拒绝依据已不适用 — 成本是精确迁移最后这一分支；其它定义/跨range拒绝保持，不给整个protected root重渲染权限。

Ruling: Task2恢复已存在nested consecutive-hardbreak正例时，允许captureInlineEmission对actual无generated getLines SourceTrace登记从首raw piece到末raw piece的正文envelope；piece间真实container前缀/缩进gap只能按既有retained gaps逐字节保留，不因此得到可写TextSourceSpan或跨prefix Replace权限 — 原 - A反斜线LF两个空格反斜线LF 的实际getLines去indent导致trace不连续，旧contiguous-only body缺失使原positive无法进入新recipe — 成本是一个精确body捕获范围扩展；只用实际trace片段，不扫描/猜容器前缀，generated padding继续拒绝，hardbreak atom仅实际syntax至LF，不连带下行indent。原跨quote-prefix/hardbreak Replace与generated/atomic拆分反例原样回归，所有edits和protected须继续证明。

Ruling: 依据t2-aggregate-migration-perf真实RED，Task2把对全部body的sameMarkup/content-size/最终children+marks核验移到原Step链处理完成后一次，移除每step对每个body反复base.doc.resolve/after.resolve；每步原生prototype、完整docs/apply、同parent/inline原range与合法Step限定不变，任何candidate前仍完整最终核验所有受影响关系 — 实测24/48/80/160 roots访问1165/4645/12869/51349，原阈值320/608/992/1952被明显突破；这些获准原生mark/closed同parent Replace本身不修改ancestor，重复全body检查无额外权限价值 — 成本为校验时机改变而非校验省略；必须保留中途不支持Step、伪docs、跨parent、attrs、混合事务原子失败反例，性能两阈值保持原值，再以12/24/48/80/160原测试实证修复。不新增公开authority或只凭最终doc授权。

Ruling: source-block-fidelity三处既有StepMap.getMap().ranges运行断言允许精确交叉类型声明readonly ranges:number[]，仅消除新纳入strict时的TS2339 — 当前实际运行有ranges而依赖d.ts未公开；三个原断言已在GREEN证明运行形状 — 成本仅类型擦除，不改配置/运行逻辑/断言，不扩大其它文件改动。

Ruling: 本阶段 core main gzip 局部预算从98304调整为102400 bytes（100 KiB），主spec share-editor最终900 KiB硬门槛不变 — 实际全exports同参数产物100204，1230项全量通过；只读审查三处重复候选均属独立权限/capture闭包且无足够低风险删减，不为1900 bytes差额引入重构或删校验 — 成本为局部预算增加4096 bytes、当前较前置88537增加11667 bytes；原超限证据保留，不代表最终网页bundle已达标。

Ruling: Task1 installed empty toolbar测试改为applyTransaction取得真实root+append完整有序链，逐笔交producer并strict对齐对应tr.doc；原输入command raw expected及原Step数不变，另以独立常量核既有插件追加后的完整raw和最终view doc.eq — 实际8失败来自测试仅处理root，原插件会插U+200B或展开link为字面源码，非schema差异；真实append均已证明可保存 — 成本为明确本批只证明producer消费真实步骤，不把带U+200B/escaped link的legacy编辑器当作最终file协作体验；后继bindings工厂必须隔离展示性doc变形并验收原raw不被光标/selection改写。不得删插件、滤字节或放松eq来让本测试假通过。

Ruling: HOST source-block-fidelity.test.ts四处旧root/whole-body edits预期迁移到实际窄delimiter插入；governed Target为17/23、table Target为16/22、reference Alpha为17/22或18/23，两端text均**；table补完整原raw仅Target加bold的独立expected — CORE对应窄producer已受理，旧单edit不是用户行为约束，实际raw保持更严格 — 成本仅旧expected精确更新，changedRoots/proposal/原完整raw/protected/base不变与原跨range负例暂保持；如后续原负例因已批准多body能力不再适用，必须具名报告，不能静默放宽。HOST该测试文件加入Task2精确allowlist。

Ruling: HOST source-block-fidelity.test.ts两例reference-covered owner中原cross Alpha/Tail AddMark旧拒绝改成功；list完整raw为 - [ref]: /url\n\n  **Alpha**\n\n**Tail**，四插入17/22/24/28；quote为 > [ref]: /url\n>\n> **Alpha**\n\n**Tail**，四插入18/23/25/29，text均**；明确changedRoots[0,1]、protected原集合严格全等、doc.eq(cross.doc)、base原bytes不变 — 与此前CORE source-reference具名迁移同一已批准多body能力，旧拒绝被首patch断言遮住并非真实保护边界 — 成本仅两已失效negative迁移，不修改实际跨parent Replace/definition触碰/伪Step等有意义的反例。

Ruling: final I1允许仅对真实code mark添加/移除实际覆盖的文本片段，按原PM字符和目标code词法确定性重编码必要payload；未改code上下文/未选正文继续保原raw，delimiter/padding仍用既有事实和工具 — 三个实际toggleMark的独立expected均可strict表达，单保raw会改变entity/escape含义并被semantic-mismatch拒绝 — 成本是选区内必要entity/escape/空白表示变化，不是整body格式归一；原Step/atomic/surrogate/跨prefix权限与最终strict不放宽，无第二parser/试parse/serialize后diff。

Ruling: final I2允许point叶真实删除时一并删除因此不再覆盖任何存活内容的actual enclosing mark wrapper，并以该完整actual正文边界核原root自有terminal EOL；有存活邻字的wrapper必须保留 — 旧syntax-only规则对唯一带strong point删除会遗留水平线，独立空串expected严格等于目标doc — 成本仅失去覆盖内容的原wrapper及既有合法终止符删除，不按raw邻接猜delimiter，不授一般atom/结构权限；nested/cell/protected/同代事实与失败原子性保持。

Ruling: 按Superpowers执行唯一final fix wave处理I1/I2，M1–M3按final报告继续具名deferred；修后只做一次fresh scoped review与root最终类型/指纹，不再重开whole-range — 最终审查已完成全部范围且提出两可定位功能缺口 — 成本是修订后全量证据仍注明旧27cfdcc/d312910，只以相应covering/新构建安装证明补丁，不把旧全量外推新SHA。

Ruling: final I1 changedCode→plain 的实际字符编码包含块起始 #/列表/hr 与 $ 数学词法，沿相同已授权 code mark 移除范围确定性转义；不能把移除 code 后相同字面字符误解析为新节点 — writer 四个独立 expected 先 strict 相等、原实现 4/4 semantic-mismatch — 成本仅选中 payload 必要编码，未改上下文保持 raw，不授数学创建权限。

Ruling: 本 final fix 不扩展 definition-only 空体 capture/materialization；原始单独打开 >\n> [r]: /u\n 同样拒绝首字，已证不是 I2 删除的回归。I2 仍须删除后完整 raw/protected/doc.eq 正例；后继输入失败单列未完成 — 原 empty-cache 正例覆盖 heading-before-definition、多余 blank 和 definition-before-empty，未覆盖这一个首 blank 形状 — 成本为当前阶段暂有该已知限制，root 明确新增 bindings 前的空体前置 Task，修复并验证连续输入、replay/protected后才能交付；不能以负例永久定义为用户不支持的操作。

## 最终审查结论
唯一whole-range C0/I2/M3，唯一fix wave后唯一scoped审查两Important均关闭，无新增问题；原M1–M3继续具名维护。最终双SHA的源码producer受理，完整协作与发行继续，不在此阶段停工。

## Canonical证据归档
- archive: /Users/bruce/git/mdeditor/src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-14/inline-annotations/inline-annotations-evidence.tar.gz
- archiveBytes: 16096698
- archiveSha256: 044d54948ea0afaa4fcf95eb0069cac953a9871883a98b1eee00f2659f5dbf90
- manifestSha256: f4082d8c5f783d0263596a28563303f9428b8d38bc31a26c0c94b4412f9045b4
- rawFiles: 6750
- rawBytes: 53826362
- verifiedMembers: 6751

每一raw member SHA/bytes及MANIFEST已全部回读核验；收尾命令与tool metadata位于同目录post-archive-closure，避免归档时改变源日志。

收尾已完成：canonical逐member回读后，39项后继输入按archive/manifest/member SHA提取到source-consumer-closure；仅删除本阶段own的6750文件、53826362 bytes，sibling目录元数据保持。收尾文档提交22d3359e0a644e9ad92ecabe1fff9a3c2811bf7b；该SHA是文档记录，不是产品发行。精确清理证据见post-archive-closure/evidence/own-cleanup-verified。
