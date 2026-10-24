use notemd_health_sync::{cli, plugin::HealthPlugin};
use serde_json::json;
fn output(value: impl std::fmt::Display) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout().lock(), "{value}");
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        if args.iter().any(|v| v == "--help" || v == "-h") {
            output(cli::USAGE);
            return;
        }
        let (command, mut params) = match cli::parse(&args) {
            Ok(v) => v,
            Err(e) => {
                output(json!({"ok":false,"error":e}));
                std::process::exit(2);
            }
        };
        if command == "connect" && params["credentials_stdin"] == true {
            use std::io::Read;
            let loaded = (|| -> Result<(), String> {
                let mut text = String::new();
                std::io::stdin()
                    .take(65537)
                    .read_to_string(&mut text)
                    .map_err(|_| "Cannot read credentials from stdin")?;
                if text.len() > 65536 {
                    return Err("Credentials input is too large".into());
                }
                let mut value: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|_| "Credentials stdin must be a JSON object")?;
                text.clear();
                let object = value
                    .as_object_mut()
                    .ok_or("Credentials stdin must be a JSON object")?;
                for key in ["api_key", "client_id", "client_secret", "redirect_uri"] {
                    if let Some(value) = object.remove(key) {
                        params[key] = value;
                    }
                }
                Ok(())
            })();
            if let Err(e) = loaded {
                output(json!({"ok":false,"error":e}));
                std::process::exit(2);
            }
        }
        match cli::run(&command, &params, &mut |m| eprintln!("{m}")) {
            Ok(mut data) => {
                if command == "connect" && data["pending"] == true {
                    if let Some(url) = data["authorize_url"].as_str() {
                        eprintln!("Complete authorization in your browser: {url}");
                    }
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(310);
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        match cli::run("connections", &params, &mut |_| {}) {
                            Ok(status) => {
                                let source = params["source"].as_str().unwrap_or("oura");
                                if status[source]["pending"] != true {
                                    if status[source]["connected"] == true
                                        && status[source]["error"].is_null()
                                    {
                                        data = json!({"connected":true,"source":source});
                                        break;
                                    }
                                    output(
                                        json!({"ok":false,"error":status[source]["error"].as_str().unwrap_or("Authorization did not complete")}),
                                    );
                                    std::process::exit(1);
                                }
                            }
                            Err(e) => {
                                output(json!({"ok":false,"error":e}));
                                std::process::exit(1);
                            }
                        }
                        if std::time::Instant::now() > deadline {
                            output(json!({"ok":false,"error":"Authorization timed out"}));
                            std::process::exit(1);
                        }
                    }
                }
                let ok = data["complete"].as_bool().unwrap_or(true);
                output(json!({"ok":ok,"data":data}));
                if !ok {
                    std::process::exit(4);
                }
            }
            Err(e) => {
                output(json!({"ok":false,"error":e}));
                std::process::exit(1);
            }
        }
    } else {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(notemd_plugin_sdk::serve(HealthPlugin));
    }
}
