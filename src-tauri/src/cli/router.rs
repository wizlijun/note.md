//! Routing: argv → Route. Step order matches spec §3 exactly.

use crate::plugin_host::{scan_disk, PluginManifest};
use super::args::Parsed;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug)]
pub enum Route {
    Builtin(Builtin),
    Plugin(PluginRoute),
    Disabled { plugin_id: String, subcommand: String },
    Unknown(String),
}

#[derive(Debug)]
pub enum Builtin {
    Help { topic: Option<String>, all: bool },
    Version,
    PluginList,
    PluginEnable(String),
    PluginDisable(String),
    PluginInfo(String),
    Openclaw(super::openclaw::OpenclawCmd),
}

#[derive(Debug)]
pub struct PluginRoute {
    pub plugin_id: String,
    pub subcommand: String,
    pub remaining: Vec<String>,
}

/// Resolves against the live filesystem.
pub fn resolve(parsed: &Parsed) -> Route {
    let (manifests, enabled) = current_scan(parsed);
    resolve_with(&parsed.rest, &manifests, &enabled)
}

/// Pure resolver — takes pre-scanned data. Used by tests.
pub fn resolve_with(
    rest: &[String],
    manifests: &[(PluginManifest, PathBuf)],
    enabled: &HashMap<String, bool>,
) -> Route {
    let first = match rest.first() {
        Some(s) => s.clone(),
        None => return Route::Builtin(Builtin::Help { topic: None, all: false }),
    };

    if matches!(first.as_str(), "help" | "-h" | "--help") {
        let mut topic: Option<String> = None;
        let mut all = false;
        for a in rest.iter().skip(1) {
            if a == "--all" { all = true; }
            else if topic.is_none() { topic = Some(a.clone()); }
        }
        return Route::Builtin(Builtin::Help { topic, all });
    }

    if matches!(first.as_str(), "version" | "-v" | "--version") {
        return Route::Builtin(Builtin::Version);
    }

    if first == "plugin" {
        return match rest.get(1).map(|s| s.as_str()) {
            Some("list") => Route::Builtin(Builtin::PluginList),
            Some("enable") => match rest.get(2) {
                Some(id) => Route::Builtin(Builtin::PluginEnable(id.clone())),
                None => Route::Unknown("plugin enable (missing id)".to_string()),
            },
            Some("disable") => match rest.get(2) {
                Some(id) => Route::Builtin(Builtin::PluginDisable(id.clone())),
                None => Route::Unknown("plugin disable (missing id)".to_string()),
            },
            Some("info") => match rest.get(2) {
                Some(id) => Route::Builtin(Builtin::PluginInfo(id.clone())),
                None => Route::Unknown("plugin info (missing id)".to_string()),
            },
            _ => Route::Unknown(format!("plugin {}", rest.get(1).cloned().unwrap_or_default())),
        };
    }

    if first == "openclaw" {
        let force = rest.iter().any(|a| a == "--force" || a == "-f");
        let keep_files = rest.iter().any(|a| a == "--keep-files");
        return match rest.get(1).map(|s| s.as_str()) {
            Some("install") => Route::Builtin(Builtin::Openclaw(super::openclaw::OpenclawCmd::Install { force })),
            Some("uninstall") => Route::Builtin(Builtin::Openclaw(super::openclaw::OpenclawCmd::Uninstall { keep_files })),
            Some("status") | None => Route::Builtin(Builtin::Openclaw(super::openclaw::OpenclawCmd::Status)),
            Some(other) => Route::Unknown(format!("openclaw {}", other)),
        };
    }

    let resolved = match_against_manifests(manifests, &first, enabled);
    match resolved {
        Some((plugin_id, subcommand, is_enabled)) => {
            if is_enabled {
                Route::Plugin(PluginRoute {
                    plugin_id,
                    subcommand,
                    remaining: rest.iter().skip(1).cloned().collect(),
                })
            } else {
                Route::Disabled { plugin_id, subcommand }
            }
        }
        None => Route::Unknown(first),
    }
}

