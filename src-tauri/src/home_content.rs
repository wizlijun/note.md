//! A bounded-header document catalog for home; independent of full-text filters.

use std::{collections::HashSet, fs, io::Read, path::Path, sync::LazyLock, time::{SystemTime, UNIX_EPOCH}};
use serde::Serialize;
use crate::vault_stats::DocumentRules;

const HEADER_BYTES: u64 = 16 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub path: String,
    pub title: Option<String>,
    pub concept_type: Option<String>,
    pub created_at: Option<u64>,
    pub modified_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub root: String,
    pub items: Vec<CatalogItem>,
    pub skipped: u64,
}

#[tauri::command]
pub async fn home_content_catalog(app: tauri::AppHandle, expected_root: String, rules: DocumentRules) -> Result<Catalog, String> {
    if crate::sotvault::resolve_vault_root(&app).as_deref() != Some(Path::new(&expected_root)) {
        return Err("Vault changed".into());
    }
    crate::sotvault::root_guard::check(Path::new(&expected_root))
        .map_err(|reason| format!("This folder cannot be scanned as a Vault: {reason:?}"))?;
    if rules.extensions.len() > 4096 || rules.names.len() > 4096
        || rules.extensions.iter().chain(&rules.names).any(|s| s.len() > 256) {
        return Err("Invalid catalog request".into());
    }
    let root = expected_root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || scan(Path::new(&root), &rules))
        .await.map_err(|error| error.to_string())?;
    if crate::sotvault::resolve_vault_root(&app).as_deref() != Some(Path::new(&expected_root)) {
        return Err("Vault changed".into());
    }
    result
}

fn milliseconds(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH).ok().map(|duration| duration.as_millis() as u64)
}

fn created_timestamp(value: &str) -> Option<u64> {
    let timestamp = chrono::DateTime::parse_from_rfc3339(value).map(|date| date.timestamp_millis())
        .or_else(|_| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map(|date| date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())).ok()?;
    u64::try_from(timestamp).ok()
}

/// Only complete frontmatter within the prefix is metadata. A heading or a
/// clipped YAML block must not accidentally classify the document.
fn markdown_parts(prefix: &str) -> (Option<serde_yaml::Value>, Option<&str>) {
    let text = prefix.trim_start_matches('\u{feff}');
    let mut lines = text.split_inclusive('\n');
    let Some(first) = lines.next() else { return (None, Some(text)) };
    if first.trim_end() != "---" { return (None, Some(text)); }
    let mut offset = first.len();
    for line in lines {
        if matches!(line.trim_end(), "---" | "...") {
            return (serde_yaml::from_str(&text[first.len()..offset]).ok(), Some(&text[offset + line.len()..]));
        }
        offset += line.len();
    }
    // A clipped frontmatter block has no safe body in this prefix.
    (None, None)
}

