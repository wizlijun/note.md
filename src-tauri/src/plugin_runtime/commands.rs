//! Tauri commands exposing the v2 runtime to the frontend (plan Task 8).
//!
//! Lifecycles register lazily in [`RUNNING`]: the first trigger builds a
//! [`SpawnCtx`] from the AppHandle once; from then on the lifecycle machine
//! owns (re)spawning without any tauri types (crash restarts included).

use std::path::Path;
use std::sync::Arc;

use tauri::Manager;

use super::lifecycle::{self, PluginLifecycle, SpawnCtx, Trigger, RUNNING};
use super::{adapter, discovery, host_api, STATE};

/// v2 manifests serialized in v1 `PluginManifest` shape; the frontend spots
/// them by `manifest_version: 2` and routes execution to `plugin_v2_execute`.
#[tauri::command]
pub fn get_plugin_manifests_v2() -> Vec<serde_json::Value> {
    adapter::adapted_v2_manifests()
        .iter()
        .filter_map(|m| serde_json::to_value(m).ok())
        .collect()
}

/// Execute `command` on a v2 plugin: lazy activation (spec §4.2) followed by
/// `command.execute`. `context` is the same shape v1 plugins receive.
#[tauri::command]
pub async fn plugin_v2_execute(
    app: tauri::AppHandle,
    plugin_id: String,
    command: String,
    context: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let lc = get_or_register(&app, &plugin_id)?;
    lc.ensure_active(&Trigger::Command(command.clone())).await?;
    lc.execute(plugin_protocol::ExecuteCommandParams { command, context })
        .await
}

/// Called from `plugin_runtime::init` after discovery populated STATE:
/// register a lifecycle for every discovered plugin, then eagerly activate
/// the ones whose events match `Startup` (spec §4.3). The activation itself
/// is pushed onto the tauri async runtime — `init` runs inside `setup`,
/// outside any tokio context, and `startup_activation` needs `tokio::spawn`.
pub fn startup_activate_all<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let ids: Vec<String> = STATE.read().unwrap().plugins.keys().cloned().collect();
    let mut lifecycles = Vec::new();
    for id in ids {
        match get_or_register(app, &id) {
            Ok(lc) => lifecycles.push(lc),
            Err(e) => eprintln!("[plugin_runtime] cannot register '{id}': {e}"),
        }
    }
    if lifecycles.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        lifecycle::startup_activation(lifecycles);
    });
}

/// Look up the live lifecycle for `plugin_id`, registering a fresh one from
/// STATE on first use. Registration is idempotent: on a lost race the entry
/// that got in first wins and the freshly built (never-spawned) one is dropped.
fn get_or_register<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_id: &str,
) -> Result<Arc<PluginLifecycle>, String> {
    if let Some(lc) = RUNNING.read().unwrap().get(plugin_id) {
        return Ok(lc.clone());
    }
    let (manifest, install_dir) = STATE
        .read()
        .unwrap()
        .plugins
        .get(plugin_id)
        .cloned()
        .ok_or_else(|| format!("unknown v2 plugin: {plugin_id}"))?;
    let ctx = build_spawn_ctx(app, &manifest, &install_dir)?;
    let lc = Arc::new(PluginLifecycle::new(manifest, install_dir, ctx));
    Ok(RUNNING
        .write()
        .unwrap()
        .entry(plugin_id.to_string())
        .or_insert(lc)
        .clone())
}

/// Assemble everything the lifecycle needs to (re)spawn without an AppHandle.
fn build_spawn_ctx<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    manifest: &plugin_protocol::ManifestV2,
    install_dir: &Path,
) -> Result<SpawnCtx, String> {
    // Same arch mapping discovery validated against at scan time.
    let triple = discovery::current_arch_triple()
        .ok_or_else(|| format!("unsupported host arch '{}'", std::env::consts::ARCH))?;
    let rel = manifest.binary.get(triple).ok_or_else(|| {
        format!("plugin '{}': no binary for host arch '{triple}'", manifest.id)
    })?;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("cannot resolve app log dir: {e}"))?
        .join("plugins");
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    Ok(SpawnCtx {
        binary: install_dir.join(rel),
        host_sink: host_api::make_sink_for_app(
            manifest.id.clone(),
            manifest.capabilities.clone(),
            app.clone(),
            log_dir.clone(),
        ),
        log_dir,
        host_version: app.package_info().version.to_string(),
        locale: crate::read_saved_locale(app),
        app_data,
    })
}
