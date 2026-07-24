# 决策日志设计复审:基于欧美最佳实践的改进方案

> 2026-07-24 深度研究产出。方法:5 路检索(实践者模板 / 校准科学 / 决策质量框架 / 依从性行为科学 / 反方与 AI 边界)→ 25 源 → 123 条论断 → 25 条重点论断各 3 票对抗验证(21 确认 / 4 否决)。  
> 对照对象:`docs/2026-07-21-decision-log-spec.md`(下称 spec)。本文是"改什么、为什么"的复审结论;采纳后应回写 spec。

---

## 0. 总判词

**总体架构方向正确**:^^结构化强制字段、校准记分牌、决策质量与结果质量分离、AI 提名人签字^^——均与欧美最佳实践一致,且部分设计(两问裁决、不展示对错率)有强背书。

**三处关键设计与实证证据冲突,需要修改**:

| \# | 现设计 | 证据裁定 | 改法 |
| --- | --- | --- | --- |
| 1 | 信心用三档 low/medium/high | ❌ 被 88.8 万条真实预测的同行评审研究直接挑战 | 底层改数值概率,UI {==保持按钮但升为 5 档==}{>>未来<<}锚定百分比 |
| 2 | 记分牌只展示校准度 | ⚠️ 不完整:成熟平台共识是"校准 + 恰当评分"组合 | 加净正和"决策分"(proper scoring),保留不展示对错率 |
| 3 | 连续 3 次回避即自动降级 | ❌ 与个人信息学研究方向相反(回避≠脱离) | ^^strike 只记"主动跳过",跳过时问一句原因^^,降级可逆+温和捞回 |

另有两个字段值得加入(premortem、备选项),一处措辞层面的弃用风险要防(记分牌的审判感)。

---

## 1. 逐决策点裁定

### 1.1 强制预测+信心+检查日期(spec §2)——保留,但摩擦是头号弃用风险

**支持**:Annie {==Duke 明确否定自由体决策日记==}{>><<}——"I'm not a big fan of decision journaling. I think it's kind of mushy"——她要的正是可打分的结构化捕获(预测、量表、rubric)(decidership.com 访谈,3-0 验证)。方向对。

**挑战**:

- CHI 2016 弃用研究(Epstein et al., n=193,同行评审):**采集成本是自我追踪弃用的头号原因**(活动追踪 45.6%、财务 57.1%),手动定期录入的工具最难坚持(3-0)。
- Metaculus 官方明确承认^^"做出预测"本身存在心理门槛(损失厌恶 + 理性不参与动机),需刻意用参与激励克服^^(3-0)。
- 注意:Duke 背书的是结构化字段本身,**不能引她背书"不填就不许创建"的阻断式门槛**。

**裁定**:强制三要素保留(这是产品身份),但每一分摩擦都要用 AI 预填 + 默认值 + 一键确认买回来:

- quoted 候选:一点签字(已是如此)。
- check-date 给默认建议值(如 +14 天,可改),不许为空但不逼用户思考。
- confidence 必选但只是一排按钮(见 1.2)。
- 允许"存为草稿、今晚再签"——候选托盘本身就是这个缓冲,别加第二道。

### 1.2 三档信心(spec §6/§7.4)——被最强证据挑战,改为数值底层 + 5 档锚定按钮

**挑战(本次研究最硬的一条)**:

- Friedman, Baker, Mellers, **Tetlock** & Zeckhauser (ISQ 2018),基于 **888,328 条真实地缘政治预测**:"coarsening numeric probability assessments in a manner consistent with common qualitative expressions … consistently sacrifices predictive accuracy"(3-0)。论文明确把 low/moderate/high 建模为概率线上的 **3 个 bin——正是本产品的粒度,且是所研究方案中最粗的之一**(3-0)。结论对评分规则、时间跨度、极端概率均稳健。
- 粗化还会**污染度量本身**:Clements 2011(JMCB)发现取整让预测者"看起来"失准/不一致,问题出在测量粒度而非判断质量(2-1)。三档粒度会削弱校准记分牌自己的信度。

**重要限定**(对抗验证明确否决了过度推论):"普通用户也能用好细粒度百分比"这一命题被 0-3 否决——研究对象是锦标赛预测者,对新手的可用性**未被直接证明**。所以不搬 101 档百分比输入框吓退用户。

**裁定(中间路线)**:

