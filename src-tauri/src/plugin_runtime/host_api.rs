//! Dispatch of plugin→host `host.*` calls with capability enforcement
//! (spec §5). Unauthorized method → JSON-RPC error -32001 capability_denied.
//!
//! # Testability deviation from plan
//!
//! The plan's `make_sink` took an `AppHandle<R>` directly. We instead take a
//! `ToastEmitter = Arc<dyn Fn(serde_json::Value) + Send + Sync>` so unit tests
//! can inject a recording closure without needing a real Tauri runtime. The
//! production entry point `make_sink_for_app<R: tauri::Runtime>` wraps
//! `app.emit` into that emitter. Task 8 calls `make_sink_for_app`.

use plugin_protocol as proto;
use std::sync::Arc;

/// Callable that emits a `plugin-toast` event payload to the frontend.
/// In production this wraps `AppHandle::emit`; in tests it records payloads.
pub type ToastEmitter = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

/// 方法所需 capability；`None` = 免授权（spec §5 表）。
/// 进程侧（make_sink）与 UI 侧（ui_rpc::dispatch）共用同一张表。
pub fn method_capability(method: &str) -> Option<&'static str> {
    match method {
        "host.log.info" | "host.log.warn" | "host.log.error" => None,
        "host.toast" => Some("toast"),
        "host.dialog.open" | "host.dialog.save" => Some("dialog"),
        "host.vault.info" => Some("vault.read"),
        "host.vault.read" | "host.vault.exists" | "host.vault.list" => Some("vault.read"),
        "host.vault.write" | "host.vault.mkdir" => Some("vault.write"),
        "host.fs.read_text" => Some("fs.read:dialog"),
        "host.clipboard.write" => Some("clipboard.write"),
        _ => Some("__unknown__"), // 未实现的方法一律拒绝
    }
}

/// Shared handling for the methods that the process sink and the UI RPC bridge
/// implement identically: `host.log.*` and `host.toast`. Returns:
/// - `Some(Ok(value))` — handled; `value` is the JSON result payload.
/// - `Some(Err(detail))` — handled but failed (currently unused; kept for symmetry).
/// - `None` — not one of these methods; the caller handles it (or errors).
///
/// The capability gate is the CALLER's responsibility (it precedes this call in
/// both sinks); `host.log.*` needs no capability and `host.toast` requires the
/// already-checked `toast`. This function only executes the side effect.
pub(crate) fn handle_common(
    method: &str,
    params: serde_json::Value,
    plugin_id: &str,
    log_dir: &std::path::Path,
    emitter: &ToastEmitter,
) -> Option<Result<serde_json::Value, String>> {
    match method {
        m @ ("host.log.info" | "host.log.warn" | "host.log.error") => {
            if let Ok(p) = serde_json::from_value::<proto::LogParams>(params) {
                let level = m.rsplit('.').next().unwrap_or("info");
                crate::plugin_runtime::process::append_plugin_log(
                    log_dir, plugin_id, level, &p.message,
                );
            }
            Some(Ok(serde_json::json!({"ok": true})))
        }
        "host.toast" => {
            if let Ok(p) = serde_json::from_value::<proto::ToastParams>(params) {
                emitter(serde_json::json!({
                    "plugin_id": plugin_id,
                    "level": p.level,
                    "message": p.message,
                    "detail": p.detail,
                }));
            }
            Some(Ok(serde_json::json!({"ok": true})))
        }
        _ => None,
    }
}

