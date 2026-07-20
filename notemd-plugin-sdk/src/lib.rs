//! note.md v2 plugin SDK. Implement [`NotemdPlugin`], call [`serve`] from main.
//! Protocol: NDJSON JSON-RPC 2.0 over stdio (stdout is protocol-only; log via
//! `Host::log_*` or stderr, which the host captures to the plugin log file).

use plugin_protocol as proto;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

/// Full protocol crate re-export so plugin authors only depend on the SDK.
pub use plugin_protocol;
pub use plugin_protocol::{ExecuteCommandParams, InitializeParams, ToastParams};

/// 插件实现面（①期最小集；后续期次按 spec §4.4 增补方法）。
pub trait NotemdPlugin: Send + 'static {
    fn activate(&mut self, host: &Host, params: &proto::ActivateParams) -> Result<(), String>;
    fn deactivate(&mut self, host: &Host);
    fn execute_command(&mut self, host: &Host, params: &proto::ExecuteCommandParams)
        -> Result<Value, String>;
    /// $initialize 到达时回调（可选覆写；默认记录 host 上下文即可）。
    fn initialize(&mut self, _host: &Host, _params: &proto::InitializeParams) {}
    /// UI 窗口→插件进程请求（`ui.request`）。默认实现返回错误；覆写以处理窗口 RPC。
    /// 向后兼容：不覆写的插件（md2pdf/roam）行为不变。
    fn on_ui_request(&mut self, _host: &Host, _method: &str, _params: Value)
        -> Result<Value, String> {
        Err("plugin has no ui handler".into())
    }
}

/// 插件→宿主调用句柄。克隆廉价；内部经 channel 写 stdout。
#[derive(Clone)]
pub struct Host {
    tx: mpsc::UnboundedSender<OutMsg>,
    next_id: std::sync::Arc<AtomicU64>,
    pending: std::sync::Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<proto::RpcResponse>>>>,
}

enum OutMsg { Line(String) }

impl Host {
    pub fn log_info(&self, m: &str) { self.notify("host.log.info", json!({"message": m})); }
    pub fn log_warn(&self, m: &str) { self.notify("host.log.warn", json!({"message": m})); }
    pub fn log_error(&self, m: &str) { self.notify("host.log.error", json!({"message": m})); }
    pub fn toast(&self, level: &str, message: &str, detail: Option<&str>) {
        self.notify("host.toast", json!({"level": level, "message": message, "detail": detail}));
    }
    /// 插件进程→UI 窗口单向推送（fire-and-forget 通知）。
    /// 宿主收到后经 `push_to_window` 投递给指定 `window_id` 的 WebView。
    pub fn ui_post(&self, window_id: &str, payload: Value) {
        self.notify("host.ui.post", json!({"window_id": window_id, "payload": payload}));
    }
    fn notify(&self, method: &str, params: Value) {
        let req = proto::RpcRequest { jsonrpc: "2.0".into(), id: None, method: method.into(), params };
        let _ = self.tx.send(OutMsg::Line(serde_json::to_string(&req).unwrap()));
    }
    /// 需要返回值的宿主调用（①期插件端暂无消费者，保留给后续期次）。
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let req = proto::RpcRequest { jsonrpc: "2.0".into(), id: Some(id), method: method.into(), params };
        self.tx.send(OutMsg::Line(serde_json::to_string(&req).unwrap())).map_err(|e| e.to_string())?;
        let resp = rx.await.map_err(|e| e.to_string())?;
        match (resp.result, resp.error) {
            (Some(v), _) => Ok(v),
            (_, Some(e)) => Err(format!("{}: {}", e.code, e.message)),
            _ => Err("empty response".into()),
        }
    }
}

/// 主循环。从 stdin 读宿主消息，分发给插件实现；stdout 只写协议行。
/// 收到 `$deactivate` 后调用 `deactivate` 并干净退出（进程退出即优雅关停）。
pub async fn serve<P: NotemdPlugin>(plugin: P) {
    serve_io(plugin, tokio::io::stdin(), tokio::io::stdout()).await;
}

