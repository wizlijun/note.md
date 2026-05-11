# Typora Theme Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded skin system with a directory-based theme system that natively imports Typora themes from `.zip` archives.

**Architecture:** Tauri commands in Rust handle zip extraction, CSS selector rewriting (via `lightningcss`), and disk I/O against `~/Library/Application Support/com.laobu.mdeditor/themes/`. Each `*.css` under that directory is one theme (Typora convention), compiled into a scoped `[data-theme="<id>"] .moraya-editor` form in `themes/.compiled/`. The frontend reads the compiled CSS via two `<style>` slots and toggles between them via the `data-theme` attribute on the editor host.

**Tech Stack:** Rust (`lightningcss`, `zip`), Tauri 2, Svelte 5 (`$state`), Vitest, `cargo test`.

**Reference spec:** `docs/superpowers/specs/2026-05-11-typora-theme-import-design.md`

**Pre-existing context (relied on by tasks below):**

- Bundle id is `com.laobu.mdeditor` (commit `886bc7b`).
- Built-in `shuyuan` skin already removed (commit `6a7567d`); only `default` and `effie` remain.
- Current `data-skin` attribute lives on `.host` in `src/components/RichEditor.svelte:170`.
- Current Tauri commands and `invoke_handler` registration live in `src-tauri/src/lib.rs:224`.
- Existing settings persistence is in `src/lib/settings.svelte.ts`; uses `@tauri-apps/plugin-store` via `Store.load('settings.json')`.

---

## File structure (created or modified by this plan)

### Rust (src-tauri)

- **Create** `src-tauri/src/themes/mod.rs` — module facade re-exporting submodules
- **Create** `src-tauri/src/themes/paths.rs` — themes directory + compiled subdir helpers
- **Create** `src-tauri/src/themes/id.rs` — theme id validation
- **Create** `src-tauri/src/themes/header.rs` — CSS metadata header parser
- **Create** `src-tauri/src/themes/appearance.rs` — filename appearance heuristic
- **Create** `src-tauri/src/themes/registry.rs` — `ThemeMeta`, `scan_themes_dir`
- **Create** `src-tauri/src/themes/compiler.rs` — selector + url rewriter, full compile pipeline
- **Create** `src-tauri/src/themes/zip_safety.rs` — zip extraction with bounds & path-traversal checks
- **Create** `src-tauri/src/themes/import.rs` — `theme_import`, `theme_install`
- **Create** `src-tauri/src/themes/commands.rs` — `#[tauri::command]` wrappers
- **Create** `src-tauri/resources/themes/default.css` — built-in (Typora source form)
- **Create** `src-tauri/resources/themes/effie.css` — built-in (Typora source form)
- **Modify** `src-tauri/Cargo.toml` — add `lightningcss`, `zip` deps
- **Modify** `src-tauri/tauri.conf.json` — add `resources/themes/**/*` to bundle resources
- **Modify** `src-tauri/src/lib.rs` — register commands, run first-launch migration
- **Create** `src-tauri/tests/themes_header_test.rs`
- **Create** `src-tauri/tests/themes_appearance_test.rs`
- **Create** `src-tauri/tests/themes_id_test.rs`
- **Create** `src-tauri/tests/themes_compiler_test.rs`
- **Create** `src-tauri/tests/themes_zip_safety_test.rs`
- **Create** `src-tauri/tests/themes_import_test.rs`

### Frontend (src)

- **Create** `src/lib/themes.svelte.ts` — reactive theme registry
- **Create** `src/lib/themes.test.ts`
- **Create** `src/lib/theme-loader.ts` — two-slot `<style>` manager + `data-theme` computation
- **Create** `src/lib/theme-loader.test.ts`
- **Create** `src/components/ThemeImportDialog.svelte` — import confirmation modal
- **Create** `src/components/ThemeImportDialog.test.ts` (component test via happy-dom)
- **Modify** `src/lib/settings.svelte.ts` — schema migration `skin` → `theme.{light,dark,followSystem}`
- **Modify** `src/lib/settings.test.ts` — migration tests
- **Modify** `src/components/SettingsDialog.svelte` — replace Skin row with Theme section + buttons
- **Modify** `src/components/RichEditor.svelte` — `data-skin` → `data-theme`
- **Modify** `src/App.svelte` — load themes, install loader, route `.zip` drops to import
- **Modify** `src/lib/plugins/share-baker.ts` — read compiled CSS via registry
- **Modify** `src/lib/plugins/share-baker.test.ts` — update assertions for `data-theme`
- **Delete** `src/lib/skin.svelte.ts` — replaced by `themes.svelte.ts`
- **Delete** `src/lib/skin.test.ts` — replaced by `themes.test.ts`
- **Delete** `src/styles/skins/default.css` — moved to `src-tauri/resources/themes/default.css`
- **Delete** `src/styles/skins/effie.css` — moved to `src-tauri/resources/themes/effie.css`

### Docs

- **Modify** `README.md` — Skin → Themes section + smoke tests 68–80
- **Modify** `README.zh-CN.md` — same

---

## Task ordering (sanity check)

Rust comes first (Tasks 1–22) because frontend tests mock Tauri `invoke` and need a stable command surface to mock against. Within Rust: deps → pure functions (TDD) → I/O wrappers → command surface. Frontend (Tasks 23–32) layers on top: settings migration → registry → loader → UI → integration. Tasks 33–34 are cleanup and docs.

---

## Task 1: Add Rust dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add lightningcss and zip to `[dependencies]`**

Append to `src-tauri/Cargo.toml` `[dependencies]` section (after `serde_json = "1"`):

```toml
lightningcss = "1.0.0-alpha.66"
zip = { version = "2.2", default-features = false, features = ["deflate"] }
tempfile = "3.13"
```

`tempfile` is needed for zip extraction to a scratch dir before installation.

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: completes with no errors (warnings about unused deps are fine; we'll use them soon).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "$(cat <<'EOF'
build(theme): add lightningcss, zip, tempfile deps

Required for Typora theme import + selector rewriting.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create themes module skeleton + paths helper

**Files:**
- Create: `src-tauri/src/themes/mod.rs`
- Create: `src-tauri/src/themes/paths.rs`
- Modify: `src-tauri/src/lib.rs:13` (add `pub mod themes;`)

- [ ] **Step 1: Create `src-tauri/src/themes/mod.rs`**

```rust
//! Theme management: directory layout, Typora-CSS metadata parsing,
//! selector rewriting (`lightningcss`), zip import, and the `#[tauri::command]`
//! surface consumed by the frontend.
//!
//! Every `*.css` directly under `themes/` is one independent theme; compiled
//! CSS is written to `themes/.compiled/`. See
//! `docs/superpowers/specs/2026-05-11-typora-theme-import-design.md`.

pub mod paths;
```

- [ ] **Step 2: Create `src-tauri/src/themes/paths.rs`**

```rust
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

/// Absolute path to the user's themes directory:
/// `~/Library/Application Support/com.laobu.mdeditor/themes/` on macOS.
/// Created on demand by callers.
pub fn themes_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("themes"))
}

/// Subdirectory holding the compiled (scoped) CSS. Users do not edit these
/// directly; M↓ overwrites them on every compile.
pub fn compiled_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(themes_dir(app)?.join(".compiled"))
}

/// Path to the source CSS for theme id `id` (no validation here — caller
/// must have already validated `id`).
pub fn source_path<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    Ok(themes_dir(app)?.join(format!("{id}.css")))
}

/// Path to the compiled CSS for theme id `id`.
pub fn compiled_path<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    Ok(compiled_dir(app)?.join(format!("{id}.css")))
}

/// Path to the optional same-named asset folder for theme id `id`.
pub fn asset_dir<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    Ok(themes_dir(app)?.join(id))
}

/// Ensure `themes/` and `themes/.compiled/` exist (creates them if missing).
pub fn ensure_dirs<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    std::fs::create_dir_all(themes_dir(app)?).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(compiled_dir(app)?).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 3: Register module in lib.rs**

Modify `src-tauri/src/lib.rs` — find the line `pub mod plugin_host;` (around line 13) and append:

```rust
pub mod plugin_host;
pub mod themes;
```

- [ ] **Step 4: Compile check**

Run: `cd src-tauri && cargo check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(theme): scaffold themes module + path helpers

Adds src-tauri/src/themes/ with paths.rs providing themes_dir,
compiled_dir, source_path, compiled_path, asset_dir, ensure_dirs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Theme id validation (TDD)

**Files:**
- Create: `src-tauri/src/themes/id.rs`
- Modify: `src-tauri/src/themes/mod.rs` (add `pub mod id;`)
- Create: `src-tauri/tests/themes_id_test.rs`

- [ ] **Step 1: Write the failing test file**

Create `src-tauri/tests/themes_id_test.rs`:

```rust
use mdeditor_lib::themes::id::{is_valid_theme_id, ThemeIdError};

#[test]
fn accepts_simple_lowercase() {
    assert!(is_valid_theme_id("default").is_ok());
    assert!(is_valid_theme_id("effie").is_ok());
}

#[test]
fn accepts_hyphens_underscores_dots_digits() {
    assert!(is_valid_theme_id("claude-like").is_ok());
    assert!(is_valid_theme_id("theme_v2").is_ok());
    assert!(is_valid_theme_id("dracula.dark").is_ok());
    assert!(is_valid_theme_id("a1b2c3").is_ok());
}

#[test]
fn rejects_empty() {
    assert_eq!(is_valid_theme_id(""), Err(ThemeIdError::Empty));
}

#[test]
fn rejects_uppercase() {
    assert_eq!(is_valid_theme_id("Default"), Err(ThemeIdError::InvalidChar('D')));
    assert_eq!(is_valid_theme_id("clauDe"), Err(ThemeIdError::InvalidChar('D')));
}

#[test]
fn rejects_leading_punctuation() {
    assert_eq!(is_valid_theme_id("-foo"), Err(ThemeIdError::BadLeadingChar('-')));
    assert_eq!(is_valid_theme_id(".hidden"), Err(ThemeIdError::BadLeadingChar('.')));
    assert_eq!(is_valid_theme_id("_x"), Err(ThemeIdError::BadLeadingChar('_')));
}

#[test]
fn rejects_spaces_and_slashes() {
    assert_eq!(is_valid_theme_id("my theme"), Err(ThemeIdError::InvalidChar(' ')));
    assert_eq!(is_valid_theme_id("a/b"), Err(ThemeIdError::InvalidChar('/')));
    assert_eq!(is_valid_theme_id("..").is_err(), true);
}
```

- [ ] **Step 2: Verify it fails to compile**

Run: `cd src-tauri && cargo test --test themes_id_test`
Expected: compile error — `themes::id` module not found.

- [ ] **Step 3: Implement the module**

Create `src-tauri/src/themes/id.rs`:

```rust
//! Theme id validation. IDs match `[a-z0-9][a-z0-9._-]*`.

#[derive(Debug, PartialEq, Eq)]
pub enum ThemeIdError {
    Empty,
    BadLeadingChar(char),
    InvalidChar(char),
}

pub fn is_valid_theme_id(id: &str) -> Result<(), ThemeIdError> {
    let mut chars = id.chars();
    let first = chars.next().ok_or(ThemeIdError::Empty)?;
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(ThemeIdError::BadLeadingChar(first));
    }
    for c in chars {
        let ok = c.is_ascii_lowercase()
            || c.is_ascii_digit()
            || c == '-'
            || c == '_'
            || c == '.';
        if !ok {
            return Err(ThemeIdError::InvalidChar(c));
        }
    }
    Ok(())
}
```

Modify `src-tauri/src/themes/mod.rs` — append:

```rust
pub mod id;
```

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_id_test`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/id.rs src-tauri/src/themes/mod.rs src-tauri/tests/themes_id_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): theme id validation

IDs match [a-z0-9][a-z0-9._-]*. Surfaces specific ThemeIdError variants
so the import dialog can show actionable messages.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: CSS metadata header parser (TDD)

**Files:**
- Create: `src-tauri/src/themes/header.rs`
- Modify: `src-tauri/src/themes/mod.rs` (add `pub mod header;`)
- Create: `src-tauri/tests/themes_header_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/themes_header_test.rs`:

```rust
use mdeditor_lib::themes::header::{parse_header, ParsedHeader};

#[test]
fn parses_full_header() {
    let css = "/*\n * Theme Name: Claude-Like\n * Author: anonymous\n * Version: 1.0.0\n * Appearance: light\n * Description: Warm paper.\n */\n:root { --bg: #fff; }";
    let h = parse_header(css);
    assert_eq!(h.name.as_deref(), Some("Claude-Like"));
    assert_eq!(h.author.as_deref(), Some("anonymous"));
    assert_eq!(h.version.as_deref(), Some("1.0.0"));
    assert_eq!(h.appearance.as_deref(), Some("light"));
    assert_eq!(h.description.as_deref(), Some("Warm paper."));
}

#[test]
fn returns_empty_when_no_header() {
    let css = ":root { --bg: #fff; }";
    let h = parse_header(css);
    assert!(h.name.is_none());
    assert!(h.appearance.is_none());
}

#[test]
fn case_insensitive_keys() {
    let css = "/*\n * THEME NAME: Foo\n * appearance: DARK\n */\nbody {}";
    let h = parse_header(css);
    assert_eq!(h.name.as_deref(), Some("Foo"));
    assert_eq!(h.appearance.as_deref(), Some("DARK"));
}

#[test]
fn ignores_lines_without_colon() {
    let css = "/*\n * Hello, world!\n * Theme Name: X\n */";
    let h = parse_header(css);
    assert_eq!(h.name.as_deref(), Some("X"));
}

#[test]
fn trims_whitespace_around_value() {
    let css = "/*\n * Theme Name:    Spacey   \n */";
    let h = parse_header(css);
    assert_eq!(h.name.as_deref(), Some("Spacey"));
}

#[test]
fn only_first_comment_block_is_inspected() {
    let css = "/*\n * Theme Name: First\n */\n:root {}\n/*\n * Theme Name: Second\n */";
    let h = parse_header(css);
    assert_eq!(h.name.as_deref(), Some("First"));
}

#[test]
fn handles_bom_and_charset_before_header() {
    let css = "\u{FEFF}@charset \"UTF-8\";\n/*\n * Theme Name: X\n */";
    let h = parse_header(css);
    assert_eq!(h.name.as_deref(), Some("X"));
}

#[test]
fn handles_crlf_line_endings() {
    let css = "/*\r\n * Theme Name: X\r\n * Appearance: dark\r\n */";
    let h = parse_header(css);
    assert_eq!(h.name.as_deref(), Some("X"));
    assert_eq!(h.appearance.as_deref(), Some("dark"));
}

#[test]
fn no_comment_at_all_returns_empty() {
    let h = parse_header("");
    assert!(h.name.is_none());
    assert!(h.appearance.is_none());
    assert!(h.author.is_none());
}
```

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_header_test`
Expected: compile error — `themes::header` not found.

- [ ] **Step 3: Implement**

Create `src-tauri/src/themes/header.rs`:

```rust
//! Parse the first CSS comment block as Typora-format `Key: Value` metadata.

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParsedHeader {
    pub name: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
    pub appearance: Option<String>,
    pub description: Option<String>,
}

pub fn parse_header(css: &str) -> ParsedHeader {
    let mut out = ParsedHeader::default();
    let Some(block) = first_comment_block(css) else { return out };
    for line in block.lines() {
        // Strip leading whitespace and the optional leading `*` Typora uses.
        let mut line = line.trim_start();
        line = line.trim_start_matches('*').trim_start();
        let Some((key_raw, val_raw)) = line.split_once(':') else { continue };
        let key = key_raw.trim().to_ascii_lowercase();
        let val = val_raw.trim().to_string();
        if val.is_empty() { continue }
        match key.as_str() {
            "theme name" => out.name = Some(val),
            "author"     => out.author = Some(val),
            "version"    => out.version = Some(val),
            "appearance" => out.appearance = Some(val),
            "description" => out.description = Some(val),
            _ => {}
        }
    }
    out
}

fn first_comment_block(css: &str) -> Option<&str> {
    // Skip BOM
    let css = css.strip_prefix('\u{FEFF}').unwrap_or(css);
    // Skip leading whitespace + optional @charset declaration.
    let mut rest = css.trim_start();
    if rest.starts_with("@charset") {
        if let Some(end) = rest.find(';') {
            rest = rest[end + 1..].trim_start();
        }
    }
    if !rest.starts_with("/*") { return None }
    let after_open = &rest[2..];
    let close = after_open.find("*/")?;
    Some(&after_open[..close])
}
```

Modify `src-tauri/src/themes/mod.rs` — append:

```rust
pub mod header;
```

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_header_test`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/header.rs src-tauri/src/themes/mod.rs src-tauri/tests/themes_header_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): CSS metadata header parser

Parses the first /* ... */ block in a Typora theme CSS for
Theme Name / Author / Version / Appearance / Description.
Handles BOM, @charset prefix, CRLF, case-insensitive keys.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Filename appearance heuristic (TDD)

**Files:**
- Create: `src-tauri/src/themes/appearance.rs`
- Modify: `src-tauri/src/themes/mod.rs` (add `pub mod appearance;`)
- Create: `src-tauri/tests/themes_appearance_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/themes_appearance_test.rs`:

```rust
use mdeditor_lib::themes::appearance::{resolve_appearance, title_case_from_stem, Appearance};

#[test]
fn explicit_header_wins() {
    assert_eq!(resolve_appearance(Some("dark"), "anything-light"), Appearance::Dark);
    assert_eq!(resolve_appearance(Some("LIGHT"), "anything-dark"), Appearance::Light);
}

#[test]
fn unknown_header_falls_through_to_stem() {
    assert_eq!(resolve_appearance(Some("amber"), "warm-dark"), Appearance::Dark);
    assert_eq!(resolve_appearance(Some(""), "default"), Appearance::Light);
}

#[test]
fn stem_dark_keyword_at_end() {
    assert_eq!(resolve_appearance(None, "claude-like-dark"), Appearance::Dark);
    assert_eq!(resolve_appearance(None, "claude_dark"), Appearance::Dark);
}

#[test]
fn stem_dark_keyword_at_start() {
    assert_eq!(resolve_appearance(None, "dark-claude"), Appearance::Dark);
    assert_eq!(resolve_appearance(None, "night-mode"), Appearance::Dark);
}

#[test]
fn stem_dark_keyword_in_middle() {
    assert_eq!(resolve_appearance(None, "claude-dark-pro"), Appearance::Dark);
    assert_eq!(resolve_appearance(None, "a_night_b"), Appearance::Dark);
}

#[test]
fn substring_does_not_match() {
    assert_eq!(resolve_appearance(None, "darkroom"), Appearance::Light);
    assert_eq!(resolve_appearance(None, "midnighter"), Appearance::Light);
}

#[test]
fn unrelated_stems_are_light() {
    assert_eq!(resolve_appearance(None, "default"), Appearance::Light);
    assert_eq!(resolve_appearance(None, "claude-like"), Appearance::Light);
    assert_eq!(resolve_appearance(None, "claude-like-grey"), Appearance::Light);
}

#[test]
fn title_case_basic() {
    assert_eq!(title_case_from_stem("default"), "Default");
    assert_eq!(title_case_from_stem("claude-like"), "Claude-Like");
    assert_eq!(title_case_from_stem("claude-like-dark"), "Claude-Like Dark");
}

#[test]
fn title_case_underscores_dots() {
    assert_eq!(title_case_from_stem("theme_v2"), "Theme V2");
    assert_eq!(title_case_from_stem("dracula.dark"), "Dracula Dark");
}
```

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_appearance_test`
Expected: compile error.

- [ ] **Step 3: Implement**

Create `src-tauri/src/themes/appearance.rs`:

```rust
//! Light/dark appearance resolution from header value and file stem.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
    Light,
    Dark,
}