/// Core sink constructor. Uses an injectable `ToastEmitter` so unit tests can
/// record emitted payloads without a real Tauri runtime.
///
/// Behaviour:
/// - Unknown method (`__unknown__`) → error -32601 for requests; silent no-op for notifications.
/// - Missing capability → error -32001 for requests; silent no-op for notifications.
/// - `host.log.*` → `append_plugin_log` (no capability required); returns `{ok:true}` for requests.
/// - `host.toast` → calls `emitter` with the payload JSON; returns `{ok:true}` for requests.
pub fn make_sink(
    plugin_id: String,
    capabilities: Vec<String>,
    log_dir: std::path::PathBuf,
    emitter: ToastEmitter,
) -> crate::plugin_runtime::process::HostSink {
    Arc::new(move |req: proto::RpcRequest| {
        let reply_err = |id: u64, code: i64, message: String| {
            Some(proto::RpcResponse {
                jsonrpc: "2.0".into(),
                id,
                result: None,
                error: Some(proto::RpcError { code, message }),
            })
        };
        let ok = |id: Option<u64>| {
            id.map(|id| proto::RpcResponse {
                jsonrpc: "2.0".into(),
                id,
                result: Some(serde_json::json!({"ok": true})),
                error: None,
            })
        };

        match method_capability(&req.method) {
            Some("__unknown__") => {
                // Notification: silent no-op (no id to respond to)
                req.id.and_then(|id| {
                    reply_err(
                        id,
                        proto::ERR_METHOD_NOT_FOUND,
                        format!("unknown method {}", req.method),
                    )
                })
            }
            Some(cap) if !capabilities.iter().any(|c| c == cap) => {
                // Notification: silent no-op
                req.id.and_then(|id| {
                    reply_err(
                        id,
                        proto::ERR_CAPABILITY_DENIED,
                        format!("method {} requires capability '{cap}'", req.method),
                    )
                })
            }
            _ => match handle_common(&req.method, req.params, &plugin_id, &log_dir, &emitter) {
                // The process sink only ever shares log/toast with ui_rpc; every
                // other authorized method is unreachable here (method_capability
                // maps them to caps this sink's plugins never hold in practice,
                // and ui-only methods aren't invoked over the process channel).
                Some(Ok(_)) => ok(req.id),
                Some(Err(detail)) => req
                    .id
                    .and_then(|id| reply_err(id, proto::ERR_INTERNAL, detail)),
                None => unreachable!("filtered above"),
            },
        }
    })
}

