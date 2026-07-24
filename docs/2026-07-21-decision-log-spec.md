# 决策日志(Decision Log)设计规格

> 归档用设计 spec。定稿日期 2026-07-21。对应实现计划见 `docs/superpowers/plans/2026-07-21-decision-log.md`,插件规范见 `docs/plugin-v2-development.md`。
> 本文是"要做成什么、为什么"的权威;实现细节以计划为准,二者冲突时先改本文再改计划。

> **⚠️ 2026-07-24 v1.1 修订**(依据 `docs/2026-07-24-decision-log-design-review.md` 研究复审 + `docs/2026-07-24-decision-log-v1.1-requirements.md`,后者为准),以下条款被取代:
> - **信心三档(§6/§7.4)→ 10 格概率条**:UI 为 10 个格子(前 5 格锁定=0–50% 基线,后 5 格可选,锚定 55/65/75/85/95%,悬停显示概率+语言表达),存储改数值 `confidence: 0.85`;旧枚举读入映射 low→0.6/medium→0.75/high→0.9。"不填百分比"原则退役(三档粗化被 ISQ 2018 的 88.8 万条预测研究证伪)。早先的"五颗星"方案已废(1★ 视觉误导 >50% 概率)。
> - **记分牌(§7.6/§8)**:新增净正和"决策分"(proper score,`max(0, 10+40·log₂(2p))`),校准分桶按五星;仍不展示对错率。
> - **三振降级(§2-3/§9)**:strike 只记"主动跳过且原因为回避";跳过三选一(还没到时候=改期不计振 / 已不相关=drop / 先不想面对=计振);整场回顾没做不计振;新增 `skip` 事件。
> - **签字模态(§7.4)**:新增可选 premortem(确定性措辞)与 alternatives 字段(🔒 同预测)。
> - **裁决(§7.4)**:Q2 答"不会"时追加可选第三问"哪一环最弱"(SDG 六要素);AI suggested_outcome 不再自动预选按钮(防锚定)。
> - **顶部价值主张**:窗口顶部常驻一句话「把决定变成可检验的下注:时间会告诉你,你的判断哪里可信、哪里高估。」

---

## 1. 背景与定位

决策日志是 **Hemory × note.md「行动反馈闭环」** 落在 note.md 一侧的产品形态。闭环:

```
无感记录(Hemory 捕获) → AI 压缩提炼 → 反思与选择(note.md 裁决)
   → 可证伪的下一步 → 被动验证(Hemory 附证据) → 回到反思
```

- **Hemory = 传感器 + 证据库**(捕获、压缩、给上下文)。
- **note.md = 裁决界面**(承载"保留摩擦"的选择动作)。
- 决策日志只负责闭环里的 **`反思与选择` + `可证伪的下一步`** 两个环节,**不抢捕获/证据附着**(那是 Hemory 的活)。

产品身份一句话:**把"记录"逼成"下注",再用被动证据把"自我叙事"逼成"可检验的假设"。**

---

## 2. 核心模型:只做两件事

1. **事前预测** —— 创建一个决策时,**必须**同时给出可证伪的预测(做什么 + 预期证据 + 信心 + 检查日期)。没有预测不许建决策。
2. **事后裁决** —— 到检查日期,由**人**做一次裁决(命中/未命中/放弃),AI 只帮着找证据、填草稿、关闭。

围绕这两件事的两个自动机制:

3. **自动降级** —— 决策连续 3 次(按周回顾计)被摆出却不裁决 → 自动归档为"降级/不重要"。回避本身是诚实信号,让不重要的东西自己沉底。
4. **量化记分牌** —— 记录**预测校准度**(不是对错率),可看历史。

> 设计哲学:摩擦被刻意压到极限,且只留在"裁决"而非"组装"。用户的脑力用于判断,不用于填表。

---

## 3. 反人性守则(不可在实现中"优化"掉)

每条都对应一个具体失败坑,均有研究背书(见 §10):

