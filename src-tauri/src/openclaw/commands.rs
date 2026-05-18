use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use crate::openclaw::protocol::Frame;
use crate::openclaw::relay_client::{Envelope, RelayClient, RelayEvent};
use crate::openclaw::state::{Backend, OpenClawState};
use crate::openclaw::uds_client::{UdsClient, UdsEvent};
use crate::openclaw::config::ConnectMode;

#[tauri::command]
pub async fn openclaw_connect(app: AppHandle) -> Result<String, String> {
    let state = app.state::<Arc<OpenClawState>>();
    let cfg = state.config.lock().await.clone();

    let mode = match cfg.mode {
        ConnectMode::Auto => {
            if cfg.socket_path.exists() { ConnectMode::Host } else { ConnectMode::Remote }
        }
        m => m,
    };

    match mode {
        ConnectMode::Host => {
            let token = cfg.access_token.clone()
                .ok_or_else(|| "access token not configured — run OpenClaw once to auto-generate".to_string())?;
            let client = crate::openclaw::uds_client::spawn(cfg.socket_path.clone(), token);
            forward_uds_events(app.clone(), client.clone());
            *state.backend.lock().await = Backend::Host(client.clone());

            // Optionally start the relay bridge if relay_url + host_token are configured.
            if let (Some(relay_url), Some(host_tok)) = (cfg.relay_url.clone(), cfg.host_token.clone()) {
                let bridge = crate::openclaw::relay_bridge::spawn(
                    app.clone(),
                    Arc::new(client),
                    relay_url,
                    host_tok,
                );
                // Stash the outbound sender so forward_uds_events can forward frames to relay.
                *state.relay_tx.lock().await = Some(bridge.client.tx_send.clone());
                *state.bridge.lock().await = Some(bridge);
            }
            crate::openclaw::state::spawn_claim_poller(app.clone());
            Ok("host".into())
        }
        ConnectMode::Remote => {
            let url = cfg.relay_url.clone().ok_or("no relay URL")?;
            let token = cfg.device_token.clone().ok_or("not paired — open Devices to pair")?;
            let client = crate::openclaw::relay_client::spawn(url, "remote", token);
            forward_relay_events(app.clone(), client.clone());
            *state.backend.lock().await = Backend::Remote(client);
            Ok("remote".into())
        }
        ConnectMode::Auto => Err("auto resolved to unknown".into()),
    }
}

#[tauri::command]
pub async fn openclaw_send(app: AppHandle, frame: Frame) -> Result<(), String> {
    let state = app.state::<Arc<OpenClawState>>();
    let guard = state.backend.lock().await;
    match &*guard {
        Backend::Host(c) => c.tx_to_server.send(frame).await.map_err(|e| e.to_string()),
        Backend::Remote(c) => {
            let env = Envelope { to: "host".into(), from: "remote:self".into(), frame };
            c.tx_send.send(env).await.map_err(|e| e.to_string())
        }
        Backend::None => Err("not connected".into()),
    }
}

#[tauri::command]
pub async fn openclaw_disconnect(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<OpenClawState>>();
    *state.backend.lock().await = Backend::None;
    *state.bridge.lock().await = None;
    *state.relay_tx.lock().await = None;
    Ok(())
}

fn forward_uds_events(app: AppHandle, client: UdsClient) {
    let event_rx = client.event_rx.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(UdsEvent::Connected) => {
                    let _ = app.emit("openclaw://status", "connected");
                }
                Some(UdsEvent::Connecting) => {
                    let _ = app.emit("openclaw://status", "connecting");
                }
                Some(UdsEvent::Disconnected(r)) => {
                    let _ = app.emit("openclaw://status", format!("disconnected:{}", r));
                }
                Some(UdsEvent::Error(e)) => {
                    let _ = app.emit("openclaw://error", e);
                }
                Some(UdsEvent::Frame(f)) => {
                    // Emit to webview.
                    let _ = app.emit("openclaw://frame", f.clone());
                    // Also forward to relay if bridge is active (outbound direction).
                    let state = app.state::<Arc<OpenClawState>>();
                    let tx_opt = state.relay_tx.lock().await.clone();
                    if let Some(tx) = tx_opt {
                        let env = Envelope {
                            to: "broadcast".into(),
                            from: "host".into(),
                            frame: f,
                        };
                        let _ = tx.send(env).await;
                    }
                }
                None => break,
            }
        }
    });
}

use crate::openclaw::devices::{Device, DeviceStatus};

#[derive(serde::Serialize)]
pub struct PairCreateOut {
    pub code: String,
    pub pairing_id: String,
    pub expires_at: u64,
    pub qr_svg: String,
}

