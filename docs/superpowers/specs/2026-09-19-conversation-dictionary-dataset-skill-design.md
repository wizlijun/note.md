# 沟通词典：存量字幕生成 Skill 与待审数据集

- 日期：2026-09-19
- 最后更新：2026-09-20
- 状态：v1 数据集协议、生成 Skill、插件导入与集中审阅已实现
- 产品：Conversation Dictionary / 沟通词典
- 正式文件：`ssot/meetings/conversation-dictionary.yml`
- 生成 Skill：`build-conversation-dictionary`
- 关联：[主规格](2026-09-19-speech-alignment-plugin-design.md)、[schema 取舍](2026-09-19-conversation-dictionary-schema-discussion.md)

当前实现对 stale base 采取保守拒绝，要求重新生成数据集；尚未实现本文件第 7 节描述的逐项 rebase、拆分误聚合、旧规则停用和已提交决定纠正流程。v1 可提交类型固定为 `create_domain`、`create_entry`、`add_forms`、`create_rule`。

## 1. 用户流程

用户可以一次发起：

> 用 $build-conversation-dictionary 整理我参与的历史会议和通话字幕，找出可能识别错的人名、术语、同名冲突和可归并写法，生成沟通词典的待审数据集。

可以指定目录、文件清单、时间范围或只处理上次之后的记录。没有指定范围时，先从会议插件归档与用户明确授权的沟通目录形成扫描清单；无法推断边界时问范围，不顺便扫描所有 Vault 文档。

完整流程：**确定清单 → 按沟通来源分段 → 提取与比对 → 聚合同类建议 → 校验与输出数据集 → 插件集中审阅 → 人工提交所选变更。**

支持首次建词典和已有词典补全。用户不用先手工建齐场景或词条；Skill 可以生成场景、词条、规则的关联草稿，由界面一起展示和确认。

用户最终审阅的是按场景聚合的规则/归并建议，而非数千个 occurrence。同一场景“伟涛→伟滔”出现 200 次，只产生一项规则提案，附次数、来源分布、代表证据与反例。

## 2. 三种数据不能混用

| 数据 | 作者与用途 | 能否直接应用 |
| --- | --- | --- |
| 扫描来源与证据 | Skill 读取指定字幕，保留片段、定位、hash 与范围依据 | 否，只是证据 |
| 待审数据集 | Agent 生成拟新增/关联/修改的 domains、entries、rules，以及冲突和归并建议 | 否；没有人工批准 |
| 正式词典 | 用户在插件审阅后由提交服务写入 | 通过主体、场景与基线校验后才可应用 |

Skill 不直接生成带 confirmed_by 的正式词典，也不覆写现有 `conversation-dictionary.yml`。它输出可导入的**字典数据集**，不是只写一篇总结；插件将用户选择的修改编译为正式词典。原始字幕始终不变。

## 3. Skill 的处理要求

### 3.1 建立扫描清单和基线

- 固定目标 subject、已授权目录/时间范围、词典 dictionary_id/路径、词典 base revision/hash；无词典时记录 `state: absent`。
- 枚举文件并记录路径、内容 hash、来源关系、处理状态。用户明确说“这些都是我参与的会议”可以作为这份清单的参与依据，不重复要求逐文件确认。
- 仅消费的播客/YouTube 等外部材料排除；用户参与的公开访谈可纳入。未知参与关系列为待核实，不用于可批准的规则提案。
- MD、SRT、VTT 可以代表同一份沟通。优先使用包含完整文本和定位的一份，其他记录为 alternative_representation，避免把三种格式重复计算为三份独立证据。
- 格式损坏、不可读、超出范围、重复表示、来源不明分别记录；不能全都混为“跳过”。

### 3.2 分段计算与归并

按沟通/说话轮次或有界字幕块处理；长文件不一次塞入模型。块间可以保留重叠上下文，但 occurrence 以 subject_id + canonical_source_id + 源 hash + 原文 span + observed 去重。字幕 cue/timecode 用于回源，不能当作唯一文本身份。

