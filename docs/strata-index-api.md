# STRATA 索引宿主接口 v1

`host.index.snapshot`、`host.index.blocks`、`host.index.status` 同时支持 native 插件进程与插件 UI RPC；均需 `index.read`，执行前后重新核对当前插件授权与 Vault 配置。Rust 合同在 `plugin-protocol/src/index.rs`，JSON Schema 与 TypeScript 由 `scripts/gen-plugin-protocol.sh` 生成。

## 快照和分页

```json
{"version":1,"range":{"from":"2026-09-01","to":"2026-09-30","dateKind":"doc_date"},"pageSize":500}
```

日期为包含两端的索引文档日期，不是修改时间；接受真实 `YYYY-MM-DD`，拒绝零年、非法日和反向范围。省略 range 创建 `atlas_metadata` 快照，其 ID 一律不能调用 blocks。后续 metadata cursor 请求须重传原 range。默认 500 文件，最大 1000，按稳定 fileKey 排序，快照冻结 asOf、有效权重、元数据与单元引用。asOf 复用现有 searchidx 排序器的 UTC 民用日时钟；顶栏的设备本地日期预设仅决定 range，不改变优先级计算时钟。fileKey 是规范化 Vault 相对路径的 SHA-256；改内容保持 key、改路径更换 key。contentHash 是原始文件字节 SHA-256。blockKey 来自路径、contentHash 和包含两端的行范围，不依赖 SQLite rowid。

快照只读取索引字段，不读取原文或索引 block.text。只使用 line 级语义单元，重叠 leaf 范围合并成一个原文区间、采用其中最高优先级依据，File/Section 汇总不重复计质量。filePriority 为非重叠单元优先级最大值，同分按最小 blockKey；无合格单元为 0 / null 并计入 skipped。优先级复用搜索的 structural、annotation、verified、origin、attention、agent、freshness 因子，不包含 BM25、短语或 query 关联分数，不进行结果集最大值归一化。

coverage.indexed 为索引总文件数，selected 为当前范围内实际保留数，stale 为范围内 stat 与索引不符而剔除数，excluded 包含不可访问、已移除、符号链接或当前规则排除数，undated 为索引总无日期数，skipped 为保留但无合格语义单元数。快照有 stale 时 freshness 为 stale。覆盖的是已索引数据，不能声称已捕获尚未被 watcher 索引的新文件。

TTL 为 60 分钟；全进程最多 32 个快照，每插件最多 8 个；约 128 MiB 元数据总预算、单次捕获 32 MiB、最多 50000 文件或 500000 单元。越界拒绝，不悄悄截断；过期或容量淘汰返回 `SNAPSHOT_EXPIRED`。日期/Vault/插件/配置不匹配的 cursor 不可使用。Vault 切换、设置成功写入、插件移除/更新/撤权会清除旧快照，即使之后切回也不恢复旧 ID。

## 原文读取与状态

```json
{"version":1,"snapshotId":"host-issued-id","fileKeys":["opaque-file-key"],"maxBytes":1048576}
```

blocks 只接受该 range 快照已有的 fileKeys；默认单页原文 UTF-8 文本 1 MiB、最大 4 MiB、单快照累计返回文本 32 MiB；fileKeys 最多 1000。继续 cursor 时须重传相同顺序的 fileKeys。分页保留完整语义单元，不截断原文；单元超页预算会返回 too_large conflict 并跳过，调用者必须呈现覆盖缺口。每页最多 2000 单元。

每次读取重新检查当前排除规则、常规文件和路径边界，再核验完整文件原始字节 SHA-256。Unix 用逐层 openat + O_NOFOLLOW 固定目录描述符；Windows 检查最终打开句柄的路径与 reparse 标记。发生 changed、missing、denied、too_large 时返回冲突，不返回未验证的新文本。返回 text 为原始文本去除 CR 后的 1-based、两端包含的行范围，不是搜索索引的扁平化 text。

`host.index.status({version:1,snapshotId})` 返回 `{snapshotId,valid,freshness,reason?}`。无效原因包括 SNAPSHOT_EXPIRED、SNAPSHOT_INVALIDATED、SOURCE_CHANGED；撤权由 RPC 返回 CAPABILITY_DENIED 错误。UI 应在 focus 与定时检查失败时撤下旧引文。UI 调用在 blocking pool 执行，不占 UI 线程。

status 是廉价元数据检查，不是原文字节证明：创建快照时比较索引的秒级 mtime/size，后续比较快照捕获时的纳秒 mtime/size。捕获前的同秒同长度编辑，以及人为恢复时间戳，无法仅凭 stat 判明。缓存正文/引文必须经过本次明确日期范围的 blocks SHA 验证；atlas 缓存仅用于标题、标签、链接布局，不能把 status current 当作原文已验证。

## 隐私字段与索引升级

schema 6 → 7 新增 files.confidentiality，沿用已有「派生索引可重建」迁移策略；旧索引在正常索引器打开时重建。GUI 未完成首建/重建返回 INDEX_NOT_READY。无 GUI watcher 的 CLI 插件只读打开已有兼容索引；缺失、版本不符或未完成构建返回 INDEX_NOT_READY，不因 atlas 浏览请求隐式扫描全 Vault。需要先通过常规索引入口完成构建。

只识别顶层明确 `confidentiality: confidential | explicitly_public | unknown` 和 `private: true`；后者对应 confidential。private:false 不等于公开，缺省为 unknown；不从 origin、type、标题、正文或 sensitivity 猜测。confidential 标记优先于冲突的公开标记。该字段是本次新增规则，旧索引在重建前不具备完整的隐私元数据。
