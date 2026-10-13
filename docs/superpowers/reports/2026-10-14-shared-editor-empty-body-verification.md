# 空正文及 Enter 保存闭包：验证记录

状态：Task1/2均独立受理；root Svelte及指纹通过，唯一whole-range终审Ready to merge Yes，C0/I0/M3，无final fix。不代表完整编辑器或发行完成。

## 精确版本与范围
- whole-plan CORE BASE 75abb5bd168fd33935a8cd692d1d63543fb1a7eb；HOST BASE c3cd5e571cd8e060bea2a49289d2109946d7e13a。
- 当前 CORE 9ccee70ff8338e22c8b8c9f02654cffa6491354d；HOST产品574fee6ce9d7e8302bc02e7b2f2062e18a5fe1a9。
- Task1 ab105742 +审查修复4c2aa6f2；HOST b4a51983。Task2 4dd04ae3 +自审补修8d7ac8b7 +审查fix1 9ccee70f；HOST05f38f8b +fix1 574fee6c。root裁定文档独立提交。
- 在两个现有main工作；未建worktree，保留原7项未跟踪文件及原stash。未push、部署或发版。

## 已实现
实际parser签发空正文位置、空cell/补齐cell、schema首段、闭合literal、frontmatter和容器真实拥有空行。普通首字采用必要语法与最窄原文补丁；Enter与结构命令沿既有结构权限保存。private缓存事实克隆和平移、source-only空段发射不改变默认legacy空行语义。

EmptyAttempt分为not-empty/unsupported/ready；真实原Step、tr.docs、完整attrs/marks、strict doc.eq与保护区精确集合保持。Task1审查发现的后步空输入绕过由全链分类修复；纯结构操作保留。空列表快捷路径、定义分隔、TAB部分展开及首行marker separator均有实际回归。

## 验证快照
| 验证 | 实际范围 |
|---|---|
| Task1 | 首实现436/14相关；fix1最终52及同runtime245分别记录，不冒称当时全量 |
| Task2首轮CORE | 48套1107项通过，类型、新测试strict、build/artifacts通过 |
| Task2首轮HOST | 340套4324项通过；installed目标97/5，purity、受控空envDir Vite、editor-kit、新测试strict通过 |
| Fix1最终 | CORE377/7、HOST100/5 covering通过；prod/newtests strict/build/committed安装闭包通过。未重跑全量或HOST build，不外推旧结果 |
| 安装 | 58 committed dist逐字节；18真实JS导入、36声明出口目标、15声明引用、19maps/96源闭包 |
| 不变输入 | 两仓package/lock完整bytes、各14fixture及manifest对冻结BASE保持 |
| gzip | 88537 bytes；旧80838，增7699约9.52%；原81920失败如实保留，root批准98304，余9767 |

Task2补修前的CORE全套于4dd04+精确marker补修工作区执行，原样提交8d7ac8后安装；HOST全套于16109717+精确四文件工作区执行，原样提交05f38f8。提交后installed closure再次核对双HEAD及完整产物。

## 失败、噪声与限制
首次CORE全套1073/1101、首次HOST全套4318/4321及所有其他RED/工具错误均归档；没有用最后绿结果抹掉早期失败。nested尾空行的两fence旧expected迁移曾获批，随后因发现partial TAB伪权限撤回并恢复旧预期。source-list-boundary仅经明确裁定调整真实sink/lift语义和有效tamper输入。

首artifact因88452>81920硬失败；Node gzip参数最终保持，早期Python默认gzip9探针不作预算依据。未改入口、导出或压缩参数规避门槛。

CORE保留KaTeX quirks warnings；HOST保留localhost:3000/editor-kit-v1.css ECONNREFUSED、异步资源/销毁噪声。Vite保留Svelte a11y、state_referenced_locally、unused CSS、Rollup PURE annotation、mixed import与chunk size警告。不能称日志pristine或全部与历史同因；由最终review按影响裁定。

结构命令仍可规范其有权修改的根内布局；普通首字精确写集不能外推结构保真。list/footnote纯空格EOF不是实际parser行，必须保留生成LF；quote EOF marker可无EOL。无新parser/生产试parse/整根serialize后diff。

partial/multi-Step marks、inline code/Critic payload与空点批注、bindings/history/Source、网页E1–E3、桌面E4、真实native/IME及统一发行仍须继续实施。未闭fence与closed-fence碰撞恢复不在本批。默认math回归不等于公式source编辑验收。

