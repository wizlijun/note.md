# 当 agent 在跑，人该做什么

**——写给 note.md 的一篇场景论纲（2026 年初趋势快照）**

全文分两部分：

- **第一部分**回答"agent 在跑时，那段被解放出来的注意力该去哪"——论证深度专注、亲自消化 AI 产出，是等待期的正解。
- **第二部分**回答一个更尖锐的问题："那段时间产出的数据，归谁所有？"——论证新一批 AI app 正在争夺这个生产力入口、用数据锁定留住用户，而这恰恰是 note.md 的机会。

---

# 第一部分：那段被解放出来的注意力

## 1. 一个正在被普遍问出来的问题

2026 年初，欧美效率圈、生产力圈和 AI 圈几乎同时撞上了同一个问题：**当 AI agent 接手一个任务、开始长时间自主运行时，坐在屏幕前的人到底该做什么？**

这不是一个修辞式的问题。编码 agent 一次跑几分钟到几十分钟已是常态，知识工作里的"深研究 / 长任务"也在拉长。过去的工作节奏是"我做一步、看一步"，现在变成了"我发起、它执行、我等待"。等待，第一次成为知识工作者日程表里一段结构性的、反复出现的空白。

围绕"这段空白该怎么填"，业界迅速分裂成了两条对立的路线。

## 2. 两条对立的路线

### 路线 A：编排者（orchestrator）——把等待用于并行

主流的、声量更大的一派主张：既然一个 agent 在跑，你就该同时开好几个，把自己升级成"编排者"，在多个 agent 之间快速切换。

- Addy Osmani 在 O'Reilly Radar 的文章里描述编排者的人力投入是"前置"（写规格）加"后置"（审阅结果），中段"你去处理更高层的设计或别的工作，你的 AI 团队在写代码"。\[1\]\[2\]
- Forbes 的 Philip Maymin 干脆把文章标题写成《深度工作的终结：为什么 agentic AI 奖励善于切换上下文的人》，主张"瓶颈不再是我们专注的能力，而是我们监督许多 agent 的能力……你发起一个任务，agent 干活，你切去做别的，你在轨道上运行"。\[3\]
- Claude Code 官方的异步工作流指南，把后台化子 agent（Ctrl+B）明确设计成"让你和 Claude 继续处理别的任务"——"这个在跑，我们先来搞数据库 schema"。\[4\]

这一派的潜台词是：**^^专注不再稀缺，切换才是新技能^^。**

### 路线 B：深度专注——重要的事，就留在一个上下文里

但一条同样强劲、且有经验和认知科学双重支撑的反向共识，正在成形。它的核心主张恰恰相反：**做重要功能、做深度工作时，^^人不该在 agent 运行期切换到别的项目分散注意力，而应留在当前任务的上下文里^^。**

- victoronsoftware 的结论很直接：**"在处理重要功能或缺陷时，避免切换。你需要把全部心力保留在这个任务的上下文里，才能交付最好的软件。"** 他把这称为"单任务模式 / 深度专注模式"——一边监控进度，一边向前规划、准备测试环境，**保持你的上下文完整**。\[5\]
- Atomic Object 的建议是：**"等待期间你能做的最好的事，是领先 agent 一步。审阅上一轮产出、排好下一个 prompt、规划验证。"** 并警告"高效的拖延"（productive procrastination）这个陷阱。\[6\]
- super-productivity 直接把"切换上下文"列为等待期的"两大陷阱"之首，把"开另一个任务 / 刷 Slack / 刷社媒"归为"上下文破坏者"，并劝告"别开任何你会后悔半途放弃的东西"。\[7\]

值得注意的是，这两派其实不是水火不容——**多数作者持的是"双模式"折中：例行、低风险的任务可以并行 2–3 个；而重要的、深度的工作，就该专注单干。** 我们要占据、要放大的，正是后半句。

## 3. 并行不是越多越好：2–3 的"有界最优"

即便在最鼓励并行的编码场景里，"无限 fan-out"也被实践证伪。

