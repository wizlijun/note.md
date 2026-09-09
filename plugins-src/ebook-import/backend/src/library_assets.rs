//! Resumable, sequential enrichment of an existing ebook library. Network calls
//! happen outside the topic lock; each completed book is committed independently.
use crate::{book_assets, library, pipeline, topics};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

pub fn run(root: &Path) -> Result<(), String> {
    run_with_report(root, None)
}

pub fn rebuild(root: &Path) -> Result<topics::RebuildResult, String> {
    validate_root(root)?;
    topics::with_topic_lock(root, || {
        validate_root(root)?;
        let catalog = topics::read_catalog(root)?;
        topics::rebuild_indexes(root, &catalog)
    })
}

pub fn run_with_report(root: &Path, report: Option<&Path>) -> Result<(), String> {
    validate_root(root)?;
    let mut report = report.map(|path| open_report(root, path)).transpose()?;
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let mut emit = |event: Value| -> Result<(), String> {
        let mut line = serde_json::to_vec(&event).map_err(|error| error.to_string())?;
        line.push(b'\n');
        // Persist first, so a disconnected observer does not lose the result.
        if let Some(file) = &mut report {
            file.write_all(&line)
                .and_then(|_| file.flush())
                .and_then(|_| file.sync_data())
                .map_err(|error| format!("write asset report: {error}"))?;
        }
        stdout
            .write_all(&line)
            .and_then(|_| stdout.flush())
            .map_err(|error| format!("write progress: {error}"))
    };
    let result = run_batch(root, &mut book_assets::fetch_assets, &mut emit);
    if let Err(error) = &result {
        let _ = emit(json!({"type":"fatal", "warning":error}));
    }
    result
}

fn validate_root(root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("Library root must be an absolute path".into());
    }
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("inspect library root: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Library root must be a regular directory, not a symlink".into());
    }
    Ok(())
}

fn open_report(root: &Path, path: &Path) -> Result<File, String> {
    if !path.is_absolute() {
        return Err("Report path must be absolute".into());
    }
    let parent = path.parent().ok_or("Report path must name a file")?;
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("inspect report directory: {error}"))?;
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    if parent.starts_with(&canonical_root) {
        return Err("Use a temporary report path outside the book library".into());
    }
    let mut options = OpenOptions::new();
    options.write(true).append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("open asset report: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Report must be a regular file".into());
    }
    Ok(file)
}

fn cover_present(dir: &Path) -> bool {
    ["cover.jpg", "cover.png", "cover.jpeg"]
        .iter()
        .any(|name| library::is_regular_file(&dir.join(name)))
}

fn read_metadata(path: &Path) -> Result<serde_yaml::Value, String> {
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: serde_yaml::Value =
        serde_yaml::from_str(&text).map_err(|error| format!("invalid book metadata: {error}"))?;
    if !value.is_mapping() {
        return Err("Book metadata must be a YAML mapping".into());
    }
    Ok(value)
}

fn cached_metadata(value: &serde_yaml::Value) -> bool {
    value
        .get("book_metadata")
        .and_then(serde_yaml::Value::as_mapping)
        .is_some_and(|mapping| {
            mapping
                .get("provider")
                .and_then(serde_yaml::Value::as_str)
                .is_some()
                && mapping
                    .get("title")
                    .and_then(serde_yaml::Value::as_str)
                    .is_some()
        })
}

fn retryable(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    if let Some(status) = lower.split("http ").nth(1) {
        if let Some(code) = status.get(..3).and_then(|code| code.parse::<u16>().ok()) {
            return code == 429 || (500..600).contains(&code);
        }
    }
    lower.contains("connection")
        || lower.contains("connect error")
        || lower.contains("dns error")
        || lower.contains("timeout")
        || lower.contains("timed out")
}

type FetchResult = Result<Option<book_assets::BookAssets>, String>;

fn fetch_with_retry<F>(mut fetch: F, mut pause: impl FnMut()) -> FetchResult
where
    F: FnMut() -> FetchResult,
{
    let first = fetch();
    let retry = match &first {
        Err(error) => retryable(error),
        Ok(Some(assets)) if assets.cover.is_none() => assets.warnings.iter().any(|w| retryable(w)),
        _ => false,
    };
    if !retry {
        return first;
    }
    pause();
    match (first, fetch()) {
        (Ok(Some(mut first)), Err(error)) => {
            first.warnings.push(format!("Retry failed: {error}"));
            Ok(Some(first))
        }
        (Ok(Some(first)), Ok(None)) => Ok(Some(first)),
        (_, second) => second,
    }
}

