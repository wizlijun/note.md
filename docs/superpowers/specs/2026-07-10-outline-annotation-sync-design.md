# 大纲批注同步 + wikilink 句子化 设计

日期：2026-07-10
状态：已实现（feat/outline-annotation-sync）

## 需求（用户原话归纳）

1. 大纲同步 highlight/wikilink 的地方，增加同步批注（CriticMarkup）：先保留原文部分为节点，
   批注作为子节点；批注允许修改，修改后同步回主 md。
2. wikilink 只收一个词不合适：把所在句子（标点之间）整个作为节点同步。

## 行为

### derive（src/lib/outline/derive.ts）

- `{==原文==}{>>批注<<}`：AutoItem `source:'annotation'`，content = 原文，`note` = 批注。
- 插入点 `{>>批注<<}`：content = 所在句子（清理批注标记后），note = 批注。
- wikilink：content = 所在整句（保留 `[[…]]`；句内批注标记清理：点批注删除、包裹批注还原原文）；
  同句多个 wikilink 合并为一条。
- 句子边界：`。！？；.!?;`，`[[…]]`/批注/高亮标记内部的标点不切分；无标点取整行。
- 原有规则保留：高亮内容不变；高亮内部的 wikilink 不单独收录；包裹批注不再重复按高亮收录。

### 节点模型与 .note.md

- `NodeSource` 新增 `'annotation'`（原文节点，只读跟随文档）与 `'note'`（批注子节点，可编辑）。
- `.note.md` 落盘 `type:: annotation` / `type:: note`（parseOutline 白名单同步扩展）。
- sync：annotation 按（source+原文）做 LCS 配对；批注内容写入其唯一的 note 子节点
  （原地更新保 id；随父删除；不参与 LCS 也不走孤儿重挂）。手写子节点照旧保留。

### 批注编辑回写（src/lib/outline/note-writeback*.ts）

- 大纲 tab 中 note 子节点可编辑（Enter=提交退出；Backspace 不合并；结构命令无效）。
- 提交时以编辑起点内容为"旧批注"，定位主 md：先按 `{==原文==}{>>旧批注<<}`（anchorLine 提示
  消歧），失败再按插入点 `{>>旧批注<<}`（排除包裹批注的尾段）；替换为新批注（走 sanitize）。
- 主文档 tab 开着 → setContent（保 dirty/undo 语义）；没开 → plugin-fs 直接读写盘。
- 定位失败（主文档已改）→ toast 警告，批注保留在 .note.md，下次派生会与主 md 重新对齐。

## 决策

| 决策 | 结论 |
|---|---|
| 插入点批注的"原文" | 所在句子（与 wikilink 句子规则一致） |
| note 子节点在 LCS 中 | 不参与；由 annotation 父节点管理生命周期 |
| 原文节点编辑 | 只读（与 highlight 一致；改原文请在主文档改） |
| 回写失败 | 不回滚 .note.md，提示 + 依赖下次派生对齐 |
