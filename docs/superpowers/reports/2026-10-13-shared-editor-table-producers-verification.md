# 表格与代码语言 producer 验证报告

2026-10-13。表格与代码输入阶段已完成实现、独立审查和最终类型检查，已提交但未发布。完整共享编辑器保真、网页与桌面协作仍在实施。

## 范围与提交

| 仓库 | 完整计划 BASE | 当前受审 HEAD |
| --- | --- | --- |
| moraya-core | 7ec5d621f195f7a389774dd355aa240420972c8c | 042a473a8befb22230988ba2eef6685affca77a1 |
| mdeditor | 5c5bdd02438009ab885f2066ff704fcb4c9a8fe2 | 8e3c0e6365746a32aa985b72c766fb089df8af7b |

Task1 core4eb60a7d / host2306ad3a，独立 spec/quality C0I0M3。Task2 core042a473a / hostfd5b1ef3，初审遗漏 slash 注释（spec❌，C0I0M6）；注释及不实报告陈述在 hosta45d4e5f 更正，唯一 scoped 复审 M1 ADDRESSED、新 C0I0M0。原140行报告及 SHA 保留。

实现：合法 header-only table；缺省代码 language `''` 与显式 `text` 区分；quote 内 table cell 捕获不带入容器前缀；Rich 行首逐字 fence 与 inline-code 输入；schema-local 共享 GFM 表格命令，Rich/Kit/Memory 同一算法；新增行继承各列 alignment，保留已有 attrs/marks/colwidth；表内拒绝不 fall back 修改外层 list；真实 Mod+Enter 单笔结构及选择事务；整列对齐菜单复用全局 hover。Source 仅有证一对一 EOF table 的无末 EOL 来源窄修。

既有悬空 SDK `./style` 出口真正关闭：删除无产物的声明并从 sideEffects 过滤错误项，README 指明宿主样式。installed manifest 使用 committed bytes 原子替换，不改 pnpm store 硬链接。全部其余 metadata 保持，旧错误 import 明确 ERR_PACKAGE_PATH_NOT_EXPORTED。

## 验证证明与保留的原失败

- Task1 core663 / host4215；Task2 core689 / host4229，均有实际 RED/GREEN、core tsc/tsup、host purity/Vite/Kit build 与安装审计。
- 最新安装证明绑定 core042a473 / host8e3c0e63：58 committed dist、18 JS 实际导入、36 JS/DTS export targets、15 DTS 引用、19 map 关系、90 embedded source 记录；全部声明目标存在、unknownPreserved=[]；gzip64295≤81920。
- manifest SHA `023ab45bd9d712e077e143c0483965b2ecbefe4d12ab314624886497830b4195`；14 fixture×两仓的 BASE/HEAD/working bytes/SHA 不变，语料 manifest SHA `7a86e35b0d25fe5c74ef16374b26554396c7f0fc6343b37739cce0051877946d`。
- Task1 Rich6 / Kit2；Task2 Rich快捷键/slash/context三种插入与三种 alignment、独立 keyboard case、Kit2 通过，35份 flush/draft 由 installed parser 完整 PM eq/JSON 回读。Rich 一个 run 整体仍为 FAIL，三 case PASS；keyboard 另独立 run PASS，不覆盖原失败。
- Memory 新三 typed 按钮独立 Svelte0errors/0warnings 与隔离 build 通过；未安装/挂载整个插件，未发布。
- root ROOT-FINAL-svelte **真实 exit1、3errors/34warnings/18files**：新增 table-producer snapshot readonly 类型与 wikilink fixture 的旧 options/handleTextInput 签名。before/诊断after 199core+982host tracked 输入完全相同，SHA `e0e521ae86e5a8a0c8d6f819b7da0eec16f9679155a4635c26d28671ae0e82cf`。原失败完整保存；随后统一修复并在新 HEAD 通过，见下文。
- canonical 前置 Svelte stdout SHA `8b01347630acee12475bf48d37d9909d6f6004b2e77fbe912e25134956c41551` 已按归档 SHA 选取。normalized diagnostics 比对只有3errors和actions初值1warning新增，原33warning仍在；未拿历史检查代替当前代码。

## 失败与限制

所有有效行为 RED、无效 fixture RED、非预期失败及修正分别保留，不把 missing import/观察器/时序当产品行为 RED。Task1 host PM TableMap 观察器解析失败、Rich 本地 route/picker hover、paired-close/hardbreak 守卫；Task2 缺 MediaResolver、ack timeout、数组类型、旧 alignment 负例、浏览器 locator/selectionchange/完整 attrs/null-prototype 观察错误均有独立记录与后续成功。

