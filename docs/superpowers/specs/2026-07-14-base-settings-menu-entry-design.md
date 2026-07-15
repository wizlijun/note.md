# Base 插件:设置项 + 文件菜单创建入口设计 (v1.2)

> 状态:已通过 brainstorm,待实现计划
> 日期:2026-07-14
> 前置:`2026-07-14-base-plugin-design.md`(只读 v1)、`2026-07-14-base-column-editing-design.md`(v1.1 编辑)。

## 1. 目标

1. 让 base 插件出现在**设置 ▸ 插件**页,带启用/禁用开关。
2. 在 **File 菜单**加一个「New Base」创建入口,点它弹保存对话框选位置、写起步模板、打开为表格 tab。
3. 完成后**合并到 main**。

### 已确定的决策

| 维度 | 决策 |
|---|---|
| 设置项 + 菜单项来源 | 一个 builtin manifest `src-tauri/plugins/base/manifest.json`(零 Rust 代码改动) |
| 菜单位置 | File 菜单里的一个平项「New Base」(非嵌套子菜单) |
| 「New Base」动作 | 保存对话框选目录+文件名 → 写起步 .base 模板 → 打开 |
| 合并策略 | 收尾时决定(整支 merge vs 只 cherry-pick base 提交);见 §6 |

## 2. builtin manifest(同时满足设置 + 菜单)

新增 `src-tauri/plugins/base/manifest.json`,格式照 `folder-view` / `roam-import`:
```json
{
  "id": "base",
  "name": "Base",
  "version": "0.1.0",
  "description": "Show a folder's markdown metadata as a structured, editable table defined by an Obsidian-compatible .base file.",
  "kind": "builtin",
  "default_enabled": true,
  "host_capabilities": [],
  "menus": [
    { "location": "file", "label": "New Base", "command": "create" }
  ],
  "i18n": {
    "zh": { "name": "Base", "description": "用 Obsidian 兼容的 .base 文件把某目录的 markdown 元数据显示为结构化可编辑表格。", "menus": { "create": "新建 Base" } },
    "ja": { "name": "Base", "description": "Obsidian 互換の .base ファイルで、フォルダ内 markdown のメタデータを構造化テーブルとして表示・編集します。", "menus": { "create": "新規 Base" } },
    "de": { "name": "Base", "description": "Zeigt die Markdown-Metadaten eines Ordners als strukturierte, bearbeitbare Tabelle über eine Obsidian-kompatible .base-Datei.", "menus": { "create": "Neue Base" } }
  }
}
```

机制(均为现有能力,无需改 Rust):
- **设置**:`get_all_plugin_manifests`(Rust)返回它 → `PluginsSettingsTab.svelte` 用 `resolvePluginEnabled(m)` 渲染一行带勾选;`default_enabled: true` → 默认开,与运行时 `isPluginEnabled('base')` 门控一致。
- **菜单**:`collect_top_menu_items` 收集**已启用**插件的 `menus`,id 编码为 `plugin:base:create`;`build_menu` 已把 `location:"file"` 且无 `submenu` 的项作为平项加入 File 菜单。插件禁用 → 该菜单项与 EditorPane 表格渲染一并消失。

约束:manifest 是 builtin 且 base **无后端二进制**(纯前端插件,同 folder-view)。菜单命令不经 Rust dispatch,靠前端处理(§4)。

## 3. 起步模板 + 创建动作

新模块 `src/lib/base/create.ts`:

```ts
/** Starter .base YAML: one table view showing the file name. */
export function newBaseTemplate(): string { /* returns YAML below */ }
```
模板内容:
```yaml
views:
  - type: table
    name: Table
    order:
      - file.name
```

`createNewBase()`(编排,同文件):
1. `const path = await pickSaveFile('untitled.base')`(现有 dialogs 助手,弹保存对话框)。
2. 取消(path 为 null)→ 直接返回。
3. `await writeTextFile(path, newBaseTemplate())`。
4. `await openFile(path)`(以 base kind、rich 模式打开 → BaseView 扫描该目录)。
5. 失败 → `showError`。

## 4. 前端菜单路由

`src/App.svelte` 的 `menu-event` 监听里,已有按 `pluginId` 分派的链(sotvault / roam-import)。在 roam-import 分支旁加:
```ts
if (pluginId === 'base') { if (command === 'create') await createNewBase(); return }
```
(`plugin:base:create` 已被解析为 `pluginId='base'`, `command='create'`。)

## 5. 保存过滤器

`src/lib/dialogs.ts` 的 `pickSaveFile` 依 `defaultPath` 扩展名取 `saveFilters(ext)`。若 `saveFilters` 不含 `base` 扩展,补一个:`{ name: 'Base', extensions: ['base'] }`,使保存对话框正确显示 `.base`。传 `'untitled.base'` 作 defaultPath。

## 6. 合并到 main(收尾)

实现 + 隔离 worktree GUI 验证(需重建 Tauri 加载 manifest)后进入 finishing。
**风险**:`feat/base-plugin` 已混入并行会话的 folder-view/outline 提交,整支 merge 会把它们一并带进 main。收尾时给用户两条路:
- ①**只 cherry-pick base 相关提交**到从 main 切的干净分支再合(推荐;避免带入未就绪的他人工作;注意共享文件 EditorPane/fs/i18n 可能冲突需解决);
- ②整支 merge(若 folder-view/outline 也已就绪)。
由用户拍板。

## 7. 测试

- `src/lib/base/create.test.ts`:`newBaseTemplate()` 产出的字符串经 `parseBase()` 解析出恰好一个 `type:'table'` 视图、`order` 含 `file.name`、`error` 为 undefined。
- 设置行显示、菜单项、保存对话框、创建后扫描:隔离 worktree 手动 GUI 验证(重建 Tauri)。

## 8. 明确不做(本轮 out of scope)

- File ▸ New 嵌套子菜单重构(保持平项)。
- base 后端二进制 / host 能力。
- 模板选择器(只出一个固定起步模板)。
- 无活动目录时的智能默认路径(统一走保存对话框)。
