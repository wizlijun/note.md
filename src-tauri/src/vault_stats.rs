//! Metadata-only welcome-page statistics; independent of search and Git filters.
use std::{collections::{HashMap, HashSet}, fs, path::Path, sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}}, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use tauri::Manager;

static REQUESTS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SCAN_GATE: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRules { pub extensions: Vec<String>, pub names: Vec<String> }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStats {
    pub root: String,
    pub documents: u64,
    pub files: u64,
    pub bytes: u64,
    pub skipped: u64,
    pub completed_at: Option<u64>,
}

fn current_root(app: &tauri::AppHandle) -> Option<String> {
    app.state::<Arc<crate::vault_sync::VaultSyncManager>>().repo_path.lock().unwrap().clone()
}

#[tauri::command]
pub fn notemd_vault_stats_cancel(request_id: String) {
    if let Some(cancel) = REQUESTS.lock().unwrap().get(&request_id) { cancel.store(true, Ordering::Relaxed); }
}

#[tauri::command]
pub async fn notemd_vault_stats(app: tauri::AppHandle, expected_root: String, request_id: String, rules: DocumentRules) -> Result<VaultStats, String> {
    if current_root(&app).as_deref() != Some(expected_root.as_str()) { return Err("Vault changed".into()); }
    crate::sotvault::root_guard::check(Path::new(&expected_root))
        .map_err(|reason| format!("This folder cannot be scanned as a Vault: {reason:?}"))?;
    if request_id.is_empty() || request_id.len() > 128 || rules.extensions.len() > 4096 || rules.names.len() > 4096
        || rules.extensions.iter().chain(rules.names.iter()).any(|s| s.len() > 256) { return Err("Invalid statistics request".into()); }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut requests = REQUESTS.lock().unwrap();
        if requests.len() >= 8 || requests.contains_key(&request_id) { return Err("Statistics request already pending".into()); }
        requests.insert(request_id.clone(), cancel.clone());
    }
    let root = expected_root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCAN_GATE.lock().unwrap();
        scan(Path::new(&root), &rules, &cancel)
    }).await.map_err(|e| e.to_string()).and_then(|r| r);
    REQUESTS.lock().unwrap().remove(&request_id);
    if current_root(&app).as_deref() != Some(expected_root.as_str()) { return Err("Vault changed".into()); }
    result
}

fn scan(root: &Path, rules: &DocumentRules, cancel: &AtomicBool) -> Result<VaultStats, String> {
    if cancel.load(Ordering::Relaxed) { return Err("Statistics cancelled".into()); }
    let metadata = fs::metadata(root).map_err(|e| e.to_string())?;
    if !metadata.is_dir() { return Err("Vault is not a directory".into()); }
    let extensions: HashSet<_> = rules.extensions.iter().map(|s| s.to_lowercase()).collect();
    let names: HashSet<_> = rules.names.iter().map(|s| s.to_lowercase()).collect();
    let mut stats = VaultStats { root: root.to_string_lossy().into_owned(), documents: 0, files: 0, bytes: 0, skipped: 0, completed_at: None };
    // Open directory iterators retain O(depth) state instead of every file/path.
    let mut stack = vec![fs::read_dir(root).map_err(|e| e.to_string())?];
    while let Some(entries) = stack.last_mut() {
        if cancel.load(Ordering::Relaxed) { return Err("Statistics cancelled".into()); }
        let Some(entry) = entries.next() else { stack.pop(); continue };
        let entry = match entry { Ok(e) => e, Err(_) => { stats.skipped += 1; continue } };
        let name = entry.file_name();
        if matches!(name.to_str(), Some(".git" | ".notemd" | ".DS_Store" | "Thumbs.db")) { continue; }
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => { stats.skipped += 1; continue },
        };
        if metadata.file_type().is_symlink() { continue; }
        if metadata.is_dir() {
            match fs::read_dir(entry.path()) { Ok(e) => stack.push(e), Err(_) => stats.skipped += 1 }
        } else if metadata.is_file() {
            stats.files += 1;
            stats.bytes = stats.bytes.saturating_add(metadata.len());
            let lower = name.to_string_lossy().to_lowercase();
            let extension = Path::new(&lower).extension().and_then(|e| e.to_str()).unwrap_or("");
            if names.contains(&lower) || extensions.contains(extension) { stats.documents += 1; }
        }
    }
    if stats.skipped == 0 { stats.completed_at = Some(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64); }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rules() -> DocumentRules { DocumentRules { extensions: vec!["md".into(), "canvas".into(), "base".into(), "custom".into()], names: vec!["makefile".into()] } }
    fn write(root: &Path, path: &str, bytes: &[u8]) { let p = root.join(path); fs::create_dir_all(p.parent().unwrap()).unwrap(); fs::write(p, bytes).unwrap(); }
    #[test]
    fn counts_content_not_index_or_git_history() {
        let root = tempfile::tempdir().unwrap();
        for (p, data) in [("a.MD", "abc"), ("nested/x.canvas", "ab"), ("x.base", "a"), ("plugin.custom", "x"), ("Makefile", "x"), ("photo.png", "1234"), (".hidden/n.md", "x"), (".git/objects/a", "ignore"), ("nested/.notemd/index", "ignore"), (".DS_Store", "ignore"), (".gitignore", "x")] { write(root.path(), p, data.as_bytes()); }
        let got = scan(root.path(), &rules(), &AtomicBool::new(false)).unwrap();
        assert_eq!((got.documents, got.files, got.bytes, got.skipped), (6, 8, 14, 0));
        assert!(got.completed_at.is_some());
    }
    #[test]
    fn empty_missing_and_cancelled_are_distinct() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(scan(root.path(), &rules(), &AtomicBool::new(false)).unwrap().files, 0);
        assert!(scan(&root.path().join("missing"), &rules(), &AtomicBool::new(false)).is_err());
        assert_eq!(scan(root.path(), &rules(), &AtomicBool::new(true)).unwrap_err(), "Statistics cancelled");
    }
    #[cfg(unix)]
    #[test]
    fn does_not_follow_links_and_counts_hardlinks_by_path() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "a.md", b"abc");
        std::os::unix::fs::symlink(root.path(), root.path().join("loop")).unwrap();
        std::os::unix::fs::symlink(root.path().join("a.md"), root.path().join("linked.md")).unwrap();
        fs::hard_link(root.path().join("a.md"), root.path().join("hard.md")).unwrap();
        let got = scan(root.path(), &rules(), &AtomicBool::new(false)).unwrap();
        assert_eq!((got.documents, got.files, got.bytes), (2, 2, 6));
    }
}
