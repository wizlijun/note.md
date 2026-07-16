# 深度研究原始结果：AI app 数据锁定 vs 数据所有权/互操作

> 这是第二轮 deep-research 工作流的完整产出存档，供撰写产品论纲  
> `[2026-07-15-what-humans-do-while-agents-run.md](./2026-07-15-what-humans-do-while-agents-run.md)` 时溯源使用。
>
> **研究问题**：欧美生产力/AI/local-first 圈关于"AI 生产力 app 争夺生产力入口与用户时长、  
> 通过数据锁定/围墙花园留住用户"的讨论与趋势，以及与之对抗的"数据所有权、local-first、  
> file-over-app、跨工具互操作"运动，对纯 Markdown、本地优先的 note.md 意味着什么机会。
>
> **统计**：6 搜索角度 / 抓取 25 源 / 抽取 121 声明 / 3 票对抗性验证 25 条 → 确认 23、否掉 2 / 综合后 9 条 / 108 个子 agent。  
> **快照时间**：2026 年上半年公开讨论。

## 综述

研究确认存在两股对立潮流。

**锁定侧**：经典 VC 剧本（Greylock 的 Jerry Chen）明确建议通过"数据的良性循环"和高切换成本建护城河；2026 年的实地报道显示，AI app 如今主要通过**累积的工作流依赖**和\*\*编码进厂商基础设施的、不可携的"机构知识"\*\*来锁人，而非靠价格——这是一种 AI 反而会强化的"深锁定"，即便它同时在瓦解旧式（导出摩擦型的）"浅锁定"。

**对抗侧**：一套成熟且来源扎实的 local-first / file-over-app 谱系（Ink & Switch/Kleppmann 2019；Steph Ango/Obsidian 2023）主张：真正的数据所有权要求本地文件成为**主副本**，以耐久、人类可读的格式（纯文本/Markdown）存在，活得比厂商久，并支持工具间自由迁移。

值得注意的是，AI 编码子领域**已经存在一股真实的反锁定潮流**（OpenAI 发布官方 Apache-2.0 插件，经开放的 MCP 架构运行在 Anthropic 的 Claude Code 内部、用量计在用户自己的订阅上），表明在用户明显多工具使用的地方，互操作能赢——这正是 note.md 的叙事切口：纯 Markdown 作为反围墙花园的基底，让用户的工作保持可携、Obsidian/CLI 可读、独立于厂商。

---

## 已验证发现（confidence 排序）

### 1. 锁定剧本是明文的 VC 教条 · high · 3-0

通过"数据的良性循环"（更多用户数据 → 更好的模型/产品 → 高切换成本）建护城河，并刻意用集成、固化的工作流、缺乏替代品来制造黏性，让客户无法离开。

**证据**：Jerry Chen（Greylock GP）提出护城河"从旧护城河（数据的来源）转向新护城河（你拿数据做什么）"与"智能系统"；点名"数据的良性循环……制造出另一道护城河——高切换成本"；并逐字开出锁定处方："你要让他们的切换变得尽可能困难……这些都可以成为一种锁定形式。"这是 note.md 叙事所反对的亲围墙花园教条。

**引用瑕疵**："new moats"定义出自 Chen 2017 的 *The New Moats*；良性循环/切换成本材料在 2023 的 *The New New Moats*（所引 URL 404，内容经检索+二手源确认）。"消费级生产力 app 锁定"框定是超出 Chen 企业级本意的合理外推。

**来源**：

- https://greylock.com/greymatter/the-new-new-moats/
- https://news.greylock.com/the-new-moats-53f61aeac2d9

### 2. 2026 年 AI app 靠"工作流依赖 + 不可携机构知识"深锁定 · medium · (工作流依赖机制 2-1；不可携知识 3-0；深浅之分 3-0)

2026 年，AI 生产力/agent app 主要通过累积的工作流依赖和编码进厂商基础设施的不可携"机构知识"锁人——这是一种 AI 会**强化**的"深锁定"，区别于 AI 正在**瓦解**的"浅锁定"（导出乱、自定义字段）；竞争标的是"嵌入的使用"而非"座位"。