fn metadata_field(metadata: &serde_yaml::Value, field: &str) -> Option<String> {
    metadata.get(field)?.as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

/// Text extraction only: no Markdown/HTML rendering or resource loading. These
/// patterns are compiled once and only see the already-bounded file prefix.
fn body_preview(body: &str, title: Option<&str>) -> Option<String> {
    static HIDDEN_HTML: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?is)<!--.*?(?:-->|$)|<(?:script|style|iframe|object|svg)\b[^>]*>.*?(?:</(?:script|style|iframe|object|svg)\s*>|$)").unwrap());
    static HTML_TAGS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<[^>]*>").unwrap());
    static IMAGES: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"!\[[^\]]*\]\([^\n)]*\)").unwrap());
    static LINKS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\[([^\]]+)\]\([^\n)]*\)").unwrap());
    let body = HIDDEN_HTML.replace_all(body, "");
    let mut text = String::new();
    let mut fence: Option<(char, usize)> = None;
    for line in body.lines() {
        let trimmed = line.trim();
        let marker = trimmed.chars().next().filter(|c| matches!(c, '`' | '~'));
        let count = marker.map(|marker| trimmed.chars().take_while(|c| *c == marker).count()).unwrap_or(0);
        if count >= 3 {
            match fence {
                Some((open, length)) if marker == Some(open) && count >= length && trimmed[count..].trim().is_empty() => fence = None,
                None => fence = marker.map(|marker| (marker, count)),
                _ => {},
            }
            continue;
        }
        if fence.is_some() || line.starts_with("    ") || line.starts_with('\t') || trimmed.starts_with("[^") { continue; }
        let without_images = IMAGES.replace_all(trimmed, "");
        let without_links = LINKS.replace_all(&without_images, "$1");
        let without_tags = HTML_TAGS.replace_all(&without_links, "");
        let mut plain = without_tags.trim_start_matches(['#', '>']).trim();
        if ["- ", "* ", "+ "].iter().any(|prefix| plain.starts_with(*prefix)) { plain = plain[2..].trim(); }
        if let Some((number, rest)) = plain.split_once(['.', ')']) {
            if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) && rest.starts_with(char::is_whitespace) { plain = rest.trim(); }
        }
        if ["[ ] ", "[x] ", "[X] "].iter().any(|prefix| plain.starts_with(*prefix)) { plain = plain[4..].trim(); }
        let plain = plain.replace(['*', '`', '~'], "").replace("__", "").replace('|', " ");
        let plain = plain.split_whitespace().collect::<Vec<_>>().join(" ");
        if plain.is_empty() || plain.chars().all(|c| matches!(c, '-' | '_' | '=' | ':' | ' '))
            || title.is_some_and(|title| plain.eq_ignore_ascii_case(title.trim())) { continue; }
        if !text.is_empty() { text.push(' '); }
        text.extend(plain.chars().filter(|c| !c.is_control()));
        if text.chars().count() > 180 { break; }
    }
    if text.is_empty() { return None; }
    if text.chars().count() > 180 { text = text.chars().take(179).chain(std::iter::once('…')).collect(); }
    Some(text)
}