impl Appearance {
    pub fn as_str(self) -> &'static str {
        match self {
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        }
    }
}

/// Header value (if any) takes precedence when it's exactly `light` or `dark`
/// (case-insensitive). Otherwise the file stem is inspected for `dark` or
/// `night` as a whole token (delimited by start/end or `[-_]`).
pub fn resolve_appearance(header_value: Option<&str>, stem: &str) -> Appearance {
    if let Some(v) = header_value {
        match v.trim().to_ascii_lowercase().as_str() {
            "light" => return Appearance::Light,
            "dark"  => return Appearance::Dark,
            _ => {}
        }
    }
    if stem_indicates_dark(stem) { Appearance::Dark } else { Appearance::Light }
}

fn stem_indicates_dark(stem: &str) -> bool {
    let lower = stem.to_ascii_lowercase();
    for keyword in &["dark", "night"] {
        if contains_token(&lower, keyword) { return true }
    }
    false
}

fn contains_token(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let nbytes = needle.as_bytes();
    let mut i = 0usize;
    while let Some(found) = haystack[i..].find(needle) {
        let start = i + found;
        let end = start + nbytes.len();
        let left_ok = start == 0 || matches!(bytes[start - 1], b'-' | b'_');
        let right_ok = end == bytes.len() || matches!(bytes[end], b'-' | b'_');
        if left_ok && right_ok { return true }
        i = start + 1;
    }
    false
}

/// `claude-like-dark` → "Claude-Like Dark". Tokens are split on `_` and `.`
/// (rendered as spaces). `-` is preserved.
pub fn title_case_from_stem(stem: &str) -> String {
    let normalized: String = stem.chars().map(|c| if c == '_' || c == '.' { ' ' } else { c }).collect();
    let mut out = String::with_capacity(normalized.len());
    let mut capitalize_next = true;
    for c in normalized.chars() {
        if c == ' ' || c == '-' {
            out.push(c);
            capitalize_next = true;
        } else if capitalize_next {
            for u in c.to_uppercase() { out.push(u); }
            capitalize_next = false;
        } else {
            out.push(c);
        }
    }
    out
}
```

Modify `src-tauri/src/themes/mod.rs` — append:

```rust
pub mod appearance;
```

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_appearance_test`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/appearance.rs src-tauri/src/themes/mod.rs src-tauri/tests/themes_appearance_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): appearance heuristic + title-case display name

resolve_appearance: header value 'light'|'dark' wins; otherwise
look for 'dark'/'night' as a whole token (delimited by start, end,
or [-_]) in the file stem. title_case_from_stem turns
'claude-like-dark' into 'Claude-Like Dark'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: ThemeMeta + scan_themes_dir (TDD)

**Files:**
- Create: `src-tauri/src/themes/registry.rs`
- Modify: `src-tauri/src/themes/mod.rs` (add `pub mod registry;`)
- Create: `src-tauri/tests/themes_registry_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/themes_registry_test.rs`:

```rust
use mdeditor_lib::themes::registry::{scan_themes_dir, ThemeMeta};
use std::fs;
use tempfile::tempdir;

fn write(dir: &std::path::Path, name: &str, body: &str) {
    fs::write(dir.join(name), body).unwrap();
}

#[test]
fn empty_dir_returns_empty_vec() {
    let d = tempdir().unwrap();
    let list = scan_themes_dir(d.path(), &["default", "effie"]).unwrap();
    assert!(list.is_empty());
}

#[test]
fn picks_up_css_with_header() {
    let d = tempdir().unwrap();
    write(d.path(), "claude-like.css",
        "/*\n * Theme Name: Claude-Like\n * Appearance: light\n */\n:root {}");
    let list = scan_themes_dir(d.path(), &["default"]).unwrap();
    assert_eq!(list.len(), 1);
    let m: &ThemeMeta = &list[0];
    assert_eq!(m.id, "claude-like");
    assert_eq!(m.name, "Claude-Like");
    assert_eq!(m.appearance.as_str(), "light");
    assert!(!m.built_in);
}

#[test]
fn no_header_uses_filename_heuristic_and_title_case() {
    let d = tempdir().unwrap();
    write(d.path(), "claude-like-dark.css", ":root {}");
    let list = scan_themes_dir(d.path(), &["default"]).unwrap();
    let m = &list[0];
    assert_eq!(m.id, "claude-like-dark");
    assert_eq!(m.name, "Claude-Like Dark");
    assert_eq!(m.appearance.as_str(), "dark");
}

#[test]
fn built_in_flag_is_set_for_known_ids() {
    let d = tempdir().unwrap();
    write(d.path(), "default.css", ":root {}");
    write(d.path(), "custom.css", ":root {}");
    let list = scan_themes_dir(d.path(), &["default", "effie"]).unwrap();
    let by_id = |id: &str| list.iter().find(|m| m.id == id).unwrap().built_in;
    assert!(by_id("default"));
    assert!(!by_id("custom"));
}

#[test]
fn skips_non_css_files_and_subdirs_quietly() {
    let d = tempdir().unwrap();
    write(d.path(), "valid.css", ":root {}");
    write(d.path(), "README.md", "hi");
    write(d.path(), "screenshot.png", "");
    fs::create_dir(d.path().join("valid")).unwrap();           // asset folder; ignored here
    fs::create_dir(d.path().join(".compiled")).unwrap();       // M↓ cache; ignored here
    let list = scan_themes_dir(d.path(), &["default"]).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "valid");
}

#[test]
fn skips_invalid_ids_with_warning() {
    let d = tempdir().unwrap();
    write(d.path(), "Bad Name.css", ":root {}");   // space + uppercase
    write(d.path(), "ok.css", ":root {}");
    let list = scan_themes_dir(d.path(), &["default"]).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "ok");
}

#[test]
fn list_is_sorted_by_display_name() {
    let d = tempdir().unwrap();
    write(d.path(), "zebra.css", ":root {}");
    write(d.path(), "apple.css", ":root {}");
    let list = scan_themes_dir(d.path(), &["default"]).unwrap();
    let names: Vec<&str> = list.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, vec!["Apple", "Zebra"]);
}

#[test]
fn missing_dir_returns_empty_not_error() {
    let d = tempdir().unwrap();
    let missing = d.path().join("does-not-exist");
    let list = scan_themes_dir(&missing, &["default"]).unwrap();
    assert!(list.is_empty());
}
```

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_registry_test`
Expected: compile error.

- [ ] **Step 3: Implement**

Create `src-tauri/src/themes/registry.rs`:

```rust
//! Scan the themes directory and produce ThemeMeta entries.

use crate::themes::appearance::{resolve_appearance, title_case_from_stem, Appearance};
use crate::themes::header::parse_header;
use crate::themes::id::is_valid_theme_id;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct ThemeMeta {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
    pub author: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub source: PathBuf,
    pub compiled: PathBuf,
    pub built_in: bool,
}

impl serde::Serialize for Appearance { /* via derive on enum below */ }
// NB: Appearance already derives nothing for serde — we redefine its derive
// macro in the appearance module. See companion change.

