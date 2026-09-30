# STRATA · 层峦

把 note.md Vault 的索引和有原文证据的知识，呈现为稳定的等高线与三维山体。顶部提供日期、视角与设置；其余区域用于地形，目录与证据按需展开。

## 运行前提

STRATA 0.1.1 要求 **note.md 6.930.2 或更新版本**，包含大 Vault 流式快照修复，使用 note.md 6.930.1 新增的 `host.index.*` v1 / `index.read`。manifest 的 `engines.notemd: >=6.930.2` 同时约束市场版本选择和安装；6.929.1 及更早宿主不具备这些接口。索引 schema 从 6 升至 7，首次运行沿用宿主现有索引重建流程；未就绪会显示 `INDEX_NOT_READY`，待正常索引完成后刷新。

首次打开只读取已授权索引元数据，在本地 Worker 中聚类、生成候选地形。使用「设置 → 从原文深读」明确选择 Agent、文档数与正文预算，才发送当前日期范围内的原文。深读需安装包含 `strata-extract-v1` 的配套 provider：Claude Agent 1.0.32、Codex Agent 1.0.19 或 DeepSeek Agent 1.1.18（及后续兼容版本）。界面仍检查实际任务与输入隔离能力；旧 provider 会禁用深读，本地候选浏览仍可用。

## 浏览与语义

- 文档日期包含起止两天；索引缺日期时的修改时间推定单独计数。切换日期不重新排列旧节点，不按当前最大值重标高。
- 「个人优先」强调个人独有知识的标签与峰顶；**个人独有与保密性分开**。索引仅采纳明确 `confidentiality: confidential | explicitly_public | unknown` / `private: true`，不会把本人创作当成私密，也不会把 `private: false` 当成公开。
- 默认深读排除明确私密材料；保密性未知材料仍属于所选范围，界面会展示数量。Agent 可能使用远程模型，发送前可核对提供方、范围和预算。
- 候选只代表标题/标签定位；「引文已核对」代表原始字节哈希与引用区间匹配，不代表外部事实验证。详情保留陈述者、条件、限制和引用，可打开真实源文件；行号供核对，宿主当前不提供准确行跳转。
- 点击山群或使用目录进入子峰；拖动旋转/平移，滚轮缩放；方向键、加减键与 0 也可导航。密集节点不会全部在概览分辨，需展开；目录可访问未显示标签的节点。
- 「停止后续批次」不声称撤销已提交给 provider 的远程任务。重启只恢复已知 run 的状态；启动回执不明时不自动重发。显式「放弃本次恢复」只解除本地等待。

## 实现

`backend/` 是异步 Rust NDJSON 插件进程，负责范围快照、内容去重预算、证据核验、原子缓存、任务恢复与回源。`src/lib/atlas.ts` 使用有界倒排候选图与多层社区划分；旧节点沿用布局。`terrain.ts` 按冻结来源组分配质量，使用确定性多尺度分形核与宽山脚；同一标量场供 D3 contours/Canvas 和 Three.js 网格使用。不同日期只是移除对应贡献；空范围严格为零。显式重排才改变地图 epoch。

前端为 Svelte 5，d3-contour 4.0.2 和 Three.js r160 随包离线构建；Worker 是同源独立 ES module，不需要 CDN、eval、blob Worker 或放宽宿主 CSP。布局缓存不保存引文与原文。每次浏览最多用 500 文件 / 16 MiB 的原文核对缓存引文；未完成本次证明的节点保留地图身份，但降为候选并收起引文，覆盖详情标记待核对数量。缩小日期后可以继续查看。缓存位于 Host 提供的插件 data_dir 内，按 Vault 隔离；源变更/排除/撤权后不展示失效引文。

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

本地开发安装沿用 `bash scripts/dev-install-plugin.sh strata`；需先运行 note.md 6.930.2 或更新宿主，不会自动更新正在运行的旧宿主。双架构签名打包用 `bash scripts/release-plugins.sh strata`，输出 `dist-plugins/notemd.strata/0.1.1/`，该脚本不上传。正式发布须先完成兼容宿主的公开发行，再沿用仓库既有流程发布目标插件；本文件中的版本要求与本地构建步骤不代表公网发布已经完成。

macOS 原生协议/GPU 验证：`node plugins-src/strata/scripts/check-webkit-worker.mjs`；独立交互窗口：`node plugins-src/strata/scripts/open-webkit-fixture.mjs`。两者均使用临时非持久 WebKit 与合成 RPC，不触碰宿主配置。

浏览器复验（**合成 fixture，没有真实 Vault/Agent**）：先 build，再 `node plugins-src/strata/scripts/preview-fixture.mjs`，打开 `http://127.0.0.1:8767`。服务使用与宿主相同的 self 脚本/连接限制，加载真实生产 UI、Worker 和 Three.js；fixture bridge 仅由验收服务器注入，不进入插件包。

32,000 节点基准：在插件目录执行 `node src/lib/terrain.benchmark.mjs report.json`。报告说明 CPU/内存测量范围；Node Worker 的测量不等价于 WebKit/GPU 或插件总内存保证。