/// 可注入 IO 的实现，供单元测试用内存管道驱动。
pub async fn serve_io<P, R, W>(mut plugin: P, reader: R, writer: W)
where P: NotemdPlugin, R: tokio::io::AsyncRead + Unpin + Send + 'static, W: AsyncWrite + Unpin + Send + 'static {
    let (tx, mut rx) = mpsc::unbounded_channel::<OutMsg>();
    let host = Host { tx, next_id: Default::default(), pending: Default::default() };
    // writer task：串行化 stdout 写。
    let writer_task = tokio::spawn(async move {
        let mut w = writer;
        while let Some(OutMsg::Line(l)) = rx.recv().await {
            if w.write_all(l.as_bytes()).await.is_err() { break }
            if w.write_all(b"\n").await.is_err() { break }
            let _ = w.flush().await;
        }
    });
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() { continue }
        // 宿主→插件：request；插件 request 的应答：response（路由给 pending）。
        if let Ok(resp) = serde_json::from_str::<proto::RpcResponse>(&line) {
            if resp.result.is_some() || resp.error.is_some() {
                if let Some(tx) = host.pending.lock().await.remove(&resp.id) { let _ = tx.send(resp); }
                continue;
            }
        }
        let req: proto::RpcRequest = match serde_json::from_str(&line) { Ok(r) => r, Err(_) => continue };
        let reply = |id: u64, result: Result<Value, String>| {
            let resp = match result {
                Ok(v) => proto::RpcResponse { jsonrpc: "2.0".into(), id, result: Some(v), error: None },
                Err(m) => proto::RpcResponse { jsonrpc: "2.0".into(), id,
                    result: None, error: Some(proto::RpcError { code: -32000, message: m }) },
            };
            OutMsg::Line(serde_json::to_string(&resp).unwrap())
        };
        match req.method.as_str() {
            "$initialize" => {
                if let Ok(p) = serde_json::from_value(req.params) { plugin.initialize(&host, &p); }
                if let Some(id) = req.id { let _ = host.tx.send(reply(id, Ok(json!({"ok": true})))); }
            }
            "$activate" => {
                let r = serde_json::from_value(req.params).map_err(|e| e.to_string())
                    .and_then(|p| plugin.activate(&host, &p)).map(|_| json!({"ok": true}));
                if let Some(id) = req.id { let _ = host.tx.send(reply(id, r)); }
            }
            "$deactivate" => {
                plugin.deactivate(&host);
                if let Some(id) = req.id { let _ = host.tx.send(reply(id, Ok(json!({"ok": true})))); }
                break; // 干净退出
            }
            "command.execute" => {
                let r = serde_json::from_value(req.params).map_err(|e| e.to_string())
                    .and_then(|p| plugin.execute_command(&host, &p));
                if let Some(id) = req.id { let _ = host.tx.send(reply(id, r)); }
            }
            "ui.request" => {
                let r = serde_json::from_value::<proto::UiRequestParams>(req.params)
                    .map_err(|e| e.to_string())
                    .and_then(|p| plugin.on_ui_request(&host, &p.method, p.params));
                if let Some(id) = req.id { let _ = host.tx.send(reply(id, r)); }
            }
            other => {
                if let Some(id) = req.id {
                    let resp = proto::RpcResponse { jsonrpc: "2.0".into(), id, result: None,
                        error: Some(proto::RpcError { code: proto::ERR_METHOD_NOT_FOUND,
                            message: format!("unknown method {other}") }) };
                    let _ = host.tx.send(OutMsg::Line(serde_json::to_string(&resp).unwrap()));
                }
            }
        }
    }
    // 插件可能保存了 Host 克隆（Host: Clone）；先 drop 插件再 drop 本地 host，
    // 保证所有 sender 释放、writer task 排空后退出，serve_io 才能真正完成。
    drop(plugin);
    drop(host);
    let _ = writer_task.await;
}

