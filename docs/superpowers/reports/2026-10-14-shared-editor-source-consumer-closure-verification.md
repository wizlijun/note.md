# Source consumer closure 验证记录

状态：本阶段已受理。唯一 whole-range final 为 Ready Yes / Approved，C0I0M4；不是网页/桌面协作完成或发行记录。

## 版本和结果

CORE BASE `f67e8d227492e943b9ee2d3cf46003c376200aea` → `d0807fa278bd4cdf1724435c4262a6295b64d61e`；HOST whole BASE `22d3359e0a644e9ad92ecabe1fff9a3c2811bf7b` → product `a955cb1c1de811e6a604f3f5179b8cd5e5e2270f`。既有 main，无新 worktree。

- Task1：definition-only 空 quote/list/quote-list 首字与连续输入，保留实际 prefix/EOL、受保护定义与其它 raw；CORE `71f78ff2be04247871589515a7a5866d561d8fa8` / HOST `3572d39ef82e860a1125f281f3bf8f6a9723bed4`，374/10 CORE +55/3 HOST 覆盖、strict、build、安装检查通过，main gzip100744。独立 spec✅ / Approved C0I0M2。
- Task2：修复 insertMathBlock 的实际 schema；source-only canonical 空数学块；inline/standalone math 的真实新生成与旧完整 occurrence 保持、完整删除/替换。内部 payload/attrs/selected mark 没有新增权限；实际 witness 在 renderer 前，原始 Step/docs 链和最终 strict doc.eq 保持。
- 主实现 `4e41fd16cf8010468b1f5ff96c2d8680df906ec1` 上 CORE1336/55 全量、HOST4389/343 全量，strict/purity/空 envDir Vite/checkKit 通过。HOST 测试工作 bytes 后精确提交 `a955cb1...`。
- 自审发现自定义 schema 的非空默认 value 可误满足 hasMarkup(defaults)，新增 RED（renderer1而应0）后显式校验 actual value 为空。最终 `d0807fa...` 上 CORE267/6、HOST14/1 必要覆盖 + strict/build/重新 committed 安装通过；旧全量与 Vite 不外推为最终 SHA 重跑。
- 最终 main gzip **101857≤102400**；58 dist、36 exports、18 actual JS imports、15 DTS refs、19 maps/97 sources 全闭合；两仓各14原 fixture及manifest不变；包锁不变。安装前驱逐次为f67→71f→4e41→d080，未覆盖原阶段BASE。
- Task2独立 spec✅ / Approved C0I0M2。root最终 Svelte：0 errors、33 warnings/16 files；两仓225/989 tracked files前后相同，fingerprint `6c67495665879bdbdceab6ab39360bb57affc946175a376c6e5245ec3ece4db1`。

## 失败、诊断和界限

保留全部实际 RED/工具失败：Task1原始6/83失败与无空格3/47失败→GREEN；Task2首次14真实功能RED+1 createSchema fixture错误分列，合法fixture15/15 RED→GREEN；随后列表父schema不允许、helper跨schema、PM拟合去除非法marks/raw ReplaceStep先被schema拒绝、无效html attr no-op均如实修fixture，不能计算为额外产品RED。旧full1335/1336仅过时完整math replacement negative，具名裁定迁移后full1336成功。安装前驱audit脚本直接执行exit126后明确sh执行通过。

root先发允许仅covering消息，随即纠正冻结计划要求最终full；更正送达前writer已build/artifacts，但未stage/commit/install。旧“任何build之前”叙述不准确，保留原记录并补事实；最终按full→build→新manifest重新闭合。

已知警告不抑制：KaTeX quirks mode、nested-window指标stdout、HOST localhost editor-kit CSS ECONNREFUSED/happy-dom teardown、Svelte a11y/unused CSS、Vite mixed imports/chunk size。最终HOSTmath covering stderr为空，但全阶段输出非pristine。

非本阶段完成项：实际file slash删除组合/快捷键、同owner跨Source/Rich/history/save/reopen、native/Web/中日IME、字体主题、900KiB网页预算与正式发行。后继 bindings/history 四Task和delivery八Task继续。未进行push/Worker部署或新版应用发行。

## 本阶段所有 Ruling（保留原文及成本）

