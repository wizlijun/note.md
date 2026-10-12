mod bridge;
mod cli;
mod plugin;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--queue-runner") {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        if rt.block_on(cli::run(&args)).is_err() {
            std::process::exit(1);
        }
        return;
    }
    if !args.is_empty() {
        if let Err(error) = local_command(&args) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(notemd_plugin_sdk::serve(plugin::AgencyPlugin::new()));
}

// Read-only diagnostic used for source audits and installation verification.
fn local_command(args: &[String]) -> Result<(), String> {
    if args.len() != 3 || !matches!(args[0].as_str(), "scan" | "snapshot") {
        return Err("usage: notemd-agency scan|snapshot <vault> <YYYY-MM-DD>".into());
    }
    let root = std::path::Path::new(&args[1]);
    let value = if args[0] == "scan" {
        serde_json::to_value(notemd_agency::core::scan(root, &args[2])?)
    } else {
        serde_json::to_value(notemd_agency::core::load(root, &args[2])?)
    }
    .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&plugin::without_source_text(value))
            .map_err(|e| e.to_string())?
    );
    Ok(())
}
