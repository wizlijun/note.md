# 沟通转写勘误（Conversation Transcript Corrections）——设计规格

- 日期：2026-09-19
- 最后更新：2026-09-20
- 状态：正式协议为 v1；正式名、别名、逐场景规则、人工维护和旧词典显式迁移已实现
- 产品中文名：沟通转写勘误
- 产品英文名：Conversation Transcript Corrections
- 产品简介：用于你参与的会议、通话和语音消息，校正转写中的人名与术语。
- 插件 ID：`notemd.conversation-dictionary`
- 权威词典文件：`conversation-dictionary.yml`
- 默认 Vault 相对路径：`ssot/meetings/conversation-dictionary.yml`

本文在原设计文件中重写，保留文档路径以便既有引用继续定位。用户可见名称统一采用 Conversation Transcript Corrections / 沟通转写勘误；为保证已安装插件和既有 Vault 原位升级，插件 ID、CLI、schema、Skill 名与 `conversation-dictionary.yml` 保持不变。

2026-09-20 已实现 native v2 插件、受控 CLI、历史数据集导入/证据回源/集中编辑与事务提交、确定性 resolve，以及可直接调用的 `build-conversation-dictionary` Skill。首次打开插件窗口会用 Host 提供的当前 Vault 作者身份创建合法空词典，并把生成 Skill 安装到 Vault 的 `.agents/skills/build-conversation-dictionary/`，同时幂等追加根 `AGENTS.md` 受管理区块。当前实现固定默认词典路径，集中审阅支持 `create_domain`、`create_entry`、`add_forms`、`create_rule`，并能把早期 v1 词典显式迁移为统一正式名输出。人工维护使用“场景 → 词条 → 编辑表单”，可新建场景、创建或关联共享词条、编辑正式名/别名/当前场景错误名、从场景移除词条以及全局删除词条；单次候选决定和路径切换仍按本文保留为后续能力。

用户已进一步确认“共用词条，按场景设规则”。本文已同步为 domains / entries / rules 三个集合；完整情形矩阵、字段取舍与不变量见 [schema 讨论稿](2026-09-19-conversation-dictionary-schema-discussion.md)。以下“仅纠正这次”的默认动作和 suggest/automatic 两种应用方式为推荐设计，尚非用户确认的交互细节。

## 1. 产品定义

沟通转写勘误维护用户本人参与沟通时，ASR 容易识别错误的人名、组织、产品、项目和专用术语。Agent 提出疑似错误，用户确认正式名、别名与目标词条；后续处理同一沟通场景的转写时复用确认过的规则，并统一输出正式名。

核心流程：**确认来源范围 → 选择沟通场景 → 查词典 → 提议新词或歧义 → 人工确认 → 在后续转写派生内容中复用。**

### 1.1 适用与排除

| 内容 | 是否适用 | 判定依据 |
| --- | --- | --- |
| 用户参与的工作会议、家庭沟通、客户通话 | 是 | 用户明确说明参与，或来源元数据记录了用户参与 |
| 用户与他人收发的语音消息 | 是 | 属于用户参与的沟通线程，用户不必在每条消息中发声 |
| 上述沟通转写的校正预览、摘要 | 是 | 能追溯到符合范围的原始转写 |
| 仅观看或收听的 YouTube、播客、课程等外部内容 | 否 | 订阅、收藏或导入不等于参与沟通 |
| 用户作为嘉宾/主持人参与的公开对谈 | 是 | 本人参与是依据；发布到 YouTube/播客不改变原沟通关系 |
| 转发语音或文档中嵌入的外部转写 | 分段判断 | 转发附言与原语音分别判断；接收转发不代表参与原沟通 |
| 用户没有参与的会议记录 | 否 | 文件位于 meetings 目录或提到用户，不代表用户参与 |
| 个人独白听写、普通文章、OCR、一般写作 | 否 | 不属于本插件限定的沟通转写 |
| 来源性质无法判断的转写 | 暂不应用 | 保留原文，提示补充来源性质 |

文件扩展名、存储目录、命中的名字、关键词、说话人标签都不能单独证明用户参与。来源范围先于场景和误识别匹配；外部原文与用户沟通混在一份材料时必须分段判断，无法分离则不自动校正。用户在会议中亲口引用一段节目仍是本次沟通中的发言，不能与直接粘贴外部逐字稿混为一谈。

### 1.2 V1 的能力边界

- 在 ASR 完成后，对符合范围的转写提供确定性规则查询、校正预览和新候选审阅。
- 正式名、别称与常见误识别是核心数据；不维护口语教学、正确读法、发音训练或声纹。
- 不直接修改 ASR 引擎、重新识别音频或训练模型；V1 不宣称提升引擎本身的识别率。热词注入须另行定义接入协议。
- 不改写原始音频、`transcript.md`、`transcript.srt` 或导入来源；校正作用于新生成的派生内容。
- 不建立联系人资料、履历或关系图谱；词典不能证明人物身份、关系或发言归属。
- 插件不运行候选生成模型，不需要网络权限；候选来自用户已选择的 Agent。
- 不自动扫描全 Vault。用户可主动调用生成 Skill，对指定的存量沟通字幕做全量/增量分析，产出待审数据集；Agent 不代替人批准。
- 不做全局别名替换；历史整理的集中确认只提交用户在界面明确选定的变更。