/// Scan `dir` for `*.css` files at the top level. Returns one `ThemeMeta` per
/// valid id, sorted by display name. Missing directory is treated as empty.
///
/// `built_in_ids` marks themes we shipped (used for the `built_in` flag and
/// the "Restore built-in themes" affordance).
pub fn scan_themes_dir(dir: &Path, built_in_ids: &[&str]) -> Result<Vec<ThemeMeta>, String> {
    let mut out: Vec<ThemeMeta> = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Some(ext) = path.extension().and_then(|s| s.to_str()) else { continue };
        if ext.to_ascii_lowercase() != "css" { continue }
        if is_valid_theme_id(stem).is_err() {
            eprintln!("[theme] skip invalid id: {:?}", path);
            continue
        }
        let css = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => { eprintln!("[theme] read {:?}: {e}", path); continue }
        };
        let header = parse_header(&css);
        let name = header.name.clone().unwrap_or_else(|| title_case_from_stem(stem));
        let appearance = resolve_appearance(header.appearance.as_deref(), stem);
        let compiled = dir.join(".compiled").join(format!("{stem}.css"));
        out.push(ThemeMeta {
            id: stem.to_string(),
            name,
            appearance,
            author: header.author,
            version: header.version,
            description: header.description,
            source: path,
            compiled,
            built_in: built_in_ids.iter().any(|b| *b == stem),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}
```

The above relies on `Appearance` being `Serialize`. Update `src-tauri/src/themes/appearance.rs` to add the derive — replace the `pub enum Appearance` block with:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Light,
    Dark,
}
```

And in `src-tauri/src/themes/registry.rs`, delete the stub block:

```rust
impl serde::Serialize for Appearance { /* ... */ }
// NB: ...
```

(Just remove those lines — the derive on `Appearance` handles serialization.)

Modify `src-tauri/src/themes/mod.rs` — append:

```rust
pub mod registry;
```

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_registry_test`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/registry.rs src-tauri/src/themes/appearance.rs src-tauri/src/themes/mod.rs src-tauri/tests/themes_registry_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): scan_themes_dir + ThemeMeta

Walks themes/*.css at top level, parses header, applies appearance
heuristic, marks built-ins, sorts by display name. Missing dir is
treated as empty (no error).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `@include-when-export` pre-stripper (TDD)

**Files:**
- Create: `src-tauri/src/themes/compiler.rs` (initial — `strip_include_when_export` only)
- Modify: `src-tauri/src/themes/mod.rs` (add `pub mod compiler;`)
- Create: `src-tauri/tests/themes_compiler_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/themes_compiler_test.rs`:

```rust
use mdeditor_lib::themes::compiler::strip_include_when_export;

#[test]
fn strips_basic_form() {
    let css = "@include-when-export url(https://fonts.example.com/x.css);\n:root {}";
    assert_eq!(strip_include_when_export(css), "\n:root {}");
}

#[test]
fn strips_with_extra_whitespace() {
    let css = "  @include-when-export   url(  https://x  )  ;\n.a {}";
    assert_eq!(strip_include_when_export(css), "\n.a {}");
}

#[test]
fn strips_multiple_occurrences() {
    let css = "@include-when-export url(a);\n.a {}\n@include-when-export url(b);\n.b {}";
    let out = strip_include_when_export(css);
    assert!(!out.contains("@include-when-export"));
    assert!(out.contains(".a"));
    assert!(out.contains(".b"));
}

#[test]
fn preserves_css_with_no_directive() {
    let css = ":root { --x: 1; }\n.a { color: red; }";
    assert_eq!(strip_include_when_export(css), css);
}

#[test]
fn does_not_strip_similarly_named_rules() {
    let css = "/* @include-when-export-comment */\n.a {}";
    assert_eq!(strip_include_when_export(css), css);
}
```

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_compiler_test`
Expected: compile error.

- [ ] **Step 3: Implement**

Create `src-tauri/src/themes/compiler.rs`:

```rust
//! CSS compilation pipeline: pre-strip Typora-private at-rules, parse with
//! lightningcss, rewrite selectors and url() targets, serialize.

/// Remove every `@include-when-export url(...)` at-rule from the source. This
/// runs *before* lightningcss parses the CSS because lightningcss treats
/// unknown at-rules as parse errors.
///
/// The pattern is line-anchored on the at-rule keyword; the value can wrap
/// across whitespace inside `url(...)`. We require a trailing `;` to avoid
/// matching inside comments or strings.
pub fn strip_include_when_export(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let bytes = css.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if css[i..].trim_start().starts_with("@include-when-export") {
            // Anchor to start of the at-rule and skip any leading whitespace
            // on the line so we don't leave hanging spaces.
            let line_start = css[..i].rfind('\n').map(|n| n + 1).unwrap_or(0);
            // Find the terminating `;`.
            if let Some(rel_end) = css[i..].find(';') {
                let semi = i + rel_end;
                // Replace [line_start..=semi] with nothing.
                out.truncate(line_start.min(out.len()));
                // Keep characters between `out.len()` cursor and the line
                // start as-is (they're already in `out`), but we need to
                // skip ahead past the semicolon.
                i = semi + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}
```

Wait — the loop above is byte-indexed but pushes single bytes as chars, which is wrong for multi-byte UTF-8. Replace the implementation with a char-iteration approach. Use this instead:

```rust
pub fn strip_include_when_export(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    loop {
        match rest.find("@include-when-export") {
            None => { out.push_str(rest); break }
            Some(idx) => {
                // Find start of this line so we also drop preceding indentation.
                let before = &rest[..idx];
                let line_start = before.rfind('\n').map(|n| n + 1).unwrap_or(0);
                // Emit everything up to the line start.
                out.push_str(&rest[..line_start]);
                // Find the terminating semicolon after the at-rule.
                let after = &rest[idx..];
                match after.find(';') {
                    None => {
                        // Malformed — bail and keep the rest verbatim.
                        out.push_str(after);
                        break
                    }
                    Some(semi_rel) => {
                        rest = &after[semi_rel + 1..];
                    }
                }
            }
        }
    }
    out
}
```

Modify `src-tauri/src/themes/mod.rs` — append:

```rust
pub mod compiler;
```

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_compiler_test`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/compiler.rs src-tauri/src/themes/mod.rs src-tauri/tests/themes_compiler_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): strip @include-when-export pre-pass

Removes Typora's private at-rule before lightningcss parses the CSS
(lightningcss treats unknown at-rules as parse errors).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Selector rewriter (TDD)

**Files:**
- Modify: `src-tauri/src/themes/compiler.rs` (add `rewrite_selectors`)
- Modify: `src-tauri/tests/themes_compiler_test.rs` (add tests)

The rewrite operates on selector strings, not on the lightningcss AST. We parse the stylesheet, serialize each rule's selectors back to a string, transform that string, and put it back. This sidesteps lifetime issues with `parcel_selectors::SelectorList` and gives us a small, well-tested function.

- [ ] **Step 1: Append failing tests**

Append to `src-tauri/tests/themes_compiler_test.rs`:

```rust
use mdeditor_lib::themes::compiler::rewrite_selector_text;

const SCOPE: &str = r#"[data-theme="x"] .moraya-editor"#;

#[test]
fn rewrites_root() {
    assert_eq!(rewrite_selector_text(":root", "x"), SCOPE);
}

#[test]
fn rewrites_write() {
    assert_eq!(rewrite_selector_text("#write", "x"), SCOPE);
}

#[test]
fn rewrites_html_and_body() {
    assert_eq!(rewrite_selector_text("html", "x"), SCOPE);
    assert_eq!(rewrites_body_alone("body", "x"), SCOPE);
}

fn rewrites_body_alone(sel: &str, id: &str) -> String { rewrite_selector_text(sel, id) }

#[test]
fn write_child_combinator_becomes_descendant() {
    assert_eq!(rewrite_selector_text("#write > h1", "x"), format!("{SCOPE} h1"));
    assert_eq!(rewrite_selector_text("#write>h1", "x"), format!("{SCOPE} h1"));
}

#[test]
fn write_descendant_unchanged_in_form() {
    assert_eq!(rewrite_selector_text("#write h1", "x"), format!("{SCOPE} h1"));
}

#[test]
fn prefixes_class_selector() {
    assert_eq!(
        rewrite_selector_text(".md-fences", "x"),
        format!("{SCOPE} .md-fences")
    );
}

#[test]
fn prefixes_compound_selector() {
    assert_eq!(
        rewrite_selector_text("a.external", "x"),
        format!("{SCOPE} a.external")
    );
}

#[test]
fn selector_list_each_element_prefixed() {
    let out = rewrite_selector_text("h1, h2, h3", "x");
    assert_eq!(out, format!("{SCOPE} h1, {SCOPE} h2, {SCOPE} h3"));
}

#[test]
fn selector_list_mixed_scope_and_other() {
    // `:root` rewrites to scope; `.foo` gets prefixed; dedupe identical results.
    let out = rewrite_selector_text(":root, .foo", "x");
    assert_eq!(out, format!("{SCOPE}, {SCOPE} .foo"));
}

#[test]
fn body_with_class_is_not_treated_as_scope() {
    // body.modal-open is a compound, not a bare body — prefix without replacement.
    assert_eq!(
        rewrite_selector_text("body.modal-open", "x"),
        format!("{SCOPE} body.modal-open")
    );
}

#[test]
fn scope_attribute_uses_id_verbatim() {
    let out = rewrite_selector_text("#write", "claude-like");
    assert_eq!(out, r#"[data-theme="claude-like"] .moraya-editor"#);
}
```

(Remove the helper `fn rewrites_body_alone` if Rust complains about ordering — inline the call instead. The body just exists to make the assertion symmetric in the test source.)

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_compiler_test`
Expected: compile error — `rewrite_selector_text` not found.

- [ ] **Step 3: Implement**

Append to `src-tauri/src/themes/compiler.rs`:

```rust
/// Rewrite a single CSS selector list string to a scoped form.
///
/// Algorithm: split on top-level commas → for each selector, tokenize into
/// (compound, combinator) pairs → substitute scope targets (`:root`,
/// `#write`, `html`, `body` when alone) with the SCOPE marker → normalize
/// child combinators following the scope to descendants → ensure exactly
/// one scope at the start → render. Selector-list results are de-duplicated.
pub fn rewrite_selector_text(input: &str, theme_id: &str) -> String {
    let scope = format!(r#"[data-theme="{theme_id}"] .moraya-editor"#);
    let mut parts: Vec<String> = Vec::new();
    for raw in split_top_level_comma(input) {
        parts.push(rewrite_one(raw.trim(), &scope));
    }
    // Deduplicate while preserving order.
    let mut seen: Vec<String> = Vec::new();
    for p in parts {
        if !seen.iter().any(|s| s == &p) { seen.push(p) }
    }
    seen.join(", ")
}

fn rewrite_one(sel: &str, scope: &str) -> String {
    let tokens = tokenize_selector(sel);
    // tokens is a flat list alternating (compound, combinator); first is compound.
    // Substitute scope targets when compound is exactly one of the four.
    let mut rebuilt: Vec<SelToken> = Vec::with_capacity(tokens.len());
    for tok in tokens {
        match tok {
            SelToken::Compound(s) if is_scope_target(&s) => {
                rebuilt.push(SelToken::ScopeMarker);
            }
            other => rebuilt.push(other),
        }
    }
    // Convert child combinators following a ScopeMarker into descendant.
    for i in 0..rebuilt.len().saturating_sub(1) {
        if matches!(rebuilt[i], SelToken::ScopeMarker)
            && matches!(rebuilt[i + 1], SelToken::Combinator('>'))
        {
            rebuilt[i + 1] = SelToken::Combinator(' ');
        }
    }
    // Ensure exactly one leading ScopeMarker.
    let has_leading_scope = matches!(rebuilt.first(), Some(SelToken::ScopeMarker));
    if !has_leading_scope {
        rebuilt.insert(0, SelToken::Combinator(' '));
        rebuilt.insert(0, SelToken::ScopeMarker);
    }
    // Render.
    let mut out = String::new();
    for tok in rebuilt {
        match tok {
            SelToken::ScopeMarker => out.push_str(scope),
            SelToken::Compound(s) => out.push_str(&s),
            SelToken::Combinator(' ') => out.push(' '),
            SelToken::Combinator(c) => {
                if !out.ends_with(' ') { out.push(' ') }
                out.push(c);
                out.push(' ');
            }
        }
    }
    // Collapse any double spaces.
    while out.contains("  ") { out = out.replace("  ", " ") }
    out.trim().to_string()
}

#[derive(Debug, Clone)]
enum SelToken {
    Compound(String),
    Combinator(char), // ' ' descendant, '>' child, '+' adjacent, '~' general
    ScopeMarker,
}

fn is_scope_target(compound: &str) -> bool {
    matches!(compound, ":root" | "#write" | "html" | "body")
}

fn tokenize_selector(sel: &str) -> Vec<SelToken> {
    let mut out: Vec<SelToken> = Vec::new();
    let mut current = String::new();
    let mut chars = sel.chars().peekable();
    let mut depth_paren = 0usize;
    let mut depth_bracket = 0usize;
    while let Some(c) = chars.next() {
        match c {
            '(' => { depth_paren += 1; current.push(c) }
            ')' => { if depth_paren > 0 { depth_paren -= 1 } current.push(c) }
            '[' => { depth_bracket += 1; current.push(c) }
            ']' => { if depth_bracket > 0 { depth_bracket -= 1 } current.push(c) }
            ' ' | '\t' | '\n' if depth_paren == 0 && depth_bracket == 0 => {
                if !current.is_empty() {
                    out.push(SelToken::Compound(std::mem::take(&mut current)));
                }
                // Peek next non-whitespace; if it's a structural combinator,
                // emit that; else emit descendant.
                while let Some(&p) = chars.peek() {
                    if p == ' ' || p == '\t' || p == '\n' { chars.next(); continue }
                    break;
                }
                match chars.peek() {
                    Some('>') | Some('+') | Some('~') => {
                        let c2 = chars.next().unwrap();
                        // Skip trailing whitespace.
                        while let Some(&p) = chars.peek() {
                            if p == ' ' || p == '\t' || p == '\n' { chars.next(); continue }
                            break;
                        }
                        out.push(SelToken::Combinator(c2));
                    }
                    Some(_) => out.push(SelToken::Combinator(' ')),
                    None => break,
                }
            }
            '>' | '+' | '~' if depth_paren == 0 && depth_bracket == 0 => {
                if !current.is_empty() {
                    out.push(SelToken::Compound(std::mem::take(&mut current)));
                }
                out.push(SelToken::Combinator(c));
                // Skip whitespace after combinator.
                while let Some(&p) = chars.peek() {
                    if p == ' ' || p == '\t' || p == '\n' { chars.next(); continue }
                    break;
                }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(SelToken::Compound(current));
    }
    out
}

fn split_top_level_comma(s: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut depth_paren = 0i32;
    let mut depth_bracket = 0i32;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'(' => depth_paren += 1,
            b')' => depth_paren -= 1,
            b'[' => depth_bracket += 1,
            b']' => depth_bracket -= 1,
            b',' if depth_paren == 0 && depth_bracket == 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < bytes.len() { out.push(&s[start..]) }
    out
}
```

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_compiler_test`
Expected: all tests pass (the 5 stripper tests + 11 selector-rewriter tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/compiler.rs src-tauri/tests/themes_compiler_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): selector rewriter

rewrite_selector_text scopes any Typora selector list to
[data-theme="<id>"] .moraya-editor:
  :root / #write / html / body alone → scope only
  #write > x          → SCOPE x  (child combinator dropped)
  selector-list       → each element scoped independently
  compound w/ html|body → just prefix, no replacement
String-level tokenizer respects (), []; de-dupes identical results.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `@font-face` `url()` rewriter (TDD)

**Files:**
- Modify: `src-tauri/src/themes/compiler.rs` (add `rewrite_font_face_urls`)
- Modify: `src-tauri/tests/themes_compiler_test.rs` (add tests)

- [ ] **Step 1: Append failing tests**

Append to `src-tauri/tests/themes_compiler_test.rs`:

```rust
use mdeditor_lib::themes::compiler::rewrite_url_value;

#[test]
fn relative_url_resolves_against_asset_dir() {
    let out = rewrite_url_value("./fonts/x.woff2", "/Users/u/themes/claude-like");
    assert_eq!(out, "file:///Users/u/themes/claude-like/fonts/x.woff2");
}

#[test]
fn implicit_relative_url() {
    let out = rewrite_url_value("fonts/x.woff2", "/Users/u/themes/cl");
    assert_eq!(out, "file:///Users/u/themes/cl/fonts/x.woff2");
}

#[test]
fn parent_path_returns_safe_blank() {
    let out = rewrite_url_value("../escape.woff2", "/Users/u/themes/cl");
    assert_eq!(out, "about:blank");
    let out = rewrite_url_value("./a/../../b.woff2", "/Users/u/themes/cl");
    assert_eq!(out, "about:blank");
}

#[test]
fn https_url_is_left_alone() {
    let out = rewrite_url_value("https://cdn.example.com/x.woff2", "/Users/u/themes/cl");
    assert_eq!(out, "https://cdn.example.com/x.woff2");
}

#[test]
fn data_url_is_left_alone() {
    let out = rewrite_url_value("data:font/woff2;base64,AAAA", "/Users/u/themes/cl");
    assert_eq!(out, "data:font/woff2;base64,AAAA");
}

#[test]
fn empty_url_is_left_alone() {
    let out = rewrite_url_value("", "/Users/u/themes/cl");
    assert_eq!(out, "");
}
```

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_compiler_test`
Expected: compile error.

- [ ] **Step 3: Implement**

Append to `src-tauri/src/themes/compiler.rs`:

```rust
use std::path::{Component, Path, PathBuf};

/// Rewrite a single `url(...)` payload (without the surrounding `url(` and
/// `)`, no quotes) for use in compiled CSS.
///
/// - Absolute URL schemes (`https:`, `http:`, `data:`, `file:`) are left alone.
/// - Empty string is left alone.
/// - Otherwise the value is treated as a path relative to `asset_dir` (the
///   theme's same-named asset folder). If the resolved path tries to escape
///   `asset_dir` via `..`, return `about:blank` to neuter the reference.
pub fn rewrite_url_value(value: &str, asset_dir: &str) -> String {
    if value.is_empty() { return String::new() }
    let lower = value.to_ascii_lowercase();
    for scheme in ["http://", "https://", "data:", "file://", "about:"] {
        if lower.starts_with(scheme) { return value.to_string() }
    }
    let base = Path::new(asset_dir);
    let candidate = base.join(value);
    let normalized = normalize(&candidate);
    if !normalized.starts_with(base) {
        return "about:blank".to_string();
    }
    format!("file://{}", normalized.display())
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
```

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_compiler_test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/compiler.rs src-tauri/tests/themes_compiler_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): @font-face url() rewriter

rewrite_url_value resolves relative urls against the theme's asset
dir, leaves http/https/data/file/about urls untouched, and returns
about:blank when the path tries to escape via .. (defense-in-depth
against hostile zip contents).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Full compile pipeline (TDD)

**Files:**
- Modify: `src-tauri/src/themes/compiler.rs` (add `compile_theme_css`)
- Modify: `src-tauri/tests/themes_compiler_test.rs` (end-to-end tests)

- [ ] **Step 1: Append failing tests**

Append to `src-tauri/tests/themes_compiler_test.rs`:

```rust
use mdeditor_lib::themes::compiler::compile_theme_css;

#[test]
fn end_to_end_minimal_theme() {
    let src = "/*\n * Theme Name: X\n */\n:root { --c: red; }\n#write h1 { color: var(--c); }";
    let out = compile_theme_css(src, "x", "/tmp/themes/x").expect("compile ok");
    assert!(out.contains(r#"[data-theme="x"] .moraya-editor"#));
    assert!(out.contains("--c: red"));
    assert!(out.contains("color: var(--c)"));
    assert!(!out.contains("#write"));
}

#[test]
fn end_to_end_strips_include_when_export() {
    let src = "@include-when-export url(https://x);\n:root {}";
    let out = compile_theme_css(src, "x", "/tmp/x").unwrap();
    assert!(!out.contains("@include-when-export"));
}

#[test]
fn end_to_end_preserves_media_print() {
    let src = "@media print { #write { color: black; } }";
    let out = compile_theme_css(src, "x", "/tmp/x").unwrap();
    assert!(out.contains("@media print"));
    assert!(out.contains(r#"[data-theme="x"] .moraya-editor"#));
}

#[test]
fn end_to_end_preserves_imports() {
    let src = "@import url(https://cdn.example.com/font.css);\n:root {}";
    let out = compile_theme_css(src, "x", "/tmp/x").unwrap();
    assert!(out.contains("@import"));
    assert!(out.contains("https://cdn.example.com/font.css"));
}

#[test]
fn end_to_end_rewrites_font_face_url() {
    let src = "@font-face { font-family: 'X'; src: url('./fonts/x.woff2') format('woff2'); }";
    let out = compile_theme_css(src, "claude-like", "/themes/claude-like").unwrap();
    assert!(out.contains("file:///themes/claude-like/fonts/x.woff2"));
}

#[test]
fn malformed_css_returns_err() {
    let src = ":root { color: ";  // unterminated
    let result = compile_theme_css(src, "x", "/tmp/x");
    assert!(result.is_err());
}
```

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_compiler_test`
Expected: compile error.

- [ ] **Step 3: Implement**

Append to `src-tauri/src/themes/compiler.rs`:

```rust
use lightningcss::{
    rules::CssRule,
    stylesheet::{ParserOptions, PrinterOptions, StyleSheet},
    traits::ToCss,
    values::url::Url,
};

/// Compile Typora source CSS into a scoped, M↓-ready form.
///
/// `theme_id` is used both as the `data-theme` attribute value and (with
/// `asset_dir`) to resolve relative `url(...)` paths inside `@font-face`.
pub fn compile_theme_css(src: &str, theme_id: &str, asset_dir: &str) -> Result<String, String> {
    let stripped = strip_include_when_export(src);
    let mut ss = StyleSheet::parse(&stripped, ParserOptions::default())
        .map_err(|e| format!("parse error: {e}"))?;
    rewrite_rules(&mut ss.rules.0, theme_id, asset_dir);
    let printed = ss
        .to_css(PrinterOptions { minify: false, ..PrinterOptions::default() })
        .map_err(|e| format!("print error: {e}"))?;
    Ok(printed.code)
}

fn rewrite_rules<'i>(rules: &mut Vec<CssRule<'i>>, theme_id: &str, asset_dir: &str) {
    for rule in rules.iter_mut() {
        match rule {
            CssRule::Style(style) => {
                let mut selector_str = String::new();
                style.selectors.to_css(&mut Printer::new(&mut selector_str, PrinterOptions::default())).ok();
                let rewritten = rewrite_selector_text(&selector_str, theme_id);
                // Re-parse the rewritten selectors back into the rule.
                let new_list = lightningcss::selector::SelectorList::parse_string_with_options(
                    &rewritten,
                    ParserOptions::default(),
                ).map_err(|e| format!("re-parse selectors {:?}: {e}", rewritten));
                if let Ok(new_list) = new_list {
                    style.selectors = new_list;
                }
                // Recurse into nested style rules (CSS nesting).
                rewrite_rules(&mut style.rules.0, theme_id, asset_dir);
            }
            CssRule::Media(media) => {
                rewrite_rules(&mut media.rules.0, theme_id, asset_dir);
            }
            CssRule::Supports(supports) => {
                rewrite_rules(&mut supports.rules.0, theme_id, asset_dir);
            }
            CssRule::FontFace(ff) => {
                use lightningcss::rules::font_face::FontFaceProperty;
                use lightningcss::rules::font_face::Source;
                for prop in ff.properties.iter_mut() {
                    if let FontFaceProperty::Source(sources) = prop {
                        for src in sources.iter_mut() {
                            if let Source::Url(u) = src {
                                let new_url = rewrite_url_value(&u.url.url, asset_dir);
                                u.url.url = new_url.into();
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    // Suppress unused warning if Url is unused after compile.
    let _ = std::marker::PhantomData::<Url>;
}

// Convenience to print a SelectorList to a string. lightningcss exposes
// a printer over any io::Write/std::fmt::Write target.
use lightningcss::printer::Printer;
```

> **Note on lightningcss API drift:** Type/method names above target
> `lightningcss = "1.0.0-alpha.66"` as named in Task 1. If a newer alpha
> renames items (e.g. `FontFaceProperty` → another enum), update the
> import paths to match; do not refactor the algorithm. Anchor on the
> tests in this task — if they pass, the integration is correct.

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_compiler_test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/compiler.rs src-tauri/tests/themes_compiler_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): full compile_theme_css pipeline

Pipeline: strip @include-when-export → lightningcss parse → recurse
through rules, rewriting Style selectors and @font-face src urls →
print non-minified. Preserves @media print, @import, and the rest of
the stylesheet untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: theme_list + theme_reveal + theme_recompile commands

**Files:**
- Create: `src-tauri/src/themes/commands.rs`
- Modify: `src-tauri/src/themes/mod.rs` (add `pub mod commands;`)
- Modify: `src-tauri/src/lib.rs` (register commands)

This task wires up scan/reveal/recompile to the Tauri command surface. There are no Rust unit tests at this level (we test the building blocks). The smoke tests in the README cover the wired behavior.

- [ ] **Step 1: Implement commands**

Create `src-tauri/src/themes/commands.rs`:

```rust
use crate::themes::compiler::compile_theme_css;
use crate::themes::paths::{compiled_path, compiled_dir, ensure_dirs, source_path, themes_dir, asset_dir};
use crate::themes::registry::{scan_themes_dir, ThemeMeta};

/// Ids of the themes we ship with the app. Used for the `built_in` flag and
/// the "Restore built-in themes" affordance.
pub const BUILT_IN_THEME_IDS: &[&str] = &["default", "effie"];

#[tauri::command]
pub fn theme_list(app: tauri::AppHandle) -> Result<Vec<ThemeMeta>, String> {
    ensure_dirs(&app)?;
    let dir = themes_dir(&app)?;
    scan_themes_dir(&dir, BUILT_IN_THEME_IDS)
}

#[tauri::command]
pub fn theme_reveal(app: tauri::AppHandle) -> Result<(), String> {
    ensure_dirs(&app)?;
    let dir = themes_dir(&app)?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = dir; Err("not supported on this platform".into()) }
}

#[tauri::command]
pub fn theme_recompile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    ensure_dirs(&app)?;
    let source = source_path(&app, &id)?;
    let compiled = compiled_path(&app, &id)?;
    let assets = asset_dir(&app, &id)?;
    let src = std::fs::read_to_string(&source).map_err(|e| e.to_string())?;
    let out = compile_theme_css(&src, &id, assets.to_str().unwrap_or(""))?;
    std::fs::write(&compiled, out).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn theme_recompile_all(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    ensure_dirs(&app)?;
    let list = theme_list(app.clone())?;
    let mut errs: Vec<String> = Vec::new();
    for meta in list {
        if let Err(e) = theme_recompile(app.clone(), meta.id.clone()) {
            errs.push(format!("{}: {e}", meta.id));
        }
    }
    Ok(errs)
}
```

Modify `src-tauri/src/themes/mod.rs` — append:

```rust
pub mod commands;
```

- [ ] **Step 2: Register commands in lib.rs**

Modify `src-tauri/src/lib.rs` — find the `invoke_handler` block (around line 224) and add the four theme commands. Find:

```rust
        .invoke_handler(tauri::generate_handler![
            quit_app,
            set_default_app_for_extensions,
            set_plugin_menu_item_enabled,
            plugin_host::get_plugin_manifests,
            plugin_host::get_all_plugin_manifests,
            plugin_host::invoke_plugin,
        ])
```

Replace with:

```rust
        .invoke_handler(tauri::generate_handler![
            quit_app,
            set_default_app_for_extensions,
            set_plugin_menu_item_enabled,
            plugin_host::get_plugin_manifests,
            plugin_host::get_all_plugin_manifests,
            plugin_host::invoke_plugin,
            themes::commands::theme_list,
            themes::commands::theme_reveal,
            themes::commands::theme_recompile,
            themes::commands::theme_recompile_all,
        ])
```

- [ ] **Step 3: Compile check**

Run: `cd src-tauri && cargo check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/themes/commands.rs src-tauri/src/themes/mod.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(theme): theme_list / theme_reveal / theme_recompile commands

Wires the registry + compiler to the Tauri command surface. Reveal
uses macOS `open` to surface the themes dir in Finder.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Hand-rewrite default.css to Typora source form

**Files:**
- Create: `src-tauri/resources/themes/default.css`

The bundled built-in is shipped as a Typora-format CSS — no `[data-skin]` prefix, plain selectors targeting `:root`, `#write`, etc. The compile pipeline produces the scoped form at install time.

- [ ] **Step 1: Create the resources directory**

Run: `mkdir -p /Users/bruce/git/mdeditor/src-tauri/resources/themes`

- [ ] **Step 2: Author `default.css`**

Create `src-tauri/resources/themes/default.css`:

```css
/*
 * Theme Name: Default
 * Author: M↓
 * Version: 1.0.0
 * Appearance: light
 * Description: GitHub-style sans-serif. Neutral and minimal. Auto-flips to dark via system colors.
 */

#write { line-height: 1.6; }

#write h1 { font-size: 2em;    font-weight: 700; margin: 1.2em 0 0.4em; }
#write h2 { font-size: 1.5em;  font-weight: 600; margin: 1.1em 0 0.4em; }
#write h3 { font-size: 1.25em; font-weight: 600; margin: 1em   0 0.3em; }
#write h4,
#write h5,
#write h6 { font-size: 1em; font-weight: 600; margin: 1em 0 0.3em; }

#write p { margin: 0.6em 0; }
#write a { color: #0969da; text-decoration: underline; }

#write blockquote {
  border-left: 3px solid color-mix(in srgb, CanvasText 30%, transparent);
  margin: 0.6em 0;
  padding: 0 12px;
  color: GrayText;
}

#write ul,
#write ol { padding-left: 1.6em; margin: 0.6em 0; }
#write li { margin: 0.2em 0; }

#write img { max-width: 100%; }

#write table { border-collapse: collapse; margin: 0.8em 0; }
#write th,
#write td {
  border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
  padding: 6px 10px;
}
#write hr {
  border: 0;
  border-top: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
  margin: 1em 0;
}

/* Inline code (not inside a pre). */
#write :not(pre) > code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  padding: 1px 4px;
  background: color-mix(in srgb, CanvasText 8%, transparent);
  border-radius: 3px;
}
```

- [ ] **Step 3: Spot-check by running the compiler manually**

This isn't a permanent test, but a sanity check before committing. Add a temporary one-off binary test (or use `cargo test` with an inline assertion):

Run: `cd src-tauri && cargo test --test themes_compiler_test`
Expected: existing tests still pass; no new test required for this task.

Alternative sanity check (optional): write a tiny scratch test that reads the file and compiles it. If it parses and produces output containing `[data-theme="default"] .moraya-editor`, it's good. Delete the scratch test after.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/resources/themes/default.css
git commit -m "$(cat <<'EOF'
feat(theme): bundle default.css as Typora source-form built-in

Plain selectors (#write, ...), Typora-format header comment. The
compile pipeline scopes them to [data-theme="default"] .moraya-editor
at install time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Hand-rewrite effie.css to Typora source form

**Files:**
- Create: `src-tauri/resources/themes/effie.css`

This task copies `src/styles/skins/effie.css`, drops every `[data-skin="effie"]` prefix, and adds a Typora header.

- [ ] **Step 1: Author `effie.css`**

Create `src-tauri/resources/themes/effie.css`:

```css
/*
 * Theme Name: Effie
 * Author: M↓
 * Version: 1.0.0
 * Appearance: light
 * Description: Mint paper, teal headings, purple strong, orange em. Auto-flips to a dark Dracula-mood palette via prefers-color-scheme.
 */

@import url('https://cdn.jsdelivr.net/npm/lxgw-wenkai-lite-webfont@1.7.0/lxgwwenkailite-regular.css');
@import url('https://cdn.jsdelivr.net/npm/lxgw-wenkai-lite-webfont@1.7.0/lxgwwenkailite-bold.css');
@import url('https://cdn.jsdelivr.net/npm/lxgw-wenkai-lite-webfont@1.7.0/lxgwwenkaimonolite-regular.css');

:root {
  background: #e8f0ea;
}

#write {
  font-family:
    'LXGW WenKai Lite',
    'Iowan Old Style', 'Charter', 'Georgia',
    'Source Han Serif SC', 'Noto Serif CJK SC',
    'Songti SC', 'STSong', serif;
  font-feature-settings: 'palt';
  font-size: 20px;
  font-weight: 400;
  line-height: 1.6;
  color: #2c2c2c;
  background: transparent;
  padding-left: 2.5em;
}

/* ── Headings ────────────────────────────────────────────────────────────── */

#write h1,
#write h2,
#write h3,
#write h4,
#write h5,
#write h6 {
  font-weight: 700;
  color: #4a8b8e;
  font-family: inherit;
}

#write h1 { font-size: 22px; margin: 1.6em 0 1em; }
#write h2 { font-size: 21px; margin: 1.4em 0 0.7em; }
#write h3 { font-size: 20px; margin: 1.2em 0 0.5em; }
#write h4 { font-size: 20px; margin: 1em 0 0.4em; }
#write h5 { font-size: 20px; margin: 1em 0 0.4em; color: #6ba8aa; }
#write h6 { font-size: 20px; margin: 1em 0 0.4em; color: #6ba8aa; }

#write h1,
#write h2,
#write h3,
#write h4 {
  position: relative;
}
#write h1::before,
#write h2::before,
#write h3::before,
#write h4::before {
  position: absolute;
  left: -2.5em;
  font-size: 0.9em;
  font-weight: 500;
  color: #95c0c2;
  letter-spacing: 0.04em;
  font-feature-settings: 'tnum';
}
#write h1::before { content: 'H1'; }
#write h2::before { content: 'H2'; }
#write h3::before { content: 'H3'; }
#write h4::before { content: 'H4'; }

/* ── Body text ───────────────────────────────────────────────────────────── */

#write p { margin: 0.9em 0; }

#write strong {
  color: #6a5fc6;
  font-weight: 700;
}
#write em {
  color: #cc7140;
  font-style: italic;
}

#write a {
  color: #6a5fc6;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

#write blockquote {
  border-left: 3px solid #b9d3d4;
  margin: 1.2em 0;
  padding: 0.4em 0.8em;
  color: #5c7f80;
  background: rgba(185, 211, 212, 0.12);
}

#write ol { padding-left: 2em; }
#write ol > li { margin: 0.4em 0; }
#write ol > li::marker {
  color: #4a8b8e;
  font-weight: 600;
}

#write ul {
  list-style: none;
  padding-left: 1.4em;
}
#write ul > li { position: relative; margin: 0.4em 0; }
#write ul > li::marker { content: ''; }

#write table {
  border-collapse: collapse;
  margin: 0.8em 0;
  width: 100%;
}
#write th,
#write td {
  border: 1px solid #b9d3d4;
  padding: 8px 12px;
  text-align: left;
}
#write th { font-weight: 700; }
#write td { font-weight: 400; }

#write hr {
  border: 0;
  height: 1px;
  background: #b9d3d4;
  margin: 1.6em 0;
}

#write img {
  max-width: 100%;
  margin: 0.6em 0;
}

#write :not(pre) > code {
  font-family: 'LXGW WenKai Mono Lite', ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.95em;
  padding: 1px 5px;
  background: rgba(106, 95, 198, 0.10);
  color: #6a5fc6;
  border-radius: 3px;
}

#write pre,
#write .code-block-pre,
#write .code-block-code {
  font-family: 'LXGW WenKai Mono Lite', ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  line-height: 1.5;
  background: rgba(74, 139, 142, 0.06);
  padding: 12px 14px;
  border-radius: 4px;
  border: 1px solid rgba(74, 139, 142, 0.18);
}

#write .code-block-wrapper,
#write pre:not(.code-block-pre),
#write .mermaid-preview,
#write .renderer-preview {
  background: rgba(74, 139, 142, 0.06);
  border-radius: 4px;
  border: 1px solid rgba(74, 139, 142, 0.18);
}

@media (prefers-color-scheme: dark) {
  :root {
    background: #1e2024;
  }

  #write {
    color: #d8d8d8;
  }

  #write h1,
  #write h2,
  #write h3,
  #write h4 {
    color: #79b3b5;
  }
  #write h5,
  #write h6 {
    color: #6da0a0;
  }

  #write h1::before,
  #write h2::before,
  #write h3::before,
  #write h4::before {
    color: #4d6f70;
  }

  #write ul > li::marker { color: #6da0a0; }

  #write strong { color: #ee8a4a; }
  #write em      { color: #ede78a; }

  #write a {
    color: #c39cf5;
    text-decoration-color: rgba(195, 156, 245, 0.4);
  }

  #write blockquote {
    border-left-color: #4d6f70;
    background: rgba(77, 111, 112, 0.18);
    color: #b0c4c5;
  }

  #write ol > li::marker { color: #6da0a0; }
  #write ul > li::before { color: #6da0a0; }

  #write :not(pre) > code {
    background: rgba(195, 156, 245, 0.18);
    color: #d8c0ff;
  }

  #write th,
  #write td {
    border-color: #4d6f70;
  }

  #write hr {
    background: #4d6f70;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/resources/themes/effie.css
git commit -m "$(cat <<'EOF'
feat(theme): bundle effie.css as Typora source-form built-in

Same visual content as the legacy [data-skin="effie"] CSS but with
plain selectors and a Typora header. compile_theme_css scopes it
at install time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Register `resources/themes/**/*` in Tauri bundle

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add resources entry**

Edit `src-tauri/tauri.conf.json`. Find:

```json
    "resources": [
      "plugins/**/*"
    ],
```

Replace with:

```json
    "resources": [
      "plugins/**/*",
      "resources/themes/**/*"
    ],
```

- [ ] **Step 2: Verify dev build still works**

Run: `pnpm tauri dev` for ~5 seconds, then quit. (Just to confirm the bundle hasn't broken.)
Expected: app launches, window appears.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "$(cat <<'EOF'
build(theme): bundle resources/themes/**/* as app resources

Available at runtime via app.path().resource_dir().join("resources/themes").

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: First-launch built-in migration

**Files:**
- Create: `src-tauri/src/themes/migration.rs`
- Modify: `src-tauri/src/themes/mod.rs` (add `pub mod migration;`)
- Modify: `src-tauri/src/lib.rs` (call from setup)
- Create: `src-tauri/tests/themes_migration_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/themes_migration_test.rs`:

```rust
use mdeditor_lib::themes::migration::copy_built_ins_if_missing;
use std::fs;
use tempfile::tempdir;

#[test]
fn copies_all_built_ins_when_themes_dir_empty() {
    let res = tempdir().unwrap();
    let themes = tempdir().unwrap();
    fs::write(res.path().join("default.css"), "/* d */").unwrap();
    fs::write(res.path().join("effie.css"), "/* e */").unwrap();
    let n = copy_built_ins_if_missing(res.path(), themes.path(), &["default", "effie"]).unwrap();
    assert_eq!(n, 2);
    assert!(themes.path().join("default.css").exists());
    assert!(themes.path().join("effie.css").exists());
}

#[test]
fn does_not_overwrite_existing() {
    let res = tempdir().unwrap();
    let themes = tempdir().unwrap();
    fs::write(res.path().join("default.css"), "/* new */").unwrap();
    fs::write(themes.path().join("default.css"), "/* user-edited */").unwrap();
    let n = copy_built_ins_if_missing(res.path(), themes.path(), &["default"]).unwrap();
    assert_eq!(n, 0);
    let body = fs::read_to_string(themes.path().join("default.css")).unwrap();
    assert_eq!(body, "/* user-edited */");
}

#[test]
fn missing_resource_is_warning_not_error() {
    let res = tempdir().unwrap();
    let themes = tempdir().unwrap();
    // resource dir is empty — no default.css to copy.
    let n = copy_built_ins_if_missing(res.path(), themes.path(), &["default"]).unwrap();
    assert_eq!(n, 0);
    assert!(!themes.path().join("default.css").exists());
}
```

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_migration_test`
Expected: compile error.

- [ ] **Step 3: Implement**

Create `src-tauri/src/themes/migration.rs`:

```rust
//! First-launch migration: copy built-in source CSS from app resources to
//! the user themes directory if (and only if) the user's copy is missing.

use std::path::Path;

/// Copies any built-in theme listed in `ids` from `res_dir` to `themes_dir`
/// when the destination file does not already exist. Returns the number of
/// files actually copied. Missing source files are logged and skipped (not
/// an error — the resource may have been excluded from a partial build).
///
/// Compilation of the copied files is the caller's responsibility (use
/// `theme_recompile_all` after migration to bring the .compiled cache in
/// sync).
pub fn copy_built_ins_if_missing(
    res_dir: &Path,
    themes_dir: &Path,
    ids: &[&str],
) -> Result<usize, String> {
    std::fs::create_dir_all(themes_dir).map_err(|e| e.to_string())?;
    let mut copied = 0usize;
    for id in ids {
        let src = res_dir.join(format!("{id}.css"));
        let dst = themes_dir.join(format!("{id}.css"));
        if dst.exists() { continue }
        if !src.exists() {
            eprintln!("[theme] built-in source missing: {:?}", src);
            continue;
        }
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        copied += 1;
    }
    Ok(copied)
}

/// Like `copy_built_ins_if_missing` but overwrites existing files. Used by
/// the "Restore built-in themes" command.
pub fn force_copy_built_ins(
    res_dir: &Path,
    themes_dir: &Path,
    ids: &[&str],
) -> Result<usize, String> {
    std::fs::create_dir_all(themes_dir).map_err(|e| e.to_string())?;
    let mut copied = 0usize;
    for id in ids {
        let src = res_dir.join(format!("{id}.css"));
        let dst = themes_dir.join(format!("{id}.css"));
        if !src.exists() {
            eprintln!("[theme] built-in source missing: {:?}", src);
            continue;
        }
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        copied += 1;
    }
    Ok(copied)
}
```

Modify `src-tauri/src/themes/mod.rs` — append:

```rust
pub mod migration;
```

- [ ] **Step 4: Wire into lib.rs setup**

Modify `src-tauri/src/lib.rs`. Find the `.setup(|app| {` block (around line 232) and locate `plugin_host::init(&app.handle());`. Add the theme bootstrap right after that line:

```rust
            plugin_host::init(&app.handle());

            // Bootstrap themes: ensure dirs exist, copy any missing built-ins,
            // and (re)compile every theme into .compiled/ so the frontend can
            // load fresh CSS without waiting on a separate compile pass.
            if let Err(e) = bootstrap_themes(&app.handle()) {
                eprintln!("[themes] bootstrap failed: {e}");
            }
```

Below `pub fn run()`, add a helper:

```rust
fn bootstrap_themes(app: &tauri::AppHandle) -> Result<(), String> {
    use themes::paths::{themes_dir, ensure_dirs};
    use themes::commands::BUILT_IN_THEME_IDS;

    ensure_dirs(app)?;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources").join("themes");
    let themes = themes_dir(app)?;
    themes::migration::copy_built_ins_if_missing(&res_dir, &themes, BUILT_IN_THEME_IDS)?;
    let _ = themes::commands::theme_recompile_all(app.clone());
    Ok(())
}
```

(`use tauri::Manager;` is already imported at the top of the file.)

- [ ] **Step 5: Run tests + compile check**

Run: `cd src-tauri && cargo test --test themes_migration_test && cargo check`
Expected: 3 passed, no compile errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/themes/migration.rs src-tauri/src/themes/mod.rs src-tauri/src/lib.rs src-tauri/tests/themes_migration_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): first-launch built-in migration

copy_built_ins_if_missing copies default.css + effie.css from app
resources into the user themes dir when absent. bootstrap_themes
runs at setup time, then recompiles all themes so the .compiled/
cache is fresh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: theme_restore_builtins command

**Files:**
- Modify: `src-tauri/src/themes/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register)

- [ ] **Step 1: Implement command**

Append to `src-tauri/src/themes/commands.rs`:

```rust
use tauri::Manager;

#[tauri::command]
pub fn theme_restore_builtins(app: tauri::AppHandle) -> Result<usize, String> {
    use crate::themes::migration::force_copy_built_ins;
    use crate::themes::paths::{themes_dir, ensure_dirs};
    ensure_dirs(&app)?;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources").join("themes");
    let themes = themes_dir(&app)?;
    let n = force_copy_built_ins(&res_dir, &themes, BUILT_IN_THEME_IDS)?;
    // Recompile so the .compiled/ cache reflects the restored sources.
    let _ = theme_recompile_all(app.clone());
    Ok(n)
}
```

- [ ] **Step 2: Register in lib.rs**

Add `themes::commands::theme_restore_builtins,` to the `generate_handler![...]` list in `src-tauri/src/lib.rs`.

- [ ] **Step 3: Compile check**

Run: `cd src-tauri && cargo check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/themes/commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(theme): theme_restore_builtins command

Force-copies built-in theme sources back into themes/, overwriting
any present version. Used by the Preferences "Restore built-in
themes" button.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Zip extraction safety (TDD)

**Files:**
- Create: `src-tauri/src/themes/zip_safety.rs`
- Modify: `src-tauri/src/themes/mod.rs` (add `pub mod zip_safety;`)
- Create: `src-tauri/tests/themes_zip_safety_test.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/themes_zip_safety_test.rs`:

```rust
use mdeditor_lib::themes::zip_safety::{extract_zip_safely, ExtractError, ExtractLimits};
use std::fs;
use std::io::Write;
use tempfile::tempdir;
use zip::write::SimpleFileOptions;

fn make_zip(dir: &std::path::Path, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
    let path = dir.join("test.zip");
    let f = fs::File::create(&path).unwrap();
    let mut zw = zip::ZipWriter::new(f);
    for (name, body) in entries {
        zw.start_file(*name, SimpleFileOptions::default()).unwrap();
        zw.write_all(body).unwrap();
    }
    zw.finish().unwrap();
    path
}

fn small_limits() -> ExtractLimits {
    ExtractLimits { max_entry_bytes: 5 * 1024 * 1024, max_total_bytes: 20 * 1024 * 1024 }
}

#[test]
fn extracts_valid_zip() {
    let scratch = tempdir().unwrap();
    let target = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[
        ("claude-like.css", b":root {}"),
        ("claude-like/fonts/x.txt", b"font-data"),
    ]);
    let report = extract_zip_safely(&zip, target.path(), small_limits()).unwrap();
    assert_eq!(report.entries_extracted, 2);
    assert!(target.path().join("claude-like.css").exists());
    assert!(target.path().join("claude-like/fonts/x.txt").exists());
}

#[test]
fn rejects_path_traversal() {
    let scratch = tempdir().unwrap();
    let target = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[
        ("../escape.css", b"bad"),
    ]);
    let err = extract_zip_safely(&zip, target.path(), small_limits()).unwrap_err();
    assert!(matches!(err, ExtractError::PathTraversal(_)));
}

#[test]
fn rejects_absolute_paths() {
    let scratch = tempdir().unwrap();
    let target = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[
        ("/etc/passwd", b"bad"),
    ]);
    let err = extract_zip_safely(&zip, target.path(), small_limits()).unwrap_err();
    assert!(matches!(err, ExtractError::PathTraversal(_)));
}

#[test]
fn rejects_per_entry_overflow() {
    let scratch = tempdir().unwrap();
    let target = tempdir().unwrap();
    let big: Vec<u8> = vec![b'x'; 6 * 1024 * 1024];
    let zip = make_zip(scratch.path(), &[("huge.css", &big)]);
    let err = extract_zip_safely(&zip, target.path(), small_limits()).unwrap_err();
    assert!(matches!(err, ExtractError::EntryTooLarge { .. }));
}

#[test]
fn rejects_total_overflow() {
    let scratch = tempdir().unwrap();
    let target = tempdir().unwrap();
    let chunk: Vec<u8> = vec![b'x'; 4 * 1024 * 1024];
    let zip = make_zip(scratch.path(), &[
        ("a.css", &chunk),
        ("b.css", &chunk),
        ("c.css", &chunk),
        ("d.css", &chunk),
        ("e.css", &chunk),
        ("f.css", &chunk),  // total 24 MB > 20 MB cap
    ]);
    let err = extract_zip_safely(&zip, target.path(), small_limits()).unwrap_err();
    assert!(matches!(err, ExtractError::TotalTooLarge { .. }));
}

#[test]
fn corrupt_zip_returns_err() {
    let scratch = tempdir().unwrap();
    let target = tempdir().unwrap();
    let zip = scratch.path().join("bad.zip");
    fs::write(&zip, b"not a zip").unwrap();
    let err = extract_zip_safely(&zip, target.path(), small_limits()).unwrap_err();
    assert!(matches!(err, ExtractError::Corrupt(_)));
}
```

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_zip_safety_test`
Expected: compile error.

- [ ] **Step 3: Implement**

Create `src-tauri/src/themes/zip_safety.rs`:

```rust
//! Zip extraction with bounds + path-traversal checks.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub enum ExtractError {
    Corrupt(String),
    PathTraversal(String),
    EntryTooLarge { name: String, bytes: u64 },
    TotalTooLarge { bytes: u64 },
    Io(String),
}

impl std::fmt::Display for ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractError::Corrupt(m) => write!(f, "corrupt zip: {m}"),
            ExtractError::PathTraversal(p) => write!(f, "path traversal: {p}"),
            ExtractError::EntryTooLarge { name, bytes } => write!(f, "entry too large: {name} ({bytes} bytes)"),
            ExtractError::TotalTooLarge { bytes } => write!(f, "total too large: {bytes} bytes"),
            ExtractError::Io(m) => write!(f, "i/o error: {m}"),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ExtractLimits {
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
}

impl Default for ExtractLimits {
    fn default() -> Self {
        Self { max_entry_bytes: 5 * 1024 * 1024, max_total_bytes: 20 * 1024 * 1024 }
    }
}

#[derive(Debug)]
pub struct ExtractReport {
    pub entries_extracted: usize,
    pub total_bytes: u64,
}

pub fn extract_zip_safely(
    zip_path: &Path,
    target: &Path,
    limits: ExtractLimits,
) -> Result<ExtractReport, ExtractError> {
    let f = std::fs::File::open(zip_path).map_err(|e| ExtractError::Io(e.to_string()))?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| ExtractError::Corrupt(e.to_string()))?;
    std::fs::create_dir_all(target).map_err(|e| ExtractError::Io(e.to_string()))?;
    let target = target.canonicalize().map_err(|e| ExtractError::Io(e.to_string()))?;

    let mut total: u64 = 0;
    let mut extracted: usize = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| ExtractError::Corrupt(e.to_string()))?;
        let entry_name = entry.name().to_string();
        if entry.is_dir() { continue }

        let relative = sanitize_entry_path(&entry_name)
            .ok_or_else(|| ExtractError::PathTraversal(entry_name.clone()))?;
        let dest = target.join(&relative);
        // Ensure dest stays under target after path joining + ../ normalization.
        let dest_normalized = normalize_path(&dest);
        if !dest_normalized.starts_with(&target) {
            return Err(ExtractError::PathTraversal(entry_name));
        }

        let size = entry.size();
        if size > limits.max_entry_bytes {
            return Err(ExtractError::EntryTooLarge { name: entry_name, bytes: size });
        }
        total = total.saturating_add(size);
        if total > limits.max_total_bytes {
            return Err(ExtractError::TotalTooLarge { bytes: total });
        }

        if let Some(parent) = dest_normalized.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ExtractError::Io(e.to_string()))?;
        }
        let mut out = std::fs::File::create(&dest_normalized).map_err(|e| ExtractError::Io(e.to_string()))?;
        let mut buf = vec![0u8; 8192];
        let mut written: u64 = 0;
        loop {
            let n = entry.read(&mut buf).map_err(|e| ExtractError::Io(e.to_string()))?;
            if n == 0 { break }
            written += n as u64;
            if written > limits.max_entry_bytes {
                return Err(ExtractError::EntryTooLarge { name: entry_name, bytes: written });
            }
            use std::io::Write;
            out.write_all(&buf[..n]).map_err(|e| ExtractError::Io(e.to_string()))?;
        }
        extracted += 1;
    }
    Ok(ExtractReport { entries_extracted: extracted, total_bytes: total })
}

/// Reject paths that are absolute or contain `..` components. Returns the
/// safe relative path otherwise.
fn sanitize_entry_path(name: &str) -> Option<PathBuf> {
    if name.starts_with('/') || name.starts_with('\\') { return None }
    let p = PathBuf::from(name);
    for comp in p.components() {
        match comp {
            Component::ParentDir => return None,
            Component::Prefix(_) | Component::RootDir => return None,
            _ => {}
        }
    }
    Some(p)
}

fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
```

Modify `src-tauri/src/themes/mod.rs` — append:

```rust
pub mod zip_safety;
```

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_zip_safety_test`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/zip_safety.rs src-tauri/src/themes/mod.rs src-tauri/tests/themes_zip_safety_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): zip extraction safety helpers

extract_zip_safely enforces 5 MB per-entry / 20 MB total caps,
rejects absolute paths and .. traversal, propagates corrupt-zip
errors. Backbone for the import flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: theme_import command (TDD)

**Files:**
- Create: `src-tauri/src/themes/import.rs`
- Modify: `src-tauri/src/themes/mod.rs` (add `pub mod import;`)
- Create: `src-tauri/tests/themes_import_test.rs`

`theme_import` extracts a zip to a tempdir, scans the result, returns a report to the frontend. It does **not** copy files into the user themes dir — that happens in `theme_install` after the user confirms.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/themes_import_test.rs`:

```rust
use mdeditor_lib::themes::import::{prepare_import, ImportReport};
use std::fs;
use std::io::Write;
use tempfile::tempdir;
use zip::write::SimpleFileOptions;

fn make_zip(dir: &std::path::Path, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
    let path = dir.join("t.zip");
    let f = fs::File::create(&path).unwrap();
    let mut zw = zip::ZipWriter::new(f);
    for (name, body) in entries {
        zw.start_file(*name, SimpleFileOptions::default()).unwrap();
        zw.write_all(body).unwrap();
    }
    zw.finish().unwrap();
    path
}

#[test]
fn detects_three_themes_from_typora_zip() {
    let scratch = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[
        ("claude-like.css",      b"/*\n * Theme Name: Claude-Like\n * Appearance: light\n */\n:root {}"),
        ("claude-like-grey.css", b"/*\n * Theme Name: Claude-Like Grey\n */\n:root {}"),
        ("claude-like-dark.css", b"/*\n * Theme Name: Claude-Like Dark\n * Appearance: dark\n */\n:root {}"),
    ]);
    let existing_ids = vec!["default".to_string(), "effie".to_string()];
    let report: ImportReport = prepare_import(&zip, &existing_ids).unwrap();
    assert_eq!(report.themes.len(), 3);
    assert_eq!(report.themes[0].id, "claude-like");
    assert_eq!(report.themes[0].appearance.as_str(), "light");
    assert_eq!(report.themes[1].id, "claude-like-dark");
    assert_eq!(report.themes[1].appearance.as_str(), "dark");
    assert_eq!(report.themes[2].id, "claude-like-grey");
    assert!(report.themes.iter().all(|t| !t.conflict));
    assert!(report.asset_dirs.is_empty());
}

#[test]
fn flags_conflicts_with_existing_ids() {
    let scratch = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[
        ("default.css", b"/*\n * Theme Name: Default Replacement\n */\n:root {}"),
        ("brand-new.css", b":root {}"),
    ]);
    let existing = vec!["default".to_string()];
    let report = prepare_import(&zip, &existing).unwrap();
    let by_id = |id: &str| report.themes.iter().find(|t| t.id == id).unwrap();
    assert!(by_id("default").conflict);
    assert!(!by_id("brand-new").conflict);
}

