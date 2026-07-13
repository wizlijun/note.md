# Sidecar Note 3-Way Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blind `std::fs::copy` overwrite of companion sidecar notes (`*.note.md`) during sotvault sync with a git-style 3-way merge that never loses hand-written note content.

**Architecture:** Add a `note_merge_base` (last-converged note content = merge ancestor) to each sotvault `Record`. A pure `reconcile_note(base, source, vault)` decides which side(s) to write and whether the result conflicts, using `diffy::merge` for the both-changed case. An IO wrapper reads/writes the two note files, backs up both originals to `.conflict.<ts>` on conflict, and returns the new base. Both sync commands (`sotvault_sync_to_vault`, `sotvault_apply_update`) fetch the prior base, reconcile, and persist the new base — making protection bidirectional.

**Tech Stack:** Rust (Tauri backend), `diffy` 0.5.0 (pure-Rust 3-way text merge), `serde`. Existing sotvault modules: `store.rs`, `logic.rs`, `mod.rs`. Reference spec: `docs/superpowers/specs/2026-07-13-sidecar-note-3way-merge-design.md`.

**Working directory for all commands:** `/Users/bruce/git/mdeditor/src-tauri` (the Rust crate). Tests run with `cargo test`.

**Commit hygiene (from repo memory):** This main worktree is often shared by sibling sessions. **Only `git add` the exact files each task names — never `git add -A`.** End every commit message with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## File Structure

- `src-tauri/Cargo.toml` — add `diffy = "0.5"` dependency.
- `src-tauri/src/sotvault/store.rs` — `Record` gains `note_merge_base: Option<String>` (`#[serde(default)]`).
- `src-tauri/src/sotvault/logic.rs` — new pure `reconcile_note` + `merge_notes` + `NotePlan`; unit tests.
- `src-tauri/src/sotvault/mod.rs` — new IO `reconcile_companion_notes` + helpers replacing `sync_companion_note`; wired into both commands; integration tests.
- (Task 5, OPTIONAL) `src-tauri/src/sotvault/mod.rs` emits an event; `src/lib/sotvault.svelte.ts` + `src/lib/i18n/en.ts` show a toast.

---

## Task 1: Add `diffy` dependency and `note_merge_base` field to `Record`

**Files:**
- Modify: `src-tauri/Cargo.toml` (main `[dependencies]`, near line 43-44)
- Modify: `src-tauri/src/sotvault/store.rs` (struct at lines 4-11; test helper at line 78)
- Modify: `src-tauri/src/sotvault/mod.rs:178` (explicit `Record` construction)
- Modify: `src-tauri/src/sotvault/logic.rs` (test helper `rec()` line 323; explicit `Record` at line 377)
- Test: `src-tauri/src/sotvault/store.rs` (tests module)

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`, under the main `[dependencies]` section, right after the `hex = "0.4"` line (line 44), add:

```toml
diffy = "0.5"
```

(diffy is pure Rust and cross-platform, so it belongs in the main `[dependencies]`, not a `[target.*]` block.)

- [ ] **Step 2: Add the field to `Record`**

In `src-tauri/src/sotvault/store.rs`, change the struct (lines 4-11) to:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub vault_path: String,
    pub source_path: String,
    pub synced_at: u64,
    pub source_hash: String,
    pub vault_hash: String,
    /// Last-converged companion-note content = the 3-way merge ancestor.
    /// `#[serde(default)]` keeps old `sotvault-sync.json` files loadable
    /// (missing key → `None`, which triggers the migration branch on next sync).
    #[serde(default)]
    pub note_merge_base: Option<String>,
}
```

- [ ] **Step 3: Fix all explicit `Record` constructions and test helpers so the crate compiles**

In `src-tauri/src/sotvault/store.rs`, the test helper `rec()` (line 78-86) — add the field:

```rust
    fn rec(vault: &str, source: &str) -> Record {
        Record {
            vault_path: vault.into(),
            source_path: source.into(),
            synced_at: 100,
            source_hash: "aaa".into(),
            vault_hash: "aaa".into(),
            note_merge_base: None,
        }
    }
