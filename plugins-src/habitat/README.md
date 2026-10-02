# HABITAT · 心城

HABITAT 从当前 Vault 的 Markdown、大纲节点和已有会议知识数据生成可回源的关键词关系图：关键词成为建筑，关系形成道路，Leiden 社区形成街区。核心计算在本机完成，不新增模型调用。已有 AI 抽取数据仍标记为导入声明或候选；来源版本匹配不代表语义已经证实。

`0.3.0` 已发布至 [note.md 插件市场](https://plugins.notemd.net/)。知识节点改为关注关键词，采用 TF-IDF 关注先验、个性化 PageRank、局部 NPMI 关联和标准 Leiden 社区发现。提供 macOS Apple Silicon / Intel 包。最低宿主为 `>=6.930.3`，需要包含新 `host.knowledge.*` 接口；宿主 `6.930.3` 已发布。已完成本地提取、压缩快照、专用 Git 保存与历史接口、语义比较及 Three.js 低模 3D 城市界面；真实 Vault 本轮只读验证，没有在该 Vault 创建结构文件、Git 提交或推送。产品设计与当前实现边界见 [提取规格](../../docs/superpowers/specs/2026-09-30-vault-knowledge-structure-extraction-design.md#11-源码实现与真实全量验收2026-09-30)。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| [`habitat-core`](../../habitat-core/) | 纯本地解析、确定性身份与来源家族、候选主题、稳定布局、快照校验/编码及语义 diff；不操作 Vault 或 Git |
| [`backend/`](backend/) | 经授权宿主接口冻结索引清单、补充会议知识集、逐份读取与核对 hash；运行提取任务、保留失败预览、调用保存/历史接口 |
| [`src-tauri/src/knowledge_structure/`](../../src-tauri/src/knowledge_structure/) | 宿主限定路径的原子写入、Git 专用提交、事务恢复、历史读取与同步分叉检查；发布前复核来源和范围 |
| [`src/`](src/) | 城市、全量搜索列表、主题归属、证据定位、覆盖范围、历史与语义差异界面 |
| [`scripts/preview.mjs`](scripts/preview.mjs) | 只读本地浏览器预览已生成 JSONL；不连接宿主、不保存、不读取 Git 历史 |

## 当前算法与展示范围

- Markdown 使用 AST 解析链接，按段落/大纲节点复用证据；代码块、外部 URL 和页内 fragment 不生成知识关系。空 Wiki 是命名锚点，可从入链取得依据。Wiki 显示别名不作为全局身份别名。
- 精确副本和可核对的单一来源链共享来源家族。未知谱系保留 `unresolved`，不会被算成已验证的独立来源；导入证据的 `imported` 与原文定位核对的 `matched` 分开。
- 会议数据先检查 schema 与引用闭包。首版投影 `concept`、`entity`、`project`；`claims/events/narratives` 全部读取检查，保留在带 path/hash 的原知识文件并计入未投影统计，不逐条生成建筑或单条定位索引。已投影对象和关系维护 record/evidence JSON Pointer；只有参与者均已投影的关系才进入图，保留完整角色，不能把不完整多元关系降成错误二元边。
- 解析阶段同名会议对象保留各自 dataset 作用域。图谱阶段以 NFKC/大小写归一的词项汇总证据，表示“同一个词”，不确认同名人物是同一个实体；原有 JSON Pointer 定位保留。“项目”元数据只构成候选意图。
- 组织算法为 `habitat-keyword/2`：候选来自明确 Wiki 链接、标签和已有命名概念/实体/项目；用来源去重的 TF-IDF 关注先验和个性化 PageRank 选择最多 1,200 个关键词。人工记录线索、主动链接和项目元数据加权，模板词、日期和路径噪声过滤，纯导入内容降权。当前不自动发现未标注正文中的全部术语。
- 明确关系保留类型、方向角色和来源；同一来源组去重。统计共现仅来自短段落/大纲节点，使用一致窗口计算正 NPMI，并要求至少两个去重来源组；未知谱系不冒称独立证据，共现不表示因果。多元关系保留，不能为画道路强拆成两两事实。
- 固定种子调用 `leiden-rs =0.8.1` 完整三阶段 Leiden（局部移动、细化、聚合）；按加权关系形成社区，中心词组合命名。NPMI 权重用于聚类，道路按关系类型与来源支持单独分级。主归属决定街区，次归属仅表示跨主题联系；未形成关系的词留在探索区。算法依据和参数见 [关键词图谱规格](../../docs/superpowers/specs/2026-10-02-habitat-keyword-graph.md)。
- 原有身份和坐标尽量继承；新主题采用方形螺旋布局并避让已有地块。词面相似和局部共现不宣称因果。
- 城市使用 Three.js/WebGL：地形基座、光照阴影、园区建筑群、营地、街区和树木；支持旋转、平移、缩放与对象选择。Hemory、note.md、Bushcraft 的园区/营地外观来自本次视觉规划，不改变其真实类型、候选状态或主题归属。
- 新版城市按关键词的主社区组织抖动 Voronoi 地块、连续街道和沿街住宅；不把空间相邻误当成语义相近。同一社区的项目地标可有独立园区。孤立词按空间收纳为“待连接关键词”探索地块，明确不是知识社区。旧快照仍按原空间规划显示并标记“旧版对象图”。每块保留成员引用，建筑总量限制为 650；列表每页 60 项，搜索及社区过滤覆盖全部入选关键词。
- 地标优先标注。对象间不叠画独立曲线；二元关系聚合到街区后沿稳定街道网络路由，经过的路段按固定的局部流量函数变宽。直接记录的引用/知识链接权重最高，统计共现、标签和导入声明较低；多参与者关系不擅自拆成两两道路，未投影或断开的关系不虚构道路。浅色小径、树木和水岸是景观，不代表真实知识调用；没有调用事件数据时不生成车流。历史变化以橙色地面标记显示，总览中街区任一成员变化会标记其代表建筑。

尚未实现人工合并/拆分、用途及园区规划编辑、真实知识调用事件车流、跨设备同时生成或自动语义消歧。没有事件数据时不生成真实车流；历史界面列出保存版本及结构差异，未实现完整成长动画或恢复旧版为新版本的操作。

## 快照与 Git

生产固定文件为 `.notemd/habitat/knowledge-structure.jsonl.zst`。内部是完整、规范排序的 UTF-8 JSONL（schema `vault-knowledge-structure/1`），外层使用标准 Zstandard level 9 无损压缩，不是私有压缩格式或删减投影。来源 hash、身份、证据定位、角色、归属、布局、覆盖与算法参数均在快照内；不保存原文全文。

`habitat_core::encode/decode` 处理压缩快照；`codec::encode_jsonl` 用于人工导出。已安装标准 `zstd` 命令时，可在 Vault 外解压查看：

```sh
zstd -d -c -- /path/to/vault/.notemd/habitat/knowledge-structure.jsonl.zst > /tmp/habitat-current.jsonl
```

源码宿主中的“重新解析”执行生成与保存事务，只提交上述一个固定文件，保留其他已暂存和未暂存修改；相同结果沿用原版本，不制造空历史。失败预览与待保存事务不是已提交历史。体量超过现有 Git 门禁时保留旧版并报告，不能截断后声称覆盖全库。

人可以直接使用 Git 检查该文件的版本和导出某一版：

```sh
git -C /path/to/vault log --oneline -- .notemd/habitat/knowledge-structure.jsonl.zst
git -C /path/to/vault show COMMIT:.notemd/habitat/knowledge-structure.jsonl.zst | zstd -d -c > /tmp/habitat-history.jsonl
```

Git 保留所有结构版本；界面首版最多列出最近 100 个，截断时明确提示。压缩文件的文本 diff 不表达知识变化。HABITAT 的“历史 → 查看结构变化”解码两个完整版本，按稳定 ID 比较新增、缺失、改名、关系、归属和布局，并区分方法/范围/依据变化。旧结构中的证据只在当前来源 hash 匹配时打开；当前文件不能冒充旧版原文。

## 构建与测试

以下命令从仓库根目录执行，使用现有 Rust 与 pnpm 工作区环境：

```sh
cargo test --manifest-path habitat-core/Cargo.toml
cargo test --manifest-path plugins-src/habitat/backend/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib knowledge --no-default-features
cargo test --manifest-path src-tauri/Cargo.toml --lib vault_sync::git_ops --no-default-features
pnpm --filter habitat-plugin check
pnpm --filter habitat-plugin test
pnpm --filter habitat-plugin build
cargo build --release --manifest-path plugins-src/habitat/backend/Cargo.toml --bin notemd-habitat
```

只需查看已生成结果时，使用下节只读预览。需要验证宿主接线时，本地安装命令为：

```sh
bash scripts/dev-install-plugin.sh habitat
```

源 manifest 的最低宿主版本为 `>=6.930.3`。dev 安装脚本只调整**安装副本**的版本约束，源 manifest 不变；本地开发宿主须包含 `host.knowledge.*` 接口。此命令是本地插件开发安装，不发布插件，不替换正式 note.md app。

## 只读复验与预览

开发审计从既有 schema v7 SQLite 导出只读清单，再调用与生产相同的纯提取、组织与编码代码。它不重建索引，不写 Vault；输出目录必须在 Vault 外。该适配器与生产 host RPC 捕获不是同一次验收，`vaultId/scopeHash` 也明确使用开发标识。

```sh
mkdir -p tasks/design
python3 habitat-core/examples/export_audit_manifest.py /Users/bruce/git/sotvault tasks/design/habitat-vault-manifest.json
cargo run --release --manifest-path habitat-core/Cargo.toml --example audit_vault -- /Users/bruce/git/sotvault tasks/design/habitat-vault-manifest.json tasks/design/habitat-current.jsonl
pnpm --filter habitat-plugin preview --snapshot /Users/bruce/git/mdeditor/tasks/design/habitat-current.jsonl --port 8787
```

最后一条命令自动构建前端并仅监听 `127.0.0.1:8787`，输入必须是解压后的标准 JSONL。也可先构建再直接运行：

```sh
node plugins-src/habitat/scripts/preview.mjs --snapshot /absolute/path/snapshot.jsonl --port 8787
```

浏览器预览显示“只读预览 · 未存入 Vault”。它支持城市选择、全量搜索、分页、主题和覆盖范围浏览；重新解析、保存、Git 历史和打开原文均不可用。此模式不能证明真实 note.md 桥接已通过验收。

## 2026-09-30 全量验证记录

本机 `/Users/bruce/git/sotvault` 冻结清单包含 14,207 输入（含 445 个 `knowledge.json` 与 2 份配置），全部成功解析；没有不可用输入。输出只保存在仓库被忽略的 `tasks/design/`。

| 指标 | 实测 |
| --- | ---: |
| 节点 | 32,526：概念 11,603、实体 5,805、项目 401、文档 12,437、主题 2,280 |
| 关系 / 证据定位 | 31,067 / 63,870 |
| 会议知识记录 | 44,838 = 19,145 已投影 + 25,693 明确未投影 + 0 隔离记录 |
| 未有命名概念归属的来源 / 未解析本地链接 | 8,184 / 12,287 |
| 压缩快照 | 8,274,428 bytes（7.89 MiB），低于 10 MiB 门禁 |
| 完整展开 JSONL | 48,601,593 bytes；压缩后为 17.03% |
| 提取 / 组织 / 完整解码 | 30,376 / 1,282 / 1,050 ms |
| 同输入完整重跑 | 32,913 ms；压缩字节与 JSONL 字节均完全相同 |
| 无损解码 / 空标签 / 坏证据引用 | 通过 / 0 / 0 |
| 主题布局宽高比 / 全部坐标重复 | 1.0 / 0 |

源码验证还包括核心 24 项、原生后端 9 项、宿主知识接口/事务 28 项、Vault Sync 20 项、既有 index 9 项、Vault 信息 7 项；前端 20 项与本地服务 2 项测试、类型检查、生产构建通过。宿主和插件 debug 二进制构建、原生 NDJSON 初始化及宿主请求往返通过。宿主按测试名称筛选包含既有回归，不以数量宣称覆盖完整应用。历史缓存已覆盖容量上限、跨分支 commit 绑定与未知坏版本拒绝。

12 项提取 fixture 测试已通过，覆盖 AST、空 Wiki 入链、真实 `note.md` 名称、路径扩展、局部大纲证据、改名身份、来源去重、会议闭包和完整关系角色。全量结果中可检索到 Hemory、note.md、隐性知识与 Bushcraft；名称命中数不代表已确认项目数或语义质量准确率。

只读浏览器预览已验证真实全量数据的亮色、暗色、800 px 窗口、选择详情、覆盖面板及写操作不可用状态，未出现浏览器错误。本机 Chrome 单次首次显示 325 ms、搜索 54 ms；这是一次观察值，不是 SLA。截图保存在忽略目录 `tasks/design/habitat-final-{overview,hemory,detail,coverage,dark,narrow}.png`，不代表原生宿主集成验收。

可复验摘要为 `tasks/design/habitat-current-summary.json`，快照为同目录 `habitat-current.jsonl.zst` 与人工预览用 `.jsonl`。上述耗时是本机单次测量，不是 p50/p95 或峰值内存结论；全库人工语义准确率和真实宿主全量保存/回放仍需单独验收。

## 2026-09-30 三维视觉重做

已将原 72 地标 Canvas 替换为低模三维城市场景，使用同一真实快照，无新增模型调用。前端 25 项和预览 HTTP 2 项测试、类型检查及生产构建通过；Chrome 实测了全景、地标详情、放大展开、回到全景、搜索、深色和 800 px 宽度。截图为 `tasks/design/habitat-3d-{overview,detail,zoom,search,dark,narrow}.png`。WebGL 不可用时保留结构列表入口。当前仍是本机只读浏览器预览，未替换运行中的正式 app。

## 0.1.0 市场发布验证（2026-09-30）

使用仓库 Wrangler 3.114.17 与 Account API Token，按 R2 包/签名上传 → 匿名回读验签 → KV 索引的顺序发布。双架构 Developer ID、minisign 生产签名均通过验证，原生进程初始化/退出检查通过。公网包与本地产物逐字节一致；索引保留原有 249 条，仅新增 HABITAT 为第 250 条，普通与绕缓存公网索引均匹配候选文件。未发布宿主、未修改实际 Vault，也未随包携带私有快照。

- Apple Silicon：3,477,791 bytes，SHA-256 `b762c3a4fc37f3424a4c588e3763dfe5b04367977f52274fbfde0851611a3ebe`。
- Intel：3,575,249 bytes，SHA-256 `78fe74c7ef6bab26f700b833074575d8108f1d0d66956be6bf41f1a126120587`。
- 发布审计文件：`tasks/design/habitat-release/`（本机忽略目录）。

## 0.1.1 道路与街区更新（2026-10-01）

关系不再以跨街区曲线叠画；直接记录的链接、标签以及低权重的导入候选沿已有街道网络聚合，局部关系量决定路宽。道路宽度采用固定映射，使历史版本中其他地区增长不会令原路变窄。园区占地按整段道路采样避让，街区有分组住宅、项目楼群、成长地块、营地和水岸。真实快照 32,526 对象的全景、近景、Hemory 详情和 800 px 窄屏已在 Chrome 只读预览验证；这是低模程序化城市，尚未达到概念效果图的写实程度，也没有实际车辆流量。

前端 32 项、预览 HTTP 2 项测试及类型检查、生产构建通过。Apple Silicon / Intel 包分别为 SHA-256 `108ed929121fe006a618329deb7dfef63e31a3524149bfd42f240202089bd3c5` / `01563f2e9a8aa407e7d9346a81169ae9fbb1e1288a8849789b8b1ec851e035de`；Developer ID 与 minisign 验签通过。沿用仓库 Wrangler 3.114.17 + Account API Token，R2 四对象匿名回读逐字节匹配后发布 KV；公网索引由 250 条增至 251 条，旧条目保持不变。

## 0.2.0 游戏模型与连续街区（2026-10-02）

参考 [SimCity Three.js](https://github.com/dgreenheck/simcity-threejs-clone) 的资产缓存与建筑组织，以及 [3d.city](https://github.com/lo-th/3d.city) 的城市表现；未复制这些项目的模型或代码。使用 Kenney 官方 CC0 的住宅、商业楼、树木、帐篷及道具，34 个原始 GLB 和 3 张贴图共 2,526,130 bytes，离线随包分发。完整来源、ZIP/文件校验值和许可证见 `public/models/manifest.json` 与 `THIRD_PARTY_LICENSES.txt`。

场景用实例化模型、合并道路/车道/历史标记、自然边界、岸线、街灯、庭院、林缘与接触阴影。关系仅升级已有道路；项目园区、概念街区、未归属成长区和 Bushcraft 营地采用不同组合。点击地标同时靠近并显示来源，所有对象仍可搜索。新版本不改变提取算法、快照格式或 Git 历史协议。

可重复的浏览器回归（测试页仅在脚本运行期存在，不进入插件包）：

```sh
node plugins-src/habitat/scripts/render-qa.mjs \
  --snapshot /absolute/path/current.jsonl \
  --output /absolute/path/qa --hardware
```

需先在当前环境安装 Playwright，或通过 `--playwright /absolute/path/to/playwright/index.mjs` 指定现有模块；Chrome 可通过 `--chrome` 指定。脚本检查 20 次全量重建、全量历史高亮、子集/全量反复切换、知识 ID 拾取、旋转缩放、深浅色、窄窗口、关闭重开和仅本地资源加载。`--hardware` 使用默认 GPU；省略则使用 SwiftShader 做可移植检查。渲染耗时为 JS 提交测量，不当作 GPU 帧率。

最终真实全量浏览器验收：69 个 draw calls、69 个 GPU 几何、25 张 GPU 纹理，20 次重建及 5 次全量变化标记、5 次子集恢复均无资源增长；浏览器错误、警告、失败请求和外网请求均为 0。场景含 1,228 个建筑/景观实例，实际34模型文件不是知识对象数。正式UI另验 Hemory/note.md/Bushcraft 点击靠近和来源详情、搜索恢复、深浅色及800px无横向溢出。Apple M4 Pro热缓存成景约0.43秒，较冷首屏曾约1.2秒；旋转JS提交0.6–1.0ms，不代表GPU帧率。没有以本地浏览器结果替代原生宿主完整读写验收。

发布复核：前端28项、HTTP3项、类型检查、生产构建通过；已退休旧渲染模块的12项测试由新规划8项测试替代。双架构原生初始化/退出、Developer ID与minisign验签通过。沿用Wrangler 3.114.17与Account API Token，R2包和签名匿名回读逐字节一致后才发布KV，公网252条索引保留全部251条旧记录。Apple Silicon包3,964,996 bytes（SHA-256 `ad9f37effe38166f91c03499ce4021ea3d2fbb91c7724ce5d5df9691ede4c05e`）；Intel包4,063,032 bytes（`7e06ee5a66c521dd37c1b4ef0e27cdc59e4033732e8751d9be6116155628d890`）。宿主继续使用6.930.3。

## 0.2.1 街区标记

每个可见街区均显示可点击标记，名称优先取地标及本区实际主题，否则使用代表对象；悬停显示完整名称和对象数。远景拥挤处折叠文字但保留标记，靠边展开向内对齐；标签不会覆盖详情面板。真实全量110个街区均有标记，选中对象使用真实知识ID且没有重复标签。知识规划、保存坐标及快照协议保持原样。

0.2.1 验收：110/110街区标记、唯一知识ID、悬停展开、点击依据、旋转及800px全覆盖通过；28项前端、3项HTTP、类型检查与真实GPU20次重建回归通过。双架构包Developer ID/minisign验证及R2匿名回读匹配，KV由252→253条，保留全部旧记录；公网回读在短暂传播延迟后与候选索引完全一致。


## 2026-10-02 关键词图谱验证

当前 Vault 冻结清单共 14,271 个输入、445 个会议知识集，全部完成只读解析，无不可用输入。新图包含 1,151 个关键词、45 个 Leiden 社区、524 条关系（445 Wiki 引用、74 统计共现、5 导入类型关系）；724 个词没有足够关系证据，留在明确标注的探索区，不人为补边。此版本仍只使用已有明确词项，未标注的纯正文术语尚不自动发现。

完整提取约 31 秒，组织约 250 毫秒；压缩快照 1,637,865 字节。两轮全量输入得到完全相同的 JSONL/压缩字节，旧发布 core 也能解码并逐字节回编码新文件。旧快照迁移正确标记算法变化；实际 Vault 没有写入或创建 Git 提交。

32 项核心、9 项 backend、28 项宿主知识接口、35 项前端和 3 项预览服务测试通过，类型检查无错误警告。独立审计 20 项检查包含正负 NPMI、重复来源不增权、社区连通、顺序确定和旧格式兼容。新旧真实快照均通过硬件浏览器渲染回归，新图连续 20 次重建维持 69 个几何体/25 张纹理；社区筛选、关键词证据、探索区、地标、暗色窄屏和销毁重建通过。只读浏览器与 mock-host 测试不等同于真实宿主端到端写入。

0.3.0 发布复核：Apple Silicon / Intel 原生初始化与退出通过；包 Developer ID 和 minisign 验证通过。沿用 Wrangler 3 和 Account API Token 发布，R2 四个对象匿名回读逐字节一致，随后才更新 KV。公网普通/绕缓存索引均为 254 条，与候选一致，原 253 条未改动。最低宿主仍为 >=6.930.3。
