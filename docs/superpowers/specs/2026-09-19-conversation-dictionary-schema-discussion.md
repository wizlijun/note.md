# 沟通词典：Schema 讨论稿

- 日期：2026-09-19
- 最后更新：2026-09-20
- 状态：用户已确认共享词条、按场景设规则、多个别称与统一正式名输出；v1 已实现并验证
- 已确认：Conversation Dictionary / 沟通词典；`conversation-dictionary.yml`
- 用途：用户本人参与沟通的 ASR 转写校正，不用于仅消费的外部内容
- 主规格：[沟通词典设计](2026-09-19-speech-alignment-plugin-design.md)

## 1. 先用实际情形检验模型

| 情形 | 应有行为 | 对数据模型的要求 |
| --- | --- | --- |
| 伟滔同时出现在产品会议和客户会议 | 一个词条，各场景分别确认纠正规则 | 词条与场景规则分离 |
| 两个不同的人都叫伟滔 | 可以有两个同写法词条，不自动合并 | 独立稳定 ID，名称不作唯一键 |
| “伟涛”在同一场景也可能是另一个真实名字 | 不依据旧确认强行替换 | 允许表达歧义，阻止冲突处自动应用 |
| 同一个产品有中文名、英文名、缩写 | 共用一个词条，用户选择唯一正式名，其余作为别称 | 别称与误识别分开，规则只输出正式名 |
| 产品更名，旧录音使用旧名称 | 正式名变更时展示全部受影响规则，并在一次事务中统一更新 | 正式名是唯一输出，变更需 CAS、journal 与 revision |
| 已确认一个 alias，后来团队出现同音新人 | 可单独停用这条规则，其他规则仍可用 | 生命周期在规则层，不只在词条层 |
| 用户只确定某一句的意思 | 只校正此次派生预览，不形成无限期规则 | 单次决定与长期批准分离 |
| 用户想以后都保留 ROC | 创建有明确场景的保留规则 | preserve 是规则，不需要虚构一个目标词条 |
| 用户作为嘉宾参加播客/YouTube 对谈 | 属于本人沟通，可适用 | 是否参与与发布平台分开 |
| 用户只是听播客、看视频 | 不适用，即使命中熟悉的人名 | 来源门禁先于匹配 |
| 对方直接给用户发语音，用户没回复 | 仍属于用户沟通 | 直接收件者属于适用关系 |
| 用户收到转发的陌生人语音 | 原语音仍按原沟通关系判断；转发附言可独立适用 | 转发不自动继承接收线程的参与资格 |
| 用户在会议上亲口引用节目内容 | 当前 ASR 对象是本次沟通的发言，可适用 | 实际说出的引用与粘贴的外部转写不同 |
| 一份文档混合会议转写与外部节目原文 | 按可定位片段分别判断，不能整体授权 | 请求限定一个来源片段 |
| 共享 Vault 中 Bruce 与 Alice 的参与会议不同 | 按词典服务的主体判断，不能按当前操作者替代 | 主体与批准者分开 |
| ASR 重新生成后文本位置变化 | 单次决定不能凭旧偏移应用到新版本 | 来源 hash + 精确位置 + 原观测值 |
| 跨场景联合会议暂时无法选择场景 | 返回待确定，不遍历全库尝试替换 | V1 单场景是执行限制，不是词条只能有一个场景 |
| 一个不相关场景存在歧义 | 仍可使用其他已验证场景 | 结构错误与局部语义冲突分开 |

词典解决的是写法校正，不证明两段沟通里的名字属于同一个现实人物。跨场景并入词条必须由用户明确选择，Agent 不能仅凭同名自动合并。

## 2. 模型选择

### 方案 A：场景下嵌套词条

`domains[].entries[]`，每个词条包含 canonical 与 aliases。

优点：小、容易手写，单场景读取直接。缺点：跨场景重复词条；误识别规则与正确名字绑在一起；单个 alias 停用、改名影响、同名歧义及多语言输出都难以精确表达。