## Task2首轮全量的有界计数（对应8d7ac8）
100/1000同值；均local、1 block parse、1 top runner、0 legacy/full capture。普通rich rule48/lines233/inline3；quote66/346/3、list60/367/3、footnote58/308/3、table48/263/6、ATX45/213/3、setext46/228/3。container分别1 nested tokenize，其他0。不是全流程O(1)承诺。

## 所有裁定（ledger原顺序，含撤销及后继候选成本）



Ruling: EmptyAttempt 改为 not-empty / unsupported(reason) / ready(recipe) 三态；原目标为空但无fact或recipe不可表达必须unsupported，只有真实非空操作可走旧分派 — 原undefined同时表示不适用与拒绝，会意外进入root fallback — 成本是私有返回类型稍增，但可独立验证fail-closed；Task2及后继marks复用此边界。

Ruling: 常用空正文和Enter闭包仍是本批完整验收范围，Task1只验证首字、Task2补结构输出后统一installed — 每个Task有独立可拒绝的交付，避免一次修改全部UI — 成本是中间源码提交不可发布且dist尚旧，任务报告必须明确。

Ruling: 只准计划点名的两条empty-cell和一条top blank旧能力断言迁移；其余失败先按实际原因裁定 — 新能力应改变预期，不能批量删保护负例 — 成本为潜在追加精准裁定和审查，不以历史上限阻止正确能力。

Ruling: 保留main gzip81920门槛，当前80838，不在执行前涨预算；实际超限应携产物数据交root裁定 — 不知道实际增量时提前放宽无依据 — 成本是Task2可能需优化或明确更改预算，不能换入口或压缩参数隐瞒。

Ruling: 后继E4保持free-upload source ZIP只含批准源文件，Rust从确认origin的公开reader唯一project-data JSON严格提取manifest、不执行HTML，并核version-before/reader/ZIP/version-after项目及快照一致；legacy保留内部manifest验收 — free-upload已明确禁止往source ZIP再加manifest/reader，review-merge§13.2及§20措辞落后实际协议，现无manifest公共路由 — 成本为额外reader下载/本地解析及竞态重试；正式E4计划采用时必须同步精确修订spec，不能把当前候选裁定当已实现或降低路径/hash/未列文件安全校验。

Ruling: Task1允许仅恢复fence wrapper的原installed alternates（preserveAlternates=true），新增实际parseMarkdown/parseMarkdownAsync与source capture的paragraph后fence、list前置P后fence回归 — c488d235新增capture wrapper意外清空markdown-it原paragraph/reference/blockquote/list alternates，导致本Task批准raw被误读inline code；这是未发布前置引入的grammar回归，不是有意扩legacy语法 — 成本为当前BASE上的legacy行为发生修正，必须明确例外并核定实际grammar/类型与相关回归，不批量调整其它规则、旧tests或strict doc.eq。

Ruling: 后继bindings首次mount即定义最小adapters/render、既有DecorationHost和真实note-commands批注入口，controller接受仅对整笔准入链最终raw的pure veto；E1 owner保护可用authority初挂冻结floor=min(snapshot原批注多重集计数,初始draft计数)，抽取仍用完整base — schema中塞origin会冲突strict canonical回读，§21明确允许说明替代，旧touched草稿不能静默重写且恢复后undo必须闭合 — 成本是floor不保证逐occurrence身份（复制后删原仍剩同文一份可过），需诚实记录、测试重复/copy/delete/restore/undo/rebase，并在正式后继spec/计划采用时写明；不能让veto授来源权限或逐history中间delta错误拒绝。

Ruling: Task1精准迁移source-file-window.spec.ts中existing rich entry parses one changed paragraph locally in 100/1000 roots两条blockLinesVisited预期227→245，保持48实际规则、3inline、1runner及local/完整oracle等其余断言 — env-local三种container wrapper记录入口活动行表，在三root窗口实增18次读取，两个规模同245，未新增parser/tokenize；实际失败t1-existing-capture-cache-regressions为158通过2仅计数失败 — 成本为有界常数读取增加，须报告新实际六family计数而不能沿用nested旧数；不改其它旧测试或扩大源权限。

