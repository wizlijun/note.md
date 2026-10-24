use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_notemd-health-sync"))
}

fn initialize(root: &Path) -> PathBuf {
    let library = root.join("library");
    fs::create_dir(&library).unwrap();
    let output = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", root.join("state"))
        .args(["health-init", "--path"])
        .arg(&library)
        .arg("--vault")
        .arg(root.join("vault"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["data"]["configured"], true);
    assert_eq!(reply["data"]["available"], true);
    library
}

fn database_snapshot(library: &Path) -> (Vec<u8>, std::time::SystemTime) {
    let path = library.join("health.sqlite");
    (
        fs::read(&path).unwrap(),
        fs::metadata(path).unwrap().modified().unwrap(),
    )
}
fn assert_initialized_empty(library: &Path) {
    let db = rusqlite::Connection::open_with_flags(
        library.join("health.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM records", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

fn assert_sqlite_only(library: &Path, vault: &Path) {
    assert!(
        fs::read_dir(vault).unwrap().next().is_none(),
        "raw data or default report leaked into Vault"
    );
    assert!(library.join("health.sqlite").is_file());
    fn visit(path: &Path) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(&path);
            } else {
                let name = path.file_name().unwrap().to_string_lossy();
                assert!(
                    name != "manifest.json"
                        && !name.ends_with(".jsonl")
                        && !name.ends_with("-health.md"),
                    "unexpected machine shard/report: {}",
                    path.display()
                );
            }
        }
    }
    visit(library);
}

#[test]
fn standalone_credentials_stdin_passes_region_to_validation_before_network() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::create_dir(root.join("vault")).unwrap();
    initialize(&root);
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
    let library = initialize(&root);
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
            fs::read(library.join(file["payload"]["attachment_path"].as_str().unwrap())).unwrap()
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
    assert_sqlite_only(&library, &vault);
    let db = rusqlite::Connection::open(library.join("health.sqlite")).unwrap();
    let region: String = db
        .query_row(
            "SELECT region FROM accounts WHERE source='garmin' AND account_id=?1",
            [&account],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&region).unwrap(), "china");
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(fs::read(export).unwrap(), original_zip);
    // Offline import saves location configuration only; no API credentials or cursor state.
    let local = state.join(notemd_health_sync::store::hash(
        vault.to_string_lossy().as_bytes(),
    ));
    let state_files = fs::read_dir(local)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(state_files, [std::ffi::OsString::from("library.json")]);
}