### 方案 B：共享词条 + 场景规则（用户已确认）

三个集合分别承担一种职责：

- `domains`：在哪个沟通场景使用。
- `entries`：用户确认的词汇条目、唯一正式名及多个别称，不建立人物档案。
- `rules`：在指定场景把哪个观测写法归一到目标词条的正式名，或者明确保留。

候选、原文证据和一次性决定放在插件控制状态，不进入可移植词典。

方案 B 多了引用校验，但它解决的是已经出现的实际语义，不是预先建设通用知识图谱。V1 不引入场景继承、任意条件表达式、多人 ACL 或来源图数据库。

## 3. 推荐 YAML 形状

以下是完整可解析示例。保持 v1 字段兼容：`label` 明确为正式名，`forms` 保存正式名与别称。

```yaml
schema: notemd.conversation-dictionary.v1
dictionary_id: dict_example_01
revision: 1
updated_at: "2026-09-19T08:10:00Z"
subject_id: human:bruce
scope: user_communications

domains:
  - id: d_product_team
    name: 产品团队
    description: 用户参与的产品团队沟通。
  - id: d_customer_project
    name: 客户项目
    description: 用户参与的当前客户项目沟通。

entries:
  - id: e_weitao
    kind: person
    label: 伟滔
    forms: [伟滔, Weitao, Bruce, 滔哥]
    description: 用于本人的产品团队及客户项目沟通，不作为人物身份凭证。

rules:
  - id: r_team_weitao
    domain_id: d_product_team
    observed: 伟涛
    action: replace
    target:
      entry_id: e_weitao
      text: 伟滔
    application: automatic
    enabled: true
    confirmed_by: human:bruce
    confirmed_at: "2026-09-19T08:10:00Z"

  - id: r_customer_weitao
    domain_id: d_customer_project
    observed: 伟涛
    action: replace
    target:
      entry_id: e_weitao
      text: 伟滔
    application: suggest
    enabled: true
    confirmed_by: human:bruce
    confirmed_at: "2026-09-19T08:10:00Z"

  - id: r_team_roc
    domain_id: d_product_team
    observed: ROC
    action: preserve
    enabled: true
    confirmed_by: human:bruce
    confirmed_at: "2026-09-19T08:10:00Z"
```

### 为什么这样分字段

- `dictionary_id` 稳定标识整份词典，不用可变路径冒充身份；迁移路径不改变 ID。新设备仍需建立本机批准基线。
- ID 使用插件生成的稳定随机标识；示例用可读占位值。ID 不包含会随编辑变化的 kind、名称或场景含义。
- `label` 是唯一正式名，也是所有替换规则的最终输出。同名不同词条可以用 description 消歧。
- `forms` 包含正式名与用户认可的别称，不包含 ASR 误识别。别称不形成全局替换；生成 Skill 必须为每个有证据支持的“别称 × 场景”生成独立规则提案，由用户逐项或集中批准。
- V1 的 forms 使用字符串列表，不加语言标签；输出选择由 `label` 唯一确定，多语言别称不等于翻译规则。
- replacement 的 `target.text` 必须与该 entry 的 `label` 完全一致。后端提交时从 entry 派生该值，不接受 Agent 或界面把别称保存为输出。
- 保留 `target.text` 是为了兼容现有 v1 文件和便于审计。正式名变更必须在一个人工事务中重写所有引用规则，不能产生新旧输出并存。
- 每条规则只有一个 observed，便于独立暂停、审阅和定位冲突。UI 可以把相同目标下的多条规则合并显示为“常见误识别”。
- `domain_id` 必须指向一个明确场景；一条规则只对应一个场景。多个场景通过不同规则引用同一 entry，不使用共享场景数组来混合批准粒度。不能用空值、`*` 或缺省表示全局。
- 向其他场景复用映射时创建新规则并单独确认；改写或停用原场景规则不影响其他场景。UI 可以聚合展示；历史整理时用户可以选择多项已展示的规则一次提交，但 Agent 不能代替批准。
- `action: preserve` 不含 target 或 application：它只阻止该观测区间被替换，不代表某个人或术语实体。
- `application: suggest` 表示“这个映射值得建议，不代表每次都正确”；`automatic` 表示满足范围、场景和匹配条件后可用于派生输出。两者都必须经过人工批准才能进入规则集合。
- `enabled` 表示当前是否启用；过去确认过的事实保留在历史中。停用某一规则无需废弃整个词条。
- `subject_id` 指这份词典服务的用户；`confirmed_by` 指作出决定的人。V1 限单主体、批准者为该主体，不设计委托审批；多人共享 Vault 不代表词典自动共用。

