# 自然顶层块来源与局部输出验证

2026-10-13。N1/N2及唯一最终修复均已验收。**本报告不表示完整I7、网页/桌面协作或新版本发布完成**。生产消费者仍未开启；P2 v6.1013.2已发布，不重复实施或发布。

本计划提供实际parser token.map与handler emission的自然root/gap/synthetic来源，capture-only单首BOM，精确单字优先、稳定自然块mark/inline/multi-step局部渲染，以及实际reference规则消费的不可见原文保护。没有整篇canonical后过滤格式diff；默认parseMarkdown/Async/serializeMarkdown和schema语义不变。

## 源码与验证

- Core范围 `4a67ebbff738d00f4761da2ab2acb106b48c8e2c..b5602875ad4805b844d476cb9df8d98d5d3b3a22`：Task1 `1af55743`；Task2产品 `e92a494b`、test-only公开shape `0566f16e`；唯一最终R1修复 `b5602875`。每次产品源码和必要dist同提交。
- Host产品范围 `da208c0f5dd13680e1b43d8bbdfb35472334b411..a7136c292024f95c22256ff6a2ee60a5c302b66b`：Task2 `e919d98a`（两测试及必要lock元数据）；R1 `a7136c29`（一个安装版测试文件）。随后root文档收口不计为产品范围。
- 最终R1 core focused182/8files，full443/29files，tsc/tsup全exit0；host focused31/3files、full4142/330files，purity14生产文件、Vite/Kit构建与实际Chromium gate全exit0。此前N1 full362、N2 full398及其后test-only30项shape回归各自保留，不将新增测试倒算进旧full。
- 最终安装依赖Svelte check exit0，0errors/33warnings/16files；stdout SHA256 `8b01347630acee12475bf48d37d9909d6f6004b2e77fbe912e25134956c41551` 与本计划修复前及已验证前次archive日志逐字相同。检查前后852host+130core已跟踪source/config及HEAD零变化；两个snapshot的枚举范围由root-final-verify.py固定，不与旧882/128枚举数混同。
- 两仓各一个原main worktree，原7未跟踪项列表、3精确stash及force-pull backup `b4d139e05fd0ba67ea3efea83171c408ce1bdd8e` 保持；没有新branch/worktree/install/push/tag/npm发布。只证明受管动作/列表保持，不冒称全部原untracked内容逐hash。

58个tracked dist的committed/built/installed逐SHA全等；index.js SHA256 **`e5036029c2ff7f2970e90954464a69c0e76d00d24d3519fc8f446759ed812a0b`**，gzip **52,749≤81,920bytes**。20个DTS闭包15个相对引用都在committed blobs；最终hash声明`markdown-Dp-_6v9A.d.ts`，精准纳入并只删本计划旧孤儿。4份最终fix map嵌入的core源码与committed source一致。两仓committed manifest SHA256 `7a86e35b0d25fe5c74ef16374b26554396c7f0fc6343b37739cce0051877946d`，全部14fixedfixtures逐bytes/SHA验证含CRLF/BOM。

prosemirror-transform既有1.12.0提升为直接peer/dev并tsup external，host lock仅同步实际peer关系。host direct/state/core真实解析同一包且Step prototype一致；没有下载升级或bundle第二份。

实际Chromium gate仅证明旧批准的Kit单块opt-in：三轮既有行为、一字93bytes/单hunk[0,5)、semantic拒绝/exact ack/default行为及0pageErrors。OUTPUT/CACHE显式指向本计划目录。它不证明新自然块API生产接入、14语料完整UI切换或Source/nativehistory/系统IME通过。

## 审查与R1最终修复

Task1独立spec compliant/quality Approved C0/I0；Task2同样通过。唯一strongest全范围审查在core0566f16e/hoste919d98a上C0/I0/M1；M1为既有验证日志噪声。随后root只读capture研究引出新R1，并以真实安装包复现：列表和引用块内仅给Alpha加strong，结果ok:true且doc.eq:true，却删除unused `[ref]: /url`。完整输入/脚本/输出/指纹保留；不能用语义等价作为不可见原文的保护证明。

唯一统一最终fix从实际reference block rule成功non-silent返回处记录startLine→最终state.line，使用normalize后缓存的物理lineStarts投回SourceTrace/rawRange；不看env差异、不以最大探看行、不regex猜定义。覆盖duplicate、多行、title rollback、EOF、BOM/CRLF/loneCR及nested容器marker。SourceSession/capture新增冻结protectedSources，root-render前和所有真实source edits独立检查不可覆盖；有序区间二分查询。两原反例先RED后GREEN，邻owner/exact正例、多根原子失败和44项actualreference回归均通过。

当前含nested definition的覆盖性root-render明确拒绝，不会默删；未来保留片段renderer仍必做。唯一scoped复审已通过：R1 ADDRESSED，修复新增C0/I0/M0，out-of-scope None；没有第二次broadreview或第二fix wave。

## 保留的失败、警告与后续

所有原始失败保留：N2第一次test提取语法错误不算能力RED；首次tsc发现structure DTS不公开，worker当时错误继续full的事实保留，最终只读交叉类型断言后tsc成功。R1 title-garbage多行mark正例被既有terminal hardbreak语义拒绝，范围probe证明并非保护区间扩大；最终单行rollback正例与原多行metadata/exact测试通过。R1一次stage被ignore拒绝后精准DTS提交；两CRLF断言长度误写14→实际字符串length15后GREEN。这些不被改写为产品能力失败或已修复hardbreak。

