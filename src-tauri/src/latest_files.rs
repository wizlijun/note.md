//! Metadata-only lookup for the File menu, independent of full-text exclusions.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const LIMIT: usize = 7;

fn latest_time(created: Option<SystemTime>, modified: Option<SystemTime>) -> SystemTime {
    created.into_iter().chain(modified).max().unwrap_or(UNIX_EPOCH)
}

/// Scan all user directories without reading file contents or following links.
/// Keep only seven candidates so memory does not grow with the vault's file count.
pub fn scan_latest_files(root: &Path) -> Result<Vec<String>, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut directories = vec![root.clone()];
    let mut latest: Vec<(SystemTime, PathBuf)> = Vec::with_capacity(LIMIT + 1);
    while let Some(directory) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if directory == root => return Err(error.to_string()),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                if matches!(entry.file_name().to_str(), Some(".git" | ".notemd" | ".trash")) {
                    continue;
                }
                directories.push(path);
                continue;
            }
            if !kind.is_file()
                || !path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            let Ok(metadata) = entry.metadata() else { continue };
            let candidate = (latest_time(metadata.created().ok(), metadata.modified().ok()), path);
            let position = latest.binary_search_by(|existing| {
                candidate.0.cmp(&existing.0).then_with(|| existing.1.cmp(&candidate.1))
            }).unwrap_or_else(|position| position);
            if position < LIMIT {
                latest.insert(position, candidate);
                latest.truncate(LIMIT);
            }
        }
    }
    Ok(latest.into_iter().map(|(_, path)| path.to_string_lossy().into_owned()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn note(root: &Path, relative: &str, seconds: u64) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = fs::File::create(path).unwrap();
        // Future timestamps keep birthtime from overriding fixture ordering.
        file.set_modified(UNIX_EPOCH + Duration::from_secs(4_000_000_000 + seconds)).unwrap();
    }

    fn relative(root: &Path) -> Vec<String> {
        let root = root.canonicalize().unwrap();
        scan_latest_files(&root).unwrap().into_iter().map(|path| {
            Path::new(&path).strip_prefix(&root).unwrap().to_string_lossy().into_owned()
        }).collect()
    }

    #[test]
    fn newest_seven_across_subdirectories_with_stable_ties() {
        let vault = tempfile::tempdir().unwrap();
        for i in 0..10 {
            note(vault.path(), &format!("nested/deep/{i}.md"), i);
        }
        note(vault.path(), "a.md", 9);
        assert_eq!(relative(vault.path()), [
            "a.md", "nested/deep/9.md", "nested/deep/8.md", "nested/deep/7.md",
            "nested/deep/6.md", "nested/deep/5.md", "nested/deep/4.md",
        ]);
    }

    #[test]
    fn creation_and_modification_each_count_and_missing_dates_fall_back() {
        let older = UNIX_EPOCH + Duration::from_secs(10);
        let newer = UNIX_EPOCH + Duration::from_secs(20);
        assert_eq!(latest_time(Some(newer), Some(older)), newer);
        assert_eq!(latest_time(Some(older), Some(newer)), newer);
        assert_eq!(latest_time(None, Some(newer)), newer);
        assert_eq!(latest_time(Some(newer), None), newer);
        assert_eq!(latest_time(None, None), UNIX_EPOCH);
    }

    #[test]
    fn includes_hidden_user_notes_large_files_and_uppercase_md_but_not_internal_data() {
        let vault = tempfile::tempdir().unwrap();
        for path in [".private/a.MD", ".hidden.md", "notes/a.note.md", "large.md"] {
            note(vault.path(), path, 1);
        }
        let large = fs::OpenOptions::new().write(true).open(vault.path().join("large.md")).unwrap();
        large.set_len(11 * 1024 * 1024).unwrap();
        large.set_modified(UNIX_EPOCH + Duration::from_secs(4_000_000_001)).unwrap();
        for path in [".git/a.md", "nested/.notemd/a.md", ".trash/a.md", "readme.txt"] {
            note(vault.path(), path, 9);
        }
        assert_eq!(relative(vault.path()), [".hidden.md", ".private/a.MD", "large.md", "notes/a.note.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlink_files_and_directories() {
        use std::os::unix::fs::symlink;
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        note(vault.path(), "actual.md", 1);
        note(outside.path(), "outside.md", 9);
        symlink(outside.path(), vault.path().join("linked-dir")).unwrap();
        symlink(outside.path().join("outside.md"), vault.path().join("linked.md")).unwrap();
        assert_eq!(relative(vault.path()), ["actual.md"]);
    }

    #[test]
    fn deletion_is_reflected_and_empty_vault_is_supported() {
        let vault = tempfile::tempdir().unwrap();
        assert!(relative(vault.path()).is_empty());
        note(vault.path(), "a.md", 1);
        assert_eq!(relative(vault.path()), ["a.md"]);
        fs::remove_file(vault.path().join("a.md")).unwrap();
        assert!(relative(vault.path()).is_empty());
        assert!(scan_latest_files(&vault.path().join("missing")).is_err());
    }

    #[test]
    fn large_vault_metadata_scan() {
        let vault = tempfile::tempdir().unwrap();
        for i in 0..10_000 {
            note(vault.path(), &format!("dir-{}/note-{i}.md", i % 100), i);
        }
        let started = Instant::now();
        let result = relative(vault.path());
        eprintln!("10,000-file metadata scan: {:?}", started.elapsed());
        assert_eq!(result.len(), LIMIT);
        assert_eq!(result.first().unwrap(), "dir-99/note-9999.md");
        assert_eq!(result.last().unwrap(), "dir-93/note-9993.md");
    }
}
