//! Built-in subcommands: help, version, plugin {list,enable,disable,info}.
//!
//! These run entirely in Rust without spinning up a Tauri webview.

use crate::plugin_host::{scan_disk, write_enabled_flag, PluginManifest};
use super::args::Parsed;
use super::router::Builtin;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;

const PLUGIN_API_VERSION: &str = "v1";

pub fn run(b: Builtin, parsed: &Parsed) -> ExitCode {
    let (manifests, enabled) = current_scan(parsed);
    let manifests_only: Vec<PluginManifest> =
        manifests.into_iter().map(|(m, _)| m).collect();
    match b {
        Builtin::Help { topic, all } => {
            println!("{}", render_help(topic.as_deref(), all, &manifests_only, &enabled));
            ExitCode::from(0)
        }
        Builtin::Version => {
            println!("{}", render_version(parsed.globals.json));
            ExitCode::from(0)
        }
        Builtin::PluginList => {
            println!("{}", render_plugin_list(parsed.globals.json, &manifests_only, &enabled));
            ExitCode::from(0)
        }
        Builtin::Openclaw(cmd) => super::openclaw::run(cmd),
        Builtin::PluginEnable(id) => {
            if !manifests_only.iter().any(|m| m.id == id) {
                eprintln!("mdedit: unknown plugin id '{id}'");
                return ExitCode::from(2);
            }
            let cfg = super::resolve_config_dir();
            match write_enabled_flag(&cfg, &id, true) {
                Ok(()) => {
                    if !parsed.globals.quiet {
                        eprintln!("✓ plugin '{id}' enabled");
                    }
                    ExitCode::from(0)
                }
                Err(e) => {
                    eprintln!("mdedit: failed to enable plugin: {e}");
                    ExitCode::from(1)
                }
            }
        }
        Builtin::PluginDisable(id) => {
            if !manifests_only.iter().any(|m| m.id == id) {
                eprintln!("mdedit: unknown plugin id '{id}'");
                return ExitCode::from(2);
            }
            let cfg = super::resolve_config_dir();
            match write_enabled_flag(&cfg, &id, false) {
                Ok(()) => {
                    if !parsed.globals.quiet {
                        eprintln!("✓ plugin '{id}' disabled");
                    }
                    ExitCode::from(0)
                }
                Err(e) => {
                    eprintln!("mdedit: failed to disable plugin: {e}");
                    ExitCode::from(1)
                }
            }
        }
        Builtin::PluginInfo(id) => {
            let m = match manifests_only.iter().find(|m| m.id == id) {
                Some(m) => m,
                None => {
                    eprintln!("mdedit: unknown plugin id '{id}'");
                    return ExitCode::from(2);
                }
            };
            println!("{}", render_plugin_info(m, &enabled));
            ExitCode::from(0)
        }
    }
}

pub fn render_version(as_json: bool) -> String {
    let version = env!("CARGO_PKG_VERSION");
    if as_json {
        json!({
            "ok": true,
            "data": { "version": version, "plugin_api": PLUGIN_API_VERSION }
        }).to_string()
    } else {
        format!("mdedit {version} (plugin API {PLUGIN_API_VERSION})")
    }
}

pub fn render_help(
    topic: Option<&str>,
    all: bool,
    manifests: &[PluginManifest],
    enabled: &HashMap<String, bool>,
) -> String {
    if let Some(t) = topic {
        return render_help_topic(t, manifests, enabled);
    }
    let version = env!("CARGO_PKG_VERSION");
    let mut out = String::new();
    out.push_str("mdedit — M↓ command-line interface\n");
    out.push_str(&format!("Version: {version} (plugin API {PLUGIN_API_VERSION})\n\n"));
    out.push_str("USAGE:\n");
    out.push_str("  mdedit <command> [args...]\n");
    for m in manifests {
        let is_on = enabled.get(&m.id).copied().unwrap_or(true);
        if !is_on { continue }
        for entry in &m.cli {
            if let Some(short) = entry.aliases.iter().find(|a| a.starts_with('-') && a.len() == 2) {
                out.push_str(&format!(
                    "  mdedit {short} <file>                  (alias for: mdedit {} <file>)\n",
                    entry.subcommand,
                ));
            }
        }
    }
    out.push_str("\nCORE COMMANDS:\n");
    out.push_str("  help          Show this help\n");
    out.push_str("  version       Print version\n");
    out.push_str("  plugin        Manage plugins (list, enable, disable, info)\n");
    out.push_str("  openclaw      Install the M\u{2193} chat plugin into OpenClaw (install, uninstall, status)\n");

    let mut shown_header = false;
    for m in manifests {
        let is_on = enabled.get(&m.id).copied().unwrap_or(true);
        if !is_on { continue }
        for entry in &m.cli {
            if !shown_header {
                out.push_str("\nPLUGIN COMMANDS:\n");
                shown_header = true;
            }
            out.push_str(&format!(
                "  {:<13} {:<60} [{}]\n",
                entry.subcommand, entry.summary, m.name,
            ));
        }
    }

    if all {
        let mut shown = false;
        for m in manifests {
            let is_on = enabled.get(&m.id).copied().unwrap_or(true);
            if is_on { continue }
            for entry in &m.cli {
                if !shown {
                    out.push_str("\nDISABLED COMMANDS:\n");
                    shown = true;
                }
                out.push_str(&format!(
                    "  {:<13} (provided by '{}' plugin — disabled)\n                Enable: mdedit plugin enable {}\n",
                    entry.subcommand, m.name, m.id,
                ));
            }
        }
    }

    out.push_str("\nRun 'mdedit help <command>' for details on a specific command.\n");
    out.push_str("Run 'mdedit help --all' to see disabled / unavailable commands too.\n");
    out
}

