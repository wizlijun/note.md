//! openclaw v2 plugin: the whole UDS/relay/pair state machine moved off Tauri
//! onto notemd-plugin-sdk. A long-running JSON-RPC service driven by
//! `ui.request` from its window; every inbound frame / status change is pushed
//! back to the window via `host.ui_post("main", {kind, data})`.
//!
//! v1 (src-tauri/src/openclaw) stays until ④; this crate starts fresh — the
//! user re-pairs in the v2 window, config/devices live in `<data_dir>` (see
//! plan Task 4 / spec §20 for why no one-time migration).

pub mod config;
pub mod devices;
pub mod pair;
pub mod protocol;
pub mod relay_bridge;
pub mod relay_client;
pub mod uds_client;

use std::path::PathBuf;
use std::sync::Arc;

use notemd_plugin_sdk::{self as sdk, NotemdPlugin};
use notemd_plugin_sdk::plugin_protocol as proto;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use config::{ConnectMode, OpenClawConfig};
use devices::{Device, DeviceStatus};
use protocol::Frame;
use relay_bridge::RelayBridge;
use relay_client::{Envelope, RelayClient, RelayEvent};
use uds_client::{UdsClient, UdsEvent};

/// Which transport the window is connected through.
enum Backend {
    None,
    Host(UdsClient),
    Remote(RelayClient),
}

/// The mutable runtime state, shared by the plugin and every spawned task.
struct Inner {
    config: OpenClawConfig,
    backend: Backend,
    bridge: Option<RelayBridge>,
    /// Sender side of the relay client's outbound channel (host mode + bridge
    /// active), so the UDS reader can forward frames to the relay.
    relay_tx: Option<tokio::sync::mpsc::Sender<Envelope>>,
    /// Spawned reader / poller tasks, aborted on disconnect + deactivate.
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Inner {
    fn abort_tasks(&mut self) {
        for t in self.tasks.drain(..) {
            t.abort();
        }
        if let Some(b) = self.bridge.take() {
            b.pump.abort();
        }
    }
}

pub struct OpenClawPlugin {
    data_dir: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl OpenClawPlugin {
    pub fn new() -> Self {
        Self {
            data_dir: PathBuf::from("."),
            inner: Arc::new(Mutex::new(Inner {
                config: OpenClawConfig::default(),
                backend: Backend::None,
                bridge: None,
                relay_tx: None,
                tasks: Vec::new(),
            })),
        }
    }
}

impl Default for OpenClawPlugin {
    fn default() -> Self { Self::new() }
}

impl NotemdPlugin for OpenClawPlugin {
    fn initialize(&mut self, host: &sdk::Host, params: &proto::InitializeParams) {
        self.data_dir = PathBuf::from(&params.data_dir);
        let cfg = config::read(&self.data_dir);
        // Best-effort: seed the in-memory config from disk. block_in_place is
        // safe here — serve_io runs initialize on a multi-thread runtime.
        let inner = self.inner.clone();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                inner.lock().await.config = cfg;
            });
        });
        host.log_info(&format!("openclaw v2 initialized (data_dir={})", self.data_dir.display()));
    }

    fn activate(&mut self, host: &sdk::Host, _p: &proto::ActivateParams) -> Result<(), String> {
        // v1 semantics: no auto-connect. The UI triggers `connect`.
        host.log_info("openclaw v2 activated");
        Ok(())
    }

    fn deactivate(&mut self, _host: &sdk::Host) {
        let inner = self.inner.clone();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let mut g = inner.lock().await;
                g.backend = Backend::None;
                g.relay_tx = None;
                g.abort_tasks();
            });
        });
    }

    /// openclaw has no menu/CLI command — the window drives everything via
    /// `ui.request`. This satisfies the trait but is never reached for openclaw.
    fn execute_command(&mut self, _host: &sdk::Host, params: &proto::ExecuteCommandParams)
        -> Result<Value, String> {
        Err(format!("openclaw has no command '{}'; use the chat window", params.command))
    }

    fn on_ui_request(&mut self, host: &sdk::Host, method: &str, params: Value)
        -> Result<Value, String> {
        let inner = self.inner.clone();
        let data_dir = self.data_dir.clone();
        let host = host.clone();
        // The SDK calls on_ui_request synchronously on the read task; run the
        // async body on the current multi-thread runtime.
        tokio::task::block_in_place(move || {
            tokio::runtime::Handle::current().block_on(async move {
                dispatch(&host, &inner, &data_dir, method, params).await
            })
        })
    }
}

