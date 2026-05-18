pub mod shared_config;
pub mod calibre;
pub mod fs_ops;
pub mod hash;

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![ping, shared_config_read, shared_config_write, calibre_detect])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
