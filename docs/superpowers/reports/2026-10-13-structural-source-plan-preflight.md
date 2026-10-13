# 结构来源计划 root 自审

2026-10-13。完整阅读 428 行候选、已提交 core f62d4dcf 的 source-fidelity 实际稳定路径、既有访问计数测试、capture-layout 的真实执行脚本与 master §12.4。不派额外 plan-reviewer；未运行拟议实现。正式计划 `../plans/2026-10-13-shared-editor-structural-source.md` 的依赖须前置 whole-range 受理后冻结。

| 生产者 → 消费者 | 自审问题 | 已接入的修订 |
| --- | --- | --- |
| actual standard mark/inline Replace → N2 | 候选让稳定快路也逐 step replay+whole eq，将重新引入 S×N，现有 Node.child spy 未必覆盖 Fragment.eq 扫描 | 保留现 actual prototype/range/tr.docs 局部归纳+最终一次 roots 检查；只结构慢路 replay。12/24/48 原计数保留、补 80/160 与 Fragment.eq 风险；保存固定输入/BASE/hash 两实现各一次比较 |
| BlankLineUnit → 结构删除与 baseline | 删除最后自然 root 后，保留一个 empty 的 PM 语义与保留其原 LF 不可同时成立（LF 会重新生成 baseline+empty） | 唯一 typed baseline-conversion：实际删除 witness 指定 surviving child 与恰一 unit，整 EOL 原子消费；绝不借此删 separator/BOM/definition/普通空段 |
| 原 tail/blank → serializer generated pieces | 候选 EOL 方向尚未冻结 | 新语法生成 LF，原 kept raw EOL 不改，不对字符串全局换行替换；混合风格成本明确登记 |
| ledger windows → recipe claims | 泛 Span 混淆 raw UTF-16、PM位置与 child索引 | 分 RawSpan/PmSpan/ChildRange，helper signature 及每字段来源明确；不增加通用树框架 |
| source-structure → source-fidelity | 候选复用私有错误/renderer 没规定模块边界，可能 runtime 环依赖或为测试导出内部入口 | SourceSession type-only import；内部专用 known error，由 source-fidelity 映射；生产 callback 传 renderer，不 root-export、不复制第三套 serializer |
| 前置脚本 → 新计划 | 候选直接在 capture-layout workspace 运行，会跨计划读写旧证据 | 新独立 structural-source workspace，自含所有脚本，archive 验 SHA 后显式挑选研究；前置归档后才 dispatch |
| core commit → host 安装 | 前置同步脚本实际 cp working dist，虽最终 audit 已证与 committed 同值，但不符合候选更强“只安装 committed”措辞 | 新脚本预读全部 committed blob、逐 built byte核验，然后仅写 blob；精确 --no-renames hashed DTS 删除，不清未知项 |
| Task1 helpers → Task2 commands | 候选 Task1 引入 wrap/list/table imports但本任务不支持 ReplaceAround | Task1只 split/join，Task2 imports移至真正消费文件，publicAPI+actual executeEditorCommand 不变 |
| gate script names → recorder | 候选依赖共用门槛不自含，容易猜不存在脚本 | 从实际 L2 command.json 核对 purity/check/build/browser argv，实际使用 check-share-merge-purity.mjs；完整 toolchains 与失败停止下游约束自含 |
| captured protected definitions → structure renderer | unused definition 丢失不能由 doc.eq 捕捉，已有 R1 必须持续有效 | 不先撤 pre-serializer 与最终 edit guard；本计划只原样 kept top-level definitions，nested fragment producer仍明确后续 |
| subset GREEN → 完整交付 | 相邻 list/fence/table layout/Source与history/file环境/两端仍未接线 | 不将 fail-closed 子集冒充完成；总体 checklist 保持未完成，随后连续实施、统一验收发版 |

本计划开始时必须把以下决定逐字写入其自己的 progress.md；这里不代表已执行或已通过：

Ruling: 真实结构删除导致最后 surviving empty 成为 rawless baseline 时，允许 typed baseline-conversion 恰消费其原完整 blank unit — capture 的 k个EOL→baseline+k 合同使原unit全留与目标PM空段数量不可同时成立，角色变化由实际删除step/最终child/unit三者证明 — 若错误授权会丢空白原字节，故例外仅恰一unit、完整CRLF、明确witness，separator/BOM/protected和其他未触碰空段不受权；固定字节fixture与strict重捕获门槛保留。
Ruling: 本轮所有新生成语法EOL固定LF，原kept raw EOL逐字保留 — 既有source serializer生成LF，局部生成不等于对原件换行归一，缺少逐语法piece事实时全字符串替换会改literal内容 — 编辑过的结构可能形成混合换行；这是有限生成策略的成本，不允许重写未触碰root/tail/blank，后续若继承风格需另证piece合同。
Ruling: 稳定N2不增加逐step replay/whole-doc.eq，结构慢路才做完整chain replay — actual标准step与局部ownership归纳已支持稳定路径，候选额外比较将破坏此前长mark性能门槛 — 不能由此声称接受任意被外部篡改的transaction对象；未知prototype继续拒绝，实际tr.docs局部与最终ownership核验保留，结构chain负例和稳定访问/Fragment.eq计数补证。

未证事项：详细 ledger 算法需要实现者按真实 PM 步骤 TDD 证明；source-only whitespace/fence 回调尚未实测；布局权限模型不能凭最终 eq 反授权。若 RED 暴露合同缺陷，root 按 master 决定最小修订并记裁决，不悄悄削减必过案例。
