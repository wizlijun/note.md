# History Row Layout + Tabbed Themed Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make history rows lead with date-time + author (commit message secondary); merge the per-item preview windows into ONE tabbed preview window; and render the rich preview with the user's configured theme.

**Architecture:** (1) Frontend-only row layout swap + a pure `formatDateTime`. (2) The Rust preview backend becomes a single `"preview"` window whose frontend maintains a tab list, fetched via a `drain_preview_tabs` command (payloads keyed by tabId; each unconsumed payload = a pending tab). (3) Rich preview HTML is baked with `bakeThemedPreviewHtml` (theme + katex + hljs inlined, no share chrome).

**Tech Stack:** Rust (Tauri v2 managed state + windows), Svelte 5 runes, TypeScript, Vitest.

---

## File Structure

- `src/lib/git-history/applies.ts` — add pure `formatDateTime`; remove `relTime`.
- `src/lib/git-history/applies.test.ts` — add formatDateTime tests; remove relTime tests.
- `src/lib/git-history/gate.svelte.ts` — drop `relTime` re-export.
- `src/components/history/HistoryPanel.svelte` — row markup (primary/secondary) + import + CSS.
- `src-tauri/src/preview_window/mod.rs` — replace open/take with `open_preview_tab` + `drain_preview_tabs`; `PreviewTab` type; `drain` helper + tests.
- `src-tauri/src/lib.rs` — re-register the two commands.
- `src-tauri/capabilities/default.json` — `"preview-*"` → `"preview"`.
- `src/lib/plugins/share-baker.ts` — extract `themedHead`; add `bakeThemedPreviewHtml`.
- `src/lib/git-history/preview-tabs.ts` (new) — `PreviewTab` interface + pure `upsertTab`.
- `src/lib/git-history/preview-tabs.test.ts` (new) — upsertTab tests.
- `src/preview-app.svelte` — tab container.
- `src/lib/git-history/preview.ts` — `open_preview_tab` wiring; rich uses `bakeThemedPreviewHtml`.

---

## Task 1: History row layout (date-time + author primary)

**Files:**
- Modify: `src/lib/git-history/applies.ts`, `src/lib/git-history/applies.test.ts`, `src/lib/git-history/gate.svelte.ts`, `src/components/history/HistoryPanel.svelte`

- [ ] **Step 1: Replace relTime tests with formatDateTime tests**

In `src/lib/git-history/applies.test.ts`, change the import line
```ts
import { historyAppliesTo, relTime } from './applies'
```
to
```ts
import { historyAppliesTo, formatDateTime } from './applies'
```
Delete the entire `describe('relTime', ...)` block and replace it with:
```ts
describe('formatDateTime', () => {
  it('formats a unix-seconds timestamp as local yyyy-MM-dd HH:mm', () => {
    // 2026-07-12 17:36:00 local time
    const ts = Math.floor(new Date(2026, 6, 12, 17, 36, 0).getTime() / 1000)
    expect(formatDateTime(ts)).toBe('2026-07-12 17:36')
  })
  it('zero-pads month, day, hour, minute', () => {
    const ts = Math.floor(new Date(2026, 0, 3, 4, 5, 0).getTime() / 1000)
    expect(formatDateTime(ts)).toBe('2026-01-03 04:05')
  })
})
```

- [ ] **Step 2: Run — expect FAIL (formatDateTime not defined)**

Run: `cd /Users/bruce/git/mdeditor && pnpm vitest run src/lib/git-history/applies.test.ts`
Expected: FAIL — `formatDateTime` is not exported.

- [ ] **Step 3: Implement formatDateTime, remove relTime**

In `src/lib/git-history/applies.ts`, DELETE the `relTime` function (the whole `export function relTime(...) { ... }` block) and add:
```ts
/** Local `yyyy-MM-dd HH:mm` for a Unix-seconds timestamp. Pure (no runes). */
export function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
```

- [ ] **Step 4: Drop the relTime re-export from the gate**

In `src/lib/git-history/gate.svelte.ts`, change
```ts
export { historyAppliesTo, relTime } from './applies'
```
to
```ts
export { historyAppliesTo, formatDateTime } from './applies'
```

- [ ] **Step 5: Update HistoryPanel row + import + CSS**

In `src/components/history/HistoryPanel.svelte`:

(a) In the import from the gate (the line listing `historyAppliesTo, relTime`), replace `relTime` with `formatDateTime`.

