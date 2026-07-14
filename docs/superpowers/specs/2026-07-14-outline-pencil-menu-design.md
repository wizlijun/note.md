# 大纲面板铅笔按钮 → 菜单（Markdown 打开 / 删除）设计

日期：2026-07-14
相关记忆：[[project_outline_intent_save]]、[[reference_sidecar_notes_naming]]、[[reference_i18n_system]]

## 背景与需求

大纲面板（`OutlinePanel.svelte`）右上角铅笔按钮当前直接调 `openNoteTab()` 把 `.note.md` 开成 tab（渲染为大纲）。用户要求：点铅笔改为弹**菜单**，两项：

1. **使用 Markdown 打开** —— 把 `.note.md` 开成原始 Markdown（源码），而非大纲视图。
2. **删除** —— 删除该 `.note.md`，删前**确认**。

## 关键实现依据

- `EditorPane.svelte:100-106` 路由顺序：`{:else if tab.mode === 'source'}`（→ SourceView）**先于** `{:else if isOutlineNoteTab(tab)}`（→ OutlineEditor）。因此把 `.note.md` tab 的 `mode` 设为 `'source'` 即可显示原始 Markdown、绕过大纲。
- `tabs.svelte`：`setMode(id, 'source')`；`closeTab(id, confirmFn)`，`DirtyChoice='save'|'discard'|'cancel'`。
- `companionPathFor(mainPath)` 得 `.note.md` 路径；`plugin-fs` 的 `exists`/`remove`。

## 交互设计

铅笔按钮 `onclick` 改为**开/关菜单**（fixed 定位，锚到按钮左下；window mousedown/Esc 关闭——复用 FolderView 的菜单模式）。菜单两项：

### 1. 使用 Markdown 打开（`openMarkdown`）
- 文件存在：`await openFile(companionPath)` → `setMode(tabByPath.id, 'source')`。
- 文件不存在（惰性）：现有惰性逻辑 `openNewOutlineTab(companionPath, newOutlineFileText(pageNameOf(companionPath)))` → `setMode(tab.id, 'source')`（未保存 buffer 也以源码显示模板文本）。

### 2. 删除（`deleteNote`）
- 磁盘无此文件时：菜单项 `disabled`（灰显）。
- 点击 → `@tauri-apps/plugin-dialog` 的 `ask`/`confirm` 弹确认（`outline.deleteNoteConfirm`，title `outline.deleteNote`）。
- 确认后依次：
  1. 若 `.note.md` 正开着 tab（`tabs.find(t => t.filePath === companionPath)`）→ `closeTab(tab.id, async () => 'discard')`（删文件前不保存）。
  2. `remove(companionPath)` 删盘。
  3. **重置面板大纲**：OutlinePanel 给 `<OutlineEditor mainTab={tab}>` 的 `{#key}` 由 `tab!.id` 改为 `` `${tab!.id}:${resetTick}` ``，删后 `resetTick++` → 强制重挂 → OutlineEditor 重读（文件已无）→ `attachDoc('')` → 大纲变空。
- 只删 `.note.md` 本身，**不动主 md**。

### 菜单项启用态
开菜单时异步 `exists(companionPath)` → 存 `noteExists`，据此 `disabled={!noteExists}` 控制"删除"。（"使用 Markdown 打开"始终可用——不存在则惰性开。）

## 改动文件

- `src/components/outline/OutlinePanel.svelte`：铅笔改为菜单触发；菜单模板 + `openMarkdown`/`deleteNote` 处理器 + `menuOpen`/`menuXY`/`noteExists`/`resetTick` 状态 + 关闭菜单的 window 监听。
- `src/lib/i18n/{en,zh,de,ja}.ts`：`outline.openMarkdown`、`outline.deleteNote`、`outline.deleteNoteConfirm`。
- （`tabs.svelte` 用现成 `setMode`/`closeTab`，无需改。）

## i18n 文案

| key | en | zh | de | ja |
|---|---|---|---|---|
| outline.openMarkdown | Open as Markdown | 使用 Markdown 打开 | Als Markdown öffnen | Markdown で開く |
| outline.deleteNote | Delete note | 删除笔记 | Notiz löschen | ノートを削除 |
| outline.deleteNoteConfirm | Delete this sidecar note file? This cannot be undone. | 删除这份伴生笔记文件？此操作不可撤销。 | Diese Begleitnotiz löschen? Kann nicht rückgängig gemacht werden. | この伴走ノートを削除しますか？元に戻せません。 |

## 测试

- 无纯逻辑可单测（全是组件 + dialog + fs）；主要 dev GUI 验证（[[feedback_no_ui_automation_user_tests]]）：
  1. 点铅笔弹菜单；点"使用 Markdown 打开" → `.note.md` 以源码 Markdown 打开（非大纲）。
  2. 点"删除" → 弹确认；确认后文件消失、若开着的 note tab 被关、面板大纲清空。
  3. 主 md 不受影响。
  4. 笔记尚未落盘时，"删除"置灰禁用；"使用 Markdown 打开"仍能惰性打开。

## 已决策 / 权衡

- "使用 Markdown 打开" = **source 模式**（复用 mode 路由优先级，改动最小）。
- 删除 = 删盘 + 关 tab + 面板重置；**无文件时禁用**；只删 `.note.md` 不动主 md。
- 铅笔原来的"开成大纲 tab"行为**移除**（面板本身即大纲编辑器，冗余）。
