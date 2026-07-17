//! Tauri commands exposing the v2 runtime to the frontend (plan Task 8).
//!
//! Lifecycles register lazily in [`RUNNING`]: the first trigger builds a
//! [`SpawnCtx`] from the AppHandle once; from then on the lifecycle machine
//! owns (re)spawning without any tauri types (crash restarts included).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::Manager;

use super::lifecycle::{self, PluginLifecycle, SpawnCtx, Trigger, RUNNING};
use super::{adapter, discovery, host_api, STATE};

/// v2 manifests serialized in v1 `PluginManifest` shape; the frontend spots
/// them by `manifest_version: 2` and routes execution to `plugin_v2_execute`.
///
/// ③期市场窗口 hook 入口（待实现）。①期此命令未被前端直接消费——前端经由
/// `get_plugin_manifests`（plugin_host）拿到已合流的 v1+v2 列表。③期市场
/// 窗口将直接调用此命令以区分 v2 插件并驱动安装/升级/启停 UI。
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

/// STATE lookup half of registration — AppHandle-free so it is unit-testable.
fn lookup_v2(plugin_id: &str) -> Result<(plugin_protocol::ManifestV2, PathBuf), String> {
    STATE
        .read()
        .unwrap()
        .plugins
        .get(plugin_id)
        .cloned()
        .ok_or_else(|| format!("unknown v2 plugin: {plugin_id}"))
}

/// RUNNING registration half — idempotent: on a lost race the entry that got
/// in first wins and the freshly built (never-spawned) one is dropped.
fn register_lifecycle(plugin_id: &str, lc: Arc<PluginLifecycle>) -> Arc<PluginLifecycle> {
    RUNNING
        .write()
        .unwrap()
        .entry(plugin_id.to_string())
        .or_insert(lc)
        .clone()
}

/// Look up the live lifecycle for `plugin_id`, registering a fresh one from
/// STATE on first use.
fn get_or_register<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_id: &str,
) -> Result<Arc<PluginLifecycle>, String> {
    if let Some(lc) = RUNNING.read().unwrap().get(plugin_id) {
        return Ok(lc.clone());
    }
    let (manifest, install_dir) = lookup_v2(plugin_id)?;
    let ctx = build_spawn_ctx(app, &manifest, &install_dir)?;
    let lc = Arc::new(PluginLifecycle::new(manifest, install_dir, ctx));
    Ok(register_lifecycle(plugin_id, lc))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_manifest(id: &str) -> plugin_protocol::ManifestV2 {
        serde_json::from_value(serde_json::json!({
            "manifest_version": 2, "id": id, "name": "Fixture", "version": "1.0.0",
            "kind": "native", "engines": { "notemd": ">=0.0.0" },
            "activation": { "events": ["onCommand:noop"] }, "capabilities": []
        }))
        .unwrap()
    }

    fn noop_spawn_ctx() -> SpawnCtx {
        SpawnCtx {
            binary: PathBuf::from("/nonexistent/fixture-bin"),
            log_dir: std::env::temp_dir(),
            host_sink: std::sync::Arc::new(|_req| None),
            host_version: "0.0.0".into(),
            locale: "en".into(),
            app_data: std::env::temp_dir(),
        }
    }

    /// The real STATE-lookup half of get_or_register: unknown id → Err;
    /// present id → the stored (manifest, install_dir) pair.
    #[test]
    fn lookup_v2_err_on_unknown_and_ok_on_present() {
        let missing = lookup_v2("bogus.unknown-plugin");
        assert_eq!(missing.unwrap_err(), "unknown v2 plugin: bogus.unknown-plugin");

        // Unique id + cleanup keeps the global STATE mutation race-free
        // against other tests (none of which use this id).
        let id = "test.commands-lookup-fixture";
        STATE.write().unwrap().plugins.insert(
            id.to_string(),
            (fixture_manifest(id), PathBuf::from("/tmp/fixture-install")),
        );
        let found = lookup_v2(id).unwrap();
        assert_eq!(found.0.id, id);
        assert_eq!(found.1, PathBuf::from("/tmp/fixture-install"));
        STATE.write().unwrap().plugins.remove(id);
    }

    /// The real RUNNING-registration half: double registration returns the
    /// first Arc (idempotent; the loser is dropped without spawning).
    #[test]
    fn register_lifecycle_is_idempotent() {
        let id = "test.commands-register-fixture";
        let first = Arc::new(PluginLifecycle::new(
            fixture_manifest(id), PathBuf::from("/tmp/a"), noop_spawn_ctx()));
        let second = Arc::new(PluginLifecycle::new(
            fixture_manifest(id), PathBuf::from("/tmp/b"), noop_spawn_ctx()));
        let won_first = register_lifecycle(id, first.clone());
        let won_second = register_lifecycle(id, second);
        assert!(Arc::ptr_eq(&won_first, &first));
        assert!(Arc::ptr_eq(&won_second, &first), "second registration must return the first Arc");
        RUNNING.write().unwrap().remove(id);
    }
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