(b) Replace the two row spans:
```svelte
              <span class="subject">{c.subject}</span>
              <span class="meta">{c.short} · {relTime(c.timestamp)} · {c.author}</span>
```
with:
```svelte
              <span class="primary">{formatDateTime(c.timestamp)} · {c.author}</span>
              <span class="secondary">{c.subject} · {c.short}</span>
```

(c) In the `<style>` block, replace the `.subject` and `.meta` rules with:
```css
  .primary { font-size: 13px; font-weight: 500; }
  .secondary { font-size: 11px; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```
(If `.subject`/`.meta` are referenced nowhere else, they are fully replaced. Grep the file to confirm before removing.)

- [ ] **Step 6: Verify**

Run: `cd /Users/bruce/git/mdeditor && pnpm vitest run src/lib/git-history/applies.test.ts && pnpm check 2>&1 | tail -1 && grep -rn "relTime" src/`
Expected: tests pass; 0 type errors; grep prints nothing (relTime fully removed).

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/git-history/applies.ts src/lib/git-history/applies.test.ts src/lib/git-history/gate.svelte.ts src/components/history/HistoryPanel.svelte
git commit -m "feat(git-history): history rows lead with date-time + author"
```

---

## Task 2: Rust — single tabbed preview window backend

**Files:**
- Modify: `src-tauri/src/preview_window/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`

- [ ] **Step 1: Rewrite the module (payloads keyed by tabId; open_preview_tab + drain_preview_tabs)**

Replace the ENTIRE contents of `src-tauri/src/preview_window/mod.rs` with:

```rust
//! Backing store + commands for the single tabbed native "preview" window used
//! by the git-history plugin. The main window computes each view's content
//! (a unified diff, or self-contained themed rich HTML) and calls
//! `open_preview_tab`, which stashes the payload keyed by a tab id and ensures
//! the one `preview` window exists. That window drains pending tabs via
//! `drain_preview_tabs` on mount and whenever it receives a `preview-add-tab`
//! event, upserting them into its tab bar.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The single preview window's label.
const PREVIEW_LABEL: &str = "preview";

/// A tab's content. `kind` is "diff" or "rich"; `content` is the unified diff
/// text (diff) or a self-contained themed HTML document (rich).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewPayload {
    pub title: String,
    pub kind: String,
    pub content: String,
}

/// A tab handed to the window: its id plus payload fields (flattened).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewTab {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub content: String,
}

/// Managed state: tabId -> pending payload (unconsumed = a tab to open).
#[derive(Default)]
pub struct PreviewStore(pub Mutex<HashMap<String, PreviewPayload>>);

/// Insert/overwrite the payload for `id`.
pub fn stash(map: &mut HashMap<String, PreviewPayload>, id: String, payload: PreviewPayload) {
    map.insert(id, payload);
}

/// Remove and return ALL pending tabs, clearing the map.
pub fn drain(map: &mut HashMap<String, PreviewPayload>) -> Vec<PreviewTab> {
    let mut out: Vec<PreviewTab> = map
        .drain()
        .map(|(id, p)| PreviewTab { id, title: p.title, kind: p.kind, content: p.content })
        .collect();
    // Deterministic order (HashMap drain order is arbitrary): sort by id.
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// `Emitter` is required for `window.emit(...)`; `Manager` for `app.state()` /
// `app.get_webview_window()`.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Stash a tab's payload and ensure the single preview window exists (focus it
/// and emit `preview-add-tab` if already open, so it re-drains).
#[tauri::command]
pub fn open_preview_tab(
    app: AppHandle,
    tab_id: String,
    title: String,
    kind: String,
    content: String,
) -> Result<(), String> {
    {
        let store = app.state::<PreviewStore>();
        let mut map = store.0.lock().map_err(|e| e.to_string())?;
        stash(&mut map, tab_id, PreviewPayload { title, kind, content });
    }

    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = w.emit("preview-add-tab", ());
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(&app, PREVIEW_LABEL, WebviewUrl::App("preview.html".into()))
        .title("Preview")
        .inner_size(760.0, 680.0)
        .min_inner_size(420.0, 320.0)
        .resizable(true)
        .decorations(true)
        .visible(false)
        .build()
        .map_err(|e| format!("preview window build: {e}"))?;
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Drain (and clear) all pending tabs. Called by the preview window on mount and
/// on each `preview-add-tab` event.
#[tauri::command]
pub fn drain_preview_tabs(app: AppHandle) -> Result<Vec<PreviewTab>, String> {
    let store = app.state::<PreviewStore>();
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    Ok(drain(&mut map))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(c: &str) -> PreviewPayload {
        PreviewPayload { title: "t".into(), kind: "diff".into(), content: c.into() }
    }

    #[test]
    fn drain_returns_all_and_clears() {
        let mut m = HashMap::new();
        stash(&mut m, "diff-a".into(), payload("da"));
        stash(&mut m, "rich-b".into(), payload("rb"));
        let tabs = drain(&mut m);
        assert_eq!(tabs.len(), 2);
        // sorted by id
        assert_eq!(tabs[0].id, "diff-a");
        assert_eq!(tabs[1].id, "rich-b");
        assert_eq!(tabs[0].content, "da");
        // drained → empty
        assert!(drain(&mut m).is_empty());
    }

    #[test]
    fn stash_overwrites_same_id() {
        let mut m = HashMap::new();
        stash(&mut m, "diff-a".into(), payload("v1"));
        stash(&mut m, "diff-a".into(), payload("v2"));
        let tabs = drain(&mut m);
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].content, "v2");
    }

    #[test]
    fn drain_empty_is_empty() {
        let mut m = HashMap::new();
        assert!(drain(&mut m).is_empty());
    }
}
```

- [ ] **Step 2: Update lib.rs command registration**

In `src-tauri/src/lib.rs`, find the two lines registering the old commands:
```rust
                preview_window::open_preview_window,
                preview_window::take_preview_payload,
