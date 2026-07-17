//! Plugin runtime v2 (spec §3-§5). Coexists with the v1 one-shot host until
//! all first-batch plugins migrate (子项目④). Everything is gated behind
//! `plugins_v2.enabled` in settings.json or NOTEMD_PLUGINS_V2=1.

pub mod adapter;
pub mod commands;
pub mod discovery;
pub mod host_api;
pub mod lifecycle;
pub mod process;
pub mod state;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, RwLock};

pub struct RuntimeState {
    pub enabled_flag: bool,
    /// id → (manifest, install_dir<current/>)
    pub plugins: HashMap<String, (plugin_protocol::ManifestV2, std::path::PathBuf)>,
}

pub static STATE: LazyLock<RwLock<RuntimeState>> =
    LazyLock::new(|| RwLock::new(RuntimeState { enabled_flag: false, plugins: HashMap::new() }));

/// Pure(ish) flag check against an explicit config dir: env var override first,
/// then `settings.json` in `config_dir`. The CLI (no AppHandle) calls this
/// directly with `cli::resolve_config_dir()`; the AppHandle version wraps it.
pub fn v2_flag_enabled_at(config_dir: &Path) -> bool {
    if std::env::var("NOTEMD_PLUGINS_V2").map_or(false, |v| v == "1") {
        return true;
    }
    // 读法仿 read_saved_locale（lib.rs）
    let Ok(text) = std::fs::read_to_string(config_dir.join("settings.json")) else { return false };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    json.get("plugins_v2.enabled").and_then(|v| v.as_bool()).unwrap_or(false)
}

pub fn v2_flag_enabled<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    // On resolution failure fall through with an empty path: the settings read
    // fails closed while the env-var override still applies.
    let dir = tauri::Manager::path(app).app_config_dir().unwrap_or_default();
    v2_flag_enabled_at(&dir)
}

/// setup 阶段调用（plugin_host::init 之后）。flag 关 ⇒ 空 STATE，零成本。
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let flag = v2_flag_enabled(app);
    {
        let mut st = STATE.write().unwrap();
        st.enabled_flag = flag;
        if !flag {
            return;
        }
        let host_version = app.package_info().version.to_string();
        match discovery::scan(app, &host_version) {
            Ok(map) => st.plugins = map,
            Err(e) => eprintln!("[plugin_runtime] scan failed: {e}"),
        }
        eprintln!("[plugin_runtime] v2 enabled, {} plugin(s)", st.plugins.len());
    } // release the STATE write lock before registration re-reads it
    commands::startup_activate_all(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: none of these tests set NOTEMD_PLUGINS_V2 — mutating the process
    // environment would race with parallel tests. The env override is a plain
    // `== "1"` check exercised implicitly (unset ⇒ falls through to settings).

    #[test]
    fn flag_reads_settings_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{ "plugins_v2.enabled": true }"#)
            .unwrap();
        assert!(v2_flag_enabled_at(dir.path()));
    }

    #[test]
    fn flag_false_when_setting_false_or_missing() {
        let dir = tempfile::tempdir().unwrap();
        // No settings.json at all
        assert!(!v2_flag_enabled_at(dir.path()));
        // Explicit false
        std::fs::write(dir.path().join("settings.json"), r#"{ "plugins_v2.enabled": false }"#)
            .unwrap();
        assert!(!v2_flag_enabled_at(dir.path()));
        // Key absent
        std::fs::write(dir.path().join("settings.json"), r#"{ "locale": "en" }"#).unwrap();
        assert!(!v2_flag_enabled_at(dir.path()));
    }

    #[test]
    fn flag_false_on_malformed_settings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "{ not json").unwrap();
        assert!(!v2_flag_enabled_at(dir.path()));
    }
}