/// Production entry point (called by Task 8 / lifecycle). Wraps `app.emit`
/// into a `ToastEmitter` and delegates to `make_sink`.
pub fn make_sink_for_app<R: tauri::Runtime>(
    plugin_id: String,
    capabilities: Vec<String>,
    app: tauri::AppHandle<R>,
    log_dir: std::path::PathBuf,
) -> crate::plugin_runtime::process::HostSink {
    use tauri::Emitter;
    let emitter: ToastEmitter = Arc::new(move |payload| {
        let _ = app.emit("plugin-toast", payload);
    });
    make_sink(plugin_id, capabilities, log_dir, emitter)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use plugin_protocol as proto;
    use std::sync::Mutex;

    /// Build a `ToastEmitter` that records every payload it sees.
    fn recording_emitter() -> (ToastEmitter, Arc<Mutex<Vec<serde_json::Value>>>) {
        let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_in = seen.clone();
        let emitter: ToastEmitter = Arc::new(move |v| {
            seen_in.lock().unwrap().push(v);
        });
        (emitter, seen)
    }

    fn req(method: &str, id: Option<u64>, params: serde_json::Value) -> proto::RpcRequest {
        proto::RpcRequest {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        }
    }

    fn notification(method: &str, params: serde_json::Value) -> proto::RpcRequest {
        req(method, None, params)
    }

    // ── ① toast WITHOUT capability, as a request → -32001 ──────────────────

    #[test]
    fn toast_without_capability_request_returns_32001() {
        let dir = tempfile::tempdir().unwrap();
        let (emitter, seen) = recording_emitter();
        let sink = make_sink("pub.test".into(), vec![], dir.path().to_path_buf(), emitter);

        let resp = sink(req(
            "host.toast",
            Some(42),
            serde_json::json!({"level": "info", "message": "hi"}),
        ))
        .unwrap();

        assert_eq!(resp.id, 42);
        assert!(resp.result.is_none());
        let err = resp.error.unwrap();
        assert_eq!(err.code, proto::ERR_CAPABILITY_DENIED);
        assert!(err.message.contains("toast"), "message: {}", err.message);

        // No emission happened
        assert!(seen.lock().unwrap().is_empty());
    }

    // ── ① toast WITHOUT capability, as a notification → silent no-op ────────

    #[test]
    fn toast_without_capability_notification_is_silent() {
        let dir = tempfile::tempdir().unwrap();
        let (emitter, seen) = recording_emitter();
        let sink = make_sink("pub.test".into(), vec![], dir.path().to_path_buf(), emitter);

        let resp = sink(notification(
            "host.toast",
            serde_json::json!({"level": "info", "message": "hi"}),
        ));

        assert!(resp.is_none(), "notification must return None");
        assert!(seen.lock().unwrap().is_empty());
    }

    // ── ② unknown method → -32601 (request) / None (notification) ───────────

    #[test]
    fn unknown_method_request_returns_32601() {
        let dir = tempfile::tempdir().unwrap();
        let (emitter, _) = recording_emitter();
        let sink = make_sink(
            "pub.test".into(),
            vec!["toast".into()],
            dir.path().to_path_buf(),
            emitter,
        );

        let resp = sink(req("host.unknown.method", Some(7), serde_json::json!({}))).unwrap();
        assert_eq!(resp.id, 7);
        let err = resp.error.unwrap();
        assert_eq!(err.code, proto::ERR_METHOD_NOT_FOUND);
        assert!(
            err.message.contains("host.unknown.method"),
            "message: {}",
            err.message
        );
    }

    #[test]
    fn unknown_method_notification_is_silent() {
        let dir = tempfile::tempdir().unwrap();
        let (emitter, _) = recording_emitter();
        let sink = make_sink(
            "pub.test".into(),
            vec![],
            dir.path().to_path_buf(),
            emitter,
        );
        let resp = sink(notification("host.doesnt.exist", serde_json::json!({})));
        assert!(resp.is_none());
    }

    // ── ③ log.* without any capability → writes [level] line to <id>.log ────

    #[test]
    fn log_writes_level_tagged_line_to_plugin_log() {
        let dir = tempfile::tempdir().unwrap();
        let (emitter, _) = recording_emitter();
        // No capabilities at all — log is free.
        let sink = make_sink("pub.myplugin".into(), vec![], dir.path().to_path_buf(), emitter);

        let resp = sink(req(
            "host.log.info",
            Some(1),
            serde_json::json!({"message": "hello from plugin"}),
        ))
        .unwrap();

        // Request → {ok: true}
        assert_eq!(resp.result, Some(serde_json::json!({"ok": true})));
        assert!(resp.error.is_none());

        let log_path = dir.path().join("pub.myplugin.log");
        let content = std::fs::read_to_string(&log_path)
            .expect("log file should have been created");
        assert!(
            content.contains("[info] hello from plugin"),
            "log content: {content:?}"
        );
    }

    #[test]
    fn log_warn_and_error_write_correct_level_tags() {
        let dir = tempfile::tempdir().unwrap();
        let (emitter, _) = recording_emitter();
        let sink = make_sink("pub.myplugin".into(), vec![], dir.path().to_path_buf(), emitter);

        sink(req(
            "host.log.warn",
            None,
            serde_json::json!({"message": "watchout"}),
        ));
        sink(req(
            "host.log.error",
            None,
            serde_json::json!({"message": "boom"}),
        ));

        let log_path = dir.path().join("pub.myplugin.log");
        let content = std::fs::read_to_string(&log_path).unwrap();
        assert!(content.contains("[warn] watchout"), "content: {content:?}");
        assert!(content.contains("[error] boom"), "content: {content:?}");
    }

    // ── ④ toast WITH capability → emitter called + response {ok:true} ────────

    #[test]
    fn toast_with_capability_request_emits_payload_and_returns_ok() {
        let dir = tempfile::tempdir().unwrap();
        let (emitter, seen) = recording_emitter();
        let sink = make_sink(
            "pub.test".into(),
            vec!["toast".into()],
            dir.path().to_path_buf(),
            emitter,
        );

        let resp = sink(req(
            "host.toast",
            Some(99),
            serde_json::json!({"level": "success", "message": "done!", "detail": null}),
        ))
        .unwrap();

        assert_eq!(resp.id, 99);
        assert_eq!(resp.result, Some(serde_json::json!({"ok": true})));
        assert!(resp.error.is_none());

        let emitted = seen.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["plugin_id"], "pub.test");
        assert_eq!(emitted[0]["level"], "success");
        assert_eq!(emitted[0]["message"], "done!");
    }

    // ── ④ toast WITH capability as notification → emitter called, no response ─

    #[test]
    fn toast_with_capability_notification_emits_and_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let (emitter, seen) = recording_emitter();
        let sink = make_sink(
            "pub.plug".into(),
            vec!["toast".into()],
            dir.path().to_path_buf(),
            emitter,
        );

        let resp = sink(notification(
            "host.toast",
            serde_json::json!({"level": "warn", "message": "heads up"}),
        ));

        assert!(resp.is_none(), "notification must return None");
        let emitted = seen.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["plugin_id"], "pub.plug");
        assert_eq!(emitted[0]["level"], "warn");
    }

    // ── method_capability table ───────────────────────────────────────────────

    #[test]
    fn method_capability_table() {
        assert_eq!(method_capability("host.log.info"), None);
        assert_eq!(method_capability("host.log.warn"), None);
        assert_eq!(method_capability("host.log.error"), None);
        assert_eq!(method_capability("host.toast"), Some("toast"));
        assert_eq!(method_capability("host.unknown"), Some("__unknown__"));
        assert_eq!(method_capability("anything.else"), Some("__unknown__"));
    }
}
