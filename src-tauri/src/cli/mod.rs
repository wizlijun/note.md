//! CLI mode: argv parsing, routing, and execution.
//!
//! Entered from `main.rs` when `argv[0]` basename equals `"mdedit"` or argv
//! contains `--cli`. Returns a `std::process::ExitCode` that main propagates.

use std::path::PathBuf;
use std::process::ExitCode;

pub mod args;
pub mod router;
pub mod builtin;
pub mod runner;
pub mod install;
pub mod openclaw;
pub mod state;

const APP_BUNDLE_ID: &str = "com.laobu.mdeditor";

/// Resolve the plugins directory. Tries in order:
/// 1. Explicit `--plugin-dir` override
/// 2. `current_exe()` canonicalized → `../../Resources/plugins`
/// 3. Well-known install path `/Applications/M↓.app/Contents/Resources/plugins`
/// 4. Compile-time `CARGO_MANIFEST_DIR/plugins` (dev only)
pub fn resolve_plugins_dir(override_dir: Option<&str>) -> PathBuf {
    if let Some(p) = override_dir {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        let exe = exe.canonicalize().unwrap_or(exe);
        if let Some(macos_dir) = exe.parent() {
            if let Some(contents) = macos_dir.parent() {
                let candidate = contents.join("Resources").join("plugins");
                if candidate.exists() { return candidate; }
            }
        }
    }
    let well_known = PathBuf::from("/Applications/M\u{2193}.app/Contents/Resources/plugins");
    if well_known.exists() { return well_known; }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("plugins")
}

/// Resolve the app config directory (where settings.json lives).
pub fn resolve_config_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        return std::path::Path::new(&home)
            .join("Library").join("Application Support").join(APP_BUNDLE_ID);
    }
    PathBuf::from(".")
}

/// Detect whether the current process should run in CLI mode.
pub fn is_cli_mode(argv: &[String]) -> bool {
    if argv.iter().any(|a| a == "--cli") { return true; }
    if let Some(arg0) = argv.first() {
        let name = std::path::Path::new(arg0)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if name == "mdedit" { return true; }
    }
    false
}

pub fn run_cli(argv: Vec<String>) -> ExitCode {
    let parsed = args::parse(&argv);
    let route = router::resolve(&parsed);
    match route {
        router::Route::Builtin(b) => builtin::run(b, &parsed),
        router::Route::Plugin(p) => runner::run(p, parsed),
        router::Route::Disabled { plugin_id, subcommand } => {
            eprintln!("mdedit: command '{subcommand}' is provided by the '{plugin_id}' plugin, which is disabled.");
            eprintln!("Enable it in Preferences → Plugins, or run:");
            eprintln!("  mdedit plugin enable {plugin_id}");
            ExitCode::from(3)
        }
        router::Route::Unknown(name) => {
            eprintln!("mdedit: unknown command '{name}'. Run 'mdedit help' to see available commands.");
            ExitCode::from(127)
        }
    }
}
