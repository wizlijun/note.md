# 保存确认框 macOS 标准化 + 国际化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"关闭未保存文件"的确认框改成 macOS 标准单个三按钮原生弹窗（Save / Don't Save / Cancel），并把相关硬编码文案完整国际化（en/zh/ja）。

**Architecture:** 三处改动 + i18n 目录：(1) `src/lib/i18n/{en,zh,ja}.ts` 新增 `dialog.*` 键；(2) `src/lib/dialogs.ts` 的 `confirmDirtyClose` 重写为 `message()` 三按钮；(3) `src/lib/tabs.svelte.ts` 让 `closeTab` 把文件名传进回调、并把 untitled fallback 框 i18n。返回类型 `DirtyChoice` 与调用点不变。

**Tech Stack:** TypeScript + Svelte 5 + Vitest + `@tauri-apps/plugin-dialog` v2（`message()` 支持 `YesNoCancel` 自定义三按钮，返回 `'Yes'|'No'|'Cancel'`）。

**Spec:** `docs/superpowers/specs/2026-07-14-save-dialog-mac-i18n-design.md`

---

## File Structure

- **Modify** `src/lib/i18n/en.ts` / `zh.ts` / `ja.ts` — 新增 5 个 `dialog.*` 键（en 为 source of truth；`zh`/`ja` 是 `Record<keyof Messages,string>`，缺键会 `pnpm check` 报错 + `store.test.ts` 运行时校验失败）。
- **Modify** `src/lib/dialogs.ts` — 重写 `confirmDirtyClose` 为三按钮 `message()`，签名加 `name` 参数。
- **Create** `src/lib/dialogs.test.ts` — `confirmDirtyClose` 单测。
- **Modify** `src/lib/tabs.svelte.ts` — `closeTab` 传 `basename` 给回调；untitled fallback ask 换 i18n；顶部加 `t` import。
- **Modify** `src/lib/tabs.test.ts` — 加 i18n mock；补一条"basename 传入回调"断言。

---

## Task 1: i18n 新增 dialog.* 键

**Files:**
- Modify: `src/lib/i18n/en.ts:16`、`src/lib/i18n/zh.ts:11`、`src/lib/i18n/ja.ts:11`
- Guarded by: `src/lib/i18n/store.test.ts`（现有键集一致性测试）+ `pnpm check`（类型）

- [ ] **Step 1: 在 en.ts 加键（source of truth）**

在 `src/lib/i18n/en.ts` 第 16 行 `'common.saveAs': 'Save as…',` 之后插入：
```ts
  'dialog.saveChanges.message': 'Do you want to save the changes you made to "{name}"?',
  'dialog.saveChanges.info': "Your changes will be lost if you don't save them.",
  'dialog.save': 'Save',
  'dialog.dontSave': "Don't Save",
  'dialog.discard.message': 'Are you sure you want to discard your changes?',
```

- [ ] **Step 2: 确认类型/测试此时失败**

Run: `pnpm exec vitest run src/lib/i18n/store.test.ts`
Expected: FAIL — zh/ja 缺这 5 个键，键集一致性断言（`store.test.ts:58-59`）不通过。

- [ ] **Step 3: 在 zh.ts 加对应中文键**

在 `src/lib/i18n/zh.ts` 第 11 行 `'common.saveAs': '另存为…',` 之后插入：
```ts
  'dialog.saveChanges.message': '是否将更改保存到"{name}"？',
  'dialog.saveChanges.info': '如果不保存，更改将丢失。',
  'dialog.save': '保存',
  'dialog.dontSave': '不保存',
  'dialog.discard.message': '确定放弃更改吗？',
```

- [ ] **Step 4: 在 ja.ts 加对应日文键**

在 `src/lib/i18n/ja.ts` 第 11 行 `'common.saveAs': '名前を付けて保存…',` 之后插入：
```ts
  'dialog.saveChanges.message': '"{name}"に加えた変更を保存しますか？',
  'dialog.saveChanges.info': '保存しない場合、変更は失われます。',
  'dialog.save': '保存',
  'dialog.dontSave': '保存しない',
  'dialog.discard.message': '変更を破棄してもよろしいですか？',
```

- [ ] **Step 5: 校验通过**

Run: `pnpm exec vitest run src/lib/i18n/store.test.ts && pnpm check`
Expected: 测试 PASS；`pnpm check` 无新增 error（zh/ja 键集与 en 一致）。

- [ ] **Step 6: Commit（精确 add；兄弟 worktree 共享本仓库，禁用 `git add -A`/`.`）**

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts
git commit -m "i18n(dialogs): add save-confirmation dialog keys (en/zh/ja)"
```

---

## Task 2: 重写 confirmDirtyClose 为三按钮原生弹窗

**Files:**
- Modify: `src/lib/dialogs.ts:1`（import）、`:34-50`（函数）
- Test: `src/lib/dialogs.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