## 4. 必须规定的不变量

### 4.1 结构与引用

1. domains、entries、rules 分别具有唯一 ID，跨集合可通过类型明确区分；名称与显示文本不要求唯一。
2. 空词典可以三个集合皆空；可以先建条目但暂时没有纠正规则。
3. forms 是字符串列表，不含空文本，按 NFC 后的精确文本去重；每个 entry 至少一个 form，且必须包含与 label NFC 等价的正式名。
4. rules 的 observed 非空；replace 必须含有效 entry 引用，target.text 必须等于该 entry 的 label；preserve 禁止 target/application 字段。
5. replace 的 observed 与 target.text 在比较规范化后不能相同；这类“不要改”应使用 preserve。
6. 不允许无场景规则、悬空场景引用、未知 action 或错误字段类型；这些是结构错误，整份词典停止写入与应用。
7. 人工修改 entry 的 label/forms、rules 的 domain/application 都通过统一决定事务，变更一次 revision 加一；修改 label 时同一事务重写全部引用规则的 target.text。
8. 词典中没有 `pending`；所有可应用内容都必须与人工提交基线一致。YAML 上的 actor 字符串不能独立构成人工批准。

### 4.2 既有 v1 词典迁移

早期 v1 允许 `label` 只作显示名、rule 输出任意 form。为保持文件兼容，不升 schema 版本，也不静默猜测正式名：插件仍能读取并校验旧结构，但 status 标为 `migration_required`，在迁移前禁止 list、resolve 与批次提交。

首次打开显示每个词条当前 label、所有别称以及按当前选择动态计算的完整规则影响。用户可逐项修改正式名；一次提交要求覆盖全部 entry，以 base revision 与文件 SHA 做 CAS，保留旧正式名为别称，统一重写所有 replace target，移除变成无操作的规则，并把同场景、同观测、同词条的重复规则保守合并（任一 suggest 则保留 suggest，任一停用则保持停用）。对该词条已有规则覆盖的场景，现有别称会生成独立的 suggest 归一规则；没有既有场景的词条不会猜测适用范围。revision 只增加一次，并通过 journal 保证崩溃恢复和 transaction ID 幂等。合规词典也可通过相同事务修改正式名。已安装的旧版生成 Skill 只在内容 hash 精确匹配官方旧版本时原位升级；检测到用户修改便停止覆盖，Skill 与 AGENTS.md 的整组升级有恢复 journal，失败或重启不会留下新旧混合状态。

每次插件成功创建或提交词典时，同时在本地 `control.json` 的 `baseline_dictionary` 字段保存与当前可信基线逐字节一致的恢复副本。初始化发现正式词典缺失时，只有副本 SHA-256、dictionary_id、revision 与 subject_id 全部匹配控制基线及当前用户才原位恢复；副本缺失、损坏或身份不一致继续失败关闭，不创建空词典，也不丢弃待审批批次。有效旧词典升级后会补建该副本。

### 4.3 歧义与保留