- **schema 底层改存数值概率**:`confidence: 0.55 | 0.65 | 0.75 | 0.85 | 0.95`(number,0-1),旧三档迁移映射 low→0.6 / medium→0.75 / high→0.9。
- **UI 仍是一排按钮,三秒可点**,从 3 个升为 5 个,每个锚定百分比:`勉强过半 55%` / `六成多 65%` / `挺有把握 75%` / `很有把握 85%` / `几乎确定 95%`。按钮上明示百分比数字——锚定语义,同时教育用户概率思维。
- 极客模式允许直接输入任意百分比(与 Brier 极客模式同开关)。
- 此改动与 1.3 的 proper scoring **互相锁定**:恰当评分规则需要数值概率输入。

### 1.3 记分牌只展示校准(spec §7.6/§8)——方向对,但"只有校准"不完整

**支持**:

- Duke:3:1 优势的好决策仍有 25% 坏结果,单次结果不能评判决策质量,应按 portfolio 跨多次重复来评(3-0)——支持不展示逐条对错率。
- Metaculus 公开 track record(365 万条预测)确实不展示裸对错率(3-0)。

**挑战**:

- Metaculus 官方:"there just isn't a single number … prediction quality *can* be measured, as a combination of **calibration and precision**"(3-0)。只看校准会漏掉 resolution:**永远压基础率的人校准完美但毫无信息量**。
- 恰当评分规则(proper scoring rule)还有激励意义:只有 proper rule 让"如实报告信心"成为最优策略,防止用户博弈记分牌(3-0)。
- 参与激励:Metaculus 曾刻意把记分设计为**净正和**以克服预测的心理门槛(3-0)。时效限定:2023-11 后 Metaculus 改用 Baseline/Peer 分(仍 proper,不再严格净正和),净正和曾有刷分副作用——个人工具无排行榜,无此风险,净正和适用。

**裁定**:记分牌升级为三件套 + 状态模式(替换 spec §7.6 的①②):

1. **校准分桶**(保留,但桶=5 档数值):"你说 85% 的事,实际发生了 8/10"。
2. **决策分**(新):baseline 型 proper score,**净正和**——每完成一次裁决得基础参与分,预测优于抛硬币(50%)得准确加成,劣于则少得但**不为负**。慢反馈期的即时进度奖励从"样本数"升级为"会涨的分数"。公式:`每次裁决得分 = 10 + 40 × log2(2·p_assigned)`,p_assigned 为押中侧概率,下限截断为 0(p=0.5 时得 10 分参与分,95% 命中≈47 分,95% 落空 0 分)。
3. **样本进度**(保留)。
4. **状态模式**(保留,Hemory 独有)。

- Brier 分/校准曲线仍收在极客模式(与百分比输入同开关)。
- **对错率仍然永不展示**——立场不变。

**措辞的弃用风险(必须写进实现)**:CHI 2016 逐字核验——"tracking can highlight perceived shortcomings … Abandoning tracking may be the easiest way to address this discomfort"(3-0)。突出短板的反馈本身是弃用通道。记分牌一律用**学习/进步框架**:展示校准随时间的改善曲线;失准呈现为"信息增量"("这类事你的把握比感觉低 15%——下次押低一档试试"),不用红色警示、不用"错误率"字眼。这与 spec §3-S5"教练语气"同源,此处扩展到记分牌。

### 1.4 两问裁决(spec §3-S4/§7.4)——保留,加一个可选的"第三问"

**支持**:SDG(Strategic Decisions Group)决策质量框架:高质量决策六要素——恰当框架、创造性备选项、有意义的信息、清晰的价值与权衡、正确的推理、行动承诺;决策质量**可在决策当时直接评分**,无需等结果;整体质量按**最弱一环**(min,非平均)计(三条均 3-0,并有 Wiley 2016 Spetzler et al. 书独立佐证)。

**裁定**:两问结构不动。当第②问答"不会"时,**追加一个单选**(可跳过):"哪一环最弱?"——六要素六选一(想错了问题 / 没想别的选项 / 信息不够 / 没想清楚要什么 / 推理有漏洞 / 没真执行)。由此得到与结果无关的**决策卫生(decision hygiene)过程指标**:记分牌可显示"你最常见的弱环是'没想别的选项'"。落 `_scoreboard.jsonl` 的 `weakest_element` 字段。

### 1.5 三振自动降级(spec §2/§3-S7/§9)——被系统性挑战,改为"区分信号 + 优雅回归"

**挑战**(个人信息学三条独立发现,全部 3-0):

- 放弃不是失败的可靠信号——"Abandonment is thus not always indicative of failure … could rather be a sign of diminishing returns or a redefinition of goals"(Epstein CHI 2016;含"学够了"的 happy abandonment)。
- 中断(lapse)往往是**有意的、临时的**,伴随未满足需求(UbiComp 2016 "Reconsidering the Device in the Drawer")。
- 真实自我追踪本来就是间歇性的 lapse-and-return 循环,线性依从模型本身错误(Lived Informatics Model, UbiComp 2015,十年影响力奖)。
- "回避即信号"机制**没有找到任何正面研究先例**,现有证据方向相反。

