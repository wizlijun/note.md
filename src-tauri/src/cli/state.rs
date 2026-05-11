//! Shared state between the Rust CLI runner and the frontend CliRunner.
//!
//! The runner builds a CliPayload, pushes it into CliState before showing
//! the hidden window, and waits on a oneshot channel for the frontend's
//! cli_finish call. The frontend's CliRunner pulls the payload via the
//! cli_payload command, performs the work, and reports completion through
//! cli_finish.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize)]
pub struct CliPayload {
    pub subcommand: String,
    pub plugin_id: String,
    pub plugin_command: String,
    pub file: Option<String>,
    pub flags: serde_json::Map<String, serde_json::Value>,
    pub global: GlobalFlags,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlobalFlags {
    pub json: bool,
    pub quiet: bool,
    pub clipboard: bool,
    pub yes: bool,
}

#[derive(Debug, Deserialize)]
pub struct CliResult {
    pub exit_code: i32,
    #[serde(default)]
    pub stdout: Option<String>,
    #[serde(default)]
    pub stderr: Vec<String>,
}

pub struct CliState {
    pub payload: Mutex<Option<CliPayload>>,
    pub result_tx: Mutex<Option<oneshot::Sender<CliResult>>>,
}

impl CliState {
    pub fn new(payload: CliPayload, tx: oneshot::Sender<CliResult>) -> Self {
        Self {
            payload: Mutex::new(Some(payload)),
            result_tx: Mutex::new(Some(tx)),
        }
    }
}

#[tauri::command]
pub fn cli_payload(state: tauri::State<'_, CliState>) -> Result<CliPayload, String> {
    let p = state.payload.lock().unwrap().clone();
    p.ok_or_else(|| "cli payload missing".to_string())
}

#[tauri::command]
pub fn cli_finish(
    result: CliResult,
    state: tauri::State<'_, CliState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(tx) = state.result_tx.lock().unwrap().take() {
        let code = result.exit_code;
        if let Some(s) = &result.stdout {
            if !s.is_empty() {
                println!("{s}");
            }
        }
        for line in &result.stderr {
            eprintln!("{line}");
        }
        let _ = tx.send(result);
        app.exit(code);
        Ok(())
    } else {
        Err("cli_finish called twice or without state".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;
    use tokio::sync::oneshot;

    #[test]
    fn cli_state_holds_payload_once() {
        let (tx, _rx) = oneshot::channel();
        let payload = CliPayload {
            subcommand: "share".into(),
            plugin_id: "share".into(),
            plugin_command: "publish".into(),
            file: Some("/tmp/x.md".into()),
            flags: Map::new(),
            global: GlobalFlags { json: false, quiet: false, clipboard: true, yes: false },
        };
        let state = CliState::new(payload.clone(), tx);
        let first = state.payload.lock().unwrap().clone().unwrap();
        assert_eq!(first.subcommand, "share");
    }
}