每块提取：观测文本、可能的正确写法、场景建议、已有词典命中、最多三个候选、理由、证据定位与不确定性。不要把频率最高的写法直接当标准写法；高频错误仍然是错误。

完成分块后做跨块汇总：

1. 完全相同的“场景 + 观测 + 动作 + 目标”归为同一规则提案，合并证据而不扩大场景。
2. 相同 entry 可以被多个场景规则引用；每个场景仍为不同规则，分别批准。
3. 中文名/英文名/缩写可能指同一个词条时生成关联建议；仅凭谐音、相同字符串或高频不能自动合并。
4. 归并候选要同时保留支持与反对证据。不同沟通中的同名人物可以保持独立，用户可以拆分聚合结果。
5. 已有词典的确定性冲突（同场景、同观测、不同目标）与模型推测的“可能同人”分开标记；置信度不能把前者消除。
6. 新证据可能使旧 automatic 规则不再可靠时，生成审阅警示及可选的停用建议，不能由 Agent 自动停用旧规则。
7. 未知正确写法可以作为 unresolved 项保留原观测，不为了填满数据集编造 canonical。

### 3.3 覆盖与可恢复性

“一次性整理”指一次用户任务，可在多个计算批次完成。run manifest 保存文件 hash、块边界、处理游标、输入/规则版本和已完成产物；中断后只继续未处理或已变化的块，不把全量任务重新跑一遍。

覆盖至少记录 discovered、processed、excluded、unknown_scope、failed 的文件数，以及 planned/processed 块数。这些文件状态互斥且总和相等；批次状态 partial 时未处理文件归入 pending，计数中也必须显式出现 pending。

- completed 只表示清单中所有文件都有最终处理状态，不能宣称发现了所有 ASR 错误；存在 failed/unknown_scope 必须显示“有遗漏或待核实”。
- 跨文件建议必须关联已读取的完整原文块；只用搜索命中片段做过的分析标明局部覆盖，不计为整份处理完成。
- 扫描前后 hash 改变的文件重新计算或标记 changed，不能混合前后两版证据。changed 作为 failed 的具体原因保留。
- 基线词典或提取协议改变后重跑需重新比对；不能复用旧 prompt/schema 产物而宣称是新协议结果。
- 确定性脚本负责枚举、解析、hash、去重、引用校验和覆盖统计；Agent 负责语义候选与归并建议。长任务失败可保留 partial 数据集，不能假装全部完成。

## 4. 产物与目录

默认草稿路径：

```text
ssot/meetings/conversation-dictionary-drafts/<run-id>/
├── dataset.yml
├── evidence.jsonl
└── report.md
```

- `dataset.yml`：扫描清单及每份来源的处理范围、基线、提案、冲突、待解决项及对 evidence 文件的 hash 引用。
- `evidence.jsonl`：原文片段、来源定位、内容版本、参与依据与 occurrence；excerpt 上限沿用 2,000 code points，不复制整份字幕。
- `report.md`：覆盖、主要冲突、归并建议、未完成项及导入入口，便于不打开插件也能理解结果。

run-id 使用 UUID；这些文件不使用正式词典路径，不会被 list/resolve 误读。导入后插件保留不可变输入快照，修改与决定存入控制状态；再次生成使用新 run-id，不原地篡改已审阅输入。resume 仅允许修改尚未导入的同一 run；已导入部分结果之后续算必须产生新 dataset ID 并引用 parent_run_id。

## 5. Dataset 协议草案

数据集 ID 唯一采用 run_id（UUID），文中 batch ID 仅指插件本地审阅会话。可选 parent_run_id（UUID）关联已导入快照之后的续算产物。一个 run_id 只能导入一个不可变快照；导入另计算整个 dataset 文件字节 hash 并校验证据文件 hash。必须复制并持久化校验过的同一组字节，不能校验后再次读取可能变化的文件充当快照。不同 run 的同内容通过证据与正式规则层去重，不假定随机 ID 能跨 run 自动去重。

