# Timeline / 时间轴

将 `type: Timeline` 的 Markdown 显示为可查看的竖向日程。点击活动查看描述、子议题与来源；点击“编辑 Markdown”修改原文。插件不可用或格式不支持时，宿主自动使用 Markdown 编辑器。

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

五大类固定为工作（蓝）、兴趣（绿）、生活（粉）、休闲（灰）、其他（白）。在“分类设置”中修改规则名称、关键词和大类，并可新增、删除、调整顺序。仅匹配活动类别中包含的关键词，忽略大小写，按从上到下首条命中；不会使用描述正文做分类，未命中归其他。设置保存到插件域，不更改 Markdown。

## 开发

```sh
pnpm --filter timeline test
pnpm --filter timeline check
pnpm --filter timeline build
# 隔离浏览器验收（需已安装 Playwright）
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-timeline-browser.mjs
```

`scripts/dev-install-plugin.sh timeline` 安装本机开发包；`scripts/release-plugins.sh timeline` 构建并签名 universal 包，不自动上传。除自动匹配外，也可从「插件 → 回顾 → 查看时间轴」查看当前文件；没有打开文件时，宿主会先打开文件选择器。本插件最低宿主版本为 `6.909.2`；旧宿主仍可在市场发现插件，但需要先升级宿主才能安装和加载。
