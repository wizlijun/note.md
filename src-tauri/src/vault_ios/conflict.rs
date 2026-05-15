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

/// Fallback path: libgit2's `git_stash_apply` (and rebase apply) under the
/// default GIT_CHECKOUT_SAFE strategy can produce textual conflict markers in
/// the working tree without recording stage>0 entries in the index. Walk the
/// working tree for files containing the standard `<<<<<<<` / `=======` /
/// `>>>>>>>` markers, split them into ours/theirs, write our side to a
/// `.conflict.<ts>` sibling, replace the file with the theirs side, and stage
/// the result.
pub fn handle_marker_files(repo: &Repository, log: &mut Vec<String>) -> Result<(), VaultError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| VaultError::FsError("no workdir".into()))?
        .to_path_buf();
    let ts = crate::vault_ios::sig::timestamp_compact();
    let head_tree = repo.head()?.peel_to_tree()?;

    // Use git status to find candidate files (modified/added in workdir) — cheaper
    // than recursing the entire tree. Skip .git internals automatically.
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(false);
    let statuses = repo.statuses(Some(&mut opts))?;

    // Collect rel paths first so we can mutate workdir without holding the borrow.
    let mut candidates: Vec<String> = Vec::new();
    for entry in statuses.iter() {
        if let Some(p) = entry.path() {
            candidates.push(p.to_string());
        }
    }

    for rel in candidates {
        let abs = workdir.join(&rel);
        if !abs.is_file() {
            continue;
        }
        let content = match std::fs::read_to_string(&abs) {
            Ok(s) => s,
            Err(_) => continue, // binary or non-utf8 — skip
        };
        let ours = match extract_ours_from_markers(&content) {
            Some(s) => s,
            None => continue,
        };

        // Write OUR side (the stashed-local content) to the .conflict backup.
        let conflict_path = make_conflict_path(&abs, &ts);
        std::fs::write(&conflict_path, ours.as_bytes())
            .map_err(|e| VaultError::FsError(e.to_string()))?;

        // Replace the file with the verbatim HEAD blob (theirs, the rebased
        // remote version). This avoids relying on whitespace produced by
        // libgit2's marker block.
        let head_blob_oid = head_tree
            .get_path(Path::new(&rel))
            .ok()
            .map(|e| e.id());
        if let Some(oid) = head_blob_oid {
            let blob = repo.find_blob(oid)?;
            std::fs::write(&abs, blob.content())
                .map_err(|e| VaultError::FsError(e.to_string()))?;
        } else {
            // No HEAD blob (new file in stash) — remove the marker file; the
            // .conflict backup retains our content.
            let _ = std::fs::remove_file(&abs);
        }
        log.push(conflict_path.display().to_string());
    }

    // Re-stage everything so the .conflict.<ts> backups and overwritten files
    // are recorded in the index.
    let mut index = repo.index()?;
    index.add_all(["."].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index.write()?;
    Ok(())
}

/// Parse a file with libgit2 conflict markers and reconstruct the OUR side.
/// libgit2 emits `<<<<<<< Updated upstream` (theirs/incoming, above `=======`)
/// and `>>>>>>> Stashed changes` (ours, below). Returns `None` when no
/// conflict block is present.
fn extract_ours_from_markers(text: &str) -> Option<String> {
    if !text.contains("<<<<<<<") || !text.contains("=======") || !text.contains(">>>>>>>") {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    enum Mode { Pass, Theirs, Ours }
    let mut mode = Mode::Pass;
    let mut seen_any_block = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.starts_with("<<<<<<<") {
            mode = Mode::Theirs;
            seen_any_block = true;
            continue;
        }
        if matches!(mode, Mode::Theirs) && trimmed == "=======" {
            mode = Mode::Ours;
            continue;
        }
        if trimmed.starts_with(">>>>>>>") {
            mode = Mode::Pass;
            continue;
        }
        match mode {
            Mode::Pass => out.push_str(line),
            Mode::Theirs => {}
            Mode::Ours => out.push_str(line),
        }
    }
    if !seen_any_block { return None; }
    Some(out)
}
