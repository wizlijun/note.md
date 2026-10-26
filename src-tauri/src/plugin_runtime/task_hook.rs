//! User-selected NEXT reminder script. No shell, agent, or model is involved.
//! The native picker is the only grant writer; plugin settings cannot grant execution.

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

fn selection_payload(script: Option<&Path>) -> Value {
    match script {
        Some(path) => json!({"configured":true,"scriptPath":path}),
        None => json!({"configured":false}),
    }
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
    if !success {
        return pending("script_failed", exit_code);
    }
    let Ok(value) = serde_json::from_slice::<Value>(output) else {
        return pending("invalid_output", exit_code);
    };
    let Some(ok) = value["ok"].as_bool() else {
        return pending("invalid_output", exit_code);
    };
    let status = value["status"].as_str().unwrap_or("");
    if !matches!(
        (ok, status),
        (true, "synced" | "disabled") | (false, "pending")
    ) {
        return pending("invalid_output", exit_code);
    }
    let mut result = json!({"ok":ok,"status":status});
    for key in ["created", "updated", "deleted"] {
        let Some(count) = value[key].as_u64() else {
            return pending("invalid_output", exit_code);
        };
        result[key] = json!(count);
    }
    if !ok {
        result["errorCode"] = json!("script_pending");
    }
    if let Some(exit_code) = exit_code {
        result["exitCode"] = json!(exit_code);
    }
    result
}

async fn execute(vault: &Path, script: &Path, task_id: &str, timeout: Duration) -> Value {
    let script = match validate_script(vault, script) {
        Ok(script) => script,
        Err(_) => return pending("invalid_script", None),
    };
    let mut command = crate::platform::tokio_command("python3");
    command.env_clear();
    for name in crate::platform::plugin_env_allowlist() {
        if let Ok(value) = std::env::var(name) {
            command.env(name, value);
        }
    }
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
        let script = {
            let _guard = CONFIG_LOCK
                .lock()
                .map_err(|_| "config_unavailable: settings lock failed")?;
            read_selection(&private_root, &vault)?
        };
        return Ok(match script {
            None => json!({"ok":true,"status":"disabled","created":0,"updated":0,"deleted":0}),
            Some(script) => {
                execute(&vault, &script, params["taskId"].as_str().unwrap(), TIMEOUT).await
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
    Ok(selection_payload(
        read_selection(&private_root, &vault)?.as_deref(),
    ))
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
    async fn executes_only_fixed_arguments_in_vault_without_model_or_secrets() {
        let (_temp, vault, script) = fixture(
            r#"import json, os, sys
assert sys.argv[1:] == ['--vault', os.getcwd(), '--task-id', '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8', '--apply']
assert not any(k in os.environ for k in ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLOUDFLARE_API_TOKEN'])
print(json.dumps(dict(ok=True, status='synced', created=0, updated=1, deleted=2, secret='not returned')))
"#,
        );
        let result = execute(&vault, &script, TASK, Duration::from_secs(5)).await;
        assert_eq!(result["status"], "synced", "{result}");
        assert_eq!(result["updated"], 1);
        assert!(result.get("secret").is_none());
    }
    #[tokio::test]
    async fn oversized_output_is_bounded_and_missing_script_is_pending() {
        let (_temp, vault, script) = fixture("print('x' * 100000)\n");
        assert_eq!(
            execute(&vault, &script, TASK, Duration::from_secs(5)).await["errorCode"],
            "output_too_large"
        );
        std::fs::remove_file(&script).unwrap();
        assert_eq!(
            execute(&vault, &script, TASK, Duration::from_secs(5)).await["errorCode"],
            "invalid_script"
        );
    }
    #[tokio::test]
    async fn timeout_and_nonzero_never_claim_success() {
        let (_temp, vault, script) = fixture("import time\ntime.sleep(10)\n");
        assert_eq!(
            execute(&vault, &script, TASK, Duration::from_millis(100)).await["errorCode"],
            "timeout"
        );
        std::fs::write(&script, "import sys\nprint('secret')\nsys.exit(7)\n").unwrap();
        let result = execute(&vault, &script, TASK, Duration::from_secs(5)).await;
        assert_eq!(result["errorCode"], "script_failed");
        assert_eq!(result["exitCode"], 7);
    }
}
