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
    scan_disk(&plugins_dir, &config_dir)
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
