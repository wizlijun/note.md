//! User-selected NEXT reminder script. No shell, agent, or model is involved.
//! The native picker is the only grant writer; plugin settings cannot grant execution.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use super::ui_rpc::{DialogFilter, HostServices, OpenOptions, TauriServices};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

const MAX_OUTPUT: u64 = 16 * 1024;
const MAX_ENVIRONMENT_TEXT: usize = 16 * 1024;
const MAX_ENVIRONMENT_VALUE: usize = 8 * 1024;
type Environment = BTreeMap<String, String>;
const TIMEOUT: Duration = Duration::from_secs(30);
static CONFIG_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn check_request(plugin: &str, method: &str, params: &Value) -> Result<(), String> {
    if plugin != "notemd.next" {
        return Err("not_granted: task hooks are restricted to NEXT".into());
    }
    let fields = params
        .as_object()
        .ok_or("bad_request: expected an object")?;
    match method {
        "host.taskHook.get" | "host.taskHook.select" | "host.taskHook.clear"
            if fields.is_empty() =>
        {
            Ok(())
        }
        "host.taskHook.setEnvironment" if fields.len() == 1 => {
            let text = fields
                .get("text")
                .and_then(Value::as_str)
                .ok_or("bad_request: environment text required")?;
            parse_environment(text).map(|_| ())
        }
        "host.taskHook.run" if fields.len() == 1 => {
            let id = fields
                .get("taskId")
                .and_then(Value::as_str)
                .ok_or("bad_request: taskId required")?;
            let uuid =
                uuid::Uuid::parse_str(id).map_err(|_| "bad_request: taskId must be a UUID v4")?;
            if uuid.get_version_num() != 4 || uuid.to_string() != id {
                return Err("bad_request: taskId must be a canonical UUID v4".into());
            }
            Ok(())
        }
        _ => Err("bad_request: unsupported task hook request or parameters".into()),
    }
}

fn config_path(private_root: &Path, vault: &Path) -> PathBuf {
    let key = hex::encode(Sha256::digest(vault.to_string_lossy().as_bytes()));
    private_root.join("task-hooks").join(format!("{key}.json"))
}

fn read_selection(private_root: &Path, vault: &Path) -> Result<Option<PathBuf>, String> {
    let path = config_path(private_root, vault);
    let data = match std::fs::read(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("config_unavailable: cannot read task hook selection".into()),
    };
    let data: Value = serde_json::from_slice(&data)
        .map_err(|_| "config_unavailable: invalid task hook selection")?;
    if data["vaultRoot"].as_str() != vault.to_str() {
        return Err("config_unavailable: task hook Vault mismatch".into());
    }
    let script = data["scriptPath"]
        .as_str()
        .ok_or("config_unavailable: script path missing")?;
    Ok(Some(PathBuf::from(script)))
}

fn selection_payload(script: Option<&Path>, environment: &Environment) -> Value {
    let mut result = match script {
        Some(path) => json!({"configured":true,"scriptPath":path}),
        None => json!({"configured":false}),
    };
    result["environmentSupported"] = json!(true);
    result["environmentKeys"] = json!(environment.keys().collect::<Vec<_>>());
    result
}

fn valid_environment_entry(key: &str, value: &str) -> bool {
    matches!(key, "DESK_DISPLAY_URL" | "DESK_DISPLAY_TOKEN")
        && !value.trim().is_empty()
        && value.len() <= MAX_ENVIRONMENT_VALUE
        && !value.contains(['\0', '\n', '\r'])
}

fn parse_environment(text: &str) -> Result<Environment, String> {
    let invalid = "bad_request: invalid task hook environment";
    if text.len() > MAX_ENVIRONMENT_TEXT || text.contains('\0') {
        return Err(invalid.into());
    }
    let mut environment = Environment::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, raw_value) = line.split_once('=').ok_or(invalid)?;
        let key = key.trim();
        let mut value = raw_value.trim();
        if value.starts_with(['\'', '"']) || value.ends_with(['\'', '"']) {
            let quote = value.as_bytes()[0];
            if value.len() < 2
                || !matches!(quote, b'\'' | b'"')
                || value.as_bytes().last() != Some(&quote)
            {
                return Err(invalid.into());
            }
            value = value[1..value.len() - 1].trim();
        }
        if !valid_environment_entry(key, value)
            || environment
                .insert(key.to_owned(), value.to_owned())
                .is_some()
        {
            return Err(invalid.into());
        }
    }
    Ok(environment)
}