**限定**(验证者明确提出,采纳):这些研究讲的是**整工具中断**,而本产品场景是"活跃用户逐条跳过裁决"——后者更接近鸵鸟效应式信息回避,回避在此**可能确实是有效信号**。所以是"区分信号",不是取消机制。

**裁定**(修改 spec §9 状态机):

1. **strike 只记"主动跳过"**:仅当用户**当次周回顾裁决了别的决策、却跳过这条**时 +1;整场周回顾没做(lapse)不给任何决策加 strike。这一条把"人中断了"和"人回避这件事"分开,是与研究对齐的关键修正。
2. **跳过时轻问一句**(单选,可不答):`还没到时候`(顺手改 check-date,不计 strike)/ `已不相关`(直接 drop,无愧疚归档)/ `先不想面对`(计 strike——这是诚实的回避信号,也是 spec 原意真正想抓的东西)。不答视同"先不想面对"。
3. **降级保持可逆 + 温和 resurface**:降级项每月在周回顾尾部以一行出现("沉底了 3 条,看一眼?"),一键捞回;召回文案禁止说教/内疚化(研究:说教式召回让部分用户"非常反感")。
4. **跨间隔 catch-up 视图**:用户缺席 N 周后回来,周回顾先给"你离开期间到期了 5 条"的批量补裁页,把 lapse-and-return 当常态支持而非异常惩罚。

### 1.6 节奏:当天签 / 每周批量裁决(spec §4)——保留

每周批量裁决与"间歇性使用是常态"的实证图景兼容,且批量模式天然适合 lapse 后补做;研究给出的设计要求是"优雅回归、跨间隔保持洞察"(Munson,3-0)——由 1.5-4 的 catch-up 视图满足。

**证据缺失声明**:复盘最优间隔(如 Farnam Street 传说的 6 个月)**没有找到任何通过验证的实证依据**,间隔重复应用于决策复盘同样无据。check-date 保持用户自定 + 默认建议值,**产品文案勿把任何具体间隔当科学结论引用**。

### 1.7 缺失字段——加两个,缓两个

| 字段 | 裁定 | 证据 |
| --- | --- | --- |
| **premortem 失败预想** | ✅ 加(签字模态可选行) | Klein HBR 2007:机制在于把失败框定为**确定已发生**——"the premortem operates on the assumption that the patient has died"(3-0);Klein 2021 明确把开放式"What can go wrong?"列为**常见错误用法**(3-0);Veinott, Klein & Wiggins 2010 对照实验(n=178,五条件):premortem 条件对过度自信削减最大,约为 pros-cons 组两倍,p<.0001(3-0) |
| **备选项 alternatives** | ✅ 加(可选,一行) | SDG 六要素之一("创造性备选项"),按最弱一环规则缺它则决策质量封顶(3-0);也是 1.4 第三问的选项之一,字段与指标闭环 |
| one-way/two-way door 可逆性 | ⏸ 缓 | 本次验证未产出 surviving 证据(证据缺失,非证据反对) |
| base rate/外部视角提示 | ⏸ 缓 | 同上 |

**premortem 措辞硬约束**(实现时逐字采用确定性框架):

> "假设现在是 {check-date},这个决策**已经失败了**。最可能的原因是什么?"

绝不写成"可能会出什么问题?"——Klein 认定后者无效。两字段均可选、均可由 AI 从当天内容预填(agent prompt 加 `premortem_hint` / `alternatives` 提名,人签字时确认),不增加强制摩擦。

**否决的传言**(产品文案切勿引用):"prospective hindsight 提升 30% 识别力"(Mitchell/Russo/Pennington 1989)这一常被引数字在对抗验证中被 0-3 否决;"Duke 接受 Likert 式信心表达"同被 0-3 否决。

### 1.8 AI 提名/人签字/签后不可改(spec §3-S1/S2)——保留,补一条防锚定

无直接研究(该方向无 surviving 证据,置信度 low),但两条间接证据一致:AI 预填直接对冲"采集成本是弃用头号原因";签后不可改的预测正是 Duke 要的"可被检验打分"的捕获。设计与产品信念 3 自洽,不动。

**防锚定补丁**(针对 open question:AI 建议是否污染人的判断):

