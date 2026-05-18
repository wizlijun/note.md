use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use crate::openclaw::uds_client::UdsClient;
use crate::openclaw::config::OpenClawConfig;
use crate::openclaw::relay_client::Envelope;

pub struct OpenClawState {
    pub config: Mutex<OpenClawConfig>,
    pub uds: Mutex<Option<UdsClient>>,
    /// Active relay bridge (host mode only).
    pub bridge: Mutex<Option<crate::openclaw::relay_bridge::RelayBridge>>,
    /// Sender side of the relay client's outbound channel.
    /// Populated when the bridge is active so that `forward_uds_events` can
    /// forward UDS frames to the relay without needing to touch the bridge's
    /// `Arc<RelayClient>` (avoids cross-coupling with the bridge module).
    pub relay_tx: Mutex<Option<mpsc::Sender<Envelope>>>,
}

pub fn init_state(app: &tauri::AppHandle) -> Arc<OpenClawState> {
    let cfg = crate::openclaw::config::read(app);
    Arc::new(OpenClawState {
        config: Mutex::new(cfg),
        uds: Mutex::new(None),
        bridge: Mutex::new(None),
        relay_tx: Mutex::new(None),
    })
}