fn match_against_manifests(
    manifests: &[(PluginManifest, PathBuf)],
    token: &str,
    enabled: &HashMap<String, bool>,
) -> Option<(String, String, bool)> {
    for (m, _dir) in manifests {
        for entry in &m.cli {
            if entry.subcommand == token || entry.aliases.iter().any(|a| a == token) {
                let is_enabled = crate::plugin_host::resolve_enabled(m, enabled);
                return Some((m.id.clone(), entry.subcommand.clone(), is_enabled));
            }
        }
    }
    None
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
    use std::path::PathBuf;

    fn manifest_with_cli(id: &str, sub: &str, aliases: &[&str]) -> PluginManifest {
        PluginManifest {
            id: id.to_string(),
            name: id.to_string(),
            version: "0.1.0".to_string(),
            description: None,
            kind: crate::plugin_host::PluginKind::External,
            binary: Some("bin".to_string()),
            default_enabled: None,
            menus: vec![],
            context_menus: vec![],
            settings: None,
            host_capabilities: vec![],
            timeout_seconds: 30,
            cli: vec![CliEntry {
                subcommand: sub.to_string(),
                aliases: aliases.iter().map(|s| s.to_string()).collect(),
                command: "noop".to_string(),
                summary: "s".to_string(),
                args: vec![],
                flags: vec![],
                requires_tab_context: false,
            }],
        }
    }

    fn route_with(
        rest: &[&str],
        manifests: Vec<(PluginManifest, PathBuf)>,
        enabled: std::collections::HashMap<String, bool>,
    ) -> Route {
        resolve_with(
            &rest.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &manifests,
            &enabled,
        )
    }

    #[test] fn no_args_is_help() {
        let r = route_with(&[], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::Help { .. })));
    }
    #[test] fn help_subcommand_routes_to_help() {
        let r = route_with(&["help"], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::Help { topic: None, all: false })));
    }
    #[test] fn help_with_topic_carries_topic() {
        let r = route_with(&["help", "share"], vec![], Default::default());
        let Route::Builtin(Builtin::Help { topic, all }) = r else { panic!() };
        assert_eq!(topic.as_deref(), Some("share"));
        assert!(!all);
    }
    #[test] fn dash_h_routes_to_help() {
        let r = route_with(&["-h"], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::Help { .. })));
    }
    #[test] fn version_routes() {
        let r = route_with(&["version"], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::Version)));
    }
    #[test] fn plugin_list_routes() {
        let r = route_with(&["plugin", "list"], vec![], Default::default());
        assert!(matches!(r, Route::Builtin(Builtin::PluginList)));
    }
    #[test] fn plugin_enable_with_id_routes() {
        let r = route_with(&["plugin", "enable", "share"], vec![], Default::default());
        let Route::Builtin(Builtin::PluginEnable(id)) = r else { panic!() };
        assert_eq!(id, "share");
    }
    #[test] fn enabled_plugin_subcommand_routes_to_plugin() {
        let m = manifest_with_cli("share", "share", &["-s"]);
        let mut enabled = std::collections::HashMap::new();
        enabled.insert("share".to_string(), true);
        let r = route_with(&["share", "draft.md"], vec![(m, PathBuf::from("/tmp"))], enabled);
        let Route::Plugin(p) = r else { panic!() };
        assert_eq!(p.plugin_id, "share");
        assert_eq!(p.subcommand, "share");
        assert_eq!(p.remaining, vec!["draft.md".to_string()]);
    }
    #[test] fn enabled_plugin_alias_resolves_to_subcommand() {
        let m = manifest_with_cli("share", "share", &["-s"]);
        let mut enabled = std::collections::HashMap::new();
        enabled.insert("share".to_string(), true);
        let r = route_with(&["-s", "draft.md"], vec![(m, PathBuf::from("/tmp"))], enabled);
        let Route::Plugin(p) = r else { panic!() };
        assert_eq!(p.subcommand, "share");
        assert_eq!(p.remaining, vec!["draft.md".to_string()]);
    }
    #[test] fn disabled_plugin_yields_disabled_route() {
        let m = manifest_with_cli("share", "share", &["-s"]);
        let mut enabled = std::collections::HashMap::new();
        enabled.insert("share".to_string(), false);
        let r = route_with(&["-s", "x.md"], vec![(m, PathBuf::from("/tmp"))], enabled);
        let Route::Disabled { plugin_id, subcommand } = r else { panic!() };
        assert_eq!(plugin_id, "share");
        assert_eq!(subcommand, "share");
    }
    #[test] fn unknown_command_yields_unknown() {
        let r = route_with(&["nope"], vec![], Default::default());
        let Route::Unknown(name) = r else { panic!() };
        assert_eq!(name, "nope");
    }
}