- 裁决模态里 AI 的 `suggested_outcome` **不预选按钮**——证据引文置顶展示,三个结果按钮平权,用户点完后才显示"AI 的建议与你一致/不一致"。已有的"confidence 无据则 null、nominated 用问句"规则保持,它们正是防锚定的正确做法。

### 1.9 坚持性设计检查清单(新增 spec 一节)

实证弃用原因排序:①采集成本(45-57%,首位)②反馈揭示短板的不适 ③线性依从模型本身错误。对应三件套,作为每个新特性的检查清单:

1. **每次录入摩擦最低**:AI 预填、默认值、批量操作、一键确认。
2. **学习式而非审判式反馈**:进步曲线、信息增量措辞、永无对错率。
3. **lapse-and-return 优雅回归**:catch-up 视图、可逆归档、非内疚召回、缺席不惩罚。

加参与激励:净正和决策分(1.3),裁决完成本身得分。

---

## 2. Schema 变更清单(对照 spec §6)

```jsonc
// $defs 变更
confidence: number | null        // 0-1,五锚点 0.55/0.65/0.75/0.85/0.95;极客模式任意值
                                 // 迁移:low→0.6, medium→0.75, high→0.9;旧枚举读入时映射
// 新增 $defs
skip_reason: "not-yet" | "avoid" | "irrelevant"
weakest_element: "frame" | "alternatives" | "information" | "values" | "reasoning" | "commitment"

// 候选/open 看板条目新增可选字段(AI 可提名,人签字确认;🔒 同 prediction)
premortem: string | null         // 确定性措辞的失败预想
alternatives: string[] | null    // 落选备选项,每项一句话

// 归档条目新增
weakest_element: …               // 仅 still-endorse=false 且用户作答时存在

// _scoreboard.jsonl 事件变更
// verdict 事件:confidence 为数值;新增 score(净正和决策分,append 时计算冻结)
// 新增 skip 事件:{ event: "skip", id, reason: skip_reason }   // strike 语义变更的载体
// downgrade 事件不变(category 保留)
```

状态机(spec §9)变更:`incStrike` 仅由"主动跳过"触发(周回顾中裁决过其他决策为前提);新增 `skip(reason)` 纯函数——`not-yet` 改期不计振、`irrelevant` 走 drop、`avoid`/未答计振。

## 3. 实施优先级

| 期 | 内容 | 理由 |
| --- | --- | --- |
| P1(改对度量,趁样本少) | 信心改数值五档 + 决策分(净正和)+ 记分牌学习框架措辞 | 度量是地基,样本积累越多迁移越疼;三处证据最硬 |
| P2(改对信号) | strike 语义改主动跳过 + 跳过三选一 + catch-up 视图 + 温和 resurface | 状态机纯函数改动,可 TDD |
| P3(补字段) | premortem + alternatives(签字模态可选行 + agent prompt 提名)+ 第三问 weakest_element | 全部可选,不动主流程 |
| 缓 | 可逆性分类、base rate 提示、Brier 曲线极客模式 | 证据缺失或已延后 |

## 4. 证据强度与诚实声明

- **最硬**:三档粗化有害(88.8 万条预测,ISQ 2018,Tetlock 挂名,3-0)、弃用主因是采集成本(CHI 2016,3-0)、间歇使用是常态(UbiComp 2015/2016,3-0)、premortem 对照实验(2010,3-0)。
- **框架级**(非实证):SDG 六要素是咨询公司自述框架(有 Wiley 书佐证);Duke 观点出自访谈。
- **外推缺口**:粗化研究对象是锦标赛预测者,新手能否坚持数值概率**未被证明**(0-3 否决了乐观推论)——这是 1.2 采取"5 档锚定按钮"而非纯百分比的原因;弃用研究来自健身/财务追踪,决策日志是类比。
- **证据缺失≠证据反对**:复盘间隔、可逆性分类、base rate、AI 锚定效应、"逐条回避是否有效信号"(鸵鸟效应文献未覆盖)——均为 open questions,方案在这些点上保守处理。
- **勿引用**(验证否决):"prospective hindsight +30%"、"Duke 接受 Likert 信心"。

主要来源:ISQ 2018 (academic.oup.com/isq/article-abstract/62/2/410/4944059) · Epstein et al. CHI 2016 (dl.acm.org/doi/10.1145/2858036.2858045) · Lived Informatics (smunson.com/portfolio/projects/personalinformatics) · Metaculus track record & scoring primer (metaculus.com) · Klein premortem (HBR 2007 / Psychology Today 2021) · Veinott, Klein & Wiggins 2010 · SDG Decision Quality (sdg.com/decision-quality) · Duke 访谈 (decidership.com) · Clements 2011 (ideas.repec.org/p/wrk/warwec/869.html)