```

In `src-tauri/src/sotvault/mod.rs:178`, the `Record { ... }` in `sotvault_sync_to_vault` — add `note_merge_base: None,` as the last field (Task 4 replaces it with the reconcile result):

```rust
    let rec = Record {
        vault_path: target.to_string_lossy().to_string(),
        source_path: source.to_string_lossy().to_string(),
        synced_at: now_secs(),
        source_hash,
        vault_hash,
        note_merge_base: None,
    };
```

In `src-tauri/src/sotvault/logic.rs`, the test helper `rec()` (line 323-331) — add the field:

```rust
    fn rec(source_hash: &str, vault_hash: &str) -> Record {
        Record {
            vault_path: "/vault/a.md".into(),
            source_path: "/src/a.md".into(),
            synced_at: 1,
            source_hash: source_hash.into(),
            vault_hash: vault_hash.into(),
            note_merge_base: None,
        }
    }
```

In `src-tauri/src/sotvault/logic.rs:377`, the explicit `Record` in `check_update_io_detects_origin_update` — add `note_merge_base: None,` as the last field:

```rust
        let r = Record {
            vault_path: vault.to_string_lossy().into(),
            source_path: source.to_string_lossy().into(),
            synced_at: 1,
            source_hash: sha256_hex(b"OLD"),
            vault_hash: sha256_hex(b"OLD"),
            note_merge_base: None,
        };
```

(The `Record { synced_at, source_hash, vault_hash, ..rec }` spreads at `mod.rs:259` and `mod.rs:278` already cover the new field via `..rec` — leave them for now; Task 4 edits line 259.)

- [ ] **Step 4: Write the failing test — old JSON (no field) round-trips to `None`**

In `src-tauri/src/sotvault/store.rs`, inside the `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    fn legacy_json_without_note_base_loads_as_none() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        // A store written before note_merge_base existed.
        let legacy = r#"{"version":1,"records":[
            {"vault_path":"/v/a.md","source_path":"/s/a.md",
             "synced_at":5,"source_hash":"h1","vault_hash":"h2"}]}"#;
        std::fs::write(&p, legacy).unwrap();
        let store = load_records(&p);
        assert_eq!(store.records.len(), 1);
        assert_eq!(store.records[0].note_merge_base, None);
    }

    #[test]
    fn note_base_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        let mut store = RecordStore::default();
        let mut r = rec("/v/a.md", "/s/a.md");
        r.note_merge_base = Some("- base line".into());
        store.upsert(r);
        save_records(&p, &store).unwrap();
        let loaded = load_records(&p);
        assert_eq!(loaded.records[0].note_merge_base.as_deref(), Some("- base line"));
    }
```

- [ ] **Step 5: Run tests to verify they pass (and the crate compiles)**

Run: `cargo test -p sotvault 2>/dev/null || cargo test sotvault::store`
Expected: the two new tests PASS; all existing sotvault tests still PASS.
(If unsure of the crate name, `cargo test sotvault` runs every test whose path contains `sotvault`.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/sotvault/store.rs src-tauri/src/sotvault/mod.rs src-tauri/src/sotvault/logic.rs
git commit -m "feat(sotvault): add note_merge_base field + diffy dep"
```

---

## Task 2: Pure `reconcile_note` decision function (with `diffy` merge)

**Files:**
- Modify: `src-tauri/src/sotvault/logic.rs` (add `NotePlan`, `reconcile_note`, `merge_notes` near the top, after `decide_update`; add tests in the tests module)

- [ ] **Step 1: Write the failing tests covering every decision-table row**

