# `.note.md` 基础功能升级 — 第四期:Dailynote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 托盘菜单"Today's Note"一键打开(不存在则创建)今日日记 `vault/{dailynote}/{yyyy}/{yyyy-MM-dd}.note.md`;`[[yyyy-MM-dd]]`/`[[yyyy-MM]]`/`[[yyyy]]` 日期链接先于索引按路径规范解析,点击缺失即创建。

**Architecture:** 纯函数层(`daily.ts`:日期链接识别、路径推导、今日字符串)全部单测;IO 薄层 `ensureDailyNote`(mkdir + 复用三期 `ensureOutlineFile`)。Rust 端只加一个托盘菜单项并 emit 事件,前端 App.svelte 监听(与 `open-file` 监听同模式)。日期链接分支插在 `openPageOrCreate` 的索引解析**之前**(spec §6:规范形式先于索引匹配)。

**Tech Stack:** Svelte 5、TypeScript、vitest、Tauri 2(tray/menu、事件)、@tauri-apps/plugin-fs

**Spec:** `docs/superpowers/specs/2026-07-10-outline-note-base-design.md` §6(目录名配置已在三期 Task 1 完成)

**依赖:** 三期已合入(`outlineDirs`、`ensureOutlineFile(path, title?)`、`resolveTarget`、`sotvaultStore.vaultRoot` 索引根)。

---

### Task 1: daily.ts — 日期链接识别、路径推导、ensureDailyNote

**Files:**
- Create: `src/lib/outline/daily.ts`
- Test: `src/lib/outline/daily.test.ts`

- [ ] **Step 1: 写失败测试** — 新建 `daily.test.ts`:

```ts
// src/lib/outline/daily.test.ts
import { describe, it, expect } from 'vitest'
import { parseDateLink, dailyNotePath, todayStr } from './daily'

describe('parseDateLink(规范形式,spec §6:仅三种,其余一律 null)', () => {
  it('day / month / year', () => {
    expect(parseDateLink('2026-07-10')).toEqual({ kind: 'day', year: '2026' })
    expect(parseDateLink('2026-07')).toEqual({ kind: 'month', year: '2026' })
    expect(parseDateLink('2026')).toEqual({ kind: 'year', year: '2026' })
  })
  it('rejects non-canonical date formats', () => {
    expect(parseDateLink('2026/07/10')).toBeNull()
    expect(parseDateLink('26-07-10')).toBeNull()
    expect(parseDateLink('2026-7-1')).toBeNull()
    expect(parseDateLink('2026-13')).toBeNull()      // 月份越界
    expect(parseDateLink('2026-07-32')).toBeNull()   // 日期越界
    expect(parseDateLink('July 10')).toBeNull()
    expect(parseDateLink('20260710')).toBeNull()
  })
})

describe('dailyNotePath', () => {
  it('builds vault/{dailynote}/{yyyy}/{target}.note.md', () => {
    expect(dailyNotePath('/v', 'dailynote', '2026-07-10')).toBe('/v/dailynote/2026/2026-07-10.note.md')
    expect(dailyNotePath('/v', 'dailynote', '2026-07')).toBe('/v/dailynote/2026/2026-07.note.md')
    expect(dailyNotePath('/v', '日记', '2026')).toBe('/v/日记/2026/2026.note.md')
  })
  it('null for non-date targets', () => {
    expect(dailyNotePath('/v', 'dailynote', 'not-a-date')).toBeNull()
  })
})

describe('todayStr', () => {
  it('formats local date as yyyy-MM-dd', () => {
    expect(todayStr(new Date(2026, 6, 10))).toBe('2026-07-10')  // 月份 0-based
    expect(todayStr(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
```

- [ ] **Step 2:** `pnpm vitest run src/lib/outline/daily.test.ts` → FAIL(模块不存在)

- [ ] **Step 3: 实现** — `daily.ts`:

```ts
// src/lib/outline/daily.ts
import { joinPath } from '../fs'

export type DateLinkKind = 'day' | 'month' | 'year'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^(\d{4})-(\d{2})$/
const YEAR_RE = /^(\d{4})$/

/**
 * 日期链接规范形式(spec §6):[[yyyy-MM-dd]]/[[yyyy-MM]]/[[yyyy]] 三种,
 * 其余日期写法一律不解析。做月/日范围粗验(01-12 / 01-31)。
 */
export function parseDateLink(target: string): { kind: DateLinkKind; year: string } | null {
  let m = target.match(DAY_RE)
  if (m) {
    const mm = Number(m[2]), dd = Number(m[3])
    return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 ? { kind: 'day', year: m[1] } : null
  }
  m = target.match(MONTH_RE)
  if (m) {
    const mm = Number(m[2])
    return mm >= 1 && mm <= 12 ? { kind: 'month', year: m[1] } : null
  }
  m = target.match(YEAR_RE)
  return m ? { kind: 'year', year: m[1] } : null
}

/** vault/{dailynoteDir}/{yyyy}/{target}.note.md;非日期返回 null */
export function dailyNotePath(vaultRoot: string, dailynoteDir: string, target: string): string | null {
  const d = parseDateLink(target)
  if (!d) return null
  return joinPath(joinPath(joinPath(vaultRoot, dailynoteDir), d.year), `${target}.note.md`)
}

/** 本地时区 yyyy-MM-dd(文件名字典序即时间序,spec §6) */
export function todayStr(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 确保日期笔记存在(按需建年目录;fm title = 日期字符串本身),返回路径。
 * vault 未配置返回 null。IO 薄层,vitest 不覆盖(仓库惯例)。
 */
export async function ensureDailyNote(target: string): Promise<string | null> {
  const { sotvaultStore } = await import('../sotvault.svelte')
  const vault = sotvaultStore.vaultRoot
  if (!vault) return null
  const { outlineDirs } = await import('./dirs.svelte')
  const path = dailyNotePath(vault, outlineDirs.dailynote, target)
  if (!path) return null
  const { mkdir } = await import('@tauri-apps/plugin-fs')
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true }).catch(() => {})
  const { ensureOutlineFile } = await import('./create')
  await ensureOutlineFile(path, target)
  return path
}
```

(动态 import 保持模块纯度:daily.test.ts 只触及纯函数,不拉起 Tauri/store 依赖。)

- [ ] **Step 4:** `pnpm vitest run src/lib/outline/daily.test.ts` → PASS;`pnpm check` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/daily.ts src/lib/outline/daily.test.ts
git commit -m "feat(outline): daily-note date links — canonical parse, path derivation, ensureDailyNote"
```

---

### Task 2: 日期链接接入 openPageOrCreate(先于索引解析)

**Files:**
- Modify: `src/lib/outline/backlinks-io.svelte.ts`(`openPageOrCreate` 开头)

- [ ] **Step 1: 实现** — `openPageOrCreate` 函数体最前(在 resolveTarget 解析之前)插入:

```ts
  // 日期链接规范形式(spec §6):先于索引匹配,按路径规则直达 dailynote
  {
    const { parseDateLink, ensureDailyNote } = await import('./daily')
    if (parseDateLink(target)) {
      const p = await ensureDailyNote(target)
      if (p) { await openFile(p); return }
      // vault 未配置:落回普通解析/建页逻辑
    }
  }
```

- [ ] **Step 2:** `pnpm check && pnpm test` → 全绿(行为无单测,Task 3 实机验证)

- [ ] **Step 3: Commit**

```bash
git add src/lib/outline/backlinks-io.svelte.ts
git commit -m "feat(outline): canonical date links resolve to dailynote before index lookup"
```

---

### Task 3: 托盘 "Today's Note" 入口(Rust + 前端)

**Files:**
- Modify: `src-tauri/src/lib.rs`(`build_tray_menu` ~line 1090、`on_menu_event` ~line 808、`menu_label` ~line 991)
- Modify: `src/App.svelte`(事件监听,`unlistenOpenFile` 同区域 ~line 126)

- [ ] **Step 1: Rust 菜单项** — `build_tray_menu` 中 `show_item` 之后新增:

```rust
    let today_note_item = MenuItem::with_id(app, "tray-today-note", menu_label(locale, "tray.todayNote"), true, None::<&str>)?;
```

并把 `today_note_item` 加进菜单 items 列表(紧跟 show_item 之后的位置;`Menu::with_items` 的数组里插入 `&today_note_item`——先读该函数尾部的 items 组装代码,保持既有分隔符结构)。

`menu_label` 的 match 增加:

```rust
        "tray.todayNote" => ("Today's Note", "今天的日记", "今日のノート"),