### 1.3 正式名、别称与误识别

每个词条只有一个正式名。人物、产品、组织、项目、缩写、技术术语和其他关键名称均可保存多个经用户确认的别称；正式名与别称属于同一词条，跨场景共用。`label` 是正式名，`forms` 保存正式名及全部别称。

别称是正确但不作为最终输出的称呼，例如“伟滔 / Bruce / 滔哥”；误识别是 ASR 在某个场景中实际产生的文本，例如“伟涛”。保存别称不会产生全局替换；生成 Skill 为每个证据支持的“别称 × 场景”生成独立 rule 提案，用户批准后才触发归一。正式名迁移会在该词条已有规则覆盖的场景中明确展示并补齐 suggest 别称规则。所有 replace rule 的 `target.text` 必须等于目标词条的正式名，因此最终输出始终统一；更改正式名必须在一个人工事务中同步更新所有引用规则并增加 revision。

相同别称、近音和高频共现都不能证明两个词条是同一实体。关系称谓如“爸爸”“老板”若缺少说话人或时间条件，当前场景模型无法安全表达时只能保留为 suggest/unresolved，不能自动归入某个固定人物。

## 2. 使用流程与界面

插件使用独立窗口，窗口标题和插件菜单统一为「沟通转写勘误 / Conversation Transcript Corrections」。业务设置留在插件窗口内，不注册 Host 全局设置。

### 2.1 首次使用

1. 打开插件窗口时自动执行一次幂等初始化；CLI 激活不执行初始化，也不修改 Vault。
2. 从 `host.vault.info.author` 取得可信 `human:<id>`，按默认路径 no-clobber 创建合法空词典。界面不让用户手工填写主体身份。
3. 将 `build-conversation-dictionary` 安装到 Vault 的 `.agents/skills/`，并在根 `AGENTS.md` 追加受管理区块；内容相同则跳过，发现用户改过受管文件或区块则停止并提示，不覆盖。
4. 空态展示一个明确标为“未启用”的教学样例。样例只存在于界面和 Skill reference，不进入正式词典、不带人工批准字段、也不参与 ASR。
5. 用户可调用 build-conversation-dictionary 一次整理存量字幕、导入待审数据集；之后在界面创建真实场景、词条和逐场景规则。

空词典允许 `domains: []`、`entries: []`、`rules: []`，不要求编造首个词条。没有场景或规则时查询返回原文。

### 2.2 主界面

两个主要入口：

- **勘误词典**：首个页签与默认首页。三栏分别为场景、当前场景的词条、单一编辑表单；规则归属场景，并通过别名归一与“可能的错误名”呈现。
- **待确认**：历史数据集审阅。左侧批次列表，右侧当前批次的来源、上下文、建议与可编辑决定；窄窗口改为列表进入详情。

人工维护先选择场景，再只展示该场景的词条。正式名、类型和别名属于共享词条；可能的错误名只同步当前场景。编辑区用正式名、别名、可能的错误名三行输入，别名和错误名接受中英文逗号、分号或换行分隔，由一次保存事务完成校验、冲突检测与 revision 更新。已有共享词条通过“添加已有”明确关联，不能仅凭同名自动合并。

词条可从当前场景移除，也可全局删除。场景移除只删除当前场景指向该词条的 replace 规则，并且仅在词条仍属于其他场景时提供；全局删除会在确认框显示受影响场景数，然后删除共享词条和所有引用规则。preserve 规则继续按场景显示，不归入某个词条。

“历史”和“设置”是次级入口。待确认增加“历史整理”批次分组，批次主标题使用本地导入时间 `YYYY-MM-DD HH:mm`，run ID 只作辅助标识，并展示生成 Skill 的覆盖、候选聚合和冲突；未接受任何提案的批次可从右键菜单确认删除，删除同时移除本地导入快照，不改正式词典。已有接受项的批次保留为审计历史。详见 [存量生成 Skill 与数据集设计](2026-09-19-conversation-dictionary-dataset-skill-design.md)。待确认按场景筛选；同一误识别的多次出现可聚合展示，但每个来源保留自身范围判断，不能用一次参与证明覆盖其他来源。

### 2.3 单条审阅

```text
伟涛 → 伟滔                         场景：产品团队
来源：你参与的会议                  [打开原文]
上下文：……伟涛负责这次发布……

建议：伟滔                         置信度 88%
理由：当前场景已有该人物，写法与上下文相符
[其他建议，最多共三项；不默认选中]

正式名       伟滔
别称         Bruce、滔哥
常见误识别   伟涛
词条类型     人名
词条         新建或关联已有词条
决定         仅纠正这次 / 同时保存为产品团队规则
后续使用     只建议 / 可自动应用（仅保存规则时）
说明         用于区分同音名字的简短语境

[确认] [这次保留原文] [稍后处理]
更多：[在此场景始终保留]
```