In `src-tauri/src/sotvault/logic.rs`, inside `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    fn reconcile_both_absent_is_noop() {
        let p = reconcile_note(Some("b"), None, None);
        assert_eq!(p, NotePlan { write_source: None, write_vault: None, new_base: Some("b".into()), conflict: false });
    }

    #[test]
    fn reconcile_only_source_copies_to_vault() {
        let p = reconcile_note(None, Some("S"), None);
        assert_eq!(p.write_vault.as_deref(), Some("S"));
        assert_eq!(p.write_source, None);
        assert_eq!(p.new_base.as_deref(), Some("S"));
        assert!(!p.conflict);
    }

    #[test]
    fn reconcile_only_vault_pulls_to_source() {
        let p = reconcile_note(None, None, Some("V"));
        assert_eq!(p.write_source.as_deref(), Some("V"));
        assert_eq!(p.write_vault, None);
        assert_eq!(p.new_base.as_deref(), Some("V"));
        assert!(!p.conflict);
    }

    #[test]
    fn reconcile_equal_sides_no_writes() {
        let p = reconcile_note(Some("old"), Some("same"), Some("same"));
        assert_eq!(p.write_source, None);
        assert_eq!(p.write_vault, None);
        assert_eq!(p.new_base.as_deref(), Some("same"));
        assert!(!p.conflict);
    }

    #[test]
    fn reconcile_source_only_changed_fast_forwards_vault() {
        // vault == base, source moved on
        let p = reconcile_note(Some("base"), Some("newS"), Some("base"));
        assert_eq!(p.write_vault.as_deref(), Some("newS"));
        assert_eq!(p.write_source, None);
        assert_eq!(p.new_base.as_deref(), Some("newS"));
        assert!(!p.conflict);
    }

    #[test]
    fn reconcile_vault_only_changed_fast_forwards_source() {
        // source == base, vault moved on
        let p = reconcile_note(Some("base"), Some("base"), Some("newV"));
        assert_eq!(p.write_source.as_deref(), Some("newV"));
        assert_eq!(p.write_vault, None);
        assert_eq!(p.new_base.as_deref(), Some("newV"));
        assert!(!p.conflict);
    }

    #[test]
    fn reconcile_both_changed_non_overlapping_auto_merges() {
        // base has a shared, unchanged middle line; source edits the first line
        // and vault edits the last. The untouched middle gives diffy the context
        // it needs to auto-merge the two non-overlapping changes. (diffy's
        // line-level merge needs a shared context line BETWEEN the two changed
        // regions — a 2-line doc with both lines changed collapses to a conflict.)
        let base = "alpha\nmiddle\nbeta\n";
        let source = "ALPHA\nmiddle\nbeta\n";
        let vault = "alpha\nmiddle\nBETA\n";
        let p = reconcile_note(Some(base), Some(source), Some(vault));
        assert!(!p.conflict, "non-overlapping edits should auto-merge");
        // both sides converge to the same merged text
        assert_eq!(p.write_source, p.write_vault);
        assert_eq!(p.write_source, p.new_base);
        let merged = p.new_base.unwrap();
        assert!(merged.contains("ALPHA"));
        assert!(merged.contains("BETA"));
        assert!(!merged.contains("<<<<<<<"));
    }

    #[test]
    fn reconcile_both_changed_same_line_conflicts() {
        let base = "hello\n";
        let source = "hello local\n";
        let vault = "hello vault\n";
        let p = reconcile_note(Some(base), Some(source), Some(vault));
        assert!(p.conflict, "competing edits to the same line must conflict");
        let merged = p.new_base.clone().unwrap();
        assert!(merged.contains("<<<<<<<"));
        assert!(merged.contains("hello local"));
        assert!(merged.contains("hello vault"));
        // converge both sides to the marked result
        assert_eq!(p.write_source.as_deref(), Some(merged.as_str()));
        assert_eq!(p.write_vault.as_deref(), Some(merged.as_str()));
    }

    #[test]
    fn reconcile_no_base_diverged_is_conflict() {
        // migration: no stored ancestor, and the two sides differ
        let p = reconcile_note(None, Some("localA\n"), Some("vaultB\n"));
        assert!(p.conflict);
        let merged = p.new_base.clone().unwrap();
        assert!(merged.contains("localA"));
        assert!(merged.contains("vaultB"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test sotvault::logic::tests::reconcile 2>&1 | tail -20`
Expected: FAIL — `cannot find function reconcile_note` / `cannot find type NotePlan`.

- [ ] **Step 3: Implement `NotePlan`, `reconcile_note`, `merge_notes`**

In `src-tauri/src/sotvault/logic.rs`, immediately after the `decide_update` function (after line 39), add:

