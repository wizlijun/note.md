#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    #[cfg(not(target_os = "ios"))]
    {
        let argv: Vec<String> = std::env::args().collect();
        if mdeditor_lib::cli::is_cli_mode(&argv) {
            return mdeditor_lib::cli::run_cli(argv);
        }
    }
    mdeditor_lib::run();
    ExitCode::from(0)
}
