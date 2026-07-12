# Git History View Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `git-history` builtin plugin that shows the git commit history of the current vault file in a right-side panel (mutually exclusive with the outline panel), letting the user view a diff or restore any past version.

**Architecture:** Mirror the existing `outline-notes` plugin pattern: a builtin manifest under `src-tauri/plugins/`, a `gate.svelte.ts` state store, a lazily-imported panel component rendered in the `.pane` flex row, and a View-menu `toggle` command wired in `App.svelte`. Three new desktop Tauri commands reuse `vault_sync::git_ops::run_git` to run `git log`/`git show` against the vault repo. Restore writes into the editor buffer (dirty, no disk write); diff opens in a read-only code tab.

**Tech Stack:** Rust (Tauri commands, `std::process::Command` via `git_ops`), Svelte 5 runes, TypeScript, Vitest, self-rolled i18n.

---

## File Structure

**Backend (Rust):**
- Create `src-tauri/src/git_history/mod.rs` — `GitCommit` type, pure `parse_log`, `rel_path`, and three commands (`git_file_log`, `git_file_show`, `git_file_at`). Reuses `crate::vault_sync::git_ops`.
- Modify `src-tauri/src/lib.rs` — declare `pub mod git_history;` and register the three commands in the desktop `invoke_handler!`.
- Create `src-tauri/plugins/git-history/manifest.json` — builtin plugin manifest, `default_enabled: false`, View-menu toggle with `enabled_when: "vaultConfigured"`.

**Frontend (TS/Svelte):**
- Create `src/lib/git-history/applies.ts` — pure `historyAppliesTo(tab, vaultRoot)` and `relTime(ts, now)` (testable, no runes/tauri imports).
- Create `src/lib/git-history/applies.test.ts` — unit tests for both.
- Create `src/lib/git-history/gate.svelte.ts` — `historyGate` state + load/visible/width setters (mirror `outline/gate.svelte.ts`); re-exports `historyAppliesTo`, `relTime`.
- Create `src/lib/git-history/types.ts` — `GitCommit` TS interface (matches Rust).
- Modify `src/lib/sotvault-logic.ts` — export the existing private `isUnder`.
- Modify `src/lib/tabs.svelte.ts` — add `openTextTab(...)` helper for the read-only diff tab.
- Modify `src/lib/tabs.test.ts` — test `openTextTab`.
- Create `src/components/history/HistoryPanel.svelte` — the panel (toolbar, commit list, inline diff/restore actions, empty states).
- Modify `src/App.svelte` — boot load, `dispatchPlugin` branch + mutual exclusion, `showHistoryPanel` derived, render panel, float-toggle offset.
- Modify `src/lib/i18n/en.ts`, `src/lib/i18n/zh.ts`, `src/lib/i18n/ja.ts` — `history.*` keys.

---

## Task 1: Rust — GitCommit type, pure parser, rel_path (unit tests)

**Files:**
- Create: `src-tauri/src/git_history/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod git_history;` near the other `pub mod` lines, ~line 31)

- [ ] **Step 1: Create the module with type, pure helpers, and failing tests**

Create `src-tauri/src/git_history/mod.rs`:

```rust
//! File-level git history for vault files. Reuses `vault_sync::git_ops` to run
//! `git log`/`git show` against the vault repo. Desktop-only in practice
//! (commands are registered only in the non-iOS invoke handler).

use std::path::Path;

use crate::vault_sync::git_ops;

/// One commit that touched a given file. `timestamp` is Unix seconds (author date).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
}

/// The field separator we embed in the `git log --format` string (ASCII Unit
/// Separator, 0x1f — will never appear in a one-line subject).
const FS: char = '\u{1f}';

/// Parse the `git log --format=%H<FS>%h<FS>%an<FS>%at<FS>%s` output (one commit
/// per line) into structured commits. Blank lines and malformed lines are skipped.
pub fn parse_log(stdout: &str) -> Vec<GitCommit> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split(FS);
            let hash = parts.next()?.trim().to_string();
            if hash.is_empty() {
                return None;
            }
            let short = parts.next()?.to_string();
            let author = parts.next()?.to_string();
            let timestamp = parts.next()?.trim().parse::<i64>().ok()?;
            let subject = parts.next().unwrap_or("").to_string();
            Some(GitCommit { hash, short, author, timestamp, subject })
        })
        .collect()
}

/// The repo-relative, forward-slashed path of `abs` under `repo`. Errors when
/// `abs` is not under `repo`.
pub fn rel_path(repo: &Path, abs: &Path) -> Result<String, String> {
    let rel = abs
        .strip_prefix(repo)
        .map_err(|_| "file is not under the vault repo".to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parse_log_reads_fields() {
        let fs = '\u{1f}';
        let line = format!("abcdef123456{fs}abcdef1{fs}Jane Doe{fs}1700000000{fs}fix: a thing");
        let out = parse_log(&format!("{line}\n"));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].hash, "abcdef123456");
        assert_eq!(out[0].short, "abcdef1");
        assert_eq!(out[0].author, "Jane Doe");
        assert_eq!(out[0].timestamp, 1_700_000_000);
        assert_eq!(out[0].subject, "fix: a thing");
    }

    #[test]
    fn parse_log_skips_blank_and_malformed() {
        let fs = '\u{1f}';
        let good = format!("h{fs}s{fs}a{fs}123{fs}subj");
        let bad = format!("h{fs}s{fs}a{fs}notanumber{fs}subj");
        let out = parse_log(&format!("\n{good}\n{bad}\n\n"));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].subject, "subj");
    }

    #[test]
    fn rel_path_forward_slashes_under_repo() {
        let repo = PathBuf::from("/vault");
        let abs = PathBuf::from("/vault/Sync/note.md");
        assert_eq!(rel_path(&repo, &abs).unwrap(), "Sync/note.md");
    }

    #[test]
    fn rel_path_rejects_outside() {
        let repo = PathBuf::from("/vault");
        let abs = PathBuf::from("/elsewhere/note.md");
        assert!(rel_path(&repo, &abs).is_err());
    }
}
```

Add the module declaration in `src-tauri/src/lib.rs` next to the other `pub mod` lines (after `pub mod vault_sync;` at ~line 31):

```rust
pub mod git_history;
```

- [ ] **Step 2: Run the tests — expect PASS (pure logic only)**