Task2 Rich keyboard 使用80ms等待 selectionchange；不称产品修复或 native 证明。所有新验证/stage/install/commit/audit 有唯一 label、真实 argv/cwd/time/exit、stdout/stderr 与完整 tool initial/session/final；原始 root 准备路径错误及 diff-check 行尾空白失败亦保留。审查者自己的 evidence harness 失败在相应报告注明。

KaTeX quirks、CSS 网络/teardown 生命周期、既有 Svelte a11y/unusedCSS/初值、Vite 混合导入与大 chunk 是明确记录的债务；新增菜单 actions 初值告警已修复；其余债务经唯一整计划审查明确延期，不称 warning-free。当前仅 Chromium 真实组件/默认 Kit fixture；非 Source 文件模式、macOS WKWebView、原生菜单或人工 IME。

后续仍需列表/checked 完整保真、file env/cache/局部 reparse、业务 bindings、原字节 raw/native 同一 history、width seam/stable identity、完整 Source 切换、14语料三轮零diff/一字一hunk、网页 E1–E3、桌面 E4、人工 IME 与统一发行。现有 fail-closed 只是边界，不是最终用户体验。

## 最终受理

唯一整计划审查覆盖 core7ec5d621→042a473、host5c5bdd02→a45d4e5f，发现 I1/I2（共三个新增类型错误）和 M1 新菜单初值警告。统一修复提交 host8e3c0e63，父提交 c3df9113，精确三个文件、8增5删：snapshot 显式使用公开 readonly 类型、输入 fixture 按实际签名提供 defaultTransaction、菜单以 untrack 表达每次挂载能力快照。没有削弱类型、源码保真或审查标准。

唯一 scoped 复审确认 I1/I2/M1 全部 ADDRESSED、新 C0/I0/M0。最终 ROOT-FFIX-svelte exit0：0 errors /33 warnings /16 files；stdout 32425 bytes，SHA d2ce704dda2a63df98deca0abc828bdc3b0f5bca1b865aad099a5990e8d9005e；stderr 0 bytes。warning 的路径/级别/内容及重复数与前置 baseline 一致。199 core +982 host（含 Memory）before/after 指纹一致：bd523e2ae6f896316ebd59bfdc3b623c7da29660999a6fa9d1dd1045fab0810f。

修复覆盖 focused29/3files、空 envDir Vite、真实 Rich context 菜单三方向 alignment/全局 hover/关闭重开。浏览器 run-2026-10-13T11-58-54.882Z-4OyR8q 在修复 working bytes、参考 a45d4e5f 下运行；后续精确提交证明内容绑定，不冒称在 8e3c0e63 提交后再次运行过浏览器。core689/host4229、Kit及Memory既有同runtime证明沿用，未无变化重复运行。

修复期间 host 外部新增 610f6d48（最近创建文件从7至10、Rust及双日志）和 c3df9113（完成/发行证据规则）。首次 stage 因 HEAD 漂移真实失败且尚未 git add；root 核完整差异后 refreeze 为 c3df9113，新标签提交成功。两项外部更新保留，独立登记后续发行必验/必含；producer JS 验证不能证明 Rust 行为。

原7 untracked 路径、3 stash 精确SHA、backup ref、非main refs与两仓各唯一 main worktree 均核对保留；未捕获的原 untracked payload 不声称逐字节证明。所有辅助读取/观察器失败按原报告保留，不伪称产品 RED。

整计划最终无开放 C/I；M2 KaTeX、M3 CSS网络/teardown、M4既有33条Svelte、M5 Vite imports/chunks 明确延期。完整 I7、file/cache/bindings/raw history/width/native/IME/E1–E4 与统一发行仍未完成。

## Rulings I made

以下15项为本计划全部裁决原文，含原因及误判成本，按原顺序保存。

Ruling: SDK采用B撤回从未有产物的样式子路径；仅删exports[./style]并从sideEffects过滤./dist/style.css，README说明宿主CSS来源，host安装同一committed manifest且原子替换不改硬链接 — BASE到最终产品均无CSS源/产物且实际宿主自供样式，提炼926行宿主CSS会扩大API及视觉范围，空CSS不能兑现契约 — 潜在外部消费者未知，升级后该错误路径将明确ERR_PACKAGE_PATH_NOT_EXPORTED；主入口和全部真实出口必须actualimport及双UI回归，发行说明记录撤回错误出口，未来独立SDK样式需另定义真实所有权。

