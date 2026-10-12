//! Exercise the real SDK command entry and detached executable, with a fake
//! provider (no model/network). The temporary CLI host exits before completion.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    vault: PathBuf,
    config: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let vault = temp.path().join("vault");
        std::fs::create_dir_all(vault.join("agent-sessions")).unwrap();
        std::fs::write(vault.join("agent-sessions/one.md"), "# Test\n\n- Started: 2026-09-20 10:00\n- Ended: 2026-09-20 10:30\n- Model: codex\n- User turns: 1\n\n---\n\n## 👤 User\n请核对这个结果。\n## 🤖 Codex\n已检查。\n").unwrap();
        let plugins = home.join("Library/Application Support/net.notemd.app/plugins");
        let provider = plugins.join("notemd.codex-agent/current");
        std::fs::create_dir_all(provider.join("bin")).unwrap();
        std::fs::write(
            plugins.join("state.json"),
            serde_json::to_vec(
                &json!({"installed":{"notemd.codex-agent":{"enabled":true,"version":"1.0.19"}}}),
            )
            .unwrap(),
        )
        .unwrap();
        std::fs::write(provider.join("manifest.json"), serde_json::to_vec(&json!({"manifest_version":2,"id":"notemd.codex-agent","name":"Fake Codex","activation":{"events":["onCommand:harness-status","onCommand:run-task","onCommand:run-status"]},"contributes":{},"capabilities":[],"version":"1.0.19","kind":"native","binary":{"aarch64-apple-darwin":"bin/provider","x86_64-apple-darwin":"bin/provider","x86_64-unknown-linux-gnu":"bin/provider"},"engines":{"notemd":">=6.905.6"}})).unwrap()).unwrap();
        let binary = provider.join("bin/provider");
        std::fs::write(&binary, r#"#!/usr/bin/python3
import json, sys
for line in sys.stdin:
    req=json.loads(line)
    if 'id' not in req: continue
    method=req.get('method')
    p=req.get('params', {})
    result={'ok':True}
    if method=='command.execute':
        cmd=p.get('command')
        if cmd=='harness-status':
            result={'ok':True,'capabilities':{'terminal_result':True,'input_only_isolation':True,'tasks':['agency-observe-v1']}}
        elif cmd=='run-task':
            result={'run_id':'fake-run'}
        elif cmd=='run-status':
            result={'state':'done','record':{'status':'failed'}}
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}), flush=True)
    if method=='$deactivate': break
"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let config = temp.path().join("shared.json");
        std::fs::write(
            &config,
            serde_json::to_vec(&json!({"version":1,"sotvault":vault})).unwrap(),
        )
        .unwrap();
        Self {
            _temp: temp,
            home,
            vault,
            config,
        }
    }
    fn command(&self, action: &str, flags: Value) -> Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_notemd-agency"))
            .env("HOME", &self.home)
            .env("NOTEMD_SHARED_CONFIG", &self.config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let requests = [
            json!({"jsonrpc":"2.0","id":1,"method":"$initialize","params":{"protocol_version":2,"host_version":"6.923.0","locale":"zh","theme":"light","plugin_root":"/unused","data_dir":"/unused"}}),
            json!({"jsonrpc":"2.0","id":2,"method":"$activate","params":{"event":"onCli:agency"}}),
            json!({"jsonrpc":"2.0","id":3,"method":"command.execute","params":{"command":"agency","context":{"cli":{"args":{"action":action},"flags":flags}}}}),
        ];
        let mut response = Value::Null;
        for request in requests {
            writeln!(input, "{request}").unwrap();
            input.flush().unwrap();
            loop {
                let mut line = String::new();
                assert!(
                    output.read_line(&mut line).unwrap() > 0,
                    "CLI unexpectedly exited"
                );
                let value: Value = serde_json::from_str(&line).unwrap();
                if value.get("id") == request.get("id") && value.get("method").is_none() {
                    response = value;
                    break;
                }
            }
        }
        drop(input); // The actual temporary CLI host is gone after this point.
        assert!(child.wait().unwrap().success());
        response
    }
    fn job(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.vault.join(".notemd/agency/job.json")).unwrap())
            .unwrap()
    }
    fn wait(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let value = self.job();
            if predicate(&value) {
                return value;
            }
            assert!(Instant::now() < deadline, "timed out, job={value}");
            std::thread::sleep(Duration::from_millis(30));
        }
    }
}

#[test]
fn detached_queue_outlives_cli_and_continues_after_an_ordinary_day_failure() {
    let fixture = Fixture::new();
    let start = fixture.command("run", json!({"from":"2026-09-20","to":"2026-09-21"}));
    assert!(start.get("error").is_none(), "{start}");
    assert_eq!(start["result"]["background"], true);
    assert_eq!(start["result"]["state"], "running");
    let done = fixture.wait(|job| job["state"] != "running");
    assert_eq!(done["items"][0]["state"], "failed");
    assert_eq!(done["items"][1]["state"], "skipped");
    assert_eq!(done["id"], start["result"]["id"]);
    assert!(!Path::new(&fixture.vault.join(".notemd/agency/state.json")).exists());
}

#[test]
fn second_cli_cannot_replace_running_queue_and_can_stop_pending_dates() {
    let fixture = Fixture::new();
    let flags = json!({"from":"2026-09-20","to":"2026-09-22"});
    let start = fixture.command("run", flags.clone());
    assert!(start.get("error").is_none(), "{start}");
    fixture.wait(|job| job["run_id"] == "fake-run");
    let duplicate = fixture.command("run", flags);
    assert!(duplicate.get("error").is_some(), "{duplicate}");
    let stop = fixture.command("stop", json!({}));
    assert_eq!(stop["result"]["stop_requested"], true);
    let done = fixture.wait(|job| job["state"] != "running");
    assert_eq!(done["id"], start["result"]["id"]);
    assert_eq!(done["state"], "cancelled");
    assert_eq!(done["items"][0]["state"], "failed");
    assert_eq!(done["items"][1]["state"], "cancelled");
    assert_eq!(done["items"][2]["state"], "cancelled");
}
