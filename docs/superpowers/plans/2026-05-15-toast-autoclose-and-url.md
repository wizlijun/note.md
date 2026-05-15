# Toast 自动关闭持久化 + 消息内 URL 可点击 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 toast 的"自动关闭"复选框成为可持久化的全局偏好，并让 toast 消息中的 URL 可点击在系统浏览器打开。

**Architecture:** 把"自动关闭"挪到 `settings.svelte.ts` 全局响应式 settings 对象上，持久化到 `settings.json`；`pushToast` 在调用方未显式传 `autoDismissMs` 时按全局值决定默认；`Toast.svelte` 的复选框直接绑定全局值并在切换时即时重排所有可见 toast 的定时器。URL 识别用一个独立的纯函数 `splitUrls()`（带单测），在 `Toast.svelte` 中把 message 切成"文本/URL"段，URL 段渲染为 `<button>` 并用 `@tauri-apps/plugin-opener` 的 `openUrl` 打开。

**Tech Stack:** Svelte 5 runes (`$state`), TypeScript, Vitest, `@tauri-apps/plugin-store`, `@tauri-apps/plugin-opener`.

**Reference spec:** `docs/superpowers/specs/2026-05-15-toast-autoclose-and-url-design.md`

---

## File Structure

- **Modify** `src/lib/settings.svelte.ts` — 新增 `toastAutoClose` 字段；`loadSettings` 读取，`saveSettings` 写入。
- **Modify** `src/lib/settings.test.ts` — 新增 round-trip 用例。
- **Modify** `src/lib/toast.svelte.ts` — `pushToast` 在 `autoDismissMs` 未显式传时按全局 setting 决定；导出 `TOAST_AUTO_DISMISS_MS` 常量。
- **Modify** `src/lib/toast.test.ts` — 新增全局偏好生效的用例。
- **Create** `src/lib/toast-urls.ts` — 纯函数 `splitUrls(text)`。
- **Create** `src/lib/toast-urls.test.ts` — `splitUrls` 单测。
- **Modify** `src/components/Toast.svelte` — 复选框绑定全局值；消息渲染 URL 为可点击按钮。

---

## Task 1: 在 settings 中新增 `toastAutoClose` 字段

**Files:**
- Modify: `src/lib/settings.svelte.ts`
- Test: `src/lib/settings.test.ts`

- [ ] **Step 1: 在 `settings.test.ts` 新增 round-trip 用例（失败的测试）**

在 `src/lib/settings.test.ts` 的 `describe('settings', ...)` 块末尾、最后一个 `it(...)` 之后追加：

```ts
  it('loadSettings hydrates toastAutoClose from store, defaults to false', async () => {
    const { loadSettings, settings } = await import('./settings.svelte')
    mockGet.mockImplementation(async (key: string) =>
      key === 'toastAutoClose' ? true : undefined,
    )
    await loadSettings()
    expect(settings.toastAutoClose).toBe(true)
  })

  it('loadSettings defaults toastAutoClose to false when missing', async () => {
    const { loadSettings, settings } = await import('./settings.svelte')
    // mockGet returns undefined for all keys by default
    await loadSettings()
    expect(settings.toastAutoClose).toBe(false)
  })

  it('saveSettings persists toastAutoClose', async () => {
    const { loadSettings, saveSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    settings.toastAutoClose = true
    await saveSettings()
    expect(mockSet).toHaveBeenCalledWith('toastAutoClose', true)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/settings.test.ts`
Expected: 三个新用例失败 —— `settings.toastAutoClose` 属性不存在 / `mockSet` 没有被调用过 `('toastAutoClose', …)`。

- [ ] **Step 3: 在 settings.svelte.ts 中新增字段、load、save**

在 `src/lib/settings.svelte.ts` 中：

(a) 在响应式 `settings` 对象类型与初始化里加上 `toastAutoClose`。把：

```ts
export const settings = $state<{
  autoSave: boolean
  theme: ThemeSettings
  mdblock: MdblockSettings
}>({
  autoSave: false,
  theme: { ...DEFAULT_THEME },
  mdblock: structuredClone(DEFAULT_MDBLOCK_SETTINGS),
})
```

改为：

```ts
export const settings = $state<{
  autoSave: boolean
  toastAutoClose: boolean
  theme: ThemeSettings
  mdblock: MdblockSettings
}>({
  autoSave: false,
  toastAutoClose: false,
  theme: { ...DEFAULT_THEME },
  mdblock: structuredClone(DEFAULT_MDBLOCK_SETTINGS),
})
```

(b) 在 `loadSettings()` 中，在 `settings.autoSave = ...` 之后插入一行：

```ts
  settings.toastAutoClose = (await s.get<boolean>('toastAutoClose')) ?? false
```

(c) 在 `saveSettings()` 中，在 `await s.set('autoSave', settings.autoSave)` 之后插入：