建议单独 schema：`notemd.conversation-dictionary-dataset.v1`，不能与正式词典 schema 混用。

```yaml
schema: notemd.conversation-dictionary-dataset.v1
run_id: "853f8a64-51d4-4dc8-8a97-8bd6d98784a3"
subject_id: human:bruce
state: completed
base_dictionary:
  state: present
  dictionary_id: dict_example_01
  path: ssot/meetings/conversation-dictionary.yml
  revision: 4
  sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
selection:
  roots: [ssot/meetings]
  date_from: "2026-01-01"
  date_to: "2026-09-19"
coverage:
  discovered: 2
  processed: 2
  excluded: 0
  unknown_scope: 0
  failed: 0
  pending: 0
  chunks_planned: 2
  chunks_processed: 2
evidence_file:
  path: evidence.jsonl
  sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
sources:
  - id: src_01
    canonical_source_id: communication_a_transcript
    resource: ssot/meetings/meeting-a/transcript.srt
    content_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    status: processed
    eligible_ranges: [[0, 9]]
    processed_ranges: [[0, 9]]
  - id: src_02
    canonical_source_id: communication_b_transcript
    resource: ssot/meetings/meeting-b/transcript.srt
    content_sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    status: processed
    eligible_ranges: [[0, 9]]
    processed_ranges: [[0, 9]]
proposals:
  - id: p_entry_01
    kind: create_entry
    value:
      kind: person
      label: 伟滔
      forms: [伟滔]
      description: 产品团队沟通中的人名写法，待用户确认。
    evidence_ids: [ev_01, ev_02]
    reason: 两次沟通存在可归并的写法；同一人物关系尚须用户确认。
  - id: p_rule_01
    kind: create_rule
    depends_on: [p_entry_01]
    value:
      domain_ref: {existing_id: d_product_team}
      observed: 伟涛
      action: replace
      target:
        entry_ref: {proposal_id: p_entry_01}
        text: 伟滔
      application: suggest
    evidence_ids: [ev_01, ev_02]
    reason: 这两处观测可能是同一人名的 ASR 误识别。
conflicts: []
unresolved: []
```

示例路径与 hash 均为结构示意，不表示已扫描真实 Vault。真实生成器必须计算 hash 并附完整 evidence，不能复制示例占位值作为产物。

### 5.1 提案类型与引用

V1 的 proposals 是受限的变更意图，不接受任意 JSON Patch 或任意文件写入：

| kind | value 内容 | 批准效果 |
| --- | --- | --- |
| create_domain | name、description | 新建场景，插件分配永久 ID |
| create_entry | kind、label、forms、description | 新建共享词条，插件分配永久 ID |
| add_forms | entry_ref、新增 forms | 明确为已有条目添加正确形式，不改变旧规则输出 |
| create_rule | domain_ref、observed、action、target、application | 在指定场景创建规则 |
| merge_entries | 多个 entry_refs、建议保留条目及说明 | 先展示所有受影响引用，用户明确选择后合并 |
| disable_rule | 既有 rule ID、原规则 hash、理由 | 用户批准后停用指定规则 |

关联已有条目可以直接在 create_rule 中使用 existing_id，不需要复制 entry。references 必须恰好包含 `existing_id` 或 `proposal_id` 之一；proposal_id 必须指向匹配类型的提案，每个 proposal 可包含 depends_on，依赖图无环。插件还须重算语义依赖：例如 target 指向既有 entry 的新 form 时，必须依赖对应 add_forms，不能仅靠 entry_ref 推断完整依赖。新永久 ID 由插件提交时分配并持久记录映射，Agent 不伪造稳定正式 ID。