| # | 守则 | 反的坑 |
|---|---|---|
| S1 | **AI 提名,人签字**。AI 只能"捕捉"你的原话或"提名"候选,预测的最终措辞与信心必须由人锁定。签字动作不可省。 | 认知卸载:AI 代想侵蚀判断力;记分牌若量 AI 的校准则整个产品失去意义 |
| S2 | **预测与信心签字后不可改**(锁定)。 | 事后美化预测 = 自欺 |
| S3 | **记分牌记校准,不记对错率**。展示"你说'很有把握'的事实际发生几成",不展示"你错了 40%"。 | outcome bias(结果偏见)+ 羞耻螺旋弃用 |
| S4 | **裁决分两问**:①结果发生了吗 ②抛开结果还会这么决定吗。两栏独立。 | 把决策质量与结果质量混为一谈 |
| S5 | **教练语气,不是审计**。默认展示"已完成";未完成问"优先级变了还是需要调整?";"放弃"是无愧疚选项。 | 全量自我监控 → 过度自察 → 弃用 |
| S6 | **圈选制,不是全量追踪**。只有被确认/签字的才进追踪清单。 | 全量追踪的压力 |
| S7 | **降级是归档 + 数据,不是删除/惩罚**。文案"帮你清理了"+ 一键捞回;回避的主题进记分牌。 | GTD 式积压压垮系统 |
| S8 | **裁决必须一次点按**,提醒搭在周回顾里,不独立打断。 | 零散打断 → 三次提醒被无视三次 |

---

## 4. 两个节奏(都不独立打断,都搭在既有仪式上)

| 节奏 | 时机 | 动作 | 为什么分开 |
|---|---|---|---|
| **每日** | 打开 daily note 时 | 签字新预测(捕捉/提名) | 预测必须趁热签,隔周签会被后见之明污染 |
| **每周** | 周回顾里 | 裁决到期/触发的决策 + strike 计数 | 裁决要批量、冷静,不该零散打断 |

---

## 5. 存储架构

全部落盘为 vault 内文件,Obsidian/CLI 可直接解析(file-over-app)。

| 状态 | 载体 | 角色 |
|---|---|---|
| **所有未决决策** | `vault/decision/open.decision.note.md`(唯一一个) | 活动看板,front-matter 里是 `decisions` 数组;真相源 |
| **已完成/放弃/降级** | `vault/decision/archive/YYYY-MM-DD-decision.note.md`(按裁决日,一天一个) | 永久留档,front-matter 数组;真相源 |
| **每日候选托盘** | `vault/diary/YYYY-MM-DD-decision.json` | AI 生成的机器草稿,可丢;插件只读消费 |
| **积分事件日志** | `vault/decision/_scoreboard.jsonl` | 追加式派生缓存,可由归档重建 |

**生命周期**:候选 JSON →(签字)进 `open.decision.note.md` 数组 →(裁决/降级)从数组删除,追加进当天 `archive/*.note.md` 数组 + `_scoreboard.jsonl` 记一行。

命名/id 规则:文件名只靠日期(**不含 slug,无需 LLM 计算**);决策 id = `创建日期-当日序号`(如 `2026-07-21-01`),全生命周期稳定,不进文件名。

---

## 6. 数据契约(schema)

给 AI 生成候选、给插件读写的正式契约。共享类型:

```jsonc
// $defs
confidence: "low" | "medium" | "high" | null   // 三档,不用百分比;low/medium/high = 有点/挺有/非常把握;数值中点 0.6/0.75/0.9 由 App 算
outcome:    "hit" | "partial" | "miss"
status:     "closed" | "dropped" | "downgraded"
trigger:    { if: string, source?: string }     // 复议触发条件
evidence:   { conv_id?: string, quote: string, time?: string }
state:      { time?: string, speech_rate?: "slow|normal|fast", calendar_density?: "low|medium|high" }  // 决策时被动状态快照
```

