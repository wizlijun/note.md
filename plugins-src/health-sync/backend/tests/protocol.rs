use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_notemd-health-sync"))
}

#[test]
fn standalone_credentials_stdin_passes_region_to_validation_before_network() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::create_dir(root.join("vault")).unwrap();
    let mut child = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", root.join("state"))
        .args([
            "connect",
            "--source",
            "garmin",
            "--credentials-stdin",
            "--vault",
        ])
        .arg(root.join("vault"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"api_key":"synthetic","region":"invalid-region","label":"Old watch"}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(response["error"].as_str().unwrap().contains("region"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic"));
    assert!(fs::read_dir(root.join("vault")).unwrap().next().is_none());
}

#[test]
fn manifest_passes_real_host_contract() {
    use notemd_plugin_sdk::plugin_protocol::{validate_manifest, ManifestV2};
    let manifest: ManifestV2 =
        serde_json::from_str(include_str!("../../manifest.v2.json")).unwrap();
    validate_manifest(&manifest, "6.921.2").unwrap();
    for name in [
        "health-import",
        "health-sync",
        "health-status",
        "health-query",
        "health-catalog",
        "health-disconnect",
    ] {
        assert!(manifest
            .contributes
            .cli
            .iter()
            .any(|c| c["subcommand"] == name));
    }
    assert!(manifest
        .contributes
        .cli
        .iter()
        .all(|c| c["requires_tab_context"] == false));
}

#[test]
fn standalone_cli_and_real_stdio_use_same_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let fixture_root = temp.path().canonicalize().unwrap();
    let vault = fixture_root.join("vault");
    fs::create_dir(&vault).unwrap();
    let export = fixture_root.join("export.xml");
    fs::write(&export,"<HealthData><ExportDate value=\"2026-10-24 09:00:00 +0900\"/><Record type=\"HeartRate\" startDate=\"2026-10-01 01:00:00 +0900\" value=\"60\"/></HealthData>").unwrap();
    let result = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", fixture_root.join("state"))
        .arg("health-import")
        .arg(&export)
        .arg("--vault")
        .arg(&vault)
        .arg("--json")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    let imported: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(imported["data"]["record_count"], 1);
    let mut process = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", fixture_root.join("state"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"$activate","params":{"event":"onCli:health-status"}}),
        json!({"jsonrpc":"2.0","id":2,"method":"command.execute","params":{"command":"status","context":{"cli":{"flags":{"vault":vault}}}}}),
        // Actual UI forwarding strips the plugin. prefix.
        json!({"jsonrpc":"2.0","id":3,"method":"ui.request","params":{"method":"query","params":{"vault":vault,"limit":1}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"command.execute","params":{"command":"sync","context":{"cli":{"flags":{"vault":vault,"source":"apple-health"}}}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"$deactivate","params":{}}),
    ];
    let mut stdin = process.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = process.wait_with_output().unwrap();
    assert!(output.status.success());
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let reply = |id: u64| lines.iter().find(|v| v["id"] == id).unwrap();
    assert_eq!(reply(2)["result"]["imported"], true);
    assert_eq!(
        reply(3)["result"]["records"][0]["attributes"]["value"],
        "60"
    );
    assert_eq!(reply(4)["result"]["data_changed"], false);
    assert!(lines.iter().all(|v| v["error"].is_null()));
}

#[test]
fn cli_has_nonzero_validation_and_partial_completion_exit_codes() {
    let bad = binary()
        .args(["health-query", "--limit", "0"])
        .output()
        .unwrap();
    assert_eq!(bad.status.code(), Some(2));
    let temp = tempfile::tempdir().unwrap();
    let fixture_root = temp.path().canonicalize().unwrap();
    let vault = fixture_root.join("vault");
    fs::create_dir(&vault).unwrap();
    let export = fixture_root.join("export.xml");
    fs::write(&export,"<HealthData><ExportDate value=\"2026-10-24 09:00:00 +0900\"/><Record startDate=\"2026-10-01\"/></HealthData>").unwrap();
    assert!(binary()
        .env("NOTEMD_HEALTH_STATE_DIR", fixture_root.join("state"))
        .arg("health-import")
        .arg(&export)
        .arg("--vault")
        .arg(&vault)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(vault.join("health/daily/2026-10-01-health.md"), "human").unwrap();
    let partial = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", fixture_root.join("state"))
        .arg("health-sync")
        .args(["--source", "apple-health"])
        .arg("--vault")
        .arg(&vault)
        .output()
        .unwrap();
    assert_eq!(partial.status.code(), Some(4));
    let result: Value = serde_json::from_slice(&partial.stdout).unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(
        result["data"]["summary_conflicts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn explicit_file_sync_previews_before_first_import_and_preserves_remembered_source() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = temp.path().canonicalize().unwrap();
    let vault = fixture.join("vault");
    fs::create_dir(&vault).unwrap();
    let export = fixture.join("导出.xml");
    fs::write(&export, r#"<HealthData><ExportDate value="2026-10-24 09:00:00 +0900"/><Record type="HeartRate" startDate="2026-10-01" value="60"/></HealthData>"#).unwrap();
    let run = |args: &[&str]| {
        binary()
            .env("NOTEMD_HEALTH_STATE_DIR", fixture.join("state"))
            .args(args)
            .arg("--vault")
            .arg(&vault)
            .output()
            .unwrap()
    };
    for source in ["apple-health", "all"] {
        let result = run(&[
            "health-sync",
            "--source",
            source,
            "--file",
            export.to_str().unwrap(),
            "--dry-run",
        ]);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
        assert!(!vault.join("health/manifest.json").exists());
        let status: Value = serde_json::from_slice(&run(&["health-status"]).stdout).unwrap();
        assert!(status["data"]["source_file"].is_null());
    }
    assert!(run(&[
        "health-sync",
        "--source",
        "apple-health",
        "--file",
        export.to_str().unwrap()
    ])
    .status
    .success());
    let before = fs::read(vault.join("health/manifest.json")).unwrap();
    let replacement = fixture.join("new.xml");
    fs::write(
        &replacement,
        r#"<HealthData><ExportDate value="2026-10-24 10:00:00 +0900"/></HealthData>"#,
    )
    .unwrap();
    assert!(run(&[
        "health-sync",
        "--source",
        "apple-health",
        "--file",
        replacement.to_str().unwrap(),
        "--dry-run"
    ])
    .status
    .success());
    assert_eq!(
        fs::read(vault.join("health/manifest.json")).unwrap(),
        before
    );
    let status: Value = serde_json::from_slice(&run(&["health-status"]).stdout).unwrap();
    assert_eq!(status["data"]["source_file"], export.to_str().unwrap());
    assert!(!run(&[
        "health-sync",
        "--source",
        "apple-health",
        "--file",
        "/missing/health.xml",
        "--dry-run"
    ])
    .status
    .success());
    let resumed = run(&["health-sync", "--source", "apple-health"]);
    assert!(resumed.status.success());
    let report: Value = serde_json::from_slice(&resumed.stdout).unwrap();
    assert_eq!(report["data"]["record_count"], 1);
}