struct Outcome {
    status: &'static str,
    cover_present: bool,
    warning: Option<String>,
}

fn complete_book<F>(
    root: &Path,
    book: &topics::ScannedBook,
    fetch: &mut F,
) -> Result<Outcome, String>
where
    F: FnMut(&str, Option<&str>, &str, &AtomicBool) -> FetchResult,
{
    validate_root(root)?;
    let meta_path = topics::existing_book_meta(root, &book.rel)?;
    let dir = meta_path.parent().ok_or("Book metadata has no parent")?;
    let metadata = read_metadata(&meta_path)?;
    if cached_metadata(&metadata) && cover_present(dir) {
        return Ok(Outcome {
            status: "cached",
            cover_present: true,
            warning: None,
        });
    }
    // Only ISBNs extracted by fetch_assets, title and author leave the machine.
    // Cached ISBNs precede the bounded book prefix so they remain available when
    // the original book lacks structured frontmatter.
    let mut evidence = String::new();
    if let Some(isbn) = metadata.get("isbn") {
        if let Some(value) = isbn.as_str() {
            evidence.push_str(&format!("ISBN: {value}\n"));
        }
        if let Some(values) = isbn.as_sequence() {
            for value in values.iter().filter_map(serde_yaml::Value::as_str) {
                evidence.push_str(&format!("ISBN: {value}\n"));
            }
        }
    }

    if let Some(isbns) = metadata.get("book_metadata").and_then(|m| m.get("isbn")) {
        if let Some(values) = isbns.as_sequence() {
            for value in values.iter().filter_map(serde_yaml::Value::as_str).take(12) {
                evidence.push_str(&format!("ISBN: {value}\n"));
            }
        }
    }
    evidence.push_str(&pipeline::read_asset_evidence(&dir.join("book.md"))?);
    let cancelled = AtomicBool::new(false);
    let assets = fetch_with_retry(
        || fetch(&book.title, book.creator.as_deref(), &evidence, &cancelled),
        || std::thread::sleep(Duration::from_secs(1)),
    )?;
    let Some(assets) = assets else {
        return Ok(Outcome {
            status: "unmatched",
            cover_present: cover_present(dir),
            warning: Some("No uniquely matching metadata found; original files preserved".into()),
        });
    };
    topics::with_topic_lock(root, || {
        validate_root(root)?;
        let current_meta = topics::existing_book_meta(root, &book.rel)?;
        let dir = current_meta.parent().ok_or("Book metadata has no parent")?;
        if cached_metadata(&read_metadata(&current_meta)?) && cover_present(dir) {
            return Ok(Outcome {
                status: "cached",
                cover_present: true,
                warning: None,
            });
        }
        pipeline::store_book_assets(dir, &assets)?;
        let cover_present = cover_present(dir);
        let mut warnings = assets.warnings.clone();
        if !cover_present && warnings.is_empty() {
            warnings.push("Metadata saved; no supported cover was available".into());
        }
        Ok(Outcome {
            status: if cover_present { "updated" } else { "partial" },
            cover_present,
            warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
        })
    })
}

