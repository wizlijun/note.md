use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn request(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

fn initialize(data: &Path) -> Value {
    request(
        1,
        "$initialize",
        json!({"protocol_version": 2, "host_version": "6.915.1",
        "locale": "zh", "theme": "light", "plugin_root": data, "data_dir": data}),
    )
}

fn protocol(messages: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_notemd-apple-notes"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for message in messages {
        writeln!(input, "{message}").unwrap();
    }
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("plugin did not shut down within 5 seconds");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn result(messages: &[Value], id: u64) -> &Value {
    let reply = messages
        .iter()
        .find(|value| value["id"] == id && value.get("method").is_none())
        .unwrap();
    assert!(reply.get("error").is_none(), "{reply}");
    &reply["result"]
}

#[test]
fn manifest_validates_and_exposes_only_mac_binaries() {
    let manifest: notemd_plugin_sdk::plugin_protocol::ManifestV2 =
        serde_json::from_str(include_str!("../../manifest.v2.json")).unwrap();
    notemd_plugin_sdk::plugin_protocol::validate_manifest(&manifest, "6.915.1").unwrap();
    assert_eq!(manifest.binary.len(), 2);
    assert!(manifest
        .binary
        .keys()
        .all(|target| target.ends_with("apple-darwin")));
}

#[test]
fn cli_activation_never_creates_global_plugin_state() {
    let data = tempfile::tempdir().unwrap();
    let output = protocol(&[
        initialize(data.path()),
        request(2, "$activate", json!({"event": "onCli:apple-notes-sync"})),
        request(
            3,
            "ui.request",
            json!({"method": "plugin.status", "params": {}}),
        ),
        request(4, "$deactivate", json!({})),
    ]);
    assert_eq!(result(&output, 3)["auto_sync"], false);
    assert_eq!(result(&output, 3)["running"], false);
    assert_eq!(result(&output, 3)["ready"], false);
    assert!(!data.path().join("state.json").exists());
    assert!(
        !output
            .iter()
            .any(|value| value["method"] == "host.vault.info"),
        "CLI activation must never start automatic sync"
    );
}

#[test]
fn cli_ndjson_returns_rpc_failure_for_invalid_vault_without_touching_notes() {
    let data = tempfile::tempdir().unwrap();
    let missing = data.path().join("missing-vault");
    let output = protocol(&[
        initialize(data.path()),
        request(2, "$activate", json!({"event": "onCli:apple-notes-sync"})),
        request(
            3,
            "command.execute",
            json!({"command": "sync", "context": {"cli": {"flags": {"vault": missing, "dry-run": true}}}}),
        ),
        request(4, "$deactivate", json!({})),
    ]);
    let reply = output.iter().find(|value| value["id"] == 3).unwrap();
    assert_eq!(reply["error"]["code"], -32000);
    assert!(!missing.exists());
    assert!(!output
        .iter()
        .any(|value| value["method"] == "host.vault.info"));
}

#[test]
fn standalone_cli_emits_json_and_nonzero_exit_on_bad_input() {
    let output = Command::new(env!("CARGO_BIN_EXE_notemd-apple-notes"))
        .args(["sync", "--dry-run"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let json: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["ok"], false);
    assert!(json["error"].as_str().unwrap().contains("--vault"));
}

#[cfg(unix)]
#[test]
fn closed_stdout_preserves_cli_exit_code_without_panicking() {
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    let (reader, writer) = UnixStream::pair().unwrap();
    drop(reader);
    let output = Command::new(env!("CARGO_BIN_EXE_notemd-apple-notes"))
        .args(["sync", "--dry-run"])
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("panicked"));
}
