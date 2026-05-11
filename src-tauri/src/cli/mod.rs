//! CLI mode: argv parsing, routing, and execution.
//!
//! Entered from `main.rs` when `argv[0]` basename equals `"mdedit"` or argv
//! contains `--cli`. Returns a `std::process::ExitCode` that main propagates.

use std::process::ExitCode;

pub mod args;
pub mod router;
pub mod builtin;
pub mod runner;
pub mod install;
pub mod state;

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
