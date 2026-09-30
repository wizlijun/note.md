# STRATA · 层峦

把 note.md Vault 的索引候选、深读知识与已有会议提取结果，呈现为稳定的等高线与三维山体。顶部提供数据集、日期、视角与设置；其余区域用于地形，目录与证据按需展开。

## 会议地图的标记密度

会议概览以连续山体和山群标签表达聚合，不铺满知识点阵。展开到知识层后，仅显示成功放置标签的少量标记，保持屏幕间距；选中知识用空心环定位。全部知识与关系仍可从目录访问，地形贡献和缓存布局不因标记抽样改变。

## 运行前提

STRATA 0.1.2 要求 **note.md 6.930.2 或更新版本**，包含大 Vault 流式快照修复，使用 note.md 6.930.1 新增的 `host.index.*` v1 / `index.read`。manifest 的 `engines.notemd: >=6.930.2` 同时约束市场版本选择和安装；6.929.1 及更早宿主不具备这些接口。索引 schema 从 6 升至 7，首次运行沿用宿主现有索引重建流程；未就绪会显示 `INDEX_NOT_READY`，待正常索引完成后刷新。

「全 Vault 索引」首次打开只读取已授权索引元数据，在本地 Worker 中聚类、生成候选地形。使用「设置 → 从原文深读」明确选择 Agent、文档数与正文预算，才发送当前日期范围内的原文。深读需安装包含 `strata-extract-v1` 的配套 provider：Claude Agent 1.0.32、Codex Agent 1.0.19 或 DeepSeek Agent 1.1.18（及后续兼容版本）。界面仍检查实际任务与输入隔离能力；旧 provider 会禁用深读，本地候选浏览仍可用。「会议知识」直接读取本地已有提取结果，不提供深读入口，也不调用 Agent。

## 两个数据集

| 数据集 | 输入与子峰 | 日期与高度含义 |
| --- | --- | --- |
| 全 Vault 索引 | 已授权索引中的文档候选，以及本次原文证据核对通过的深读知识 | 文档日期；沿用宿主索引优先级，按冻结来源组去重、饱和后分配贡献 |
| 会议知识 | `ssot/meetings/` 下标准 `knowledge.json` 中校验通过的实体、概念、主张、事件、叙事；关系另行显示，不生成山峰 | 会议发生日期；每个知识对象按核心/支撑权重独立贡献，表示加权知识积累 |

会议模式复用 Knowledge Browser 的严格 JSON、Schema 和业务规则校验，支持配套的 `knowledge-representation-dataset/3.1.0` 与历史 `3.0.0`。不兼容或致命错误文件跳过；局部不合格记录隔离并报告，关系不连接已隔离对象。只读取文件名严格等于 `knowledge.json` 的结果，`knowledge_*.json` 试验副本不重复计入。跨会议同名实体或相似断言不会自动合并；对象身份由知识文件路径与局部 ID 共同确定。

会议日期优先取同目录 `meta.yml.created_at`；没有 `meta.yml` 时读取 `meta.json.created_at`。有效 RFC 3339 时间保留所写时区的日历日期；元数据缺失或日期无效时尝试目录中的 `YYYYMMDD` 日期并标明推定，仍无法确定则不进入日期范围。不会拿 `generated.at`、事件的 `event/valid` 或文件修改时间代替会议日期。起止日均包含；日期切换只重新渲染当前全量快照，点击「刷新」或重新进入数据集才重新读取会议知识。

会议记录的 **`i=0` 是核心、`i=1` 是支撑**，不是私人性或真假。核心/支撑的输入权重为 2/1，再经过固定 `2 × (1 − exp(−p/2))` 压缩，单对象贡献约为 1.264/0.787；不会因为某次会议知识较多再平均摊薄。五类知识用峰顶颜色区分，「核心优先」强调核心标签和标记。分组面积按成员数量分配，山高还受局部密度叠加影响，因此不能把峰高直接当作事实可信度或单条知识排名。

关系保留 `participants` 中的全部具名角色，以多角色连接及详情表达，不额外计入地形质量。连接线不代表二元因果方向；P0–P3 是关系类别，不是四层海拔。详情保留重要性理由、说话人、条件、例外、范围、时间、限制、原始状态与证据强度声明。`strong` 只反映抽取记录的证据分档，不能等同于本插件核验事实；没有独有性或保密性字段时均为未知。

会议节点标记为「已导入」，保存的引文与定位在本次浏览中没有重新核对原文。打开来源前，后端重新核对 `knowledge.json` 的本次内容摘要，并检查来源路径及当前可访问性；这不等于读取并核验转录全文。`sources[].v` 是提取时记录的来源版本，不能显示为本次 SHA 核验成功。外部 URI 不自动抓取，知识文件、元数据与会议转录均不写回。

## 浏览与语义

全景的山群对应领域分组，中层山体对应主题分组，放大后的子峰对应所选数据集的对象。索引候选按内容去重，分组使用索引标签和标题词汇；会议知识使用对象标签、相关概念/实体和真实结构引用。领域与主题是本地算法分组，不是对全部原文的语义理解，也不把叙事成员的重叠归属强行解释成唯一父子树。山脊和分形细节没有独立知识或已核实关系含义。两个数据集的贡献单位不同，不应直接跨数据集比较山高。