- 同 observed、同场景、不同目标是**可表达的歧义**，不应靠禁止录入来掩盖真实情况。
- 冲突目标只要有一条启用规则就计入歧义，包括 suggest 规则；不能因另一个规则标 automatic 就强行胜出。
- 冲突只阻止相关命中自动替换，返回候选集合供判断；其他场景和无冲突规则仍可使用。具体候选超过三个时提示有更多可能，要求缩小语境，不能挑前三项冒充完整集合。
- 关闭一条规则后可解除歧义。两个同 entry、同输出目标的规则不重复应用；UI 应提示重复，保存时禁止完全重复的规则定义。输出文本相同但指向不同 entry 时仍报告歧义，不据此自动认定是同一个人。
- preserve 覆盖其命中区间上的 replacement；禁用 preserve 后才恢复其他规则。UI 保存 preserve 时展示被阻止的规则。
- 同一原文位置的重叠匹配不按置信度或最长字符串自行胜出；保留原文并报告冲突。
- 采用单轮替换，A→B 与 B→C 不能连锁变成 A→C。

### 4.4 “人确认”有两个强度

- **仅纠正这次**：用户确认某个观测 occurrence 的替换；只影响该次派生输出，不修改词典，不增加词典 revision。
- **保存为场景规则**：用户批准可复用映射，明确场景及“只建议/可自动应用”；才进入 YAML。

这两个动作不是重复确认弹窗。它们是不同的用户意图，应当在提交前选择；一次提交只做用户选择的动作。默认推荐“仅纠正这次”，避免把一次判断放大为长期规则。

“这次保持原文”与“在此场景始终保留”同样区分；忽略候选也不等于建立 preserve。

## 5. 来源上下文应单独建模

推荐以**适用主体与原沟通的关系**为主轴，传播渠道只作描述。来源上下文进入 resolve/propose 和决定证据，不进入通用词条。

```json
{
  "schema": "notemd.conversation-dictionary-context.v1",
  "subject_id": "human:bruce",
  "communication": {
    "id": "comm_20260919_interview",
    "kind": "conversation",
    "user_relation": "participant",
    "basis": {
      "type": "user_statement",
      "detail": "用户说明自己是本次对谈的嘉宾"
    }
  },
  "source": {
    "resource": "ssot/meetings/20260919_interview/transcript.md",
    "content_kind": "asr_transcript",
    "distribution": "podcast",
    "content_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "span": { "start": 0, "end": 9 }
  }
}
```

- communication.kind：`meeting | call | voice_message | conversation`，只描述实际沟通形态，不以发布平台分类。
- user_relation：`participant | direct_recipient | consumer | unknown`。前两类具备范围资格；consumer 不应用；unknown 待补证。
- basis：用户说明或来源元数据；来源元数据必须附资源定位。插件校验声明结构并展示依据，不声称能认证真实参与。
- source.content_kind：`asr_transcript | derived_text`。派生摘要不作为识别错误的独立证据；新错误候选须能定位回原始转写。
- source.distribution 可缺省、自由描述，不参与准入计算，避免不断添加平台枚举。
- `communication.id` 只标识原沟通，不创建沟通管理数据库。调用者没有稳定 ID 时可以缺省，用来源定位与 hash 绑定该次请求，不能随意把不同来源合为一个沟通。
- hash 是源文本 UTF-8 字节的 SHA-256；span 是该版本文本的 Unicode code point `[start, end)`，不是音频秒数。显示用时间码另存 locator，不与字符偏移混用。
- source.resource 缺失时允许提交提供文本的人工审阅草稿；hash 针对提供的完整片段，span 相对于该片段，明确标为调用者提供。没有版本绑定的草稿不能自动复用为单次校正。
- 源文件已变化，旧 occurrence 决定失效等待重定位；不能只凭 observed 相同就套到新位置。
- 直接粘贴、转发的外部逐字稿保留原沟通关系，不因进入用户线程而变为 participant；用户现场说出的引用则属于当前沟通。
- 混合来源请求 V1 要求调用者先分段，不实现来源图；未能分段就保留原文。

