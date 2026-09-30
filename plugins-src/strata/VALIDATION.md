# STRATA 0.1.0 / note.md 6.930.1 发布验收

本次发布组合为 note.md 6.930.1、STRATA 0.1.0、Claude Agent 1.0.32、Codex Agent 1.0.19 和 DeepSeek Agent 1.1.18。STRATA 的最低宿主版本为 6.930.1；应先验证该宿主已公开可下载，再发布依赖它的市场版本。

下列结果记录实现阶段已执行的验收，保留各项测量范围。隔离发布 checkout 的重新构建、公证、签名和公网回读应另记录最终版本、提交与文件哈希；本记录不把发布计划视为已上线，也未拿用户真实 Vault 向云模型试发。

## 实现阶段已执行

| 范围 | 结果与证据 |
| --- | --- |
| searchidx | 326 个测试通过：统一优先级、日期、隐私字段、元数据与范围单元 |
| plugin-protocol | 38 个测试通过；Schema/TS 重新生成前后逐字节一致 |
| 宿主 | `cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features`：1,088 个通过；涵盖真实临时 Vault/SQLite、范围、SHA、分页、失效和双 RPC 授权 |
| STRATA 后端 | Rust 3 个测试、严格 Clippy、真实 NDJSON 子进程 10 个流程通过；包括未确认启动期间立即停止、恢复不重发、待证明旧知识回源 |
| Provider | Claude 117、Codex 82、DeepSeek 131 个通过；agent-run-core task 专项 16 个通过。使用 fake CLI/ACP 检查 STRATA 任务与输入隔离 |
| 前端 | Svelte 检查 0 错误/0 警告；Vitest 27 个通过，另 1 个手动基准默认跳过。涵盖反向日期、晚到响应、撤权收起旧内容、无自动 AI、Worker 不收引文、回源失败不打开文件 |
| 地形 | 40/40 子项邻近独立峰及独占闭合轮廓；同输入确定性、空范围零场、扩大日期高度单调、来源质量守恒、粗细网格与 tile 积分一致、宽坡连续、中文完整名称 |
| 生产构建 | 本地 ES module Worker、D3 和 Three.js 随包；无远程脚本、无 blob Worker。Safari 加载生产 bundle 与合成 RPC 成功 |
| WebKit 自定义协议 | 独立非持久 WKWebView，实际 `plugin://notemd.strata` + 生产 bridge/CSP：Worker build/render/empty 三轮、日期子集单调和空场通过；真实 WebGL 6 次日期/空场切换与同 canvas renderer 重建通过。可运行 `node scripts/check-webkit-worker.mjs` 复验 |
| 市场与仓库 | 市场 UI 12 测试通过；宿主默认配置 `cargo check --locked` 通过；仓库 Svelte 0 错误，原有 33 警告位于 16 个非本次组件；shell 语法和 diff 空白检查通过 |

`pnpm check:protocol` 现有实现用 `git diff HEAD` 判断是否一致，所以未提交的新协议会返回非零；已另行记录再生成前后的哈希完全一致，没有为了通过检查暂存或提交工作区。

原生生产 UI 人工检查：三维子峰/二维切换、全景恢复、近 7 天从 40 项变为 7 项、目录搜索、候选与引文详情已观察；中文名称完整，山脚阶梯问题已修。验收过程中发现的 WebGL 释放问题已修复并由真实 GPU 回归补验。

## 性能实测

当前报告是 [terrain.benchmark-report.json](src/lib/terrain.benchmark-report.json)，通过实际 module Worker 入口 + Node worker_threads 适配测量，并包含传递结果的开销。32,000 个节点、768×512、概览固定轮廓子集，暖往返 p95 约 194 ms，观测 Worker heap+external 约 98.3 MiB。测量环境为 Apple Silicon/macOS、Node v23.10.0。

这是 Node Worker 观测值，不是 WebKit/GPU 真实帧率或插件总内存上限。初次聚类比暖筛选慢，32k 概览不能分辨每个子峰；近景重新采样同一连续地形。总增量 ≤256 MiB 尚未证明。相机路径已缓存全量节点筛选/排序/标签聚合，只投影有界标记与标签；jsdom 检查确认连续30帧不重复全量计算，不将该 stub 计时作为真实 FPS。

## 设计落地的明确边界

- 优先级沿用既有索引策略；具体数值因当天 asOf、来源配置和规范知识集合而版本化。固定同组版本内，日期只做贡献掩码；新抽取替换候选、索引配置变化或知识集合变化时，预算版本可以改变。
- 地形为程序化分形山体，不是水文侵蚀模拟，也不是地理测量。二维与三维使用同一连续密度的网格面积平均值，采用固定对数高程。
- 第一版 Agent 协议采用专用紧凑 schema，保留证据、陈述者、条件、限制、独有性与保密性；未直接串接完整 KnowledgeDataset 3.1 写回链路，详见 [后端说明](backend/implementation-notes.md)。
- 每次页面缓存证明限 500 文件 / 16 MiB。超预算保留节点位置与身份、降为候选并隐藏引文；真 SHA 冲突撤去缓存。status 的 stat 检查不能替代 SHA。
- 三家真实云模型抽取质量、真实用户全量 Vault 的运行时间、完整 Tauri 本体端到端使用尚未作为已测结论。独立 WebKit 验证加载/Worker/CSP，Rust 真实 SQLite fixture 验证宿主接口，真实插件子进程验收后台协议；分别说明，不互相冒充。
- note.md 6.929.1 及更早版本缺少新索引 API；STRATA 安装包和市场索引均须声明 `>=6.930.1`。本地候选浏览不要求 Agent；原文深读要求配套 provider 实际报告任务与输入隔离能力。

## 发布包核验

`bash scripts/release-plugins.sh strata` 在 `dist-plugins/notemd.strata/0.1.0/` 生成 ARM64 / Intel `.notemdpkg`、各自 minisign 签名及 manifest。包内只应包含生产 manifest/bin/ui 和第三方许可证，不包含合成 RPC、测试脚本或用户数据。

实现阶段的双架构开发包已通过 minisign/codesign 与 UI 逐字节核对，ARM 包内实际二进制通过 10 项协议验收；Intel 未在本机执行。开发包采用旧宿主门槛，其哈希不能作为本次正式发布凭据。更新最低宿主版本后必须重新打包、签名并核对包内 manifest、UI 与实际二进制。

市场发布沿用仓库 Wrangler 3 + Account API Token：上传 R2 包与签名 → 匿名公网逐字节回读并验签 → 合并现有索引、校验目标版本及 `min_host` → 写入 KV `INDEX` 的 `index` → 不加查询参数回读公开索引。非本次插件的历史包、哈希与版本条目应保持不变；以 6.930.1 验证 STRATA 可选，并确认旧宿主不会获得不可用版本。