开发者 Sean C. Davis 用 Claude 连续实测两整天后总结：**"四个并发会话太多了"；"同时开两到三个项目感觉刚刚好"；"只做一个时我觉得太慢、总有个 agent 在等我，而做四个时总有个 agent 在空等我。"** 他强调："人的思考是让这一切运转的关键。哪怕编码 agent 能越来越久地独立工作，它们仍然需要人的输入。"\[8\]

这个"有界最优"有旁证：Cursor 的 Multitask ^^建议并发 agent 上限约 3 个以避免"上下文颠簸"^^。换句话说：**并行的甜蜜点很窄，超过它，人就成了瓶颈。** 克制，而非最大化，才是正解。

（诚实边界：Davis 说的是主观"感觉刚刚好"，来源是个人博客与从业者共识，非受控研究；且这是 2026 年初的快照——随着模型自主时长变长，这个上限未来可能上移。）

## 4. 真正的敌人：doomscrolling gap

如果"等待期该专注"，那专注地对抗的到底是什么？答案被多位作者点名了同一个词：**^^doomscrolling gap^^（刷手机空窗）。**

- Osmani 逐字写道：**"Vibe Kanban 解决的是 doomscrolling gap——那 agent 在跑、你无事可做的 2 到 5 分钟。"** 他把这段时间导向结构化看板：审 diff、管 worktree、看任务卡。\[2\]
- Atomic Object 说得更重：^^doomscrolling 是等待期"你能做的最糟糕的事^^"——**"你从等待里回来时比开始前更累，而现在你却要用一个被掏空的大脑去审阅 agent 的产出。"**\[6\]

这一句是整篇论纲里最锋利的产品钩子。它把问题从"打发时间"提升成了一个**质量问题**：agent 产出的价值，取决于你审阅它时的认知状态；而刷SNS会在你最需要清醒的那一刻把你掏空。**^^空窗不该被 doomscrolling 吞掉，而应转向审阅、规划、深度阅读这类高杠杆的认知活动^^。**

## 5. 理论支点：别让 AI 替你读

从"编码等待期"往上抽象一层，触到了一个更根本的命题——它来自语言学者、^^《Who Wrote This?》^^作者 Naomi S. Baron（美利坚大学荣休教授）：

> "阅读是一条通往反思、自我理解与智识成长的古老路径。如果我们把阅读外包给机器，就放弃了这些机会……我们最后拿到的解释与判断，是机器人的，不是我们自己的。"
>
> "尤其对那些能吸引我们、挑战我们的材料，阅读的过程本身就是一种思考。"\[9\]

这段话为 note.md 这类工具提供了理论支点：**AI 可以帮你预处理信息、可以给你建议、可以标出你遗漏的盲区；^^但意义建构这一步，必须由人亲自完成^^。** 阅读与思考不可切分——一旦把它整段外包出去，被侵蚀的是人的成长本身。

（诚实边界：这是规范性论证而非受控实验，且是条件式的——"**如果**我们把阅读外包出去"。有引导的、脚手架式的 AI 辅助阅读反而可能促进理解。所以我们的主张不是"AI 阅读有害"，而是"**AI 预处理、人来消化**"这条更精确的分工线。）

## 6. "审阅/规划"也是深度工作——正是工具该服务的地方

有人会说：连深度专注派的权威也主要把等待期导向"同一个任务的规划与审阅"（排下一个 prompt、审上一轮 diff），而不是"读新知识"。这看似削弱了阅读器的用武之地。

恰恰相反。**"审阅 AI 产出、规划下一步"本身就是一件需要工具去读、去消化、去批注的深度工作。** 你要读懂一段 agent 生成的长代码/长文档/研究报告，要在上面^^标出疑问、写下判断、记下"这里它漏了什么"^^——这就是阅读、消化、批注。它不是阅读器的反例，而是阅读器最高频的使用场景。

于是"等待期该做什么"的答案，在产品上收敛成一件事：**用一个称手的工具，把 AI 预处理过的内容读进去、想清楚、留下你自己的痕迹。** 无论那内容是"同任务的下一步"还是"AI 建议你补的盲区"，落点都是同一个——一个{==让人亲自做意义建构的地方==}{>>可能是写作思考空间的价值点<<}。