fn render_help_topic(
    topic: &str,
    manifests: &[PluginManifest],
    enabled: &HashMap<String, bool>,
) -> String {
    for m in manifests {
        for entry in &m.cli {
            if entry.subcommand == topic || entry.aliases.iter().any(|a| a == topic) {
                let on = enabled.get(&m.id).copied().unwrap_or(true);
                let mut out = String::new();
                out.push_str(&format!(
                    "mdedit {} — {}\n",
                    entry.subcommand, entry.summary,
                ));
                out.push_str(&format!("Provided by: {} plugin (v{})", m.name, m.version));
                if !on { out.push_str(" [DISABLED]"); }
                out.push('\n');
                out.push_str("\nUSAGE:\n");
                let args_sig = entry.args.iter()
                    .map(|a| if a.required { format!("<{}>", a.name) } else { format!("[{}]", a.name) })
                    .collect::<Vec<_>>().join(" ");
                out.push_str(&format!("  mdedit {} {}\n", entry.subcommand, args_sig));
                for a in &entry.aliases {
                    out.push_str(&format!("  mdedit {} {}                  (alias)\n", a, args_sig));
                }
                if !entry.args.is_empty() {
                    out.push_str("\nARGUMENTS:\n");
                    for a in &entry.args {
                        out.push_str(&format!("  <{:<8}> {}\n",
                            a.name, a.help.as_deref().unwrap_or("")));
                    }
                }
                if !entry.flags.is_empty() {
                    out.push_str("\nFLAGS:\n");
                    for f in &entry.flags {
                        let flag = match &f.short {
                            Some(s) => format!("{}, {}", s, f.long),
                            None => f.long.clone(),
                        };
                        out.push_str(&format!("  {:<25} {}\n",
                            flag, f.help.as_deref().unwrap_or("")));
                    }
                }
                out.push_str("\nEXIT CODES:\n");
                out.push_str("  0    Success\n");
                out.push_str("  2    File or argument error\n");
                out.push_str("  3    Plugin disabled\n");
                out.push_str("  4    Network or server error\n");
                return out;
            }
        }
    }
    format!("mdedit: unknown topic '{topic}'. Run 'mdedit help' to see commands.\n")
}

pub fn render_plugin_list(
    as_json: bool,
    manifests: &[PluginManifest],
    enabled: &HashMap<String, bool>,
) -> String {
    if as_json {
        let arr: Vec<_> = manifests.iter().map(|m| {
            let is_on = enabled.get(&m.id).copied().unwrap_or(true);
            json!({
                "id": m.id,
                "name": m.name,
                "version": m.version,
                "status": if is_on { "enabled" } else { "disabled" },
                "cli": m.cli.iter().map(|c| json!({
                    "subcommand": c.subcommand,
                    "aliases": c.aliases,
                    "summary": c.summary,
                })).collect::<Vec<_>>(),
            })
        }).collect();
        return json!({ "ok": true, "data": arr }).to_string();
    }
    let mut out = String::new();
    out.push_str(&format!("{:<10} {:<12} {:<8} {:<10} {}\n",
        "ID", "NAME", "VERSION", "STATUS", "CLI"));
    for m in manifests {
        let is_on = enabled.get(&m.id).copied().unwrap_or(true);
        let cli = m.cli.iter().map(|c| {
            let aliases = if c.aliases.is_empty() {
                String::new()
            } else {
                format!(" ({})", c.aliases.join(", "))
            };
            format!("{}{aliases}", c.subcommand)
        }).collect::<Vec<_>>().join(", ");
        out.push_str(&format!("{:<10} {:<12} {:<8} {:<10} {}\n",
            m.id, m.name, m.version,
            if is_on { "enabled" } else { "disabled" },
            cli,
        ));
    }
    out
}

