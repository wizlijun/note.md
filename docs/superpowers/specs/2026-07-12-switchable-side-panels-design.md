# 可切换的左右侧视图布局 — 设计文档

日期:2026-07-12

## 背景

主界面 `.pane`(`src/App.svelte`)是一个横向 flex 容器:

```
FolderView(左) | EditorPane(中) | OutlinePanel / HistoryPanel(右)
```

现状问题:

- **左侧**只有 `FolderView`,由 `folderView.{enabled,visible,width}` gate 控制,写死在 `App.svelte` 的 `{#if}` 里,没有扩展位。
- **右侧**有 `OutlinePanel` 和 `HistoryPanel` 两个面板,各自独立 gate(`outline.*` / `history.*`),靠 `dispatchPlugin` 里手写的互斥逻辑保证同时只显示一个。
- 每加一个新视图,都要改 `App.svelte` 的 `{#if}` 分支 + `dispatchPlugin` 的 `if` 链 + 新写一套 gate。没有任何注册表/抽象。

目标:把左右两侧都做成**可切换、可扩展**的结构。以后加一个侧边视图 = 注册一条,不再动 `App.svelte`。

## 交互范式(已定)

**面板顶部 Tab**。每侧面板顶部放一小排 tab 切换该侧视图;整侧的显隐仍走菜单/快捷键。不引入 VSCode 式的最外缘图标栏(Activity Bar)。

补充决策:

- **≤1 个可用视图时隐藏 tab 栏**,面板内容占满(与现观感一致);≥2 个才出现 tab 栏。
- **active 视图对当前文件不适用时自动回退**到同侧另一个适用视图;都不适用才整侧隐藏。
- **宽度每侧共享**:右侧是一个容器,outline 与 history 共用一个宽度(而非各记各的)。VSCode 同侧共享宽度的标准做法。

## 架构:三层抽象

把"视图硬编码挂在 `.pane`"换成 注册表 → 每侧容器 → 每侧状态。

### ① SideView 注册项

描述一个可挂载的侧边视图。

```ts
interface SideView {
  id: string                          // 'folder-view' | 'outline-notes' | 'git-history' | 未来
  side: 'left' | 'right'
  title: () => string                 // tab 标签(走 i18n,函数以便语言切换即时更新)
  order: number                       // 同侧 tab 排序
  isAvailable: () => boolean          // 插件是否启用 → 读现有 gate.enabled
  appliesTo: (tab: Tab | null) => boolean  // 对当前文件是否适用(默认恒 true)
  component: () => Promise<Component>  // 懒加载内容组件(沿用现在的动态 import)
}
```

新增 `src/lib/side-panel/registry.svelte.ts`:

- 维护一个 `SideView[]`,提供 `registerSideView(v)`。
- 提供派生选择器(见"显示/回退规则")。
- 三个现有视图开局各注册一条:
  - `folder-view` → side `left`,`isAvailable = () => folderView.enabled`,`appliesTo` 恒 true,`component` = `FolderView`。
  - `outline-notes` → side `right`,`isAvailable = () => outlineGate.enabled`,`appliesTo = tab => !(tab && isOutlineNoteTab(tab))`,`component` = `OutlinePanel` 内容。
  - `git-history` → side `right`,`isAvailable = () => historyGate.enabled`,`appliesTo = tab => tab != null && historyAppliesTo(tab, sotvaultStore.vaultRoot)`,`component` = `HistoryPanel` 内容。

### ② 每侧状态

取代散落的 `outline.visible` / `history.visible` / `folderView.visible/width`。

```ts
interface SidePanelState { visible: boolean; activeId: string | null; width: number }
sidePanels = $state<{ left: SidePanelState; right: SidePanelState }>({ ... })
```

新增 `src/lib/side-panel/state.svelte.ts`:

- 持久化到 `settings.json`,key:`sidebar.left.{visible,activeId,width}`、`sidebar.right.{visible,activeId,width}`。
- 每侧的 width min/max 取该侧所有视图 min/max 的并集(左侧沿用 folder 的 160–480;右侧沿用 outline/history 的 240–640)。
- setter:`setSideVisible(side, v)`、`setActiveView(side, id)`、`setSideWidthLive(side, w)`(拖拽中,仅改 state)、`setSideWidth(side, w)`(落盘)。

### ③ SidePanel 容器组件

左右各一个实例。新增 `src/components/side-panel/SidePanel.svelte`。

`App.svelte` 的 `.pane` 变成:

```svelte
<section class="pane">
  <SidePanel side="left" {current} />
  {#if current}<EditorPane tab={current} />{:else}<EmptyState />{/if}
  <SidePanel side="right" {current} />
</section>
```

容器负责:

- 宽度(读 `sidePanels[side].width`)+ 拖拽把手(左侧把手在右缘,右侧把手在左缘)。
- 顶部 tab 栏(仅当 `shownViews.length >= 2` 时渲染)。
- 渲染当前 `activeView` 的内容组件(懒加载,沿用 `{#await import()}`)。
- 面板 header 保留 Hide 按钮(整侧隐藏)。
- 整侧不可见(`effectiveVisible === false`)时不渲染任何东西(不占位)。

## 显示/回退规则(纯派生,一处定义)