**证据**：VaaSBlock："座位正在生成工作流依赖""被沉淀下来的是那份依赖"；当 agent 吞进 18 个月的记录/邮件，"由此形成的机构知识被编码进微软的基础设施里，而非能干净迁移的可携格式。"Buteau 明确区分"浅锁定"（糟糕的导出、自定义字段、集成债）与"深锁定"（组织"如何决策、如何协调工作、如何记住发生过什么"），论证"AI 擅长攻击浅锁定，因为那多是翻译和清洗"，而它通过让上下文更有用来强化深锁定。旁证广泛（Kai Waehner、The Register 2026-04-28、Kong、a16z CIO 调查：37% 用 5+ 模型对冲、NexGen 迁移耗 $315K/3 个月）。

**置信 medium**：两个一手源都是策略/研究博客（非厂商一手文档），且"座位 vs 使用"机制有一票异议（价格也在成为真实锁定杠杆——Anthropic 2026-04 转向用量计费）。两条相关声明被**否掉**：(a) Notion 策略是围墙花园锁定的反面；(b) 主导厂商的反互操作动机使标准化不太可能自发出现——两者都按未定处理。

**来源**：

- https://www.vaasblock.com/research/enterprise-ai-vendor-lock-in-switching-costs-copilot-agentforce-2026/
- https://www.antoinebuteau.com/seven-powers-in-the-ai-era-series-5-switching-costs-workflow-lock-in-is-not-the-same-as-user-pain/

### 3. "围墙花园"在 AI 语境的定义 · high · 3-0

AI 中的"围墙花园"是一个封闭生态：数据由单一实体控制，限制与外部系统的互操作，并产生厂商锁定和更高的用户成本。

**证据**：多个独立词条（ExpressVPN、AppsFlyer、Lenovo、Unite.AI）收敛的教科书定义："一个封闭生态，数据与信息由单一实体控制，限制访问与互操作性"，"会导致厂商锁定和更高成本"。2026 年企业经济学旁证（Forrester 论锁定加深；Parallels 调查：94% 担忧厂商锁定；约 19–34% 切换成本溢价）。

**来源**：

- https://iterate.ai/ai-glossary/walled-garden-explained
- https://www.expressvpn.com/blog/walled-garden
- https://www.appsflyer.com/glossary/walled-garden

### 4. Notion 把工作区变成外部 AI agent 的编排中枢 · high · 3-0

2026 年 5 月 13 日，Notion 通过新的 External Agents API 开放工作区，把竞品 agent（Claude Code、Cursor、Codex、Decagon）作为原生、被追踪的参与者接入——一个现存玩家竞相成为"生产力入口/编排层"、捕获所有人类+AI 活动的具体例子。

**证据**：TechCrunch + Notion 官博确认 2026-05-13 发布、四家具名 agent、External Agents API（Developer Platform v3.5 的一部分，含 Workers 运行时 + 数据库同步）、agent 作为可见/被追踪参与者（"什么在跑、谁批准的、它做了什么"）、CEO Ivan Zhao 的"任何数据、任何工具、任何 agent"编排层框定。

**微妙处**：External Agents API 以私测/候补名单形式发布（朝 Notion 3.6，2026-07-01 GA 推进），其究竟是"反围墙花园"还是更微妙的"占据工作区"策略有争议（"Notion 是锁定的反面"这一声明被否 1-2）。最佳读法：一个现存玩家通过吸收所有跨 agent 活动来争夺入口所有权。

**来源**：

- https://techcrunch.com/2026/05/13/notion-just-turned-its-workspace-into-a-hub-for-ai-agents/
- https://www.notion.com/blog/introducing-developer-platform
- https://www.techtimes.com/articles/317092/20260525/notion-opens-workspace-claude-code-cursor-codex-native-ai-agents.htm

### 5. AI 编码已存在真实的反锁定潮流：codex-plugin-cc · high · 3-0

OpenAI 发布官方 Apache-2.0 插件（codex-plugin-cc），它经开放的 MCP 插件架构**安装并运行在 Anthropic 的 Claude Code 内部**，委托给本地 Codex CLI，不新建运行时/围墙花园，用量计在开发者自己的订阅上——因为开发者无论如何都在用多个工具。