#[test]
fn manifest_passes_real_host_contract() {
    use notemd_plugin_sdk::plugin_protocol::{validate_manifest, ManifestV2};
    let manifest: ManifestV2 =
        serde_json::from_str(include_str!("../../manifest.v2.json")).unwrap();
    validate_manifest(&manifest, "6.921.2").unwrap();
    for name in [
        "health-init",
        "health-storage",
        "health-import",
        "health-garmin-import",
        "health-oura-import",
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
fn standalone_cli_and_real_stdio_use_same_external_sqlite_records() {
    let temp = tempfile::tempdir().unwrap();
    let fixture_root = temp.path().canonicalize().unwrap();
    let vault = fixture_root.join("vault");
    fs::create_dir(&vault).unwrap();
    let library = initialize(&fixture_root);
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
        json!({"jsonrpc":"2.0","id":4,"method":"command.execute","params":{"command":"import","context":{"cli":{"args":{"file":export},"flags":{"vault":vault}}}}}),
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
    assert_eq!(reply(2)["result"]["summary"]["record_count"], 1);
    assert_eq!(reply(2)["result"]["summary"]["schema_version"], 1);
    assert_eq!(reply(2)["result"]["summary"]["scope"], "raw-library");
    assert!(reply(2)["result"]["manifest"].is_null());
    assert_eq!(
        reply(3)["result"]["records"][0]["attributes"]["value"],
        "60"
    );
    assert_eq!(reply(4)["result"]["data_changed"], false);
    assert!(lines.iter().all(|v| v["error"].is_null()));
    assert_sqlite_only(&library, &vault);
}

#[test]
fn cli_validation_and_backend_errors_leave_external_records_unchanged() {
    let bad = binary()
        .args(["health-query", "--limit", "0"])
        .output()
        .unwrap();
    assert_eq!(bad.status.code(), Some(2));
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let vault = root.join("vault");
    fs::create_dir(&vault).unwrap();
    let library = initialize(&root);
    let export = root.join("export.xml");
    fs::write(
        &export,
        r#"<HealthData><ExportDate value="2026-10-24 09:00:00 +0900"/><Record type="HeartRate" startDate="2026-10-01" value="60"/></HealthData>"#,
    )
    .unwrap();
    let run = |args: &[&str]| {
        binary()
            .env("NOTEMD_HEALTH_STATE_DIR", root.join("state"))
            .args(args)
            .arg("--vault")
            .arg(&vault)
            .output()
            .unwrap()
    };
    assert!(run(&["health-import", export.to_str().unwrap()])
        .status
        .success());
    let before = fs::read(library.join("health.sqlite")).unwrap();
    let bad_xml = root.join("invalid.xml");
    fs::write(&bad_xml, "not XML").unwrap();
    let failed = run(&["health-import", bad_xml.to_str().unwrap()]);
    assert_eq!(failed.status.code(), Some(1));
    let reply: Value = serde_json::from_slice(&failed.stdout).unwrap();
    assert_eq!(reply["ok"], false);
    assert!(reply["error"].is_string());
    assert_eq!(fs::read(library.join("health.sqlite")).unwrap(), before);
    assert_sqlite_only(&library, &vault);
}

#[test]
fn explicit_apple_file_preview_is_readonly_and_api_sync_rejects_apple_or_file() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = temp.path().canonicalize().unwrap();
    let vault = fixture.join("vault");
    fs::create_dir(&vault).unwrap();
    let library = initialize(&fixture);
    let initialized = database_snapshot(&library);
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
    let preview = run(&["health-import", export.to_str().unwrap(), "--dry-run"]);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stdout)
    );
    assert_initialized_empty(&library);
    assert_eq!(database_snapshot(&library), initialized);
    let status: Value = serde_json::from_slice(&run(&["health-status"]).stdout).unwrap();
    assert_eq!(status["data"]["imported"], false);
    assert!(status["data"]["source_file"].is_null());
    assert!(run(&["health-import", export.to_str().unwrap()])
        .status
        .success());
    let before = fs::read(library.join("health.sqlite")).unwrap();
    let replacement = fixture.join("new.xml");
    fs::write(
        &replacement,
        r#"<HealthData><ExportDate value="2026-10-24 10:00:00 +0900"/><Record type="HeartRate" startDate="2026-10-02" value="70"/></HealthData>"#,
    )
    .unwrap();
    assert!(
        run(&["health-import", replacement.to_str().unwrap(), "--dry-run"])
            .status
            .success()
    );
    assert_eq!(fs::read(library.join("health.sqlite")).unwrap(), before);
    let status: Value = serde_json::from_slice(&run(&["health-status"]).stdout).unwrap();
    assert_eq!(status["data"]["source_file"], export.to_str().unwrap());
    for args in [
        vec!["health-sync", "--source", "apple-health"],
        vec![
            "health-sync",
            "--source",
            "all",
            "--file",
            export.to_str().unwrap(),
        ],
        vec![
            "health-sync",
            "--file",
            export.to_str().unwrap(),
            "--dry-run",
        ],
    ] {
        let result = run(&args);
        assert_eq!(
            result.status.code(),
            Some(2),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }
    assert_eq!(fs::read(library.join("health.sqlite")).unwrap(), before);
    // A later export merges records instead of replacing the prior snapshot.
    assert!(run(&["health-import", replacement.to_str().unwrap()])
        .status
        .success());
    let result: Value =
        serde_json::from_slice(&run(&["health-query", "--source", "apple-health"]).stdout).unwrap();
    assert_eq!(result["data"]["records"].as_array().unwrap().len(), 2);
    assert_sqlite_only(&library, &vault);
}

