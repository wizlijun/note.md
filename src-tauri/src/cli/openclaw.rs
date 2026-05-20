//! `mdedit openclaw {install,uninstall,status}` — install the bundled M↓
//! channel plugin into a local OpenClaw setup (typically `~/.openclaw/`).
//!
//! The plugin source is embedded at compile time (~56 KB) via `include_dir`,
//! so no network is needed during install — only `pnpm install` afterwards
//! to fetch the plugin's own runtime deps (zod).

use include_dir::{include_dir, Dir};
use rand::RngCore;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

/// Generate a 64-char hex shared secret (32 random bytes).
fn generate_access_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

static PLUGIN_BUNDLE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/resources/openclaw-plugin");

#[derive(Debug, Clone)]
pub enum OpenclawCmd {
    Install { force: bool },
    Uninstall { keep_files: bool },
    Status,
}

/// True iff manifest exists on disk AND user has not explicitly disabled it
/// AND (either explicitly enabled OR default_enabled = true).
fn is_openclaw_chat_active(plugins_dir: &std::path::Path, config_dir: &std::path::Path) -> bool {
    let (manifests, enabled) = crate::plugin_host::scan_disk(plugins_dir, config_dir);
    let manifest = manifests.iter().find(|(m, _)| m.id == "openclaw-chat");
    let manifest = match manifest {
        Some((m, _)) => m,
        None => return false,
    };
    crate::plugin_host::resolve_enabled(manifest, &enabled)
}

pub fn run(cmd: OpenclawCmd) -> ExitCode {
    let plugins_dir = super::resolve_plugins_dir(None);
    let config_dir = super::resolve_config_dir();
    if !is_openclaw_chat_active(&plugins_dir, &config_dir) {
        eprintln!("mdedit: openclaw-chat plugin is disabled.");
        eprintln!("Enable it first:");
        eprintln!("  mdedit plugin enable openclaw-chat");
        return ExitCode::from(2);
    }
    let res = match cmd {
        OpenclawCmd::Install { force } => install(force),
        OpenclawCmd::Uninstall { keep_files } => uninstall(keep_files),
        OpenclawCmd::Status => status(),
    };
    match res {
        Ok(()) => ExitCode::from(0),
        Err(e) => {
            eprintln!("mdedit: {e}");
            ExitCode::from(1)
        }
    }
}

fn openclaw_home() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home.join(".openclaw"))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(openclaw_home()?.join("openclaw.json"))
}

fn plugin_install_dir() -> Result<PathBuf, String> {
    Ok(openclaw_home()?.join("plugins").join("mdeditor"))
}

fn install(force: bool) -> Result<(), String> {
    let oc_home = openclaw_home()?;
    if !oc_home.exists() {
        // Create it — openclaw might not be configured yet, but the dir is owned
        // by the user and creating it is harmless.
        fs::create_dir_all(&oc_home).map_err(|e| format!("mkdir {oc_home:?}: {e}"))?;
    }

    let dest = plugin_install_dir()?;
    if dest.exists() && !force {
        return Err(format!(
            "plugin already installed at {dest:?}; pass --force to overwrite"
        ));
    }
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| format!("rm {dest:?}: {e}"))?;
    }
    fs::create_dir_all(&dest).map_err(|e| format!("mkdir {dest:?}: {e}"))?;

    // Extract all bundled files.
    extract_dir(&PLUGIN_BUNDLE, &dest)?;
    println!("✓ extracted {} files to {}", count_files(&PLUGIN_BUNDLE), dest.display());

    // Try to fetch runtime deps via pnpm/npm (best-effort).
    let pm = which_pkg_manager();
    if let Some(pm_name) = &pm {
        let _ = Command::new(pm_name)
            .arg("install")
            .current_dir(&dest)
            .status();
        // Verify zod actually landed regardless of pnpm exit code (pnpm exits
        // non-zero for benign warnings like ignored post-install build scripts).
        if dest.join("node_modules/zod/package.json").exists() {
            println!("✓ runtime deps installed via {pm_name}");
        } else {
            println!("⚠ {pm_name} install: zod not present at node_modules/zod — install manually if loading the plugin fails");
        }
    } else {
        println!("⚠ no pnpm/npm found; install deps manually with `cd {} && pnpm install`", dest.display());
    }

    // Merge openclaw.json.
    let token = merge_config(&dest)?;
    println!("✓ updated {} to register the channel", config_path()?.display());

    // Also write the token into M↓'s own settings.json so the host-mode chat
    // client picks it up automatically (no manual copy-paste).
    match write_mdeditor_settings(&token) {
        Ok(path) => println!("✓ token written to M↓ settings: {}", path.display()),
        Err(e) => println!("⚠ could not update M↓ settings: {e} (paste the token in Settings → OpenClaw manually)"),
    }

    println!();
    println!("Restart OpenClaw for the plugin to take effect.");
    println!("In M↓: tray → OpenClaw → status should turn green (connected).");
    Ok(())
}

