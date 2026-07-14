# 保存确认框 macOS 标准化 + 国际化 — 设计文档

日期：2026-07-14
分支：feat/recall-perf-linkfix

## 目标

把"关闭有未保存更改的文件时是否保存"的确认框，从**硬编码英文 + 两步两按钮**流程，改成 **macOS 标准的单个三按钮原生弹窗**（`Save` / `Don't Save` / `Cancel`），并且**完整国际化**（en/zh/ja），措辞采用 macOS 官方句式（带文件名 + "更改将丢失"副文案）。

## 背景（探查结论）

- 这些确认框**本来就是 Tauri 原生对话框**（`@tauri-apps/plugin-dialog`），样式/布局已是 macOS 原生。真正的缺陷是：**文案硬编码、未走 i18n**，且**流程不符合 macOS 标准**（两步两按钮，而非单个三按钮）。
- 关键触发点：
  - `src/lib/dialogs.ts:34-50` `confirmDirtyClose()` —— 命名脏文件关闭确认。当前两步：`ask('Save changes before closing?')` → 取消后 `ask('Close without saving?')`。全硬编码。返回 `DirtyChoice = 'save'|'discard'|'cancel'`（定义于 `src/lib/tabs.svelte.ts:319`）。
  - `src/lib/tabs.svelte.ts:339-344` —— untitled 脏文件：先弹 NSSavePanel，用户取消保存面板后弹硬编码 `ask('Close without saving?')`。
- `confirmDirtyClose` 作为**回调**传给 `closeTab(id, confirm)`，调用点：`src/App.svelte:20/…`、`src/components/TabBar.svelte:17`、`src/components/ExternalChangeBanner.svelte:23`、`src/lib/commands.ts:35`。`closeTab` 内部以**无参** `await confirm()`（`tabs.svelte.ts:350`）调用。`src/lib/tabs.test.ts:46` 用 `vi.fn(async () => 'discard')` mock 它。
- 技术可行性：安装的 `@tauri-apps/plugin-dialog` v2 的 `message()` 支持 `YesNoCancel` 自定义三按钮（`buttons: { yes, no, cancel }`），返回 `MessageDialogResult = 'Yes'|'No'|'Cancel'|…`，可精确区分点了哪个。
- i18n：`src/lib/i18n/{en,zh,ja}.ts`，扁平点分键 + `t(key, params?)`（`{placeholder}` 插值）。已有 `'common.cancel'`。en.ts 为 source of truth。

## 需求（已与用户确认）

1. **形态**：macOS 标准**单个三按钮**原生弹窗（`Save`/`Don't Save`/`Cancel`），替掉两步流程。
2. **措辞**：macOS 官方完整句式——主句带**当前文件名**，副句"如果不保存，更改将丢失"。
3. **范围**：**仅保存/关闭确认框**（`dialogs.ts` 的 `confirmDirtyClose` + `tabs.svelte.ts` untitled 取消保存面板后的硬编码 ask）。已 i18n 的 outline/vault/sotvault/cli 与 Rust 侧 AGENTS.md 框**不动**。
4. **untitled 主流程不变**：仍"先弹 NSSavePanel"，只把其后的 fallback ask 换成 i18n + Mac 措辞。
5. i18n 键放在**新的 `dialog.*` 命名空间**下（复用已存在的 `common.cancel`）。

## macOS NSAlert 两层文案映射

macOS NSAlert = 粗体主文案（messageText）+ 灰色副文案（informativeText）。Tauri/rfd 映射（与当前 `title:'note.md'` 显示为粗体主文案的表现一致）：

- Tauri `title`（options）→ NSAlert **粗体主文案** → 放**带文件名的主句**
- Tauri `message`（首参）→ NSAlert **灰色副文案** → 放"更改将丢失"

> 此两层渲染在实现时 **dev 实机复核**（GUI 改动按既定规则须实机验证）。若真机上映射相反，则对调 `title`/`message` 两个参数即可，其余不变。

## 架构（2 个源文件 + i18n 目录 + 1 个测试）

### 1. `src/lib/dialogs.ts` — 重写 `confirmDirtyClose`

签名从无参改为 **`confirmDirtyClose(name: string): Promise<DirtyChoice>`**：