创建 `src/lib/dialogs.test.ts`：
```ts
// src/lib/dialogs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// message() mock must be hoisted-safe; use vi.hoisted so the factory can reference it.
const { messageMock } = vi.hoisted(() => ({ messageMock: vi.fn() }))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: messageMock,
  save: vi.fn(),
  open: vi.fn(),
}))

// Deterministic t(): echo the key, and for the {name} template append the name so
// the test can assert the filename reached the title.
vi.mock('./i18n/store.svelte', () => ({
  t: (key: string, params?: Record<string, string>) =>
    params?.name ? `${key}|${params.name}` : key,
}))

beforeEach(() => { messageMock.mockReset() })

describe('confirmDirtyClose', () => {
  it('shows a single 3-button native dialog with the filename in the title', async () => {
    messageMock.mockResolvedValueOnce('Yes')
    const { confirmDirtyClose } = await import('./dialogs')
    await confirmDirtyClose('README.md')

    expect(messageMock).toHaveBeenCalledTimes(1)
    const [info, opts] = messageMock.mock.calls[0]
    expect(info).toBe('dialog.saveChanges.info')          // informative text
    expect(opts.title).toContain('README.md')             // bold headline carries filename
    expect(opts.kind).toBe('warning')
    expect(opts.buttons).toEqual({
      yes: 'dialog.save',
      no: 'dialog.dontSave',
      cancel: 'common.cancel',
    })
  })

  it('maps Yes→save, No→discard, Cancel→cancel', async () => {
    const { confirmDirtyClose } = await import('./dialogs')
    messageMock.mockResolvedValueOnce('Yes')
    expect(await confirmDirtyClose('a.md')).toBe('save')
    messageMock.mockResolvedValueOnce('No')
    expect(await confirmDirtyClose('a.md')).toBe('discard')
    messageMock.mockResolvedValueOnce('Cancel')
    expect(await confirmDirtyClose('a.md')).toBe('cancel')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run src/lib/dialogs.test.ts`
Expected: FAIL — 现有 `confirmDirtyClose` 无参且用两步 `ask()`，`message` 未被调用（`messageMock` 调用次数 0）。

- [ ] **Step 3: 改 import**

`src/lib/dialogs.ts` 第 1 行由：
```ts
import { ask, save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
```
改为：
```ts
import { message, save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
import { t } from './i18n/store.svelte'
```

- [ ] **Step 4: 重写函数**

