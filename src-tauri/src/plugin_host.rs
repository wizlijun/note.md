//! Plugin host: scans manifest files at startup, spawns plugin binaries on demand.
//!
//! Startup is intentionally cheap — only `manifest.json` files are read. Plugin
//! binaries are NEVER opened, `stat`'d, or otherwise touched until the user
//! triggers an invocation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    pub binary: String,
    #[serde(default)]
    pub menus: Vec<MenuEntry>,
    #[serde(default)]
    pub context_menus: Vec<ContextMenuEntry>,
    #[serde(default)]
    pub settings: Option<SettingsBlock>,
    pub host_capabilities: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_timeout() -> u64 { 30 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuEntry {
    pub location: String,
    pub label: String,
    #[serde(default)]
    pub shortcut: Option<String>,
    pub command: String,
    #[serde(default)]
    pub enabled_when: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuEntry {
    pub location: String,
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub enabled_when: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsBlock {
    pub tab_label: String,
    pub schema: Vec<serde_json::Value>,
}

#[derive(Debug, Default)]
struct State {
    /// Plugin id → (manifest, source-directory containing the binary).
    plugins: HashMap<String, (PluginManifest, PathBuf)>,
}

static STATE: RwLock<State> = RwLock::new(State { plugins: HashMap::new() });

/// Called from `lib.rs` once at app startup. Walks `<resource_dir>/plugins/*/manifest.json`,
/// parses each, and stashes valid ones in STATE. Invalid manifests are logged
/// to stderr and skipped — they do not crash the app.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let plugins_dir = match app.path().resource_dir() {
        Ok(rd) => rd.join("plugins"),
        Err(e) => { eprintln!("[plugin_host] resource_dir failed: {e}"); return; }
    };
    if !plugins_dir.exists() { return }

    let entries = match std::fs::read_dir(&plugins_dir) {
        Ok(e) => e,
        Err(e) => { eprintln!("[plugin_host] read_dir {:?}: {e}", plugins_dir); return; }
    };

    let mut state = STATE.write().unwrap();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue }
        let manifest_path = dir.join("manifest.json");
        if !manifest_path.exists() { continue }

        let bytes = match std::fs::read(&manifest_path) {
            Ok(b) => b,
            Err(e) => { eprintln!("[plugin_host] read {:?}: {e}", manifest_path); continue }
        };
        let manifest: PluginManifest = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(e) => { eprintln!("[plugin_host] parse {:?}: {e}", manifest_path); continue }
        };
        if state.plugins.contains_key(&manifest.id) {
            eprintln!("[plugin_host] duplicate id '{}' — keeping first", manifest.id);
            continue
        }
        state.plugins.insert(manifest.id.clone(), (manifest, dir));
    }
}

#[tauri::command]
pub fn get_plugin_manifests() -> Vec<PluginManifest> {
    STATE.read().unwrap().plugins.values().map(|(m, _)| m.clone()).collect()
}
