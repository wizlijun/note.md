# 结构来源事务验证报告

2026-10-13。本报告仅受理共享编辑器的 source-only 结构来源切片。完整网页与桌面协作、Source/native history、IME 和统一发行继续推进，未标记完成。

## 范围与提交

| 仓库 | 完整计划 BASE | 最终产品 HEAD |
| --- | --- | --- |
| moraya-core | f62d4dcfa32e21d019f0f3fe9703c3d4aa6d8c39 | 7ec5d621f195f7a389774dd355aa240420972c8c |
| mdeditor | f5c51b871698441654cbb3bd48287969e28cf493 | 440e7302a545fd24b0a7173cc2d9c092a8434dbc |

Task1 初次 core5a09c768/host816913fb；fix1 core590b8061/host17e531c1。Task2 初次 core759de039/host768e9ede；fix1 corec488d235/host58ba3064。唯一 whole-range 审查指出 separator 左邻 mark/Attr 遮住右邻结构删除的权限；唯一统一 final fix core7ec5d621/host440e7302 后，唯一 scoped 复审确认 I1 ADDRESSED，无新增 C/I/M。两任务和最终修复均有独立 spec+quality 结论。没有重开第二次广审。

实现保留真实标准步骤的来源账本、blank/baseline 消费权限、未触碰原字节与严格全 attrs/marks 重捕获；source-only 渲染支持实际容器步骤、软换行、mark delimiter/code padding、闭 fence 容器前缀与 schema 填充段落。未闭 fence 用实际 parser 调用事实绑定最终 SourceRoot；unknown 不默认闭合。R1 不可见引用的两道保护继续保留。

## 最终证明

- core focused 218、full 625；host focused 59、full 4204；core tsc/build、host purity/Vite/Kit build/旧单块 browser regression 均 exit0。
- index gzip 62934 bytes，cap81920；index SHA256 `99d1a98773267bec9f36e9c579821a0a6f3d83297eccb6147498048529e5cad0`，map `c4042b984b7e6b6bbcd7d6409a61b1ccab1a9e2a25a1611e3d8ca807fbbd038c`。
- 58 committed/installed dist、14 固定字节语料、原审计15 DTS引用、78 embedded sources 逐 SHA通过。补充实际导出审计：18 JS imports、36现存JS/DTS目标、16 DTS相对边、19 maps；JS相对边0。
- **全部声明导出目标闭包未通过**：既有 `./style -> dist/style.css` 在整个计划 BASE 和最终 HEAD 都缺失，README仍承诺该导入。ROOT-FINAL-exports exit1原失败保留；ROOT-FFIX-exports exit0只表示现存JS/DTS检查通过，`allDeclaredExportTargetsPresent=false`。I-B1列后续 SDK 契约与统一发行必修，未造空CSS或暗删出口。
- root 新HEAD必要 Svelte复验0 errors/33 warnings/16 files；stdout SHA256 `8b01347630acee12475bf48d37d9909d6f6004b2e77fbe912e25134956c41551`。before/after 195core+942host tracked src/scripts/dist/buildconfig文件和HEAD不变，combined SHA256 `71096ec1dd07339458b18df1d755dda8d5f6229cd96a05961c10a49ca341dd8e`。旧ROOT-FINAL组保留，不能拿旧HEAD证明最终代码。
- 10k-root/100-mark相同输入的单次观察：Task1 BASE76.124792ms→77.545708ms；Task2 BASE82.274875ms→78.7065ms。不是最终blob重测，也不是通用性能保证；结构慢路O(S×N)成本如实保留。

## 失败、限制与保全

原Task1 diff-check exit2后helper未throw却误提交c26041d7，worker在root消息到达前仅删测试EOF空行amend成816913fb；两版本metadata/patch与准确时序归档，不宣称完全遵循流程。Task2部分直接只读/编写调用仅有会话记录，不能补造独立metadata；所有RED/验证/stage/install/commit/audit均有raw/tool记录。final fix前置argparse错误、frozen-audit NUL解析错误和audit自包含计数错误均保留，后两项发生在已完成产品提交之后，修审计脚本另名复验，不覆盖失败。

KaTeX、Svelte/Vite、localhost CSS连接与happy-dom关闭警告保留；Svelte输出历史SHA一致不证明所有stderr因果归属。sourceRoot fence事实有对象/同bundle亲和性；foreign/clone Session恢复authority属于后续file环境任务。task checked、相邻lists、fence EOF、nested definitions、table layout与共享file/history/Source/两端UI继续必做，具体拒绝不冒充最终交付。

