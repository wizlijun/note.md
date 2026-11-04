//! Exercise the real detached runner against an independently held task lock.
//! The only available harness is a stub that must never be executed.
use agent_run_core::{detach::Request, lock, record, task};
use std::os::unix::fs::PermissionsExt;

#[test]
fn detached_capacity_rejection_survives_runner_exit() {
    let root = tempfile::tempdir().unwrap();
    let vault = root.path().join("vault");
    let task_dir = task::task_dir(&vault, "next-task-kickoff");
    std::fs::create_dir_all(&task_dir).unwrap();
    std::fs::write(
        task_dir.join("task.json"),
        r#"{"name":"Isolated lock test","prompt":"Must not run","model":"gpt-test"}"#,
    )
    .unwrap();
    let run_dir = task::runs_root(&vault).join("next-task-kickoff");
    let _guard = lock::acquire(
        &run_dir,
        lock::LockInfo {
            pid: std::process::id() as i32,
            run_id: "holder-run".into(),
            started_at: "2026-10-27T00:00:00Z".into(),
        },
    )
    .unwrap();
    let lock_before = std::fs::read(lock::lock_path(&run_dir)).unwrap();
    let pending = root.path().join("pending");
    std::fs::create_dir(&pending).unwrap();
    std::fs::write(
        pending.join("request.json"),
        serde_json::to_string(&Request {
            vault,
            task_id: "next-task-kickoff".into(),
            prompt: String::new(),
            run_id: "rejected-run".into(),
        })
        .unwrap(),
    )
    .unwrap();
    let fake = root.path().join("codex");
    std::fs::write(&fake, "#!/bin/sh\necho unexpected-harness-invocation >&2\nexit 99\n")
        .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_notemd-codex-agent"))
        .arg("--runner")
        .arg(&pending)
        .env("NOTEMD_CODEX_BIN", fake)
        .env("SHELL", "/bin/false")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4), "{output:?}");
    assert!(!String::from_utf8_lossy(&output.stderr).contains("unexpected-harness-invocation"));
    let rejected = record::find(&run_dir, "rejected-run").unwrap();
    assert_eq!(rejected.status, record::Status::Error);
    assert_eq!(rejected.failure_kind.as_deref(), Some("capacity"));
    assert_eq!(std::fs::read(lock::lock_path(&run_dir)).unwrap(), lock_before);
    assert!(record::find(&run_dir, "holder-run").is_none());
    assert!(!pending.exists());
}
