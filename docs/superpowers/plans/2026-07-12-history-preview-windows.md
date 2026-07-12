# History Preview Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show git-history views (a new rich markdown preview of a past version, plus the existing diff and compare-with-current) in independent native Tauri preview windows instead of read-only tabs.

**Architecture:** A single generic `preview` native window app renders a payload it fetches from Rust-managed state (keyed by window label). The main window computes the content string (a unified diff, or self-contained rich HTML built via the existing print pipeline) and calls `open_preview_window`, which stashes the payload and creates/focuses the window. One window per (version + kind); reusing a label focuses + refreshes. The diff-as-tab path is removed.

**Tech Stack:** Rust (Tauri v2 `WebviewWindowBuilder`, managed `State`), Svelte 5 runes, TypeScript, Vitest, `@tauri-apps/api`.

---

## File Structure

**Backend (Rust):**
- Create `src-tauri/src/preview_window/mod.rs` — `PreviewPayload` type, `Mutex<HashMap<String, PreviewPayload>>` state, pure `stash`/`take` helpers (+ tests), and the `open_preview_window` / `take_preview_payload` commands.
- Modify `src-tauri/src/lib.rs` — declare the module, `.manage(...)` the state, register the two commands, add a `open_preview_window` window-builder helper.

**Frontend (new window app):**
- Create `preview.html` — window entry (mirrors `roam-import.html`).
- Create `src/preview-main.ts` — mounts the app.
- Create `src/preview-app.svelte` — reads its label, fetches payload, renders diff (`DiffView`) or rich (iframe), listens for `preview-updated`.
- Modify `vite.config.ts` — add `preview: 'preview.html'` to `rollupOptions.input` and to `optimizeDeps.entries`.
- Modify `src-tauri/capabilities/default.json` — add `"preview-*"` to `windows`.

**Frontend (wiring + cleanup):**
- Create `src/lib/git-history/preview.ts` — `openDiffPreview`, `openComparePreview`, `openRichPreview` helpers (build payload, invoke command).
- Modify `src/components/history/HistoryPanel.svelte` — `onDiff`/`onCompareCurrent` call the new helpers; add `onPreview` (rich) + a button; import cleanup.
- Modify `src/lib/i18n/{en,zh,ja}.ts` — add `history.preview` label.
- Modify `src/components/EditorPane.svelte` — remove the `isDiffPreviewTab` branch + `DiffView`/`isDiffPreviewTab` imports.
- Modify `src/lib/tabs.svelte.ts` — remove `openTextTab` and `isDiffPreviewTab`.
- Modify `src/lib/tabs.test.ts` — remove the `openTextTab` test.

`src/components/history/DiffView.svelte` and `src/lib/git-history/diff-parse.ts` are unchanged but now consumed by the preview window instead of EditorPane.

---

## Task 1: Rust preview-window state + commands

**Files:**
- Create: `src-tauri/src/preview_window/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create the module with pure helpers + failing tests**

Create `src-tauri/src/preview_window/mod.rs`:

```rust
//! Backing store + commands for the generic native "preview" window used by the
//! git-history plugin. The main window computes a content string (a unified
//! diff, or self-contained rich HTML) and calls `open_preview_window`, which
//! stashes the payload keyed by the window label and creates/focuses the window.
//! The preview window fetches its payload via `take_preview_payload` on mount
//! (and again whenever it receives a `preview-updated` event).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One preview's data. `kind` is "diff" or "rich"; `content` is the unified
/// diff text (diff) or a self-contained HTML document (rich).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewPayload {
    pub title: String,
    pub kind: String,
    pub content: String,
}

/// Managed state: label -> pending payload.
#[derive(Default)]
pub struct PreviewStore(pub Mutex<HashMap<String, PreviewPayload>>);

/// Insert/overwrite the payload for `label`.
pub fn stash(map: &mut HashMap<String, PreviewPayload>, label: String, payload: PreviewPayload) {
    map.insert(label, payload);
}