### 6.1 候选文件 `vault/diary/YYYY-MM-DD-decision.json`(AI 每日生成)

```jsonc
{
  "date": "2026-07-21",
  "generated_by": "openclaw",
  "new_candidates": [{
    "id": "cand-2026-07-21-01",               // cand-<日期>-<当日序号>
    "title": "先做决策日志 MVP",
    "prediction_source": "quoted" | "nominated",
    "quote": "两周内能发",                      // quoted 必填,原样引用
    "prediction": "两周内发出 MVP" | null,      // nominated 写反问句或留空,严禁替用户编断言
    "confidence": "medium" | null,             // 仅当原话透露把握时填,签字时被覆盖
    "check_date": "2026-08-04" | null,
    "triggers": [{ "if": "竞品先发布", "source": "openclaw" }],
    "state": { "time": "08:12", "speech_rate": "normal", "calendar_density": "low" },
    "source": { "conv_id": "cv1", "quote": "…", "time": "08:12" },
    "status": "pending"
  }],
  "closures": [{
    "decision_id": "2026-07-07-01",            // 指向 open 看板里的 id
    "reason": "due" | "trigger",
    "suggested_outcome": "hit" | "partial" | "miss",
    "evidence": [{ "conv_id": "cv2", "quote": "上线了" }],
    "status": "pending"
  }]
}
```

**AI 生成硬规则**:① nominated 绝不编造断言(反问句/留空);② quoted 必带原文且不改写;③ confidence 无据则 null;④ closures 只含到期(due)或触发(trigger)的;⑤ state 挖不到整体省略;⑥ 所有 status = pending。

### 6.2 未决看板 `open.decision.note.md`(front-matter)

```yaml
type: decision-board
decisions:
  - id: 2026-07-21-01
    title: 先做决策日志 MVP
    prediction: 两周内发出 MVP      # 🔒 签字后不可改
    confidence: medium              # 🔒
    check-date: 2026-08-04          # 可调整(留痕)
    created: 2026-07-21             # 🔒
    origin: agent | manual          # 🔒
    source_conv: cv1
    quote: 两周内能发                # 🔒 来自 quoted 候选
    strikes: 0                      # 0..3;每次周回顾摆出未裁决 +1,满 3 降级
    triggers: []
    state: { time: '08:12', ... }   # 🔒 创建时快照
```
正文是插件渲染的人类可读镜像(`# 未决决策` + 每条一节)。

### 6.3 归档 `archive/YYYY-MM-DD-decision.note.md`(front-matter)

```yaml
type: decision-archive
resolved: 2026-08-04                # = 文件名日期
decisions:
  - id: 2026-07-21-01
    created: 2026-07-21
    status: closed | dropped | downgraded
    prediction: 两周内发出 MVP      # 🔒 冻结
    confidence: medium              # 🔒
    outcome: hit                    # status=closed 必填;dropped/downgraded 省略
    still-endorse: true             # 抛开结果还会这么决定吗;closed 必填
    evidence: [{ conv_id: cv2, quote: '上线了' }]
    origin: agent | manual
    state: { ... }
```

### 6.4 积分事件 `_scoreboard.jsonl`(每行一对象)

```jsonc
{ "ts": "ISO8601", "event": "create|verdict|downgrade|adjust|reopen", "id": "…",
  "confidence": "medium", "outcome": "hit", "still_endorse": true,
  "category": "招聘",        // downgrade 事件带主题,用于回避模式分析
  "state": { … } }
```

---

## 7. 交互设计(易用、低认知负荷)

三层:**看板给概览、队列给日常、模态给单步**。日常绝不强迫面对整块看板。

### 7.1 主界面:三列看板 + 常驻记分牌

- 列:**候选 Candidates**(AI 提名/捕捉)→ **未决 Open**(已签字待裁决)→ **归档 Archive**(完成/放弃/降级)。方向 = 状态推进,单向。
- 记分牌**常驻右栏不折叠**(慢反馈期唯一的即时进度奖励)。

