# STRATA · 层峦：Vault 知识等高线插件设计

日期：2026-09-30
状态：设计基线已落地为本地可构建插件；配套 HTML 仍是合成原型。实现范围、测量结果与尚未验证的生产边界见 [实现验收](../../../plugins-src/strata/VALIDATION.md)。
插件 ID：`notemd.strata`；源码目录：`plugins-src/strata/`。

配套交互原型：[STRATA prototype](./2026-09-30-strata-prototype.html)。这是当前权威 HTML 片段，可用 visualize 的 render.py 包装预览。原型加载固定版本 D3 7.9.0 与 THREE 0.160.0 CDN，仅包含合成数据；二维晕渲与可旋转三维山体共用同一个高度场。生产插件按本规格将所需模块离线打包。默认示例日期为 2026-09-01 至 2026-09-30。

## 1. 产品决策与成功标准

STRATA 把 Vault 中的知识组织成可探索的山地图：领域形成山系，主题形成山谷与峰群，知识点分布其中，点击后可逐条回到原文证据。中文名「层峦」同时表达知识分层与连绵地形；英文名称保留 STRATA。

用户先选文档日期范围，立即看到已有索引与缓存支持的地形。没有抽取缓存时，只展示明确标为「索引候选地形」的标题、标签和来源分布；用户主动选择深读后，按预算读取原文并逐批替换为有证据的知识地形。首次推理耗时单独报告，不能用首屏绘制耗时暗示 AI 已读完全部文档。

成功标准：

- 沿用 note.md index 的来源判定与用户配置的优先级，不建立另一套与搜索漂移的来源规则。
- 显示「领域 → 主题 → 知识点 → 证据」的树，并保留跨主题关系；每条被展示为知识的内容都有可验证来源。
- 突出个人独有知识，但不把「本人写的」「个人独有」「保密」「可信」混为一谈。
- 日期切换保持已有节点的位置、地图坐标、密度核和高度刻度，方便比较同一片知识在不同日期范围内的积累。
- 页面只有固定顶栏和占满其余空间的地图；详情是临时浮层，不设置永久侧栏。
- 原文只读，派生数据可删除重建；没有缓存也不要求重新扫描整份 Vault 才能打开窗口。

首版不包含写回原文、修改 Memory、自动创建知识页面、自动发送第三方消息、知识真假评分、云向量库、持续重训 UMAP/HDBSCAN、三维地球或地图底图。

## 2. 已核实的仓库契约

下列文件行号对应设计时工作区，用于说明现状；「拟新增」接口尚不存在。

| 能力 | 现状与依据 |
| --- | --- |
| 插件窗口与菜单 | [开发规范](../../../docs/plugin-v2-development.md:164)；[Agency manifest](../../../plugins-src/agency/manifest.v2.json:1) 已有独立 Svelte UI + Rust backend + 单例窗口 |
| UI 调用自身 backend | `window.notemd.request('plugin.*', params)` 转成进程 `ui.request`；[lifecycle.rs](../../../src-tauri/src/plugin_runtime/lifecycle.rs:388) |
| Host capability | [host_api.rs](../../../src-tauri/src/plugin_runtime/host_api.rs:32) 已有 `vault.read`、`agent`、`editor.open`、`settings`、`ui`；当前没有 `host.index.*` / `index.read` |
| Agent | 同文件 51 行起的 `host.agent.run/status/providers/limits`；不是知识抽取服务 |
| 插件私有数据目录 | `$initialize.data_dir` 指向 `<app_data>/plugin_data/<id>`；[lifecycle.rs](../../../src-tauri/src/plugin_runtime/lifecycle.rs:268)，目录由插件自行建立 |
| 索引数据 | [block.rs](../../../searchidx/src/block.rs:1) 含 File/Section/Line、正文、行号、breadcrumb、批注与作者；[store.rs](../../../searchidx/src/store.rs:86) 含文件 hash、元数据、链接与注意力表 |
| 来源与权重 | [origin.rs](../../../searchidx/src/origin.rs:130)、[query.rs](../../../searchidx/src/query.rs:248)、[options.rs](../../../src-tauri/src/search/options.rs:94)；权重解析必须仍走统一入口 |
| 知识契约 | [types.ts](../../../plugins-src/knowledge-browser/src/lib/types.ts:1)、[validator.ts](../../../plugins-src/knowledge-browser/src/lib/validator.ts:27) 已有实体、概念、主张、事件、叙事、关系、证据强度与来源引用 |
| 时间维度 | [time.ts](../../../plugins-src/knowledge-browser/src/lib/time.ts:3) 已区分 event、valid、source、generated |
| 模块 Worker | [worker-client.ts](../../../plugins-src/knowledge-browser/src/lib/worker-client.ts:15) 已有同源 module Worker 与取消模式 |
| 全局样式 | [ui-foundation.css](../../../src/styles/ui-foundation.css:1) 引入 [popup-menu.css](../../../src/styles/popup-menu.css:1)，与 [app.css](../../../src/styles/app.css:1) 共用 |
| CSP | [protocol.rs](../../../src-tauri/src/plugin_runtime/protocol.rs:106)：`script-src 'self'`、`connect-src 'self'`；依赖应随包提供 |
| 回源导航 | [ui_rpc.rs](../../../src-tauri/src/plugin_runtime/ui_rpc.rs:1197) 当前 `host.editor.open` 支持 path/fileView，没有精确跳行参数 |

Knowledge Browser 当前是读取既有 JSON 的文件视图，不负责索引扫描、知识抽取、语义聚类或等高线生成。STRATA 使用独立窗口，借用其契约与验证经验，不把已有浏览器描述为完整计算后端。

### 2.1 优先级：复用策略，不能复用检索分数

现有默认权重为 `human=1.25, derived=1.0, source=0.9, unlabeled=0.3, attention=0.4`，允许用户修改；来源权重合法范围 `(0, 5]`，attention 合法范围 `[0, 2]`。见 [query.rs](../../../searchidx/src/query.rs:265)。

现有 `score_of` 还包含精确短语、查询 wikilink 命中、BM25、结构等级、批注、人类确认、AI 作者、注意力、日期新鲜度等因子，并在最后压缩为 `r/(1+r)`。见 [query.rs](../../../searchidx/src/query.rs:1267)。检索 score 依赖查询，不能直接变成地形高度。

拟在 `searchidx` 内提取同一个 `priority_factors` 纯函数，由搜索评分与索引快照共同调用。它保留以下与查询无关的乘数，不改变搜索原有运算顺序与排序：

```text
P(unit, asOf) = W[indexOrigin]
             × structuralFactor(unit)       # file/section 1.2；line 1.0
             × annotationFactor(unit)       # 批注 1.2，否则 1
             × verifiedFactor(document)     # human_verified 1.1，否则 1
             × agentFactor(unit)            # agent_by 存在时 0.85，否则 1
             × attentionBoost(document, asOf)
             × freshness(document.docDate, asOf)

attentionBoost = 1 + k × min(log(1 + M) / log(121), 1)
ageDays        = searchidx::query::days_between(docDate, asOf)
freshness      = 1 + 0.2 × exp(-ageDays / 180)
```