/// Remove and return the payload for `label` (None if absent).
pub fn take(map: &mut HashMap<String, PreviewPayload>, label: &str) -> Option<PreviewPayload> {
    map.remove(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(c: &str) -> PreviewPayload {
        PreviewPayload { title: "t".into(), kind: "diff".into(), content: c.into() }
    }

    #[test]
    fn take_returns_and_removes_stashed_payload() {
        let mut m = HashMap::new();
        stash(&mut m, "preview-diff-abc".into(), payload("hello"));
        let got = take(&mut m, "preview-diff-abc");
        assert_eq!(got, Some(payload("hello")));
        // taken → gone
        assert_eq!(take(&mut m, "preview-diff-abc"), None);
    }

    #[test]
    fn stash_overwrites_same_label() {
        let mut m = HashMap::new();
        stash(&mut m, "l".into(), payload("v1"));
        stash(&mut m, "l".into(), payload("v2"));
        assert_eq!(take(&mut m, "l").unwrap().content, "v2");
    }

    #[test]
    fn take_absent_label_is_none() {
        let mut m = HashMap::new();
        assert_eq!(take(&mut m, "nope"), None);
    }
}
```

- [ ] **Step 2: Run the tests — expect PASS (pure logic)**

Run: `cd /Users/bruce/git/mdeditor/src-tauri && cargo test --lib preview_window::tests`
Expected: 3 tests pass. (If the module isn't found, confirm Step 3's `pub mod` line.)

- [ ] **Step 3: Add the commands + window builder**

Append to `src-tauri/src/preview_window/mod.rs` (after `take`, before `#[cfg(test)]`):

```rust
// `Emitter` is required for `window.emit(...)` in Tauri v2; `Manager` for
// `app.state()` / `app.get_webview_window()`.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Create (or focus + refresh) the preview window `label`, stashing `payload`
/// for the window to fetch. Reusing a label focuses the existing window and
/// emits `preview-updated` so it re-fetches.
#[tauri::command]
pub fn open_preview_window(
    app: AppHandle,
    label: String,
    title: String,
    kind: String,
    content: String,
) -> Result<(), String> {
    let payload = PreviewPayload { title: title.clone(), kind, content };
    {
        let store = app.state::<PreviewStore>();
        let mut map = store.0.lock().map_err(|e| e.to_string())?;
        stash(&mut map, label.clone(), payload);
    }

    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.emit("preview-updated", ());
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("preview.html".into()))
        .title(title)
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

/// Fetch (and clear) the pending payload for `label`. Called by the preview
/// window on mount and on each `preview-updated` event.
#[tauri::command]
pub fn take_preview_payload(
    app: AppHandle,
    label: String,
) -> Result<Option<PreviewPayload>, String> {
    let store = app.state::<PreviewStore>();
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    Ok(take(&mut map, &label))
}
```

- [ ] **Step 4: Wire into lib.rs**

In `src-tauri/src/lib.rs`, add the module declaration next to the other `pub mod` lines (near `pub mod git_history;`):

```rust
pub mod preview_window;
```

Add the managed state where the other `.manage(...)` calls are (near `.manage(RecentMenu(Mutex::new(None)));`, ~line 738):

```rust
    let builder = builder.manage(preview_window::PreviewStore::default());
```

Register the two commands in the `#[cfg(not(target_os = "ios"))]` `generate_handler!` block, right after the `git_history::git_diff_current,` line:

```rust
                preview_window::open_preview_window,
                preview_window::take_preview_payload,
```

- [ ] **Step 5: Verify build + tests**

Run: `cd /Users/bruce/git/mdeditor/src-tauri && cargo test --lib preview_window && cargo check`
Expected: 3 tests pass; crate compiles.

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src-tauri/src/preview_window/mod.rs src-tauri/src/lib.rs
git commit -m "feat(preview): native preview-window state + open/take commands"
```

---

## Task 2: Preview window app (entry + component)

**Files:**
- Create: `preview.html`, `src/preview-main.ts`, `src/preview-app.svelte`
- Modify: `vite.config.ts`, `src-tauri/capabilities/default.json`

- [ ] **Step 1: Create the HTML entry**

Create `preview.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preview</title>
  </head>
  <body>
    <div id="preview-app"></div>
    <script type="module" src="/src/preview-main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create the mount entry**

Create `src/preview-main.ts`:

```ts
import { mount } from 'svelte'
import PreviewApp from './preview-app.svelte'

const target = document.getElementById('preview-app')
if (!target) throw new Error('preview-app root missing')
mount(PreviewApp, { target })
```

- [ ] **Step 3: Create the app component**

Create `src/preview-app.svelte`:

```svelte
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import DiffView from './components/history/DiffView.svelte'

  interface PreviewPayload { title: string; kind: string; content: string }

  let payload = $state<PreviewPayload | null>(null)
  let missing = $state(false)

  async function fetchPayload() {
    try {
      const label = getCurrentWindow().label
      const p = await invoke<PreviewPayload | null>('take_preview_payload', { label })
      if (p) {
        payload = p
        missing = false
        void getCurrentWindow().setTitle(p.title).catch(() => {})
      } else if (!payload) {
        missing = true
      }
    } catch (e) {
      console.warn('[preview] fetch payload:', e)
      if (!payload) missing = true
    }
  }

  $effect(() => {
    void fetchPayload()
    const un = getCurrentWindow().listen('preview-updated', () => { void fetchPayload() })
    return () => { void un.then((f) => f()) }
  })
</script>

<main class="preview-root">
  {#if payload?.kind === 'diff'}
    <DiffView content={payload.content} />
  {:else if payload?.kind === 'rich'}
    <iframe class="rich-frame" title={payload.title} srcdoc={payload.content} sandbox="allow-same-origin"></iframe>
  {:else if missing}
    <div class="empty">This preview is no longer available. Reopen it from the history panel.</div>
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
  .rich-frame {
    flex: 1;
    width: 100%;
    border: 0;
    background: #fff;
  }
  .empty { padding: 24px; opacity: 0.6; font-size: 13px; }
</style>
```

- [ ] **Step 4: Register the vite entry**

In `vite.config.ts`, add to `rollupOptions.input` (after `roamImport: 'roam-import.html',`):

```ts
        preview: 'preview.html',
```

And add `'preview.html'` to the `optimizeDeps.entries` array (which currently lists `'index.html', 'chat.html', 'insights.html', 'roam-import.html'`):

```ts
    entries: ['index.html', 'chat.html', 'insights.html', 'roam-import.html', 'preview.html'],
```

- [ ] **Step 5: Grant window capability**

In `src-tauri/capabilities/default.json`, change the `windows` array from
`["main", "cli", "chat", "insights", "roam-import"]` to add the glob:

```json
  "windows": ["main", "cli", "chat", "insights", "roam-import", "preview-*"],
```

> Tauri v2 capability `windows` supports glob label matching. If a `dev`/build error indicates the glob is rejected, fall back to listing fixed labels (`"preview-diff-*"` etc.) — but the single `"preview-*"` glob is expected to work.

- [ ] **Step 6: Type-check + build**

Run: `cd /Users/bruce/git/mdeditor && pnpm check && pnpm build`
Expected: 0 type errors; Vite build emits `preview.html`.

- [ ] **Step 7: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add preview.html src/preview-main.ts src/preview-app.svelte vite.config.ts src-tauri/capabilities/default.json
git commit -m "feat(preview): native preview window app (diff + rich iframe)"
```

---

## Task 3: History panel wiring (diff/compare → windows, add rich preview)

**Files:**
- Create: `src/lib/git-history/preview.ts`
- Modify: `src/components/history/HistoryPanel.svelte`, `src/lib/i18n/en.ts`, `src/lib/i18n/zh.ts`, `src/lib/i18n/ja.ts`

- [ ] **Step 1: Create the preview helpers**

Create `src/lib/git-history/preview.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '../tabs.svelte'
import { renderTabAsInlineBody } from '../plugins/host-render-html'
import { wrapPrintHtml } from '../print'

/** Open (or focus+refresh) a native preview window. `label` is unique per
 *  (kind + version) so the same version reuses its window and different
 *  versions open side-by-side. */
async function open(label: string, title: string, kind: 'diff' | 'rich', content: string): Promise<void> {
  await invoke('open_preview_window', { label, title, kind, content })
}

/** A unified diff (git show / git diff) in a native window. */
export async function openDiffPreview(short: string, title: string, diff: string): Promise<void> {
  await open(`preview-diff-${short}`, title, 'diff', diff)
}

/** Diff of the selected version against the live editor buffer, in a window. */
export async function openComparePreview(short: string, title: string, diff: string): Promise<void> {
  await open(`preview-cmp-${short}`, title, 'diff', diff)
}

/** Rich (rendered markdown) preview of a past version, in a window. Renders the
 *  historical markdown through the same pipeline as print/PDF into a
 *  self-contained styled HTML document. */
export async function openRichPreview(short: string, title: string, tab: Tab, markdown: string): Promise<void> {
  const synthetic: Tab = { ...tab, currentContent: markdown, initialContent: markdown }
  const body = await renderTabAsInlineBody(synthetic)
  const html = wrapPrintHtml(body, title)
  await open(`preview-rich-${short}`, title, 'rich', html)
}
```

- [ ] **Step 2: Rewire HistoryPanel actions**

In `src/components/history/HistoryPanel.svelte`, replace the imports of `openTextTab`/`setContent`:

Find:
```ts
  import { openTextTab, setContent } from '../../lib/tabs.svelte'
```
Replace with:
```ts
  import { setContent } from '../../lib/tabs.svelte'
  import { openDiffPreview, openComparePreview, openRichPreview } from '../../lib/git-history/preview'
```

Replace the body of `onDiff`:
```ts
  async function onDiff(c: GitCommit) {
    if (!tab || !vaultRoot) return
    try {
      const diff = await invoke<string>('git_file_show', { repo: vaultRoot, rev: c.hash, absPath: tab.filePath })
      const title = t('history.diffTitle', { short: c.short, name: basename(tab.filePath) })
      await openDiffPreview(c.short, title, diff)
    } catch (e) {
      pushToast({ level: 'error', message: t('history.loadFailed'), detail: String(e) })
    }
  }
```

Add `onPreview` immediately after `onDiff`:
```ts
  async function onPreview(c: GitCommit) {
    if (!tab || !vaultRoot) return
    try {
      const md = await invoke<string>('git_file_at', { repo: vaultRoot, rev: c.hash, absPath: tab.filePath })
      const title = t('history.previewTitle', { short: c.short, name: basename(tab.filePath) })
      await openRichPreview(c.short, title, tab, md)
    } catch (e) {
      pushToast({ level: 'error', message: t('history.loadFailed'), detail: String(e) })
    }
  }
```

Replace the `openTextTab(...)` call inside `onCompareCurrent` (which currently does `openTextTab({ title, content: diff, kind: 'code', language: 'diff' })`) with:
```ts
      await openComparePreview(c.short, title, diff)
```
(Leave the rest of `onCompareCurrent` — the empty-diff `history.noDiff` toast — unchanged.)

- [ ] **Step 3: Add the Preview action button**

In the actions row (currently `onDiff` / `onCompareCurrent` / `onRestore` buttons), add a Preview button as the FIRST action:

Find:
```svelte
                <button class="abtn" onclick={() => void onDiff(c)}>{t('history.diff')}</button>
```
Replace with:
```svelte
                <button class="abtn" onclick={() => void onPreview(c)}>{t('history.preview')}</button>
                <button class="abtn" onclick={() => void onDiff(c)}>{t('history.diff')}</button>
```

- [ ] **Step 4: Add i18n keys**

In `src/lib/i18n/en.ts`, after the `'history.diffCurrentTitle': ...,` line add:
```ts
  'history.preview': 'Preview',
  'history.previewTitle': '{short} · {name}',
```
In `src/lib/i18n/zh.ts`, after its `'history.diffCurrentTitle': ...,` line add:
```ts
  'history.preview': '预览',
  'history.previewTitle': '{short} · {name}',
```
In `src/lib/i18n/ja.ts`, after its `'history.diffCurrentTitle': ...,` line add:
```ts
  'history.preview': 'プレビュー',
  'history.previewTitle': '{short} · {name}',
```

- [ ] **Step 5: Type-check**

Run: `cd /Users/bruce/git/mdeditor && pnpm check 2>&1 | tail -1`
Expected: 0 ERRORS. (At this point `openTextTab` is still exported from tabs.svelte.ts — Task 4 removes it. No error yet.)

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/git-history/preview.ts src/components/history/HistoryPanel.svelte src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts
git commit -m "feat(git-history): open diff/compare/rich-preview in native windows"
```

---

## Task 4: Remove the diff-as-tab path

**Files:**
- Modify: `src/components/EditorPane.svelte`, `src/lib/tabs.svelte.ts`, `src/lib/tabs.test.ts`

- [ ] **Step 1: Confirm nothing else uses `openTextTab` / `isDiffPreviewTab`**

Run: `cd /Users/bruce/git/mdeditor && grep -rn "openTextTab\|isDiffPreviewTab" src/ | grep -v "tabs.test.ts"`
Expected: only `src/lib/tabs.svelte.ts` (definitions) and `src/components/EditorPane.svelte` (import + branch). If any OTHER file references them, STOP and report — they must be migrated first.

- [ ] **Step 2: Remove the EditorPane diff branch**

In `src/components/EditorPane.svelte`, remove these two import lines:
```ts
  import { isDiffPreviewTab } from '../lib/tabs.svelte'
  import DiffView from './history/DiffView.svelte'
```
And remove the diff branch from the template:
```svelte
  {:else if isDiffPreviewTab(tab)}
    {#key tab.id}
      <DiffView content={tab.currentContent} />
    {/key}
```
(Leave the following `{:else if tab.mode === 'source'}` branch — it becomes the next branch.)

- [ ] **Step 3: Remove `openTextTab` and `isDiffPreviewTab` from tabs.svelte.ts**

In `src/lib/tabs.svelte.ts`, delete the entire `openTextTab` function (the block starting with its doc comment `/** Open an in-memory, unsaved tab holding read-only-ish generated text ...`) and the entire `isDiffPreviewTab` function (the block starting `/** True for the in-memory, read-only unified-diff tabs ...`).

- [ ] **Step 4: Remove the `openTextTab` test**

In `src/lib/tabs.test.ts`, delete the `describe('openTextTab', ...)` block added earlier (the test that calls `openTextTab({ title: 'abc123 · note.md.diff', ... })`). If that leaves an unused import of `openTextTab` in the test file, remove `openTextTab` from the import list too.

- [ ] **Step 5: Verify nothing references the removed symbols; type-check + tests**

Run: `cd /Users/bruce/git/mdeditor && grep -rn "openTextTab\|isDiffPreviewTab" src/ ; echo "---" ; pnpm check 2>&1 | tail -1 ; pnpm test 2>&1 | tail -4`
Expected: grep prints nothing; 0 type errors; all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/components/EditorPane.svelte src/lib/tabs.svelte.ts src/lib/tabs.test.ts
git commit -m "refactor(git-history): drop diff-as-tab path (diff now opens in preview window)"
```

---

## Task 5: Manual GUI verification (dev build)

> Window/rendering change → real dev-GUI verification required. Beware the installed-app single-instance collision (see the `gui-verify-isolation` memory): fully quit ALL notemd instances first, confirm the running exe is `target/debug/notemd`, and drive strictly via `System Events tell process "notemd"` (never `tell application ... activate`, which launches the installed /Applications copy).

**Files:** none (verification only)

- [ ] **Step 1: Confirm the full automated suite is green**

Run: `cd /Users/bruce/git/mdeditor && pnpm check && pnpm test && (cd src-tauri && cargo test --lib preview_window && cargo test --lib git_history)`
Expected: all green. Record output.

- [ ] **Step 2: Launch a clean dev build**

Fully quit any running notemd, then `pnpm tauri dev`. Confirm `ps -o command= -p $(pgrep -f notemd)` shows `target/debug/notemd`. Enable the `git-history` plugin (it is builtin, default-enabled per the current manifest) and open a vault file that has ≥2 commits.

- [ ] **Step 3: Verify the three window actions + reuse**

Toggle the History panel (⌘⇧Y), click a commit, and verify:
1. **Preview** → a new native window opens showing the past version rendered as rich markdown (headings/lists/code styled), tracking light/dark.
2. **View diff** → a native window shows the coloured unified diff (green/red lines, line numbers).
3. **Compare with current** → a native window shows the diff of that version vs the current editor buffer.
4. Clicking the SAME action on the SAME commit again → focuses/refreshes the existing window (no duplicate).
5. Clicking the same action on a DIFFERENT commit → opens a SECOND window (side-by-side).
6. No diff/preview ever opens as an editor tab anymore.
7. **Restore** still writes into the editor buffer (tab goes dirty), no window.

- [ ] **Step 4: Capture evidence + report**

Screenshot the rich preview window and a diff window (both in the same run). Report pass/fail per numbered check with screenshots. Do not claim completion without them.

---

## Self-Review Notes (spec coverage)

- New rich preview action → Task 3 (`onPreview` + `openRichPreview` via `renderTabAsInlineBody` + `wrapPrintHtml`).
- diff + compare-current become native windows → Task 3 (`openDiffPreview`/`openComparePreview`), Task 4 removes the tab path.
- Independent native window, one generic app → Task 2.
- Window per (version+kind), reuse focuses+refreshes → Task 1 label scheme + `preview-updated`; Task 3 label prefixes.
- Main window computes content string → Task 3 helpers.
- Rich rendered read-only, styled → Task 3 `wrapPrintHtml` + Task 2 iframe.
- Diff reuses DiffView → Task 2.
- Restore unchanged → left as-is (Task 3 touches only onDiff/onCompareCurrent/adds onPreview).
- capabilities `preview-*` + color-scheme pitfalls → Task 2 steps 5 + 3.
- Compare-current empty → "no diff" toast unchanged → Task 3 step 2 note.
- Tests: Rust stash/take (Task 1); diff-parse unchanged; GUI (Task 5).
