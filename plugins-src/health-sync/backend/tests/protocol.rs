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
fn garmin_zip_command_and_ui_require_region_before_accessing_files_or_state() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let vault = root.join("untouched-vault");
    let state = root.join("untouched-state");
    let output = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", &state)
        .args(["health-garmin-import", "missing.zip", "--vault"])
        .arg(&vault)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(response["error"].as_str().unwrap().contains("region"));
    let mut process = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", &state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"$activate","params":{"event":"onCli:health-garmin-import"}}),
        json!({"jsonrpc":"2.0","id":2,"method":"command.execute","params":{"command":"garmin-import","context":{"cli":{"args":{"file":"missing.zip"},"flags":{"vault":vault,"region":"invalid"}}}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"ui.request","params":{"method":"garmin-import","params":{"vault":vault,"file":"missing.zip","region":false}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"$deactivate","params":{}}),
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
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    for id in [2, 3] {
        let response = lines.iter().find(|value| value["id"] == id).unwrap();
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("region"));
    }
    assert!(!vault.exists());
    assert!(!state.exists());
}

#[test]
fn garmin_zip_command_preview_and_ui_import_share_identity_payload_and_saved_archive() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let vault = root.join("vault");
    let state = root.join("state");
    fs::create_dir(&vault).unwrap();
    let export = root.join("佳明历史导出.zip");
    let profile =
        serde_json::to_vec(&json!({"userProfilePk":42,"preferences":{"language":"zh"}})).unwrap();
    let activity = json!({
        "activityId":7,"ownerId":42,"startTimeLocal":1735689600000_i64,
        "distance":123.5,"nested":{"preserve":[1,"two",null,{"unicode":"运动"}]}
    });
    let activities =
        serde_json::to_vec(&json!([{"summarizedActivitiesExport":[activity]}])).unwrap();
    let mut zip = zip::ZipWriter::new(fs::File::create(&export).unwrap());
    for (name, bytes) in [
        ("本地化根目录/个人资料.JSON", &profile),
        ("任意文件夹/运动记录.json", &activities),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
    let original_zip = fs::read(&export).unwrap();
    let account = notemd_health_sync::auth::account_id_for_subject("garmin:china:42");
    let mut process = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", &state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"$activate","params":{"event":"onCli:health-garmin-import"}}),
        json!({"jsonrpc":"2.0","id":2,"method":"command.execute","params":{"command":"garmin-import","context":{"cli":{"args":{"file":export},"flags":{"vault":vault,"region":"china","dry-run":true}}}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"ui.request","params":{"method":"catalog","params":{"vault":vault}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"ui.request","params":{"method":"garmin-import","params":{"vault":vault,"file":export,"region":"china","dry_run":false}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"command.execute","params":{"command":"query","context":{"cli":{"flags":{"vault":vault,"source":"garmin","account":account,"metric":"garmin.export_activities"}}}}}),
        json!({"jsonrpc":"2.0","id":6,"method":"ui.request","params":{"method":"query","params":{"vault":vault,"source":"garmin","account_id":account,"metric":"garmin.export_files"}}}),
        json!({"jsonrpc":"2.0","id":7,"method":"ui.request","params":{"method":"catalog","params":{"vault":vault}}}),
        json!({"jsonrpc":"2.0","id":8,"method":"$deactivate","params":{}}),
    ];
    let mut stdin = process.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(
        lines.iter().all(|value| value["error"].is_null()),
        "{lines:?}"
    );
    let reply = |id: u64| &lines.iter().find(|value| value["id"] == id).unwrap()["result"];
    for id in [2, 4] {
        assert_eq!(reply(id)["account_id"], account);
        assert_eq!(reply(id)["complete"], true);
        assert_eq!(reply(id)["records"], 1);
        assert_eq!(reply(id)["files"], 2);
        assert_eq!(reply(id)["region"], "china");
        assert_eq!(
            reply(id)["date_range"],
            json!({"since":"2025-01-01","until":"2025-01-01"})
        );
    }
    assert_eq!(reply(2)["dry_run"], true);
    assert_eq!(reply(3), &json!({"categories":[],"sources":{}}));
    assert_eq!(reply(4)["dry_run"], false);
    let records = reply(5)["records"].as_array().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["payload"], activity);
    assert_eq!(records[0]["attributes"]["accountId"], account);
    assert_eq!(records[0]["day"], "2025-01-01");
    let files = reply(6)["records"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    let mut saved = files
        .iter()
        .map(|file| {
            assert_eq!(file["attributes"]["accountId"], account);
            fs::read(vault.join(file["payload"]["attachment_path"].as_str().unwrap())).unwrap()
        })
        .collect::<Vec<_>>();
    saved.sort();
    let mut expected = vec![profile, activities];
    expected.sort();
    assert_eq!(saved, expected);
    assert_eq!(
        reply(7)["sources"]["garmin"]["accounts"][&account]["collections"]["export_activities"]
            ["observed_days"],
        1
    );
    let manifest: Value =
        serde_json::from_slice(&fs::read(vault.join("health/manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["schema_version"], 3);
    assert_eq!(
        manifest["sources"]["garmin"]["accounts"][&account]["garmin_region"],
        "china"
    );
    assert_eq!(fs::read(export).unwrap(), original_zip);
    // Offline import creates only the archive lock, never API account or cursor state.
    let local = state.join(notemd_health_sync::store::hash(
        vault.to_string_lossy().as_bytes(),
    ));
    let state_files = fs::read_dir(local)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(state_files, [std::ffi::OsString::from("write.lock")]);
}

#[test]
fn manifest_passes_real_host_contract() {
    use notemd_plugin_sdk::plugin_protocol::{validate_manifest, ManifestV2};
    let manifest: ManifestV2 =
        serde_json::from_str(include_str!("../../manifest.v2.json")).unwrap();
    validate_manifest(&manifest, "6.921.2").unwrap();
    for name in [
        "health-import",
        "health-garmin-import",
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
