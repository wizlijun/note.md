//! Plugin-subcommand path: build CliPayload, launch headless Tauri, wait
//! for cli_finish from the frontend, exit.

use crate::cli::args::Parsed;
use crate::cli::router::PluginRoute;
use crate::cli::state::{CliPayload, CliState, GlobalFlags};
use crate::plugin_host::{scan_disk, PluginManifest};
use std::path::PathBuf;
use std::process::ExitCode;
use tokio::sync::oneshot;

pub fn run(p: PluginRoute, parsed: Parsed) -> ExitCode {
    let (manifests, _enabled) = current_scan(&parsed);
    let manifest = match manifests.iter().find(|(m, _)| m.id == p.plugin_id) {
        Some((m, _)) => m.clone(),
        None => {
            eprintln!(
                "notemd: internal: plugin '{}' vanished between routing and execution",
                p.plugin_id
            );
            return ExitCode::from(1);
        }
    };
    let cli_entry = match manifest.cli.iter().find(|c| c.subcommand == p.subcommand) {
        Some(e) => e.clone(),
        None => {
            eprintln!(
                "notemd: internal: subcommand '{}' missing in '{}'",
                p.subcommand, p.plugin_id
            );
            return ExitCode::from(1);
        }
    };

    // Parse remaining argv against the cli entry's spec.
    let (file, flags) = match parse_subcommand_args(&p.remaining, &cli_entry) {
        Ok(v) => v,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };

    // Resolve file to absolute, verify it exists.
    let absfile = if let Some(f) = file {
        match std::path::Path::new(&f).canonicalize() {
            Ok(p) => Some(p.to_string_lossy().into_owned()),
            Err(_) => {
                eprintln!("notemd: cannot read '{f}': No such file or directory");
                return ExitCode::from(2);
            }
        }
    } else {
        None
    };

    // Decide plugin_command via flags (--unshare/--copy-link/--update).
    let plugin_command = match decide_plugin_command(&flags, &cli_entry.command) {
        Ok(s) => s,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };

    let payload = CliPayload {
        subcommand: p.subcommand.clone(),
        plugin_id: p.plugin_id.clone(),
        plugin_command,
        file: absfile,
        flags,
        global: GlobalFlags {
            json: parsed.globals.json,
            quiet: parsed.globals.quiet,
            clipboard: parsed.globals.clipboard,
            yes: parsed.globals.yes,
        },
    };
    let (tx, rx) = oneshot::channel();
    let state = CliState::new(payload, tx);

    let exit_code = launch_tauri_headless(state, rx);
    ExitCode::from(exit_code as u8)
}

fn current_scan(
    parsed: &Parsed,
) -> (
    Vec<(PluginManifest, PathBuf)>,
    std::collections::HashMap<String, bool>,
) {
    let plugins_dir = super::resolve_plugins_dir(parsed.globals.plugin_dir_override.as_deref());
    let config_dir = super::resolve_config_dir();
    let (mut manifests, mut enabled) = scan_disk(&plugins_dir, &config_dir);
    append_core_cli_stubs(&mut manifests, &mut enabled);
    (manifests, enabled)
}

/// Core-ized 功能的 CLI stub：share 与 reading-insights 的子命令属于核心，
/// 不再有磁盘 manifest；注入扫描结果供 router/runner 统一匹配。
pub fn core_cli_stub_manifests() -> Vec<PluginManifest> {
    let share = serde_json::from_value(serde_json::json!({
        "id": "share", "name": "Share", "version": "core", "binary": "",
        "host_capabilities": ["renderer.html", "settings.read", "settings.write:share.records", "clipboard.write", "toast", "dialog"],
        "cli": [{
            "subcommand": "share", "aliases": ["--share"], "command": "publish",
            "summary": "Render and publish file as a shareable URL",
            "args": [{ "name": "file", "type": "path", "required": true, "help": "Markdown or image file to share" }],
            "flags": [
                { "long": "--update", "type": "boolean", "help": "Force update existing share (default if already shared)" },
                { "long": "--copy-link", "type": "boolean", "help": "Print previously-shared URL instead of re-publishing" },
                { "long": "--unshare", "type": "boolean", "help": "Remove share for this file" }
            ],
            "requires_tab_context": true
        }]
    })).expect("share cli stub");
    let insights = serde_json::from_value(serde_json::json!({
        "id": "reading-insights", "name": "Reading Insights", "version": "core", "binary": "",
        "host_capabilities": [],
        "cli": [{
            "subcommand": "report", "command": "report",
            "summary": "Generate a reading engagement report (owner + online audience) from the Vault",
            "args": [],
            "flags": [
                { "long": "--vault", "type": "string", "help": "Vault root (defaults to the configured Vault)" },
                { "long": "--date", "type": "string", "help": "today | yesterday (default) | 7d | 30d | month" },
                { "long": "--from", "type": "string", "help": "YYYY-MM-DD (with --to, overrides --date)" },
                { "long": "--to", "type": "string", "help": "YYYY-MM-DD" },
                { "long": "--stdout", "type": "boolean", "help": "Print to stdout instead of writing <vault>/stat/*.md" }
            ]
        }]
    })).expect("insights cli stub");
    vec![share, insights]
}

