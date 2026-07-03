# Sync md Image Assets to Vault — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When syncing an `.md` file to the Vault, also copy the local images it references into a per-md unique `{stem}.assets/` directory and rewrite the links.

**Architecture:** All work happens in the Rust `sotvault` module. Pure scanning/rewriting logic lives in `sotvault/logic.rs` (unit-tested, `exists` injected); file IO lives in `sotvault/mod.rs`. Both `sotvault_sync_to_vault` and `sotvault_apply_update` call one shared IO helper, `bundle_referenced_images`. The frontend is unchanged.

**Tech Stack:** Rust (Tauri commands), no new crates — a hand-written scanner replaces a regex dependency. Tests via `cargo test --lib` from `src-tauri/`.

**Spec:** `docs/superpowers/specs/2026-07-03-sync-md-image-assets-design.md`

**Run all Rust tests:** `( cd src-tauri && cargo test --lib )`

---

### Task 1: Pure helpers in `logic.rs`

Small, independently-testable building blocks: image-extension check, assets dir name, inline-image scanner, link-target path extraction, relative-local filter, and target rewriter. Plus the two data structs.

**Files:**
- Modify: `src-tauri/src/sotvault/logic.rs`
- Test: same file's `#[cfg(test)] mod tests`

- [ ] **Step 1: Write failing tests** — add these to the `mod tests` block at the bottom of `logic.rs` (after the existing tests, before the closing `}`):

```rust
    #[test]
    fn is_image_ext_matches_known_extensions() {
        assert!(is_image_ext("a/b/pic.PNG"));
        assert!(is_image_ext("x.jpeg"));
        assert!(is_image_ext("x.svg"));
        assert!(!is_image_ext("x.pdf"));
        assert!(!is_image_ext("noext"));
        assert!(!is_image_ext("trailing."));
    }

    #[test]
    fn assets_dir_name_appends_suffix() {
        assert_eq!(assets_dir_name("2026-07-03-notes"), "2026-07-03-notes.assets");
    }

    #[test]
    fn scan_finds_inline_image_targets_only() {
        let md = "text ![a](assets/x.png) more [not img](y.md) ![b](<z.png>) end";
        let got = scan_image_link_targets(md);
        assert_eq!(got, vec!["assets/x.png".to_string(), "<z.png>".to_string()]);
    }

    #[test]
    fn extract_link_path_handles_title_and_angles() {
        assert_eq!(extract_link_path("assets/x.png"), "assets/x.png");
        assert_eq!(extract_link_path("  assets/x.png  \"a title\""), "assets/x.png");
        assert_eq!(extract_link_path("<assets/my file.png>"), "assets/my file.png");
    }

    #[test]
    fn is_relative_local_rejects_absolute_and_urls() {
        assert!(is_relative_local("assets/x.png"));
        assert!(is_relative_local("./images/x.png"));
        assert!(!is_relative_local("/abs/x.png"));
        assert!(!is_relative_local("https://h/x.png"));
        assert!(!is_relative_local("http://h/x.png"));
        assert!(!is_relative_local("data:image/png;base64,AAAA"));
        assert!(!is_relative_local("C:\\win\\x.png"));
        assert!(!is_relative_local(""));
    }

    #[test]
    fn rewrite_link_target_preserves_title_and_angles() {
        assert_eq!(rewrite_link_target("assets/x.png", "d.assets/x.png"), "d.assets/x.png");
        assert_eq!(
            rewrite_link_target("assets/x.png \"t\"", "d.assets/x.png"),
            "d.assets/x.png \"t\""
        );
        assert_eq!(
            rewrite_link_target("<assets/x.png>", "d.assets/x.png"),
            "<d.assets/x.png>"
        );
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd src-tauri && cargo test --lib sotvault::logic )`
Expected: FAIL — compile errors, `cannot find function is_image_ext` etc.

- [ ] **Step 3: Implement the helpers** — add to `logic.rs`, just above the `#[cfg(test)]` line. Note `dedup_target`/`split_ext`/`sha256_hex` already exist in this file:

```rust
/// Image file extensions (lowercase), mirroring paste-resources.ts.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff", "tif", "avif",
];

/// True when `name`'s extension (case-insensitive) is a known image type.
pub fn is_image_ext(name: &str) -> bool {
    match name.rfind('.') {
        Some(i) if i + 1 < name.len() => {
            let ext = name[i + 1..].to_ascii_lowercase();
            IMAGE_EXTENSIONS.contains(&ext.as_str())
        }
        _ => false,
    }
}

/// The per-md assets directory name derived from the vault md file stem.
pub fn assets_dir_name(stem: &str) -> String {
    format!("{stem}.assets")
}

/// Scan markdown for inline image links `![alt](target)` and return each raw
/// `target` string (the text between the parentheses), in document order.
/// v1: no nested `]`/`)`, no reference-style, no HTML.
pub fn scan_image_link_targets(md: &str) -> Vec<String> {
    let b = md.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 1 < b.len() {
        if b[i] == b'!' && b[i + 1] == b'[' {
            if let Some(close) = find_byte(b, i + 2, b']') {
                if close + 1 < b.len() && b[close + 1] == b'(' {
                    if let Some(rparen) = find_byte(b, close + 2, b')') {
                        out.push(md[close + 2..rparen].to_string());
                        i = rparen + 1;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    out
}

fn find_byte(b: &[u8], from: usize, needle: u8) -> Option<usize> {
    (from..b.len()).find(|&j| b[j] == needle)
}

/// Extract the path portion from a raw link target, stripping an optional
/// `"title"` and unwrapping `<...>` angle brackets.
pub fn extract_link_path(raw: &str) -> String {
    let t = raw.trim();
    if let Some(stripped) = t.strip_prefix('<') {
        return stripped.split('>').next().unwrap_or("").to_string();
    }
    // Path runs until the first ASCII whitespace (a title, if any, follows).
    match t.find(char::is_whitespace) {
        Some(i) => t[..i].to_string(),
        None => t.to_string(),
    }
}

/// True when `p` is a relative local path (not a URL, not absolute, not data:).
pub fn is_relative_local(p: &str) -> bool {
    let t = p.trim();
    if t.is_empty() || t.starts_with('/') || t.starts_with('#') {
        return false;
    }
    if t.starts_with("data:") || t.contains("://") {
        return false;
    }
    // Windows drive-absolute, e.g. C:\...
    let b = t.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        return false;
    }
    true
}

/// Rebuild a raw link target with `new_path` swapped in, preserving an optional
/// `"title"` and `<...>` angle brackets.
pub fn rewrite_link_target(raw: &str, new_path: &str) -> String {
    let t = raw.trim();
    if t.starts_with('<') {
        // <path>rest  ->  <new_path>rest
        let after = match t.find('>') {
            Some(i) => &t[i + 1..],
            None => "",
        };
        return format!("<{new_path}>{after}");
    }
    match t.find(char::is_whitespace) {
        Some(i) => format!("{}{}", new_path, &t[i..]),
        None => new_path.to_string(),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd src-tauri && cargo test --lib sotvault::logic )`
