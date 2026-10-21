# Timeline / 时间轴

将 `type: Timeline` 的 Markdown 显示为可查看的竖向日程。点击活动查看描述、子议题与来源；通过宿主顶部的视图分段控件切换 Timeline、Rich 与 Source。插件不可用或格式不支持时，宿主自动使用 Markdown 编辑器。

```markdown
---
type: Timeline
title: 2026-09-09 Timeline
description: 当日活动记录
---
# 2026-09-09 Timeline

以下时间范围来自活动记录，不代表连续投入时长。

- 09:00:00–10:30:00 — 开发：实现页面。 [来源](../notes/design.md#L10)
- 10:00:00–11:00:00 — 会议：讨论下一步。
  - 10:10:00–10:20:00 — 议题：确认交付范围。
- 12:00:00–12:00:00 — 阅读：读到一篇文章。
```

支持分钟/秒精度、零时长、重叠活动、嵌套子议题和空日。时间必须有效，结束不早于开始，可用 `24:00` 表示日末；不支持的条目整体退回 Markdown。标题、摘要和说明保留在“时间线说明”中。来源按钮打开当前 Vault 中对应文件；目前宿主来源接口不定位 `#L10` 等行号。

事件可通过行末 `<!-- event:e01 -->` 绑定 frontmatter 的 `event_metadata.e01`。查看器消费已保存的 `high`（重要）、`normal`（普通）、`unknown`（待判断），以独立色条和文字标签展示；`anomaly.status: flagged` 另显示“反常”，不会改变重要程度或活动分类。详情逐层显示理由、证据 ID/行号、已证实耗时、引用字数和本人关系；未判断的反常不称为正常，未知数值不补零。查看器不会扫描原文或自动打分；仅在用户明确保存编辑时改写当前 Timeline。

没有元数据和标记的旧文档继续显示，等级为待判断。声明元数据后，所有事件及子议题必须具有唯一、稳定的标记与对应条目；非法枚举、类型、证据、理由、数值或绑定会使整份视图回退 Markdown。代码块中的示例不作为真实事件。完整格式及约束见[事件重要程度规格](../../docs/superpowers/specs/2026-10-21-timeline-event-importance.md)和[合成示例](../../scripts/fixtures/timeline-importance.md)。状态标签与标题同行，时间和时长共用第二行，短事件保留 44px 点击区域；重叠较多时，日程区域允许横向滚动。生成端共享样例的已知差异见[验收记录](../../docs/superpowers/reports/2026-10-21-timeline-event-importance-verification.md)。

五大类固定为工作（蓝）、兴趣（绿）、生活（粉）、休闲（灰）、其他（白）。在“时间线设置”中修改规则名称、关键词和大类，并可新增、删除、调整顺序。仅匹配活动类别中包含的关键词，忽略大小写，按从上到下首条命中；不会使用描述正文做分类，未命中归其他。

打开时定位时间默认为 `09:00`，可在同一设置页中使用严格的 `HH:mm` 时间修改。每次打开时间线或切换日期后，日程会将该时间对齐到可视区域顶部；早于或晚于当日时间轴时会自动限定到可滚动范围。日期切换会直接替换当前页签中的文件。分类和定位时间作为一份设置保存到插件域，保存失败会保留整份草稿且不应用部分变更，也不会更改 Markdown。

## 编辑卡片

支持编辑的宿主中，打开活动或子议题详情，点击“编辑”，修改活动名称、事件描述、开始/结束时间及重要程度后保存。时间支持秒与 `24:00`，父子时间范围必须有效。取消不写文件，保存失败保留草稿；文件在编辑期间发生变化时拒绝覆盖，须取消并重新打开卡片。源码链接、事件 ID、未知 frontmatter 保留，未修改的文案保留 Markdown。

手动重要程度写入 `importance_origin: manual`，可以没有原文证据；详情明确标注手动设置，已有来源证据保留。旧文档首次改变重要程度时补齐事件 ID 和 unknown 元数据。外部生成/筛选工具需要支持此扩展，当前不宣称外部工具已更新。完整行为见[交互编辑规格](../../docs/superpowers/specs/2026-10-21-timeline-interactive-editing.md)。宿主通过 `file_view.open.capabilities.edit` 告知编辑支持；旧宿主仍可查看并提示升级。

## 开发

```sh
pnpm --filter timeline test
pnpm --filter timeline check
pnpm --filter timeline build
# 隔离浏览器验收（需已安装 Playwright）
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-timeline-browser.mjs
# 事件重要程度生产包、明暗/窄屏/键盘验收（隔离宿主 RPC，不读取 Vault）
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-timeline-importance-browser.mjs
# 对照外部生成工具，共享样例存在差异时退出 1；--select-only 可单独验收选材
python3 scripts/check-timeline-importance-contract.py --generator-script /path/to/vault-timeline/scripts/timeline.py
```

`scripts/dev-install-plugin.sh timeline` 安装本机开发包；`scripts/release-plugins.sh timeline` 构建并签名 universal 包，不自动上传。除自动匹配外，也可从「插件 → 回顾 → 查看时间轴」查看当前文件；没有打开文件时，宿主会先打开文件选择器。本插件最低宿主版本为 `6.1021.1`；旧宿主仍可在市场发现插件，但需要先升级宿主才能安装和加载。