### 7.2 卡片:极简,零操作控件

| 列 | 卡片显示 |
|---|---|
| 候选 | 标题 + 来源徽标(🎙你的原话 / 💡AI提名) |
| 未决 | 标题 + 信心档 + 距检查天数(⚡=有触发条件) |
| 归档 | 标题 + 结果图标(✅◐❌⊘) + 是否还认同 |

信息前置、操作后置——点开卡片才展开动作,避免每张卡都在"喊你操作"。

### 7.3 拖放语义:拖是意图,落触发"唯一那一步"

| 拖动 | 含义 | 落下弹出 |
|---|---|---|
| 候选 → 未决 | 签字下注 | 签字模态 |
| 未决 → 归档 | 裁决 | 裁决模态 |
| 候选 → 丢弃 | 不是决策 | 一点消失(训练信号,AI 少提同类) |
| 归档 → 未决 | 重开 | 仅 ⚡触发命中允许;手动重开需二次确认 |

非法拖动(未决→候选、跨列跳格)直接弹回 + 一句话说明。每个拖放都有等价的**卡片按钮**路径(键盘/触屏/无障碍)。

### 7.4 两张原子模态(全产品仅有的两个"要动脑"处)

**签字模态(候选→未决)** —— 一屏,最多两下:
- quoted:显示原话,一点签字。
- nominated:反问"你是预期 B 吗?",**必须填/改 prediction 才能创建**。
- 信心 = **三个按钮**(有点/挺有把握/非常),**不填百分比**。
- check-date 选择器;可选 triggers("若…则提前")。

**裁决模态(未决→归档)** —— 一屏两问两点:
- ① 发生了吗?(命中/部分/未命中)
- ② 抛开结果,还会这么决定吗?(会/不会)
- 顶部只读展示预测(🔒)+ AI 已附证据。教练语气,未命中不显示为失败。

### 7.5 事后浏览 + 大纲编辑:锁的视觉语言

在大纲/伴生笔记回看时,统一锁语言:
- **锁定(永不可改)**:预测、把握、创建时间、状态快照、来源原话、裁决结论 —— 灰底 + 🔒,点击提示"这是记分牌的基准,不可改"(带解释,非冷禁用)。
- **可改**:标题、理由正文、检查日期(调整留痕)、触发条件。

### 7.6 记分牌显示三维度

```
① 校准分桶:"你说'很有把握'的 8/10 发生了"      —— 反 outcome bias
② 样本进度:"已积累 23 个决策样本"              —— 把慢反馈变成收集进度感
③ 状态模式:"你在日程满档 + 语速快时,命中率↓"    —— Hemory 独有
```
Brier 分数 → 收进"极客模式",默认不显示。

---

## 8. 校准记分牌算法

- 只统计 `event: "verdict"` 事件。
- **校准分桶**:按 confidence(low/medium/high)分桶,每桶记 `{ hits, total }`,`hits` = outcome==="hit" 计数(partial 不进分子)。
- **样本数** = verdict 事件总数(慢反馈期的进度感来源)。
- **回避模式** = 对 `event: "downgrade"` 的 `category` 计数。
- Brier / 校准曲线为后续极客模式,不在 MVP。

---

## 9. 生命周期状态机(纯逻辑,可测)

```
候选(JSON pending)
   │ sign(签字)                → 追加 create 事件
   ▼
未决(open 数组, strikes 0..3)
   │ verdict(裁决)             → status=closed, 追加 verdict 事件
   │ incStrike ×3(周回顾未裁决) → status=downgraded, 追加 downgrade 事件
   │ (拖丢弃/主动放弃)          → status=dropped
   ▼
归档(archive 数组, 冻结)
   │ trigger 命中 / 手动重开     → reopen 事件(回到未决)
```