#[test]
fn detects_same_name_asset_directories() {
    let scratch = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[
        ("claude-like.css", b":root {}"),
        ("claude-like/fonts/x.woff2", b"font-bytes"),
    ]);
    let report = prepare_import(&zip, &[]).unwrap();
    assert_eq!(report.themes.len(), 1);
    assert_eq!(report.asset_dirs, vec!["claude-like".to_string()]);
}

#[test]
fn ignores_non_css_root_files_silently() {
    let scratch = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[
        ("ok.css", b":root {}"),
        ("README.md", b"# readme"),
        ("screenshot.png", b""),
    ]);
    let report = prepare_import(&zip, &[]).unwrap();
    assert_eq!(report.themes.len(), 1);
    assert_eq!(report.themes[0].id, "ok");
}

#[test]
fn invalid_css_is_reported_and_excluded() {
    let scratch = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[
        ("ok.css", b":root {}"),
        ("broken.css", b":root { color:"),  // unterminated
    ]);
    let report = prepare_import(&zip, &[]).unwrap();
    let ids: Vec<&str> = report.themes.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["ok"]);
    assert_eq!(report.errors.len(), 1);
    assert!(report.errors[0].file == "broken.css");
}

#[test]
fn empty_zip_returns_empty_report_no_error() {
    let scratch = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[
        ("README.md", b"hi"),
    ]);
    let report = prepare_import(&zip, &[]).unwrap();
    assert!(report.themes.is_empty());
    assert!(report.errors.is_empty());
}