fn environment_path(private_root: &Path, vault: &Path) -> PathBuf {
    config_path(private_root, vault).with_extension("environment.json")
}

fn read_environment(private_root: &Path, vault: &Path) -> Result<Environment, String> {
    let invalid = "config_unavailable: cannot read task hook environment";
    let data = match std::fs::read(environment_path(private_root, vault)) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Environment::new()),
        Err(_) => return Err(invalid.into()),
    };
    let data: Value = serde_json::from_slice(&data).map_err(|_| invalid)?;
    if data["vaultRoot"].as_str() != vault.to_str() {
        return Err(invalid.into());
    }
    let environment: Environment =
        serde_json::from_value(data["environment"].clone()).map_err(|_| invalid)?;
    if !environment
        .iter()
        .all(|(key, value)| valid_environment_entry(key, value))
    {
        return Err(invalid.into());
    }
    Ok(environment)
}

fn save_environment(private_root: &Path, vault: &Path, text: &str) -> Result<(), String> {
    let environment = parse_environment(text)?;
    let path = environment_path(private_root, vault);
    let invalid = "config_unavailable: cannot save task hook environment";
    if environment.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(invalid.into()),
        };
    }
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent).map_err(|_| invalid)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| invalid)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| invalid)?;
    }
    temp.write_all(
        &serde_json::to_vec(&json!({"vaultRoot":vault,"environment":environment})).unwrap(),
    )
    .map_err(|_| invalid)?;
    temp.as_file().sync_all().map_err(|_| invalid)?;
    temp.persist(path).map_err(|_| invalid)?;
    Ok(())
}

fn validate_script(vault: &Path, script: &Path) -> Result<PathBuf, String> {
    let script = script
        .canonicalize()
        .map_err(|_| "invalid_script: selected script is unavailable")?;
    // Check against the literal skills directory beneath the canonical Vault:
    // symlinks out of skills (including a symlinked skills root) cannot escape it.
    if !script.starts_with(vault.join("skills"))
        || !script.is_file()
        || script.extension().and_then(|e| e.to_str()) != Some("py")
    {
        return Err(
            "invalid_script: select a Python file inside this Vault's skills directory".into(),
        );
    }
    Ok(script)
}

fn save_selection(private_root: &Path, vault: &Path, script: &Path) -> Result<(), String> {
    let script = validate_script(vault, script)?;
    let path = config_path(private_root, vault);
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent)
        .map_err(|_| "config_unavailable: cannot create task hook settings")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "config_unavailable: cannot save task hook settings")?;
    temp.write_all(&serde_json::to_vec(&json!({"vaultRoot":vault,"scriptPath":script})).unwrap())
        .map_err(|_| "config_unavailable: cannot save task hook settings")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "config_unavailable: cannot persist task hook settings")?;
    temp.persist(path)
        .map_err(|_| "config_unavailable: cannot replace task hook settings")?;
    Ok(())
}

fn pending(code: &str, exit_code: Option<i32>) -> Value {
    let mut result =
        json!({"ok":false,"status":"pending","created":0,"updated":0,"deleted":0,"errorCode":code});
    if let Some(exit_code) = exit_code {
        result["exitCode"] = json!(exit_code);
    }
    result
}