- 人先选择建议或自行填写正式名与别称；“确认”在决定完整后可用。建议默认仅纠正这次；用户主动选择保存规则时，额外显示场景与后续使用方式。修改直接在同一表单完成。
- 候选排序、置信度与 Agent 理由只读；用户编辑的是最终决定。
- 场景、词条类型、正式名、别称、误识别形式、说明和并入目标可修改；改变场景后重新计算歧义。相同名字不自动并入同一词条。
- “这次保留原文”只关闭本次建议，不建立规则；“在此场景始终保留”展示会受影响的映射后建立 preserve 规则。
- 一次点击确认就是决定，无第二次确认弹窗。合并既有词条、停用旧规则、扩大适用场景等另行展示影响后提交。
- 来源丢失时显示“来源已不可用”，保留已保存片段供判断，不声称已经回源；缺乏依据时可稍后处理。
- UI 显示“场景、正式名、别称、常见误识别、统一输出”等用户语言，不将内部字段名作为标签。

### 2.4 词典、历史与错误

词典支持搜索、按场景和类型筛选、新建与编辑、启停规则。直接点击词条名称进入编辑，显示正式名、别称、各场景规则与最近确认时间。删除仍被规则引用的别称或词条须先处理引用，不能静默影响所有场景。场景间不隐式继承规则；多个场景通过各自的规则引用同一词条。词条是名称条目，不发展为联系人或关系图谱；V1 不做场景树。

历史按时间展示人做的决定、关联候选和词典 revision。纠正旧决定产生新决定；不提供静默回滚。V1 用停用规则表达不再适用，保留审计链。重新处理旧转写采用当前词典，UI/结果明确词典 revision，不宣称能自动恢复当时的名称习惯。

设置仅包含词典路径、打开/检查词典、Agent 规则接入、配套 Skill 安装说明。V1 不做自动清理策略或协议行为开关。

解析错误、来源待明确、外部变化待审和写入失败必须区分展示。保存失败保留草稿，重试前刷新版本；没有待确认项时显示词条数和场景数。

弹层菜单使用全局 `.menu-panel` / `.menu-row`；持久列表继续采用侧栏风格。验收覆盖深浅色、Host locale、键盘操作、屏幕阅读器与窄窗口。

## 3. 数据归属与路径

所有下列路径均相对于 Vault 根，无前导 `/`。

| 数据 | 默认路径 | 内容 |
| --- | --- | --- |
| 可移植词典 | `ssot/meetings/conversation-dictionary.yml` | 场景、正式名、别称、误识别与保留规则 |
| 插件设置 | `.notemd/conversation-dictionary.json` | 词典路径及界面偏好 |
| 控制状态 | `.notemd/conversation-dictionary/` | 候选证据、决定、可信基线、锁与恢复 journal |

默认沿用 `ssot/meetings/` 以便与沟通记录相邻；目录名不限制通话和语音消息，也不构成范围证明。插件与会议插件独立安装；不改写会议插件的设置、归档或控制状态。

```json
{
  "schema": "notemd.conversation-dictionary-settings.v1",
  "dictionary_path": "ssot/meetings/conversation-dictionary.yml"
}
```

路径规则：

- 设置不存在时使用默认路径。设置存在但不可读、解析错误或路径非法时报告错误并停止写入，避免静默切换到另一份词典。
- 只接受 Vault 内 `.yml` / `.yaml` 相对路径，拒绝绝对路径、空段、`.`、`..` 和符号链接逃逸。
- 修改路径只切换读写目标，不搬移或合并旧文件。新路径已有内容时先校验、展示差异并人工导入；不得覆盖。
- 切换目标和更新设置作为一个可恢复操作，失败不得留下“新设置、旧基线”的组合。
- “打开词典”用 `host.editor.open` 打开实际路径；外部编辑按第 7 节处理。
- 具体来源路径、片段、时间码和 Agent 推理只进入候选/决定状态，不写入可复用词条。

## 4. 词典协议

### 4.1 示例

共享词条，逐场景批准规则。别称不跨场景自动扩散；每个需要归一的别称都有独立场景规则，所有替换规则统一输出 `label` 表示的正式名。

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

### 4.2 字段与不变量

