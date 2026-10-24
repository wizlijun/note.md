use crate::store::{default_state_base, QueryFilter, Store};
use serde_json::{json, Value};
use std::path::PathBuf;

pub const USAGE: &str = "Health Sync: Apple primary + Garmin/Oura details, one person per vault

notemd-health-sync health-import <export.zip|export.xml> [--vault DIR] [--dry-run] [--json]
notemd-health-sync health-sync [--file EXPORT] [--source all|apple-health|garmin|oura] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--max-days 31] [--restart] [--vault DIR] [--dry-run] [--json]
notemd-health-sync health-status [--vault DIR] [--json]
notemd-health-sync health-catalog [--vault DIR] [--json]
notemd-health-sync health-query [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--category sleep] [--source oura] [--metric TYPE] [--limit 100] [--offset 0] [--vault DIR] [--json]
notemd-health-sync connect --source garmin|oura --credentials-stdin [--vault DIR]
notemd-health-sync health-disconnect --source garmin|oura [--vault DIR]

Apple import replaces only the Apple complete snapshot; old shards remain.
Provider sync resumes a bounded backfill, then revisits the recent fortnight.
Credentials are read from stdin JSON, never command-line arguments, and stored in Keychain.
Output is JSON. With no arguments the native plugin stdio protocol starts.";

pub fn parse(args: &[String]) -> Result<(String, Value), String> {
    let first = args.first().ok_or("Missing command")?;
    let command = first.strip_prefix("health-").unwrap_or(first).to_string();
    if ![
        "import",
        "sync",
        "status",
        "query",
        "catalog",
        "connect",
        "disconnect",
        "connections",
    ]
    .contains(&command.as_str())
    {
        return Err(format!("Unknown command: {first}"));
    }
    let mut params = json!({});
    let mut i = 1;
    while i < args.len() {
        let token = &args[i];
        match token.as_str() {
            "--json" => {}
            "--dry-run" if command == "import" || command == "sync" => {
                params["dry_run"] = json!(true);
            }
            "--restart" if command == "sync" => {
                params["restart"] = json!(true);
            }
            "--credentials-stdin" if command == "connect" => {
                params["credentials_stdin"] = json!(true);
            }
            "--vault" | "--since" | "--until" | "--metric" | "--limit" | "--offset"
            | "--source" | "--category" | "--max-days" | "--file" => {
                let allowed = match token.as_str() {
                    "--vault" => true,
                    "--since" | "--until" => command == "query" || command == "sync",
                    "--source" => {
                        ["sync", "query", "connect", "disconnect"].contains(&command.as_str())
                    }
                    "--max-days" | "--file" => command == "sync",
                    _ => command == "query",
                };
                if !allowed {
                    return Err(format!("{token} is not valid with {command}"));
                }
                i += 1;
                let value = args
                    .get(i)
                    .filter(|v| !v.starts_with("--"))
                    .ok_or_else(|| format!("Missing value for {token}"))?;
                let key = token.trim_start_matches('-');
                if !params[key].is_null() {
                    return Err(format!("Duplicate flag: {token}"));
                }
                params[key] = json!(value);
            }
            _ if !token.starts_with('-') && command == "import" && params["file"].is_null() => {
                params["file"] = json!(token)
            }
            _ => return Err(format!("Unexpected argument: {token}")),
        }
        i += 1;
    }
    if command == "import" && params["file"].is_null() {
        return Err("health-import requires a complete export file".into());
    }
    // Validate numeric and date syntax before doing any I/O.
    validate_query(&command, &params)?;
    Ok((command, params))
}

fn field<'a>(params: &'a Value, name: &str) -> Option<&'a Value> {
    let dash = name.replace('_', "-");
    [
        format!("/cli/args/{dash}"),
        format!("/cli/flags/{dash}"),
        format!("/cli/{dash}"),
        format!("/{name}"),
        format!("/{dash}"),
    ]
    .iter()
    .find_map(|p| params.pointer(p).filter(|v| !v.is_null()))
}
fn string(params: &Value, name: &str) -> Option<String> {
    field(params, name)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
}
fn number(params: &Value, name: &str, default: usize) -> Result<usize, String> {
    match field(params, name) {
        None => Ok(default),
        Some(Value::String(s)) => s
            .parse()
            .map_err(|_| format!("--{name} must be a nonnegative integer")),
        Some(v) => v
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(|| format!("--{name} must be a nonnegative integer")),
    }
}
fn validate_query(command: &str, params: &Value) -> Result<(), String> {
    if command != "query" && command != "sync" {
        return Ok(());
    }
    if command == "sync" {
        if string(params, "file").is_some()
            && string(params, "source").is_some_and(|s| s != "all" && s != "apple-health")
        {
            return Err("--file applies only to all or apple-health sources".into());
        }
        let days = number(params, "max_days", 31)?;
        if days == 0 || days > 36600 {
            return Err("max-days must be 1..36600".into());
        }
        if let Some(source) = string(params, "source") {
            if !["all", "apple-health", "garmin", "oura"].contains(&source.as_str()) {
                return Err("Unknown health source".into());
            }
        }
    }
    let limit = number(params, "limit", 100)?;
    let offset = number(params, "offset", 0)?;
    if limit == 0 || limit > 1000 || offset.checked_add(limit).is_none() {
        return Err("limit must be 1..1000 and offset must not overflow".into());
    }
    let since = string(params, "since");
    let until = string(params, "until");
    for date in [since.as_deref(), until.as_deref()].into_iter().flatten() {
        if !crate::store::valid_day(date) {
            return Err("Dates must be YYYY-MM-DD".into());
        }
    }
    if since.zip(until).is_some_and(|(a, b)| a > b) {
        return Err("--since must not be later than --until".into());
    }
    Ok(())
}

