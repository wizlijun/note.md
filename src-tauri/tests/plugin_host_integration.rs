use mdeditor_lib::plugin_host::{run_plugin_binary, InvokeResult};
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("tests/fixtures").join(name)
}

#[tokio::test]
async fn echo_round_trip() {
    let result = run_plugin_binary(&fixture("echo.sh"), r#"{"hello":"world"}"#, 5).await.unwrap();
    assert_eq!(result.stdout_line.as_deref(), Some(r#"{"hello":"world"}"#));
    assert_eq!(result.exit_code, Some(0));
    assert!(result.success);
}

#[tokio::test]
async fn timeout_kills_subprocess() {
    let result = run_plugin_binary(&fixture("sleep.sh"), "{}", 1).await.unwrap();
    assert!(!result.success);
    assert!(result.error.as_deref().unwrap_or("").contains("timeout"));
}

#[tokio::test]
async fn crash_reports_stderr_and_nonzero_exit() {
    let result = run_plugin_binary(&fixture("crash.sh"), "{}", 5).await.unwrap();
    assert!(!result.success);
    assert!(result.stderr_tail.contains("boom"));
    assert!(matches!(result.exit_code, Some(c) if c != 0));
}

#[tokio::test]
async fn garbage_stdout_yields_non_json_line_for_caller_to_reject() {
    let result = run_plugin_binary(&fixture("garbage.sh"), "{}", 5).await.unwrap();
    // Host doesn't try to parse JSON itself — that's the frontend's job.
    // It just returns the line, and caller decides protocol_error.
    assert_eq!(result.stdout_line.as_deref(), Some("this is not json"));
    assert_eq!(result.exit_code, Some(0));
}

#[tokio::test]
async fn huge_stdout_does_not_oom_host() {
    let result = run_plugin_binary(&fixture("huge.sh"), "{}", 30).await.unwrap();
    assert_eq!(result.stdout_line.as_deref(), Some(r#"{"success":true,"actions":[]}"#));
}

#[allow(dead_code)]
fn _suppress_unused_warning(_r: InvokeResult) {}