- create_rule 的 replacement 需要 target 和 application；preserve 禁止这两项，与正式规则一致。
- 所有 value 禁止携带 confirmed_by/at、正式 revision 或“已批准”状态；启停和批准字段由提交服务产生。
- value 中的 description 不当作消歧表达式，Agent reason 与人工编辑分开保留。
- merge_entries 是建议，不自动重写跨场景引用；create_entry 后同名条目仍允许保持独立。批量确认前的编辑支持将一组拆成多个条目、或将一个草稿改为引用既有条目。合并后尚未审阅、指向被合并条目的提案必须重新显示目标差异；不能静默重定向为已确认。
- 批准一个 rule 依赖尚未批准的新 domain/entry 时，界面显式展示依赖，用户一并选择或改为已有对象；不能悄悄顺带批准未展示的提案。
- 旧词典已存在同义规则时标 already_present，不重复创建。target 文本相同但 entry 不同不能算“同一规则”。

### 5.2 证据与冲突

source hash 对原文件字节计算，不规范化 BOM/换行；V1 只接受有效 UTF-8，解码后保留 BOM 为位置中的字符。来源范围以完整原文的 code point 为坐标；SRT/VTT 去除时间码、MD 提取正文后的工作视图必须映射回该原文坐标。每份 source 记录 eligible_ranges、processed_ranges、块处理状态，processed 只在合格范围全部完成时成立；partial 数据集允许未完成文件状态为 pending 并附已处理范围，不用文件计数掩盖局部读取。

canonical_source_id 表示原始来源身份，优先复用宿主已有标识；没有稳定标识时以规范 Vault 资源路径维持扫描登记，不把相同 hash 当作相同沟通。MD/SRT/VTT 的已知重复表示用 alternative_of 指向主表示；无法证明同源时保留不同来源并提示可能重复。文件改名只能依据已有身份映射或用户确认关联，不能凭内容相同认定同源。

每条 evidence 至少包含 ID、source ID/hash、subject、communication 关系及依据、source span、observed、excerpt、可选 cue/timecode。证据 ID 不按显示行号推断；span 必须在该源版本定位到 observed。上下文可相互重叠，occurrence 计数不能重复。参与依据来自外部元数据文件时，同时保存该元数据资源路径与 hash；只验证字幕 hash 不足以验证范围依据仍然有效。报告分别显示 occurrence 数与独立沟通来源数；无法证明两个导出独立时不得虚增独立来源数。

conflicts 包含稳定 ID、类型、涉及的 proposal/既有 rule/entry 引用、evidence_ids、说明与可选解决方案。至少区分：

- 同场景同观测的目标冲突；
- 同名/近音条目的可能归并与可能误并；
- proposed form 与已有条目/规则的不一致；
- 来源范围未证实；
- 相对于现有词典的过时变更。

确定性规则冲突由插件导入时重新计算，不能只信 Agent 提交的空 conflicts 列表。语义归并建议不要求机器证明身份，但不能自动消除为“已解决”。最多三个建议与“候选可能未穷尽”规则保持一致。

unresolved 保留没能给出可靠正确形式的观测及证据。它们不会被自动转换成 preserve，也不妨碍其他无依赖项先完成审阅。

### 5.3 来源定位回归示例

下面两个 JSON 块是一组可执行校验的来源/证据 fixture。第一个字符串按 JSON 解码得到源文件的完整字节内容（UTF-8）；包含 CRLF、emoji 和两处相同人名。第二个 evidence 定位到**第二处**，不得使用第一次字符串命中代替 span。

```json
{
  "fixture_source_utf8": "1\r\n00:00:00,000 --> 00:00:02,000\r\n伟涛，收到😀。\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n伟涛负责发布。\r\n"
}
```