fn run_batch<F>(
    root: &Path,
    fetch: &mut F,
    emit: &mut impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String>
where
    F: FnMut(&str, Option<&str>, &str, &AtomicBool) -> FetchResult,
{
    validate_root(root)?;
    let books = topics::with_topic_lock(root, || {
        let catalog = topics::read_catalog(root)?;
        topics::preflight_indexes(root, &catalog)?;
        topics::scan_books(root)
    })?;
    let mut counts: BTreeMap<&str, usize> = ["updated", "partial", "unmatched", "failed", "cached"]
        .into_iter()
        .map(|key| (key, 0))
        .collect();
    let mut failures = Vec::new();
    let mut missing_covers = Vec::new();
    emit(json!({"type":"start", "total":books.len()}))?;
    for (index, book) in books.iter().enumerate() {
        let outcome = complete_book(root, book, fetch).unwrap_or_else(|warning| Outcome {
            status: "failed",
            cover_present: topics::existing_book_meta(root, &book.rel)
                .ok()
                .and_then(|meta| meta.parent().map(PathBuf::from))
                .is_some_and(|dir| cover_present(&dir)),
            warning: Some(warning),
        });
        *counts.entry(outcome.status).or_default() += 1;
        if outcome.status == "failed" {
            failures.push(json!({"book":book.rel, "warning":outcome.warning}));
        }
        if !outcome.cover_present {
            missing_covers.push(book.rel.clone());
        }
        emit(json!({
            "type":"progress", "current":index + 1, "total":books.len(),
            "book":book.rel, "status":outcome.status,
            "coverPresent":outcome.cover_present, "warning":outcome.warning,
        }))?;
    }
    let rebuild = rebuild(root);
    emit(json!({
        "type":"summary", "total":books.len(), "counts":counts,
        "failures":failures, "missingCovers":missing_covers,
        "indexesRebuilt":rebuild.is_ok(), "warning":rebuild.as_ref().err(),
    }))?;
    rebuild.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(root: &Path, title: &str, extra: &str) -> PathBuf {
        let dir = root.join("2026-09").join(title);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("book.md"),
            format!(
                "---\ntype: Book\ntitle: {title}\n---\nISBN: 9780735214491\n{}\n",
                "x".repeat(70_000)
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("meta.yml"),
            format!("topic_id: reading\nadded_at: 2026-09-01T00:00:00Z\nuser_key: keep\n{extra}"),
        )
        .unwrap();
        dir
    }

    fn catalog(root: &Path) {
        std::fs::write(root.join("topics.yml"), "schema_version: 1\ntopics:\n  - id: reading\n    label: Reading\n    description: Books\n    index_file: reading.index.md\n    vocabulary:\n      - term: One\n        description: One\n      - term: Two\n        description: Two\n").unwrap();
    }

    fn assets(title: &str, cover: bool) -> book_assets::BookAssets {
        book_assets::BookAssets {
            metadata: book_assets::BookMetadata {
                provider: "Open Library".into(),
                source_url: "https://openlibrary.org/books/OL1M".into(),
                fetched_at: "2026-09-10T00:00:00Z".into(),
                matched_by: "isbn".into(),
                isbn: vec!["9780735214491".into()],
                title: title.into(),
                authors: vec!["Author".into()],
                publisher: None,
                published_date: None,
                cover_source_url: None,
            },
            cover: cover.then(|| ("jpg".into(), vec![1, 2, 3])),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn batch_resumes_cached_books_preserves_inputs_and_continues_failures() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        catalog(root);
        let cached = seed(
            root,
            "Cached",
            "book_metadata:\n  provider: openlibrary\n  title: Cached\n  authors: [Cached Author]\n",
        );
        std::fs::write(cached.join("cover.png"), b"user cover").unwrap();
        let updated = seed(root, "Updated", "");
        std::fs::write(updated.join("cover.jpeg"), b"existing cover").unwrap();
        let partial = seed(root, "Partial", "book_metadata:\n  authors: [Cached Author]\n  isbn: ['080442957X']\n  user_note: preserve\n");
        seed(root, "Unmatched", "");
        seed(root, "Failed", "");
        let original_book = std::fs::read(partial.join("book.md")).unwrap();
        let mut requested = Vec::new();
        let mut fetch = |title: &str, author: Option<&str>, evidence: &str, _: &AtomicBool| {
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .open(root.join(topics::LOCK_FILE))
                .unwrap();
            fs2::FileExt::try_lock_exclusive(&lock).expect("network call must not hold topic lock");
            fs2::FileExt::unlock(&lock).unwrap();
            requested.push(title.to_string());
            assert!(evidence.len() < 66_000);
            match title {
                "Updated" => Ok(Some(assets(title, true))),
                "Partial" => {
                    assert_eq!(author, Some("Cached Author"));
                    assert!(evidence.starts_with("ISBN: 080442957X\n"));
                    Ok(Some(assets(title, false)))
                }
                "Unmatched" => Ok(None),
                "Failed" => Err("invalid Open Library metadata".into()),
                _ => panic!("Cached books must not fetch"),
            }
        };
        let mut events = Vec::new();
        run_batch(root, &mut fetch, &mut |event| {
            events.push(event);
            Ok(())
        })
        .unwrap();
        assert_eq!(requested.len(), 4);
        let summary = events.last().unwrap();
        for status in ["cached", "updated", "partial", "unmatched", "failed"] {
            assert_eq!(summary["counts"][status], 1, "{status}");
        }
        assert_eq!(summary["indexesRebuilt"], true);
        assert_eq!(summary["missingCovers"].as_array().unwrap().len(), 3);
        assert_eq!(
            std::fs::read(cached.join("cover.png")).unwrap(),
            b"user cover"
        );
        assert_eq!(
            std::fs::read(updated.join("cover.jpeg")).unwrap(),
            b"existing cover"
        );
        assert!(!updated.join("cover.jpg").exists());
        assert_eq!(
            std::fs::read(partial.join("book.md")).unwrap(),
            original_book
        );
        let metadata = read_metadata(&partial.join("meta.yml")).unwrap();
        assert_eq!(metadata["user_key"].as_str(), Some("keep"));
        assert_eq!(
            metadata["book_metadata"]["user_note"].as_str(),
            Some("preserve")
        );
        assert_eq!(
            metadata["book_metadata"]["authors"][0].as_str(),
            Some("Cached Author")
        );
        assert!(root.join("reading.index.md").is_file());
    }

    #[test]
    fn retries_only_transient_errors_once_and_keeps_partial_metadata() {
        for error in [
            "Open Library returned HTTP 429 Too Many Requests",
            "Open Library returned HTTP 503 Service Unavailable",
            "connection reset",
            "book enrichment timed out",
        ] {
            let mut calls = 0;
            let mut pauses = 0;
            let result = fetch_with_retry(
                || {
                    calls += 1;
                    Err(error.into())
                },
                || pauses += 1,
            );
            assert!(result.is_err());
            assert_eq!(calls, 2);
            assert_eq!(pauses, 1);
        }
        for error in [
            "Open Library returned HTTP 400 Bad Request",
            "invalid JSON",
            "untrusted book asset URL",
        ] {
            let mut calls = 0;
            let _ = fetch_with_retry(
                || {
                    calls += 1;
                    Err(error.into())
                },
                || panic!("must not retry"),
            );
            assert_eq!(calls, 1);
        }
        let mut calls = 0;
        let result = fetch_with_retry(
            || {
                calls += 1;
                if calls == 1 {
                    let mut partial = assets("Partial", false);
                    partial
                        .warnings
                        .push("Open Library returned HTTP 503 Service Unavailable".into());
                    Ok(Some(partial))
                } else {
                    Err("connection reset".into())
                }
            },
            || {},
        )
        .unwrap()
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(result.metadata.title, "Partial");
        assert!(result.warnings.last().unwrap().contains("Retry failed"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_root_and_report_symlinks_and_report_inside_library() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("books");
        std::fs::create_dir(&root).unwrap();
        assert!(validate_root(Path::new("books")).is_err());
        symlink(&root, temp.path().join("alias")).unwrap();
        assert!(validate_root(&temp.path().join("alias")).is_err());
        assert!(open_report(&root, &root.join("meta.yml")).is_err());
        let target = temp.path().join("report.jsonl");
        std::fs::write(&target, b"prior\n").unwrap();
        let alias = temp.path().join("report-link");
        symlink(&target, &alias).unwrap();
        assert!(open_report(&root, &alias).is_err());
        let mut report = open_report(&root, &target).unwrap();
        report.write_all(b"next\n").unwrap();
        assert_eq!(std::fs::read_to_string(target).unwrap(), "prior\nnext\n");
    }

    #[cfg(unix)]
    #[test]
    fn revalidates_book_after_network_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let dir = seed(root, "Changed", "");
        let book = topics::scan_books(root).unwrap().remove(0);
        let original_meta = std::fs::read(dir.join("meta.yml")).unwrap();
        let target = root.join("outside.yml");
        std::fs::write(&target, &original_meta).unwrap();
        let result = complete_book(root, &book, &mut |_, _, _, _| {
            std::fs::remove_file(dir.join("meta.yml")).unwrap();
            std::os::unix::fs::symlink(&target, dir.join("meta.yml")).unwrap();
            Ok(Some(assets("Changed", true)))
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(target).unwrap(), original_meta);
        assert!(!dir.join("cover.jpg").exists());
    }
}