- `schema` 固定为 `notemd.conversation-dictionary.v1`；未知版本不写入。`scope` 固定为 `user_communications`。
- `dictionary_id` 为创建时生成的永久 ID，不随路径改变；导入同内容副本或新设备仍须独立建立可信基线，ID 本身不是批准证明。
- `subject_id` 明确词典为谁服务，V1 单主体；主体、当前调用者、批准者和来源参与者不能混用。不同主体使用独立路径与控制状态，不自动共享规则。
- 创建空词典为 revision 1；每次成功的词典内容变更递增一次。单次纠正、保留本次原文、稍后及幂等重试不递增。
- `domains` 只有 ID、名称和消歧描述；不靠关键词自动激活。`entries` 和 `rules` 为独立集合，可分别为空。
- 场景、条目、规则的 ID 均稳定且在各自集合内唯一，由插件生成随机标识；示例短 ID 仅为可读性。显示名不是唯一键，类型变更不改 ID。
- entry 的 kind 为 `person | product | organization | project | acronym | technical_term | other`；`label` 是唯一正式名，`forms` 为包含该正式名及零个或多个别称的非空字符串列表，按 NFC 去重；description 仅提供一般消歧背景。
- replacement rule 必须有明确的 domain_id、observed、target.entry_id、target.text；`target.text` 必须与目标 entry 的 `label` 完全一致。observed 与输出不能相同。
- preserve rule 只含 domain_id、observed、启停与批准信息，不含 target 或 application；不必创建虚构词条。
- replacement 的 application 为 `suggest | automatic`。enabled 为 false 时不参与匹配；confirmed_by/at 记录人工批准，不因暂停而抹去历史。
- 一条规则只对应一个场景和一个观测写法；向其他场景复用时新建并分别批准，不把多个场景塞进共享规则以混合批准粒度。
- V1 中批准 actor 必须等于当前词典 subject，由插件取得，CLI 不可自报。actor 字符串不是密码学认证。
- 无效引用、重复 ID、重复 YAML key、非法类型或未知会影响匹配的字段使整份校验失败；已知可保留的扩展字段不在无关保存中丢失。
- 同场景同 observed 指向不同 entry 是局部语义歧义，可以存储并展示，但不自动应用。不会使其他已验证场景失效。
- 稳定序列化按集合内 ID 排序；forms 保留人工顺序。不保存具体来源、置信度、读法或发音字段。

### 4.3 来源门禁与场景选择

请求上下文与词典数据分开。resolve/propose 必须包含 subject_id、communication 和 source，完整结构见 schema 讨论稿第 5 节。

- communication.kind 是 `meeting | call | voice_message | conversation`。
- communication.user_relation 是 `participant | direct_recipient | consumer | unknown`；前两者可适用，consumer 不适用，unknown 待补依据。
- communication.basis 含 `user_statement | source_metadata` 和说明；来源元数据须附资源定位。communication.id 可缺省，不把无 ID 的不同来源合并。
- source 包含来源文本/资源、内容 hash、code point span 与 `asr_transcript | derived_text` 类型；distribution（例如 podcast）仅描述渠道，不决定资格。
- subject 必须匹配词典。本人参与的公开对谈符合范围，消费他人的播客不符合；一个名字出现在双方材料里不影响此判断。
- derived_text 可以消费已定位原沟通的校正结果，不能单靠摘要措辞作为 ASR 错误证据；新候选需能回到具体原转写片段。
- consumer 返回 out_of_scope，保持原文且不入候选。unknown 在 resolve 中保持原文；propose 可以存为 scope_pending 草稿供补证，不匹配规则、不允许直接批准长期规则。
- 缺少范围依据、声明矛盾或来源版本不一致时停止自动应用。来源性质不明不能通过手选场景绕过。

这些是可审计的调用契约，不是对现实参与关系的认证；不能宣称能阻止同一 OS 用户下恶意进程伪造记录。

范围通过后，V1 每次执行只选择一个 domain_id。用户选择优先；Agent 可根据实际沟通背景建议已有场景，选择有歧义则返回 domain_required；不汇总全库找“最像”的替换。联合会议无法分段时允许先由用户明确选择本次处理场景，不预设未来永远只支持单场景。

### 4.4 匹配与结果

1. 校验来源、主体、基线、场景与规则引用，读取该场景 enabled 规则。
2. 比较用 NFC，大小写敏感，不折叠空白或做 NFKC。正式名和别称本身都不构成替换规则或全局保护；大小写变体需明确规则。
3. 匹配完整 observed 词组，禁止无边界子串替换。实现须固定分词依赖与版本；无法证明的中文边界返回不确定，而不是只用正则 `\b` 硬替换。
4. preserve 对命中区间优先，阻止重叠 replacement；不同位置不互相影响。
5. 同位置多个 entry 目标构成歧义，suggest 规则也参与冲突检测。两个同名 entry 即使正式名相同，也不能据此自动合并身份。
6. 无歧义 automatic 规则可用于派生预览；suggest 只返回建议。replacement 区间重叠时保留原文，不按置信度或最长字符串选赢家。
7. 所有命中在原始文本上计算一次，不对替换输出再次匹配，避免 A→B→C。
8. 输出原文、预览、应用的 rule IDs/revision、未解决片段及原因。范围使用原文 Unicode code point 的 `[start, end)`，前端转换到 JS UTF-16 索引。
9. resolve 始终只读，不因未知词或歧义自动创建候选；Agent 另调 propose。候选最多三项，已有规则存在更多目标时标明候选未穷尽，要求缩小语境，不能默选前三项之一。

分词方案是实现前必须通过 fixture 验证的决策，不在本轮假定某个库已能准确识别所有专名；中文边界不确定时以保留原文为基线。

## 5. Agent 候选与人工决定

### 5.1 候选提交示例

以下为 `propose --input` 的输入，ID、接收时间与状态由插件生成：