```json
{
  "id": "ev_srt_second",
  "source_id": "src_srt_fixture",
  "content_sha256": "f81696da95760f6fc9401c006d54242361178084cdbedbb6802e7401a005394e",
  "span": {
    "start": 79,
    "end": 81
  },
  "observed": "伟涛",
  "excerpt": "伟涛负责发布。",
  "excerpt_span": {
    "start": 79,
    "end": 86
  },
  "locator": "00:00:03,000-00:00:04,000"
}
```

这是位置校验 fixture，不是完整待审数据集；真实 evidence 还必须携带主体和参与依据。hash 对源字符串 UTF-8 字节计算，source span 与 excerpt_span 均相对于原文；界面转换到 UTF-16 后仍须选中第二处。BOM、LF、CRLF、中文和 emoji 另有专项覆盖，不能依赖某一种编辑器的换行转换。

## 6. 插件集中审阅

待确认页新增“历史整理”分组，可导入 dataset.yml 或从 Skill 的完成结果打开待审批次。页面展示扫描范围与覆盖，并区分：

- 建议新增的词条与场景；
- 建议建立的规则及其证据次数；
- 可关联既有词条/待确认归并；
- 有冲突、范围不明或尚无可靠正确写法的项。

点击一组即可查看标准写法、所属场景、拟自动应用还是只建议、代表正反证据；用户可直接改字、切换目标、拆分/合并草稿、移除误聚合证据或选择已有词条。每条规则保留独立批准身份，UI 分组不改变规则粒度。

用户可以手动多选或选择当前无冲突集合，最后点击 **“保存选中的 N 项更改”**。提交前已显示最终变更清单、依赖、影响场景与规则；不强制逐条打开每一次出现，也不添加第二次批准弹窗。未选中的项留在待审队列。

以下不能被“选择无冲突项”顺带批准：未解决目标冲突、参与关系未知、既有条目合并、停用旧规则。用户必须先在界面明确处理其影响；Agent 不能通过高置信度标记绕过。

一笔已选择的变更计划原子提交、存在实际内容变化时词典 revision 增加一次，记录批次决定和每项结果；不是每个 occurrence 都增加一次 revision。源文件改变的证据必须重新定位；若提案还有其他未变更证据，重新展示剩余依据后可继续审阅，不能默默丢弃反例。

## 7. 并发、幂等与重复运行

- 首次导入验证 dataset schema、引用/依赖、路径、证据文件 hash、来源版本、主体和 base_dictionary。
- base_dictionary.state=absent 的首次批准用 no-clobber 创建；此后审阅会话保存新 dictionary_id/基线，不再按 absent 重建。
- base revision/hash 变化不必整批作废。对每项计算“无变化、已存在、目标已变化、冲突”，展示当前差异。未知类型/损坏引用阻止整批导入，局部语义冲突只阻止相关项。
- 用户批准本批次一部分会自然增加当前 revision。导入记录保存本批次自身的提交映射；不能拿原始 base revision 不变去否定同批剩余项。
- 每次最终提交仍使用当前词典 hash/revision 做 CAS，依赖变更时重新预览，不自动按旧目标提交。
- 提交使用固定 transaction_id + plan_hash 重试；每项审阅状态用 run_id/hash + proposal ID + review_revision 做 CAS，并对 proposal 设置唯一终态和永久 ID 映射。重复请求返回既有结果；同 transaction_id 的不同 plan_hash 拒绝执行。相同 ID 不同输入 hash 拒绝覆盖已导入快照。proposal 一旦终结只能幂等返回原结果；不同最终决定 hash 不得再次创建一份结果，要显式开启纠正已提交决定的流程。
- 新 run 处理相同源内容时，以 subject/原始来源身份/hash/位置/观测去重 evidence，再与当前规则比较；不重复创建条目或已存在规则。不仅凭文字相同跨文件去重，因为两个沟通可以真的出现同一句话。
- 已批准生成的永久 ID 映射必须持久化；进程崩溃后重试不能为同一 proposal 分配第二个条目。
- 外部修改和多设备同步仍遵守主规格可信基线，不靠 dataset 的自报 approved 字段取得权威。

