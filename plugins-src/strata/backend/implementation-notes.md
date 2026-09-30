# STRATA 后端实现与边界

后端仅调用 `host.vault.info`、`host.index.snapshot/blocks`、`host.agent.providers/run/status` 和 `host.ui.post`。原文由宿主的只读索引能力提供；没有 SQLite、CLI `--all` 或 Vault 正文写回通道。`data_dir/SHA256(vault root)/` 存放可丢弃派生缓存、任务回执和布局。临时文件原子替换，Unix 目录为 `0700`、缓存文件为 `0600`。

## UI RPC

所有字段遵循 `src/types.rs` 的 camelCase 序列化，`File.docDate` 可为 `null`。

- `plugin.snapshot {from,to}`：返回完整授权 atlas 元数据、候选/已核对节点、关系、覆盖率和最近任务。`snapshotId` 是宿主真实的 atlas token，可用于 `host.index.status`。日期含两端，沿用 `doc_date`，没有日期的文件不进入选区。`asOf` 是宿主复用既有优先级计算的 UTC 民用日；与 UI 的设备日期预设用途不同。
- `plugin.extract {from,to,harness,budget,includeConfidential}`：立即返回 `Job`，后台顺序处理。预算为 `{maxFiles,maxBytes,maxSeconds}`，默认 `120/2097152/1800`，允许 `1–500` 文件、`256 B–8 MiB` 原文、`10–3600` 秒。`maxBytes` 累计实际提交的原文文本 UTF-8 字节，不含协议提示词开销，也不是价格上限。每批最多 `32 KiB`、一个文件的非重叠单元。超大的语义单元不截断后冒充完整原文。
- `plugin.job {}`、`plugin.stop {}`：读取状态或停止后续批次。停止设置本地取消标记并阻止随后发布，不声称远程 provider 已停止计费。停止路径无需等待 Host RPC。
- `plugin.dismiss_job {jobId}`：只有 `canDismissRecovery=true`、当前 worker 已结束、仍有未确认 pending 回执时可放弃本地恢复。返回更新后的 `Job`。这是显式丢弃恢复信息，不会启动 Agent，也不能证明远程批次已结束。
- `plugin.open_source {nodeId,from,to,evidenceId?}`：重新创建所选范围快照并由 `blocks` 核验 SHA；证据打开返回完整 `Evidence`，候选打开只返回 `{path,sourceId,contentHash}`。包含保留旧知识 ID 的待复核候选。UI 之后调用 `host.editor.open`，当前宿主没有精确跳行 API。
- `plugin.atlas.load {vaultKey}` / `plugin.atlas.save {vaultKey,atlas}`：Vault key 与当前 Host root 哈希一致才读写。持久化节点只保留 ID、位置、半径和父级，不保存标题、引文或 sourceGroups；刷新后必须由当前 `snapshot.nodes` 合并。旧节点被过滤时同时清除旧 IDF、重置分组名称。版本、坐标、计数和 `16 MiB` 大小有界。

浏览与缓存证明不会调用 `host.agent.run`。没有 provider 仍可浏览标题/标签候选。深读必须从 UI 明确选择 provider/范围/预算后触发；默认跳过明确 `confidential` 来源。`unknown` 不是公开，也不是个人独有。来源优先级沿用宿主 `filePriority=max_nonoverlap_unit`；backend 不复制检索 score，也不再次计算地形质量。

## 抽取与证据

`strata-extract-v1` 的共用编译时协议位于 `plugins-src/agent-run-core/templates/strata-extract-v1/`。Claude、Codex、DeepSeek 的能力表、内置任务读取、协议指令和执行隔离均注册了该任务；被篡改的 Vault 同名协议不能提升工具权限。隔离沿用各 provider 既有实现：空临时工作目录、编译时工具禁用规则，不加载 Vault 项目指令/上下文。

首版实现的是紧凑 `notemd.strata/extraction/v1`，**没有宣称完整复用设计中的 KnowledgeDataset schema**。保留的知识字段为 `kind`（entity/concept/claim/event/narrative）、`epistemic`、`speaker`、`conditions`、`limits`、`ownerSpecificity`、`confidentiality`、`classificationReason` 和 `evidence`；关系为严格的二元类型和各自证据。一次输入最多 48 节点、96 关系，每个对象 1–8 条逐字引用。跨文件同义实体统一、多元关系和独立事实判断不在这份紧凑契约内；聚类相似性不会自动生成事实关系。

