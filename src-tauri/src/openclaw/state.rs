use std::sync::Arc;
use tokio::sync::Mutex;
use crate::openclaw::uds_client::UdsClient;
use crate::openclaw::relay_client::{Envelope, RelayClient};
use crate::openclaw::config::OpenClawConfig;

pub enum Backend {
    None,
    Host(UdsClient),
    Remote(RelayClient),
}

pub struct OpenClawState {
    pub config: Mutex<OpenClawConfig>,
    pub backend: Mutex<Backend>,
    /// Active relay bridge (host mode only).
    pub bridge: Mutex<Option<crate::openclaw::relay_bridge::RelayBridge>>,
    /// Sender side of the relay client's outbound channel.
    /// Populated when the bridge is active so that `forward_uds_events` can
    /// forward UDS frames to the relay without needing to touch the bridge's
    /// `Arc<RelayClient>` (avoids cross-coupling with the bridge module).
    pub relay_tx: Mutex<Option<tokio::sync::mpsc::Sender<Envelope>>>,
    /// Pending-claim poller handle (populated by P4.7).
    pub claim_poller: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub fn init_state(app: &tauri::AppHandle) -> Arc<OpenClawState> {
    let cfg = crate::openclaw::config::read(app);
    Arc::new(OpenClawState {
        config: Mutex::new(cfg),
        backend: Mutex::new(Backend::None),
        bridge: Mutex::new(None),
        relay_tx: Mutex::new(None),
        claim_poller: Mutex::new(None),
    })
}
