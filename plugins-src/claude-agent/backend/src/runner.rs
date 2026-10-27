//! The CLI detach path. A CLI subcommand runs inside a throwaway headless app
//! instance (src-tauri/src/cli/runner.rs:82): a single invoke is capped at 300
//! seconds, and the instance exiting takes the child process with it — neither
//! works for a sweep that runs for ten minutes.
//!
//! So by default the work is handed to this binary's own runner mode: setsid'd
//! into its own session, it outlives the headless instance, and the plugin can
//! return a run id immediately.
use crate::{discover, engine, prompt, task};
use agent_run_core::detach;
use std::path::PathBuf;
use tokio::sync::mpsc;

pub use agent_run_core::detach::spawn_detached;

/// The runner process body. Returns the process exit code.
pub async fn run(run_dir: PathBuf) -> i32 {
    let Some(req) = detach::read_request(&run_dir) else {
        return 2;
    };

    let task_dir = task::task_dir(&req.vault, &req.task_id);
    let Some(mut def) = task::read_task(&task_dir) else {
        return 2;
    };
    def.id = req.task_id.clone();
    if task::validate_next_kickoff_task(&def).is_err() {
        return 6;
    }
    let Some(claude) = discover::discover(std::env::var("NOTEMD_CLAUDE_BIN").ok().as_deref())
    else {
        return 3;
    };

    let spec = engine::RunSpec {
        vault: req.vault.clone(),
        prompt: prompt::compose_for_task(&def, &req.prompt, None),
        task: def,
        task_dir,
        task_run_dir: task::runs_root(&req.vault).join(&req.task_id),
        claude,
        env_path: None,
        trigger: "cli".into(),
        harness: "notemd.claude-agent".into(),
        run_id: req.run_id.clone(),
        oauth_token: std::env::var("CLAUDE_CODE_OAUTH_TOKEN").ok(),
        // A CLI run is a whole-vault pass; the precheck decides from the vault.
        target: None,
        // The CLI names no single output file (no reminder to earn), so there
        // is nothing to declare; artifacts still cover output/ and answers/.
        deliverable: None,
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let (_cancel_tx, cancel_rx) = mpsc::channel(1);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let code = match engine::run(spec, tx, cancel_rx).await {
        Ok(()) => 0,
        // The same task was already running.
        Err(_busy) => 4,
    };
    let _ = drain.await;
    detach::cleanup(&run_dir);
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_run_core::detach::Request;


    #[tokio::test]
    async fn runner_exits_with_a_code_when_the_request_is_unreadable() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(run(d.path().to_path_buf()).await, 2);
    }

    #[tokio::test]
    async fn runner_refuses_a_weakened_kickoff_before_discovering_claude() {
        let pending = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let template = task::task_dir(vault.path(), task::NEXT_KICKOFF_V2);
        std::fs::create_dir_all(&template).unwrap();
        std::fs::write(template.join("task.json"), serde_json::json!({
            "name": "changed after confirmation", "strict_readonly": false,
            "max_turns": 40, "timeout_seconds": 600,
        }).to_string()).unwrap();
        std::fs::write(pending.path().join("request.json"), serde_json::to_string(&Request {
            vault: vault.path().into(), task_id: task::NEXT_KICKOFF_V2.into(),
            prompt: task::NEXT_KICKOFF_V2_MARKER.into(), run_id: "rejected".into(),
        }).unwrap()).unwrap();
        assert_eq!(run(pending.path().into()).await, 6);
    }

    #[tokio::test]
    async fn runner_refuses_an_unknown_task() {
        let d = tempfile::tempdir().unwrap();
        let v = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("request.json"),
            serde_json::to_string(&Request {
                vault: v.path().to_path_buf(),
                task_id: "nope".into(),
                prompt: String::new(),
                run_id: "r".into(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(run(d.path().to_path_buf()).await, 2);
    }
}