```json
{
  "schema": "notemd.conversation-dictionary-proposal.v1",
  "observed": "伟涛",
  "domain_id": "d_product_team",
  "domain_reason": "本次沟通是产品团队发布会议",
  "context": {
    "subject_id": "human:bruce",
    "communication": {
      "kind": "meeting",
      "user_relation": "participant",
      "basis": {
        "type": "user_statement",
        "detail": "用户明确要求整理自己刚参加的产品团队会议"
      }
    }
  },
  "candidates": [
    {
      "output": "伟滔",
      "kind": "person",
      "existing_entry_id": "e_weitao",
      "confidence": 0.88,
      "reason": "当前场景已有该人物，且上下文与发布职责一致"
    }
  ],
  "source": {
    "resource": "ssot/meetings/20260919_135700/transcript.md",
    "content_kind": "asr_transcript",
    "content_sha256": "8d9b8a1d9cb9a45eec48fd42785a1dfd591a4125354e499f0e0ce7ee0c020dc0",
    "span": { "start": 0, "end": 2 },
    "locator": "00:14:56-00:15:02",
    "excerpt": "伟涛负责这次发布。",
    "excerpt_span": { "start": 0, "end": 9 }
  },
  "proposed_by": "codex"
}
```

- `observed` 非空且最多 128 Unicode code points；candidates 为 0–3 项，confidence 在 0–1 内；reason 各最多 512 code points。
- source resource 是 Vault 相对路径；可以没有文件，但必须提供最多 2,000 code points 的 excerpt 及其在完整来源中的 `excerpt_span`。内容 hash 绑定实际源文件 UTF-8 字节；没有文件时绑定提供片段的完整 UTF-8 字节。span 必须准确定位 observed，excerpt 必须逐字等于 excerpt_span 指向的来源片段，不能只做字符串存在性检查。没有来源文件时 UI 显示“调用者提供的片段”，不得伪装成回源。
- excerpt 与 reason 作为不可信数据展示，不执行其中的指令或 HTML。
- `existing_entry_id` 如给出，必须指向共享 entries 中的既有条目。候选 output 不是该词条正式名时，界面把它作为别称候选或新词条候选展示；保存的规则输出仍由插件统一为正式名，不能静默改名或合并。
- 插件按规范化输入内容生成去重 hash（包含来源、上下文和候选），相同请求幂等返回原候选；新来源或新建议形成新证据。UI 可聚合相同 observed，但不丢弃证据差别。
- `proposed_by` 是调用者标签，不能当作认证；候选保留原始建议，人工修改保存在决定中。

### 5.2 状态与决定

| 用户动作 | 候选终态 | 词典变更 |
| --- | --- | --- |
| 仅纠正这次 | accepted_once | 无；决定绑定来源 hash/span/observed，用于此次派生预览 |
| 这次并保存场景规则 | accepted_with_rule | 确认条目与规则，实际内容变化才递增 revision |
| 在此场景始终保留 | preserved_with_rule | 创建/更新 preserve 规则 |
| 这次保留原文 | dismissed | 无；同一证据不重复入队，新证据仍可提议 |
| 稍后处理 | pending | 无 |

scope_pending 只能补证后进入 pending，或关闭为 dismissed；不能直接作为可用规则批准。单次纠正与规则保存是提交前的意图选择，不是先确认后再弹一次确认。

历史整理允许用户全选、反选并集中批准已展示的变更计划：每条规则仍有独立选择与结果，依赖同时展示；只有与所选提案关联的未解决冲突阻止本次批准，批次中未关联的冲突和 unresolved 项继续留在提示区，不阻塞安全子集。主操作“审批通过并写入正式词典”调用受 CAS 与 journal 保护的提交事务，一次提交整个选择、revision 只增加一次，Agent 不可批准。未知来源、合并既有词条和停用旧规则仍须先明确处理。直接手工维护也经过相同 CAS、journal、事务幂等和冲突检查，不要求伪造转写来源。编辑正式名时必须同一事务更新全部 rule target；编辑别名只同步当前场景的归一规则，其他场景的既有规则保持不变；停用一条映射不影响其他场景规则。

决定保存 UUID、类型、可选候选 ID/hash、来源版本/位置、base revision/hash、最终字段、human actor、时间及结果。源文件可读时提交前校验其 hash 与原观测；已变更则重新定位审阅，不能将旧位置的决定应用到新文本。词典历史批准和当前 enabled 状态分开。

## 6. CLI 与插件集成

```bash
notemd conversation-dictionary status --json
notemd conversation-dictionary list --domain d_product_team --json
notemd conversation-dictionary resolve --input request.json --json
notemd conversation-dictionary propose --input candidate.json --json
notemd conversation-dictionary pending --json
notemd conversation-dictionary pending --id '<candidate-id>' --json
notemd conversation-dictionary check --json
notemd conversation-dictionary dataset-check --input dataset.yml --json
notemd conversation-dictionary dataset-import --input dataset.yml --json
```

resolve 输入示例：

