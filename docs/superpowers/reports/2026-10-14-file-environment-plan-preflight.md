# F1 正式采纳前 root 自审

候选全文及 helpers 1–18 已读；依赖研究从 structural canonical archive 逐 SHA 选取到 research-reference/file-preflight，未读取旧 workspace。列表 Task2 I1 已修复，scoped和唯一whole-range均通过；正式计划提交后冻结F1 BASE。

| 交叉关系 | 生产者 / 消费者合同 | 自审结果 |
| --- | --- | --- |
| A–B / C–D，markdown.ts | 完整实际 capture / templates、definitions、checkpoint、inline replay | 同一次实际规则，不另建 parser；B 完成不是整个 Task 完成。C 定义事件须在实际 block 阶段记录，不能从最终 env 推回 duplicate。 |
| B / E，source-file-cache.ts 与 source-fidelity.ts | 唯一 factory 与 verified authority / 三个公开入口 | 当前 prepareListAuthority 必须被统一恢复路径接管，不能并存两次 full capture；所有 revision-only spreads 需移到登记 factory 内。 |
| D / E，raw Source 与 Rich | 明确 raw patches 权限 / 真实事务授权 recipe | 公共 Source API 可编辑 definitions；Rich 不得借这个入口绕 R1。candidate parser 可共享，授权不能合并。 |
| D / 后续 bindings | actual root correspondence / 业务身份 | 本轮只出 raw 来源关系，不指定 inheritor、不按文本或 node identity 继承业务 ID。 |
| E / 当前列表 renderer | accepted marker/tight、真实 M、occurrence 位置 / conservative escaping | F1 不改 list family/style 决策，不自动插 M；保已受理回归。停止 relaxEscapes 后必须证明真实完整候选严格相等，不能删语义校验。 |
| F / host consumer | committed core dist / @moraya/core API 与本仓 PM | 一次完整真实出口、map/DTS/14fixture审计；不能以本地源码 import 代替安装消费。 |
| 单 Task 自洽 | A–F 顺序及 scope | 一个可独立验收的 file parser 管线，任何部分都不能当整体受理；UI/history 不作尚不存在的前置。所有新增 helper 为明确实现目标，非既有 API。 |

研究接缝 core096452bf：createSourceSession 仍直接 parseDocumentWithSourceCapture；MorayaMarkdownParser 构造器仍固定 md；source-only serializer 仍调用 relaxEscapes；prepareListAuthority 在 block 入口 guard 前真实恢复。此为下一计划的具体改动接缝，并非已存在 file cache 能力。最终受理core8453283c仅修列表来源优先级与逐步item重绑；上述factory/parser/serializer接缝没有改变。

正式候选必须删除过时的“table 正在实现/非渲染边界未采纳”陈述，改成真实受理的普通 html_block(M) 合同；所有旧 SHA 只能放历史证据段。新的 lexer facts、render occurrence 与 EOF 多根 join 裁决一并带入。

§12.4 原字节门槛不下降：区分 raw 写集、block 语法影响闭包与 inline 引用环境闭包；定义变化可以改变远处视图但不得重写远处 raw。正式 ledger 记录该解释及错误成本。普通段落真实局部成功为门槛，full fallback 不算局部通过，O(N) 预处理/行表/PM emission 如实计数。

后续正式执行的 tooling 仍用 next-file-tool-candidate，当前只有语法通过，不能称运行门槛成功。正式 baseline 包含列表最终 fix 与收尾文档；不得靠历史测试数或旧 gzip 推定新结果。

来源归档SHA256 `afd515035c0c2efc919633df5ed0375c6178b0c179df82716660320e6e159f89`，逐成员SHA恢复到`src-tauri/target/release-artifacts/shared-editor-source-fidelity/2026-10-13/list-producers/file-adoption-reference`。产品前置最终core8453283c、hostffb96012，收尾hostc869ee6f；执行BASE以本计划提交后OWN冻结为准。