```ts
import { message } from '@tauri-apps/plugin-dialog'
import { t } from './i18n/store.svelte'   // dialogs.ts 在 src/lib/ 下，与 sotvault.svelte.ts 同路径

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
- 删除原两步 `ask()` 实现与 `ask` 的 import（若无其他使用）。
- `message` 加入 `@tauri-apps/plugin-dialog` 的 import。

### 2. `src/lib/tabs.svelte.ts` — 两处

**(a) `closeTab` 把文件名传进回调**，让 `confirmDirtyClose(name)` 拿到名字，同时**所有调用点不变**（仍传裸 `confirmDirtyClose`）：

- 回调类型：`confirm: (name: string) => Promise<DirtyChoice>`
- 命名脏文件分支：`const choice = await confirm(basename(tab.filePath!))`（`tabs.svelte.ts` 需 import `basename`，来自 `./fs`）。

**(b) untitled fallback ask i18n 化**（保留 2 按钮，流程不变）：

```ts
const doClose = await ask(t('dialog.discard.message'), {
  title: 'note.md',
  kind: 'warning',
  okLabel: t('dialog.dontSave'),
  cancelLabel: t('common.cancel'),
})
```

### 3. i18n — `src/lib/i18n/{en,zh,ja}.ts` 新增键

| key | en | zh | ja |
|-----|----|----|----|
| `dialog.saveChanges.message` | `Do you want to save the changes you made to "{name}"?` | `是否将更改保存到"{name}"？` | `"{name}"に加えた変更を保存しますか？` |
| `dialog.saveChanges.info` | `Your changes will be lost if you don't save them.` | `如果不保存，更改将丢失。` | `保存しない場合、変更は失われます。` |
| `dialog.save` | `Save` | `保存` | `保存` |
| `dialog.dontSave` | `Don't Save` | `不保存` | `保存しない` |
| `dialog.discard.message` | `Are you sure you want to discard your changes?` | `确定放弃更改吗？` | `変更を破棄してもよろしいですか？` |

`common.cancel` 复用（已存在：`Cancel` / `取消` / `キャンセル`）。

## 数据流

`closeTab(id, confirmDirtyClose)` → 命名脏文件 → `confirmDirtyClose(basename(path))` → 原生三按钮 `message()` → `'Yes'|'No'|'Cancel'` → `'save'|'discard'|'cancel'` → `closeTab` 现有分支逻辑（save→saveActive、discard→关闭、cancel→保留）**完全不变**。

## 按钮映射与顺序

`yes→save`、`no→discard`、`cancel→cancel`。左右排列与默认按钮由 macOS/rfd 决定（原生标准布局，`Save` 为默认蓝色按钮），只提供标签、不强排顺序。

## 边界 / 错误处理

- 文件名含引号/特殊字符：`{name}` 直接插值，交给原生渲染，不额外转义。
- 三按钮返回值只可能是 `'Yes'|'No'|'Cancel'`；映射用两个 `if` + 兜底 `return 'cancel'`，无漏网。
- untitled 分支无文件名，走 (b) 的 2 按钮 fallback，不进主句模板。

## 测试

- **新增 `src/lib/dialogs.test.ts`**：mock `@tauri-apps/plugin-dialog` 的 `message` 与 i18n `t`（或用真实 en 目录），断言 `confirmDirtyClose('README.md')`：
  1. 调 `message` 时 `title` 含文件名（`README.md`）、`buttons` 为 `{yes,no,cancel}` 三键、`kind:'warning'`；
  2. `message` 返回 `'Yes'/'No'/'Cancel'` 分别映射到 `'save'/'discard'/'cancel'`。
- **`src/lib/tabs.test.ts`**：确认现有 mock（`vi.fn(async () => 'discard')`）仍通过；补一条断言 `closeTab` 以文件名参数调用 `confirm`（命名脏文件分支）。
- **i18n 键完整性**：en/zh/ja 三处新键齐全（若项目已有 i18n 键校验测试则自动覆盖；否则人工核对）。
- **dev 实机验证（必做）**：真机关闭一个脏的已命名文件 → 确认是**单个三按钮 macOS 标准弹窗**、两层文案（主句带文件名、副句"更改将丢失"）、三个按钮点击后 save/discard/cancel 行为正确；顺带复核 untitled 取消保存面板后的 fallback 框已本地化。

## 非目标（YAGNI）

- 不动已 i18n 的 outline / vault / sotvault / cli 确认框。
- 不动 Rust 侧 `agents_sync` 的 AGENTS.md 冲突框。
- 不改 untitled 的"先弹 NSSavePanel"主流程。
- 不新建自研 HTML/Svelte 对话框组件（要的就是原生 macOS 弹窗）。