// ── Unit tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::time::{timeout, Duration};

    // ── Recording test plugin ──────────────────────────────────────────

    #[derive(Clone, Default)]
    struct Recorder(Arc<StdMutex<Vec<String>>>);

    impl Recorder {
        fn push(&self, s: impl Into<String>) { self.0.lock().unwrap().push(s.into()); }
        fn calls(&self) -> Vec<String> { self.0.lock().unwrap().clone() }
    }

    struct TestPlugin {
        rec: Recorder,
        activate_result: Result<(), String>,
        toast_on_execute: bool,
        /// When true, keeps a Host clone inside the plugin — pins the serve_io
        /// shutdown fix (a plugin-held sender must not keep serve_io alive).
        keep_host: bool,
        #[allow(dead_code)]
        host: Option<Host>,
    }

    impl TestPlugin {
        fn new() -> Self {
            Self { rec: Recorder::default(), activate_result: Ok(()),
                   toast_on_execute: false, keep_host: false, host: None }
        }
    }

    impl NotemdPlugin for TestPlugin {
        fn initialize(&mut self, host: &Host, params: &proto::InitializeParams) {
            self.rec.push(format!("initialize:{}", params.host_version));
            if self.keep_host { self.host = Some(host.clone()); }
        }
        fn activate(&mut self, host: &Host, params: &proto::ActivateParams) -> Result<(), String> {
            self.rec.push(format!("activate:{}", params.event));
            if self.keep_host { self.host = Some(host.clone()); }
            self.activate_result.clone()
        }
        fn deactivate(&mut self, _host: &Host) { self.rec.push("deactivate"); }
        fn execute_command(&mut self, host: &Host, params: &proto::ExecuteCommandParams)
            -> Result<Value, String> {
            self.rec.push(format!("execute:{}", params.command));
            if self.toast_on_execute { host.toast("success", "hi from plugin", Some("detail")); }
            Ok(json!({ "echo": params.command }))
        }
    }

    // ── Harness: two duplex pairs driving serve_io ─────────────────────

    struct Harness {
        to_plugin: DuplexStream,
        from_plugin: tokio::io::Lines<BufReader<DuplexStream>>,
        serve: tokio::task::JoinHandle<()>,
        rec: Recorder,
    }

    fn spawn_plugin(plugin: TestPlugin) -> Harness {
        let (to_plugin, plugin_stdin) = tokio::io::duplex(64 * 1024);
        let (plugin_stdout, from_plugin) = tokio::io::duplex(64 * 1024);
        let rec = plugin.rec.clone();
        let serve = tokio::spawn(serve_io(plugin, plugin_stdin, plugin_stdout));
        Harness { to_plugin, from_plugin: BufReader::new(from_plugin).lines(), serve, rec }
    }

    impl Harness {
        async fn send(&mut self, v: serde_json::Value) {
            let mut buf = serde_json::to_vec(&v).unwrap();
            buf.push(b'\n');
            self.to_plugin.write_all(&buf).await.unwrap();
        }
        async fn recv_line(&mut self) -> String {
            timeout(Duration::from_secs(5), self.from_plugin.next_line()).await
                .expect("timed out waiting for plugin output")
                .expect("read error")
                .expect("plugin closed stdout unexpectedly")
        }
        async fn recv_response(&mut self) -> proto::RpcResponse {
            let line = self.recv_line().await;
            serde_json::from_str(&line)
                .unwrap_or_else(|e| panic!("expected RpcResponse, got: {line} ({e})"))
        }
    }

    fn init_request(id: u64) -> serde_json::Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "$initialize", "params": {
            "protocol_version": 2, "host_version": "6.717.0", "locale": "en",
            "theme": "light", "plugin_root": "/tmp/plugin", "data_dir": "/tmp/data" } })
    }

    // ── ① $initialize → {ok:true} ──────────────────────────────────────

    #[tokio::test]
    async fn initialize_replies_ok_and_calls_plugin() {
        let mut h = spawn_plugin(TestPlugin::new());
        h.send(init_request(1)).await;
        let resp = h.recv_response().await;
        assert_eq!(resp.id, 1);
        assert_eq!(resp.result, Some(json!({"ok": true})));
        assert!(resp.error.is_none());
        assert_eq!(h.rec.calls(), vec!["initialize:6.717.0"]);
    }

    // ── ② $activate success / failure ──────────────────────────────────

    #[tokio::test]
    async fn activate_success_replies_ok() {
        let mut h = spawn_plugin(TestPlugin::new());
        h.send(json!({"jsonrpc":"2.0","id":2,"method":"$activate",
                      "params":{"event":"onStartupFinished"}})).await;
        let resp = h.recv_response().await;
        assert_eq!(resp.id, 2);
        assert_eq!(resp.result, Some(json!({"ok": true})));
        assert!(resp.error.is_none());
        assert_eq!(h.rec.calls(), vec!["activate:onStartupFinished"]);
    }

    #[tokio::test]
    async fn activate_failure_replies_error_32000_with_message() {
        let mut plugin = TestPlugin::new();
        plugin.activate_result = Err("boom: cannot activate".into());
        let mut h = spawn_plugin(plugin);
        h.send(json!({"jsonrpc":"2.0","id":3,"method":"$activate","params":{"event":"*"}})).await;
        let resp = h.recv_response().await;
        assert_eq!(resp.id, 3);
        assert!(resp.result.is_none());
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, -32000);
        assert_eq!(err.message, "boom: cannot activate");
    }

    // ── ③ command.execute returns result ───────────────────────────────

    #[tokio::test]
    async fn execute_command_returns_result() {
        let mut h = spawn_plugin(TestPlugin::new());
        h.send(json!({"jsonrpc":"2.0","id":4,"method":"command.execute",
                      "params":{"command":"export","context":{}}})).await;
        let resp = h.recv_response().await;
        assert_eq!(resp.id, 4);
        assert_eq!(resp.result, Some(json!({"echo": "export"})));
        assert!(resp.error.is_none());
        assert_eq!(h.rec.calls(), vec!["execute:export"]);
    }

    // ── ④ host.toast notification precedes the execute response ────────

    #[tokio::test]
    async fn toast_notification_precedes_execute_response() {
        let mut plugin = TestPlugin::new();
        plugin.toast_on_execute = true;
        let mut h = spawn_plugin(plugin);
        h.send(json!({"jsonrpc":"2.0","id":5,"method":"command.execute",
                      "params":{"command":"export","context":{}}})).await;

        let first = h.recv_line().await;
        let notif: proto::RpcRequest = serde_json::from_str(&first)
            .unwrap_or_else(|e| panic!("first line must be the toast notification: {first} ({e})"));
        assert_eq!(notif.id, None, "toast must be a notification (no id): {first}");
        assert_eq!(notif.method, "host.toast");
        assert_eq!(notif.params,
            json!({"level": "success", "message": "hi from plugin", "detail": "detail"}));

        let second = h.recv_line().await;
        let resp: proto::RpcResponse = serde_json::from_str(&second)
            .unwrap_or_else(|e| panic!("second line must be the execute response: {second} ({e})"));
        assert_eq!(resp.id, 5);
        assert_eq!(resp.result, Some(json!({"echo": "export"})));
    }

    // ── ⑤ $deactivate → {ok:true}, then serve_io completes ─────────────

    #[tokio::test]
    async fn deactivate_replies_ok_then_serve_exits() {
        let mut h = spawn_plugin(TestPlugin::new());
        h.send(json!({"jsonrpc":"2.0","id":6,"method":"$deactivate","params":{}})).await;
        let resp = h.recv_response().await;
        assert_eq!(resp.id, 6);
        assert_eq!(resp.result, Some(json!({"ok": true})));
        assert_eq!(h.rec.calls(), vec!["deactivate"]);
        // serve_io future completes (clean exit)…
        timeout(Duration::from_secs(5), h.serve).await
            .expect("serve_io did not exit after $deactivate")
            .expect("serve task panicked");
        // …and the plugin stdout reaches EOF (writer task drained + closed).
        let eof = timeout(Duration::from_secs(5), h.from_plugin.next_line()).await
            .expect("timed out waiting for EOF").expect("read error");
        assert_eq!(eof, None, "expected EOF after serve_io exit");
    }

    /// Pins the shutdown fix: a Host clone stored inside the plugin must not
    /// keep the writer channel open after $deactivate (serve_io drops the
    /// plugin before awaiting the writer task).
    #[tokio::test]
    async fn deactivate_exits_even_when_plugin_holds_host_clone() {
        let mut plugin = TestPlugin::new();
        plugin.keep_host = true;
        let mut h = spawn_plugin(plugin);
        h.send(json!({"jsonrpc":"2.0","id":7,"method":"$activate","params":{"event":"*"}})).await;
        let _ = h.recv_response().await;
        h.send(json!({"jsonrpc":"2.0","id":8,"method":"$deactivate","params":{}})).await;
        let resp = h.recv_response().await;
        assert_eq!(resp.id, 8);
        assert_eq!(resp.result, Some(json!({"ok": true})));
        timeout(Duration::from_secs(5), h.serve).await
            .expect("serve_io must exit even when the plugin kept a Host clone")
            .expect("serve task panicked");
    }

    // ── ⑥ unknown method with id → -32601 ──────────────────────────────

    #[tokio::test]
    async fn unknown_method_replies_method_not_found() {
        let mut h = spawn_plugin(TestPlugin::new());
        h.send(json!({"jsonrpc":"2.0","id":9,"method":"nope.nothing","params":{}})).await;
        let resp = h.recv_response().await;
        assert_eq!(resp.id, 9);
        assert!(resp.result.is_none());
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, proto::ERR_METHOD_NOT_FOUND);
        assert_eq!(err.code, -32601);
        assert!(err.message.contains("nope.nothing"), "got: {}", err.message);
        assert!(h.rec.calls().is_empty(), "plugin must not be called for unknown methods");
    }

    // ── ⑦–⑨ ui.request / host.ui.post / on_ui_request error ─────────────

    /// A plugin that echoes ui.request params back as result, and optionally
    /// calls host.ui_post before returning.
    struct UiEchoPlugin {
        /// When Some(window_id), call ui_post before returning the echo.
        post_to: Option<String>,
        /// When true, return Err instead of echoing.
        fail: bool,
    }

    impl UiEchoPlugin {
        fn echo() -> Self { Self { post_to: None, fail: false } }
        fn echo_and_post(window_id: &str) -> Self {
            Self { post_to: Some(window_id.to_string()), fail: false }
        }
        fn failing() -> Self { Self { post_to: None, fail: true } }
    }

    impl NotemdPlugin for UiEchoPlugin {
        fn activate(&mut self, _host: &Host, _params: &proto::ActivateParams) -> Result<(), String> { Ok(()) }
        fn deactivate(&mut self, _host: &Host) {}
        fn execute_command(&mut self, _host: &Host, _params: &proto::ExecuteCommandParams)
            -> Result<Value, String> { Ok(json!({})) }
        fn on_ui_request(&mut self, host: &Host, _method: &str, params: Value)
            -> Result<Value, String> {
            if self.fail { return Err("ui handler failed".into()); }
            if let Some(wid) = &self.post_to.clone() {
                host.ui_post(wid, json!({"seq": 1}));
            }
            Ok(params)
        }
    }

    fn spawn_ui_echo(plugin: UiEchoPlugin) -> Harness {
        let (to_plugin, plugin_stdin) = tokio::io::duplex(64 * 1024);
        let (plugin_stdout, from_plugin) = tokio::io::duplex(64 * 1024);
        // UiEchoPlugin doesn't have a Recorder, reuse the Harness struct with a dummy one.
        let rec = Recorder::default();
        let serve = tokio::spawn(serve_io(plugin, plugin_stdin, plugin_stdout));
        Harness { to_plugin, from_plugin: BufReader::new(from_plugin).lines(), serve, rec }
    }

    /// ⑦ ui.request echo: host sends {method:"echo", params:{x:1}} →
    ///    on_ui_request echoes params → response.result == {x:1}
    #[tokio::test]
    async fn ui_request_echo_returns_params() {
        let mut h = spawn_ui_echo(UiEchoPlugin::echo());
        h.send(json!({
            "jsonrpc": "2.0", "id": 10, "method": "ui.request",
            "params": { "method": "echo", "params": { "x": 1 } }
        })).await;
        let resp = h.recv_response().await;
        assert_eq!(resp.id, 10);
        assert_eq!(resp.result, Some(json!({"x": 1})));
        assert!(resp.error.is_none());
    }

    /// ⑧ host.ui.post notification: a plugin that calls host.ui_post inside
    ///    on_ui_request produces a `host.ui.post` notification line (no id,
    ///    correct method, params.window_id=="main") before the response.
    #[tokio::test]
    async fn ui_post_notification_precedes_ui_request_response() {
        let mut h = spawn_ui_echo(UiEchoPlugin::echo_and_post("main"));
        h.send(json!({
            "jsonrpc": "2.0", "id": 11, "method": "ui.request",
            "params": { "method": "push", "params": {} }
        })).await;

        // First output line must be the host.ui.post notification.
        let first = h.recv_line().await;
        let notif: proto::RpcRequest = serde_json::from_str(&first)
            .unwrap_or_else(|e| panic!("expected host.ui.post notification, got: {first} ({e})"));
        assert_eq!(notif.id, None, "host.ui.post must be a notification (no id): {first}");
        assert_eq!(notif.method, "host.ui.post");
        assert_eq!(notif.params["window_id"], "main");
        assert_eq!(notif.params["payload"], json!({"seq": 1}));

        // Second line must be the ui.request response.
        let second = h.recv_line().await;
        let resp: proto::RpcResponse = serde_json::from_str(&second)
            .unwrap_or_else(|e| panic!("expected ui.request response, got: {second} ({e})"));
        assert_eq!(resp.id, 11);
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
    }

    /// ⑨ on_ui_request returning Err → RpcError with code -32000.
    #[tokio::test]
    async fn ui_request_error_returns_rpc_error() {
        let mut h = spawn_ui_echo(UiEchoPlugin::failing());
        h.send(json!({
            "jsonrpc": "2.0", "id": 12, "method": "ui.request",
            "params": { "method": "fail", "params": {} }
        })).await;
        let resp = h.recv_response().await;
        assert_eq!(resp.id, 12);
        assert!(resp.result.is_none());
        let err = resp.error.expect("expected RpcError");
        assert_eq!(err.code, -32000);
        assert_eq!(err.message, "ui handler failed");
    }
}