这就把我们带到了第二个、也更尖锐的问题：**这段时间产出的数据、留下的痕迹，到底归谁所有？**

---

# 第二部分：那段时间的产出，归谁所有？

## 7. 生产力入口争夺战：谁在抢这段时间

第一部分论证了"等待期该专注地读与想"。但一个残酷的现实是：**这段被 AI 解放出来、含金量极高的注意力时间，正在被新一批 app 争夺，成为它们的"生产力入口"。** Claude、Codex、Notion AI、Cursor……谁能占据"你审阅、你思考、你记录"的那个界面，谁就占据了用户时长和数据。

而这套打法是有明确剧本的。

**剧本一：把数据变成护城河。** 硅谷 VC 的经典教条来自 Greylock 的 Jerry Chen——护城河已从"数据的来源"转向"你拿数据做了什么"，他明确点名"数据的良性循环……制造出另一道护城河：高昂的切换成本"，并直白地开处方："你要让他们的切换变得尽可能困难……这些都可以成为一种锁定。"\[10\]（注：Chen 原文谈的是企业级软件的防御性，把它推及消费级生产力 app 是合理外推，非其字面范围。）

**剧本二：争当"编排层"，把所有活动收进来。** 2026 年 5 月 13 日，Notion 把自己的工作区变成了外部 AI agent 的编排中枢——通过新的 External Agents API，把竞品的 agent（Claude Code、Cursor、Codex、Decagon）作为**原生、被追踪的参与者**接进来，CEO Ivan Zhao 的框定是"任何数据、任何工具、任何 agent"。\[11\] 表面看这是开放，实质是**一场争夺入口的竞赛：无论你用哪家最好用的 agent，产生的所有跨工具活动都被 Notion 的工作区吸收、沉淀在它的基础设施里。**（研究中"Notion 的策略是锁定的反面"这一说法在对抗性验证中被否掉 1-2 票——它更准确的读法是"用更聪明的方式占据入口"，而非无私开放。）

**为什么这种锁定在 AI 时代更难挣脱。** 有分析者区分了两种锁定：\[12\]

- **浅锁定（shallow lock-in）**：导出麻烦、自定义字段、集成债——这些 AI 其实正在**瓦解**，因为迁移无非是翻译和清洗，AI 很擅长。
- **深锁定（deep lock-in）**：当一个 agent 吞进你 18 个月的记录、邮件、上下文，"由此形成的机构知识被编码进了厂商的基础设施里，而不是一种能干净迁移的可携格式"。AI 让上下文越有用，这种深锁定就**越强**。

一句话：**旧的锁定是"你的文件搬不走"，新的锁定是"你的上下文、你和 AI 共同积累的判断，被锁在了别人的服务器里"。** 竞争的标的，已经从"座位"变成了"嵌入你工作流的深度"。

## 8. 用户真正要的：数据所有权 + 跨工具自由

与这股锁定潮对抗的，是一套成熟得多、也权威得多的思想谱系。

**local-first：本地文件是"主副本"。** 2019 年 Ink & Switch / Martin Kleppmann 等人的同行评审论文《Local-first software》奠定了这个框架，逐字写道："所有数据访问都得经过服务器，你只能做服务器允许你做的事……你并不完全拥有那份数据——云厂商才拥有。"以及："一旦服务关停，软件就停止运转，用它创造的数据也就丢了。"\[13\] 它给出的解法是一次**架构反转**：**用户设备上的那份副本才是主副本，服务器只持有次副本。**\[14\]

**格式即所有权：纯文本会活得比厂商久。** 同一篇论文指出，纯文本、JPEG、PDF 这类格式"如此普及，很可能未来几个世纪都还能读"，美国国会图书馆也把 XML/JSON/SQLite 列为归档推荐格式——**"你的工作应当无限期地保持可访问，哪怕做出这个软件的公司已经消失。"**\[14\]