Ruling: Task1同两条source-file-window计数最终迁移为227→233，明确取代前条245目标；保留原245失败记录 — writer去除list/footnote未使用marker的冗余行表读取后，同输入t1-window-counter-after-minimal-reads实测100/1000均233，48规则/3inline/0nested/local不变，仅quote入口保留必要6次读取 — 成本缩至有界6次读取，仍不改其它断言或隐瞒本次旧227失败；不能将优化前245套用最终源码。

Ruling: 后继bindings候选的 installBaseline(input, options?:{policy:FilePolicy|null}) 在新controller完整构建成功后与authority原子交换policy，失败保留旧controller/policy/history；ShareEditor rebase与undo-rebase必须按目标snapshot和draft显式重建floor，省略仅沿用普通host既有policy — 原冻结closure不能跨authority复用旧批注floor，新增可变setter会模糊生命周期 — 成本为baseline接口一个可选参数及调用者的重建责任；null仅trusted宿主可传，received/URL/draft/浏览器公开API不得控制，core保护不变。此为后继候选合同，正式冻结前不宣称已实现。

Ruling: Task1 fix1精确迁移source-block-fidelity.spec.ts两处旧空正文拒绝：preserves opaque references and their synthetic paragraphs中的synthetic键X改成功且expected为`[Alpha][ref]\n\nX\n\n[ref]: /url "T"\n\nTail`，keeps serializer limitations and partial surrogate edits fail closed仅empty文件键A改成功且source为`A`；原reference/未闭fence/partial-surrogate等断言保持 — 新扩展的I1 guard回归真实281/283，两失败是本Task已批准single-step能力与旧负例冲突，不是应恢复的限制 — 成本为新增一个精确旧测试文件allowlist；保留实际失败，不称ab105全量通过，不扩多步权限或批量迁移。

Ruling: Task2 source-only renderer对list/footnote尾empty保留实际indent加终端LF，quote marker末行仍允许无EOL；纯空格EOF没有真实StateBlock行或container.map所有权，不签nested blank。空list退出测试用已安装keymap的真实命令链及HOST实际handleKeyDown — 实际markdown-it构造器跳过纯空格EOF，splitListItem对空item自身返回false并由后续keymap命令处理，不能靠假事实/假单命令期望改parser — 成本为新生成的list/footnote尾空段多一个必需LF；保持默认parser和brief独立expected，新增三条探测失败单列不冒充原Task行为RED。

Ruling: Task2仅迁移source-structure-commands.spec.ts具名closed container fence AttrStep preserves %s syntax and content的list/list-tail-lf两个expected：分别`- ```ts\n  A\n  ```\n  \r\nTail __raw__`与`- ```ts\n  A\n  \n  ```\n  \r\nTail __raw__`；quote两例及edits.every(to<=tailFrom)/doc.eq等断言不变 — actual tokenizer已拥有尾部indent空行，新source-only semantic emptyP归root body；renderer实际owned末行凭据已修ledger多余外部LF，独立t2-owned-tail-scope-green证明仅一edit止于21/22，根外CRLF和Tail逐字保持 — 成本为结构AttrStep沿既有整根权限会将该根内旧空行padding规范为两空格并采用source-only输出换行；不是普通输入权限，不授权改其它旧例或根外seam。

Ruling: Task2 nested blank分类沿既有collectBlankDrafts约定，将actual已消费的protected definition也计作分隔边界；其后第一owned blank是separator，不因definition不发PM可见child而误签leading empty — 首次全CORE1073/1101通过、28失败中已发现此真实分类缺陷，计划“可见block/leading”的简写不能取消保护定义的真实消费事实 — 成本为澄清分类输入须含既有实际保护/规则事实，不能新扫raw猜definition或批量迁移位置断言。

Ruling: 撤销并取代上一条Task2 list/list-tail-lf两个expected迁移裁定，恢复其原expected；保留该错误诊断、已批准记录与提交历史 — 新核实共享尾空行含部分TAB跨越blkIndent，真实trace会生成正文padding；observer此前仅b+t跳过整TAB误签empty权限，违反既定无TAB-generated正文授权。应以实际b/t/bs/blkIndent证明完整raw边界后才签，不得按“含TAB”一概拒绝 — 成本为此前迁移和裁定的返工，两个expected必须恢复；此前ledger重复separator修复仍须独立覆盖合法纯空格owned行，不借撤回测试掩盖其必要性。

