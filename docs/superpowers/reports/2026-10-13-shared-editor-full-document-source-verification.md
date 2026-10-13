# 完整文件来源与局部文字事务验证

2026-10-13。本计划三任务及唯一最终统一修复均已验收；**这不是完整I7、网页/桌面协作或新版本发布完成证明**。生产消费者仍未开启。P2 v6.1013.2已经正式发布，本轮不重复发布P2。

产品范围：共享纯EOL投影；同实际parser的math/smartquote/EOL/NUL来源trace；整文件raw保持与稀疏顶层段落text映射；单text ReplaceStep精确splice；14固定raw语料与真实installed core→propose句界。默认canonical API不变，特殊块内部编辑、格式/结构/history/SourceDOM与Kit多块继续后续计划。

## 源码与验证

- Core范围 `cafc03894cbc68294a01fafda118d59c61265eda..4a67ebbff738d00f4761da2ab2acb106b48c8e2c`，含EOL、整篇capture、backticks修正、full-doc单字事务与最终性能修复。源码与tracked dist同commit。
- Host产品范围 `299c2a5b34966da0f532d839b0d02988cf874cdd..fbbece090986be1982453eded442d47230d74432`，含browser命令路径修正、固定语料/merge测试和单个CRLF fixture的.gitattributes -text例外；随后正式文档提交不改变产品范围。
- 最终core focused80、full341/26files、tsc与tsup全部exit0；新安装依赖下host focused23、full4134/329files、purity14productionfiles、Vite/Kit构建与真Chromium gate全部exit0。Svelte最终exit0，0errors/33warnings/16files，完整日志SHA与此前相同 `8b01347630acee12475bf48d37d9909d6f6004b2e77fbe912e25134956c41551`。此前root包装漏记exitmetadata的旧记录仍保留，不能倒填为成功exit。
- root最终门禁前后828host+125core源文件SHA及HEAD零变化。原7未跟踪项、3精确stash、force-pull backup `b4d139e05fd0ba67ea3efea83171c408ce1bdd8e`、两仓各一个原main worktree保持；仅核对列表/受管动作范围，不冒称对全部原untracked逐内容hash。无新branch/worktree、npm发布、push或tag。

57个dist文件committed/built/installed逐SHA全等，root `407862b61cf1aa484e4237b922012b7d5c1d1afbedd5b798c48ef94e00f1e6f9`，gzip48,882≤81,920bytes。19maps中69个core源码条目与committed source一致；第三方sources单列。两仓manifest+14fixtures的committed blobs全等且符合固定SHA/bytes，包含CRLF。修正前host归一化错误blob反例保留，未扩大merge expected。

真浏览器Chromium140.0.7339.16/Node23.10.0仅证明既有Kit单块三次往返零diff，一字93bytes、恰1hunk[0,5)、semantic拒绝/exact ack/default行为、0pageErrors。installed root SHA如上；Vite转换响应SHA是另一产物，不能声称与root文件字节相同。Core14语料reopen不冒充14类完整UI切换。

## 审查与性能修复

Task1独立审查通过；Task2初审unclosed-backticks I1经5项真实RED→GREEN及scoped复审关闭；Task3独立审查通过。唯一最终whole-range审查C0/I1/M0：完整capture重复扫描trace、PMcursor、逐run doc前缀，当前单字事务同步触发。一次统一修复 `4a67ebb` 后唯一scoped复审I1ADDRESSED、直接新增C0/I0/M0；没有重复整体审查。

修复采用二分/前进trace游标、真实parser frame累计tail大小、一次PM文本索引关联有序runs、join仅对最后存活token写来源。完整独立PM/raw验证及allattrs/marks严格重解析没有移除。两项确定性访问增长反例先RED后GREEN；组合math/quotes/NUL/CRLF和长entity/escape join保留真实单字/spans回归。

最初规模JSON未保留输入源码，只作为风险证据。本轮另存完整生成脚本/输入SHA/环境，immutable fd01db4与4a67ebb各对500/1500/3000段LF/CRLF一次测量。3000段、约135/141KB的捕获由433/498ms降到21/23ms，单字事务由442/480ms降到26/21ms；全部canonicalEq、exact splice、transactionDocEq及重建span独立PM校验通过。这是单环境一次佐证，不是毫秒产品合同。首次仅peer模块解析失败、零case，原log保留；调整到同core peers后成功一次，无新包安装或反复追数值。

## 保留的警告与未完成范围

Core KaTeX quirks；host happy-dom CSS localhost fetch/AsyncTaskManager关闭输出（新增/既有归因未建立）；Svelte a11y/state_referenced_locally/unusedCSS；Rollup PURE注释、静态/动态import混用与chunk体积警告均保留。全测试通过不表示日志pristine。

下一计划是[自然顶层块来源与局部输出](../plans/2026-10-13-shared-editor-natural-block-source.md)。其后仍须完成结构/属性命令、精确保留源码history、Source raw buffer/DOM/IME/native菜单、Kit多块与CDR出口、网页E1–E3及桌面E4、全部13类真实三次切换及保存/重开/提交、CSP/SRI/平台门槛和统一发布。先前免费Worker10msCPU遗留并未在本轮解决。原pergrammar精细映射草稿仅归档参考，未采纳实施。

## Rulings I made

