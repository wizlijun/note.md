# Empty body plan preflight

规格是主分享 spec §12.4/I7、§12.9；本计划只交付 source-only 空正文闭包，不把局部完成替代完整网页/桌面/native/IME与发行。嵌套阶段已归档受理 core75abb5bd/hosta373bd70，正式记录hostc3cd5e57；两仓main，已明确不新建worktree。

| 配对 / Task | 生产 / 消费与检查 | 结论 |
|---|---|---|
| Task1 ↔ Task2：markdown.ts/content-trace | Task1 actual empty facts、instance-local tokenize observer与emission；Task2观察真正consumed nested blanks，clone同代重发 | 顺序依赖清楚，Task1不生成nested-blank假fact；Task2只在source capture发synthetic token，legacy不变 |
| Task1 ↔ Task2：source-empty-body.ts/fidelity | Task1认证EmptyBody→原Step审计→EmptyAttempt；Task2只扩nested-blank recipe | 原draft undefined歧义已改显式三态；空目标无fact必须unsupported，不能fallback；自然rootclosed/protected guard不松 |
| Task1 ↔ Task2：source-structure.ts | Task1窄blank/fallback ledger消费；Task2 source-only容器emptyP输出 | 不把ordinary首字交整根renderer；结构Enter可用原授权渲染，并严格doc.eq证明 |
| Task1 ↔ Task2：utils/cache/HOST suite | Task1共用helper/首字测试；Task2沿同接口加链式命令/installed | Task1仅源+strict类型及相关回归；HOST源码可写但旧dist不证明其通过，Task2统一安装验证 |
| Task1 ↔ Task2：CHANGELOG/dist | Task1未发布条目，Task2更新闭包并build/commit/install | dist只Task2，package/lock完整bytes、14fixture和exports/map闭包不放宽 |
| Task1内部 | API定义在Task1自身且立即消费；表格显式/补齐、ATX、schema首P、literal、synthetic均有独立raw与实际PM路径expected | source-only偏差无legacy初始化承诺；真实frontmatter callback在Task2安装后验；2cell+1layout旧断言精确迁移 |
| Task2内部 | 使用Task1observer/recipe后定义nested语义与renderer；Enter链、真实keymap/toolbar/NodeView、安装闭包 | 已定义source-only空P约定；EOF无EOL/默认schema首P去重须测试证明；不以宽松docEq绕过 |

交叉接口已对实际75abb5bd核：capturedSourceLists/InlineBodies同代binding、captureInline/LiteralEmission、cloneTokenBatch、preparePreservingSourceCandidate、source-structure create/advance/finishLedger+partitionSlots。SourceEdit确在source-ownership；原Step classifier及链审计必须保留，empty分派在changedNaturalRoots之前且不能逃避原Step审计。

Ruling: EmptyAttempt 改为 not-empty / unsupported(reason) / ready(recipe) 三态；原目标为空但无fact或recipe不可表达必须unsupported，只有真实非空操作可走旧分派 — 原undefined同时表示不适用与拒绝，会意外进入root fallback — 成本是私有返回类型稍增，但可独立验证fail-closed；Task2及后继marks复用此边界。
Ruling: 常用空正文和Enter闭包仍是本批完整验收范围，Task1只验证首字、Task2补结构输出后统一installed — 每个Task有独立可拒绝的交付，避免一次修改全部UI — 成本是中间源码提交不可发布且dist尚旧，任务报告必须明确。
Ruling: 只准计划点名的两条empty-cell和一条top blank旧能力断言迁移；其余失败先按实际原因裁定 — 新能力应改变预期，不能批量删保护负例 — 成本为潜在追加精准裁定和审查，不以历史上限阻止正确能力。
Ruling: 保留main gzip81920门槛，当前80838，不在执行前涨预算；实际超限应携产物数据交root裁定 — 不知道实际增量时提前放宽无依据 — 成本是Task2可能需优化或明确更改预算，不能换入口或压缩参数隐瞒。