fn default_vault() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("Specify --vault; HOME is unavailable")?;
    let bytes = std::fs::read(
        PathBuf::from(home).join("Library/Application Support/net.notemd.app/shared.json"),
    )
    .map_err(|_| "Configure a Vault or specify --vault".to_string())?;
    let config: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    config["sotvault"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Configure a Vault or specify --vault".into())
}

pub fn run(command: &str, params: &Value, progress: &mut dyn FnMut(&str)) -> Result<Value, String> {
    validate_query(command, params)?;
    let vault = string(params, "vault")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(default_vault)?;
    let store = Store::new(&vault, &default_state_base()?)?;
    match command {
        "connect" => {
            let source = string(params, "source").ok_or("Choose garmin or oura")?;
            let result = crate::auth::connect(&vault, &source, params)?;
            if let Some(url) = result["authorize_url"].as_str() {
                // Only open the URL produced by our OAuth implementation.
                if url.starts_with("https://cloud.ouraring.com/oauth/authorize?") {
                    let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
                }
            }
            return Ok(result);
        }
        "connections" => return crate::auth::status(&vault),
        "disconnect" => {
            return crate::auth::disconnect(
                &vault,
                &string(params, "source").ok_or("Choose garmin or oura")?,
            )
        }
        "status" => {
            let mut result = store.status()?;
            match crate::auth::status(&vault) {
                Ok(connections) => result["connections"] = connections,
                Err(e) => result["connections_error"] = json!(e),
            }
            return Ok(result);
        }
        "sync" => {
            return crate::sync::run(
                &vault,
                &crate::sync::Options {
                    source: string(params, "source").unwrap_or_else(|| "all".into()),
                    file: string(params, "file").map(PathBuf::from),
                    since: string(params, "since"),
                    until: string(params, "until"),
                    max_days: number(params, "max_days", 31)?,
                    dry_run: boolean(params, "dry_run")?,
                    restart: boolean(params, "restart")?,
                },
                progress,
            )
        }
        _ => {}
    }
    run_with_store(&store, command, params, progress)
}

fn boolean(params: &Value, name: &str) -> Result<bool, String> {
    match field(params, name) {
        None => Ok(false),
        Some(Value::Bool(v)) => Ok(*v),
        Some(Value::String(s)) if s == "true" => Ok(true),
        Some(Value::String(s)) if s == "false" => Ok(false),
        _ => Err(format!("{name} must be boolean")),
    }
}

pub fn run_with_store(
    store: &Store,
    command: &str,
    params: &Value,
    progress: &mut dyn FnMut(&str),
) -> Result<Value, String> {
    validate_query(command, params)?;
    let dry_run = boolean(params, "dry_run")?;
    match command {
        "import" => {
            let path =
                string(params, "file").ok_or("health-import requires a complete export file")?;
            serde_json::to_value(store.import(&PathBuf::from(path), dry_run, progress)?)
                .map_err(|e| e.to_string())
        }
        "sync" => serde_json::to_value(store.sync(
            string(params, "file").map(PathBuf::from).as_deref(),
            dry_run,
            progress,
        )?)
        .map_err(|e| e.to_string()),
        "status" => store.status(),
        "catalog" => store.catalog(),
        "query" => store.query_filtered(
            QueryFilter {
                since: string(params, "since").as_deref(),
                until: string(params, "until").as_deref(),
                metric: string(params, "metric").as_deref(),
                category: string(params, "category").as_deref(),
                source: string(params, "source").as_deref(),
            },
            number(params, "limit", 100)?,
            number(params, "offset", 0)?,
        ),
        _ => Err(format!("Unknown health command: {command}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_cli_and_host_context() {
        let args = [
            "health-import",
            "/tmp/export.xml",
            "--vault",
            "/tmp/vault",
            "--dry-run",
            "--json",
        ]
        .map(str::to_string);
        let (cmd, p) = parse(&args).unwrap();
        assert_eq!(cmd, "import");
        assert_eq!(p["dry_run"], true);
        let context =
            json!({"cli":{"args":{"file":"/tmp/x"},"flags":{"dry-run":true,"vault":"/tmp/v"}}});
        assert_eq!(string(&context, "file").as_deref(), Some("/tmp/x"));
        assert_eq!(field(&context, "dry_run"), Some(&json!(true)));
    }
    #[test]
    fn rejects_bad_args_before_io() {
        for args in [
            vec!["health-import"],
            vec!["health-sync", "--source", "garmin", "--file", "a.xml"],
            vec!["health-status", "--dry-run"],
            vec!["health-query", "--limit", "0"],
            vec!["health-query", "--offset", "-1"],
            vec!["health-query", "--since", "2026-02-30"],
            vec![
                "health-query",
                "--since",
                "2026-10-01",
                "--until",
                "2020-01-01",
            ],
            vec!["health-sync", "--vault", "a", "--vault", "b"],
        ] {
            assert!(parse(&args.into_iter().map(str::to_string).collect::<Vec<_>>()).is_err());
        }
    }
}