Ruling: 接受header-only GFM表，将table body基数+改*，不紧缩row/cell、不补伪body；TableMap/doc.check/strict Source正例一起验 — 真实GFM允许分隔行后无body，当前schema自动生成零cell body导致合法输入无效 — 旧非法负例必须转正且保留真正非法doc；若失败不能用fixTables或额外节点掩盖。

Ruling: 缺省代码语言统一空串，显式text保持text并序列化为text，toggleCodeBlock只取state.schema — 实际InputRule/Enter/Kit/Rich已产空串，parser的text与serializer抹text使真实producer不能严格回读 — legacy JSON默认与显式text输出会变，旧挂载state不批改；DOM/sync/async/source/picker与图表精确路由回归必须通过。

Ruling: 共享gfmTableCommand从root与既有commands子入口导出，Kit/Rich及已有insertTable委托，一事件一笔结构和selection事务 — 两端复制算法造成新行alignment丢失与行为分歧，schema-local命令是最少单一维护点 — 现有attrs/marks/colwidth必须保留，merged/异形拒绝，不能因Source表达不足清attrs或制造第二历史栈。

Ruling: 本计划只交付表格与语言生产/契约，width/file/cache/bindings/同一history/Source/native/人工IME/E1–E4和统一发行保持主任务必做 — 这些能力的依赖与本次可独立验证schema/commands不同，具体fail-closed不能作为最终用户体验 — 若分片边界错误会掩盖未接线能力，故报告/UI平台/原文保真与人工验收限制逐项明列，不标整体完成。

Ruling: Task1允许renderTableRow临时cell inline捕获同时保存/清空/恢复serializer delim，最终表行仍由原state.write添加真实容器前缀 — 已列T1.2要求nested quote header-only回读，实际RED显示out清空但delim保留使前缀污染cell，固定BASE1773–1804确认根因；同一markdown.ts窄修是任务闭包而非新feature — 若恢复时序错误会丢表外容器前缀或污染后续块，故quote header-only/普通body及合法列表内table严格全部attrs回读回归，不strip最终字符串、不放宽eq、不重构整renderer。

Ruling: Task1 stage allowlist增加精确src/__tests__/source-block-fidelity.spec.ts，仅将显式text→缺省空language旧拒绝改为accept并断言raw及全部attrs — S1-core-regression304/305唯一失败来自本次R2明确语义修正，其他stale/colwidth负例必须原样保留 — 若过度迁移会掩盖真正不可表达属性；禁止批量snapshot或删除负例，相关focused回归另label证明。

Ruling: Task1 TableMap结构合法性在core直接依赖用真实get验证；host只消费installed doc.check/完整attrs/source strict eq，安装blob SHA闭包将两者绑定，不为重复观察器新增或猜测host依赖 — 宿主无直接prosemirror-tables依赖，新增import、require条件与Vitest import.meta.resolve先后harness失败，不代表产品失败；TableMap只观察不参与hostproducer — 若跨链未绑定会漏已安装schema差异，故core已提交TableMap证据和host完整dist逐SHA必须一起过；保留所有failed attempts，不再尝试第三种动态解析，不把host无TableMap写为未验证表格。

Ruling: Task1授权宿主wikilink-plugin.ts及其真实plugin测试，修单backtick立即toggle吞掉行首fence输入；空paragraph行首首tick先保留字面，若紧接普通text则消费唯一待定tick并延续原inline-code输入语义，连续ticks交实际fence/Enter — Rich实机逐字输入证明doc始终空，core Enter/InputRule单测并不能代替宿主真实producer；只改首tickliteral会损坏行首inline-code，必须一起闭包 — 若延迟判别不精确会改变输入/marks/历史，故有限实际doc形状判断不新增持久状态或历史栈，保持非行首/选区/已有code关闭，实际plugin RED/GREEN和Rich逐字fence/inline输入回归；宿主runtime变化后重过必要hostfull/bundle/UI，core不重复无变化套件。

Ruling: 覆盖前条backtick“紧接普通text时消费首tick”策略，改为只在实际closing tick将paragraph前缀恰单tick+非空无tick内容转换为code mark并结束stored code；普通文字与IME输入不拦截，连续ticks保持字面供fence；code-active/非行首/选区沿旧toggle，不新增pending PluginState — 设计复核确认DOM composition可能不走handleTextInput，普通字桥接会残留首tick，而仅doc/storedMarks无法区分刚首tick与toolbar code-active；paired-close复用Markdown惯例、状态最少且最终文本/marks可严格证明 — 成本是空paragraph行首inline-code到闭delimiter才显现，接受这一有限UX变化以使真实fence可输入并避免新增IME状态机；必须在实际core inline-code-convert配套下验证fence/inline/关闭/选区/后续文字，不用plugin-alone假baseline或synthetic声称人工IME通过。旧草稿/RED与原裁决保留，未发生产品修复不伪称回滚。

