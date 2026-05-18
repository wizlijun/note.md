pub mod shared_config;
pub mod calibre;
pub mod fs_ops;
pub mod hash;

use serde::Serialize;

#[derive(Serialize)]
pub struct SotvaultEntry {
    pub rule_dir: String,
    pub book_name: String,
    pub meta_yaml: String,
}

#[tauri::command]
fn sotvault_list_meta(sotvault: String) -> Result<Vec<SotvaultEntry>, String> {
    let root = std::path::PathBuf::from(&sotvault);
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_name() != "meta.yml" { continue; }
        let p = entry.path();
        // expected layout: <sotvault>/<rule_dir>/<book_name>/meta.yml
        let book_dir = match p.parent() { Some(b) => b, None => continue };
        let rule_dir_path = match book_dir.parent() { Some(r) => r, None => continue };
        if rule_dir_path == root { continue; } // depth 1: skip top-level meta.yml
        if rule_dir_path.file_name().map(|s| s.to_string_lossy().starts_with('.')) == Some(true) {
            continue; // skip .exlibris/
        }
        let book_name = book_dir.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let rule_dir = rule_dir_path.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let yaml = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
        out.push(SotvaultEntry { rule_dir, book_name, meta_yaml: yaml });
    }
    Ok(out)
}

#[tauri::command]
fn fs_atomic_copy(src: String, dst: String) -> Result<String, String> {
    crate::fs_ops::atomic_copy_with_suffix(
        std::path::Path::new(&src), std::path::Path::new(&dst),
    )
    .map(|p| p.to_string_lossy().to_string())
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_rename_strict(src: String, dst: String) -> Result<(), String> {
    crate::fs_ops::rename_strict(
        std::path::Path::new(&src), std::path::Path::new(&dst),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn hash_file_sha256(path: String) -> Result<String, String> {
    crate::hash::file_sha256(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ping() -> &'static str { "pong" }

#[tauri::command]
fn shared_config_read() -> Result<crate::shared_config::SharedConfig, String> {
    let path = crate::shared_config::config_path().map_err(|e| e.to_string())?;
    crate::shared_config::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn shared_config_write(cfg: crate::shared_config::SharedConfig) -> Result<(), String> {
    let path = crate::shared_config::config_path().map_err(|e| e.to_string())?;
    crate::shared_config::write(&path, &cfg).map_err(|e| e.to_string())
}

#[tauri::command]
fn calibre_detect(user_configured: Option<String>) -> Option<String> {
    let user = user_configured.map(std::path::PathBuf::from);
    crate::calibre::detect(user.as_deref())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn calibre_extract_meta(
    binary_dir: String, file: String, timeout_secs: u64,
) -> Result<crate::calibre::ExtractedMeta, String> {
    crate::calibre::extract_meta(
        std::path::Path::new(&binary_dir),
        std::path::Path::new(&file),
        std::time::Duration::from_secs(timeout_secs),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn calibre_convert(
    binary_dir: String, src: String, dst: String, timeout_secs: u64,
) -> Result<(), String> {
    crate::calibre::convert(
        std::path::Path::new(&binary_dir),
        std::path::Path::new(&src),
        std::path::Path::new(&dst),
        std::time::Duration::from_secs(timeout_secs),
    )
    .await
    .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![ping, shared_config_read, shared_config_write, calibre_detect, calibre_extract_meta, calibre_convert, sotvault_list_meta, hash_file_sha256, fs_atomic_copy, fs_rename_strict])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
