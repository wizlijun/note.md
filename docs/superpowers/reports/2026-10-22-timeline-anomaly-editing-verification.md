# Timeline 反常标签编辑验收

日期：2026-10-22。状态：源码修复已验证；本次没有发布市场包或提高 Timeline 版本号，已安装的 1.2.0 不因此自动获得此修复。

## 结果

父活动及各级子议题的“编辑”表单，在重要程度下方新增“反常标签”原生下拉，可设置反常、未发现反常、待判断。保存同步卡片/子议题标签；取消保持已保存值，磁盘失败保留草稿并可重试。旧宿主不暴露编辑表单。

反常与重要程度独立。明确改变状态时写入 `anomaly.origin: manual` 及手动理由，保留原有证据、未知元数据和来源，不捏造原文证据。详情说明手动标记，避免把无证据的人工判断描述成“有依据的反常”。未改状态字节不变；缺失状态保持待判断且不自动升级格式。原生成端无 manual 的 flagged 仍严格要求有效证据。

沿用既有 whole-document 保存协议与冲突控制，没有修改宿主或来源文件。补齐 YAML anchor/alias 双向隔离：编辑共享判断的父活动或子议题均不连带修改另一方。

## 验证证据

- RED：新增回归后 8 项失败，复现缺编辑入口、手动无证据被拒和旧格式无法持久化。额外 parent anchor 回归先失败，证明原共享对象确实会连带改变另一事件。
- GREEN：`pnpm --filter timeline test`，9 文件、279 项通过（原基线 265 项，本次新增 14 项，并扩展已有父子编辑、取消、失败保留、旧宿主用例）。覆盖手动状态枚举/来源严格校验、设置/撤销/待判断、legacy ID 升级、证据和未知字段保留、BOM/CRLF、原状态不自动转 manual、父子 alias 独立。
- `pnpm --filter timeline check`：0 错误、0 警告。
- `pnpm --filter timeline build`：成功，201 modules；`git diff --check`：通过。
- `scripts/check-timeline-importance-browser.mjs`：实际生产 bundle 在 Chromium 140.0.7339.16 通过全部 7 组验收，0 page errors。包含父卡片设置/取消/移除反常、保存后标签刷新、磁盘失败保持反常草稿并重试、legacy 子议题设置/回到待判断/重新打开保持、父卡片不被子议题误标、旧宿主只读及英文下拉三个选项。
- 明/暗主题 × 1100/390px 编辑表单字段均无横向越界；截图实际检查了重要程度下方的反常控件。窄屏详情沿用内部滚动区域，可滚到下方保存动作。

浏览器仅隔离宿主 RPC 与 file_view 消息，不读取真实 Vault；没有宣称原生 WebView 安装或线上发布已验证。沿用此前的分类、标签布局、来源与键盘验收。

证据保存在忽略目录 `tasks/timeline-anomaly-20261022/`：`red.log`、`alias-parent-red.log`、`tests.log`、`check.log`、`build.log`、`source-hashes.json`、`production-assets.json`，以及 `browser/report.json`、`browser/edit-{light,dark,narrow,narrow-dark}-anomaly.png`。

生产包文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `plugins-src/timeline/dist/assets/index-X5mIZ8SN.js` | `fd2f185acebbb5dad7471d183c551cd62460ced25c1a842e656263c4c8bb1faf` |
| `plugins-src/timeline/dist/assets/index-b47pUKgT.css` | `7cb68ee1a432de4dabd47537a5651bff9c0d26d212ce2a9606f9c9d2c5809b27` |
| `plugins-src/timeline/dist/index.html` | `f604fceef9d054b8160bf27bc3d438b8685bdded15a7a09c55b890476c62480e` |

## 兼容边界

`anomaly.origin: manual` 是插件文档契约扩展。旧查看器及尚未支持该字段的外部生成/筛选工具可能拒绝无原文证据的人工反常；本次不宣称外部工具兼容。生成判断的证据规则未放宽。最小宿主版本和现有编辑 capability 没有变化。