**file-over-app：Obsidian 的产品哲学。** 2023 年 Obsidian CEO Steph Ango 提出的"文件先于应用"原则，几乎就是 note.md 的产品宣言：**"时间拉长看，你创造的文件比你用来创造它们的工具更重要。应用是短暂的，但你的文件有机会长存。"** 他直言今天大多数数字产物"被存在服务器里、数据库里，锁在联网和云端登录背后"，并把这原则表述为\*\*"对工具制造者的一个呼吁：承认所有软件都是短暂的，把数据的所有权交还给人。"\*\*\[15\] 值得一提的是，Ango 把这条原则也用来自我要求 Obsidian——这种自省让它比营销话术更可信。

**互操作已经在赢——只要用户确实在用多个工具。** 最有力的一个反锁定实例来自 AI 编码本身：2026 年 3 月底，OpenAI 发布了官方 Apache-2.0 插件 `codex-plugin-cc`，**它安装并运行在竞争对手 Anthropic 的 Claude Code 内部**，通过开放的 MCP 插件架构委托给本地 Codex CLI，用量计在开发者自己的 OpenAI 订阅上、不新建任何围墙花园。\[16\] The New Stack 的评论一针见血："传统剧本说要锁住用户……OpenAI 反其道而行，而经济账解释了原因"——**因为开发者本来就同时在用多个工具，与其锁不住，不如去用户已经在的地方跟他们会合。** 这证明了一件事：**在用户明显要跨工具的场景里，开放会赢。**（范围限定：这条反锁定证据目前只在"AI 编码、本地委托"这个子领域被证实，不能直接推及云端托管的生产力/笔记 app。）

## 9. note.md 的位置：反围墙花园的那块基底

把两部分接起来，note.md 的定位就清晰了：

**它不加入编排者的军备竞赛，也不去当那个吸走所有活动的"入口"。它做的是那块任何入口都锁不住的基底——纯 Markdown 文件。**

- 第一部分说：等待期的高价值活动，是**亲自读、亲自想、亲自批注** AI 的产出。
- 第二部分说：这些高价值活动产生的痕迹，**不该被锁进任何一家 app**。
- note.md 的答案：**让这些痕迹，从第一秒起就是你磁盘上一份 Obsidian 和命令行都能直接解析的纯 Markdown 文件。** AI 可以帮你预处理、可以给你建议、可以进来读写——但产出永远躺在你自己的文件里，可迁移、可跨工具、独立于任何厂商。

这正是 file-over-app 在 AI 时代的必然延伸：**当别人争着做"入口"、用你的上下文织成护城河时，note.md 争的是"归属"——让你的工作，无论经过多少个 AI，最终都落回你能带走的一份文件。**

## 10. 对 note.md 的产品指引

1. **两条价值线合一。** 对外只讲一句话：**"AI 在跑时，回到你正在读、正在想的那件事——而它的产出，永远是你自己的文件。"** 深度专注（第一部分）+ 数据所有权（第二部分）是同一个承诺的两面。
2. **把"审阅 AI 产出"做成一等场景。** 读 AI 预处理过的长文/diff/研究报告，低摩擦、可批注、可留痕。伴生笔记（`.note.md`）、行内批注就是"人亲自做意义建构"的落点——继续加深。
3. **纯 Markdown 是不可动摇的地基。** 坚持 file-over-app：文件是主副本，Obsidian/CLI 可直接解析，不靠专有格式、不靠云端登录才能读。这是对抗深锁定的结构性优势，宣发上要旗帜鲜明。
4. **直面深锁定的真问题——上下文可携。** 这是最诚实、也最关键的一条：**纯文件只保证了"内容"可携，但没自动保证"AI 积累的上下文/判断"可携。** 新型锁定恰恰锁在后者。note.md 若要真正兑现"反锁定"，需要回答：AI 衍生的上下文如何也留在本地、可导出？（例如本地向量/嵌入、可导出的上下文、自带模型 BYO-model。）这既是产品护城河，也是叙事必须自洽的地方——否则"数据所有权"会被追问穿。
5. **克制地对待"并行"与"入口"。** 不渲染"同时开十个项目"，也不假装要做那个吞掉一切的中枢。研究显示并行甜蜜点只有 2–3 个。note.md 站在"少数项目、深度耕耘、数据归你"这一边，更真诚也更耐用。

