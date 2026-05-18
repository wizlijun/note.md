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