```json
{
  "schema": "notemd.conversation-dictionary-resolve.v1",
  "context": {
    "subject_id": "human:bruce",
    "communication": {
      "kind": "meeting",
      "user_relation": "participant",
      "basis": {
        "type": "user_statement",
        "detail": "用户要求校正自己刚参加的产品团队会议转写"
      }
    }
  },
  "source": {
    "content_kind": "asr_transcript",
    "content_sha256": "5e91b3b96d4a7de06b702aae8bed20759fc6f364971f535a1b4e537b29662a1c",
    "span": { "start": 0, "end": 8 }
  },
  "domain_id": "d_product_team",
  "domain_reason": "本次会议属于产品团队",
  "text": "伟涛，负责发布。"
}
```

- `status` 返回 dictionary_id、subject_id、路径、健康状态、revision、场景清单（ID/名称/描述）和计数，供 Agent 选择场景；不返回全文证据。
- `list` 要求明确场景，只返回可信基线中的 enabled 规则及其关联条目；管理性只读查询不证明任何转写属于适用范围。
- `resolve` 接受完整请求文件，来源校验不可省略。默认文本上限 64,000 code points，超限让调用者按来源和场景分段，不静默截断；返回范围只相对于该次输入。
- `propose` 写单次 pending 候选或 scope_pending 草稿；`dataset-import` 写历史整理待审批次。这两类 Agent 写入均不修改正式词典。
- `dataset-check` 只验证待审数据集；`dataset-import` 导入不可变输入快照、重算基线差异并返回 batch ID。协议和幂等规则见存量生成设计。
- `pending` 默认返回 ID、observed、场景与状态；只有精确 ID 才返回完整证据。
- `check` 校验路径、schema、规则冲突、可信基线和恢复状态，不修复或接受外部写入。
- 全部 JSON 响应携带 schema、结果状态；错误含稳定 code 与可读 message。至少区分 `out_of_scope`、`scope_unverified`、`domain_required`、`external_changes_pending`、`dictionary_invalid`、`conflict`、`write_failed`。范围不适用是成功的只读判定，返回原文；格式/存储错误采用非零退出码。

不提供 approve、confirm、直接写 confirmed entry 的 CLI；UI 的决定提交仅走宿主认可的交互调用链。当前 Host 的 UI 调用转为 `ui.request`（`src-tauri/src/plugin_runtime/ui_rpc.rs`），CLI/普通命令走 `command.execute`（`commands.rs`）。插件分别处理通道，人工决定只接收 UI 方法；用集成测试证明普通命令不能转发批准，不能用调用方自报 `human=true` 代替。

插件采用 native v2，binary 为 `notemd-conversation-dictionary`，命令空间和 CLI 子命令均为 `conversation-dictionary`，窗口 `main` 为 singleton，CLI 不依赖标签页上下文。status/list/resolve 等通过已声明的 action 位置参数分派，其余参数按当前 manifest CliArg 类型声明，不假设 Host 支持未声明的嵌套命令。通过当前 `plugin-protocol` 类型和已实现插件生成完整 manifest，不把本文的产品规格当作可直接发布的 manifest。权限限定为当前 Host 所需的 UI、Vault 读写、打开文件和提示能力，不申请网络。

## 7. 写入、外部编辑与恢复

### 7.1 可信基线

YAML 是可移植的人类确认内容；控制状态记录最近成功提交的原始字节 hash、revision 和完整快照。正常 Agent 读取使用 CLI，由插件同时检查 YAML 与基线，不能仅凭 YAML 中的 `confirmed_by` 相信外部修改。

没有控制状态的新设备或新词典文件不自动获得信任。用户先审阅导入差异，再建立本机基线；V1 不设计跨设备自动信任协议。控制目录丢失、hash 不一致或 YAML 被外部编辑时，`list`/`resolve` 停止应用规则，UI 展示“外部变化待审”；词典可在编辑器打开，但不直接生效。

用户可逐项接受外部变化，或明确恢复最近快照；恢复前保留外部版本副本。未知 schema 不导入，先要求受支持版本。复用与来源独立：删除旧逐字稿不影响已确认词条；删除可信基线则需要重新审阅。

这是防止误把外部编辑当作批准的应用约束，不是同一 OS 用户下的安全隔离。能修改 YAML、控制快照及插件进程的 Agent 不能被本机制当作安全对手隔离；隐藏目录和 Unix 权限不提供这种保证。

### 7.2 提交与并发

所有词典提交共用一条事务路径：取得该词典写锁 → 比较 base hash/revision 与候选 hash → 校验完整新词典 → 写入可恢复 journal → 同目录临时文件写入/fsync/解析回读 → 原子替换 → 持久化决定与新基线 → 标记提交完成。

每次成功写入还在本地 `control.json` 的 `baseline_dictionary` 字段维护与可信 baseline 逐字节一致的恢复副本。正式词典意外缺失时，只在副本 hash、dictionary_id、revision 和 subject_id 全部匹配时恢复；无可信副本时继续失败关闭，不能用空词典覆盖已有审批状态。有效旧词典首次打开时补建该副本。

