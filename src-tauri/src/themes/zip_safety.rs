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