#[test]
fn first_use_cli_status_is_readonly_and_init_rejects_vault_locations() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let vault = root.join("vault");
    fs::create_dir(&vault).unwrap();
    let state = root.join("state");
    let run = |args: &[&str]| {
        binary()
            .env("NOTEMD_HEALTH_STATE_DIR", &state)
            .args(args)
            .arg("--vault")
            .arg(&vault)
            .output()
            .unwrap()
    };
    let output = run(&["health-status"]);
    assert!(output.status.success());
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["data"]["storage"]["configured"], false);
    assert_eq!(reply["data"]["imported"], false);
    assert!(!state.exists());
    assert!(fs::read_dir(&vault).unwrap().next().is_none());
    let import = run(&["health-import", "missing.xml"]);
    assert_eq!(import.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&import.stdout).contains("outside the Vault"));
    let child = vault.join("health");
    fs::create_dir(&child).unwrap();
    let mut invalid = vec![vault.clone(), child.clone(), root.clone()];
    #[cfg(unix)]
    {
        let alias = root.join("alias-vault");
        std::os::unix::fs::symlink(&child, &alias).unwrap();
        invalid.push(alias);
    }
    for path in invalid {
        let rejected = run(&["health-init", "--path", path.to_str().unwrap()]);
        assert_eq!(rejected.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&rejected.stdout).contains("outside the Vault"));
        assert!(!state.exists());
        assert!(!path.join(".notemd-health-library").exists());
    }
    fs::remove_dir(&child).unwrap();
    let library = initialize(&root);
    fs::rename(&library, root.join("offline-library")).unwrap();
    let unavailable: Value = serde_json::from_slice(&run(&["health-storage"]).stdout).unwrap();
    assert_eq!(unavailable["data"]["configured"], true);
    assert_eq!(unavailable["data"]["available"], false);
    assert_eq!(unavailable["data"]["path"], library.to_str().unwrap());
    assert_eq!(run(&["health-query"]).status.code(), Some(1));
    assert!(!library.exists());
    assert!(fs::read_dir(&vault).unwrap().next().is_none());
}