`M` 是截至快照 `asOf` 衰减后的累计 `read + 1.5 × edit` 分钟，半衰期 30 天，见 [attention.rs](../../../searchidx/src/attention.rs:10)。它不是用户所选日期范围内的阅读投入；顶栏日期选择只过滤文档，不重算「这段时间读了多少」。无查询时不使用 BM25、phrase ×1.3、linked mention ×1.5 或同名知识页硬置顶。

这里直接复用当前调用链：`score_of` 的指数公式在 [query.rs:1344](../../../searchidx/src/query.rs:1344)，其调用的 `days_between` 在 [query.rs:1356](../../../searchidx/src/query.rs:1356) 已把负日期差截为 0。因此未来文档日期的 freshness 是 1.2，不会大于 1.2；插件不能只看指数公式就绕过 helper，也不另加一套日期修正。日期解析失败时沿用当前不施加新鲜度因子的行为。

一个原文片段只选择一个非重叠索引单元承载上述因子。不能把覆盖同一文本的 File、Section 和 Line 同时计数。独立知识点的证据强度、知识类型、个人独有性另行保存，不偷偷乘进上述 index 权重。

### 2.2 日期契约

沿用 [chunk.rs](../../../searchidx/src/chunk.rs:99) 的 `doc_date` 解析顺序：文件名日期前缀 → frontmatter `created` → `date` → `generated.at` → mtime。仅最后一种 `date_inferred=true`。沿用 [query.rs](../../../searchidx/src/query.rs:1015) 的日期过滤：`doc_date >= from AND doc_date <= to`，首尾均包含。

UI 明示「文档日期」，可查看「含 N 篇使用修改时间推定的文档」。7/30/90 日以设备当前日为右端，分别减 6/29/89 个民用日；向后端发送 `YYYY-MM-DD`，不把日期字符串转为 UTC 午夜后再截断。`event_time`、`valid_time`、`extracted_at` 均不能覆盖 doc_date。

长会话或跨日文档进入日期范围，不代表其中每一条事实发生于该日。没有块级明确时间时，证据保留文档日期并标明时间粒度。

## 3. 用户体验与视觉语言

### 3.1 浏览页

```text
STRATA 层峦 | 文档日期 [开始]—[结束] [7 日] [30 日] [90 日]
            | [个人优先] [关系] [刷新] [设置]
────────────────────────────────────────────────────────────
                  全幅等高线画布
       领域名 → 主题名 → 知识点，随缩放渐进显现
       悬停提示；点击打开临时证据浮层；Esc 收起
       角落：缩放 / 复位、简短图例、覆盖与生成状态
```

顶栏约 60 px；小窗口允许紧凑两行，不挤压地图为卡片列表。浅色主题采用暖白地图纸、墨灰细线与柔和域色；深色主题采用深石墨背景与低亮度等高线。个人独有知识用琥珀色峰标与同色文字强调，关系用克制的冷色线。色彩不承担唯一语义，峰标、虚实线与文字标签同步表达。

- **二维/三维与导航**：二维拖动平移，三维拖动旋转与调整俯仰，均可缩放、展开山群与返回全景；相机操作不重新计算知识质量。当前原型另有旋转和俯视/侧视按钮；不能把镜头变化当成新的知识布局。
- **个人优先**：提高已证实 owner-specific 节点的标签优先级与视觉显著性，候选深读队列优先安排有明确本人创作证据的材料；不改变来源权重、不把未知项自动标成个人独有，也不改变地形高度标尺。
- **关系**：默认关闭全图连线。开启后仅展示当前焦点/视口内的有限邻接关系，默认最多 60 条；其余数量可见。跨域关系不强行改变节点归属。
- **刷新**：获取新索引快照，更新失效缓存与已有节点高度；不等于把地图重新排布。显式「重建地图布局」放在设置中并说明已有位置会改变。
- **浮层**：名称、层级面包屑、知识类型、原文/推断状态、独有性、保密性、来源数量、支持/反对证据与原文入口；关闭后地图恢复全部空间。
- **来源导航**：首版在浮层展示经过验证的行段与引文，`host.editor.open({path})` 打开原文件。不得宣称已跳到指定行；宿主增添 location 支持后才能承诺精确定位。

### 3.2 层级与等高线各自表达什么

层级由显式父子树表达：领域 → 主题 → 知识点 → 证据。等高线表达在同一稳定空间中的「优先级加权知识积累密度」，圈数多说明此处积累更高，不说明结论更真实、抽象程度更高或用户能力更强。

几何嵌套的轮廓不能代替知识层级树。地形中的高峰可以是很具体的项目细节，低地也可能是重要但来源稀少的决定。领域与主题边界可在聚焦时显示淡轮廓；不能把每一圈都命名成一个知识层级。

LOD 按屏幕投影尺寸选择可见层级：全图优先领域与少量主题；中尺度显示主题与代表知识点；近景显示原子知识点；证据只在选中后出现。层级切换使用标签碰撞索引和稳定排序，避免所有文本同屏或每帧跳变。屏幕阅读器使用同一棵树的可访问 DOM 列表，键盘可逐项聚焦，Canvas 不承担全部可访问性。

### 3.3 状态与覆盖率

必须区分 `candidate`（标题/标签候选）、`extracting`、`verified`（结构与引文核验通过）、`partial`、`stale`、`error`、`empty`。其中 verified 不表示事实经外部查证，UI 使用「引文已核对」，而不直接称「事实已证实」。

页角状态例：「索引候选 · 482 篇」「已深读 36 / 120 篇 · 待处理 84 篇」「来源变化，23 条知识待更新」。未读、被排除、超预算、读取失败、时间推定数量都计入覆盖记录；不能把预算内子集呈现为完整 Vault 知识。

## 4. 数据模型与私有知识

### 4.1 五个独立维度

| 维度 | 字段与语义 | 不可替代的其他维度 |
| --- | --- | --- |
| 索引来源 | `indexOrigin: human / derived / source / unlabeled`，沿用 index | 不是隐私等级；human 也可能是公开笔记 |
| 个人独有性 | `ownerSpecificity: owner_specific / general / unknown`，附 evidence IDs 与判定理由 | 本人参与的具体决定、关系上下文、个人做法可成立；转载常识或作者不明不能猜 |
| 保密性 | `confidentiality: confidential / explicitly_public / unknown`，只接受明确来源标注或用户设置 | 未标保密不等于允许公开；owner_specific 不自动等于 confidential |
| 认识状态 | 已有 `epistemic.strength/basis`、status、limits，区分原话、自述、推断、争议 | 高峰、高权重、多次重复不等于可信 |
| 知识类型 | entity/concept/claim/event/narrative/relation 及 claim.kind | 决定、承诺、假设、规则不能互相冒充 |

索引 `source` 也可能包含用户私有会议原话，不能一概降低其个人价值。未知保密性在云深读选择中仍需要纳入明确的本次范围，不视为默许外发。密钥、token、凭据等不是要突出的私有知识，应在读取和输出过滤阶段排除，不生成标签或日志。

### 4.2 契约复用边界

