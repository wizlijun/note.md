mod plugin;

fn print_line(value: impl std::fmt::Display) {
    use std::io::Write;
    // Piping to `head` or a consumer that exits early must preserve our status.
    let _ = writeln!(std::io::stdout().lock(), "{value}");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        if args == ["--help"] || args == ["-h"] || args == ["sync", "--help"] {
            print_line(notemd_apple_notes::cli::USAGE);
            return;
        }
        let parsed = match notemd_apple_notes::cli::parse(&args) {
            Ok(args) => args,
            Err(error) => {
                print_line(serde_json::json!({"ok": false, "error": error}));
                std::process::exit(2);
            }
        };
        match notemd_apple_notes::sync::sync_recorded(&parsed.vault, parsed.dry_run) {
            Ok(report) => {
                print_line(serde_json::json!({"ok": report.complete, "report": report}));
                if !report.complete {
                    std::process::exit(4);
                }
            }
            Err(error) => {
                print_line(serde_json::json!({"ok": false, "error": error}));
                std::process::exit(1);
            }
        }
        return;
    }
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(notemd_plugin_sdk::serve(plugin::AppleNotesPlugin::new()));
}
