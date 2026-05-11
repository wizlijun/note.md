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