```rust
/// What a companion-note reconcile decided. `write_source`/`write_vault` are the
/// contents to write to each side (`None` = leave that side untouched).
/// `new_base` is the content to persist as the next merge ancestor. `conflict`
/// is true when the merged text contains conflict markers — the caller then also
/// writes `.conflict.<ts>` backups of both original sides.
#[derive(Debug, Clone, PartialEq)]
pub struct NotePlan {
    pub write_source: Option<String>,
    pub write_vault: Option<String>,
    pub new_base: Option<String>,
    pub conflict: bool,
}

/// Pure 3-way reconcile of a companion note. `base` = last-converged content
/// (merge ancestor), `source`/`vault` = current contents (`None` = file absent).
/// Direction-agnostic: converges BOTH sides to the merged result so the pair
/// never re-diverges (writing only one side would make the next sync treat the
/// other side's unique lines as deletions). Missing base with diverged sides is
/// treated conservatively as a conflict (ancestor = "").
pub fn reconcile_note(base: Option<&str>, source: Option<&str>, vault: Option<&str>) -> NotePlan {
    match (source, vault) {
        (None, None) => NotePlan {
            write_source: None,
            write_vault: None,
            new_base: base.map(str::to_string),
            conflict: false,
        },
        (Some(s), None) => NotePlan {
            write_source: None,
            write_vault: Some(s.to_string()),
            new_base: Some(s.to_string()),
            conflict: false,
        },
        (None, Some(v)) => NotePlan {
            write_source: Some(v.to_string()),
            write_vault: None,
            new_base: Some(v.to_string()),
            conflict: false,
        },
        (Some(s), Some(v)) => {
            if s == v {
                return NotePlan {
                    write_source: None,
                    write_vault: None,
                    new_base: Some(s.to_string()),
                    conflict: false,
                };
            }
            // Fast-forward when exactly one side moved away from a known base.
            if let Some(b) = base {
                if s == b {
                    return NotePlan {
                        write_source: Some(v.to_string()),
                        write_vault: None,
                        new_base: Some(v.to_string()),
                        conflict: false,
                    };
                }
                if v == b {
                    return NotePlan {
                        write_source: None,
                        write_vault: Some(s.to_string()),
                        new_base: Some(s.to_string()),
                        conflict: false,
                    };
                }
            }
            // Both sides changed (or no base): 3-way merge, converge both sides.
            let ancestor = base.unwrap_or("");
            let (merged, conflict) = match merge_notes(ancestor, s, v) {
                Ok(m) => (m, false),
                Err(m) => (m, true),
            };
            NotePlan {
                write_source: Some(merged.clone()),
                write_vault: Some(merged.clone()),
                new_base: Some(merged),
                conflict,
            }
        }
    }
}

/// 3-way text merge via diffy. `Ok` = clean; `Err` = merged text carrying
/// classic `<<<<<<< ours` / `=======` / `>>>>>>> theirs` conflict markers
/// (ours = local source note, theirs = vault note).
fn merge_notes(ancestor: &str, ours: &str, theirs: &str) -> Result<String, String> {
    diffy::MergeOptions::new()
        .set_conflict_style(diffy::ConflictStyle::Merge)
        .merge(ancestor, ours, theirs)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test sotvault::logic::tests::reconcile 2>&1 | tail -20`
