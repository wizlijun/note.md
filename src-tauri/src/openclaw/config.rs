use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenClawConfig {
    pub mode: ConnectMode,
    pub socket_path: PathBuf,
    pub access_token: Option<String>,
    pub relay_url: Option<String>,
    pub host_token: Option<String>,
    pub device_token: Option<String>,
    /// In remote mode, our own device id assigned by mdrelay on pair-claim
    /// (e.g. "remote:abc123def456"). Used as the `from` field on every
    /// envelope we send so the worker can route replies back to this socket.
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectMode {
    Auto,
    Host,
    Remote,
}

impl Default for OpenClawConfig {
    fn default() -> Self {
        let home = dirs::home_dir().expect("home dir");
        Self {
            mode: ConnectMode::Auto,
            socket_path: home.join(".openclaw").join("mdeditor.sock"),
            access_token: None,
            relay_url: Some("wss://mdrelay.example.com".into()),
            host_token: None,
            device_token: None,
            device_id: None,
        }
    }
}

pub fn read(app: &tauri::AppHandle) -> OpenClawConfig {
    use tauri_plugin_store::StoreExt;
    let store = match app.store("settings.json") {
        Ok(s) => s,
        Err(_) => return OpenClawConfig::default(),
    };
    let mode = store
        .get("openclaw.mode")
        .and_then(|v| {
            v.as_str().map(|s| match s {
                "host" => ConnectMode::Host,
                "remote" => ConnectMode::Remote,
                _ => ConnectMode::Auto,
            })
        })
        .unwrap_or(ConnectMode::Auto);
    let socket_path = store
        .get("openclaw.socketPath")
        .and_then(|v| {
            v.as_str().map(|s| {
                if s.starts_with("~/") {
                    dirs::home_dir()
                        .map(|h| h.join(&s[2..]))
                        .unwrap_or_else(|| PathBuf::from(s))
                } else {
                    PathBuf::from(s)
                }
            })
        })
        .unwrap_or_else(|| OpenClawConfig::default().socket_path);
    let access_token = store
        .get("openclaw.accessToken")
        .and_then(|v| v.as_str().map(String::from));
    let relay_url = store
        .get("openclaw.relayUrl")
        .and_then(|v| v.as_str().map(String::from))
        .or_else(|| OpenClawConfig::default().relay_url);
    let host_token = store
        .get("openclaw.hostToken")
        .and_then(|v| v.as_str().map(String::from));
    let device_token = store
        .get("openclaw.deviceToken")
        .and_then(|v| v.as_str().map(String::from));
    let device_id = store
        .get("openclaw.deviceId")
        .and_then(|v| v.as_str().map(String::from));
    OpenClawConfig {
        mode,
        socket_path,
        access_token,
        relay_url,
        host_token,
        device_token,
        device_id,
    }
}