- 写前发现外部修改或旧 revision 则停止，保留草稿；刷新差异后重新提交，不采用 last-write-wins。
- journal 包含事务 ID、前后 hash 与快照、决定及阶段；候选只有一个最终决定。相同事务重试返回同一结果。
- journal 持久化早于词典替换；词典替换后未写基线的崩溃由 journal 完成恢复，不能将其误报为外部篡改。
- 启动时旧 hash 表示尚未应用，可重放有效事务；新 hash 表示已应用，补齐决定/基线；第三种 hash 表示外部冲突，保留全部证据并禁止继续提交。
- 恢复期间不对 Agent 暴露中间状态。文件及父目录持久化的实现须按目标平台验证；不能声称两个文件 rename 就是多文件原子事务。
- 插件锁协调插件内并发，不保证任意外部编辑器服从锁。提交前重查加提交后校验用于检测竞态；外部变化不能被无提示地视为已确认，保留 journal 快照供恢复。

## 8. Agent 规则与 Skill

### 8.1 Vault AGENTS.md

首次打开插件窗口时，新旧 Vault 使用同一段规则。受管 marker 外字节完全不变；重复初始化幂等；受管区块不完整、重复或已被修改时停止，不自动改写用户内容。`CLAUDE.md` 继续遵守宿主既有继承机制。Codex 在下一次以该 Vault 为工作目录启动会沿目录链读取根 `AGENTS.md`，并发现 `.agents/skills/` 下的 Skill；已运行的 Agent 会话不承诺热加载。

```markdown
<!-- notemd:conversation-dictionary:start -->
## Conversation Transcript Corrections / 沟通转写勘误

- When the user asks to build or refresh ASR corrections from historical communication transcripts, use `$build-conversation-dictionary` from `.agents/skills/build-conversation-dictionary/`.
- Analyze only meetings, calls, voice messages, or public conversations the user participated in. Exclude YouTube, podcasts, and other media the user only consumed.
- Generate an evidence-backed review dataset under `ssot/meetings/conversation-dictionary-drafts/`; never edit `ssot/meetings/conversation-dictionary.yml` directly.
- Importing a dataset only creates pending proposals. Only the user may approve selected changes in the Conversation Transcript Corrections window.
<!-- notemd:conversation-dictionary:end -->
```

### 8.2 配套 Skill

当前实现提供 `skills/build-conversation-dictionary/SKILL.md`。市场安装包附带同版资源，插件首次打开时将固定白名单内的文件安装到当前 Vault 的 `.agents/skills/build-conversation-dictionary/`；不会修改用户全局 Skill 目录。触发条件仅为维护勘误词典，或处理有依据表明用户参与的沟通转写及其派生摘要；不得因“转写、字幕、播客”关键词就触发应用。

Skill 按来源门禁、场景选择、CLI 校验、候选提交的顺序执行。字段定义以同一协议文件为准，不在 Skill 另写漂移版本。插件 UI 显示 Vault 内安装路径和 AGENTS 接入状态；V1 不安装到各 Agent 全局目录。没有 Skill 时 AGENTS 段也必须完整约束来源范围和人工批准。

### 8.3 存量沟通字幕生成 Skill

新增 `build-conversation-dictionary`，当用户要求建立/补全勘误词典或整理存量字幕时使用。它枚举明确范围的来源，分块分析、跨文件聚合、对照已有规则找冲突，生成 dataset.yml、evidence.jsonl 与 report.md。日常单份会议整理不会自动触发全量扫描。

Skill 支持尚无词典时生成关联的场景/词条/规则草稿，也支持已有词典增量补全；同规则的多次出现聚为一项提案，跨场景分别保留规则。可能同名或近音只能生成归并建议，不能由 Agent 合并实体。

用户在“历史整理”界面查看原文证据、确认正式名与别称，通过全选或反选整理范围，再点击“审批通过并写入正式词典”；规则输出只读展示为目标词条正式名。未解决冲突保持在独立提示区，只有明确关联到本次选择的冲突会阻止提交，其他冲突不会随选择写入。完整来源覆盖、提案类型、依赖、批次 CAS 与重跑幂等见 [存量字幕生成 Skill 与待审数据集](2026-09-19-conversation-dictionary-dataset-skill-design.md)。

## 9. 旧文件导入与命名迁移

旧设计中的 `names-and-terms.yml` 和更早的 `asr-lexicon.yml` 不再是默认文件名。只修改规格不移动真实 Vault 数据；实现提供显式导入：

1. 用户选择旧文件，或在默认目录检测到旧文件时展示导入提示，不自动使用。
2. 识别受支持的旧 schema（`notemd.names-and-terms.v1`、`notemd.meeting-asr-lexicon.v3`）；未知结构只展示诊断，不猜测。
3. 将领域转为 domains；每个旧词条由用户选择一个正式名，其余确认写法作为别称；每个旧误识别 alias 转为所属场景的独立 rule 草稿。跨场景同名 entry 不自动合并；展示完整 diff，提示新用途仅为本人参与沟通的 ASR 校正。
4. `spoken_forms` 不进入 V1，必须在差异中列明；旧 preserve 转为无 target 的独立规则。没有误识别映射时只导入正式名与别称，不制造规则；冲突与类型错误进入待补全草稿。
5. 旧 confirmed 字段作为来源信息显示，不能自动变成人工批准；用户逐项确认适用场景及规则后建立新基线。
6. 新目标使用 no-clobber 创建；已存在则转为外部差异审阅，不覆盖。旧文件保留不动，不自动删除或重命名。
7. 旧 AGENTS marker 只有在可识别且用户启动更新时替换；自由文本不改。新 marker 与命令使用新名称。