/// Dispatch one of the 11 window operations. Mirrors the v1 command bodies but
/// returns a `serde_json::Value` and pushes async events via `host.ui_post`.
async fn dispatch(
    host: &sdk::Host,
    inner: &Arc<Mutex<Inner>>,
    data_dir: &std::path::Path,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "connect" => op_connect(host, inner).await,
        "send" => {
            let frame: Frame = serde_json::from_value(params.get("frame").cloned().unwrap_or(params))
                .map_err(|e| format!("bad frame: {e}"))?;
            op_send(inner, frame).await?;
            Ok(json!({"ok": true}))
        }
        "disconnect" => {
            let mut g = inner.lock().await;
            g.backend = Backend::None;
            g.relay_tx = None;
            g.abort_tasks();
            Ok(json!({"ok": true}))
        }
        "pair_create" => op_pair_create(inner, data_dir).await,
        "pair_claim" => {
            let code = str_param(&params, "code")?;
            let hostname = params.get("hostname").and_then(|v| v.as_str()).map(String::from);
            op_pair_claim(inner, data_dir, code, hostname).await
        }
        "revoke_device" => {
            let device_id = str_param(&params, "device_id")?;
            op_revoke_device(inner, data_dir, &device_id).await?;
            Ok(json!({"ok": true}))
        }
        "forget_device" => {
            let device_id = str_param(&params, "device_id")?;
            devices::forget(data_dir, &device_id)?;
            Ok(json!({"ok": true}))
        }
        "list_devices" => {
            Ok(serde_json::to_value(devices::read_all(data_dir)).map_err(|e| e.to_string())?)
        }
        "approve_pending" => {
            let device_id = str_param(&params, "device_id")?;
            let hostname = str_param(&params, "hostname")?;
            devices::upsert(data_dir, Device {
                device_id, hostname, status: DeviceStatus::Active, last_seen: None,
            })?;
            Ok(json!({"ok": true}))
        }
        "reject_pending" => {
            // v1: reject == revoke.
            let device_id = str_param(&params, "device_id")?;
            op_revoke_device(inner, data_dir, &device_id).await?;
            Ok(json!({"ok": true}))
        }
        "upload_attachment" => {
            let session = str_param(&params, "session")?;
            let filename = str_param(&params, "filename")?;
            let bytes_b64 = str_param(&params, "bytes_b64")?;
            let frame = Frame::UserAttachUpload {
                session,
                blob_id: format!("b-{}", uuid_like()),
                filename,
                bytes_b64,
            };
            op_send(inner, frame).await?;
            Ok(json!({"ok": true}))
        }
        other => Err(format!("unknown ui method: {other}")),
    }
}

fn str_param(params: &Value, key: &str) -> Result<String, String> {
    params.get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("missing param: {key}"))
}

// ── connect ────────────────────────────────────────────────────────────────

async fn op_connect(host: &sdk::Host, inner: &Arc<Mutex<Inner>>) -> Result<Value, String> {
    let cfg = inner.lock().await.config.clone();

    let mode = match cfg.mode {
        ConnectMode::Auto => {
            if cfg.socket_path.exists() { ConnectMode::Host } else { ConnectMode::Remote }
        }
        m => m,
    };

    match mode {
        ConnectMode::Host => {
            let token = cfg.access_token.clone().ok_or_else(||
                "access token not configured — run OpenClaw once to auto-generate".to_string())?;
            let client = uds_client::spawn(cfg.socket_path.clone(), token);
            let reader = forward_uds_events(host.clone(), inner.clone(), client.clone());
            {
                let mut g = inner.lock().await;
                g.backend = Backend::Host(client.clone());
                g.tasks.push(reader);
            }

            // Optionally start the relay bridge if relay_url + host_token set.
            if let (Some(relay_url), Some(host_tok)) = (cfg.relay_url.clone(), cfg.host_token.clone()) {
                let bridge = relay_bridge::spawn(
                    host.clone(),
                    Arc::new(client),
                    relay_url,
                    host_tok,
                );
                let mut g = inner.lock().await;
                g.relay_tx = Some(bridge.client.tx_send.clone());
                g.bridge = Some(bridge);
            }
            spawn_claim_poller(host.clone(), inner.clone()).await;
            Ok(json!("host"))
        }
        ConnectMode::Remote => {
            let url = cfg.relay_url.clone().ok_or("no relay URL")?;
            let token = cfg.device_token.clone().ok_or("not paired — open Devices to pair")?;
            let client = relay_client::spawn(url, "remote", token);
            let reader = forward_relay_events(host.clone(), client.clone());
            let mut g = inner.lock().await;
            g.backend = Backend::Remote(client);
            g.tasks.push(reader);
            Ok(json!("remote"))
        }
        ConnectMode::Auto => Err("auto resolved to unknown".into()),
    }
}