Ruling: Task2只修source-list-boundary.spec.ts的tampered blank authority fails before serializer负例构造：当前actual nested尾已完全raw拥有，public blankLines为空，原赋[]不再构成篡改；改用另一个实际session的非空blankLines并先证明与原值不同，保留reject和serializer零调用，其它kind不变 — 真实语义调整不应让负例成为no-op，不能把合法foreign恢复改为拒绝来迎合无效fixture — 成本为一个精确测试输入迁移，拒绝要求加强而不放宽；其余sink/lift不自动获准。

Ruling: Task2允许source-only实际renderer向内部StructuralRendered/body atom传递真实末尾continuationIndent；仅结构witness触碰的左root和既有认证separator unit，在原padding按实际TAB宽度恰能完整满足新container缩进、会被收为新增semantic emptyP时，ledger可清该unit的padding并保留原EOL。只claim该separator，不扩root/保护/semantic-empty权限，不从raw猜容器或生产试parse — 真实sink将indent2改4，旧` \t`由partial-generated变完整owned，原raw必多出PM空段；独立最小候选`* A\n  * B\r\n\r\nTail __raw__\r\n`与真实tr.doc严格相等 — 成本是该结构操作需额外删除旧已认证separator的两个缩进字符；须断言唯一该padding写集、EOL与Tail不变、普通输入和未触碰seam不获权限。source-list-boundary仅此bullet sink expected迁移，ordered sink保持。

Ruling: Task2仅迁移source-list-boundary中actual nested的bullet C lift expected为`* A\n  + B\n* C\n  \r\nTail __raw__\r\n`，保留完整严格回读/字节/base与item lineage，并补edits止于原tailFrom检查 — actual完整TAB在原inner indent4确已拥有尾空P，lift后该P随C移至outer；t2-list-depth-ownership-diagnosis证明target保有它，唯一edit0..19止于原tailFrom，旧根外CRLF与Tail不变 — 成本为原结构根内空P换行/padding依source-onlyrenderer重写，不能沿旧expected丢失该P；不迁移其它list用例。

Ruling: 本批main gzip门槛由81920调整为98304（96KiB），不改入口/压缩参数/exports或其它产物门槛。root-empty-size-evidence实测旧75abb为351570原bytes/80838 gzip，新统一empty build为384249/88452 gzip（SHA44824c5eb9559aee810cd763c074449f3fabaf71ed2f9c3dd9414d6f579133f9），增7614；原artifact硬失败完整保留 — 新增必要空正文实际来源、Enter/容器保存闭包已48suite1104测试通过，原80KiB是内部阶段预算而非用户限制，删除必要能力或换入口规避不合理 — 成本为主包比已受理基线多7614 gzip bytes（约9.42%），新上限保留9852余量；后继需继承实际预算，不称此前80KiB门槛通过，最终浏览器900KiB预算不变。

Ruling: Task2精准迁移HOST source-file-environment.test.ts的installed raw API edits one sentence locally in 100/1000 roots两条blockLinesVisited 227→233；source-layout.test.ts首项仅将PM8空段键X改成功、完整expected `- A\n\nX\n\nB`并核doc.eq/窄edits，可同步改该测试标题以描述新能力。其余local/48rules/3inline/oracle/单hunk和原mark断言保持 — 首次HOST全套4318/4321仅这三旧断言失败，实际installed与Task1已裁定CORE能力一致 — 成本为补齐两处HOST消费预期和allowlist；不把失败隐藏或称首轮全套通过，不批量迁移其它测试。

Ruling: 后继inline Task1允许精确修改source-structure.ts的prepareEmptyParagraphEdits，使已认证首步空inline Replace加仅作用新内容的真实Add/RemoveMark链逐步推进原ledger；原始tr.steps/tr.docs全部保留并逐步apply核对，不截短事务、不造中间authority、不只用最终doc替代链。helper签名和single-origin/no-birth/one-final-run/claims边界保持，source-empty-body先完整验证窄链；直接helper入口也拒绝非该形状。仅此具名helper扩大文件allowlist，不改其它结构算法 — 已提交8d7ac8接口仍硬要求单Step，与候选空文件link的Replace+AddMark正例及禁止修改source-structure冲突；原advanceLedger已支持mark，不需另一placement实现 — 成本为后继新增一个既有产品文件的精确接缝与空file/blank link正例、跨旧内容mark及三旧empty多步负例；此为候选裁定，当前empty Task2范围与验收不变。