Ruling: Task1无空格空列表marker同样须支持definition邻接首字；在真实list baseline emptyInline、before恰空格、range末端与actual EOL起点相等、protected definition起点恰EOL末端且actual read.prefix存在时，允许仅为既有inline.after生成actual EOL+continuation prefix，保留原before — t1-no-space-actual-evidence已证明两独立expected strict等于目标；read.e/body与真实EOL/definition边界可完整认证，没有owned blank并不等于不能表达 — 成本是新增必要separator bytes与既有列表padding，定义原bytes保持精确平移；不扫描raw猜prefix、不改EmptyPlace公开shape、source-empty-body或结构权限。须两例真实RED→GREEN、LF/CRLF/BOM及replay/连续输入与不邻接反例；不能永久拒绝这两个已有合法shape。

Ruling: Task2示例createSchema调用更正为实际必须的config，注入new BrowserMediaResolver()并从已有browser-media-resolver子入口导入 — t2-core-red-1有一条fixture在产品producer之前即因缺config失败，实际createSchema(config:SchemaConfig)不可零参数 — 成本仅测试fixture和计划示例修正，无产品API/类型放宽；保留首次14个真实功能RED与这一环境/fixture错误分列，另名运行完整合法RED。

Ruling: Task2完成full/build/artifact后可一次精确source+dist提交，取代机械要求先source后dist两commit — 验证与committed-only安装顺序不变，单快照减少未构建中间HEAD误用 — 成本仅提交粒度变化，不减少任何gate；若先source提交仍禁止提前安装。

Ruling: source-inline-recipe.spec.ts 的 fix1 unchanged math grants no edit or selected atom mark permission 仅 replaced 分支改为具名完整occurrence替换正例；internal局部payload Replace、selected atom mark两个负例原样保留 — Task2已准许完整旧occurrence删除和原closed slice canonical新math生成，实际完整替换同时满足两者，不应为保旧能力白名单负例增加“同一步删旧并插新就拒绝”的特殊限制；root-whole-math-replacement-expected独立证明原raw Alpha $x$ Beta LF、原AddMark1..3 + Replace7..10的完整expected **Al**pha $y$ Beta LF严格等于原tr.doc — 成本是旧全atom替换从拒绝变成功，只限actual whole occurrence覆盖/新canonical slice/原链/最终strict同受理范围，无内部公式TextSourceSpan、无attrs编辑、新UI或meta授权。正例须明确完整expected、两个strong窄insert与一个wholemath窄replace、base和protected不变；未选公式raw与mixed unsupported原子失败保持。不允许据此迁移其它旧负例。

## 唯一最终审查与后继

Astra/xhigh完整审查两个Task及交互，无Critical/Important。追加唯一窄组合probe3/3：真实installed createEditor handleTextInput在definition-only quote、marker-only list、BOM/CRLF quote-list首字后触发数学，独立raw/strict/protected平移均通过，产品/index/HEAD未改。没有最终fix波或第二whole-range review。

四Minor具名延期：M1整颗inline math删除重复findIndex的静态复杂度→性能维护；M2KaTeX doctype→测试环境；M3本地CSS资源请求/teardown→宿主测试生命周期；M4Svelte/Vite诊断→宿主诊断与delivery资源预算。nested-window性能指标stdout保留为有效证据，不为减少输出改产品。

后继计划正式化：bindings/history的correspondence来源在实际私有F1调用点保证，pure helper只验形状/roots；无额外provenance服务。候选旧98304预算纠正为当前已执行102400；仅余543B，不能默增。严格测试保留ambient，安装始终核实际前驱。下一阶段详细裁定和交叉自审归其正式计划。

## Canonical 归档

- Archive: `/Users/bruce/git/mdeditor/src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-14/source-consumer-closure/source-consumer-closure-evidence.tar.gz`
- SHA-256: `fcbc0cb0af85e0d73e9137a074c2d9e2bccd95516e7e65fd28be51e08b2b71f1`
- Manifest SHA-256: `2ad379169c9ad97b3e419ed820fb5dcbb8211de6516e50c7b62ee2a200cae9aa`
- 7654 个raw文件，归档21385879bytes；全部7655成员回读验SHA通过。各gate保留实际argv/cwd/exit/stdout/stderr与tool lifecycle。
- 后续文档提交、选择性恢复与仅本OWN清理的真实命令证据在同目录 `post-archive-closure/`。下一阶段仅使用SHA验证的选定恢复成员，不读取其它/已清理SDD。
