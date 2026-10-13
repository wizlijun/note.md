# 嵌套正文来源计划自审

日期：2026-10-14。计划：[nested source](../plans/2026-10-14-shared-editor-nested-source.md)。这是实现前自审，不是产品验证。源码依据 core `6585a2470f885984819f5418aa17d4400a7b9ea5`、host `dbb79b5ba24a32f2e0ccca033d0d3e1707d277e3`；前置 F1 已独立受理。

依据主规格 I7、§12.4、§12.9。用户已授权共享编辑器保真前置、继续两端协作与最终统一发行，并要求既有 main、不建 worktree。本计划只交付嵌套正文 producer 与有限局部解析，不用该范围替代后续 UI、撤销、绑定或真实输入法验收。

## 文件与接口交叉检查

| 项目 | 生产／消费接口 | 自审结果 |
|---|---|---|
| Task 1 自洽 | actual getLines trace → token facts → PM occurrence → textSpans/body authority → exact/fragment | capture 与真实消费者一起交付；保护原 Step/prototype/attrs，非仅删除 depth 限制；保留候选严格等价检查 |
| Task 2 自洽 | actual table row/slot 与 literal handler → Task 1 trace → exact/fragment | 表格以原规则成功为前提；frontmatter 用真实整正文 callback 验收，不能以模拟单字操作替代 |
| Task 3 自洽 | F1 实际 top checkpoint/window → 新 facts clone/sentinel → installed host propose | LF 支持面必须真实 local/expanded；允许明确列出的 fallback，不能将其计作局部解析；统一构建安装后才验证宿主 |
| Task 1 ↔ Task 2 | markdown.ts/source-fidelity.ts/source-content-trace.ts；body 与 trace 类型 | Task 2 只扩实际正文类型和消费投影，沿用同一权限链；private facts 不写入公开 session、不增加第二 parser |
| Task 1 ↔ Task 3 | markdown.ts/cache tests；clone/PM emission/私有 layout authority | 每次重发射重建 PM 位置；rawDelta 与 lineDelta 分开；foreign 真实重捕与失败不登记均需测试 |
| Task 2 ↔ Task 3 | table/literal facts、nested cache、installed body fixtures | sentinel 比较新增来源事实；源码 fixture 不变；host 通过已提交 dist，不能 alias core 源码假通过 |

## 裁定

Ruling: 表格保留原 markdown-it table grammar，仅在其成功后投影实际 row/slot 的 trim、escapedSplit 消费 — 避免复制整段 grammar；实际 token 内容必须严格相等 — 若错，来源映射会拒绝或错误授权，需实际 escaped pipe、重复列、补空列和嵌套表格测试发现并返工。

Ruling: 新 exact/fragment 的 protected 精确集合验证放在内部 preserving candidate 入口，登记前执行；旧结构 candidate 合同不变 — 增强新权限而不无意重定义既有结构操作 — 若边界选错，可能漏保护或拒绝合法命令，需新负例与原结构回归证明。

Ruling: 本批仅承担真实 nested/table/literal 改字及单行全正文 strong/em；inline code/math、point 属性和任意选区格式不冒称完成 — 范围依据已核实际 producer，后续 UI 启用这些操作前必须补明确能力和消费者验收 — 若下游确依赖这些操作，会增加前置任务，不得通过降级或静默禁用声称符合能力矩阵。

Ruling: Task 1/2 提交经过相关回归和类型检查的源码，Task 3 统一构建 dist 与安装验证 — 避免每个中间任务重复完整宿主发布级验证，且禁止安装陈旧 dist 宣称新能力 — 若中间源码改变构建约束，Task 3 会暴露并须修复；本批未完成前不发布。

## 验证计划与限界

新能力须保留实现前真实 RED；原不变量首次 GREEN 据实记录。每项执行保留完整命令、cwd、stdout/stderr、exit 和工具 session/final metadata，非预期失败停止依赖操作。新测试单独严格类型检查。主入口 gzip 上限 81920 字节，当前 76263；不预先放宽。两个仓库的 14 原 fixture/manifest 及 package/lock 字节不变。