Run: `cd src-tauri && cargo test --lib git_history::tests`
Expected: 4 tests pass. (If `cargo` reports the module isn't found, confirm the `pub mod git_history;` line was added.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/git_history/mod.rs src-tauri/src/lib.rs
git commit -m "feat(git-history): parse_log + rel_path helpers with tests"
```

---

## Task 2: Rust — the three commands + integration test against a temp repo

**Files:**
- Modify: `src-tauri/src/git_history/mod.rs`
- Modify: `src-tauri/src/lib.rs` (register commands in the `#[cfg(not(target_os = "ios"))]` `generate_handler!` block, ~lines 768-826)

- [ ] **Step 1: Write a failing integration test that drives real git**

Append to the `tests` module in `src-tauri/src/git_history/mod.rs` (inside `mod tests`, before its closing brace):

```rust
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .unwrap();
        assert!(status.success(), "git {:?} failed", args);
    }

    #[test]
    fn log_show_at_roundtrip_in_temp_repo() {
        let dir = std::env::temp_dir().join(format!("mdeditor-gh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        let file = dir.join("note.md");
        std::fs::write(&file, "v1\n").unwrap();
        git(&dir, &["add", "note.md"]);
        git(&dir, &["commit", "-q", "-m", "first"]);
        std::fs::write(&file, "v2\n").unwrap();
        git(&dir, &["add", "note.md"]);
        git(&dir, &["commit", "-q", "-m", "second"]);

        let repo = dir.to_string_lossy().to_string();
        let abs = file.to_string_lossy().to_string();

        let log = git_file_log(repo.clone(), abs.clone()).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "second"); // newest first
        assert_eq!(log[1].subject, "first");

        let old = log[1].hash.clone();
        let content = git_file_at(repo.clone(), old.clone(), abs.clone()).unwrap();
        assert_eq!(content, "v1\n");

        let diff = git_file_show(repo.clone(), log[0].hash.clone(), abs.clone()).unwrap();
        assert!(diff.contains("-v1"));
        assert!(diff.contains("+v2"));

        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run it to confirm it fails (commands not defined yet)**

Run: `cd src-tauri && cargo test --lib git_history::tests::log_show_at_roundtrip_in_temp_repo`
Expected: FAIL to compile — `cannot find function git_file_log` (and the two others).

- [ ] **Step 3: Implement the three commands**

Add to `src-tauri/src/git_history/mod.rs` (after `rel_path`, before `#[cfg(test)]`):

```rust
/// The `git log` format string. Newest commit first, one line each.
fn log_format() -> String {
    format!("--format=%H{FS}%h{FS}%an{FS}%at{FS}%s")
}

/// Commit history for a single file. Returns an empty list when the file has no
/// history; returns `Err("git-unavailable")` when git isn't runnable so the UI
/// can show a distinct empty state.
#[tauri::command]
pub fn git_file_log(repo: String, abs_path: String) -> Result<Vec<GitCommit>, String> {
    if git_ops::version().is_none() {
        return Err("git-unavailable".to_string());
    }
    let repo_path = Path::new(&repo);
    let rel = rel_path(repo_path, Path::new(&abs_path))?;
    let out = git_ops::run_git(
        repo_path,
        &["log", "--follow", &log_format(), "--", &rel],
    )?;
    Ok(parse_log(&out))
}

/// Full `git show <rev>` diff limited to the file (includes the commit header).
#[tauri::command]
pub fn git_file_show(repo: String, rev: String, abs_path: String) -> Result<String, String> {
    let repo_path = Path::new(&repo);
    let rel = rel_path(repo_path, Path::new(&abs_path))?;
    git_ops::run_git(repo_path, &["show", &rev, "--", &rel])
}

/// File contents as of `<rev>` (`git show <rev>:<rel>`), for buffer restore.
#[tauri::command]
pub fn git_file_at(repo: String, rev: String, abs_path: String) -> Result<String, String> {
    let repo_path = Path::new(&repo);
    let rel = rel_path(repo_path, Path::new(&abs_path))?;
    let spec = format!("{rev}:{rel}");
    git_ops::run_git(repo_path, &["show", &spec])
}
```

- [ ] **Step 4: Run the integration test — expect PASS**

Run: `cd src-tauri && cargo test --lib git_history`
Expected: all 5 tests pass. (Requires `git` on PATH — it is, this is a git repo.)

- [ ] **Step 5: Register the commands**

In `src-tauri/src/lib.rs`, inside the `#[cfg(not(target_os = "ios"))]` `tauri::generate_handler![ ... ]` block (the one starting ~line 768), add after the `sotvault::sotvault_accept_current,` line:

```rust
                git_history::git_file_log,
                git_history::git_file_show,
                git_history::git_file_at,
```

- [ ] **Step 6: Verify the crate builds**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/git_history/mod.rs src-tauri/src/lib.rs
git commit -m "feat(git-history): git_file_log/show/at commands + integration test"
```

---

## Task 3: Plugin manifest

**Files:**
- Create: `src-tauri/plugins/git-history/manifest.json`

- [ ] **Step 1: Create the manifest**

```json
{
  "id": "git-history",
  "name": "Git History",
  "version": "0.1.0",
  "description": "View the git commit history of the current vault file; diff or restore any past version.",
  "kind": "builtin",
  "default_enabled": false,
  "host_capabilities": [],
  "menus": [
    {
      "location": "view",
      "label": "History View",
      "shortcut": "Cmd+Shift+Y",
      "command": "toggle",
      "enabled_when": "vaultConfigured"
    }
  ],
  "i18n": {
    "zh": {
      "name": "Git 历史",
      "description": "查看当前 vault 文件的 git 提交历史；对任一历史版本查看差异或恢复。",
      "menus": { "toggle": "历史视图" }
    },
    "ja": {
      "name": "Git 履歴",
      "description": "現在の vault ファイルの git コミット履歴を表示し、任意の版を差分表示または復元します。",
      "menus": { "toggle": "履歴ビュー" }
    }
  }
}
```

- [ ] **Step 2: Verify it parses (Rust manifest walk deserializes it)**

Run: `cd src-tauri && cargo test --lib plugin_host`
Expected: existing plugin_host tests still pass (this confirms the manifest schema — `default_enabled`, `enabled_when`, `kind:"builtin"` — is all already supported).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/plugins/git-history/manifest.json
git commit -m "feat(git-history): builtin plugin manifest (opt-in, View menu toggle)"
```

---

## Task 4: Frontend pure logic — historyAppliesTo + relTime

**Files:**
- Modify: `src/lib/sotvault-logic.ts` (export the existing private `isUnder`)
- Create: `src/lib/git-history/applies.ts`
- Create: `src/lib/git-history/applies.test.ts`
- Create: `src/lib/git-history/types.ts`

- [ ] **Step 1: Export `isUnder` from sotvault-logic**

In `src/lib/sotvault-logic.ts`, change the private `isUnder` (currently `function isUnder(...)`) to be exported:

```ts
export function isUnder(path: string, root: string): boolean {
  if (path === root) return true
  const r = root.endsWith('/') ? root : root + '/'
  return path.startsWith(r)
}
```

- [ ] **Step 2: Create the TS type**

Create `src/lib/git-history/types.ts`:

```ts
/** One commit that touched a file. Mirrors Rust `git_history::GitCommit`. */
export interface GitCommit {
  hash: string
  short: string
  author: string
  /** Unix seconds (author date). */
  timestamp: number
  subject: string
}
```

- [ ] **Step 3: Write the failing tests**

Create `src/lib/git-history/applies.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { historyAppliesTo, relTime } from './applies'

describe('historyAppliesTo', () => {
  it('true when the file is under the vault root', () => {
    expect(historyAppliesTo({ filePath: '/vault/Sync/a.md' }, '/vault')).toBe(true)
  })
  it('false when the file is outside the vault root', () => {
    expect(historyAppliesTo({ filePath: '/other/a.md' }, '/vault')).toBe(false)
  })
  it('false when there is no vault root', () => {
    expect(historyAppliesTo({ filePath: '/vault/a.md' }, null)).toBe(false)
  })
  it('false for an untitled tab (empty path)', () => {
    expect(historyAppliesTo({ filePath: '' }, '/vault')).toBe(false)
  })
  it('false when tab is null', () => {
    expect(historyAppliesTo(null, '/vault')).toBe(false)
  })
})

describe('relTime', () => {
  const now = 1_700_000_000 // seconds
  it('"just now" within a minute', () => {
    expect(relTime(now - 5, now)).toBe('just now')
  })
  it('minutes', () => {
    expect(relTime(now - 120, now)).toBe('2m')
  })
  it('hours', () => {
    expect(relTime(now - 3 * 3600, now)).toBe('3h')
  })
  it('days', () => {
    expect(relTime(now - 2 * 86400, now)).toBe('2d')
  })
})
```

- [ ] **Step 4: Run to confirm failure**

Run: `pnpm vitest run src/lib/git-history/applies.test.ts`
Expected: FAIL — cannot resolve `./applies`.

- [ ] **Step 5: Implement `applies.ts`**

Create `src/lib/git-history/applies.ts`:

```ts
import { isUnder } from '../sotvault-logic'

/** True when the tab's file lives inside the configured vault repo (so it has
 *  git history). Pure — no runes/tauri imports, so it's unit-testable. */
export function historyAppliesTo(
  tab: { filePath: string } | null,
  vaultRoot: string | null,
): boolean {
  if (!tab || !tab.filePath || !vaultRoot) return false
  return isUnder(tab.filePath, vaultRoot)
}

/** Compact relative time for a Unix-seconds timestamp. `now` (seconds) is
 *  injectable for deterministic tests; defaults to the wall clock. */
export function relTime(ts: number, now: number = Date.now() / 1000): string {
  const s = Math.max(0, Math.floor(now - ts))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
```

- [ ] **Step 6: Run to confirm pass**

Run: `pnpm vitest run src/lib/git-history/applies.test.ts`
Expected: all 9 assertions pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sotvault-logic.ts src/lib/git-history/applies.ts src/lib/git-history/applies.test.ts src/lib/git-history/types.ts
git commit -m "feat(git-history): historyAppliesTo + relTime pure helpers with tests"
```

---

## Task 5: Frontend gate store

**Files:**
- Create: `src/lib/git-history/gate.svelte.ts`

- [ ] **Step 1: Create the gate (mirror `src/lib/outline/gate.svelte.ts`)**

Create `src/lib/git-history/gate.svelte.ts`:

```ts
import { Store } from '@tauri-apps/plugin-store'
import { isPluginEnabled } from '../settings.svelte'

export { historyAppliesTo, relTime } from './applies'

export const PLUGIN_ID = 'git-history'
export const DEFAULT_WIDTH = 360
export const MIN_WIDTH = 240
export const MAX_WIDTH = 640

export const historyGate = $state<{ enabled: boolean; visible: boolean; width: number }>({
  enabled: false,
  visible: false,
  width: DEFAULT_WIDTH,
})

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

/** Call after settings hydration (same timing as loadOutlineGate). */
export async function loadHistoryGate(): Promise<void> {
  historyGate.enabled = isPluginEnabled(PLUGIN_ID)
  const s = await getStore()
  historyGate.visible = (await s.get<boolean>('history.visible')) ?? false
  historyGate.width = (await s.get<number>('history.width')) ?? DEFAULT_WIDTH
}

export async function setHistoryVisible(v: boolean): Promise<void> {
  historyGate.visible = v
  const s = await getStore()
  await s.set('history.visible', v)
  await s.save()
}

/** Update width in state only (clamped, no persist). Call during drag. */
export function setHistoryWidthLive(w: number): void {
  historyGate.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w))
}

