//! Integration tests for plugin_runtime::process (plugin-runtime-v2 Task 5):
//! spawn/handshake, NDJSON RPC round-trip, per-request timeout, fast failure
//! on process death, stderr logging, graceful shutdown — and for
//! plugin_runtime::lifecycle (Task 6): crash backoff circuit breaker, idle
//! shutdown + lazy re-activation, deactivate-is-not-a-crash, startup
//! activation.

use mdeditor_lib::plugin_runtime::lifecycle::{
    startup_activation, PhaseKind, PluginLifecycle, SpawnCtx, Trigger,
};
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

// ═══ Task 6: lifecycle state machine ═══

fn v2_manifest(id: &str, events: &[&str], idle_shutdown_seconds: Option<u64>) -> proto::ManifestV2 {
    let mut m = json!({
        "manifest_version": 2,
        "id": id,
        "name": "Lifecycle Fixture",
        "version": "1.0.0",
        "kind": "native",
        "engines": { "notemd": ">=0.0.0" },
        "activation": { "events": events },
        "capabilities": []
    });
    if let Some(n) = idle_shutdown_seconds {
        m["idle_shutdown_seconds"] = json!(n);
    }
    serde_json::from_value(m).unwrap()
}

/// Lifecycle over a fixture script: fast test-friendly poll intervals are set
/// by each test on the returned (not-yet-Arc'd) value.
fn make_lifecycle(
    fixture_name: &str,
    id: &str,
    events: &[&str],
    idle_shutdown_seconds: Option<u64>,
    dir: &std::path::Path,
) -> PluginLifecycle {
    let (sink, _seen) = recording_sink();
    let ctx = SpawnCtx {
        binary: fixture(fixture_name),
        log_dir: dir.to_path_buf(),
        host_sink: sink,
        host_version: "6.716.7".into(),
        locale: "en".into(),
        app_data: dir.to_path_buf(),
    };
    PluginLifecycle::new(
        v2_manifest(id, events, idle_shutdown_seconds),
        dir.to_path_buf(),
        ctx,
    )
}

async fn wait_for_phase(lc: &PluginLifecycle, want: impl Fn(&PhaseKind) -> bool) -> PhaseKind {
    let mut kind = lc.phase_kind().await;
    for _ in 0..100 {
        // generous: up to 10s
        if want(&kind) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        kind = lc.phase_kind().await;
    }
    kind
}

// ── ② crash-loop.sh: backoff restarts converge to Disabled("crash-loop") ──

#[tokio::test]
async fn crash_loop_restarts_then_trips_breaker_to_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let mut lc = make_lifecycle("crash-loop.sh", "test.crashloop", &["*"], None, dir.path());
    lc.backoff_secs = vec![0, 0, 0];
    lc.crash_poll = Duration::from_millis(100);
    let lc = Arc::new(lc);

    // Activation itself SUCCEEDS (the fixture answers the full handshake
    // before dying) — the breaker is a supervision concern, not a handshake one.
    lc.ensure_active(&Trigger::Startup).await.expect("first activation succeeds");

    // Crash #1 → restart, crash #2 → restart, crash #3 → Disabled.
    let kind = wait_for_phase(&lc, |k| matches!(k, PhaseKind::Disabled(_))).await;
    assert_eq!(kind, PhaseKind::Disabled("crash-loop".into()));
    assert_eq!(
        lc.crash_times.lock().unwrap().len(),
        3,
        "exactly 3 crashes recorded in the window"
    );

    // Disabled rejects further activation with the reason (spec §4.2).
    let err = match lc.ensure_active(&Trigger::Startup).await {
        Ok(_) => panic!("ensure_active must fail once disabled"),
        Err(e) => e,
    };
    assert!(err.contains("crash-loop"), "got: {err}");

    // The breaker trip landed in the plugin log.
    let log = std::fs::read_to_string(dir.path().join("test.crashloop.log")).unwrap_or_default();
    assert!(log.contains("[crash-loop]"), "log content: {log:?}");
}

// ── ③ ok.sh + idle_shutdown_seconds=1: idle reap, then lazy re-activation ──

#[tokio::test]
async fn idle_shutdown_deactivates_then_next_trigger_reactivates() {
    let dir = tempfile::tempdir().unwrap();
    let mut lc = make_lifecycle("ok.sh", "test.idle", &["*"], Some(1), dir.path());
    lc.idle_poll = Duration::from_millis(200);
    let lc = Arc::new(lc);

    lc.ensure_active(&Trigger::Startup).await.unwrap();
    assert_eq!(lc.phase_kind().await, PhaseKind::Active);

    // idle_shutdown_seconds(1s) + poll(200ms) with generous margin.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(
        lc.phase_kind().await,
        PhaseKind::Inactive,
        "idle watcher should have deactivated"
    );
    assert!(
        lc.crash_times.lock().unwrap().is_empty(),
        "idle shutdown must not be recorded as a crash"
    );

    // Lazy re-activation on the next trigger; execute round-trips.
    lc.ensure_active(&Trigger::Command("noop".into())).await.unwrap();
    assert_eq!(lc.phase_kind().await, PhaseKind::Active);
    let out = lc
        .execute(proto::ExecuteCommandParams { command: "noop".into(), context: json!({}) })
        .await
        .unwrap();
    assert_eq!(out, json!({ "echo": true }));
    lc.deactivate().await;
}

// ── ④ deactivate is not a crash ──

#[tokio::test]
async fn deactivate_is_not_recorded_as_a_crash() {
    let dir = tempfile::tempdir().unwrap();
    let mut lc = make_lifecycle("ok.sh", "test.deact", &["*"], None, dir.path());
    lc.crash_poll = Duration::from_millis(100);
    let lc = Arc::new(lc);

    lc.ensure_active(&Trigger::Startup).await.unwrap();
    lc.deactivate().await;
    assert_eq!(lc.phase_kind().await, PhaseKind::Inactive);

    // Give the crash watcher several ticks to (wrongly) react.
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(
        lc.phase_kind().await,
        PhaseKind::Inactive,
        "phase must stay Inactive, not Disabled"
    );
    assert!(
        lc.crash_times.lock().unwrap().is_empty(),
        "deactivate must not be recorded as a crash"
    );
}

// ── startup_activation: only Startup-matching plugins get activated ──

#[tokio::test]
async fn startup_activation_activates_only_matching_plugins() {
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let on_startup = Arc::new(make_lifecycle(
        "ok.sh",
        "test.startup",
        &["onStartupFinished"],
        None,
        dir_a.path(),
    ));
    let on_command = Arc::new(make_lifecycle(
        "ok.sh",
        "test.oncommand",
        &["onCommand:export"],
        None,
        dir_b.path(),
    ));

    startup_activation(vec![on_startup.clone(), on_command.clone()]);

    let kind = wait_for_phase(&on_startup, |k| matches!(k, PhaseKind::Active)).await;
    assert_eq!(kind, PhaseKind::Active, "onStartupFinished plugin should activate");
    assert_eq!(
        on_command.phase_kind().await,
        PhaseKind::Inactive,
        "onCommand-only plugin must stay inactive"
    );
    on_startup.deactivate().await;
}
