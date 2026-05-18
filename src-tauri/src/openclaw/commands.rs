use std::sync::Arc;
use tauri::{AppHandle, Manager, Emitter};
use tokio::task;
use crate::openclaw::protocol::Frame;
use crate::openclaw::state::OpenClawState;
use crate::openclaw::uds_client::{spawn, UdsEvent};
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

    if mode != ConnectMode::Host {
        return Err("remote mode not implemented in this plan".into());
    }

    let token = cfg.access_token.clone()
        .ok_or_else(|| "access token not configured — run OpenClaw once to auto-generate".to_string())?;
    let client = spawn(cfg.socket_path.clone(), token);

    let event_rx = client.event_rx.clone();
    let app_for_events = app.clone();
    task::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(UdsEvent::Connected) => { let _ = app_for_events.emit("openclaw://status", "connected"); }
                Some(UdsEvent::Connecting) => { let _ = app_for_events.emit("openclaw://status", "connecting"); }
                Some(UdsEvent::Disconnected(r)) => { let _ = app_for_events.emit("openclaw://status", format!("disconnected:{}", r)); }
                Some(UdsEvent::Error(e)) => { let _ = app_for_events.emit("openclaw://error", e); }
                Some(UdsEvent::Frame(f)) => { let _ = app_for_events.emit("openclaw://frame", f); }
                None => break,
            }
        }
    });

    *state.uds.lock().await = Some(client);
    Ok("host".into())
}

#[tauri::command]
pub async fn openclaw_send(app: AppHandle, frame: Frame) -> Result<(), String> {
    let state = app.state::<Arc<OpenClawState>>();
    let guard = state.uds.lock().await;
    let client = guard.as_ref().ok_or_else(|| "not connected".to_string())?;
    client.tx_to_server.send(frame).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn openclaw_disconnect(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<OpenClawState>>();
    *state.uds.lock().await = None;
    Ok(())
}
