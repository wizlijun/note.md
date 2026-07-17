//! Host-side relay bridge (inbound direction).
//!
//! Ported from src-tauri/src/openclaw/relay_bridge.rs. The only tauri coupling
//! was `app.emit("openclaw://relay-status"|"relay-error", …)`; that becomes
//! `host.ui_post("main", {kind:"relay-status"|"relay-error", data})`.
//!
//! The UdsClient's event_rx is an mpsc::Receiver — only one task can drain it.
//! That owner is the UDS reader in lib.rs, which already ui_posts frames to the
//! window and forwards them to the relay. This file handles only the INBOUND
//! direction: relay WS envelopes → tx_to_server on the UdsClient, plus relaying
//! connection-state events to the window.

use std::sync::Arc;

use notemd_plugin_sdk::Host;
use serde_json::json;

use crate::relay_client::{spawn as spawn_relay, RelayClient, RelayEvent};
use crate::uds_client::UdsClient;

pub struct RelayBridge {
    /// Kept alive so the relay WS loop keeps running.
    pub client: Arc<RelayClient>,
    /// Inbound pump task handle, aborted on disconnect/deactivate.
    pub pump: tokio::task::JoinHandle<()>,
}

/// Spawns the relay WS client and the inbound pump task.
///
/// Outbound direction (UDS frame → relay) is handled by the UDS reader in
/// lib.rs, which reads the relay sender we return via `client.tx_send`.
pub fn spawn(
    host: Host,
    uds: Arc<UdsClient>,
    relay_url: String,
    host_token: String,
) -> RelayBridge {
    let client = Arc::new(spawn_relay(relay_url, "host", host_token));

    // Inbound: relay envelopes → UDS send channel + window status events.
    let uds_for_inbound = uds.clone();
    let event_rx = client.event_rx.clone();
    let pump = tokio::spawn(async move {
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
                    host.ui_post("main", json!({"kind": "relay-status", "data": "connected"}));
                }
                Some(RelayEvent::Connecting) => {
                    host.ui_post("main", json!({"kind": "relay-status", "data": "connecting"}));
                }
                Some(RelayEvent::Disconnected(r)) => {
                    host.ui_post("main", json!({"kind": "relay-status", "data": format!("disconnected:{}", r)}));
                }
                Some(RelayEvent::Error(e)) => {
                    host.ui_post("main", json!({"kind": "relay-error", "data": e}));
                }
                None => break,
            }
        }
    });

    RelayBridge { client, pump }
}
