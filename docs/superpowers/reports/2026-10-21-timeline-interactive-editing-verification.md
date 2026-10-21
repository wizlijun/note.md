# Timeline 交互编辑验收

日期：2026-10-21。实现范围见[交互编辑规格](../specs/2026-10-21-timeline-interactive-editing.md)。本次仅实现、验证和提交；未安装用户插件、未发布宿主或插件、未修改用户 Vault。

## 实现结果

- 活动和各级子议题详情提供编辑入口：活动名称、事件描述、秒级开始/结束时间、重要程度下拉、保存和取消。名称直接显示在卡片，分类规则仍决定分类。
- 单次文档补丁保留来源链接、稳定 ID、无关正文/frontmatter、BOM/换行风格。时间范围及父子包含关系通过完整重解析验证。
- 手动重要程度显式记录 `importance_origin: manual`，不制造原文证据，不重算已证实耗时、来源字数或反常判断；旧文档首次修改等级时升级全部真实事件的稳定绑定。
- 宿主通过显式 `editor.write` 权限提供快照保存协议，校验来源、身份、只读、外部冲突和磁盘基线，使用既有文档 owner 和 Markdown FIFO 保存。拒绝时不覆盖；磁盘失败保留 dirty 内容供重试。
- 编辑草稿不会被同文件的新快照覆盖；活动删除、权限撤销及保存失败均可保留草稿，取消后同步最新文档。跨文件旧回执不影响新编辑状态。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Timeline 全量 Vitest | 9 文件，265 项通过 |
| 其中源码编辑回归 | 43 项：保真、迁移、链接、层级范围、格式及 manual 校验 |
| 其中详情组件回归 | 9 项：父/子编辑、失败、取消、busy、卸载、权限撤销 |
| 宿主定向 Vitest | 3 文件，164 项通过，包含 FilePluginView 协议及 tabs 保存准入 |
| 真文档 owner | FileController 接受/拒绝、undo/redo、持久化 source hash 均通过；文件 IO 为测试桩 |
| 插件 svelte-check | 0 errors / 0 warnings |
| 根 svelte-check | 0 errors / 31 既有 warnings（15 文件） |
| 宿主生产构建 | `pnpm build` 退出 0，含分享编辑器和包边界检查 |
| 插件生产构建 | 浏览器验收脚本内正式 Vite build 通过 |
| 浏览器 | Chromium 140.0.7339.16，页面运行时错误 0 |

浏览器使用真实生产插件和 iframe 消息，隔离宿主 RPC/保存回执，不代表原生安装包或真实 Vault 写入验收。已实际检查浅色、深色和 390px 截图；表单字段不横向溢出，窄屏详情可滚动到保存按钮。验证五字段修改、失败保留草稿、基于宿主 dirty 快照重试、保存后的卡片文字/时间/重要程度刷新、Escape 取消；既有短卡片、重叠、英文、来源和格式回退验收保持通过。

日志/截图在本地忽略目录 `tasks/timeline-editing-20261021/`。可复跑：

```sh
pnpm --filter timeline test
pnpm --filter timeline check
pnpm test src/components/FilePluginView.test.ts src/lib/plugins/v2/file-view-msg.test.ts src/lib/tabs.test.ts
pnpm build
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-timeline-importance-browser.mjs
```

## 实际边界

活动名称和描述为单行文字；显式改文案时把用户输入转义为纯文本，跨字段 Markdown 包装可能规范化，元数据节点内部格式可能经 YAML AST 整理。未编辑的区域和来源链接保留。

新手动判断契约需消费者支持。旧外部生成/筛选工具可能拒绝没有证据的手动 high/normal；本次未改外部 Vault 工具，也未宣称其兼容。旧宿主没有编辑协议时仍可查看，详情提示需要支持该功能的新版 note.md。此次代码提交不证明已经进入市场安装包。