#[test]
fn returns_temp_path_for_install() {
    let scratch = tempdir().unwrap();
    let zip = make_zip(scratch.path(), &[("ok.css", b":root {}")]);
    let report = prepare_import(&zip, &[]).unwrap();
    assert!(report.staging_dir.exists());
    assert!(report.staging_dir.join("ok.css").exists());
}
```

- [ ] **Step 2: Verify failure**

Run: `cd src-tauri && cargo test --test themes_import_test`
Expected: compile error.

- [ ] **Step 3: Implement**

Create `src-tauri/src/themes/import.rs`:

```rust
//! Two-stage import: prepare_import extracts a zip to a tempdir and returns
//! a report; install_prepared copies the report's staged files into the
//! user themes dir.

use crate::themes::appearance::{resolve_appearance, title_case_from_stem, Appearance};
use crate::themes::compiler::compile_theme_css;
use crate::themes::header::parse_header;
use crate::themes::id::is_valid_theme_id;
use crate::themes::zip_safety::{extract_zip_safely, ExtractError, ExtractLimits};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone)]
pub struct ImportTheme {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
    pub source_file: String,    // basename inside the staging dir
    pub conflict: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportError {
    pub file: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportReport {
    pub themes: Vec<ImportTheme>,
    pub asset_dirs: Vec<String>,
    pub errors: Vec<ImportError>,
    pub staging_dir: PathBuf,
}

pub fn prepare_import(zip_path: &Path, existing_ids: &[String]) -> Result<ImportReport, String> {
    // Persist staging dir across the import dialog round-trip by leaking a
    // TempDir handle. The matching `install_prepared` (and the cancel path)
    // remove the directory explicitly via `cleanup_staging`.
    let staging = tempfile::tempdir().map_err(|e| e.to_string())?;
    let staging_path = staging.path().to_path_buf();
    let limits = ExtractLimits::default();
    extract_zip_safely(zip_path, &staging_path, limits).map_err(|e: ExtractError| e.to_string())?;
    let _ = staging.into_path(); // detach lifetime; cleanup is explicit

    let mut themes: Vec<ImportTheme> = Vec::new();
    let mut errors: Vec<ImportError> = Vec::new();
    let mut asset_dirs: Vec<String> = Vec::new();

    let entries = std::fs::read_dir(&staging_path).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() { continue }  // asset dirs handled below
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Some(ext) = path.extension().and_then(|s| s.to_str()) else { continue };
        if ext.to_ascii_lowercase() != "css" { continue }
        if is_valid_theme_id(stem).is_err() {
            errors.push(ImportError {
                file: format!("{stem}.css"),
                message: "invalid theme id (must match [a-z0-9][a-z0-9._-]*)".into(),
            });
            continue;
        }
        let css = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => { errors.push(ImportError { file: format!("{stem}.css"), message: e.to_string() }); continue }
        };
        // Probe-compile to validate CSS syntax. We discard the output; the
        // real compile happens in install_prepared.
        if let Err(e) = compile_theme_css(&css, stem, &staging_path.join(stem).to_string_lossy()) {
            errors.push(ImportError { file: format!("{stem}.css"), message: e });
            continue;
        }
        let header = parse_header(&css);
        let name = header.name.unwrap_or_else(|| title_case_from_stem(stem));
        let appearance = resolve_appearance(header.appearance.as_deref(), stem);
        themes.push(ImportTheme {
            id: stem.to_string(),
            name,
            appearance,
            source_file: format!("{stem}.css"),
            conflict: existing_ids.iter().any(|e| e == stem),
        });
    }

    // Sort themes by name for deterministic UI ordering.
    themes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    // Detect same-name asset directories.
    let theme_id_set: std::collections::HashSet<&str> = themes.iter().map(|t| t.id.as_str()).collect();
    let entries = std::fs::read_dir(&staging_path).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        if theme_id_set.contains(name) {
            asset_dirs.push(name.to_string());
        }
    }
    asset_dirs.sort();

    Ok(ImportReport { themes, asset_dirs, errors, staging_dir: staging_path })
}

/// Copy staged files into `themes_dir`, then compile each. Returns the
/// number of themes installed. The staging dir is removed regardless of
/// outcome.
pub fn install_prepared(
    report: &ImportReport,
    themes_dir: &Path,
    overwrite: bool,
) -> Result<usize, String> {
    std::fs::create_dir_all(themes_dir).map_err(|e| e.to_string())?;
    let compiled_dir = themes_dir.join(".compiled");
    std::fs::create_dir_all(&compiled_dir).map_err(|e| e.to_string())?;
    let mut installed = 0usize;
    for theme in &report.themes {
        let dst = themes_dir.join(&theme.source_file);
        if dst.exists() && !overwrite { continue }
        let src = report.staging_dir.join(&theme.source_file);
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        // Copy companion asset dir if it exists.
        let asset_src = report.staging_dir.join(&theme.id);
        if asset_src.exists() && asset_src.is_dir() {
            copy_dir_all(&asset_src, &themes_dir.join(&theme.id)).map_err(|e| e.to_string())?;
        }
        // Compile.
        let css = std::fs::read_to_string(&dst).map_err(|e| e.to_string())?;
        let assets = themes_dir.join(&theme.id);
        let out = compile_theme_css(&css, &theme.id, assets.to_str().unwrap_or(""))?;
        std::fs::write(compiled_dir.join(&theme.source_file), out).map_err(|e| e.to_string())?;
        installed += 1;
    }
    cleanup_staging(&report.staging_dir);
    Ok(installed)
}

pub fn cleanup_staging(staging: &Path) {
    let _ = std::fs::remove_dir_all(staging);
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}
```

Modify `src-tauri/src/themes/mod.rs` — append:

```rust
pub mod import;
```

- [ ] **Step 4: Run tests, expect green**

Run: `cd src-tauri && cargo test --test themes_import_test`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/themes/import.rs src-tauri/src/themes/mod.rs src-tauri/tests/themes_import_test.rs
git commit -m "$(cat <<'EOF'
feat(theme): prepare_import + install_prepared

prepare_import extracts a zip to a staging dir, scans for CSS,
probe-compiles each for validation, and returns a report with
themes/asset-dirs/errors/staging-path. install_prepared copies
the staged files into themes/ (honoring overwrite), then compiles
each into .compiled/.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: theme_import + theme_install commands

**Files:**
- Modify: `src-tauri/src/themes/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register)

- [ ] **Step 1: Add commands**

Append to `src-tauri/src/themes/commands.rs`:

```rust
use crate::themes::import::{prepare_import, install_prepared, cleanup_staging, ImportReport};

#[tauri::command]
pub fn theme_import(app: tauri::AppHandle, zip_path: String) -> Result<ImportReport, String> {
    let existing: Vec<String> = theme_list(app)?.into_iter().map(|m| m.id).collect();
    prepare_import(std::path::Path::new(&zip_path), &existing)
}

#[tauri::command]
pub fn theme_install(app: tauri::AppHandle, report: ImportReport, overwrite: bool) -> Result<usize, String> {
    use crate::themes::paths::themes_dir;
    let dir = themes_dir(&app)?;
    let n = install_prepared(&report, &dir, overwrite)?;
    let _ = app.emit("themes-updated", ());
    Ok(n)
}

#[tauri::command]
pub fn theme_cancel_import(_app: tauri::AppHandle, staging_dir: String) {
    cleanup_staging(std::path::Path::new(&staging_dir));
}
```

Add `use tauri::Emitter;` if not already at top of file.

For `ImportReport` to flow over the Tauri IPC boundary, the struct already derives `Serialize`. We also need `Deserialize` for the install command's argument. Modify `src-tauri/src/themes/import.rs` to add `Deserialize` to the relevant derives:

```rust
use serde::{Serialize, Deserialize};
```

And change every:
- `#[derive(Debug, Serialize, Clone)]` → `#[derive(Debug, Serialize, Deserialize, Clone)]`

Also update `src-tauri/src/themes/appearance.rs` to derive `Deserialize`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance { Light, Dark }
```

- [ ] **Step 2: Register**

Add to `src-tauri/src/lib.rs` `generate_handler![...]`:

```rust
            themes::commands::theme_import,
            themes::commands::theme_install,
            themes::commands::theme_cancel_import,
