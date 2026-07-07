//! Plugin host: scans manifest files at startup, spawns plugin binaries on demand.
//!
//! Startup is intentionally cheap — only `manifest.json` files are read. Plugin
//! binaries are NEVER opened, `stat`'d, or otherwise touched until the user
//! triggers an invocation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{LazyLock, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, AsyncBufReadExt};
use tokio::process::Command;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    #[default]
    External,
    Builtin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub kind: PluginKind,
    #[serde(default)]
    pub binary: Option<String>,
    #[serde(default)]
    pub default_enabled: Option<bool>,
    #[serde(default)]
    pub menus: Vec<MenuEntry>,
    #[serde(default)]
    pub context_menus: Vec<ContextMenuEntry>,
    #[serde(default)]
    pub settings: Option<SettingsBlock>,
    pub host_capabilities: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub cli: Vec<CliEntry>,
}

fn default_timeout() -> u64 { 30 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptSpec {
    pub kind: String,                           // "save-dialog" only in v1
    pub default_filename: String,
    pub filters: Vec<PromptFilter>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuEntry {
    pub location: String,
    pub label: String,
    #[serde(default)]
    pub shortcut: Option<String>,
    pub command: String,
    #[serde(default)]
    pub enabled_when: Option<String>,
    #[serde(default)]
    pub prompt: Option<PromptSpec>,
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
pub struct CliArg {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,             // "path" | "string" | "integer"
    pub required: bool,
    #[serde(default)]
    pub help: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliFlag {
    pub long: String,
    #[serde(default)]
    pub short: Option<String>,
    #[serde(rename = "type")]
    pub ty: String,             // "boolean" | "string"
    #[serde(default)]
    pub help: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliEntry {
    pub subcommand: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub command: String,
    pub summary: String,
    #[serde(default)]
    pub args: Vec<CliArg>,
    #[serde(default)]
    pub flags: Vec<CliFlag>,
    #[serde(default)]
    pub requires_tab_context: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsBlock {
    pub tab_label: String,
    pub schema: Vec<serde_json::Value>,
}

#[derive(Debug, Default)]
struct State {
    /// Manifests the host considers active (passed plugins.enabled filter).
    /// Drives menu registration, settings tabs, invocation lookups.
    enabled: HashMap<String, (PluginManifest, PathBuf)>,
    /// Every manifest discovered on disk (including disabled). Used only
    /// by the Preferences "Plugins" tab to render the on/off list.
    all: Vec<PluginManifest>,
}

static STATE: LazyLock<RwLock<State>> = LazyLock::new(|| RwLock::new(State::default()));

/// Read the `plugins.enabled` map from settings.json. Best-effort — any
/// error returns an empty map so all plugins fall through to the
/// default-on rule. Accepts three on-disk shapes:
///   1. Top-level "plugins.enabled" key:    `{"plugins.enabled": {"foo": true}}`
///   2. Nested under "plugins":              `{"plugins": {"enabled": {"foo": true}}}`
///   3. Flat fully-qualified keys:           `{"plugins.enabled.foo": true}`
/// Shape (1) is what the front-end writes today via tauri-plugin-store.
fn read_enabled_map<R: Runtime>(app: &AppHandle<R>) -> HashMap<String, bool> {
    let path = match app.path().app_config_dir() {
        Ok(p) => p.join("settings.json"),
        Err(_) => return HashMap::new(),
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    let v: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let mut out = HashMap::new();
    // Shape (1): top-level key "plugins.enabled" → object
    if let Some(obj) = v.get("plugins.enabled").and_then(|e| e.as_object()) {
        for (k, vv) in obj { if let Some(b) = vv.as_bool() { out.insert(k.clone(), b); } }
    }
    // Shape (2): nested {"plugins": {"enabled": {...}}}
    if let Some(obj) = v.get("plugins").and_then(|p| p.get("enabled")).and_then(|e| e.as_object()) {
        for (k, vv) in obj { if let Some(b) = vv.as_bool() { out.insert(k.clone(), b); } }
    }
    // Shape (3): flat top-level "plugins.enabled.<id>" keys
    if let Some(top) = v.as_object() {
        for (k, vv) in top {
            if let Some(rest) = k.strip_prefix("plugins.enabled.") {
                if let Some(b) = vv.as_bool() { out.insert(rest.to_string(), b); }
            }
        }
    }
    out
}

/// Whether a plugin id is enabled per settings.json, falling back to `default_on`
/// when the id is absent from the map. Used by the native menu builder to gate
/// built-in feature toggles (e.g. Folder View) that are managed through the same
/// `plugins.enabled` map as external plugins.
pub fn plugin_enabled_in_settings<R: Runtime>(app: &AppHandle<R>, id: &str, default_on: bool) -> bool {
    read_enabled_map(app).get(id).copied().unwrap_or(default_on)
}

/// Called from `lib.rs` once at app startup. Walks `<resource_dir>/plugins/*/manifest.json`,
/// parses each, and stashes valid ones in STATE. Invalid manifests are logged
/// to stderr and skipped — they do not crash the app. Manifests where the
/// user has set `plugins.enabled.<id> = false` are recorded in the "all"
/// list (so the Preferences UI can render them) but not added to the
/// active map; their menus / shortcuts / settings tabs do not register.
/// Best-effort fallback: derive `<bundle>/Contents/Resources/plugins/` from
/// `current_exe()`. Used when `app.path().resource_dir()` fails — which
/// happens at least when the process is launched through a symlink in a
/// non-`.app` location (e.g., the CLI's `/usr/local/bin/mdedit → .app/.../mdeditor`).
fn fallback_plugins_dir_from_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let macos_dir = exe.parent()?;
    let contents = macos_dir.parent()?;
    let candidate = contents.join("Resources").join("plugins");
    if candidate.exists() { Some(candidate) } else { None }
}

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let plugins_dir = match app.path().resource_dir() {
        Ok(rd) => rd.join("plugins"),
        Err(_) => {
            match fallback_plugins_dir_from_exe() {
                Some(p) => p,
                None => return,
            }
        }
    };
    if !plugins_dir.exists() { return }

    let entries = match std::fs::read_dir(&plugins_dir) {
        Ok(e) => e,
        Err(e) => { eprintln!("[plugin_host] read_dir {:?}: {e}", plugins_dir); return; }
    };

    let enabled_map = read_enabled_map(app);

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

        // Always record the manifest in the "all" list (even if disabled).
        state.all.push(manifest.clone());

        let is_enabled = resolve_enabled(&manifest, &enabled_map);
        if !is_enabled { continue }

        if state.enabled.contains_key(&manifest.id) {
            eprintln!("[plugin_host] duplicate id '{}' — keeping first", manifest.id);
            continue
        }
        state.enabled.insert(manifest.id.clone(), (manifest, dir));
    }
}

#[tauri::command]
pub fn get_plugin_manifests() -> Vec<PluginManifest> {
    STATE.read().unwrap().enabled.values().map(|(m, _)| m.clone()).collect()
}

/// Returns *every* manifest discovered on disk, including disabled ones.
/// Only the Preferences "Plugins" tab uses this — runtime menus / dispatch
/// must use `get_plugin_manifests` so disabled plugins remain inert.
#[tauri::command]
pub fn get_all_plugin_manifests() -> Vec<PluginManifest> {
    STATE.read().unwrap().all.clone()
}

/// Whether the given plugin id is currently registered as enabled.
/// Single source of truth for all gating logic across Rust + IPC.
pub fn is_plugin_enabled(id: &str) -> bool {
    STATE.read().unwrap().enabled.contains_key(id)
}

#[tauri::command]
pub fn plugin_is_enabled(id: String) -> bool { is_plugin_enabled(&id) }

#[derive(Debug, Serialize)]
pub struct InvokeResult {
    pub success: bool,
    pub stdout_line: Option<String>,
    pub stderr_tail: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

const STDERR_CAP_BYTES: usize = 16 * 1024;

fn pick_binary_for_arch(plugin_dir: &PathBuf, base: &str) -> Option<PathBuf> {
    #[cfg(target_arch = "aarch64")]
    let triple = "aarch64-apple-darwin";
    #[cfg(target_arch = "x86_64")]
    let triple = "x86_64-apple-darwin";
    let candidate = plugin_dir.join(format!("{base}-{triple}"));
    if candidate.exists() { return Some(candidate) }
    // Fallback for fixtures: bare name (e.g. shell scripts).
    let bare = plugin_dir.join(base);
    if bare.exists() { return Some(bare) }
    None
}

/// Test-friendly wrapper: takes a binary path + request JSON + timeout, returns
/// the same InvokeResult. The Tauri command (`invoke_plugin`) wraps this with
/// manifest lookup. Tests in Task 8 call `run_plugin_binary` directly to avoid
/// needing a full Tauri AppHandle.
pub async fn run_plugin_binary(
    binary: &PathBuf,
    request_json: &str,
    timeout_seconds: u64,
) -> Result<InvokeResult, String> {
    let mut cmd = Command::new(binary);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;

    let req = request_json.to_string();
    let write_fut = async move {
        stdin.write_all(req.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.shutdown().await?;
        Ok::<_, std::io::Error>(())
    };

    let stdout_fut = async {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) => Ok::<Option<String>, std::io::Error>(None),
            Ok(_) => Ok(Some(line.trim_end_matches('\n').to_string())),
            Err(e) => Err(e),
        }
    };

    let stderr_fut = async {
        let mut buf = Vec::with_capacity(4096);
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    let take = n.min(STDERR_CAP_BYTES.saturating_sub(buf.len()));
                    buf.extend_from_slice(&chunk[..take]);
                    if buf.len() >= STDERR_CAP_BYTES { break }
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    };

    let timeout = Duration::from_secs(timeout_seconds.max(1));
    let combined = async {
        let (_, stdout_line, stderr_tail) = tokio::join!(write_fut, stdout_fut, stderr_fut);
        let exit_status = child.wait().await.ok();
        Ok::<(Option<String>, String, Option<i32>), std::io::Error>(
            (stdout_line.unwrap_or(None), stderr_tail, exit_status.and_then(|s| s.code())),
        )
    };

    match tokio::time::timeout(timeout, combined).await {
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Ok(InvokeResult {
                success: false,
                stdout_line: None,
                stderr_tail: String::new(),
                exit_code: None,
                error: Some(format!("timeout:{}", timeout_seconds)),
            })
        }
        Ok(Err(e)) => Err(format!("io error: {e}")),
        Ok(Ok((stdout_line, stderr_tail, exit_code))) => {
            let success = matches!(exit_code, Some(0)) && stdout_line.is_some();
            Ok(InvokeResult { success, stdout_line, stderr_tail, exit_code, error: None })
        }
    }
}

#[tauri::command]
pub async fn invoke_plugin(plugin_id: String, request_json: String) -> Result<InvokeResult, String> {
    let (manifest, plugin_dir) = {
        let st = STATE.read().unwrap();
        match st.enabled.get(&plugin_id) {
            Some((m, d)) => (m.clone(), d.clone()),
            None => return Err(format!("unknown plugin: {plugin_id}")),
        }
    };
    if matches!(manifest.kind, PluginKind::Builtin) {
        return Err("builtin plugins cannot be invoked via dispatch".into());
    }
    let binary_name = manifest.binary.as_deref()
        .ok_or_else(|| "plugin has no binary (builtin plugins cannot be invoked)".to_string())?;
    let binary = match pick_binary_for_arch(&plugin_dir, binary_name) {
        Some(p) => p,
        None => return Err(format!("binary not found for plugin {plugin_id}")),
    };
    run_plugin_binary(&binary, &request_json, manifest.timeout_seconds).await
}

/// Test-only: initialize STATE from an arbitrary directory rather than the
/// app's resource_dir. Lets integration tests measure startup cost without
/// needing a Tauri AppHandle. Returns the number of plugins loaded.
///
/// Like `init`, this only reads manifest.json files. It does NOT open, stat,
/// or otherwise touch the plugin binary file referenced by `manifest.binary`.
pub fn init_from(plugins_dir: &PathBuf) -> usize {
    let mut state = STATE.write().unwrap();
    state.enabled.clear();
    state.all.clear();
    let entries = match std::fs::read_dir(plugins_dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue }
        let manifest_path = dir.join("manifest.json");
        if !manifest_path.exists() { continue }
        let bytes = match std::fs::read(&manifest_path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let manifest: PluginManifest = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(_) => continue,
        };
        state.all.push(manifest.clone());
        if state.enabled.contains_key(&manifest.id) { continue }
        state.enabled.insert(manifest.id.clone(), (manifest, dir));
    }
    state.enabled.len()
}

pub struct LocatedMenuItem {
    pub id: String,
    pub label: String,
    pub shortcut: Option<String>,
    pub location: String,
}

/// Returns menu entries flattened across all loaded plugins, with ids encoded
/// as `plugin:<id>:<command>`.
pub fn collect_top_menu_items() -> Vec<LocatedMenuItem> {
    let st = STATE.read().unwrap();
    let mut out = Vec::new();
    for (_, (m, _)) in st.enabled.iter() {
        for me in m.menus.iter() {
            out.push(LocatedMenuItem {
                id: format!("plugin:{}:{}", m.id, me.command),
                label: me.label.clone(),
                shortcut: me.shortcut.clone(),
                location: me.location.clone(),
            });
        }
    }
    out
}

/// Read-only access to every discovered enabled plugin with its directory path.
/// The CLI router uses this to find plugins by subcommand/alias.
pub fn enabled_manifests_with_paths() -> Vec<(PluginManifest, PathBuf)> {
    STATE.read().unwrap().enabled.values().cloned().collect()
}

pub fn all_manifests() -> Vec<PluginManifest> {
    STATE.read().unwrap().all.clone()
}

/// Decide whether a given manifest should be active given the persisted
/// enabled-map. External plugins default ON (preserves legacy behavior);
/// builtin plugins use the manifest's `default_enabled` field (default OFF).
pub fn resolve_enabled(manifest: &PluginManifest, enabled_map: &HashMap<String, bool>) -> bool {
    match enabled_map.get(&manifest.id) {
        Some(&v) => v,
        None => match manifest.kind {
            PluginKind::External => true,
            PluginKind::Builtin => manifest.default_enabled.unwrap_or(false),
        },
    }
}

/// Same as `read_enabled_map` but takes an explicit config path. The CLI uses
/// this before any Tauri AppHandle exists.
pub fn read_enabled_map_from(config_dir: &std::path::Path) -> HashMap<String, bool> {
    let path = config_dir.join("settings.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    let v: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let mut out = HashMap::new();
    if let Some(obj) = v.get("plugins.enabled").and_then(|e| e.as_object()) {
        for (k, vv) in obj { if let Some(b) = vv.as_bool() { out.insert(k.clone(), b); } }
    }
    if let Some(obj) = v.get("plugins").and_then(|p| p.get("enabled")).and_then(|e| e.as_object()) {
        for (k, vv) in obj { if let Some(b) = vv.as_bool() { out.insert(k.clone(), b); } }
    }
    if let Some(top) = v.as_object() {
        for (k, vv) in top {
            if let Some(rest) = k.strip_prefix("plugins.enabled.") {
                if let Some(b) = vv.as_bool() { out.insert(rest.to_string(), b); }
            }
        }
    }
    out
}

/// Persist plugins.enabled.<plugin_id> to <config_dir>/settings.json, preserving
/// every other top-level key. Creates the config dir + file if needed.
pub fn write_enabled_flag(
    config_dir: &std::path::Path,
    plugin_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let path = config_dir.join("settings.json");
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = match std::fs::read(&path) {
        Ok(b) if !b.is_empty() => serde_json::from_slice(&b).map_err(|e| e.to_string())?,
        _ => serde_json::json!({}),
    };
    let root = v.as_object_mut().ok_or_else(|| "settings.json root not an object".to_string())?;
    let entry = root.entry("plugins.enabled".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let map = entry.as_object_mut().ok_or_else(|| "plugins.enabled not an object".to_string())?;
    map.insert(plugin_id.to_string(), serde_json::Value::Bool(enabled));
    let bytes = serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// CLI router uses this to discover manifests + enabled-state from disk
/// without a Tauri AppHandle. Errors are silently ignored.
pub fn scan_disk(
    plugins_dir: &std::path::Path,
    config_dir: &std::path::Path,
) -> (Vec<(PluginManifest, PathBuf)>, HashMap<String, bool>) {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(plugins_dir) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() { continue }
            let mp = dir.join("manifest.json");
            if !mp.exists() { continue }
            if let Ok(bytes) = std::fs::read(&mp) {
                if let Ok(m) = serde_json::from_slice::<PluginManifest>(&bytes) {
                    out.push((m, dir));
                }
            }
        }
    }
    let enabled = read_enabled_map_from(config_dir);
    (out, enabled)
}

#[cfg(test)]
mod cli_helpers_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn read_enabled_map_from_missing_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let m = read_enabled_map_from(tmp.path());
        assert!(m.is_empty());
    }

    #[test]
    fn write_then_read_round_trips() {
        let tmp = TempDir::new().unwrap();
        write_enabled_flag(tmp.path(), "foo", false).unwrap();
        let m = read_enabled_map_from(tmp.path());
        assert_eq!(m.get("foo"), Some(&false));
    }

    #[test]
    fn write_preserves_other_top_level_keys() {
        let tmp = TempDir::new().unwrap();
        let settings = tmp.path().join("settings.json");
        std::fs::write(&settings, r#"{"unrelated": 42, "plugins.enabled": {"x": true}}"#).unwrap();
        write_enabled_flag(tmp.path(), "foo", true).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        assert_eq!(v.get("unrelated").and_then(|v| v.as_i64()), Some(42));
        assert_eq!(v.get("plugins.enabled").and_then(|p| p.get("x")).and_then(|v| v.as_bool()), Some(true));
        assert_eq!(v.get("plugins.enabled").and_then(|p| p.get("foo")).and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn manifest_with_cli_round_trips() {
        let json = r#"{
            "id": "demo",
            "name": "Demo",
            "version": "0.1.0",
            "binary": "bin",
            "host_capabilities": [],
            "cli": [{
                "subcommand": "demo",
                "command": "noop",
                "summary": "s",
                "args": [{"name": "f", "type": "path", "required": true}]
            }]
        }"#;
        let m: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.cli.len(), 1);
        assert_eq!(m.cli[0].subcommand, "demo");
        assert_eq!(m.cli[0].args.len(), 1);
        assert_eq!(m.cli[0].args[0].ty, "path");
    }

    #[test]
    fn manifest_without_cli_defaults_to_empty() {
        let json = r#"{
            "id": "old",
            "name": "Old",
            "version": "0.1.0",
            "binary": "bin",
            "host_capabilities": []
        }"#;
        let m: PluginManifest = serde_json::from_str(json).unwrap();
        assert!(m.cli.is_empty());
    }

    #[test]
    fn share_manifest_parses_with_cli() {
        let mp = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("plugins/share/manifest.json");
        let bytes = std::fs::read(&mp).expect("read manifest");
        let m: PluginManifest = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(m.id, "share");
        assert_eq!(m.cli.len(), 1);
        assert_eq!(m.cli[0].subcommand, "share");
        assert!(m.cli[0].aliases.contains(&"--share".to_string()));
        assert!(m.cli[0].requires_tab_context);
        assert_eq!(m.cli[0].flags.len(), 3);
        assert_eq!(m.cli[0].args.len(), 1);
        assert_eq!(m.cli[0].args[0].name, "file");
        assert_eq!(m.cli[0].args[0].ty, "path");
        assert!(m.cli[0].args[0].required);
    }

    #[test]
    fn manifest_defaults_to_external_kind() {
        let json = r#"{
            "id": "share", "name": "Share", "version": "1.0.0",
            "binary": "bin", "host_capabilities": ["toast"]
        }"#;
        let m: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.kind, PluginKind::External);
    }

    #[test]
    fn manifest_parses_builtin_kind() {
        let json = r#"{
            "id": "openclaw-chat", "name": "OpenClaw Chat", "version": "0.1.0",
            "kind": "builtin", "host_capabilities": []
        }"#;
        let m: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.kind, PluginKind::Builtin);
        assert!(m.binary.is_none());
    }

    #[test]
    fn resolve_enabled_external_defaults_true_when_absent() {
        let enabled_map = HashMap::new();
        let manifest = PluginManifest {
            id: "share".into(), name: "Share".into(), version: "1.0.0".into(),
            description: None, kind: PluginKind::External, binary: Some("bin".into()),
            default_enabled: None, menus: vec![], context_menus: vec![],
            settings: None, host_capabilities: vec![], timeout_seconds: 30,
            cli: vec![],
        };
        assert_eq!(resolve_enabled(&manifest, &enabled_map), true);
    }

    #[test]
    fn resolve_enabled_builtin_defaults_false_when_absent() {
        let enabled_map = HashMap::new();
        let manifest = PluginManifest {
            id: "openclaw-chat".into(), name: "OpenClaw Chat".into(), version: "0.1.0".into(),
            description: None, kind: PluginKind::Builtin, binary: None,
            default_enabled: Some(false), menus: vec![], context_menus: vec![],
            settings: None, host_capabilities: vec![], timeout_seconds: 30,
            cli: vec![],
        };
        assert_eq!(resolve_enabled(&manifest, &enabled_map), false);
    }

    #[test]
    fn is_plugin_enabled_returns_false_for_unknown_id() {
        // STATE is a global, but tests here run after init returns empty STATE.
        assert_eq!(is_plugin_enabled("never-existed-plugin"), false);
    }

    #[test]
    fn resolve_enabled_builtin_explicit_true_wins() {
        let mut enabled_map = HashMap::new();
        enabled_map.insert("openclaw-chat".to_string(), true);
        let manifest = PluginManifest {
            id: "openclaw-chat".into(), name: "OpenClaw Chat".into(), version: "0.1.0".into(),
            description: None, kind: PluginKind::Builtin, binary: None,
            default_enabled: Some(false), menus: vec![], context_menus: vec![],
            settings: None, host_capabilities: vec![], timeout_seconds: 30,
            cli: vec![],
        };
        assert_eq!(resolve_enabled(&manifest, &enabled_map), true);
    }
}