- `sign` / `verdict` / `incStrike` / `manualCreate` 为纯函数:输入当前 open 列表 + 动作,输出 `{ open, archived?, event }`,不碰 I/O(便于 TDD)。
- `now`/`today` 由调用处注入,保持确定性。

---

## 10. 研究依据(2026-07-21 深度检索,43 源 / 227 条对抗验证论断)

- **记校准不记对错**:outcome bias 由 Baron & Hershey (1988) 实证(5 组研究);Annie Duke 称 "resulting"。`en.wikipedia.org/wiki/Outcome_bias`、`psycnet.apa.org/doiLanding?doi=10.1037/0022-3514.54.4.569`、`calvinrosser.com/notes/thinking-in-bets-annie-duke`。
- **行动前写 + 记决策时状态**:Farnam Street 官方模板固定含 Mental/Physical State(勾选框)、预期+概率 与 实际结果分块、Review Date(决策后 6 个月)、落选备选项、"必须行动前写"以对抗 hindsight bias。`fs.blog/decision-journal/`、`fs.blog/wp-content/uploads/2017/02/decision-journal_draft3.pdf`、`alliancefordecisioneducation.org/resources/keeping-a-decision-journal/`。
- **outcome 与"是否仍认同"分栏**:决策质量 ≠ 结果质量。`psychologytoday.com/us/blog/decisions-and-the-brain/202509/...`。
- **一记一决策 / Status 生命周期 / front-matter**:ADR/MADR 惯例。`github.com/joelparkerhenderson/architecture-decision-record`、`adr.github.io/madr/`、`martinfowler.com/bliki/ArchitectureDecisionRecord.html`。
- **复议触发条件**:premortem(Duke 评价高于 backcasting);ADR 的条件式重开。
- **AI 提名不代判**:LLM 可实时检测 confirmation bias(arXiv 2503.05516),定位为辅助审查。

---

## 11. 作为插件的形态(合规)

- **纯前端 v2 插件**,id `notemd.decision-log`,形态照抄 `plugins-src/roam-import/`。
- 主界面 = **独立窗口看板**(经 `contributes.windows` + `open_command`)。理由:插件当前无侧栏注册入口(见 `docs/plugin-v2-development.md` §7)。
- capabilities:`["vault.read", "vault.write", "toast"]`。
- 读写 vault 走 `window.notemd.request('host.vault.*', …)`;路径 vault 相对、禁 `..`、10MB 上限。
- 要生成 `.note.md` 需把主程序 `src/lib/outline/` 工具复制进插件(隔离 webview 不能 import 主程序);本插件 front-matter 是"数组 + 镜像正文",直接用 `yaml` 库更简单。
- i18n:manifest `name` 用英文 + `i18n.zh` 覆盖;UI 字符串用插件自带 `strings.ts`(locale 取自 bridge)。

---

## 12. MVP 边界

**本期做**:存储三层 + 候选消费 + 生命周期(含三振降级)+ 校准记分牌 + 三列看板/两模态/记分牌 UI + 手动创建 + file-over-app 落盘。

**明确延后**(schema 字段已预留,不用再改结构):
1. **AI 自动填候选**(quoted 捕捉 / nominated 提名的自动生成)—— 依赖 openclaw/hemory-vault;本期只消费外部生成的候选 JSON,挖不到就手填。
2. **状态快照 / 触发条件的自动采集** —— 依赖 Hemory 被动采集;本期手填或由外部 JSON 带入。
3. **Brier 分数 / 校准曲线极客模式**。
4. **每日"一次一张卡"轻量队列视图** —— 本期先给完整看板。

---

## 13. 验收标准

用户能在 note.md 里:**记下一个可证伪的决策(强制预测+信心)→ 到期被温和提醒 → 一到两次点按完成裁决 → 在记分牌看到校准与样本进度**,全过程产物是纯 markdown 的 `.note.md`(Obsidian/CLI 可直接读),而证据自动附着与候选自动生成是留好的、可插拔的空位。