**证据**：一手仓库（github.com/openai/codex-plugin-cc，Apache-2.0，OpenAI org，2026-03-30/31 前后）确认可在 Claude Code 内安装运行（`/plugin install codex@openai-codex`），FAQ："经你本地的 Codex CLI……在同一台机器上委托。"The New Stack 框定："传统剧本说要锁住用户……OpenAI 反其道而行，经济账解释了原因"——去开发者已经在的地方会合以近零获客成本获取分发，用量计在用户自己的 OpenAI 配额（而非 Anthropic）。由 Anthropic 开放的、基于 MCP 的插件架构使能，该架构"设计上支持第三方集成，包括来自竞争对手的"。

**范围限定**：这条反锁定潮流在"本地委托的 AI 编码子领域"被证实；它**不**反驳云托管生产力 app（Notion AI、托管上下文）中的锁定。作为反证引用，而非普遍反驳。

**来源**：

- https://github.com/openai/codex-plugin-cc
- https://thenewstack.io/ai-coding-tool-stack/

### 6. local-first 经典框架：云/SaaS 剥夺数据所有权与能动性 · high · 3-0

Ink & Switch / Kleppmann 等人 2019 年 4 月（Onward! 2019）的经典框架论证：云/SaaS 剥夺用户的数据所有权与能动性，因为一切访问都经服务器中介、受厂商约束，一旦服务关停，软件停止运转、数据丢失。

**证据**：奠基性同行评审来源（Kleppmann, Wiggins, van Hardenberg, McGranaghan；DOI 10.1145/3359591.3359737），"local-first software"一词的出处。逐字："所有数据访问都得经过服务器，你只能做服务器允许你做的事……你并不完全拥有那份数据——云厂商才拥有"；"通过把数据存储集中到服务器上，云 app 也拿走了所有权与能动性……一旦服务关停，软件停止运转，用它创造的数据也就丢了。"

**来源**：

- https://www.inkandswitch.com/essay/local-first/
- https://martin.kleppmann.com/papers/local-first.pdf

### 7. 架构反转 + 耐久格式 = 真正的所有权与长寿 · high · 3-0

local-first 通过一次架构反转交付真正的数据所有权与长寿——用户设备上的副本是**主副本**（服务器只持有次副本）——以普及、人类可读的格式（纯文本、JPEG、PDF；加 LoC 推荐的 XML/JSON/SQLite）存储，很可能几个世纪都可读，因此哪怕厂商消失，工作仍无限期可访问。

**证据**：Ink & Switch："我们把你本地设备上的那份数据副本……当作主副本。服务器仍然存在，但只持有次副本"；"某些文件格式（如纯文本、JPEG、PDF）如此普及，很可能未来几个世纪都还能读。美国国会图书馆也推荐 XML、JSON 或 SQLite"；"你的工作应当无限期地保持可访问，哪怕做出这个软件的公司已经消失。"LoC 推荐格式声明独立确认 SQLite/XML/JSON/CSV 为归档格式。这是 note.md 纯 Markdown、file-over-app 价值主张的技术/耐久性脊梁。

**微妙处**：长寿以主动保存（冗余副本）为前提，专有同步/格式锁定可能削弱它——这反而更论证支持开放纯文本格式。

**来源**：

- https://www.inkandswitch.com/essay/local-first/
- https://martin.kleppmann.com/papers/local-first.pdf
- https://www.loc.gov/preservation/resources/rfs/data.html

### 8. file-over-app 原则：note.md 的直接产品哲学 · high · 3-0

Steph Ango（Obsidian CEO，2023-07）提出的 file-over-app 原则就是 note.md 的直接产品哲学：文件比创造它们的应用活得久，所以耐久的产物必须是用户可控的、易读格式的文件；今天的产物被锁在服务器/数据库、云登录与专有格式背后；这是对工具制造者的明确呼吁——"承认所有软件都是短暂的，把数据所有权交还给人。"

**证据**：逐字："时间拉长看，你创造的文件比你用来创造它们的工具更重要。应用是短暂的，但你的文件有机会长存"；"如果你想创造能长存的数字产物，它们必须是你能控制的文件，格式易于取回和阅读"；"今天大多数数字产物被存在服务器里、数据库里，锁在联网和云服务登录背后"；"file over app 是对工具制造者的一个呼吁：承认所有软件都是短暂的，把数据的所有权交还给人。"由 Obsidian CEO 提出——note.md 对齐的正是这个社区/哲学。值得注意的是它自省（Ango 把该原则也用于 Obsidian 自身），这比营销话术更增可信度。

**来源**：

- https://stephango.com/file-over-app