```

- [ ] **Step 3: Compile check**

Run: `cd src-tauri && cargo check && cargo test`
Expected: all existing tests still green.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/themes src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(theme): theme_import / theme_install / theme_cancel_import

theme_import returns the prepared ImportReport (serializable, sent
to the frontend confirmation dialog). theme_install copies + compiles
on confirm. theme_cancel_import removes the staging dir when the
user backs out. Emits themes-updated on successful install.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Frontend — settings schema migration (TDD)

**Files:**
- Modify: `src/lib/settings.svelte.ts`
- Modify: `src/lib/settings.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/lib/settings.test.ts` (after the existing `describe('settings', ...)` block, before `describe('plugin-scoped settings', ...)`):

```ts
describe('theme settings', () => {
  it('migrates legacy `skin: "effie"` into theme.{light,dark,followSystem:false}', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'skin') return 'effie'
      if (key === 'theme') return undefined
      return undefined
    })
    const { loadSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    expect(settings.theme).toEqual({
      light: 'effie',
      dark: 'effie',
      followSystem: false,
    })
    const deleteCall = mockSet.mock.calls.find((args) => args[0] === 'skin')
    // The migration should also delete the legacy `skin` key on save.
    expect(deleteCall).toBeUndefined()
  })

  it('respects existing theme settings when present', async () => {
    const stored = { light: 'default', dark: 'effie', followSystem: true }
    mockGet.mockImplementation(async (key: string) =>
      key === 'theme' ? stored : undefined,
    )
    const { loadSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    expect(settings.theme).toEqual(stored)
  })

  it('defaults to {light:"default", dark:"default", followSystem:true} when nothing stored', async () => {
    mockGet.mockResolvedValue(undefined)
    const { loadSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    expect(settings.theme).toEqual({
      light: 'default',
      dark: 'default',
      followSystem: true,
    })
  })

  it('persists theme via saveSettings', async () => {
    mockGet.mockResolvedValue(undefined)
    const { loadSettings, saveSettings, settings } = await import('./settings.svelte')
    await loadSettings()
    settings.theme = { light: 'effie', dark: 'default', followSystem: false }
    await saveSettings()
    const setCall = mockSet.mock.calls.find((args) => args[0] === 'theme')
    expect(setCall?.[1]).toEqual({ light: 'effie', dark: 'default', followSystem: false })
  })
})
```

Also remove the old `describe('settings', ...)` block's `'loadSettings hydrates skin from store...'`, `'saveSettings writes skin under "skin" key'`, and `'loadSettings falls back to "default" when stored skin is unknown'` tests — they reference the legacy single-field shape that is being removed.

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/lib/settings.test.ts`
Expected: new theme tests fail (or compile error if `settings.theme` is not yet typed).

- [ ] **Step 3: Implement**

Modify `src/lib/settings.svelte.ts`:

Replace the existing `settings` `$state` block and KNOWN_SKIN_IDS with:

```ts
export interface ThemeSettings {
  light: string
  dark: string
  followSystem: boolean
}

const DEFAULT_THEME: ThemeSettings = { light: 'default', dark: 'default', followSystem: true }

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

(Remove the `skin: string` field entirely; remove `KNOWN_SKIN_IDS`.)

Replace `loadSettings` body to handle migration:

```ts
export async function loadSettings(): Promise<void> {
  const s = await getStore()
  settings.autoSave = (await s.get<boolean>('autoSave')) ?? false

  // Theme migration: prefer new shape; fall back to legacy single skin id.
  const storedTheme = await s.get<ThemeSettings>('theme')
  if (storedTheme && typeof storedTheme.light === 'string' && typeof storedTheme.dark === 'string') {
    settings.theme = {
      light: storedTheme.light,
      dark: storedTheme.dark,
      followSystem: storedTheme.followSystem !== false,
    }
  } else {
    const legacy = await s.get<string>('skin')
    if (legacy) {
      settings.theme = { light: legacy, dark: legacy, followSystem: false }
      // Drop the legacy key so future loads take the new path.
      await s.delete('skin')
    } else {
      settings.theme = { ...DEFAULT_THEME }
    }
  }

  recentFiles = (await s.get<string[]>('recentFiles')) ?? []
  recentModesByExt = (await s.get<Record<string, Mode>>('recentModesByExt')) ?? {}
  pluginScoped = (await s.get<Record<string, Record<string, unknown>>>('plugins')) ?? {}
  pluginsEnabled = (await s.get<Record<string, boolean>>('plugins.enabled')) ?? {}
  const storedMdblock = await s.get<MdblockSettings>('mdblock')
  settings.mdblock = storedMdblock
    ? {
        ...DEFAULT_MDBLOCK_SETTINGS,
        ...storedMdblock,
        hover: { ...DEFAULT_MDBLOCK_SETTINGS.hover, ...(storedMdblock.hover ?? {}) },
      }
    : structuredClone(DEFAULT_MDBLOCK_SETTINGS)
  pluginScopedVersion.value++
}
```

Replace `saveSettings`:

```ts
export async function saveSettings(): Promise<void> {
  const s = await getStore()
  await s.set('autoSave', settings.autoSave)
  await s.set('theme', settings.theme)
  await s.set('recentFiles', recentFiles)
  await s.set('recentModesByExt', recentModesByExt)
  await s.set('plugins', pluginScoped)
  await s.set('plugins.enabled', pluginsEnabled)
  await s.set('mdblock', settings.mdblock)
  await s.save()
}
```

- [ ] **Step 4: Run tests, expect green**

Run: `pnpm test src/lib/settings.test.ts`
Expected: all settings tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings.svelte.ts src/lib/settings.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): settings schema migration (skin → theme.{light,dark,followSystem})

loadSettings prefers the new `theme` shape; if absent but legacy
`skin` is present, migrates and deletes the legacy key. New defaults:
{ light: default, dark: default, followSystem: true }. saveSettings
writes only the new shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: Frontend — themes registry module (TDD)

**Files:**
- Create: `src/lib/themes.svelte.ts`
- Create: `src/lib/themes.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/themes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('themes registry', () => {
  it('hydrates list from theme_list', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'default', name: 'Default', appearance: 'light', source: '/x/default.css', compiled: '/x/.compiled/default.css', built_in: true },
      { id: 'effie',   name: 'Effie',   appearance: 'light', source: '/x/effie.css',   compiled: '/x/.compiled/effie.css',   built_in: true },
    ])
    const { themes, loadThemes } = await import('./themes.svelte')
    await loadThemes()
    expect(themes.list.length).toBe(2)
    expect(themes.list.map((t) => t.id)).toEqual(['default', 'effie'])
    expect(themes.error).toBeNull()
  })

  it('records error when invoke rejects', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue('boom')
    const { themes, loadThemes } = await import('./themes.svelte')
    await loadThemes()
    expect(themes.error).toBe('boom')
    expect(themes.list).toEqual([])
  })

  it('findById returns the meta or undefined', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'default', name: 'Default', appearance: 'light', source: '/a', compiled: '/b', built_in: true },
    ])
    const { findThemeById, loadThemes } = await import('./themes.svelte')
    await loadThemes()
    expect(findThemeById('default')?.name).toBe('Default')
    expect(findThemeById('missing')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/lib/themes.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `src/lib/themes.svelte.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'

export interface ThemeMeta {
  id: string
  name: string
  appearance: 'light' | 'dark'
  author?: string
  version?: string
  description?: string
  source: string
  compiled: string
  built_in: boolean
}

export const themes = $state<{ list: ThemeMeta[]; error: string | null }>({
  list: [],
  error: null,
})

export async function loadThemes(): Promise<void> {
  try {
    const list = await invoke<ThemeMeta[]>('theme_list')
    themes.list = list
    themes.error = null
  } catch (e) {
    themes.list = []
    themes.error = typeof e === 'string' ? e : String(e)
  }
}

export function findThemeById(id: string): ThemeMeta | undefined {
  return themes.list.find((t) => t.id === id)
}

export async function reloadThemes(): Promise<void> {
  await loadThemes()
}
```

- [ ] **Step 4: Run tests, expect green**

Run: `pnpm test src/lib/themes.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/themes.svelte.ts src/lib/themes.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): frontend themes registry

Reactive list hydrated from theme_list. Surfaces error string when
the invoke fails. findThemeById helper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: Frontend — theme-loader module (TDD)

**Files:**
- Create: `src/lib/theme-loader.ts`
- Create: `src/lib/theme-loader.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/theme-loader.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async (_p: string) => `/* css for ${_p} */`),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  document.head.innerHTML = ''
})

describe('theme-loader', () => {
  it('installs two style slots on first call', async () => {
    const { ensureThemeSlots, applyThemeContent } = await import('./theme-loader')
    ensureThemeSlots()
    expect(document.querySelectorAll('style[data-theme-slot]').length).toBe(2)
    expect(document.querySelector('style[data-theme-slot="light"]')).toBeTruthy()
    expect(document.querySelector('style[data-theme-slot="dark"]')).toBeTruthy()
    void applyThemeContent
  })

  it('writes CSS content into the named slot', async () => {
    const { applyThemeContent } = await import('./theme-loader')
    await applyThemeContent('light', '/themes/.compiled/default.css')
    const slot = document.querySelector('style[data-theme-slot="light"]')!
    expect(slot.textContent).toContain('default.css')
  })

  it('computeActiveThemeId picks light when !followSystem', () => {
    return import('./theme-loader').then(({ computeActiveThemeId }) => {
      const id = computeActiveThemeId(
        { light: 'a', dark: 'b', followSystem: false },
        true,    // systemDark
      )
      expect(id).toBe('a')
    })
  })

  it('computeActiveThemeId follows system when enabled', () => {
    return import('./theme-loader').then(({ computeActiveThemeId }) => {
      expect(computeActiveThemeId({ light: 'a', dark: 'b', followSystem: true }, true)).toBe('b')
      expect(computeActiveThemeId({ light: 'a', dark: 'b', followSystem: true }, false)).toBe('a')
    })
  })

  it('observePrefersColorScheme reports current value and updates on change', async () => {
    // jsdom does not implement matchMedia properly; mock it.
    let listeners: Array<(e: MediaQueryListEvent) => void> = []
    let matches = false
    ;(globalThis as unknown as { matchMedia: unknown }).matchMedia = vi.fn((q: string) => ({
      media: q,
      matches,
      addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => { listeners.push(cb) },
      removeEventListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }))
    const { observePrefersColorScheme } = await import('./theme-loader')
    const updates: boolean[] = []
    const stop = observePrefersColorScheme((dark) => updates.push(dark))
    expect(updates).toEqual([false])
    matches = true
    listeners.forEach((cb) => cb({ matches: true } as MediaQueryListEvent))
    expect(updates).toEqual([false, true])
    stop()
  })
})
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/lib/theme-loader.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `src/lib/theme-loader.ts`:

```ts
import { readTextFile } from '@tauri-apps/plugin-fs'

export type ThemeSlot = 'light' | 'dark'

export interface ThemeSettingsLike {
  light: string
  dark: string
  followSystem: boolean
}

export function ensureThemeSlots(): void {
  for (const slot of ['light', 'dark'] as ThemeSlot[]) {
    if (!document.querySelector(`style[data-theme-slot="${slot}"]`)) {
      const el = document.createElement('style')
      el.setAttribute('data-theme-slot', slot)
      document.head.appendChild(el)
    }
  }
}

/**
 * Read the compiled CSS at `compiledPath` and place it in the named slot.
 * Use after the active theme id for a slot has changed.
 */
export async function applyThemeContent(slot: ThemeSlot, compiledPath: string): Promise<void> {
  ensureThemeSlots()
  const el = document.querySelector(`style[data-theme-slot="${slot}"]`)
  if (!el) return
  try {
    const css = await readTextFile(compiledPath)
    el.textContent = css
  } catch (e) {
    console.warn('[theme-loader] applyThemeContent', slot, compiledPath, e)
    el.textContent = ''
  }
}

/**
 * Resolve the theme id whose CSS should currently match via `data-theme`.
 */
export function computeActiveThemeId(t: ThemeSettingsLike, systemDark: boolean): string {
  if (!t.followSystem) return t.light
  return systemDark ? t.dark : t.light
}

/**
 * Listen to `prefers-color-scheme: dark`. Calls back immediately with the
 * current value, then on every change. Returns a stop function.
 */
export function observePrefersColorScheme(cb: (dark: boolean) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  cb(mq.matches)
  const handler = (e: MediaQueryListEvent) => cb(e.matches)
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
```

- [ ] **Step 4: Run tests, expect green**

Run: `pnpm test src/lib/theme-loader.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/theme-loader.ts src/lib/theme-loader.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): theme-loader (style slots + active id + system-appearance observer)

ensureThemeSlots installs two <style data-theme-slot="...">.
applyThemeContent reads compiled CSS via tauri-plugin-fs and
writes into the named slot. computeActiveThemeId combines settings
+ system-dark into the id that should be on the editor host.
observePrefersColorScheme is a tiny matchMedia wrapper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 23: Rename `data-skin` → `data-theme` in RichEditor

**Files:**
- Modify: `src/components/RichEditor.svelte`

The CSS attribute is migrating from `data-skin` (one of the legacy `SkinId` values) to `data-theme` (a theme id, which may be any user-installed theme). The legacy skin module is removed in a later task.

- [ ] **Step 1: Update the host binding**

In `src/components/RichEditor.svelte`, find line 170:

```html
    <div class="host" data-skin={skin.current} bind:this={host}></div>
```

Replace with:

```html
    <div class="host" data-theme={activeThemeId} bind:this={host}></div>
```

- [ ] **Step 2: Replace the skin import**

Find the import line `import { skin } from '../lib/skin.svelte'` near the top of the file. Replace with:

```ts
  import { activeTheme } from '../lib/active-theme.svelte'
  // The reactive store of the currently active theme id is exposed by
  // theme-loader integration in App.svelte (Task 24). Default is 'default'.
  const activeThemeId = $derived(activeTheme.id)
```

(We're forward-referencing `active-theme.svelte`, which Task 24 creates. The build will fail here until Task 24 lands — that's fine because Task 23 alone is just textual prep.)

- [ ] **Step 3: Skip immediate build verification**

Because this task depends on Task 24's module, run only the syntactic check (no `pnpm dev`):

Run: `pnpm check 2>&1 | grep "RichEditor"` — there may be an "active-theme not found" error; that's expected and gets resolved by Task 24.

- [ ] **Step 4: Commit**

```bash
git add src/components/RichEditor.svelte
git commit -m "$(cat <<'EOF'
refactor(theme): RichEditor host uses data-theme + activeTheme store

Replaces data-skin={skin.current} with data-theme={activeTheme.id}.
The activeTheme store is added in the next commit; this one is the
mechanical attribute rename and import swap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 24: activeTheme store + App.svelte integration

**Files:**
- Create: `src/lib/active-theme.svelte.ts`
- Modify: `src/App.svelte`

- [ ] **Step 1: Create the active-theme store**

Create `src/lib/active-theme.svelte.ts`:

```ts
export const activeTheme = $state<{ id: string }>({ id: 'default' })

export function setActiveTheme(id: string): void {
  activeTheme.id = id
}
```

- [ ] **Step 2: Wire into App.svelte mount**

In `src/App.svelte`:

**A. Remove the legacy CSS imports** (lines 4–6):

```ts
  import './styles/skins/default.css'
  import './styles/skins/effie.css'
```

These two lines disappear entirely. The compiled CSS is now served from disk by `theme-loader`.

**B. Replace the skin-hydration block** (lines 56–62 — the comment + try/catch that imports skin module):

Find:

```ts
      // Sync persisted skin into the reactive skin module so RichEditor's
      // [data-skin] binding picks it up before first mount.
      try {
        const { skin: skinState } = await import('./lib/skin.svelte')
        const { settings: s } = await import('./lib/settings.svelte')
        if (s.skin === 'default' || s.skin === 'effie') skinState.current = s.skin
      } catch (e) { console.warn('[App] hydrate skin:', e) }
```

Replace with:

```ts
      // Theme initialization: load registry, install style slots, observe
      // system appearance, and keep activeTheme.id + slot CSS in sync.
      try {
        const { loadThemes, themes, findThemeById } = await import('./lib/themes.svelte')
        const { ensureThemeSlots, applyThemeContent, computeActiveThemeId, observePrefersColorScheme } = await import('./lib/theme-loader')
        const { setActiveTheme } = await import('./lib/active-theme.svelte')
        await loadThemes()
        ensureThemeSlots()

        let systemDark = false
        let lightAssigned: string | null = null
        let darkAssigned: string | null = null

        async function syncSlots() {
          const t = settings.theme
          if (t.light !== lightAssigned) {
            const meta = findThemeById(t.light)
            if (meta) { await applyThemeContent('light', meta.compiled) }
            lightAssigned = t.light
          }
          if (t.dark !== darkAssigned) {
            const meta = findThemeById(t.dark)
            if (meta) { await applyThemeContent('dark', meta.compiled) }
            darkAssigned = t.dark
          }
          setActiveTheme(computeActiveThemeId(t, systemDark))
        }

        const stopSystem = observePrefersColorScheme((dark) => {
          systemDark = dark
          void syncSlots()
        })
        // Re-sync whenever settings.theme changes (the dropdowns mutate it).
        const stopWatch = $effect.root(() => {
          $effect(() => {
            // Read every theme field so the effect reruns on any change.
            void settings.theme.light
            void settings.theme.dark
            void settings.theme.followSystem
            void syncSlots()
          })
        })
        // Also re-sync when themes list changes (import added new themes).
        const stopThemesWatch = $effect.root(() => {
          $effect(() => {
            void themes.list
            // Reset cache so next syncSlots picks up freshly compiled CSS.
            lightAssigned = null
            darkAssigned = null
            void syncSlots()
          })
        })
        ;(window as unknown as { __mdeditor_stop_theme?: () => void }).__mdeditor_stop_theme = () => {
          stopSystem()
          stopWatch()
          stopThemesWatch()
        }
      } catch (e) { console.warn('[App] theme init:', e) }
```

- [ ] **Step 3: Compile check**

Run: `pnpm check 2>&1 | tail -20`
Expected: no errors related to themes / theme-loader / active-theme.

- [ ] **Step 4: Manual sanity**

Run: `pnpm tauri dev` for ~10 seconds. Expected: app launches; editor renders styled by the default theme (`themes/default.css` is migrated and compiled on launch — see Task 15).

- [ ] **Step 5: Commit**

