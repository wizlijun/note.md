//! CLI mode: argv parsing, routing, and execution.
//!
//! Entered from `main.rs` when `argv[0]` basename equals `"notemd"` (or the
//! legacy `"mdedit"`) or argv contains `--cli`. Returns a
//! `std::process::ExitCode` that main propagates.

use std::path::PathBuf;
use std::process::ExitCode;

pub mod args;
pub mod router;
pub mod builtin;
pub mod runner;
pub mod install;
pub mod openclaw;
pub mod state;

use crate::app_dirs::BUNDLE_ID as APP_BUNDLE_ID;

/// Resolve the plugins directory. Tries in order:
/// 1. Explicit `--plugin-dir` override
/// 2. `current_exe()` canonicalized → `../../Resources/plugins`
/// 3. Well-known install paths `/Applications/note.md.app/Contents/Resources/plugins`
///    (falling back to the legacy `/Applications/M↓.app/…` for pre-rename installs)
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
    for well_known in [
        "/Applications/note.md.app/Contents/Resources/plugins",
        // Auto-updated installs keep the pre-rename bundle folder name.
        "/Applications/M\u{2193}.app/Contents/Resources/plugins",
    ] {
        let well_known = PathBuf::from(well_known);
        if well_known.exists() { return well_known; }
    }
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
        // `mdedit` is the pre-rename command name; old symlinks keep working.
        if name == "notemd" || name == "mdedit" { return true; }
    }
    false
}

pub fn run_cli(argv: Vec<String>) -> ExitCode {
    crate::app_dirs::migrate_legacy_app_support();
    let parsed = args::parse(&argv);
    let route = router::resolve(&parsed);
    match route {
        router::Route::Builtin(b) => builtin::run(b, &parsed),
        router::Route::Plugin(p) => runner::run(p, parsed),
        router::Route::Disabled { plugin_id, subcommand } => {
            eprintln!("notemd: command '{subcommand}' is provided by the '{plugin_id}' plugin, which is disabled.");
            eprintln!("Enable it in Preferences → Plugins, or run:");
            eprintln!("  notemd plugin enable {plugin_id}");
            ExitCode::from(3)
        }
        router::Route::Unknown(name) => {
            eprintln!("notemd: unknown command '{name}'. Run 'notemd help' to see available commands.");
            ExitCode::from(127)
        }
    }
}
