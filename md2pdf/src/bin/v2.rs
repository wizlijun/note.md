//! md2pdf v2 plugin: long-running JSON-RPC service. Each export spawns the
//! sibling v1 binary (`md2pdf`) which owns the main-thread WKWebView render
//! loop — the proven v1 path, one pristine process per export.

use notemd_plugin_sdk::{self as sdk, NotemdPlugin};
use serde_json::{json, Value};

struct Md2PdfV2 {
    v1_bin: std::path::PathBuf,
}

/// Last `limit` chars of the v1 renderer's stderr, for error context.
fn stderr_tail(bytes: &[u8], limit: usize) -> String {
    let lossy = String::from_utf8_lossy(bytes);
    let t = lossy.trim();
    let n = t.chars().count();
    if n <= limit {
        t.to_string()
    } else {
        format!("…{}", t.chars().skip(n - limit).collect::<String>())
    }
}

impl NotemdPlugin for Md2PdfV2 {
    fn activate(
        &mut self,
        host: &sdk::Host,
        _p: &sdk::plugin_protocol::ActivateParams,
    ) -> Result<(), String> {
        host.log_info("md2pdf v2 activated");
        Ok(())
    }

    fn deactivate(&mut self, _host: &sdk::Host) {}

    // NOTE: this blocks the SDK read loop while the v1 renderer runs. Fine for
    // ①期: the host serializes requests per plugin (single in-flight, 60s
    // per-request timeout covers hangs), and everything emitted meanwhile
    // (toast/log) is a fire-and-forget notification — no response routing is
    // needed during the block.
    fn execute_command(
        &mut self,
        host: &sdk::Host,
        p: &sdk::ExecuteCommandParams,
    ) -> Result<Value, String> {
        if p.command != "export" {
            return Err(format!("unknown command {}", p.command));
        }
        // v1 请求 = { command:"export", context:{...} }（context 与 v2 同形，v1 兼容读取）
        let v1_req = json!({ "command": "export", "context": p.context });
        let out = std::process::Command::new(&self.v1_bin)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn v1 renderer {}: {e}", self.v1_bin.display()))
            .and_then(|mut c| {
                use std::io::Write;
                // The taken ChildStdin is a temporary that drops — i.e. closes
                // the pipe — at the end of this statement. v1 reads stdin to
                // EOF (read_to_string), so the close is required before it
                // can respond.
                c.stdin
                    .take()
                    .unwrap()
                    .write_all(v1_req.to_string().as_bytes())
                    .map_err(|e| format!("write v1 renderer stdin: {e}"))?;
                c.wait_with_output()
                    .map_err(|e| format!("wait v1 renderer: {e}"))
            })?;
        if !out.status.success() {
            return Err(format!(
                "v1 renderer exited {}: {}",
                out.status,
                stderr_tail(&out.stderr, 400),
            ));
        }
        let line = String::from_utf8_lossy(&out.stdout);
        let resp: Value = serde_json::from_str(line.trim()).map_err(|e| {
            format!(
                "v1 renderer bad output: {e}; stderr: {}",
                stderr_tail(&out.stderr, 400),
            )
        })?;
        if resp["success"] == json!(true) {
            let path = p.context["output_path"].as_str().unwrap_or("");
            host.toast("success", &format!("✅ Exported to {path}"), None);
            Ok(json!({ "path": path }))
        } else {
            // v1 的失败 toast actions 转述为错误
            Err(format!("render failed: {}", resp["actions"]))
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let v1_bin = std::env::current_exe()
        .expect("current_exe")
        .parent()
        .expect("exe has parent dir")
        .join("md2pdf");
    sdk::serve(Md2PdfV2 { v1_bin }).await;
}
