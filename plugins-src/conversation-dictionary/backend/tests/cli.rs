use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

struct PluginProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl PluginProcess {
    fn start(vault: &std::path::Path) -> Self {
        let shared = vault.join("shared.json");
        std::fs::write(
            &shared,
            serde_json::to_vec(&json!({"sotvault":vault})).unwrap(),
        )
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_notemd-conversation-dictionary"))
            .env("NOTEMD_SHARED_CONFIG", shared)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            next_id: 1,
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let line = serde_json::to_string(
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )
        .unwrap();
        writeln!(self.stdin.as_mut().unwrap(), "{line}").unwrap();
        self.stdin.as_mut().unwrap().flush().unwrap();
        loop {
            let mut output = String::new();
            self.stdout.read_line(&mut output).unwrap();
            assert!(!output.is_empty(), "plugin closed before response");
            let value: Value = serde_json::from_str(&output).unwrap();
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                return value;
            }
        }
    }

    fn close_and_wait(mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if self.child.try_wait().unwrap().is_some() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "plugin did not exit after stdin EOF"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn cli_status_is_structured_and_cli_cannot_approve() {
    let vault = tempfile::tempdir().unwrap();
    let mut plugin = PluginProcess::start(vault.path());
    assert_eq!(
        plugin.request(
            "$initialize",
            json!({
                "protocol_version":2,"host_version":"6.916.1","locale":"zh-TW","theme":"light",
                "plugin_root":"/tmp/plugin","data_dir":"/tmp/data"
            })
        )["result"]["ok"],
        true
    );
    assert_eq!(
        plugin.request(
            "$activate",
            json!({"event":"onCli:conversation-dictionary"})
        )["result"]["ok"],
        true
    );
    let status = plugin.request(
        "command.execute",
        json!({
            "command":"conversation-dictionary",
            "context":{"cli":{"args":{"action":"status"},"flags":{}}}
        }),
    );
    assert_eq!(status["result"]["__notemd_cli_result"]["exit_code"], 0);
    assert_eq!(
        status["result"]["__notemd_cli_result"]["data"]["status"],
        "not_created"
    );
    assert!(!vault
        .path()
        .join("ssot/meetings/conversation-dictionary.yml")
        .exists());
    assert!(!vault.path().join("AGENTS.md").exists());
    assert!(!vault
        .path()
        .join(".agents/skills/build-conversation-dictionary")
        .exists());
    let forbidden = plugin.request(
        "command.execute",
        json!({
            "command":"conversation-dictionary",
            "context":{"cli":{"args":{"action":"approve"},"flags":{"human":"true"}}}
        }),
    );
    assert!(forbidden["error"]["message"]
        .as_str()
        .unwrap()
        .contains("only available"));
    plugin.close_and_wait();
}
