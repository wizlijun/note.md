//! openclaw config, stored at `<data_dir>/config.json`.
//!
//! v1 read this out of Tauri's settings.json (`plugins.openclaw-chat.*`). The
//! v2 plugin owns its own state file under the host-provided `data_dir`
//! (InitializeParams.data_dir). ②b starts fresh: the user re-pairs in the v2
//! window; there is no one-time migration from the v1 settings.json (accepted
//! for a chat/pairing plugin — see plan Task 4 / spec §20).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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

/// Best-effort home directory (no `dirs` crate; the plugin runs on macOS/Linux
/// where $HOME is always set). Falls back to "." so the default socket path is
/// still a valid PathBuf.
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

impl Default for OpenClawConfig {
    fn default() -> Self {
        Self {
            mode: ConnectMode::Auto,
            socket_path: home_dir().join(".openclaw").join("notemd.sock"),
            access_token: None,
            relay_url: Some("wss://mdrelay.example.com".into()),
            host_token: None,
            device_token: None,
            device_id: None,
        }
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

/// Load the config from `<data_dir>/config.json`, falling back to defaults when
/// the file is missing or unparseable (fresh install).
pub fn read(data_dir: &Path) -> OpenClawConfig {
    match std::fs::read_to_string(config_path(data_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => OpenClawConfig::default(),
    }
}

/// Persist the config to `<data_dir>/config.json`. Creates `data_dir` if needed.
pub fn write(data_dir: &Path, cfg: &OpenClawConfig) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(data_dir), s).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_missing_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = read(dir.path());
        assert_eq!(cfg.mode, ConnectMode::Auto);
        assert!(cfg.relay_url.is_some());
        assert!(cfg.device_token.is_none());
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = OpenClawConfig::default();
        cfg.mode = ConnectMode::Remote;
        cfg.device_token = Some("dt-123".into());
        cfg.device_id = Some("remote:abc".into());
        cfg.host_token = Some("ht-xyz".into());
        write(dir.path(), &cfg).unwrap();

        let back = read(dir.path());
        assert_eq!(back.mode, ConnectMode::Remote);
        assert_eq!(back.device_token.as_deref(), Some("dt-123"));
        assert_eq!(back.device_id.as_deref(), Some("remote:abc"));
        assert_eq!(back.host_token.as_deref(), Some("ht-xyz"));
    }
}
