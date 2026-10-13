# 列表计划 root 采纳前自审

状态：root已完整自审并采纳。表格阶段已受理并归档；正式计划提交后冻结列表执行BASE。

输入：`list-producer-pm-plan-final-candidate.md`（223 行）、`list-producer-pm-adoption-notes.md`、`list-pm-marker-lf-preflight.md`、`list-gate-tool-preparation.md`、`next-list-tool-candidate/`。原 163 行候选保留，不在执行时混用旧 zero-PM 方案。

| 配对 | root 自审结论 / 正式执行合同 |
| --- | --- |
| T1 token → 实际发射 → 最终 doc | 单次配对遍历、单次最终 doc 遍历；对象身份定位真实 list，不能把 schema 填充前 cursor 当最终位置。nested raw 包络允许包含，不授予 nested 写权限。 |
| T1 checked → tokenSources | 同步裁剪实际 runs，完整 atomic 可消费、内部不可切；无 trace 不伪造。保留识别规则，真实 checked 正例后才迁移旧拒绝。 |
| T1 ordered0 → 默认 serializer | 真正缺陷在数值 order 的 `|| 1`；字符串 `'0'` 本来 truthy。只改缺省合同，不改全局 grammar 或编造 parser 根因。 |
| T1 public metadata → T2 renderer | `SourceLayout.lists?` 观察字段兼容旧输入；新 capture 实际完整填充并绑定私有 authority。不得以公开 JSON、默认空数组或 readonly 当可信来源。 |
| T2 foreign → 既有 fence / R1 guards | 一次真实 recapture 必须在 guard 前，严格核对全部来源与 doc/schema；valid clone 成功，伪 facts 原子失败。内部恢复保持 caller revision，unchanged 返回原 caller 对象。 |
| T2 standard steps → 存活 list style | 从实际 shell/item witness 传递 marker/tight；split 继承、join 左存活、无 witness 为新生默认。不能按文字/hash/ordinal 匹配。 |
| T2 nested renderer → serializer | 实际 1.13.4 仅三参数 renderList；逐层保存/设置/恢复公开 options.tightLists，不访问私有 inTightList，不复制 renderer。 |
| 精确 M → 普通 HTML parser | 既有 noCloseToken 分支只剥一个末 LF；精确 comment PM 文本可表达，不 trim 任意空白。普通 HTML 的既有权限不扩大。 |
| T2 core 能力 → 后续 controller | 当前仅接受目标已含真实 M 的标准步骤；测试 augmentation 明示。首次 guard 前生产补 M、隐藏节点导航/marker-only/跨 M join、Source/remote/undo 不补 M 为后续硬合同。 |
| T1/T2 → future file cache | actual list token facts 随模板克隆重绑，新 emission 后重算最终 PM/root 位置；fence 同代。未来 F1 必须接管唯一恢复路径，不能叠两套 factory。 |
| source/dist → installed consumers | 现有 58 dist/18 JS 是观测，非固定数；全 HEAD dist/exports/DTS/maps/14 fixed fixtures 闭包。manifest BASE→HEAD 完整 bytes 不变，不继承 B-style 删除授权。 |
| task gates → final | 每 Task fresh writer + 唯一 spec/quality reviewer；fix 闭合才 root final Svelte/指纹，唯一 strongest whole-range；不重复无变化 suites。 |

root 已读工具候选完整代码及精确差异；静态检查是准备证据，不算正式 baseline/产品门槛。正式工具须按 canonical archive SHA 选取到下一 own；已受理表格改动与 source-only EOF table/no-language 契约必须保留。

正式计划还需补齐：全局约束与共享 §2A/§2B 接口合同作为每个 task brief 的配套文件、两个 Task 的精确 stage allowlist/实际 focused 路径、使用空 envDir 的 programmatic Vite 命令、baseline preservation 清单、当前实际 BASE 与归档输入 provenance。新增类型只作为 source-layout 内部模块可导出类型及 SourceSession 可达声明，不新增 root 生产函数/任意 setter。

完整 I7、局部 file reparse、同一 raw/native history、width、两端协作与统一发布仍未交付；候选采纳不改变主任务的验收标准。

实际旧checked负例已只读定位：core src/__tests__/source-structure-commands.spec.ts:69–74 同时断言createSourceSession任务列表unsupported与真实wrapInTaskList拒绝；host src/editor-kit-v2/source-structure-commands.test.ts:85–87 真实Kit任务列表拒绝。T1 checkbox capture正例交付后，如实际命令已成功，精确将这两case转独立raw/fullattrs正例并保留其他负例。未来T1 stage allowlist须包含这两个精确文件，不等fullsuite失败后才发现，亦不提前把T2风格能力假称已实现。

实际schema bullet_list无attrs、ordered_list仅order；1.13.4 renderList确按typeof tight !== undefined优先读attrs。已核candidate拒绝非同style已有tight的条件与当前依赖一致，不以删除attrs强行套词法风格。M末LF接口由固定parser源码解除，运行时矩阵仍由T2做。

正式采纳补充：共用合同/§2A/§2B置于Task之前并原文复制common-execution.md；Task brief只含自身要求。T1只产真实metadata，foreign恢复属于T2，修正候选release报告跨Task误要求。root收尾补宿主双语Unreleased，执行者不改版本/发布。现有9个focused路径已实际存在；新增两spec按Task创建。工具与候选从canonical cfc3a1f7102da52e64be74beaffec69d99eea55d56b9d6bb5fa449cb7dfbf800 按manifest逐SHA选择，非旧workspace读取。