## 8. 接口与 Skill 打包

当前实现提供以下 action 位置参数接口：

```bash
notemd conversation-dictionary dataset-check --input dataset.yml --json
notemd conversation-dictionary dataset-import --input dataset.yml --json
```

check 只验证；import 将不可变快照加入插件待审状态，返回 batch ID 和可打开的插件入口，不写正式词典。这些是 Agent 可调用的草稿写入能力，仍无 approve CLI。

插件未安装时 Skill 也能输出上述数据集文件和 report，说明待导入；不能宣称已经进入界面或已经生效。

当前交付结构：

```text
skills/build-conversation-dictionary/
├── SKILL.md
├── references/
│   └── dataset-format.md
└── scripts/
    ├── inventory_transcripts.py
    └── validate_dataset.py
```

脚本和插件校验器已用合成字幕、证据篡改、中文位置、依赖提交和重试数据验证。schema 类型仍以插件协议为权威；Skill 引用它，不把 Agent 输出当作批准。

### 建议 SKILL.md 核心内容

```markdown
---
name: build-conversation-dictionary
description: 根据用户指定的历史沟通字幕，生成沟通词典待审数据集，聚合人名术语的误识别、可能归并写法和冲突，供插件界面确认。用于建立或补全本人沟通词典，不用于普通会议摘要或仅消费的外部节目转写。
---

# Build Conversation Dictionary

读取 references/dataset-format.md；按用户授权范围生成 dataset.yml、
evidence.jsonl 和 report.md。读取当前词典基线，保持原始字幕与正式词典不变。

先固定扫描清单和用户参与依据，记录排除、失败与待核实来源。对长字幕分块
分析，保留源版本和位置，聚合重复观测；跨场景共用条目、分别提出规则。
相同拼写、近音或高频只支持候选，不能证明同一人或正确写法。

同时检查已有规则冲突和可能的归并；保留反例，缺少可靠答案时输出未解决项。
不生成 confirmed_by，不批准、合并或停用正式规则。

校验 schema、引用、证据、覆盖计数和当前基线。生成报告时说明完成范围与遗漏，
不得把局部检索当作全量处理。支持中断续算，保留已导入数据集的不可变性。

插件具备 dataset-import 时导入待审批次并返回入口；否则交付文件路径及待导入
说明。最终规则由用户在插件中确认或修改后生效。
```

普通 conversation-dictionary Skill 处理日常查询和单次候选；build-conversation-dictionary 处理用户要求的历史整理。两者共享协议，但日常整理会议不得自动触发全量历史扫描。

## 9. 必须覆盖的验证

1. 多份会议同一规则聚为一个提案，来源次数正确；SRT/MD 重复表示和块重叠不虚增证据。
2. 同音不同人、同名不同人、同人跨场景、多正确形式均不会仅凭拼写自动合并。
3. 支持首次无词典建立完整 domains/entries/rules 提案；也支持已有词典增量补全，原词典在确认前 hash 不变。
4. 用户参与的公开对谈可进入；仅消费的外部内容排除；未知来源留草稿且不可批量批准。
5. 一次 scan 的每个文件有可核对状态；partial、中断恢复、源文件变化、模型失败和不完整搜索召回不冒充全量完成。
6. 生成的数据集经 schema/引用/证据校验后能在真实插件中展示，正确次数、冲突与代表片段可回源。
7. 用户一次修改正确写法能正确更新所选依赖规则；取消或拆分不会改动正式词典；未处理项保留。
8. 用户选择一组无冲突变更后一次提交成功；含未解决冲突、未知范围、未展示依赖的项不可混入。
9. 导入同一数据集、重跑相同字幕、批准部分后继续审阅及崩溃后重试，不重复条目、不反复报本批自身造成的过时版本。
10. 原始字幕、未选中正式规则和旧词典历史不变；只将用户批准的变更集写入新的词典 revision。