全部收敛到 registry 的派生里,`App.svelte` 不再散落这些条件:

```ts
shownViews(side) =
  registry.filter(v => v.side === side && v.isAvailable() && v.appliesTo(current))
          .sort(byOrder)

effectiveVisible(side) = sidePanels[side].visible && shownViews(side).length > 0

activeView(side) =
  shownViews(side).find(v => v.id === sidePanels[side].activeId) ?? shownViews(side)[0]  // 自动回退

showTabBar(side) = effectiveVisible(side) && shownViews(side).length >= 2
```

- History 遇非 vault 文件、Outline 遇 `.note.md` 全屏大纲 → 从 `shownViews` 掉出 → `activeView` 自动回退到同侧另一个适用视图;都不适用则 `effectiveVisible === false`,整侧隐藏。
- `iOS` 平台:左右两侧容器整体不渲染(沿用现有 `platformName !== 'ios'` 前置条件,放进 `effectiveVisible` 或容器顶层)。

## 切换语义(菜单/快捷键 toggle,泛化现有互斥)

```
toggleView(id):
  side = registry.get(id).side
  if !sidePanels[side].visible        → setSideVisible(side, true); setActiveView(side, id)
  else if activeId === id             → setSideVisible(side, false)        // 再点当前 = 收起
  else                                → setActiveView(side, id)            // 切 tab,保持显示
```

- 泛化了现在的"打开 outline 强制隐藏 history":history 开着时触发 outline → 切到 outline tab、整侧保持显示,净效果与旧行为一致。
- 左侧只有 folder 时,`toggleView('folder-view')` 退化为纯显隐。
- tab 点击 = `setActiveView(side, id)`,只切换不收起。

## 组件改造与迁移

### 新增

- `src/lib/side-panel/registry.svelte.ts` — SideView 注册表 + 派生选择器。
- `src/lib/side-panel/state.svelte.ts` — 每侧状态 + 持久化 + 迁移。
- `src/components/side-panel/SidePanel.svelte` — 通用容器(tab 栏 + resize 把手 + 内容渲染 + Hide)。tab 栏可内联,或拆 `SideTabBar.svelte`(视复杂度定,实现时决定)。

### 改造(降级为"内容组件")

`FolderView` / `OutlinePanel` / `HistoryPanel` 剥掉各自的**外壳**:

- 移除:自身的宽度绑定、resize 把手、整侧显隐判断(上移到容器/派生)。
- 保留:各自的工具条(Outline 的 Edit Note、History 的 Refresh、Folder 的搜索框)放在内容组件顶部,位于 tab 栏之下。
- 结果:它们成为挂在 `SidePanel` 里的纯内容组件,不再感知宽度和显隐。

### 保留

- 三个 `gate.svelte.ts`(`outline` / `git-history` / `folder-view`)继续负责 `enabled` 和视图专属配置(如 outline 的快捷键 overrides)。
- 只把 `visible / width / active` 从 gate 上移到每侧状态;gate 里对应字段与 setter 删除,消费方改读每侧状态。

### 简化

- `dispatchPlugin` 里 `folder-view` / `outline-notes` / `git-history` 三段硬编码 toggle → 统一 `toggleView(viewId)`(pluginId 与 viewId 一一对应,直接用 pluginId 查 registry)。

### 迁移(一次性,加载时)

首次加载若新 key 不存在,则从旧 key 推导后写入新 key:

- `folderView.visible / folderView.width` → `sidebar.left.visible / sidebar.left.width`,`sidebar.left.activeId = 'folder-view'`。
- 右侧:`sidebar.right.visible = outline.visible || history.visible`;`activeId = outline.visible ? 'outline-notes' : history.visible ? 'git-history' : null`;`sidebar.right.width` = 二者中已设的那个(优先 active 的),否则默认 360。
- 旧 key 保留读取兜底,不主动删除(避免回滚数据丢失)。

## 未来扩展方式(本设计交付的"规则")

加一个新侧边视图,只需:

1. 写内容组件(纯内容,不管宽度/显隐)。
2. 在其插件/模块里 `registerSideView({ id, side, title, order, isAvailable, appliesTo, component })`。
3. (可选)在菜单里加一条走 `toggleView(id)` 的命令 + 快捷键。

不改 `App.svelte`、不改 `SidePanel`、不改派生规则。

## 测试

- 派生规则(`shownViews` / `activeView` 回退 / `showTabBar`)是纯函数,单测覆盖:
  - 单视图侧不出 tab 栏;双视图侧出 tab 栏。
  - active 不适用 → 回退到另一个;都不适用 → 整侧隐藏。
  - `toggleView` 三种分支。
- 迁移逻辑:给定旧 key 组合,断言产出的新 key。
- GUI 实机验证(dev 构建,遵循项目既有 GUI 验证流程):左右切换 tab、拖拽宽度、切文件触发回退、菜单/快捷键 toggle、重启后状态恢复。

## 非目标(YAGNI)

- 不做 Activity Bar 图标栏。
- 不做同侧多视图同时堆叠(始终一个 active)。
- 不做视图拖拽换侧 / 用户自定义顺序。
- 不做第三方插件动态注册侧边视图的公开 API(仅内部 registry;未来需要再抽)。
