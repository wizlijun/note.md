# Base 设置项 + File New-Base 菜单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 base 插件出现在设置▸插件页(带启用开关),并在 File 菜单加「New Base」创建入口(保存对话框→写模板→打开)。

**Architecture:** 一个 builtin manifest (`src-tauri/plugins/base/manifest.json`) 同时驱动设置行(`get_all_plugin_manifests`)与 File 菜单平项(`collect_top_menu_items`)——零 Rust 代码改动。菜单命令 `plugin:base:create` 由前端 App.svelte 路由到 `createNewBase()`(在 `src/lib/base/create.ts`)。

**Tech Stack:** Tauri builtin plugin manifest (JSON), TypeScript, Svelte 5, Vitest, `@tauri-apps/plugin-fs`, `yaml`(via parseBase).

参照:`docs/superpowers/specs/2026-07-14-base-settings-menu-entry-design.md`

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src-tauri/plugins/base/manifest.json` | builtin manifest:设置行 + File 菜单项 | 建 |
| `src/lib/base/create.ts` | `newBaseTemplate()` + `createNewBase()` | 建 |
| `src/lib/base/create.test.ts` | 模板单测 | 建 |
| `src/lib/dialogs.ts` | `saveFilters` 加 base 分支 | 改 |
| `src/App.svelte` | menu-event 路由 `plugin:base:create` | 改 |

---

## Task 1: builtin manifest

**Files:**
- Create: `src-tauri/plugins/base/manifest.json`

- [ ] **Step 1: 写 manifest**

创建 `src-tauri/plugins/base/manifest.json`(格式对照现有 `src-tauri/plugins/folder-view/manifest.json`):
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
    {
      "location": "file",
      "label": "New Base",
      "command": "create"
    }
  ],
  "i18n": {
    "zh": {
      "name": "Base",
      "description": "用 Obsidian 兼容的 .base 文件把某目录的 markdown 元数据显示为结构化可编辑表格。",
      "menus": { "create": "新建 Base" }
    },
    "ja": {
      "name": "Base",
      "description": "Obsidian 互換の .base ファイルで、フォルダ内 markdown のメタデータを構造化テーブルとして表示・編集します。",
      "menus": { "create": "新規 Base" }
    },
    "de": {
      "name": "Base",
      "description": "Zeigt die Markdown-Metadaten eines Ordners als strukturierte, bearbeitbare Tabelle über eine Obsidian-kompatible .base-Datei.",
      "menus": { "create": "Neue Base" }
    }
  }
}
```

- [ ] **Step 2: 校验 JSON 合法 + 结构对齐**

Run: `node -e "const m=require('./src-tauri/plugins/base/manifest.json'); if(m.id!=='base'||m.kind!=='builtin'||m.default_enabled!==true||m.menus[0].command!=='create') throw new Error('shape'); console.log('ok', m.id)"`
Expected: 打印 `ok base`(JSON 合法且字段正确)。

再对照现有 manifest 的键集合一致:
Run: `node -e "const a=Object.keys(require('./src-tauri/plugins/folder-view/manifest.json')).sort(); const b=Object.keys(require('./src-tauri/plugins/base/manifest.json')).sort(); console.log('folder-view', a); console.log('base', b)"`
Expected: base 的顶层键与 folder-view 一致(id/name/version/description/kind/default_enabled/host_capabilities/menus/i18n)。

- [ ] **Step 3: 提交**

precise-add ONLY this file(工作树有其他会话的未提交改动,绝不 `git add -A`):
```bash
git add src-tauri/plugins/base/manifest.json
git commit -m "feat(base): builtin manifest — settings row + File New-Base menu item

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `create.ts` 模板 + 创建动作

**Files:**
- Create: `src/lib/base/create.ts`
- Test: `src/lib/base/create.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/base/create.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { newBaseTemplate } from './create'
import { parseBase } from './parse'

