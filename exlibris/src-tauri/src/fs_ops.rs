use std::path::{Path, PathBuf};

/// Atomically copy `src` to `dst`. If `dst` exists, append " (N)" to the stem
/// (preserving extension) until a free name is found. Returns the final path.
pub fn atomic_copy_with_suffix(src: &Path, dst: &Path) -> std::io::Result<PathBuf> {
    let final_path = resolve_collision(dst);
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = final_path.with_extension(format!(
        "{}.tmp",
        final_path.extension().and_then(|s| s.to_str()).unwrap_or("")
    ));
    std::fs::copy(src, &tmp)?;
    if let Ok(f) = std::fs::File::open(&tmp) { let _ = f.sync_all(); }
    std::fs::rename(&tmp, &final_path)?;
    Ok(final_path)
}

fn resolve_collision(dst: &Path) -> PathBuf {
    if !dst.exists() { return dst.to_path_buf(); }
    let stem = dst.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let ext = dst.extension().and_then(|s| s.to_str());
    let parent = dst.parent().unwrap_or(Path::new("."));
    let mut n = 2;
    loop {
        let candidate_name = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() { return candidate; }
        n += 1;
        if n > 1000 { return candidate; }
    }
}

pub fn rename_strict(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("rename target already exists: {}", dst.display()),
        ));
    }
    if let Some(parent) = dst.parent() { std::fs::create_dir_all(parent)?; }
    std::fs::rename(src, dst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn atomic_copy_writes_to_final_path() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src.txt");
        let dst = tmp.path().join("out/dst.txt");
        std::fs::write(&src, "hello").unwrap();
        let got = atomic_copy_with_suffix(&src, &dst).unwrap();
        assert_eq!(got, dst);
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "hello");
    }

    #[test]
    fn atomic_copy_avoids_collision_with_suffix() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src.txt");
        let dst = tmp.path().join("dst.txt");
        std::fs::write(&src, "v1").unwrap();
        std::fs::write(&dst, "existing").unwrap();
        let got = atomic_copy_with_suffix(&src, &dst).unwrap();
        assert_eq!(got, tmp.path().join("dst (2).txt"));
        assert_eq!(std::fs::read_to_string(&got).unwrap(), "v1");
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "existing");
    }

    #[test]
    fn rename_strict_errors_on_existing_target() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("a"); let dst = tmp.path().join("b");
        std::fs::create_dir(&src).unwrap();
        std::fs::create_dir(&dst).unwrap();
        let err = rename_strict(&src, &dst).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }
}