Expected: PASS (all `logic` tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/logic.rs
git commit -m "feat(sotvault): image-link scan/rewrite helpers"
```

---

### Task 2: `plan_image_assets` + `dedup_name`

The core pure planner: given markdown, the source dir, the vault stem, and an injected `exists`, return a rewrite plan (`Vec<PlannedRef>`) and a copy plan (`Vec<CopyOp>`). Filenames are deduped within the assets dir; the same source file referenced twice is copied once.

**Files:**
- Modify: `src-tauri/src/sotvault/logic.rs`
- Test: same file's `mod tests`

- [ ] **Step 1: Write failing tests** — add to `mod tests`:

```rust
    fn always(_p: &std::path::Path) -> bool { true }

    #[test]
    fn plan_no_images_returns_empty() {
        let (refs, copies) = plan_image_assets("# hi\n[link](a.md)", Path::new("/s"), "d", &always);
        assert!(refs.is_empty());
        assert!(copies.is_empty());
    }

    #[test]
    fn plan_single_image_rewrites_and_copies() {
        let md = "![a](assets/x.png)";
        let (refs, copies) = plan_image_assets(md, Path::new("/s"), "d", &always);
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].src_abs, PathBuf::from("/s/assets/x.png"));
        assert_eq!(copies[0].dest_filename, "x.png");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].original, "(assets/x.png)");
        assert_eq!(refs[0].rewritten, "(d.assets/x.png)");
        assert_eq!(refs[0].dest_filename, "x.png");
    }

    #[test]
    fn plan_skips_urls_absolute_and_non_images() {
        let md = "![a](https://h/x.png) ![b](/abs/y.png) ![c](note.md)";
        let (refs, copies) = plan_image_assets(md, Path::new("/s"), "d", &always);
        assert!(refs.is_empty());
        assert!(copies.is_empty());
    }

    #[test]
    fn plan_skips_missing_source_files() {
        let md = "![a](assets/x.png)";
        let none = |_p: &Path| false;
        let (refs, copies) = plan_image_assets(md, Path::new("/s"), "d", &none);
        assert!(refs.is_empty());
        assert!(copies.is_empty());
    }

    #[test]
    fn plan_dedups_same_basename_from_different_dirs() {
        let md = "![a](one/img.png) ![b](two/img.png)";
        let (refs, copies) = plan_image_assets(md, Path::new("/s"), "d", &always);
        assert_eq!(copies.len(), 2);
        assert_eq!(copies[0].dest_filename, "img.png");
        assert_eq!(copies[1].dest_filename, "img-2.png");
        assert_eq!(refs[0].rewritten, "(d.assets/img.png)");
        assert_eq!(refs[1].rewritten, "(d.assets/img-2.png)");
    }

    #[test]
    fn plan_copies_same_file_once() {
        let md = "![a](assets/x.png) then again ![a](assets/x.png)";
        let (refs, copies) = plan_image_assets(md, Path::new("/s"), "d", &always);
        assert_eq!(copies.len(), 1);
        assert_eq!(refs.len(), 1); // one unique original token
        assert_eq!(refs[0].rewritten, "(d.assets/x.png)");
    }

    #[test]
    fn plan_preserves_title_in_rewrite() {
        let md = "![a](assets/x.png \"cap\")";
        let (refs, _copies) = plan_image_assets(md, Path::new("/s"), "d", &always);
        assert_eq!(refs[0].original, "(assets/x.png \"cap\")");
        assert_eq!(refs[0].rewritten, "(d.assets/x.png \"cap\")");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd src-tauri && cargo test --lib sotvault::logic::tests::plan )`
Expected: FAIL — `cannot find function plan_image_assets` and missing structs.

- [ ] **Step 3: Implement `plan_image_assets`, `dedup_name`, and the structs** — add to `logic.rs` above `#[cfg(test)]`. Also add `use std::collections::{HashMap, HashSet};` to the top-of-file `use` block:

```rust
/// One file to copy into the assets dir: absolute source -> dest filename.
#[derive(Debug, Clone, PartialEq)]
pub struct CopyOp {
    pub src_abs: PathBuf,
    pub dest_filename: String,
}

/// One planned link rewrite. Applied by the caller only after the matching
/// CopyOp copies successfully (keeps md refs consistent with copied files).
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedRef {
    /// The exact `(target)` token in the source md, including parentheses.
    pub original: String,
    /// The replacement `(target)` token pointing into the assets dir.
    pub rewritten: String,
    pub dest_filename: String,
}

/// Pick a non-colliding filename within an assets dir given already-used names.
fn dedup_name(name: &str, used: &HashSet<String>) -> String {
    if !used.contains(name) {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    let mut n = 2;
    loop {
        let candidate = match &ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        if !used.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Scan `md` for inline images with relative-local image paths that exist under
/// `source_dir`, and plan how to bundle them into `{stem}.assets/`.
/// Returns (rewrite plan, copy plan). Pure: `exists` decides file presence.
pub fn plan_image_assets(
    md: &str,
    source_dir: &Path,
    stem: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> (Vec<PlannedRef>, Vec<CopyOp>) {
    let mut used_names: HashSet<String> = HashSet::new();
    let mut abs_to_dest: HashMap<String, String> = HashMap::new();
    let mut seen_originals: HashSet<String> = HashSet::new();
    let mut copies: Vec<CopyOp> = Vec::new();
    let mut refs: Vec<PlannedRef> = Vec::new();

    for raw in scan_image_link_targets(md) {
        let path = extract_link_path(&raw);
        if !is_relative_local(&path) || !is_image_ext(&path) {
            continue;
        }
        let abs = source_dir.join(&path);
        if !exists(&abs) {
            continue;
        }
        let original = format!("({raw})");
        if !seen_originals.insert(original.clone()) {
            continue; // identical token already planned
        }
        let abs_key = abs.to_string_lossy().to_string();
        let dest = match abs_to_dest.get(&abs_key) {
            Some(d) => d.clone(),
            None => {
                let basename = path.rsplit('/').next().unwrap_or(&path);
                let name = dedup_name(basename, &used_names);
                used_names.insert(name.clone());
                abs_to_dest.insert(abs_key, name.clone());
                copies.push(CopyOp { src_abs: abs.clone(), dest_filename: name.clone() });
                name
            }
        };
        let rewritten = format!("({})", rewrite_link_target(&raw, &format!("{stem}.assets/{dest}")));
        refs.push(PlannedRef { original, rewritten, dest_filename: dest });
    }
    (refs, copies)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd src-tauri && cargo test --lib sotvault::logic )`
