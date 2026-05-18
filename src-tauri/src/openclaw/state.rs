use std::sync::Arc;
use tokio::sync::Mutex;
use crate::openclaw::uds_client::UdsClient;
use crate::openclaw::config::OpenClawConfig;

pub struct OpenClawState {
    pub config: Mutex<OpenClawConfig>,
    pub uds: Mutex<Option<UdsClient>>,
}

pub fn init_state(app: &tauri::AppHandle) -> Arc<OpenClawState> {
    let cfg = crate::openclaw::config::read(app);
    Arc::new(OpenClawState {
        config: Mutex::new(cfg),
        uds: Mutex::new(None),
    })
}
