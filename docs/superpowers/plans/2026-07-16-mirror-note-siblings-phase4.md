# Mirror-hosted marks — Phase 4 Implementation Plan (multi-device note siblings: discover + open)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the document you're working on has **sibling mirrors on other devices** (same content = same `checksum`, a different mirror file each), surface them and let you open each sibling's `.note.md` to read/copy its annotations. No automatic note modification — zero data-loss risk.

**Scope decision (user-confirmed):** "Discover + open", NOT automatic merge. Automatic 3-way/append note merge is deferred together with concurrent same-note editing.

**Phase 3 note:** Session-time source↔mirror md consistency is ALREADY implemented (pre-existing `pushSourceToVaultIfTracked`, wired into `saveActive`/`saveTab`/`autosave`: `origin_updated`→silent apply, `conflict`→prompt). No Phase-3 code is needed.

**Architecture:** A pure `sibling_mirrors()` grouping helper in `mirror_meta.rs` + a `notemd_mirror_note_siblings` command that, given the open doc path (a mirror OR its source), resolves the doc's mirror + checksum and returns the sibling mirrors' companion-note paths + device names (only siblings that actually have a `.note.md`). A new `MirrorSiblingsBanner.svelte` renders those as "open note" buttons, next to `SyncOriginBanner` in `EditorPane`.

**Tech Stack:** Rust (serde_json, tempfile tests), Tauri command, Svelte 5, Vitest.

Spec: `docs/superpowers/specs/2026-07-16-mirror-hosted-marks-design.md` §⑤.

---

## File Structure

- Modify: `src-tauri/src/sotvault/mirror_meta.rs` — pure `sibling_mirrors()` helper + tests.
- Modify: `src-tauri/src/sotvault/mod.rs` — `notemd_mirror_note_siblings` command (+ a `NoteSibling` serde struct).
- Modify: `src-tauri/src/lib.rs` — register the command.
- Modify: `src/lib/sotvault.svelte.ts` — `noteSiblings(path)` wrapper.
- Create: `src/components/MirrorSiblingsBanner.svelte` — the discover/open banner.
- Modify: `src/components/EditorPane.svelte` — render `MirrorSiblingsBanner` beside `SyncOriginBanner`.
- Modify: `src/lib/i18n/en.ts`, `zh.ts`, `ja.ts`, `de.ts` — `mirrorSiblings.*` keys.

---

## Task 1: Backend — `sibling_mirrors` helper + `notemd_mirror_note_siblings` command

**Files:**
- Modify: `src-tauri/src/sotvault/mirror_meta.rs` (helper + tests)
- Modify: `src-tauri/src/sotvault/mod.rs` (command)
- Modify: `src-tauri/src/lib.rs` (register)

- [ ] **Step 1: Write failing tests for the pure helper**

In `mirror_meta.rs` `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    fn sibling_mirrors_same_checksum_distinct_files() {
        let metas = vec![
            meta("sync/a.md", "d1", "/a/x.md"),        // checksum sha256:abc (helper default)
            meta("sync/b.md", "d2", "/b/x.md"),        // same content, other device/file
            meta("sync/a.md", "d3", "/c/x.md"),        // same mirror as #1 → not a sibling
        ];
        let sibs = sibling_mirrors(&metas, "sync/a.md", "sha256:abc");
        assert_eq!(sibs.len(), 1);
        assert_eq!(sibs[0].mirror, "sync/b.md");
    }

    #[test]
    fn sibling_mirrors_ignores_other_checksums_and_self() {
        let mut other = meta("sync/c.md", "d9", "/d/y.md");
        other.checksum = "sha256:zzz".into();
        let metas = vec![meta("sync/a.md", "d1", "/a/x.md"), other];
        assert!(sibling_mirrors(&metas, "sync/a.md", "sha256:abc").is_empty());
    }
```

Add the stub:

```rust
/// Distinct sibling mirrors of `mirror_rel`: metas with the same `checksum` but
/// a DIFFERENT mirror path (i.e. the same content mirrored as a separate file,
/// typically on another device). Deduped to one entry per distinct mirror path.
pub fn sibling_mirrors(metas: &[MirrorMeta], mirror_rel: &str, checksum: &str) -> Vec<MirrorMeta> {
    unimplemented!()
}
```

- [ ] **Step 2: Run — expect fail**

Run: `cd src-tauri && cargo test --lib sotvault::mirror_meta::tests::sibling`
Expected: 2 fail (`not implemented`).

- [ ] **Step 3: Implement**