以下逐字保留本计划ledger全部裁决及代价，按发生顺序：

- Ruling: 本计划先验收完整文件原文与顶层段落局部文字，特殊语法内部、格式历史和Source界面连续另行实施 — 已验证简单来源捕获，需要先把多段与预处理链的未知分开否证；用户完整两端目标及I7保持 — 若边界过窄会增加审查次数，因此每个计划保留全部剩余交付清单，不能据14语料core门槛声称完整UI已交付。

- Ruling: 后续语法计划在fidelity专用工作trace删除且仅删除一个开头BOM，raw与默认canonical/EOL API保持原样 — 实测BOM会使ATX/frontmatter/fence类型错误，桌面既有读入本就消耗BOM；保留raw后需保持正常语法语义 — fidelity doc将有意区别legacy parseMarkdown(raw)，因此增加明确测试且未来Kit opt-in必须以同schema session.doc materialize，不能忽略全部attrs绕过；当前三Task不改该语义。

- Ruling: Task2补实际newline规则的已知行尾U+0020消费trace，不将整个pending普通文本降为opaque — 新增3RED表明newline在pushPending前裁空格，root已核对实际newline.mjs；仅更新对应已知runs/partiallinear trace并委托原规则 — 若私有规则改变可能失配，因此前后普通字同时测且契约不符failclosed，不引入最终字符串diff或通用框架。

- Ruling: 下一正式计划优先自然顶层块ownership与已触碰块局部renderer，不先扩大所有语法内部exact textspan — 实际mark/list/table局部序列化可经严格全文重解析证明I7，普通段落1字仍走现有exactsplice；每种已触碰tablecell的内部空格保留不是用户新增要求，KISS更直接通向全功能 — 若自然块边界不足会在结构/依赖gate暴露，因此未知gap/attrs仍拒绝、结构反例明确后续必修，不能降低I7或把边界稳定子集称完整交付；已写syntaxdraft仅归档参考不实施。

- Ruling: Task2两个Minor保留且不扩改测试DOM或重做既有提交 — KaTeX同类告警在前一正式报告明确既有，新增测试增加出现次数；stage非零原因及最终精确dist已可见并无缺产物 — 输出仍有噪声可能遮盖新问题，所以保留完整日志/当前49次计数且最终验收分开报告，不声称pristine。

- Ruling: Task3浏览器命令补显式当前计划OUTPUT/CACHE环境路径 — root核对既有harness默认仍指向已归档删除的前一workspace，原plan省略这两个env会错误重建旧目录；只修正式plan/brief命令，不改产品脚本 — 若遗漏路径会污染历史证据，因此运行后同时确认旧workspace未重建；保留既有同一harness验收范围。

- Ruling: Task3允许host .gitattributes仅fixed crlf.md精确-text例外并amend本轮未交付hostcommit — 实际Git全局text=auto/eol=lf把working原始CRLF规范为LF，破坏独立clone固定raw corpus；需要版本库blob也保持相同SHA — 增加单个必要受管文件，若漏查core会仍假通过，故同时校验两repo全部14fixture+manifest committed blobs，不扩大expected/mergekernel且保留反例SHA。

- Ruling: 最终审查 I1 在继续自然块能力前统一修复全部重复前缀扫描 — 当前单字 API 已同步整文档重捕获，约120KB/3000段约0.4秒且代码可证二次增长，不是未来开关风险 — 若优化私有状态过度会破坏来源守卫，因此保留独立完整验证、既有字节与语义门槛，用真实事务及有界规模证据复核，不引入固定毫秒合同。

- Ruling: 最终性能复核使用保存生成脚本和输入SHA的新有界baseline/fix对比，不声称复现最初探针同输入 — root最初scale JSON未保留输入源码，不能从bytes/spans反猜；committed fd01db4仍可作真实旧实现，在同一新明确输入各一次检查 — 原数值只能证明初始风险，不能用作精确提升倍数，新增确定性getter访问增长RED→GREEN作为主要复杂度证据，全部局限进入正式报告。

- Ruling: 下一自然块计划将已安装 prosemirror-transform 1.12.0 提升为直接peer/dev并明确tsup external — 严证标准Step类才能按范围保证结构稳定，实际core根尚无法resolve该传递包，host已有同版本直接依赖 — 若bundle或解析到另一副本会导致prototype拒绝，因此不下载/升级，记录真实路径、同包身份与独立clone manifest/lock可重建，配置改动纳入N2审查。

## 证据归档

归档：`src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-13/full-document-source/full-document-source-evidence.tar.gz`；SHA256 **`6463e6e650e698f4c829337e3ced5bf0933e04846578ec8ce18d35ca0c44f42b`**；3,965,855bytes。154个原始文件与manifest共155entries全部逐项readback验证SHA，包含完整raw日志、原始patch/maps、独立审查、失败反例、探针源码/结果、实际产物及保全证据、全部裁决、未采纳后续草稿/定向研究。717项derived cache/link排除，不把node_modules副本视作证据。相邻archive-verification.json与cleanup-verification.json记录归档及本计划own workspace清理；不删除历史正式归档或他人目录。

归档prefix `2026-10-13-shared-editor-full-document-source/`；后续计划只从此已验SHA归档选取明确研究文件，不重建或读被删除旧workspace。