/// Locate M↓'s settings store on macOS and patch in the access token.
/// Returns the file path on success.
fn write_mdeditor_settings(token: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let path = home
        .join("Library/Application Support/com.laobu.mdeditor/settings.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    }
    let mut d: Value = if path.exists() {
        parse_or_default(&path)?
    } else {
        json!({})
    };
    if let Some(obj) = d.as_object_mut() {
        let plugins = obj.entry("plugins".to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| "plugins must be an object".to_string())?;
        let oc = plugins.entry("openclaw-chat".to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| "openclaw-chat must be an object".to_string())?;
        oc.insert("accessToken".into(), json!(token));
        oc.entry("mode".to_string()).or_insert_with(|| json!("auto"));
    }
    let pretty = serde_json::to_string_pretty(&d).map_err(|e| e.to_string())?;
    fs::write(&path, pretty).map_err(|e| format!("write {path:?}: {e}"))?;
    Ok(path)
}

fn uninstall(keep_files: bool) -> Result<(), String> {
    let cfg_path = config_path()?;
    if cfg_path.exists() {
        let mut cfg: Value = parse_or_default(&cfg_path)?;
        let mut changed = false;
        let install_dir_str = plugin_install_dir()?.to_string_lossy().to_string();
        if let Some(plugins) = cfg.get_mut("plugins").and_then(|v| v.as_object_mut()) {
            if let Some(entries) = plugins.get_mut("entries").and_then(|v| v.as_object_mut()) {
                changed |= entries.remove("mdeditor").is_some();
            }
            if let Some(load) = plugins.get_mut("load").and_then(|v| v.as_object_mut()) {
                if let Some(paths) = load.get_mut("paths").and_then(|v| v.as_array_mut()) {
                    let before = paths.len();
                    paths.retain(|v| v.as_str().map(|s| s != install_dir_str).unwrap_or(true));
                    changed |= paths.len() != before;
                }
            }
        }
        if let Some(channels) = cfg.get_mut("channels").and_then(|v| v.as_object_mut()) {
            changed |= channels.remove("mdeditor").is_some();
        }
        if changed {
            let pretty = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
            fs::write(&cfg_path, pretty).map_err(|e| format!("write {cfg_path:?}: {e}"))?;
            println!("✓ removed mdeditor entries from {}", cfg_path.display());
        } else {
            println!("(no mdeditor entries in {})", cfg_path.display());
        }
    }

    if !keep_files {
        let dest = plugin_install_dir()?;
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| format!("rm {dest:?}: {e}"))?;
            println!("✓ deleted {}", dest.display());
        }
    } else {
        println!("(plugin files kept at {})", plugin_install_dir()?.display());
    }
    Ok(())
}

fn status() -> Result<(), String> {
    let dest = plugin_install_dir()?;
    let cfg_path = config_path()?;
    println!("plugin source : {}", if dest.exists() { format!("✓ {}", dest.display()) } else { "✗ not installed".into() });
    if cfg_path.exists() {
        let cfg: Value = parse_or_default(&cfg_path)?;
        let entry = cfg.pointer("/plugins/entries/mdeditor");
        let channel = cfg.pointer("/channels/mdeditor");
        let token = cfg
            .pointer("/channels/mdeditor/accounts/default/accessToken")
            .and_then(|v| v.as_str());
        println!("openclaw.json : {}", cfg_path.display());
        println!("  plugins.entries.mdeditor   : {}", display_value(entry));
        println!("  channels.mdeditor          : {}", display_value(channel));
        println!(
            "  access token               : {}",
            token.map(|t| format!("✓ {} (paste into M↓ Settings → OpenClaw)", t)).unwrap_or_else(|| "✗ not set".into())
        );
    } else {
        println!("openclaw.json : ✗ {}  (run OpenClaw at least once to create it)", cfg_path.display());
    }
    let sock = openclaw_home()?.join("mdeditor.sock");
    println!("UDS socket    : {}", if sock.exists() { format!("✓ {} (OpenClaw + plugin are running)", sock.display()) } else { format!("✗ {} (OpenClaw not running, or plugin not loaded)", sock.display()) });
    Ok(())
}

fn extract_dir(dir: &Dir<'_>, dest: &Path) -> Result<(), String> {
    for f in dir.files() {
        let rel = f.path();
        let target = dest.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        fs::write(&target, f.contents()).map_err(|e| format!("write {target:?}: {e}"))?;
    }
    for sub in dir.dirs() {
        extract_dir(sub, dest)?;
    }
    Ok(())
}

fn count_files(dir: &Dir<'_>) -> usize {
    dir.files().count() + dir.dirs().map(count_files).sum::<usize>()
}

fn which_pkg_manager() -> Option<&'static str> {
    for pm in ["pnpm", "npm"] {
        if Command::new(pm).arg("--version").output().map(|o| o.status.success()).unwrap_or(false) {
            return Some(pm);
        }
    }
    None
}