## 11. 宣发口径（可直接取用的表达）

- **一句话定位**："AI 在跑时，别刷手机——回到你正在读、正在想的那件事。而它产出的一切，永远是你自己的文件。"
- **对立面锚定（入口 vs 归属）**："别人争着做你的生产力入口、用你的上下文织护城河；我们只做那块谁都锁不住的基底——你能带走的纯 Markdown 文件。"
- **质量论点**（第一部分最有力）："AI 产出的价值，取决于你审阅它时是否清醒。doomscrolling 会在你最需要清醒的那一刻掏空你。"
- **所有权论点**（第二部分最有力）："应用是短暂的，你的文件会长存。"（呼应 file-over-app）
- **分工线**（最精确，避免反噬）："让 AI 替你**预处理**，别让 AI 替你**读**；让 AI 进你的文件干活，别把你的文件锁进 AI。"
- **克制姿态**："我们不比谁开的项目多，也不想当那个吞掉一切的入口。少数项目，深度耕耘，数据归你。"

## 12. 诚实边界（内部备忘，勿写进对外文案的主体）

**第一部分相关：**

1. **证据性质**：核心一手源多为博客/从业者观点（Osmani、Davis、victoronsoftware 等），非受控研究。**流传甚广的量化数字（"中断后 23 分 15 秒回神""每天 96–120 分钟切换损失"等）在对抗性验证中被 0-3 否掉、溯源存疑，不要引用。** 需要量化时改用定性表述。
2. **两派并存，未收敛**：不要把我们的论点包装成"业界唯一共识"，更诚实的框定是"针对深度/重要工作的那一半"。
3. **领域偏差**：第一部分的一手证据几乎都讲编码 agent，外推到通用阅读/学习需论证桥接；Baron 的阅读论点是唯一非编码支点。

**第二部分相关：**  
4. **强时效**：这是 2026 年初的快照，关键事实只有数周/数月大（Notion External Agents API 2026-05 私测、codex-plugin-cc 2026-03 底发布、Anthropic 2026-04 转向用量计费）。发布前须复核状态。  
5. **锁定"机制"证据偏软**：Greylock 教条与 local-first/file-over-app 谱系**证据很硬**（同行评审论文、原始 essay、一手 GitHub 仓库、TechCrunch + Notion 官博）；但"2026 年 AI app 具体如何锁人"的分析来自策略/研究博客（VaaSBlock、Antoine Buteau），是有旁证的分析而非厂商一手文档，按"informed analysis"对待。  
6. **两条被否声明**：①"Notion 的策略是锁定的反面"被否（1-2）——它更像"更聪明地占据入口"；②"主导厂商有直接动机阻止互操作、故标准化不会自发出现"被否（1-2）——互操作前景未定，别把它说死。  
7. **互操作反例是子领域特定的**：codex-plugin-cc / MCP 只证明了 AI 编码子领域，**不能当作对云端生产力/笔记 app 围墙花园的普遍反驳**。  
8. **Greylock 引用瑕疵**："new moats"定义出自 Chen 2017 旧文（所引 2023 URL 已 404），且"消费级生产力 app 锁定"是超出其企业级本意的合理外推——引用时注明。  
9. **最大的未决问题（对第 10.4 条至关重要）**：纯 Markdown 中和了"浅锁定"，但**未必**中和"深锁定"——新型锁定锁在 AI 编码的上下文/判断里，而非文件内容里。note.md 必须给出"上下文也可携"的答案，否则"数据所有权"叙事会被追问穿。这是产品和宣发都要正视的软肋，也是真正的机会所在。

---

## 引用来源

**第一部分：**