真实Rich隔离fixture已验证table/code快捷键、slash/context菜单与全局hover，0 page/console errors；仅证明fixture可用，非本片新语法全部UI验证、native或人工IME。旧单块Kit browser仅该场景回归。原7untracked、3stash、backupref和两仓唯一main worktree按状态/refs核对；未声称原untracked payload逐byte保全。

完整raw证据归档到 `src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-13/structural-source/structural-source-evidence.tar.gz`，manifest逐项字节/SHA回读。仅明确排除Vite缓存和隔离Chromium profile；归档执行metadata及最终archive SHA在相邻archive-verification.json，避免自包含。报告编写时归档尚未执行，以该文件实际成功结果为准。

## 全部裁决（逐字保留）

Ruling: 真实结构删除导致最后 surviving empty 成为 rawless baseline 时，允许 typed baseline-conversion 恰消费其原完整 blank unit — capture 的 k个EOL→baseline+k 合同使原unit全留与目标PM空段数量不可同时成立，角色变化由实际删除step/最终child/unit三者证明 — 若错误授权会丢空白原字节，故例外仅恰一unit、完整CRLF、明确witness，separator/BOM/protected和其他未触碰空段不受权；固定字节fixture与strict重捕获门槛保留。

Ruling: 本轮所有新生成语法EOL固定LF，原kept raw EOL逐字保留 — 既有source serializer生成LF，局部生成不等于对原件换行归一，缺少逐语法piece事实时全字符串替换会改literal内容 — 编辑过的结构可能形成混合换行；这是有限生成策略的成本，不允许重写未触碰root/tail/blank，后续若继承风格需另证piece合同。

Ruling: 稳定N2不增加逐step replay/whole-doc.eq，结构慢路才做完整chain replay — actual标准step与局部ownership归纳已支持稳定路径，候选额外比较将破坏此前长mark性能门槛 — 不能由此声称接受任意被外部篡改的transaction对象；未知prototype继续拒绝，实际tr.docs局部与最终ownership核验保留，结构chain负例和稳定访问/Fragment.eq计数补证。

Ruling: host误提交已在root消息到达前仅删测试EOF空行并amend成816913fb，保留该最终HEAD且不再改写或人为还原历史，另将旧c26041d7完整commit metadata/patch与失败时序纳入证据归档 — 两提交仅EOF空白差异、尚未发布，额外历史操作不能追回已发生的流程违例，最终diff-check/独立审查与committed产物闭包仍必须通过 — 若时序或差异描述不实会掩盖未验证代码，故必须以原始tool/raw与两commit精确diff证明，旧失败不得由后续exit0覆盖，也不宣称流程完全遵守。

Ruling: Task2实际checked任务列表在当前capture中返回unsupported-source时保留明确原子拒绝，列后续task-list capture/producer必过任务；isInline:true hardbreak允许仅source-only回调输出LF，heading真实setNodeMarkup旧负例转正，未闭fence仍须stable与结构路径共同拒绝 — 本任务允许source-only局部表达而禁止重做capture/default语义，真实RED区分了serializer缺口与capture缺口，不能把误接受自动补闭算通过 — 若错误冻结范围会遗漏常用协作能力，故所有暂拒case必须进入后续验收，普通space/tab/单strong/em/highlight与真实softbreak正例不可降级，总体I7/两端仍未完成。

Ruling: 相邻strong/em及code两端空白先实测source-only备选delimiter与原生code-padding；仍需新上下文producer设计的组合可本Task具体fail-closed但不得称Markdown不可表达 — 当前一次输出失败只证明现serializer不足，brief允许未证mark组合列后续而不允许删除marks/放宽eq — 若误判会把可修缺陷永久化，故须保留所试具体表达、strict全部attrs结果，并将未解producer登记为完整交付前必做项。

Ruling: Task2覆盖继续放source-structure-commands.spec.ts而不为brief文件清单改source-structure.spec.ts；部分只读/编写命令仅有会话记录的缺口如实受理并归档已有证据，不重跑或补造原metadata — 独立审查未发现覆盖落点导致行为遗漏，所有RED/验证/stage/commit/install/audit已有完整raw/tool闭包，凑路径或事后制造证据不能提升实际证明 — 若原始证据范围判断错误会遗漏未验证行为，故最终review保留M2/M3及精确commandaudit，后续writer全部新verification仍严格录制，不能宣称本轮每个工具调用均独立归档。