```

`on_menu_event` 的 match(`"tray-show" => …` 之后)增加:

```rust
                            "tray-today-note" => {
                                show_main_window(app);
                                let _ = app.emit("tray-today-note", ());
                            }
```

- [ ] **Step 2: 前端监听** — `App.svelte` 中 `unlistenOpenFile` 的同一 onMount 区域追加:

```ts
    const unlistenTodayNote = listen('tray-today-note', async () => {
      const { ensureDailyNote, todayStr } = await import('./lib/outline/daily')
      const p = await ensureDailyNote(todayStr())
      if (p) {
        await openFile(p)
      } else {
        pushToast({ level: 'info', message: t('outline.dailyNeedsVault') })
      }
    })
```

清理函数处与其他 unlisten 一致地追加 `unlistenTodayNote.then(f => f())`(以该文件现有 unlisten 清理写法为准)。`pushToast`/`t`/`openFile` 若未导入则按现有 import 补。

i18n:en `'outline.dailyNeedsVault': 'Set up a sync vault first (tray → Vault) to use daily notes.'`;zh `'outline.dailyNeedsVault': '请先在托盘菜单设置同步 Vault,才能使用每日笔记。'`;ja `'outline.dailyNeedsVault': 'デイリーノートを使うには、まずトレイメニューで Vault を設定してください。'`。

- [ ] **Step 3:** `pnpm check && pnpm test` → 全绿;`cargo check`(在 src-tauri 下)→ 编译通过:

```bash
cd src-tauri && cargo check 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src/App.svelte src/lib/i18n
git commit -m "feat(tray): Today's Note menu item — creates and opens today's daily note"
```

---

### Task 4: 三+四期回归 + dev 实机验证

- [ ] **Step 1:** `pnpm check && pnpm test` → 全绿

- [ ] **Step 2: dev 实机验证**(按 `reference_dev_gui_verification`,清场单实例;若机器被并行会话/用户占用,按二期先例有界等待)

fixtures:在真实 vault(`sotvault_vault_root`)或临时 vault 下验证:
1. 大纲编辑器内输入 `[[2026-07-10]]` 点击 → `vault/{dailynote}/2026/2026-07-10.note.md` 自动创建(含 fm title: 2026-07-10 + 空大纲)并以大纲 tab 打开;年目录自动创建
2. `[[2026-07]]`、`[[2026]]` 同理直达月度/年度总结
3. 托盘菜单出现"今天的日记/Today's Note"(随系统语言);点击 → 窗口前置 + 今日笔记打开;再点(已存在)→ 直接打开不重建
4. 大纲内输入 `[[新页面]]` 点击 → `vault/{wikipage}/新页面.note.md` 创建并打开;fm title 为原文
5. 设置页 outline tab:目录名输入框可改,改后新建页落到新目录
6. 制造同名冲突(两个目录各放 x.md)→ 索引构建 toast 上报
7. vault 未配置(临时把 vault root 置空不易——跳过,走 i18n toast 的代码审查确认)
8. `[[wiki]]` 指向 wikipage 下独立 .note.md 能解析打开(不再被伴生过滤误伤)

- [ ] **Step 3: 提交验证记录**(allow-empty commit,注明覆盖与未覆盖项)

---

## Self-Review 结果

- **Spec 覆盖:** §6 路径与命名三种形式(Task 1 dailyNotePath + 测试)、fm title=日期字符串(ensureDailyNote 传 target 为 title)、字典序即时间序(命名本身保证,无代码)、托盘入口+窗口前置+按需建目录(Task 3 + ensureDailyNote mkdir)、插件未启用降级(openFile 走 gate,天然降级)、规范形式先于索引且不支持其他格式(Task 2 前置分支 + parseDateLink 拒绝集测试)。
- **占位符:** 无;Rust 侧"items 组装保持既有结构"指向具体函数(build_tray_menu 尾部),非空泛。
- **类型一致性:** `parseDateLink → {kind, year}`、`dailyNotePath(vaultRoot, dir, target)`、`ensureDailyNote(target)` 在 Task 1/2/3 间一致;`ensureOutlineFile(path, title?)` 为三期已有签名。
