//! Integration tests for plugin_runtime::process (plugin-runtime-v2 Task 5):
//! spawn/handshake, NDJSON RPC round-trip, per-request timeout, fast failure
//! on process death, stderr logging, graceful shutdown.

use mdeditor_lib::plugin_runtime::process::{initialize_and_activate, HostSink, PluginProcess};
use plugin_protocol as proto;
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn fixture(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("tests/fixtures/v2").join(name)
}

/// HostSink that records every plugin→host request/notification it sees.
fn recording_sink() -> (HostSink, Arc<Mutex<Vec<proto::RpcRequest>>>) {
    let seen: Arc<Mutex<Vec<proto::RpcRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_in_sink = seen.clone();
    let sink: HostSink = Arc::new(move |req| {
        seen_in_sink.lock().unwrap().push(req);
        None
    });
    (sink, seen)
}

fn init_params(root: &std::path::Path) -> proto::InitializeParams {
    proto::InitializeParams {
        protocol_version: proto::PROTOCOL_VERSION,
        host_version: "6.716.7".into(),
        locale: "en".into(),
        theme: "light".into(),
        plugin_root: root.display().to_string(),
        data_dir: root.display().to_string(),
    }
}

/// Poll `has_exited` until it reports an exit code (reaping can lag the pipe
/// EOF slightly).
async fn wait_exit_code(proc: &PluginProcess) -> Option<i32> {
    for _ in 0..50 {
        if let Some(code) = proc.has_exited().await {
            return Some(code);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

// ── ① ok.sh: full round-trip + host.toast notification + graceful shutdown ──

#[tokio::test]
async fn ok_round_trip_toast_and_graceful_shutdown() {
    let log_dir = tempfile::tempdir().unwrap();
    let (sink, seen) = recording_sink();
    let proc = PluginProcess::spawn(&fixture("ok.sh"), "test.ok", log_dir.path(), 5, sink)
        .await
        .unwrap();
    initialize_and_activate(&proc, &init_params(log_dir.path()), "onStartupFinished")
        .await
        .unwrap();

    let out = proc
        .request("command.execute", json!({ "command": "noop", "context": {} }))
        .await
        .unwrap();
    assert_eq!(out, json!({ "echo": true }));

    // ok.sh emits the toast notification *before* the execute response on the
    // same pipe, so the sequential reader has already delivered it by now.
    {
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "expected exactly one host.* message");
        assert_eq!(seen[0].method, "host.toast");
        assert_eq!(seen[0].id, None, "toast is a notification");
        assert_eq!(seen[0].params, json!({ "level": "success", "message": "hi" }));
    }

    assert!(proc.shutdown().await, "expected graceful shutdown");
    assert_eq!(proc.has_exited().await, Some(0));
}

// ── ② slow.sh: per-request timeout fails the request only (spec §12) ──

#[tokio::test]
async fn slow_execute_times_out_without_killing_process() {
    let log_dir = tempfile::tempdir().unwrap();
    let (sink, _seen) = recording_sink();
    let proc = PluginProcess::spawn(&fixture("slow.sh"), "test.slow", log_dir.path(), 1, sink)
        .await
        .unwrap();
    // The 1s per-request timeout under test also governs the handshake, which
    // can flake on a cold/loaded machine. Retrying is safe: the fixture drops
    // nothing, and a late response to a timed-out id is discarded by the host.
    let mut handshake = Err(String::new());
    for _ in 0..3 {
        handshake = initialize_and_activate(&proc, &init_params(log_dir.path()), "onCommand:x").await;
        if handshake.is_ok() {
            break;
        }
    }
    handshake.expect("handshake should succeed within retries");

    let err = proc.request("command.execute", json!({})).await.unwrap_err();
    assert!(err.contains("timeout:1"), "got: {err}");

    // Process must survive a per-request timeout…
    assert_eq!(proc.has_exited().await, None, "process should still be alive");
    // …and still serve later requests: $deactivate succeeds → graceful.
    assert!(proc.shutdown().await, "expected graceful shutdown after timeout");
}

// ── ③ crash-activate.sh: activation failure surfaces + exit code observed ──

#[tokio::test]
async fn crash_on_activate_reports_error_and_exit_code() {
    let log_dir = tempfile::tempdir().unwrap();
    let (sink, _seen) = recording_sink();
    let proc = PluginProcess::spawn(
        &fixture("crash-activate.sh"),
        "test.crash",
        log_dir.path(),
        5,
        sink,
    )
    .await
    .unwrap();

    let err = initialize_and_activate(&proc, &init_params(log_dir.path()), "onCommand:x")
        .await
        .unwrap_err();
    assert!(err.starts_with("$activate:"), "got: {err}");
    assert_eq!(wait_exit_code(&proc).await, Some(1));
}

// ── ④ die-mid-request.sh: pins the reader-exit pending drain + stderr log ──

#[tokio::test]
async fn process_death_mid_request_fails_pending_fast_and_logs_stderr() {
    let log_dir = tempfile::tempdir().unwrap();
    let (sink, _seen) = recording_sink();
    // 30s request timeout: only the drain-on-reader-exit behavior makes the
    // in-flight request return promptly instead of hanging out the timeout.
    let proc = PluginProcess::spawn(
        &fixture("die-mid-request.sh"),
        "test.die",
        log_dir.path(),
        30,
        sink,
    )
    .await
    .unwrap();
    initialize_and_activate(&proc, &init_params(log_dir.path()), "onCommand:x")
        .await
        .unwrap();

    let t0 = Instant::now();
    let err = proc.request("command.execute", json!({})).await.unwrap_err();
    assert!(
        t0.elapsed() < Duration::from_secs(5),
        "request should fail fast, took {:?}",
        t0.elapsed()
    );
    assert!(err.contains("channel closed"), "got: {err}");
    assert_eq!(wait_exit_code(&proc).await, Some(0));

    // The fixture's stderr line landed in <log_dir>/<plugin_id>.log with the
    // "stderr" level tag (poll: the capture task writes asynchronously).
    let log_path = log_dir.path().join("test.die.log");
    let mut content = String::new();
    for _ in 0..50 {
        content = std::fs::read_to_string(&log_path).unwrap_or_default();
        if !content.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        content.contains("[stderr] dying mid-request"),
        "log content: {content:?}"
    );
}

// ── shutdown on an already-dead process: false, and promptly ──

#[tokio::test]
async fn shutdown_after_process_death_is_not_graceful_and_returns_promptly() {
    let log_dir = tempfile::tempdir().unwrap();
    let (sink, _seen) = recording_sink();
    let proc = PluginProcess::spawn(
        &fixture("die-mid-request.sh"),
        "test.die2",
        log_dir.path(),
        5,
        sink,
    )
    .await
    .unwrap();
    initialize_and_activate(&proc, &init_params(log_dir.path()), "onCommand:x")
        .await
        .unwrap();
    let _ = proc.request("command.execute", json!({})).await; // kills the fixture
    assert_eq!(wait_exit_code(&proc).await, Some(0));

    let t0 = Instant::now();
    let graceful = proc.shutdown().await;
    assert!(!graceful, "dead process must not report a graceful shutdown");
    assert!(
        t0.elapsed() < Duration::from_secs(5),
        "shutdown of a dead process should not hang, took {:?}",
        t0.elapsed()
    );
}
