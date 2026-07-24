# 大纲 Zoom-in / Zoom-out 设计

**日期**: 2026-07-24
**状态**: 设计已确认,待实现
**参照**: hulunote 的 `:block-focus`(`src/cljs/hulunote/render.cljs`、`single_note.cljs`、`router.cljs`)

## 目标

把 Roam/Workflowy/hulunote 的 **zoom(聚焦到单个子树)** 能力迁移进 note.md 的大纲:
点某节点 bullet → 把该节点当作新的可见根,只显示它的子树;顶部面包屑列出祖先,可逐级或一键 zoom-out 回全文。

生效范围:**主大纲面板** + **每日日志**。仅内存(关窗/切文件即重置),无落盘、无 URL 路由。

## 术语与现状事实

- `OutlineNode`(`src/lib/outline/model.ts`)已有 `parentId: string | null`;`tree.nodes` 是 `Map<id, node>`,可 `tree.nodes.get(id)` 取节点。→ 面包屑靠 `parentId` 上溯即可,无需额外父映射。
- `OutlineEditor`(`src/components/outline/OutlineEditor.svelte`)的**唯一渲染入口**是 `visibleRoots`(`roots = childrenOf(outline.tree, null)`,再按搜索 `visibleIds` 过滤),对每个 root 渲染 `<OutlineNode depth={0} …>`。聚焦只需替换 `visibleRoots`。
- `OutlineNode` 的 bullet 当前 `onclick` 临时接的是"折叠",本设计改为发 **focus 事件**;折叠彻底交回 tri 三角。
- 每日日志(`src/daily-notes-app.svelte`)已有 `type View = feed | page` + `NavHistory<View>`(带前进/后退),`page` 视图用独立组件替换 feed。→ daily 的 focus 复用这套视图切换。

## 核心机制:OutlineEditor 做成"受控聚焦"组件

`OutlineEditor` 新增:

- prop `focusRootId: string | null`(**受控**,由宿主持有)
- 回调 `onFocusChange(id: string | null)`

渲染规则:

- `focusRootId == null` → `visibleRoots = childrenOf(tree, null)`(现状不变)
- `focusRootId != null` → `visibleRoots = [tree.nodes.get(focusRootId)]`(**含该节点本身**作为顶行,对齐 hulunote `include-root? = true`);其下正常渲染子树
- `focusRootId != null` 时,body 顶部渲染 **面包屑条**(见下)

事件流:

- `OutlineNode` 的 bullet `onclick` → 新增 `onFocus(node)` 回调,一路上抛到 `OutlineEditor` → `onFocusChange(node.id)`
- tri 三角继续只管 `collapsed`(不变)
- 折叠交互:聚焦态下,顶行(focus 根)自身的 tri 仍可折叠其子树

**为什么 bullet 只发事件、由宿主决定响应**:主大纲要"就地 zoom",daily 要"切聚焦视图"。同一个组件、两种宿主策略。

## 宿主接法

### ① 主大纲面板(就地 zoom)

宿主(挂 OutlineEditor 的那层)持 `let focusId = $state<string|null>(null)`:

```
<OutlineEditor focusRootId={focusId} onFocusChange={(id) => focusId = id} … />
```

面板内就地收窄。zoom-out 走面包屑 → `onFocusChange`。切文件时宿主重置 `focusId = null`。

### ② 每日日志(聚焦视图替换 feed,Roam block-focus 式)

- `View` 增加 `{ kind: 'focus'; date: string; nodeId: string }`
- feed 中任一天(只读日或活动日)点 bullet → `onFocus(node)` 冒泡到 `daily-notes-app` → `nav.push({ kind:'focus', date, nodeId })`
- focus 视图:用**一个聚焦编辑器**(该天的 note + `focusRootId=nodeId`)替换 feed,和现有 `page` 视图同样的替换模式
- zoom-out:
  - 面包屑祖先段 → `nav.push({ kind:'focus', date, nodeId: 祖先 })`(或直接改当前视图)
  - 面包屑最左"日期" → `nav.push({ kind:'feed', date })` 回该天 feed
  - `NavHistory` 后退键同样可退出聚焦
- 之所以不在 feed 里就地 zoom:feed 是多天连续流,就地收窄会让上下其他天仍在,语义混乱。

> 只读日点 bullet 直接进 focus 视图,无需先 activate 该天(focus 视图自带该天的聚焦编辑器)。

## 面包屑组件

新增 `OutlineBreadcrumb.svelte`(或内联进 OutlineEditor 顶部):

- 输入:`tree`、`focusRootId`、可选 `rootLabel`(主大纲=笔记名 / daily=日期)、`onCrumb(id|null)`
- 计算:从 `focusRootId` 沿 `parentId` 上溯到根,收集祖先;**渲染祖先(不含当前节点本身**,当前节点已作顶行,对齐 hulunote `butlast`)
- 渲染:`根Label › 祖先A › 祖先B`,每段可点;`根Label` → `onCrumb(null)`,祖先 → `onCrumb(祖先id)`
- 祖先文本取 `node.content` 的首行/截断(纯文本,去 markdown 标记),过长省略

## 边界与失效处理

- **聚焦节点被删/不存在**:`tree.nodes.get(focusRootId)` 为空 → 安全回退 `onFocusChange(null)`(主大纲)/ 弹回 feed(daily)
- **空子树**:聚焦叶子节点合法——顶行显示、无子节点;仍可编辑/加子节点
- **折叠态**:聚焦**不修改**任何节点的 `collapsed` 数据。但聚焦语义 = 看该子树,所以聚焦视图里 focus 根**按展开渲染**(即使它 `collapsed=true` 也显示其直接子节点);其内层子节点仍各自遵守自己的 `collapsed`。zoom-out 回去后,focus 根的原折叠态不受影响。实现:OutlineNode 的 `showChildren` 判断,对"当前 focus 根"这一行忽略 `collapsed`(通过一个 `forceExpand` 标志,仅作用于顶行)。
- **搜索 `visibleIds` 与聚焦并存**:聚焦优先;聚焦态下暂不叠加搜索过滤(YAGNI,后续可加)

## 不做(YAGNI)

- 不落盘、不记 per-file 聚焦位置、无 URL
- 无 zoom 动画
- 无键盘快捷键(后续可加 `outline.zoomIn`/`zoomOut` 命令)
- 聚焦态下不叠加搜索过滤

## 涉及文件(预估)

- `src/lib/outline/model.ts` — 或加一个 `ancestorsOf(tree, id)` 辅助(纯函数,可测)
- `src/components/outline/OutlineNode.svelte` — bullet `onclick` 改发 `onFocus`;透传 `onFocus`
- `src/components/outline/OutlineEditor.svelte` — `focusRootId` prop、`onFocusChange`、`visibleRoots` 分支、顶部面包屑
- `src/components/outline/OutlineBreadcrumb.svelte` — 新增
- 主大纲面板宿主 — 持 `focusId`、切文件重置
- `src/daily-notes-app.svelte` — `View` 加 `focus`、视图分支、`onFocus` → push
- `src/components/daily/DailyDay.svelte` / `DailyFeed.svelte` — 冒泡 `onFocus`;新增 daily focus 视图组件(复用 OutlineEditor)

## 测试

- 纯函数 `ancestorsOf`:链路、根、不存在 id、循环保护
- 面包屑渲染:祖先数量正确(不含自身)、点击回调 id 正确、根 label → null
- OutlineEditor:`focusRootId` 切换时 `visibleRoots` 正确;失效 id 回退
- daily:点 bullet → focus 视图;面包屑/后退回退路径