```
and replace them with:
```rust
                preview_window::open_preview_tab,
                preview_window::drain_preview_tabs,
```
(The `pub mod preview_window;` and `.manage(preview_window::PreviewStore::default())` lines are unchanged.)

- [ ] **Step 3: Narrow the capability to the single window**

In `src-tauri/capabilities/default.json`, change the `windows` array entry `"preview-*"` to `"preview"`:
```json
  "windows": ["main", "cli", "chat", "insights", "roam-import", "preview"],
```

- [ ] **Step 4: Verify build + tests**

Run: `cd /Users/bruce/git/mdeditor/src-tauri && cargo test --lib preview_window && cargo check`
Expected: 3 tests pass; crate compiles (dead-code warnings for the new commands until the frontend calls them are OK).

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/src/preview_window/mod.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat(preview): single tabbed window backend (open_preview_tab/drain_preview_tabs)"
```

---

## Task 3: Themed rich-preview HTML (no share chrome)

**Files:**
- Modify: `src/lib/plugins/share-baker.ts`

- [ ] **Step 1: Extract a shared themed style-head + add bakeThemedPreviewHtml**

In `src/lib/plugins/share-baker.ts`, the `bakeShareHtml` function builds its `<head>` with this block of inline styles (katex, hljs light/dark, themeCssBlock, themeCss, mobileOverrides, CRITIC_CSS). Extract that into a helper and add a chrome-free themed baker.

Add this helper ABOVE `bakeShareHtml` (it uses the module's existing `katexCss`, `hljsLightCss`, `hljsDarkCss`, `themeCssBlock`, `mobileOverridesCssBlock`, `CRITIC_CSS` imports/functions):
```ts
/** The shared inline `<style>` head used by both the share page and the
 *  git-history rich preview: katex + hljs(light/dark) + base responsive block +
 *  the user's theme CSS + mobile overrides + CriticMarkup. */
function themedStyleHead(themeCss: string): string {
  return `<style>${katexCss}</style>
<style>${hljsLightCss}</style>
<style>@media (prefers-color-scheme: dark) { ${hljsDarkCss} }</style>
<style>${themeCssBlock()}</style>
<style>${themeCss}</style>
<style>${mobileOverridesCssBlock()}</style>
<style>${CRITIC_CSS}</style>`
}

/** Render a Tab to a self-contained, THEME-STYLED HTML document for the
 *  git-history rich preview. Same theme/katex/hljs styling as the share page,
 *  but WITHOUT the share chrome (no header/footer/beacon). */
export async function bakeThemedPreviewHtml(tab: Tab, themeId: string = 'default'): Promise<string> {
  const inlineBody = await renderTabAsInlineBody(tab)
  const themeCss = await readThemeCss(themeId)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${viewportMetaTag()}
${themedStyleHead(themeCss)}
</head>
<body data-theme="${htmlEscape(themeId)}">
<main class="moraya-editor">${inlineBody}</main>
</body>
</html>`
}
```

Then refactor `bakeShareHtml` to reuse the helper: replace its seven consecutive `<style>...</style>` lines (the katex/hljs/themeCssBlock/themeCss/mobileOverrides/CRITIC_CSS block) with a single `${themedStyleHead(themeCss)}`. Leave everything else in `bakeShareHtml` (the `share-shell` header/footer, metadataBlock, beacon) unchanged.

- [ ] **Step 2: Verify share-baker still works + type-check**

Run: `cd /Users/bruce/git/mdeditor && pnpm vitest run src/lib/plugins/share-baker.test.ts && pnpm check 2>&1 | tail -1`
Expected: share-baker tests pass (the refactor is output-preserving); 0 type errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/plugins/share-baker.ts
git commit -m "feat(share-baker): extract themedStyleHead; add bakeThemedPreviewHtml (no chrome)"
```