复用 `knowledge-representation-dataset/3.1.0` 的对象结构和关系注册表。当前 Knowledge Browser validator 对 `generated.rule` 只接受已有 extractor 规则，因此 STRATA 不能伪称输出来自 `relation-schema-extractor/3.1.1`。实施时将领域无关的 schema 验证与具体 producer allowlist 拆为同一内部契约模块，新增真实 `strata-extract/1.0.0` producer profile；保留旧格式兼容测试，不发布泛化 SDK。

STRATA 的派生字段存外层 sidecar，不能塞进 strict schema 的任意未知字段：

```ts
type StrataSnapshot = {
  schema: 'notemd.strata/v1'
  indexSnapshotId: string
  configHash: string
  atlasEpoch: string
  asOf: string
  scope: { from: string; to: string; dateKind: 'doc_date' }
  knowledge: KnowledgeDataset
  sourceMeta: Record<string, {
    contentHash: string
    indexOrigin: 'human' | 'derived' | 'source' | 'unlabeled'
    docDate: string
    dateInferred: boolean
    sourceGroupId: string
  }>
  nodeMeta: Record<string, {
    ownerSpecificity: 'owner_specific' | 'general' | 'unknown'
    confidentiality: 'confidential' | 'explicitly_public' | 'unknown'
    classificationEvidence: string[]
    parentTopic: string
    canonicalId: string
  }>
  coverage: { selected: number; processed: number; skipped: number; failed: number }
}
```

已有 schema 的 `Source.origin` 仅为 `derived | unknown`，不是 index 的四档来源；新字段必须命名 `indexOrigin`。一个引用单元保留 `sourceId + contentHash + blockKey + lineStart/lineEnd + exactQuote`。blockKey 为快照内稳定引用，不承诺索引 SQLite rowid 是跨重建的永久身份。

多元关系继续保留 relation 节点与参数角色，不把三方关系强行扁平化为单向二元边；参见 [graph-model.ts](../../../plugins-src/knowledge-browser/src/lib/graph-model.ts:79)。语义近邻图只服务聚类，不能伪装成「导致」「支持」「认识某人」等有证据关系。

## 5. 索引 API 与一致性

### 5.1 新增 `index.read` Host 能力

插件不直连 SQLite，不执行 `notemd search --all` 冒充索引浏览，不自行走目录遍历重建候选库。宿主建立只读、版本化 API，复用已打开的 SearchIndex 和统一配置解析。

```ts
// 拟新增；方法名包含 host. 前缀。
host.index.snapshot({
  version: 1,
  range?: { from: '2026-09-01', to: '2026-09-30', dateKind: 'doc_date' },
  cursor?: string,
  pageSize?: number
}) -> {
  snapshotId: string, configHash: string, asOf: string,
  indexGeneration: string, policyVersion: string, nextCursor?: string,
  mode: 'range' | 'atlas_metadata',
  effectiveWeights: { human: number; derived: number; source: number; unlabeled: number; attention: number },
  files: Array<{
    fileKey: string, path: string, contentHash: string,
    title?: string, conceptType?: string, tags: string[], docDate: string, dateInferred: boolean,
    indexOrigin: string, humanVerified: boolean,
    attentionMinutes: number, links: Array<{ kind: string; target: string; line: number }>,
    filePriority: number,
    priorityBasis: { aggregation: 'max_nonoverlap_unit'; blockKey: string; factors: object } | null
  }>,
  coverage: { indexed: number; selected: number; stale: number; excluded: number },
  freshness: 'current' | 'stale'
}

host.index.blocks({
  version: 1, snapshotId: string, fileKeys: string[],
  cursor?: string, maxBytes?: number
}) -> {
  snapshotId: string, nextCursor?: string,
  units: Array<{
    fileKey: string, contentHash: string, blockKey: string,
    lineStart: number, lineEnd: number, breadcrumb: string, text: string,
    level: 'file' | 'section' | 'line', isAnnotation: boolean,
    agentBy?: string, priority: number, priorityFactors: object
  }>,
  conflicts: Array<{ fileKey: string; reason: 'changed' | 'missing' | 'denied' }>
}
```

首请求冻结快照，后续 cursor 必须绑定 snapshotId、调用插件、Vault、范围与排序；客户端不能改范围后继续旧 cursor。单页默认 500 文件、上限 1,000；正文请求默认上限 1 MiB，服务端另有总预算闸门。排序按稳定 fileKey，不使用易随时间漂移的 score 排序作为分页游标。

`filePriority` 由宿主对该文件已索引的规范化非重叠单元计算 `max(P(unit, asOf))`，同分取最小稳定 blockKey；返回命中单元与因子作为 `priorityBasis`，不返回其正文。宿主只读已有索引的等级/批注/作者等字段即可汇总，不能为候选浏览重新读整篇原文。候选质量和深读队列使用这个值，不在前端从缺少的 agentBy 等元数据猜算。没有合格索引单元时 priority 为 0、basis 为 null 并列入 skipped。

快照包含 `configHash`：索引规则/版本、source globs、排除配置、用户 weights、归一化/分词版本、日期语义；hash 不包含凭据。数据变化用 indexGeneration/contentHash 表达，不让「配置不变」等同「文本不变」。`asOf` 冻结注意力和新鲜度计算基准。

快照保留有界的元数据与引用，不以长时间 SQL 写锁阻塞索引。正文在 `blocks` 中按 hash 重新验证；发生变更时返回 conflict，不混入当前新文本。快照过期返回明确 `SNAPSHOT_EXPIRED`，新一轮请求重新获取，旧地图保持可见但标为待刷新。Vault 切换、权限收回、索引排除变化立即使快照失效；所有请求仍须在执行时检查当前授权，冻结快照不是冻结授权。

每个文件选择不重叠的语义段：有章节时取最细且可独立理解的段落/大纲单元，补充标题与 breadcrumb；没有结构时使用有界连续行段。父 File/Section 只供背景和元数据，不再次计入证据质量。这个归一化逻辑在 index adapter 一处维护；必须有覆盖重叠样本的测试。

### 5.2 全 Vault 布局与日期筛选

稳定布局的 atlas 使用当前授权范围内的本地索引元数据建立，不读取全 Vault 正文，也不向 Agent 发送范围外材料。首次建立可分页取全 Vault 的标题/标签/链接以形成背景位置，当前日期范围只决定可见质量与正文抽取集合；UI 明示「布局基于本地索引；深读仅限所选日期」。如用户设置了更窄的授权目录，atlas 同样受限。

`range` 可选：提供时创建 `mode=range` 快照；省略时创建 `mode=atlas_metadata`，仅提供授权范围内的布局元数据。`host.index.blocks` 必须拒绝 atlas_metadata 的 snapshotId；需要正文时新建本次明确日期范围的 range 快照，只接受其 fileKeys。不能借 `from=0000-01-01` 等魔法值或客户端追加 fileKey 绕过范围。无日期的条目单独计数，不补造日期。

## 6. 从索引候选到有证据的知识

### 6.1 两条速度不同的流水线

**本地即时路径**：读取索引元数据 → 命中缓存 → 稀疏向量/已有概念 → 稳定 atlas → 本次日期质量 → 密度场与等高线。只依赖索引与本地缓存，不调用 Agent。

