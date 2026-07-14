# 伴生笔记「按意图保存」策略设计

日期：2026-07-14
分支：feat/outline-code-wikilink-clickable（或后续新分支）
相关记忆：[[project_principle_relationships_confirmed]]、[[reference_sidecar_notes_naming]]、[[file_over_app]]、[[project_outline_store_singleton_wipe_guard]]

## 背景与问题

当前伴生笔记（`.note.md`，内部 id `outline-notes`）在 **panel 模式**下会"浏览即自动生成"：

- 右侧大纲面板可见时，主文档一被编辑，`OutlineEditor.svelte` 的同步 `$effect`（约 line 145-161）会 `syncAutoItems(...)` 派生标题/高亮/wikilink → `markDirty()` → 全局 sink → `persistToDisk`（line 131，500ms 防抖写盘）。
- 结果：只要面板开着、主文档里有可派生结构，磁盘上就凭空多出一个 `.note.md`，用户从未表达"要写笔记"的意愿。

产品诉求（用户原话归纳）：

> note.md 的自动生成要很谨慎，**默认不自动生成**。只有用户有主动意愿写笔记时才创建和保存。打开大纲视图 = 有写笔记的意图；没打开就不该自动创建。主文档被编辑时，高亮/注释/wikilink 的同步**可以进内存但不自动保存**，需要用户确认。确认动作有两个：① 大纲工具栏上的保存按钮；② 用户在任意大纲节点里输入（激活自动保存）。保存按钮的状态本身要有指示性作用。

额外风险（用户补充）：git 在多端持续同步 `.md`，编辑期间远端更新可能与本地 in-memory 编辑冲突、互相覆盖。

## 目标

1. 默认不再"浏览即自动生成" `.note.md`；文件只在用户表达意图后才落盘。
2. 主文档编辑 → 同步只进内存 + 置"未保存"，不自动写盘。
3. 两种保存确认：保存按钮（一次性写盘并激活）、节点输入（激活自动保存）。
4. 工具栏保存按钮状态即脏标记指示器（脏=高亮+小圆点，净=灰显禁用）。
5. panel 模式 `.note.md` 写盘前做冲突校验，绝不盲目覆盖被远端改过的文件。

非目标（本次不做）：panel 模式 `.note.md` 的实时文件监听/自动重载（远端变更主动推入干净面板）——见"已决策/权衡"。历史数据迁移。

## 核心模型：笔记状态 + 自动保存「激活」开关

在 outline 单例 store（`store.svelte.ts`）上新增两个 `$state`：

- **`dirty: boolean`** —— 相对上次落盘是否有未保存变更。驱动保存按钮指示态。
- **`armed: boolean`** —— 自动保存是否已激活。决定 sink 是否真的写盘。

`attachDoc` 时重置：

```
dirty = false
armed = noteTextHasContent(初始笔记文本)   // 磁盘已有内容 → 视为“活跃笔记”，自动保存照旧
```

判定表：

| 场景 | 初始 `armed` | 行为 |
|---|---|---|
| 磁盘上 `.note.md` 已存在且有内容 | `true` | 同步/编辑照常自动保存（"已有笔记即活跃"） |
| 无文件 / 文件为空 | `false` | 手动确认模式：同步只置脏、不写盘 |

`armed` 由 `false → true` 的触发（= 用户主动意愿）：

1. 在任意节点里输入或结构编辑（打字、缩进/反缩进、删除、拖拽、slash 命令、加链接、pin ref、regenerate 等一切用户发起的树变更）；
2. 点保存按钮（一次性写盘并激活）。

**同步 `syncAutoItems` 永远不 arm** —— 这是唯一的非用户来源变更。

## 详细改动

### 1. store（`src/lib/outline/store.svelte.ts`）

- 新增 `outline.dirty`、`outline.armed`（`$state`），并在 `attachDoc` 尾部按上表初始化。
- 拆分两个信号：
  - `markDirty()`（用户编辑）：`dirty = true; armed = true;` 然后调 `changeSink`。
  - `markSynced()`（同步派生）：`dirty = true;` **仅当 `armed`** 才调 `changeSink`；未激活时不落盘。
- 新增 `markSaved()`：落盘成功后 `dirty = false`（写盘点回调）。
- 新增冲突态字段（见 §5）：`outline.externalConflict: { diskText: string } | null`、`outline.noteDiskHash: string | null`。