---

## Task 4: upsertTab pure helper

**Files:**
- Create: `src/lib/git-history/preview-tabs.ts`, `src/lib/git-history/preview-tabs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/git-history/preview-tabs.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { upsertTab, type PreviewTab } from './preview-tabs'

const t = (id: string, content = id): PreviewTab => ({ id, title: id, kind: 'diff', content })

describe('upsertTab', () => {
  it('appends a new tab and activates it', () => {
    const r = upsertTab([t('a')], t('b'))
    expect(r.tabs.map((x) => x.id)).toEqual(['a', 'b'])
    expect(r.activeId).toBe('b')
  })
  it('updates an existing tab in place and activates it (no duplicate)', () => {
    const r = upsertTab([t('a'), t('b', 'old')], t('b', 'new'))
    expect(r.tabs.map((x) => x.id)).toEqual(['a', 'b'])
    expect(r.tabs[1].content).toBe('new')
    expect(r.activeId).toBe('b')
  })
  it('does not mutate the input array', () => {
    const input = [t('a')]
    upsertTab(input, t('b'))
    expect(input.map((x) => x.id)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `cd /Users/bruce/git/mdeditor && pnpm vitest run src/lib/git-history/preview-tabs.test.ts`
Expected: FAIL — cannot resolve `./preview-tabs`.

- [ ] **Step 3: Implement**

Create `src/lib/git-history/preview-tabs.ts`:
```ts
export interface PreviewTab {
  id: string
  title: string
  kind: 'diff' | 'rich'
  content: string
}

/** Merge a tab into the list: if `tab.id` already exists, replace it in place
 *  (keeping position); otherwise append. Returns a NEW array plus the id to
 *  activate (always the upserted tab). Pure — no mutation of `tabs`. */