pub fn render_plugin_info(
    m: &PluginManifest,
    enabled: &HashMap<String, bool>,
) -> String {
    let is_on = enabled.get(&m.id).copied().unwrap_or(true);
    let mut out = String::new();
    out.push_str(&format!("{} ({})  v{}\n", m.name, m.id, m.version));
    out.push_str(&format!("Status: {}\n", if is_on { "enabled" } else { "disabled" }));
    if let Some(d) = &m.description {
        out.push_str(&format!("Description: {d}\n"));
    }
    if !m.cli.is_empty() {
        out.push_str("\nCLI commands:\n");
        for c in &m.cli {
            out.push_str(&format!("  - {}: {}\n", c.subcommand, c.summary));
            for a in &c.aliases {
                out.push_str(&format!("    alias: {a}\n"));
            }
        }
    }
    if !m.menus.is_empty() {
        out.push_str("\nMenu items:\n");
        for me in &m.menus {
            out.push_str(&format!("  - [{}] {} ({})\n", me.location, me.label, me.command));
        }
    }
    out
}

fn current_scan(parsed: &Parsed) -> (Vec<(PluginManifest, PathBuf)>, HashMap<String, bool>) {
    let plugins_dir = super::resolve_plugins_dir(parsed.globals.plugin_dir_override.as_deref());
    let config_dir = super::resolve_config_dir();
    scan_disk(&plugins_dir, &config_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_host::{PluginManifest, CliEntry};
    use std::collections::HashMap;

    fn share_manifest() -> PluginManifest {
        PluginManifest {
            id: "share".to_string(),
            name: "Share".to_string(),
            version: "0.1.0".to_string(),
            description: Some("Publish current file as a shareable web page".to_string()),
            binary: "bin".to_string(),
            menus: vec![],
            context_menus: vec![],
            settings: None,
            host_capabilities: vec![],
            timeout_seconds: 30,
            cli: vec![CliEntry {
                subcommand: "share".to_string(),
                aliases: vec!["--share".to_string()],
                command: "publish".to_string(),
                summary: "Render and publish file as a shareable URL".to_string(),
                args: vec![],
                flags: vec![],
                requires_tab_context: true,
            }],
        }
    }

    #[test] fn help_includes_share_when_enabled() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), true);
        let out = render_help(None, false, &[share_manifest()], &enabled);
        assert!(out.contains("PLUGIN COMMANDS:"));
        assert!(out.contains("share"));
        assert!(out.contains("[Share]"));
        assert!(out.contains("Render and publish"));
    }
    #[test] fn help_all_includes_disabled_section() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), false);
        let out = render_help(None, true, &[share_manifest()], &enabled);
        assert!(out.contains("DISABLED COMMANDS:"));
        assert!(out.contains("mdedit plugin enable share"));
    }
    #[test] fn help_topic_shows_per_subcommand_detail() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), true);
        let out = render_help(Some("share"), false, &[share_manifest()], &enabled);
        assert!(out.contains("mdedit share"));
        assert!(out.contains("Render and publish"));
        assert!(out.contains("EXIT CODES:"));
    }
    #[test] fn version_string_includes_plugin_api() {
        let v = render_version(false);
        assert!(v.contains("mdedit"));
        assert!(v.contains("plugin API v1"));
    }
    #[test] fn version_json_is_parsable() {
        let v = render_version(true);
        let _: serde_json::Value = serde_json::from_str(&v).expect("valid JSON");
    }
    #[test] fn plugin_list_rows_enabled_and_disabled() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), false);
        let out = render_plugin_list(false, &[share_manifest()], &enabled);
        assert!(out.contains("share"));
        assert!(out.contains("disabled"));
    }
    #[test] fn plugin_list_json_array() {
        let mut enabled = HashMap::new();
        enabled.insert("share".to_string(), true);
        let out = render_plugin_list(true, &[share_manifest()], &enabled);
        let v: serde_json::Value = serde_json::from_str(&out).expect("valid JSON");
        let arr = v["data"].as_array().expect("data is array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["status"], "enabled");
    }
}