/// Drains the UDS client's event channel: pushes frames/status to the window
/// and forwards frames to the relay when the bridge is active.
fn forward_uds_events(host: sdk::Host, inner: Arc<Mutex<Inner>>, client: UdsClient)
    -> tokio::task::JoinHandle<()> {
    let event_rx = client.event_rx.clone();
    tokio::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(UdsEvent::Connected) => {
                    host.ui_post("main", json!({"kind": "status", "data": "connected"}));
                }
                Some(UdsEvent::Connecting) => {
                    host.ui_post("main", json!({"kind": "status", "data": "connecting"}));
                }
                Some(UdsEvent::Disconnected(r)) => {
                    host.ui_post("main", json!({"kind": "status", "data": format!("disconnected:{}", r)}));
                }
                Some(UdsEvent::Error(e)) => {
                    host.ui_post("main", json!({"kind": "error", "data": e}));
                }
                Some(UdsEvent::Frame(f)) => {
                    // Push to the window.
                    host.ui_post("main", json!({"kind": "frame", "data": f.clone()}));
                    // Also forward to relay if the bridge is active.
                    let tx_opt = inner.lock().await.relay_tx.clone();
                    if let Some(tx) = tx_opt {
                        let env = Envelope { to: "broadcast".into(), from: "host".into(), frame: f };
                        let _ = tx.send(env).await;
                    }
                }
                None => break,
            }
        }
    })
}

fn forward_relay_events(host: sdk::Host, client: RelayClient) -> tokio::task::JoinHandle<()> {
    let event_rx = client.event_rx.clone();
    tokio::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(RelayEvent::Connected) => {
                    host.ui_post("main", json!({"kind": "status", "data": "connected"}));
                }
                Some(RelayEvent::Connecting) => {
                    host.ui_post("main", json!({"kind": "status", "data": "connecting"}));
                }
                Some(RelayEvent::Disconnected(r)) => {
                    host.ui_post("main", json!({"kind": "status", "data": format!("disconnected:{}", r)}));
                }
                Some(RelayEvent::Error(e)) => {
                    host.ui_post("main", json!({"kind": "error", "data": e}));
                }
                Some(RelayEvent::Envelope(env)) => {
                    host.ui_post("main", json!({"kind": "frame", "data": env.frame}));
                }
                None => break,
            }
        }
    })
}

// ── send ─────────────────────────────────────────────────────────────────

async fn op_send(inner: &Arc<Mutex<Inner>>, frame: Frame) -> Result<(), String> {
    let g = inner.lock().await;
    match &g.backend {
        Backend::Host(c) => c.tx_to_server.send(frame).await.map_err(|e| e.to_string()),
        Backend::Remote(c) => {
            let tx = c.tx_send.clone();
            let device_id = g.config.device_id.clone()
                .unwrap_or_else(|| "remote:unknown".to_string());
            drop(g);
            let env = Envelope { to: "host".into(), from: device_id, frame };
            tx.send(env).await.map_err(|e| e.to_string())
        }
        Backend::None => Err("not connected".into()),
    }
}

// ── pairing ────────────────────────────────────────────────────────────────

async fn op_pair_create(inner: &Arc<Mutex<Inner>>, data_dir: &std::path::Path)
    -> Result<Value, String> {
    use qrcode::render::svg::Color;
    use qrcode::QrCode;

    let cfg = inner.lock().await.config.clone();
    let url = cfg.relay_url.ok_or("relay URL not configured")?;
    let create = pair::pair_create(&url).await?;
    let host_boot = pair::host_bootstrap(&url, &create.pairing_id).await?;

    // Persist the host token so the host can use it immediately.
    {
        let mut g = inner.lock().await;
        g.config.host_token = Some(host_boot.device_token.clone());
        config::write(data_dir, &g.config)?;
    }

    let qr = QrCode::new(create.code.as_bytes()).map_err(|e| e.to_string())?;
    let qr_svg = qr.render::<Color>().build();
    Ok(json!({
        "code": create.code,
        "pairing_id": create.pairing_id,
        "expires_at": create.expires_at,
        "qr_svg": qr_svg,
    }))
}