把 `src/lib/dialogs.ts:26-50`（含 JSDoc 与 `confirmDirtyClose` 整个函数体）替换为：
```ts
/**
 * Confirm-before-close for NAMED dirty files — a single macOS-standard
 * three-button alert (Save / Don't Save / Cancel).
 * Untitled dirty files are handled directly in closeTab (NSSavePanel).
 *
 * `title` renders as NSAlert's bold headline (carries the filename);
 * the first arg renders as the gray informative text.
 */
export async function confirmDirtyClose(name: string): Promise<DirtyChoice> {
  const res = await message(t('dialog.saveChanges.info'), {
    title: t('dialog.saveChanges.message', { name }),
    kind: 'warning',
    buttons: {
      yes: t('dialog.save'),
      no: t('dialog.dontSave'),
      cancel: t('common.cancel'),
    },
  })
  if (res === 'Yes') return 'save'
  if (res === 'No') return 'discard'
  return 'cancel'
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `pnpm exec vitest run src/lib/dialogs.test.ts`
Expected: PASS（2 用例全绿）。

- [ ] **Step 6: Commit（精确 add）**

```bash
git add src/lib/dialogs.ts src/lib/dialogs.test.ts
git commit -m "feat(dialogs): confirmDirtyClose as macOS 3-button native alert, i18n'd"
```

---

## Task 3: closeTab 传文件名 + untitled fallback i18n

**Files:**
- Modify: `src/lib/tabs.svelte.ts:1`（无需改 fs import，`basename` 已在）、`:322-323`（回调类型）、`:338-344`（untitled ask）、`:350`（named 调用）
- Test: `src/lib/tabs.test.ts`（加 i18n mock + 一条断言）

注意：`tabs.svelte.ts` 顶部已 `import { readMd, writeMd, basename, … } from './fs'`（第 2-4 行），无需再加 basename。

- [ ] **Step 1: 写失败测试 + i18n mock**

在 `src/lib/tabs.test.ts` 第 53 行（`@tauri-apps/plugin-dialog` mock 结束的 `}))` 之后）新增 i18n mock：
```ts
vi.mock('./i18n/store.svelte', () => ({
  t: (k: string) => k,
}))
```

并在 `describe('tabs', …)` 内、命名脏文件那组测试之后（约第 187 行 `closeTab named dirty → confirm=cancel` 用例之后）新增：
```ts
  it('closeTab named dirty passes the basename to the confirm callback', async () => {
    const m = await import('./tabs.svelte')
    await m.openFile('/tmp/foo.md')
    const id = m.tabs[0].id
    m.setContent(id, 'edited')
    const confirmSpy = vi.fn(async () => 'discard' as const)
    await m.closeTab(id, confirmSpy)
    expect(confirmSpy).toHaveBeenCalledWith('foo.md')
  })
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run src/lib/tabs.test.ts -t "passes the basename"`
Expected: FAIL — 现有 `closeTab` 以无参 `confirm()` 调用，`confirmSpy` 收到 `undefined` 而非 `'foo.md'`。

- [ ] **Step 3: 加 t import**

`src/lib/tabs.svelte.ts` 顶部 import 区加一行（紧随现有 `} from './fs'` 之后即可）：
```ts
import { t } from './i18n/store.svelte'
```

- [ ] **Step 4: 改 closeTab 回调类型 + 传 basename**

`src/lib/tabs.svelte.ts:322-323` 的回调类型：
```ts
export async function closeTab(
  id: string,
  confirm: () => Promise<DirtyChoice>,
): Promise<boolean> {
```
改为：
```ts
export async function closeTab(
  id: string,
  confirm: (name: string) => Promise<DirtyChoice>,
): Promise<boolean> {
```

命名脏文件分支第 350 行：
```ts
      const choice = await confirm()        // uses confirmDirtyClose
```
改为（`tab.filePath` 在 `if (!tab.filePath)` 的 else 分支里已被 TS 收窄为 string）：
```ts
      const choice = await confirm(basename(tab.filePath))  // uses confirmDirtyClose
```

- [ ] **Step 5: untitled fallback ask 换 i18n**

`src/lib/tabs.svelte.ts:338-344` 的：
```ts
        const { ask } = await import('@tauri-apps/plugin-dialog')
        const doClose = await ask('Close without saving?', {
          title: 'note.md',
          kind: 'warning',
          okLabel: 'Close without Saving',
          cancelLabel: 'Keep Editing',
        })
```
改为：
```ts
        const { ask } = await import('@tauri-apps/plugin-dialog')
        const doClose = await ask(t('dialog.discard.message'), {
          title: 'note.md',
          kind: 'warning',
          okLabel: t('dialog.dontSave'),
          cancelLabel: t('common.cancel'),
        })
```

- [ ] **Step 6: 运行 tabs 全套，确认通过**

Run: `pnpm exec vitest run src/lib/tabs.test.ts`
Expected: PASS（新用例通过；原有 closeTab 用例——含 `async () => 'save'` 等忽略参数的回调——仍全绿）。

- [ ] **Step 7: Commit（精确 add）**

```bash
git add src/lib/tabs.svelte.ts src/lib/tabs.test.ts
git commit -m "feat(tabs): pass filename to close-confirm; i18n untitled discard fallback"
```

---

## Task 4: 全量校验 + dev 实机验证

**Files:** none（verification only）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: PASS（全绿，含新 `dialogs.test.ts`、i18n `store.test.ts`、`tabs.test.ts`）。

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 无新增 error（本改动引入的文件/键均类型正确）。

- [ ] **Step 3: dev 实机验证（必做，GUI 改动）**

启动 dev（项目常规 dev 入口），验证并记录每条 pass/fail：
1. 编辑一个**已命名**文件使其变脏 → 关闭该 tab → 应弹出**单个三按钮 macOS 原生弹窗**：粗体主句含**文件名**、灰色副句"如果不保存，更改将丢失"、三个按钮 `保存` / `不保存` / `取消`。
2. 点 `保存` → 存到原路径并关闭；点 `不保存` → 不保存直接关闭；点 `取消` → tab 保留、不关闭。
3. 切换语言（设置里改 en/ja）后重复 1 → 文案随语言变化（英文 "Do you want to save the changes you made to "…"?" / 日文对应句）。
4. 新建 untitled 文件写点内容 → 关闭 → 先弹 NSSavePanel；在保存面板点取消 → 弹本地化的两按钮框（`不保存` / `取消`），点 `不保存` 关闭、点 `取消` 保留。

> 注：若实机发现主句/副句的粗体-灰色两层位置与预期相反（即 macOS 把 `message` 首参渲染成粗体、`title` 渲染成灰色），则把 `dialogs.ts` 里 `message()` 的第一个参数与 `title` 选项对调即可，其余不变；对调后重跑 `dialogs.test.ts` 并把该测试中 `info`/`title` 的断言相应对调。

---

## Self-Review Notes

- **Spec coverage:** 三按钮 message()→Task 2；完整句式带文件名→Task 1 键 + Task 2 传参 + Task 3 传 basename；untitled fallback i18n→Task 3 Step 5；`dialog.*` 命名空间→Task 1；en/zh/ja 三语→Task 1；调用点不变→Task 3（回调签名兼容，四处仍传裸 `confirmDirtyClose`，`tabs.test.ts` 内联 mock 忽略参数仍兼容）。
- **Type consistency:** `confirmDirtyClose(name: string): Promise<DirtyChoice>`、`closeTab` 回调 `(name: string) => Promise<DirtyChoice>`、`message()` 返回 `'Yes'|'No'|'Cancel'` 映射三分支——三处签名一致。
- **No placeholders:** 每步含完整代码/命令/预期。实机对调那条是明确的条件性回退指令，非占位符。