/// True when this manifest is one of the injected core CLI stubs (see
/// [`core_cli_stub_manifests`]) rather than a real on-disk plugin. Stubs are
/// distinguishable by their sentinel shape: version "core" + empty binary.
/// builtin.rs uses this to keep core commands out of the PLUGIN COMMANDS help
/// section even if stubs are ever passed to the renderers.
pub fn is_core_cli_stub(m: &PluginManifest) -> bool {
    m.version == "core" && m.binary.as_deref() == Some("")
}

/// 把 core stub 追加进扫描结果。磁盘上已有同 id manifest（T7 删除前的过渡期）
/// 则不追加，保持原插件行为；追加时强制 enabled=true —— core 命令不受
/// plugins.enabled 遗留配置影响。
pub(crate) fn append_core_cli_stubs(
    manifests: &mut Vec<(PluginManifest, PathBuf)>,
    enabled: &mut std::collections::HashMap<String, bool>,
) {
    for stub in core_cli_stub_manifests() {
        if manifests.iter().any(|(m, _)| m.id == stub.id) {
            continue;
        }
        enabled.insert(stub.id.clone(), true);
        manifests.push((stub, PathBuf::new()));
    }
}

fn parse_subcommand_args(
    remaining: &[String],
    entry: &crate::plugin_host::CliEntry,
) -> Result<(Option<String>, serde_json::Map<String, serde_json::Value>), String> {
    let mut flags = serde_json::Map::new();
    let mut file: Option<String> = None;
    let mut i = 0;
    while i < remaining.len() {
        let tok = &remaining[i];
        if let Some(flag) = entry
            .flags
            .iter()
            .find(|f| f.long == *tok || f.short.as_deref() == Some(tok.as_str()))
        {
            match flag.ty.as_str() {
                "boolean" => {
                    flags.insert(
                        flag.long.trim_start_matches('-').to_string(),
                        serde_json::Value::Bool(true),
                    );
                }
                "string" => {
                    if i + 1 >= remaining.len() {
                        return Err(format!("notemd: flag {} requires a value", flag.long));
                    }
                    flags.insert(
                        flag.long.trim_start_matches('-').to_string(),
                        serde_json::Value::String(remaining[i + 1].clone()),
                    );
                    i += 1;
                }
                _ => return Err(format!("notemd: internal: unknown flag type '{}'", flag.ty)),
            }
        } else if tok.starts_with('-') {
            return Err(format!("notemd: unknown flag '{tok}'"));
        } else if file.is_none() && !entry.args.is_empty() {
            file = Some(tok.clone());
        } else {
            return Err(format!("notemd: unexpected argument '{tok}'"));
        }
        i += 1;
    }
    if let Some(first_required) = entry.args.iter().find(|a| a.required) {
        if file.is_none() {
            return Err(format!(
                "notemd: missing required argument '<{}>'",
                first_required.name
            ));
        }
    }
    Ok((file, flags))
}

/// Mutually-exclusive flag fan-out: --update, --copy-link, --unshare map to
/// the right plugin command. Default is the manifest entry's declared command.
fn decide_plugin_command(
    flags: &serde_json::Map<String, serde_json::Value>,
    default_cmd: &str,
) -> Result<String, String> {
    let truthy = |k: &str| flags.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    let exclusive: Vec<&str> = ["update", "copy-link", "unshare"]
        .into_iter()
        .filter(|k| truthy(k))
        .collect();
    if exclusive.len() > 1 {
        return Err(format!(
            "notemd: flags --{} are mutually exclusive",
            exclusive.join(" --")
        ));
    }
    Ok(if truthy("unshare") {
        "unpublish".to_string()
    } else if truthy("copy-link") {
        "copy-link".to_string()
    } else {
        default_cmd.to_string()
    })
}