Ruling: 产物audit对working build删除的tracked hashed DTS按当前已提交HEAD验证旧blob；sync增加显式INSTALLED_CORE_BASE完整SHA（缺省冻结BASE），先验证BASE→该提交→新HEAD祖先关系和安装中该提交全部dist原bytes，再仅按该已安装提交→新HEAD的no-renames删除列表核hash并清obsolete单层hashed DTS；whole-plan BASE仍负责package/lock/corpus等不变项 — Task2 fix1产物真实失败：中途8d7ac8生成的markdown-BsDVxNKf.d.ts并不存在75abb初始BASE，旧工具把阶段基线误当所有中间文件来源 — 成本为每次同阶段再次安装须提供上一成功安装SHA并逐bytes证明；来源不符即停，未知文件保留，禁止手清或覆盖BASE掩盖失败。

Ruling: inline前置受理后、file协作UI启用前，必须补既有数学块插入/$$ InputRule与行内$x$转换的source保存闭包，并纳入真实mount/Source切换/undo矩阵；当前两Task inline候选不静默扩scope，下一步依实际完成接口冻结最小producer任务。只接现有菜单/快捷键/InputRules，不新增无现有consumer的Rich公式正文编辑UI — 固定提交审计证明math_block受现结构output guard拒绝，math_inline可能依赖整根fallback，默认KaTeX渲染不能证明§12.4/I7及§12.9；现只有通用Source可编辑公式正文 — 成本为额外必需兼容工作与真实consumer验证，在取得证据前不称完整公式支持；空math往返/原Step链及protected边界须实际RED，不广开closed-literal白名单。

Ruling: 接受唯一whole-range终审C0/I0/M3，保留KaTeX DOM环境、HOST未受控CSS网络/async teardown与Svelte/Vite各类警告为明确维护项；M3含a11y、state_referenced_locally、unused CSS、Rollup PURE annotation、mixed imports和大chunk，不统称全历史无害 — 所有Task阻断经fix1关闭，最终377/100 covering及committed安装、Svelte0errors/33warnings与前后指纹通过，未见本阶段产品阻断 — 成本是日志噪声仍可能掩盖未来回归，须在相关harness/组件及后续UI验收按实际行为处理，不压制告警；旧1107/4324全量不外推最终SHA，不冒称完整协作或发行完成。

## Root最终检查与审查
Task2首独立审查C0/I2/M3：definition相邻补分隔事实错误、definition-only提前continue漏登记，实际首字分别semantic-mismatch/unsupported-step。三个最小expected严格doc/protected均已独立证明；fix1的三个真实RED已修；追加3 cache replay与3连续输入、HOST3真实view序列。scoped两I均ADDRESSED，无新破坏。
root Svelte0errors/33warnings/16files，stdout SHA d2ce704dda2a63df98deca0abc828bdc3b0f5bca1b865aad099a5990e8d9005e；前后指纹c75d2c5a2c10f3dcb359d667c3a6d238045a449174e81a51a1f89ad1d7b79b3d，216 CORE/986 HOST源、配置、dist等绑定最终双HEAD未变。唯一whole-range终审Ready to merge Yes，C0/I0/M3；源码、生成产物、实际安装及历史裁定均已核，无final fix。

## 证据归档
本OWN已冻结待归档。正式报告在canonical归档逐member回读后记录archive/manifest SHA；归档外post-archive-closure保存正式文档提交及精确清理证据。

Fix1安装工具原失败完整保留：中途旧hashed DTS不存在初始BASE；root工具修复以current HEAD审working删除、以显式上一installed commit逐bytes验证后清已知obsolete，未覆盖冻结BASE。最终安装无unknown。

Canonical: src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-14/empty-body/empty-body-evidence.tar.gz

SHA256: 73a8feb404f33f6b650c00880bf0e1a8486258f5e64e08e935b02455d66b95b2

Manifest SHA256: df4392e111a218f3c9b366d22b847cdc59063e8c2c6e8f55814b974c9ce1075b

全部 7332 个原始文件及manifest已逐项回读，压缩包 17065875 bytes，零排除。后继候选也归档，未视为产品交付。