```ts
  await s.set('toastAutoClose', settings.toastAutoClose)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/settings.test.ts`
Expected: 全部用例通过（含新增三个）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings.svelte.ts src/lib/settings.test.ts
git commit -m "feat(settings): add toastAutoClose persisted flag"
```

---

## Task 2: `pushToast` 默认按全局偏好排定时

**Files:**
- Modify: `src/lib/toast.svelte.ts`
- Test: `src/lib/toast.test.ts`

- [ ] **Step 1: 在 `toast.test.ts` 新增用例（失败的测试）**

在 `src/lib/toast.test.ts` 的 `describe('toast queue', ...)` 块内，最后一个 `it(...)` 之后追加：

```ts
  it('auto-dismisses after 4s when settings.toastAutoClose is true and ms not supplied', async () => {
    vi.useFakeTimers()
    const { settings } = await import('./settings.svelte')
    settings.toastAutoClose = true
    pushToast({ level: 'info', message: 'q' })
    expect(toasts.list.length).toBe(1)
    vi.advanceTimersByTime(4000)
    expect(toasts.list).toEqual([])
    settings.toastAutoClose = false
    vi.useRealTimers()
  })

  it('explicit autoDismissMs overrides settings.toastAutoClose', async () => {
    vi.useFakeTimers()
    const { settings } = await import('./settings.svelte')
    settings.toastAutoClose = true
    pushToast({ level: 'info', message: 'q', autoDismissMs: 0 })
    vi.advanceTimersByTime(10_000)
    expect(toasts.list.length).toBe(1)  // still there — explicit 0 wins
    settings.toastAutoClose = false
    clearToasts()
    vi.useRealTimers()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/toast.test.ts`
Expected: 第一个新用例失败（4s 后仍在列表里 / `toasts.list` 非空）。

- [ ] **Step 3: 修改 toast store 让全局偏好生效**

把 `src/lib/toast.svelte.ts` 的全部内容替换为：

```ts
import type { ToastLevel } from './plugins/types'
import { settings } from './settings.svelte'

export interface ToastItem {
  id: number
  level: ToastLevel
  message: string
  detail?: string
}

interface PushOpts {
  level: ToastLevel
  message: string
  detail?: string
  /** ms before auto-dismiss; 0 = sticky. If omitted, falls back to the
   *  global `settings.toastAutoClose` preference (on → 4000ms, off → 0). */
  autoDismissMs?: number
}

export const TOAST_AUTO_DISMISS_MS = 4000

export const toasts = $state<{ list: ToastItem[] }>({ list: [] })

let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

const MSG_MAX = 200
const DETAIL_MAX = 2048

export function pushToast(opts: PushOpts): number {
  const id = nextId++
  const item: ToastItem = {
    id,
    level: opts.level,
    message: opts.message.slice(0, MSG_MAX),
    detail: opts.detail ? opts.detail.slice(0, DETAIL_MAX) : undefined,
  }
  toasts.list = [...toasts.list, item]
  const ms = opts.autoDismissMs ?? (settings.toastAutoClose ? TOAST_AUTO_DISMISS_MS : 0)
  if (ms > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), ms))
  }
  return id
}

export function dismissToast(id: number): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  toasts.list = toasts.list.filter((t) => t.id !== id)
}

export function scheduleAutoDismiss(id: number, ms: number): void {
  const existing = timers.get(id)
  if (existing) clearTimeout(existing)
  if (ms > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), ms))
  } else {
    timers.delete(id)
  }
}