#[test]
fn oura_cli_profile_preview_import_and_stdio_account_query_share_explicit_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let vault = root.join("vault");
    fs::create_dir(&vault).unwrap();
    let state = root.join("state");
    let run = |args: &[&str]| {
        binary()
            .env("NOTEMD_HEALTH_STATE_DIR", &state)
            .args(args)
            .arg("--vault")
            .arg(&vault)
            .output()
            .unwrap()
    };
    // Invalid identity combinations fail during argument validation, before file/state access.
    for args in [
        vec!["health-oura-import", "missing.csv"],
        vec![
            "health-oura-import",
            "missing.csv",
            "--profile",
            "old",
            "--account",
            "abc",
        ],
        vec!["health-oura-import", "missing.csv", "--profile", "   "],
    ] {
        assert_eq!(run(&args).status.code(), Some(2));
        assert!(!state.exists());
    }
    let library = initialize(&root);
    let initialized = database_snapshot(&library);
    let export = root.join("戒指数据.csv");
    let bytes = "id,day,active_calories,steps,label\r\nx,2026-10-24,100.010,123,\"line one,\nline two\"\r\n";
    fs::write(&export, bytes).unwrap();
    let unknown = notemd_health_sync::store::hash(b"unknown-oura-account");
    let rejected = run(&[
        "health-oura-import",
        export.to_str().unwrap(),
        "--account",
        &unknown,
        "--dry-run",
    ]);
    assert_eq!(rejected.status.code(), Some(1));
    let rejected: Value = serde_json::from_slice(&rejected.stdout).unwrap();
    assert!(rejected["error"]
        .as_str()
        .unwrap()
        .to_lowercase()
        .contains("account"));
    assert_initialized_empty(&library);
    assert_eq!(database_snapshot(&library), initialized);
    let profile = "Retired Oura";
    let account = notemd_health_sync::store::hash(format!("oura:offline:{profile}").as_bytes());
    let preview = run(&[
        "health-oura-import",
        export.to_str().unwrap(),
        "--profile",
        profile,
        "--dry-run",
    ]);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stdout)
    );
    assert_initialized_empty(&library);
    assert_eq!(database_snapshot(&library), initialized);
    let preview: Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(preview["data"]["account_id"], account);
    assert_eq!(preview["data"]["records"], 1);
    let imported = run(&[
        "health-oura-import",
        export.to_str().unwrap(),
        "--profile",
        profile,
    ]);
    assert!(
        imported.status.success(),
        "{}",
        String::from_utf8_lossy(&imported.stdout)
    );
    let mut process = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", &state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"$activate","params":{"event":"onCli:health-oura-import"}}),
        json!({"jsonrpc":"2.0","id":2,"method":"ui.request","params":{"method":"oura-import","params":{"vault":vault,"file":export,"account_id":account,"dry_run":true}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"command.execute","params":{"command":"query","context":{"cli":{"flags":{"vault":vault,"source":"oura","account":account,"metric":"oura.export_daily_activity"}}}}}),
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
    assert!(lines.iter().all(|v| v["error"].is_null()), "{lines:?}");
    let reply = |id: u64| &lines.iter().find(|value| value["id"] == id).unwrap()["result"];
    assert_eq!(reply(2)["account_id"], account);
    let records = reply(3)["records"].as_array().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["attributes"]["accountId"], account);
    assert_eq!(records[0]["payload"]["active_calories"], "100.010");
    assert_eq!(records[0]["payload"]["label"], "line one,\nline two");
    assert_eq!(fs::read(export).unwrap(), bytes.as_bytes());
    assert_sqlite_only(&library, &vault);
}

#[test]
fn real_ui_protocol_initializes_external_storage_without_accessing_vault_records() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let vault = root.join("vault");
    let library = root.join("library");
    let state = root.join("state");
    fs::create_dir(&vault).unwrap();
    fs::create_dir(&library).unwrap();
    let mut process = binary()
        .env("NOTEMD_HEALTH_STATE_DIR", &state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"$activate","params":{"event":"onView:health-sync"}}),
        json!({"jsonrpc":"2.0","id":2,"method":"ui.request","params":{"method":"storage_status","params":{"vault":vault}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"ui.request","params":{"method":"configure_storage","params":{"vault":vault,"path":vault}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"ui.request","params":{"method":"configure_storage","params":{"vault":vault,"path":library}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"ui.request","params":{"method":"storage_status","params":{"vault":vault}}}),
        json!({"jsonrpc":"2.0","id":6,"method":"ui.request","params":{"method":"catalog","params":{"vault":vault}}}),
        json!({"jsonrpc":"2.0","id":7,"method":"$deactivate","params":{}}),
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
    let reply = |id: u64| lines.iter().find(|value| value["id"] == id).unwrap();
    assert_eq!(reply(2)["result"]["configured"], false);
    assert!(reply(3)["error"]["message"]
        .as_str()
        .unwrap()
        .contains("outside the Vault"));
    for id in [4, 5] {
        assert_eq!(reply(id)["result"]["configured"], true);
        assert_eq!(reply(id)["result"]["available"], true);
        assert_eq!(reply(id)["result"]["path"], library.to_str().unwrap());
    }
    assert_eq!(reply(6)["result"], json!({"categories":[],"sources":{}}));
    assert!(fs::read_dir(&vault).unwrap().next().is_none());
    assert_initialized_empty(&library);
}