fn script_result(output: &[u8], success: bool, exit_code: Option<i32>) -> Value {
    let invalid = if success {
        "invalid_output"
    } else {
        "script_failed"
    };
    let Ok(value) = serde_json::from_slice::<Value>(output) else {
        return pending(invalid, exit_code);
    };
    let Some(ok) = value["ok"].as_bool() else {
        return pending(invalid, exit_code);
    };
    let status = value["status"].as_str().unwrap_or("");
    if !matches!(
        (ok, status),
        (true, "synced" | "disabled") | (false, "pending")
    ) {
        return pending(invalid, exit_code);
    }
    if !success && ok {
        return pending("script_failed", exit_code);
    }
    let mut result = json!({"ok":ok,"status":status});
    for key in ["created", "updated", "deleted"] {
        let Some(count) = value[key].as_u64() else {
            return pending(invalid, exit_code);
        };
        result[key] = json!(count);
    }
    if !ok {
        // Only these fixed skill error codes may cross the native boundary.
        // Never expose arbitrary script output, including errors containing secrets.
        let code = match value["error"].as_str() {
            Some(
                code @ ("missing_cube_config"
                | "cube_unavailable"
                | "sync_busy"
                | "cube_safe_create_unavailable"),
            ) => code,
            _ if success => "script_pending",
            _ => "script_failed",
        };
        result["errorCode"] = json!(code);
    }
    if let Some(exit_code) = exit_code {
        result["exitCode"] = json!(exit_code);
    }
    result
}

// Finder-launched macOS apps commonly have a system-only PATH. Prefer an
// already installed Homebrew Python, where the skill dependencies are installed.
// Never source a shell profile or install a runtime on behalf of the user.
fn find_python(candidates: &[&Path]) -> PathBuf {
    for candidate in candidates {
        let Ok(metadata) = candidate.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                continue;
            }
        }
        return candidate.to_path_buf();
    }
    PathBuf::from("python3")
}

fn python_program() -> PathBuf {
    if cfg!(target_os = "macos") {
        find_python(&[
            Path::new("/opt/homebrew/bin/python3"),
            Path::new("/usr/local/bin/python3"),
        ])
    } else {
        find_python(&[])
    }
}

async fn execute(
    vault: &Path,
    script: &Path,
    task_id: &str,
    environment: &Environment,
    timeout: Duration,
) -> Value {
    let script = match validate_script(vault, script) {
        Ok(script) => script,
        Err(_) => return pending("invalid_script", None),
    };
    let mut command = crate::platform::tokio_command(python_program());
    command.env_clear();
    for name in crate::platform::plugin_env_allowlist() {
        if let Ok(value) = std::env::var(name) {
            command.env(name, value);
        }
    }
    command.envs(environment);
    command
        .args(["-X", "utf8", "-E", "-s"])
        .arg(script)
        .arg("--vault")
        .arg(vault)
        .arg("--task-id")
        .arg(task_id)
        .arg("--apply")
        .current_dir(vault)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return pending("launch_failed", None),
    };
    let pid = child.id();
    let mut output = Vec::new();
    let mut stdout = child.stdout.take().unwrap().take(MAX_OUTPUT + 1);
    let completed = tokio::time::timeout(timeout, async {
        stdout.read_to_end(&mut output).await?;
        if output.len() as u64 > MAX_OUTPUT {
            return Ok(None);
        }
        child.wait().await.map(Some)
    })
    .await;
    // Terminate the process group as well: a timed-out script must not leave
    // descendants performing reminder writes after NEXT reports pending.
    #[cfg(unix)]
    if !matches!(&completed, Ok(Ok(Some(_)))) {
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    match completed {
        Err(_) => {
            let _ = child.kill().await;
            pending("timeout", None)
        }
        Ok(Err(_)) => {
            let _ = child.kill().await;
            pending("script_failed", None)
        }
        Ok(Ok(None)) => {
            let _ = child.kill().await;
            pending("output_too_large", None)
        }
        Ok(Ok(Some(status))) => script_result(&output, status.success(), status.code()),
    }
}