export async function setHistoryWidth(w: number): Promise<void> {
  const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)))
  historyGate.width = clamped
  const s = await getStore()
  await s.set('history.width', clamped)
  await s.save()
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: no new errors from `git-history/gate.svelte.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/git-history/gate.svelte.ts
git commit -m "feat(git-history): gate store (enabled/visible/width, persisted)"
```

---

## Task 6: `openTextTab` helper for the read-only diff tab

**Files:**
- Modify: `src/lib/tabs.svelte.ts`
- Modify: `src/lib/tabs.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/tabs.test.ts` (append a new test; keep existing imports — add `openTextTab` to the import from `./tabs.svelte` if it destructures, otherwise import it):

```ts
import { openTextTab, tabs, activeId, isDirty } from './tabs.svelte'

describe('openTextTab', () => {
  it('opens a non-dirty active code tab with the given content', () => {
    tabs.length = 0
    activeId.value = null
    openTextTab({ title: 'abc123 · note.md.diff', content: 'diff --git a b\n', language: 'diff' })
    expect(tabs.length).toBe(1)
    const t = tabs[0]
    expect(activeId.value).toBe(t.id)
    expect(t.kind).toBe('code')
    expect(t.language).toBe('diff')
    expect(t.filePath).toBe('')
    expect(isDirty(t.id)).toBe(false)
  })
})
```