```rust
pub fn sibling_mirrors(metas: &[MirrorMeta], mirror_rel: &str, checksum: &str) -> Vec<MirrorMeta> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for m in metas {
        if m.checksum == checksum && m.mirror != mirror_rel && seen.insert(m.mirror.clone()) {
            out.push(m.clone());
        }
    }
    out
}
```

- [ ] **Step 4: Run — expect pass**

Run: `cd src-tauri && cargo test --lib sotvault::mirror_meta` → PASS.

- [ ] **Step 5: Add the command in `mod.rs`**

Add a serde struct (near the other command return types) and the command after `notemd_relink_mirror_source`:

```rust
/// A sibling mirror's companion note the UI can open.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSibling {
    /// Absolute path to the sibling mirror's `.note.md`.
    pub note_path: String,
    /// The device that created that sibling mirror (display label).
    pub device_name: String,
}

/// For the given open document (a mirror OR its source), find sibling mirrors on
/// other devices (same content = same checksum, different mirror file) and return
/// those that actually have a companion note, so the UI can offer to open them.
#[tauri::command]
pub fn notemd_mirror_note_siblings(app: AppHandle, doc_path: String) -> Result<Vec<NoteSibling>, String> {
    let vault_root = resolve_vault_root(&app).ok_or("Vault not configured")?;
    let metas = mirror_meta::read_all(&vault_root);
    let store = load_store(&app)?;

    // Resolve the open doc to a vault-relative mirror path.
    let doc = PathBuf::from(&doc_path);
    let self_rel = mirror_meta::relative_mirror(&vault_root, &doc);
    let mirror_rel = if metas.iter().any(|m| m.mirror == self_rel) {
        self_rel // the doc IS a mirror
    } else if let Some(rec) = store.find_by_source(&doc_path) {
        mirror_meta::relative_mirror(&vault_root, &PathBuf::from(&rec.vault_path))
    } else {
        return Ok(Vec::new()); // not a tracked mirror/source
    };

    let checksum = match metas.iter().find(|m| m.mirror == mirror_rel) {
        Some(m) => m.checksum.clone(),
        None => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    for sib in mirror_meta::sibling_mirrors(&metas, &mirror_rel, &checksum) {
        let mirror_abs = vault_root.join(&sib.mirror);
        if let Some(note) = companion_path(&mirror_abs) {
            if note.is_file() {
                out.push(NoteSibling {
                    note_path: note.to_string_lossy().to_string(),
                    device_name: sib.device_name,
                });
            }
        }
    }
    Ok(out)
}
```