Expected: PASS (all logic tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sotvault/logic.rs
git commit -m "feat(sotvault): plan_image_assets pure planner"
```

---

### Task 3: Bundle assets on `sotvault_sync_to_vault`

Add the shared IO helper `bundle_referenced_images` and call it in `sotvault_sync_to_vault`, splitting `source_hash` (source original) from `vault_hash` (rewritten copy).

**Files:**
- Modify: `src-tauri/src/sotvault/mod.rs` (imports; body of `sotvault_sync_to_vault`, currently lines 64-103; new helper fn)

- [ ] **Step 1: Add imports** — in the top `use` block of `mod.rs`, change `use std::path::PathBuf;` to:

```rust
use std::collections::HashSet;
use std::path::{Path, PathBuf};
```

- [ ] **Step 2: Add the `bundle_referenced_images` helper** — insert after the `now_secs` function (around line 21):

```rust
/// Copy the relative-local images referenced by `src_md` into
/// `{dest_dir}/{stem}.assets/` and return the markdown with successfully-copied
/// links rewritten to point there. When nothing is bundled, returns `src_md`
/// unchanged. A per-file copy failure is logged and its link left untouched.
fn bundle_referenced_images(
    src_md: &str,
    source_dir: &Path,
    dest_dir: &Path,
    stem: &str,
) -> Result<String, String> {
    let (refs, copies) =
        logic::plan_image_assets(src_md, source_dir, stem, &|p| p.exists());
    if copies.is_empty() {
        return Ok(src_md.to_string());
    }
    let assets = dest_dir.join(logic::assets_dir_name(stem));
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;

    let mut copied: HashSet<String> = HashSet::new();
    for op in &copies {
        let dst = assets.join(&op.dest_filename);
        match std::fs::copy(&op.src_abs, &dst) {
            Ok(_) => {
                copied.insert(op.dest_filename.clone());
            }
            Err(e) => {
                eprintln!("[sotvault] copy asset {:?} failed: {e}", op.src_abs);
            }
        }
    }

    let mut md = src_md.to_string();
    for r in &refs {
        if copied.contains(&r.dest_filename) {
            md = md.replace(&r.original, &r.rewritten);
        }
    }
    Ok(md)
}
```

- [ ] **Step 3: Rewrite the write+hash block of `sotvault_sync_to_vault`** — replace the current lines 87-99 (from `let target = ...` through the `let rec = Record {` fields) with the version below. The `dedup_target` call is unchanged; the change is: compute stem, bundle images, write the rewritten bytes, and hash the two sides separately.

Replace this existing block:

```rust
    let target = logic::dedup_target(&subdir, &basename, &|p| p.exists());
    let bytes = std::fs::read(&source).map_err(|e| e.to_string())?;
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    let hash = logic::sha256_hex(&bytes);

    let mut s = load_store(&app)?;
    let rec = Record {
        vault_path: target.to_string_lossy().to_string(),
        source_path: source.to_string_lossy().to_string(),
        synced_at: now_secs(),
        source_hash: hash.clone(),
        vault_hash: hash,
    };
```

with:

```rust
    let target = logic::dedup_target(&subdir, &basename, &|p| p.exists());
    let src_bytes = std::fs::read(&source).map_err(|e| e.to_string())?;

    let stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let source_dir = source.parent().unwrap_or_else(|| Path::new("."));

    // Non-UTF-8 (unusual for md): copy bytes verbatim, no asset handling.
    let vault_bytes: Vec<u8> = match std::str::from_utf8(&src_bytes) {
        Ok(src_md) => bundle_referenced_images(src_md, source_dir, &subdir, &stem)?.into_bytes(),
        Err(_) => src_bytes.clone(),
    };
    std::fs::write(&target, &vault_bytes).map_err(|e| e.to_string())?;

    let source_hash = logic::sha256_hex(&src_bytes);
    let vault_hash = logic::sha256_hex(&vault_bytes);

    let mut s = load_store(&app)?;
    let rec = Record {
        vault_path: target.to_string_lossy().to_string(),
        source_path: source.to_string_lossy().to_string(),
        synced_at: now_secs(),
        source_hash,
        vault_hash,
    };
```

- [ ] **Step 4: Build to verify it compiles**

Run: `( cd src-tauri && cargo build --lib )`
Expected: builds with no errors (warnings ok).

- [ ] **Step 5: Add an integration test** — add a new `#[cfg(test)] mod tests` at the bottom of `mod.rs` (the file currently has none). It exercises the helper end-to-end on a temp dir:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn bundle_copies_image_and_rewrites_link() {
        let tmp = TempDir::new().unwrap();
        let src_dir = tmp.path().join("src");
        std::fs::create_dir_all(src_dir.join("assets")).unwrap();
        std::fs::write(src_dir.join("assets/x.png"), b"PNGDATA").unwrap();

        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();

        let md = "![a](assets/x.png)";
        let out = bundle_referenced_images(md, &src_dir, &dest_dir, "2026-07-03-note").unwrap();

        assert_eq!(out, "![a](2026-07-03-note.assets/x.png)");
        let copied = dest_dir.join("2026-07-03-note.assets/x.png");
        assert_eq!(std::fs::read(&copied).unwrap(), b"PNGDATA");
    }

    #[test]
    fn bundle_no_images_returns_unchanged_and_creates_nothing() {
        let tmp = TempDir::new().unwrap();
        let dest_dir = tmp.path().join("vault");
        std::fs::create_dir_all(&dest_dir).unwrap();

        let md = "# just text, [a link](note.md)";
        let out = bundle_referenced_images(md, tmp.path(), &dest_dir, "note").unwrap();

        assert_eq!(out, md);
        assert!(!dest_dir.join("note.assets").exists());
    }
}
```

- [ ] **Step 6: Run the new tests**

Run: `( cd src-tauri && cargo test --lib sotvault )`
Expected: PASS (logic tests + the two `bundle_*` tests).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sotvault/mod.rs
git commit -m "feat(sotvault): bundle referenced images on sync to vault"
```