Expected: all nine `reconcile_*` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/logic.rs
git commit -m "feat(sotvault): pure 3-way reconcile_note decision fn"
```

---

## Task 3: IO wrapper `reconcile_companion_notes` (replaces `sync_companion_note`)

**Files:**
- Modify: `src-tauri/src/sotvault/mod.rs` — remove `sync_companion_note` (lines 64-90) and its two tests (`companion_note_synced_with_renamed_target`, `companion_note_missing_is_a_noop`, lines 324-354); add the new IO wrapper + helpers + integration tests.

Note: this task only ADDS `reconcile_companion_notes` (plus helpers, `NoteReconcileOutcome`, and the new integration tests). Leave the old `sync_companion_note` function and its two calls (lines 172, 257) in place — Task 4 deletes them together with their callers. The new function is exercised by this task's tests, so `cargo test` sees it as used (no dead-code error).

- [ ] **Step 1: Write the failing integration tests**

In `src-tauri/src/sotvault/mod.rs`, inside `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    fn reconcile_first_sync_copies_source_note_to_vault() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("foo.md"), b"# main").unwrap();
        std::fs::write(src_dir.join("foo.note.md"), b"- outline note").unwrap();
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();
        let target = dest_dir.join("2026-07-10-foo.md");

        let out = reconcile_companion_notes(&src_dir.join("foo.md"), &target, None);

        assert_eq!(std::fs::read(dest_dir.join("2026-07-10-foo.note.md")).unwrap(), b"- outline note");
        assert_eq!(out.new_base.as_deref(), Some("- outline note"));
        assert!(!out.conflict);
    }

    #[test]
    fn reconcile_missing_source_note_is_noop() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("foo.md"), b"# main").unwrap();
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();

        let out = reconcile_companion_notes(&src_dir.join("foo.md"), &dest_dir.join("foo.md"), None);

        // no note on either side → nothing written, no base
        assert!(std::fs::read_dir(&dest_dir).unwrap().next().is_none());
        assert_eq!(out.new_base, None);
        assert!(!out.conflict);
    }

    #[test]
    fn reconcile_conflict_writes_markers_and_two_backups() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        std::fs::write(src_dir.join("foo.md"), b"# main").unwrap();
        std::fs::write(dest_dir.join("foo.md"), b"# main").unwrap();
        // both note sides edited the same base line differently
        std::fs::write(src_dir.join("foo.note.md"), b"line local\n").unwrap();
        std::fs::write(dest_dir.join("foo.note.md"), b"line vault\n").unwrap();

        let out = reconcile_companion_notes(
            &src_dir.join("foo.md"),
            &dest_dir.join("foo.md"),
            Some("line base\n"),
        );

        assert!(out.conflict);
        // both note files now carry conflict markers and identical content
        let s = std::fs::read_to_string(src_dir.join("foo.note.md")).unwrap();
        let v = std::fs::read_to_string(dest_dir.join("foo.note.md")).unwrap();
        assert!(s.contains("<<<<<<<"));
        assert_eq!(s, v);
        // one .conflict backup next to each side, preserving the originals
        let src_backup = std::fs::read_dir(&src_dir).unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().contains(".conflict."))
            .expect("source-side .conflict backup missing");
        assert_eq!(std::fs::read_to_string(src_backup.path()).unwrap(), "line local\n");
        let vault_backup = std::fs::read_dir(&dest_dir).unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().contains(".conflict."))
            .expect("vault-side .conflict backup missing");
        assert_eq!(std::fs::read_to_string(vault_backup.path()).unwrap(), "line vault\n");
    }

    #[test]
    fn reconcile_fast_forward_pulls_vault_edit_into_source() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        // source note untouched since base; vault note moved on
        std::fs::write(src_dir.join("foo.note.md"), b"base\n").unwrap();
        std::fs::write(dest_dir.join("foo.note.md"), b"vault edit\n").unwrap();

        let out = reconcile_companion_notes(
            &src_dir.join("foo.md"),
            &dest_dir.join("foo.md"),
            Some("base\n"),
        );

        assert!(!out.conflict);
        assert_eq!(std::fs::read_to_string(src_dir.join("foo.note.md")).unwrap(), "vault edit\n");
        assert_eq!(out.new_base.as_deref(), Some("vault edit\n"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test sotvault::tests::reconcile 2>&1 | tail -20`
Expected: FAIL — `cannot find function reconcile_companion_notes`.

- [ ] **Step 3: Implement the IO wrapper + helpers**

In `src-tauri/src/sotvault/mod.rs`, add (place near `sync_companion_note`, e.g. after line 90):

```rust
/// Outcome of reconciling a pair's companion notes: the new merge base to
/// persist on the `Record`, and whether conflict markers were produced.
pub struct NoteReconcileOutcome {
    pub new_base: Option<String>,
    pub conflict: bool,
}

/// The companion-note path for an md path (`foo.md` → `foo.note.md`), or None
/// when `md` is itself a note / non-md.
fn companion_path(md: &Path) -> Option<PathBuf> {
    let name = md.file_name().and_then(|s| s.to_str())?;
    let note = logic::companion_note_name(name)?;
    Some(md.with_file_name(note))
}

/// Read a note file. `Ok(None)` = absent. `Ok(Some(text))` = UTF-8 content.
/// `Err(())` = present but unreadable (IO error or non-UTF-8). The caller must
/// then skip the whole reconcile rather than treat the file as absent, which
/// would overwrite an unreadable-but-present note (data loss).
fn read_note(p: &Path) -> Result<Option<String>, ()> {
    if !p.is_file() {
        return Ok(None);
    }
    match std::fs::read_to_string(p) {
        Ok(s) => Ok(Some(s)),
        Err(e) => {
            eprintln!("[sotvault] read note {p:?} failed ({e}); skipping note reconcile to avoid overwrite");
            Err(())
        }
    }
}

/// Back up `content` next to `note` as `<stem>.conflict.<ts>.<ext>`
/// (e.g. `foo.note.md` → `foo.note.conflict.1720000000.md`), mirroring the
/// `.conflict.<ts>` convention in `vault_sync/conflict.rs`.
fn backup_conflict_note(note: &Path, content: &str, ts: u64) {
    let stem = note.file_stem().and_then(|s| s.to_str()).unwrap_or("note");
    let ext = note
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let backup = note.with_file_name(format!("{stem}.conflict.{ts}{ext}"));
    if let Err(e) = std::fs::write(&backup, content) {
        eprintln!("[sotvault] write conflict backup {backup:?} failed: {e}");
    }
}

/// Reconcile the companion notes of a synced pair (bidirectional, 3-way).
/// `source` = source md path, `vault_md` = vault-copy md path, `base` = the
/// record's stored `note_merge_base`. Writes the merged content to whichever
/// side(s) changed, backs up both originals to `.conflict.<ts>` on conflict,
/// and returns the new base + conflict flag. Per-file IO errors are logged and
/// non-fatal (sync must not fail because a note write hiccuped).
fn reconcile_companion_notes(source: &Path, vault_md: &Path, base: Option<&str>) -> NoteReconcileOutcome {
    let (Some(src_note), Some(vault_note)) = (companion_path(source), companion_path(vault_md)) else {
        return NoteReconcileOutcome { new_base: base.map(str::to_string), conflict: false };
    };

    // If either side is present-but-unreadable, skip entirely — never risk
    // overwriting a note we couldn't read. Keep the stored base unchanged.
    let (src_content, vault_content) = match (read_note(&src_note), read_note(&vault_note)) {
        (Ok(s), Ok(v)) => (s, v),
        _ => return NoteReconcileOutcome { new_base: base.map(str::to_string), conflict: false },
    };

    let plan = logic::reconcile_note(base, src_content.as_deref(), vault_content.as_deref());

    if plan.conflict {
        let ts = now_secs();
        if let Some(s) = &src_content {
            backup_conflict_note(&src_note, s, ts);
        }
        if let Some(v) = &vault_content {
            backup_conflict_note(&vault_note, v, ts);
        }
    }
    if let Some(content) = &plan.write_vault {
        if let Err(e) = std::fs::write(&vault_note, content) {
            eprintln!("[sotvault] write vault note {vault_note:?} failed: {e}");
        }
    }
    if let Some(content) = &plan.write_source {
        if let Err(e) = std::fs::write(&src_note, content) {
            eprintln!("[sotvault] write source note {src_note:?} failed: {e}");
        }
    }
    NoteReconcileOutcome { new_base: plan.new_base, conflict: plan.conflict }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test sotvault::tests::reconcile 2>&1 | tail -20`
Expected: all four `reconcile_*` integration tests PASS. Existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/mod.rs
git commit -m "feat(sotvault): 3-way reconcile IO wrapper for companion notes"
```

---

## Task 4: Wire reconcile into both sync commands; remove `sync_companion_note`

**Files:**
- Modify: `src-tauri/src/sotvault/mod.rs` — `sotvault_sync_to_vault` (lines 171-187), `sotvault_apply_update` (lines 256-266); delete `sync_companion_note` (lines 64-90) and its two tests (lines 324-354).

- [ ] **Step 1: Rewrite `sotvault_sync_to_vault` to fetch prior base, reconcile, and persist new base**

In `src-tauri/src/sotvault/mod.rs`, replace the block that currently reads (lines 171-187):

```rust
    std::fs::write(&target, &vault_bytes).map_err(|e| e.to_string())?;
    sync_companion_note(&source, &target);

    let source_hash = logic::sha256_hex(&src_bytes);
    let vault_hash = logic::sha256_hex(&vault_bytes);

    let mut s = load_store(&app)?;
    let rec = Record {
        vault_path: target.to_string_lossy().to_string(),
        source_path: source.to_string_lossy().to_string(),
        synced_at: now_secs(),
        source_hash,
        vault_hash,
        note_merge_base: None,
    };
    s.upsert(rec.clone());
    save_store(&app, &s)?;
    Ok(rec)
```

with:

```rust
    std::fs::write(&target, &vault_bytes).map_err(|e| e.to_string())?;

    let mut s = load_store(&app)?;
    let prior_base = s
        .find_by_vault(&target.to_string_lossy())
        .and_then(|r| r.note_merge_base.clone());
    let note = reconcile_companion_notes(&source, &target, prior_base.as_deref());

    let source_hash = logic::sha256_hex(&src_bytes);
    let vault_hash = logic::sha256_hex(&vault_bytes);

    let rec = Record {
        vault_path: target.to_string_lossy().to_string(),
        source_path: source.to_string_lossy().to_string(),
        synced_at: now_secs(),
        source_hash,
        vault_hash,
        note_merge_base: note.new_base,
    };
    s.upsert(rec.clone());
    save_store(&app, &s)?;
    Ok(rec)
```

- [ ] **Step 2: Rewrite `sotvault_apply_update` to reconcile with the record's stored base**

In `src-tauri/src/sotvault/mod.rs`, replace (lines 256-266):

```rust
    std::fs::write(&rec.vault_path, &vault_bytes).map_err(|e| e.to_string())?;
    sync_companion_note(Path::new(&rec.source_path), &vault_pathbuf);

    let updated = Record {
        synced_at: now_secs(),
        source_hash: logic::sha256_hex(&src_bytes),
        vault_hash: logic::sha256_hex(&vault_bytes),
        ..rec
    };
```

with:

```rust
    std::fs::write(&rec.vault_path, &vault_bytes).map_err(|e| e.to_string())?;
    let note = reconcile_companion_notes(
        Path::new(&rec.source_path),
        &vault_pathbuf,
        rec.note_merge_base.as_deref(),
    );

    let updated = Record {
        synced_at: now_secs(),
        source_hash: logic::sha256_hex(&src_bytes),
        vault_hash: logic::sha256_hex(&vault_bytes),
        note_merge_base: note.new_base,
        ..rec
    };
```

- [ ] **Step 3: Delete the obsolete `sync_companion_note` function and its two tests**

In `src-tauri/src/sotvault/mod.rs`:
- Delete the `sync_companion_note` function (the doc comment at line 64 through the closing brace at line 90).
- In the tests module, delete the `companion_note_synced_with_renamed_target` test (lines 324-340) and the `companion_note_missing_is_a_noop` test (lines 342-354) — their behavior is now covered by `reconcile_first_sync_copies_source_note_to_vault` and `reconcile_missing_source_note_is_noop` from Task 3.

- [ ] **Step 4: Run the full sotvault test suite + clippy**

Run: `cargo test sotvault 2>&1 | tail -25`
Expected: all sotvault tests PASS; no reference to `sync_companion_note` remains (no unused-function warning).

Run: `cargo clippy -p mdeditor 2>&1 | tail -15` (or the crate's actual package name; `cargo clippy 2>&1 | tail -15` works too)
Expected: no new warnings about `sync_companion_note` or unused imports.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/mod.rs
git commit -m "feat(sotvault): reconcile companion notes on sync (both directions)"
```

---

## Task 5 (OPTIONAL): Conflict toast

Only do this if you want a user-facing signal beyond the in-file markers + `.conflict` backups. It emits a Tauri event on note conflict and shows a toast. Skipping it loses no data — the markers and backups are already on disk.

**Files:**
- Modify: `src-tauri/src/sotvault/mod.rs` — emit an event after reconcile in both commands.
- Modify: `src/lib/sotvault.svelte.ts` — listen for the event, show a toast.
- Modify: `src/lib/i18n/en.ts` — add the toast message key.

- [ ] **Step 1: Emit the event from both commands**

In `src-tauri/src/sotvault/mod.rs`, add the import near the top (with the other `use tauri::...`):

```rust
use tauri::Emitter;
```

In `sotvault_sync_to_vault`, after `s.upsert(rec.clone()); save_store(&app, &s)?;` and before `Ok(rec)`, add:

```rust
    if note.conflict {
        let _ = app.emit("sotvault://note-conflict", ());
    }
```

In `sotvault_apply_update`, after `s.upsert(updated); save_store(&app, &s)?;` and before `Ok(vault_string)`, add:

```rust
    if note.conflict {
        let _ = app.emit("sotvault://note-conflict", ());
    }
```

- [ ] **Step 2: Add the i18n key**

In `src/lib/i18n/en.ts`, add a flat key (follow the existing `sotvault.*` key style; if none exists, add under a `sotvault` grouping consistent with the file's dotted-key convention):

```ts
'sotvault.noteConflict': 'Sidecar note had a merge conflict — conflict markers inserted and originals backed up (.conflict).',
```

(Per repo i18n memory: en.ts is the source of truth; the zh partial can add the same key later. `t()` falls back to en.)

- [ ] **Step 3: Listen and toast in the frontend**

In `src/lib/sotvault.svelte.ts`, add near the top imports:

```ts
import { listen } from '@tauri-apps/api/event'
```

Then add an exported initializer (call it once at app boot, next to other sotvault init):

```ts
let noteConflictUnlisten: (() => void) | null = null
/** Show a toast whenever a sidecar-note merge produced conflict markers. */
export async function initSotvaultNoteConflictToast(): Promise<void> {
  if (noteConflictUnlisten) return
  noteConflictUnlisten = await listen('sotvault://note-conflict', () => {
    pushToast({ kind: 'warn', message: t('sotvault.noteConflict') })
  })
}
```

Wire the call: find where sotvault/app boot runs one-time setup (e.g. where `refreshSotvault()` is first invoked at startup) and `await initSotvaultNoteConflictToast()` there. Verify `pushToast`'s option shape against `src/lib/toast.svelte.ts` (`PushOpts`) — adjust `kind`/`message` field names to match that type exactly.

- [ ] **Step 4: Build the frontend to verify it compiles**

Run: `pnpm check` (from repo root `/Users/bruce/git/mdeditor`)
Expected: no type errors from the new code (fix `PushOpts` field names if `check` complains).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/mod.rs src/lib/sotvault.svelte.ts src/lib/i18n/en.ts
git commit -m "feat(sotvault): toast on sidecar-note merge conflict"
```

---

## Final Verification

- [ ] Run the whole backend test suite: `cd src-tauri && cargo test 2>&1 | tail -20` — all green.
- [ ] `cargo clippy 2>&1 | tail -20` — no new warnings.
- [ ] Manually reason through the spec's decision table against the tests in Tasks 2-3: every row has a passing test.
- [ ] Confirm `git log --oneline -5` shows the task commits and `git status` shows only intended files changed.

## Notes for the Implementer

- **Do not `git add -A`.** This worktree is shared; add only the files each task lists.
- The **open-editor race** (spec §"打开中的笔记竞态") is intentionally handled by the existing file-watcher/external-state path — reconcile just writes the file; the editor reload/banner is out of scope for this plan. The `.conflict` backups are the safety net if that path is imperfect.
- diffy's markers are `<<<<<<< ours` (= local source note) / `>>>>>>> theirs` (= vault note). This is fixed by the library; no custom labels.
- `reconcile_note` converges BOTH sides on a both-changed merge. This is deliberate — writing only one side re-diverges the pair (spec §"关键约束"). Do not "optimize" it to write a single side.