fn launch_tauri_headless(
    state: CliState,
    rx: oneshot::Receiver<crate::cli::state::CliResult>,
) -> i32 {
    let result_arc = std::sync::Arc::new(std::sync::Mutex::new(None::<i32>));
    let result_arc_clone = result_arc.clone();

    let init_script = "window.__M_CLI_MODE__ = true;";

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            crate::cli::state::cli_payload,
            crate::cli::state::cli_finish,
            crate::plugin_host::get_plugin_manifests,
            crate::plugin_host::invoke_plugin,
            crate::themes::commands::theme_load_compiled,
            // sotvault: needed by `notemd share` — refreshSotvault + prepareShareSrc
            // resolve the vault root, and an outside-vault file is homed in first
            // via sotvault_sync_to_vault. resolve_vault_root falls back to the
            // shared config, so no VaultSyncManager needs to be managed here.
            crate::sotvault::sotvault_vault_root,
            crate::sotvault::sotvault_vault_debug,
            crate::sotvault::sotvault_records,
            crate::sotvault::sotvault_sync_to_vault,
        ])
        .setup(move |app| {
            crate::plugin_host::init(&app.handle());
            let _ = tauri::WebviewWindowBuilder::new(
                app,
                "cli",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .visible(false)
            .skip_taskbar(true)
            .initialization_script(init_script)
            .build()?;
            Ok(())
        })
        .manage(state)
        .build(crate::tauri_context())
        .expect("tauri build failed in cli mode");

    tauri::async_runtime::spawn(async move {
        if let Ok(res) = rx.await {
            *result_arc_clone.lock().unwrap() = Some(res.exit_code);
        }
    });

    app.run(|_app, _event| {});

    let code = result_arc.lock().unwrap().unwrap_or(1);
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_host::{CliArg, CliEntry, CliFlag};

    fn entry_with_file_and_flags() -> CliEntry {
        CliEntry {
            subcommand: "share".to_string(),
            aliases: vec![],
            command: "publish".to_string(),
            summary: "s".to_string(),
            args: vec![CliArg {
                name: "file".to_string(),
                ty: "path".to_string(),
                required: true,
                help: None,
            }],
            flags: vec![
                CliFlag {
                    long: "--update".to_string(),
                    short: None,
                    ty: "boolean".to_string(),
                    help: None,
                },
                CliFlag {
                    long: "--copy-link".to_string(),
                    short: None,
                    ty: "boolean".to_string(),
                    help: None,
                },
                CliFlag {
                    long: "--unshare".to_string(),
                    short: None,
                    ty: "boolean".to_string(),
                    help: None,
                },
            ],
            requires_tab_context: true,
        }
    }

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_just_file_succeeds() {
        let (file, flags) =
            parse_subcommand_args(&s(&["draft.md"]), &entry_with_file_and_flags()).unwrap();
        assert_eq!(file.as_deref(), Some("draft.md"));
        assert!(flags.is_empty());
    }
    #[test]
    fn parse_file_with_flag() {
        let (file, flags) =
            parse_subcommand_args(&s(&["draft.md", "--update"]), &entry_with_file_and_flags())
                .unwrap();
        assert_eq!(file.as_deref(), Some("draft.md"));
        assert_eq!(flags.get("update").and_then(|v| v.as_bool()), Some(true));
    }
    #[test]
    fn parse_missing_required_arg() {
        let r = parse_subcommand_args(&s(&[]), &entry_with_file_and_flags());
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("missing required"));
    }
    #[test]
    fn parse_unknown_flag() {
        let r = parse_subcommand_args(&s(&["draft.md", "--bogus"]), &entry_with_file_and_flags());
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("unknown flag"));
    }

    #[test]
    fn decide_default_command() {
        let r = decide_plugin_command(&serde_json::Map::new(), "publish").unwrap();
        assert_eq!(r, "publish");
    }
    #[test]
    fn decide_unshare_maps_to_unpublish() {
        let mut f = serde_json::Map::new();
        f.insert("unshare".to_string(), serde_json::Value::Bool(true));
        assert_eq!(decide_plugin_command(&f, "publish").unwrap(), "unpublish");
    }
    #[test]
    fn decide_copy_link_maps_to_copy_link() {
        let mut f = serde_json::Map::new();
        f.insert("copy-link".to_string(), serde_json::Value::Bool(true));
        assert_eq!(decide_plugin_command(&f, "publish").unwrap(), "copy-link");
    }
    #[test]
    fn decide_mutually_exclusive() {
        let mut f = serde_json::Map::new();
        f.insert("update".to_string(), serde_json::Value::Bool(true));
        f.insert("unshare".to_string(), serde_json::Value::Bool(true));
        let r = decide_plugin_command(&f, "publish");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("mutually exclusive"));
    }
}