### 9. 真正的所有权要求人类可读、可导出/迁移的状态 · medium · 3-0（单一实验性仓库源）

真正的数据所有权要求人类可读、可导出/可迁移的状态，而不仅仅是把文件存在用户自己的存储里——CRDT-over-filesystem 模式表明 local-first、无服务器的同步在普通存储（本地 FS、Dropbox/GDrive 挂载、S3）上技术可行。

**证据**：作者论证"用户存储了文件，并不必然意味着用户拥有那些文件"，以及"状态的人类可读表示要被存在某处，使用户（至少能手动）导出数据、导入另一个应用"——一条直接的互操作/反锁定要求，强化了 file-over-app（纯 Markdown **就是**那种人类可读状态）。也演示了在"任何实现文件系统接口的存储（S3、本地文件系统\[挂载 Dropbox/GDrive\]、或 Dropbox/GDrive/任意 Drive API）"上构建、无中心服务器。

**置信 medium**：单一来源，自述为"一个未完成的实验……远未到生产就绪"，故它证明的是一种模式/设计论证，而非成熟度或采纳度。

**来源**：

- https://github.com/3timeslazy/crdt-over-fs

---

## 被否声明（不可引用）

| 声明 | 票数 | 来源 |
| --- | --- | --- |
| Notion 的策略是现存玩家围墙花园锁定的**反面**：不把客户留在单一栈内，而押注成为捕获活动的工作区/基础设施，任凭用户按任务挑选最优 agent。 | 1-2 | techtimes.com（Notion 报道） |
| 主导 AI 厂商在 AI 层有直接经济动机阻止互操作，故跨工具标准化不太可能自发快速出现。 | 1-2 | vaasblock.com |

---

## 注意事项（caveats）

**时效性**：这是快速演变的 2026 领域，多个关键事实只有数周/数月大（Notion External Agents API 2026-05-13 私测、朝 2026-07-01 GA；OpenAI codex-plugin-cc 2026-03 底发布；Anthropic 2026-04 转向用量计费）。竞争/互操作图景会变，发布前须核实状态。

**来源强度**：锁定**教条**与 local-first/file-over-app **谱系**来源很强（2019 同行评审论文、file-over-app 原始 essay、一手 GitHub 仓库、TechCrunch + Notion 官博）。"2026 年 AI app 具体如何锁人"的**当下机制**发现依赖策略/研究博客（VaaSBlock、Antoine Buteau）——被独立评论者充分旁证，但非厂商一手文档；按 informed analysis 对待。

**两处 Greylock 引用问题**："new moats"定义出自 Chen 2017 essay（非所引 2023 URL，该 URL 404），"生产力 app 锁定"框定是超出 Chen 企业级本意的合理外推。

**争议/未定**：Notion 之举是反围墙花园还是更微妙的"占据入口"（"它是锁定的反面"被否）；跨厂商互操作是否会从 AI 编码扩散到云生产力 app；数据护城河是否真的有效（a16z 曾论"数据网络效应被高估"）。AI 编码互操作反潮流（MCP、codex-plugin-cc）真实但**子领域特定**——**不要**当作对托管生产力/笔记 app 围墙花园的普遍反驳。

---

## 待解问题（openQuestions）

1. AI 编码中的开放插件/MCP 互操作趋势（用户明显多工具、厂商去用户所在处会合），会扩散到云生产力/笔记 app 吗？还是那些 app 因锁定是"深"的（累积上下文而非"浅"的导出摩擦）而保持围墙？
2. note.md 的纯 Markdown、file-over-app 模型真能中和"深锁定"吗？纯文件保证内容可携，但新兴锁定在 AI 编码的机构知识/上下文里——note.md 对"让 AI 衍生上下文也可携"（如本地嵌入、可导出上下文、BYO-model）的答案是什么？
3. local-first、数据所有权优先的工具，相对集成云 AI 的便利吸引力，实证需求/市场规模有多大——file-over-app 是主流楔子还是 prosumer/Obsidian 邻域的小众？
4. 监管（GDPR 第 20 条数据可携、EU 互操作规则）将如何与 AI 时代锁定互动，鉴于评论者指出可携性法律是为结构化个人数据设计、并不覆盖习得的/行为性的 AI 上下文？

---

*存档来源：deep-research 工作流 run `wf_085c9e04-41f`（task `w1xvxv9kp`），2026-07-15。*