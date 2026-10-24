use notemd_health_sync::{cli, plugin::HealthPlugin};
use serde_json::{json, Value};
fn output(value: impl std::fmt::Display) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout().lock(), "{value}");
}
fn copy_credentials(params: &mut Value, value: &mut Value) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or("Credentials stdin must be a JSON object")?;
    for key in [
        "api_key",
        "region",
        "label",
        "client_id",
        "client_secret",
        "redirect_uri",
    ] {
        if let Some(value) = object.remove(key) {
            params[key] = value;
        }
    }
    Ok(())
}

fn authorization_result(
    status: &Value,
    source: &str,
    attempt: &str,
) -> Result<Option<Value>, String> {
    let state = &status[source];
    if state["authorization_id"].as_str() != Some(attempt) {
        return Err("Authorization was cancelled or replaced".into());
    }
    if state["pending"] == true {
        return Ok(None);
    }
    if let Some(id) = state["completed_account_id"].as_str() {
        if state["accounts"].as_array().is_some_and(|accounts| {
            accounts
                .iter()
                .any(|account| account["id"] == id && account["connected"] == true)
        }) {
            return Ok(Some(
                json!({"connected":true,"source":source,"account_id":id,"authorization_id":attempt}),
            ));
        }
    }
    Err("Authorization did not complete".into())
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
                copy_credentials(&mut params, &mut value)
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
                    let Some(attempt) = data["authorization_id"].as_str().map(str::to_owned) else {
                        output(json!({"ok":false,"error":"Missing authorization attempt ID"}));
                        std::process::exit(1);
                    };
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(310);
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        match cli::run("connections", &params, &mut |_| {}) {
                            Ok(status) => {
                                let source = params["source"].as_str().unwrap_or("oura");
                                match authorization_result(&status, source, &attempt) {
                                    Ok(Some(result)) => {
                                        data = result;
                                        break;
                                    }
                                    Ok(None) => {}
                                    Err(error) => {
                                        output(json!({"ok":false,"error":error}));
                                        std::process::exit(1);
                                    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stdin_preserves_region_and_label_without_overwriting_cli_destination() {
        let mut params = json!({"vault":"selected-vault","source":"garmin"});
        let mut credentials = json!({"api_key":"synthetic","region":"china","label":"Old watch","vault":"other-vault","source":"oura"});
        copy_credentials(&mut params, &mut credentials).unwrap();
        assert_eq!(params["region"], "china");
        assert_eq!(params["label"], "Old watch");
        assert_eq!(params["vault"], "selected-vault");
        assert_eq!(params["source"], "garmin");
        assert!(credentials.get("api_key").is_none());
        assert!(copy_credentials(&mut params, &mut json!([])).is_err());
    }
    #[test]
    fn cli_waits_for_this_attempt_and_reports_new_noncurrent_account() {
        let mut status = json!({"oura":{"authorization_id":"attempt","pending":true,"connected":true,
            "active_account_id":"old","accounts":[{"id":"old","connected":true},{"id":"new","connected":true}]}});
        assert!(authorization_result(&status, "oura", "attempt")
            .unwrap()
            .is_none());
        status["oura"]["pending"] = json!(false);
        assert!(authorization_result(&status, "oura", "attempt").is_err());
        status["oura"]["completed_account_id"] = json!("new");
        let result = authorization_result(&status, "oura", "attempt")
            .unwrap()
            .unwrap();
        assert_eq!(result["account_id"], "new");
        assert_eq!(status["oura"]["active_account_id"], "old");
        assert!(authorization_result(&status, "oura", "replaced-attempt").is_err());
        status["oura"]["accounts"][1]["connected"] = json!(false);
        assert!(authorization_result(&status, "oura", "attempt").is_err());
    }
}