async fn op_pair_claim(
    inner: &Arc<Mutex<Inner>>,
    data_dir: &std::path::Path,
    code: String,
    hostname: Option<String>,
) -> Result<Value, String> {
    let cfg = inner.lock().await.config.clone();
    let url = cfg.relay_url.ok_or("relay URL not configured")?;
    let host_name = hostname.unwrap_or_else(|| {
        gethostname::gethostname().to_string_lossy().to_string()
    });
    let claim = pair::pair_claim(&url, &code, &host_name).await?;

    // Persist device_token + device_id so a subsequent connect sees them.
    {
        let mut g = inner.lock().await;
        g.config.device_token = Some(claim.device_token.clone());
        g.config.device_id = Some(claim.device_id.clone());
        config::write(data_dir, &g.config)?;
    }

    Ok(json!({
        "pairing_id": claim.pairing_id,
        "device_id": claim.device_id,
    }))
}

async fn op_revoke_device(
    inner: &Arc<Mutex<Inner>>,
    data_dir: &std::path::Path,
    device_id: &str,
) -> Result<(), String> {
    let cfg = inner.lock().await.config.clone();
    let url = cfg.relay_url.ok_or("relay URL not configured")?;
    let host_tok = cfg.host_token.ok_or("not the host")?;
    pair::revoke_device(&url, &host_tok, device_id).await?;
    devices::set_status(data_dir, device_id, DeviceStatus::Revoked)
}

/// Polls the relay for pending device claims every 8s and pushes each to the
/// window as `{kind:"pending-claim", data}`. Started once per connect.
async fn spawn_claim_poller(host: sdk::Host, inner: Arc<Mutex<Inner>>) {
    let poll_inner = inner.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            let cfg = poll_inner.lock().await.config.clone();
            let url = match &cfg.relay_url { Some(u) => u.clone(), None => continue };
            let tok = match &cfg.host_token { Some(t) => t.clone(), None => continue };
            if let Ok(claims) = pair::pending_claims(&url, &tok).await {
                for c in claims {
                    host.ui_post("main", json!({"kind": "pending-claim", "data": c}));
                }
            }
        }
    });
    inner.lock().await.tasks.push(task);
}

fn uuid_like() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..12).map(|_| format!("{:x}", rng.gen_range(0..16))).collect()
}

// ── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_plugin_defaults_are_disconnected() {
        // A fresh plugin starts with a default config and no backend; the data_dir
        // placeholder is "." until initialize() captures the host-provided one.
        let p = OpenClawPlugin::new();
        assert_eq!(p.data_dir, PathBuf::from("."));
    }

    #[test]
    fn list_devices_empty_store_returns_empty() {
        // list_devices (the network-free ui method) reads the on-disk store; a
        // fresh data_dir yields an empty array.
        let dir = tempfile::tempdir().unwrap();
        let out = devices::read_all(dir.path());
        assert!(out.is_empty());
        let as_json = serde_json::to_value(&out).unwrap();
        assert_eq!(as_json, json!([]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatch_approve_then_list_and_forget() {
        let dir = tempfile::tempdir().unwrap();
        // approve_pending upserts an active device
        devices::upsert(dir.path(), Device {
            device_id: "dev-1".into(),
            hostname: "phone".into(),
            status: DeviceStatus::Active,
            last_seen: None,
        }).unwrap();
        let listed = devices::read_all(dir.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].device_id, "dev-1");
        assert_eq!(listed[0].status, DeviceStatus::Active);

        // forget removes it
        devices::forget(dir.path(), "dev-1").unwrap();
        assert!(devices::read_all(dir.path()).is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn send_without_connect_errors() {
        let inner = Arc::new(Mutex::new(Inner {
            config: OpenClawConfig::default(),
            backend: Backend::None,
            bridge: None,
            relay_tx: None,
            tasks: Vec::new(),
        }));
        let frame = Frame::UserMessage {
            session: "s".into(), text: "hi".into(), attachments: vec![],
        };
        let err = op_send(&inner, frame).await.unwrap_err();
        assert_eq!(err, "not connected");
    }

    #[test]
    fn uuid_like_is_12_hex_chars() {
        let id = uuid_like();
        assert_eq!(id.len(), 12);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