Ruling: I1修复允许仅capture模式观测实际fence规则唯一getLines消费并用返回state.line判closed，Token事实绑定最终实际SourceRoot内部WeakMap，两个pre-render入口据此拒绝触碰未闭fence的root — split-write修复已实证暴露nestedunclosed误补闭，现顶层regexguard不能证明容器内闭合，实际规则调用事实可避免复制grammar/剥容器/影子parse且不改公开Session或PM attrs — 若闭合或对象绑定推断错误会自动补闭原文或误拒合法编辑，故必须验证唯一实际调用、token/map、最终root身份、unknown不默认closed、finally原descriptor恢复，nested/top/尾LF及legacy回归全部保留，R1两道guard和所有attrs严格比较不动。

Ruling: source-only list_item仅checked为null、首个真实空paragraph且第二child为code_block的schema填充形状，可省略该首空paragraph的Markdown输出，剩余children仍走既有renderer — 实际parser对code-first列表自动补该首段，而原serializer写空列表后分离code，I1闭fence列表修改无法回读；规范候选直接code-first已strict等价，不必改schema/default列表算法 — 若把带attrs/marks的真实首段误当填充会丢语义，故条件或strict负例必须覆盖这些差异，最终实际capture恢复同一完整PM空段/allattrs/marks；checked/其它形状/legacy/外部blank与原tail不获新删除权限，未闭fence仍由实际事实guard拒绝。

Ruling: 将前条source-only list_item首段省略条件从第二child恰code_block修订为第二child非paragraph，其他条件仍是checked===null、首段真正空且schema默认attrs/marks、childCount>1；剩余children仍走原renderer，目标PM与strict实际capture不变 — 实证list→quote→closedfence遭同一schema首段填充错误，按第二child逐类型追加特判更复杂且不能解决容器闭literal合同；schema-local首paragraph约束配最终strict重建给出统一有限表达 — 若自定义schema不补首段或该非paragraph语法不可表示，将strict原子拒绝而不能抹attrs；须补两种容器排列、非literal heading或nestedlist正例，以及第二paragraph/nondefaultattrs/marks/checked/非空首段不适用的边界，不改变legacy或相邻列表marker合同。此条覆盖前条第二child类型限制，前条原始决策与失败证据仍保留。

Ruling: 本结构切片保留原有悬空的@moraya/core/style导出为明确baseline缺口，补审现存全部JS/DTS/实际import时仅列此经BASE字节证明的唯一缺项并保持all-export闭包false，后续SDK产物/文档契约与统一发行盘点必须处理 — 整planBASE和当前HEAD均无任何trackedCSS，host实际源码/插件/scripts未直接消费该出口，当前没有可据实打包的CSS源，空占位或擅删出口都是猜测/额外兼容性改变 — 若延后影响未审的动态或外部SDK消费者会仍报模块不存在，故报告必须明列README43的错误承诺、完整failedgate/knownGap，不声称全导出通过，完整交付/统一发版前追到真实样式来源并作明确修复或兼容裁决，不能静默漏发。

Ruling: 唯一finalfix修改了tsconfig实际include的宿主TypeScript测试输入，root在新双HEAD上补一次命名ROOT-FFIX的Svelte与before/after指纹必要复验，保留原ROOT-FINAL整组，不把旧检查冒充新代码证明 — 先前唯一检查在c488/58ba通过，最终I1修复与新host回归是在其后发生，最终类型安全优先于“单次调用”字面计数；这不是额外广审或无变化重复suite — 若错误认为新输入不影响类型会漏交不可编译代码，故复验绑定7ec5d621/440e7302实际最终产物且不覆旧日志；只有后续真实修复再次改变相关输入/失败时才另裁必要复验，不声称整个plan仅执行过一次svelte-check。

归档完成：SHA256 `d897e5eafbc3b02c98a1c8bf6953dd8a01643ffefb3f4b9933b0aa1b22f762c5`，5279943 bytes，1485 raw + manifest / 1486 entries 全部回读校验通过；明确排除 4581 个缓存文件。上述归档内formal-report为归档前快照，本附记和archive执行toolmetadata在canonical相邻文件独立留证。
