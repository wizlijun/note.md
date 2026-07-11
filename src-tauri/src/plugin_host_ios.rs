//! iOS stub for the plugin host. The full subprocess plugin host is desktop-only
//! (App Sandbox forbids spawning child processes); on iOS all built-in plugin
//! functionality (share, etc.) is reimplemented in TS at `src/lib/share/`.

use serde_json::Value;
use std::collections::HashMap;
use tauri::AppHandle;

pub struct LocatedMenuItem {
    pub id: String,
    pub label: String,
    pub location: String,
    pub shortcut: Option<String>,
    pub submenu: Option<String>,
}

pub fn init<R: tauri::Runtime>(_app: &AppHandle<R>) {}
pub fn collect_top_menu_items(_locale: &str) -> Vec<LocatedMenuItem> { Vec::new() }

#[tauri::command]
pub fn get_plugin_manifests() -> Vec<Value> { Vec::new() }

#[tauri::command]
pub fn get_all_plugin_manifests() -> Vec<Value> { Vec::new() }

#[tauri::command]
pub fn plugin_is_enabled(_id: String) -> bool { false }

#[tauri::command]
pub async fn invoke_plugin(
    _id: String,
    _command: String,
    _payload: HashMap<String, Value>,
) -> Result<Value, String> {
    Err("plugins not supported on iOS".into())
}