export function clearToasts(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  toasts.list = []
  nextId = 1
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/toast.test.ts`
Expected: 全部通过（含新增两个）。

注：`settings.test.ts` mock 了 `@tauri-apps/plugin-store`，但 `toast.test.ts` 不会触发 `loadSettings` —— 直接读 `settings.toastAutoClose` 的当前内存值，初值 `false`，测试里显式赋 `true` 触发新分支，没问题。

- [ ] **Step 5: Commit**

```bash
git add src/lib/toast.svelte.ts src/lib/toast.test.ts
git commit -m "feat(toast): honor global toastAutoClose preference in pushToast"
```

---

## Task 3: `splitUrls` 纯函数 + 单测

**Files:**
- Create: `src/lib/toast-urls.ts`
- Test: `src/lib/toast-urls.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `src/lib/toast-urls.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { splitUrls } from './toast-urls'

describe('splitUrls', () => {
  it('returns a single text segment when no URL is present', () => {
    expect(splitUrls('hello world')).toEqual([{ kind: 'text', value: 'hello world' }])
  })

  it('returns empty array for empty string', () => {
    expect(splitUrls('')).toEqual([])
  })

  it('splits a single https URL surrounded by text', () => {
    expect(splitUrls('see https://example.com here')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: ' here' },
    ])
  })

  it('splits an http URL', () => {
    expect(splitUrls('go http://x.test now')).toEqual([
      { kind: 'text', value: 'go ' },
      { kind: 'url', value: 'http://x.test' },
      { kind: 'text', value: ' now' },
    ])
  })

  it('handles a URL at the very start and end', () => {
    expect(splitUrls('https://a.b')).toEqual([{ kind: 'url', value: 'https://a.b' }])
    expect(splitUrls('hi https://a.b')).toEqual([
      { kind: 'text', value: 'hi ' },
      { kind: 'url', value: 'https://a.b' },
    ])
    expect(splitUrls('https://a.b end')).toEqual([
      { kind: 'url', value: 'https://a.b' },
      { kind: 'text', value: ' end' },
    ])
  })

  it('handles multiple URLs', () => {
    expect(splitUrls('a https://x.test b https://y.test c')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'url', value: 'https://x.test' },
      { kind: 'text', value: ' b ' },
      { kind: 'url', value: 'https://y.test' },
      { kind: 'text', value: ' c' },
    ])
  })

  it('strips trailing CJK punctuation back into the text segment', () => {
    expect(splitUrls('点这里 https://example.com，然后继续')).toEqual([
      { kind: 'text', value: '点这里 ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: '，然后继续' },
    ])
    expect(splitUrls('看 https://example.com。')).toEqual([
      { kind: 'text', value: '看 ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: '。' },
    ])
  })

  it('strips trailing ASCII punctuation back into the text segment', () => {
    expect(splitUrls('see https://example.com, please')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: ', please' },
    ])
    expect(splitUrls('end https://example.com).')).toEqual([
      { kind: 'text', value: 'end ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: ').' },
    ])
  })

  it('keeps path/query intact', () => {
    expect(splitUrls('open https://x.test/a/b?c=1&d=2 done')).toEqual([
      { kind: 'text', value: 'open ' },
      { kind: 'url', value: 'https://x.test/a/b?c=1&d=2' },
      { kind: 'text', value: ' done' },
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/toast-urls.test.ts`
Expected: 因为 `toast-urls.ts` 不存在，所有用例失败 / import 报错。

- [ ] **Step 3: 实现 `splitUrls`**

创建 `src/lib/toast-urls.ts`：

```ts
export type TextSegment = { kind: 'text'; value: string }
export type UrlSegment = { kind: 'url'; value: string }
export type Segment = TextSegment | UrlSegment

const URL_RE = /https?:\/\/[^\s]+/g
const TRAILING_PUNCT_RE = /[)\]，。；：！？,.;:!?>'"」』]+$/

/**
 * Split a string into a sequence of text/url segments. URLs are detected by
 * the simple `https?://[^\s]+` rule; trailing punctuation (CJK and ASCII)
 * is shaved off the URL and pushed back into the following text segment so
 * URLs like `https://example.com，` don't drag the comma into the link.
 */
export function splitUrls(text: string): Segment[] {
  if (!text) return []
  const out: Segment[] = []
  let last = 0
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0]
    const start = m.index
    let end = start + url.length
    // Shave trailing punctuation off the URL.
    const trailMatch = url.match(TRAILING_PUNCT_RE)
    if (trailMatch) {
      const trailLen = trailMatch[0].length
      url = url.slice(0, -trailLen)
      end -= trailLen
      URL_RE.lastIndex = end
    }
    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) })
    out.push({ kind: 'url', value: url })
    last = end
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/toast-urls.test.ts`
Expected: 9 个用例全部通过。

- [ ] **Step 5: Commit**

```bash
git add src/lib/toast-urls.ts src/lib/toast-urls.test.ts
git commit -m "feat(toast): add splitUrls helper for inline URL detection"
```

---

## Task 4: 让 Toast.svelte 复选框绑定全局值；URL 段可点击打开

**Files:**
- Modify: `src/components/Toast.svelte`

注：本任务没有自动化测试（Svelte 组件渲染依赖 DOM/Tauri 运行时）。完成后必须按本任务"手动验证"列表逐项验证。

- [ ] **Step 1: 重写 `Toast.svelte`**

把 `src/components/Toast.svelte` 的整个内容替换为：

```svelte
<script lang="ts">
  import { toasts, dismissToast, scheduleAutoDismiss, TOAST_AUTO_DISMISS_MS, type ToastItem } from '../lib/toast.svelte'
  import { settings, saveSettings } from '../lib/settings.svelte'
  import { splitUrls } from '../lib/toast-urls'

  let expanded = $state<Record<number, boolean>>({})

  function toggle(id: number) {
    expanded[id] = !expanded[id]
  }

  function toggleAutoClose() {
    const on = !settings.toastAutoClose
    settings.toastAutoClose = on
    void saveSettings()
    const ms = on ? TOAST_AUTO_DISMISS_MS : 0
    for (const t of toasts.list) scheduleAutoDismiss(t.id, ms)
  }

  async function openLink(url: string) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  }

  function levelIcon(t: ToastItem) {
    switch (t.level) {
      case 'success': return '✓'
      case 'error': return '✕'
      case 'warn': return '⚠'
      default: return '🔔'
    }
  }