```bash
git add src/lib/active-theme.svelte.ts src/App.svelte
git commit -m "$(cat <<'EOF'
feat(theme): wire theme registry + loader + active-theme store in App.svelte

On mount: loadThemes, ensure two <style> slots, observe prefers-color-scheme,
keep both slots populated with their assigned theme's compiled CSS, and
update activeTheme.id from settings.theme + system appearance. Removes
the legacy bundled CSS imports (default.css, effie.css) — those files
now live in src-tauri/resources/themes/ and are loaded from disk.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 25: SettingsDialog — replace Skin row with Theme section

**Files:**
- Modify: `src/components/SettingsDialog.svelte`

- [ ] **Step 1: Replace imports**

In `src/components/SettingsDialog.svelte`, find line 6:

```ts
  import { SKINS, skin, setSkin, type SkinId, isValidSkinId } from '../lib/skin.svelte'
```

Replace with:

```ts
  import { themes, loadThemes, reloadThemes } from '../lib/themes.svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { open as openFilePicker } from '@tauri-apps/plugin-dialog'
  import ThemeImportDialog from './ThemeImportDialog.svelte'
```

(`invoke` is already imported; if a second import shows up, dedupe in the same change. `ask` is also already imported.)

- [ ] **Step 2: Replace the onSkinChange / describeSkin block**

Find the block:

```ts
  async function onSkinChange(e: Event) {
    const val = (e.currentTarget as HTMLSelectElement).value
    if (!isValidSkinId(val)) return
    setSkin(val)
    settings.skin = val
    await saveSettings()
  }

  function describeSkin(id: SkinId): string {
    return SKINS.find((s) => s.id === id)?.description ?? ''
  }
```

Replace with:

```ts
  let importReport = $state<unknown | null>(null)
  let importBusy = $state(false)

  async function onLightThemeChange(e: Event) {
    settings.theme.light = (e.currentTarget as HTMLSelectElement).value
    await saveSettings()
  }
  async function onDarkThemeChange(e: Event) {
    settings.theme.dark = (e.currentTarget as HTMLSelectElement).value
    await saveSettings()
  }
  async function onFollowSystemToggle(e: Event) {
    settings.theme.followSystem = !(e.currentTarget as HTMLInputElement).checked
    // Note: the *checkbox label* says "Always use light theme", so
    // checked means !followSystem.
    await saveSettings()
  }

  async function handleImportTheme() {
    const selection = await openFilePicker({
      multiple: false,
      directory: false,
      filters: [{ name: 'Typora theme zip', extensions: ['zip'] }],
    })
    if (!selection || Array.isArray(selection)) return
    importBusy = true
    try {
      importReport = await invoke('theme_import', { zipPath: selection })
    } catch (e) {
      console.warn('[Settings] theme_import:', e)
      importReport = { themes: [], asset_dirs: [], errors: [{ file: '?', message: String(e) }], staging_dir: '' }
    } finally {
      importBusy = false
    }
  }

  async function handleRevealThemes() {
    try { await invoke('theme_reveal') }
    catch (e) { console.warn('[Settings] theme_reveal:', e) }
  }

  async function handleReloadThemes() {
    await reloadThemes()
  }

  async function handleRestoreBuiltins() {
    try { await invoke('theme_restore_builtins') }
    catch (e) { console.warn('[Settings] theme_restore_builtins:', e) }
    await reloadThemes()
  }

  $effect(() => { void loadThemes() })
```

- [ ] **Step 3: Replace the Skin section in the template**

Find the section that starts with `<section class="block">` containing `<span class="lbl">Skin</span>` (around line 161–171). Replace the whole `<section class="block">…</section>` with:

```svelte
        <section class="block">
          <h3>Themes</h3>
          <label class="row">
            <span class="lbl">Light theme</span>
            <select value={settings.theme.light} onchange={onLightThemeChange}>
              {#each themes.list as t (t.id)}
                <option value={t.id}>{t.name}</option>
              {/each}
            </select>
          </label>
          <label class="row">
            <span class="lbl">Dark theme</span>
            <select value={settings.theme.dark} onchange={onDarkThemeChange}>
              {#each themes.list as t (t.id)}
                <option value={t.id}>{t.name}</option>
              {/each}
            </select>
          </label>
          <label class="row" style="margin-top: 6px;">
            <input
              type="checkbox"
              checked={!settings.theme.followSystem}
              onchange={onFollowSystemToggle}
            />
            Always use light theme (ignore system appearance)
          </label>
          <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 8px;">
            <button onclick={handleImportTheme} disabled={importBusy}>
              {importBusy ? 'Importing…' : 'Import Typora theme…'}
            </button>
            <button onclick={handleRevealThemes}>Reveal themes folder</button>
            <button onclick={handleReloadThemes}>Reload themes</button>
            <button onclick={handleRestoreBuiltins}>Restore built-in themes</button>
          </div>
          {#if themes.error}
            <p class="desc" style="color: tomato;">Failed to load themes: {themes.error}</p>
          {/if}
        </section>

        {#if importReport}
          <ThemeImportDialog
            report={importReport}
            onClose={() => { importReport = null; reloadThemes() }}
          />
        {/if}
```

- [ ] **Step 4: Compile check**

Run: `pnpm check 2>&1 | tail -10`
Expected: at most a warning about the missing `ThemeImportDialog` (created in Task 26). If errors mention `skin.svelte` or `SkinId`, ensure all references in SettingsDialog were removed.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsDialog.svelte
git commit -m "$(cat <<'EOF'
feat(theme): Preferences → Themes section (light/dark dropdowns + 4 buttons)

Replaces the single Skin row with two dropdowns (Light theme / Dark
theme), an "Always use light theme" override checkbox, and four buttons:
Import / Reveal / Reload / Restore built-ins. Mutates settings.theme;
saveSettings persists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 26: ThemeImportDialog component (TDD-ish)

**Files:**
- Create: `src/components/ThemeImportDialog.svelte`
- Create: `src/components/ThemeImportDialog.test.ts`

Svelte 5 component tests under Vitest typically use a mounting helper. To keep this lightweight, the test verifies the dialog renders expected fields from a `report` prop and invokes the right Tauri commands on confirm/cancel.

- [ ] **Step 1: Write the failing test**

Create `src/components/ThemeImportDialog.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, unmount } from 'svelte'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

const sampleReport = {
  themes: [
    { id: 'claude-like', name: 'Claude-Like', appearance: 'light', source_file: 'claude-like.css', conflict: false },
    { id: 'default',     name: 'Default',     appearance: 'light', source_file: 'default.css',     conflict: true  },
  ],
  asset_dirs: ['claude-like'],
  errors: [{ file: 'broken.css', message: 'parse error' }],
  staging_dir: '/tmp/staging',
}

describe('ThemeImportDialog', () => {
  it('renders theme names, conflict markers, asset dirs, and errors', async () => {
    const { default: ThemeImportDialog } = await import('./ThemeImportDialog.svelte')
    const app = mount(ThemeImportDialog as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { report: sampleReport, onClose: () => {} },
    })
    expect(document.body.textContent).toContain('Claude-Like')
    expect(document.body.textContent).toContain('Default')
    expect(document.body.textContent).toContain('will overwrite existing')
    expect(document.body.textContent).toContain('claude-like')   // asset dir
    expect(document.body.textContent).toContain('broken.css')    // error row
    expect(document.body.textContent).toContain('parse error')
    unmount(app)
  })

  it('requires overwrite checkbox when any theme is in conflict', async () => {
    const { default: ThemeImportDialog } = await import('./ThemeImportDialog.svelte')
    const app = mount(ThemeImportDialog as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { report: sampleReport, onClose: () => {} },
    })
    const btn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Import')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    const cb = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement
    cb.checked = true
    cb.dispatchEvent(new Event('change', { bubbles: true }))
    expect(btn.disabled).toBe(false)
    unmount(app)
  })

  it('invokes theme_install on confirm and calls onClose', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(2)
    const onClose = vi.fn()
    const noConflictReport = { ...sampleReport, themes: sampleReport.themes.map(t => ({ ...t, conflict: false })) }
    const { default: ThemeImportDialog } = await import('./ThemeImportDialog.svelte')
    const app = mount(ThemeImportDialog as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { report: noConflictReport, onClose },
    })
    const btn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Import')) as HTMLButtonElement
    btn.click()
    // Allow microtasks to flush.
    await new Promise((r) => setTimeout(r, 0))
    expect(invoke).toHaveBeenCalledWith('theme_install', expect.objectContaining({ report: expect.any(Object), overwrite: false }))
    expect(onClose).toHaveBeenCalled()
    unmount(app)
  })

  it('invokes theme_cancel_import on cancel', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const onClose = vi.fn()
    const { default: ThemeImportDialog } = await import('./ThemeImportDialog.svelte')
    const app = mount(ThemeImportDialog as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { report: sampleReport, onClose },
    })
    const btn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Cancel')) as HTMLButtonElement
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(invoke).toHaveBeenCalledWith('theme_cancel_import', { stagingDir: '/tmp/staging' })
    expect(onClose).toHaveBeenCalled()
    unmount(app)
  })
})
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/components/ThemeImportDialog.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `src/components/ThemeImportDialog.svelte`:

```svelte
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'

  interface ImportTheme {
    id: string
    name: string
    appearance: 'light' | 'dark'
    source_file: string
    conflict: boolean
  }
  interface ImportError { file: string; message: string }
  interface ImportReport {
    themes: ImportTheme[]
    asset_dirs: string[]
    errors: ImportError[]
    staging_dir: string
  }

  let { report, onClose }: { report: ImportReport; onClose: () => void } = $props()

  let overwrite = $state(false)
  let busy = $state(false)

  const hasConflict = $derived(report.themes.some((t) => t.conflict))
  const canImport = $derived(!busy && report.themes.length > 0 && (!hasConflict || overwrite))

  async function confirm() {
    busy = true
    try {
      const n = await invoke<number>('theme_install', { report, overwrite })
      console.info('[ThemeImport] installed', n, 'themes')
    } catch (e) {
      console.warn('[ThemeImport] install failed:', e)
    } finally {
      busy = false
      onClose()
    }
  }

  async function cancel() {
    busy = true
    try { await invoke('theme_cancel_import', { stagingDir: report.staging_dir }) }
    catch (e) { console.warn('[ThemeImport] cancel:', e) }
    finally { busy = false; onClose() }
  }
</script>

<div class="overlay" role="presentation" onclick={cancel}>
  <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
    <h2>Import Typora theme</h2>

    {#if report.themes.length === 0}
      <p>No Typora themes found in this zip.</p>
    {:else}
      <p>Detected {report.themes.length} theme{report.themes.length === 1 ? '' : 's'}:</p>
      <ul>
        {#each report.themes as t (t.id)}
          <li>
            <strong>{t.name}</strong> ({t.appearance})
            {#if t.conflict}<span class="warn">⚠ will overwrite existing</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if report.asset_dirs.length > 0}
      <p>Asset folders:</p>
      <ul>
        {#each report.asset_dirs as d (d)}<li>{d}</li>{/each}
      </ul>
    {/if}

    {#if report.errors.length > 0}
      <p>Errors:</p>
      <ul>
        {#each report.errors as e (e.file)}
          <li class="err">{e.file}: {e.message}</li>
        {/each}
      </ul>
    {/if}

    {#if hasConflict}
      <label class="overwrite">
        <input type="checkbox" checked={overwrite} onchange={(e) => overwrite = (e.currentTarget as HTMLInputElement).checked} />
        Overwrite existing themes
      </label>
    {/if}

    <div class="actions">
      <button onclick={cancel}>Cancel</button>
      <button class="primary" onclick={confirm} disabled={!canImport}>
        {busy ? 'Importing…' : 'Import'}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 200; }
  .dialog { background: Canvas; color: CanvasText; padding: 18px 22px; border-radius: 8px; min-width: 380px; max-width: 560px; max-height: 80vh; overflow: auto; }
  .dialog h2 { margin: 0 0 12px; font-size: 1.05rem; }
  .dialog ul { margin: 6px 0 12px; padding-left: 1.4em; }
  .warn { color: #b8860b; margin-left: 6px; }
  .err  { color: tomato; }
  .overwrite { display: flex; gap: 6px; align-items: center; margin: 10px 0; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .primary { font-weight: 600; }
</style>
```

- [ ] **Step 4: Run tests, expect green**

Run: `pnpm test src/components/ThemeImportDialog.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/components/ThemeImportDialog.svelte src/components/ThemeImportDialog.test.ts
git commit -m "$(cat <<'EOF'
feat(theme): ThemeImportDialog confirmation modal

Lists detected themes (with conflict flags), asset folders, and
errors. Disables Import until "Overwrite existing themes" is
checked when any row is in conflict. Confirm → theme_install;
Cancel → theme_cancel_import. Closes itself via onClose callback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 27: Drag-and-drop `.zip` routing

**Files:**
- Modify: `src/App.svelte`

The existing `onDragDropEvent` handler opens every dropped path as a tab. We add a precondition: if the path ends in `.zip`, dispatch `theme_import` and surface the dialog through the existing SettingsDialog mechanism. To keep state out of App.svelte, we use a small module-level store.

- [ ] **Step 1: Create a thin pending-import store**

Create `src/lib/theme-import-bus.svelte.ts`:

```ts
export const pendingThemeImport = $state<{ report: unknown | null }>({ report: null })
```

- [ ] **Step 2: Update App.svelte drag handler**

In `src/App.svelte`, find the `onDragDropEvent` block (around lines 187–193):

```ts
    const unlistenDrop = win.onDragDropEvent(async (event) => {
      if (event.payload.type === 'drop') {
        for (const path of event.payload.paths) {
          try { await openFile(path) } catch (e) { console.warn('[App] drop openFile:', e) }
        }
      }
    })
```

Replace with:

```ts
    const unlistenDrop = win.onDragDropEvent(async (event) => {
      if (event.payload.type === 'drop') {
        for (const path of event.payload.paths) {
          if (path.toLowerCase().endsWith('.zip')) {
            try {
              const report = await invoke('theme_import', { zipPath: path })
              const { pendingThemeImport } = await import('./lib/theme-import-bus.svelte')
              pendingThemeImport.report = report
              showSettings = true   // surface the SettingsDialog so its child dialog renders
            } catch (e) { console.warn('[App] drop theme_import:', e) }
            continue
          }
          try { await openFile(path) } catch (e) { console.warn('[App] drop openFile:', e) }
        }
      }
    })
```

- [ ] **Step 3: Plumb pendingThemeImport into SettingsDialog**

Modify `src/components/SettingsDialog.svelte`:

At the top of the `<script>`, after the existing imports:

```ts
  import { pendingThemeImport } from '../lib/theme-import-bus.svelte'
```

In the existing `let importReport = $state<unknown | null>(null)` declaration, replace with an effect that mirrors the bus:

```ts
  let importReport = $state<unknown | null>(null)
  $effect(() => {
    if (pendingThemeImport.report) {
      importReport = pendingThemeImport.report
      pendingThemeImport.report = null
    }
  })
```

- [ ] **Step 4: Compile + smoke**

Run: `pnpm check && pnpm tauri dev` for ~10s. Manually drag the spec's example zip (`~/Downloads/Typora_Claude-Like_Theme.zip` if available) onto the window — the import dialog should appear inside Preferences.

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte src/components/SettingsDialog.svelte src/lib/theme-import-bus.svelte.ts
git commit -m "$(cat <<'EOF'
feat(theme): route dropped .zip to theme_import + surface in Preferences

App.svelte's drop handler now branches: .zip → theme_import via a
small bus store; everything else → openFile (existing behavior).
SettingsDialog watches the bus and renders ThemeImportDialog when
a report appears.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 28: share-baker migration to compiled CSS

**Files:**
- Modify: `src/lib/plugins/share-baker.ts`
- Modify: `src/lib/plugins/share-baker.test.ts`

`share-baker` currently imports `default.css` and `effie.css` via Vite `?raw`. After this plan the legacy files are deleted and the active theme can be any user-installed CSS. share-baker now reads the **compiled** CSS for the user's active light theme from disk.

- [ ] **Step 1: Update share-baker.ts**

Open `src/lib/plugins/share-baker.ts`. Replace the top imports + `SKIN_CSS` constant (lines 1–23 area):

Find:

```ts
import { basename } from '../fs'
import type { Tab } from '../tabs.svelte'
import type { SkinId } from '../skin.svelte'
import {
  htmlEscape,
  renderTabAsInlineBody,
  renderTabBody as sharedRenderTabBody,
  inlineImages as sharedInlineImages,
  __setImageReaderForTests as sharedSetImageReader,
  buildPdfTitle,
} from './host-render-html'
import katexCss from 'katex/dist/katex.min.css?raw'
import hljsLightCss from 'highlight.js/styles/github.css?raw'
import hljsDarkCss from 'highlight.js/styles/github-dark.css?raw'
import defaultSkinCss from '../../styles/skins/default.css?raw'
import effieSkinCss from '../../styles/skins/effie.css?raw'

const SKIN_CSS: Record<SkinId, string> = {
  default: defaultSkinCss,
  effie: effieSkinCss,
}
```

Replace with:

```ts
import { basename } from '../fs'
import type { Tab } from '../tabs.svelte'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { findThemeById } from '../themes.svelte'
import {
  htmlEscape,
  renderTabAsInlineBody,
  renderTabBody as sharedRenderTabBody,
  inlineImages as sharedInlineImages,
  __setImageReaderForTests as sharedSetImageReader,
  buildPdfTitle,
} from './host-render-html'
import katexCss from 'katex/dist/katex.min.css?raw'
import hljsLightCss from 'highlight.js/styles/github.css?raw'
import hljsDarkCss from 'highlight.js/styles/github-dark.css?raw'

async function readThemeCss(themeId: string): Promise<string> {
  const meta = findThemeById(themeId)
  if (!meta) return ''
  try { return await readTextFile(meta.compiled) }
  catch (e) { console.warn('[share-baker] readThemeCss', themeId, e); return '' }
}
```

- [ ] **Step 2: Update the bakeShareHtml signature**

Find the `mobileOverridesCssBlock` function. Inside, the `[data-skin="effie"]` rules need to become `[data-theme="effie"]`. Replace lines containing `[data-skin="effie"]` with `[data-theme="effie"]`. (Three references.)

Find:

```ts
  /* effie: drop the 2.5em left gutter and hide the H-labels — no room on
     phones, and the labels look orphaned without their indent buddy. */
  [data-skin="effie"] .moraya-editor { padding-left: 0; }
  [data-skin="effie"] .moraya-editor h1::before,
  [data-skin="effie"] .moraya-editor h2::before,
  [data-skin="effie"] .moraya-editor h3::before,
  [data-skin="effie"] .moraya-editor h4::before { display: none; }