export function upsertTab(tabs: PreviewTab[], tab: PreviewTab): { tabs: PreviewTab[]; activeId: string } {
  const idx = tabs.findIndex((x) => x.id === tab.id)
  const next = idx >= 0
    ? tabs.map((x, i) => (i === idx ? tab : x))
    : [...tabs, tab]
  return { tabs: next, activeId: tab.id }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd /Users/bruce/git/mdeditor && pnpm vitest run src/lib/git-history/preview-tabs.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/git-history/preview-tabs.ts src/lib/git-history/preview-tabs.test.ts
git commit -m "feat(preview): upsertTab pure helper for the tabbed preview"
```

---

## Task 5: Preview window app — tab container

**Files:**
- Modify: `src/preview-app.svelte`

- [ ] **Step 1: Rewrite the component as a tab container**

Replace the ENTIRE contents of `src/preview-app.svelte` with:

```svelte
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import DiffView from './components/history/DiffView.svelte'
  import { upsertTab, type PreviewTab } from './lib/git-history/preview-tabs'

  let tabs = $state<PreviewTab[]>([])
  let activeId = $state<string | null>(null)

  let active = $derived(tabs.find((x) => x.id === activeId) ?? null)

  async function drainTabs() {
    try {
      const drained = await invoke<PreviewTab[]>('drain_preview_tabs')
      for (const t of drained) {
        const r = upsertTab(tabs, t)
        tabs = r.tabs
        activeId = r.activeId
      }
      if (active) void getCurrentWindow().setTitle(active.title).catch(() => {})
    } catch (e) {
      console.warn('[preview] drain:', e)
    }
  }

  function selectTab(id: string) {
    activeId = id
    const ttl = tabs.find((x) => x.id === id)?.title
    if (ttl) void getCurrentWindow().setTitle(ttl).catch(() => {})
  }

  function closeTab(id: string) {
    const idx = tabs.findIndex((x) => x.id === id)
    if (idx < 0) return
    tabs = tabs.filter((x) => x.id !== id)
    if (tabs.length === 0) {
      void getCurrentWindow().close()
      return
    }
    if (activeId === id) selectTab(tabs[Math.min(idx, tabs.length - 1)].id)
  }

  $effect(() => {
    void drainTabs()
    const un = getCurrentWindow().listen('preview-add-tab', () => { void drainTabs() })
    // Re-drain once the listener is ready: the backend may emit before it
    // resolves. drain is idempotent (payloads cleared on take; upsert dedupes).
    void un.then(() => drainTabs())
    return () => { void un.then((f) => f()) }
  })
</script>

<main class="preview-root">
  {#if tabs.length > 0}
    <div class="tabbar" role="tablist">
      {#each tabs as tt (tt.id)}
        <div class="tab" class:active={tt.id === activeId}>
          <button class="tab-label" title={tt.title} onclick={() => selectTab(tt.id)}>{tt.title}</button>
          <button class="tab-close" aria-label="Close tab" onclick={() => closeTab(tt.id)}>×</button>
        </div>
      {/each}
    </div>
    <div class="body">
      {#if active?.kind === 'diff'}
        <DiffView content={active.content} />
      {:else if active?.kind === 'rich'}
        <!-- srcdoc is self-generated, self-contained themed HTML (no scripts); allow-same-origin without allow-scripts cannot escalate. -->
        <iframe class="rich-frame" title={active.title} srcdoc={active.content} sandbox="allow-same-origin"></iframe>
      {/if}
    </div>
  {:else}
    <div class="empty">No preview to show. Reopen it from the history panel.</div>
  {/if}
</main>

<style>
  /* Independent window: declare its own color-scheme so system canvas colors
     (used by DiffView) track light/dark, instead of being stuck light. */
  :global(:root) { color-scheme: light dark; }
  :global(html), :global(body) { margin: 0; height: 100%; }
  .preview-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: Canvas;
    color: CanvasText;
    overflow: hidden;
  }
  .tabbar {
    display: flex;
    gap: 2px;
    padding: 4px 6px 0;
    overflow-x: auto;
    border-bottom: 1px solid var(--border-color, #3333);
    flex-shrink: 0;
  }
  .tab {
    display: flex; align-items: center;
    max-width: 220px;
    border: 1px solid var(--border-color, #3333);
    border-bottom: 0;
    border-radius: 6px 6px 0 0;
    background: color-mix(in srgb, CanvasText 5%, Canvas);
  }
  .tab.active { background: Canvas; }
  .tab-label {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    font-size: 12px; padding: 5px 8px;
    max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tab-close {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    font-size: 13px; line-height: 1; padding: 4px 6px 4px 0; opacity: 0.6;
  }
  .tab-close:hover { opacity: 1; }
  .body { flex: 1; display: flex; min-height: 0; overflow: hidden; }
  .rich-frame { flex: 1; width: 100%; border: 0; background: Canvas; }
  .empty { padding: 24px; opacity: 0.6; font-size: 13px; }
</style>
```

- [ ] **Step 2: Type-check + build**

Run: `cd /Users/bruce/git/mdeditor && pnpm check 2>&1 | tail -2 && pnpm build 2>&1 | tail -4`
Expected: 0 type errors; build succeeds (emits `dist/preview.html`).

- [ ] **Step 3: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/preview-app.svelte
git commit -m "feat(preview): tabbed preview window (drain + upsert + close)"
```

---

## Task 6: Wire the panel to the tabbed window + themed rich

**Files:**
- Modify: `src/lib/git-history/preview.ts`

- [ ] **Step 1: Rewrite preview.ts helpers**

Replace the ENTIRE contents of `src/lib/git-history/preview.ts` with:

```ts
import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '../tabs.svelte'
import { bakeThemedPreviewHtml } from '../plugins/share-baker'
import { activeTheme } from '../active-theme.svelte'

/** Open (or add a tab to) the single native preview window. `tabId` is unique
 *  per (kind + version) so the same version reuses its tab; different
 *  versions/kinds get their own tabs. */
async function open(tabId: string, title: string, kind: 'diff' | 'rich', content: string): Promise<void> {
  await invoke('open_preview_tab', { tabId, title, kind, content })
}

/** A unified diff (git show / git diff) as a preview tab. */
export async function openDiffPreview(short: string, title: string, diff: string): Promise<void> {
  await open(`diff-${short}`, title, 'diff', diff)
}

/** Diff of the selected version against the live editor buffer, as a tab. */
export async function openComparePreview(short: string, title: string, diff: string): Promise<void> {
  await open(`cmp-${short}`, title, 'diff', diff)
}

/** Rich (rendered markdown) preview of a past version, as a tab. Rendered with
 *  the user's CURRENT theme via `bakeThemedPreviewHtml`. */
export async function openRichPreview(short: string, title: string, tab: Tab, markdown: string): Promise<void> {
  const synthetic: Tab = { ...tab, currentContent: markdown, initialContent: markdown }
  const html = await bakeThemedPreviewHtml(synthetic, activeTheme.id)
  await open(`rich-${short}`, title, 'rich', html)
}
```

- [ ] **Step 2: Type-check + full tests**

Run: `cd /Users/bruce/git/mdeditor && pnpm check 2>&1 | tail -2 && pnpm test 2>&1 | tail -4`
Expected: 0 type errors; all tests pass. (`HistoryPanel` already imports these three helpers with unchanged signatures, so no panel change is needed.)

- [ ] **Step 3: Verify no stale references to old command/helpers**

Run: `cd /Users/bruce/git/mdeditor && grep -rn "open_preview_window\|take_preview_payload\|wrapPrintHtml\|preview-updated\|preview-diff-\|preview-cmp-\|preview-rich-" src/`
Expected: nothing (all replaced). If `wrapPrintHtml` still appears only in `src/lib/print.ts` (its own definition, used by the print/PDF feature) that's fine — it should NOT appear in any git-history/preview file.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/git-history/preview.ts
git commit -m "feat(git-history): open previews as tabs; rich follows configured theme"
```

---

## Task 7: Manual GUI verification (dev build)

> Window/rendering change → real dev-GUI verification. Beware the installed-app single-instance collision (`gui-verify-isolation` memory): fully quit ALL notemd instances first, confirm the running exe is `target/debug/notemd`, drive via `System Events tell process "notemd"` (never `tell application ... activate`).

**Files:** none.

- [ ] **Step 1: Confirm full automated suite green**

Run: `cd /Users/bruce/git/mdeditor && pnpm check && pnpm test && (cd src-tauri && cargo test --lib preview_window && cargo test --lib git_history)`
Expected: all green.

- [ ] **Step 2: Launch clean dev build; open a vault file with ≥2 commits**

Fully quit notemd, `pnpm tauri dev`, confirm `target/debug/notemd`. Open History (⌘⇧Y).

- [ ] **Step 3: Verify**

1. **Row layout:** each history row shows `yyyy-MM-dd HH:mm · author` prominently, with `subject · shorthash` muted beneath.
2. **Preview** → a preview window opens showing the past version rendered rich, styled with the **current configured theme** (switch theme in Settings, reopen preview → styling changes; toggle system dark mode → iframe follows).
3. **View diff** and **Compare with current** → open as ADDITIONAL TABS in the SAME preview window (not new windows, not editor tabs).
4. Same commit + same action again → focuses/refreshes its existing tab (no duplicate).
5. Different commit → new tab; tabs switch on click; each tab's × closes it; closing the last tab closes the window.
6. **Restore** still writes the editor buffer (dirty), no window/tab.

- [ ] **Step 4: Capture evidence + report**

Screenshot: the history rows, a themed rich preview, and the preview window with ≥2 tabs. Report pass/fail per check with screenshots.

---

## Self-Review Notes (spec coverage)

- History row date-time+author primary → Task 1 (`formatDateTime` + markup + CSS; relTime removed).
- Single tabbed preview window → Task 2 (Rust `open_preview_tab`/`drain_preview_tabs`, `"preview"` capability), Task 4 (`upsertTab`), Task 5 (tab container), Task 6 (`open_preview_tab` wiring, tab ids `diff-/cmp-/rich-`).
- Tab reuse by id / closable / close-last-closes-window → Task 4 upsert + Task 5 closeTab.
- Rich follows configured theme → Task 3 (`bakeThemedPreviewHtml`, no chrome) + Task 6 (`activeTheme.id`).
- Drain race handling → Task 5 mount-drain + `.then(drain)` + `preview-add-tab` listener.
- capability narrowed → Task 2 step 3.
- Tests: formatDateTime (T1), Rust drain (T2), share-baker still-green (T3), upsertTab (T4); GUI (T7).