保持不变：现有 `wouldWipe` / `noteTextHasContent` / 空树守卫等数据丢失防线全部保留（[[project_outline_store_singleton_wipe_guard]]）。

### 2. OutlineEditor（`src/components/outline/OutlineEditor.svelte`）

- **关键一刀**：同步 `$effect`（约 line 157）里，把 `bump(); markDirty()` 改为 `bump(); markSynced()`。这样"浏览/主文档编辑触发的派生"不再自动写盘。
- 其余所有 `markDirty()` 调用点保持不变（`applyToTextarea` 490、缩进/反缩进 442、删除 434/574、拖拽 267、pin ref 569、regenerate 等）——它们天然充当"激活"动作。
- panel-disk 分支的 sink（line 131）：`persistToDisk` 只在 `outline.armed` 且无冲突时执行；`flushDisk` 写盘成功后调 `markSaved()` 并更新 `noteDiskHash`（见 §5）。
- tab 路由分支（`persistTab` 存在，line 119-126）保持不变：sink 只写 `tab.currentContent`（置 tab 脏），磁盘写入本就只发生在 tab 保存时，天然满足"手动确认"，不需要 armed 逻辑。

### 3. 工具栏保存按钮（`OutlineEditor.svelte` toolbar，line 585-600）

- 在搜索/重新生成按钮旁新增保存按钮（软盘图标）。
- **显示态**：`persistTab ? isTabDirty(persistTab) : outline.dirty`。
  - 脏：按钮高亮 + 右上角小圆点。
  - 净（已保存 / 无内容）：灰显 `disabled`。
- **点击动作**：
  - 有 `persistTab` → 触发该 tab 的保存（复用 `saveActive`/tab 保存路径）。
  - 否则（panel-disk）→ 立即 `flushDisk()`（首次会创建文件）+ 置 `armed = true`。
- i18n：新增 `outline.save` 键，补齐所有已注册语言（en/zh/de/… 见 [[reference_i18n_system]]）。样例文档/keywords 不译。

### 4. 惰性创建文件

- **panel 模式**：`persistToDisk`/`flushDisk` 只在 `armed` 后才写；未激活时磁盘上不出现 `.note.md`。保留 `flushDisk` 现有的空文本守卫（line 57）。
- **铅笔"编辑笔记"**（`OutlinePanel.svelte:18-22`）：去掉 `ensureOutlineFile` 的预创建。
  - **目标行为**：点铅笔打开一个绑定到伴生路径、但磁盘上尚无文件的**未保存大纲 tab**；文件在首次保存/节点输入时才落盘。
  - **实现风险**：`openFile`（`tabs.svelte.ts:137`）要求文件已存在才能读；`newFile` 走空 filePath + 保存弹框的未命名路子。需要新增一个小 helper（例如 `openNewOutlineTab(path)`）：push 一个 `filePath=companionPath`、`initialContent=''`、`currentContent=newOutlineFileText(title)`、`externalState='fresh'` 的 tab；`startWatchingTab` 需**延迟到文件首次存在后**再挂（对不存在路径直接 `watchImmediate` 可能报错），可在首次成功保存（`recordOurWrite` 之后）补挂 watcher。
  - **兜底方案**（若上述接线被证明脆弱/回归面大）：铅笔在笔记文件尚不存在时 `disabled`；用户通过在面板内编辑来"开始"这份笔记（面板首次保存即创建文件），文件出现后铅笔才可点开为独立 tab。此兜底同样满足"惰性、不预建空文件"，且零 tab 系统改动。计划阶段二选一。

### 5. panel 模式 `.note.md` 冲突防护（写盘前校验，轻量）

不引入新的文件监听器。只在 panel-disk 的写盘点做一次校验：

- 状态：`outline.noteDiskHash: string | null`（我们上次加载/写入 `.note.md` 时的 sha256；`null` 表示"我们认为磁盘上还没有此文件"）。
  - `attachDoc` 读到磁盘文本时：`noteDiskHash = sha256(diskText)`（无文件则 `null`）。