**深读路径**：用户选 provider 与范围/预算 → 冻结输入 → 获取非重叠正文单元 → 批次抽取 → schema/引用/角色验证 → 语义去重与来源分组 → 原子写入缓存 → 增量更新地图。任务可暂停排队；已提交给 provider 的批次是否能取消，必须按 provider 实际能力展示，不能把「停止后续批次」说成已终止远程推理。

首次默认预算建议 120 篇 / 2 MiB 正文 / 30 分钟任务墙钟，按先到阈值停止；这是可调产品预算，不是处理全部文档的承诺。显示文件数、预计字节/输入 token、实际所选 provider 与已配置模型；模型价格没有已核实数据时只显示 token 估计，不捏造费用。单批正文最多 32 KiB，按语义段拆分，完整材料不足的关系标 partial。

队列排序先沿 index 的查询无关 priority，再用稳定 fileKey 打破同分；开启个人优先时只对已有明确 owner 证据的来源设置优先队列，不给未知归属生成虚假标签。可在 top priority 之外保留少量跨主题覆盖名额，具体份额固定在版本化规则，不让热门主题吞尽全部预算。

### 6.2 抽取与核验

- 只从输入段生成实体、原子主张、概念与明确关系；标题/标签只能当候选，不能成为新事实。
- 保留说话人、条件、有效范围、反证与争议。「某人认为 P」不能升级为 P；助手自述完成不能升级为用户确认。
- 抽取输出必须来自成功且完整的 terminal result。借用 [Agency task.rs](../../../plugins-src/agency/backend/src/task.rs:141) 的完整结果闸门，不解析截断摘要当最终 JSON。
- 逐条检查 ID、引用闭包、source hash、行范围、逐字引文、说话人、关系类型与参数。可允许一次仅修复引用的重试；不能通过放宽规则使失败结果通过。
- 去重先精确 canonical key/hash，再在同主题稀疏近邻内做保守等价判断；未确定同义的主张保持分开。反对/修正关系不能被合并成多数表决结果。
- 同源转载、镜像、由相同原文生成的总结归一个 `sourceGroupId`，但只有显式来源引用或可验证内容指纹才自动归组；不确定时保留分开并标「独立性未知」，不能把不同路径称为独立佐证。

## 7. 稀疏聚类与稳定空间

首版没有现成 embedding 能力，也不把安装云 embedding 服务作为启动条件。采用可解释、有限候选的稀疏相似图；跨语言同义词、隐喻与完全不共享词面的概念会较弱，这是已知限制。

### 7.1 特征与近邻

节点起初是文档候选，抽取完成后成为 canonical 知识点。文本特征来自标题、标签、breadcrumb 与抽取概念，采用与 index 一致的 token 归一化；按 atlas epoch 冻结 IDF，标题/标签提高特征权重但不改变 index priority。每节点保留最多 32 个有区分度特征，通用停用词和超高 document frequency 词不参与候选生成。

通过倒排表寻找候选：每节点取最多 16 个稀有特征；每个 posting 最多取 32 个稳定哈希采样成员，合并后按共享特征贡献保留最多 256 个候选；仅对这些候选计算精确稀疏 cosine。保留 top 12 邻居，再对称化；补充最多 8 条显式 wikilink/已抽取概念结构边。共同出现在文档中只能形成聚类边，不能生成事实关系。

这是一张近似 kNN 图，不能宣传为精确全对近邻。候选上限固定，构图成本约 `O(N × T + N × C × T)`，`T≤32、C≤256`；图存储 `O(N × (k + explicitEdges))`。不生成 `N×N` 相似度矩阵；32k 节点也不做全对比较。

### 7.2 有界、确定性的多尺度社区

采用**固定遍历顺序的多层 Louvain 模块度局部移动**，无需引入每次重训的二维随机投影：

