# 点评：《关系只在人确认处生长》

*对 note.md 关系系统产品原则的评审 —— 正反两面 · 欧美效率圈原则判定 · AI agent 时代适配性 · 竞争判断 · 2026-07-12*

> 被评审文档：《产品原则：关系只在人确认处生长》——捕获层（原始 `.md`）与关系层（`.note.md`）刻意分离；反链/召回索引只扫描 `.note.md`；素材必须经人一次明确动作（读过、留心得、连链接）才生成 `.note.md`、才入网。

---

## 一、正面：为什么这确实是个聪明的设计

**1. 它把"注意力署名"从习惯升格成了架构。** 此前产品的全部理念——写作残差、批注即数据、品味经济——都停留在方法与文案层面；这条原则第一次把它焊进索引器：图谱里每一条边都是一次人类判断的物证，反链索引本身成为用户的品味数据集。"高信噪比是设计出来的，不是清理出来的"是全文最硬的一句——它是对收藏家谬误（[Matuschak: Collecting material feels more useful than it usually is](https://notes.andymatuschak.org/Collecting_material_feels_more_useful_than_it_usually_is)）的**架构级**回答：别人靠自律降噪，这里靠入口。

**2. 它是对 agent 时代结构病的天然免疫。** agent 产出无限的世界里，任何自动结网的图谱必然被 agent 洪水淹没——一夜涌入一百份报告，自动关联的图谱直接变成填埋场。"关系只在人确认处生长"让思想网络对 slop 结构性免疫：捕获层随便机器倒，关系层一个字节都不被污染。这可能是该设计最大的时代价值，文档自身尚未完全说破。

**3. 工程理由是真实的。** 索引只处理结构统一、尺寸可控的 `.note.md`——召回快、回写稳、"系统只对自己能担保的结构负责"。这不是给哲学找补，是独立成立的架构收益。

**4. 与既有原则三位一体。** file-over-app 管关系用什么表达（[[wikilink]] 写在文件里，[Steph Ango: File over app](https://stephango.com/file-over-app)），伴生分离管谁写的（人机文本不混），本原则管关系何时被允许存在（人确认后）。表达、纯度、时机——三条腿互为支撑。

## 二、负面：三个必须打的补丁

**1.（最重）语义陷阱：同一语法，两种行为——违反最小惊讶原则。** 文档允许原始 `.md` 里写 `[[链接]]`，但它不入网。同一语法在两类文件中行为不同，正面违反[最小惊讶原则（Principle of Least Astonishment）](https://en.wikipedia.org/wiki/Principle_of_least_astonishment)——Obsidian 迁移用户第一天就会踩中并困惑："链接写了，反链面板为什么看不见？"**修法可以让原则更纯而不是妥协**：把"在原始 md 里亲手写下 `[[链接]]`"本身^^定义为确认动作——双括号打出的那一刻即人确认发生的那一刻，系统顺势生成伴生^^ `^^.note.md^^` ^^并挂入该链接。^^语法全局一致，原则反而更彻底：写链接即确认，确认即结网。

**2. 图谱范围 ≠ 检索范围，必须钉死。** 文档只用半句"可读、可搜、可用"带过。若被误读为"未确认素材不可发现"，就牺牲了 unlinked mentions 式的偶遇价值（"原来我三年前存过相关内容"——Roam/Obsidian 用户的真实依赖）。正确表述应升格为独立小节：**全文搜索与 agent 语义检索覆盖全库（含原始层），只有关系图谱是确认制的。发现靠检索，信任靠图谱，两层各司其职。**

**3. agent 在结网中的位置缺席。** 现文只写"不许自动结网"，会被批评为拒绝 AI 助力。应补 "suggest, never assert"：agent 可提议关系（进待确认队列），确认动作永远归人——AI 出候选，人出裁决，与产品整体分工（✦ 出稿 / ● 判断）严丝合缝。这一条补上，原则从防御姿态变为人机协作的积极设计。

**附一条表达建议**：工程理由（尺寸可控、召回快）与哲学理由（人确认）应分开陈述——外宣只讲哲学，工程放实现文档。否则有朝一日算力允许全库扫描时，哲学理由会被误认为工程借口的遮羞布。

## 三、欧美效率圈原则判定

| 原则 / 传统 | 判定 | 依据 |
| --- | --- | --- |
| **Calm Technology**（Mark Weiser & John Seely Brown） | ✅ 教科书级符合 | "默认沉默，而非默认喧哗"正是[《The Coming Age of Calm Technology》](https://calmtech.com/papers/coming-age-calm-technology)的主张：^^好技术索取尽可能少的注意力^^。Mem/Reflect 式自动关联推荐正是该学派批判的对象。 |
| **Zettelkasten 正统**（Luhmann） | ✅ 原教旨实现 | ^^卢曼对每张卡片放哪、连谁均为手工决定^^（[Schmidt (2018), ](https://sociologica.unibo.it/article/view/8350)*[Niklas Luhmann's Card Index](https://sociologica.unibo.it/article/view/8350)*[, Sociologica](https://sociologica.unibo.it/article/view/8350)）；"链接是思考动作而非存储副作用"是 [Ahrens《How to Take Smart Notes》](https://www.markwk.com/smart-notes.html)与 [Matuschak 常青笔记](https://notes.andymatuschak.org/Evergreen_notes)的共同教义。^^自动连接才是对 Zettelkasten 的背叛^^。 |
| **GTD**（David Allen） | ✅ 同构 | [GTD 五步](https://gettingthingsdone.com/what-is-gtd/)本来就^^把 Capture 与 Clarify 分开^^：^^捕获必须零摩擦，澄清才投入认知^^。本设计=捕获层零摩擦（照原样躺）+确认层有摩擦，是 GTD 两步论的图谱版。外宣可点名此对应。 |
| **File over app**（Steph Ango） | ✅ 显式继承 | 关系写在纯文本里，[原文](https://stephango.com/file-over-app)的标准（其他工具可直接操作同一文件）成立。 |
| **最小惊讶原则** | ⚠️ 现方案违反      已修正 | 见补丁 1；按"写链接即确认"修复后转为符合。 |
| **AI 产品主流风潮**（auto-enrichment：[Mem](https://mem.ai)、[Reflect](https://reflect.app)、Notion AI 一族） | ⚠️ 有意逆流 | 现在笔记类 AI 产品的行业默认方向是"AI 替你自动整理"——你存进一条东西，Mem 自动打标签、Reflect 自动找相似笔记连起来、Notion AI 自动归类总结。逆流即定位。      原因是，^^我判断：一定要保留一个完全可信自己脑子同步的空间，可以很小，但必须有^^。      代价是市场教育成本，收益是差异化与叙事权。 |

## 四、AI agent 时代的适配性判断

**结论：不仅适配，且比前 AI 时代更成立。** 三层理由：

1. **Grounding 质量**：context engineering 圈正在收敛的共识是"上下文必须被策展，而非堆砌"（[Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)——finding the smallest possible set of high-signal tokens）。^^人类确认层就是天然的最高信号密度上下文，agent 引用它的可靠性远高于全库 embedding 检索^^。
2. **Slop 免疫**：见正面第 2 条——这是对"agent 产出速度百倍于人类阅读速度"这一结构性事实的唯一架构级应对。
3. **双层映射双主体**^^：捕获层是机器的地盘（✦）^^，^^关系层是人的地盘（●）^^，与产品符号语言完全一致。

唯一前提是补丁 3（suggest, never assert）到位——否则"人确认"会在体验上退化为"人肉劳动"。

## 五、能否干掉 Obsidian / Roam

**这条原则本身干不掉任何人，但能做一件更值钱的事。** 干掉平台需要生态、迁移与十年打磨，原则不搬运用户；Obsidian 的"涌现派"用户（爱 graph view 与 {==unlinked mentions 的意外感==}{>>这一块还没有开发。[[unlinked 意外感]]<<}）视此设计为减法，不会迁移；Roam 无需你杀。

它能做到的是：**在"AI 后图谱信任危机"的战场上插第一面旗。** ^^自动结网工具的图谱正在被 agent 洪水冲垮口碑，对图谱失去信任的用户在增多^^——抢先命名 "consent-based linking / human-confirmed graph"，即拥有该品类的定义权。Obsidian 可以抄形（插件做白名单索引即可），抄不了魂：它没有伴生架构、不区分人机作者、默认哲学是 everything can link。护城河中等，先发叙事价值极大。

## 六、能否坚持

能，需一个条件加一个誓言。**条件**：三个补丁全部落地（写链接即确认、图谱≠检索声明、agent 建议队列），否则用户流失压力迟早逼出一个"自动结网开关"——**原则性设计死于第一个开关**。**誓言**：反过来把不可撤销性写进原则本身：^^"note.md 永远不提供自动结网选项"^^，像 Obsidian 承诺永不绑架数据那样，把承诺的不可逆当作卖点。原则的商业价值不在多正确，在于用户相信你十年后还守着它。

## 总评

这是本产品迄今含金量最高的一条原则：它把残差、纯度、注意力署名、slop 免疫全部压进同一个架构决策，并站在^^卢曼、Calm Tech、GTD 三个最经得起时间的传统的延长线上^^。打上三个补丁，配得上"天才设计"四个字的一半——另一半^^要等它在真实用户的抱怨里活过第一年^^。

---

### 引用来源

- Mark Weiser & John Seely Brown — [The Coming Age of Calm Technology (1996)](https://calmtech.com/papers/coming-age-calm-technology)
- Johannes F.K. Schmidt — [Niklas Luhmann's Card Index: The Fabrication of Serendipity, ](https://sociologica.unibo.it/article/view/8350)*[Sociologica](https://sociologica.unibo.it/article/view/8350)*[ 12(1), 2018](https://sociologica.unibo.it/article/view/8350)
- Sönke Ahrens — [How to Take Smart Notes（评述）](https://www.markwk.com/smart-notes.html)
- Andy Matuschak — [Evergreen notes](https://notes.andymatuschak.org/Evergreen_notes) · [收藏家谬误](https://notes.andymatuschak.org/Collecting_material_feels_more_useful_than_it_usually_is) · [Notes should surprise you](https://notes.andymatuschak.org/Notes_should_surprise_you)
- David Allen — [GTD 五步（Capture 与 Clarify 分离）](https://gettingthingsdone.com/what-is-gtd/)
- Steph Ango (kepano) — [File over app](https://stephango.com/file-over-app)
- Anthropic — [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（另见 [HN 讨论](https://news.ycombinator.com/item?id=45418251)）
- [Principle of Least Astonishment](https://en.wikipedia.org/wiki/Principle_of_least_astonishment)
- 自动关联风潮的代表产品：[Mem](https://mem.ai) · [Reflect](https://reflect.app)
- 站内姊妹文档：《2026-07-12-写得更少的时代-大纲的价值》（写作残差理论）·《2026-07-12-少写笔记写对笔记-AI时代笔记法》·《2026-07-12-notemd价值主张-信息屋》