只接受 `state=done`、`record.status=success`、`terminal_result.complete=true` 的完整 JSON。校验 schema、invocationId、字段范围、关系端点、输入中的 blockKey、原始文件 SHA、1-based 行范围和指定行里的逐字引文。完成后再用冻结来源 `blocks` 验证同一原文，才原子发布缓存。模型声称成功、截断摘要、伪造/错行引文、来源变化或快照过期均不发布该批结果。`verified` 仅意味着结构与引文回源核对，不意味着观点被证明、说话人身份得到独立认证或模型分类必然正确。

`owner_specific` 需要解释与引用，模型的归属判断仍是可审查推断。来源明确敏感不可降级；未明确公开的来源不能因模型选择 public 而升级。候选不继承个人独有标签。协议禁止提取凭据，后端另对常见私钥/token 形态阻断；这不是对任意语言机密的完整检测器。

## 缓存、稳定性与预算

来源缓存按稳定 fileKey 分隔，只有路径、contentHash、抽取规则版本匹配才复用。源编辑/删除/权限排除会使旧条目失效；宿主还校验 Vault、配置、权限和快照寿命。索引元数据里的 mtime/size 不能证明同秒同长度编辑，因此当前选区展示已核对引文前，后端另取 range snapshot，用 `blocks` SHA 证明缓存仍匹配。

每次浏览的证明预算为最多 500 文件、16 MiB 返回原文，按 `filePriority` 排序。`coverage.proofDeferred` 报告选区内尚未获得本次证明的缓存来源。超过预算或语义段无法纳入的节点保留身份和布局成员，降为 `candidate`，清空 evidence/关系与个人独有标签，说明“已有抽取缓存，尚未在本次范围核对来源 SHA”。日期外缓存同样不携带引文。缩小日期范围可优先证明对应来源。源 SHA 冲突则撤除缓存，回到文档元数据候选，不能用预算延后解释真实失效。

相同 contentHash 才认作同一来源组；不会把相似标题或推测的衍生文档合为一组。组中一旦有已抽取知识，文档候选被替换，不再与知识点重复分配来源预算；未完成部分计入 coverage。组版本由规则、configHash、实际 priority 和完整 canonical ID 集合决定，不因时间滑块或每次 RPC 的瞬间时间改变。质量分配由前端 Worker 单点负责。

固定组版本/布局 epoch 下，仅日期 mask 变化可以保持质量标尺；新抽取改变 canonical 集合、来源编辑、策略或每日衰减导致 priority 改变时会切组版本，不能承诺这些变化前后的旧峰严格单调。候选转知识也可能改变成员和布局；先前几何只为当前节点提供位置种子，不会复活已撤销数据。

## 异步执行与恢复

`rpc.rs` 使用异步 NDJSON dispatcher：Host 应答持续被处理，等待索引的 UI 请求和长 Agent 任务不阻塞协议读循环。每个 Vault 仅一条本地顺序深读队列；每批持久化 `invocationId/input_hash/run_id` 回执。没有全局跨插件调度器；provider 的既有任务锁仍可能因另一窗口正在使用同名任务而拒绝启动，显示失败而不私自重复排队。

正常完成/拒绝的终端结果清理 pending；启动状态未确认时保留回执并阻止再次启动。进程重启只轮询已有 run_id，核对原快照后可保留已完成批次，剩余文件必须再次显式深读；不重新发送原文、不自动重启剩余队列。过期快照下结果被丢弃。缺失 run_id 时不能安全重试，显示 `canDismissRecovery`，由用户显式放弃恢复。已取消批次即使后来成功也不发布。源正文在待完成 packet 中可能暂存于私有缓存目录，终端回执处理后删除；用户丢弃恢复也删除它。

## 验证入口

```sh
cargo test --manifest-path plugins-src/strata/backend/Cargo.toml
cargo build --manifest-path plugins-src/strata/backend/Cargo.toml
python3 plugins-src/strata/backend/tests/protocol_smoke.py
```

Python 测试启动真实 Rust 子进程，用合成 Host/Agent 协议测候选与回源、成功与预算、取消、伪引文、截断、来源漂移、过期、未知启动回执、进程恢复、布局过滤和 Vault 切换；不读取真实 Vault，不调用云 Agent。Provider 引擎测试另使用 fake CLI/ACP，验证 STRATA 空工作目录与禁用工具规则。真实三家云模型的语义质量和计费未由这些测试证明。