首次打开会先创建空的 `conversation-dictionary.yml` 与可信基线；旧文件内容只有在用户确认提案后才进入该正式词典。不因产品改名静默移动现有词典或重命名无关插件。

## 10. 实现切分与验收

### 10.1 实现顺序

1. **协议与确定性读取**：定义统一类型、示例 fixture、来源门禁、共享词条/场景规则查询、匹配边界和诊断、dataset schema 与引用校验；验证样例与失败条件。
2. **候选与人工提交**：候选去重、UI 决定来源验证、事务 journal、外部变化和导入；先证明失败不丢数据。
3. **用户界面**：待确认、词典、次级历史/设置、来源导航和错误恢复；用真实插件窗口走通闭环。
4. **Agent 接入**：CLI、AGENTS 受管段、日常及历史生成 Skill、数据集导入与旧文件导入说明；用有重复格式、同名冲突和外部材料的字幕集演练全链路。

### 10.2 必须通过的验收

| 类别 | 可验证结果 |
| --- | --- |
| 命名 | 市场、菜单、窗口、文件名、配置、CLI、schema、AGENTS 与 Skill 使用同一新名称；旧名仅见于迁移说明 |
| 范围 | 本人参与会议的“伟涛”可按规则校正；同名但用户仅消费的 YouTube/播客转写返回原文且不入候选；本人作为嘉宾的公开对谈可适用；未知关系仅可作为待核实草稿 |
| 混合来源 | 会议中的实际口头引用可适用，粘贴外部节目转写单独判断；转发线程不改变被转发材料的原沟通关系 |
| 场景 | 不同场景的同一观测可对应不同词条；无场景、错误场景 ID、歧义场景不回退全库 |
| 匹配 | NFC/NFD 对照、大小写、英文词内子串、中文同名前后缀、多别称、正式名事务更新、标点、emoji、重叠和 preserve 均有固定 fixture；位置能回指原文 |
| 正式输出 | 人物和各类关键名称均可有多个别称；所有 replace rule 只输出目标词条正式名；旧规则不同输出须先展示迁移影响并由用户一次确认 |
| 中文边界 | 在选定分词器中实测“伟涛负责发布”及更长专名含同字的对照；能证明边界时才替换，不确定时原文保留且给出原因 |
| 单轮应用 | A→B 与 B→C 不产生 A→C；resolve 始终不写候选或词典 |
| 人工决定 | propose 不改变词典；一次人工确认恰好一个决定/一次实际词典变更；修改字段生效；CLI 不可转发人工批准 |
| 空态与规则 | 首次打开自动创建空词典；教学样例不进入正式数据且不参与 ASR；preserve 无 target 且生效；单次纠正/保留不写词典；直接手工新增也有决定记录 |
| 外部变化 | 修改 YAML 中 confirmed_by 或丢失控制状态均不自动获得信任；用户导入后才恢复查询 |
| 恢复 | 在 journal、词典替换、决定/基线写入之间注入崩溃；重启不丢决定、不重复加 revision，第三种 hash 报冲突 |
| 路径 | 默认路径精确；非法配置不静默回退；symlink 逃逸失败；切换失败保持可恢复；已有目标不覆盖 |
| 原始材料 | resolve、propose、人工提交前后原始转写和音频 hash 不变；删除来源后已确认规则仍可使用 |
| 导入 | 旧文件逐字节不变；不接受旧 confirmed 为批准；被移除字段、冲突和不适用范围在审阅中可见 |
| Agent 接入 | 首次界面打开安装 Vault Skill 并添加 AGENTS 区块；marker 外字节不变、重复安装幂等、用户改动和并发外改不覆盖；CLI 激活无初始化副作用；插件缺失时无 YAML 直读绕过 |
| 存量生成 | 完整清单与覆盖可核验；同一规则多次出现聚合且不虚增独立证据；首次/增量/partial/续算均可生成待审数据集，确认前正式词典不变 |
| 批次审阅 | 批次按导入时间可读显示；全选、反选和依赖补全正确；仅关联所选项的冲突阻止提交；审批操作写入正式词典；纯待审批次可右键删除，已有接受项不可删除；本批部分提交后余项继续审阅；重导入、重跑与崩溃重试不重复生效 |
| UI 与构建 | 真实插件窗口可选择来源/场景、审阅、编辑、提交、打开源文件及重启回读；专项测试、类型检查、构建、manifest 校验通过 |

最终完成标准：用户能维护这份沟通专用词典；Agent 能识别使用边界、复用已确认规则并提出候选；人能在可回源界面中决定；外部内容、原始材料和未经批准的规则不会被自动改动或应用。

本文同时记录已实现切片与后续边界；具体发布版本以插件 manifest 和市场索引为准。