---

### Task 4: Re-bundle assets on `sotvault_apply_update`

When the source md changes and the user accepts the update, re-scan and re-copy images, write the rewritten md, and fingerprint both sides.

**Files:**
- Modify: `src-tauri/src/sotvault/mod.rs` — body of `sotvault_apply_update` (currently lines 149-160)

- [ ] **Step 1: Rewrite the body of `sotvault_apply_update`** — replace this existing block:

```rust
    let mut s = load_store(&app)?;
    let rec = s.find_by_vault(&vault_path).cloned().ok_or("not tracked")?;
    let bytes = std::fs::read(&rec.source_path).map_err(|e| e.to_string())?;
    std::fs::write(&rec.vault_path, &bytes).map_err(|e| e.to_string())?;
    let hash = logic::sha256_hex(&bytes);
    let updated = Record { synced_at: now_secs(), source_hash: hash.clone(), vault_hash: hash, ..rec };
    s.upsert(updated);
    save_store(&app, &s)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
```

with:

```rust
    let mut s = load_store(&app)?;
    let rec = s.find_by_vault(&vault_path).cloned().ok_or("not tracked")?;
    let src_bytes = std::fs::read(&rec.source_path).map_err(|e| e.to_string())?;

    let vault_pathbuf = PathBuf::from(&rec.vault_path);
    let dest_dir = vault_pathbuf.parent().unwrap_or_else(|| Path::new("."));
    let stem = vault_pathbuf
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let source_dir = Path::new(&rec.source_path)
        .parent()
        .unwrap_or_else(|| Path::new("."));

    let vault_string: String = match std::str::from_utf8(&src_bytes) {
        Ok(src_md) => bundle_referenced_images(src_md, source_dir, dest_dir, &stem)?,
        Err(_) => return Err("source is not valid UTF-8".into()),
    };
    let vault_bytes = vault_string.clone().into_bytes();
    std::fs::write(&rec.vault_path, &vault_bytes).map_err(|e| e.to_string())?;

    let updated = Record {
        synced_at: now_secs(),
        source_hash: logic::sha256_hex(&src_bytes),
        vault_hash: logic::sha256_hex(&vault_bytes),
        ..rec
    };
    s.upsert(updated);
    save_store(&app, &s)?;
    Ok(vault_string)
```

- [ ] **Step 2: Build to verify it compiles**

Run: `( cd src-tauri && cargo build --lib )`
Expected: builds, no errors.

- [ ] **Step 3: Run the whole sotvault suite**

Run: `( cd src-tauri && cargo test --lib sotvault )`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sotvault/mod.rs
git commit -m "feat(sotvault): re-bundle images on apply update"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run all Rust lib tests**

Run: `( cd src-tauri && cargo test --lib )`
Expected: PASS, no failures.

- [ ] **Step 2: Clippy (matches repo convention)**

Run: `( cd src-tauri && cargo clippy --lib )`
Expected: no new warnings from the changed files. Fix any that appear.

- [ ] **Step 3: Commit any clippy fixes** (skip if none)

```bash
git add -A && git commit -m "chore(sotvault): clippy fixes"
```

---

## Notes for the implementer

- **Do not touch the frontend.** `src/lib/sotvault.svelte.ts` and `sotvault-logic.ts` stay as-is; command signatures are unchanged.
- **`String::from_utf8` vs `str::from_utf8`:** the plan uses `std::str::from_utf8(&bytes)` to avoid consuming `src_bytes` (still needed for hashing). Keep it.
- **`md.replace` on the `(target)` token:** using the full parenthesized token (not just the bare path) avoids corrupting a path that is a substring of another link. Do not simplify it to replacing the bare path.
- **Out of scope (per spec, do not add):** reference-style images `![][id]`, HTML `<img>`, absolute-path refs, percent-encoded path decoding, orphan cleanup, image-change detection when md text is unchanged.