1. Addy Osmani, *Conductors to Orchestrators: The Future of Agentic Coding*, O'Reilly Radar, 2026. https://www.oreilly.com/radar/conductors-to-orchestrators-the-future-of-agentic-coding/
2. Addy Osmani, *The Code Agent Orchestra*. https://addyosmani.com/blog/code-agent-orchestra/
3. Philip Maymin, *The End Of Deep Work: Why Agentic AI Rewards Context-Switchers*, Forbes, 2026-02-21. https://www.forbes.com/sites/philipmaymin/2026/02/21/the-end-of-deep-work-why-agentic-ai-rewards-context-switchers/ （*Forbes contributor 单一观点，引用需注明立场*）
4. *Asynchronous Workflows*, Claude Code guide. https://claudefa.st/blog/guide/agents/async-workflows
5. Victor, *Multitasking with AI Agents*. https://victoronsoftware.com/posts/multitasking-with-ai-agents/
6. Atomic Object, *Your Agent Is Working — 26 Things To Do While You Wait*. https://spin.atomicobject.com/agent-wait-26-things-to-do/
7. Super Productivity, *What To Do While Waiting For Claude Code*. https://super-productivity.com/blog/what-to-do-while-waiting-for-claude-code/
8. Sean C. Davis, *Finding Balance with Context Switching*. https://www.seancdavis.com/posts/finding-balance-with-context-switching/
9. Naomi S. Baron, *Letting AI Read for Us Can Undermine Our Thinking*, Stanford UP Blog, 2024-01.（原 typepad 链接已失效，经 blog.sup.org 官方镜像核实）https://blog.sup.org/

**第二部分：**

10. Jerry Chen (Greylock), *The New New Moats* / *The New Moats*. https://greylock.com/greymatter/the-new-new-moats/ （*"new moats" 定义出自 2017 旧文；所引 2023 URL 已 404，内容经检索+二手源核实*）
11. *Notion just turned its workspace into a hub for AI agents*, TechCrunch, 2026-05-13；Notion 官博 *Introducing the Developer Platform*. https://techcrunch.com/2026/05/13/notion-just-turned-its-workspace-into-a-hub-for-ai-agents/ · https://www.notion.com/blog/introducing-developer-platform
12. VaaSBlock, *Enterprise AI Vendor Lock-in & Switching Costs*, 2026；Antoine Buteau, *Seven Powers in the AI Era #5: Switching Costs*. https://www.vaasblock.com/research/enterprise-ai-vendor-lock-in-switching-costs-copilot-agentforce-2026/ · https://www.antoinebuteau.com/seven-powers-in-the-ai-era-series-5-switching-costs-workflow-lock-in-is-not-the-same-as-user-pain/ （*策略/研究博客，按 informed analysis 对待*）
13. M. Kleppmann, A. Wiggins, P. van Hardenberg, M. McGranaghan, *Local-First Software*, Ink & Switch / Onward! 2019 (DOI 10.1145/3359591.3359737). https://www.inkandswitch.com/essay/local-first/ · https://martin.kleppmann.com/papers/local-first.pdf
14. 同上（论文中关于"主副本/次副本"架构反转、纯文本与 LoC 归档格式、无限期可访问的论述）；美国国会图书馆推荐格式声明 https://www.loc.gov/preservation/resources/rfs/data.html
15. Steph Ango (Obsidian CEO), *File over app*, 2023-07. https://stephango.com/file-over-app
16. OpenAI, *codex-plugin-cc* (Apache-2.0), 2026-03. https://github.com/openai/codex-plugin-cc ；The New Stack, *The AI Coding Tool Stack*. https://thenewstack.io/ai-coding-tool-stack/ （*反锁定证据仅限 AI 编码子领域，勿过度外推*）

*本文由两轮 deep-research 工作流产出后编写：第一轮（5 角度/抓取 20 源/89 声明→验证 25、确认 18）覆盖"agent 运行时人类该做什么"；第二轮（6 角度/抓取 25 源/121 声明→验证 25、确认 23）覆盖"数据锁定 vs 数据所有权/互操作"。研究快照时间：2026 年上半年的公开讨论。*