- 在同一数据集和布局版本内，切换日期不重新排列旧节点，不按当前最大值重标高。日期与视图偏好分别保存，两个数据集不混用布局缓存。
- 索引模式的文档日期包含起止两天；缺日期时的修改时间推定单独计数。「个人优先」强调个人独有知识的标签与峰顶；**个人独有与保密性分开**。索引仅采纳明确 `confidentiality: confidential | explicitly_public | unknown` / `private: true`，不会把本人创作当成私密，也不会把 `private: false` 当成公开。
- 索引模式默认深读排除明确私密材料；保密性未知材料仍属于所选范围，界面会展示数量。Agent 可能使用远程模型，发送前可核对提供方、范围和预算。
- 索引候选只代表标题/标签定位；「引文已核对」代表原始字节哈希与引用区间匹配，不代表外部事实验证。行号供核对，宿主当前不提供准确行跳转。
- 点击山群或使用目录进入子峰；拖动旋转/平移，滚轮缩放；方向键、加减键与 0 也可导航。密集节点不会全部在概览分辨，需展开；目录可访问未显示标签的节点。
- 「停止后续批次」不声称撤销已提交给 provider 的远程任务。重启只恢复已知 run 的状态；启动回执不明时不自动重发。显式「放弃本次恢复」只解除本地等待。

## 实现

`backend/` 是异步 Rust NDJSON 插件进程，负责索引快照、深读证据核验、会议知识读取、原子缓存、任务恢复与回源。会议读取走已授权的 `host.vault.list/read/exists`，不直连 SQLite 或绕过 Host 直接读取 Vault；单次知识与元数据合计限 64 MiB、最多 5,000 份知识文件，超预算明确失败。`meetings.worker.ts` 顺序复用现有 Knowledge Browser parser；适配后不保留整份输入文本，来源、证据与引用对象在数据集内共享。

`src/lib/atlas.ts` 使用有界倒排候选图与多层社区划分；旧节点沿用布局。`terrain.ts` 使用确定性多尺度分形核与实际主题/领域的宽山脚，同一标量场供 D3 contours/Canvas 和 Three.js 网格使用。固定完整对象集合和版本内，日期只移除对应贡献；空范围严格为零。新抽取、编辑或权限变化使对象集合改变时，不承诺跨版本逐点单调。升级 0.1.2 会将旧 `/1` 布局一次性迁移到 `/2`，为大聚类分配相应面积；此后日期切换和再次打开沿用新布局。

前端为 Svelte 5，d3-contour 4.0.2 和 Three.js r160 随包离线构建；Worker 是同源独立 ES module，不需要 CDN、eval、blob Worker 或放宽宿主 CSP。布局通过几何白名单保存节点位置、分组和词频，不保存节点正文、引文或来源支持明细；完整输入限 64 MiB，净化缓存限 32 MiB、词频最多 250,000 项，字段形状、数值和来源授权仍须通过校验。缓存位于 Host 提供的插件 `data_dir`，按 Vault 与数据集隔离；重新载入时只恢复当前授权节点的布局。

索引模式每次浏览最多用 500 文件 / 16 MiB 的原文核对缓存引文；未完成本次证明的节点保留地图身份，但降为候选并收起引文，覆盖详情标记待核对数量。缩小日期后可以继续查看。会议模式展示已保存的提取结果，不执行这一步原文证明；刷新后重新解析当前知识文件，打开来源时另外检查知识文件是否已经变化。

宿主契约见 [索引 API](../../docs/strata-index-api.md)，设计基线见 [设计说明](../../docs/superpowers/specs/2026-09-30-strata-knowledge-terrain-design.md)。实现和验收差异见 [验收记录](VALIDATION.md)。

## 构建与验证

从仓库根目录：

```sh
pnpm install --frozen-lockfile
pnpm --filter strata-plugin check
pnpm --filter strata-plugin test
pnpm --filter strata-plugin build
cargo test --manifest-path plugins-src/strata/backend/Cargo.toml --locked
cargo build --manifest-path plugins-src/strata/backend/Cargo.toml --locked
python3 plugins-src/strata/backend/tests/protocol_smoke.py
pnpm check:protocol
```

本地开发安装沿用 `bash scripts/dev-install-plugin.sh strata`；需先运行 note.md 6.930.2 或更新宿主，不会自动更新正在运行的旧宿主。双架构签名打包用 `bash scripts/release-plugins.sh strata`，输出 `dist-plugins/notemd.strata/0.1.2/`，该脚本不上传。正式发布须先完成兼容宿主的公开发行，再沿用仓库既有流程发布目标插件；本文件中的版本要求与本地构建步骤不代表公网发布已经完成。

macOS 原生协议/GPU 验证：`node plugins-src/strata/scripts/check-webkit-worker.mjs`；独立交互窗口：`node plugins-src/strata/scripts/open-webkit-fixture.mjs`。两者均使用临时非持久 WebKit 与合成 RPC，不触碰宿主配置。

浏览器复验（**合成 fixture，没有真实 Vault/Agent**）：先 build，再 `node plugins-src/strata/scripts/preview-fixture.mjs`，打开 `http://127.0.0.1:8767`。服务使用与宿主相同的 self 脚本/连接限制，加载真实生产 UI、Worker 和 Three.js；fixture bridge 仅由验收服务器注入，不进入插件包。

32,000 节点基准：在插件目录执行 `node src/lib/terrain.benchmark.mjs report.json`。报告说明 CPU/内存测量范围；Node Worker 的测量不等价于 WebKit/GPU 或插件总内存保证。