fn parse_or_default(p: &Path) -> Result<Value, String> {
    let s = fs::read_to_string(p).map_err(|e| format!("read {p:?}: {e}"))?;
    if s.trim().is_empty() { return Ok(json!({})); }
    serde_json::from_str(&s).map_err(|e| format!("parse {p:?}: {e}"))
}

/// Merge our entries into ~/.openclaw/openclaw.json and return the
/// shared-secret access token (newly generated or pre-existing).
fn merge_config(plugin_dir: &Path) -> Result<String, String> {
    let cfg_path = config_path()?;
    let mut cfg: Value = if cfg_path.exists() {
        parse_or_default(&cfg_path)?
    } else {
        json!({})
    };
    let root = cfg.as_object_mut().ok_or_else(|| "config root must be object".to_string())?;

    let plugins = root
        .entry("plugins")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "plugins must be object".to_string())?;
    // Tell OpenClaw to scan this directory for plugin manifests. This is the
    // canonical localPath install — `plugins.entries.<id>` only accepts
    // `{enabled, config}` per OpenClaw's schema, not `{type, path}`.
    let load = plugins
        .entry("load")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "plugins.load must be object".to_string())?;
    let paths = load
        .entry("paths")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| "plugins.load.paths must be array".to_string())?;
    let plugin_dir_str = plugin_dir.to_string_lossy().to_string();
    let already = paths
        .iter()
        .any(|v| v.as_str().map(|s| s == plugin_dir_str).unwrap_or(false));
    if !already {
        paths.push(json!(plugin_dir_str));
    }
    let entries = plugins
        .entry("entries")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "plugins.entries must be object".to_string())?;
    entries.insert("mdeditor".into(), json!({ "enabled": true }));

    let channels = root
        .entry("channels")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "channels must be object".to_string())?;
    let mdeditor = channels
        .entry("mdeditor")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "channels.mdeditor must be object".to_string())?;
    mdeditor.insert("enabled".into(), json!(true));
    let accounts = mdeditor
        .entry("accounts")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "accounts must be object".to_string())?;
    let default = accounts
        .entry("default")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "accounts.default must be object".to_string())?;
    default.entry("socketPath".to_string())
        .or_insert_with(|| json!("~/.openclaw/mdeditor.sock"));
    // Generate the UDS handshake shared secret if not already present.
    // M↓ host client reads the same token from this file (or user pastes it
    // into M↓ Settings → OpenClaw → Access Token).
    let token_was_new = !default.contains_key("accessToken");
    default
        .entry("accessToken".to_string())
        .or_insert_with(|| json!(generate_access_token()));

    let pretty = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(&cfg_path, pretty).map_err(|e| format!("write {cfg_path:?}: {e}"))?;

    let token = cfg
        .pointer("/channels/mdeditor/accounts/default/accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if token_was_new {
        println!();
        println!("──────────────────────────────────────────────────────────────");
        println!("  Generated access token (also written to both configs):");
        println!("    {}", token);
        println!("──────────────────────────────────────────────────────────────");
    }
    Ok(token)
}

fn display_value(v: Option<&Value>) -> String {
    match v {
        Some(Value::Null) | None => "✗ missing".into(),
        Some(other) => format!("✓ {}", serde_json::to_string(other).unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_settings(dir: &std::path::Path, enabled: bool) {
        let path = dir.join("settings.json");
        let v = serde_json::json!({
            "plugins.enabled": { "openclaw-chat": enabled }
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
    }

    #[test]
    fn returns_disabled_error_when_plugin_off() {
        let tmp = TempDir::new().unwrap();
        make_settings(tmp.path(), false);
        let plugins = TempDir::new().unwrap();
        std::fs::create_dir_all(plugins.path().join("openclaw-chat")).unwrap();
        let m = serde_json::json!({
            "id": "openclaw-chat", "name": "OpenClaw Chat", "version": "0.1.0",
            "kind": "builtin", "host_capabilities": [], "default_enabled": false
        });
        std::fs::write(
            plugins.path().join("openclaw-chat/manifest.json"),
            serde_json::to_vec_pretty(&m).unwrap(),
        ).unwrap();
        assert!(!is_openclaw_chat_active(plugins.path(), tmp.path()));
    }

    #[test]
    fn returns_active_when_enabled_flag_true() {
        let tmp = TempDir::new().unwrap();
        make_settings(tmp.path(), true);
        let plugins = TempDir::new().unwrap();
        std::fs::create_dir_all(plugins.path().join("openclaw-chat")).unwrap();
        let m = serde_json::json!({
            "id": "openclaw-chat", "name": "OpenClaw Chat", "version": "0.1.0",
            "kind": "builtin", "host_capabilities": [], "default_enabled": false
        });
        std::fs::write(
            plugins.path().join("openclaw-chat/manifest.json"),
            serde_json::to_vec_pretty(&m).unwrap(),
        ).unwrap();
        assert!(is_openclaw_chat_active(plugins.path(), tmp.path()));
    }
}