- `flushDisk` 真正写盘前：
  1. 读当前磁盘状态。
  2. 若文件存在：`h = sha256(disk)`。
     - `noteDiskHash != null && h === noteDiskHash` → 磁盘未变，正常写；写后 `noteDiskHash = sha256(written)`、`markSaved()`。
     - `h !== noteDiskHash`（含 `noteDiskHash == null` 但文件已存在的情形）→ 说明远端在我们不知情时改/建了文件：
       - 若我们的序列化文本与磁盘文本相同 → 无需写，更新 `noteDiskHash = h`。
       - 否则 → **冲突**：不写盘，置 `outline.externalConflict = { diskText: disk }`，工具栏弹冲突横幅。
  3. 若文件不存在（`noteDiskHash` 亦为 `null`）→ 正常创建写入。
- **冲突态期间**：`flushDisk`/自动保存拒绝写入（镜像 tab 系统 `externalState==='changed'` 的保存阻断，`tabs.svelte.ts:269-273`）。
- **冲突横幅**（大纲工具栏/面板顶部）动作：
  - **重载远端**：以 `diskText` 重新 `attachDoc`（丢弃内存未保存内容），清冲突，`noteDiskHash = sha256(diskText)`。
  - **覆盖本地**：把内存内容写盘，清冲突，更新 `noteDiskHash`，`armed = true`。
  - （另存为可后置，本次可不做。）
- i18n：新增 `outline.conflict.title` / `outline.conflict.reload` / `outline.conflict.overwrite`（或复用现有 `external.*` 键，计划阶段确认是否可复用）。

### 已天然安全、无需改动的路径

- **主 `.md`**：本就是被监听 tab。远端更新走 `decide()`（`external-state.ts:44-67`）：干净 tab → 静默重载 → `mdeditor:auto-reloaded` → 派生 effect 重新同步（配合 `markSynced` 不会乱写盘）；脏 tab → 弹"已在外部修改"横幅。
- **`.note.md` 作为 tab 打开**：完全走 tab 那套（干净静默重载、脏则横幅、`externalState==='changed'` 阻止保存、`recordOurWrite` 用 hash 抑制自身回声）。

## 已决策 / 权衡

- **铅笔惰性创建**：不预建空文件（用户选择"惰性创建"）。
- **已有内容的笔记 = 活跃**：磁盘上已有内容者，`armed` 初始为 `true`，同步/编辑照常自动保存（用户选择"已有笔记即活跃"）。手动确认模式只作用于全新/空笔记。
- **保存按钮指示态**：脏高亮+小圆点、净灰显禁用（用户选择）。
- **冲突防护档次**：写盘前校验（用户选择"轻量"档），不做 panel 模式实时监听/自动重载。取舍：能防住"覆盖远端"这个数据丢失点；代价是干净面板不会实时刷新远端变更，需交互/重开才刷新（但不丢数据）。完整监听对齐留作后续独立任务。

## 测试

单元（vitest，纯逻辑优先）：
- `markSynced()` 在 `armed=false` 时不触发 sink；`armed=true` 时触发。
- `markDirty()` 置 `armed=true` 并触发 sink。
- `attachDoc` 后 `armed` 初值随初始文本内容判定（有内容→true，空→false）。
- 冲突判定：`noteDiskHash` 与磁盘 hash 不一致且内容不同 → 置 `externalConflict` 且不写。

手动 / GUI（dev 构建 + 手动步骤，遵循 [[feedback_no_ui_automation_user_tests]]）：
1. 开面板浏览含标题的 `.md`，不触碰面板 → 磁盘上不出现 `.note.md`。
2. 编辑主文档 → 面板同步显示派生条目、保存按钮变亮带圆点、磁盘仍无文件。
3. 点保存按钮 → 文件出现、按钮变灰。
4. 在任意节点打字 → 自动保存生效、文件随之更新。
5. 已有内容的笔记：编辑主文档 → 照常自动保存（不需先打字）。
6. 冲突：面板有未保存编辑时，外部改写同名 `.note.md` → 下次写盘被拦、弹冲突横幅；重载/覆盖两动作各自正确。
7. 铅笔：无笔记时点铅笔 → 按选定方案（惰性未保存 tab / 或 disabled 兜底）表现正确，且不预建空文件。

## 风险

- 铅笔惰性 tab 的 watcher 延迟挂载接线（§4）——最脆弱处，已备兜底方案。
- 全局单例树在 attach/detach 竞态下的 `dirty/armed` 归属：务必在 `attachDoc` 内与树一起重置，避免跨笔记泄漏（沿用现有 `docPath === path` 守卫思路）。
- `$effect` 内同步调用读写 `$state` 的函数需 `untrack`，避免自失效死循环（[[feedback_svelte_effect_untrack]]）。