```

Replace with:

```ts
  /* effie: drop the 2.5em left gutter and hide the H-labels — no room on
     phones, and the labels look orphaned without their indent buddy. */
  [data-theme="effie"] .moraya-editor { padding-left: 0; }
  [data-theme="effie"] .moraya-editor h1::before,
  [data-theme="effie"] .moraya-editor h2::before,
  [data-theme="effie"] .moraya-editor h3::before,
  [data-theme="effie"] .moraya-editor h4::before { display: none; }
```

Then find `bakeShareHtml`. Replace the signature line:

```ts
export async function bakeShareHtml(tab: Tab, skinId: SkinId = 'default'): Promise<string> {
```

with:

```ts
export async function bakeShareHtml(tab: Tab, themeId: string = 'default'): Promise<string> {
```

Replace inside the function body:

```ts
  const skinCss = SKIN_CSS[skinId] ?? SKIN_CSS.default
```

with:

```ts
  const themeCss = await readThemeCss(themeId)
```

Replace `<style>${skinCss}</style>` with `<style>${themeCss}</style>`.

Replace `<body data-skin="${htmlEscape(skinId)}">` with `<body data-theme="${htmlEscape(themeId)}">`.

Update the leading docstring comment to say `data-theme` instead of `data-skin`.

- [ ] **Step 3: Update share-baker.test.ts**

The tests reference the legacy imports. Open `src/lib/plugins/share-baker.test.ts` and find:

```ts
    expect(html).toContain('data-skin="default"')
    expect(html).toContain('[data-skin="default"] .moraya-editor')
```

Replace with:

```ts
    expect(html).toContain('data-theme="default"')
    expect(html).toContain('[data-theme="default"] .moraya-editor')
```

Find:

```ts
  it('inlines effie skin css and sets data-skin="effie" when requested', async () => {
    ...
    expect(html).toContain('data-skin="effie"')
    expect(html).toContain('[data-skin="effie"] .moraya-editor')
```

Replace with:

```ts
  it('inlines effie theme css and sets data-theme="effie" when requested', async () => {
    ...
    expect(html).toContain('data-theme="effie"')
    expect(html).toContain('[data-theme="effie"] .moraya-editor')
```

And:

```ts
    expect(html).toMatch(/\[data-skin="effie"\][^{]*h1::before[\s\S]*?display: none/)
```

→

```ts
    expect(html).toMatch(/\[data-theme="effie"\][^{]*h1::before[\s\S]*?display: none/)
```

The tests likely set up a mock for the bundled CSS imports. Replace any such fixture with a mock for `findThemeById` + `readTextFile`. At the top of the test file (in `beforeEach`), add:

```ts
vi.mock('../themes.svelte', () => ({
  findThemeById: (id: string) => ({
    id,
    name: id,
    appearance: 'light',
    source: `/themes/${id}.css`,
    compiled: `/themes/.compiled/${id}.css`,
    built_in: true,
  }),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async (p: string) => {
    if (p.includes('default')) return '[data-theme="default"] .moraya-editor { color: black; }'
    if (p.includes('effie')) return '[data-theme="effie"] .moraya-editor { color: teal; } [data-theme="effie"] .moraya-editor h1::before { content: "H1"; display: block; }'
    return ''
  }),
}))
```

- [ ] **Step 4: Run tests, expect green**

Run: `pnpm test src/lib/plugins/share-baker.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plugins/share-baker.ts src/lib/plugins/share-baker.test.ts
git commit -m "$(cat <<'EOF'
refactor(share): use compiled theme CSS from disk + data-theme attr

share-baker no longer bundles per-skin CSS at build time. It reads
the compiled CSS for the requested themeId via tauri-plugin-fs and
embeds it in the shared HTML. The legacy [data-skin] mobile overrides
and body attribute are renamed to [data-theme].

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 29: Update share-baker callers (App.svelte)

**Files:**
- Modify: `src/App.svelte`

`bakeShareHtml` was called with a `SkinId` (typed); now its second arg is the active theme id (string). Callers must be updated.

- [ ] **Step 1: Find the call**

Run: `grep -n "bakeShareHtml" /Users/bruce/git/mdeditor/src/App.svelte`
Expected: at least one call site (in the plugin-host integration for the Share plugin).

- [ ] **Step 2: Replace the argument**

Where the call is `bakeShareHtml(tab, skin.current)` (or similar reference to `skin.current`), replace with `bakeShareHtml(tab, activeTheme.id)`. Ensure `activeTheme` is imported at the top:

```ts
  import { activeTheme } from './lib/active-theme.svelte'
```

If `skin` is still imported in App.svelte, remove that import.

- [ ] **Step 3: Compile check**

Run: `pnpm check 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/App.svelte
git commit -m "$(cat <<'EOF'
refactor(share): pass activeTheme.id (not skin.current) to bakeShareHtml

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 30: Delete legacy skin module + bundled skin CSS

**Files:**
- Delete: `src/lib/skin.svelte.ts`
- Delete: `src/lib/skin.test.ts`
- Delete: `src/styles/skins/default.css`
- Delete: `src/styles/skins/effie.css`
- Delete: `src/styles/skins/` (entire directory)

- [ ] **Step 1: Sweep for remaining references**

Run:

```bash
grep -rn "skin\.svelte\|SkinId\|isValidSkinId\|setSkin\|SKINS" /Users/bruce/git/mdeditor/src 2>/dev/null | grep -v node_modules
```

Expected: no matches. If there are matches, fix them before deleting (likely an import that wasn't cleaned up in earlier tasks).

- [ ] **Step 2: Delete the files**

```bash
rm /Users/bruce/git/mdeditor/src/lib/skin.svelte.ts
rm /Users/bruce/git/mdeditor/src/lib/skin.test.ts
rm /Users/bruce/git/mdeditor/src/styles/skins/default.css
rm /Users/bruce/git/mdeditor/src/styles/skins/effie.css
rmdir /Users/bruce/git/mdeditor/src/styles/skins
```

- [ ] **Step 3: Verify build still passes**

Run: `pnpm check && pnpm test && cd src-tauri && cargo test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A src/lib/skin.svelte.ts src/lib/skin.test.ts src/styles/skins
git commit -m "$(cat <<'EOF'
refactor(theme): drop legacy skin module and bundled skin CSS

The skin system is fully replaced by the theme system. data-skin
no longer exists in the codebase. Built-in default + effie themes
live in src-tauri/resources/themes/ and are written to the user
themes directory on first launch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 31: Final integration check — full app smoke

**Files:** none (verification only)

- [ ] **Step 1: Clean previous user theme state for a clean run**

```bash
mv ~/Library/Application\ Support/com.laobu.mdeditor/themes ~/Library/Application\ Support/com.laobu.mdeditor/themes.bak 2>/dev/null || true
```

(If the dir doesn't exist yet, the command no-ops. We rename rather than delete so a bad run can be recovered.)

- [ ] **Step 2: Run the app**

```bash
pnpm tauri dev
```

- [ ] **Step 3: Verify bootstrap behavior**

In another terminal:

```bash
ls ~/Library/Application\ Support/com.laobu.mdeditor/themes
```

Expected: contains `default.css`, `effie.css`, `.compiled/default.css`, `.compiled/effie.css`. If anything is missing, check the Tauri terminal output for `[themes] bootstrap failed:` errors.

- [ ] **Step 4: Switch theme through the UI**

In the running app: open Preferences (Cmd+,) → Themes. Both dropdowns list Default and Effie. Change "Light theme" to Effie. The editor pane visibly changes to the mint-paper palette without a flash.

- [ ] **Step 5: Run all tests one more time**

Run: `pnpm test && cd src-tauri && cargo test`
Expected: green across the board.

- [ ] **Step 6: Restore your backup or leave the fresh state**

If you want your old state back:

```bash
rm -rf ~/Library/Application\ Support/com.laobu.mdeditor/themes
mv ~/Library/Application\ Support/com.laobu.mdeditor/themes.bak ~/Library/Application\ Support/com.laobu.mdeditor/themes
```

Otherwise leave it.

(No commit for this task — verification only.)

---

## Task 32: Import a real Typora theme (manual smoke)

**Files:** none (verification only)

This task exercises the end-to-end import path on the actual example zip from the spec.

- [ ] **Step 1: Confirm the sample zip exists**

```bash
ls -l ~/Downloads/Typora_Claude-Like_Theme.zip
```

If absent, download a small Typora theme zip from `https://theme.typora.io/` or skip this task and use a synthetic zip instead (the existing Rust import tests cover the semantics).

- [ ] **Step 2: Drag the zip onto the running app window**

The Theme Import dialog should appear inside Preferences and list 3 themes (Claude-Like, Claude-Like Grey, Claude-Like Dark) with their appearances.

- [ ] **Step 3: Confirm import**

Click **Import**. The dialog closes; the Light/Dark dropdowns now include all three themes.

- [ ] **Step 4: Apply Claude-Like to Light theme**

The editor turns into warm-paper mode. Cycle the macOS Appearance to Dark — if Dark theme is set to Claude-Like Dark, the editor switches to its dark palette.

- [ ] **Step 5: Reveal the themes folder**

Click **Reveal themes folder**. Finder opens the directory. Confirm all three new CSS files plus any asset folders are present, plus the corresponding entries in `.compiled/`.

- [ ] **Step 6: Manually delete one file via Finder, click Reload themes**

The dropdown updates to no longer list the deleted theme. If the active theme was the one deleted, M↓ falls back to `default` (the UI dropdown selects whatever is in settings — if the id is gone from `themes.list`, the dropdown shows "blank"; verify the editor still renders without crashing).

(No commit for this task — verification only.)

---

## Task 33: README updates

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Update the Skins → Themes feature bullet (README.md)**

Find the bullet starting with `- **Skins** for rich mode`:

```markdown
- **Skins** for rich mode (Preferences → Core): GitHub-style **default**;
  and **effie**, an Effie-inspired mint-paper aesthetic in
  LXGW WenKai (霞鹜文楷) with paired light + dark palettes — the kai-style
  webfont streams on demand from jsDelivr only when the skin is selected, then
  is cached by the system webview
```

Replace with:

```markdown
- **Themes** for rich mode (Preferences → Core → Themes): drop a Typora
  theme `.zip` onto the window (or import via Preferences) to add any
  theme from the Typora ecosystem. Each `.css` under
  `~/Library/Application Support/com.laobu.mdeditor/themes/` becomes one
  theme. Pair a light and a dark theme; M↓ follows macOS Appearance
  automatically. Built-in **default** (GitHub-style) and **effie**
  (Effie-inspired mint-paper, paired light + dark via
  `prefers-color-scheme`, LXGW WenKai webfont from jsDelivr) ship with
  the app and live in the same folder — delete or edit them like any
  other.
```

- [ ] **Step 2: Replace smoke tests 68–70 with the new theme-system tests**

Find lines 209–222 (the three Skin smoke tests). Replace the entire block with:

```markdown
68. **Theme switch (Light)** — open a markdown file with H1/H2/H3,
    blockquote, bullet list, table, hr → Preferences (Cmd+,) → Themes →
    switch *Light theme* to "Effie". Editor immediately updates to
    Effie's mint-paper palette. Switch back to "Default" → reverts.
69. **Theme persistence** — set Light=Effie, Dark=Default, quit M↓,
    relaunch. Preferences shows Effie/Default in the dropdowns; editor
    is styled by Effie in light mode.
70. **Light/Dark auto-switch** — with Light=Default, Dark=Effie, toggle
    macOS Appearance between Light and Dark; editor flips themes
    instantly with no flash.
71. **Always use light theme** — check the box, toggle macOS Appearance
    → editor stays on the light theme regardless.
72. **Import Typora zip via drag** — drag a Typora theme `.zip` onto
    the window. Confirmation dialog lists detected themes with their
    appearances. Click Import → toast "Imported N themes." → dropdowns
    now include them.
73. **Import via Preferences button** — Preferences → "Import Typora
    theme…" → pick a zip → import works the same. Re-importing the
    same zip prompts for an overwrite confirmation; cancel keeps
    existing themes.
74. **Apply imported theme** — pick a freshly imported theme in the
    Light dropdown; editor turns into that theme's palette.
75. **Reveal themes folder** — click "Reveal themes folder" → Finder
    opens `~/Library/Application Support/com.laobu.mdeditor/themes/`
    with source CSS, asset folders, and a `.compiled/` subfolder.
76. **Manual delete via Finder** — delete a theme's `.css` in Finder,
    click "Reload themes" → dropdown updates, that theme is gone.
77. **Restore built-in themes** — delete `default.css` in Finder, then
    "Restore built-in themes" → file reappears, theme works.
78. **Theme + share plugin** — with Effie active, share via
    `Cmd+Shift+L`. Shared HTML uses Effie's compiled palette.
79. **Malformed zip** — drag a `.zip` containing no CSS → dialog shows
    "No Typora themes found in this zip." Close → no files written.
80. **Zip size cap** — drag a `.zip` with a > 5 MB single CSS entry →
    dialog refuses with "entry too large".
```

(If the existing list has more steps after 70, increment their numbers by +10 or renumber as appropriate — keep all later items present.)

- [ ] **Step 3: Update README.zh-CN.md**

Find the equivalent 皮肤 bullet:

```markdown
- **皮肤系统** —— 富文本模式下两套排版（Preferences → Core 切换）：
  GitHub 风格 **default**；以及 **Effie**（薄荷纸 + 青绿标题 + 紫粗体 + 暖橙斜体，
  正文用 LXGW 霞鹜文楷，浅/深双配色）。霞鹜文楷的 webfont 在切到 effie 时才从
  jsDelivr 按需流式加载（按字符 unicode-range 切片，只取页面用到的子集），
  之后由系统 webview 缓存复用
```

Replace with:

```markdown
- **主题系统** —— 富文本模式（Preferences → Core → Themes）兼容 Typora
  主题：把 `.zip` 拖进窗口或在 Preferences 里选择导入，即可装入 Typora
  生态里的任意主题。每个位于
  `~/Library/Application Support/com.laobu.mdeditor/themes/` 下的 `.css`
  都是一个独立主题；为浅色和深色模式分别选一个主题，M↓ 跟随 macOS Appearance
  自动切换。内置 **default**（GitHub 风格）与 **effie**（Effie 配色：薄荷
  纸 + 青绿标题 + 紫粗体 + 暖橙斜体，浅/深双配色经
  `prefers-color-scheme` 切换，LXGW 霞鹜文楷 webfont 由 jsDelivr 按需流式
  加载）随应用一并写入同一目录，可像其它主题一样删除或编辑。
```

- [ ] **Step 4: Commit**

```bash
git add README.md README.zh-CN.md
git commit -m "$(cat <<'EOF'
docs: update README for theme system

Rewrites the Skins bullet into a Themes section reflecting the
Typora-compatible directory-based mechanism. Replaces smoke tests
68–70 with 68–80 covering theme switching, light/dark auto-switch,
import (drag + Preferences), reveal, manual edit/delete, restore
built-ins, share-plugin integration, malformed zip, size cap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 34: Final cargo + pnpm full-tree verification

**Files:** none (verification + summary commit)

- [ ] **Step 1: Run every test**

```bash
cd /Users/bruce/git/mdeditor
pnpm test
pnpm check
( cd src-tauri && cargo test && cargo check )
```

Expected:
- `pnpm test`: all suites pass (Rust integration tests are not run here).
- `pnpm check` (svelte-check): 0 errors.
- `cargo test`: all themes_*_test suites pass.
- `cargo check`: clean.

- [ ] **Step 2: Run the manual smoke test from Task 31**

If anything fails, fix in place and commit before continuing.

- [ ] **Step 3: Verify there is no stray `data-skin`, `skin.svelte`, `SkinId`, etc. in active code**

```bash
grep -rn "data-skin\|skin\.svelte\|SkinId\|isValidSkinId\|setSkin\|SKINS" \
  /Users/bruce/git/mdeditor/src /Users/bruce/git/mdeditor/src-tauri/src 2>/dev/null | \
  grep -v node_modules | grep -v target
```

Expected: empty output (only `docs/superpowers/specs/...` historical docs may still reference these terms — that's fine).

- [ ] **Step 4: Confirm the bundled CSS-import lines are gone**

```bash
grep -n "skins/" /Users/bruce/git/mdeditor/src/App.svelte
```

Expected: empty.

- [ ] **Step 5: Tag the milestone if green**

(Optional — only if the user explicitly requests a release. Otherwise stop here.)

---

## Self-review (mark complete after the plan is read end-to-end)

**Spec coverage:** Walk each spec section and find its task:

- High-level architecture / Tauri command surface → Tasks 11, 16, 19
- Directory layout (`themes/`, `themes/<id>/`, `themes/.compiled/`) → Tasks 2, 15, 18
- Built-in theme migration → Tasks 12, 13, 14, 15, 16
- CSS metadata convention → Tasks 4, 6
- Selector translation rules → Tasks 8, 10
- Compilation pipeline → Tasks 7, 8, 9, 10
- Frontend integration: theme registry → Task 21
- Frontend integration: theme loader → Tasks 22, 24
- Frontend integration: host attribute (`data-skin` → `data-theme`) → Tasks 23, 24
- Preferences UI → Tasks 25, 26
- Import flow (entry points, confirmation dialog, errors) → Tasks 19, 26, 27
- Settings schema migration → Task 20
- Security and validation (zip caps, traversal, `url()`) → Tasks 9, 17, 18
- Testing strategy → covered throughout (Tasks 3–10, 15, 17, 18, 20, 21, 22, 26, 28)
- Risks → noted inline (Task 10 lightningcss API drift; Task 28 share-baker; Task 24 first-launch latency; manual reload via UI button in Task 25).

**Placeholder scan:** No TBD / TODO / "fill in later" in any step. Every code block is concrete. Tasks where the action is purely procedural (Tasks 14, 31, 32, 34) describe exact commands and expected outputs.

**Type / name consistency:** `ImportReport` / `ImportTheme` / `ImportError` are defined in Task 18 and consumed by Tasks 19, 26, 27. `ThemeMeta` defined in Task 6 (Rust) and Task 21 (TS) matches the serialized field names (`source`, `compiled`, `built_in`, `appearance`). `data-theme` attribute introduced in Task 23 is consistently used in Tasks 24, 25, 28. The settings field `theme.{light,dark,followSystem}` is consistent from Task 20 onward.

**Scope:** This plan is one cohesive feature (theme system replacement). It does not bundle unrelated refactors. The bundle-id rename and shuyuan removal were done as separate commits before this plan started.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-typora-theme-import.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