未知参与关系可接收“来源待核实”的候选草稿以供人补充，不能用于自动应用或批准长期规则。已明确 consumer 的材料不进入这份词典候选队列。

## 6. 一次决定如何避免被错误复用

occurrence 至少绑定：原沟通/来源定位、源文本 hash、span、observed。用户决定另存输出和 actor/time，引用候选 hash。提交前重读可用源文件并比较 hash 与 observed；引用材料失效时只允许保存待审草稿，不能声称已验证当前来源。

规则批准与 occurrence 决定是不同类型的决定，都有 UUID 和不可变历史；一次操作可以明确选择“仅这次”或“这次并保存规则”。它们共用事务机制，但前者不写词典。

跨设备复制 YAML 仍需要建立本机可信基线；将 subject_id 换成另一个用户不等于已获得相同批准。V1 不做多人合并和跨设备自动授权；新的主体使用独立词典路径及控制状态。

词典确认可以脱离具体转写进行：用户在词典里手动创建正式名、别称或规则，不必伪造一份来源。具体候选的决定必须绑定它实际看到的证据，二者不能混淆。

## 7. 现在保留的能力与延后项

现在设计清楚：稳定 ID、共享条目、唯一正式名与多个别称、每个观测一条规则、正式名统一输出、逐场景规则、主体边界、单次/长期决定、规则启停、来源版本与歧义结果。

延后实现：多场景同时自动匹配、基于日期/参会人的布尔条件、自动失效、规则优先级、完整来源图、多人委托审批、跨设备批准同步、ASR 热词导出、发音、模型训练。

不预先设置万能 `metadata` 来绕过契约。冻结 schema 时应定义严格核心字段与明确可保留的扩展区；未知会影响匹配的字段不能被旧客户端静默忽略。协议升级需要显式版本和迁移，而不是声称所有未来字段都天然兼容。

## 8. 待讨论的产品选择

1. **词条共用方式（已确认）**：共享 entries、场景分别确认 rules；每条规则只对应一个场景，多个场景可以引用同一 entry。
2. **确认默认强度**：推荐默认仅纠正这次，保存为长期规则必须明确选择；不增加第二次确认弹窗。
3. **已知但可能歧义的规则**：推荐支持 suggest 与 automatic，不能把“曾确认过”解释成“以后总自动替换”。
4. **来源平台边界**：推荐排除“仅消费的外部内容”，允许“用户作为参与者录制的公开对谈”；这是对本人沟通边界的具体化，不将普通播客转写纳入。

主规格按上述共享词条与逐场景规则模型同步更新。确认默认强度与 application 的设计仍是明确标注的建议，并非用户已经确认；后续讨论可调整 UI 默认行为，不应再次把单次判断与长期批准合并为一个含混状态。

## 9. 存量字幕生成对 Schema 的补充

用户要求通过 Skill 一次性计算历史沟通字幕，找冲突和可归并写法，生成在界面确认/修改的数据集。采用独立 dataset schema 承载未确认提案、证据与覆盖清单，不在正式词典中添加 pending 词条。

正式词典只需补充稳定 dictionary_id，以便扫描基线不依赖文件路径；原 domains/entries/rules 模型保持不变。新增条目和场景使用 dataset 局部 proposal 引用，插件在人确认时分配正式 ID 并持久保存映射。

审阅单位是一条场景规则/变更提案，不是每一次字幕出现。同一规则跨很多字幕的证据可以聚合；跨场景映射、不同目标身份和既有条目合并必须保留独立决定。用户可在界面选择无冲突变更集中提交；这与 Agent 代替人批准不同。

完整数据集协议、Skill 正文建议和验收见 [存量字幕生成设计](2026-09-19-conversation-dictionary-dataset-skill-design.md)。
