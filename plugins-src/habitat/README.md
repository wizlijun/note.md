# HABITAT · 心城

HABITAT 从当前 Vault 的 Markdown、大纲节点和已有会议知识数据提取可回源的知识结构，以候选主题、概念、实体和项目呈现为城市。核心计算在本机完成，不新增模型调用。已有 AI 抽取数据仍标记为导入声明或候选；来源版本匹配不代表语义已经证实。

`0.1.0` 已发布至 [note.md 插件市场](https://plugins.notemd.net/)，提供 macOS Apple Silicon / Intel 包。最低宿主为 `>=6.930.3`，需要包含新 `host.knowledge.*` 接口；旧版宿主 `6.930.2` 无此接口，升级至 `6.930.3` 或更新版后才可使用本插件。已完成本地提取、压缩快照、专用 Git 保存与历史接口、语义比较及 Three.js 低模 3D 城市界面；真实 Vault 本轮只读验证，没有在该 Vault 创建结构文件、Git 提交或推送。以下说明当前实现与验证范围。

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
- 同名会议对象保留各自 dataset 作用域，不自动跨会议合并。“项目”元数据只构成候选意图，不表示已经立项或完成。
- 词汇特征与显式联系形成候选邻近图。组织算法为 `connected-local-moving/1`，是确定性局部移动及连通性细化，**不是完整 Leiden**。主归属由社区分区决定，次归属保留跨主题联系；主题名称与归属仍是候选。
- 原有身份和坐标尽量继承；新主题采用方形螺旋布局并避让已有地块。词面相似和局部共现不宣称因果。
- 城市使用 Three.js/WebGL：地形基座、光照阴影、园区建筑群、营地、街区和树木；支持旋转、平移、缩放与对象选择。Hemory、note.md、Bushcraft 的园区/营地外观来自本次视觉规划，不改变其真实类型、候选状态或主题归属。
- 超过 1,200 个对象时，总览按固定 8 单位空间格选择确定性的代表建筑；当前全量为 935 个代表。它是渲染聚合，不是新的语义社区，不改变快照坐标。每格保留全部成员引用，悬停显示街区对象数；放大至 3.5 倍展开原对象，列表选择非代表项时临时显示选择标记。列表每页 60 项，搜索、分页与主题过滤覆盖整个快照。
- 地标优先标注；实线金色连接与候选虚线来自结构关系，只显示有限显著联系。街道铺装、树木和景观是装饰，不宣称真实调用或知识关系。历史变化以橙色地面标记显示，总览中街区任一成员变化会标记其代表建筑。

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

源 manifest 保持最低宿主 `>=6.930.3`。dev 安装脚本只把**安装副本**的版本约束改为源码仓库当前 `package.json` 的精确版本，供本地源码宿主调试；市场发布包始终使用源 manifest 的正式门槛。

## 只读复验与预览

开发审计从既有 schema v7 SQLite 导出只读清单，再调用与生产相同的纯提取、组织与编码代码。它不重建索引，不写 Vault；输出目录必须在 Vault 外。该适配器与生产 host RPC 捕获不是同一次验收，`vaultId/scopeHash` 也明确使用开发标识。

```sh
mkdir -p tasks/design
python3 habitat-core/examples/export_audit_manifest.py /path/to/vault tasks/design/habitat-vault-manifest.json
cargo run --release --manifest-path habitat-core/Cargo.toml --example audit_vault -- /path/to/vault tasks/design/habitat-vault-manifest.json tasks/design/habitat-current.jsonl
pnpm --filter habitat-plugin preview --snapshot /path/to/mdeditor/tasks/design/habitat-current.jsonl --port 8787
```

最后一条命令自动构建前端并仅监听 `127.0.0.1:8787`，输入必须是解压后的标准 JSONL。也可先构建再直接运行：

```sh
node plugins-src/habitat/scripts/preview.mjs --snapshot /absolute/path/snapshot.jsonl --port 8787
```

浏览器预览显示“只读预览 · 未存入 Vault”。它支持城市选择、全量搜索、分页、主题和覆盖范围浏览；重新解析、保存、Git 历史和打开原文均不可用。此模式不能证明真实 note.md 桥接已通过验收。

## 本地验证说明

前端测试、原生后端测试、结构核心测试、宿主知识接口及 Vault 同步测试均已覆盖生成、来源核对、压缩快照、历史读取和冲突保护。使用上节命令可在自己的 Vault 运行只读审计；审计清单、展开快照与截图只保存在被忽略的 `tasks/design/`，不随源码或插件包发布。

## 2026-09-30 三维视觉重做

已将原 72 地标 Canvas 替换为低模三维城市场景，使用同一真实快照，无新增模型调用。前端 25 项和预览 HTTP 2 项测试、类型检查及生产构建通过；Chrome 实测了全景、地标详情、放大展开、回到全景、搜索、深色和 800 px 宽度。截图为 `tasks/design/habitat-3d-{overview,detail,zoom,search,dark,narrow}.png`。WebGL 不可用时保留结构列表入口。当前仍是本机只读浏览器预览，未替换运行中的正式 app。

## 0.1.0 市场发布验证（2026-09-30）

使用仓库 Wrangler 3.114.17 与 Account API Token，按 R2 包/签名上传 → 匿名回读验签 → KV 索引的顺序发布。双架构 Developer ID、minisign 生产签名均通过验证，原生进程初始化/退出检查通过。公网包与本地产物逐字节一致；索引保留原有 249 条，仅新增 HABITAT 为第 250 条，普通与绕缓存公网索引均匹配候选文件。市场包仅含插件；宿主需另行升级到 6.930.3 或更新版。未修改实际 Vault，也未随包携带私有快照。

- Apple Silicon：3,477,791 bytes，SHA-256 `b762c3a4fc37f3424a4c588e3763dfe5b04367977f52274fbfde0851611a3ebe`。
- Intel：3,575,249 bytes，SHA-256 `78fe74c7ef6bab26f700b833074575d8108f1d0d66956be6bf41f1a126120587`。
- 发布审计文件：`tasks/design/habitat-release/`（本机忽略目录）。