fn scan(root: &Path, rules: &DocumentRules) -> Result<Catalog, String> {
    if !fs::metadata(root).map_err(|error| error.to_string())?.is_dir() {
        return Err("Vault is not a directory".into());
    }
    let extensions: HashSet<_> = rules.extensions.iter().map(|value| value.to_lowercase()).collect();
    let names: HashSet<_> = rules.names.iter().map(|value| value.to_lowercase()).collect();
    let mut catalog = Catalog { root: root.to_string_lossy().into_owned(), items: vec![], skipped: 0 };
    let mut stack = vec![fs::read_dir(root).map_err(|error| error.to_string())?];
    while let Some(entries) = stack.last_mut() {
        let Some(entry) = entries.next() else { stack.pop(); continue };
        let entry = match entry { Ok(entry) => entry, Err(_) => { catalog.skipped += 1; continue } };
        let name = entry.file_name();
        if matches!(name.to_str(), Some(".git" | ".notemd" | ".trash" | "node_modules")) { continue; }
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => { catalog.skipped += 1; continue },
        };
        if metadata.file_type().is_symlink() { continue; }
        if metadata.is_dir() {
            match fs::read_dir(&path) { Ok(entries) => stack.push(entries), Err(_) => catalog.skipped += 1 }
            continue;
        }
        if !metadata.is_file() { continue; }
        let lower = name.to_string_lossy().to_lowercase();
        let extension = Path::new(&lower).extension().and_then(|value| value.to_str()).unwrap_or("");
        if !extensions.contains(extension) && !names.contains(&lower) { continue; }
        let mut item = CatalogItem {
            path: path.to_string_lossy().into_owned(),
            title: path.file_stem().map(|stem| stem.to_string_lossy().into_owned()),
            concept_type: None,
            created_at: metadata.created().ok().and_then(milliseconds),
            modified_at: metadata.modified().ok().and_then(milliseconds).unwrap_or(0),
            preview: None,
        };
        if matches!(extension, "md" | "markdown" | "mdown" | "mkd" | "mdx") {
            let mut prefix = Vec::new();
            match fs::File::open(&path).and_then(|file| file.take(HEADER_BYTES).read_to_end(&mut prefix)) {
                Ok(_) => {
                    let prefix = String::from_utf8_lossy(&prefix);
                    let (frontmatter, body) = markdown_parts(&prefix);
                    if let Some(frontmatter) = frontmatter {
                        if let Some(title) = metadata_field(&frontmatter, "title") { item.title = Some(title); }
                        item.concept_type = metadata_field(&frontmatter, "type");
                        item.created_at = metadata_field(&frontmatter, "created").as_deref().and_then(created_timestamp).or(item.created_at);
                    }
                    if extension != "mdx" { item.preview = body.and_then(|body| body_preview(body, item.title.as_deref())); }
                },
                Err(_) => { catalog.skipped += 1; continue },
            }
        }
        catalog.items.push(item);
    }
    catalog.items.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn rules() -> DocumentRules {
        DocumentRules { extensions: vec!["MD".into(), "canvas".into(), "custom".into()], names: vec!["makefile".into()] }
    }
    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fn relative(catalog: &Catalog) -> Vec<String> {
        catalog.items.iter().map(|item| Path::new(&item.path).strip_prefix(&catalog.root).unwrap().to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn creation_is_not_modification_and_frontmatter_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "answer.md", "\u{feff}---\r\ntitle: 新报告\r\ntype: Answer\r\ncreated: 2026-10-01T08:30:00Z\r\n---\r\n正文");
        let path = root.path().join("answer.md");
        let birth = fs::metadata(&path).unwrap().created().ok().and_then(milliseconds);
        let future = UNIX_EPOCH + Duration::from_secs(4_000_000_000);
        fs::File::options().write(true).open(&path).unwrap().set_modified(future).unwrap();
        let catalog = scan(root.path(), &rules()).unwrap();
        let item = &catalog.items[0];
        assert_eq!(item.title.as_deref(), Some("新报告"));
        assert_eq!(item.concept_type.as_deref(), Some("Answer"));
        assert_eq!(item.created_at, created_timestamp("2026-10-01T08:30:00Z"));
        assert_eq!(item.modified_at, 4_000_000_000_000);
        write(root.path(), "plain.md", "---\ncreated: invalid\n---\n");
        let plain = root.path().join("plain.md");
        let expected = fs::metadata(&plain).unwrap().created().ok().and_then(milliseconds);
        fs::File::options().write(true).open(&plain).unwrap().set_modified(future).unwrap();
        assert_eq!(scan(root.path(), &rules()).unwrap().items[1].created_at, expected);
        assert!(birth.is_none_or(|timestamp| timestamp != 4_000_000_000_000));
    }

    #[test]
    fn returns_all_candidates_and_supported_formats_with_stable_paths() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..32 { write(root.path(), &format!("nested/{index:02}.md"), "note"); }
        for name in [".private/a.MD", ".hidden.md", "a.canvas", "b.custom", "Makefile"] { write(root.path(), name, "x"); }
        for name in ["image.png", "nested/.git/a.md", ".notemd/b.md", ".trash/c.md", "node_modules/d.md"] { write(root.path(), name, "ignore"); }
        let catalog = scan(root.path(), &rules()).unwrap();
        assert_eq!(catalog.items.len(), 37);
        assert_eq!(catalog.skipped, 0);
        let paths = relative(&catalog);
        assert_eq!(&paths[..5], [".hidden.md", ".private/a.MD", "Makefile", "a.canvas", "b.custom"]);
        assert_eq!(paths.last().unwrap(), "nested/31.md");
        assert_eq!(catalog.items[3].title.as_deref(), Some("a"));
    }

    #[test]
    fn only_complete_bounded_frontmatter_is_used() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "large.md", &format!("---\ntitle: outside\n{}\n---\n", "#".repeat(HEADER_BYTES as usize)));
        write(root.path(), "body.md", "# Heading\ntitle: body\n---\n");
        write(root.path(), "date.md", "---\ncreated: 2026-10-01\n---\n");
        let catalog = scan(root.path(), &rules()).unwrap();
        assert_eq!(catalog.items[0].title.as_deref(), Some("body"));
        assert_eq!(catalog.items[1].created_at, created_timestamp("2026-10-01"));
        assert_eq!(catalog.items[2].title.as_deref(), Some("large"));
        assert!(created_timestamp("not a date").is_none());
        assert!(created_timestamp("1960-01-01").is_none());
    }

    #[test]
    fn empty_missing_and_file_roots_are_distinct() {
        let root = tempfile::tempdir().unwrap();
        assert!(scan(root.path(), &rules()).unwrap().items.is_empty());
        assert!(scan(&root.path().join("missing"), &rules()).is_err());
        write(root.path(), "file.md", "x");
        assert_eq!(scan(&root.path().join("file.md"), &rules()).unwrap_err(), "Vault is not a directory");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_file_or_directory_links() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(root.path(), "local.md", "local");
        write(outside.path(), "outside.md", "external");
        std::os::unix::fs::symlink(root.path(), root.path().join("loop")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("outside")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("outside.md"), root.path().join("link.md")).unwrap();
        assert_eq!(relative(&scan(root.path(), &rules()).unwrap()), ["local.md"]);
    }

    #[test]
    fn ten_thousand_files_do_not_drop_older_candidates() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..10_000 { write(root.path(), &format!("dir-{}/note-{index:05}.md", index % 100), "note"); }
        let start = Instant::now();
        let catalog = scan(root.path(), &rules()).unwrap();
        eprintln!("10,000-file home catalog: {:?}", start.elapsed());
        assert_eq!(catalog.items.len(), 10_000);
        assert_eq!(catalog.skipped, 0);
    }

    #[test]
    fn wire_shape_uses_the_frontend_contract() {
        let item = CatalogItem { path: "a.md".into(), title: None, concept_type: Some("Answer".into()), created_at: None, modified_at: 123, preview: None };
        let wire = serde_json::to_value(item).unwrap();
        assert_eq!(wire, serde_json::json!({"path":"a.md","title":null,"conceptType":"Answer","createdAt":null,"modifiedAt":123}));
    }

    #[test]
    fn previews_real_body_without_metadata_repeated_title_or_resources() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "report.md", "\u{feff}---\r\ntitle: New report\r\ntype: Answer\r\ngenerated:\r\n  by: private-agent\r\n---\r\n# New report\r\n\r\n**Real** [evidence](https://remote.invalid/evidence).\r\n![secret image](https://remote.invalid/image.png)\r\n```sh\r\nprivate-command\r\n```\r\n<script>alert('private')</script>\r\n<p>Last line.</p>");
        let catalog = scan(root.path(), &rules()).unwrap();
        assert_eq!(catalog.items[0].preview.as_deref(), Some("Real evidence. Last line."));
        let wire = serde_json::to_value(&catalog.items[0]).unwrap();
        assert_eq!(wire["preview"], "Real evidence. Last line.");
    }

    #[test]
    fn never_uses_clipped_or_invalid_frontmatter_as_a_preview() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "clipped.md", &format!("---\nprivate: {}\n---\nUnseen body", "x".repeat(HEADER_BYTES as usize)));
        write(root.path(), "invalid.md", "---\nprivate: [invalid\n---\nSafe body");
        let catalog = scan(root.path(), &rules()).unwrap();
        assert!(catalog.items[0].preview.is_none());
        assert_eq!(catalog.items[1].preview.as_deref(), Some("Safe body"));
    }

    #[test]
    fn unicode_preview_is_short_and_removes_list_markers_without_inventing_body() {
        assert_eq!(body_preview("# Report\n---\n1. [x] **First** item\n> Next `word`", Some("Report")).as_deref(), Some("First item Next word"));
        assert_eq!(body_preview("# Report\n===\n```js\nsecret()\n```\n![only image](https://remote.invalid)", Some("Report")), None);
        let long = body_preview(&"深入阅读🚀".repeat(100), None).unwrap();
        assert_eq!(long.chars().count(), 180);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn does_not_make_previews_for_binary_or_mixed_code_formats() {
        let root = tempfile::tempdir().unwrap();
        for name in ["canvas.canvas", "plugin.custom", "Makefile"] { write(root.path(), name, "this must not be a pretend document excerpt"); }
        write(root.path(), "code.mdx", "---\ntitle: Code\n---\nimport secret from 'remote';\n<Component />");
        let mut formats = rules(); formats.extensions.push("mdx".into());
        let catalog = scan(root.path(), &formats).unwrap();
        assert_eq!(catalog.items.len(), 4);
        assert!(catalog.items.iter().all(|item| item.preview.is_none()));
    }
}