每 Task 一个新 writer、一个 combined spec/quality review；唯一 whole-range strongest final，按技能固定修复上限。临时证据只写本计划 OWN；原 F1 研究和工具已从 canonical archive 验证完整 archive、manifest、每个 member SHA 后选择性恢复。当前没有新产品测试或性能结论。

Ruling: 后续 pnpm 命令均显式前置 env pnpm_config_verify_deps_before_run=false，禁止 approve-builds/install — 当前 pnpm 11 自动 depsStatusCheck 曾触发 install 后因 ignored builds 退出，测试未运行；保留环境失败并核对 package/lock 与实际依赖解析 — 若配置无效仍可能改变依赖，必须观察真实命令输出并停止，不能把环境失败计作 RED。

Ruling: Task1精准允许迁移 source-fidelity.spec.ts 的 list opaque/拒绝嵌套正文两项旧断言，以及 source-terminal-hardbreak.spec.ts 的两条 list/quote textSpans为空断言 — 新能力直接改变这些既有能力边界；替换为实际范围/原字节/doc等价与hardbreak无span，不删除安全负例 — 若迁移过宽会掩盖回归，独立review核对精确diff；其余literal opaque和protected hardbreak mark断言本Task保持。

Ruling: 授权 task-1-conflicts.md 经固定BASE核对的净能力断言迁移：source-list checked正文映射与exact；source-document-capture同parent而非depth1及quote/list；source-block-fidelity四种whole-body fragment与list exact；source-list-boundary单字保留blank/CRLF/9)以及定义旁正文exact（必须核完整protected和不进renderer）；source-file-window实际221→227读取 — 新来源快照确增加每段2次行表读，保留48规则/1runner/3inline与100对1000有界证明，不隐瞒计数 — 若扩大迁移会掩盖回归，独立review须逐项对照，本批未覆盖literal/结构/安全断言不改。

Ruling: 继续拒绝含未闭fence自然根内的新exact/fragment操作，不迁移两条unclosed拒绝用例 — 本批保持既有未闭根权限边界，不因可映射字符而隐式扩权 — 成本是这类正文仍不能Rich局部修改，可由显式Source处理；后续若要开放须独立证明完整权限。

Ruling: Task2真实frontmatter callback测试的legacy createEditor视图初值仅去开头一个BOM，source session与expected保留完整原raw/BOM/CRLF；仍先核doc相等并触发真实callback，不修改legacy全局parseMarkdown — 当前legacy raw含BOM初值与capture语义不同，file-mode初始化尚未交付且必须直接使用final schema同次capture.doc — 成本是此测试不证明原createEditor(raw含BOM)已修，后继计划必须验真实file mount首帧；初始doc.eq失败不能计consumer RED，callback路径的RED如实注明已做capture但尚未做literal权限/Step收缩，不恢复工作源码制造历史。

Ruling: Task2精准迁移3个旧测试文件中的literal能力断言：source-fidelity的fence span和Mermaid公开exact；source-document-capture仅新增code_block/frontmatter/html_block parent与实际literal span、strike_through/html_mark（inlinecode仍不映射）；source-block-fidelity仅table wholebody fragment与table/fence/frontmatter单字exact，均核完整独立raw/base不变 — 这些旧opaque/root-render预期与新增正文映射直接冲突 — 成本是旧测试期望变更，必须独立review精确diff，所有其它未知mark/atom/跨范围/未闭fence拒绝不迁移。

Ruling: Task2仅迁移source-structure-commands.spec.ts的旧自动延长围栏一例为原子拒绝/不进renderer/base不变 — 该用例实际是纯正文Replace，旧靠整根fallback扩大围栏，与新literal严格拒绝合同冲突；其它结构与getLines descriptor回归不变 — 成本为source-aware Rich暂不接受该自动延长操作（default legacy不变），已要求后继inline计划在file UI启用前以实际fence边界专用producer恢复，不能静默禁用后宣称完整能力。