</script>

{#if toasts.list.length > 0}
  <div class="toast-bar" role="status" aria-live="polite">
    {#each toasts.list as t (t.id)}
      <div class="toast toast-{t.level}">
        <div class="row">
          <span class="icon">{levelIcon(t)}</span>
          <span class="msg">
            {#each splitUrls(t.message) as seg}
              {#if seg.kind === 'url'}
                <button type="button" class="link" onclick={() => openLink(seg.value)}>{seg.value}</button>
              {:else}
                {seg.value}
              {/if}
            {/each}
          </span>
          {#if t.detail}
            <button class="more" onclick={() => toggle(t.id)} aria-label="Show details">
              {expanded[t.id] ? '收起' : '详情'}
            </button>
          {/if}
          <label class="auto-close">
            <input type="checkbox" checked={settings.toastAutoClose} onchange={toggleAutoClose} />
            自动关闭
          </label>
          <button class="close" onclick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
        </div>
        {#if t.detail && expanded[t.id]}
          <pre class="detail">{t.detail}</pre>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-bar {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    z-index: 100;
  }
  .toast {
    background: color-mix(in srgb, Canvas 85%, CanvasText 15%);
    color: CanvasText;
    padding: 10px 16px;
    font-size: 13px;
    line-height: 1.4;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  .toast-success .icon { color: #2ec27e; }
  .toast-info .icon    { color: #3584e4; }
  .toast-warn .icon    { color: #f5c211; }
  .toast-error .icon   { color: #e01b24; }
  .row { display: flex; align-items: center; gap: 10px; }
  .icon { font-size: 15px; flex-shrink: 0; }
  .msg { flex: 1; word-break: break-word; }
  .close {
    background: transparent; color: inherit; border: none;
    cursor: pointer; padding: 2px 6px; font-size: 16px;
    opacity: 0.7;
  }
  .close:hover { opacity: 1; }
  .more {
    background: transparent; color: inherit; border: none;
    cursor: pointer; padding: 4px 8px; font-size: 12px;
    opacity: 0.7;
  }
  .more:hover { opacity: 1; }
  .link {
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    color: #3584e4;
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover { filter: brightness(1.2); }
  .auto-close {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    opacity: 0.7;
    cursor: pointer;
    user-select: none;
  }
  .auto-close input {
    margin: 0;
    cursor: pointer;
  }
  .detail {
    margin: 8px 0 0 25px; padding: 6px 8px;
    background: color-mix(in srgb, Canvas 70%, CanvasText 30%);
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 11px; max-height: 160px; overflow: auto;
    white-space: pre-wrap; word-break: break-word;
  }
</style>
```

- [ ] **Step 2: 跑类型检查 + 测试**

Run:

```bash
pnpm vitest run
pnpm exec svelte-check
```

Expected: 测试全部通过；`svelte-check` 没有新增错误。

注：如果项目无 `svelte-check` 脚本，跳过它，但确认 `pnpm vitest run` 通过。

- [ ] **Step 3: 启动 dev 并手动验证**

Run: 按项目惯例启动 dev（参考 `package.json` 的 `dev` / `tauri dev` 脚本）。

依次验证：

1. 触发任意 toast（例如分享一个文档，或菜单中触发任何带 toast 反馈的动作）。
2. **持久化：** 勾上"自动关闭" → 重启 App → 再触发 toast → 复选框默认勾上，且 4 秒后自动消失。
3. **联动重排：** 在未勾状态下连续触发 3 条粘性 toast → 勾上复选框 → 这 3 条都在约 4s 后陆续消失；再触发新 toast 时也按 4s 自动关闭。
4. **取消联动：** 勾上后再次取消 → 此刻可见 toast 不再被自动关闭，新的也不会自动关闭。
5. **URL 点击：** 触发分享成功 toast，消息形如 `已分享：https://...`：URL 显示下划线链接样式，点击系统浏览器打开对应页面；前后中文标点（冒号、句号）保持在普通文本里没有被吃进链接。
6. **无 URL toast：** 普通 toast 文案渲染保持原样。

- [ ] **Step 4: Commit**

```bash
git add src/components/Toast.svelte
git commit -m "feat(toast): persist auto-close pref globally; clickable URLs"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `pnpm vitest run`
Expected: 全绿。

- [ ] **格式 / 类型检查**

如果项目有 lint / typecheck 脚本（看 `package.json`），跑一遍并修任何新增告警：

```bash
pnpm exec tsc --noEmit
```

Expected: 无新增错误。