pub async fn dispatch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin: &str,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    use tauri::Manager;
    check_request(plugin, method, params)?;
    let vault = crate::sotvault::resolve_vault_root(app)
        .ok_or("vault_required: configure a Vault first")?
        .canonicalize()
        .map_err(|_| "vault_required: Vault is unavailable")?;
    let private_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "config_unavailable: application data unavailable")?;
    if method == "host.taskHook.run" {
        let (script, environment) = {
            let _guard = CONFIG_LOCK
                .lock()
                .map_err(|_| "config_unavailable: settings lock failed")?;
            (
                read_selection(&private_root, &vault)?,
                read_environment(&private_root, &vault)?,
            )
        };
        return Ok(match script {
            None => json!({"ok":true,"status":"disabled","created":0,"updated":0,"deleted":0}),
            Some(script) => {
                execute(
                    &vault,
                    &script,
                    params["taskId"].as_str().unwrap(),
                    &environment,
                    TIMEOUT,
                )
                .await
            }
        });
    }
    if method == "host.taskHook.select" {
        let services = TauriServices::new(app.clone());
        let picked = tauri::async_runtime::spawn_blocking(move || {
            services.pick_paths(&OpenOptions {
                title: Some("选择 NEXT 提醒脚本（当前 Vault / skills）".into()),
                filters: vec![DialogFilter {
                    name: "Python".into(),
                    extensions: vec!["py".into()],
                }],
                directory: false,
                multiple: false,
            })
        })
        .await
        .map_err(|_| "dialog_failed: cannot open script picker")??;
        let _guard = CONFIG_LOCK
            .lock()
            .map_err(|_| "config_unavailable: settings lock failed")?;
        if let Some(script) = picked.and_then(|paths| paths.into_iter().next()) {
            save_selection(&private_root, &vault, &script)?;
        }
        return Ok(selection_payload(
            read_selection(&private_root, &vault)?.as_deref(),
            &read_environment(&private_root, &vault)?,
        ));
    }
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|_| "config_unavailable: settings lock failed")?;
    if method == "host.taskHook.clear" {
        match std::fs::remove_file(config_path(&private_root, &vault)) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("config_unavailable: cannot clear task hook selection".into()),
        }
    }
    if method == "host.taskHook.setEnvironment" {
        save_environment(&private_root, &vault, params["text"].as_str().unwrap())?;
    }
    let mut result = selection_payload(
        read_selection(&private_root, &vault)?.as_deref(),
        &read_environment(&private_root, &vault)?,
    );
    if method == "host.taskHook.get" {
        result["pythonPath"] = json!(python_program());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    const TASK: &str = "8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8";
    fn fixture(body: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().canonicalize().unwrap();
        let dir = vault.join("skills/test/scripts");
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("hook with spaces.py");
        std::fs::write(&script, body).unwrap();
        (temp, vault, script)
    }
    #[test]
    fn python_discovery_skips_missing_nonfiles_and_nonexecutables() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing");
        let script = temp.path().join("python");
        std::fs::write(&script, "fixture").unwrap();
        assert_eq!(
            find_python(&[&missing, temp.path()]),
            PathBuf::from("python3")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(find_python(&[&script]), PathBuf::from("python3"));
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(find_python(&[&missing, &script]), script);
    }

    #[test]
    fn origin_and_parameters_cannot_choose_commands_or_vault() {
        assert!(check_request("notemd.next", "host.taskHook.run", &json!({"taskId":TASK})).is_ok());
        for params in [
            json!({"taskId":TASK,"script":"x"}),
            json!({"taskId":TASK,"vault":"x"}),
            json!({"taskId":"$(touch bad)"}),
        ] {
            assert!(check_request("notemd.next", "host.taskHook.run", &params).is_err());
        }
        assert!(
            check_request("other.plugin", "host.taskHook.run", &json!({"taskId":TASK})).is_err()
        );
        assert!(
            check_request("notemd.next", "host.taskHook.select", &json!({"path":"x"})).is_err()
        );
        assert!(check_request(
            "notemd.next",
            "host.taskHook.setEnvironment",
            &json!({"text":"DESK_DISPLAY_TOKEN=fake"})
        )
        .is_ok());
        for (plugin, params) in [
            ("other.plugin", json!({"text":"DESK_DISPLAY_TOKEN=fake"})),
            ("notemd.next", json!({"text":"", "vault":"other"})),
            ("notemd.next", json!({"text":42})),
            ("notemd.next", json!({"text":"PYTHONPATH=secret"})),
        ] {
            assert!(check_request(plugin, "host.taskHook.setEnvironment", &params).is_err());
        }
    }

    #[test]
    fn environment_parser_accepts_only_literal_allowed_assignments() {
        let environment = parse_environment("\r\n # ignored\r\n DESK_DISPLAY_URL = \" https://cube.invalid \"\r\nDESK_DISPLAY_TOKEN='fake=a=$HOME$(noop)`noop`#literal'\n").unwrap();
        assert_eq!(environment["DESK_DISPLAY_URL"], "https://cube.invalid");
        assert_eq!(
            environment["DESK_DISPLAY_TOKEN"],
            "fake=a=$HOME$(noop)`noop`#literal"
        );
        assert!(parse_environment(" \n# comment\n").unwrap().is_empty());
        for text in [
            "secret-without-equals",
            "PATH=secret",
            "export DESK_DISPLAY_TOKEN=secret",
            "DESK_DISPLAY_TOKEN=",
            "DESK_DISPLAY_TOKEN=' '",
            "DESK_DISPLAY_TOKEN='secret\"",
            "DESK_DISPLAY_TOKEN=secret'",
            "DESK_DISPLAY_TOKEN=secret\0",
            "DESK_DISPLAY_TOKEN=secret\nDESK_DISPLAY_TOKEN=other",
            "DESK_DISPLAY_TOKEN=\"secret\nsecond line\"",
        ] {
            let error = parse_environment(text).unwrap_err();
            assert_eq!(error, "bad_request: invalid task hook environment");
            assert!(!error.contains("secret"));
        }
        assert!(parse_environment(&format!(
            "DESK_DISPLAY_TOKEN={}",
            "x".repeat(MAX_ENVIRONMENT_VALUE + 1)
        ))
        .is_err());
        assert!(parse_environment(&" ".repeat(MAX_ENVIRONMENT_TEXT + 1)).is_err());
    }

    #[test]
    fn environment_storage_is_private_isolated_and_never_returns_values() {
        let (_temp, vault, _) = fixture("");
        let private = tempfile::tempdir().unwrap();
        save_environment(
            private.path(),
            &vault,
            "DESK_DISPLAY_URL=https://cube.invalid\nDESK_DISPLAY_TOKEN=fake-secret",
        )
        .unwrap();
        let environment = read_environment(private.path(), &vault).unwrap();
        assert_eq!(environment["DESK_DISPLAY_TOKEN"], "fake-secret");
        let payload = selection_payload(None, &environment);
        assert_eq!(
            payload,
            json!({"configured":false,"environmentSupported":true,"environmentKeys":["DESK_DISPLAY_TOKEN","DESK_DISPLAY_URL"]})
        );
        assert!(!payload.to_string().contains("fake-secret"));
        assert!(!payload.to_string().contains("cube.invalid"));
        let path = environment_path(private.path(), &vault);
        assert!(!path.starts_with(&vault));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let other = vault.join("other");
        assert!(read_environment(private.path(), &other).unwrap().is_empty());
        std::fs::copy(&path, environment_path(private.path(), &other)).unwrap();
        assert!(read_environment(private.path(), &other).is_err());
        assert!(save_environment(private.path(), &vault, "PATH=secret").is_err());
        assert_eq!(
            read_environment(private.path(), &vault).unwrap(),
            environment
        );
        save_environment(private.path(), &vault, "DESK_DISPLAY_TOKEN=replacement").unwrap();
        assert_eq!(read_environment(private.path(), &vault).unwrap().len(), 1);
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"vaultRoot":vault,"environment":{"PYTHONPATH":"secret"}}))
                .unwrap(),
        )
        .unwrap();
        let error = read_environment(private.path(), &vault).unwrap_err();
        assert!(!error.contains("secret"));
    }

    #[test]
    fn environment_and_script_selection_clear_independently() {
        let (_temp, vault, script) = fixture("");
        let private = tempfile::tempdir().unwrap();
        save_selection(private.path(), &vault, &script).unwrap();
        save_environment(private.path(), &vault, "DESK_DISPLAY_TOKEN=fake").unwrap();
        save_environment(private.path(), &vault, " # clear\n ").unwrap();
        assert_eq!(
            read_selection(private.path(), &vault).unwrap(),
            Some(script.clone())
        );
        assert!(read_environment(private.path(), &vault).unwrap().is_empty());
        assert!(!environment_path(private.path(), &vault).exists());
        save_environment(private.path(), &vault, "DESK_DISPLAY_TOKEN=fake").unwrap();
        std::fs::remove_file(config_path(private.path(), &vault)).unwrap();
        assert_eq!(read_selection(private.path(), &vault).unwrap(), None);
        assert_eq!(
            read_environment(private.path(), &vault).unwrap()["DESK_DISPLAY_TOKEN"],
            "fake"
        );
        save_selection(private.path(), &vault, &script).unwrap();
        assert_eq!(
            read_environment(private.path(), &vault).unwrap()["DESK_DISPLAY_TOKEN"],
            "fake"
        );
    }

    #[tokio::test]
    async fn script_receives_saved_environment_snapshot_without_shell_or_output_leaks() {
        let (_temp, vault, script) = fixture(
            r#"import json, os, sys
assert sys.argv[1:] == ['--vault', os.getcwd(), '--task-id', '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8', '--apply']
assert os.environ['DESK_DISPLAY_URL'] == 'https://cube.invalid'
assert os.environ['DESK_DISPLAY_TOKEN'] == 'fake=a=$HOME$(noop)`noop`'
assert 'PYTHONPATH' not in os.environ
print(json.dumps(dict(ok=True, status='synced', created=0, updated=0, deleted=0, token=os.environ['DESK_DISPLAY_TOKEN'])))
"#,
        );
        let private = tempfile::tempdir().unwrap();
        save_environment(
            private.path(),
            &vault,
            "DESK_DISPLAY_URL=https://cube.invalid\nDESK_DISPLAY_TOKEN='fake=a=$HOME$(noop)`noop`'",
        )
        .unwrap();
        let environment = read_environment(private.path(), &vault).unwrap();
        save_environment(private.path(), &vault, "").unwrap();
        let result = execute(&vault, &script, TASK, &environment, Duration::from_secs(5)).await;
        assert_eq!(result["status"], "synced", "{result}");
        assert!(result.get("token").is_none());
        assert!(!result.to_string().contains("fake="));
    }
    #[test]
    fn configuration_is_bound_to_canonical_vault() {
        let (_temp, vault, script) = fixture("print('unused')");
        let private = tempfile::tempdir().unwrap();
        save_selection(private.path(), &vault, &script).unwrap();
        assert_eq!(
            read_selection(private.path(), &vault).unwrap(),
            Some(script)
        );
        assert_eq!(
            read_selection(private.path(), &vault.join("another")).unwrap(),
            None
        );
        assert!(!config_path(private.path(), &vault).starts_with(&vault));
    }
    #[test]
    fn rejects_scripts_outside_skills_and_symlink_escapes() {
        let (_temp, vault, _) = fixture("");
        let outside = vault.join("outside.py");
        std::fs::write(&outside, "").unwrap();
        assert!(validate_script(&vault, &outside).is_err());
        #[cfg(unix)]
        {
            let link = vault.join("skills/test/escape.py");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(validate_script(&vault, &link).is_err());
        }
    }
    #[test]
    fn output_is_strict_and_secrets_are_not_returned() {
        let result = script_result(br#"{"ok":true,"status":"synced","created":1,"updated":2,"deleted":3,"token":"secret"}"#, true, Some(0));
        assert_eq!(result["deleted"], 3);
        assert!(result.get("token").is_none());
        for output in [
            b"secret".as_slice(),
            br#"{"ok":true,"status":"pending"}"#,
            br#"{"ok":true,"status":"synced","created":-1,"updated":0,"deleted":0}"#,
        ] {
            assert_eq!(
                script_result(output, true, Some(0))["errorCode"],
                "invalid_output"
            );
        }
        assert_eq!(
            script_result(b"secret", false, Some(9))["errorCode"],
            "script_failed"
        );
    }
    #[tokio::test]
    async fn nonzero_script_preserves_allowlisted_diagnostic() {
        let (_temp, vault, script) = fixture(
            "import json, sys\nprint(json.dumps(dict(ok=False, status='pending', error='missing_cube_config', created=0, updated=0, deleted=0)))\nsys.exit(1)\n",
        );
        let result = execute(
            &vault,
            &script,
            TASK,
            &Environment::new(),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            result,
            json!({"ok":false,"status":"pending","errorCode":"missing_cube_config","created":0,"updated":0,"deleted":0,"exitCode":1})
        );
    }

    #[test]
    fn diagnostics_require_valid_pending_schema_and_allowlisted_code() {
        for code in [
            "missing_cube_config",
            "cube_unavailable",
            "sync_busy",
            "cube_safe_create_unavailable",
        ] {
            let output = json!({"ok":false,"status":"pending","error":code,"created":0,"updated":1,"deleted":2,"token":"secret"});
            for success in [true, false] {
                let result = script_result(
                    &serde_json::to_vec(&output).unwrap(),
                    success,
                    Some(if success { 0 } else { 1 }),
                );
                assert_eq!(result["errorCode"], code);
                assert_eq!(result["updated"], 1);
                assert!(!result.to_string().contains("secret"));
            }
        }
        for (success, fallback) in [(true, "script_pending"), (false, "script_failed")] {
            let output = br#"{"ok":false,"status":"pending","error":"secret-token","created":0,"updated":0,"deleted":0}"#;
            let result = script_result(output, success, None);
            assert_eq!(result["errorCode"], fallback);
            assert!(!result.to_string().contains("secret"));
        }
        for output in [
            br#"{"ok":true,"status":"synced","created":0,"updated":0,"deleted":0}"#.as_slice(),
            br#"{"ok":false,"status":"synced","error":"missing_cube_config","created":0,"updated":0,"deleted":0}"#,
            br#"{"ok":false,"status":"pending","error":"missing_cube_config","created":-1,"updated":0,"deleted":0}"#,
            br#"{"ok":false,"status":"pending","error":"missing_cube_config","updated":0,"deleted":0}"#,
        ] {
            let result = script_result(output, false, Some(1));
            assert_eq!(result["ok"], false);
            assert_eq!(result["status"], "pending");
            assert_eq!(result["errorCode"], "script_failed");
        }
    }

    #[tokio::test]
    async fn executes_only_fixed_arguments_in_vault_without_model_or_secrets() {
        let (_temp, vault, script) = fixture(
            r#"import json, os, sys
assert sys.argv[1:] == ['--vault', os.getcwd(), '--task-id', '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8', '--apply']
assert not any(k in os.environ for k in ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLOUDFLARE_API_TOKEN'])
print(json.dumps(dict(ok=True, status='synced', created=0, updated=1, deleted=2, secret='not returned')))
"#,
        );
        let result = execute(
            &vault,
            &script,
            TASK,
            &Environment::new(),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(result["status"], "synced", "{result}");
        assert_eq!(result["updated"], 1);
        assert!(result.get("secret").is_none());
    }
    #[tokio::test]
    async fn oversized_output_is_bounded_and_missing_script_is_pending() {
        let (_temp, vault, script) = fixture("print('x' * 100000)\n");
        assert_eq!(
            execute(
                &vault,
                &script,
                TASK,
                &Environment::new(),
                Duration::from_secs(5)
            )
            .await["errorCode"],
            "output_too_large"
        );
        std::fs::remove_file(&script).unwrap();
        assert_eq!(
            execute(
                &vault,
                &script,
                TASK,
                &Environment::new(),
                Duration::from_secs(5)
            )
            .await["errorCode"],
            "invalid_script"
        );
    }
    #[tokio::test]
    async fn timeout_and_nonzero_never_claim_success() {
        let (_temp, vault, script) = fixture("import time\ntime.sleep(10)\n");
        assert_eq!(
            execute(
                &vault,
                &script,
                TASK,
                &Environment::new(),
                Duration::from_millis(100)
            )
            .await["errorCode"],
            "timeout"
        );
        std::fs::write(&script, "import sys\nprint('secret')\nsys.exit(7)\n").unwrap();
        let result = execute(
            &vault,
            &script,
            TASK,
            &Environment::new(),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(result["errorCode"], "script_failed");
        assert_eq!(result["exitCode"], 7);
    }
}
