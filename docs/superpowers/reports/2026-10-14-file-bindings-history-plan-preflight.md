# bindings/history 正式化 root 自审

这是 root 计划核对，不是额外审查席位。实际核对 CORE source-fidelity/source-file-cache/source-ownership、HOST contract/identity/commands 边界，读完整候选四Task；前置最终已受理COREd0807fa/HOSTa955cb1；执行SHA在本计划文档提交后冻结。

| 对象 | 生产→消费 | 核对结果与裁定 |
|---|---|---|
| Task1自身 | source-history纯payload、bindings/projection、M | 不依赖controller或未来open；SourceFileUpdate无provenance token，纯helper仅数据核验，实际F1来源在Task2私有调用点保证；已明确测试边界。 |
| Task2自身 | source producer/controller/history/resize/slash | replaceSource/middleReplace、唯一test helper、NodeView/hint同Task完成，浏览器resize不依赖未来mount。 |
| Task3自身 | createState→owner/mount/source input | 同次capture.doc首帧，无legacy parse后补；adapters/type在Task1，真实controller在Task2；两个legacy展示append在配置前过滤。 |
| Task4自身 | recovery/native→已有owner | 只持久恢复元数据，不再实现raw merge或第二history；平台实测未有设备须单列未验。 |
| 1↔2 | history payload/bindings/projection/M | 单一source-history registry，controller私有WeakMap，外部JSON不可授权；Task2完整chain最终veto一次。 |
| 1↔3 | type-only契约/包出口→factory | 只增加source-history package/tsup入口；session-table-view用已有wildcard；owner参数不能覆盖source/history。 |
| 1↔4 | recovery validation | 完整roots+hash复用Task1，缓存错只重建IDs，不覆盖raw。 |
| 2↔3 | controller/Source/commands/layout→DOM | Task3不后补Task2核心算法；flush/pending/composition阻止丢buffer，保存不清栈。 |
| 2↔4 | publish-only observer/history→save/native | 源成功安装后才统计/通知，拒绝链零副作用；native菜单无重复accelerator。 |
| 3↔4 | owner生命周期→baseline/recovery | 新baseline候选成功才交换policy/authority/history；普通restore可撤销；旧保存回执不覆盖新输入。 |
| bindings↔delivery | mount/policy/annotations/保存 | pure builder与持久outbox在delivery；rebase显式新policy，ordinary owner无网页wire协议。 |
| 前置→本期工具 | CORE101857B/包manifest/安装 | 候选98304旧cap改当前102400，不预增；允许新包出口精确差异，依赖锁不变；明确真实上一已安装SHA与ambient shims。 |

裁定和代价见 next-bindings-history-ready-plan.md 末节。主入口余543B是实际约束，新增M/factory须验证，不预提高预算。平台缺失不是通过，也不阻止独立实现。
