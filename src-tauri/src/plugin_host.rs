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

static STATE: LazyLock<RwLock<State>> = LazyLock::new(|| RwLock::new(State::default()));

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
                error: Some(format!("timeout after {}s", timeout_seconds)),
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
        match st.plugins.get(&plugin_id) {
            Some((m, d)) => (m.clone(), d.clone()),
            None => return Err(format!("unknown plugin: {plugin_id}")),
        }
    };
    let binary = match pick_binary_for_arch(&plugin_dir, &manifest.binary) {
        Some(p) => p,
        None => return Err(format!("binary not found for plugin {plugin_id}")),
    };
    run_plugin_binary(&binary, &request_json, manifest.timeout_seconds).await
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
    for (_, (m, _)) in st.plugins.iter() {
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