(`companion_path` is the existing private fn in `mod.rs` that maps an md path → its `.note.md` path via `logic::companion_note_name`. Confirm its name/visibility; it's used by `reconcile_companion_notes`.)

- [ ] **Step 6: Register in `lib.rs`**

After `sotvault::notemd_relink_mirror_source,` add:

```rust
                sotvault::notemd_mirror_note_siblings,
```

- [ ] **Step 7: Verify**

Run: `cd src-tauri && cargo test --lib sotvault::` → PASS. `cargo check --lib` → clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/sotvault/mirror_meta.rs src-tauri/src/sotvault/mod.rs src-tauri/src/lib.rs
git commit -m "feat(mirror): notemd_mirror_note_siblings — discover other devices' notes for the same content

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Frontend — `noteSiblings` wrapper + banner + i18n

**Files:**
- Modify: `src/lib/sotvault.svelte.ts` (wrapper)
- Create: `src/components/MirrorSiblingsBanner.svelte`
- Modify: `src/components/EditorPane.svelte` (render it)
- Modify: `src/lib/i18n/en.ts`, `zh.ts`, `ja.ts`, `de.ts`

No automated test (Svelte component + thin invoke wrapper) — verify via typecheck + manual steps.

- [ ] **Step 1: Add the wrapper in `sotvault.svelte.ts`**

```ts
export interface NoteSibling { notePath: string; deviceName: string }

/** Sibling mirrors' notes (other devices, same content) for an open doc path. */
export async function noteSiblings(path: string | null): Promise<NoteSibling[]> {
  if (!path || !sotvaultStore.vaultRoot) return []
  return invoke<NoteSibling[]>('notemd_mirror_note_siblings', { docPath: path }).catch(() => [])
}
```

- [ ] **Step 2: Add i18n keys (all 4 files)**

`en.ts`:
```ts
  'mirrorSiblings.label': '🔗 Also annotated on {n} other device(s):',
  'mirrorSiblings.openNote': "Open {device}'s note",
```
`zh.ts`:
```ts
  'mirrorSiblings.label': '🔗 这份内容在另外 {n} 台设备上也有笔记：',
  'mirrorSiblings.openNote': '打开 {device} 的笔记',
```
`ja.ts`:
```ts
  'mirrorSiblings.label': '🔗 他の {n} 台の端末にもこの内容の注釈があります：',
  'mirrorSiblings.openNote': '{device} のノートを開く',
```
`de.ts`:
```ts
  'mirrorSiblings.label': '🔗 Auf {n} weiteren Gerät(en) ebenfalls annotiert:',
  'mirrorSiblings.openNote': 'Notiz von {device} öffnen',
```

(The `t()` helper supports `{name}` interpolation — see existing keys like `vault.err.generic`. `{n}` and `{device}` are passed at call sites.)

- [ ] **Step 3: Create `MirrorSiblingsBanner.svelte`**

```svelte
<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { noteSiblings, sotvaultStore, type NoteSibling } from '../lib/sotvault.svelte'
  import { openFile } from '../lib/tabs.svelte'
  import { t } from '../lib/i18n/store.svelte'

  let { tab }: { tab: Tab } = $props()

  let siblings = $state<NoteSibling[]>([])
  // Recompute when the tab path changes OR sotvault records/metas refresh (tick).
  $effect(() => {
    const path = tab.filePath
    void sotvaultStore.tick
    siblings = []
    if (!path) return
    noteSiblings(path).then((s) => { siblings = s })
  })
</script>

{#if siblings.length > 0}
  <div class="banner mirror-siblings" role="status" aria-live="polite">
    <span class="label">{t('mirrorSiblings.label', { n: siblings.length })}</span>
    {#each siblings as sib (sib.notePath)}
      <button class="action" onclick={() => openFile(sib.notePath)}>{t('mirrorSiblings.openNote', { device: sib.deviceName })}</button>
    {/each}
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 6px 10px;
    font-size: 12px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
  }
  .banner.mirror-siblings {
    background: #e2e3ff;
    color: #2f2b7a;
  }
  .label { white-space: nowrap; }
  .action {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    background: rgba(255, 255, 255, 0.5);
    color: inherit;
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
  }
  .action:hover { background: rgba(255, 255, 255, 0.85); }
</style>
```

- [ ] **Step 4: Render it in `EditorPane.svelte`**

Read `src/components/EditorPane.svelte`, import `MirrorSiblingsBanner`, and render it directly AFTER the existing `<SyncOriginBanner {tab} />` line (same place/condition context — it self-hides when there are no siblings):

```svelte
  import MirrorSiblingsBanner from './MirrorSiblingsBanner.svelte'
```
```svelte
  <SyncOriginBanner {tab} />
  <MirrorSiblingsBanner {tab} />
```

- [ ] **Step 5: Verify**

Run: `pnpm check 2>&1 | grep -E "COMPLETED|ERRORS"` → `0 ERRORS`.
Run: `npx vitest run 2>&1 | tail -3` → all pass (unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/lib/sotvault.svelte.ts src/components/MirrorSiblingsBanner.svelte src/components/EditorPane.svelte src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts src/lib/i18n/de.ts
git commit -m "feat(mirror): MirrorSiblingsBanner — open other devices' notes for the same content

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Manual verification (GUI — user runs)

1. Device A: annotate an outside-vault `foo.md` → mirror + note in vault; sync the vault (git).
2. Device B: pull the vault; open its own local copy of the same `foo.md` and annotate → B creates its own mirror + note (same checksum). Sync.
3. Device A: pull; open `foo.md` (or its mirror). The MirrorSiblingsBanner shows "Also annotated on 1 other device: [Open B's note]". Click → B's `.note.md` opens as a tab. A's own note is untouched.

## Definition of Done (Phase 4)

- `cargo test --lib` pass (incl. 2 new `sibling_mirrors` tests); `pnpm check` 0 errors; `pnpm test` pass.
- `notemd_mirror_note_siblings` returns only siblings (same checksum, different mirror) that have a `.note.md`, resolving the open doc via mirror OR source.
- Banner appears when siblings exist and opens each sibling's note; hidden otherwise. No note content is modified.

Out of scope (deferred): automatic note merge (3-way/append) and concurrent same-note editing. Retiring the app-support Record store.

---

## Overall initiative status after Phase 4

- P1 ✅ git-synced `.notemd/mirrors/` meta + migration + product principle.
- P2 ✅ open-in-vault edit-source (pre-existing) + relink when source absent + banner.
- P3 ✅ session-time source↔mirror consistency — already covered by pre-existing `pushSourceToVaultIfTracked`.
- P4 ✅ (this plan) multi-device note discovery + open.
- Deferred: automatic multi-device note merge; concurrent same-note editing; retiring the app-support Record store.
