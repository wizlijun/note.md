// src-tauri/src/openclaw/relay_bridge.rs
//
// Host-side relay bridge.
//
// Design choice: Option B (single-owner fan-out).
//
// The UdsClient's event_rx is an mpsc::Receiver — only one task can drain it.
// That owner is `forward_uds_events` in commands.rs, which already emits frames
// to the webview.  To also forward frames to the relay we store an
// `Arc<RelayClient>` in OpenClawState and let `forward_uds_events` call
// `relay_client.tx_send` on each outbound frame.
//
// This file handles only the INBOUND direction:
//   relay WS envelopes → tx_to_server on the UdsClient
// and relays connection-state events to the webview.

use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use super::relay_client::{spawn as spawn_relay, RelayClient, RelayEvent};
use super::uds_client::UdsClient;

pub struct RelayBridge {
    /// Kept alive so the relay WS loop keeps running.
    pub client: Arc<RelayClient>,
}

/// Spawns the relay WS client and the inbound pump task.
///
/// Outbound direction (UDS frame → relay) is handled by `forward_uds_events`
/// in commands.rs, which reads `OpenClawState::relay_tx` that we populate here.
pub fn spawn(
    app: AppHandle,
    uds: Arc<UdsClient>,
    relay_url: String,
    host_token: String,
) -> RelayBridge {
    let client = Arc::new(spawn_relay(relay_url, "host", host_token));

    // Inbound: relay envelopes → UDS send channel + webview status events.
    let uds_for_inbound = uds.clone();
    let app_for_inbound = app.clone();
    let event_rx = client.event_rx.clone();
    tokio::spawn(async move {
        loop {
            let mut rx = event_rx.lock().await;
            match rx.recv().await {
                Some(RelayEvent::Envelope(env)) => {
                    // Forward only envelopes addressed to the host or broadcast.
                    if env.to == "host" || env.to == "broadcast" {
                        let _ = uds_for_inbound.tx_to_server.send(env.frame).await;
                    }
                }
                Some(RelayEvent::Connected) => {
                    let _ = app_for_inbound.emit("openclaw://relay-status", "connected");
                }
                Some(RelayEvent::Connecting) => {
                    let _ = app_for_inbound.emit("openclaw://relay-status", "connecting");
                }
                Some(RelayEvent::Disconnected(r)) => {
                    let _ = app_for_inbound
                        .emit("openclaw://relay-status", format!("disconnected:{}", r));
                }
                Some(RelayEvent::Error(e)) => {
                    let _ = app_for_inbound.emit("openclaw://relay-error", e);
                }
                None => break,
            }
        }
    });

    RelayBridge { client }
}