describe('newBaseTemplate', () => {
  it('produces a valid single-table .base parseable with no error', () => {
    const cfg = parseBase(newBaseTemplate())
    expect(cfg.error).toBeUndefined()
    expect(cfg.views).toHaveLength(1)
    expect(cfg.views[0].type).toBe('table')
    expect(cfg.views[0].order).toContain('file.name')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/lib/base/create.test.ts`
Expected: FAIL(`./create` 模块不存在)。

- [ ] **Step 3: 实现**

创建 `src/lib/base/create.ts`:
```ts
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { pickSaveFile, showError } from '../dialogs'
import { openFile } from '../tabs.svelte'

/** Starter .base YAML: one table view showing the file name. */
export function newBaseTemplate(): string {
  return `views:
  - type: table
    name: Table
    order:
      - file.name
`
}

/**
 * File ▸ New Base: pick a location via the save dialog, write the starter
 * template there, then open it (as a base table tab that scans its folder).
 * A cancelled dialog is a no-op.
 */
export async function createNewBase(): Promise<void> {
  try {
    const path = await pickSaveFile('untitled.base')
    if (!path) return
    await writeTextFile(path, newBaseTemplate())
    await openFile(path)
  } catch (e) {
    showError(String(e))
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/lib/base/create.test.ts`
Expected: PASS。再 `pnpm check`,确认无新错误(create.ts 引用的 `pickSaveFile`/`showError` 来自 `../dialogs`,`openFile` 来自 `../tabs.svelte`——均为现有导出)。

- [ ] **Step 5: 提交**

```bash
git add src/lib/base/create.ts src/lib/base/create.test.ts
git commit -m "feat(base): new-base template + createNewBase (save-dialog → write → open)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 保存对话框识别 `.base`

**Files:**
- Modify: `src/lib/dialogs.ts`(`saveFilters` 函数)

- [ ] **Step 1: 加 base 过滤分支**

在 `src/lib/dialogs.ts` 的 `saveFilters(ext)` 里,在 `if (IMAGE_EXTS.includes(ext)) ...` 之后、`if (ALL_EXTS.includes(ext)) ...` 之前,加一行:
```ts
  if (ext === 'base')
    return [{ name: 'Base', extensions: ['base'] }]
```
(放在通用 `ALL_EXTS` 兜底之前,确保 `.base` 显式命中而非落到 “All supported”。)

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 0 error(仅现有 a11y 警告)。

- [ ] **Step 3: 提交**

```bash
git add src/lib/dialogs.ts
git commit -m "feat(base): save dialog shows .base file format filter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: App.svelte 菜单路由

**Files:**
- Modify: `src/App.svelte`(import 区 + `dispatchPlugin` 函数)

- [ ] **Step 1: 导入 createNewBase**

在 `src/App.svelte` 现有 `import { activeTab, tabs, closeTab, openFile, newFile, isDirty, activate } from './lib/tabs.svelte'` 附近的 import 区加一行:
```ts
  import { createNewBase } from './lib/base/create'
```

- [ ] **Step 2: 加 base 分派分支**

在 `dispatchPlugin` 函数里,现有:
```ts
        if (pluginId === 'roam-import') {
          if (command === 'open') await invoke('show_roam_import_window')
          return
        }
```
之后紧接着加:
```ts
        if (pluginId === 'base') {
          if (command === 'create') await createNewBase()
          return
        }
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `pnpm check && pnpm test`
Expected: 0 error;测试全绿。

- [ ] **Step 4: 提交**

```bash
git add src/App.svelte
git commit -m "feat(base): route File ▸ New Base menu command to createNewBase

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 全量校验 + 手动 GUI 冒烟(重建 Tauri)

**Files:** 无

- [ ] **Step 1: 全量**

Run: `pnpm test && pnpm check`
Expected: 全绿,0 error。

- [ ] **Step 2: 重建并手动核对(隔离 worktree,交用户)**

manifest 是 Tauri 侧资源,**必须重建**(`pnpm tauri dev`,让 build 复制 `plugins/` 并让 host 重新加载)。在隔离 worktree(`mdeditor-base-verify`,端口 1440,identifier `net.notemd.app.baseverify`)重建后:
1. **设置 ▸ 插件**:出现「Base」行,默认勾选(启用);描述与版本正确。
2. **File 菜单**:出现「New Base」条目。
3. 点「New Base」→ 弹保存对话框,过滤器显示 `.base`,默认名 `untitled.base` → 选目录保存。
4. 保存后自动以**表格 tab** 打开,列为 File(file.name),扫描该目录下的 md。
5. **设置里取消勾选 Base → 重启**:File 菜单「New Base」消失;`.base` 文件以源码/文本打开(表格渲染门控生效)。
6. 语言切到中文:菜单项显示「新建 Base」,设置行名/描述为中文。

- [ ] **Step 3: 无代码改动,跳过提交**

---

## 执行顺序

Task 1 → 2 → 3 → 4 → 5(Task 4 依赖 Task 2 的 `createNewBase` 存在;其余独立)。

## 自审记录(spec 覆盖)

- 设置行(启用开关)→ manifest `kind:builtin`+`default_enabled`(Task 1)+ 现有 PluginsSettingsTab。✓
- File 菜单「New Base」平项 → manifest `menus`(Task 1)+ 现有 build_menu 平项逻辑。✓
- 保存对话框选位置 → `createNewBase`→`pickSaveFile`(Task 2)+ base 过滤器(Task 3)。✓
- 写起步模板 + 打开 → `newBaseTemplate`+`writeTextFile`+`openFile`(Task 2)。✓
- 菜单命令路由 → App.svelte `plugin:base:create`(Task 4)。✓
- 测试:`create.test.ts`(Task 2);GUI(Task 5)。✓
- 零 Rust 代码改动:仅新增 manifest 资源,重建加载(Task 5 Step 2 说明)。✓
- 合并到 main:属收尾(finishing),不在本实现计划内;实现后按 spec §6 决策。
