use std::path::Path;
use git2::{Repository, build::CheckoutBuilder};

use super::VaultError;
use super::sig::timestamp_compact;

/// Walk conflicted index entries. For each:
///   1. Copy the working-tree file (which holds OUR version after stash-pop) to
///      `<basename>.conflict.<ts><.ext>`
///   2. Check out the THEIRS version into the working tree
///   3. Stage both files (.conflict backup + checked-out theirs)
pub fn handle(repo: &Repository, log: &mut Vec<String>) -> Result<(), VaultError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| VaultError::FsError("no workdir".into()))?
        .to_path_buf();
    let ts = timestamp_compact();

    let mut index = repo.index()?;
    let conflicts: Vec<_> = index.conflicts()?.collect::<Result<Vec<_>, _>>()?;

    for c in &conflicts {
        let our_entry = match c.our.as_ref() {
            Some(e) => e,
            None => continue,
        };
        let path_str = std::str::from_utf8(&our_entry.path)
            .map_err(|e| VaultError::FsError(e.to_string()))?;
        let file_path = workdir.join(path_str);

        if file_path.exists() {
            let conflict_path = make_conflict_path(&file_path, &ts);
            if let Err(e) = std::fs::copy(&file_path, &conflict_path) {
                eprintln!("conflict copy failed for {}: {}", path_str, e);
                continue;
            }
            log.push(conflict_path.display().to_string());
        }
    }

    // Checkout theirs for each conflicted path.
    let mut co = CheckoutBuilder::new();
    co.force().use_theirs(true);
    for c in &conflicts {
        if let Some(e) = c.their.as_ref().or(c.our.as_ref()) {
            if let Ok(p) = std::str::from_utf8(&e.path) {
                co.path(p);
            }
        }
    }
    repo.checkout_index(Some(&mut index), Some(&mut co))?;

    // Re-stage everything (including the .conflict backups).
    let mut index2 = repo.index()?;
    index2.add_all(["."].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index2.write()?;

    Ok(())
}

fn make_conflict_path(file_path: &Path, ts: &str) -> std::path::PathBuf {
    let stem = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = file_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{stem}.conflict.{ts}{ext}"))
}