算法依据为 Blondel 等人的 [Fast unfolding of communities in large networks](https://arxiv.org/abs/0803.0476)。下列轮次、候选上限、分辨率与树约束属于本插件的设计选择，尚未通过真实 Vault 语料调校。

1. 初次 atlas 对稀疏图按 stable node ID 遍历，节点只尝试相邻社区，采用 weighted modularity 增益；同分按最小社区 ID 决定。
2. 领域层 resolution `γ=0.6`；每层最多 8 轮局部移动、最多 4 次图收缩，增益阈值固定在算法版本内。没有正增益即停止。
3. 在每个领域诱导子图上用 `γ=1.2` 做主题层，禁止跨父领域移动，形成真实嵌套树。很小的领域可只有一个主题，不为凑层级制造空节点。
4. 社区名称先用区分度最高的标签/概念词组合；Agent 可在已有证据范围内建议更好名称，但名称不是新事实。领域/主题明确标为自动组织。

有限轮次的图移动与收缩约 `O(I × E)`，其中 I 有上述常数界；不保证全局最优模块度。两组 resolution 是首版初值，需通过合成主题语料与人工评审调校，不能声称已证明最优。

### 7.3 树约束布局与位置保持

采用确定性的递归圆形布局：领域圆按 stable ID 放置在固定世界坐标，主题圆放在领域内，知识点用稳定哈希起点加有限轮碰撞消解放在主题内。一级空间分配依据 atlas 中规范化节点数的平方根并留 20% 空隙，不依赖本次日期质量，避免日期切换挤压地形。域间的几何间距只表示空间分配，不是全局语义距离，不能据「两座山很远」推导两领域互不相关。

所有层使用按圆半径分档的 spatial hash，禁止以「有限轮」掩盖轮内全对碰撞。领域/主题圆先按半径档放入确定性粗网格 bucket，以包围方格预留槽位，再在父圆内局部调整；同一 bucket 超过 32 个候选即进入下一预留槽位，不枚举全部已有圆。单点最多 64 次位置尝试、每次最多检查 32 个邻居，局部调整最多 8 轮；邻居查询只访问覆盖当前半径的固定数量相邻 bucket。每层放置成本因此有明确 `O(N × 64 × 32 × 8)` 上界，半径档数受固定最小/最大半径约束。额度内无法放置的内容形成可展开的拥挤占位，保留真实数量，不偷偷退回全对算法；验收检验此退化的可见性。

一个 atlas epoch 的世界范围固定，例如 `4096 × 4096`；持久保存 canonicalId、父主题、x/y、社区 ID、IDF 与世界尺寸。只切日期时不再聚类或重排。新知识优先继承其候选文档的主题锚点，新节点在该主题空隙中增加；已存在节点保持坐标。空间不足或结构变化较大时显示「建议重建布局」，由用户明确触发新 epoch，而非悄悄全图跳动。

初版选择空间稳定与可解释层级，接受局部词面相似性的不足。聚类树变化不是用户知识发生变化的证据。重新布局必须保留旧版本标识，不能拿不同 epoch 的几何位置直接作趋势比较。

## 8. 高度场、去重与绘制

### 8.1 高度定义

先对同一来源组去重、饱和，再累积不同来源组的贡献。每个 `groupVersion + atlasEpoch` 冻结该来源组在授权缓存中完整已知的 canonical 集合与非重叠证据，以及同一 configHash/asOf 下的最大 index priority `P_g`。这里「完整已知」指该版本已处理材料的全部知识，不声称尚未读取的原文已被穷尽。所选日期只改变支持证据的可见 mask，不能重算组预算或分母：

```text
B_g = τ × (1 - exp(-P_g / τ)), τ = 2
A_g = 该 groupVersion 在本 atlasEpoch 内完整已知的 canonical 集合（冻结）
visible(g,k,range) = 组内至少一条支持 k 的合格来源 doc_date 在 range 内时为 1，否则 0
mass(k,range) = Σ_{g: k∈A_g} visible(g,k,range) × B_g / |A_g|
K_k(x,y) = C × F_k(x,y) / ∫world F_k(u,v) du dv
H(x,y) = Σ_k mass(k) × K_k(x,y)
C = 2π × σ_ref²，σ_ref = 48（固定世界坐标单位）
```

同一来源组总贡献最多 `τ`，一本很长的书或重复转写不会因字数/拆块数堆成最高峰；固定版本中的多个知识点分摊同一个冻结预算。来自多组材料的积累可以升高，但多路径并不自动等于独立证据，浮层始终区分来源组数与已核验独立来源数。关系对象若只是重述同一组知识，不再次添加质量，只作为连线与导航结构。空集合不参与计算，避免零分母。

`F_k` 是固定种子、非负的自然地形核，由紧凑子峰、弯曲山脊、偏心肩部与宽山坡混合形成，详见 §8.2。每个核在完整世界域上冻结积分归一化；增宽山麓或增加纹理不额外创造知识质量。不同峰形的峰值不保证相同，因此不能仅凭两座不同形状的峰高排序重要性；精确优先级在证据中读取。`τ`、σ_ref、每个核的形状参数和归一化系数、世界网格及阈值序列与 atlas epoch 一起版本化。

当前原型采用固定单调高程映射与对应逆阈值，取代此前的几何序列/线性 H 阈值草案：

```text
E(H) = 0.24 × log1p(H / 0.012)
三维顶点高度 = E(H) × verticalScale
threshold[i] = 0.012 × expm1((i + 1) × 0.011 / 0.24), i = 0…139
```

140 个阈值在 E 空间等间距 0.011，D3 仍在原始 H 上取等值线；丰富细节概览取索引步长 3，知识点近景取步长 2，简洁模式分别为 6 和 4。这里只稀疏选择固定阈值，不按选区 min/max 拉伸。E 表示相对视觉高程，不是海拔米数、概率或重要性总分。零场 E(0)=0，日期扩大时 H 与 E 都非递减；同一组版本/configHash/asOf/atlasEpoch 下，旧峰不会因分母或刻度改变而变矮。生产侧需要把坐标与核积分单位一并定版，不能直接把原型归一化坐标中的数值当成已完成生产标定。

抽取新材料、同源归组变化、证据撤销或权限变化会产生新 groupVersion；新的 A_g/P_g 只能随显式标记的快照更新原子切换。页角说明「知识版本已更新」，不能把版本变更造成的高度差称为日期趋势；跨版本比较需重新投影到同一冻结版本，或明确禁用直接比较。候选升级为知识也属于版本变更。

候选地形以文档标题/标签作为候选节点，使用同一来源预算机制，但整图明确标为候选；不能把候选质量与知识质量同时叠加。逐批替换时移除已处理候选对应的质量，再加入核验知识点。未知/低证据内容用纹理或描边表示，不用密度偷表可信度。

### 8.2 共享高度场、D3 等高线与生产计算路径

**山群与子峰共用同一个连续高度场。** 领域/主题是组织标签；每个有正贡献的知识子项贡献自己的小山峰。放大时增加采样与轮廓细节、展开子项标签，不能仅把父山换上更多文字，也不能独立抖动各条等高线。

自然地形核的参数由 `canonicalId + atlasEpoch + terrainVersion` 固定生成：

1. 子峰使用紧凑核，宽度依据冻结布局中的最近邻间距限制；至少覆盖数个细网格采样点，避免尖峰漏采。每个子项须有独立局部极大值与可见的闭合等高线，峰间保留鞍部。
2. 山体由方向、长短轴不同的弯曲脊线、偏心肩部与宽山坡连贯叠加。共享父主题方向形成支脉，但不使用统一圆形底座，也不把装饰性山脊当作真实知识关系。
3. 使用 5 个 octave 的 fBm（频率倍率 2.03、幅值衰减 0.52）构造大尺度域形变；4 个 octave 的 ridged multifractal 以绝对值反转、平方与前一层信号反馈形成支脉，ridged 幅值衰减为 0.55。每个 octave 旋转采样坐标避免格网方向感；子峰另用 3 层细尺度 fBm 形变，长短轴按节点种子变化；当前正值分形包络为 `1+0.55×fBm`，取代上一版的 0.85，调制子峰径向衰减。纹理乘数保持为正：`0.7 + 0.5×ridged + 0.27×fBm`，理论下界 0.43。最高频率受固定采样网格限制，防止用高频噪声伪装细节。积分系数在完整固定域上预计算，日期仅改变 mass，不重算噪声、最近邻、核宽或归一化分母。空集合仍严格为零。
4. atlas 构建阶段检验局部峰及峰间显著度；若子项被邻峰吞没，调整该版布局的间距与峰核比例再验收。不得靠增加虚构知识质量来强行抬峰。极低或零贡献不能伪造积累；零贡献保留可导航记录标记。真实大规模/极端权重下的独立峰保证仍属于 P3 验收，40 点原型不能代替证明。

分形方法参考 [PBRT 的 fBm/octave 说明](https://www.pbr-book.org/3ed-2018/Texture/Noise) 与 [libnoise 的 RidgedMulti 说明](https://libnoise.sourceforge.net/docs/classnoise_1_1module_1_1RidgedMulti.html)。原型使用自写二维 value-noise 组合，不引入 libnoise；只模拟自然山形视觉，没有实现水力侵蚀或声称真实地理过程。

同源 module Worker 以固定世界坐标计算 `H`，由 `d3.contours()` 提取标量场轮廓。概览使用粗采样缓存；近景只细化当前可见的 tile，使最窄子峰有足够采样点。tile 边界包含相邻核的完整支持区并共享坐标、归一化与阈值，不能逐 tile 自行拉伸高度。LOD 可以选取同一固定阈值全集的子集；缩放/DPR 只影响采样精度和绘制，不改变数学高度场及来源预算。

生产核以局部支持范围截断、保存稀疏模板及确定性的归一化参数，近邻查询复用 §7.3 的 spatial hash。禁止为 32k 节点分配「每节点一张完整世界网格」，也不做全对最近邻搜索。每次筛选累积的成本按实际核覆盖格数 `S` 计为 `O(S)`，轮廓提取为 `O(L×G_visible)`；需通过 tile 数、支持半径、阈值和顶点上限控制最坏成本。原来的统一核 blur 仅能作对照基线，不能再用 `O(N+G×R)` 宣称这一版自然地形已达性能目标。

主线程 Canvas 缓存 Path2D，绘制填色、等高线、峰顶标记、关系和有限标签。峰顶标记从当前高度场邻域极大值定位，允许地形随证据筛选发生细微峰顶偏移，canonical 节点和山群布局不重排；标签偏移放置并用细引导线连接峰顶。碰撞时省略文字，但峰顶仍可点选；放大或平移后重新避让。日期改变需要重新累积；平移/缩放复用已有轮廓，缺少近景 tile 才提交可取消细化任务。

当前合成原型采用 `960×624` 固定网格预计算 40 个核（约 95.8 MB，仅指 40 个 Float32 核的持久数组），没有 Worker、tile 或稀疏缓存；同一固定高度场用于远近景与二维/三维。最新局部核 `L=(0.6×body+0.4×core)×texture` 混合后才归一化；0.4 是混合系数，不能称为 core 恰占 40% 质量。宽山麓 `W` 使用长短轴 0.32/0.20 的核与 `0.65+1.2×ridged+0.3×fBm` 区域纹理。L 和 W 分别归一到相同冻结积分，再取 `K=0.78×normalize(L)+0.22×normalize(W)`，所以局部/宽山麓分别占积分的 78%/22%，总知识贡献保持不变。原型归一化域为 `[0,1]²`，单核目标积分 `2π×0.034²≈0.0072633622`。

同组布局也扩大间距：沿主轴范围参数由 `.14+.035×seed` 改为 `.22+.04×seed`，横向交错由 `.012+.025×seed` 改为 `.016+.036×seed`，使子峰之间留出鞍部。它们是合成原型的固定布局规则，不是已经实现的真实语义聚类。

宽山麓把已有质量延伸到连续低地，不能另加无数据山脉或全图常数底高。全 40 点情景下，coverage 报告显示全域高于最低两个概览阈值；这意味着连续低地，不意味着处处画有等高线。等值线只经过该级高度的位置，低于全域最小值的轮廓可能只有域边界；平坦处可没有内部线，少量日期子集也不保证全域被覆盖。空集合保持全零，由空态覆盖平板。

这些是视觉原型参数，生产需结合真实优先级范围与最坏规模调校。生产性能目标仍待实测。按日网格或 prefix 缓存仅在测得筛选瓶颈后考虑，不能预先承受大量日期的内存与权限失效成本。

### 8.3 同场二维晕渲与可旋转三维山体

二维使用 H 的固定 E 映射计算色带与有限差分法线，按同一方向光向量得到晕渲，再叠加真实 D3 等高线；不是把单独画好的山体背景垫在轮廓下面。

三维原型使用 THREE r160 的 PerspectiveCamera 与 `12×8` 世界平面，mesh 为 `480×312` 分段，共 150,553 顶点。顶点按 D3 cell-center 约定 `(i+0.5)/gridSize` 双线性采样同一个 H，再应用 E 和 verticalScale；只有 field/倍率改变才更新位置、平滑法线与包围体，相机旋转不重建网格。顶点色表达植被到岩石的柔和渐变，方向光和阴影揭示坡面；白底纹理叠加传入的真实 D3 轮廓后乘顶点色，不另造山峰。薄底盘和边裙只接住已有地形边界，不提供额外知识高度。

当前工厂接口为 `createTerrain3D(canvas,getInk)` → `render/project/heightAt/dispose`。view 控制 yaw、pitch、distance 和归一化 targetX/Y；project 返回 CSS 像素及视锥/前山遮挡判断，供同一份标签/峰顶/关系叠加使用。heightAt 返回原始 H 的双线性值。无 WebGL 或上下文丢失时界面切回同场二维；二维与 WebGL 使用独立 canvas。dispose 释放几何、材质、纹理、阴影贴图和 renderer。

原型实际有二维/三维切换、拖动旋转、俯仰按钮、缩放与返回全景；默认三维。以上描述来自 canonical HTML 的已接线代码，数值验证不代替每个浏览器的 GPU 视觉验收。THREE 在原型中通过固定版本 CDN UMD 加载，生产需离线打包、验证 Tauri CSP/WebGL 和降级，尚未接入生产 Worker。

### 8.4 GitHub 参考评估

以下 star 为 2026-09-30 调研快照，会变化；用于衡量生态，不作为绘图正确性或性能证明。

| 项目 | Star / license | 匹配点与取舍 |
| --- | --- | --- |
| [D3](https://github.com/d3/d3) / [d3-contour](https://github.com/d3/d3-contour) | 113,786 / 522；ISC | 与 Svelte/Vite、Canvas、离线 Worker 直接匹配；d3-contour 成熟低频更新，调研所见仓库 pushed 时间为 2024-11-26，不等于 release 日期，也不能据此单独判断不可用。首选 |
| [deck.gl](https://github.com/visgl/deck.gl) / [ContourLayer](https://deck.gl/docs/api-reference/aggregation-layers/contour-layer) | 14,619；MIT | GPU 聚合与大规模图层优秀；当前三维只需 THREE 的同场 mesh，仍无需额外引入 deck.gl 聚合与图层体系。生产实测聚合瓶颈后再评估 |
| [DataMapPlot](https://github.com/TutteInstitute/datamapplot) | 1,025；MIT | 簇标签、离线交互导出与全图美术很适合参考；Python 流水线更重，alpha-shape 簇轮廓不是标量等高线，不直接当运行时依赖。使用其导出时也需检查 `offline_mode` 与外部资源 |
| [TMAP](https://github.com/reymond-group/tmap) / [TMAP2](https://github.com/afloresep/tmap2) | 262 / 43 | 原 TMAP 停止维护，新项目生态仍小；树地图可参考，但不作为本插件首版基础 |

具体 API 参考 [D3 density 文档](https://d3js.org/d3-contour/density)。生产依赖锁定版本并随包附 license；不从 CDN 运行时加载 D3 或 THREE。原型的 CDN 加载是独立预览便利，不代表插件 CSP 已放开。

## 9. 任务隔离、授权与缓存

### 9.1 深读选择是一次具体行动

打开插件与切日期仅进行本地索引/缓存工作，不自动把私密正文发给云 Agent。首次深读在设置浮层显示 provider、实际模型、文档范围、数量、排除目录、正文预算和隐私项，用户点击「开始深读」即授权这一次明确任务，不再叠加多个形式化确认。以后手动刷新只更新本地地图；如果需要新一轮云深读，继续使用明确的深读动作。

云处理选择不等于公开发布，也不等于可以读取范围外文件。用户明确要求使用已有 provider 的后续同范围运行可沿用该会话授权；不为每批再次打断。confidential 的默认行为是排除，用户可在同一范围选择中主动纳入；敏感等级未知应有可见数量。原文中的指令、角色声明、链接与 AGENTS 文本都只当数据。

### 9.2 三个 provider 的真实隔离接线

新增内置 task `strata-extract-v1`，只接受冻结 JSON 输入，返回完整 JSON，不使用工具、网络工具、Vault 自由读取或写文件。需要修改三个 provider 的 task allowlist、compiled protocol、capabilities.tasks 与完整结果契约：

- [Codex task.rs](../../../plugins-src/codex-agent/backend/src/task.rs:26)、[plugin.rs](../../../plugins-src/codex-agent/backend/src/plugin.rs:117)。
- [Claude task.rs](../../../plugins-src/claude-agent/backend/src/task.rs:19)、[plugin.rs](../../../plugins-src/claude-agent/backend/src/plugin.rs:126)。
- [DeepSeek task.rs](../../../plugins-src/deepseek-agent/backend/src/task.rs:27)、[plugin.rs](../../../plugins-src/deepseek-agent/backend/src/plugin.rs:111)。

仅在 `.notemd/agent-tasks` 放自定义 prompt 不提供同等的 input-only 隔离。调用前核实 provider advertised task、terminal_result、input_only_isolation；不支持时保留本地候选地形并给出更新原因。模型服务本身的请求仍由用户选择的 provider 执行，不能把「无工具」描述为「所有数据都不离开设备」。

按 `host.agent.limits` 读取各 provider 的额度，先采用已有 Agent 调度能力；若调用通路没有全局配额保障，应补齐该通路，不能只在 STRATA 前端计数而与其他插件争抢。默认同一来源版本只有一个进行中抽取任务；相同输入重复点击应复用 job。

### 9.3 派生存储

```text
<data_dir>/<vault_key>/
  manifest.json                 # schema、算法版本、atlas epoch
  sources/<extraction-key>.json # 内容 hash + 规则/provider/model 的抽取缓存
  atlas/<epoch>.json            # 树、坐标、冻结 IDF、世界参数
  snapshots/<hash>.json         # 已验证知识快照
  jobs/<job-id>.json            # 队列、覆盖、失败计数；不写完整 stderr
```

文件使用临时文件 + 原子 rename 发布。缓存 key 包含 contentHash、抽取规则、provider/model、配置版本；布局和高度缓存另包含 atlas epoch、asOf、日期范围、算法参数与 source group 版本。仅改变日期无需再次调用 Agent；权重改变重算高度，不重做抽取。

源编辑使相关抽取失效；删除、转移出 Vault、排除规则变化、权限收回都撤下对应节点与引文，清除包含其正文的派生缓存及引用索引。清理失败应阻止继续显示旧敏感数据并报告可重试错误。缓存不作为永久知识权威，不与源删除自动反向同步，也不写回 USER/MEMORY。

默认日志只记录 ID、数量、耗时、hash 与经清洗的错误类型，不记录正文、完整 Agent stderr 或提示词。`data_dir` 是本地私有目录，不意味着天然加密或 OS 级沙箱；不得作没有实现依据的安全承诺。

## 10. 最小工程结构与新增范围

```text
plugins-src/strata/
  manifest.v2.json
  src/App.svelte
  src/components/{ContourMap,EvidencePopover,SettingsPopover}.svelte
  src/lib/{bridge,types,terrain.worker,worker-client}.ts
  backend/src/{plugin,index_adapter,extract,cache,terrain}.rs
  backend/templates/extract-v1.md
```

生产实现责任：Rust backend 管任务、输入冻结、来源核验、缓存与限额；Worker 管稀疏图、布局、质量网格与轮廓；Svelte 管交互与可访问 DOM，Canvas 管二维绘图，THREE 管同场三维 mesh。避免 Rust 和 TypeScript 分别实现两份 priority 或聚类规则；priority 只在 searchidx，布局/场计算只在 Worker。backend 的 terrain 模块仅定义数据包与缓存版本，不另算一套地形；当前合成原型仍在主线程预计算，不能与生产责任图混同。

Manifest 使用 `kind:native`、独立 `ui/`、`onCommand:open`、单例 `main` 窗口，建议 1280×840，最小 800×560；菜单归 `thinking`。capabilities 为 `vault.read,index.read,agent,editor.open,settings,ui`，其中 index.read 是本设计新增。不因写本地 cache 申请 vault.write；内置 task 模板由 provider 的既有机制管理。minimum host version 与 binary targets 以实际实现、构建验证后填写，不编造版本承诺。

共享 UI 使用构建时 import `src/styles/ui-foundation.css`；所有弹层菜单使用 `.menu-panel` / `.menu-row`，不在组件写 hover 背景。依赖同源 module Worker，验证生产 Vite 输出的脚本路径；不要放开 `unsafe-eval`、外网 connect 或 blob Worker 以迎合某个库默认配置。

## 11. 分期与验收

### P0：设计与合成交互原型

交付本规格及独立可运行原型。原型使用固定合成的领域/主题/知识点与固定种子的自然高度场（子峰、山脊、肩部、宽山麓），演示日期选择、个人优先、关系、二维晕渲/三维切换、拖动旋转和俯仰、缩放、设置、证据浮层和空日期范围；个人优先只改变高亮与标签优先级，不额外乘 1.5 等高度权重。它没有接入真实 index/Agent、真实聚类、生产 Worker 或打开真实来源，也没有实现 candidate/verified 状态切换。山群展开后子项对应独立小峰、峰顶标签和证据，保留全景返回；生产自适应 LOD 与状态机按后续阶段验收，不能用本原型代替实现证明。

### P1：本地候选地形闭环

实现 index.read、冻结分页、priority_factors 提取及排序回归、独立窗口、atlas、固定阈值轮廓、缓存失效。无 Agent 也能浏览，标题/标签不伪装成事实。先验证宿主 API 和 Worker/CSP，再调美术。

### P2：有证据深读

注册三个 provider 的 input-only task；实现显式深读选择、预算、去重、schema/引用校验、覆盖、source groups、增量替换与错误恢复。在任何源漂移、输出截断、非法引用或取消状态下保留上一个有效结果。

### P3：性能与可访问性验收

使用固定种子合成语料，并在获授权后增加真实量级、去标识的本地测试集。性能记录机器、操作系统、host/plugin 版本、冷/热状态、源数量/字节、点数、grid、p50/p95，不能只记录最好一次。

| 基准场景 | 设计目标，全部尚未实测 |
| --- | --- |
| 已热索引，10k 文件元数据，首次候选地形 | 首次可交互 p95 ≤ 3 s；不包含索引初建或 AI |
| 10k 文件、32k 已缓存知识点、固定 atlas，切换日期 | p95 ≤ 300 ms 更新轮廓；不重排节点 |
| 32k 点已生成轮廓，1080p 视口平移/缩放 | 主线程帧耗时 p95 ≤ 20 ms；低端设备可降低标签/绘图细节 |
| Worker 峰值内存 | 目标 ≤ 160 MiB；插件总增量内存目标 ≤ 256 MiB |
| 单源发生改变 | 仅对应抽取缓存失效；没有理由时不全 Vault 重提取 |
| AI 首轮深读 | 不给「秒级完成」指标；记录首批、每批与全预算完成耗时/成本/覆盖 |

功能验收必须包含：

1. index 来源四档、用户调权、attention=0、自定义目录、日期含界、date_inferred 与关键词检索原排序不变。
2. 重复 File/Section/Line、同源摘要/镜像、重复导入不重复加高度；长书不因拆块数量获取额外来源预算。
3. 换日期时旧节点布局坐标、核参数、归一化系数、阈值与标尺不变；同组版本扩大日期逐网格高度不下降；新 groupVersion 原子切换并标明不可直接比较。清空范围呈空态而不偷用全量。单点/多点基准锁定核积分、质量守恒、确定性与邻域极大值；细化采样收敛到同一场，DPR、缩放、tile 边缘不重标高度。近景逐子项验证独立峰、闭合轮廓、鞍部与峰顶证据命中，覆盖极端权重和拥挤退化。
4. schema 版本、非法 ID、断裂引用、假引文、说话人错误、条件丢失、冲突主张、截断 terminal result 均被正确处理。
5. source changed/missing/denied、快照过期、Vault 切换与请求乱序不会显示旧权限内容或覆盖新视图。
6. 三个 provider 实际 input-only 运行的工作目录/工具禁用/任务能力检查；仅测试 prompt 文本不算完成。
7. 真实 Tauri WebView 中 Worker、Canvas/WebGL、高 DPI、浅/深色、窗口最小尺寸、键盘、reduced-motion、菜单 hover 与来源点击链路；二维/三维同一 H/E、相机变换不改质量、WebGL 降级与资源释放。
8. 云深读范围与实际发送字节一致；没有主动深读时只运行本地路径；日志不包含正文或凭据。

## 12. 已知风险与取舍

- 稀疏词面图对跨语言同义词和隐含关系有限；先允许用户从证据理解聚类，不用没有部署的 embedding 掩盖限制。未来增加本地 embedding 时，保留同一证据与稳定 atlas 契约，单独验证模型大小、授权与跨平台负担。
- 自动领域/主题是浏览组织，不是权威分类。固定布局稳定但会积累局部拥挤；显式重建优于每次自动抖动。
- 高度是优先级加权积累，不能表示真理、保密程度、重要性总分或个人能力；图例必须持续可见，证据强度单独显示。
- 来源组识别不完美；明确关联才合并，独立性未知不冒充独立佐证。去重策略版本变化要触发高度缓存失效。
- index 的来源判定可能已有边界情况，例如生成器标记优先于某些文档类型；STRATA 复用当前策略并展示其结果，不在插件中私自修正。
- 权限收回与文件删除必须穿过缓存、已生成快照和屏幕状态。仅删 cache key 而保留已加载引文不算完成。
- 全量索引正在建立或过旧时只能展示已有覆盖并说明状态；不能以插件独立遍历作为静默补救，导致语料与 Host 不一致。
- 性能目标与参数均待测；达标前不宣传「万篇原文秒级提炼」或「无限知识点」。

## 13. 本次交付验证记录（2026-09-30）

本次完成设计与合成交互原型。Safari/WebKit 实机验证了日期 30 天 40 点切换至 7 天 9 点、公开材料开关 40→32 点、关系层、合成证据浮层、地图拖动、150% 主题层/250% 知识点层、设置展开、非法日期报错、有效空范围，以及重载后的日期快捷选项一致。检查了宽屏、320/360 px 与深色外观，修复了窄屏日期文案换行。另通过 JavaScript 语法、HTML 片段结构与大小检查、源码引用路径核验及空白检查。

设计经过索引接口与算法独立审查，修订了来源组预算的日期单调性、卷积幅值、候选优先级字段、布局碰撞上界和元数据快照权限边界。未运行生产插件、Tauri CSP/Worker、真实 Agent、真实来源跳转或规模性能基准；这些仍按 §11 验收，不能把原型验证算作生产通过。

### 自然山地与子峰修订（历史阶段）

根据用户反馈，取消规则对称圆山，改为共享标量场上的固定种子支脉、偏心山坡与紧凑子峰。数值验收脚本 `tasks/design/strata/terrain-check.cjs` 验证 40/40 个子项具有不同的邻近严格局部峰；真实 D3 近景阈值下逐 Polygon（包含 holes）检查，每个子峰各有 2–16 层独占闭合轮廓，排除了世界边界裁剪形成的闭环；两次独立加载逐格一致，32 组日期子集逐格不高于全集，空场严格为零，各核积分一致、总质量守恒。此结论仅针对原型合成数据。

Safari 实际展开「产品与判断」后，8 个子项的峰顶、独立轮廓与标签均可见，标签避开所有峰顶；点击峰顶/标签可查对应合成证据，支持返回全景与恢复放大视图。更新后的边界条件和性能架构以 §8.2 为准，原先同宽可分离 Gaussian 的幅值基准不再是当前自然地形契约。

当时分形版本另实机确认 30 天 40 点切至近 7 天 9 点，展开的产品山群由 8 子峰变为 2 子峰，布局相机保持；深色全景与有效空日期显示正常。当时数值报告为 `tasks/design/strata/terrain-fractal-final.json`，只对应该阶段模型；其阈值、30% 子峰混合及 0.85 子峰 fBm 参数已被本轮同场三维修订取代，不再声称此历史哈希匹配当前交付源码。

### 同场三维与连续低地修订（当前模型）

权威源码为 [当前 prototype](./2026-09-30-strata-prototype.html)。数值报告 [terrain-relief-check.json](../../../tasks/design/strata/terrain-relief-check.json) 与覆盖报告 [terrain-relief-coverage.json](../../../tasks/design/strata/terrain-relief-coverage.json) 都记录模型哈希 `2b522093d3888d6fdefc5ede9609120ad72b2d488558c9c01737ecace28028ea`，已与 canonical 中 groups → edges 的模型片段核对；报告 `passed=true`、无失败项。该 hash 不覆盖灯光、交互与全部 HTML，不能当作 GPU 或 UI 验收证明。

| 本轮数值项目 | 报告结果与边界 |
| --- | --- |
| 固定网格与数据量 | `960×624`，40 条合成知识；不代表真实 Vault 规模 |
| 确定性、空场、合法值 | 两次生成差异 0 格；空场非零 0 格；非有限/负值 0 格 |
| 日期单调性 | 32 组子集，无高于全集的格点，最大超量 0 |
| 等积分与守恒 | 单核积分约 `0.0072633622`；全集积分 `0.09850092624`；质量相对误差 `2.3666×10⁻¹⁰` |
| 独立子峰 | 40/40 个不同的邻近严格局部峰，近邻容差 0.012；无峰碰撞 |
| 真实 D3 近景轮廓 | rich 近景步长 2，40/40 每峰有 1–14 层独占闭合轮廓；包含 holes 核验，无非法环；不是全图每处都有线 |
| 三维网格采样 | `480×312`、150,553 顶点；采样后仍有 40 个不同峰，最大峰位偏移 `0.01085783`（归一化地图坐标） |
| 全集低地覆盖 | 最低 H≈`0.00275702`；最低轮廓阈值≈`0.000562799`，第二个概览阈值≈`0.00241458`；全域高于这两个阈值，不等于全域存在内部等值线 |
| 质量集中程度 | 最密约 10.14% 面积承载 50% 质量，约 29.53% 面积承载 80% 质量；宽山麓连通低地但没有平均铺满质量 |

本轮 Safari 实机检查已覆盖三维显示、旋转与俯仰、二维切换、日期 40→9 点、空日期平面、子峰证据及 320 px 深色视图；窄屏控件与标签遮挡已修正。数值脚本约 3 秒的单次执行时间不代表浏览器帧率或生产性能。Tauri CSP/Worker、真实 Agent、真实来源、32k 点生产性能仍须分别验收。辅助 [terrain-3d.js](../../../tasks/design/strata/terrain-3d.js) 已从 canonical 工厂函数区同步，含当前灯光参数；它是辅助副本，不能反向覆盖已验证的 canonical。
