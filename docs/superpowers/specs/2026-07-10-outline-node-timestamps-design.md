# 大纲节点创建/修改时间戳

日期:2026-07-10

## 目标

大纲笔记中,高亮(highlight)与手写(manual)节点记录创建时间;内容被修改时记录修改时间。自动补全的 TOC 节点不记录任何时间。时间仅持久化到伴生 md 文件,UI 不显示。

## 数据模型(model.ts)

- `OutlineNode` 新增可选字段:
  - `createdAt?: string` — ISO 8601(`new Date().toISOString()`)
  - `updatedAt?: string` — ISO 8601
- 新增辅助函数 `setNodeContent(node, content)`:内容不变时无副作用;变化时赋值,且当 `node.source !== 'toc'` 时刷新 `updatedAt`。

## 写入时机

- **创建**:
  - `commands.ts` 的 `createSiblingBelow` / `createSiblingAbove`(manual 节点)→ `createdAt`
  - `sync.ts` 中 LCS 未匹配而新建的 `highlight` 节点 → `createdAt`;`toc` 节点不写
  - 匹配保留的节点不改 `createdAt`(保留首次加入时间);存量无时间戳节点不回填
- **修改**:所有内容赋值点改用 `setNodeContent`:
  - `commands.ts` `mergeWithPrevious`(prev.content 拼接)
  - `sync.ts` 匹配节点的 `node.content = it.content`(LCS 按内容匹配,实际几乎不变,防御性统一)
  - `OutlineNode.svelte` 各 `node.content =` 赋值点、`OutlinePanel.svelte` `applyToTextarea`

## 持久化(markdown.ts)

- 属性行新增 `created:: <ISO>` 与 `updated:: <ISO>`,写在 `type::`/`line::` 之后、`id::` 之前
- 序列化:字段存在即写(toc 节点因从不赋值自然不写)
- 解析:`PROP_RE` 扩展 `created|updated`,读回对应字段

## 测试

- model:`setNodeContent` 变/不变、toc 不打时间戳
- commands:新建 manual 节点有 `createdAt`
- sync:新高亮有 `createdAt`、toc 无、匹配节点保留原 `createdAt`
- markdown:`created::`/`updated::` 序列化与解析往返