#[tauri::command]
pub async fn openclaw_pair_create(app: AppHandle) -> Result<PairCreateOut, String> {
    use qrcode::QrCode;
    use qrcode::render::svg::Color;
    let cfg = {
        let state = app.state::<std::sync::Arc<crate::openclaw::state::OpenClawState>>();
        let x = state.config.lock().await.clone(); x
    };
    let url = cfg.relay_url.ok_or("relay URL not configured")?;
    let create = crate::openclaw::pair::pair_create(&url).await?;
    let host = crate::openclaw::pair::host_bootstrap(&url, &create.pairing_id).await?;
    persist_setting(&app, "openclaw.hostToken", &host.device_token)?;
    persist_setting(&app, "openclaw.pairingId", &create.pairing_id)?;
    let qr = QrCode::new(create.code.as_bytes()).map_err(|e| e.to_string())?;
    let qr_svg = qr.render::<Color>().build();
    Ok(PairCreateOut {
        code: create.code,
        pairing_id: create.pairing_id,
        expires_at: create.expires_at,
        qr_svg,
    })
}

#[derive(serde::Serialize)]
pub struct PairClaimOut {
    pub pairing_id: String,
    pub device_id: String,
}

#[tauri::command]
pub async fn openclaw_pair_claim(app: AppHandle, code: String, hostname: Option<String>) -> Result<PairClaimOut, String> {
    let cfg = {
        let state = app.state::<std::sync::Arc<crate::openclaw::state::OpenClawState>>();
        let x = state.config.lock().await.clone(); x
    };
    let url = cfg.relay_url.ok_or("relay URL not configured")?;
    let host_name = hostname.unwrap_or_else(|| {
        gethostname::gethostname().to_string_lossy().to_string()
    });
    let claim = crate::openclaw::pair::pair_claim(&url, &code, &host_name).await?;
    persist_setting(&app, "openclaw.deviceToken", &claim.device_token)?;
    persist_setting(&app, "openclaw.pairingId", &claim.pairing_id)?;
    persist_setting(&app, "openclaw.deviceId", &claim.device_id)?;
    Ok(PairClaimOut { pairing_id: claim.pairing_id, device_id: claim.device_id })
}

#[tauri::command]
pub async fn openclaw_revoke_device(app: AppHandle, device_id: String) -> Result<(), String> {
    let cfg = {
        let state = app.state::<std::sync::Arc<crate::openclaw::state::OpenClawState>>();
        let x = state.config.lock().await.clone(); x
    };
    let url = cfg.relay_url.ok_or("relay URL not configured")?;
    let host_tok = cfg.host_token.ok_or("not the host")?;
    crate::openclaw::pair::revoke_device(&url, &host_tok, &device_id).await?;
    crate::openclaw::devices::set_status(&app, &device_id, DeviceStatus::Revoked)?;
    Ok(())
}

#[tauri::command]
pub async fn openclaw_forget_device(app: AppHandle, device_id: String) -> Result<(), String> {
    crate::openclaw::devices::forget(&app, &device_id)
}

#[tauri::command]
pub async fn openclaw_list_devices(app: AppHandle) -> Vec<Device> {
    crate::openclaw::devices::read_all(&app)
}

#[tauri::command]
pub async fn openclaw_approve_pending(app: AppHandle, device_id: String, hostname: String) -> Result<(), String> {
    crate::openclaw::devices::upsert(&app, Device {
        device_id,
        hostname,
        status: DeviceStatus::Active,
        last_seen: None,
    })
}

#[tauri::command]
pub async fn openclaw_reject_pending(app: AppHandle, device_id: String) -> Result<(), String> {
    openclaw_revoke_device(app, device_id).await
}

fn persist_setting(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set(key.to_string(), serde_json::Value::String(value.to_string()));
    Ok(())
}

fn forward_relay_events(app: AppHandle, client: RelayClient) {
    let event_rx = client.event_rx.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(RelayEvent::Connected) => {
                    let _ = app.emit("openclaw://status", "connected");
                }
                Some(RelayEvent::Connecting) => {
                    let _ = app.emit("openclaw://status", "connecting");
                }
                Some(RelayEvent::Disconnected(r)) => {
                    let _ = app.emit("openclaw://status", format!("disconnected:{}", r));
                }
                Some(RelayEvent::Error(e)) => {
                    let _ = app.emit("openclaw://error", e);
                }
                Some(RelayEvent::Envelope(env)) => {
                    // In remote mode, "to" = "remote:<self>" or "broadcast"; emit the frame.
                    let _ = app.emit("openclaw://frame", env.frame);
                }
                None => break,
            }
        }
    });
}