> Note: if `tabs.test.ts` already imports some of these names, merge rather than duplicate the import line.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run src/lib/tabs.test.ts -t openTextTab`
Expected: FAIL — `openTextTab is not a function`.

- [ ] **Step 3: Implement `openTextTab`**

Add to `src/lib/tabs.svelte.ts` (after the `setContent` function, ~line 227):

```ts
/**
 * Open an in-memory, unsaved tab holding read-only-ish generated text (e.g. a
 * git diff). It has no filePath and `initialContent === currentContent`, so it
 * is never dirty and closes without a save prompt. Not watched, not persisted.
 */
export function openTextTab(opts: {
  title: string
  content: string
  kind?: FileKind
  language?: string
}): void {
  const tab: Tab = {
    id: crypto.randomUUID(),
    filePath: '',
    title: opts.title,
    initialContent: opts.content,
    currentContent: opts.content,
    mode: 'source',
    kind: opts.kind ?? 'code',
    language: opts.language,
    externalState: 'fresh',
    externalBannerDismissed: false,
    lastKnownMtime: 0,
    lastKnownHash: '',
    pendingExternal: undefined,
  }
  tabs.push(tab)
  activeId.value = tab.id
  notifyInsights('onActiveDocChanged')
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/lib/tabs.test.ts -t openTextTab`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tabs.svelte.ts src/lib/tabs.test.ts
git commit -m "feat(tabs): openTextTab helper for ephemeral read-only text (diff) tabs"
```

---

## Task 7: i18n keys

**Files:**
- Modify: `src/lib/i18n/en.ts`
- Modify: `src/lib/i18n/zh.ts`
- Modify: `src/lib/i18n/ja.ts`

- [ ] **Step 1: Add English keys**

In `src/lib/i18n/en.ts`, add after the `'outline.*'` block (after the line `'outline.dailyNeedsVault': ...`):

```ts
  'history.title': 'History',
  'history.hide': 'Hide history',
  'history.refresh': 'Refresh',
  'history.diff': 'View diff',
  'history.restore': 'Restore this version',
  'history.restored': 'Restored into the editor — unsaved. Press ⌘S to keep it.',
  'history.noDocument': 'Open a file to see its history',
  'history.notInVault': 'This file is not in a vault — no git history',
  'history.gitUnavailable': 'git was not found on this system',
  'history.empty': 'No history for this file yet',
  'history.loadFailed': 'Could not load history',
  'history.diffTitle': '{short} · {name}.diff',
```

- [ ] **Step 2: Add Simplified Chinese keys**

In `src/lib/i18n/zh.ts`, add after the `'outline.*'` block:

```ts
  'history.title': '历史',
  'history.hide': '隐藏历史',
  'history.refresh': '刷新',
  'history.diff': '查看差异',
  'history.restore': '恢复此版本',
  'history.restored': '已恢复到编辑器（未保存），按 ⌘S 保留。',
  'history.noDocument': '打开文件以查看其历史',
  'history.notInVault': '该文件不在 vault 中，没有 git 历史',
  'history.gitUnavailable': '系统中未找到 git',
  'history.empty': '该文件暂无历史记录',
  'history.loadFailed': '无法加载历史',
  'history.diffTitle': '{short} · {name}.diff',
```

- [ ] **Step 3: Add Japanese keys**

In `src/lib/i18n/ja.ts`, add after the `'outline.*'` block:

```ts
  'history.title': '履歴',
  'history.hide': '履歴を隠す',
  'history.refresh': '更新',
  'history.diff': '差分を表示',
  'history.restore': 'この版を復元',
  'history.restored': 'エディタに復元しました（未保存）。⌘S で保存します。',
  'history.noDocument': 'ファイルを開くと履歴が表示されます',
  'history.notInVault': 'このファイルは vault にありません — git 履歴なし',
  'history.gitUnavailable': 'git が見つかりませんでした',
  'history.empty': 'このファイルの履歴はまだありません',
  'history.loadFailed': '履歴を読み込めませんでした',
  'history.diffTitle': '{short} · {name}.diff',
```

- [ ] **Step 4: Type-check the i18n tables**

Run: `pnpm check`
Expected: no errors. (The self-rolled i18n `t()` interpolates `{short}`/`{name}` at call sites — no schema constraint beyond string values.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts
git commit -m "feat(git-history): i18n strings (en/zh/ja)"
```

---

## Task 8: HistoryPanel component

**Files:**
- Create: `src/components/history/HistoryPanel.svelte`

- [ ] **Step 1: Create the panel**

Create `src/components/history/HistoryPanel.svelte`:

```svelte
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import type { Tab } from '../../lib/tabs.svelte'
  import { openTextTab, setContent } from '../../lib/tabs.svelte'
  import { basename } from '../../lib/fs'
  import { t } from '../../lib/i18n/store.svelte'
  import { pushToast } from '../../lib/toast.svelte'
  import { sotvaultStore } from '../../lib/sotvault.svelte'
  import {
    historyGate, setHistoryWidth, setHistoryWidthLive, setHistoryVisible, historyAppliesTo, relTime,
  } from '../../lib/git-history/gate.svelte'
  import type { GitCommit } from '../../lib/git-history/types'

  let { tab }: { tab: Tab | null } = $props()

  let commits = $state<GitCommit[]>([])
  let selected = $state<string | null>(null)
  let state = $state<'loading' | 'ready' | 'not-applicable' | 'git-unavailable' | 'error'>('loading')

  let vaultRoot = $derived(sotvaultStore.vaultRoot)
  let applicable = $derived(historyAppliesTo(tab, vaultRoot))

  async function load() {
    selected = null
    if (!tab || !applicable || !vaultRoot) {
      commits = []
      state = 'not-applicable'
      return
    }
    state = 'loading'
    try {
      commits = await invoke<GitCommit[]>('git_file_log', { repo: vaultRoot, absPath: tab.filePath })
      state = 'ready'
    } catch (e) {
      commits = []
      state = String(e).includes('git-unavailable') ? 'git-unavailable' : 'error'
      if (state === 'error') console.warn('[git-history] log:', e)
    }
  }

  // Reload whenever the active file changes (or applicability flips).
  $effect(() => {
    // read deps so the effect re-runs on tab/vault change:
    void tab?.id; void tab?.filePath; void applicable
    void load()
  })

  async function onDiff(c: GitCommit) {
    if (!tab || !vaultRoot) return
    try {
      const diff = await invoke<string>('git_file_show', { repo: vaultRoot, rev: c.hash, absPath: tab.filePath })
      const title = t('history.diffTitle', { short: c.short, name: basename(tab.filePath) })
      openTextTab({ title, content: diff, kind: 'code', language: 'diff' })
    } catch (e) {
      pushToast({ level: 'error', message: t('history.loadFailed'), detail: String(e) })
    }
  }

  async function onRestore(c: GitCommit) {
    if (!tab || !vaultRoot) return
    try {
      const content = await invoke<string>('git_file_at', { repo: vaultRoot, rev: c.hash, absPath: tab.filePath })
      setContent(tab.id, content)
      pushToast({ level: 'success', message: t('history.restored') })
    } catch (e) {
      pushToast({ level: 'error', message: t('history.loadFailed'), detail: String(e) })
    }
  }

  let startX = 0
  let startW = 0
  function onSplitterDown(e: PointerEvent) {
    startX = e.clientX; startW = historyGate.width
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onSplitterMove(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    setHistoryWidthLive(startW + (startX - e.clientX))
  }
  function onSplitterUp(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    void setHistoryWidth(historyGate.width)
  }
</script>

<aside class="history-panel" style="width: {historyGate.width}px">
  <div class="splitter" onpointerdown={onSplitterDown} onpointermove={onSplitterMove} onpointerup={onSplitterUp}></div>
  <header>
    <button class="hbtn" title={t('history.hide')} aria-label={t('history.hide')} onclick={() => void setHistoryVisible(false)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="15" y1="3" x2="15" y2="21" />
        <polyline points="8 9 11 12 8 15" />
      </svg>
    </button>
    <span class="title">{t('history.title')}</span>
    <button class="hbtn" title={t('history.refresh')} aria-label={t('history.refresh')} onclick={() => void load()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    </button>
  </header>

  {#if state === 'not-applicable'}
    <div class="body"><p class="empty">{tab == null ? t('history.noDocument') : t('history.notInVault')}</p></div>
  {:else if state === 'git-unavailable'}
    <div class="body"><p class="empty">{t('history.gitUnavailable')}</p></div>
  {:else if state === 'error'}
    <div class="body"><p class="empty">{t('history.loadFailed')}</p></div>
  {:else if state === 'ready' && commits.length === 0}
    <div class="body"><p class="empty">{t('history.empty')}</p></div>
  {:else}
    <div class="body">
      <ul class="commits">
        {#each commits as c (c.hash)}
          <li class="commit" class:selected={selected === c.hash}>
            <button class="row" onclick={() => (selected = selected === c.hash ? null : c.hash)}>
              <span class="subject">{c.subject}</span>
              <span class="meta">{c.short} · {relTime(c.timestamp)} · {c.author}</span>
            </button>
            {#if selected === c.hash}
              <div class="actions">
                <button class="abtn" onclick={() => void onDiff(c)}>{t('history.diff')}</button>
                <button class="abtn" onclick={() => void onRestore(c)}>{t('history.restore')}</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</aside>

<style>
  .history-panel {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color, #3333);
    overflow: hidden;
  }
  .splitter {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 4px;
    cursor: col-resize;
    z-index: 5;
    touch-action: none;
  }
  header {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    border-bottom: 1px solid var(--border-color, #3333);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .title { flex: 1; }
  .hbtn {
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; background: transparent; cursor: pointer;
    padding: 3px; border-radius: 4px; opacity: 0.7;
  }
  .hbtn svg { display: block; }
  .hbtn:hover { background: rgba(0,0,0,0.08); opacity: 1; }
  .body { flex: 1; overflow-y: auto; padding: 8px; }
  .empty { opacity: 0.5; font-size: 12px; }
  .commits { list-style: none; margin: 0; padding: 0; }
  .commit { border-radius: 6px; }
  .commit.selected { background: rgba(0,0,0,0.06); }
  .row {
    display: flex; flex-direction: column; gap: 2px;
    width: 100%; text-align: left;
    border: 0; background: transparent; cursor: pointer;
    padding: 6px 8px; border-radius: 6px;
  }
  .row:hover { background: rgba(0,0,0,0.05); }
  .subject { font-size: 13px; }
  .meta { font-size: 11px; opacity: 0.6; }
  .actions { display: flex; gap: 6px; padding: 2px 8px 8px; }
  .abtn {
    font-size: 12px; padding: 3px 8px; border-radius: 4px;
    border: 1px solid var(--border-color, #3335); background: transparent; cursor: pointer;
  }
  .abtn:hover { background: rgba(0,0,0,0.06); }
  @media (prefers-color-scheme: dark) {
    .hbtn:hover, .row:hover, .abtn:hover { background: rgba(255,255,255,0.1); }
    .commit.selected { background: rgba(255,255,255,0.08); }
  }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: no errors from `HistoryPanel.svelte`.

- [ ] **Step 3: Commit**

```bash
git add src/components/history/HistoryPanel.svelte
git commit -m "feat(git-history): HistoryPanel (commit list, inline diff/restore, empty states)"
```

---

## Task 9: Wire into App.svelte

**Files:**
- Modify: `src/App.svelte`

- [ ] **Step 1: Add imports**

Near the outline gate import (`src/App.svelte:49`), add:

```ts
  import { historyGate, loadHistoryGate, setHistoryVisible, historyAppliesTo } from './lib/git-history/gate.svelte'
```

- [ ] **Step 2: Load the gate at boot**

In the boot sequence, right after `await loadOutlineGate()` (`src/App.svelte:197`), add:

```ts
      await loadHistoryGate()
```

- [ ] **Step 3: Add the dispatch branch + mutual exclusion**

In `dispatchPlugin` (`src/App.svelte:329+`), replace the existing outline branch:

```ts
        if (pluginId === 'outline-notes') {
          if (command === 'toggle') await setOutlineVisible(!outlineGate.visible)
          return
        }
```

with (adds "hide history when opening outline"):

```ts
        if (pluginId === 'outline-notes') {
          if (command === 'toggle') {
            const next = !outlineGate.visible
            await setOutlineVisible(next)
            if (next) await setHistoryVisible(false)
          }
          return
        }
        if (pluginId === 'git-history') {
          if (command === 'toggle') {
            const next = !historyGate.visible
            await setHistoryVisible(next)
            if (next) await setOutlineVisible(false)
          }
          return
        }
```

- [ ] **Step 4: Add the `showHistoryPanel` derived and widen the float offset**

After the `showOutlinePanel` derived (`src/App.svelte:621-624`) and its `outlineRightOffset` line (`:629`), add / adjust:

```ts
  let showHistoryPanel = $derived(
    platformName !== 'ios' && historyGate.enabled && historyGate.visible
      && current != null && historyAppliesTo(current, sotvaultStore.vaultRoot)
  )
```

Change the `outlineRightOffset` derived (`:629`) to account for either panel:

```ts
  let outlineRightOffset = $derived(
    showHistoryPanel ? historyGate.width : showOutlinePanel ? outlineGate.width : 0
  )
```

- [ ] **Step 5: Render the panel**

In the `.pane` section, right after the `showOutlinePanel` block (`src/App.svelte:712-716`), add:

```svelte
    {#if showHistoryPanel}
      {#await import('./components/history/HistoryPanel.svelte') then Panel}
        <Panel.default tab={current ?? null} />
      {/await}
    {/if}
```

- [ ] **Step 6: Type-check + build the frontend**

Run: `pnpm check && pnpm build`
Expected: no type errors; Vite build succeeds.

- [ ] **Step 7: Run the full unit-test suite**

Run: `pnpm test`
Expected: all tests pass (including the new `applies.test.ts` and `tabs.test.ts` cases).

- [ ] **Step 8: Commit**

```bash
git add src/App.svelte
git commit -m "feat(git-history): wire panel into App (toggle, outline mutual-exclusion, render)"
```

---

## Task 10: Manual GUI verification (dev build)

> Per project convention, window/layout changes require real dev-GUI verification (see the `dev GUI 实机验证` and `GUI 验证与并行会话隔离` memories). Confirm the desktop is free of parallel sessions first.

**Files:** none (verification only)

- [ ] **Step 1: Confirm the full test + check suite is green**

Run: `pnpm check && pnpm test && (cd src-tauri && cargo test --lib git_history)`
Expected: all green. Record the output.

- [ ] **Step 2: Launch a dev build and verify behaviour**

Start the app (`pnpm tauri dev` or the project's dev-launch skill), then verify with osascript-driven windows + screenshots to `/tmp/mdeditor.log`:

1. Enable the **Git History** plugin in Settings ▸ Plugins (it is OFF by default). Restart if the menu needs a rebuild.
2. With **no vault configured**, confirm View ▸ *History View* is greyed out (`enabled_when: vaultConfigured`).
3. Configure a vault, open a file **inside** the vault. View ▸ *History View* (⌘⇧Y) shows the right panel with the file's commit list.
4. Open a file **outside** the vault → panel shows "not in a vault" empty state.
5. Toggle *Outliner View* (⌘⇧O) while History is open → History hides (and vice-versa): **mutual exclusion**.
6. Click a commit → inline **View diff** / **Restore this version** appear.
7. **View diff** → a new read-only `*.diff` code tab opens with the coloured unified diff.
8. **Restore this version** → the editor buffer changes to that version and the tab goes **dirty** (dot), file on disk unchanged until ⌘S.
9. **Refresh** button re-pulls the log; **Hide** button closes the panel.
10. Drag the splitter → width changes and persists across app restart.

- [ ] **Step 3: Record evidence and report**

Capture screenshots for steps 3, 5, 7, 8. Report pass/fail per numbered check with the evidence. Do not claim completion without the screenshots.

---

## Self-Review Notes (spec coverage)

- Opt-in load → Task 3 manifest `default_enabled: false` + Task 10 step 1.
- View-menu "History View" → Task 3 menu entry (auto-collected by `plugin_host`).
- Vault-only + git history → Tasks 1-2 commands, Task 4 `historyAppliesTo`, Task 9 `showHistoryPanel`.
- Outline-parallel, switchable, mutually exclusive → Task 9 dispatch mutual-exclusion + shared `.pane` slot.
- Show/hide → Task 5 `setHistoryVisible`, Task 8 hide button, Task 9 toggle.
- List history, click → diff/restore → Task 8 panel actions.
- Diff = read-only tab → Task 6 `openTextTab` + Task 8 `onDiff`.
- Restore = editor buffer only → Task 8 `onRestore` via `setContent`.
- Toolbar refresh + hide buttons → Task 8 header.
- i18n → Task 7.
- Tests: Rust parse/rel/integration (Tasks 1-2), TS applies/relTime (Task 4), openTextTab (Task 6); GUI (Task 10).