Ruling: Task2 table内Tab/Shift-Tab即使共享命令返回false（首格previous、merged或非法表），也不进入外层list缩进或插空格fallback；只有明确table外才沿原list/space路径 — 候选“table内优先，否则list”易把命令拒绝误当不在table，nested table首格或merged表会因此改外层结构，违反已定无dispatch拒绝 — 成本是这些table内拒绝事件返回false由后续非结构/browser焦点处理；必须覆盖nested table首格previous和merged的真实plugin keyevent，不冒称拒绝后仍无doc变却偷偷indent列表。

Ruling: Task2允许结构recipe修正有证来源的EOF table缺省terminator：最终EOF table继承原EOF table且原无终止EOL时，剥掉renderer虚拟行LF后不再无条件生成LF — 正式add-row精确raw矩阵失败，而稳定root路径已保留原无LF尾部；固定BASE结构309–314剥后重加LF形成不一致 — 若范围过宽会吞真实content EOL/原tail，故必须actualorigins/finalindex/slots证明，EOF有无LF/CRLF/多finalnodes/birth/middle与terminalhardbreak回归保留，不全局trim或改公开table serializer，新增生产src/source-structure.ts及相关commands spec为精确allowlist。

Ruling: Task2允许host source-structure-commands.test.ts两个right/center add-row旧“unfixed producer”拒绝转真实命令/full attrs+source eq与独立raw正例，merged/colwidth等真负例保留 — 共享新行继承header alignment正是本Task明确修复，S2-host-full仅这两个旧断言失败、其余4227过，不能保留失效负例或拿局部数称full通过 — 若迁移过宽会掩盖属性丢失，故精确限定两case、原失败保留，新focused后完成必要full成功证据，不批量snapshot。

Ruling: finalfix暂存前host main并发新增610f6d48最近文件10项与c3df9113完成/发行证据约束，保留两提交并将三文件fixBASE从a45d4e5f重新冻结为c3df91132771028a005c8cde08b6061b2e1c0dc4，core不变；精确核两提交仅AGENTS/双changelog/Rust与本fix无交叉，当前index为空且三文件dirty范围未变 — 已提交的其他工作不能reset/amend或被本writer代提交，最新AGENTS约束立即采用，整个未发布更新随后统一盘点 — 若遗漏新Rust行为验证会错称其已随producer验收，故本producer wholefinal原范围保留，inbound独立登记为发行必验/必含；Svelte前端输入未受影响，不机械重跑同runtimeJS门槛，但新冻结HEAD还需必要Svelte/指纹与唯一fix scoped；原stage失败完整保留，新label重新stage，任何再次漂移即停。

Ruling: 唯一finalfix已提交host8e3c0e63，三文件含真实tsconfig测试与菜单Svelte输入变化，root在新冻结双HEAD执行ROOT-FFIX before/Svelte/after必要复验，原ROOT-FINAL 3errors/34warnings及整组指纹原样保留 — Vitest/Vite只转译不能豁免真实类型失败，最终输入的类型正确性优先于单次检查字面计数，已在全局合同允许实际fix必要复验 — 若错误沿用旧check将漏发不可类型检查的fixture或snapshot合同；故新组绑定042a473/8e3c0e63实际HEAD，只有通过并经唯一scoped才受理，不重复未变化full/core/Kit/Memory套件，不开启第二wholefinal。

## 证据归档

Canonical archive：`/Users/bruce/git/mdeditor/src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-13/table-producers/table-producers-evidence.tar.gz`。14370837 bytes，SHA256 `cfc3a1f7102da52e64be74beaffec69d99eea55d56b9d6bb5fa449cb7dfbf800`；7167 raw files + manifest，共7168 entries，全部回读逐字节/SHA核对通过。仅排除明确的cache/vite-cache和浏览器profile，共11916个缓存文件。manifest SHA `bec0384259fb366b290f563e9bd435f137678cf9f2e8aa1388e207b72771a692`。归档执行的真实argv/cwd/time/exit、stdout/stderr和tool结果独立保存在同目录，避免自包含记录。

归档内 formal-report.md 是归档前快照；本段是归档完成后的真实结果。精确清理结果由相邻 cleanup-verification.json 记录，仅限本计划工作目录；兄弟计划不动。