Core KaTeX quirks；host Svelte、localhost CSS ECONNREFUSED/happy-dom AsyncTaskManager关闭输出；Vite PURE、静态/动态import和chunk警告均保留。确切异步噪声因果未独立证明，不声称本轮新增、修好或日志pristine。

未采纳研究/草稿一并归档：capture-only runs/全空文件/list-tail/terminal hardbreak；结构lineage/separator/protected pieces；Rich唯一PMhistory rawpayload/CAS/ABA；table header-only/布局持久语义；Source DOM真实消费点；E4旧已核验archive选取的研究引用。草稿不是已实现能力。

继续必做：空段与hardbreak来源合同、结构/属性命令与raw envelope、未使用引用片段保留、原块字节级undo/redo、Source rawbuffer/DOM/native菜单/局部解析/IME、Kit多块/CDR出口、annotation owner保护、网页E1–E3与桌面E4、13类真实三轮切换/保存重开/提交及统一发布。旧免费Worker10msCPU遗留未在本计划解决。

## Rulings I made

以下逐字保留本计划ledger全部裁决及代价，按发生顺序：

- Ruling: 本计划只实施已有自然块边界稳定的局部输出，完整结构/属性、history、Source与两端仍继续必做 — 已有普通段落exact门槛已通过，先让真实mark/list/table/literal操作走最小局部renderer并严证I7，不先造全语法细粒度映射 — 若边界不够会在明确结构反例拒绝，不能把本计划GREEN冒充完整编辑交付；未知gap/attrs保持拒绝并纳入后续门槛。

- Ruling: N2按实际标准Step类证明范围/结构并将既有prosemirror-transform1.12.0声明为直接peer/dev且external — 实际addMark跨paragraph产生Nsteps，逐step全doc验证会重复前缀扫描；同inline-parent closedReplace和标准mark可严证中间结构稳定后最终一次校验 — 若解析到不同副本会prototype拒绝，故同既有state解析包建local入口、明确peer/lock并核对installedhost同包身份，不下载升级、不bundled第二份。

- Ruling: Task1允许精确force-stage新生成且被声明入口引用的dist/markdown-Bnn17Tqp.d.ts — 实际roots/gaps跨entry类型使tsup拆分DTS，tracked-only规则会漏引用依赖，提交必须可独立重建/使用 — 若hash文件成为孤儿会累积产物，因此核对全部committed DTS相对specifier依赖，新hash仅按实际引用纳入并在后续build删除本轮孤儿；不泛化force-stage、不改tsup/ignore或安装。

- Ruling: N2 raw edits 拼接改为 chunks.join 一次输出 — 原草稿 candidate+= 重复增长字符串与已接受全文 trace 修复的线性拼接原则不一致，dispatch前修正正式plan/brief而不改已提交产品 — 若分段顺序实现错误会损伤 untouched bytes，因此所有已有edits重放/全attrs parse/非相邻owner字节门槛不变；不新增API或扩大权限。

- Ruling: N2局部renderer临时fragment为equals highlight与strong/em采用连续highlight外层的渲染顺序 — 真实required正例生成**==Alpha==**== beta==，markdown-it因后半delimiter紧接空格而丢highlight；仅重排临时渲染marks可表达==**Alpha** beta==，保留原意图/默认serializer — 若交叉mark组合仍不可表达会继续fail closed并暴露具体反例，须以strong/em组合及邻接范围回归证明；绝不修改base/tr.doc、attrs/schema、guard或未知raw授权。

- Ruling: N2对已exact-prototype验证的标准ReplaceStep.structure使用只读交叉类型断言 — 实际transform1.12.0运行时确有own property且false/true与toJSON一致，但DTS不公开该字段，保留原属性读取比toJSON复制slice更小 — 若依赖升级去掉该私有属性会失去structure判别，故记录实际版本/运行时合同并保留structure正反例；本轮不升级，最终strict语义/边界验证仍在。

- Ruling: 唯一finalfix增加实际reference消费区间的源码保护，并对覆盖该区间的局部root-render拒绝 — root在最终审查后用真实安装包复现list/quote内unused definition被删且doc.eq仍true，语义守卫无法保护不可见原文，不能留给未来默默丢内容 — 部分含nested定义的格式操作暂时明确拒绝，须在后续局部结构/保留片段renderer补齐，不能称完整编辑已完成；无格式过滤/regex猜定义/全篇canonical。

## 证据归档

归档：`src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-13/natural-block-source/natural-block-source-evidence.tar.gz`；SHA256 **`407bd139bba74a01c7dfa96483020e9a3f1caf65792f5a2f9fc486423ba04422`**；3567106bytes。470份原始文件+manifest共471entries全部readback逐SHA验证；包含完整stdout/stderr、tool session/finalexit、红绿失败、maps/patch、独立审查、实际安装产物、全部七条裁决、定向研究与未采纳草稿。723项derivedcache/link排除。prefix `2026-10-13-shared-editor-natural-block-source/`。正式archive及相邻verification保持；只在formaldocs提交后清理本计划ownworkspace，兄弟/旧目录不动。

下一独立计划：[共享编辑器空段来源与末硬换行](../plans/2026-10-13-shared-editor-capture-layout.md)，已完整root自审并修订采纳；其产品验证尚未执行。
