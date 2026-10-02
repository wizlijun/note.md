# HABITAT 关键词网络 v2

`organize::build` 保持 `vault-knowledge-structure/1` 数据格式，算法版本升级为 `habitat-keyword/2`。输入是原提取器已记录的 wiki、标签、项目和导入会议概念；本版不新增全文自动抽词。关键词没有覆盖所有正文术语，缺边表示当前证据不足，不能据此判断两个词毫无关系。

## 词项与关注线索

- 排除 document/topic；NFKC、空白和大小写规范化，相同拼写汇总为 `keyword:<normalized>`。这是词项身份，**不证明同名人物或实体是同一对象**。
- 证据、原文定位、来源状态和项目意图全部保留；别名仅用于显示/检索，不作传递式身份合并。
- 过滤纯数字、日期、明显代码/配置标记、工作流来源标签和过长句子。没有主题白名单。
- 关注候选需至少一组 human 正文上下文证据、两组明确链接证据、明确项目声明，或两组未标明作者的原生来源并具有链接上下文。页面自身的 human metadata 不当作本人讨论了这个词。
- 导入词不获个性化跳转初始权重；只有至少两组来源、与原生关注词存在明确关联时才参与入选，至多 120 个。总关键词上限 1,200，候选不足时不补满。

令 `F` 为全部去重来源组数，`df(t)` 为包含词项的来源组数：

```
idf(t) = ln((1 + F) / (1 + df(t))) + 1
TF(t) = 1 + ln(1 + df(t))
attention(t) = 4 ln(1 + humanContextGroups)
             + 1.5 ln(1 + linkedGroups)
             + 0.3 ln(1 + unknownNativeGroups)
             + 2 * declaredProject
prior(t) = idf(t) * TF(t) * attention(t)
rank(t) = .55 * normalized(prior(t)) + .45 * personalizedPageRank(t)
```

PageRank 阻尼 .85，固定排序，100 次迭代上限、L1 差小于 1e-10 收敛。每词每来源组对 TF 最多贡献一次；重复拷贝、同源迁移段落不会增加词频。关注度是来源线索，不是对本人心理状态的断言。

## 明确关系与统计关联

明确关系按 `type + status + 规范化词项参与者及角色` 先聚合证据，再重算来源组。相同来源组的重复声明不额外增加 PageRank/Leiden 权重。二元关系聚类权重为 `authority * ln(1 + min(16, sourceGroups))`，observed/user-confirmed 权威系数 1，imported 为 .25，candidate 为 0。超边保留全部角色和状态，不展开为事实完全图。

统计关联只用 `verification=matched`、`role=context` 的 paragraph/outline_node：

1. 每个窗口最多 12 行、8 个候选词；先按 **source ID + locator** 还原真实段落。相同来源家族内不同文件的同一行号，绝不能拼成一个段落。
2. 再按 **source family + 关键词集合** 保守去重；不同位置的同组词转抄不会制造额外样本。这里不声称原文内容相同。
3. 所有边际概率、联合概率都在上述同一套窗口样本上计算。`NPMI = ln(p(a,b)/(p(a)p(b))) / -ln(p(a,b))`。
4. 保留在至少两组来源中共同出现且 NPMI≥.05 的词对，聚类权重为 `NPMI * sourceGroups/(sourceGroups+2)`。若所有窗口都包含这对词，0/0 不擅自解释为满分相关。
5. 输出 `edgeType=co_occurs,status=statistical`，只表示共现，不能变成因果/支持等语义断言。

未知谱系的 distinct family 仅称“去重来源组”，不是已知独立来源。`verifiedFamilies/provisionalFamilies/unresolvedLineage` 按原来源状态分开计数；即使 family verified，也只说明来源家族解析成功，不证明关系内容为真。

## 社区与历史

使用 **leiden-rs 0.8.1** 的标准局部移动、细化、聚合三阶段，禁用默认并行特性，Modularity resolution=1，seed=42，skip_refinement=false。孤立词保留，不生成关系或强行归入社区。社区名称取内部强度平方/总强度最高的 2–3 个词。

关键词身份稳定；社区沿用 Jaccard≥.6 且领先第二候选≥.15 的一对一续接，保留拆分/重组谱系。新社区以出生 ID 作为匹配键。算法迁移明确标记 `changeCause=algorithm`，不能把方法变化说成知识增长。

布局按真实 primary membership 分配，迁移时不继承旧空间分桶。仍存在的社区保留中心，同社区关键词保留坐标，跨社区词重新落位，pinned 位置优先。社区按成员规模预留空间。

## 验证

```
cargo test --manifest-path habitat-core/Cargo.toml
cargo run --manifest-path habitat-core/Cargo.toml --example reorganize_snapshot -- OLD_JSONL NEW_JSONL
```

回归覆盖同源重复、不同文件相同行号、不同段落、负/无区分度共现、长列表、超边、身份规范化、项目意图、顺序复现、快照压缩回环、算法迁移、社区生长/拆分与坐标续接。开发重组工具输出至明确给定的文件，不访问或修改 Vault。
